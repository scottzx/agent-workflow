import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** One runtime request gets one durable workbench permission request. */
export async function requestApproval(workbench, execution, sessionId, params, signal) {
  if (!workbench?.url || !execution?.jobId || !execution?.attemptId) return { outcome: 'cancelled' };
  const origin = new URL(workbench.url).origin;
  const headers = { 'Content-Type': 'application/json', ...(workbench.token ? { Authorization: `Bearer ${workbench.token}` } : {}) };
  const requestId = `prc-${randomUUID().replaceAll('-', '')}`;
  const path = `/workbench/tasks/${encodeURIComponent(execution.jobId)}/process-requests`;
  const send = async (suffix, method, body, requestSignal = signal) => {
    const response = await fetch(new URL(path + suffix, origin), { method, headers, signal: requestSignal,
      redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Approval gateway returned ${response.status}`);
    return response.json();
  };
  try {
    const opened = await send('', 'POST', { requestId, jobId: execution.jobId, attemptId: execution.attemptId, sessionId,
      kind: 'permission', toolTitle: String(params.toolName ?? 'DSH operation').slice(0, 500),
      toolDetail: String(params.reason ?? '').slice(0, 16384) });
    if (opened.requestId !== requestId) throw new Error('Approval receipt identity mismatch');
    for (;;) {
      signal.throwIfAborted();
      const view = await send(`/${requestId}`, 'GET');
      if (view.requestId !== requestId || view.jobId !== execution.jobId) throw new Error('Approval identity mismatch');
      if (view.status === 'answered') return { outcome: view.answer?.outcome === 'approved' ? 'allowed-once' : view.answer?.outcome === 'rejected' ? 'rejected' : 'cancelled' };
      if (view.status !== 'pending' || !Number.isFinite(Date.parse(view.deadlineAt)) || Date.parse(view.deadlineAt) <= Date.now()) break;
      await delay(workbench.pollMs ?? 200, undefined, { signal });
    }
  } catch { /* Lost or cancelled approval can never authorize execution. */ }
  try { await send(`/${requestId}/answers`, 'POST', { clientRequestId: `cancel:${requestId}`, outcome: 'cancelled' }, AbortSignal.timeout(5000)); } catch {}
  return { outcome: 'cancelled' };
}
