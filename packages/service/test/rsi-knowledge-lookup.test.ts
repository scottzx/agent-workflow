import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  appendRejectedEdit,
  compileKnowledgeIndex,
  markKnowledgeStale,
  rejectedEditsPath,
} from '../src/rsi/compile.js';
import { lookupLearnings } from '../src/rsi/learnings-lookup.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');

test('compileKnowledgeIndex parses solution docs and append-only rejected-edits.jsonl; stale updates metadata only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-knowledge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'docs/solutions/deploy'), { recursive: true });
  await writeFile(join(dir, 'docs/solutions/README.md'), '# README ignored by index\n');
  await writeFile(
    join(dir, 'docs/solutions/deploy/tarball-version.md'),
    [
      '---',
      'module: scripts/local-deployment',
      'tags: [deploy, tarball, desktop-profile]',
      'problem_type: regression',
      'status: active',
      'source: PR #25',
      'paths:',
      '  - scripts/local-deployment.mjs',
      '---',
      '# 必须按精确版本定位 tarball',
      '禁止通配符匹配 release/*.tgz，必须按 packages/service/package.json 版本号定位。',
      '',
    ].join('\n'),
  );

  await appendRejectedEdit(dir, {
    id: 'rej-symlink-nested',
    module: 'scripts/local-deployment',
    paths: ['scripts/local-deployment.mjs'],
    tags: ['symlink', 'node_modules'],
    problem_type: 'security',
    rule: '禁止对符号链接形态的目标包目录顺链搬移嵌套 node_modules。',
    source: 'PR #25 CR-M1',
  }, () => new Date('2026-11-27T10:00:00.000Z'));

  await appendRejectedEdit(dir, {
    id: 'rej-stale-candidate',
    module: 'scripts/local-deployment',
    paths: ['scripts/local-deployment.mjs'],
    tags: ['deploy'],
    problem_type: 'compatibility',
    rule: '旧版临时兼容约束（标记过时后不再召回）。',
    source: 'PR #12',
  }, () => new Date('2026-11-27T10:05:00.000Z'));

  const jsonlBefore = await readFile(rejectedEditsPath(dir), 'utf8');
  await markKnowledgeStale(dir, 'rej-stale-candidate', {
    reason: 'superseded by PR #25',
    now: () => new Date('2026-11-27T12:00:00.000Z'),
  });
  const jsonlAfter = await readFile(rejectedEditsPath(dir), 'utf8');
  assert.equal(jsonlAfter, jsonlBefore, 'marking stale must NEVER modify or roll back rejected-edits.jsonl body');

  const index = await compileKnowledgeIndex(dir);
  assert.equal(index.entries.length, 3);
  const staleEntry = index.entries.find(e => e.id === 'rej-stale-candidate');
  assert.equal(staleEntry?.status, 'stale');
  assert.equal(staleEntry?.staleReason, 'superseded by PR #25');

  const report = await lookupLearnings({ repoRoot: dir, paths: ['scripts/local-deployment.mjs'] });
  assert.equal(report.ok, true);
  assert.equal(report.activeCount, 2);
  assert.equal(report.matches.length, 2);
  assert.equal(report.matches.some(m => m.id === 'rej-stale-candidate'), false, 'stale entries must not be recalled');
});

test('lookupLearnings caps recall at <= 3 and CLI acp-service rsi lookup returns JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-lookup-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'docs/solutions/rsi'), { recursive: true });
  for (let i = 1; i <= 5; i += 1) {
    await writeFile(
      join(dir, `docs/solutions/rsi/c-${i}.md`),
      `---\nmodule: packages/service/src/rsi\ntags: [rsi, gate]\nproblem_type: regression\nstatus: active\nsource: PR #${20 + i}\n---\n# Rule ${i}\nConstraint body ${i}.\n`,
    );
  }

  const capped = await lookupLearnings({ repoRoot: dir, paths: ['packages/service/src/rsi/gate.ts'], limit: 10 });
  assert.equal(capped.matches.length, 3, 'lookupLearnings hard-caps recall at 3');

  const cli = join(repoRoot, 'packages/service/bin/acp-service.ts');
  const { stdout } = await exec(
    process.execPath,
    ['--import', 'tsx', cli, 'rsi', 'lookup', '--repo', dir, '--paths', 'packages/service/src/rsi/gate.ts', '--json'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { ok: boolean; matches: { id: string }[]; limit: number };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.matches.length, 3);
});
