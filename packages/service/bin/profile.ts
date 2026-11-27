/**
 * `acp-service profile …` — inspect and prepare session-level Agent profiles.
 *
 * `init` prepares everything a second account needs before its first browser login:
 * an isolated home directory, an isolated macOS login keychain (so two accounts never
 * overwrite the same `gemini`/`antigravity` item), and links to the normal developer
 * dotfiles so the Agent's own shell still sees git, ssh and package-manager settings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { discoverAgents } from '../src/catalog.js';
import { loadAgentProfiles, profileEnvironment, type AgentProfile } from '../src/agent-profiles.js';

const SHARED_DOTFILES = ['.gitconfig', '.gitignore', '.config', '.ssh', '.npmrc', '.netrc', '.local', '.cache'];

function usage(bin: string): string {
  return `用法: ${bin} profile <子命令>

  list              列出已配置的 Agent profile 及其就绪状态
  show <id>         显示一个 profile 的解析结果（底层 Agent、HOME、环境变量）
  init <id>         准备隔离目录与 keychain，并提示如何完成首次登录
  path              打印 profile 配置文件位置

Profile 让同一个原生 ACP CLI 承载多个账号：会话使用 profile id（如 agy2），
服务端换成底层 Agent 的启动命令，并只给该子进程注入 profile 的 HOME 等环境变量。
`;
}

function requireProfile(id: string): AgentProfile {
  const set = loadAgentProfiles();
  const profile = set.byId.get(id);
  if (!profile) {
    const known = set.profiles.map(item => item.id).join(', ') || '(none)';
    throw new Error(`Unknown profile "${id}" in ${set.file}; configured: ${known}`);
  }
  return profile;
}

function printList(): void {
  const set = loadAgentProfiles();
  if (set.profiles.length === 0) {
    console.log(`未配置 Agent profile。`);
    console.log(`配置文件: ${set.file}`);
    console.log(`示例: { "profiles": { "agy2": { "agent": "antigravity", "label": "Antigravity · 账号2", "home": "~/.1agents/acp-profiles/agy2" } } }`);
    return;
  }
  const statuses = new Map(discoverAgents({ profiles: set.profiles }).map(agent => [agent.id, agent]));
  console.log(`配置文件: ${set.file}`);
  for (const profile of set.profiles) {
    const status = statuses.get(profile.id);
    const ready = status?.chat_ready ? 'ready' : 'not ready';
    const home = profile.home ?? '(inherited)';
    console.log(`${profile.id}\t${profile.label}\t${profile.agent}\t${ready}\t${home}`);
  }
}

function printShow(id: string): void {
  const profile = requireProfile(id);
  console.log(JSON.stringify({
    id: profile.id,
    label: profile.label,
    agent: profile.agent,
    home: profile.home ?? null,
    env: profileEnvironment(profile),
  }, null, 2));
}

function security(args: string[], home: string): string {
  return execFileSync('security', args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Creates the profile's login keychain so its credentials cannot collide with the real account. */
function ensureKeychain(home: string, id: string): string[] {
  if (platform() !== 'darwin') return ['跳过 keychain：仅准备目录（非 macOS）。'];
  const keychains = join(home, 'Library', 'Keychains');
  mkdirSync(keychains, { recursive: true });
  const file = join(keychains, 'login.keychain-db');
  const notes: string[] = [];
  if (!existsSync(file)) {
    security(['create-keychain', '-p', '', file], home);
    notes.push(`已创建独立 keychain: ${file}`);
  }
  security(['default-keychain', '-s', file], home);
  security(['list-keychains', '-d', 'user', '-s', file], home);
  // `security unlock-keychain` rejects the empty passphrase of a fresh keychain even
  // though the keychain is already usable, so the probe below is the real check.
  try {
    security(['unlock-keychain', '-p', '', file], home);
  } catch {
    // Best effort: a locked keychain is reported by the probe instead.
  }
  const probe = `acp-profile-probe-${id}`;
  try {
    security(['add-generic-password', '-U', '-s', probe, '-a', id, '-w', 'ok', file], home);
    security(['delete-generic-password', '-s', probe, '-a', id, file], home);
    notes.push('已设为该 HOME 的默认 keychain，写入校验通过（登录后 token 会写在这里）。');
  } catch (error) {
    notes.push(`警告：keychain 写入校验失败（${(error as Error).message.split('\n')[0]}）。重新登录前请先手动解锁：security unlock-keychain ${file}`);
  }
  return notes;
}

function linkDotfiles(home: string): string[] {
  const notes: string[] = [];
  const realHome = process.env.HOME?.trim() || homedir();
  for (const name of SHARED_DOTFILES) {
    const source = join(realHome, name);
    const target = join(home, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target);
    } catch {
      // A concurrent init may have created it; the link is not required for correctness.
    }
    notes.push(`链接 ${name} -> ${source}`);
  }
  return notes;
}

function initProfile(id: string): void {
  const profile = requireProfile(id);
  if (!profile.home) {
    throw new Error(`Profile "${id}" 没有 home；请先在 profiles.json 里为它设置 home 目录。`);
  }
  mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  const notes = [...ensureKeychain(profile.home, profile.id), ...linkDotfiles(profile.home)];
  console.log(`Profile ${id} (${profile.agent}) 已准备: ${profile.home}`);
  for (const note of notes) console.log(`  - ${note}`);
  console.log('');
  console.log('首次登录（浏览器 OAuth 会写回这个 HOME 的 keychain）:');
  console.log(`  HOME='${profile.home}' ${profile.agent === 'antigravity' ? 'agy' : profile.agent}`);
  console.log('');
  console.log('登录后验证:');
  console.log(`  HOME='${profile.home}' ${profile.agent === 'antigravity' ? 'agy models' : `${profile.agent} --version`}`);
  console.log('然后在 DSH 里新建会话，preset 选 "' + profile.label + '"。');
}

export async function runProfileCli(args: string[]): Promise<void> {
  const [command, id] = args;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(usage('acp-service'));
      return;
    case 'path':
      console.log(loadAgentProfiles().file);
      return;
    case 'list':
      printList();
      return;
    case 'show':
      if (!id) throw new Error('profile show <id> 需要一个 profile id');
      printShow(id);
      return;
    case 'init':
      if (!id) throw new Error('profile init <id> 需要一个 profile id');
      initProfile(id);
      return;
    default:
      console.error(`未知的 profile 子命令: ${command}`);
      console.log(usage('acp-service'));
      process.exitCode = 1;
  }
}
