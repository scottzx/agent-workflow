/** Official-parity DSH model & reasoning capsule + two-level popover for non-ACP sessions. */
import {
  createElement as h,
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

function loadOptional(loader) {
  try { return loader(); } catch { return undefined; }
}

const reactDom = loadOptional(() => require('react-dom'));
const uiPrimitives = loadOptional(() => require('@deepseek-ai/dsh-client-ui-primitives'));

const useSafeLayoutEffect = useLayoutEffect ?? useEffect;

function cx(...names) {
  return names.filter(Boolean).join(' ');
}

export function formatCopy(t, key, params) {
  let text = String(t(key, params));
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Put the account and official providers first, preserving every other relative order. */
export function orderModelProviders(groups) {
  const rank = id => (id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2);
  return [...(groups ?? [])].sort((left, right) => rank(left.id) - rank(right.id));
}

export function resolveLocalizedText(locale, text) {
  if (text == null) return '';
  if (typeof locale?.resolveText === 'function') return locale.resolveText(text);
  if (typeof text === 'string') return text;
  if (typeof text === 'object') {
    const lang = typeof document !== 'undefined' ? document.documentElement?.lang?.toLowerCase() ?? '' : '';
    const short = lang.split('-')[0];
    if (short && typeof text[short] === 'string') return text[short];
    if (typeof text.zh === 'string') return text.zh;
    if (typeof text.en === 'string') return text.en;
    const first = Object.values(text).find(value => typeof value === 'string');
    if (first !== undefined) return first;
  }
  return String(text);
}

function fallbackRankByName(items, rawQuery) {
  const query = String(rawQuery ?? '').trim().toLowerCase();
  if (!query) return items;
  const matched = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = String(item?.name ?? '').toLowerCase();
    if (name.startsWith(query)) {
      matched.push({ item, score: 0, index: i });
      continue;
    }
    const sub = name.indexOf(query);
    if (sub !== -1) {
      matched.push({ item, score: 1 + sub / 1000, index: i });
      continue;
    }
    let qi = 0;
    for (let ni = 0; ni < name.length && qi < query.length; ni++) {
      if (name[ni] === query[qi]) qi++;
    }
    if (qi === query.length) matched.push({ item, score: 2, index: i });
  }
  matched.sort((a, b) => a.score - b.score || a.index - b.index);
  return matched.map(entry => entry.item);
}

const rankByName = typeof uiPrimitives?.rankByName === 'function' ? uiPrimitives.rankByName : fallbackRankByName;
const isMobileDevice = typeof uiPrimitives?.isMobileDevice === 'function' ? uiPrimitives.isMobileDevice : () => false;
const observeStickyMenuGroups = typeof uiPrimitives?.observeStickyMenuGroups === 'function'
  ? uiPrimitives.observeStickyMenuGroups
  : () => () => {};

function FallbackIconChevronDown({ className }) {
  return h('svg', { className, width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M3 4.5L6 7.5L9 4.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}

function FallbackIconChevronRight({ className }) {
  return h('svg', { className, width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M4.5 3L7.5 6L4.5 9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}

function FallbackIconCheck() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M3 7.3L5.7 10L11 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}

function FallbackIconClose() {
  return h('span', { 'aria-hidden': 'true' }, '×');
}

function FallbackIconData({ className, size = 16 }) {
  return h('svg', { className, width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('circle', { cx: 8, cy: 8, r: 5.5, stroke: 'currentColor', strokeWidth: 1.3 }));
}

function FallbackIconWarning() {
  return h('span', { 'aria-hidden': 'true' }, '!');
}

function FallbackMenuGroup({ label, children }) {
  return h('div', { className: 'oacp-ms-fallbackGroup' },
    h('div', { className: 'oacp-ms-fallbackGroupLabel' }, label),
    children);
}

function FallbackTag({ className, children }) {
  return h('span', { className: cx('oacp-ms-fallbackTag', className) }, children);
}

function FallbackStateDot() {
  return h('span', { className: 'oacp-ms-fallbackDot', 'aria-hidden': 'true' }, '…');
}

function FallbackToast({ text }) {
  return h('div', { role: 'alert', className: 'oacp-ms-error' }, text);
}

const MenuSurfaceComp = uiPrimitives?.MenuSurface ?? 'div';
const MenuGroupComp = uiPrimitives?.MenuGroup ?? FallbackMenuGroup;
const InputComp = uiPrimitives?.Input ?? 'input';
const TagComp = uiPrimitives?.Tag ?? FallbackTag;
const ToastComp = uiPrimitives?.Toast ?? FallbackToast;
const StateDotComp = uiPrimitives?.StateDot ?? FallbackStateDot;
const IconCheckComp = uiPrimitives?.IconCheckOutlineRegular ?? FallbackIconCheck;
const IconChevronDownComp = uiPrimitives?.IconChevronDownOutlineRegular ?? FallbackIconChevronDown;
const IconChevronRightComp = uiPrimitives?.IconChevronRightOutlineRegular ?? FallbackIconChevronRight;
const IconCloseComp = uiPrimitives?.IconCloseFillRegular ?? FallbackIconClose;
const IconDataComp = uiPrimitives?.IconDataOutlineRegular ?? FallbackIconData;
const IconWarningComp = uiPrimitives?.IconWarningOutlineRegular ?? FallbackIconWarning;

export function getModelCommandIcon() {
  return uiPrimitives?.IconDataOutlineRegular;
}

const MODEL_SELECT_CSS = `
.oacp-ms-root {
  position: relative;
  min-width: 0;
}
.oacp-ms-trigger {
  anchor-name: var(--dsh-model-anchor);
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 360px;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  cursor: pointer;
}
@media (hover: hover) {
  .oacp-ms-trigger:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.oacp-ms-trigger:focus-visible:not([data-selection-focus]) {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.oacp-ms-trigger:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
.oacp-ms-triggerLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oacp-ms-triggerEffort {
  flex-shrink: 1000;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption);
}
.oacp-ms-triggerIcon {
  display: var(--dsh-composer-model-icon-display, none);
  flex: 0 0 auto;
}
.oacp-ms-triggerLabel,
.oacp-ms-triggerEffort {
  display: var(--dsh-composer-model-text-display, block);
}
.oacp-ms-chevron {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption);
  transition: transform 120ms ease;
}
.oacp-ms-chevronOpen {
  transform: rotate(180deg);
}
.oacp-ms-menu {
  box-sizing: border-box;
  position: fixed;
  position-anchor: var(--dsh-model-anchor);
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  left: 12px;
  right: anchor(right);
  bottom: calc(anchor(top) + 8px);
  align-self: safe end;
  justify-self: safe end;
  margin: 0;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: fit-content;
  height: fit-content;
  min-width: min(240px, calc(100vw - 24px));
  max-width: min(420px, calc(100vw - 24px));
  max-height: min(360px, calc(100dvh - 96px));
  overflow: hidden;
  padding: 4px;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.oacp-ms-status,
.oacp-ms-empty {
  padding: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.oacp-ms-error,
.oacp-ms-warning {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 3px;
  padding: 6px 7px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 16px;
}
.oacp-ms-warning {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-state-warn-label);
}
.oacp-ms-retry {
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.oacp-ms-searchRow {
  position: relative;
  flex-shrink: 0;
  margin: 2px 0 3px;
}
.oacp-ms-searchRow .oacp-ms-search {
  display: flex;
  height: auto;
  padding: 5px 7px;
  border: 0 solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
}
.oacp-ms-searchRow .oacp-ms-searchWithQuery {
  padding-right: 34px;
}
.oacp-ms-searchClear {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.oacp-ms-searchClear:focus-visible {
  outline: none;
  background: var(--dsw-alias-interactive-bg-hover);
}
@media (hover: hover) {
  .oacp-ms-searchClear:hover {
    outline: none;
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.oacp-ms-searchRow .oacp-ms-search:focus-within {
  border-color: transparent;
}
.oacp-ms-searchRow .oacp-ms-search input {
  padding: 0;
  font-size: 12px;
  line-height: normal;
}
@media (pointer: coarse) {
  .oacp-ms-searchRow .oacp-ms-search input {
    font-size: 16px;
  }
}
.oacp-ms-searchRow .oacp-ms-search input::placeholder {
  color: var(--dsw-alias-label-caption);
}
.oacp-ms-groups:not([hidden]) {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.oacp-ms-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: auto;
  min-width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  outline: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.oacp-ms-option:focus-visible,
.oacp-ms-optionActive:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.oacp-ms-modelOption {
  max-width: 100%;
}
@media (hover: hover) {
  .oacp-ms-option:not(.oacp-ms-modelOption):hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.oacp-ms-selected {
  background: transparent;
}
.oacp-ms-option:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
.oacp-ms-optionCopy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.oacp-ms-modelName {
  overflow: hidden;
  color: inherit;
  font-size: 13px;
  line-height: 18px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oacp-ms-badgedName {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 4px;
  vertical-align: baseline;
  white-space: nowrap;
}
.oacp-ms-badgedNameText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oacp-ms-badge {
  flex: none;
}
.oacp-ms-check {
  display: grid;
  place-items: center;
  flex: 0 0 14px;
  color: var(--dsw-alias-label-primary);
}
.oacp-ms-check svg {
  width: 14px;
  height: 14px;
}
.oacp-ms-cell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: auto;
  min-width: 100%;
  height: 34px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  text-align: left;
  outline: none;
}
.oacp-ms-cell:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
@media (hover: hover) {
  .oacp-ms-cell:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.oacp-ms-cellLabel {
  flex: 0 0 auto;
  white-space: nowrap;
}
.oacp-ms-cellValue {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
}
.oacp-ms-cellChevron {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  color: var(--dsw-alias-menu-icon);
}
.oacp-ms-fallbackGroupLabel {
  padding: 6px 8px 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.oacp-ms-fallbackTag {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.14));
}
`;

export function installModelSelectStyles(ctx) {
  ctx.effect(() => {
    if (typeof document === 'undefined' || !document.head) return () => {};
    const style = document.createElement('style');
    style.textContent = MODEL_SELECT_CSS;
    document.head.append(style);
    return () => style.remove();
  });
}

/** Shared Host-generation catalog store mirroring official ModelCatalogDirectory. */
export function createModelCatalogStore(ctx) {
  let snapshot = { value: null, status: 'idle', error: null };
  let generation = 0;
  let inflight;
  let disposed = false;
  const listeners = new Set();
  const reasoningByKey = new Map();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setSnapshot = next => {
    snapshot = next;
    notify();
  };

  const load = () => {
    if (snapshot.status === 'ready' && snapshot.value !== null) return Promise.resolve(snapshot.value);
    if (inflight !== undefined) return inflight;
    const currentGen = generation;
    setSnapshot({ ...snapshot, status: 'loading', error: null });
    const operation = ctx.remote.session.modelCatalog().then(response => {
      if (!response.ok) throw new Error(`${response.error.code ? `${response.error.code}: ` : ''}${response.error.message}`);
      if (!disposed && currentGen === generation) {
        for (const group of response.value.groups ?? []) {
          for (const model of group.models ?? []) {
            reasoningByKey.set(JSON.stringify([group.id, model.id]), model.reasoning);
          }
        }
        setSnapshot({ value: response.value, status: 'ready', error: null });
      }
      return response.value;
    }).catch(error => {
      if (!disposed && currentGen === generation) {
        setSnapshot({ ...snapshot, status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }).finally(() => {
      if (currentGen === generation && inflight === operation) inflight = undefined;
    });
    inflight = operation;
    return operation;
  };

  const invalidate = (clear = false) => {
    generation += 1;
    inflight = undefined;
    setSnapshot({ value: clear ? null : snapshot.value, status: 'idle', error: null });
  };

  const refresh = () => {
    invalidate(false);
    void load().catch(() => {});
  };

  const resetGeneration = () => {
    reasoningByKey.clear();
    invalidate(true);
    if (listeners.size > 0) void load().catch(() => {});
  };

  ctx.effect(() => () => {
    disposed = true;
    listeners.clear();
  });
  ctx.remote.$on('llm/adapters-updated', refresh);
  ctx.remote.$on('llm/models-updated', refresh);
  ctx.remote.$on('settings/document-updated', refresh);
  ctx.remote.$on('credentials/record-updated', refresh);
  ctx.remote.$on('credentials/reference-updated', refresh);

  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    reasoningFor: selection => (selection ? reasoningByKey.get(JSON.stringify([selection.provider, selection.model])) : undefined),
    load,
    refresh,
    resetGeneration,
  };
}

function renderPortal(node) {
  if (typeof reactDom?.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
    return reactDom.createPortal(node, document.body);
  }
  return node;
}

/** Official-parity composer model seat for ordinary DSH sessions. */
export function StandardModelSelect({
  sessionId,
  locked,
  projected,
  catalogStore,
  selectModel,
  resolveText,
  renderSlot,
  t,
}) {
  const catalogState = useSyncExternalStore(
    fn => catalogStore.subscribe(fn),
    () => catalogStore.getSnapshot(),
  );
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState('root');
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(null);
  const [selectionFocus, setSelectionFocus] = useState(false);
  const [pending, setPending] = useState(null);
  const [toast, setToast] = useState(null);
  const lastActionRef = useRef('load');
  const toastSeq = useRef(0);
  const selectGeneration = useRef(0);
  const mountedRef = useRef(true);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const menuRef = useRef(null);
  const groupsRef = useRef(null);
  const itemRefs = useRef([]);
  const paneFocus = useRef(null);
  const rawId = typeof useId === 'function' ? useId() : 'oacp-ms';
  const anchorStyle = { '--dsh-model-anchor': `--dsh-model-${rawId.replaceAll(':', '')}` };

  const compute = (factory, deps) => (typeof useMemo === 'function' ? useMemo(factory, deps) : factory());

  const accountProviderName = t('providerAccount');
  const groups = compute(() => orderModelProviders(catalogState.value?.groups ?? []).map(group => ({
    ...group,
    provider: {
      id: group.id,
      name: group.id === 'deepseek-account' ? accountProviderName : group.name,
    },
  })), [catalogState.value, accountProviderName]);

  const choices = compute(() => groups.flatMap(group =>
    (group.models ?? []).map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
      },
    }))), [groups]);

  const showSearch = choices.length > 4;
  const filteredGroups = compute(() => groups.map(group => ({
    ...group,
    models: rankByName(group.models ?? [], showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [groups, query, showSearch]);

  const visibleModels = compute(() => filteredGroups.flatMap(group =>
    group.models.map(model => ({ provider: group.id, model: model.id }))), [filteredGroups]);

  const rawCurrent = projected?.next ?? catalogState.value?.default ?? null;
  const current = rawCurrent && rawCurrent.provider !== '1agents-acp' ? rawCurrent : null;
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === current?.provider && model.model === current?.model);
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1);
  const selectedIndex = current === null
    ? -1
    : choices.findIndex(choice => choice.selection.provider === current.provider && choice.selection.model === current.model);
  const currentChoice = choices[selectedIndex];
  const reasoning = currentChoice?.model.reasoning;
  const cachedReasoning = current ? catalogStore.reasoningFor(current) : undefined;
  const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort;
  const retainedEffortValue = current?.reasoningEffort ?? cachedReasoning?.defaultEffort;
  const retainedEffort = retainedEffortValue === undefined
    ? undefined
    : cachedReasoning?.efforts?.find(level => level.id === retainedEffortValue)?.name ?? retainedEffortValue;
  const effortLabel = currentChoice === undefined
    ? undefined
    : reasoning === undefined
      ? retainedEffort
      : effectiveEffort === undefined
        ? t('effortDefault')
        : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort;

  const effortChoices = compute(() => (reasoning === undefined
    ? []
    : [
      ...(reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effortDefault') }]
        : []),
      ...(reasoning.efforts ?? []).map(effort => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ]), [reasoning, t]);

  const failures = catalogState.value?.failures ?? [];
  const busy = pending !== null;

  useEffect(() => {
    selectGeneration.current += 1;
    setPending(null);
    setOpen(false);
    setPane('root');
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    void catalogStore.load().catch(() => {});
  }, [catalogStore, sessionId]);

  useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
    const closeOutside = event => {
      if (rootRef.current?.contains?.(event.target) === true) return;
      if (menuRef.current?.contains?.(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => { document.removeEventListener('mousedown', closeOutside); };
  }, [open]);

  useSafeLayoutEffect(() => {
    if (!showSearch) {
      setQuery('');
      setHighlightedIndex(null);
    }
  }, [showSearch]);

  const previousShowSearch = useRef(showSearch);
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch;
    previousShowSearch.current = showSearch;
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null);
    paneFocus.current = null;
    if (!open || intent === null) return;
    if (intent === 'drill') {
      if (pane === 'model' && showSearch && !isMobileDevice()) {
        searchRef.current?.focus?.();
        return;
      }
      const checked = menuRef.current?.querySelector?.('[role="menuitemradio"][aria-checked="true"]:not([disabled])');
      const target = checked ?? itemRefs.current.find(item => item != null && !item.disabled);
      (target ?? triggerRef.current)?.focus?.();
      return;
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0];
    (cell != null && !cell.disabled ? cell : triggerRef.current)?.focus?.();
  }, [open, pane, showSearch]);

  useEffect(() => {
    const viewport = groupsRef.current;
    if (!viewport) return undefined;
    return observeStickyMenuGroups(viewport);
  }, [open, pane, filteredGroups]);

  useSafeLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      itemRefs.current[activeModelIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, pane, activeModelIndex, visibleModels]);

  const reload = () => {
    lastActionRef.current = 'load';
    void catalogStore.load().catch(() => {});
  };

  const forceReload = () => {
    lastActionRef.current = 'load';
    catalogStore.refresh();
  };

  const show = () => {
    setSelectionFocus(false);
    triggerRef.current?.focus?.();
    setQuery('');
    setHighlightedIndex(null);
    if (currentChoice === undefined) paneFocus.current = 'drill';
    setPane(currentChoice === undefined ? 'model' : 'root');
    setOpen(true);
    reload();
  };

  const changeQuery = next => {
    setQuery(next);
    setHighlightedIndex(0);
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPane('root');
    if (restoreFocus) { const focus = () => { triggerRef.current?.focus?.(); }; if (typeof queueMicrotask === 'function') queueMicrotask(focus); else void Promise.resolve().then(focus); }
  };

  const closeAfterSelection = () => {
    setSelectionFocus(true);
    close(true);
  };

  const drill = next => {
    setQuery('');
    setHighlightedIndex(null);
    paneFocus.current = 'drill';
    setPane(next);
  };

  const back = from => {
    paneFocus.current = from;
    setPane('root');
  };

  const moveFocus = offset => {
    const items = Array.from(menuRef.current?.querySelectorAll?.(
      'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), button[role="switch"]:not([disabled])',
    ) ?? []);
    if (items.length === 0) return;
    const active = items.findIndex(item => item === document.activeElement);
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length;
    items[next]?.focus?.();
  };

  const submit = selection => {
    lastActionRef.current = 'select';
    setSelectionFocus(true);
    triggerRef.current?.focus?.();
    const gen = ++selectGeneration.current;
    setPending(selection);
    void selectModel(selection).then(result => {
      if (gen !== selectGeneration.current) return;
      setPending(null);
      if (result === undefined) return;
      if (result.ok) {
        if (mountedRef.current) closeAfterSelection();
        return;
      }
      const error = result.error ?? { code: 'error', message: 'unknown error' };
      toastSeq.current += 1;
      setToast({
        seq: toastSeq.current,
        text: error.code === 'session/writer-held'
          ? t('errorSessionInUse')
          : formatCopy(t, 'errorAction', { message: error.code ? `${error.code}: ${error.message}` : error.message }),
      });
    }, error => {
      if (gen !== selectGeneration.current) return;
      setPending(null);
      toastSeq.current += 1;
      setToast({
        seq: toastSeq.current,
        text: formatCopy(t, 'errorAction', { message: error instanceof Error ? error.message : String(error) }),
      });
    });
  };

  const choose = selection => {
    if (current?.provider === selection.provider && current.model === selection.model) {
      closeAfterSelection();
      return;
    }
    submit(selection);
  };

  const chooseEffort = effort => {
    if (current === null) return;
    if (effectiveEffort === effort) {
      closeAfterSelection();
      return;
    }
    submit({
      provider: current.provider,
      model: current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
  };

  const onRootKeyDown = event => {
    if (event.nativeEvent?.isComposing) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      if (pane !== 'root' && currentChoice !== undefined) back(pane);
      else close(true);
      return;
    }
    if (!open) return;
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length);
        searchRef.current?.focus?.();
      }
      return;
    }
    if (pane === 'model' && showSearch && typeof HTMLInputElement !== 'undefined' && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return;
      event.preventDefault();
      const highlighted = visibleModels[activeModelIndex];
      if (!busy && highlighted !== undefined) choose(highlighted);
      return;
    }
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault();
        if (pane !== 'root' && currentChoice !== undefined) back(pane);
        else close(true);
        return;
      }
      const focused = typeof document !== 'undefined' ? document.activeElement : null;
      const rows = Array.from(menuRef.current?.querySelectorAll?.(
        'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), button[role="switch"]:not([disabled])',
      ) ?? []);
      if (typeof HTMLButtonElement !== 'undefined' && focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault();
        focused.click();
        return;
      }
      if (focused !== triggerRef.current) return;
      event.preventDefault();
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null);
        searchRef.current?.focus?.();
        return;
      }
      const checked = menuRef.current?.querySelector?.('[role="menuitemradio"][aria-checked="true"]:not([disabled])');
      (checked ?? rows.find(item => !item.disabled))?.focus?.();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const onBlur = event => {
    const related = event.relatedTarget;
    if (related && (rootRef.current?.contains?.(related) === true || menuRef.current?.contains?.(related) === true)) return;
    close();
  };

  const waiting = currentChoice === undefined && (catalogState.status === 'loading' || catalogState.status === 'idle');
  const modelLabel = waiting
    ? t('loadingModels')
    : currentChoice?.model.name ?? t('modelFallback');
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
  const triggerAria = waiting
    ? t('loadingModels')
    : currentChoice === undefined
      ? t('modelFallback')
      : effortLabel === undefined
        ? formatCopy(t, 'triggerAria', { model: modelLabel })
        : formatCopy(t, 'triggerAriaEffort', { model: modelLabel, effort: effortLabel });

  const renderModelLabel = (provider, model, placement, selected) => {
    const fallback = model.badge === undefined
      ? model.name
      : h('span', { className: 'oacp-ms-badgedName' },
          placement === 'trigger'
            ? h(Fragment, null, h(TagComp, { className: 'oacp-ms-badge', tone: model.badge.tone }, resolveText(model.badge.text)), ' ')
            : null,
          h('span', { className: 'oacp-ms-badgedNameText' }, model.name),
          placement === 'trigger'
            ? null
            : h(Fragment, null, ' ', h(TagComp, { className: 'oacp-ms-badge', tone: model.badge.tone }, resolveText(model.badge.text))));
    const rendered = typeof renderSlot === 'function'
      ? renderSlot('conversation.input.model.label', { provider, model, placement, selected }, { fallback })
      : fallback;
    return h('span', { 'data-provider-id': provider.id, 'data-model-id': model.id }, rendered);
  };

  let itemIndex = 0;
  let modelIndex = 0;
  const itemRef = () => {
    const at = itemIndex++;
    return node => { itemRefs.current[at] = node; };
  };

  const menu = open ? renderPortal(
    h(MenuSurfaceComp, {
      ref: menuRef,
      id: `${rawId}-menu`,
      className: 'oacp-ms-menu',
      style: anchorStyle,
      role: pane === 'model' ? 'group' : 'menu',
      'aria-label': t('menuAria'),
      'aria-busy': catalogState.status === 'loading' || busy,
    },
    pane === 'root' && h(Fragment, null,
      h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitem',
        className: 'oacp-ms-cell',
        onClick: () => { drill('model'); },
      },
      h('span', { className: 'oacp-ms-cellLabel' }, t('menuModel')),
      h('span', { className: 'oacp-ms-cellValue' },
        currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'menu', true)),
      h(IconChevronRightComp, { className: 'oacp-ms-cellChevron' })),
      reasoning !== undefined && h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitem',
        className: 'oacp-ms-cell',
        onClick: () => { drill('effort'); },
      },
      h('span', { className: 'oacp-ms-cellLabel' }, t('menuEffort')),
      h('span', { className: 'oacp-ms-cellValue' }, effortLabel),
      h(IconChevronRightComp, { className: 'oacp-ms-cellChevron' })),
      typeof renderSlot === 'function'
        ? renderSlot('conversation.input.model.options', {
          locked: Boolean(locked) || busy,
          dismiss: () => {
            close();
            triggerRef.current?.focus?.();
          },
          reportFailure: message => { setToast({ seq: ++toastSeq.current, text: message }); },
        })
        : null),
    pane === 'model' && h(Fragment, null,
      showSearch && h('div', { className: 'oacp-ms-searchRow' },
        h(InputComp, {
          ref: searchRef,
          className: cx('oacp-ms-search', query !== '' && 'oacp-ms-searchWithQuery'),
          type: 'text',
          role: 'searchbox',
          'aria-label': t('searchPlaceholder'),
          'aria-controls': `${rawId}-models`,
          'aria-activedescendant': activeModelIndex < 0 ? undefined : `${rawId}-model-${activeModelIndex}`,
          placeholder: t('searchPlaceholder'),
          value: query,
          readOnly: busy,
          onChange: event => { changeQuery(event.target.value); },
        }),
        query !== '' && h('button', {
          type: 'button',
          className: 'oacp-ms-searchClear',
          'aria-label': t('searchClear'),
          disabled: busy,
          onClick: () => {
            changeQuery('');
            searchRef.current?.focus?.();
          },
        }, h(IconCloseComp, null))),
      catalogState.status === 'loading' && h('div', { className: 'oacp-ms-status' }, t('statusLoading')),
      catalogState.error !== null && lastActionRef.current === 'load' && h('div', { className: 'oacp-ms-error' },
        h('span', null, formatCopy(t, 'errorAction', { message: catalogState.error })),
        h('button', { type: 'button', className: 'oacp-ms-retry', onClick: forceReload }, t('retry'))),
      failures.map(failure => h('div', { className: 'oacp-ms-warning', key: failure.id },
        h('span', null, formatCopy(t, 'warningGroupLoad', {
          name: failure.id === 'deepseek-account' ? accountProviderName : failure.name,
          message: failure.message,
        })),
        h('button', { type: 'button', className: 'oacp-ms-retry', onClick: forceReload }, t('retry')))),
      h('div', {
        ref: groupsRef,
        id: `${rawId}-models`,
        className: 'oacp-ms-groups scrollable',
        role: 'menu',
        'aria-label': t('menuModel'),
        hidden: filteredGroups.length === 0,
      },
      filteredGroups.map(group => h(MenuGroupComp, { key: group.id, label: group.provider.name },
        group.models.map(model => {
          const index = modelIndex++;
          const selected = current?.provider === group.id && current.model === model.id;
          return h('button', {
            ref: itemRef(),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            id: `${rawId}-model-${index}`,
            tabIndex: showSearch ? -1 : 0,
            onFocus: () => { setHighlightedIndex(index); },
            'data-highlighted': index === activeModelIndex ? '' : undefined,
            className: cx('oacp-ms-option', 'oacp-ms-modelOption', selected && 'oacp-ms-selected', index === activeModelIndex && 'oacp-ms-optionActive'),
            onMouseMove: busy || index === activeModelIndex ? undefined : () => {
              if (showSearch) setHighlightedIndex(index);
              else itemRefs.current[index]?.focus?.();
            },
            key: model.id,
            title: model.name,
            disabled: busy,
            onClick: () => { choose({ provider: group.id, model: model.id }); },
          },
          h('span', { className: 'oacp-ms-optionCopy' },
            h('span', { className: 'oacp-ms-modelName' }, renderModelLabel(group.provider, model, 'option', selected))),
          h('span', { className: 'oacp-ms-check' },
            pending?.provider === group.id && pending.model === model.id
              ? h(StateDotComp, { state: 'ongoing' })
              : selected ? h(IconCheckComp, null) : null));
        })))),
      catalogState.status === 'ready' && filteredGroups.length === 0 && h('div', { className: 'oacp-ms-empty', role: 'status' },
        t(choices.length === 0 ? 'emptyModels' : 'searchEmpty'))),
    pane === 'effort' && h(Fragment, null,
      catalogState.error !== null && lastActionRef.current === 'load' && h('div', { className: 'oacp-ms-error' },
        h('span', null, formatCopy(t, 'errorAction', { message: catalogState.error })),
        h('button', { type: 'button', className: 'oacp-ms-retry', onClick: forceReload }, t('actionReload'))),
      h('div', { className: 'oacp-ms-groups scrollable' },
        effortChoices.length === 0
          ? h('div', { className: 'oacp-ms-empty' }, t('emptyEfforts'))
          : effortChoices.map(level => h('button', {
            ref: itemRef(),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': effectiveEffort === level.effort,
            className: cx('oacp-ms-option', effectiveEffort === level.effort && 'oacp-ms-selected'),
            key: level.key,
            disabled: busy,
            onClick: () => { chooseEffort(level.effort); },
          },
          h('span', { className: 'oacp-ms-optionCopy' },
            h('span', { className: 'oacp-ms-modelName' }, level.label)),
          h('span', { className: 'oacp-ms-check' },
            pending !== null && pending.provider === current?.provider
              && pending.model === current?.model && pending.reasoningEffort === level.effort
              ? h(StateDotComp, { state: 'ongoing' })
              : effectiveEffort === level.effort ? h(IconCheckComp, null) : null)))))),
  ) : null;

  return h('div', {
    ref: rootRef,
    className: 'oacp-ms-root',
    'data-oneagents-acp-controls': 'dsh',
    onKeyDown: onRootKeyDown,
    onBlur,
    onMouseDown: event => {
      if (typeof Element !== 'undefined' && event.target instanceof Element && event.target.closest('button') !== null) {
        event.preventDefault();
      }
    },
  },
  h('button', {
    ref: triggerRef,
    type: 'button',
    className: 'oacp-ms-trigger',
    style: anchorStyle,
    'aria-label': triggerAria,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? `${rawId}-menu` : undefined,
    title: triggerLabel,
    'aria-busy': busy,
    'data-selection-focus': selectionFocus ? '' : undefined,
    onBlur: () => { setSelectionFocus(false); },
    disabled: Boolean(locked),
    onClick: () => { if (open) close(true); else show(); },
  },
  h(IconDataComp, { className: 'oacp-ms-triggerIcon', size: 16 }),
  h('span', { className: 'oacp-ms-triggerLabel' },
    currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)),
  effortLabel !== undefined && h('span', { className: 'oacp-ms-triggerEffort' }, effortLabel),
  busy
    ? h(StateDotComp, { state: 'ongoing' })
    : h(IconChevronDownComp, { className: cx('oacp-ms-chevron', open && 'oacp-ms-chevronOpen') })),
  menu,
  toast !== null && h(ToastComp, {
    key: toast.seq,
    text: toast.text,
    icon: h(IconWarningComp, null),
    anchor: rootRef.current?.closest?.('[data-composer-card]') ?? null,
    onDone: () => { setToast(null); },
  }));
}
