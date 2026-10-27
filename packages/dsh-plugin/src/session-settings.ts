/** Accepted ACP settings, one record per workspace and Agent. Grok Build and Codex do not share a catalog. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export interface PinnedAcpOption {
  id: string;
  value: string;
  /** Model selections are replayed before other options. Each set_config_option returns a new catalog. */
  model?: true;
}
export interface PinnedAcpSettings {
  cwd: string;
  agent: string;
  modeId?: string;
  options: PinnedAcpOption[];
}

const fileName = 'agent-session-settings.json';

/** Remembers values an Agent has already accepted. It does not store the advertised catalog. */
export class AgentSessionSettings {
  constructor(private readonly directory: string) {}
  get(cwd: string, agent: string): PinnedAcpSettings | undefined {
    const found = this.load().find(entry => entry.cwd === resolve(cwd) && entry.agent === agent);
    return found ? structuredClone(found) : undefined;
  }
  remember(cwd: string, agent: string, update: { modeId?: string; option?: PinnedAcpOption }): void {
    const key = { cwd: resolve(cwd), agent };
    if (!isAbsolute(key.cwd) || !agent) throw new Error('ACP session settings require an absolute workspace and an Agent name');
    const entries = this.load().filter(entry => !(entry.cwd === key.cwd && entry.agent === key.agent));
    const current = this.load().find(entry => entry.cwd === key.cwd && entry.agent === key.agent) ?? { ...key, options: [] };
    const next: PinnedAcpSettings = { cwd: key.cwd, agent, ...(update.modeId ? { modeId: update.modeId } : current.modeId ? { modeId: current.modeId } : {}), options: current.options.map(option => ({ ...option })) };
    if (update.option) {
      if (!update.option.id || !update.option.value) throw new Error('ACP session settings require an option id and value');
      const option = { id: update.option.id, value: update.option.value, ...(update.option.model ? { model: true as const } : {}) };
      const index = next.options.findIndex(item => item.id === option.id);
      if (index < 0) next.options.push(option);
      else next.options[index] = option;
    }
    entries.push(next);
    this.save(entries);
  }
  private path(): string { return join(this.directory, fileName); }
  private load(): PinnedAcpSettings[] {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path(), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid ACP session settings');
    const body = parsed as { version?: unknown; entries?: unknown };
    if (body.version !== 1 || !Array.isArray(body.entries)) throw new Error('Invalid ACP session settings');
    return body.entries.map(decodeEntry);
  }
  private save(entries: PinnedAcpSettings[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(), temp = path + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify({ version: 1, entries }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  }
}

/** Model selections stay ahead of the other accepted values. Relative order inside each group is unchanged. */
export function replayPinnedOptions(options: readonly PinnedAcpOption[]): PinnedAcpOption[] {
  return [...options.filter(option => option.model), ...options.filter(option => !option.model)].map(option => ({ ...option }));
}

export function pinnedOptionError(agent: string, pinned: PinnedAcpOption, advertised: readonly { id?: string; options?: readonly unknown[] }[] | undefined): string | undefined {
  const option = advertised?.find(item => item.id === pinned.id);
  if (!option) return `Pinned ACP option "${pinned.id}" is not advertised by ${agent}`;
  if (!optionValues(option).includes(pinned.value)) return `Pinned ACP option "${pinned.id}" value "${pinned.value}" is not advertised by ${agent}`;
}

export function pinnedModeError(agent: string, modeId: string, modes: readonly { id?: string }[] | undefined): string | undefined {
  if (!modes?.some(mode => mode.id === modeId)) return `Pinned ACP mode "${modeId}" is not advertised by ${agent}`;
}

function optionValues(option: { options?: readonly unknown[] }): string[] {
  const values: string[] = [];
  for (const item of option.options ?? []) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { value?: unknown; options?: unknown };
    if (typeof record.value === 'string' && record.value) values.push(record.value);
    if (!Array.isArray(record.options)) continue;
    for (const child of record.options) {
      if (child && typeof child === 'object' && typeof (child as { value?: unknown }).value === 'string' && (child as { value: string }).value) values.push((child as { value: string }).value);
    }
  }
  return values;
}

function decodeEntry(value: unknown): PinnedAcpSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ACP session settings');
  const entry = value as Record<string, unknown>;
  if (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) || typeof entry.agent !== 'string' || !entry.agent) throw new Error('Invalid ACP session settings');
  if (entry.modeId !== undefined && (typeof entry.modeId !== 'string' || !entry.modeId)) throw new Error('Invalid ACP session settings');
  if (!Array.isArray(entry.options)) throw new Error('Invalid ACP session settings');
  const options = entry.options.map(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Invalid ACP session settings');
    const item = option as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || typeof item.value !== 'string' || !item.value) throw new Error('Invalid ACP session settings');
    if (item.model !== undefined && item.model !== true) throw new Error('Invalid ACP session settings');
    return { id: item.id, value: item.value, ...(item.model ? { model: true as const } : {}) };
  });
  return { cwd: entry.cwd, agent: entry.agent, ...(typeof entry.modeId === 'string' ? { modeId: entry.modeId } : {}), options };
}
