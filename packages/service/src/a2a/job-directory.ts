/**
 * Default per-task artifact location, relative to the task's cwd on the execution host:
 * `<cwd>/.1agents/jobs/<jobId>/`, including when cwd is a worktree. The directory stays inside
 * the DSH workspace-write root; `.gitignore` keeps it out of `git status`. Pure POSIX path
 * arithmetic, because the host interprets the path.
 */
import { posix } from 'node:path';
import { z } from 'zod';

export const deliveryModeSchema = z.enum(['artifacts', 'workspace_git', 'workspace_files', 'none']);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;

export const defaultJobDirectory = (cwd: string, jobId: string): string => posix.join(cwd, '.1agents', 'jobs', jobId);
export const defaultManifestPath = (cwd: string, jobId: string, attemptId: string): string => posix.join(defaultJobDirectory(cwd, jobId), `manifest-${attemptId}.json`);

/** Default job directory. Always `<cwd>/.1agents/jobs/<jobId>`, never a path outside cwd. */
export function resolveDefaultJobDirectory(cwd: string, jobId: string): string {
  return defaultJobDirectory(cwd, jobId);
}

/** True for a directory strictly below `<cwd>/.1agents/jobs`. */
export function isDefaultJobDirectory(cwd: string, directory: string): boolean {
  const tail = posix.relative(posix.join(cwd, '.1agents', 'jobs'), directory);
  return tail !== '' && tail !== '..' && !tail.startsWith('../') && !posix.isAbsolute(tail);
}

/** True for the default job directory of this cwd. Same boundary as `isDefaultJobDirectory`. */
export function isManagedJobDirectory(cwd: string, directory: string): boolean {
  return isDefaultJobDirectory(cwd, directory);
}

/** The agent-facing contract, appended to the task prompt. */
export function artifactInstructions(directory: string, manifest: string): string {
  return `\n\n---\n[产物约定] 如果本任务产生了需要交付或审核的文件，请把它们写到目录 ${directory}/ 下（目录已创建），\n`
    + `并在结束前写入清单 ${manifest}，格式：{"artifacts":[{"path":"<文件绝对路径>","mediaType":"<可选>"}]}。\n`
    + '清单里的文件必须在该任务目录或已告知的共享产物空间内；只有登记在清单里、并通过校验的文件才会作为产物展示。没有交付文件时不要创建清单。';
}

/** Prompt suffix for one delivery mode. `artifacts` keeps the manifest contract; `none` adds nothing. */
export function deliveryInstructions(mode: DeliveryMode | undefined, directory?: string, manifest?: string): string {
  const resolved = mode ?? 'artifacts';
  if (resolved === 'none') return '';
  if (resolved === 'workspace_git') {
    return '\n\n---\n[代码交付约定] 在当前工作区或隔离分支上原地修改，并提交一个干净的 commit。'
      + '禁止把 `.1agents/` 或临时文件纳入提交。无需手工创建 manifest.json；宿主在任务结束时会自动采样分支与 commit 并校验。';
  }
  if (resolved === 'workspace_files') {
    if (!manifest) return '\n\n---\n[项目文档交付约定] 可以直接在当前项目目录原地写入或修改文件，无需复制副本。';
    return '\n\n---\n[项目文档交付约定] 可以直接在当前项目目录原地写入或修改文件，不要复制一份到任务目录。'
      + `如需在工作台预览或归档，把文件的原路径登记到清单 ${manifest}，格式：{"artifacts":[{"path":"<文件绝对路径>","mediaType":"<可选>"}]}。无需复制副本。`;
  }
  if (directory && manifest) return artifactInstructions(directory, manifest);
  return '';
}

/** Names the directories and the handoff hint when a case has them. Does not authorize a path the host refused. */
export function spaceInstructions(input: {
  originSessionId: string; jobId: string; attemptId: string; caseId?: string;
  artifactSpace?: string; rolePublication?: string; deliveryMode?: DeliveryMode; hasTicket?: boolean;
}): string {
  // Callers still pass the session id; the executor prompt must not repeat it.
  void input.originSessionId;
  if (input.deliveryMode === 'none' && !input.artifactSpace && !input.rolePublication && !input.hasTicket) return '';
  if (!input.caseId && !input.artifactSpace && !input.rolePublication && !input.hasTicket) return '';
  // workspace_git and none do not create a task directory, so that sentence would be a lie.
  const lines: string[] = [];
  if (input.deliveryMode !== 'workspace_git' && input.deliveryMode !== 'none') lines.push('任务目录只属于这一轮。');
  if (input.artifactSpace) lines.push(`共享产物空间 ${input.artifactSpace}/：同一件事的其他任务可以读写。要交接的文件写在这里，并登记进任务清单。`);
  if (input.rolePublication) lines.push(`角色公开目录 ${input.rolePublication}/：给其他角色看的成品。它不是任务目录，也不是共享产物空间。`);
  if (input.caseId) lines.push(`这件事的 caseId 是 ${input.caseId}。交给另一个角色时，调用当前会话绑定的 handoff_propose 提议交接（jobId=${input.jobId}，attemptId=${input.attemptId}），只提议，不派下一单。`);
  if (input.hasTicket) lines.push('本任务带有任务单：先 ticket_show 查看，改完逐项 ticket_self_check，全部必填项通过后再 ticket_submit。');
  if (!lines.length) return '';
  return `\n\n---\n[空间]\n${lines.join('\n')}`;
}

/**
 * The frozen bytes of an accepted handoff. The next task reads these files, not the source task's directory:
 * the source may run another round later, and that must not change what this handoff delivered.
 */
export function snapshotInstructions(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const value = snapshot as { revision?: string; digest?: string; files?: { digest?: string; name?: string; path?: string }[] };
  const files = value.files ?? [];
  if (!files.length) return '';
  const lines = files.map(file => `- ${file.name ?? '产物'} sha256=${file.digest ?? ''} 路径 ${file.path ?? ''}`);
  return `\n\n---\n[交接快照] 这次交接接受的版本是 ${value.revision ?? ''}（digest ${value.digest ?? ''}）。以下文件已按 digest 冻结，是这一版的确切字节：\n${lines.join('\n')}\n`
    + '读这些文件，不要去读来源任务的目录；来源任务之后可能再跑一轮，那一轮的字节不属于这次交接。';
}
