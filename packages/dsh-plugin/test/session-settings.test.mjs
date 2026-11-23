import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionSettings, pinnedOptionError, replayPinnedOptions } from '../dist/session-settings.js';

const cwd = '/workspace/project';
const settingsFile = 'agent-session-settings.json';

function fixture(entries, t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acp-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, settingsFile), JSON.stringify({ version: 1, entries }));
  return { dir, settings: new AgentSessionSettings(dir) };
}

test('antigravity thinking_level pin migrates to thought_level and validates against agy acp', t => {
  const { settings } = fixture([{ cwd, agent: 'antigravity', options: [
    { id: 'thinking_level', value: 'medium' },
    { id: 'model', value: 'claude-opus-5-5', model: true },
  ] }], t);

  const pinned = settings.get(cwd, 'antigravity');
  assert.deepEqual(pinned.options, [
    { id: 'thought_level', value: 'medium' },
    { id: 'model', value: 'claude-opus-5-5', model: true },
  ]);

  // Model selections still replay before other options.
  assert.deepEqual(replayPinnedOptions(pinned.options).map(option => option.id), ['model', 'thought_level']);

  // This is the catalog agy acp 1.5.15 actually advertises.
  const advertised = [
    { id: 'model', options: [{ value: 'claude-opus-5-5' }] },
    { id: 'thought_level', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }] },
  ];
  for (const option of replayPinnedOptions(pinned.options)) {
    assert.equal(pinnedOptionError('antigravity', option, advertised), undefined);
  }
});

test('other agents keep their option ids unchanged', t => {
  const { settings } = fixture([{ cwd, agent: 'grok-build', options: [{ id: 'thinking_level', value: 'medium' }] }], t);
  assert.deepEqual(settings.get(cwd, 'grok-build').options, [{ id: 'thinking_level', value: 'medium' }]);
});

test('an explicit thought_level pin wins over a migrated thinking_level pin', t => {
  const { settings } = fixture([{ cwd, agent: 'antigravity', options: [
    { id: 'thinking_level', value: 'low' },
    { id: 'thought_level', value: 'xhigh' },
  ] }], t);
  assert.deepEqual(settings.get(cwd, 'antigravity').options, [{ id: 'thought_level', value: 'xhigh' }]);
});

test('remember persists the migrated id back to disk', t => {
  const { dir, settings } = fixture([{ cwd, agent: 'antigravity', options: [{ id: 'thinking_level', value: 'medium' }] }], t);
  settings.remember(cwd, 'antigravity', { option: { id: 'model', value: 'gemini-4-neon', model: true } });
  const saved = JSON.parse(readFileSync(join(dir, settingsFile), 'utf8'));
  assert.deepEqual(saved.entries[0].options, [
    { id: 'thought_level', value: 'medium' },
    { id: 'model', value: 'gemini-4-neon', model: true },
  ]);
});
