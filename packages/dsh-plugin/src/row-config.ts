/**
 * Host Typert RPC for reading and saving configuration of the two rows bundled
 * inside `@1agents/acp-service` (`oneagents-acp` and `oneagents-dsh-a2a`) via
 * DSH's `configEditor` service.
 */
import type { Context } from '@deepseek-ai/cordis';

const PACKAGE = '@1agents/acp-service';
const SERVICE = 'acpRowConfig';

export const ALLOWED_ROW_IDS = Object.freeze([
  'oneagents-acp',
  'oneagents-dsh-a2a',
] as const);

export type BundledRowId = (typeof ALLOWED_ROW_IDS)[number];

const ALLOWED_ROW_SET = new Set<string>(ALLOWED_ROW_IDS);
const VALID_SERVICE_MODES = new Set(['auto', 'external', 'managed', 'launchd']);
const VALID_RUNTIME_MODES = new Set(['headless', 'sdk']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseHttpUrl(raw: unknown, label: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  let parsed: URL | undefined;
  try { parsed = new URL(text); } catch { /* handled below */ }
  if (!text || !parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`${label} 必须是有效的 http:// 或 https:// 地址`);
  }
  return text;
}

function parseOriginUrl(raw: unknown, label: string): string {
  const text = parseHttpUrl(raw, label);
  const parsed = new URL(text);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} 必须是纯 Origin 地址（例如 http://127.0.0.1:3080，不含路径或凭据）`);
  }
  return parsed.origin;
}

/**
 * Validate incoming form edits and merge them onto the existing row config so
 * advanced fields (such as `sessionPolicies`, `a2a`, `pushNotificationOrigins`,
 * or secret references) are never silently wiped out when saving from the UI.
 */
export function validateRowConfig(
  rowId: string,
  raw: unknown,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!ALLOWED_ROW_SET.has(rowId)) {
    throw new Error(`unsupported rowId: ${String(rowId)}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error('config must be an object');
  }
  const base = isPlainObject(existing) ? structuredClone(existing) : {};

  if (rowId === 'oneagents-acp') {
    const mode = typeof raw.serviceMode === 'string' && raw.serviceMode.trim()
      ? raw.serviceMode.trim()
      : (typeof base.serviceMode === 'string' ? base.serviceMode : 'auto');
    if (!VALID_SERVICE_MODES.has(mode)) {
      throw new Error('serviceMode 必须是 auto、external、managed 或 launchd');
    }
    const serviceUrl = parseHttpUrl(
      raw.serviceUrl ?? base.serviceUrl ?? 'http://127.0.0.1:36812',
      'serviceUrl',
    );
    const next: Record<string, unknown> = { ...base, serviceMode: mode, serviceUrl };

    if ('serviceManagerLabel' in raw) {
      const label = typeof raw.serviceManagerLabel === 'string' ? raw.serviceManagerLabel.trim() : '';
      if (label) {
        if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
          throw new Error('serviceManagerLabel 只能包含字母、数字、点、下划线或连字符');
        }
        next.serviceManagerLabel = label;
      } else {
        delete next.serviceManagerLabel;
      }
    }
    if (mode === 'launchd' && !next.serviceManagerLabel) {
      throw new Error('serviceMode 为 launchd 时必须填写 serviceManagerLabel');
    }

    if ('agents' in raw) {
      if (raw.agents === null || raw.agents === undefined || raw.agents === '') {
        delete next.agents;
      } else if (Array.isArray(raw.agents)) {
        const list = raw.agents.map(item => String(item).trim()).filter(Boolean);
        if (list.some(item => !/^[a-z0-9_-]+$/i.test(item))) {
          throw new Error('agents 仅允许字母、数字、下划线或连字符');
        }
        if (list.length > 0) next.agents = [...new Set(list)];
        else delete next.agents;
      } else {
        throw new Error('agents 必须是字符串数组');
      }
    }

    if (raw.reconnectAttempts !== undefined && raw.reconnectAttempts !== '') {
      const attempts = Number(raw.reconnectAttempts);
      if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 100) {
        throw new Error('reconnectAttempts 必须是 0–100 之间的整数');
      }
      next.reconnectAttempts = attempts;
    }

    if (raw.reconnectDelayMs !== undefined && raw.reconnectDelayMs !== '') {
      const delay = Number(raw.reconnectDelayMs);
      if (!Number.isSafeInteger(delay) || delay < 100 || delay > 60_000) {
        throw new Error('reconnectDelayMs 必须是 100–60000 之间的整数');
      }
      next.reconnectDelayMs = delay;
    }

    return next;
  }

  // oneagents-dsh-a2a
  const next: Record<string, unknown> = { ...base };
  if (typeof raw.hostWorkbench === 'boolean') {
    next.hostWorkbench = raw.hostWorkbench;
  }

  if (raw.port === false) {
    next.port = false;
  } else {
    const host = typeof raw.host === 'string' && raw.host.trim()
      ? raw.host.trim()
      : (typeof base.host === 'string' && base.host.trim() ? base.host.trim() : '127.0.0.1');
    if (/\s/.test(host)) throw new Error('host 不能包含空白字符');
    const port = Number(raw.port ?? base.port ?? 3080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port 必须是 1–65535 之间的整数（或设为 false 关闭独立监听）');
    }
    const publicUrl = parseOriginUrl(
      raw.publicUrl ?? base.publicUrl ?? `http://${host}:${port}`,
      'publicUrl',
    );
    next.host = host;
    next.port = port;
    next.publicUrl = publicUrl;
  }

  if ('tokenEnv' in raw) {
    const tokenEnv = typeof raw.tokenEnv === 'string' ? raw.tokenEnv.trim() : '';
    if (tokenEnv) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(tokenEnv)) {
        throw new Error('tokenEnv 必须是合法的环境变量名（如 DSH_A2A_TOKEN）');
      }
      next.tokenEnv = tokenEnv;
    } else {
      delete next.tokenEnv;
    }
  }

  for (const field of ['tokenFile', 'stateDirectory', 'workbenchConfigFile'] as const) {
    if (field in raw) {
      const val = typeof raw[field] === 'string' ? raw[field].trim() : '';
      if (val) next[field] = val;
      else delete next[field];
    }
  }

  if ('workbench' in raw) {
    if (raw.workbench === null || raw.workbench === undefined) {
      delete next.workbench;
    } else if (isPlainObject(raw.workbench)) {
      const existingWb = isPlainObject(base.workbench) ? { ...base.workbench } : {};
      if ('url' in raw.workbench) {
        const url = typeof raw.workbench.url === 'string' ? raw.workbench.url.trim() : '';
        if (url) existingWb.url = parseOriginUrl(url, 'workbench.url');
        else delete existingWb.url;
      }
      if (Object.keys(existingWb).length > 0) next.workbench = existingWb;
      else delete next.workbench;
    } else {
      throw new Error('workbench 必须是对象');
    }
  }

  if ('runtime' in raw) {
    if (raw.runtime === null || raw.runtime === undefined) {
      delete next.runtime;
    } else if (isPlainObject(raw.runtime)) {
      const existingRt = isPlainObject(base.runtime) ? { ...base.runtime } : {};
      if ('mode' in raw.runtime) {
        const rtMode = typeof raw.runtime.mode === 'string' ? raw.runtime.mode.trim() : '';
        if (rtMode) {
          if (!VALID_RUNTIME_MODES.has(rtMode)) throw new Error('runtime.mode 必须是 headless 或 sdk');
          existingRt.mode = rtMode;
        } else {
          delete existingRt.mode;
        }
      }
      if ('command' in raw.runtime) {
        const command = typeof raw.runtime.command === 'string' ? raw.runtime.command.trim() : '';
        if (!command) throw new Error('runtime.command 不能为空');
        existingRt.command = command;
      }
      if ('args' in raw.runtime) {
        if (!Array.isArray(raw.runtime.args)) throw new Error('runtime.args 必须是字符串数组');
        existingRt.args = raw.runtime.args.map(item => String(item).trim()).filter(Boolean);
      }
      next.runtime = existingRt;
    } else {
      throw new Error('runtime 必须是对象');
    }
  }

  return next;
}

interface ConfigEditorEntry {
  disabled?: boolean;
  fiber?: { state?: number };
  options?: { id?: string; config?: Record<string, unknown> };
}

interface ConfigEditorItem {
  entry?: ConfigEditorEntry;
  inherited?: Record<string, unknown>;
  override?: Record<string, unknown>;
}

export interface ConfigEditorLike {
  configuration?: () => ConfigEditorItem[];
  edit?: (
    entry: ConfigEditorEntry,
    updater: (current: Record<string, unknown> | undefined, inherited: Record<string, unknown> | undefined) => Record<string, unknown>,
  ) => Promise<void> | void;
}

function findEntryRecord(configEditor: ConfigEditorLike | undefined, rowId: string): ConfigEditorItem | undefined {
  if (!configEditor || typeof configEditor.configuration !== 'function') return undefined;
  const list = configEditor.configuration();
  return list.find(item => item?.entry?.options?.id === rowId);
}

export function readRowConfig(configEditor: ConfigEditorLike | undefined, rowId: unknown) {
  if (typeof rowId !== 'string' || !ALLOWED_ROW_SET.has(rowId)) {
    return { ok: false, error: { code: 'INVALID_ROW', message: `不支持的组件：${String(rowId)}` } };
  }
  if (!configEditor) {
    return {
      ok: true,
      rowId,
      writable: false,
      active: false,
      reason: 'unavailable',
      effective: {},
      inherited: {},
      override: {},
    };
  }
  const found = findEntryRecord(configEditor, rowId);
  if (!found || !found.entry) {
    return {
      ok: true,
      rowId,
      writable: false,
      active: false,
      reason: 'inactive',
      effective: {},
      inherited: {},
      override: {},
    };
  }
  const entry = found.entry;
  // FiberState.ACTIVE === 2 in Cordis
  const active = entry.fiber !== undefined && entry.fiber.state === 2 && !entry.disabled;
  const effective = structuredClone(entry.options?.config ?? {});
  return {
    ok: true,
    rowId,
    writable: active,
    active,
    reason: active ? undefined : 'inactive',
    effective,
    inherited: found.inherited ?? {},
    override: found.override ?? {},
  };
}

export async function saveRowConfig(configEditor: ConfigEditorLike | undefined, rowId: unknown, rawConfig: unknown) {
  if (typeof rowId !== 'string' || !ALLOWED_ROW_SET.has(rowId)) {
    return { ok: false, error: { code: 'INVALID_ROW', message: `不支持的组件：${String(rowId)}` } };
  }
  if (!configEditor || typeof configEditor.edit !== 'function') {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '当前环境未挂载配置编辑器' } };
  }
  const found = findEntryRecord(configEditor, rowId);
  if (!found || !found.entry) {
    return {
      ok: false,
      error: { code: 'INACTIVE', message: '组件未启用，请先打开该组件的开关后再保存配置' },
    };
  }
  const currentConfig = found.entry.options?.config ?? {};
  let validated: Record<string, unknown>;
  try {
    validated = validateRowConfig(rowId, rawConfig, currentConfig);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: error instanceof Error ? error.message : String(error) },
    };
  }
  try {
    await configEditor.edit(found.entry, () => validated);
    return readRowConfig(configEditor, rowId);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'SAVE_FAILED', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

const codec = <T>(label: string, parse: (value: unknown) => T) => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${label}`,
  create: () => ({ parse }),
});

const objectOf = (value: unknown): Record<string, unknown> =>
  (!value || typeof value !== 'object' || Array.isArray(value) ? {} : value as Record<string, unknown>);

const resultOf = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && ('ok' in value) && ((value as { ok: unknown }).ok === true || (value as { ok: unknown }).ok === false)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${SERVICE}: invalid RPC result`);
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
      parameters: [
        { name: 'input', wire: 'input', source: 'json', codec: codec('ReadInput', objectOf) },
      ],
      result: codec('ReadResult', resultOf),
    },
    {
      id: `${PACKAGE}#rowConfigSave`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'input', wire: 'input', source: 'json', codec: codec('SaveInput', objectOf) },
      ],
      result: codec('SaveResult', resultOf),
    },
  ],
};

export function registerRowConfigRpc(ctx: Context): void {
  const host = ctx as unknown as {
    inject?: (deps: string[], fn: (subCtx: Record<string, unknown>) => void) => void;
    reflect?: { provide?: (name: string, value: unknown) => () => void };
  };
  if (typeof host?.inject !== 'function' || typeof host?.reflect?.provide !== 'function') return;
  host.inject(['typert'], (typertCtx) => {
    const get = typertCtx.get as ((key: string) => unknown) | undefined;
    const effect = typertCtx.effect as ((fn: () => unknown) => void) | undefined;
    const reflect = typertCtx.reflect as { provide: (name: string, value: unknown) => () => void } | undefined;
    const typert = typertCtx.typert as { register: (entry: Record<string, unknown>) => () => void } | undefined;
    if (!effect || !reflect || !typert) return;
    const service: Record<string, unknown> = {
      async read(input?: { rowId?: unknown }) {
        return readRowConfig(get?.('configEditor') as ConfigEditorLike | undefined, input?.rowId);
      },
      async save(input?: { rowId?: unknown; config?: unknown }) {
        return saveRowConfig(get?.('configEditor') as ConfigEditorLike | undefined, input?.rowId, input?.config);
      },
    };
    service.typertRemote = Object.freeze({ service, serviceKey: SERVICE, namespace: SERVICE });
    effect(() => reflect.provide(SERVICE, service));
    effect(() => typert.register({
      ...contribution,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    }));
  });
}
