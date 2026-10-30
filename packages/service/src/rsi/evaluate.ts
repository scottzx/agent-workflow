/**
 * Re-verification of a proposed version: every case runs from the version's frozen copy in a fresh session,
 * and the results go onto the version for the release gate. A case that cannot run is a failure, not a skip.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { runOutlineCase, type OutlineRunOptions } from './outline-run.js';
import type { RoleVersion, VersionEvaluation } from './versions.js';

export interface EvaluateOptions extends Omit<OutlineRunOptions, 'roleDirectory' | 'caseId' | 'projectPath'> {
  roleId: string; version: string;
  /** Local clones by repository name, e.g. `scottzx/xingjian-showroom`. */
  projects: Record<string, string>;
}

export async function evaluateVersion(options: EvaluateOptions): Promise<RoleVersion> {
  const log = options.log ?? (() => {});
  const listed = await options.invoke('rsi_version_list', { roleId: options.roleId }) as { versions: RoleVersion[] };
  const record = listed.versions.find(item => item.version === options.version);
  if (!record || record.status !== 'proposed') throw new Error(`${options.version} is not a proposed version of ${options.roleId}`);
  const root = record.snapshot.directory, cases = [];
  for (const name of (await readdir(path.join(root, 'cases'))).sort()) {
    const kase = JSON.parse(await readFile(path.join(root, 'cases', name, 'case.json'), 'utf8')) as { id: string; kind: 'original' | 'variant'; input: { repo: string }; features: string | null };
    cases.push(kase);
  }
  cases.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'original' ? -1 : 1));

  const results: VersionEvaluation['results'] = [];
  for (const kase of cases) {
    const failed = (item: string) => { results.push({ caseId: kase.id, kind: kase.kind, passed: false, rounds: 0, failedItems: [item] }); log(`${kase.id}：未运行（${item}）`); };
    if (!kase.features) { failed('features-unconfirmed'); continue; }
    const projectPath = options.projects[kase.input.repo];
    if (!projectPath) { failed('project-unavailable'); continue; }
    log(`${kase.id}（${kase.kind === 'original' ? '原题' : '变体'}）开始`);
    try {
      const report = await runOutlineCase({ ...options, roleDirectory: root, caseId: kase.id, projectPath });
      const last = report.rounds.at(-1)!;
      results.push({ caseId: kase.id, kind: kase.kind, jobId: last.jobId, passed: report.passed, rounds: report.rounds.length,
        ...(last.outlineSha256 ? { outlineSha256: last.outlineSha256 } : {}),
        failedItems: last.executionStatus === 'completed' ? last.results.filter(item => !item.pass).map(item => item.itemId) : [last.executionStatus] });
    } catch (error) {
      log(`${kase.id}：运行出错 ${error instanceof Error ? error.message : String(error)}`);
      failed('run-error');
    }
  }
  return await options.invoke('rsi_version_evaluation', { roleId: options.roleId, version: options.version,
    evaluation: { evaluatedAt: new Date().toISOString(), results } }) as RoleVersion;
}
