import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { requestApproval } from './approvals.js';

/** DSH native SDK stdio, deliberately independent of ACP. */
export async function runSdk(runtime, record, prompt, options, save) {
  if (!runtime.provider || !runtime.model) throw new Error('SDK runtime requires provider and model configuration');
  const child = spawn(runtime.command, runtime.args, { cwd: record.cwd, env: { ...process.env, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(), signal = AbortSignal.any([options.signal, controller.signal]);
  const pending = new Map(), approvalTasks = new Set();
  let serial = 0, terminal, text = '', alive = true;
  const write = value => { if (alive && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
  child.stdin.on('error', () => {}); child.stderr.resume();
  const exited = new Promise(resolve => child.once('close', code => resolve(code)));
  const fail = error => { controller.abort(error); for (const task of pending.values()) task.reject(error); pending.clear(); };
  child.once('error', fail); child.once('close', () => { alive = false; fail(new Error('DSH SDK transport closed')); });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = ++serial;
    const timer = ['initialize', 'shutdown', 'session/resume'].includes(method)
      ? setTimeout(() => { pending.delete(id); reject(new Error(`DSH SDK ${method} timed out`)); }, runtime.timeoutMs ?? 30000) : undefined;
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    write({ jsonrpc: '2.0', id, method, params });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return fail(new Error('Malformed DSH SDK frame')); }
    if (frame.method && frame.id !== undefined) {
      if (frame.method !== 'approval/request') return write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported runtime request' } });
      const task = (frame.params?.sessionId === record.runtimeSessionId
        ? requestApproval(runtime.workbench, options.execution, record.sessionId, frame.params, signal)
        : Promise.resolve({ outcome: 'cancelled' }))
        .then(result => { if (!signal.aborted) write({ jsonrpc: '2.0', id: frame.id, result }); });
      approvalTasks.add(task); void task.finally(() => approvalTasks.delete(task));
    } else if (frame.method === 'session.event' && frame.params?.sessionId === record.runtimeSessionId) {
      const event = frame.params.event;
      if (event?.type === 'turn/end') terminal = event.data?.reason;
      if (event?.type === 'assistant/message') {
        const content = event.data?.message?.content;
        if (Array.isArray(content)) text = content.filter(part => part.type === 'text').map(part => part.text).join('');
      }
    } else if (frame.id !== undefined) {
      const task = pending.get(frame.id); if (!task) return; pending.delete(frame.id);
      if (frame.error) task.reject(new Error('DSH SDK request failed')); else task.resolve(frame.result);
    }
  });
  const abort = () => { fail(options.signal.reason); child.kill('SIGTERM'); };
  options.signal.addEventListener('abort', abort, { once: true });
  const force = setInterval(() => { if (signal.aborted) child.kill('SIGKILL'); }, 1000);
  try {
    options.signal.throwIfAborted();
    const initialized = await request('initialize', { cwd: record.cwd, provider: runtime.provider, model: runtime.model, approvalRequests: true });
    if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected DSH runtime');
    if (record.runtimeSessionId) await request('session/resume', { sessionId: record.runtimeSessionId });
    else { record.runtimeSessionId = `session-${randomUUID()}`; await save(record); }
    if (runtime.permissionMode) await request('session/query', { sessionId: record.runtimeSessionId, contentBlocks: [{ type: 'text', text: `/permission ${runtime.permissionMode}` }] });
    // Permission commands may emit state events, never inherit those as this prompt's result.
    terminal = undefined; text = '';
    await request('session/prompt', { sessionId: record.runtimeSessionId, contentBlocks: [{ type: 'text', text: prompt }] });
    await request('session/wait', { sessionId: record.runtimeSessionId });
    record.uncertain = !terminal; await save(record);
    await request('shutdown', {});
    const code = await exited;
    return { outcome: code === 0 && terminal?.kind === 'completed' ? 'completed' : 'failed', text };
  } finally {
    controller.abort(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exited; clearTimeout(timer); clearInterval(force);
    options.signal.removeEventListener('abort', abort); lines.close();
    await Promise.allSettled(approvalTasks);
  }
}
