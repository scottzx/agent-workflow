/**
 * The A2A workbench sidebar panel inside the unified `@1agents/acp-service` client face.
 *
 * The page itself is served by the bundled `oneagents-dsh-a2a` host row at `/workbench/ui/`,
 * on the same origin as the DSH Web GUI. We probe `/workbench/ui/api/session` so the sidebar
 * entry appears only when `oneagents-dsh-a2a` is enabled on the host, and hides cleanly when
 * that component row is disabled.
 */
import { createElement as h, useEffect, useRef, useState } from 'react';

export const WORKBENCH_PANEL = 'oneagents-a2a-workbench';

const dictionaries = {
  zh: { workbench: 'A2A 工作台' },
  en: { workbench: 'A2A Workbench' },
};

const approvalsState = { pendingCount: 0, unreadCount: 0, byKind: {} };
const approvalsListeners = new Set();
const kindLabels = { process_request: '过程请求', review: '产物审核', handoff: '交接提议', proposal: '规范提议' };

function publishApprovals(next) {
  approvalsState.pendingCount = Math.max(0, Number(next.pendingCount) || 0);
  approvalsState.unreadCount = Math.max(0, Number(next.unreadCount) || 0);
  approvalsState.byKind = next.byKind && typeof next.byKind === 'object' ? next.byKind : {};
  if (approvalsState.pendingCount === 0) approvalsState.unreadCount = 0;
  for (const listener of approvalsListeners) listener(approvalsState);
}

function approvalsTitle(state) {
  if (!state.pendingCount) return '';
  const parts = Object.entries(state.byKind).filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => `${count} ${kindLabels[kind] || kind}`);
  const fresh = state.unreadCount > 0 ? `（${state.unreadCount} 条新${parts.length ? `：${parts.join('，')}` : ''}）` : (parts.length ? `（${parts.join('，')}）` : '');
  return `A2A 工作台 · ${state.pendingCount} 条待审批${fresh}`;
}

function badgeLabel(count) {
  if (count > 99) return '99+';
  return String(count);
}

function WorkbenchIcon({ size }) {
  const [state, setState] = useState(approvalsState);
  useEffect(() => {
    const listener = next => setState({ ...next, byKind: { ...next.byKind } });
    approvalsListeners.add(listener);
    return () => approvalsListeners.delete(listener);
  }, []);
  const pending = state.pendingCount;
  const title = approvalsTitle(state);
  const badge = pending > 0 ? badgeLabel(pending) : '';
  return h('span', {
    className: `oneagents-a2a-workbench-icon${state.unreadCount > 0 ? ' has-unread' : ''}`,
    title: title || undefined,
    style: { position: 'relative', display: 'inline-flex', width: size, height: size },
  },
  h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { d: 'M9 4v16M13 9h5M13 13h5' })),
  badge ? h('span', {
    'data-approvals-badge': badge,
    'data-unread': state.unreadCount > 0 ? 'true' : 'false',
    style: {
      position: 'absolute', top: -4, right: -6, minWidth: 14, height: 14, padding: '0 3px',
      borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 9, lineHeight: '14px',
      textAlign: 'center', fontWeight: 700,
      boxShadow: state.unreadCount > 0 ? '0 0 0 2px rgba(220,38,38,.45)' : 'none',
      animation: state.unreadCount > 0 ? 'oneagents-a2a-approvals-pulse 1.4s ease-in-out infinite' : 'none',
    },
  }, badge) : null);
}

export function registerWorkbenchPanel(ctx, options = {}) {
  const retryDelays = options.retryDelays ?? [1000, 3000];
  ctx.effect(() => ctx.locale.register('oneagentsA2A', dictionaries));
  const t = ctx.locale.bind('oneagentsA2A');

  function WorkbenchPanel() {
    const frame = useRef(null);
    useEffect(() => {
      const onMessage = event => {
        if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
        const { type, sessionId } = event.data ?? {};
        if (type === '1agents:open-session' && typeof sessionId === 'string' && sessionId) {
          ctx.uiWorkspace?.openSession?.(sessionId);
        }
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);
    return h('iframe', {
      ref: frame, src: '/workbench/ui/', title: t('workbench'),
      style: { display: 'block', width: '100%', height: '100%', border: 0 },
    });
  }

  let disposed = false;
  let controller;
  let retryTimer;
  let pollTimer;
  let pollController;
  let listening = false;
  let disposers = [];

  const onApprovalsMessage = event => {
    if (event.origin !== location.origin) return;
    const data = event.data ?? {};
    if (data.type !== '1agents:approvals-state') return;
    publishApprovals({ pendingCount: data.pendingCount, unreadCount: data.unreadCount, byKind: data.byKind });
  };
  const onVisible = () => { if (typeof document === 'undefined' || !document.hidden) pollApprovals(); };

  const pollApprovals = () => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    pollController?.abort();
    const current = new AbortController();
    pollController = current;
    void fetch('/workbench/ui/api/approvals?summary=1', { credentials: 'same-origin', signal: current.signal }).then(response => {
      if (!response.ok) return null;
      return response.json();
    }).then(body => {
      if (!body || disposed || current.signal.aborted) return;
      const pendingCount = Number(body.totalPending ?? 0) || 0;
      publishApprovals({
        pendingCount,
        unreadCount: pendingCount === 0 ? 0 : approvalsState.unreadCount,
        byKind: body.counts && typeof body.counts === 'object' ? body.counts : {},
      });
    }, () => {});
  };

  const stopApprovals = () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    pollController?.abort();
    if (listening) {
      window.removeEventListener('message', onApprovalsMessage);
      document.removeEventListener?.('visibilitychange', onVisible);
      listening = false;
    }
  };

  const startApprovals = () => {
    if (listening) return;
    listening = true;
    window.addEventListener('message', onApprovalsMessage);
    document.addEventListener?.('visibilitychange', onVisible);
    pollApprovals();
    pollTimer = setInterval(pollApprovals, 10_000);
  };

  const unmount = () => {
    stopApprovals();
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
  };

  const mount = () => {
    if (disposed || disposers.length > 0) return;
    startApprovals();
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORKBENCH_PANEL }, WorkbenchPanel));
    const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: WORKBENCH_PANEL, order: 20, label: () => t('workbench') },
      WorkbenchIcon,
    ));
    disposers = [disposeMain, disposeSidebar];
  };

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const probe = (attempt = 0) => {
    if (disposed) return;
    clearRetry();
    controller?.abort();
    const current = new AbortController();
    controller = current;
    void fetch('/workbench/ui/api/session', { credentials: 'same-origin', signal: current.signal }).then(response => {
      if (disposed || current.signal.aborted) return;
      // Host workbench answers 200 (logged-in owner), 401 (login required), or 403 (non-owner);
      // 404 means the `oneagents-dsh-a2a` row is disabled or did not mount hostWorkbench.
      if (response.status !== 404) {
        mount();
        return;
      }
      unmount();
      if (attempt < retryDelays.length) {
        retryTimer = setTimeout(() => probe(attempt + 1), retryDelays[attempt]);
      }
    }, () => {
      if (disposed || current.signal.aborted) return;
      unmount();
    });
  };

  ctx.on?.('connection/reset', () => probe(0));
  ctx.effect(() => () => {
    disposed = true;
    clearRetry();
    controller?.abort();
    unmount();
  });
  probe(0);
}
