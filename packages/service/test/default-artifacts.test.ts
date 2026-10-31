import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { artifactInstructions, defaultJobDirectory, defaultManifestPath, isDefaultJobDirectory } from '../src/a2a/job-directory.js';
import { runA2APreflight } from '../src/a2a/preflight.js';
import { createA2AResultMetadata } from '../src/a2a/result-metadata.js';

async function project() { return realpath(await mkdtemp(join(tmpdir(), 'default-artifacts-'))); }

test('the default location is per job and recognised only below .1agents/jobs', () => {
  assert.equal(defaultJobDirectory('/p', 'j1'), '/p/.1agents/jobs/j1');
  assert.equal(defaultManifestPath('/p', 'j1', 'a1'), '/p/.1agents/jobs/j1/manifest-a1.json');
  assert.ok(isDefaultJobDirectory('/p', '/p/.1agents/jobs/j1'));
  for (const other of ['/p', '/p/.1agents/jobs', '/p/.1agents/jobs/../x', '/p/src', '/q/.1agents/jobs/j1']) assert.ok(!isDefaultJobDirectory('/p', other), other);
  const text = artifactInstructions('/p/.1agents/jobs/j1', '/p/.1agents/jobs/j1/manifest-a1.json');
  assert.match(text, /manifest-a1\.json/); assert.match(text, /\/p\/\.1agents\/jobs\/j1\//);
});

test('preflight creates the default job directory but not arbitrary ones, and never through symlinks', async () => {
  const cwd = await project(), directory = defaultJobDirectory(cwd, 'job-1');
  const report = await runA2APreflight({ cwd, jobDirectory: directory });
  assert.equal(report.ok, true); assert.equal(report.jobDirectory, directory);
  assert.equal((await runA2APreflight({ cwd, jobDirectory: join(cwd, 'elsewhere') })).ok, false, 'only the default location is created');

  const outside = await project(); await mkdir(join(cwd, '.1agents-x'));
  await mkdir(join(cwd, '.1agents', 'jobs'), { recursive: true });
  await symlink(outside, join(cwd, '.1agents', 'jobs', 'evil'));
  const escaped = await runA2APreflight({ cwd, jobDirectory: defaultJobDirectory(cwd, 'evil') });
  assert.equal(escaped.ok, false);
});

async function admitted(cwd: string, jobId: string) {
  const directory = defaultJobDirectory(cwd, jobId), manifest = defaultManifestPath(cwd, jobId, 'attempt-1');
  const preflight = await runA2APreflight({ cwd, jobDirectory: directory });
  return { directory, manifest, target: { sessionId: 's', cwd, preflight } as any,
    metadata: () => createA2AResultMetadata({ taskId: 't', contextId: 'c', requestId: 'r', startedAt: new Date().toISOString(), outcome: 'completed',
      target: { sessionId: 's', cwd, preflight } as any, contract: { jobId, artifactManifestPath: manifest } }) };
}

test('a completed task without a manifest simply has no artifacts', async () => {
  const f = await admitted(await project(), 'job-a');
  const result = await f.metadata();
  assert.deepEqual([result.artifacts, result.validation.status], [[], 'not-requested']);
});

test('files listed in the default manifest are verified and reported', async () => {
  const cwd = await project(), f = await admitted(cwd, 'job-b');
  const file = join(f.directory, 'report.md'); await writeFile(file, '# hi\n');
  await writeFile(f.manifest, JSON.stringify({ artifacts: [{ path: file, mediaType: 'text/markdown' }] }));
  const result = await f.metadata();
  assert.equal(result.validation.status, 'passed');
  assert.deepEqual(result.artifacts.map(item => [item.path, item.size, item.mediaType]), [[file, 5, 'text/markdown']]);
  assert.match(result.artifacts[0]!.sha256, /^[0-9a-f]{64}$/);
});

test('a bad default manifest is recorded in validation and does not fail the task', async () => {
  const cwd = await project(), f = await admitted(cwd, 'job-c');
  await writeFile(f.manifest, '{not json');
  const garbled = await f.metadata();
  assert.deepEqual([garbled.artifacts, garbled.validation], [[], { status: 'failed', code: 'artifact-manifest-or-file-unavailable' }]);

  const secret = join(await project(), 'secret.txt'); await writeFile(secret, 'x');
  await writeFile(f.manifest, JSON.stringify({ artifacts: [{ path: secret }] }));
  const outside = await f.metadata();
  assert.deepEqual([outside.artifacts, outside.validation.code], [[], 'artifact-outside-job-directory']);
  assert.ok((await readFile(f.manifest, 'utf8')).includes('secret.txt'));
});

test('a caller-declared manifest keeps its strict behaviour', async () => {
  const cwd = await project(), directory = join(cwd, 'declared'); await mkdir(directory);
  const preflight = await runA2APreflight({ cwd, jobDirectory: directory });
  await assert.rejects(createA2AResultMetadata({ taskId: 't', contextId: 'c', requestId: 'r', startedAt: new Date().toISOString(), outcome: 'completed',
    target: { sessionId: 's', cwd, preflight } as any, contract: { jobId: 'j', artifactManifestPath: join(directory, 'missing.json') } }), /artifact-manifest-or-file-unavailable/);
});
