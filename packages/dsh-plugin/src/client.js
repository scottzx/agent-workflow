/** Browser controls for native ACP configuration and ordinary DSH models. */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AcpModelSelect,
  StandardModelSelect,
  createModelCatalogStore,
  formatCopy,
  getModelCommandIcon,
  installModelSelectStyles,
  orderModelProviders,
  resolveLocalizedText,
} from './model-select.js';
import { registerWorkbenchPanel } from './workbench-panel.js';
import { registerRowConfigPanels } from './row-config-panel.js';

export const inject = ['slots', 'sessions', 'commandUi', 'remote', 'remote.session', 'locale', 'conversation'];

const dictionaries = {
  zh: {
    model: '模型',
    choose: '选择模型',
    loading: '正在连接 Agent…',
    loadingModels: '正在加载模型…',
    retry: '重试',
    mode: '模式',
    command: 'Agent 指令',
    effort: '思考强度',
    unsupported: 'Agent 未提供可切换的模型',
    description: '选择当前 Agent 的模型',
    error: '连接失败',
    noCommands: 'Agent 尚未提供指令',
    native: 'ACP 设置',
    activeWriter: '原会话正在其他客户端运行，可查看历史；占用解除后自动恢复输入。',
    a2aRunning: '当前会话正在由 A2A 任务执行，完成后自动恢复输入。',
    providerAccount: 'DeepSeek 账号',
    modelFallback: '请选择模型',
    triggerAria: '选择模型，当前 {model}',
    triggerAriaEffort: '选择模型，当前 {model}，推理等级 {effort}',
    menuAria: '模型与推理等级',
    menuModel: '模型',
    menuEffort: '推理等级',
    effortDefault: 'Default',
    statusLoading: '正在刷新模型列表…',
    errorAction: '模型操作失败：{message}',
    errorSessionInUse: '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
    actionReload: '重新加载',
    warningGroupLoad: '{name} 加载失败：{message}',
    optionLoadError: '目录加载失败：{message}',
    searchPlaceholder: '搜索模型…',
    searchClear: '清除搜索',
    searchEmpty: '没有匹配的模型。',
    emptyModels: '暂无可用模型',
    emptyEfforts: '当前模型未提供推理等级。',
  },
  en: {
    model: 'Model',
    choose: 'Select model',
    loading: 'Connecting to Agent…',
    loadingModels: 'Loading models…',
    retry: 'Retry',
    mode: 'Mode',
    command: 'Agent commands',
    effort: 'Reasoning effort',
    unsupported: 'This Agent does not advertise model selection',
    description: 'Select this Agent’s model',
    error: 'Connection failed',
    noCommands: 'No commands advertised',
    native: 'ACP settings',
    activeWriter: 'The original session is running in another client. History is available; input resumes when it is released.',
    a2aRunning: 'An A2A task is running in this session; input resumes once it completes.',
    providerAccount: 'DeepSeek Account',
    modelFallback: 'Select model',
    triggerAria: 'Select model, current {model}',
    triggerAriaEffort: 'Select model, current {model}, reasoning effort {effort}',
    menuAria: 'Model and reasoning effort',
    menuModel: 'Model',
    menuEffort: 'Effort',
    effortDefault: 'Default',
    statusLoading: 'Refreshing model list…',
    errorAction: 'Model operation failed: {message}',
    errorSessionInUse: 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
    actionReload: 'Reload',
    warningGroupLoad: '{name} failed to load: {message}',
    optionLoadError: 'Catalog failed to load: {message}',
    searchPlaceholder: 'Search models…',
    searchClear: 'Clear search',
    searchEmpty: 'No matching models.',
    emptyModels: 'No models available.',
    emptyEfforts: 'This model provides no reasoning effort levels.',
  },
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

export function apply(ctx) {
  installModelSelectStyles(ctx);
  ctx.effect(() => ctx.locale.register('oneagentsAcp', dictionaries));
  const t = ctx.locale.bind('oneagentsAcp');
  const catalogStore = createModelCatalogStore(ctx);
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
    catalogStore.resetGeneration();
    for (const id of new Set([...native.keys(), ...pending.keys(), ...blockedSessions, ...listeners.keys()])) invalidate(id);
  };
  ctx.remote.$on('agent-preset/selected', (sessionId, agentPreset) => invalidate(sessionId, agentPreset));
  ctx.on('connection/reset', reset);

  function ModelControls({ sessionId, locked, available, resolveText, renderSlot }) {
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
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState(false);
    const changeSequence = useRef(0);
    const refresh = async () => {
      const revision = revisionOf(sessionId);
      const current = () => !disposed && revision === revisionOf(sessionId) && presetOf(sessionId) === presetId;
      try {
        if (external) await load(sessionId);
        else block(sessionId, undefined);
        if (current()) setLoadError('');
      } catch (error) { if (current()) setLoadError(String(error.message ?? error)); }
    };
    useEffect(() => {
      if (!external) block(sessionId, undefined);
      setError('');
      setLoadError('');
      changeSequence.current += 1;
      setBusy(false);
      if (external) void refresh();
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
      try { await action(); return true; }
      catch (error) { if (current()) setError(String(error.message ?? error)); return false; }
      finally { if (operation === changeSequence.current) setBusy(false); }
    };

    if (!external) {
      if (available === false) return null;
      return h(StandardModelSelect, {
        sessionId,
        locked,
        projected,
        catalogStore,
        selectModel: next => ctx.remote.session.selectModel({
          sessionId,
          provider: next.provider,
          model: next.model,
          ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
        }),
        resolveText: resolveText ?? (text => resolveLocalizedText(ctx.locale, text)),
        renderSlot,
        t,
      });
    }

    return h(AcpModelSelect, {
      sessionId,
      presetId,
      capabilities,
      locked,
      busy,
      error,
      loadError,
      onConfigure: (configId, value) => change(() => configure(sessionId, configId, value)),
      onRefresh: refresh,
      onClearError: () => setError(''),
      t,
    });
  }

  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model',
    children: {
      'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
      'conversation.input.model.options': { kind: 'list', scope: 'session' },
    },
    inject: sessionId => ({
      sessionId,
      available: ctx.sessions.subagentAddress(sessionId) === undefined,
      resolveText: text => resolveLocalizedText(ctx.locale, text),
    }),
  }, ModelControls));

  const modelCommandIcon = getModelCommandIcon();
  ctx.effect(() => ctx.commandUi.register({
    name: 'model',
    label: () => t('model'),
    description: () => t('description'),
    ...(modelCommandIcon ? { icon: modelCommandIcon } : {}),
    available: session => ctx.sessions.subagentAddress(session.sessionId) === undefined,
    ui: {
      kind: 'popupSelect',
      searchMode: 'fuzzy-label',
      searchLabels: () => ({
        placeholder: t('searchPlaceholder'),
        empty: t('emptyModels'),
        noResults: t('searchEmpty'),
      }),
      options: async ({ sessionId }) => {
        if (isAcp(sessionId)) {
          const capabilities = await load(sessionId);
          if (!capabilities) return [];
          const model = capabilities.configOptions.find(option => option.category === 'model' || option.id === 'model');
          if (!model) throw new Error(t('unsupported'));
          return choices(model).map(option => ({ id: JSON.stringify([model.id, option.value]), label: option.name, detail: option.description, active: option.value === model.currentValue }));
        }
        const value = await catalogStore.load();
        const projected = ctx.sessions.binding(sessionId)?.session.projections.faceOf('modelSelection').getSnapshot();
        const current = projected?.next ?? value.default;
        const accountName = t('providerAccount');
        const rows = [];
        for (const group of orderModelProviders(value.groups ?? [])) {
          const groupLabel = group.id === 'deepseek-account' ? accountName : group.name;
          for (const model of group.models ?? []) {
            rows.push({
              id: JSON.stringify([group.id, model.id]),
              label: model.name,
              detail: groupLabel,
              group: { name: group.id, label: groupLabel },
              ...(current?.provider === group.id && current?.model === model.id ? { active: true } : {}),
            });
          }
        }
        for (const failure of value.failures ?? []) {
          rows.push({
            id: `failure/${failure.id}`,
            label: failure.id === 'deepseek-account' ? accountName : failure.name,
            detail: formatCopy(t, 'optionLoadError', { message: failure.message }),
          });
        }
        return rows;
      },
      onSelect: async (option, { sessionId }) => {
        if (!isAcp(sessionId) && String(option.id).startsWith('failure/')) {
          throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group');
        }
        const [key, value] = JSON.parse(option.id);
        if (isAcp(sessionId)) await configure(sessionId, key, value);
        else {
          const catalog = catalogStore.getSnapshot().value;
          const projected = ctx.sessions.binding(sessionId)?.session.projections.faceOf('modelSelection').getSnapshot();
          const current = projected?.next ?? catalog?.default;
          const matched = catalog?.groups?.find(g => g.id === key)?.models?.find(m => m.id === value);
          const sameRoute = current?.provider === key && current?.model === value;
          const reasoningEffort = sameRoute
            ? current?.reasoningEffort ?? matched?.reasoning?.defaultEffort
            : matched?.reasoning?.defaultEffort;
          const result = await ctx.remote.session.selectModel({
            sessionId,
            provider: key,
            model: value,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          });
          if (!result.ok) {
            if (result.error?.code === 'session/writer-held') throw new Error(t('errorSessionInUse'));
            throw new Error(result.error?.message ?? 'failed to select model');
          }
        }
      },
    },
  }));

  // Mount the A2A Workbench sidebar panel when the bundled `oneagents-dsh-a2a` host row
  // serves `/workbench/ui/`. Using `ctx.inject` keeps `uiWorkspace` optional for hosts
  // without a workspace shell while reusing the single bundle client face.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['slots', 'locale', 'uiWorkspace'], subCtx => registerWorkbenchPanel(subCtx));
  } else if (ctx.uiWorkspace) {
    registerWorkbenchPanel(ctx);
  }

  // Register per-row `plugins.row.config` panels for `oneagents-acp` and `oneagents-dsh-a2a`
  // when the host supports Typert remote mounting and Plugin Manager row config slots.
  registerRowConfigPanels(ctx);
}
