/**
 * Browser-side `plugins.row.config` configuration panels for the two bundled
 * rows inside `@1agents/acp-service`:
 *   - `oneagents-acp`
 *   - `oneagents-dsh-a2a`
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

const PACKAGE = '@1agents/acp-service';
const SERVICE = 'acpRowConfig';
const NS = 'oneagents-acp-row-config';

const STYLE = `
.oacp-cfg { display: flex; flex-direction: column; gap: 16px; max-width: 660px; }
.oacp-cfg * { box-sizing: border-box; }
.oacp-cfg-group { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); }
.oacp-cfg-group h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.oacp-cfg-field { display: flex; flex-direction: column; gap: 6px; }
.oacp-cfg-field label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.oacp-cfg-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.oacp-cfg-input, .oacp-cfg-select { height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); border-radius: 8px; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; width: 100%; }
.oacp-cfg-input:disabled, .oacp-cfg-select:disabled { opacity: 0.6; cursor: not-allowed; }
.oacp-cfg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.oacp-cfg-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
.oacp-cfg-toggle-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.oacp-cfg-toggle-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.oacp-cfg-toggle input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; flex: none; accent-color: var(--dsw-alias-state-business-primary, #3b82f6); }
.oacp-cfg-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.oacp-cfg-btn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28)); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.oacp-cfg-btn-primary { background: var(--dsw-alias-state-business-primary, #2563eb); border-color: transparent; color: #fff; }
.oacp-cfg-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.oacp-cfg-banner { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08)); color: var(--dsw-alias-label-secondary); }
.oacp-cfg-banner-err { color: var(--dsw-alias-state-error-primary, #dc2626); }
.oacp-cfg-banner-ok { color: var(--dsw-alias-state-success-primary, #16a34a); }
`;

const codec = (label, parse) => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${label}`,
  create: () => ({ parse }),
});

const objectOf = value => (!value || typeof value !== 'object' || Array.isArray(value) ? {} : value);
const resultOf = value => {
  if (value && typeof value === 'object' && (value.ok === true || value.ok === false)) return value;
  throw new Error(`${SERVICE}: invalid result`);
};

const contribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#rowConfigRead`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('ReadInput', objectOf) }],
      result: codec('ReadResult', resultOf),
    },
    {
      id: `${PACKAGE}#rowConfigSave`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('SaveInput', objectOf) }],
      result: codec('SaveResult', resultOf),
    },
  ],
};

const zh = {
  'summary.oneagents-acp': 'ACP 外部 Agent 适配服务、预设发现与重连策略配置。',
  'summary.oneagents-dsh-a2a': '独立 DSH headless/SDK A2A 端点与同源 /workbench/ui 工作台配置。',
  loading: '正在读取当前配置…',
  inactiveHint: '该组件当前未启用。请先返回组件列表打开它的开关，然后再回来编辑并保存配置。',
  unavailableHint: '当前环境不支持在线修改配置，请直接编辑 profile 下的 cordis.patch.yml。',
  preserveNote: '保存时会自动保留 cordis.patch.yml 中原有的高级字段（如 a2a、sessionPolicies、pushNotificationOrigins 等）。',
  save: '保存并热重载',
  saving: '保存中…',
  reload: '重新读取',
  saved: '已保存到 cordis.patch.yml 并完成热重载。',
  'acp.serviceSection': 'ACP 服务连接',
  'acp.mode': '服务模式（serviceMode）',
  'acp.modeHint': 'auto 自动复用或托管启动；external 仅连外部服务；managed 随插件启停；launchd 交由系统服务管理器。',
  'acp.url': '服务地址（serviceUrl）',
  'acp.urlHint': '本机或目标 ACP 服务 HTTP 地址，默认 http://127.0.0.1:36812。',
  'acp.label': '服务管理器标签（serviceManagerLabel）',
  'acp.labelHint': '仅 launchd 模式必填（例如 com.1agents.acp-service），其他模式留空即可。',
  'acp.agentsSection': '预设与重连',
  'acp.agents': '限定 Agent 列表（agents）',
  'acp.agentsHint': '逗号分隔（如 codex, claude, antigravity）；留空则自动发现全部可用 Agent。',
  'acp.attempts': '最大重连次数（reconnectAttempts）',
  'acp.delay': '重连间隔（reconnectDelayMs）',
  'a2a.listenerSection': 'A2A 监听与工作台',
  'a2a.hostWorkbench': '在当前 DSH 界面挂载 /workbench/ui',
  'a2a.hostWorkbenchHint': '开启后侧边栏自动展示“A2A 工作台”面板，直接复用当前 DSH 登录态。',
  'a2a.listenerEnabled': '启用独立 A2A HTTP 端口监听',
  'a2a.listenerEnabledHint': '关闭后（port: false）仅保留工作台页面，不额外监听 A2A 端口。',
  'a2a.host': '监听地址（host）',
  'a2a.port': '端口（port）',
  'a2a.publicUrl': '对外地址（publicUrl）',
  'a2a.publicUrlHint': '写入 Agent Card 的纯 Origin 地址（例如 http://127.0.0.1:3080）。',
  'a2a.authSection': '凭据与状态',
  'a2a.tokenEnv': '令牌环境变量名（tokenEnv）',
  'a2a.tokenFile': '令牌文件路径（tokenFile，可选 0600）',
  'a2a.stateDir': '状态目录（stateDirectory，可选）',
  'a2a.workbenchSection': '任务网关工作台代理',
  'a2a.workbenchUrl': '网关地址（workbench.url）',
  'a2a.workbenchConfigFile': '网关配置文件（workbenchConfigFile）',
  'a2a.workbenchHint': '用于从 0600 网关配置自动读取 workbench token 与 pageRelaySecret，避免明文写入 YAML。',
  'a2a.runtimeSection': 'DSH 执行运行时',
  'a2a.runtimeMode': '运行模式（runtime.mode）',
  'a2a.runtimeCommand': '命令（runtime.command）',
  'a2a.runtimeArgs': '参数（runtime.args，空格分隔）',
};

const en = {
  'summary.oneagents-acp': 'ACP external Agent service connection, preset discovery, and reconnect policy.',
  'summary.oneagents-dsh-a2a': 'Standalone DSH headless/SDK A2A listener and same-origin /workbench/ui host.',
  loading: 'Loading configuration…',
  inactiveHint: 'This component is currently disabled. Enable its switch in the component list first, then return here to edit and save.',
  unavailableHint: 'Live configuration editing is unavailable in this environment. Edit cordis.patch.yml directly.',
  preserveNote: 'Existing advanced fields in cordis.patch.yml (such as a2a, sessionPolicies, pushNotificationOrigins) are preserved when saving.',
  save: 'Save & reload',
  saving: 'Saving…',
  reload: 'Reload',
  saved: 'Saved to cordis.patch.yml and hot-reloaded.',
  'acp.serviceSection': 'ACP service connection',
  'acp.mode': 'Service mode (serviceMode)',
  'acp.modeHint': 'auto reuses or spawns a worker; external connects only; managed owns a child; launchd delegates to launchd.',
  'acp.url': 'Service URL (serviceUrl)',
  'acp.urlHint': 'Local or remote ACP HTTP service URL (default http://127.0.0.1:36812).',
  'acp.label': 'Service manager label (serviceManagerLabel)',
  'acp.labelHint': 'Required only for launchd mode (e.g. com.1agents.acp-service); leave blank otherwise.',
  'acp.agentsSection': 'Presets & reconnect',
  'acp.agents': 'Explicit agents (agents)',
  'acp.agentsHint': 'Comma-separated (e.g. codex, claude, antigravity); leave empty to auto-discover all ready agents.',
  'acp.attempts': 'Reconnect attempts (reconnectAttempts)',
  'acp.delay': 'Reconnect delay ms (reconnectDelayMs)',
  'a2a.listenerSection': 'A2A listener & workbench',
  'a2a.hostWorkbench': 'Mount /workbench/ui on this DSH host',
  'a2a.hostWorkbenchHint': 'Shows the "A2A Workbench" sidebar panel reusing the host browser login.',
  'a2a.listenerEnabled': 'Enable standalone A2A HTTP listener',
  'a2a.listenerEnabledHint': 'When disabled (port: false), only mounts the workbench page without opening an A2A port.',
  'a2a.host': 'Listen host (host)',
  'a2a.port': 'Port (port)',
  'a2a.publicUrl': 'Public origin (publicUrl)',
  'a2a.publicUrlHint': 'Origin advertised in the Agent Card (e.g. http://127.0.0.1:3080).',
  'a2a.authSection': 'Credentials & state',
  'a2a.tokenEnv': 'Token env var (tokenEnv)',
  'a2a.tokenFile': 'Token file path (tokenFile, optional 0600)',
  'a2a.stateDir': 'State directory (stateDirectory, optional)',
  'a2a.workbenchSection': 'Gateway workbench relay',
  'a2a.workbenchUrl': 'Gateway URL (workbench.url)',
  'a2a.workbenchConfigFile': 'Gateway config file (workbenchConfigFile)',
  'a2a.workbenchHint': 'Reads workbench token & pageRelaySecret from a 0600 gateway file without inlining secrets.',
  'a2a.runtimeSection': 'DSH execution runtime',
  'a2a.runtimeMode': 'Runtime mode (runtime.mode)',
  'a2a.runtimeCommand': 'Command (runtime.command)',
  'a2a.runtimeArgs': 'Args (runtime.args, space-separated)',
};

function useRowConfig(api, rowId, toDraft) {
  const [status, setStatus] = useState('loading');
  const [meta, setMeta] = useState({ writable: false, active: false, reason: undefined });
  const [draft, setDraft] = useState(() => toDraft({}));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setFeedback(null);
    try {
      const res = await api.read({ rowId });
      if (!res.ok) {
        setStatus('error');
        setFeedback({ kind: 'error', text: res.error?.message || '读取失败' });
        return;
      }
      setMeta({ writable: res.writable === true, active: res.active === true, reason: res.reason });
      setDraft(toDraft(res.effective || {}));
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [api, rowId, toDraft]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async payload => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.save({ rowId, config: payload });
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error?.message || '保存失败' });
        return false;
      }
      setMeta({ writable: res.writable === true, active: res.active === true, reason: res.reason });
      setDraft(toDraft(res.effective || {}));
      setFeedback({ kind: 'ok', text: null });
      return true;
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, rowId, toDraft]);

  return { status, meta, draft, setDraft, saving, feedback, load, save };
}

function FormShell({ t, status, meta, saving, feedback, onSave, onReload, children }) {
  return h('div', { className: 'oacp-cfg' },
    h('style', null, STYLE),
    status === 'loading' ? h('p', { className: 'oacp-cfg-banner' }, t('loading')) : null,
    status === 'ready' && !meta.writable
      ? h('p', { className: 'oacp-cfg-banner' }, meta.reason === 'inactive' ? t('inactiveHint') : t('unavailableHint'))
      : null,
    children,
    h('p', { className: 'oacp-cfg-hint' }, t('preserveNote')),
    feedback?.kind === 'error' ? h('p', { className: 'oacp-cfg-banner oacp-cfg-banner-err', role: 'alert' }, feedback.text) : null,
    feedback?.kind === 'ok' ? h('p', { className: 'oacp-cfg-banner oacp-cfg-banner-ok', role: 'status' }, t('saved')) : null,
    h('div', { className: 'oacp-cfg-actions' },
      h('button', {
        type: 'button',
        className: 'oacp-cfg-btn oacp-cfg-btn-primary',
        disabled: saving || status !== 'ready' || !meta.writable,
        onClick: onSave,
      }, saving ? t('saving') : t('save')),
      h('button', {
        type: 'button',
        className: 'oacp-cfg-btn',
        disabled: saving,
        onClick: onReload,
      }, t('reload')),
    ),
  );
}

const acpDraftOf = cfg => ({
  serviceMode: cfg.serviceMode || 'auto',
  serviceUrl: cfg.serviceUrl || 'http://127.0.0.1:36812',
  serviceManagerLabel: typeof cfg.serviceManagerLabel === 'string' ? cfg.serviceManagerLabel : '',
  agents: Array.isArray(cfg.agents) ? cfg.agents.join(', ') : '',
  reconnectAttempts: String(cfg.reconnectAttempts ?? 5),
  reconnectDelayMs: String(cfg.reconnectDelayMs ?? 1000),
});

function AcpRowPanel({ t, view, api }) {
  if (view === 'summary') return t('summary.oneagents-acp');
  const { status, meta, draft, setDraft, saving, feedback, load, save } = useRowConfig(api, 'oneagents-acp', acpDraftOf);
  const disabled = saving || status !== 'ready' || !meta.writable;
  const handleSave = () => {
    const agents = draft.agents.split(',').map(item => item.trim()).filter(Boolean);
    void save({
      serviceMode: draft.serviceMode,
      serviceUrl: draft.serviceUrl,
      serviceManagerLabel: draft.serviceManagerLabel,
      agents: agents.length > 0 ? agents : null,
      reconnectAttempts: Number(draft.reconnectAttempts),
      reconnectDelayMs: Number(draft.reconnectDelayMs),
    });
  };
  return h(FormShell, {
    t, status, meta, saving, feedback, onSave: handleSave, onReload: () => { void load(); },
  },
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('acp.serviceSection')),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('acp.mode')),
          h('select', {
            className: 'oacp-cfg-select', value: draft.serviceMode, disabled,
            onChange: e => setDraft(d => ({ ...d, serviceMode: e.target.value })),
          },
            h('option', { value: 'auto' }, 'auto'),
            h('option', { value: 'external' }, 'external'),
            h('option', { value: 'managed' }, 'managed'),
            h('option', { value: 'launchd' }, 'launchd'),
          ),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('acp.url')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', value: draft.serviceUrl, disabled,
            onChange: e => setDraft(d => ({ ...d, serviceUrl: e.target.value })),
          }),
        ),
      ),
      h('p', { className: 'oacp-cfg-hint' }, t('acp.modeHint')),
      h('div', { className: 'oacp-cfg-field' },
        h('label', null, t('acp.label')),
        h('input', {
          className: 'oacp-cfg-input', type: 'text', placeholder: 'com.1agents.acp-service',
          value: draft.serviceManagerLabel, disabled,
          onChange: e => setDraft(d => ({ ...d, serviceManagerLabel: e.target.value })),
        }),
        h('p', { className: 'oacp-cfg-hint' }, t('acp.labelHint')),
      ),
    ),
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('acp.agentsSection')),
      h('div', { className: 'oacp-cfg-field' },
        h('label', null, t('acp.agents')),
        h('input', {
          className: 'oacp-cfg-input', type: 'text', placeholder: 'codex, claude, antigravity',
          value: draft.agents, disabled,
          onChange: e => setDraft(d => ({ ...d, agents: e.target.value })),
        }),
        h('p', { className: 'oacp-cfg-hint' }, t('acp.agentsHint')),
      ),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('acp.attempts')),
          h('input', {
            className: 'oacp-cfg-input', type: 'number', min: 0, max: 100,
            value: draft.reconnectAttempts, disabled,
            onChange: e => setDraft(d => ({ ...d, reconnectAttempts: e.target.value })),
          }),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('acp.delay')),
          h('input', {
            className: 'oacp-cfg-input', type: 'number', min: 100, max: 60000,
            value: draft.reconnectDelayMs, disabled,
            onChange: e => setDraft(d => ({ ...d, reconnectDelayMs: e.target.value })),
          }),
        ),
      ),
    ),
  );
}

const a2aDraftOf = cfg => {
  const listenerEnabled = cfg.port !== false;
  const runtime = cfg.runtime && typeof cfg.runtime === 'object' ? cfg.runtime : {};
  const workbench = cfg.workbench && typeof cfg.workbench === 'object' ? cfg.workbench : {};
  return {
    hostWorkbench: cfg.hostWorkbench !== false,
    listenerEnabled,
    host: cfg.host || '127.0.0.1',
    port: typeof cfg.port === 'number' ? String(cfg.port) : '3080',
    publicUrl: cfg.publicUrl || 'http://127.0.0.1:3080',
    tokenEnv: cfg.tokenEnv ?? 'DSH_A2A_TOKEN',
    tokenFile: typeof cfg.tokenFile === 'string' ? cfg.tokenFile : '',
    stateDirectory: typeof cfg.stateDirectory === 'string' ? cfg.stateDirectory : '',
    workbenchUrl: typeof workbench.url === 'string' ? workbench.url : '',
    workbenchConfigFile: typeof cfg.workbenchConfigFile === 'string' ? cfg.workbenchConfigFile : '',
    runtimeMode: runtime.mode === 'sdk' ? 'sdk' : 'headless',
    runtimeCommand: typeof runtime.command === 'string' && runtime.command ? runtime.command : 'dsh',
    runtimeArgs: Array.isArray(runtime.args) ? runtime.args.join(' ') : '--profile headless',
  };
};

function DshA2ARowPanel({ t, view, api }) {
  if (view === 'summary') return t('summary.oneagents-dsh-a2a');
  const { status, meta, draft, setDraft, saving, feedback, load, save } = useRowConfig(api, 'oneagents-dsh-a2a', a2aDraftOf);
  const disabled = saving || status !== 'ready' || !meta.writable;
  const listenerDisabled = disabled || !draft.listenerEnabled;

  const handleSave = () => {
    const args = draft.runtimeArgs.trim() ? draft.runtimeArgs.trim().split(/\s+/) : [];
    const payload = {
      hostWorkbench: draft.hostWorkbench,
      ...(draft.listenerEnabled
        ? { host: draft.host, port: Number(draft.port), publicUrl: draft.publicUrl }
        : { port: false }),
      tokenEnv: draft.tokenEnv,
      tokenFile: draft.tokenFile,
      stateDirectory: draft.stateDirectory,
      workbenchConfigFile: draft.workbenchConfigFile,
      workbench: { url: draft.workbenchUrl },
      runtime: {
        mode: draft.runtimeMode,
        command: draft.runtimeCommand,
        args,
      },
    };
    void save(payload);
  };

  return h(FormShell, {
    t, status, meta, saving, feedback, onSave: handleSave, onReload: () => { void load(); },
  },
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('a2a.listenerSection')),
      h('label', { className: 'oacp-cfg-toggle' },
        h('span', { className: 'oacp-cfg-toggle-text' },
          h('span', { className: 'oacp-cfg-toggle-title' }, t('a2a.hostWorkbench')),
          h('span', { className: 'oacp-cfg-hint' }, t('a2a.hostWorkbenchHint')),
        ),
        h('input', {
          type: 'checkbox', checked: draft.hostWorkbench, disabled,
          onChange: e => setDraft(d => ({ ...d, hostWorkbench: e.target.checked })),
        }),
      ),
      h('label', { className: 'oacp-cfg-toggle' },
        h('span', { className: 'oacp-cfg-toggle-text' },
          h('span', { className: 'oacp-cfg-toggle-title' }, t('a2a.listenerEnabled')),
          h('span', { className: 'oacp-cfg-hint' }, t('a2a.listenerEnabledHint')),
        ),
        h('input', {
          type: 'checkbox', checked: draft.listenerEnabled, disabled,
          onChange: e => setDraft(d => ({ ...d, listenerEnabled: e.target.checked })),
        }),
      ),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.host')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', value: draft.host, disabled: listenerDisabled,
            onChange: e => setDraft(d => ({ ...d, host: e.target.value })),
          }),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.port')),
          h('input', {
            className: 'oacp-cfg-input', type: 'number', min: 1, max: 65535,
            value: draft.port, disabled: listenerDisabled,
            onChange: e => setDraft(d => ({ ...d, port: e.target.value })),
          }),
        ),
      ),
      h('div', { className: 'oacp-cfg-field' },
        h('label', null, t('a2a.publicUrl')),
        h('input', {
          className: 'oacp-cfg-input', type: 'text', value: draft.publicUrl, disabled: listenerDisabled,
          onChange: e => setDraft(d => ({ ...d, publicUrl: e.target.value })),
        }),
        h('p', { className: 'oacp-cfg-hint' }, t('a2a.publicUrlHint')),
      ),
    ),
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('a2a.authSection')),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.tokenEnv')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', value: draft.tokenEnv, disabled,
            onChange: e => setDraft(d => ({ ...d, tokenEnv: e.target.value })),
          }),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.tokenFile')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', placeholder: '/path/to/a2a.token',
            value: draft.tokenFile, disabled,
            onChange: e => setDraft(d => ({ ...d, tokenFile: e.target.value })),
          }),
        ),
      ),
      h('div', { className: 'oacp-cfg-field' },
        h('label', null, t('a2a.stateDir')),
        h('input', {
          className: 'oacp-cfg-input', type: 'text', placeholder: '~/.dsh/state/desktop-a2a',
          value: draft.stateDirectory, disabled,
          onChange: e => setDraft(d => ({ ...d, stateDirectory: e.target.value })),
        }),
      ),
    ),
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('a2a.workbenchSection')),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.workbenchUrl')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', placeholder: 'http://127.0.0.1:36814',
            value: draft.workbenchUrl, disabled,
            onChange: e => setDraft(d => ({ ...d, workbenchUrl: e.target.value })),
          }),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.workbenchConfigFile')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', placeholder: '~/.config/1agents/a2a-gateway.json',
            value: draft.workbenchConfigFile, disabled,
            onChange: e => setDraft(d => ({ ...d, workbenchConfigFile: e.target.value })),
          }),
        ),
      ),
      h('p', { className: 'oacp-cfg-hint' }, t('a2a.workbenchHint')),
    ),
    h('div', { className: 'oacp-cfg-group' },
      h('h4', null, t('a2a.runtimeSection')),
      h('div', { className: 'oacp-cfg-grid' },
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.runtimeMode')),
          h('select', {
            className: 'oacp-cfg-select', value: draft.runtimeMode, disabled: listenerDisabled,
            onChange: e => setDraft(d => ({ ...d, runtimeMode: e.target.value })),
          },
            h('option', { value: 'headless' }, 'headless'),
            h('option', { value: 'sdk' }, 'sdk'),
          ),
        ),
        h('div', { className: 'oacp-cfg-field' },
          h('label', null, t('a2a.runtimeCommand')),
          h('input', {
            className: 'oacp-cfg-input', type: 'text', value: draft.runtimeCommand, disabled: listenerDisabled,
            onChange: e => setDraft(d => ({ ...d, runtimeCommand: e.target.value })),
          }),
        ),
      ),
      h('div', { className: 'oacp-cfg-field' },
        h('label', null, t('a2a.runtimeArgs')),
        h('input', {
          className: 'oacp-cfg-input', type: 'text', value: draft.runtimeArgs, disabled: listenerDisabled,
          onChange: e => setDraft(d => ({ ...d, runtimeArgs: e.target.value })),
        }),
      ),
    ),
  );
}

export function registerRowConfigPanels(ctx) {
  if (typeof ctx.remote?.$mount !== 'function' || typeof ctx.plugin !== 'function') return;
  void Promise.resolve(ctx.remote.$mount(contribution)).then(release => {
    if (typeof release === 'function') ctx.effect(() => release);
    return ctx.plugin({
      name: `${PACKAGE}/row-config-ui`,
      inject: ['slots', 'locale', `remote.${SERVICE}`],
      apply(uiCtx) {
        uiCtx.effect(() => uiCtx.locale.register(NS, { zh, en }));
        const remote = uiCtx.remote[SERVICE];
        const api = {
          read: input => remote.read(input),
          save: input => remote.save(input),
        };
        const rows = [
          ['oneagents-acp', AcpRowPanel],
          ['oneagents-dsh-a2a', DshA2ARowPanel],
        ];
        for (const [rowId, Component] of rows) {
          uiCtx.effect(() => uiCtx.slots.inject('plugins.row.config', () => uiCtx.slots.register({
            name: 'plugins.row.config',
            key: `${PACKAGE}#${rowId}`,
            locale: NS,
            inject: () => ({ api }),
          }, Component)));
        }
      },
    });
  }, () => { /* Ignore on older hosts without Typert remote mounting */ });
}
