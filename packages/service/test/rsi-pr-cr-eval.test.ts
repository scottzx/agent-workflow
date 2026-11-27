import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  coerceCrEvalResults, computeCrEvalDigest, computeManifestSnapshotDigest, crEvalCaseSchema, crEvalManifestSchema, findRepoRoot,
  lintCrEvalManifest, loadCrEvalManifest, parseMarkdownCrReport, scoreCrEvalSuite, verifyCrEvalCommits,
  type CrEvalCase, type CrEvalManifest, type CrReviewResult,
} from '../src/rsi/pr-cr-eval.js';

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../..');
const serviceDir = join(repoRoot, 'packages/service');
const roleDir = join(repoRoot, '.1agents/roles/pr-delivery');
const cli = join(serviceDir, 'bin/acp-service.ts');
const script = join(roleDir, 'checks/run-l3-eval.mjs');

function structured(kase: CrEvalCase): CrReviewResult {
  if (kase.kind === 'positive') {
    return {
      caseId: kase.id, verdict: 'PASS', must: [],
      ...(kase.id === 'pr11-pos-atomic-notify' ? { should: [{ summary: '可以补充说明，但不是必须项' }] } : {}),
    };
  }
  return {
    caseId: kase.id, verdict: 'CHANGES_REQUESTED',
    must: (kase.requiredDefects ?? []).map(defect => ({
      id: defect.id, file: defect.anyFilePatterns[0], summary: `${defect.description} ${defect.anyTextPatterns[0]}`,
    })),
  };
}

function deepSeek(kase: CrEvalCase): string {
  if (kase.kind === 'positive') return ['## 1. VERDICT', '', '**PASS**', '', '## 2. MUST', '', '无', '', '## 3. SHOULD', '', 'None', ''].join('\n');
  const blocks = (kase.requiredDefects ?? []).map((defect, index) => [
    `### M${index + 1} ${defect.id}`, '',
    `\`${defect.anyFilePatterns[0]}\`：${defect.description}（${defect.anyTextPatterns[0]}）`, '',
  ].join('\n'));
  return ['## 1. VERDICT', '', '**CHANGES_REQUESTED**', '', '## 2. MUST', '', ...blocks, '## 3. SHOULD', '', '无。', ''].join('\n');
}

function replace(manifest: CrEvalManifest, caseId: string, review: CrReviewResult): CrReviewResult[] {
  return manifest.cases.map(item => item.id === caseId ? review : structured(item));
}

test('manifest matches >=20 historical PR ranges with ~3:2 class balance, frozen snapshotDigest, and valid commit ancestry', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  assert.equal(manifest.roleId, 'pr-delivery');
  assert.ok(manifest.cases.length >= 20, `expected >= 20 cases, got ${manifest.cases.length}`);
  const negCount = manifest.cases.filter(item => item.kind === 'negative').length;
  const posCount = manifest.cases.filter(item => item.kind === 'positive').length;
  assert.ok(negCount >= 12 && posCount >= 8, `unexpected balance neg=${negCount} pos=${posCount}`);
  const prs = new Set(manifest.cases.map(item => item.pr));
  for (const requiredPr of [11, 12, 13, 14, 15, 18, 19, 20, 22, 23]) {
    assert.ok(prs.has(requiredPr), `missing PR #${requiredPr} coverage`);
  }
  assert.equal(manifest.snapshotDigest, computeManifestSnapshotDigest(manifest));
  const verification = await verifyCrEvalCommits(manifest, repoRoot);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.ok, true);
  assert.equal(verification.checkedCommits, manifest.cases.length * 2);
  const lint = await lintCrEvalManifest(manifest, { repoRoot });
  assert.deepEqual(lint.issues, []);
  assert.equal(lint.ok, true);
  assert.equal(lint.snapshotFrozen, true);
  const digest = await computeCrEvalDigest(roleDir);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await computeCrEvalDigest(roleDir), digest);
  assert.equal(await findRepoRoot(roleDir), await findRepoRoot(repoRoot));
});

test('a clean structured report and a DeepSeek markdown report are promotion ready', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const expectedNeg = manifest.cases.filter(item => item.kind === 'negative').length;
  const expectedPos = manifest.cases.filter(item => item.kind === 'positive').length;
  const expectedDefects = manifest.cases.reduce((sum, item) => sum + (item.requiredDefects?.length ?? 0), 0);
  const structuredScore = scoreCrEvalSuite(manifest, manifest.cases.map(structured));
  assert.equal(structuredScore.passed, true);
  assert.equal(structuredScore.promotionReady, true);
  assert.equal(structuredScore.negativeRecall, 1);
  assert.equal(structuredScore.defectRecall, 1);
  assert.equal(structuredScore.falsePositiveRate, 0);
  assert.equal(structuredScore.negativeCaught, expectedNeg);
  assert.equal(structuredScore.positivePassed, expectedPos);
  assert.equal(structuredScore.totalDefects, expectedDefects);
  assert.deepEqual(structuredScore.missingCases, []);
  const fromMarkdown = scoreCrEvalSuite(manifest, manifest.cases.map(item => parseMarkdownCrReport(item.id, deepSeek(item))));
  assert.equal(fromMarkdown.promotionReady, true);
  assert.equal(fromMarkdown.falsePositiveRate, 0);
  assert.equal(fromMarkdown.negativeRecall, 1);
});

test('markdown verdict forms fail closed unless exactly one legal verdict is present', () => {
  const listed = parseMarkdownCrReport('pr12-neg-worktree-abs-path', [
    '## VERDICT', '', '**CHANGES_REQUESTED**', '', '## MUST', '',
    '- **[M1]** `packages/service/src/a2a/result-metadata.ts` 绝对路径把 `.1agents/worktrees` 内正常文件判成敏感路径。',
    '', '## SHOULD', '', '无',
  ].join('\n'));
  assert.equal(listed.verdict, 'CHANGES_REQUESTED');
  assert.equal(listed.must[0]?.id, 'M1');
  assert.equal(listed.must[0]?.file, 'packages/service/src/a2a/result-metadata.ts');
  assert.equal(listed.should, undefined);
  const inline = parseMarkdownCrReport('pr11-pos-atomic-notify', 'VERDICT: PASS\n\n## MUST\n\n无。\n');
  assert.equal(inline.verdict, 'PASS');
  assert.deepEqual(inline.must, []);
  const ignored = parseMarkdownCrReport('pr11-neg-non-atomic-notify', [
    '## VERDICT', '', '**CHANGES_REQUESTED**', '', '## MUST', '', '### M1', '',
    '不要写成 **PASS**。`packages/service/src/a2a/gateway.ts` 在 ledger.prepare 之后订阅，失败会半持久化。',
  ].join('\n'));
  assert.equal(ignored.verdict, 'CHANGES_REQUESTED');
  assert.equal(ignored.must.length, 1);
  assert.throws(() => parseMarkdownCrReport('x', '## MUST\n\n### M1\n\ngateway.ts broke\n'), /no unique VERDICT/);
  assert.throws(() => parseMarkdownCrReport('x', '## VERDICT: PASS CHANGES_REQUESTED\n\n说明\n'), /no unique VERDICT/);
  assert.throws(() => parseMarkdownCrReport('x', '## VERDICT\n\n看起来可以\n'), /no unique VERDICT/);
  const later = parseMarkdownCrReport('pr14-pos-verified-worktree-fix', [
    '## 1. VERDICT: `PASS`', '', '正文里的 L1 gate: PASS 不是结论，也不要把 CHANGES_REQUESTED 当成这次的 verdict。', '',
    '## 2. MUST（阻塞缺陷）', '', '**无。**',
  ].join('\n'));
  assert.equal(later.verdict, 'PASS');
  assert.deepEqual(later.must, []);
  const firstLine = parseMarkdownCrReport('pos', '## VERDICT\n\nPASS\n\n后文提到 CHANGES_REQUESTED 也不改结论。\n\n## MUST\n\n- 无阻塞项\n');
  assert.equal(firstLine.verdict, 'PASS');
  assert.deepEqual(firstLine.must, []);
});

test('a bold MUST without a hash heading cannot silently pass a real blocker', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const variants = ['**MUST**', '__MUST__', '**2. MUST**', '**MUST（阻塞缺陷）**', '**MUST:**', '**MUST**：'];
  for (const header of variants) {
    const review = parseMarkdownCrReport('pr12-pos-relpath-fix', [
      'VERDICT: PASS', '', header, '',
      '- **[M1]** `packages/service/src/a2a/result-metadata.ts` 绝对路径把 `.1agents/worktrees` 内正常文件误判为敏感。',
    ].join('\n'));
    assert.equal(review.verdict, 'PASS', header);
    assert.equal(review.must.length, 1, header);
    assert.equal(review.must[0]?.id, 'M1', header);
    assert.equal(review.must[0]?.file, 'packages/service/src/a2a/result-metadata.ts', header);
    const scored = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-pos-relpath-fix', review));
    assert.equal(scored.caseResults.find(item => item.caseId === 'pr12-pos-relpath-fix')?.falsePositive, true, header);
    assert.equal(scored.promotionReady, false, header);
  }
});

test('bold or bare MUST stops at SHOULD and still matches the required defect', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const bold = parseMarkdownCrReport('pr11-neg-non-atomic-notify', [
    '**VERDICT**: CHANGES_REQUESTED', '',
    '**MUST**', '',
    '- **[M1]** `packages/service/src/a2a/gateway.ts` notifySessions 在 ledger.prepare 落盘之后才订阅，失败会半持久化。', '',
    '**SHOULD**', '',
    '- 可以补注释，但不要把 README.md 的 schemaVersion 不兼容算进必须项。', '',
    '**VERIFIED_CHECKS**', '',
    '已核对 packages/service/src/a2a/job-directory.ts 的 runtime/jobs，这不是这一条 MUST。',
  ].join('\n'));
  assert.equal(bold.verdict, 'CHANGES_REQUESTED');
  assert.equal(bold.must.length, 1);
  assert.match(bold.must[0]?.summary ?? '', /gateway\.ts/);
  assert.match(bold.must[0]?.summary ?? '', /半持久化/);
  assert.doesNotMatch(bold.must[0]?.summary ?? '', /schemaVersion|runtime\/jobs/);
  assert.equal(bold.should?.length, 1);
  assert.match(bold.should?.[0]?.summary ?? '', /schemaVersion/);
  const boldScore = scoreCrEvalSuite(manifest, replace(manifest, 'pr11-neg-non-atomic-notify', bold));
  assert.deepEqual(boldScore.caseResults.find(item => item.caseId === 'pr11-neg-non-atomic-notify')?.missedDefects, []);

  const bare = parseMarkdownCrReport('pr12-neg-worktree-abs-path', [
    'VERDICT: CHANGES_REQUESTED', '',
    'MUST:',
    '- **[M1]** `packages/service/src/a2a/result-metadata.ts` 绝对路径把 `.1agents/worktrees` 内正常文件误判为敏感。', '',
    'MUST：',
    '- **[M2]** 这条空节头后面的重复项应该并进 MUST，而不是被丢掉。', '',
    '__SHOULD__', '',
    '建议补一条回归。', '',
    '**结论**', '',
    'packages/service/src/a2a/job-directory.ts 的 runtime/jobs 不要并进上面的 MUST。',
  ].join('\n'));
  assert.equal(bare.must.length, 2);
  assert.equal(bare.must[0]?.file, 'packages/service/src/a2a/result-metadata.ts');
  assert.doesNotMatch(bare.must.map(item => item.summary).join('\n'), /runtime\/jobs/);
  assert.equal(bare.should?.length, 1);
  const bareScore = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-neg-worktree-abs-path', bare));
  assert.deepEqual(bareScore.caseResults.find(item => item.caseId === 'pr12-neg-worktree-abs-path')?.missedDefects, []);
});

test('a bold empty MUST still normalizes to no findings', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const review = parseMarkdownCrReport('pr14-pos-verified-worktree-fix', [
    '**VERDICT**', '', '**PASS**', '',
    '正文里写无 MUST、0 MUST 也不能再变出一条缺陷。', '',
    '**MUST**', '', '**无。**',
  ].join('\n'));
  assert.equal(review.verdict, 'PASS');
  assert.deepEqual(review.must, []);
  const scored = scoreCrEvalSuite(manifest, replace(manifest, 'pr14-pos-verified-worktree-fix', review));
  assert.equal(scored.caseResults.find(item => item.caseId === 'pr14-pos-verified-worktree-fix')?.falsePositive, false);
  assert.equal(scored.promotionReady, true);
});

test('an inline MUST line and a bare blocker marker are not zero findings', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const inline = parseMarkdownCrReport('pr11-neg-non-atomic-notify', [
    'VERDICT: CHANGES_REQUESTED',
    '**MUST**: `packages/service/src/a2a/gateway.ts` 在 ledger.prepare 落盘之后订阅，形成半持久化。',
    'MUST: `packages/service/src/a2a/notifications.ts` 重放漏订也要留在这一节。',
  ].join('\n'));
  assert.equal(inline.verdict, 'CHANGES_REQUESTED');
  assert.equal(inline.must.length, 2);
  assert.match(inline.must.map(item => item.summary).join('\n'), /gateway\.ts/);
  assert.match(inline.must.map(item => item.summary).join('\n'), /notifications\.ts/);
  assert.match(inline.must.map(item => item.summary).join('\n'), /半持久化/);
  const inlineScore = scoreCrEvalSuite(manifest, replace(manifest, 'pr11-neg-non-atomic-notify', inline));
  assert.deepEqual(inlineScore.caseResults.find(item => item.caseId === 'pr11-neg-non-atomic-notify')?.missedDefects, []);

  const loose = parseMarkdownCrReport('pr12-pos-relpath-fix', [
    'VERDICT: PASS', '',
    '没有 MUST 节头，但下面这条不是“无 MUST”。', '',
    '**[M1]** `packages/service/src/a2a/result-metadata.ts` 绝对路径仍会误判 `.1agents/worktrees`。', '',
    '### M2', '',
    '`packages/service/src/a2a/result-metadata.ts` 另一处绝对路径误判。',
  ].join('\n'));
  assert.equal(loose.verdict, 'PASS');
  assert.equal(loose.must.length, 2);
  assert.deepEqual(loose.must.map(item => item.id), ['M1', 'M2']);
  const looseScore = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-pos-relpath-fix', loose));
  assert.equal(looseScore.caseResults.find(item => item.caseId === 'pr12-pos-relpath-fix')?.falsePositive, true);

  const prose = parseMarkdownCrReport('pr14-pos-verified-worktree-fix', [
    'VERDICT: PASS', '',
    '本次无 MUST，0 MUST，没有阻塞项。审查时如果看到 MUST: 先写入再校验就退回。', '',
    '**SHOULD**', '',
    '- **[M1]** 这条放在建议里，不能当成阻塞项。',
  ].join('\n'));
  assert.equal(prose.verdict, 'PASS');
  assert.deepEqual(prose.must, []);
  assert.equal(prose.should?.length, 1);
});

test('a fenced bold MUST does not create a phantom finding', () => {
  const fenced = parseMarkdownCrReport('pr14-pos-verified-worktree-fix', [
    'VERDICT: PASS', '',
    '```md',
    '**MUST**',
    '### M1 phantom',
    '- **[M1]** `packages/service/src/a2a/gateway.ts` ledger.prepare 半持久化',
    '```', '',
    '正文说无 MUST。',
  ].join('\n'));
  assert.equal(fenced.verdict, 'PASS');
  assert.deepEqual(fenced.must, []);
  const closed = parseMarkdownCrReport('pos', [
    '## VERDICT', '', 'PASS', '',
    '```',
    '**MUST**',
    'MUST: `gateway.ts` 这是示例，不是缺陷。',
    '```', '',
    '**MUST**', '', '**无。**',
  ].join('\n'));
  assert.equal(closed.verdict, 'PASS');
  assert.deepEqual(closed.must, []);
});

test('bold empty MUST and fenced sample headings do not create findings', () => {
  const pass = parseMarkdownCrReport('pr14-pos-verified-worktree-fix', [
    '## 1. VERDICT: `PASS`', '', '## 2. MUST（阻塞缺陷）', '', '**无。**', '',
    '```md', '## MUST', '### M1 phantom', '`gateway.ts` ledger.prepare 半持久化', '```',
  ].join('\n'));
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.must.length, 0);
  for (const body of ['**无。**', '- 无阻塞项', '> 无阻塞缺陷', '`none`', '无（已关闭）', '0', 'no must issues']) {
    const parsed = parseMarkdownCrReport('pos', `## VERDICT\n\n**PASS**\n\n## MUST\n\n${body}\n`);
    assert.deepEqual(parsed.must, [], body);
  }
});

test('one vague MUST cannot pay for every defect, but an overlapping pair still matches', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const vague = parseMarkdownCrReport('pr12-neg-sandbox-and-inherit', [
    '## VERDICT', '', '**CHANGES_REQUESTED**', '', '## MUST', '',
    '`packages/service/src/a2a/gateway.ts` worktreeRepoRoot 挪到 runtime/jobs 越出 cwd 和沙箱；另外不继承上一轮 deliveryMode，execution_continue 的语义也值得再看。',
  ].join('\n'));
  assert.equal(vague.must.length, 1);
  const blurred = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-neg-sandbox-and-inherit', vague));
  assert.equal(blurred.passed, false);
  assert.equal(blurred.promotionReady, false);
  assert.equal(blurred.caseResults.find(item => item.caseId === 'pr12-neg-sandbox-and-inherit')?.matchedDefects.length, 1);
  const packed = parseMarkdownCrReport('pr13-neg-schema-symlink-ignore', [
    '## VERDICT', '', '**CHANGES_REQUESTED**', '', '## MUST', '',
    '`checklist.json` schemaVersion 不兼容，`worktree-projection.ts` 的 symlink 会半写，`.gitignore` 的 `**/.agents/` 遮蔽了已跟踪的 autoreview。',
  ].join('\n'));
  const packedScore = scoreCrEvalSuite(manifest, replace(manifest, 'pr13-neg-schema-symlink-ignore', packed));
  assert.equal(packed.must.length, 1);
  assert.equal(packedScore.promotionReady, false);
  const ordered = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-neg-sandbox-and-inherit', {
    caseId: 'pr12-neg-sandbox-and-inherit', verdict: 'CHANGES_REQUESTED',
    must: [
      { file: 'packages/service/src/a2a/gateway.ts', summary: 'runtime/jobs 越出 cwd，并且不继承上一轮 deliveryMode' },
      { file: 'packages/service/src/a2a/job-directory.ts', summary: 'runtime/jobs 越出 cwd' },
    ],
  }));
  const both = ordered.caseResults.find(item => item.caseId === 'pr12-neg-sandbox-and-inherit');
  assert.deepEqual(both?.missedDefects, []);
  assert.deepEqual(both?.matchedDefects, ['job-dir-outside-cwd', 'continue-misses-delivery-mode']);
  assert.equal(ordered.promotionReady, true);
});

test('missing one required defect or citing the wrong file blocks promotion', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const partial = replace(manifest, 'pr12-neg-sandbox-and-inherit', {
    caseId: 'pr12-neg-sandbox-and-inherit', verdict: 'CHANGES_REQUESTED',
    must: [{
      id: 'job-dir-outside-cwd', file: 'packages/service/src/a2a/job-directory.ts',
      summary: 'worktreeRepoRoot 把目录放到 runtime/jobs，越出 cwd',
    }],
  });
  const missed = scoreCrEvalSuite(manifest, partial);
  assert.equal(missed.passed, false);
  assert.equal(missed.promotionReady, false);
  const row = missed.caseResults.find(item => item.caseId === 'pr12-neg-sandbox-and-inherit');
  assert.deepEqual(row?.missedDefects, ['continue-misses-delivery-mode']);
  assert.deepEqual(row?.matchedDefects, ['job-dir-outside-cwd']);
  const wrongFile = replace(manifest, 'pr12-neg-worktree-abs-path', {
    caseId: 'pr12-neg-worktree-abs-path', verdict: 'CHANGES_REQUESTED',
    must: [{ file: 'README.md', summary: 'isSensitiveWorkspaceFile 用绝对路径误伤了正常文件' }],
  });
  const wrong = scoreCrEvalSuite(manifest, wrongFile);
  assert.equal(wrong.promotionReady, false);
  assert.deepEqual(wrong.caseResults.find(item => item.caseId === 'pr12-neg-worktree-abs-path')?.missedDefects, ['abs-worktree-false-sensitive']);
});

test('a positive CHANGES_REQUESTED or a PASS that still has MUST is a false positive', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const requested = scoreCrEvalSuite(manifest, replace(manifest, 'pr12-pos-relpath-fix', {
    caseId: 'pr12-pos-relpath-fix', verdict: 'CHANGES_REQUESTED',
    must: [{ summary: '还要再看一眼', file: 'packages/service/src/a2a/result-metadata.ts' }],
  }));
  assert.equal(requested.passed, false);
  assert.equal(requested.falsePositives, 1);
  assert.equal(requested.falsePositiveRate, 1 / manifest.cases.filter(item => item.kind === 'positive').length);
  assert.equal(requested.caseResults.find(item => item.caseId === 'pr12-pos-relpath-fix')?.falsePositive, true);
  const dirtyPass = scoreCrEvalSuite(manifest, replace(manifest, 'pr14-pos-verified-worktree-fix', {
    caseId: 'pr14-pos-verified-worktree-fix', verdict: 'PASS',
    must: [{ summary: '顺手记了一条必须项', file: 'packages/service/src/roles/role-rules.ts' }],
  }));
  assert.equal(dirtyPass.passed, false);
  assert.equal(dirtyPass.falsePositives, 1);
  assert.equal(dirtyPass.promotionReady, false);
});

test('missing, duplicate, and unknown cases fail closed', async () => {
  const manifest = await loadCrEvalManifest(roleDir);
  const reviews = manifest.cases.map(structured);
  const missing = scoreCrEvalSuite(manifest, reviews.filter(item => item.caseId !== 'pr13-pos-projection-hardened'));
  assert.equal(missing.passed, false);
  assert.equal(missing.promotionReady, false);
  assert.deepEqual(missing.missingCases, ['pr13-pos-projection-hardened']);
  assert.throws(() => scoreCrEvalSuite(manifest, [...reviews, reviews[0]]), /duplicate CR result/);
  assert.throws(() => scoreCrEvalSuite(manifest, [...reviews, { caseId: 'not-a-case', verdict: 'PASS', must: [] }]), /unknown CR result/);
  assert.deepEqual(coerceCrEvalResults({ results: [{ caseId: 'pr11-pos-atomic-notify', markdown: 'VERDICT: PASS\n\n## MUST\n\nNone\n' }] }).map(item => item.verdict), ['PASS']);
});

test('case schema rejects a positive defect list and a negative PASS', () => {
  const defect = { id: 'x', description: 'd', anyFilePatterns: ['a.ts'], anyTextPatterns: ['bug'] };
  assert.throws(() => crEvalCaseSchema.parse({
    id: 'pos', pr: 1, kind: 'positive', baseCommit: '69c136b5', headCommit: 'cc1b0ac3', expectedVerdict: 'PASS', summary: 'clean', requiredDefects: [defect],
  }));
  assert.throws(() => crEvalCaseSchema.parse({
    id: 'neg', pr: 1, kind: 'negative', baseCommit: '69c136b5', headCommit: 'cc1b0ac3', expectedVerdict: 'PASS', summary: 'bad', requiredDefects: [defect],
  }));
  assert.throws(() => crEvalCaseSchema.parse({
    id: 'upper', pr: 1, kind: 'positive', baseCommit: '69C136B5', headCommit: 'cc1b0ac3', expectedVerdict: 'PASS', summary: 'sha',
  }));
  assert.throws(() => crEvalManifestSchema.parse({
    schemaVersion: 1, roleId: 'pr-delivery',
    cases: [
      { id: 'same', pr: 1, kind: 'positive', baseCommit: '69c136b5', headCommit: 'cc1b0ac3', expectedVerdict: 'PASS', summary: 'a' },
      { id: 'same', pr: 1, kind: 'positive', baseCommit: '69c136b5', headCommit: 'cc1b0ac3', expectedVerdict: 'PASS', summary: 'b' },
    ],
  }));
});

test('a manifest symlink that leaves the role directory is refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-eval-escape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const role = join(root, 'role');
  await mkdir(join(role, 'evals'), { recursive: true });
  await writeFile(join(role, 'profile.json'), '{"id":"pr-delivery"}\n');
  await writeFile(join(role, 'QA.md'), '# qa\n');
  await writeFile(join(role, 'checklist.json'), '{}\n');
  const outside = join(root, 'outside.json');
  await writeFile(outside, '{"schemaVersion":1,"roleId":"pr-delivery","cases":[]}\n');
  await symlink(outside, join(role, 'evals', 'manifest.json'));
  await assert.rejects(loadCrEvalManifest(role), /symlink escapes/);
  await assert.rejects(computeCrEvalDigest(role), /symlink escapes/);
});

test('findRepoRoot rejects a symlinked .git instead of walking into the parent repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-eval-gitlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, 'nested');
  await mkdir(nested);
  await symlink(join(repoRoot, '.git'), join(nested, '.git'));
  await assert.rejects(findRepoRoot(nested), /symlink is not a repository anchor/);
});

test('commit verification fails closed when the SHAs are not in that repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cr-eval-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const manifest = await loadCrEvalManifest(roleDir);
  const verification = await verifyCrEvalCommits(manifest, root);
  assert.equal(verification.ok, false);
  assert.equal(verification.checkedCommits, 0);
  assert.ok(verification.errors.length >= 9);
});

async function spawn(args: string[], cwd = serviceDir): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await exec(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90_000 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr ?? '' };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('eval-cr CLI and run-l3-eval.mjs agree on verify-only, pass, and fail', { timeout: 180_000 }, async t => {
  const manifest = await loadCrEvalManifest(roleDir);
  const dir = await mkdtemp(join(tmpdir(), 'cr-eval-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const passFile = join(dir, 'pass.json');
  const failFile = join(dir, 'fail.json');
  await writeFile(passFile, JSON.stringify({ results: manifest.cases.map(item => ({ caseId: item.id, markdown: deepSeek(item) })) }));
  const failed = manifest.cases.map(item => ({ caseId: item.id, markdown: deepSeek(item) }));
  failed[1] = { caseId: failed[1].caseId, markdown: '## VERDICT\n\n**CHANGES_REQUESTED**\n\n## MUST\n\n### M1\n\n`README.md` 这是正样本上的误报。\n' };
  await writeFile(failFile, JSON.stringify(failed));
  const help = await spawn(['--import', 'tsx', cli, 'rsi', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /rsi eval-cr --role DIR/);
  const unified = await spawn(['--import', 'tsx', cli, '--help']);
  assert.equal(unified.status, 0, unified.stderr);
  assert.match(unified.stdout, /rsi eval-cr --role/);

  const checks: { label: string; args: string[]; status: number; mode?: string; promotionReady?: boolean }[] = [
    { label: 'cli verify', args: ['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--json'], status: 0, mode: 'verify-only' },
    { label: 'cli verify repo', args: ['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--json'], status: 0, mode: 'verify-only' },
    { label: 'script verify', args: [script, '--role-dir', roleDir, '--repo', repoRoot, '--json'], status: 0, mode: 'verify-only' },
    { label: 'cli pass', args: ['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--results', passFile, '--workspace', dir, '--json'], status: 0, mode: 'score', promotionReady: true },
    { label: 'script pass', args: [script, '--role-dir', roleDir, '--repo', repoRoot, '--results', passFile, '--workspace', dir, '--json'], status: 0, mode: 'score', promotionReady: true },
    { label: 'cli fail', args: ['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--results', failFile, '--workspace', dir, '--json'], status: 1, mode: 'score', promotionReady: false },
    { label: 'script fail', args: [script, '--role-dir', roleDir, '--repo', repoRoot, '--results', failFile, '--workspace', dir, '--json'], status: 1, mode: 'score', promotionReady: false },
  ];
  for (const check of checks) {
    const result = await spawn(check.args);
    assert.equal(result.status, check.status, `${check.label}\n${result.stderr}\n${result.stdout}`);
    const body = JSON.parse(result.stdout) as { mode: string; ok: boolean; checkedCommits?: number; totalCases?: number; promotionReady?: boolean; falsePositives?: number; negativeRecall?: number };
    assert.equal(body.mode, check.mode, check.label);
    if (check.mode === 'verify-only') {
      assert.equal(body.ok, true, check.label);
      assert.equal(body.checkedCommits, manifest.cases.length * 2, check.label);
      assert.equal(body.totalCases, manifest.cases.length, check.label);
    } else {
      assert.equal(body.promotionReady, check.promotionReady, check.label);
      assert.equal(body.ok, check.promotionReady, check.label);
      if (check.promotionReady) {
        assert.equal(body.negativeRecall, 1, check.label);
        assert.equal(body.falsePositives, 0, check.label);
      } else assert.equal(body.falsePositives, 1, check.label);
    }
  }
  const missing = await spawn(['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--results', join(dir, 'missing.json')]);
  assert.equal(missing.status, 1);
  assert.match(`${missing.stderr}\n${missing.stdout}`, /does not exist/);
  assert.doesNotMatch(`${missing.stderr}\n${missing.stdout}`, /not valid JSON/);
  await writeFile(join(dir, 'bad.json'), '{');
  const invalid = await spawn(['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--results', join(dir, 'bad.json')]);
  assert.equal(invalid.status, 1);
  assert.match(`${invalid.stderr}\n${invalid.stdout}`, /not valid JSON/);
  assert.doesNotMatch(`${invalid.stderr}\n${invalid.stdout}`, /does not exist/);
});

test('run-l3-eval resolves relative role, repo and results from the caller cwd', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-eval-rel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = await loadCrEvalManifest(roleDir);
  const passFile = join(dir, 'pass.json');
  await writeFile(passFile, JSON.stringify(manifest.cases.map(item => ({ caseId: item.id, markdown: deepSeek(item) }))));
  const result = await spawn([
    script, '--role-dir=.1agents/roles/pr-delivery', '--repo=.', '--results', relative(repoRoot, passFile), '--workspace', relative(repoRoot, dir), '--json',
  ], repoRoot);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const body = JSON.parse(result.stdout) as { mode: string; repoRoot: string; promotionReady: boolean; ok: boolean };
  assert.equal(body.mode, 'score');
  assert.equal(body.repoRoot, repoRoot);
  assert.equal(body.promotionReady, true);
  assert.equal(body.ok, true);
});

test('lintCrEvalManifest enforces minCases, class balance, dedup, defect discrimination, git diff match, and snapshotDigest freeze', async t => {
  const manifest = await loadCrEvalManifest(roleDir);

  // 1. Tampering any case breaks snapshotDigest in both lintCrEvalManifest and loadCrEvalManifest.
  const tampered: CrEvalManifest = structuredClone(manifest);
  tampered.cases[0]!.summary = `${tampered.cases[0]!.summary} (tampered)`;
  const tamperLint = await lintCrEvalManifest(tampered);
  assert.equal(tamperLint.ok, false);
  assert.ok(tamperLint.issues.some(i => i.code === 'snapshot_digest_mismatch'));

  const tmpRole = await mkdtemp(join(tmpdir(), 'cr-eval-tamper-'));
  t.after(() => rm(tmpRole, { recursive: true, force: true }));
  await mkdir(join(tmpRole, 'evals'), { recursive: true });
  await writeFile(join(tmpRole, 'profile.json'), '{"id":"pr-delivery"}\n');
  await writeFile(join(tmpRole, 'evals', 'manifest.json'), JSON.stringify(tampered, null, 2));
  await assert.rejects(loadCrEvalManifest(tmpRole), /snapshotDigest mismatch/);

  // 2. Missing snapshotDigest fails lint.
  const { snapshotDigest: _omit, ...unfrozen } = structuredClone(manifest);
  const unfrozenLint = await lintCrEvalManifest(unfrozen as CrEvalManifest);
  assert.equal(unfrozenLint.ok, false);
  assert.ok(unfrozenLint.issues.some(i => i.code === 'snapshot_digest_missing'));

  // 3. Class imbalance + minCases + duplicate commit pair + duplicate defect id + weak patterns + unmatched git diff file pattern.
  const brokenCases: CrEvalCase[] = [
    structuredClone(manifest.cases[0]!),
    {
      ...structuredClone(manifest.cases[0]!),
      id: 'dup-commit-pair',
      requiredDefects: [
        {
          id: manifest.cases[0]!.requiredDefects![0]!.id,
          description: 'duplicate defect id + weak patterns',
          anyFilePatterns: ['src'],
          anyTextPatterns: ['bug', 'x'],
        },
        {
          id: 'unmatched-file-pattern-defect',
          description: 'file pattern absent from real git diff',
          anyFilePatterns: ['packages/service/src/nonexistent-file-for-diff.ts'],
          anyTextPatterns: ['nonexistent-pattern-token'],
        },
      ],
    },
  ];
  const brokenManifest: CrEvalManifest = {
    schemaVersion: 1,
    roleId: 'pr-delivery',
    cases: brokenCases,
  };
  brokenManifest.snapshotDigest = computeManifestSnapshotDigest(brokenManifest);
  const brokenLint = await lintCrEvalManifest(brokenManifest, { repoRoot });
  assert.equal(brokenLint.ok, false);
  const codes = new Set(brokenLint.issues.map(i => i.code));
  assert.ok(codes.has('min_cases'));
  assert.ok(codes.has('class_balance'));
  assert.ok(codes.has('duplicate_commit_pair'));
  assert.ok(codes.has('duplicate_defect_id'));
  assert.ok(codes.has('weak_file_pattern'));
  assert.ok(codes.has('weak_text_pattern'));
  assert.ok(codes.has('unmatched_diff_file_pattern'));

  // 4. CLI and run-l3-eval --lint pass on real manifest and reject --lint + --results.
  const cliLint = await spawn(['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--repo', repoRoot, '--lint', '--json']);
  assert.equal(cliLint.status, 0, `${cliLint.stderr}\n${cliLint.stdout}`);
  const cliBody = JSON.parse(cliLint.stdout) as { mode: string; ok: boolean; snapshotFrozen: boolean; totalCases: number };
  assert.equal(cliBody.mode, 'lint');
  assert.equal(cliBody.ok, true);
  assert.equal(cliBody.snapshotFrozen, true);
  assert.ok(cliBody.totalCases >= 20);

  const scriptLint = await spawn([script, '--role-dir', roleDir, '--repo', repoRoot, '--lint', '--json']);
  assert.equal(scriptLint.status, 0, `${scriptLint.stderr}\n${scriptLint.stdout}`);
  assert.equal((JSON.parse(scriptLint.stdout) as { ok: boolean }).ok, true);

  const conflict = await spawn(['--import', 'tsx', cli, 'rsi', 'eval-cr', '--role', roleDir, '--lint', '--results', 'dummy.json']);
  assert.equal(conflict.status, 1);
  assert.match(`${conflict.stderr}\n${conflict.stdout}`, /cannot be combined/);
});
