/**
 * The A2A workbench sidebar panel inside the unified `@1agents/acp-service` client face.
 *
 * The page itself is served by the bundled `oneagents-dsh-a2a` host row at `/workbench/ui/`,
 * on the same origin as the DSH Web GUI. We probe `/workbench/ui/api/session` so the sidebar
 * entry appears only when `oneagents-dsh-a2a` is enabled on the host, and hides cleanly when
 * that component row is disabled.
 */
import { createElement as h, useEffect, useRef } from 'react';

export const WORKBENCH_PANEL = 'oneagents-a2a-workbench';

const dictionaries = {
  zh: { workbench: 'A2A 工作台' },
  en: { workbench: 'A2A Workbench' },
};

function WorkbenchIcon({ size }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
  h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { d: 'M9 4v16M13 9h5M13 13h5' }));
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
  let disposers = [];

  const unmount = () => {
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
  };

  const mount = () => {
    if (disposed || disposers.length > 0) return;
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
