/**
 * The A2A workbench sidebar panel.
 *
 * The page itself is served by this plugin's host half at `/workbench/ui/`, on the
 * same origin as the DSH Web GUI, so the panel embeds it with a relative iframe.
 * The page asks the host to open a session by posting `1agents:open-session`.
 */
import { createElement as h, useEffect, useRef } from 'react';

export const inject = ['slots', 'locale', 'uiWorkspace'];

const WORKBENCH_PANEL = 'oneagents-a2a-workbench';

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

export function apply(ctx) {
  // Same locale contract as the ACP client: register a namespace, then bind it.
  ctx.effect(() => ctx.locale.register('oneagentsA2A', dictionaries));
  const t = ctx.locale.bind('oneagentsA2A');

  // The gateway task workbench, served same-origin by this plugin's host half;
  // its take-over button asks to open a session here.
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

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORKBENCH_PANEL }, WorkbenchPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: WORKBENCH_PANEL, order: 20, label: () => t('workbench') },
    WorkbenchIcon,
  ));
}
