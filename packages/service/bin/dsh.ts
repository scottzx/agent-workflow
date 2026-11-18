/**
 * `acp-service dsh archive` — archive DSH sessions that have been silent.
 *
 * The command is manual by design: it runs when a person asks it to, against
 * a DSH Host that is already running. It never installs a timer and never
 * changes the Host's plugin configuration.
 */
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planArchive, runArchive, DAY_MS, type ArchiveCandidate, type ArchivePlan, type ArchiveSkip, type DshArchiveClient } from '../src/dsh-archive.js';
import { DshHostClient, DshRpcError, discoverHost, mintSessionCookie, readBrowserSessionSecret } from '../src/dsh-host-client.js';
import { readRegistryFile } from '../src/dsh-registry-file.js';
import { readSessionFileMtimes } from '../src/dsh-session-files.js';

const USAGE = `用法: acp-service dsh archive [选项]

归档 DSH 中静默超过指定天数的会话。命令手动执行，不会安装定时器，也不改动 DSH 插件配置。
归档只隐藏会话，不删除会话日志；可用 DSH 界面的归档列表随时恢复。

选项:
  --days <n>          静默天数阈值（默认: 7）
  --url <origin>      DSH Host 地址，可重复指定；省略时自动探测本机监听端口
  --dry-run           只列出将要归档的会话，不做任何改动
  --include-pinned    连置顶会话一起归档（默认跳过，置顶表示「保留可见」）
  --stop-activity     允许停止正在运行的会话来完成归档（默认跳过运行中的会话）
  --json              以 JSON 输出结果
  -h, --help          显示帮助信息

示例:
  acp-service dsh archive --days 7 --dry-run
  acp-service dsh archive --days 14 --url http://127.0.0.1:51971
`;

/** Options the command accepts. */
interface ArchiveArgs {
  days: number;
  urls: string[];
  dryRun: boolean;
  includePinned: boolean;
  stopActivity: boolean;
  json: boolean;
}

/** Parse the command line, rejecting values that cannot mean anything. */
export function parseArchiveArgs(argv: string[]): ArchiveArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      days: { type: 'string', default: '7' },
      url: { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
      'include-pinned': { type: 'boolean', default: false },
      'stop-activity': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number of days, got ${String(values.days)}`);
  for (const url of values.url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--url must be an absolute origin, got ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`--url must use http or https, got ${url}`);
  }
  return {
    days,
    urls: values.url as string[],
    dryRun: values['dry-run'],
    includePinned: values['include-pinned'],
    stopActivity: values['stop-activity'],
    json: values.json,
  };
}

/** The DSH home directory whose storage and credentials the command reads. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh');
}

function formatCandidate(candidate: ArchiveCandidate): string {
  const title = candidate.title ? candidate.title.replace(/\s+/g, ' ').slice(0, 60) : '(无标题)';
  const cwd = candidate.cwd ? `  ${candidate.cwd}` : '';
  return `- ${candidate.sessionId}  静默 ${candidate.idleDays} 天  ${title}${cwd}`;
}

function formatSkip(skip: ArchiveSkip): string {
  const label = skip.reason === 'pinned' ? '置顶' : skip.reason === 'running' ? '运行中' : '已归档';
  const title = skip.title ? `  ${skip.title.replace(/\s+/g, ' ').slice(0, 60)}` : '';
  return `- ${skip.sessionId}  跳过（${label}）${title}`;
}

/**
 * Run the archive command.
 *
 * @param argv - the command's arguments, without the command name.
 * @param env - the environment, for the DSH home directory.
 */
export async function runDshArchiveCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await archiveCommand(argv, env);
  } catch (error) {
    // Expected failures (no Host, a stale registry, a bad option) print one
    // line; an unexpected crash keeps its stack for diagnosis.
    if (error instanceof DshRpcError || /^(no reachable|none of the given|cannot read|--days|--url)/.test(String(error instanceof Error ? error.message : error))) {
      console.error(`acp-service dsh archive: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function archiveCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  // `acp-service dsh archive` passes the subcommand name through; drop it.
  const args = argv[0] === 'archive' ? argv.slice(1) : argv;
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const options = parseArchiveArgs(args);
  const home = resolveDshHome(env);
  const secret = readBrowserSessionSecret(join(home, '.credentials.yaml'));
  // The durable document is read before discovery so an out-of-date Host is
  // not chosen when an up-to-date one is running.
  const document = await readRegistryFile(home);
  const endpoint = await discoverHost(options.urls, secret, document.found ? document.archivedSessionIds : undefined);
  const client = new DshHostClient(endpoint, mintSessionCookie(secret, endpoint.authority));
  const mtimes = await readSessionFileMtimes(join(home, 'sessions'));
  // Plan against the durable document, not the Host's in-memory copy: when two
  // Hosts share one DSH home the older one's copy can be behind. The Host is
  // only asked for the session list here, and its own registry is compared
  // against the document before the first write.
  const hostArchive = (await client.readRegistry()).archivedSessionIds;
  const planSource: DshArchiveClient = {
    listSessions: () => client.listSessions(),
    readRegistry: async () => ({
      archivedSessionIds: document.found ? document.archivedSessionIds : hostArchive,
      pinnedSessionIds: document.found ? document.pinnedSessionIds : (await client.readRegistry()).pinnedSessionIds,
    }),
    archiveSession: (sessionId, archiveOptions) => client.archiveSession(sessionId, archiveOptions),
  };
  const plan: ArchivePlan = await planArchive(planSource, {
    inactivityMs: Math.round(options.days * DAY_MS),
    now: Date.now(),
    includePinned: options.includePinned,
    fileMtimes: mtimes,
  });

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify({ dryRun: true, endpoint: endpoint.origin, ...plan }, null, 2));
      return;
    }
    console.log(`DSH: ${endpoint.origin}`);
    console.log(`会话总数 ${plan.totalSessions}，已归档 ${plan.alreadyArchived}，静默超过 ${options.days} 天的待归档 ${plan.candidates.length}`);
    for (const candidate of plan.candidates) console.log(formatCandidate(candidate));
    for (const skip of plan.skipped) console.log(formatSkip(skip));
    console.log('（预演模式，未做任何改动）');
    return;
  }

  // Refuse to write through a Host that started before the document was last
  // written: its in-memory registry would drop those newer entries.
  if (document.found) await client.assertRegistryFresh(document.archivedSessionIds);
  const result = await runArchive(client, plan, { stopActivity: options.stopActivity });
  if (options.json) {
    console.log(JSON.stringify({ dryRun: false, endpoint: endpoint.origin, ...result }, null, 2));
    return;
  }
  console.log(`DSH: ${endpoint.origin}`);
  console.log(`会话总数 ${plan.totalSessions}，已归档 ${plan.alreadyArchived}，候选 ${plan.candidates.length}`);
  console.log(`已归档 ${result.archived.length}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`);
  for (const failure of result.failed) console.error(`- ${failure.sessionId}  归档失败：${failure.error}`);
  for (const skip of result.skipped) console.log(formatSkip(skip));
}
