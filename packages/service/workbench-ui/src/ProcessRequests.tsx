import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { acpTaskService, AcpTaskApiError } from './api';
import type { AcpProcessQuestion, AcpProcessRequest } from './types';
import { Md } from './Preview';
import { text } from './ui';

const statusLabel = (status: string) =>
    ({
        pending: text('待回答', 'Waiting'),
        answered: text('已回答', 'Answered'),
        cancelled: text('已取消', 'Cancelled'),
        expired: text('已过期', 'Expired'),
    })[status] || status;

function answerError(error: unknown): string {
    if (error instanceof AcpTaskApiError) {
        if (error.code === 'expired') return text('这则过程请求已经过期', 'This process request has expired');
        if (error.code === 'already_decided') return text('这则过程请求已经处理过', 'This process request was already handled');
        if (error.code === 'idempotency_conflict') return text('这次提交和上次记录不一致', 'This submit does not match the recorded answer');
    }
    return error instanceof Error ? error.message : String(error);
}

function QuestionFields({
    question,
    value,
    onChange,
}: {
    question: AcpProcessQuestion;
    value: string | string[] | undefined;
    onChange: (next: string | string[]) => void;
}) {
    if (question.options?.length && question.multiSelect) {
        const selected = Array.isArray(value) ? value : [];
        return (
            <div>
                {question.options.map(option => (
                    <label key={option.label}>
                        <input
                            type="checkbox"
                            checked={selected.includes(option.label)}
                            onChange={event => {
                                const next = new Set(selected);
                                if (event.currentTarget.checked) next.add(option.label);
                                else next.delete(option.label);
                                onChange([...next]);
                            }}
                        />
                        {option.label}
                        {option.description && <small>{option.description}</small>}
                    </label>
                ))}
            </div>
        );
    }
    if (question.options?.length) {
        return (
            <div>
                {question.options.map(option => (
                    <label key={option.label}>
                        <input
                            type="radio"
                            name={question.id}
                            checked={value === option.label}
                            onChange={() => onChange(option.label)}
                        />
                        {option.label}
                        {option.description && <small>{option.description}</small>}
                    </label>
                ))}
            </div>
        );
    }
    return (
        <textarea value={typeof value === 'string' ? value : ''} onInput={event => onChange(event.currentTarget.value)} />
    );
}

/** Completes the stored process request. It does not send another task message. */
export function ProcessRequestPanel({
    jobId,
    requests,
    onReload,
}: {
    jobId: string;
    requests?: AcpProcessRequest[];
    onReload: () => void;
}) {
    const items = requests ?? [];
    const [answers, setAnswers] = useState<Record<string, Record<string, string | string[]>>>({});
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [busyId, setBusyId] = useState('');
    const [error, setError] = useState('');
    const requestIds = useRef<Record<string, string>>({});
    if (!items.length) return null;
    const clientRequestId = (requestId: string) => {
        requestIds.current[requestId] ??= crypto.randomUUID();
        return requestIds.current[requestId];
    };
    const submit = async (
        request: AcpProcessRequest,
        outcome: 'accepted' | 'cancelled' | 'approved' | 'rejected' | 'abandoned',
        withAnswers: boolean,
        stopTask = false
    ) => {
        const note = outcome === 'rejected' ? notes[request.requestId]?.trim() : '';
        setBusyId(request.requestId);
        setError('');
        try {
            await acpTaskService.answerProcessRequest(jobId, request.requestId, {
                clientRequestId: clientRequestId(request.requestId),
                outcome,
                ...(withAnswers ? { answers: answers[request.requestId] ?? {} } : {}),
                ...(note ? { note } : {}),
                ...(stopTask ? { stopTask: true as const } : {}),
            });
            onReload();
        } catch (err) {
            setError(answerError(err));
        } finally {
            setBusyId('');
        }
    };
    return (
        <section class="acp-detail-section">
            <h3>{text('过程请求', 'Process requests')}</h3>
            {error && <p class="acp-muted">{error}</p>}
            {items.map(request => {
                const ready =
                    request.kind !== 'question' ||
                    (request.questions ?? []).every(question => {
                        const value = answers[request.requestId]?.[question.question];
                        return Array.isArray(value) ? value.length > 0 : Boolean(value && value.trim());
                    });
                return (
                    <article key={request.requestId} class="acp-process-request">
                        <strong>
                            {request.kind === 'plan'
                                ? text('计划审批', 'Plan approval')
                                : request.kind === 'permission'
                                  ? text('工具审批', 'Tool approval')
                                  : text('提问', 'Question')}
                        </strong>
                        <small>
                            {text('截止', 'Deadline')} {new Date(request.deadlineAt).toLocaleString()}
                        </small>
                        {request.planContent && <Md source={request.planContent} />}
                        {request.kind === 'permission' && (
                            <>
                                <p>{request.toolTitle}</p>
                                {request.toolDetail && <pre class="acp-tool-detail">{request.toolDetail}</pre>}
                            </>
                        )}
                        {request.questions?.map(question => (
                            <Fragment key={question.id}>
                                <p>
                                    {question.header ? `${question.header} · ` : ''}
                                    {question.question}
                                </p>
                                {request.canAnswer && (
                                    <QuestionFields
                                        question={question}
                                        value={answers[request.requestId]?.[question.question]}
                                        onChange={next =>
                                            setAnswers(current => ({
                                                ...current,
                                                [request.requestId]: { ...current[request.requestId], [question.question]: next },
                                            }))
                                        }
                                    />
                                )}
                            </Fragment>
                        ))}
                        {request.canAnswer && request.kind === 'question' && (
                            <div class="acp-agent-actions">
                                <button
                                    type="button"
                                    class="acp-button"
                                    disabled={busyId === request.requestId || !ready}
                                    onClick={() => void submit(request, 'accepted', true)}
                                >
                                    {text('提交回答', 'Submit answer')}
                                </button>
                                <button
                                    type="button"
                                    class="acp-button"
                                    disabled={busyId === request.requestId}
                                    onClick={() => void submit(request, 'cancelled', false)}
                                >
                                    {text('取消这次提问', 'Cancel question')}
                                </button>
                            </div>
                        )}
                        {request.canAnswer && request.kind !== 'question' && (
                            <textarea
                                class="acp-reject-note"
                                maxLength={2000}
                                placeholder={text('拒绝理由（可选）', 'Reason for rejecting (optional)')}
                                value={notes[request.requestId] ?? ''}
                                onInput={event => {
                                    const next = event.currentTarget.value;
                                    setNotes(current => ({ ...current, [request.requestId]: next }));
                                }}
                            />
                        )}
                        {request.canAnswer && request.kind === 'plan' && (
                            <div class="acp-agent-actions">
                                <button type="button" class="acp-button" disabled={busyId === request.requestId} onClick={() => void submit(request, 'approved', false)}>
                                    {text('批准计划', 'Approve plan')}
                                </button>
                                <button type="button" class="acp-button" disabled={busyId === request.requestId} onClick={() => void submit(request, 'rejected', false)}>
                                    {text('退回计划', 'Reject plan')}
                                </button>
                                <button type="button" class="acp-button" disabled={busyId === request.requestId} onClick={() => void submit(request, 'abandoned', false)}>
                                    {text('放弃', 'Abandon')}
                                </button>
                            </div>
                        )}
                        {request.canAnswer && request.kind === 'permission' && (
                            <div class="acp-agent-actions">
                                <button type="button" class="acp-button acp-primary" disabled={busyId === request.requestId} onClick={() => void submit(request, 'approved', false)}>
                                    {text('允许本次', 'Allow once')}
                                </button>
                                <button type="button" class="acp-button" disabled={busyId === request.requestId} onClick={() => void submit(request, 'rejected', false)}>
                                    {text('拒绝这次调用', 'Reject this call')}
                                </button>
                                <button
                                    type="button"
                                    class="acp-button acp-danger"
                                    title={text('拒绝并取消整个任务，Agent 不会再换方式重试', 'Reject and cancel the task so the agent cannot retry another way')}
                                    disabled={busyId === request.requestId}
                                    onClick={() => void submit(request, 'rejected', false, true)}
                                >
                                    {text('拒绝并停止任务', 'Reject and stop task')}
                                </button>
                                <button type="button" class="acp-button" disabled={busyId === request.requestId} onClick={() => void submit(request, 'cancelled', false)}>
                                    {text('取消', 'Cancel')}
                                </button>
                            </div>
                        )}
                        {!request.canAnswer && (
                            <small>
                                {statusLabel(request.status)}
                                {request.kind === 'permission' && request.answer?.outcome === 'approved' && ` · ${text('已允许', 'Allowed')}`}
                                {request.kind === 'permission' && request.answer?.outcome === 'rejected' &&
                                    ` · ${request.answer.stopTask ? text('已拒绝并停止任务', 'Rejected and stopped the task') : text('已拒绝', 'Rejected')}`}
                                {request.answer?.note && ` · ${request.answer.note}`}
                            </small>
                        )}
                    </article>
                );
            })}
        </section>
    );
}
