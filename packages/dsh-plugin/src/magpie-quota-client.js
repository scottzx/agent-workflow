/** Settings page for the bundled magpie quota host row. */
import { createElement as h, useEffect, useRef, useState } from 'react'

const NS = 'settings.magpie-quota'
const QUOTAS_PATH = 'api/magpie-quota/quotas'
const USAGE_PATH = 'api/magpie-quota/usage'
const routeUrl = rel => (typeof URL === 'function' && typeof document !== 'undefined' && document && document.baseURI
  ? new URL(rel, document.baseURI).href : rel)
const ORDER_KEY = 'magpie-quota.order.v2'
const REFRESH_MS = 60_000
const ROW_MODULE = '@1agents/acp-service/magpie-quota'
const RING_RADIUS = 17
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const dictionaries = {
  zh: {
    nav: '额度',
    title: 'Magpie 额度',
    intro: '读取本机 magpie 网关用量，每分钟自动刷新。',
    refresh: '刷新',
    refreshing: '刷新中…',
    accounts: '{count} 个账户',
    providers: '{count} 个供应商',
    calls: '{count} 次调用 · {period}',
    cost: '${cost} · {period}',
    used: '已用 {value}',
    remaining: '剩余 {value}',
    resets: '{time} 重置',
    updatedAt: '更新于 {time}',
    stale: '可能已过期',
    readAt: '读取 {time}',
    balance: '余额：{value}',
    noWindows: '暂无额度窗口',
    loading: '正在读取 magpie 额度…',
    empty: 'magpie 目前没有额度记录。',
    error: '读取 magpie 额度失败：{message}',
    hint: '请保持 magpie 运行，并使用默认网关地址 http://127.0.0.1:3425。',
    enabled: '插件已启用',
    disabled: '插件已停用',
    enableHint: '切换额度插件的启用状态（与插件页的开关相同）。',
    toggling: '切换中…',
    disabledNotice: '已停用。可在插件页重新启用。',
    restartNotice: '重启 DSH 后生效。',
    toggleFailed: '切换插件状态失败：{message}',
    dragHint: '拖动以调整账户顺序',
    groupDragHint: '拖动以调整供应商顺序',
    allAccounts: '全部 {count} 个账号',
    active: '已用',
    window5h: '5 小时',
    window7d: '7 天',
    collapse: '收起账号',
    expand: '展开账号',
  },
  en: {
    nav: 'Quota',
    title: 'Magpie quota',
    intro: 'Usage from the local magpie gateway. Refreshes every minute.',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    accounts: '{count} accounts',
    providers: '{count} providers',
    calls: '{count} calls · {period}',
    cost: '${cost} · {period}',
    used: '{value} used',
    remaining: '{value} left',
    resets: 'Resets {time}',
    updatedAt: 'Updated {time}',
    stale: 'possibly outdated',
    readAt: 'Read {time}',
    balance: 'Balance: {value}',
    noWindows: 'No usage window',
    loading: 'Reading magpie quotas…',
    empty: 'No quota records yet.',
    error: 'Could not read magpie quotas: {message}',
    hint: 'Keep magpie running with its gateway at http://127.0.0.1:3425.',
    enabled: 'Plugin on',
    disabled: 'Plugin off',
    enableHint: 'Turn the quota plugin on or off (same as the switch in Plugins).',
    toggling: 'Changing…',
    disabledNotice: 'Turned off. Re-enable it on the Plugins page.',
    restartNotice: 'Takes effect after DSH restarts.',
    toggleFailed: 'Could not change plugin state: {message}',
    dragHint: 'Drag to reorder accounts',
    groupDragHint: 'Drag to reorder providers',
    allAccounts: 'All {count} accounts',
    active: 'Active',
    window5h: '5 hours',
    window7d: '7 days',
    collapse: 'Collapse accounts',
    expand: 'Expand accounts',
  },
}

function fmt(t, key, vars) {
  let text = t(key)
  if (vars) {
    for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
  }
  return text
}

function percent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, Math.round(number)))
}

function time(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function accountKey(account) {
  return [account.provider, account.user, account.name].map(value => String(value ?? '')).join('|')
}

function groupKey(account) {
  return String(account.provider || account.name || 'unknown')
}

function loadOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function saveOrder(groups) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify({
      groups: groups.map(group => group.key),
      accounts: Object.fromEntries(groups.map(group => [group.key, group.accounts.map(accountKey)])),
    }))
  } catch (_) {
    // Ordering stays in memory when local storage is unavailable.
  }
}

function orderByKey(list, keys, keyOf = accountKey) {
  if (!Array.isArray(keys)) return list
  const byKey = new Map(list.map(item => [keyOf(item), item]))
  const result = []
  for (const key of keys) {
    const found = byKey.get(key)
    if (found) {
      result.push(found)
      byKey.delete(key)
    }
  }
  return result.concat(Array.from(byKey.values()))
}

function orderedGroups(accounts) {
  const byProvider = new Map()
  for (const account of accounts) {
    const key = groupKey(account)
    if (!byProvider.has(key)) byProvider.set(key, [])
    byProvider.get(key).push(account)
  }
  const saved = loadOrder()
  const groups = Array.from(byProvider, ([key, list]) => ({
    key,
    name: list[0] && list[0].name ? list[0].name : key,
    accounts: list,
  }))
  return orderByKey(groups, saved.groups, group => group.key).map(group => ({
    ...group,
    accounts: orderByKey(group.accounts, saved.accounts && saved.accounts[group.key]),
  }))
}

function windowLabel(name, t) {
  const text = String(name || '').toLowerCase()
  if (/5\s*(h|hour)/.test(text)) return t('window5h')
  if (/7\s*(d|day)|weekly/.test(text)) return t('window7d')
  return String(name || '')
}

function groupWindows(group, t) {
  const cells = new Map()
  for (const account of group.accounts) {
    const windows = Array.isArray(account.windows) ? account.windows : []
    for (const win of windows) {
      const label = windowLabel(win.name, t)
      if (!cells.has(label)) cells.set(label, { label, total: 0, count: 0 })
      const cell = cells.get(label)
      cell.total += percent(win.used)
      cell.count += 1
    }
  }
  return Array.from(cells.values()).map(cell => ({ label: cell.label, used: cell.total / cell.count }))
}

async function errorMessage(response) {
  try {
    const body = await response.json()
    if (body && body.error) return String(body.error)
  } catch (_) {
    // Keep the HTTP status when the body is not the expected JSON.
  }
  return 'gateway ' + response.status
}

async function readUsage(signal) {
  try {
    const response = await fetch(routeUrl(USAGE_PATH), { signal, cache: 'no-store' })
    if (!response.ok) return null
    return await response.json()
  } catch (_) {
    return null
  }
}

async function readQuota(signal) {
  const quotaResponse = await fetch(routeUrl(QUOTAS_PATH), { signal, cache: 'no-store' })
  if (!quotaResponse.ok) throw new Error(await errorMessage(quotaResponse))
  const quota = await quotaResponse.json()
  const usage = await readUsage(signal)
  return {
    accounts: Array.isArray(quota && quota.data) ? quota.data : [],
    usage,
  }
}

const STYLE = `
.mq-section{display:flex;flex-direction:column;gap:10px;max-width:960px;color:var(--dsw-alias-label-primary)}
.mq-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.mq-heading{margin:0;font-size:15px;font-weight:600;line-height:22px}
.mq-actions{display:flex;align-items:center;gap:8px}
.mq-refresh{border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:18px;padding:3px 9px;cursor:pointer}
.mq-refresh:disabled{opacity:0.55;cursor:default}
.mq-switch{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer;padding:3px 0}
.mq-switch-track{position:relative;width:26px;height:15px;border-radius:8px;background:var(--dsw-alias-state-business-primary);flex:none}
.mq-switch-track[data-on='false']{background:var(--dsw-alias-border-l2)}
.mq-switch-knob{position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary-on-accent,var(--dsw-alias-bg-layer-2,#fff))}
.mq-switch-track[data-on='false'] .mq-switch-knob{right:auto;left:2px}
.mq-refresh:focus-visible,.mq-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.mq-intro{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mq-summary{display:flex;flex-wrap:wrap;gap:3px 14px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mq-groups{display:flex;flex-direction:column;gap:9px}
.mq-group{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-card-fill,var(--dsw-alias-bg-layer-2,transparent))}
.mq-group[data-dragover='true']{border-color:var(--dsw-alias-state-business-primary)}
.mq-group-head{display:flex;align-items:center;gap:7px}
.mq-group-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:19px;text-transform:uppercase;letter-spacing:0.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mq-count,.mq-active{flex:none;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mq-collapse{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;padding:2px 4px}
.mq-collapse:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.mq-group-summary{display:flex;flex-wrap:wrap;gap:8px 18px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,transparent);padding:7px 9px}
.mq-summary-cell{flex:1;min-width:140px;display:flex;flex-direction:column;gap:4px}
.mq-summary-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:16px}
.mq-summary-label{color:var(--dsw-alias-label-secondary)}
.mq-summary-value{color:var(--dsw-alias-label-primary);font-weight:600}
.mq-summary-track{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.mq-summary-fill{height:100%;background:var(--dsw-alias-state-business-primary)}
.mq-children{display:flex;flex-direction:column;gap:7px}
.mq-children .mq-card{background:transparent}
.mq-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.mq-card{display:flex;flex-direction:column;gap:6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 11px;background:var(--dsw-alias-card-fill,var(--dsw-alias-bg-layer-2,transparent))}
.mq-card[data-dragover='true']{border-color:var(--dsw-alias-state-business-primary)}
.mq-card-head{display:flex;align-items:center;gap:7px;min-width:0}
.mq-drag{flex:none;cursor:grab;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:16px;user-select:none;padding:0 1px}
.mq-drag:active{cursor:grabbing}
.mq-card-title{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px}
.mq-name{font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.mq-user{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mq-badge{flex:none;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mq-donuts{display:flex;gap:12px;overflow-x:auto;padding:1px 0 3px;scrollbar-width:thin}
.mq-donut{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:2px;width:58px}
.mq-ring{position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center}
.mq-ring svg{position:absolute;inset:0}
.mq-ring-value{position:relative;font-size:11px;font-weight:600;line-height:14px}
.mq-donut-label{font-size:10px;line-height:13px;text-align:center;color:var(--dsw-alias-label-tertiary);width:58px;overflow-wrap:anywhere}
.mq-donut[data-low='true'] .mq-ring-value{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-business-primary))}
.mq-meta{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.mq-balance{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mq-empty,.mq-loading{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mq-error{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
`

function Donut({ win, t }) {
  const used = percent(win.used)
  const remaining = win.remaining === undefined || win.remaining === null
    ? 100 - used : percent(win.remaining)
  const low = remaining <= 15
  const stroke = low
    ? 'var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-business-primary))'
    : 'var(--dsw-alias-state-business-primary)'
  const dash = (used / 100) * RING_LENGTH
  const label = String(win.name || '')
  return h('div', { className: 'mq-donut', 'data-low': low ? 'true' : 'false' },
    h('div', {
      className: 'mq-ring', role: 'progressbar',
      'aria-label': label,
      'aria-valuetext': fmt(t, 'used', { value: used + '%' }) + ', '
        + fmt(t, 'remaining', { value: remaining + '%' }),
      'aria-valuenow': used, 'aria-valuemin': 0, 'aria-valuemax': 100,
      title: [fmt(t, 'used', { value: used + '%' }), win.display || '',
        win.resetsAt ? fmt(t, 'resets', { time: time(win.resetsAt) }) : ''].filter(Boolean).join(' · '),
    },
    h('svg', { viewBox: '0 0 44 44', width: 44, height: 44, 'aria-hidden': 'true' },
      h('circle', {
        cx: 22, cy: 22, r: RING_RADIUS, fill: 'none',
        stroke: 'var(--dsw-alias-border-l2)', 'stroke-width': 4,
      }),
      h('circle', {
        cx: 22, cy: 22, r: RING_RADIUS, fill: 'none', stroke,
        'stroke-width': 4, 'stroke-linecap': 'round',
        'stroke-dasharray': dash + ' ' + RING_LENGTH,
        transform: 'rotate(-90 22 22)',
      }),
    ),
    h('span', { className: 'mq-ring-value' }, used + '%'),
    ),
    h('span', { className: 'mq-donut-label' }, label),
  )
}

function AccountCard({ account, t, index, onDragStart, onDragEnd, onDragOver, onDrop, dragOver }) {
  const windows = Array.isArray(account.windows) ? account.windows : []
  return h('article', {
    className: 'mq-card', 'data-dragover': dragOver ? 'true' : 'false',
    onDragOver: event => onDragOver(event, index),
    onDrop: event => onDrop(event, index),
  },
    h('div', { className: 'mq-card-head' },
      h('span', {
        className: 'mq-drag', draggable: true, title: t('dragHint'),
        onDragStart: event => onDragStart(event, index), onDragEnd,
      }, '⠿'),
      h('div', { className: 'mq-card-title' },
        h('span', { className: 'mq-name' }, account.name || account.provider || ''),
        account.user ? h('span', { className: 'mq-user' }, String(account.user)) : null,
      ),
      account.plan ? h('span', { className: 'mq-badge' }, String(account.plan)) : null,
    ),
    windows.length
      ? h('div', { className: 'mq-donuts' }, windows.map((win, i) =>
        h(Donut, { key: String(win.name || i), win, t })))
      : h('p', { className: 'mq-empty' }, t('noWindows')),
    account.balance || account.readAt
      ? h('div', { className: 'mq-meta' },
        account.balance ? fmt(t, 'balance', { value: String(account.balance) }) : null,
        account.readAt ? ' · ' + fmt(t, 'readAt', { time: time(account.readAt) }) : null)
      : null,
    account.error ? h('div', { className: 'mq-error' }, String(account.error)) : null,
  )
}

function GroupCard({
  group, t, index, expanded, onToggle, onDragStart, onDragEnd, onDragOver, onDrop, dragOver,
  onChildDragStart, onChildDragOver, onChildDrop, childDragOver,
}) {
  const windows = groupWindows(group, t)
  return h('section', {
    className: 'mq-group', 'data-dragover': dragOver ? 'true' : 'false',
    onDragOver: event => onDragOver(event, index),
    onDrop: event => onDrop(event, index),
  },
    h('div', { className: 'mq-group-head' },
      h('span', {
        className: 'mq-drag', draggable: true, title: t('groupDragHint'),
        onDragStart: event => onDragStart(event, index), onDragEnd,
      }, '⠿'),
      h('span', { className: 'mq-group-title' }, group.name),
      h('span', { className: 'mq-count' }, fmt(t, 'allAccounts', { count: group.accounts.length })),
      h('span', { className: 'mq-active' }, t('active')),
      h('button', {
        type: 'button', className: 'mq-collapse', 'aria-expanded': expanded ? 'true' : 'false',
        title: expanded ? t('collapse') : t('expand'), onClick: () => onToggle(group.key),
      }, expanded ? '⌃' : '⌄'),
    ),
    h('div', { className: 'mq-group-summary' }, windows.map(cell =>
      h('div', { className: 'mq-summary-cell', key: cell.label },
        h('div', { className: 'mq-summary-top' },
          h('span', { className: 'mq-summary-label' }, cell.label),
          h('span', { className: 'mq-summary-value' },
            fmt(t, 'used', { value: cell.used.toFixed(1) + '%' }))),
        h('div', {
          className: 'mq-summary-track', role: 'progressbar', 'aria-label': cell.label,
          'aria-valuenow': Math.round(cell.used), 'aria-valuemin': 0, 'aria-valuemax': 100,
        }, h('div', { className: 'mq-summary-fill', style: { width: cell.used + '%' } }))))),
    expanded ? h('div', { className: 'mq-children' }, group.accounts.map((account, childIndex) =>
      h(AccountCard, {
        key: accountKey(account), account, t, index: childIndex,
        onDragStart: event => onChildDragStart(event, group.key, childIndex), onDragEnd,
        onDragOver: event => onChildDragOver(event, group.key, childIndex),
        onDrop: event => onChildDrop(event, group.key, childIndex),
        dragOver: childDragOver === group.key + '/' + childIndex,
      }))) : null,
  )
}

function QuotaSection({ t, manager }) {
  const [nonce, setNonce] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [groups, setGroups] = useState([])
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [usage, setUsage] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [childDragOver, setChildDragOver] = useState(null)
  const [row, setRow] = useState(null)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleNotice, setToggleNotice] = useState('')
  const dragIndex = useRef(null)
  const childDrag = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    readQuota(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setGroups(orderedGroups(result.accounts))
      setUsage(result.usage)
      setLoading(false)
    }, (failure) => {
      if (controller.signal.aborted) return
      setError(failure instanceof Error ? failure.message : String(failure))
      setLoading(false)
    })
    return () => controller.abort()
  }, [nonce])

  useEffect(() => {
    const timer = setInterval(() => setNonce(value => value + 1), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!manager || !manager.listPlugins) return
    let active = true
    manager.listPlugins().then(listed => {
      if (!active || !listed || !listed.ok) return
      const listedValue = listed.value
      const entries = Array.isArray(listedValue) ? listedValue : listedValue && listedValue.entries
      if (!Array.isArray(entries)) return
      const found = entries.find(entry => entry.moduleName === ROW_MODULE)
      if (found && found.entryId) setRow({ entryId: found.entryId, enabled: found.enabled !== false })
    }, () => {})
    return () => { active = false }
  }, [manager])

  function onDragStart(event, index) {
    dragIndex.current = index
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }

  function onDragOver(event, index) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragOver !== index) setDragOver(index)
  }

  function onDrop(event, index) {
    event.preventDefault()
    const from = dragIndex.current
    dragIndex.current = null
    setDragOver(null)
    if (from === null || from === index) return
    setGroups(previous => {
      const next = previous.slice()
      const [moved] = next.splice(from, 1)
      if (!moved) return previous
      next.splice(index, 0, moved)
      saveOrder(next)
      return next
    })
  }

  function onDragEnd() {
    dragIndex.current = null
    childDrag.current = null
    setDragOver(null)
    setChildDragOver(null)
  }

  function toggleGroup(key) {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function onChildDragStart(event, key, index) {
    event.stopPropagation()
    childDrag.current = { key, index }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key + '/' + index)
  }

  function onChildDragOver(event, key, index) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const target = key + '/' + index
    if (childDragOver !== target) setChildDragOver(target)
  }

  function onChildDrop(event, key, index) {
    event.preventDefault()
    event.stopPropagation()
    const from = childDrag.current
    childDrag.current = null
    setChildDragOver(null)
    if (!from || from.key !== key || from.index === index) return
    setGroups(previous => {
      const next = previous.map(group => {
        if (group.key !== key) return group
        const accounts = group.accounts.slice()
        const [moved] = accounts.splice(from.index, 1)
        if (!moved) return group
        accounts.splice(index, 0, moved)
        return { ...group, accounts }
      })
      saveOrder(next)
      return next
    })
  }

  async function togglePlugin() {
    if (!manager || !manager.setPluginEnabled || !row) {
      setToggleNotice(t('toggleFailed', { message: 'remote unavailable' }))
      return
    }
    setToggleBusy(true)
    setToggleNotice('')
    const next = !row.enabled
    try {
      const result = await manager.setPluginEnabled(row.entryId, next)
      if (!result || !result.ok) {
        setToggleNotice(t('toggleFailed', { message: result && result.error ? result.error.message : 'unknown' }))
      } else {
        setRow({ ...row, enabled: next })
        setToggleNotice(result.value && result.value.application === 'restart-required'
          ? t('restartNotice') : t(next ? 'enabled' : 'disabledNotice'))
      }
    } catch (failure) {
      setToggleNotice(t('toggleFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
    } finally {
      setToggleBusy(false)
    }
  }

  const allAccounts = groups.reduce((sum, group) => sum + group.accounts.length, 0)
  const readTimes = groups
    .flatMap(group => group.accounts)
    .map(account => new Date(account.readAt).getTime())
    .filter(value => Number.isFinite(value))
  const newestRead = readTimes.length ? Math.max(...readTimes) : null
  const stale = newestRead !== null && Date.now() - newestRead > 10 * 60 * 1000
  const enabled = row ? row.enabled : false

  return h('div', { className: 'mq-section' },
    h('style', null, STYLE),
    h('div', { className: 'mq-head' },
      h('h2', { className: 'mq-heading' }, t('title')),
      h('div', { className: 'mq-actions' },
        h('button', {
          type: 'button', className: 'mq-refresh', disabled: loading || !enabled,
          onClick: () => setNonce(value => value + 1),
        }, loading ? t('refreshing') : t('refresh')),
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': enabled ? 'true' : 'false',
          className: 'mq-switch', disabled: toggleBusy || !row,
          title: t('enableHint'), onClick: togglePlugin,
        },
          h('span', { className: 'mq-switch-track', 'data-on': enabled ? 'true' : 'false' },
            h('span', { className: 'mq-switch-knob' })),
          toggleBusy ? t('toggling') : t(enabled ? 'enabled' : 'disabled')),
      ),
    ),
    h('p', { className: 'mq-intro' }, t('intro')),
    h('div', { className: 'mq-summary' },
      h('span', null, fmt(t, 'accounts', { count: allAccounts })),
      h('span', null, fmt(t, 'providers', { count: groups.length })),
      usage && usage.calls !== undefined
        ? h('span', null, fmt(t, 'calls', { count: usage.calls, period: usage.period || '' })) : null,
      usage && usage.cost !== undefined
        ? h('span', null, fmt(t, 'cost', {
          cost: Number(usage.cost).toFixed(2), period: usage.period || '',
        })) : null,
      newestRead !== null ? h('span', null,
        fmt(t, 'updatedAt', { time: time(newestRead) }) + (stale ? ' · ' + t('stale') : '')) : null,
    ),
    toggleNotice ? h('div', { className: 'mq-error', role: 'status' }, toggleNotice) : null,
    error ? h('div', { className: 'mq-error', role: 'alert' },
      fmt(t, 'error', { message: error }), h('br'), t('hint')) : null,
    loading && allAccounts === 0 ? h('p', { className: 'mq-loading' }, t('loading')) : null,
    !loading && !error && allAccounts === 0 ? h('p', { className: 'mq-empty' }, t('empty')) : null,
    h('div', { className: 'mq-groups' }, groups.map((group, index) =>
      h(GroupCard, {
        key: group.key, group, t, index,
        expanded: !collapsed.has(group.key),
        onToggle: toggleGroup,
        onDragStart, onDragEnd, onDragOver, onDrop, dragOver: dragOver === index,
        onChildDragStart, onChildDragOver, onChildDrop, childDragOver,
      }))),
  )
}

/** Register the quota settings section from the package's single Client bundle. */
export function registerMagpieQuota(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'acp: magpie quota dictionaries')
  const t = ctx.locale.bind(NS)
  // Read the Remote face while the module fiber still has it injected; the slot
  // renderer runs in a scoped fiber where ctx.remote is not available.
  const manager = ctx.remote && ctx.remote.pluginManager
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'magpie-quota',
    order: 12,
    label: () => t('nav'),
    locale: NS,
  }, props => h(QuotaSection, { ...props, manager })))
}
