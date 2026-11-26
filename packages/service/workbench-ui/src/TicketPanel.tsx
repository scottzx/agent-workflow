import { useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpTaskDetail, AcpTicket, AcpTicketItem, AcpTicketProposal, AcpWorkflowNode } from './types';
import { errorText, text } from './ui';

export { TicketLights } from './TicketLights';

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
                    const tone = level === 'self_vs_program' ? ' is-l1' : level === 'self_vs_qa' ? ' is-l2' : passedState(check.state) ? ' is-pass' : '';
                    return (
                        <article key={check.id} class={`acp-ticket-card${tone}`}>
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
                    <article key={item.id} class={`acp-ticket-card${passedState(item.state) ? ' is-pass' : ''}`}>
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
                    <article key={item.id} class={`acp-ticket-card${item.crossCheck ? ' is-l2' : passedState(item.state) ? ' is-pass' : ''}`}>
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

function passedState(state: string) {
    return state === 'done' || state === 'passed' || state === 'closed' || state === 'ok';
}

function clip(value: string, max: number) {
    const chars = Array.from(value);
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
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
    const nodeW = 128;
    const gapX = 36;
    const rowH = 78;
    const widest = Math.max(1, ...rounds.map(round => nodes.filter(node => (node.round ?? 1) === round).length));
    const width = Math.max(560, 24 + widest * (nodeW + gapX));
    const height = Math.max(120, rounds.length * rowH + 28);
    const revise = nodes.filter(node => node.status === 'failed').length;
    return (
        <section class="acp-detail-section">
            <h3>{text('角色内检查图', 'Role micro-DAG')}</h3>
            <p class="acp-muted acp-nums">
                {text(`节点 ${nodes.filter(node => node.status === 'completed').length}/${nodes.length}`, `${nodes.filter(node => node.status === 'completed').length}/${nodes.length} completed`)}
                {nodes.some(node => node.cached) ? text(' · 含续跑缓存', ' · includes cached nodes') : ''}
                {revise ? text(` · 失败 ${revise}`, ` · ${revise} failed`) : ''}
            </p>
            <div class="acp-dag-scroll">
                <svg class="acp-dag" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text('角色内检查图', 'Role micro-DAG')}>
                    <defs>
                        <marker id="acp-dag-arrow-micro" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                            <path d="M0,0 L7,3 L0,6 Z" class="acp-dag-arrow" />
                        </marker>
                    </defs>
                    {rounds.map((round, row) => {
                        const group = nodes.filter(node => (node.round ?? 1) === round);
                        return group.map((node, index) => {
                            const x = 16 + index * (nodeW + gapX);
                            const y = 18 + row * rowH;
                            const next = group[index + 1];
                            const label = node.nodeId || 'node';
                            const status = node.status || 'unknown';
                            return (
                                <g key={`${round}-${node.nodeId}-${index}`} class="acp-dag-click">
                                    {next && (
                                        <line x1={x + nodeW} y1={y + 22} x2={x + nodeW + gapX} y2={y + 22} class="acp-dag-edge" marker-end="url(#acp-dag-arrow-micro)" />
                                    )}
                                    <rect x={x} y={y} width={nodeW} height={48} rx={8} class={`acp-dag-node is-${status}${node.cached ? ' is-cached' : ''}`} />
                                    <circle cx={x + 14} cy={y + 16} r={4} class={`acp-dag-dot is-${status}`} />
                                    <text x={x + 24} y={y + 20} class="acp-dag-label">
                                        <title>{label}</title>
                                        {clip(label, 12)}
                                    </text>
                                    <text x={x + 8} y={y + 38} class="acp-dag-sub">
                                        <title>{node.cached ? 'cached' : status}</title>
                                        {clip(node.cached ? 'cached' : status, 16)}
                                    </text>
                                </g>
                            );
                        });
                    })}
                </svg>
            </div>
            <ul class="acp-dag-legend">
                <li><span class="acp-dag-swatch is-solid" />{text('实线：已交接', 'Solid: handed over')}</li>
                <li><span class="acp-dag-swatch is-dashed" />{text('虚线：待确认提议', 'Dashed: awaiting confirmation')}</li>
                <li><span class="acp-dag-swatch is-cached" />{text('蓝底：续跑缓存', 'Blue: cached rerun')}</li>
            </ul>
        </section>
    );
}
