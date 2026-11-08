import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../dist/preset.js';

function presetContext() {
 const listeners = new Map();
 return { listeners, on: (name, listener) => { listeners.set(name, listener); } };
}

test('session preset selects its ACP route before step preparation', async () => {
 const ctx = presetContext(); const selected = [];
 apply(ctx, { agent: 'grok-build' });
 ctx.listeners.get('agent/created')({ agent: { model: { select: selection => selected.push(selection) } } });
 assert.deepEqual(selected, [{ provider: '1agents-acp', model: 'grok-build' }]);
 // Current DSH proposes the selected route; the deprecated waterfall must keep it and its controls.
 const proposal = { provider: '1agents-acp', model: 'grok-build', reasoningEffort: 'high', maxTokens: 4096 };
 assert.deepEqual(await ctx.listeners.get('agent/request')({}, async () => proposal), proposal);
});

test('session preset still routes older DSH through agent/request without dropping controls', async () => {
 const ctx = presetContext();
 apply(ctx, { agent: 'codex' });
 ctx.listeners.get('agent/created')({ agent: {} });
 assert.deepEqual(await ctx.listeners.get('agent/request')({}, async () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', maxTokens: 2048 })),
  { provider: '1agents-acp', model: 'codex', maxTokens: 2048 });
 assert.throws(() => apply(presetContext(), { agent: '../bad' }), /Invalid ACP Agent name/);
});
