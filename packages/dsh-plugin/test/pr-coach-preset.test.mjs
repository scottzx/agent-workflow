import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PR_COACH_PRESET_ID,
  PR_COACH_ROLE_ID,
  PR_COACH_SKILLS,
  prCoachPresetDefinition,
  registerPrCoachPreset,
} from '../dist/preset.js';
import * as bundle from '../dist/index.js';

test('oneagents-pr-coach thin preset definition and registerPrCoachPreset register and dispose cleanly without host packages', async () => {
  assert.equal(bundle.PR_COACH_PRESET_ID, PR_COACH_PRESET_ID);
  assert.equal(typeof bundle.registerPrCoachPreset, 'function');

  const def = prCoachPresetDefinition();
  assert.equal(def.id, PR_COACH_PRESET_ID);
  assert.equal(def.roleId, PR_COACH_ROLE_ID);
  assert.deepEqual(def.skills, [...PR_COACH_SKILLS]);
  assert.match(def.plugins[0].config.prefix, /\.1agents\/roles\/pr-coach\/ROLE\.md/);

  const presets = new Map();
  const ctx = {
    agentPresets: {
      register: async definition => {
        presets.set(definition.id, definition);
        return () => presets.delete(definition.id);
      },
    },
  };
  const dispose = await registerPrCoachPreset(ctx);
  assert.ok(presets.has(PR_COACH_PRESET_ID));
  assert.equal(presets.get(PR_COACH_PRESET_ID).name, def.name);
  await dispose();
  assert.equal(presets.size, 0);
});
