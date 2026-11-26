import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { acpTaskService, loginRequired, session } from './api';
import { countUnread, postApprovalsState } from './approvals-sync';
import { LazyView, preloadProps, Skeleton } from './LazyView';
import { executionLabels, navigateCase, taskDepth } from './model';
import { useChunkedList, useLoadMoreSentinel } from './paging';
import { hashForModule, moduleFromHash, type AcpModule } from './routing';
import { TicketLights } from './TicketLights';
import type { AcpApprovals, AcpTaskFilter, AcpTaskSummary } from './types';
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
const PAGE_SIZE = 20;
const loadApprovals = () => import('./ApprovalsModule');
const loadCases = () => import('./CaseModule');
const loadAgents = () => import('./AgentModule');
const loadTaskDetail = () => import('./TaskDetail');

function TabIcon({ name }: { name: 'approvals' | 'cases' | 'tasks' | 'agents' }) {
    const paths = {
        approvals: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
        cases: 'M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        tasks: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
        agents: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    };
    return (
        <svg class="acp-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={paths[name]} />
        </svg>
    );
}

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
    const explicitModule = moduleFromHash(location.hash);
    const landed = useRef(explicitModule !== undefined);
    // Approvals lead when something is waiting and the page was opened without a hash.
    const [module, setModule] = useState<AcpModule>(explicitModule ?? 'cases');
    const [approvals, setApprovals] = useState<AcpApprovals | null>(null);
    const [seenTick, setSeenTick] = useState(0);
    const [filter, setFilter] = useState<AcpTaskFilter>('all');
    const [counts, setCounts] = useState(emptyCounts);
    const [refreshKey, setRefreshKey] = useState(0);
    const filterRef = useRef(filter);
    filterRef.current = filter;
    const list = useChunkedList<AcpTaskSummary>({
        active: module === 'tasks',
        refreshKey,
        resetKey: filter,
        pageSize: PAGE_SIZE,
        idOf: task => task.jobId,
        fetchPage: async (offset, limit) => {
            const requested = filterRef.current;
            const next = await acpTaskService.list(requested, offset, limit);
            if (filterRef.current === requested) setCounts(next.counts);
            return next;
        },
    });
    const sentinel = useLoadMoreSentinel(module === 'tasks' && list.items.length < list.total, list.items.length, list.loadMore);

    /** A top-level tab is a hash route: clicking it writes the hash, and the hash is what the tab follows. */
    const openModule = useCallback((next: AcpModule) => {
        landed.current = true;
        setModule(next);
        if (moduleFromHash(location.hash) !== next) location.hash = hashForModule(next);
    }, []);

    // The browser's back/forward buttons and external deep links both arrive here; a detail hash keeps its module.
    useEffect(() => {
        const sync = () => {
            const next = moduleFromHash(location.hash);
            if (next) {
                landed.current = true;
                setModule(next);
            }
        };
        window.addEventListener('hashchange', sync);
        return () => window.removeEventListener('hashchange', sync);
    }, []);

    // A task link opened while another module is showing still lands on that task.
    useEffect(() => {
        if (route.jobId) setModule('tasks');
    }, [route.jobId]);

    const publishApprovals = useCallback((view: AcpApprovals) => {
        setApprovals(view);
        postApprovalsState(view.totalPending, countUnread(view.items ?? []), view.counts);
    }, []);

    useEffect(() => {
        let dead = false;
        let stamp = '';
        const tick = async () => {
            if (document.hidden) return;
            try {
                const summary = await acpTaskService.approvals(true);
                if (dead) return;
                const nextStamp = `${summary.totalPending}:${summary.latestCreatedAt ?? ''}`;
                if (nextStamp !== stamp) {
                    stamp = nextStamp;
                    const full = await acpTaskService.approvals(false);
                    if (!dead) publishApprovals(full);
                } else {
                    setApprovals(current => {
                        const view = { ...(current ?? summary), totalPending: summary.totalPending, counts: summary.counts, latestCreatedAt: summary.latestCreatedAt, items: current?.items ?? [] };
                        postApprovalsState(view.totalPending, countUnread(view.items ?? []), view.counts);
                        return view;
                    });
                }
                if (!landed.current) {
                    landed.current = true;
                    const bare = !location.hash || location.hash === '#';
                    if (summary.totalPending > 0 && bare) setModule('approvals');
                }
            } catch { /* The tab badge waits for the next tick. */ }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), 8000);
        const onVisible = () => { if (!document.hidden) void tick(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { dead = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, [publishApprovals, refreshKey]);

    useEffect(() => {
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && route.jobId) navigateAcpTask({ full: false });
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [route.jobId]);

    const rows = [...list.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const loading = module === 'tasks' && list.loading;
    const error = list.error;
    const open = (task: AcpTaskSummary, reviewId?: string) => navigateAcpTask({ jobId: task.jobId, reviewId, full: false });

    return (
        <section class={`acp-workbench${route.jobId ? ' has-detail' : ''}${route.full ? ' is-full-detail' : ''}`}>
            <header class="acp-workbench-header">
                <div class="acp-workbench-title">
                    <h1>{text('任务工作台', 'Task workbench')}</h1>
                    <nav class="acp-module-switch" aria-label={text('工作台模块', 'Workbench modules')}>
                        <button type="button" aria-pressed={module === 'approvals'} {...preloadProps('module:approvals', loadApprovals)} onClick={() => openModule('approvals')}>
                            <TabIcon name="approvals" />
                            <span>{text('待审批', 'Approvals')}</span>
                            {!!approvals?.totalPending && <span class="acp-tab-count">{approvals.totalPending}</span>}
                        </button>
                        <button type="button" aria-pressed={module === 'cases'} {...preloadProps('module:cases', loadCases)} onClick={() => openModule('cases')}>
                            <TabIcon name="cases" />
                            <span>{text('事情', 'Cases')}</span>
                        </button>
                        <button type="button" aria-pressed={module === 'tasks'} {...preloadProps('module:task-detail', loadTaskDetail)} onClick={() => openModule('tasks')}>
                            <TabIcon name="tasks" />
                            <span>{text('任务', 'Tasks')}</span>
                        </button>
                        <button
                            type="button"
                            aria-pressed={module === 'agents'}
                            {...preloadProps('module:agents', loadAgents)}
                            onClick={() => openModule('agents')}
                        >
                            <TabIcon name="agents" />
                            <span>{text('智能体', 'Agents')}</span>
                        </button>
                    </nav>
                </div>
                <div class="acp-header-actions">
                    <span
                        class="acp-source"
                        title={text('数据来源：本机 A2A 网关账本。', 'Source: this A2A gateway ledger.')}
                        aria-label={text('数据来源：本机 A2A 网关账本。', 'Source: this A2A gateway ledger.')}
                    >
                        <span class="acp-source-dot" aria-hidden="true" />
                        <span class="acp-source-label">{text('本机账本', 'Local ledger')}</span>
                    </span>
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
            {module === 'approvals' ? (
                <LazyView cacheKey="module:approvals" load={loadApprovals} lines={8}>
                    {mod => (
                        <mod.ApprovalsModule
                            view={approvals}
                            seenTick={seenTick}
                            onReload={() => setRefreshKey(key => key + 1)}
                            onViewed={() => {
                                setSeenTick(tick => tick + 1);
                                if (approvals) postApprovalsState(approvals.totalPending, countUnread(approvals.items ?? []), approvals.counts);
                            }}
                            onOpenTask={(jobId, reviewId) => {
                                landed.current = true;
                                setModule('tasks');
                                navigateAcpTask({ jobId, reviewId, full: false });
                            }}
                            onOpenCase={(caseId, originSessionId) => {
                                landed.current = true;
                                setModule('cases');
                                navigateCase(caseId, originSessionId);
                            }}
                        />
                    )}
                </LazyView>
            ) : module === 'agents' ? (
                <LazyView cacheKey="module:agents" load={loadAgents} lines={8}>
                    {mod => (
                        <mod.AgentModule
                            refreshKey={refreshKey}
                            onOpenTask={jobId => {
                                setModule('tasks');
                                navigateAcpTask({ jobId, full: false });
                            }}
                        />
                    )}
                </LazyView>
            ) : module === 'cases' ? (
                <LazyView cacheKey="module:cases" load={loadCases} lines={8}>
                    {mod => <mod.CaseModule refreshKey={refreshKey} />}
                </LazyView>
            ) : (
                <>
                    <nav class="acp-workbench-views" aria-label={text('任务视图', 'Task views')}>
                        {filters.map(view => (
                            <button
                                key={view}
                                type="button"
                                aria-pressed={filter === view}
                                onClick={() => setFilter(view)}
                            >
                                {
                                    {
                                        all: text('全部任务', 'All tasks'),
                                        pending: text('待我确认', 'My reviews'),
                                        working: text('进行中', 'Working'),
                                        failed: text('异常', 'Needs attention'),
                                    }[view]
                                }
                                {(list.items.length > 0 || list.total > 0 || !list.loading) && module === 'tasks' && <span class="acp-nums">{counts[view]}</span>}
                            </button>
                        ))}
                    </nav>
                    <div class="acp-workbench-body">
                        <div class="acp-workbench-table">
                            {!list.settled && !error && <Skeleton lines={7} />}
                            {error && (
                                <ErrorState
                                    title={text('任务读取失败', 'Could not load tasks')}
                                    message={error}
                                    onRetry={() => setRefreshKey(key => key + 1)}
                                />
                            )}
                            <table class="acp-desktop-only">
                                <thead>
                                    <tr>
                                        <th>{text('任务名称', 'Task')}</th>
                                        <th>{text('任务性质', 'Kind')}</th>
                                        <th>{text('执行状态', 'Status')}</th>
                                        <th>{text('任务方式', 'Mode')}</th>
                                        <th>{text('执行角色与服务', 'Role and service')}</th>
                                        <th>{text('当前阶段', 'Phase')}</th>
                                        <th>{text('待办与卡点', 'Action / blocker')}</th>
                                        <th>{text('最近进展', 'Last updated')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {list.settled && !rows.length && (
                                        <tr>
                                            <td colSpan={8} class="acp-muted">
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
                                                        {...preloadProps('module:task-detail', loadTaskDetail)}
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
                                                <TicketLights summary={task.ticketSummary} />
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
                                                <span class="acp-execution-cell">
                                                    <ExecutionRole execution={task.execution} />
                                                    <ExecutionService execution={task.execution} />
                                                </span>
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
                                            <td class="acp-task-updated acp-nums">{date(task.updatedAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div class="acp-mobile-cards">
                                {list.settled && !rows.length && (
                                    <p class="acp-muted">
                                        {filter === 'all'
                                            ? text('当前没有 ACP 执行任务', 'No ACP execution tasks yet')
                                            : text('当前视图没有匹配的任务', 'No tasks in this view')}
                                    </p>
                                )}
                                {rows.map(task => (
                                    <button
                                        key={task.jobId}
                                        type="button"
                                        class={`acp-mobile-card is-${taskStatus(task).replace(/[^a-z_]/gi, '')}${route.jobId === task.jobId ? ' is-selected' : ''}`}
                                        onClick={() => open(task, filter === 'pending' ? task.pendingReviewId : undefined)}
                                        {...preloadProps('module:task-detail', loadTaskDetail)}
                                    >
                                        <span class="acp-mobile-card-head">
                                            <strong>{title(task)}</strong>
                                            <Status value={taskStatus(task)} />
                                        </span>
                                        <span class="acp-mobile-card-meta">
                                            <span class="acp-mode-label">{channelLabel(task.channel)}</span>
                                            <span class="acp-mode-label">{executionLabels(task.execution, language).mode}</span>
                                            <TicketLights summary={task.ticketSummary} />
                                        </span>
                                        <span class="acp-task-blocker">
                                            {task.pendingReviewId
                                                ? text('查看并确认', 'Review content')
                                                : task.pendingProcessRequestId
                                                  ? text('回答过程请求', 'Answer request')
                                                  : progressExcerpt(task.progressSummary)}
                                        </span>
                                        <time class="acp-task-updated acp-nums">{date(task.updatedAt)}</time>
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
                        {route.jobId && (
                            <LazyView key={route.jobId} cacheKey="module:task-detail" load={loadTaskDetail} lines={8}>
                                {mod => (
                                    <mod.AcpTaskDetailPanel
                                        jobId={route.jobId!}
                                        requestedReviewId={route.reviewId}
                                        full={route.full}
                                        onChanged={() => setRefreshKey(key => key + 1)}
                                    />
                                )}
                            </LazyView>
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
