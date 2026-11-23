import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { agent as acpAgent } from '@agentclientprotocol/sdk';
import { connect, stream } from '../dist/transport.js';

test('SDK cancellation followed by socket close settles the transport once', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, 'open');
  const [peer] = await connected;
  const transport = stream(peer);
  const closed = once(peer, 'close');
  const clientClosed = once(client, 'close');
  await transport.readable.cancel();
  await Promise.all([closed, clientClosed]);
  assert.equal(peer.readyState, WebSocket.CLOSED);
});

test('connect forwards _1agents/events/session_closed notifications to handlers.closed', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  let serverConn;
  server.on('connection', ws => {
    const app = acpAgent().onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { _meta: { '1agents': { version: 1 } } },
    }));
    serverConn = app.connect(stream(ws));
  });
  const closedIds = [];
  const closedArrived = Promise.withResolvers();
  const link = await connect(`ws://127.0.0.1:${server.address().port}`, {
    update: () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    question: async () => ({ outcome: 'cancelled' }),
    plan: async () => ({ outcome: 'abandoned' }),
    closed: sessionId => { closedIds.push(sessionId); closedArrived.resolve(); },
  }, new AbortController().signal);
  t.after(() => link.close());
  await serverConn.client.notify('_1agents/events/session_closed', { sessionId: 'sess-idle-1', reason: 'idle_timeout' });
  await closedArrived.promise;
  assert.deepEqual(closedIds, ['sess-idle-1']);
});
