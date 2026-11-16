import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { runA2APreflight } from '@1agents/acp-service/a2a-standalone';

import { runSdk } from './sdk-runtime.js';

/** Native DSH headless or interactive SDK execution; no ACP transport. */
export class HeadlessDshBackend {
  constructor({ directory, command = 'dsh', args, env = {}, mode = 'headless', provider, model, workbench, permissionMode }) {
    if (!['headless', 'sdk'].includes(mode)) throw new Error('Unknown DSH runtime mode');
    this.runtime = { mode, command, args: args ?? ['--profile', mode], env, provider, model, workbench, permissionMode };
    this.directory = resolve(directory); this.command = command; this.args = this.runtime.args; this.env = env;
    this.active = new Map();
  }
  file(id) {
    if (!/^dsh-a2a-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid DSH execution session identity');
    return join(this.directory, `${id}.json`);
  }
  async save(record) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(record.sessionId), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, file);
  }
  async load(id) { return JSON.parse(await readFile(this.file(id), 'utf8')); }
  preflight(input) { return runA2APreflight(input); }
  async prepare(input, { signal } = {}) {
    signal?.throwIfAborted();
    if (input.agentPreset && input.agentPreset !== 'standard') throw new Error('Only the configured DSH headless composition is supported');
    if (input.provider || input.model) throw new Error('Configure the model on the DSH headless profile');
    const previous = input.sessionId ? await this.load(input.sessionId) : undefined;
    const cwd = resolve(input.cwd ?? previous?.cwd ?? process.cwd());
    if (previous && previous.cwd !== cwd) throw new Error('Existing session cwd conflicts');
    const preflight = await this.preflight({ ...input.preflight, cwd });
    if (!preflight.ok) throw new Error('DSH workspace preflight failed');
    const record = previous ?? { sessionId: `dsh-a2a-${randomUUID()}`, cwd, agentPreset: 'standard' };
    signal?.throwIfAborted();
    if (!previous) await this.save(record);
    return { sessionId: record.sessionId, cwd, agentPreset: 'standard', preflight };
  }
  async run(target, prompt, options) {
    if (this.active.has(target.sessionId)) throw new Error('DSH session is busy');
    this.active.set(target.sessionId, true);
    try {
      const record = await this.load(target.sessionId);
      if (record.uncertain) throw new Error('Previous DSH execution has an unknown outcome; inspect its persisted session before recovery');
      await options.beforeStart?.(options.signal); options.signal.throwIfAborted();
      // Persist before launch: never silently replay a run after a crash.
      record.uncertain = true; await this.save(record);
      if (this.runtime.mode === 'sdk') return await runSdk(this.runtime, record, prompt, options, value => this.save(value));
      const args = [...this.args, '--json', '--approval-policy', 'never', ...(record.runtimeSessionId ? ['--session-id', record.runtimeSessionId] : []), '-'];
      let final, runtimeSessionId, invalid = false;
      const child = spawn(this.command, args, { cwd: record.cwd, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const abort = () => { child.kill('SIGTERM'); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const killer = setInterval(() => { if (options.signal.aborted) child.kill('SIGKILL'); }, 1000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'session') runtimeSessionId = event.sessionId;
          if (event.type === 'final') final = event;
        } catch { invalid = true; }
      });
      child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(prompt);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearInterval(killer); options.signal.removeEventListener('abort', abort); lines.close(); }
      if (record.runtimeSessionId && runtimeSessionId && record.runtimeSessionId !== runtimeSessionId) invalid = true;
      if (record.runtimeSessionId && final?.sessionId && record.runtimeSessionId !== final.sessionId) invalid = true;
      if (runtimeSessionId) record.runtimeSessionId = runtimeSessionId;
      if (final?.sessionId) {
        if (runtimeSessionId && final.sessionId !== runtimeSessionId) invalid = true;
        record.runtimeSessionId = final.sessionId;
      }
      record.uncertain = invalid || !final || options.signal.aborted;
      await this.save(record);
      options.signal.throwIfAborted();
      return { outcome: code === 0 && !invalid && final?.reason?.kind === 'completed' ? 'completed' : 'failed', text: typeof final?.text === 'string' ? final.text : typeof final?.answer === 'string' ? final.answer : '', ...(code === 0 && final?.reason?.kind === 'completed' && !invalid ? {} : { detail: 'DSH headless did not report a completed final turn' }) };
    } finally { this.active.delete(target.sessionId); }
  }
  async status(target) { await this.load(target.sessionId); return { attached: true, activeTurn: this.active.has(target.sessionId) }; }
  async close(target) { if (this.active.has(target.sessionId)) return { processReleased: 'pending', acp: false }; return { processReleased: true, acp: false }; }
}
