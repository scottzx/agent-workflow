import { useEffect, useMemo, useState } from 'preact/hooks';
import { acpCaseService, acpTaskService, AcpTaskApiError } from './api';
import { approvalsEmptyText, filterApprovalQueue } from './approvals-queue';
import { approvalKey, readSeen, rememberSeen } from './approvals-sync';
import { ProcessRequestPanel } from './ProcessRequests';
import type { AcpApprovalItem, AcpApprovalKind, AcpApprovals, AcpTaskDetail } from './types';
import { channelLabel, date, ErrorState, errorText, language, text } from './ui';

const kindLabel = (kind: AcpApprovalKind | 'all') =>
    ({
        all: text('全部', 'All'),
        process_request: text('过程请求', 'Process'),
        review: text('产物审核', 'Review'),
        handoff: text('交接提议', 'Handoff'),
        proposal: text('规范提议', 'Proposal'),
    })[kind];

const proposalKindLabel = (kind: NonNullable<AcpApprovalItem['proposalKind']>) =>
    ({
        locked: text('红线', 'Locked'),
        check: text('检查', 'Check'),
        role: text('角色', 'Role'),
        qa: text('质检', 'QA'),
        eval_change: text('考卷变更', 'Eval Change'),
        permission_escalation: text('越权申请', 'Escalation'),
        promote_formal: text('晋升 Formal', 'Promote Formal'),
    })[kind];

function urgent(item: AcpApprovalItem, now: number): boolean {
    if (!item.deadlineAt) return false;
    const deadline = Date.parse(item.deadlineAt);
    return Number.isFinite(deadline) && deadline - now < 60_000;
}

export function ApprovalsModule({
    view,
    seenTick,
    onReload,
    onViewed,
    onOpenTask,
    onOpenCase,
}: {
    view: AcpApprovals | null;
    seenTick: number;
    onReload: () => void;
    onViewed: () => void;
    onOpenTask: (jobId: string, reviewId?: string) => void;
    onOpenCase: (caseId: string, originSessionId?: string) => void;
}) {
    const [kind, setKind] = useState<AcpApprovalKind | 'all'>('all');
    const [channel, setChannel] = useState<'all' | 'formal' | 'trial'>('all');
    const [selectedId, setSelectedId] = useState<string | undefined>();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [detail, setDetail] = useState<AcpTaskDetail | null>(null);
    const [note, setNote] = useState('');
    const [shown, setShown] = useState(20);
    const [showDetail, setShowDetail] = useState(false);
    const now = Date.now();
    const items = view?.items ?? [];
    const queue = useMemo(() => filterApprovalQueue(items, kind, channel, now), [items, kind, channel, now]);
    const selected = queue.find(item => item.id === selectedId) ?? queue[0];
    // A proposal's summary and its body are often the same sentence: render it once, never as a repeated wall.
    const summary = (selected?.summary ?? '').trim();
    const bodyText = (selected?.text ?? '').trim();
    const showSummary = !!summary && summary !== bodyText;
    const visibleQueue = queue.slice(0, shown);
    const remaining = queue.length - visibleQueue.length;

    useEffect(() => {
        setShown(20);
    }, [kind, channel]);

    useEffect(() => {
        if (!selected || selected.kind !== 'review') {
            setDetail(null);
            return;
        }
        let alive = true;
        acpTaskService.get(selected.jobId).then(next => { if (alive) setDetail(next); }).catch(() => { if (alive) setDetail(null); });
        return () => { alive = false; };
    }, [selected?.id, selected?.jobId, selected?.kind]);

    const open = (item: AcpApprovalItem) => {
        setSelectedId(item.id);
        setShowDetail(true);
        setError('');
        setNotice('');
        setNote('');
        rememberSeen(approvalKey(item));
        onViewed();
    };

    const finish = (message: string) => {
        setNotice(message);
        setError('');
        const rest = queue.filter(item => item.id !== selected?.id);
        setSelectedId(rest[0]?.id);
        onReload();
    };

    const fail = (err: unknown) => {
        if (err instanceof AcpTaskApiError && err.status === 409) {
            setError(text('这条已经被别人处理了，已刷新。', 'This item changed. Refreshed.'));
            onReload();
            return;
        }
        setError(errorText(err));
    };

    const decideReview = async (action: 'approve' | 'changes_requested' | 'comment' | 'cancel') => {
        if (!selected?.revision || !selected.digest) return;
        if ((action === 'changes_requested' || action === 'comment') && !note.trim()) {
            setError(text('请写明理由。', 'A note is required.'));
            return;
        }
        setBusy(true);
        try {
            await acpTaskService.decide(selected.jobId, selected.id, {
                action, revision: selected.revision, digest: selected.digest, clientRequestId: crypto.randomUUID(),
                ...(note.trim() ? { note: note.trim() } : {}),
            });
            finish(text('审核已提交。', 'Review submitted.'));
        } catch (err) { fail(err); }
        finally { setBusy(false); }
    };

    const decideHandoff = async (decision: 'accept' | 'reject') => {
        if (!selected?.caseId || !selected.handoff) return;
        setBusy(true);
        try {
            await acpCaseService.decideHandoff(selected.caseId, selected.handoff.handoffId, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
            finish(decision === 'accept' ? text('已接受这一版。', 'Accepted.') : text('已拒绝。', 'Rejected.'));
        } catch (err) { fail(err); }
        finally { setBusy(false); }
    };

    const decideProposal = async (state: 'accepted' | 'rejected' | 'done') => {
        if (!selected?.proposalId) return;
        if (!note.trim()) {
            setError(text('请填写理由。', 'A reason is required.'));
            return;
        }
        setBusy(true);
        try {
            await acpTaskService.decideProposal(selected.jobId, selected.proposalId, { state, note: note.trim() });
            finish(text('规范提议已记录。', 'Proposal recorded.'));
        } catch (err) { fail(err); }
        finally { setBusy(false); }
    };

    return (
        <div class="acp-approvals">
            <div class="acp-workbench-views" role="toolbar" aria-label={text('审批筛选', 'Approval filters')}>
                {(['all', 'process_request', 'review', 'handoff', 'proposal'] as const).map(value => (
                    <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>
                        {kindLabel(value)}
                        {view && value !== 'all' && <span>{view.counts[value]}</span>}
                    </button>
                ))}
                <span class="acp-filter-gap" />
                {(['all', 'formal', 'trial'] as const).map(value => (
                    <button key={value} type="button" aria-pressed={channel === value} onClick={() => setChannel(value)}>
                        {value === 'all' ? text('全部渠道', 'All channels') : value === 'formal' ? text('正式', 'Formal') : text('试跑', 'Trial')}
                    </button>
                ))}
            </div>
            {!view && <p class="acp-muted">{text('正在读取待审批…', 'Loading approvals…')}</p>}
            {view && !queue.length && <p class="acp-muted">{approvalsEmptyText(items.length, language)}</p>}
            {!!queue.length && (
                <div class={`acp-approvals-split${showDetail ? ' is-showing-detail' : ''}`}>
                    <ul class="acp-approval-queue" aria-label={text('待审批队列', 'Approval queue')}>
                        {visibleQueue.map(item => {
                            const unseen = seenTick >= 0 && !readSeen().has(approvalKey(item));
                            return (
                                <li key={item.id}>
                                    <button type="button" class={`acp-approval-row${selected?.id === item.id ? ' is-selected' : ''}${urgent(item, now) ? ' is-urgent' : ''}`} onClick={() => open(item)}>
                                        {unseen && <span class="acp-unread-dot" aria-label={text('未读', 'Unread')} />}
                                        <span class="acp-approval-row-main">
                                            <strong class="acp-approval-title">{item.title}</strong>
                                            <span class="acp-approval-meta">
                                                {item.proposalKind && (
                                                    <span class="acp-kind-tag">{proposalKindLabel(item.proposalKind)}</span>
                                                )}
                                                <span>{kindLabel(item.kind)}</span>
                                                <span aria-hidden="true">·</span>
                                                <span>{channelLabel(item.channel)}</span>
                                                <span aria-hidden="true">·</span>
                                                <span>{date(item.createdAt)}</span>
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {remaining > 0 && (
                            <li>
                                <button type="button" class="acp-button" onClick={() => setShown(count => count + 20)}>
                                    {text(`显示更多剩余 ${remaining} 条`, `Show the remaining ${remaining}`)}
                                </button>
                            </li>
                        )}
                    </ul>
                    {selected && (
                        <section class="acp-approval-detail" aria-live="polite">
                            <div class="acp-backbar">
                                <button type="button" class="acp-button" onClick={() => setShowDetail(false)}>
                                    {text('← 返回列表', '← Back to list')}
                                </button>
                            </div>
                            <header class="acp-approval-detail-head">
                                <div class="acp-approval-heading">
                                    <h2>{selected.title}</h2>
                                    <p class="acp-approval-meta">
                                        <span class="acp-kind-tag">{kindLabel(selected.kind)}</span>
                                        {selected.proposalKind && (
                                            <span class="acp-kind-tag">{proposalKindLabel(selected.proposalKind)}</span>
                                        )}
                                        {selected.roleId && <span>{selected.roleId}</span>}
                                        <span>{channelLabel(selected.channel)}</span>
                                        <span aria-hidden="true">·</span>
                                        <span>{date(selected.createdAt)}</span>
                                    </p>
                                    {showSummary && <p class="acp-approval-summary">{selected.summary}</p>}
                                </div>
                                <div class="acp-header-actions">
                                    <button type="button" class="acp-link" onClick={() => onOpenTask(selected.jobId, selected.kind === 'review' ? selected.id : undefined)}>
                                        {text('打开所属任务', 'Open task')}
                                    </button>
                                    {selected.caseId && (
                                        <button type="button" class="acp-link" onClick={() => onOpenCase(selected.caseId!, selected.originSessionId)}>
                                            {text('打开所属事情', 'Open case')}
                                        </button>
                                    )}
                                </div>
                            </header>
                            {error && <ErrorState title={text('没能提交', 'Could not submit')} message={error} onRetry={onReload} />}
                            {notice && <p class="acp-decision-message">{notice}</p>}
                            {selected.kind === 'process_request' && selected.processRequest && (
                                <>
                                    <ProcessRequestPanel jobId={selected.jobId} requests={[selected.processRequest]} onReload={() => finish(text('过程请求已处理。', 'Request handled.'))} />
                                </>
                            )}
                            {selected.kind === 'review' && (
                                <div class="acp-review-form">
                                    <p>{text('版本', 'Revision')} {selected.revision} · {selected.digest?.slice(0, 12)}</p>
                                    {detail?.reviews.find(review => review.reviewId === selected.id)?.preview.markdown && (
                                        <pre class="acp-approval-preview">{detail.reviews.find(review => review.reviewId === selected.id)?.preview.markdown}</pre>
                                    )}
                                    {detail?.reviews.find(review => review.reviewId === selected.id)?.preview.slides?.slice(0, 3).map((slide, index) => (
                                        <p key={index}><strong>{slide.title}</strong> {slide.message}</p>
                                    ))}
                                    <div class="acp-decision-box">
                                        <textarea value={note} maxLength={4000} placeholder={text('意见（要求修改或评论时必填）', 'Note, required to request changes or comment')} onInput={event => setNote(event.currentTarget.value)} />
                                        <div class="acp-review-buttons acp-sticky-actions">
                                            <button type="button" class="acp-button acp-primary" disabled={busy} onClick={() => void decideReview('approve')}>{text('通过', 'Approve')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideReview('changes_requested')}>{text('要求修改', 'Request changes')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideReview('comment')}>{text('评论', 'Comment')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideReview('cancel')}>{text('放弃', 'Abandon')}</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {selected.kind === 'handoff' && selected.handoff && (
                                <div class="acp-review-form">
                                    <p>{selected.handoff.reason}</p>
                                    <p class="acp-muted">{selected.handoff.toTargetId} / {selected.handoff.purpose} · {selected.handoff.artifactRevision} · {selected.handoff.artifactDigest.slice(0, 8)}</p>
                                    {selected.handoff.snapshots?.map(file => <p key={file.digest}>{file.name}</p>)}
                                    <div class="acp-decision-box">
                                        <textarea value={note} maxLength={4000} placeholder={text('备注（可选）', 'Note (optional)')} onInput={event => setNote(event.currentTarget.value)} />
                                        <div class="acp-review-buttons acp-sticky-actions">
                                            <button type="button" class="acp-button acp-primary" disabled={busy} onClick={() => void decideHandoff('accept')}>{text('接受这一版', 'Accept this version')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideHandoff('reject')}>{text('拒绝', 'Reject')}</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {selected.kind === 'proposal' && (
                                <div class="acp-review-form">
                                    {!!bodyText && <p class="acp-approval-body">{selected.text}</p>}
                                    {!!selected.evidence?.trim() && (
                                        <pre class="acp-approval-preview">{selected.evidence}</pre>
                                    )}
                                    <div class="acp-decision-box">
                                        <textarea value={note} maxLength={2000} placeholder={text('理由（必填）', 'Reason (required)')} onInput={event => setNote(event.currentTarget.value)} />
                                        <div class="acp-review-buttons acp-sticky-actions">
                                            <button type="button" class="acp-button acp-primary" disabled={busy} onClick={() => void decideProposal('accepted')}>{text('采纳', 'Accept')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideProposal('rejected')}>{text('拒绝', 'Reject')}</button>
                                            <button type="button" class="acp-button" disabled={busy} onClick={() => void decideProposal('done')}>{text('已完成', 'Done')}</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
