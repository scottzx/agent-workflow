/** Browser controls for native ACP configuration and ordinary DSH models. */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toolConversationDefinition } from './tool-conversation.js';
import { installTranscriptView } from './transcript-view.js';

export const inject = ['slots', 'sessions', 'commandUi', 'remote', 'remote.session', 'locale', 'uiConversation', 'conversation', 'uiWorkspace'];
const WORKBENCH_PANEL = 'oneagents-a2a-workbench';

const dictionaries = {
  zh: { toolGroup: '已调用 {count} 个工具', model: '模型', choose: '选择模型', loading: '正在连接 Agent…', loadingModels: '正在加载模型…', retry: '重试', mode: '模式', command: 'Agent 指令', effort: '思考强度', unsupported: 'Agent 未提供可切换的模型', description: '选择当前 Agent 的模型', error: '连接失败', noCommands: 'Agent 尚未提供指令', native: 'ACP 设置', activeWriter: '原会话正在其他客户端运行，可查看历史；占用解除后自动恢复输入。', workbench: 'A2A 工作台', a2aRunning: 'A2A 任务正在此会话执行，结束后可人工接管。' },
  en: { toolGroup: '{count} tool calls', model: 'Model', choose: 'Select model', loading: 'Connecting to Agent…', loadingModels: 'Loading models…', retry: 'Retry', mode: 'Mode', command: 'Agent commands', effort: 'Reasoning effort', unsupported: 'This Agent does not advertise model selection', description: 'Select this Agent’s model', error: 'Connection failed', noCommands: 'No commands advertised', native: 'ACP settings', activeWriter: 'The original session is running in another client. History is available; input resumes when it is released.', workbench: 'A2A Workbench', a2aRunning: 'An A2A task is running in this session; you can take over once it ends.' },
};

/** Preserve Agent-owned group labels and option ids. */
export function choices(option) {
  return (option.options ?? []).flatMap(item => 'group' in item
    ? item.options.map(value => ({ ...value, group: item.name ?? item.group }))
    : [item]);
}

async function acpRequest(sessionId, change, signal) {
  const response = await fetch(`/api/1agents-acp/session?id=${encodeURIComponent(sessionId)}`, {
    ...(change ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) } : {}),
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

const selectStyle = { maxWidth: 210, minHeight: 30, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1, #8885)', color: 'inherit', background: 'var(--dsw-alias-bg-base, transparent)', padding: '3px 7px', fontSize: 12 };

function Select({ title, value, rows, disabled, onSelect, placeholder }) {
  return h('label', { style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12 } },
    h('span', null, title),
    h('select', { 'aria-label': title, style: selectStyle, value: value ?? '', disabled, onChange: e => onSelect(e.target.value) },
      h('option', { value: '', disabled: true }, placeholder || title),
      rows.map(row => h('option', { key: row.value, value: row.value, title: row.description }, `${row.group ? `${row.group} · ` : ''}${row.name}`))));
}

export function apply(ctx) {
  ctx.uiConversation.events.register(toolConversationDefinition);
  installTranscriptView(ctx);
  ctx.effect(() => ctx.locale.register('oneagentsAcp', dictionaries));
  const t = ctx.locale.bind('oneagentsAcp');
  const native = new Map();
  const pending = new Map();
  const listeners = new Map();
  const blockedSessions = new Set();
  const revisions = new Map();
  const selectedPresets = new Map();
  let disposed = false;
  const revisionOf = id => revisions.get(id) ?? 0;
  const presetOf = id => {
    const projected = ctx.sessions.binding(id)?.session.projections.faceOf('agentPreset').getSnapshot();
    const selected = selectedPresets.get(id);
    if (selected === undefined) return projected;
    // The selection event and the projection arrive on separate streams.
    if (projected === selected) selectedPresets.delete(id);
    return selected;
  };
  const isAcp = id => String(presetOf(id) ?? '').startsWith('oneagents-acp-');
  // One composer block per session: an ACP connection reason wins over a running A2A turn.
  const acpBlocks = new Map();
  const a2aBlocks = new Map();
  const applyBlock = id => {
    const reason = acpBlocks.get(id) ?? a2aBlocks.get(id);
    if (reason) blockedSessions.add(id); else blockedSessions.delete(id);
    ctx.conversation.blocks.set(id, reason ? { reason } : undefined);
  };
  const block = (id, reason) => {
    if (disposed || (!reason && !blockedSessions.has(id))) return;
    if (reason) acpBlocks.set(id, reason); else acpBlocks.delete(id);
    applyBlock(id);
  };
  const blockA2A = (id, reason) => {
    if (disposed || reason === a2aBlocks.get(id)) return;
    if (reason) a2aBlocks.set(id, reason); else a2aBlocks.delete(id);
    applyBlock(id);
  };
  const notify = id => { for (const fn of listeners.get(id) ?? []) fn(); };
  ctx.effect(() => () => {
    disposed = true;
    for (const request of pending.values()) request.controller.abort();
    pending.clear();
    for (const id of blockedSessions) ctx.conversation.blocks.set(id, undefined);
    blockedSessions.clear();
  });
  const publish = (id, value) => {
    native.set(id, value);
    block(id, value?.writable === false ? t(value.blocked === 'active-writer' ? 'activeWriter' : 'error') : undefined);
    notify(id);
  };
  const load = id => {
    if (!isAcp(id)) { block(id, undefined); return Promise.resolve(undefined); }
    if (!pending.has(id)) {
      const revision = revisionOf(id);
      const preset = presetOf(id);
      const controller = new AbortController();
      const request = { controller, operation: undefined };
      const current = () => !disposed && revision === revisionOf(id) && preset === presetOf(id);
      if (!native.has(id)) block(id, t('loading'));
      request.operation = acpRequest(id, undefined, controller.signal).then(value => {
        if (!current()) return undefined;
        publish(id, value);
        return value;
      }).catch(error => {
        if (!current() || controller.signal.aborted) return undefined;
        block(id, t('error') + ': ' + error.message);
        throw error;
      }).finally(() => { if (pending.get(id) === request) pending.delete(id); });
      pending.set(id, request);
    }
    return pending.get(id).operation;
  };
  const configure = async (id, configId, value) => {
    const revision = revisionOf(id);
    const preset = presetOf(id);
    const current = () => !disposed && revision === revisionOf(id) && preset === presetOf(id) && isAcp(id);
    try {
      const updated = await acpRequest(id, { configId, value });
      if (current()) publish(id, updated);
    } catch (error) { if (current()) throw error; }
  };
  const invalidate = (id, selectedPreset) => {
    const tracked = native.has(id) || pending.has(id) || blockedSessions.has(id) || listeners.has(id);
    revisions.set(id, revisionOf(id) + 1);
    if (selectedPreset !== undefined) selectedPresets.set(id, selectedPreset);
    const request = pending.get(id);
    pending.delete(id);
    request?.controller.abort();
    native.delete(id);
    block(id, tracked && isAcp(id) ? t('loading') : undefined);
    notify(id);
  };
  const reset = () => {
    selectedPresets.clear();
    for (const id of new Set([...native.keys(), ...pending.keys(), ...blockedSessions, ...listeners.keys()])) invalidate(id);
  };
  ctx.remote.$on('agent-preset/selected', (sessionId, agentPreset) => invalidate(sessionId, agentPreset));
  ctx.on('connection/reset', reset);

  function ModelControls({ sessionId, locked }) {
    const binding = ctx.sessions.binding(sessionId);
    const preset = binding.session.projections.faceOf('agentPreset');
    const selection = binding.session.projections.faceOf('modelSelection');
    const presetId = useSyncExternalStore(fn => preset.subscribe(fn), () => preset.getSnapshot());
    const projected = useSyncExternalStore(fn => selection.subscribe(fn), () => selection.getSnapshot());
    const capabilities = useSyncExternalStore(fn => {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, set = new Set());
      set.add(fn); return () => { set.delete(fn); };
    }, () => native.get(sessionId));
    const external = String(presetId ?? '').startsWith('oneagents-acp-');
    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const changeSequence = useRef(0);
    const refresh = async () => {
      const revision = revisionOf(sessionId);
      const current = () => !disposed && revision === revisionOf(sessionId) && presetOf(sessionId) === presetId;
      try {
        if (external) await load(sessionId);
        else {
          block(sessionId, undefined);
          const result = await ctx.remote.session.modelCatalog();
          if (!current()) return;
          if (!result.ok) throw new Error(result.error.message);
          setCatalog(result.value);
        }
        if (current()) setLoadError('');
      } catch (error) { if (current()) setLoadError(String(error.message ?? error)); }
    };
    useEffect(() => {
      if (!external) block(sessionId, undefined);
      setError('');
      setLoadError('');
      changeSequence.current += 1;
      setBusy(false);
      void refresh();
    }, [sessionId, presetId]);
    // Configuration updates can arrive while the remote Agent is working.
    useEffect(() => {
      if (!external) return;
      const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
      return () => clearInterval(timer);
    }, [external, sessionId, presetId]);
    // Typing would race a running A2A turn; manual takeover opens once that turn ends.
    useEffect(() => {
      let live = true, timer;
      const check = () => fetch(`/workbench/ui/api/dsh/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
        .then(response => response.ok ? response.json() : undefined).then(value => {
          if (!live) return;
          const task = value?.task;
          blockA2A(sessionId, task?.running ? t('a2aRunning') : undefined);
          if (task && timer === undefined) timer = setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 5000);
        }, () => {});
      void check();
      return () => { live = false; if (timer !== undefined) clearInterval(timer); blockA2A(sessionId, undefined); };
    }, [sessionId]);
    const change = async action => {
      const operation = ++changeSequence.current;
      const revision = revisionOf(sessionId);
      const current = () => !disposed && operation === changeSequence.current && revision === revisionOf(sessionId) && presetOf(sessionId) === presetId;
      setBusy(true);
      setError('');
      try { await action(); }
      catch (error) { if (current()) setError(String(error.message ?? error)); }
      finally { if (operation === changeSequence.current) setBusy(false); }
    };
    const disabled = locked || busy || (external && capabilities?.writable === false);
    const controls = [];
    if (external && capabilities) {
      const configs = capabilities.configOptions.filter(option => option.type === 'select');
      const model = configs.find(option => option.category === 'model' || option.id === 'model');
      if (model) controls.push(h(Select, { key: model.id, title: model.name || t('model'), value: model.currentValue, rows: choices(model), disabled, onSelect: value => change(() => configure(sessionId, model.id, value)) }));
      else controls.push(h('span', { key: 'unsupported', title: t('unsupported'), style: { fontSize: 12 } }, `ACP · ${capabilities.agent}`));
      const additional = configs.filter(option => option !== model && !(capabilities.modes && (option.category === 'mode' || option.id === 'mode')));
      if (additional.length || capabilities.modes) controls.push(h('button', { key: 'settings', type: 'button', style: selectStyle, onClick: () => setExpanded(!expanded), 'aria-expanded': expanded }, t('native')));
      if (expanded) {
        for (const option of additional) controls.push(h(Select, { key: option.id, title: option.name, value: option.currentValue, rows: choices(option), disabled, onSelect: value => change(() => configure(sessionId, option.id, value)) }));
        if (capabilities.modes) controls.push(h(Select, { key: 'mode', title: t('mode'), value: capabilities.modes.currentModeId, rows: capabilities.modes.availableModes.map(m => ({ value: m.id, name: m.name, description: m.description })), disabled, onSelect: value => change(() => configure(sessionId, '$mode', value)) }));
      }
    } else if (!external && catalog) {
      const current = projected?.next ?? catalog.default;
      const rows = catalog.groups.flatMap(group => group.models.map(model => ({ value: JSON.stringify([group.id, model.id]), name: model.name, group: group.name })));
      const select = async (provider, model, reasoningEffort) => {
        const result = await ctx.remote.session.selectModel({ sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
        if (!result.ok) throw new Error(result.error.message);
      };
      controls.push(h(Select, { key: 'dsh-model', title: t('model'), value: current?.provider === '1agents-acp' ? '' : JSON.stringify([current?.provider, current?.model]), rows, disabled, placeholder: t('choose'), onSelect: value => change(() => select(...JSON.parse(value))) }));
      const model = catalog.groups.find(g => g.id === current?.provider)?.models.find(m => m.id === current?.model);
      if (model?.reasoning) controls.push(h(Select, { key: 'effort', title: t('effort'), value: current.reasoningEffort ?? model.reasoning.defaultEffort, rows: model.reasoning.efforts.map(e => ({ value: e.id, name: e.name })), disabled, onSelect: value => change(() => select(current.provider, current.model, value)) }));
    } else if (!error && !loadError) controls.push(h('span', { key: 'loading', style: { fontSize: 12 } }, t(external ? 'loading' : 'loadingModels')));
    if (error || loadError) controls.push(h('span', { key: 'error', role: 'alert', style: { color: '#c64b45', fontSize: 12, maxWidth: 360 } }, error || loadError, ' ', h('button', { type: 'button', onClick: () => { setError(''); void refresh(); } }, t('retry'))));
    return h('div', { 'data-oneagents-acp-controls': external ? 'acp' : 'dsh', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }, controls);
  }

  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({ name: 'conversation.input.model', inject: sessionId => ({ sessionId }) }, ModelControls));

  // The gateway task workbench, served same-origin by the host plugin; its take-over button asks to open a session here.
  function WorkbenchPanel() {
    const frame = useRef(null);
    useEffect(() => {
      const onMessage = event => {
        if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
        const { type, sessionId } = event.data ?? {};
        if (type === '1agents:open-session' && typeof sessionId === 'string' && sessionId) ctx.uiWorkspace.openSession(sessionId);
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);
    return h('iframe', { ref: frame, src: '/workbench/ui/', title: t('workbench'), style: { display: 'block', width: '100%', height: '100%', border: 0 } });
  }
  function WorkbenchIcon({ size }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { d: 'M9 4v16M13 9h5M13 13h5' }));
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORKBENCH_PANEL }, WorkbenchPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: WORKBENCH_PANEL, order: 20, label: () => t('workbench') }, WorkbenchIcon));
  ctx.effect(() => ctx.commandUi.register({
    name: 'model', description: () => t('description'),
    available: session => ctx.sessions.subagentAddress(session.sessionId) === undefined,
    ui: {
      kind: 'popupSelect',
      options: async ({ sessionId }) => {
        if (isAcp(sessionId)) {
          const capabilities = await load(sessionId);
          if (!capabilities) return [];
          const model = capabilities.configOptions.find(option => option.category === 'model' || option.id === 'model');
          if (!model) throw new Error(t('unsupported'));
          return choices(model).map(option => ({ id: JSON.stringify([model.id, option.value]), label: option.name, detail: option.description, active: option.value === model.currentValue }));
        }
        const response = await ctx.remote.session.modelCatalog();
        if (!response.ok) throw new Error(response.error.message);
        return response.value.groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify([group.id, model.id]), label: model.name, detail: group.name })));
      },
      onSelect: async (option, { sessionId }) => {
        const [key, value] = JSON.parse(option.id);
        if (isAcp(sessionId)) await configure(sessionId, key, value);
        else { const result = await ctx.remote.session.selectModel({ sessionId, provider: key, model: value }); if (!result.ok) throw new Error(result.error.message); }
      },
    },
  }));
}
