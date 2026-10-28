/**
 * Default per-task artifact location, relative to the task's cwd on the execution host:
 * `<cwd>/.1agents/jobs/<jobId>/`, with one manifest per attempt. Pure POSIX path arithmetic, because the
 * path is interpreted by the host, not by the gateway's operating system.
 */
import { posix } from 'node:path';

export const defaultJobDirectory = (cwd: string, jobId: string): string => posix.join(cwd, '.1agents', 'jobs', jobId);
export const defaultManifestPath = (cwd: string, jobId: string, attemptId: string): string => posix.join(defaultJobDirectory(cwd, jobId), `manifest-${attemptId}.json`);

/** True for a directory strictly below `<cwd>/.1agents/jobs`. */
export function isDefaultJobDirectory(cwd: string, directory: string): boolean {
  const tail = posix.relative(posix.join(cwd, '.1agents', 'jobs'), directory);
  return tail !== '' && tail !== '..' && !tail.startsWith('../') && !posix.isAbsolute(tail);
}

/** The agent-facing contract, appended to the task prompt. */
export function artifactInstructions(directory: string, manifest: string): string {
  return `\n\n---\n[产物约定] 如果本任务产生了需要交付或审核的文件，请把它们写到目录 ${directory}/ 下（目录已创建），\n`
    + `并在结束前写入清单 ${manifest}，格式：{"artifacts":[{"path":"<文件绝对路径>","mediaType":"<可选>"}]}。\n`
    + '清单里的文件必须在该目录内；只有登记在清单里、并通过校验的文件才会作为产物展示。没有交付文件时不要创建清单。';
}
