/**
 * The executor's handoff operation, without any host dependency.
 *
 * The session is bound to the job and attempt it runs, so the plugin never names whose task this is: the gateway
 * resolves it from the attempt and refuses a session that does not run it. The version and digest come from the
 * gateway's own record of the round, so a proposal can only ever talk about the bytes that were recorded.
 */
import { currentA2AExecution } from '@1agents/acp-service/a2a';

export interface HandoffGateway { invoke(method: string, params: Record<string, unknown>): Promise<unknown> }

/** The arguments as they arrive from an MCP call, before they are checked. */
export type HandoffToolArgs = Record<string, unknown>;

/** Proposes the next hop for the running round. The gateway decides whether it is a valid proposal. */
export async function runHandoffTool(gateway: HandoffGateway, sessionId: string, tool: string, args: HandoffToolArgs, via: 'dsh' | 'mcp' = 'dsh'): Promise<string> {
  const execution = currentA2AExecution(sessionId);
  if (!execution) throw new Error('本会话不是正在执行的 A2A 任务会话，不能提议交接。');
  const toTargetId = typeof args.toTargetId === 'string' ? args.toTargetId.trim() : '';
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!toTargetId || !purpose || !reason) throw new Error('交接提议需要 toTargetId、purpose 和 reason。');
  const scope = { jobId: execution.jobId, attemptId: execution.attemptId, sessionId };
  const current = await gateway.invoke('handoff_get', scope) as { caseId?: string; artifactRevision?: string; artifactDigest?: string };
  if (!current.caseId || !current.artifactRevision || !current.artifactDigest) throw new Error('这一轮还没有可交接的版本，不能提议交接。');
  const handoff = await gateway.invoke('handoff_propose', { ...scope, via, caseId: current.caseId,
    artifactRevision: current.artifactRevision, artifactDigest: current.artifactDigest,
    toTargetId, purpose, reason }) as { handoffId: string; toTargetId: string; purpose: string; artifactRevision: string };
  return `已提议交接：交给 ${handoff.toTargetId} / ${handoff.purpose}，版本 ${handoff.artifactRevision}（${handoff.handoffId}）。`
    + '只写了账本，没有派下一单；是否接受由人在工作台页面决定。';
}
