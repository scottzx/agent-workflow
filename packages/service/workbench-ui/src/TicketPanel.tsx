import { useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpTaskDetail, AcpTicket, AcpTicketItem, AcpTicketProposal, AcpTicketSummary, AcpWorkflowNode } from './types';
import { errorText, text } from './ui';

export function TicketLights({ summary }: { summary?: AcpTicketSummary }) {
    if (!summary) return null;
    const self = `${summary.selfCheckDone}/${summary.selfCheckTotal}`;
    const program = summary.openMust > 0 ? text(`必改 ${summary.openMust}`, `${summary.openMust} must-fix`) : text('机检', 'Checks');
    return (
        <span class="acp-ticket-lights" title={text('任务单', 'Ticket')}>
            <span>R{summary.round}</span>
            <span class={summary.selfCheckTotal > 0 && summary.selfCheckDone < summary.selfCheckTotal ? 'is-wait' : 'is-ok'}>
                {text('自检', 'Self')} {self}
            </span>
            <span class={summary.openMust > 0 ? 'is-bad' : 'is-ok'}>{program}</span>
            {summary.mismatches > 0 && <span class="is-warn">{text(`分歧 ${summary.mismatches}`, `${summary.mismatches} mismatches`)}</span>}
        </span>
    );
}

function settlerLabel(proposal: AcpTicketProposal): string {
    if (!proposal.by) return '';
    if (proposal.by.kind === 'coach') return text(`教练${proposal.by.agent ? ` · ${proposal.by.agent}` : ''}`, `Coach${proposal.by.agent ? ` · ${proposal.by.agent}` : ''}`);
    if (proposal.by.via === 'page') return text('人（网关页面）', 'Person (gateway page)');
    if (proposal.by.via === 'relay') return text('人（宿主转发）', 'Person (relayed)');
    return text('人', 'Person');
}

function findingOf(ticket: AcpTicket, checkId: string): AcpTicketItem | undefined {
    return ticket.items.find(item => item.crossCheck?.checkId === checkId);
}

export function TicketPanel({ detail, onChanged }: { detail: AcpTaskDetail; onChanged: () => void }) {
    const ticket = detail.ticket;
    const [round, setRound] = useState<number | 'all'>('all');
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    if (!ticket) return <p class="acp-muted">{text('这个任务没有任务单。', 'This task has no ticket.')}</p>;
    const rounds = [...new Set([ticket.round, ...ticket.items.map(item => item.raisedInRound), ...ticket.history.map(entry => entry.round)])].sort((a, b) => a - b);
    const inRound = (value: number) => round === 'all' || value === round;
    const checks = (ticket.selfChecks ?? []).filter(check => round === 'all' || check.checkedInRound === round || check.state === 'pending');
    const program = ticket.items.filter(item => item.source === 'program' && inRound(item.raisedInRound));
    const qa = ticket.items.filter(item => item.source === 'qa' && inRound(item.raisedInRound));
    const reviews = ticket.history.filter(entry => entry.action === 'reviewed' && inRound(entry.round));
    const proposals = ticket.proposals.filter(proposal => inRound(proposal.raisedInRound));
    const decide = async (proposal: AcpTicketProposal, state: 'accepted' | 'rejected' | 'done') => {
        const note = notes[proposal.id]?.trim();
        if (!note) { setError(text('请填写理由。', 'A reason is required.')); return; }
        setBusy(proposal.id);
        setError('');
        try {
            await acpTaskService.decideProposal(detail.jobId, proposal.id, { state, note });
            onChanged();
        } catch (err) {
            setError(err instanceof AcpTaskApiError && err.status === 409
                ? text('提议状态已变，请刷新。', 'The proposal changed. Refresh.')
                : errorText(err));
        } finally { setBusy(''); }
    };
    return (
        <div class="acp-ticket">
            <div class="acp-workbench-views" aria-label={text('轮次', 'Round')}>
                <button type="button" aria-pressed={round === 'all'} onClick={() => setRound('all')}>{text('全部', 'All')}</button>
                {rounds.map(value => (
                    <button key={value} type="button" aria-pressed={round === value} onClick={() => setRound(value)}>{text(`第 ${value} 轮`, `Round ${value}`)}</button>
                ))}
            </div>
            {error && <p class="acp-decision-error">{error}</p>}
            <section class="acp-detail-section">
                <h3>{text('自检清单', 'Self-check')}</h3>
                {checks.length ? checks.map(check => {
                    const finding = findingOf(ticket, check.id);
                    const level = finding?.crossCheck?.kind;
                    return (
                        <article key={check.id} class={`acp-ticket-card${level === 'self_vs_program' ? ' is-l1' : ''}${level === 'self_vs_qa' ? ' is-l2' : ''}`}>
                            <header>
                                <strong>{check.id}</strong>
                                <span class="acp-mode-label">{check.state}</span>
                                {check.kind === 'self_and_qa' && <span class="acp-mode-label">self+QA</span>}
                            </header>
                            <p>{check.rule}</p>
                            {check.note && <p class="acp-muted">{text('依据', 'Evidence')}: {check.note}</p>}
                            {finding?.crossCheck && (
                                <div class="acp-crosscheck">
                                    <p><strong>{level === 'self_vs_program' ? 'L1' : 'L2'}</strong> {text('执行者', 'Executor')}: {finding.crossCheck.claimedState}{finding.crossCheck.claimedNote ? ` · ${finding.crossCheck.claimedNote}` : ''}</p>
                                    <p>{level === 'self_vs_program' ? text('机检', 'Program') : text('质检', 'QA')}: {finding.crossCheck.actualVerdict}{finding.crossCheck.actualNote ? ` · ${finding.crossCheck.actualNote}` : ''}</p>
                                    <p>{finding.problem}</p>
                                </div>
                            )}
                        </article>
                    );
                }) : <p class="acp-muted">{text('这一轮没有自检项。', 'No self-checks in this round.')}</p>}
            </section>
            <section class="acp-detail-section">
                <h3>{text('程序检查', 'Program checks')}</h3>
                {program.length ? program.map(item => (
                    <article key={item.id} class="acp-ticket-card">
                        <header><strong>{item.id}</strong><span class="acp-mode-label">{item.state}</span>{item.severity === 'must' && <span class="acp-mode-label is-locked">{text('必改', 'Must')}</span>}</header>
                        <p>{item.where} · {item.problem}</p>
                        {item.suggestion && <p class="acp-muted">{item.suggestion}</p>}
                    </article>
                )) : <p class="acp-muted">{text('这一轮没有程序检查意见。', 'No program findings in this round.')}</p>}
                <SkippedNodes nodes={detail.workflowRun?.nodes} />
            </section>
            <section class="acp-detail-section">
                <h3>{text('QA 评审与修改项', 'QA review')}</h3>
                {reviews.map(entry => (
                    <article key={`${entry.round}-${entry.action}`} class="acp-ticket-card">
                        <header><strong>{text(`第 ${entry.round} 轮`, `Round ${entry.round}`)}</strong><span class="acp-mode-label">{entry.verdict || entry.action}</span></header>
                        {entry.summary && <p>{entry.summary}</p>}
                        {entry.scores && <p class="acp-muted">{Object.entries(entry.scores).map(([key, value]) => `${key} ${value}`).join(' · ')}</p>}
                    </article>
                ))}
                {qa.map(item => (
                    <article key={item.id} class={`acp-ticket-card${item.crossCheck ? ' is-l2' : ''}`}>
                        <header><strong>{item.id}</strong><span class="acp-mode-label">{item.state}</span></header>
                        <p>{item.where} · {item.problem}</p>
                        {item.log.filter(line => line.note || line.action === 'done' || line.action === 'disputed').map((line, index) => (
                            <p key={index} class="acp-muted">{line.by} · {line.action}{line.note ? ` · ${line.note}` : ''}</p>
                        ))}
                    </article>
                ))}
                {!reviews.length && !qa.length && <p class="acp-muted">{text('还没有质检意见。', 'No QA review yet.')}</p>}
            </section>
            <section class="acp-detail-section">
                <h3>{text('规范提议', 'Proposals')}</h3>
                {proposals.length ? proposals.map(proposal => (
                    <article key={proposal.id} class="acp-ticket-card">
                        <header>
                            <strong>{proposal.id}</strong>
                            <span class={`acp-mode-label${proposal.kind === 'locked' ? ' is-locked' : ''}`}>{proposal.kind}</span>
                            <span class="acp-mode-label">{proposal.state}</span>
                        </header>
                        <p>{proposal.text}</p>
                        {(proposal.by || proposal.note) && <p class="acp-muted">{settlerLabel(proposal)}{proposal.note ? ` · ${proposal.note}` : ''}</p>}
                        {proposal.state === 'open' && (proposal.kind === 'locked' || proposal.kind === 'check') && (
                            <div class="acp-review-form">
                                <textarea value={notes[proposal.id] ?? ''} maxLength={2000} placeholder={text('理由', 'Reason')} onInput={event => setNotes(current => ({ ...current, [proposal.id]: event.currentTarget.value }))} />
                                <div class="acp-review-buttons">
                                    <button type="button" class="acp-button acp-primary" disabled={busy === proposal.id} onClick={() => void decide(proposal, 'accepted')}>{text('采纳', 'Accept')}</button>
                                    <button type="button" class="acp-button" disabled={busy === proposal.id} onClick={() => void decide(proposal, 'rejected')}>{text('拒绝', 'Reject')}</button>
                                    <button type="button" class="acp-button" disabled={busy === proposal.id} onClick={() => void decide(proposal, 'done')}>{text('已完成', 'Done')}</button>
                                </div>
                            </div>
                        )}
                    </article>
                )) : <p class="acp-muted">{text('没有提议。', 'No proposals.')}</p>}
            </section>
        </div>
    );
}

function SkippedNodes({ nodes }: { nodes?: AcpWorkflowNode[] }) {
    const skipped = (nodes ?? []).filter(node => node.status === 'skipped');
    if (!skipped.length) return null;
    return (
        <div>
            {skipped.map(node => (
                <p key={`${node.round}-${node.nodeId}`} class="acp-muted">{text('跳过', 'Skipped')} {node.nodeId}{node.skipReason ? ` · ${node.skipReason}` : ''}</p>
            ))}
        </div>
    );
}

export function MicroDag({ nodes }: { nodes: AcpWorkflowNode[] }) {
    const rounds = [...new Set(nodes.map(node => node.round ?? 1))].sort((a, b) => a - b);
    const width = 640;
    const rowH = 78;
    const height = Math.max(96, rounds.length * rowH + 24);
    const revise = nodes.filter(node => node.status === 'failed').length;
    return (
        <section class="acp-detail-section">
            <h3>{text('角色内检查图', 'Role micro-DAG')}</h3>
            <p class="acp-muted">
                {text(`节点 ${nodes.filter(node => node.status === 'completed').length}/${nodes.length}`, `${nodes.filter(node => node.status === 'completed').length}/${nodes.length} completed`)}
                {nodes.some(node => node.cached) ? text(' · 含续跑缓存', ' · includes cached nodes') : ''}
                {revise ? text(` · 失败 ${revise}`, ` · ${revise} failed`) : ''}
            </p>
            <svg class="acp-dag" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text('Micro-DAG', 'Micro-DAG')}>
                {rounds.map((round, row) => {
                    const group = nodes.filter(node => (node.round ?? 1) === round);
                    const gap = width / Math.max(group.length, 1);
                    return group.map((node, index) => {
                        const x = gap * index + 16;
                        const y = 16 + row * rowH;
                        const next = group[index + 1];
                        return (
                            <g key={`${round}-${node.nodeId}-${index}`}>
                                {next && <line x1={x + 108} y1={y + 22} x2={gap * (index + 1) + 16} y2={y + 22} class="acp-dag-edge" />}
                                <rect x={x} y={y} width={112} height={44} rx={8} class={`acp-dag-node is-${node.status || 'unknown'}${node.cached ? ' is-cached' : ''}`} />
                                <text x={x + 8} y={y + 18} class="acp-dag-label">{node.nodeId || 'node'}</text>
                                <text x={x + 8} y={y + 34} class="acp-dag-sub">{node.cached ? 'cached' : node.status || ''}</text>
                            </g>
                        );
                    });
                })}
            </svg>
        </section>
    );
}
