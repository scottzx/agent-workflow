import { useEffect, useRef, useState } from 'preact/hooks';
import { acpCaseService } from './api';
import { navigateCase, parseAcpCaseHash, snapshotUrl } from './model';
import type { AcpCaseDetail, AcpCaseEdge, AcpCaseSummary, AcpInboxItem, AcpTaskSummary } from './types';
import { Skeleton } from './LazyView';
import { LazyArtifactDrawer, LazyArtifactItem } from './lazy-panels';
import { useChunkedList, useLoadMoreSentinel } from './paging';
import { channelLabel, date, EmptyState, ErrorState, errorText, navigateAcpTask, Status, taskStatus, text } from './ui';

export { navigateCase };

/**
 * The workbench's first screen is a thing: what it is for, who is working on it, what waits for a person, and
 * which version each decision is about. The canvas only projects the ledger: happened edges are solid, proposals
 * are dashed, and a convention that has not fired is written on the current node instead of drawn as a path.
 */

function CaseRoute() {
    const read = () => parseAcpCaseHash(location.hash) ?? {};
    const [route, setRoute] = useState(read);
    useEffect(() => {
        const update = () => setRoute(read());
        window.addEventListener('hashchange', update);
        return () => window.removeEventListener('hashchange', update);
    }, []);
    return route;
}

/**
 * A decision names the reviewer either way; what differs is whether the gateway saw its own page
 * session or a host forwarding for the page with the shared secret. A caller running as the same user
 * can read that secret, so a relayed decision is marked instead of being shown as a verified click.
 */
function decisionSource(via?: 'page' | 'relay') {
    if (via === 'page') return text('（网关页面）', ' (gateway page)');
    if (via === 'relay') return text('（宿主转发，未核验点击）', ' (relayed, click unverified)');
    return '';
}

const edgeLabels: Record<AcpCaseEdge['status'], [string, string]> = {
    proposed: ['提议', 'Proposed'],
    accepted: ['已接受，待开下一单', 'Accepted, not opened yet'],
    taken: ['已交接', 'Handed over'],
    rejected: ['已拒绝', 'Rejected'],
};

function EdgeRow({
    edge,
    caseId,
    onDecide,
    busy,
    onPreview,
    focused,
}: {
    edge: AcpCaseEdge;
    caseId: string;
    onDecide: (edge: AcpCaseEdge, decision: 'accept' | 'reject') => void;
    busy: boolean;
    onPreview: (artifact: { url: string; name: string; mediaType?: string }) => void;
    focused?: boolean;
}) {
    const label = edgeLabels[edge.status];
    return (
        <li id={`handoff-${edge.handoffId}`} class={`acp-case-edge${edge.happened ? ' is-happened' : ' is-proposed'}${focused ? ' is-focused' : ''}`}>
            <span class="acp-case-edge-line" aria-hidden="true" />
            <div>
                <strong>
                    {text(label[0], label[1])} · {edge.toTargetId} / {edge.purpose}
                </strong>
                <small class="acp-muted">
                    {edge.reason} · {text('版本', 'revision')} {edge.artifactRevision} · {edge.artifactDigest.slice(0, 12)}
                </small>
                {edge.decidedBy && (
                    <small class="acp-muted">
                        {text('决定人', 'Decided by')}{' '}
                        {edge.decidedBy.kind === 'person' ? edge.decidedBy.id || text('本机用户', 'Local user') : edge.decidedBy.agent || edge.decidedBy.sessionId}
                        {decisionSource(edge.decidedBy.via)}
                    </small>
                )}
                {edge.snapshots?.length ? (
                    <span class="acp-artifact-row">
                        <small class="acp-muted">{text('已冻结', 'Frozen')}</small>
                        {edge.snapshots.map(item => (
                            <a
                                key={item.digest}
                                href={snapshotUrl(caseId, edge.handoffId, item.digest)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={event => {
                                    event.preventDefault();
                                    onPreview({ url: snapshotUrl(caseId, edge.handoffId, item.digest), name: item.name, mediaType: item.mediaType });
                                }}
                            >
                                {item.name}
                            </a>
                        ))}
                    </span>
                ) : null}
            </div>
            {edge.status === 'proposed' && (
                <div class="acp-review-buttons">
                    <button type="button" class="acp-button acp-primary" disabled={busy} onClick={() => onDecide(edge, 'accept')}>
                        {text('接受这一版', 'Accept this version')}
                    </button>
                    <button type="button" class="acp-button" disabled={busy} onClick={() => onDecide(edge, 'reject')}>
                        {text('拒绝', 'Reject')}
                    </button>
                </div>
            )}
        </li>
    );
}

function InboxRow({ item, onOpen }: { item: AcpInboxItem; onOpen: (item: AcpInboxItem) => void }) {
    const kind = item.kind === 'review' ? text('审核', 'Review') : item.kind === 'process_request' ? text('过程请求', 'Request') : item.kind === 'proposal' ? text('规范提议', 'Proposal') : text('交接提议', 'Handoff');
    return (
        <li class="acp-inbox-row">
            <span class={`acp-mode-label${item.proposalKind === 'locked' ? ' is-locked' : ''}`}>{kind}</span>
            <div>
                <strong>{item.title}</strong>
                <small class="acp-muted">
                    {item.summary}
                    {item.revision ? ` · ${item.revision}` : ''}
                    {item.channel ? ` · ${channelLabel(item.channel)}` : ''}
                </small>
            </div>
            <button type="button" class="acp-link" onClick={() => onOpen(item)}>
                {text('去处理', 'Open')}
            </button>
        </li>
    );
}

function CaseDag({
    detail,
    onOpenTask,
    onOpenEdge,
}: {
    detail: AcpCaseDetail;
    onOpenTask: (jobId: string) => void;
    onOpenEdge: (handoffId: string) => void;
}) {
    const tasks = detail.tasks;
    if (!tasks.length) return null;
    const depth = new Map(tasks.map(task => [task.jobId, 0]));
    const links = detail.edges.filter(edge => edge.status !== 'rejected' && edge.childJobId && depth.has(edge.childJobId));
    for (let pass = 0; pass < tasks.length; pass++) {
        let changed = false;
        for (const edge of links) {
            const next = (depth.get(edge.fromJobId) ?? 0) + 1;
            if ((depth.get(edge.childJobId!) ?? 0) < next) { depth.set(edge.childJobId!, next); changed = true; }
        }
        if (!changed) break;
    }
    const columns = new Map<number, AcpTaskSummary[]>();
    for (const task of tasks) {
        const column = depth.get(task.jobId) ?? 0;
        columns.set(column, [...(columns.get(column) ?? []), task]);
    }
    const nodeW = 168, nodeH = 78, gapX = 56, gapY = 22;
    const pos = new Map<string, { x: number; y: number }>();
    let maxX = nodeW + 32, maxY = nodeH + 32;
    for (const [column, list] of columns) {
        list.forEach((task, index) => {
            const point = { x: 20 + column * (nodeW + gapX), y: 20 + index * (nodeH + gapY) };
            pos.set(task.jobId, point);
            maxX = Math.max(maxX, point.x + nodeW + 40);
            maxY = Math.max(maxY, point.y + nodeH + 28);
        });
    }
    const ghosts = detail.edges.filter(edge => edge.status === 'proposed' && !edge.childJobId);
    ghosts.forEach((edge, index) => {
        const from = pos.get(edge.fromJobId);
        if (!from) return;
        maxX = Math.max(maxX, from.x + nodeW + gapX + nodeW);
        maxY = Math.max(maxY, from.y + index * 18 + nodeH);
    });
    return (
        <section class="acp-detail-section">
            <h3>{text('跨角色流转', 'Cross-role flow')}</h3>
            <div class="acp-dag-scroll">
                <svg class="acp-dag acp-case-dag" width={maxX} height={maxY} viewBox={`0 0 ${maxX} ${maxY}`} role="img" aria-label={text('事情流转图', 'Case flow')}>
                    <defs>
                        <marker id="acp-dag-arrow-case" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                            <path d="M0,0 L7,3 L0,6 Z" class="acp-dag-arrow" />
                        </marker>
                    </defs>
                    {detail.edges.filter(edge => edge.status !== 'rejected').map(edge => {
                        const from = pos.get(edge.fromJobId);
                        const to = edge.childJobId ? pos.get(edge.childJobId) : undefined;
                        if (!from) return null;
                        const x2 = to ? to.x : from.x + nodeW + gapX;
                        const y2 = to ? to.y + nodeH / 2 : from.y + nodeH / 2;
                        const dashed = edge.status === 'proposed';
                        const label = edge.artifactDigest.slice(0, 8);
                        return (
                            <g key={edge.handoffId}>
                                <line x1={from.x + nodeW} y1={from.y + nodeH / 2} x2={x2} y2={y2} class={`acp-dag-edge${dashed ? ' is-dashed' : ''}`} marker-end="url(#acp-dag-arrow-case)" />
                                {dashed && (
                                    <line x1={from.x + nodeW} y1={from.y + nodeH / 2} x2={x2} y2={y2} class="acp-dag-hit" onClick={() => onOpenEdge(edge.handoffId)}>
                                        <title>{edge.reason}</title>
                                    </line>
                                )}
                                <text x={(from.x + nodeW + x2) / 2} y={(from.y + nodeH / 2 + y2) / 2 - 4} class="acp-dag-sub acp-dag-edge-label">
                                    <title>{edge.artifactDigest}</title>
                                    {label}
                                </text>
                            </g>
                        );
                    })}
                    {tasks.map(task => {
                        const point = pos.get(task.jobId)!;
                        const name = task.title || task.jobId;
                        const waiting = detail.conventions.filter(rule => !rule.achieved && (!rule.fromTargetId || rule.fromTargetId === task.targetId) && (!rule.fromPurpose || rule.fromPurpose === task.purpose));
                        const status = (task.executionStatus || 'unknown').replace(/[^a-z_]/gi, '');
                        const ticketLine = task.ticketSummary
                            ? `R${task.ticketSummary.round} ${task.ticketSummary.selfCheckDone}/${task.ticketSummary.selfCheckTotal}${task.ticketSummary.mismatches > 0 ? ` · ${text('分歧', 'mismatch')} ${task.ticketSummary.mismatches}` : ''}`
                            : text('无任务单', 'No ticket');
                        return (
                            <g key={task.jobId} class="acp-dag-click" onClick={() => onOpenTask(task.jobId)}>
                                <title>{name}</title>
                                <rect x={point.x} y={point.y} width={nodeW} height={nodeH} rx={8} class={`acp-dag-node is-${status}`} />
                                <circle cx={point.x + nodeW - 14} cy={point.y + 14} r={4} class={`acp-dag-dot is-${status}`} />
                                <text x={point.x + 8} y={point.y + 18} class="acp-dag-label">{clip(name, 16)}</text>
                                <text x={point.x + 8} y={point.y + 34} class="acp-dag-sub">{clip(`${channelLabel(task.channel)} · ${task.executionStatus}`, 22)}</text>
                                <text x={point.x + 8} y={point.y + 50} class="acp-dag-sub">
                                    <title>{ticketLine}</title>
                                    {clip(ticketLine, 22)}
                                </text>
                                {!!waiting.length && <text x={point.x + 8} y={point.y + 66} class="acp-dag-sub">{text('待触发', 'Waiting')} {waiting.length}</text>}
                            </g>
                        );
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

function clip(value: string, max: number) {
    const chars = Array.from(value);
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

function CaseDetail({ detail, onChanged }: { detail: AcpCaseDetail; onChanged: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [artifact, setArtifact] = useState<{ url: string; name: string; path?: string; mediaType?: string } | null>(null);
    const [focusHandoff, setFocusHandoff] = useState<string | undefined>();
    useEffect(() => {
        if (!focusHandoff) return;
        document.getElementById(`handoff-${focusHandoff}`)?.scrollIntoView({ block: 'nearest' });
    }, [focusHandoff]);
    const decide = async (edge: AcpCaseEdge, decision: 'accept' | 'reject') => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            await acpCaseService.decideHandoff(detail.caseId, edge.handoffId, { decision });
            setMessage(decision === 'accept' ? text('已接受这一版交接。', 'Handoff accepted.') : text('已拒绝这次交接。', 'Handoff rejected.'));
            onChanged();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <section class="acp-detail acp-case-detail">
            <div class="acp-backbar">
                <button type="button" class="acp-button" onClick={() => navigateCase()}>
                    {text('← 返回列表', '← Back to list')}
                </button>
            </div>
            <header class="acp-detail-header">
                <div class="acp-detail-tools">
                    <div>
                        <strong>{detail.title || detail.goal || detail.caseId}</strong>
                    </div>
                    <div>
                        <button type="button" class="acp-button" onClick={onChanged}>
                            {text('刷新', 'Refresh')}
                        </button>
                    </div>
                </div>
                <p class="acp-channel-line">
                    <span>{detail.goal}</span>
                </p>
                <small class="acp-muted">
                    {text('创建于', 'Created')} {date(detail.createdAt)} · {detail.originSessionId}
                    {detail.legacy ? ` · ${text('旧记录投影', 'projected from older records')}` : ''}
                </small>
                {detail.artifactSpace && (
                    <small class="acp-muted">
                        {text('共享产物空间', 'Shared artifact space')} <code>{detail.artifactSpace}</code>
                    </small>
                )}
            </header>
            <div class="acp-detail-content">
                {error && <p class="acp-decision-error">{error}</p>}
                {message && <p class="acp-decision-message">{message}</p>}
                <CaseDag detail={detail} onOpenTask={jobId => navigateAcpTask({ jobId, full: false })} onOpenEdge={setFocusHandoff} />

                <section class="acp-detail-section">
                    <h3>
                        {text('待我确认', 'Waiting for me')} ({detail.inbox.filter(item => item.canDecide).length})
                    </h3>
                    {detail.inbox.length ? (
                        <ul class="acp-stage-list acp-inbox-list">
                            {detail.inbox.map(item => (
                                <InboxRow key={`${item.kind}-${item.id}`} item={item} onOpen={item => {
                                    if (item.kind === 'handoff') setFocusHandoff(item.id);
                                    else if (item.kind === 'review') navigateAcpTask({ jobId: item.jobId, reviewId: item.id, full: false });
                                    else navigateAcpTask({ jobId: item.jobId, full: false });
                                }} />
                            ))}
                        </ul>
                    ) : (
                        <p class="acp-muted">{text('这件事暂时没有等待确认的事。', 'Nothing on this case is waiting for a decision.')}</p>
                    )}
                </section>

                <section class="acp-detail-section">
                    <h3>{text('交接', 'Handoffs')}</h3>
                    {detail.edges.length ? (
                        <ul class="acp-stage-list acp-case-edges">
                            {detail.edges.map(edge => (
                                <EdgeRow key={edge.handoffId} edge={edge} caseId={detail.caseId} onDecide={decide} busy={busy} onPreview={setArtifact} focused={focusHandoff === edge.handoffId} />
                            ))}
                        </ul>
                    ) : (
                        <p class="acp-muted">{text('还没有交接。', 'No handoff yet.')}</p>
                    )}
                </section>

                <section class="acp-detail-section">
                    <h3>{text('约定', 'Conventions')}</h3>
                    {detail.conventions.length ? (
                        <ul class="acp-stage-list">
                            {detail.conventions.map(rule => (
                                <li key={rule.conventionId}>
                                    <span>{rule.achieved ? '✓' : '·'}</span>
                                    <div>
                                        <strong>
                                            {rule.toTargetId} / {rule.toPurpose}
                                        </strong>
                                        <small class="acp-muted">
                                            {rule.when === 'acceptance_accepted'
                                                ? text('验收通过后可交', 'May follow an accepted result')
                                                : rule.when === 'ticket_closed'
                                                  ? text('任务单关闭后可交', 'May follow a closed ticket')
                                                  : text('事实达到阈值后可交', 'May follow a measured fact')}
                                            {rule.condition ? `：${rule.condition.metric} ${rule.condition.operator} ${rule.condition.value}` : ''}
                                        </small>
                                        <small class="acp-muted">
                                            {rule.requireHuman
                                                ? text('需要人确认', 'A person confirms')
                                                : text('验收通过即自动成立交接', 'Acceptance alone makes the handoff happen')}
                                        </small>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p class="acp-muted">{text('还没有约定。', 'No convention yet.')}</p>
                    )}
                </section>

                <section class="acp-detail-section">
                    <h3>{text('任务', 'Tasks')}</h3>
                    <ul class="acp-stage-list">
                        {detail.tasks.map(task => (
                            <li key={task.jobId}>
                                <span />
                                <div>
                                    <strong>{task.title || task.jobId}</strong>
                                    <small class="acp-muted">
                                        {task.targetId} · {task.progressSummary}
                                    </small>
                                </div>
                                <Status value={taskStatus(task)} />
                            </li>
                        ))}
                    </ul>
                </section>

                <section class="acp-detail-section">
                    <h3>{text('产物', 'Artifacts')}</h3>
                    {detail.artifacts.length ? (
                        detail.artifacts.map((group, index) => (
                            <div class="acp-artifact-group" key={`${group.revision}-${index}`}>
                                <strong>
                                    {group.revision}
                                    {group.digest ? ` · ${group.digest.slice(0, 12)}` : ''}
                                </strong>
                                <div>
                                    {group.artifacts.map((item, position) => {
                                        const artifactItem = item as { path?: string; url?: string; mediaType?: string; sha256?: string };
                                        return (
                                            <LazyArtifactItem
                                                key={`${group.revision}-${position}`}
                                                jobId={group.jobId}
                                                artifact={artifactItem}
                                                onPreview={() =>
                                                    setArtifact({
                                                        url: artifactItem.url ?? '',
                                                        name: artifactItem.path?.split('/').pop() ?? text('产物', 'Artifact'),
                                                        path: artifactItem.path,
                                                        mediaType: artifactItem.mediaType,
                                                    })
                                                }
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    ) : (
                        <p class="acp-muted">{text('还没有产物。', 'No artifact yet.')}</p>
                    )}
                </section>

                <section class="acp-detail-section">
                    <h3>{text('发布回执', 'Publication receipts')}</h3>
                    {detail.receipts.length ? (
                        <ul class="acp-stage-list">
                            {detail.receipts.map(receipt => (
                                <li key={receipt.receiptId}>
                                    <span />
                                    <div>
                                        <strong>
                                            {receipt.channel} · {receipt.remoteId}
                                        </strong>
                                        <small class="acp-muted">
                                            {receipt.artifactDigest.slice(0, 16)} · {date(receipt.publishedAt)}
                                        </small>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p class="acp-muted">{text('还没有回执。', 'No receipt yet.')}</p>
                    )}
                </section>

                <section class="acp-detail-section">
                    <h3>{text('外部事实', 'External facts')}</h3>
                    {detail.facts.length ? (
                        <ul class="acp-stage-list">
                            {detail.facts.map(fact => (
                                <li key={fact.factId}>
                                    <span />
                                    <div>
                                        <strong>
                                            {fact.metric} {fact.value}
                                            {fact.unit ? ` ${fact.unit}` : ''}
                                        </strong>
                                        <small class="acp-muted">
                                            {fact.source} · {date(fact.observedAt)}
                                        </small>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p class="acp-muted">{text('还没有事实。', 'No fact yet.')}</p>
                    )}
                </section>
            </div>
            {artifact && (
                <LazyArtifactDrawer
                    jobId=""
                    artifact={{ path: artifact.path, url: artifact.url, mediaType: artifact.mediaType }}
                    onClose={() => setArtifact(null)}
                />
            )}
        </section>
    );
}

export function CaseModule({ refreshKey }: { refreshKey: number }) {
    const route = CaseRoute();
    const [detail, setDetail] = useState<AcpCaseDetail | null>(null);
    const [goal, setGoal] = useState('');
    const [origin, setOrigin] = useState('');
    const [origins, setOrigins] = useState<string[]>([]);
    const [creating, setCreating] = useState(false);
    const [formError, setFormError] = useState('');
    const [detailError, setDetailError] = useState('');
    const originRef = useRef('');
    originRef.current = origin;
    const list = useChunkedList<AcpCaseSummary>({
        active: true,
        refreshKey,
        resetKey: 'cases',
        pageSize: 20,
        idOf: item => `${item.originSessionId}:${item.caseId}`,
        fetchPage: async (offset, limit) => {
            const next = await acpCaseService.list(offset, limit);
            setOrigins(next.origins);
            if (!originRef.current && next.origins[0]) setOrigin(next.origins[0]);
            return next;
        },
    });
    const sentinel = useLoadMoreSentinel(list.items.length < list.total, list.items.length, list.loadMore);

    useEffect(() => {
        if (!route.caseId) {
            setDetail(null);
            return;
        }
        let live = true;
        void acpCaseService
            .get(route.caseId)
            .then(next => {
                if (!live) return;
                setDetail(next);
                setDetailError('');
            })
            .catch(err => live && setDetailError(errorText(err)));
        return () => {
            live = false;
        };
    }, [route.caseId, refreshKey]);

    const open = async () => {
        if (!goal.trim() || !origin) return;
        setCreating(true);
        setFormError('');
        try {
            await acpCaseService.open({ originSessionId: origin, goal: goal.trim() });
            setGoal('');
            list.reload();
        } catch (err) {
            setFormError(errorText(err));
        } finally {
            setCreating(false);
        }
    };

    const rows = list.items;
    const error = list.error;
    return (
        <div class={`acp-workbench-body${route.caseId ? ' has-case-detail' : ''}`}>
            <div class="acp-workbench-table">
                {!list.settled && !error && <Skeleton lines={5} />}
                {(error || formError) && (
                    <ErrorState
                        title={text('事情读取失败', 'Could not load cases')}
                        message={formError || error}
                        onRetry={() => list.reload()}
                    />
                )}
                <form class="acp-case-create" onSubmit={event => { event.preventDefault(); void open(); }}>
                    <label>
                        {text('新事情的目标', 'What is this thing for')}
                        <input
                            type="text"
                            value={goal}
                            placeholder={text('例如：本周公众号选题与发布', 'e.g. this week’s topics and publication')}
                            onInput={event => setGoal(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        {text('归属会话', 'Scope')}
                        <select value={origin} onChange={event => setOrigin(event.currentTarget.value)}>
                            {origins.map(item => (
                                <option key={item} value={item}>
                                    {item}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button type="submit" class="acp-button acp-primary" disabled={creating || !goal.trim() || !origin}>
                        {text('开一件事', 'Open a case')}
                    </button>
                </form>
                <table class="acp-desktop-only">
                    <thead>
                        <tr>
                            <th>{text('目标', 'Goal')}</th>
                            <th>{text('任务', 'Tasks')}</th>
                            <th>{text('待我确认', 'Waiting for me')}</th>
                            <th>{text('归属会话', 'Scope')}</th>
                            <th>{text('最近进展', 'Last activity')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {list.settled && !rows.length && (
                            <tr>
                                <td colSpan={5} class="acp-muted">
                                    {text('还没有事情。开一件事，之后它的任务、交接和待确认都在这里。', 'No case yet. Open one; its tasks, handoffs and decisions live here.')}
                                </td>
                            </tr>
                        )}
                        {rows.map(item => (
                            <tr key={`${item.originSessionId}-${item.caseId}`} class={`acp-task-row${route.caseId === item.caseId ? ' is-selected' : ''}`}>
                                <td>
                                    <button
                                        type="button"
                                        class="acp-link acp-name-link"
                                        title={item.goal}
                                        onClick={() => navigateCase(item.caseId, item.originSessionId)}
                                    >
                                        <span class="acp-title-text">{item.title || item.goal || item.caseId}</span>
                                        <small title={item.caseId}>{item.caseId}</small>
                                    </button>
                                </td>
                                <td>{item.taskCount}</td>
                                <td>{item.pendingCount || '—'}</td>
                                <td class="acp-muted">{item.originSessionId}</td>
                                <td class="acp-task-updated acp-nums">{date(item.lastActivityAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div class="acp-mobile-cards">
                    {list.settled && !rows.length && (
                        <p class="acp-muted">
                            {text('还没有事情。开一件事，之后它的任务、交接和待确认都在这里。', 'No case yet. Open one; its tasks, handoffs and decisions live here.')}
                        </p>
                    )}
                    {rows.map(item => (
                        <button
                            key={`${item.originSessionId}-${item.caseId}`}
                            type="button"
                            class={`acp-mobile-card${item.pendingCount ? ' is-waiting_human' : ' is-working'}${route.caseId === item.caseId ? ' is-selected' : ''}`}
                            onClick={() => navigateCase(item.caseId, item.originSessionId)}
                        >
                            <span class="acp-mobile-card-head">
                                <strong>{item.title || item.goal || item.caseId}</strong>
                                <Status value={item.pendingCount ? 'waiting_human' : 'working'} />
                            </span>
                            <span class="acp-mobile-card-meta">
                                <span class="acp-mode-label acp-nums">{text(`${item.taskCount} 个任务`, `${item.taskCount} tasks`)}</span>
                                {!!item.pendingCount && <span class="acp-mode-label acp-nums">{text(`待确认 ${item.pendingCount}`, `${item.pendingCount} waiting`)}</span>}
                            </span>
                            <span class="acp-task-blocker">{item.goal}</span>
                            <time class="acp-task-updated acp-nums">{date(item.lastActivityAt)}</time>
                        </button>
                    ))}
                </div>
                {rows.length < list.total && (
                    <div class="acp-pagination">
                        <button type="button" class="acp-button" disabled={list.loadingMore} onClick={list.loadMore}>
                            {text(`加载更多（已显示 ${rows.length} / 共 ${list.total} 条）`, `Load more (${rows.length} of ${list.total})`)}
                        </button>
                    </div>
                )}
                <div ref={sentinel} class="acp-load-sentinel" />
            </div>
            {route.caseId && (
                <div class="acp-case-panel">
                    {detailError && <ErrorState title={text('事情读取失败', 'Could not load cases')} message={detailError} />}
                    {detail ? (
                        <CaseDetail detail={detail} onChanged={() => list.reload()} />
                    ) : (
                        !detailError && <EmptyState title={text('读取这件事', 'Reading the case')} />
                    )}
                </div>
            )}
        </div>
    );
}
