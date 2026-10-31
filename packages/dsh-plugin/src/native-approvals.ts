/**
 * DSH's own tool approvals inside an A2A task go to the gateway workbench as process requests, like ACP tool
 * approvals. The workbench is the only place to answer them: the host UI keeps its prompt for the request's
 * whole lifetime and could not withdraw it once the workbench answered. Without a reachable workbench, the
 * host UI answers as before.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-user-approval';
import { currentA2AExecution } from '@1agents/acp-service/a2a';
import type { ProcessRequestClient, ProcessRequestView } from './process-requests.js';

type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

function outcomeOf(view: ProcessRequestView): Outcome {
  if (view.status !== 'answered') return 'cancelled';
  return view.answer?.outcome === 'approved' ? 'allowed-once' : view.answer?.outcome === 'rejected' ? 'rejected' : 'cancelled';
}

/** Runs ahead of the host UI answerer for every agent; agents outside an A2A task pass straight through. */
export function registerNativeApprovals(ctx: Context, client: ProcessRequestClient): () => void {
  return ctx.on('approval/request', async (req, next): Promise<Outcome> => {
    const binding = currentA2AExecution(req.agent.id);
    // ACP presets open their own request in the adapter, and that request's host-UI answer passes through here.
    if (!binding || String(req.agent.session.header.agentPreset ?? '').startsWith('oneagents-acp-')) return next();
    const signal = req.signal ?? new AbortController().signal;
    const reason = req.reason ?? req.displayReason?.en ?? '';
    // The call id keeps each call its own request; without one, a later identical command must not reuse an earlier answer.
    const body = [req.callId ?? randomUUID(), req.toolName, reason];
    const requestId = `prc-${createHash('sha256').update(JSON.stringify([binding.jobId, binding.attemptId, 'permission', body])).digest('hex').slice(0, 32)}`;
    let opened: { requestId: string };
    try {
      opened = await client.open({ requestId, jobId: binding.jobId, attemptId: binding.attemptId, sessionId: req.agent.id,
        kind: 'permission', toolTitle: req.toolName.slice(0, 500), toolDetail: reason.slice(0, 16 * 1024) });
    } catch { return next(); }
    try { return outcomeOf(await client.wait({ jobId: binding.jobId, requestId: opened.requestId, signal })); }
    catch (error) {
      void client.report({ jobId: binding.jobId, requestId: opened.requestId, clientRequestId: `dsh-cancel:${opened.requestId}`, outcome: 'cancelled' }).catch(() => {});
      if (signal.aborted) return 'cancelled';
      throw error;
    }
  }, { prepend: true });
}
