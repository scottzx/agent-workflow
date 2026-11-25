/** ACP SDK client over the service's WebSocket transport. */
import { client, type AnyMessage, type Stream, type SessionUpdate, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { WebSocket } from 'ws';
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an ACP object');
  return value as JsonObject;
}
export function stream(ws: WebSocket): Stream {
  let readableClosed = false;
  return {
    readable: new ReadableStream<AnyMessage>({start(controller) {
      ws.on('message', raw => {
        if (readableClosed) return;
        try { controller.enqueue(JSON.parse(raw.toString()) as AnyMessage); }
        catch { ws.close(1002, 'Invalid JSON'); }
      });
      ws.once('close', () => {
        if (readableClosed) return;
        readableClosed = true;
        controller.close();
      });
      ws.on('error', () => ws.close());
    }, cancel() { readableClosed = true; ws.close(); }}),
    writable: new WritableStream<AnyMessage>({write(message) {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('ACP disconnected'));
        ws.send(JSON.stringify(message), error => error ? reject(error) : resolve());
      });
    }}),
  };
}
export interface Handlers {
  update(update: SessionUpdate): void;
  permission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  question(params: JsonObject, signal: AbortSignal): Promise<JsonObject>;
  plan(params: JsonObject, signal: AbortSignal): Promise<JsonObject>;
  closed?(sessionId: string): void;
}
export async function connect(endpoint: string, handlers: Handlers, signal: AbortSignal) {
  signal.throwIfAborted();
  const ws = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
  const abort = () => ws.terminate();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject);
      ws.once('close', () => reject(new Error('ACP connection closed')));
    });
    const connection = client().onNotification('session/update', ({ params }) => handlers.update(params.update))
      .onNotification('_1agents/events/session_closed', object, ({ params }) => {
        if (typeof params.sessionId === 'string') handlers.closed?.(params.sessionId);
      })
      .onRequest('session/request_permission', ({ params, signal }) => handlers.permission(params, signal))
      .onRequest('_x.ai/ask_user_question', object, ({ params, signal }) => handlers.question(params, signal))
      .onRequest('_x.ai/exit_plan_mode', object, ({ params, signal }) => handlers.plan(params, signal))
      .connect(stream(ws));
    const initialized = await connection.agent.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'dsh-acp', version: '0.1.0' },
      clientCapabilities: { _meta: { '1agents': { version: 1 } } },
    }, { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (initialized.protocolVersion !== 1 || !initialized.agentCapabilities?._meta?.['1agents']) throw new Error('Requires acp-service 0.2 with 1agents turn recovery');
    const supportsResume = Boolean(initialized.agentCapabilities?.sessionCapabilities?.resume);
    return { rpc: connection.agent, ws, supportsResume, close: () => ws.close(), closed: connection.closed };
  } catch (error) { ws.terminate(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
