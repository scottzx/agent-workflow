import { Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpDecisionInput, AcpDshSession, AcpExecution, AcpReview, AcpReviewAction, AcpTaskDetail } from './types';
import { acpTaskHash, executionLabels, latestReview } from './model';
import { ProcessRequestPanel } from './ProcessRequests';
import { ArtifactDrawer, ArtifactItem, Md, ReportPreview, TaskChat, type ArtifactRef } from './Preview';
import {
    channelLabel,
    date,
    displayStatus,
    duration,
    EmptyState,
    eventLabel,
    ErrorState,
    ExecutionRole,
    ExecutionService,
    language,
    navigateAcpTask,
    ServiceProvenance,
    Status,
    statusLabel,
    taskStatus,
    text,
    title,
} from './ui';

type DetailTab = 'overview' | 'progress' | 'review' | 'chat' | 'events';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Inside DSH the page sits in a same-origin frame whose host can open the task's own session.
const embedded = window.parent !== window;

/** Manual takeover: continue in the DSH session; the agent's submit_to_review hands the result back. */
function TakeOver({ detail }: { detail: AcpTaskDetail }) {
    const sessionId = detail.attempts.find(attempt => attempt.attemptId === detail.currentAttemptId)?.backendRunRef?.sessionId;
    const [session, setSession] = useState<AcpDshSession | null>(null);
    useEffect(() => {
        setSession(null);
        if (!embedded || !sessionId) return;
        let live = true;
        acpTaskService.dshSession(sessionId).then(
            value => live && setSession(value),
            () => live && setSession(null)
        );
        return () => {
            live = false;
        };
    }, [sessionId, detail.executionStatus]);
    // Sessions of another execution host are not on this DSH.
    if (!sessionId || !session?.available) return null;
    const running = session.task?.running === true;
    return (
        <button
            type="button"
            class="acp-button acp-primary"
            disabled={running}
            title={
                running
                    ? text('A2A 任务仍在执行，结束后可接管', 'The A2A task is still running; take over once it ends')
                    : text(
                          '在 DSH 会话中继续处理；满意后让智能体调用 submit_to_review 提交回工作流',
                          'Continue in the DSH session; when satisfied, have the agent call submit_to_review'
                      )
            }
            onClick={() => window.parent.postMessage({ type: '1agents:open-session', sessionId }, location.origin)}
        >
            {running ? text('执行中…', 'Running…') : text('在 DSH 中接管', 'Take over in DSH')}
        </button>
    );
}

function ExecutionCaption({ execution }: { execution?: AcpExecution }) {
    const labels = executionLabels(execution, language);
    return (
        <small class="acp-execution-caption">
            <span>
                {labels.mode} · {labels.role}
            </span>
            <span>
                <ExecutionService execution={execution} />
            </span>
        </small>
    );
}

function ExecutionFacts({ execution }: { execution?: AcpExecution }) {
    const labels = executionLabels(execution, language);
    return (
        <Fragment>
            <span>
                {text('任务方式', 'Task mode')}
                <strong>{labels.mode}</strong>
            </span>
            <span>
                {text('角色或预设', 'Role / preset')}
                <strong>
                    <ExecutionRole execution={execution} />
                </strong>
            </span>
            <span>
                {text('执行服务', 'Execution service')}
                <strong>
                    <ExecutionService execution={execution} />
                </strong>
            </span>
        </Fragment>
    );
}

export function AcpTaskDetailPanel({
    jobId,
    requestedReviewId,
    full,
    onChanged,
}: {
    jobId: string;
    requestedReviewId?: string;
    full: boolean;
    onChanged: () => void;
}) {
    const [detail, setDetail] = useState<AcpTaskDetail | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<DetailTab>(requestedReviewId ? 'review' : 'overview');
    const [reviewId, setReviewId] = useState<string | undefined>(requestedReviewId);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [decisionMessage, setDecisionMessage] = useState('');
    const [decisionError, setDecisionError] = useState('');
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [previewing, setPreviewing] = useState<ArtifactRef>();
    const closePreview = useCallback(() => setPreviewing(undefined), []);
    const decisionRequest = useRef<{ key: string; id: string } | null>(null);
    const alive = useRef(true);
    const requestInFlight = useRef(false);
    const heading = useRef<HTMLHeadingElement>(null);
    const currentReview = detail?.reviews.find(review => review.reviewId === reviewId);
    const latest = latestReview(detail?.reviews || []);

    const load = useCallback(async () => {
        if (requestInFlight.current) return;
        requestInFlight.current = true;
        try {
            const next = await acpTaskService.get(jobId);
            if (!alive.current) return;
            setDetail(next);
            setError('');
            setReviewId(
                previous =>
                    previous || requestedReviewId || next.pendingReviewId || latestReview(next.reviews)?.reviewId
            );
        } catch (err) {
            if (alive.current) setError(errorText(err));
        } finally {
            if (alive.current) {
                setLoading(false);
                requestInFlight.current = false;
            }
        }
    }, [jobId]);

    useEffect(() => {
        alive.current = true;
        void load();
        const interval = window.setInterval(() => {
            if (!document.hidden) void load();
        }, 5000);
        return () => {
            alive.current = false;
            window.clearInterval(interval);
        };
    }, [load]);

    useEffect(() => {
        if (requestedReviewId) {
            setReviewId(requestedReviewId);
            setTab('review');
            setDecisionError('');
            setNote('');
        }
    }, [requestedReviewId]);

    useEffect(() => {
        if (detail) heading.current?.focus();
    }, [!!detail]);

    useEffect(() => setPreviewing(undefined), [jobId]);

    const selectReview = (id: string) => {
        setReviewId(id);
        setTab('review');
        setDecisionError('');
        setDecisionMessage('');
        setNote('');
        navigateAcpTask({ jobId, reviewId: id, full });
    };

    /** A link in agent text opens the preview only when it names a registered artifact; other host paths stay inert. */
    const openFile = (path: string) => {
        const found = (detail?.artifacts || [])
            .flatMap(result => result.artifacts)
            .find(item => typeof item === 'object' && (item as ArtifactRef).path === path) as ArtifactRef | undefined;
        if (found) setPreviewing(found);
    };

    const decide = async (action: AcpReviewAction) => {
        if (!currentReview || busy || currentReview.status !== 'pending' || !currentReview.canReview) return;
        if ((action === 'changes_requested' || action === 'comment') && !note.trim()) {
            setDecisionError(text('请填写具体意见。', 'Please enter feedback.'));
            return;
        }
        const key = JSON.stringify([
            currentReview.reviewId,
            currentReview.revision,
            currentReview.digest,
            action,
            note.trim(),
        ]);
        if (decisionRequest.current?.key !== key) decisionRequest.current = { key, id: crypto.randomUUID() };
        const input: AcpDecisionInput = {
            action,
            revision: currentReview.revision,
            digest: currentReview.digest,
            clientRequestId: decisionRequest.current.id,
            ...(note.trim() ? { note: note.trim() } : {}),
        };
        setBusy(true);
        setDecisionError('');
        setDecisionMessage('');
        try {
            await acpTaskService.decide(currentReview.jobId || jobId, currentReview.reviewId, input);
            if (!alive.current) return;
            setNote('');
            setConfirmCancel(false);
            decisionRequest.current = null;
            setDecisionMessage(
                action === 'comment'
                    ? text('评论已保存，审核仍待确认。', 'Comment saved. Review remains pending.')
                    : text('决定已保存，正在同步任务进展。', 'Decision saved. Synchronizing task progress.')
            );
            await load();
            onChanged();
        } catch (err) {
            if (!alive.current) return;
            setDecisionError(
                err instanceof AcpTaskApiError &&
                    err.status === 403 &&
                    /browser_review_required|same.origin|browser/i.test(err.message)
                    ? text(
                          '当前连接不能提交人工决定。请在任务所在节点的 Web 页面登录后处理审核。',
                          'This connection cannot submit human decisions. Open the node’s web page and sign in to review.'
                      )
                    : err instanceof AcpTaskApiError && err.status === 409
                      ? text(
                            '版本或审核状态已经变化。请核对当前状态；旧版本的决定不会放行新版。',
                            'The version or review state changed. Check the latest state before deciding.'
                        )
                      : errorText(err)
            );
            if (err instanceof AcpTaskApiError && err.status === 409) await load();
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const copyLink = async () => {
        const url = new URL(window.location.href);
        url.hash = acpTaskHash({ jobId, reviewId: tab === 'review' ? reviewId : undefined, full: true });
        try {
            await navigator.clipboard.writeText(url.href);
            setDecisionMessage(text('任务链接已复制', 'Task link copied'));
        } catch {
            setDecisionMessage(text('无法复制链接，可复制地址栏链接', 'Could not copy. Copy the address bar URL.'));
        }
    };
    const tabs: [DetailTab, string][] = [
        ['overview', text('概览', 'Overview')],
        ['progress', text('进展', 'Progress')],
        ['review', text('产物与审核', 'Artifacts & review')],
        ['chat', text('对话', 'Conversation')],
        ['events', text('事件记录', 'Events')],
    ];
    return (
        <aside class="acp-detail" aria-label={text('任务详情', 'Task details')}>
            <header class="acp-detail-header">
                <div class="acp-detail-tools">
                    <span>{text('任务详情', 'Task details')}</span>
                    <div>
                        {detail && <TakeOver detail={detail} />}
                        <button type="button" class="acp-button" onClick={copyLink}>
                            {text('复制链接', 'Copy link')}
                        </button>
                        <button
                            type="button"
                            class="acp-button"
                            onClick={() => navigateAcpTask({ jobId, reviewId: requestedReviewId, full: !full })}
                        >
                            {full ? text('返回表格', 'Back to table') : text('展开整页', 'Full page')}
                        </button>
                        <button type="button" class="acp-button" onClick={() => navigateAcpTask({ full: false })}>
                            {text('关闭', 'Close')}
                        </button>
                    </div>
                </div>
                <div class="acp-breadcrumb">
                    {detail?.ancestors?.map(task => (
                        <Fragment key={task.jobId}>
                            <button
                                type="button"
                                class="acp-link"
                                onClick={() => navigateAcpTask({ jobId: task.jobId, full })}
                            >
                                {title(task)}
                            </button>
                            <span>›</span>
                        </Fragment>
                    ))}
                    <span>{jobId}</span>
                </div>
                <h2 ref={heading} tabIndex={-1}>
                    {detail ? title(detail) : text('正在读取任务…', 'Loading task…')}
                </h2>
                {detail && (
                    <p class="acp-channel-line">
                        <Status value={taskStatus(detail)} />
                        <span class="acp-mode-label">{channelLabel(detail.channel)}</span>
                        {detail.agentName && <span>{detail.agentName}</span>}
                        {detail.stale && (
                            <span class="acp-stale">
                                {text('当前为缓存状态，等待同步', 'Cached status; awaiting synchronization')}
                            </span>
                        )}
                    </p>
                )}
                {detail?.pendingProcessRequestId && tab !== 'overview' && (
                    <button type="button" class="acp-link" onClick={() => setTab('overview')}>
                        {text('有过程请求待回答', 'A process request is waiting')}
                    </button>
                )}
            </header>
            <nav class="acp-detail-tabs" aria-label={text('任务详情视图', 'Task detail views')} role="tablist">
                {tabs.map(([id, label]) => (
                    <button
                        key={id}
                        id={`acp-detail-tab-${id}`}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        aria-controls="acp-detail-content"
                        onClick={() => setTab(id)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <div
                class="acp-detail-content"
                id="acp-detail-content"
                role="tabpanel"
                aria-labelledby={`acp-detail-tab-${tab}`}
            >
                {error && (
                    <ErrorState
                        title={text('任务详情读取失败', 'Could not load task details')}
                        message={error}
                        onRetry={() => void load()}
                    />
                )}
                {loading && <p class="acp-muted">{text('正在载入…', 'Loading…')}</p>}
                {detail && (
                    <Fragment>
                        {tab === 'overview' && (
                            <TaskOverview
                                detail={detail}
                                onReview={id => selectReview(id)}
                                onReload={() => void load()}
                                onOpenFile={openFile}
                            />
                        )}
                        {tab === 'progress' && (
                            <TaskProgress detail={detail} onReview={id => selectReview(id)} onReload={() => void load()} full={full} />
                        )}
                        {tab === 'review' && (
                            <Fragment>
                                <TaskReview
                                    detail={detail}
                                    review={currentReview}
                                    requestedReviewId={reviewId}
                                    onSelect={selectReview}
                                    previewing={previewing}
                                    onPreview={setPreviewing}
                                />
                                {currentReview && (
                                    <Fragment>
                                        {latest && latest.reviewId !== currentReview.reviewId && (
                                            <div class="acp-notice">
                                                {text('正在查看历史版本。', 'Viewing a historical version.')}{' '}
                                                <button
                                                    type="button"
                                                    class="acp-link"
                                                    onClick={() => selectReview(latest.reviewId)}
                                                >
                                                    {text('查看最新版本 →', 'View latest version →')}
                                                </button>
                                            </div>
                                        )}
                                        {currentReview.status === 'approved' &&
                                            !['completed', 'failed', 'canceled', 'rejected'].includes(
                                                detail.executionStatus
                                            ) &&
                                            currentReview.resumeStatus === 'pending' && (
                                                <div class="acp-notice" role="status">
                                                    {text(
                                                        '本版已通过，等待系统继续处理。',
                                                        'This version is approved. Waiting for the workflow to resume.'
                                                    )}
                                                </div>
                                            )}
                                        {currentReview.resumeError && (
                                            <p role="alert" class="acp-decision-error">
                                                {currentReview.resumeError}
                                            </p>
                                        )}
                                        <ReviewHistory review={currentReview} />
                                        {currentReview.status === 'pending' && currentReview.canReview && (
                                            <div class="acp-review-form">
                                                <label htmlFor="acp-review-feedback">
                                                    {text('审核意见', 'Review feedback')}
                                                </label>
                                                <textarea
                                                    id="acp-review-feedback"
                                                    value={note}
                                                    disabled={busy}
                                                    onInput={event => setNote(event.currentTarget.value)}
                                                    placeholder={text(
                                                        '可注明具体页码；要求修改时请填写意见。',
                                                        'Reference page numbers. Feedback is required when requesting changes.'
                                                    )}
                                                />
                                                <div class="acp-review-buttons">
                                                    <button
                                                        type="button"
                                                        class="acp-link"
                                                        disabled={busy}
                                                        onClick={() => void decide('comment')}
                                                    >
                                                        {text('发表评论', 'Comment')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="acp-button"
                                                        disabled={busy}
                                                        onClick={() => navigateAcpTask({ full: false })}
                                                    >
                                                        {text('稍后处理', 'Later')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="acp-button"
                                                        disabled={busy}
                                                        onClick={() => void decide('changes_requested')}
                                                    >
                                                        {text('要求修改', 'Request changes')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="acp-button acp-primary"
                                                        disabled={busy}
                                                        onClick={() => void decide('approve')}
                                                    >
                                                        {busy
                                                            ? text('正在提交…', 'Submitting…')
                                                            : text(
                                                                  `通过 ${currentReview.revision}`,
                                                                  `Approve ${currentReview.revision}`
                                                              )}
                                                    </button>
                                                </div>
                                                <details class="acp-more-actions">
                                                    <summary>{text('更多操作', 'More actions')}</summary>
                                                    {confirmCancel ? (
                                                        <div class="acp-cancel-confirm">
                                                            <p>
                                                                {text(
                                                                    '放弃将终止当前工作流，已有产物与历史保留。',
                                                                    'Abandoning ends this workflow and retains existing artifacts and history.'
                                                                )}
                                                            </p>
                                                            <button
                                                                type="button"
                                                                class="acp-button"
                                                                disabled={busy}
                                                                onClick={() => setConfirmCancel(false)}
                                                            >
                                                                {text('继续保留', 'Keep task')}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                class="acp-button acp-danger"
                                                                disabled={busy}
                                                                onClick={() => void decide('cancel')}
                                                            >
                                                                {text('确认放弃任务', 'Confirm abandon')}
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            class="acp-link"
                                                            onClick={() => setConfirmCancel(true)}
                                                        >
                                                            {text('放弃任务', 'Abandon task')}
                                                        </button>
                                                    )}
                                                </details>
                                            </div>
                                        )}
                                        {currentReview.status === 'pending' && !currentReview.canReview && (
                                            <p class="acp-muted">
                                                {text(
                                                    '此审核未分配给当前用户。',
                                                    'This review is not assigned to the current user.'
                                                )}
                                            </p>
                                        )}
                                    </Fragment>
                                )}
                                {decisionMessage && (
                                    <p class="acp-decision-message" role="status">
                                        {decisionMessage}
                                    </p>
                                )}
                                {decisionError && (
                                    <p class="acp-decision-error" role="alert">
                                        {decisionError}
                                    </p>
                                )}
                            </Fragment>
                        )}
                        {tab === 'chat' && <TaskChat jobId={jobId} onOpenFile={openFile} />}
                        {tab === 'events' && (
                            <Fragment>
                                <TaskTechnical detail={detail} />
                                <TaskEvents detail={detail} />
                            </Fragment>
                        )}
                    </Fragment>
                )}
            </div>
            {previewing && <ArtifactDrawer jobId={jobId} artifact={previewing} onClose={closePreview} />}
        </aside>
    );
}

/** The verdict itself is the header status; this keeps only what the chip cannot say. */
function AcceptanceSection({ detail }: { detail: AcpTaskDetail }) {
    const acceptance = detail.businessAcceptance;
    if (!acceptance) return null;
    return (
        <section class="acp-detail-section">
            <h3>{text('业务验收', 'Business acceptance')}</h3>
            <dl class="acp-acceptance-record">
                <dt>{text('结果版本', 'Result revision')}</dt>
                <dd>{acceptance.resultRevision}</dd>
                <dt>{text('记录时间', 'Recorded')}</dt>
                <dd>{date(acceptance.recordedAt)}</dd>
                {acceptance.note && (
                    <Fragment>
                        <dt>{text('说明', 'Note')}</dt>
                        <dd>{acceptance.note}</dd>
                    </Fragment>
                )}
            </dl>
        </section>
    );
}

function TaskOverview({
    detail,
    onReview,
    onReload,
    onOpenFile,
}: {
    detail: AcpTaskDetail;
    onReview: (id: string) => void;
    onReload: () => void;
    onOpenFile: (path: string) => void;
}) {
    const current = detail.attempts.find(attempt => attempt.attemptId === detail.currentAttemptId);
    const answer = current?.result?.resultSummary;
    return (
        <Fragment>
            <ProcessRequestPanel
                jobId={detail.jobId}
                requests={detail.processRequests?.filter(request => request.status === 'pending')}
                onReload={onReload}
            />
            {detail.executionStatus === 'completed' && <AcceptanceSection detail={detail} />}
            {detail.pendingReviewId && (
                <p class="acp-notice">
                    {text('有产物等待你审核。', 'An artifact is waiting for your review.')}{' '}
                    <button type="button" class="acp-link" onClick={() => onReview(detail.pendingReviewId!)}>
                        {text('去审核', 'Review')}
                    </button>
                </p>
            )}
            {detail.description && (
                <section class="acp-detail-section">
                    <h3>{text('任务描述', 'Task description')}</h3>
                    <Md source={detail.description} onOpenFile={onOpenFile} />
                </section>
            )}
            {answer ? (
                <section class="acp-detail-section">
                    <h3>{text('最新回答', 'Latest answer')}</h3>
                    <Md source={answer} onOpenFile={onOpenFile} />
                </section>
            ) : (
                detail.progressSummary && (
                    <section class="acp-detail-section">
                        <h3>{text('当前进展', 'Current progress')}</h3>
                        <Md source={detail.progressSummary} onOpenFile={onOpenFile} />
                    </section>
                )
            )}
            <div class="acp-task-facts">
                <span>
                    {text('创建', 'Created')}
                    <strong>{date(detail.createdAt)}</strong>
                </span>
                <span>
                    {text('最近更新', 'Last updated')}
                    <strong>{date(detail.updatedAt)}</strong>
                </span>
                {detail.progress?.executionElapsedMs !== undefined && (
                    <span>
                        {text('实际执行', 'Execution time')}
                        <strong>{duration(detail.progress.executionElapsedMs)}</strong>
                    </span>
                )}
                {detail.progress?.humanWaitingMs !== undefined && (
                    <span>
                        {text('人工等待', 'Human wait')}
                        <strong>{duration(detail.progress.humanWaitingMs)}</strong>
                    </span>
                )}
            </div>
        </Fragment>
    );
}

function TaskProgress({
    detail,
    onReview,
    onReload,
    full,
}: {
    detail: AcpTaskDetail;
    onReview: (id: string) => void;
    onReload: () => void;
    full: boolean;
}) {
    const stages = detail.progress?.stages || [];
    return (
        <Fragment>
            {/* Pending requests sit in the overview where they need an answer; settled ones are history. */}
            <ProcessRequestPanel
                jobId={detail.jobId}
                requests={detail.processRequests?.filter(request => request.status !== 'pending')}
                onReload={onReload}
            />
            {stages.length > 0 && (
                <section class="acp-detail-section">
                    <h3>{text('阶段进展', 'Stage progress')}</h3>
                    <ol class="acp-stage-list">
                        {stages.map(stage => (
                            <li key={stage.stage}>
                                <span class={`acp-stage-dot acp-stage-dot-${stage.status}`} aria-hidden="true">
                                    {stage.status === 'completed' || stage.status === 'approved' ? '✓' : '•'}
                                </span>
                                <div>
                                    <strong>{stage.name}</strong>
                                    <small>
                                        {stage.planned ? (
                                            text('计划阶段 · 尚未创建执行任务', 'Planned stage · no execution task yet')
                                        ) : stage.jobId ? (
                                            <button
                                                type="button"
                                                class="acp-link"
                                                onClick={() => navigateAcpTask({ jobId: stage.jobId, full })}
                                            >
                                                {text('查看执行任务', 'Open execution task')}
                                            </button>
                                        ) : (
                                            ''
                                        )}
                                    </small>
                                </div>
                                {stage.stage === 'human_review' && detail.pendingReviewId ? (
                                    <button
                                        type="button"
                                        class="acp-link"
                                        onClick={() => onReview(detail.pendingReviewId!)}
                                    >
                                        <Status value={stage.status} />
                                    </button>
                                ) : (
                                    <Status value={stage.status} />
                                )}
                            </li>
                        ))}
                    </ol>
                </section>
            )}
            <section class="acp-detail-section">
                <h3>{text('执行轮次', 'Execution attempts')}</h3>
                {detail.attempts.length ? (
                    [...detail.attempts].reverse().map((attempt, index) => (
                        <details class="acp-attempt" key={attempt.attemptId} open={index === 0}>
                            <summary>
                                <span>
                                    {attempt.attemptId === detail.currentAttemptId
                                        ? text('当前执行', 'Current attempt')
                                        : text('历史执行', 'Past attempt')}{' '}
                                    · {date(attempt.createdAt || attempt.updatedAt)}
                                </span>
                                <Status value={attempt.executionStatus} />
                            </summary>
                            {attempt.stale && (
                                <p class="acp-stale">
                                    {text(
                                        '此轮状态待核实；历史在途执行不会被隐藏。',
                                        'This attempt needs verification; unresolved prior work remains visible.'
                                    )}
                                </p>
                            )}
                            {attempt.diagnostic && <p class="acp-decision-error">{attempt.diagnostic}</p>}
                            {attempt.attemptId !== detail.currentAttemptId && attempt.result?.resultSummary && (
                                <div class="acp-result-summary">
                                    <Md source={attempt.result.resultSummary} />
                                </div>
                            )}
                        </details>
                    ))
                ) : (
                    <p class="acp-muted">{text('暂无执行记录', 'No execution attempts')}</p>
                )}
            </section>
            <section class="acp-detail-section">
                <h3>{text('直接子任务', 'Direct subtasks')}</h3>
                {detail.children.length ? (
                    detail.children.map(child => (
                        <button
                            type="button"
                            class="acp-child-task"
                            key={child.jobId}
                            onClick={() => navigateAcpTask({ jobId: child.jobId, full })}
                        >
                            <span>
                                {title(child)}
                                <ExecutionCaption execution={child.execution} />
                            </span>
                            <Status value={displayStatus(child)} />
                        </button>
                    ))
                ) : (
                    <p class="acp-muted">{text('当前没有已创建的子任务', 'No subtasks have been created')}</p>
                )}
            </section>
        </Fragment>
    );
}

/** Where and how the task ran: identifiers and routing that help diagnosis but not review. */
function TaskTechnical({ detail }: { detail: AcpTaskDetail }) {
    return (
        <Fragment>
            <section class="acp-detail-section">
                <h3>{text('执行信息', 'Execution details')}</h3>
                <div class="acp-task-facts">
                    <ExecutionFacts execution={detail.execution} />
                </div>
                {[...detail.attempts].reverse().map(attempt => {
                    const identity = executionLabels(attempt.execution, language);
                    return (
                        <details class="acp-attempt" key={attempt.attemptId}>
                            <summary>
                                <span>
                                    {attempt.attemptId === detail.currentAttemptId
                                        ? text('当前执行', 'Current attempt')
                                        : text('历史执行', 'Past attempt')}{' '}
                                    · {attempt.attemptId}
                                </span>
                            </summary>
                            <dl>
                                <dt>{text('任务方式', 'Task mode')}</dt>
                                <dd>{identity.mode}</dd>
                                <dt>{text('角色或预设', 'Role / preset')}</dt>
                                <dd>
                                    <ExecutionRole execution={attempt.execution} />
                                </dd>
                                <dt>{text('执行服务', 'Execution service')}</dt>
                                <dd>
                                    <ExecutionService execution={attempt.execution} />
                                </dd>
                                <ServiceProvenance execution={attempt.execution} />
                                <dt>{text('原始目标 ID', 'Raw target ID')}</dt>
                                <dd>{attempt.execution?.targetId || attempt.targetId || text('未记录', 'Not recorded')}</dd>
                                <dt>{text('更新时间', 'Updated')}</dt>
                                <dd>{date(attempt.updatedAt)}</dd>
                                {attempt.previousAttemptId && (
                                    <Fragment>
                                        <dt>{text('接续执行', 'Continues attempt')}</dt>
                                        <dd>{attempt.previousAttemptId}</dd>
                                    </Fragment>
                                )}
                            </dl>
                        </details>
                    );
                })}
                <details class="acp-context">
                <summary>{text('任务来源', 'Task source')}</summary>
                <dl>
                    <ServiceProvenance execution={detail.execution} />
                    <dt>{text('原始目标 ID', 'Raw target ID')}</dt>
                    <dd>{detail.execution?.targetId || detail.targetId}</dd>
                    {detail.execution?.roleId && (
                        <Fragment>
                            <dt>{text('角色 ID', 'Role ID')}</dt>
                            <dd>{detail.execution.roleId}</dd>
                        </Fragment>
                    )}
                    {detail.execution?.agentPreset && (
                        <Fragment>
                            <dt>{text('记录的预设', 'Recorded preset')}</dt>
                            <dd>{detail.execution.agentPreset}</dd>
                        </Fragment>
                    )}
                    {detail.execution?.connectionId && (
                        <Fragment>
                            <dt>{text('连接 ID', 'Connection ID')}</dt>
                            <dd>{detail.execution.connectionId}</dd>
                        </Fragment>
                    )}
                    {detail.execution?.provider && (
                        <Fragment>
                            <dt>{text('执行后端', 'Execution backend')}</dt>
                            <dd>{detail.execution.provider}</dd>
                        </Fragment>
                    )}
                    <dt>{text('来源会话', 'Origin session')}</dt>
                    <dd>{detail.originSessionId}</dd>
                    <dt>{text('任务账本', 'Ledger source')}</dt>
                    <dd>{detail.sourceId}</dd>
                    {detail.parentAttemptId && (
                        <Fragment>
                            <dt>{text('所属父执行轮次', 'Parent attempt')}</dt>
                            <dd>{detail.parentAttemptId}</dd>
                        </Fragment>
                    )}
                </dl>
            </details>
            </section>
        </Fragment>
    );
}

function TaskReview({
    detail,
    review,
    requestedReviewId,
    onSelect,
    previewing,
    onPreview,
}: {
    detail: AcpTaskDetail;
    review?: AcpReview;
    requestedReviewId?: string;
    onSelect: (id: string) => void;
    previewing?: ArtifactRef;
    onPreview: (artifact: ArtifactRef) => void;
}) {
    const artifactResults: { revision: string; artifacts: ArtifactRef[]; deliveryReady?: boolean }[] = [
        ...(detail.progress?.availableResults || []),
    ];
    for (const result of detail.artifacts || []) {
        if (!artifactResults.some(item => item.revision === result.revision)) {
            artifactResults.push({
                revision: result.revision,
                artifacts: result.artifacts.map(item => (typeof item === 'string' ? { url: item } : (item as ArtifactRef))),
                deliveryReady: detail.executionStatus === 'completed',
            });
        }
    }
    return (
        <Fragment>
            {artifactResults.length > 0 && (
                <section class="acp-detail-section">
                    <h3>{text('已有产物', 'Available artifacts')}</h3>
                    {artifactResults.map(result => (
                        <div key={result.revision} class="acp-artifact-group">
                            <strong>
                                {result.revision} ·{' '}
                                {result.deliveryReady ? text('最终交付', 'Final delivery') : text('制作稿', 'Draft')}
                            </strong>
                            {result.artifacts.map((artifact, index) => (
                                <ArtifactItem
                                    key={`${artifact.url || artifact.path}:${index}`}
                                    jobId={detail.jobId}
                                    artifact={artifact}
                                    active={
                                        !!previewing &&
                                        (previewing.url || previewing.path) === (artifact.url || artifact.path)
                                    }
                                    onPreview={onPreview}
                                />
                            ))}
                        </div>
                    ))}
                </section>
            )}
            {artifactResults.length === 0 && (
                <section class="acp-detail-section">
                    <h3>{text('已有产物', 'Available artifacts')}</h3>
                    <p class="acp-muted">
                        {text(
                            '这个任务还没有登记产物。产物不会从对话内容里推断：智能体需要按任务要求把文件写到指定的任务目录，并登记到产物清单，执行端校验通过后才会显示在这里。',
                            'No artifacts are registered for this task. They are never inferred from the conversation: the agent must write files to the task directory and list them in the artifact manifest, and the executor verifies them before they appear here.'
                        )}
                    </p>
                </section>
            )}
            {detail.reviews.length > 0 ? (
                <Fragment>
                    <div class="acp-review-heading">
                        <h3>{text('阶段产物审核', 'Stage artifact review')}</h3>
                        <label>
                            {text('版本', 'Version')}
                            <select
                                value={review?.reviewId || requestedReviewId || ''}
                                onChange={event => onSelect(event.currentTarget.value)}
                            >
                                {requestedReviewId && !review && (
                                    <option value={requestedReviewId}>
                                        {text('未找到请求的版本', 'Requested version unavailable')}
                                    </option>
                                )}
                                {[...detail.reviews].reverse().map(item => (
                                    <option key={item.reviewId} value={item.reviewId}>
                                        {item.revision} · {statusLabel(item.status)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {review ? (
                        <Fragment>
                            <div class="acp-review-version">
                                <Status value={review.status} />
                                <span>{review.revision}</span>
                                <span>{date(review.createdAt)}</span>
                            </div>
                            <h3>{review.preview.title || review.title}</h3>
                            {review.preview.kind === 'markdown' && (
                                <section class="acp-report-preview">
                                    <p class="acp-muted">{text('报告文件：', 'Report file: ')}<code>{review.preview.reportPath}</code></p>
                                    <ReportPreview markdown={review.preview.markdown || ''} path={review.preview.reportPath} />
                                </section>
                            )}
                            {review.preview.slides.map((slide, index) => (
                                <section key={`${review.reviewId}:${index}`} class="acp-script-slide">
                                    <h4>
                                        <span>{String(index + 1).padStart(2, '0')}</span>
                                        {slide.title}
                                    </h4>
                                    <p class="acp-slide-message">{slide.message}</p>
                                    <ul>
                                        {slide.body.map((paragraph, i) => (
                                            <li key={i}>{paragraph}</li>
                                        ))}
                                    </ul>
                                    {slide.visual && (
                                        <p>
                                            <span class="acp-muted">{text('画面建议：', 'Visual: ')}</span>
                                            {slide.visual}
                                        </p>
                                    )}
                                    {slide.notes && <p>{slide.notes}</p>}
                                    <details class="acp-slide-sources">
                                        <summary>{text('事实与素材依据', 'Facts and sources')}</summary>
                                        {slide.facts.length > 0 && (
                                            <ul>
                                                {slide.facts.map((fact, i) => (
                                                    <li key={i}>{fact}</li>
                                                ))}
                                            </ul>
                                        )}
                                        <ul>
                                            {slide.sources.map((source, i) => (
                                                <li key={i}>
                                                    <code>{source}</code>
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                </section>
                            ))}
                            <details class="acp-context">
                                <summary>{text('审核版本标识', 'Review version reference')}</summary>
                                <dl>
                                    <dt>{text('内容摘要', 'Content digest')}</dt>
                                    <dd>
                                        <code>{review.digest}</code>
                                    </dd>
                                    <dt>{text('作者执行轮次', 'Author attempt')}</dt>
                                    <dd>{review.authorAttemptId || review.attemptId}</dd>
                                </dl>
                            </details>
                        </Fragment>
                    ) : (
                        <p class="acp-decision-error">
                            {text(
                                '找不到链接对应的审核版本，请选择可用版本。',
                                'The linked review version is unavailable. Select an available version.'
                            )}
                        </p>
                    )}
                </Fragment>
            ) : (
                <EmptyState
                    title={text('当前没有阶段审核', 'No stage review')}
                    description={
                        detail.parentJobRef
                            ? text(
                                  '可以返回父任务查看完整交付与审核。',
                                  'Open the parent task to see workflow reviews.'
                              )
                            : text(
                                  '产物形成后，会在这里展示可确认的版本。',
                                  'Reviewable versions appear here once artifacts are ready.'
                              )
                    }
                />
            )}
        </Fragment>
    );
}

function ReviewHistory({ review }: { review: AcpReview }) {
    const labels: Record<AcpReviewAction, string> = {
        comment: text('发表评论', 'Commented'),
        approve: text('通过', 'Approved'),
        changes_requested: text('要求修改', 'Requested changes'),
        cancel: text('放弃任务', 'Abandoned task'),
    };
    return (
        <section class="acp-detail-section">
            <h3>{text('意见与决定', 'Feedback and decisions')}</h3>
            {review.history.length ? (
                review.history.map((event, index) => (
                    <article class="acp-review-event" key={`${event.at}:${index}`}>
                        <header>
                            <strong>{event.actor.displayName || event.actor.id}</strong>
                            <span>{labels[event.action]}</span>
                            <time>{date(event.at)}</time>
                        </header>
                        {event.note && <p>{event.note}</p>}
                    </article>
                ))
            ) : (
                <p class="acp-muted">{text('当前版本尚无意见或决定', 'No feedback or decisions for this version')}</p>
            )}
        </section>
    );
}

function TaskEvents({ detail }: { detail: AcpTaskDetail }) {
    return (
        <section class="acp-detail-section">
            <h3>{text('任务事件', 'Task events')}</h3>
            {detail.events.length ? (
                <ol class="acp-event-list">
                    {[...detail.events].reverse().map(event => (
                        <li key={event.eventId}>
                            <time>{date(event.observedAt)}</time>
                            <div>
                                <strong title={event.type}>{eventLabel(event.type)}</strong>
                                {event.attemptId && (
                                    <small>
                                        {text('执行轮次：', 'Attempt: ')}
                                        {event.attemptId}
                                    </small>
                                )}
                                {event.data !== undefined && (
                                    <details>
                                        <summary>{text('技术详情', 'Technical details')}</summary>
                                        <pre>{JSON.stringify(event.data, null, 2)}</pre>
                                    </details>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
            ) : (
                <p class="acp-muted">{text('暂无任务事件', 'No task events')}</p>
            )}
        </section>
    );
}
