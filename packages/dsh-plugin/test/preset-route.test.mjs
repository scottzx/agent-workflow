import test from 'node:test';
import assert from 'node:assert/strict';
import { acpAgentOf, selectAcpRoute } from '../dist/preset-route.js';

function host(agent) {
  return { agents: { get: id => (id === 'session-1' ? agent : undefined) } };
}

test('a preset selected on a running session records the ACP route', async () => {
  const selected = [];
  const ctx = host({ model: { select: route => selected.push(route) } });
  assert.equal(await selectAcpRoute(ctx, 'session-1', 'oneagents-acp-grok-build', ['grok-build', 'codex']), true);
  assert.deepEqual(selected, [{ provider: '1agents-acp', model: 'grok-build' }]);
});

test('another preset leaves the route alone', async () => {
  const selected = [];
  const ctx = host({ model: { select: route => selected.push(route) } });
  assert.equal(await selectAcpRoute(ctx, 'session-1', 'standard', ['grok-build']), false);
  assert.equal(await selectAcpRoute(ctx, 'session-1', 'oneagents-acp-unknown', ['grok-build']), false);
  assert.deepEqual(selected, []);
  assert.equal(acpAgentOf('oneagents-acp-grok-build', ['grok-build']), 'grok-build');
  assert.equal(acpAgentOf('oneagents-acp-grok-build', ['codex']), undefined);
});

test('a session without a live agent leaves the route to its own creation', async () => {
  assert.equal(await selectAcpRoute(host(undefined), 'session-1', 'oneagents-acp-grok-build', ['grok-build']), false);
});
