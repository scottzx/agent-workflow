/** Durable ACP endpoint identity and replayable standard updates. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
export interface SessionBinding { sessionId: string; agentType: string; cwd: string; completeHistory: boolean; runtimeRecordId?: string; deleted?: boolean }
export class AcpState {
  constructor(private readonly directory = join(process.env.ACP_STATE_DIR || join(homedir(), '.1agents', 'acpx-state'), 'acp')) {}
  private file(id: string, suffix: string) { return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.${suffix}`); }
  get(id: string): SessionBinding | undefined {
    const file = this.file(id, 'json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as SessionBinding;
  }
  list(): SessionBinding[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(this.directory, file), 'utf8')) as SessionBinding);
  }
  create(binding: SessionBinding): void {
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(binding.sessionId, 'json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(binding) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  }
  append(id: string, update: SessionUpdate): void {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.file(id, 'jsonl'), JSON.stringify(update) + '\n', { mode: 0o600 });
  }
  history(id: string): SessionUpdate[] {
    const file = this.file(id, 'jsonl');
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    // A torn final append after a process crash cannot be claimed as replayable.
    if (text && !text.endsWith('\n')) throw new Error('ACP history has an incomplete final record');
    return text.trim() ? text.trimEnd().split('\n').map(line => JSON.parse(line) as SessionUpdate) : [];
  }
  /** Fast tool_call ID scan for session/resume without JSON-parsing every message chunk. */
  toolCallIds(id: string): string[] {
    const file = this.file(id, 'jsonl');
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    if (!text.includes('"tool_call"')) return [];
    const ids: string[] = [];
    for (const line of text.trimEnd().split('\n')) {
      if (!line.includes('"tool_call"')) continue;
      try {
        const update = JSON.parse(line) as SessionUpdate;
        if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
          ids.push(update.toolCallId);
        }
      } catch {
        // Ignore a torn trailing line during non-replay resume; load still validates strictly.
      }
    }
    return ids;
  }
}
