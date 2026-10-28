import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { acpTaskService, loginRequired, session } from './api';
import { AgentModule } from './AgentModule';
import { executionLabels, taskDepth } from './model';
import { AcpTaskDetailPanel } from './TaskDetail';
import type { AcpTaskFilter, AcpTaskList, AcpTaskSummary } from './types';
import {
    channelLabel,
    date,
    ErrorState,
    errorText,
    ExecutionRole,
    ExecutionService,
    language,
    navigateAcpTask,
    phaseLabel,
    progressExcerpt,
    Status,
    taskStatus,
    text,
    title,
    useRoute,
} from './ui';

const filters: AcpTaskFilter[] = ['all', 'pending', 'working', 'failed'];
const emptyCounts = { all: 0, pending: 0, working: 0, failed: 0 };
const PAGE_SIZE = 100;

function Login({ onDone }: { onDone: () => void }) {
    const [token, setToken] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <form
            class="acp-login"
            onSubmit={event => {
                event.preventDefault();
                setBusy(true);
                setError('');
                session
                    .login(token.trim())
                    .then(() => onDone())
                    .catch(err => setError(errorText(err)))
                    .finally(() => setBusy(false));
            }}
        >
            <h1>{text('任务工作台', 'Task workbench')}</h1>
            <p class="acp-muted">
                {text(
                    '输入 A2A 网关配置里的 workbench.token。登录只在本机这个网关上有效，12 小时后需要重新登录。',
                    'Enter workbench.token from the A2A gateway config. The login is valid on this gateway for 12 hours.'
                )}
            </p>
            <label>
                {text('工作台令牌', 'Workbench token')}
                <input type="password" autoComplete="current-password" value={token} onInput={event => setToken(event.currentTarget.value)} />
            </label>
            {error && <p class="acp-decision-error" role="alert">{error}</p>}
            <button type="submit" class="acp-button acp-primary" disabled={busy || !token.trim()}>
                {text('登录', 'Sign in')}
            </button>
        </form>
    );
}

/** The table and detail read one ACP projection; neither writes task states. */
function Workbench({ onLogout }: { onLogout?: () => void }) {
    const route = useRoute();
    const [module, setModule] = useState<'tasks' | 'agents'>('tasks');
    const [filter, setFilter] = useState<AcpTaskFilter>('all');
    const [offset, setOffset] = useState(0);
    const [payload, setPayload] = useState<AcpTaskList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);
    const generation = useRef(0);
    const activeRequest = useRef(false);

    useEffect(() => {
        const gen = ++generation.current;
        let disposed = false;
        activeRequest.current = false;
        setLoading(true);
        const load = async () => {
            if (activeRequest.current || document.hidden) return;
            activeRequest.current = true;
            try {
                const next = await acpTaskService.list(filter, offset, PAGE_SIZE);
                if (!disposed && gen === generation.current) {
                    setPayload(next);
                    setError('');
                }
            } catch (err) {
                if (!disposed && gen === generation.current) setError(errorText(err));
            } finally {
                if (!disposed && gen === generation.current) {
                    setLoading(false);
                    activeRequest.current = false;
                }
            }
        };
        void load();
        const interval = window.setInterval(() => void load(), 5000);
        return () => {
            disposed = true;
            window.clearInterval(interval);
        };
    }, [filter, offset, refreshKey]);

    // A task link opened while the agents module is showing still lands on that task.
    useEffect(() => {
        if (route.jobId) setModule('tasks');
    }, [route.jobId]);

    useEffect(() => {
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && route.jobId) navigateAcpTask({ full: false });
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [route.jobId]);

    const rows = [...(payload?.items || [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts = payload?.counts || emptyCounts;
    const open = (task: AcpTaskSummary, reviewId?: string) => navigateAcpTask({ jobId: task.jobId, reviewId, full: false });

    return (
        <section class={`acp-workbench${route.jobId ? ' has-detail' : ''}${route.full ? ' is-full-detail' : ''}`}>
            <header class="acp-workbench-header">
                <div class="acp-workbench-title">
                    <h1>{text('任务工作台', 'Task workbench')}</h1>
                    <nav class="acp-module-switch" aria-label={text('工作台模块', 'Workbench modules')}>
                        <button type="button" aria-pressed={module === 'tasks'} onClick={() => setModule('tasks')}>
                            {text('任务', 'Tasks')}
                        </button>
                        <button
                            type="button"
                            aria-pressed={module === 'agents'}
                            onClick={() => {
                                setModule('agents');
                                if (route.jobId) navigateAcpTask({ full: false });
                            }}
                        >
                            {text('智能体', 'Agents')}
                        </button>
                    </nav>
                </div>
                <div class="acp-header-actions">
                    <button type="button" class="acp-button" onClick={() => setRefreshKey(key => key + 1)} disabled={loading}>
                        {text('刷新', 'Refresh')}
                    </button>
                    {onLogout && (
                        <button type="button" class="acp-button" onClick={onLogout}>
                            {text('退出登录', 'Sign out')}
                        </button>
                    )}
                </div>
            </header>
            <p class="acp-workbench-source">
                {text('数据来源：本机 A2A 网关账本。', 'Source: this A2A gateway ledger.')}
            </p>
            {module === 'agents' ? (
                <AgentModule
                    refreshKey={refreshKey}
                    onOpenTask={jobId => {
                        setModule('tasks');
                        navigateAcpTask({ jobId, full: false });
                    }}
                />
            ) : (
                <>
                    <nav class="acp-workbench-views" aria-label={text('任务视图', 'Task views')}>
                        {filters.map(view => (
                            <button
                                key={view}
                                type="button"
                                aria-pressed={filter === view}
                                onClick={() => {
                                    setFilter(view);
                                    setOffset(0);
                                }}
                            >
                                {
                                    {
                                        all: text('全部任务', 'All tasks'),
                                        pending: text('待我确认', 'My reviews'),
                                        working: text('进行中', 'Working'),
                                        failed: text('异常', 'Needs attention'),
                                    }[view]
                                }
                                {payload && <span>{counts[view]}</span>}
                            </button>
                        ))}
                    </nav>
                    <div class="acp-workbench-body">
                        <div class="acp-workbench-table">
                            {error && (
                                <ErrorState
                                    title={text('任务读取失败', 'Could not load tasks')}
                                    message={error}
                                    onRetry={() => setRefreshKey(key => key + 1)}
                                />
                            )}
                            <table>
                                <thead>
                                    <tr>
                                        <th>{text('任务名称', 'Task')}</th>
                                        <th>{text('任务性质', 'Task kind')}</th>
                                        <th>{text('执行状态', 'Status')}</th>
                                        <th>{text('任务方式', 'Task mode')}</th>
                                        <th>{text('角色或预设', 'Role / preset')}</th>
                                        <th>{text('执行服务', 'Execution service')}</th>
                                        <th>{text('当前阶段', 'Phase')}</th>
                                        <th>{text('待办与卡点', 'Action / blocker')}</th>
                                        <th>{text('最近进展', 'Last updated')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {!loading && !rows.length && (
                                        <tr>
                                            <td colSpan={9} class="acp-muted">
                                                {filter === 'all'
                                                    ? text('当前没有 ACP 执行任务', 'No ACP execution tasks yet')
                                                    : text('当前视图没有匹配的任务', 'No tasks in this view')}
                                            </td>
                                        </tr>
                                    )}
                                    {rows.map(task => (
                                        <tr key={task.jobId} class={`acp-task-row${route.jobId === task.jobId ? ' is-selected' : ''}`}>
                                            <td>
                                                <div class="acp-task-name" style={{ paddingLeft: `${Math.min(taskDepth(task, rows), 6) * 16}px` }}>
                                                    <button
                                                        type="button"
                                                        class="acp-link acp-name-link"
                                                        title={title(task)}
                                                        onClick={() => open(task, filter === 'pending' ? task.pendingReviewId : undefined)}
                                                    >
                                                        <span class="acp-title-text">{title(task)}</span>
                                                        <small title={task.jobId}>
                                                            {task.jobId.length > 12 ? `${task.jobId.slice(0, 8)}…` : task.jobId}
                                                        </small>
                                                    </button>
                                                </div>
                                            </td>
                                            <td>
                                                <span class="acp-mode-label">{channelLabel(task.channel)}</span>
                                                {task.agentName && <small class="acp-cell-note">{task.agentName}</small>}
                                            </td>
                                            <td>
                                                <Status value={taskStatus(task)} />
                                                {!!task.unresolvedAttemptIds?.length && (
                                                    <small class="acp-stale">{text('有待核实的历史执行', 'Prior execution needs verification')}</small>
                                                )}
                                                {task.stale && <small class="acp-stale">{text('状态待同步', 'Awaiting sync')}</small>}
                                            </td>
                                            <td>
                                                <span class="acp-mode-label">{executionLabels(task.execution, language).mode}</span>
                                            </td>
                                            <td>
                                                <ExecutionRole execution={task.execution} />
                                            </td>
                                            <td>
                                                <ExecutionService execution={task.execution} />
                                            </td>
                                            <td>{phaseLabel(task.phase || '') || '—'}</td>
                                            <td>
                                                {task.pendingReviewId && (
                                                    <button type="button" class="acp-link" onClick={() => open(task, task.pendingReviewId)}>
                                                        {text('查看并确认', 'Review content')}
                                                    </button>
                                                )}
                                                {task.pendingProcessRequestId && (
                                                    <button type="button" class="acp-link" onClick={() => open(task)}>
                                                        {text('回答过程请求', 'Answer request')}
                                                    </button>
                                                )}
                                                {!task.pendingReviewId && !task.pendingProcessRequestId && (
                                                    <span class="acp-task-blocker" title={task.progressSummary}>
                                                        {progressExcerpt(task.progressSummary)}
                                                    </span>
                                                )}
                                            </td>
                                            <td class="acp-task-updated">{date(task.updatedAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {payload && (
                                <div class="acp-pagination">
                                    <span>{text(`${payload.total} 条任务记录`, `${payload.total} task records`)}</span>
                                    <button
                                        type="button"
                                        class="acp-button"
                                        disabled={offset === 0 || loading}
                                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                    >
                                        {text('上一页', 'Previous')}
                                    </button>
                                    <button
                                        type="button"
                                        class="acp-button"
                                        disabled={offset + rows.length >= payload.total || loading}
                                        onClick={() => setOffset(offset + PAGE_SIZE)}
                                    >
                                        {text('下一页', 'Next')}
                                    </button>
                                </div>
                            )}
                        </div>
                        {route.jobId && (
                            <AcpTaskDetailPanel
                                key={route.jobId}
                                jobId={route.jobId}
                                requestedReviewId={route.reviewId}
                                full={route.full}
                                onChanged={() => setRefreshKey(key => key + 1)}
                            />
                        )}
                    </div>
                </>
            )}
        </section>
    );
}

function App() {
    const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
    const [canSignOut, setCanSignOut] = useState(true);
    useEffect(() => {
        session
            .status()
            .then(result => {
                setCanSignOut(result.loginRequired !== false);
                setState(result.authenticated ? 'ready' : 'login');
            })
            .catch(() => setState('login'));
        const expired = () => setState('login');
        loginRequired.addEventListener('required', expired);
        return () => loginRequired.removeEventListener('required', expired);
    }, []);
    if (state === 'checking') return <p class="acp-muted acp-boot">{text('正在连接网关…', 'Connecting to the gateway…')}</p>;
    if (state === 'login') return <Login onDone={() => setState('ready')} />;
    return <Workbench onLogout={canSignOut ? () => void session.logout().finally(() => setState('login')) : undefined} />;
}

render(<App />, document.getElementById('app')!);
