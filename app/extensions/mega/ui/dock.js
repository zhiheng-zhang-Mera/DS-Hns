'use strict'
const $ = (id) => document.getElementById(id)
let latestSnapshot = null
let balanceModule = null

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '—'
}

function fmtClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = value % 60
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':')
}

function fmtTimeOfDay(ms) {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return new Date(ms).toLocaleTimeString()
  }
}

function formatMoney(value, currency = 'CNY') {
  const amount = Number(value || 0)
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency: currency || 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 4
    }).format(amount)
  } catch {
    return `${currency || 'CNY'} ${amount.toFixed(4)}`
  }
}

function showError(error) {
  $('error').textContent = error ? String(error.stack || error.message || error) : ''
}

function setSettingsStatus(text) {
  const node = $('settingsStatus')
  if (node) node.textContent = text ? String(text) : ''
}

/** Settings layer: an in-dock overlay, never a second window or page. */
function setSettingsOpen(open) {
  const overlay = $('settingsOverlay')
  if (!overlay) return false
  overlay.hidden = !open
  document.body.classList.toggle('settings-open', Boolean(open))
  if (open) {
    setSettingsStatus('')
    $('apiKey').value = ''
  }
  return Boolean(open)
}

function isSettingsOpen() {
  return !$('settingsOverlay').hidden
}

function setExpanded(expanded) {
  document.body.classList.toggle('expanded', Boolean(expanded))
  document.body.classList.toggle('collapsed', !expanded)
  $('railToggle').textContent = expanded ? '›' : '‹'
  $('rail').title = expanded ? '折叠 Mega Dock' : '展开 Mega Dock'
  // Collapse/expand is the dock's "module open" event: closing the dock and
  // reopening it is what allows another automatic balance refresh to fire.
  balanceModule?.sync()
  // The settings layer and the Live View live inside the dock, so a collapsed
  // dock closes both.
  if (!expanded) {
    setSettingsOpen(false)
    closeLiveView()
  }
}

function isActive(task) {
  return task.status === 'RUNNING' || task.status === 'DISPATCHING'
}

function queueActions(task) {
  if (!['PENDING', 'SUSPENDED'].includes(task.status)) {
    return isActive(task) ? `<button data-cancel="${esc(task.id)}" title="取消">×</button>` : ''
  }
  return [
    ['top', '⇈', '置顶'], ['up', '↑', '上移'], ['down', '↓', '下移'], ['bottom', '⇊', '置底']
  ].map(([move, label, title]) => `<button data-id="${esc(task.id)}" data-move="${move}" title="${title}">${label}</button>`).join('') + `<button data-cancel="${esc(task.id)}" title="取消">×</button>`
}

function deliveryLabel(task) {
  return task.deliveryMode === 'headless' ? 'Headless' : '官方主界面'
}

function nextValleyText(snapshot) {
  const peak = snapshot?.scheduler?.peak || {}
  if (!peak.peak) return '现在'
  const next = peak.nextChange
  if (!next?.iso || next.statusAfter !== 'OFF-PEAK') return '—'
  return fmtClock((Date.parse(next.iso) - Date.now()) / 1000)
}

function updateLivePeriod() {
  if (!latestSnapshot) return
  const peak = Boolean(latestSnapshot.scheduler?.peak?.peak)
  const timer = $('nextValleyValue')
  if (timer) timer.textContent = nextValleyText(latestSnapshot)
  const railPeak = $('railPeak')
  if (railPeak) {
    railPeak.textContent = peak ? 'PEAK' : 'VALLEY'
    railPeak.classList.toggle('peak', peak)
    railPeak.classList.toggle('offpeak', !peak)
  }
}

const PROVIDER_STATUS_TEXT = {
  ok: '正常',
  failed: '读取失败',
  timeout: '超时',
  unavailable: '不可用',
  pending: '刷新中',
  idle: '未刷新'
}

const TRIGGER_TEXT = {
  'module-open': '打开模块自动刷新',
  manual: '手动刷新',
  retry: '重试失败项'
}

function lastUpdatedText(balance) {
  return `Last updated: ${balance.lastUpdatedAt ? fmtTimeOfDay(balance.lastUpdatedAt) : '—'}`
}

function providerRows(balance) {
  const providers = Array.isArray(balance.providers) ? balance.providers : []
  if (!providers.length) return ''
  const needsDetail = providers.length > 1 || providers.some((p) => p.status !== 'ok')
  if (!needsDetail) return ''
  return `<div class="provider-list">${providers.map((provider) => {
    const note = provider.error
      ? `${provider.error.message}`
      : `${PROVIDER_STATUS_TEXT[provider.status] || provider.status}${provider.stale ? ' · 显示上次成功余额' : ''}`
    return `<div class="provider-item" data-status="${esc(provider.status)}">
      <b>${esc(provider.label || provider.id)}</b>
      <span>${esc(note)}</span>
      <small>${esc(provider.lastUpdatedAt ? `Last updated: ${fmtTimeOfDay(provider.lastUpdatedAt)}` : '尚未成功刷新')}</small>
    </div>`
  }).join('')}</div>`
}

function balanceCards(balance) {
  const rows = Array.isArray(balance.balances) ? balance.balances : []
  const primary = rows[0] || { currency: 'CNY', total: 0, toppedUp: 0, granted: 0 }
  const staleNote = balance.stale ? '上次成功值' : ''
  return [
    ['总余额', formatMoney(primary.total, primary.currency), staleNote || primary.currency, 'primary'],
    ['充值余额', formatMoney(primary.toppedUp, primary.currency), '自充值可用额度', ''],
    ['赠送余额', formatMoney(primary.granted, primary.currency), '平台赠送额度', '']
  ].map(([label, value, note, cls]) => `<div class="balance-card ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join('') + providerRows(balance)
}

function renderBalance(snapshot) {
  const balance = snapshot.balance || {}
  const status = $('balanceStatus')
  const meta = $('balanceMeta')
  const cards = $('balanceCards')
  const retry = $('balanceRetry')
  const failed = Array.isArray(balance.failedProviders) ? balance.failedProviders : []
  if (retry) retry.hidden = failed.length === 0

  const triggerText = TRIGGER_TEXT[balance.trigger] || '—'
  meta.textContent = `${lastUpdatedText(balance)} · ${triggerText}`

  if (balance.refreshing) {
    status.textContent = '刷新中'
    status.className = 'status-chip neutral'
  } else if (balance.partial) {
    status.textContent = '部分可用'
    status.className = 'status-chip warn'
  } else if (balance.ok) {
    status.textContent = '可用'
    status.className = 'status-chip ok'
  } else if (balance.hasData) {
    status.textContent = '刷新失败'
    status.className = 'status-chip warn'
  } else if (failed.length) {
    status.textContent = '读取失败'
    status.className = 'status-chip warn'
  } else {
    status.textContent = '未刷新'
    status.className = 'status-chip neutral'
  }

  if (!balance.hasData) {
    // Never blank a previously successful balance: there simply is none yet.
    const reason = failed.length
      ? `余额读取失败：${esc(balance.error?.message || '未知错误')}`
      : '打开余额模块会自动刷新，也可以点“刷新”。'
    cards.innerHTML = `<div class="balance-empty">${reason}</div>${providerRows(balance)}`
    return
  }

  cards.innerHTML = balanceCards(balance)
}

const UPDATE_STATUS_TEXT = {
  idle: '未检查',
  checking: '检查中',
  current: '已是最新',
  outdated: '可更新',
  updating: '更新中',
  failed: '检查失败'
}

const UPDATE_STATUS_CLASS = {
  idle: 'neutral',
  checking: 'busy',
  current: 'ok',
  outdated: 'warn',
  updating: 'busy',
  failed: 'warn'
}

const LAST_UPDATE_TEXT = {
  succeeded: '上次更新成功',
  // The three outcomes are distinct on purpose: a failed update that came back
  // to the previous version and a failed update that could not be rolled back
  // are not the same message to a user.
  failed: '上次更新失败',
  failed_rolled_back: '上次更新失败，已回滚到原版本',
  failed_rollback_failed: '上次更新失败，且回滚未完成',
  interrupted: '上次更新未完成',
  updating: '上次更新进行中'
}

const ROLLBACK_NOTE = '⚠ 回滚未完成，当前安装可能已损坏；请重新执行一次对齐安装以修复。'

function updateNoteText(update) {
  const last = update.lastUpdate
  const parts = []
  if (last) {
    const from = last.from ? ` ${last.from}` : ''
    const to = last.to ? ` → ${last.to}` : ''
    const when = last.finishedAt ? ` · ${fmtTime(last.finishedAt)}` : ''
    parts.push(`${LAST_UPDATE_TEXT[last.status] || '上次更新'}${from}${to}${when}`)
    if (last.rollbackFailed) {
      if (last.rollback?.code) parts.push(`回滚错误码：${last.rollback.code}`)
      parts.push(ROLLBACK_NOTE)
    } else if (last.error?.message) {
      parts.push(`原因：${last.error.message}`)
    }
  }
  if (update.error?.message) parts.push(`检查失败：${update.error.message}`)
  if (update.npmAvailable === false) parts.push('未找到 npm CLI，更新不可用。')
  return parts.join('\n')
}

/**
 * 拓展状态 module: what the Mega extension is doing, which harness version is
 * installed, and the one sanctioned way to align it with the official latest.
 * The button never installs anything by itself - the shell quits and a detached
 * runner owns the install, because npm cannot replace a running harness.
 */
function renderUpdate(snapshot) {
  const update = snapshot.update || {}
  const status = $('updateStatus')
  const meta = $('updateMeta')
  const grid = $('updateGrid')
  const note = $('updateNote')
  const check = $('updateCheck')
  const apply = $('updateApply')

  const busy = update.status === 'checking' || update.status === 'updating'
  const updatable = Boolean(update.updateAvailable)
  if (check) check.disabled = busy
  if (apply) apply.disabled = busy || !updatable || update.npmAvailable === false

  if (status) {
    status.textContent = UPDATE_STATUS_TEXT[update.status] || '未检查'
    status.className = `status-chip ${UPDATE_STATUS_CLASS[update.status] || 'neutral'}`
  }
  if (meta) {
    const checked = update.checkedAt ? `Last checked: ${fmtTimeOfDay(update.checkedAt)}` : '尚未检查更新'
    const tag = update.tag || 'latest'
    meta.textContent = `${checked} · 官方 dist-tag ${tag}`
  }

  const extension = snapshot.extension || {}
  const current = update.currentVersion || '—'
  const latest = update.latestVersion || '—'
  const rows = [
    ['Mega 扩展', extension.id ? `已加载 · ${extension.id}` : '未加载', extension.shellOwner ? `shell: ${extension.shellOwner}` : '可选功能扩展', 'ok'],
    ['主 Harness 当前', current, update.pinnedVersion && update.pinnedVersion !== current ? `package.json 固定 ${update.pinnedVersion}` : 'app\\node_modules\\@deepseek-ai\\dsh', ''],
    ['官方最新', latest, `@deepseek-ai/dsh · ${update.tag || 'latest'}`, updatable ? 'outdated' : (update.latestVersion ? 'ok' : '')],
    ['更新方式', update.npmAvailable === false ? '不可用' : '安装后自动重启', update.npmAvailable === false ? '未找到 npm CLI' : '应用会自动退出并重新拉起', '']
  ]
  if (grid) {
    grid.innerHTML = rows.map(([label, value, hint, state]) => `<div class="update-item"${state ? ` data-state="${esc(state)}"` : ''}>
      <span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(hint)}</small>
    </div>`).join('')
  }
  if (note) {
    const fallback = updateNoteText(update)
    // A plain "更新失败" must never mask "回滚未完成": that one gets its own state
    // so the stylesheet can make it unmissable.
    const rollbackFailed = Boolean(update.lastUpdate?.rollbackFailed)
    const failed = update.status === 'failed' || rollbackFailed || Boolean(update.lastUpdate?.status?.startsWith('failed'))
    note.textContent = updateMessage ? updateMessage.text : fallback
    note.dataset.state = updateMessage ? updateMessage.state : (rollbackFailed ? 'rollback-failed' : (failed ? 'failed' : ''))
  }
}

/**
 * A hand-off message (checking / updating / refused) must outlive the 5 s
 * snapshot refresh, so it is held here until the user starts another action or
 * the app restarts. Without it, "更新未启动：…" would vanish within seconds.
 */
let updateMessage = null

function setUpdateMessage(text, state = '') {
  updateMessage = text ? { text: String(text), state } : null
  renderUpdateNote()
}

function renderUpdateNote() {
  const note = $('updateNote')
  if (!note) return
  const message = updateMessage || { text: updateNoteText(latestSnapshot?.update || {}), state: '' }
  note.textContent = message.text || ''
  note.dataset.state = message.state || ''
}

const SOUND_EVENT_INPUTS = [
  ['COMPLETED', 'soundCompleted'],
  ['FAILED', 'soundFailed'],
  ['INTERRUPTED', 'soundInterrupted']
]

/* ------------------------------------------------------------------ *
 * Optional Sub-worker (plan §11 Sub-worker panel, §12 Live View)
 *
 * The dock is the worker's only visual surface: no second window, no second
 * Electron, and the Live View shows auditable execution facts only - never a
 * model's hidden reasoning.
 * ------------------------------------------------------------------ */

const SUB_WORKER_BUSY_STATES = ['ASSIGNED', 'RUNNING', 'PAUSING', 'PAUSED', 'BLOCKED', 'STOPPING']

/** Performance states of the adaptive scheduler (Update-Plan/multi-sub.md §10). */
const RESOURCE_STATE_CLASS = {
  NORMAL: 'ok',
  BOOST: 'busy',
  THROTTLED: 'warn',
  CRITICAL: 'warn',
  SAFE_MODE: 'warn'
}
let latestSubWorker = null
let liveViewOpen = false
let liveViewTaskId = null
let liveViewDetail = null

/** The worker bridge only exists inside the real dock preload. */
function subWorkerApi() {
  return window.megaSubWorker && typeof window.megaSubWorker.snapshot === 'function' ? window.megaSubWorker : null
}

function setSubWorkerStatus(text) {
  const node = $('swDispatchStatus')
  if (node) node.textContent = text ? String(text) : ''
}

function setLiveViewNotice(text) {
  const node = $('lvNotice')
  if (node) node.textContent = text ? String(text) : ''
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function subWorkerStateClass(state) {
  const value = String(state || 'OFF').toUpperCase()
  if (value === 'OFF' || value === 'HANDOFF') return 'neutral'
  if (['IDLE', 'READY_FOR_REVIEW'].includes(value)) return 'ok'
  if (['CRASHED', 'FAILED', 'BLOCKED'].includes(value)) return 'warn'
  return 'busy'
}

function subWorkerTaskText(sw) {
  const task = sw.task || null
  if (!task) return 'Idle'
  return `${task.task_id}${task.stage ? ` · ${task.stage}` : ''}`
}

function renderSubWorker(snapshot) {
  const sw = snapshot?.subWorker || { available: false, state: 'OFF', enabled: false }
  latestSubWorker = sw
  const state = String(sw.state || 'OFF').toUpperCase()
  const busy = SUB_WORKER_BUSY_STATES.includes(state)
  const available = sw.available !== false && Boolean(subWorkerApi())

  const stateChip = $('swState')
  if (stateChip) {
    stateChip.textContent = sw.available === false ? 'UNAVAILABLE' : state
    stateChip.className = `status-chip ${subWorkerStateClass(state)}`
  }
  const rail = $('railSubWorker')
  if (rail) rail.textContent = sw.available === false ? 'N/A' : (sw.enabled ? (busy ? 'BUSY' : 'ON') : 'OFF')

  const config = sw.config || {}
  const rows = [
    ['Worker', sw.worker_id || '—'],
    ['Mode', sw.mode || 'Executor'],
    ['State', state],
    ['Stage', sw.stage || '—'],
    ['Task', subWorkerTaskText(sw)],
    ['Queue', sw.queue_length ?? 0],
    ['Workspace', sw.workspace_lock?.workspace || '—'],
    ['PID', sw.pid || '—'],
    ['Restarts', sw.restarts ?? 0],
    ['Auto Delegate', config.autoDelegate ? 'ON' : 'OFF'],
    ['Workspace Mode', config.workspaceMode || 'isolated_worktree']
  ]
  const summary = $('swSummary')
  if (summary) {
    summary.innerHTML = rows
      .map(([label, value]) => `<div class="hardware-item"><span>${esc(label)}</span><b title="${esc(value)}">${esc(String(value))}</b></div>`)
      .join('')
  }

  const enable = $('swEnable')
  if (enable) {
    enable.textContent = sw.enabled ? 'Disable Sub-worker' : 'Enable Sub-worker'
    enable.disabled = !available
    enable.hidden = Boolean(sw.enabled)
  }
  const start = $('swStart')
  if (start) {
    start.hidden = Boolean(sw.enabled)
    start.disabled = !available || sw.enabled
  }
  const stop = $('swStop')
  if (stop) stop.disabled = !available || !sw.enabled
  const restart = $('swRestart')
  if (restart) restart.disabled = !available || (!sw.enabled && state === 'OFF' && !sw.handoff)
  const pause = $('swPause')
  if (pause) pause.disabled = !available || !sw.enabled || ['PAUSED', 'PAUSING'].includes(state)
  const resume = $('swResume')
  if (resume) resume.disabled = !available || !['PAUSED', 'PAUSING'].includes(state)
  const cancel = $('swCancel')
  if (cancel) cancel.disabled = !available || !busy
  const takeOver = $('swTakeOver')
  if (takeOver) takeOver.disabled = !available || (!sw.enabled && !sw.handoff)
  const live = $('swLive')
  if (live) live.disabled = !available
  const dispatchBox = $('swDispatchBox')
  if (dispatchBox) dispatchBox.hidden = sw.available === false

  if (snapshot?.subWorker?.available === false) {
    if (summary) summary.innerHTML = `<div class="muted">Sub-worker 管理器不可用：${esc(sw.reason || '未由桌面 shell 提供')}</div>`
  }

  const crash = $('swCrash')
  if (crash) {
    if (state === 'CRASHED') {
      crash.hidden = false
      crash.textContent = `Sub-worker crashed. Last task: ${sw.task_id || sw.history?.[0]?.task_id || 'none'}`
    } else if (state === 'HANDOFF') {
      crash.hidden = false
      crash.textContent = `Workspace handed over to the Controller: ${sw.handoff?.workspace || '—'}`
    } else {
      crash.hidden = true
      crash.textContent = ''
    }
  }

  const queue = $('swQueue')
  if (queue) {
    const items = sw.queue || []
    queue.innerHTML = items.length
      ? items.map((item) => `<div class="queue-item">
          <div class="queue-rank">SUB</div>
          <div class="queue-main"><div class="queue-title" title="${esc(item.objective)}">${esc(item.objective)}</div>
          <div class="queue-meta">${esc(`${item.task_id} · ${item.risk_level || '—'} · ${item.target_repo || '—'}`)}</div></div>
        </div>`).join('')
      : '<div class="muted">Sub-worker 队列为空</div>'
  }

  const history = $('swHistory')
  if (history) {
    const entries = (sw.history || []).slice(0, 12)
    history.innerHTML = entries.length
      ? `<h3 class="sw-subhead">Task History</h3>` + entries.map((entry) => `<div class="sw-history-item" data-sw-task="${esc(entry.task_id)}">
          <span class="sw-history-status" data-status="${esc(entry.status)}">${esc(entry.status)}</span>
          <b>${esc(entry.task_id)}</b>
          <small>${esc(entry.summary || entry.code || '')}</small>
        </div>`).join('')
      : ''
  }

  renderAdaptive(sw)
  renderLiveView(sw)
}

/**
 * Adaptive multi-worker surface: performance state, limits, the worker pool, the
 * task DAG and the performance metrics (Update-Plan/multi-sub.md §10, §11, §15,
 * §38).
 */
function renderAdaptive(sw) {
  const resources = sw.resources || null
  const pool = sw.pool || null

  const adaptive = $('swAdaptive')
  if (adaptive) adaptive.checked = Boolean(sw.adaptive_workers)

  const stateNode = $('swResourceState')
  if (stateNode) {
    const state = String(resources?.state || sw.resource_state || 'NORMAL').toUpperCase()
    stateNode.textContent = state
    stateNode.className = `status-chip ${RESOURCE_STATE_CLASS[state] || 'neutral'}`
    stateNode.title = (resources?.reasons || []).join('; ') || ''
  }

  const resourceGrid = $('swResources')
  if (resourceGrid) {
    if (!resources) {
      resourceGrid.innerHTML = '<div class="muted">自适应调度未启用（当前为 1 Worker 兼容模式）。</div>'
    } else {
      const sample = resources.sample || {}
      const decision = sw.decision || {}
      const hardware = sw.hardware || {}
      resourceGrid.innerHTML = [
        ['性能状态', resources.state],
        ['决策', `${decision.direction || '—'} → ${decision.desired ?? '—'} workers`],
        ['决策原因', decision.reason || '—'],
        ['CPU', `${sample.cpu?.usage_percent ?? '—'}% · 预算 ${resources.cpuBudgetPercent ?? '—'}%`],
        ['内存', `${sample.memory?.available_gb ?? '—'} / ${sample.memory?.total_gb ?? '—'} GB free（可用 ${resources.usableRamGb ?? '—'} GB）`],
        ['存储', `${resources.storageClass || '—'} · 延迟 ${sample.disk?.latency?.write_ms ?? '—'} ms`],
        ['硬件档位', hardware.tier ? `${hardware.tier.label} · 上限 ${hardware.max_recommended_workers}` : '—'],
        ['退化传感器', (resources.degraded || []).length ? resources.degraded.join('；') : '无']
      ].map(([label, value]) => `<div class="hardware-item"><span>${esc(label)}</span><b title="${esc(value)}">${esc(String(value))}</b></div>`).join('')
    }
  }

  const limitsGrid = $('swLimits')
  if (limitsGrid) {
    const limits = sw.limits || null
    if (!limits) {
      limitsGrid.innerHTML = ''
    } else {
      const rows = ['cpu', 'ram', 'io', 'thermal', 'config']
        .filter((key) => limits[key] !== undefined)
        .map((key) => [`${key} limit`, String(limits[key])])
      rows.push(['effective', String(limits.effective)])
      rows.push(['bottleneck', (limits.binding || []).join(', ') || '—'])
      if (limits.external) rows.push(['external', String(limits.external)])
      limitsGrid.innerHTML = rows
        .map(([label, value]) => `<div class="hardware-item"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
        .join('')
    }
  }

  const poolNode = $('swPool')
  if (poolNode) {
    const workers = Array.isArray(pool?.workers) ? pool.workers : []
    poolNode.innerHTML = workers.length
      ? `<div class="sw-pool-row sw-pool-head"><span>worker</span><span>role</span><span>state</span><span>task</span><span>pid</span><span>restarts</span></div>` +
        workers.map((worker) => `<div class="sw-pool-row">
          <span>${esc(worker.worker_id)}</span>
          <span>${esc(worker.role)}</span>
          <span data-status="${esc(worker.state)}">${esc(worker.busy ? 'BUSY' : worker.state)}</span>
          <span title="${esc(worker.node_id || '')}">${esc(worker.task_id || '—')}</span>
          <span>${esc(worker.pid || '—')}</span>
          <span>${esc(worker.restarts || 0)}</span>
        </div>`).join('')
      : '<div class="muted">没有运行中的 Worker。</div>'
  }

  const dagNode = $('swDag')
  if (dagNode) {
    const plans = Array.isArray(sw.plans) ? sw.plans : []
    if (!plans.length) {
      dagNode.innerHTML = '<div class="muted">暂无计划。单任务派发也会生成一个单节点计划。</div>'
    } else {
      dagNode.innerHTML = plans.slice(0, 3).map((plan) => `
        <div class="sw-plan">
          <div class="sw-plan-head"><b>${esc(plan.plan_id)}</b><span class="status-chip neutral">${esc(plan.status)}</span>
            <small>${esc(String(plan.node_count || 0))} 节点 · 关键路径 ${esc((plan.critical_path || []).join(' → ') || '—')}</small></div>
          ${(plan.nodes || []).map((node) => `<div class="sw-node" data-status="${esc(node.status)}">
            <span>${esc(node.node_id)}</span>
            <span>${esc(node.status)}</span>
            <span>${esc(node.worker_id || '—')}</span>
            <span title="${esc(node.objective)}">${esc(node.objective)}</span>
            <span>P${esc(String(node.priority ?? '—'))}</span>
          </div>`).join('')}
          ${plan.integration ? `<div class="sw-plan-integration">集成：${esc(plan.integration.summary || '')}${plan.integration.conflicts ? ` · 冲突 ${esc(String(plan.integration.conflicts))}` : ''}</div>` : ''}
        </div>`).join('')
    }
  }

  const metricsNode = $('swMetrics')
  if (metricsNode) {
    const metrics = sw.metrics || {}
    const throughput = metrics.throughput || {}
    const rows = [
      ['任务', `${metrics.tasks ?? 0}（完成 ${metrics.completed ?? 0} / 失败 ${metrics.failed ?? 0}）`],
      ['有效吞吐', `${throughput.per_minute ?? 0} / 分钟`],
      ['平均用时', metrics.average_task_ms != null ? `${metrics.average_task_ms} ms` : '—'],
      ['重试次数', String(metrics.retry_count ?? 0)],
      ['合并冲突率', String(metrics.merge_conflict_rate ?? 0)],
      ['峰值 Worker RAM', metrics.peak_worker_ram_mb != null ? `${metrics.peak_worker_ram_mb} MB` : '—']
    ]
    const profiles = Object.entries(metrics.role_profiles || {}).slice(0, 4)
    metricsNode.innerHTML = rows
      .map(([label, value]) => `<div class="hardware-item"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
      .join('') + profiles.map(([role, profile]) => `<div class="hardware-item"><span>${esc(role)} 画像</span><b title="EWMA">${esc(`${profile.ramEstimateMb ?? '—'} MB · w${profile.cpuWeight ?? '—'} · n${profile.samples ?? 0}`)}</b></div>`).join('')
  }
}

function liveViewPayload() {
  return liveViewDetail || latestSubWorker?.live || null
}

function renderLiveView(sw) {
  if (!liveViewOpen) return
  const state = String(sw?.state || 'OFF').toUpperCase()
  const chip = $('lvState')
  if (chip) {
    chip.textContent = state
    chip.className = `status-chip ${subWorkerStateClass(state)}`
  }

  const live = liveViewPayload() || {}
  const taskId = liveViewTaskId || live.task_id || sw?.task_id || null
  const task = $('lvTask')
  if (task) {
    task.innerHTML = taskId
      ? `<div class="lv-row"><span>task_id</span><b>${esc(taskId)}</b></div>
         <div class="lv-row"><span>objective</span><b>${esc(live.objective || sw?.objective || '—')}</b></div>
         <div class="lv-row"><span>workspace</span><b>${esc(live.workspace || sw?.workspace_lock?.workspace || '—')}</b></div>`
      : '<div class="muted">暂无任务。开启 Sub-worker 并由 Controller 派发任务后，这里会显示全过程。</div>'
  }

  const status = $('lvStatus')
  if (status) {
    status.innerHTML = [
      ['state', state],
      ['stage', sw?.stage || live.stage || '—'],
      ['started', live.started_at ? fmtTimeOfDay(Date.parse(live.started_at)) : '—'],
      ['finished', live.finished_at ? fmtTimeOfDay(Date.parse(live.finished_at)) : '—'],
      ['worker', sw?.worker_id || '—'],
      ['heartbeat', sw?.last_heartbeat_at ? fmtTimeOfDay(sw.last_heartbeat_at) : '—']
    ].map(([label, value]) => `<div class="lv-row"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`).join('')
  }

  const summary = $('lvSummary')
  if (summary) {
    const lines = Array.isArray(live.summary) ? live.summary.slice(-40) : []
    summary.innerHTML = lines.length
      ? `<ul class="lv-list">${lines.map((line) => `<li><i>${esc(line.icon || '·')}</i><span>${esc(line.text)}</span><small>${esc(line.at ? fmtTimeOfDay(Date.parse(line.at)) : '')}</small></li>`).join('')}</ul>`
      : '<div class="muted">尚未产生执行摘要。</div>'
  }

  const files = $('lvFiles')
  if (files) {
    const list = Array.isArray(live.changed_files) ? live.changed_files : []
    files.innerHTML = list.length
      ? `<ul class="lv-list">${list.map((file) => `<li><i>${esc(file.status || 'M')}</i><span>${esc(file.path)}</span></li>`).join('')}</ul>`
      : '<div class="muted">暂无文件变化。</div>'
  }

  const tests = $('lvTests')
  if (tests) {
    const value = live.tests || {}
    tests.innerHTML = value.parser
      ? `<div class="lv-row"><span>passed</span><b>${esc(value.passed ?? 0)}</b></div>
         <div class="lv-row"><span>failed</span><b>${esc(value.failed ?? 0)}</b></div>
         <div class="lv-row"><span>skipped</span><b>${esc(value.skipped ?? 0)}</b></div>
         <div class="lv-row"><span>parser</span><b>${esc(value.inferred ? `${value.parser}（由退出码推断）` : value.parser)}</b></div>`
      : '<div class="muted">尚未运行测试命令。</div>'
  }

  const terminal = $('lvTerminal')
  if (terminal) {
    const lines = Array.isArray(live.terminal) ? live.terminal.slice(-80) : []
    terminal.textContent = lines.length
      ? lines.map((line) => (line.kind === 'command' ? `$ ${line.text}` : line.text)).join('\n')
      : '尚无命令输出。'
  }

  const issues = $('lvIssues')
  if (issues) {
    const warnings = Array.isArray(live.warnings) ? live.warnings : []
    const errors = Array.isArray(live.errors) ? live.errors : []
    issues.innerHTML = (warnings.length || errors.length)
      ? [...errors.map((text) => `<div class="lv-issue error">${esc(text)}</div>`),
        ...warnings.map((text) => `<div class="lv-issue warn">${esc(text)}</div>`)].join('')
      : '<div class="muted">无警告与错误。</div>'
  }

  const result = $('lvResult')
  if (result) {
    const stored = live.result || null
    result.innerHTML = stored
      ? `<div class="lv-row"><span>status</span><b>${esc(stored.status)}</b></div>
         <div class="lv-row"><span>code</span><b>${esc(stored.code || '—')}</b></div>
         <div class="lv-row"><span>summary</span><b>${esc(stored.summary || '—')}</b></div>
         <div class="lv-row"><span>needs review</span><b>${stored.needs_controller_review ? 'yes' : 'no'}</b></div>
         ${(stored.acceptance || []).map((entry) => `<div class="lv-row"><span>acceptance</span><b>${esc(`${entry.status}: ${entry.criterion}`)}</b></div>`).join('')}`
      : '<div class="muted">任务尚未结束。</div>'
  }

  const events = $('lvEvents')
  if (events) {
    const list = Array.isArray(sw?.events) ? sw.events.slice(-30).reverse() : []
    events.innerHTML = list.length
      ? `<ul class="lv-list">${list.map((event) => `<li><i>·</i><span>${esc(event.type)}</span><small>${esc(event.summary || '')}</small><small>${esc(event.timestamp ? fmtTimeOfDay(Date.parse(event.timestamp)) : '')}</small></li>`).join('')}</ul>`
      : '<div class="muted">暂无事件。</div>'
  }

  const history = $('lvHistory')
  if (history) {
    const entries = sw?.history || []
    history.innerHTML = entries.length
      ? `<ul class="lv-list">${entries.map((entry) => `<li data-sw-task="${esc(entry.task_id)}"><i>${esc(entry.status)}</i><span>${esc(entry.task_id)}</span><small>${esc(entry.summary || '')}</small></li>`).join('')}</ul>`
      : '<div class="muted">暂无历史记录。</div>'
  }
}

function openLiveView(taskId = null) {
  liveViewOpen = true
  liveViewTaskId = taskId || liveViewTaskId
  liveViewDetail = null
  const overlay = $('liveView')
  if (overlay) overlay.hidden = false
  document.body.classList.add('live-view-open')
  setLiveViewNotice('')
  return refreshLiveView()
}

function closeLiveView() {
  liveViewOpen = false
  const overlay = $('liveView')
  if (overlay) overlay.hidden = true
  document.body.classList.remove('live-view-open')
  return true
}

async function refreshLiveView(taskId = liveViewTaskId) {
  if (!liveViewOpen) return null
  const api = subWorkerApi()
  if (!api) {
    setLiveViewNotice('Sub-worker 控制通道不可用')
    return null
  }
  try {
    const detail = await api.liveView(taskId || null)
    if (detail) liveViewDetail = detail
    renderLiveView(latestSubWorker || {})
    return detail
  } catch (error) {
    showError(error)
    return null
  }
}

/** One entry point for every worker action, so failures never break the dock. */
async function subWorkerAction(label, run) {
  const api = subWorkerApi()
  if (!api) {
    setSubWorkerStatus('Sub-worker 控制通道不可用')
    return null
  }
  try {
    setSubWorkerStatus(`${label}…`)
    const result = await run(api)
    await refresh()
    if (result && result.ok === false) setSubWorkerStatus(`${label} 未完成：${result.reason || result.error || 'unknown'}`)
    else setSubWorkerStatus(`${label} 已提交`)
    return result
  } catch (error) {
    setSubWorkerStatus(`${label} 失败：${error?.message || error}`)
    showError(error)
    return null
  }
}

function buildSubWorkerTask() {
  const operationsRaw = $('swOperations').value.trim()
  let operations = []
  if (operationsRaw) {
    try {
      operations = JSON.parse(operationsRaw)
    } catch (error) {
      throw new Error(`operations 不是合法 JSON：${error.message}`)
    }
    if (!Array.isArray(operations)) throw new Error('operations 必须是 JSON 数组')
  }
  return {
    version: 1,
    task_id: `mega-${Date.now().toString(36)}`,
    created_at: new Date().toISOString(),
    objective: $('swObjective').value.trim(),
    target_repo: $('swTargetRepo').value.trim(),
    workspace: $('swWorkspace').value.trim() || null,
    workspace_mode: $('swWorkspaceMode').value,
    allowed_paths: splitLines($('swAllowed').value),
    forbidden_paths: splitLines($('swForbidden').value),
    acceptance: splitLines($('swAcceptance').value),
    acceptance_commands: splitLines($('swAcceptanceCommands').value),
    permissions: {
      read: true,
      write: $('swPermWrite').checked,
      shell: $('swPermShell').checked,
      git_commit: $('swPermCommit').checked,
      network: $('swPermNetwork').checked
    },
    risk_level: $('swRisk').value,
    requires_vision: $('swRequiresVision').checked,
    operations
  }
}

function fillSelect(select, values, current) {
  if (!select) return
  const options = [...values]
  if (current && !options.includes(current)) options.unshift(current)
  select.innerHTML = options.length
    ? options.map((name) => `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`).join('')
    : '<option value="">无可用铃声</option>'
}

/**
 * Every former Full Mega Tools capability is rendered here, inside the dock.
 * The backend is unchanged: mega:update-settings, mega:update-scheduler,
 * mega:pick-workspace, mega:pick-sound and mega:snapshot.
 */
function renderSettings(snapshot) {
  const st = snapshot.settings || {}
  const sound = st.sound || {}
  const notifications = st.notifications || {}

  $('model').innerHTML = (st.models || [])
    .map((m) => `<option value="${esc(m)}" ${m === st.defaultModel ? 'selected' : ''}>${esc(m)}</option>`)
    .join('')
  $('globalPermission').value = st.permissionMode || 'workspace-write'
  $('telemetry').value = st.telemetryMode || 'DISABLED'

  $('soundEnabled').checked = sound.enabled !== false
  $('volume').value = sound.volume ?? 0.8
  const files = (snapshot.soundFiles || []).map((file) => file.name)
  for (const [event, inputId] of SOUND_EVENT_INPUTS) {
    fillSelect($(inputId), files, sound.events?.[event]?.file || '')
  }

  $('notifyEnabled').checked = notifications.enabled !== false
  $('notifyCancelled').checked = notifications.onCancelled !== false
  $('notifyEnabled').title = notifications.supported === false
    ? '当前环境不支持系统通知'
    : '终态任务会发送系统通知'
  $('notifyCancelled').title = notifications.supported === false
    ? '当前环境不支持系统通知'
    : '取消 / 中断的任务是否也发送通知'

  $('workspaceText').textContent = snapshot.workspace || '—'

  const config = snapshot.scheduler?.config || {}
  $('minConcurrent').value = config.minConcurrent ?? 1
  $('maxConcurrent').value = config.maxConcurrent ?? 0
  $('cpuReservePercent').value = config.cpuReservePercent ?? 25
  $('memoryReserveGb').value = config.memoryReserveGb ?? 2
  $('memoryPerWorkerGb').value = config.memoryPerWorkerGb ?? 2.5
  $('defaultAllowPeak').checked = Boolean(config.defaultAllowPeak)
  $('interruptRunningAtPeak').checked = Boolean(config.interruptRunningAtPeak)

  // Sub-worker configuration (plan §18). Missing data leaves the defaults as
  // they are, so an older backend cannot blank these controls.
  const swConfig = snapshot.subWorker?.config
  if (swConfig) {
    $('swEnabledOnStartup').checked = Boolean(swConfig.enabledOnStartup)
    $('swAutoDelegate').checked = Boolean(swConfig.autoDelegate)
    $('swCfgWorkspaceMode').value = swConfig.workspaceMode || 'isolated_worktree'
    $('swMaxWorkers').value = swConfig.maxWorkers ?? 1
    $('swKeepChanges').checked = swConfig.keepChangesOnStop !== false
    $('swAllowCommit').checked = Boolean(swConfig.allowGitCommit)
    $('swShowNotifications').checked = swConfig.showNotifications !== false
  }
}

function render(snapshot) {
  latestSnapshot = snapshot
  const scheduler = snapshot.scheduler || {}
  const counts = scheduler.counts || {}
  const concurrency = scheduler.concurrency || {}
  const peak = Boolean(scheduler.peak?.peak)
  const tasks = snapshot.tasks || []
  const queued = tasks.filter((t) => ['PENDING', 'SUSPENDED'].includes(t.status))
  const active = tasks.filter(isActive)
  const dock = snapshot.extension?.dock || {}
  const activeCount = (counts.RUNNING || 0) + (counts.DISPATCHING || 0) || active.length || 0
  const queuedCount = (counts.PENDING || 0) + (counts.SUSPENDED || 0) || queued.length || 0

  setExpanded(Boolean(dock.expanded))
  $('railRunning').textContent = String(activeCount)
  $('railQueued').textContent = String(queuedCount)
  $('railWorkers').textContent = `${concurrency.current ?? '—'}/${concurrency.hardwareCap ?? '—'}`

  $('summary').innerHTML = `
    <div class="summary-card period-card ${peak ? 'peak' : 'offpeak'}">
      <span>时段</span><b>${esc(peak ? '峰价' : '谷价')}</b>
    </div>
    <div class="summary-card timer-card">
      <span>距下一次谷价</span><b id="nextValleyValue">${esc(nextValleyText(snapshot))}</b>
    </div>
    <div class="summary-card task-summary-card">
      <span>任务</span>
      <div class="task-summary-values">
        <div><small>运行</small><b>${esc(activeCount)}</b></div>
        <i aria-hidden="true"></i>
        <div><small>等待</small><b>${esc(queuedCount)}</b></div>
      </div>
    </div>
    <div class="summary-card">
      <span>并行</span><b>${esc(`${concurrency.current ?? '—'} / HW ${concurrency.hardwareCap ?? '—'}`)}</b>
    </div>`

  $('queue').innerHTML = tasks.slice(0, 24).map((task) => {
    const rank = task.queueRank
      ? `#${task.queueRank}`
      : task.status === 'DISPATCHING' ? 'SEND'
        : task.status === 'RUNNING' ? 'RUN' : '—'
    const session = task.officialSessionId ? ` · session ${String(task.officialSessionId).slice(0, 8)}` : ''
    const failure = task.error ? ` · ${typeof task.error === 'string' ? task.error : JSON.stringify(task.error)}` : ''
    const meta = `${task.status} · ${deliveryLabel(task)}${session} · ${task.allowPeak ? '允许峰值' : '仅谷值'} · ${task.startAtMs ? fmtTime(task.startAtMs) : '尽快'}${failure}`
    return `<div class="queue-item">
      <div class="queue-rank">${esc(rank)}</div>
      <div class="queue-main"><div class="queue-title" title="${esc(task.prompt)}">${esc(task.promptPreview || task.prompt)}</div><div class="queue-meta">${esc(meta)}</div></div>
      <div class="queue-actions">${queueActions(task)}</div>
    </div>`
  }).join('') || '<div class="muted">暂无队列任务</div>'

  const sys = scheduler.system || {}
  const hw = scheduler.hardware || sys.hardware || {}
  const cpu = sys.cpu || {}
  const memory = sys.memory || {}
  const gpu = Array.isArray(hw.gpus) && hw.gpus.length ? hw.gpus.map((x) => x.name).join(' / ') : '未检测 / 非瓶颈'
  $('hardware').innerHTML = [
    ['CPU', `${hw.cpu?.model || cpu.model || '—'} · ${hw.cpu?.logicalCores || cpu.logicalCores || cpu.cores || '—'} logical`],
    ['实时 CPU', `${Number(cpu.usagePercent || 0).toFixed(1)}% · cap ${concurrency.byCpuLoad ?? '—'}`],
    ['RAM', `${memory.freeGb ?? '—'} / ${memory.totalGb ?? hw.memory?.totalGb ?? '—'} GB free/total`],
    ['GPU', gpu],
    ['硬件安全上限', `${concurrency.hardwareCap ?? '—'} workers`],
    ['当前并行', `${concurrency.current ?? '—'} workers`]
  ].map(([label, value]) => `<div class="hardware-item"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')

  renderBalance(snapshot)
  renderSettings(snapshot)
  renderUpdate(snapshot)
  renderSubWorker(snapshot)
  renderMode(snapshot)

  updateLivePeriod()
}

/**
 * Dock UI modules. Each is optional and each owns its own state, so a failure in
 * one (theme system, skills) can never stop the queue/hardware/balance modules from
 * rendering.
 *
 * Both modules join the shared `theme-bridge`, which is also what makes them visible
 * to theme validation: whichever panels exist report their own geometry, so a new
 * panel cannot be silently occluded by a theme.
 */
let themePanel = null
let skillsPanel = null
try {
  themePanel = window.megaThemePanel?.attach ? window.megaThemePanel.attach() : null
} catch (error) {
  showError(error)
}
try {
  skillsPanel = window.megaSkillsPanel?.attach ? window.megaSkillsPanel.attach() : null
} catch (error) {
  showError(error)
}

async function refresh() {
  try {
    showError()
    render(await window.megaTools.snapshot())
    // The dock snapshot carries only compact statuses; the panels keep the full
    // theme list and skill catalog.
    await themePanel?.refresh?.()
    await skillsPanel?.refresh?.()
  } catch (error) {
    showError(error)
  }
}

function setBalanceBusy(busy) {
  for (const id of ['balance', 'balanceRetry']) {
    const button = $(id)
    if (button) button.disabled = Boolean(busy)
  }
  $('balanceStatus').classList.toggle('busy', Boolean(busy))
}

/**
 * The one Balance-module controller for this window: automatic (module-open)
 * and manual triggers share a single refresh implementation and are coalesced.
 */
balanceModule = window.megaBalanceModule.attachBalanceModule({
  // The Balance panel sits below the fold of the dock's scrollable column, so
  // "the module was opened" means "the dock became visible" here. Collapsing and
  // re-expanding the dock is what allows the next automatic refresh.
  openOnIntersect: false,
  panelSelector: '.balance-panel',
  isOpen: () => document.body.classList.contains('expanded'),
  refresh: async (trigger, options) => {
    await window.megaTools.fetchBalance(trigger, options)
    await refresh()
  },
  onBusy: setBalanceBusy,
  onError: (error) => showError(error)
})

async function saveSettings(patch, okMessage) {
  setSettingsStatus('保存中…')
  try {
    await window.megaTools.updateSettings(patch)
    await refresh()
    setSettingsStatus(okMessage)
  } catch (error) {
    setSettingsStatus(`保存失败：${error?.message || error}`)
    showError(error)
  }
}

$('openSettings').onclick = (event) => {
  event.stopPropagation()
  setSettingsOpen(true)
}
$('closeSettings').onclick = () => setSettingsOpen(false)
$('settingsOverlay').addEventListener('click', (event) => {
  if (event.target === $('settingsOverlay')) setSettingsOpen(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // The Live View sits above the settings layer, so it closes first.
  if (liveViewOpen) {
    closeLiveView()
    return
  }
  if (isSettingsOpen()) {
    setSettingsOpen(false)
    return
  }
  const detail = $('themeDetail')
  if (detail && !detail.hidden) detail.hidden = true
})
const themeDetailClose = $('themeDetailClose')
if (themeDetailClose) {
  themeDetailClose.onclick = () => {
    const detail = $('themeDetail')
    if (detail) detail.hidden = true
  }
}

$('generalForm').onsubmit = async (event) => {
  event.preventDefault()
  const patch = {
    model: $('model').value,
    permissionMode: $('globalPermission').value,
    telemetryMode: $('telemetry').value
  }
  if ($('apiKey').value) patch.apiKey = $('apiKey').value
  await saveSettings(patch, 'General 已保存')
  $('apiKey').value = ''
}

$('notificationForm').onsubmit = async (event) => {
  event.preventDefault()
  const events = {}
  for (const [name, inputId] of SOUND_EVENT_INPUTS) {
    const file = $(inputId).value
    if (file) events[name] = { file }
  }
  const patch = {
    soundEnabled: $('soundEnabled').checked,
    sound: {
      enabled: $('soundEnabled').checked,
      volume: Number($('volume').value)
    },
    notifications: {
      enabled: $('notifyEnabled').checked,
      onCancelled: $('notifyCancelled').checked
    }
  }
  if (Object.keys(events).length) patch.sound.events = events
  await saveSettings(patch, 'Notifications 已保存')
}

$('schedulerForm').onsubmit = async (event) => {
  event.preventDefault()
  setSettingsStatus('保存中…')
  try {
    await window.megaTools.updateScheduler({
      minConcurrent: Number($('minConcurrent').value),
      maxConcurrent: Number($('maxConcurrent').value),
      cpuReservePercent: Number($('cpuReservePercent').value),
      memoryReserveGb: Number($('memoryReserveGb').value),
      memoryPerWorkerGb: Number($('memoryPerWorkerGb').value),
      defaultAllowPeak: $('defaultAllowPeak').checked,
      interruptRunningAtPeak: $('interruptRunningAtPeak').checked
    })
    await refresh()
    setSettingsStatus('Scheduler 已保存')
  } catch (error) {
    setSettingsStatus(`保存失败：${error?.message || error}`)
    showError(error)
  }
}

$('workspace').onclick = async () => {
  try {
    const selected = await window.megaTools.pickWorkspace()
    if (selected) setSettingsStatus(`工作区已切换到 ${selected}`)
    await refresh()
  } catch (error) {
    showError(error)
  }
}

$('soundFile').onclick = async () => {
  try {
    const imported = await window.megaTools.pickSound()
    if (imported?.name) setSettingsStatus(`已导入 ${imported.name}`)
    await refresh()
  } catch (error) {
    showError(error)
  }
}

$('railToggle').onclick = async (event) => {
  event.stopPropagation()
  try { await window.megaTools.toggleDock(); await refresh() } catch (error) { showError(error) }
}
$('rail').onclick = async (event) => {
  if (event.target?.closest('button')) return
  if (document.body.classList.contains('collapsed')) {
    try { await window.megaTools.setDockExpanded(true); await refresh() } catch (error) { showError(error) }
  }
}
$('collapse').onclick = async () => {
  try { await window.megaTools.setDockExpanded(false); await refresh() } catch (error) { showError(error) }
}
$('clearPending').onclick = async () => {
  try { await window.megaTools.clearPending(); await refresh() } catch (error) { showError(error) }
}
$('hardwareRefresh').onclick = async () => {
  try { await window.megaTools.refreshHardware(); await refresh() } catch (error) { showError(error) }
}
$('balance').onclick = () => balanceModule.trigger('manual')
$('balanceRetry').onclick = () => {
  const failed = latestSnapshot?.balance?.failedProviders || []
  return balanceModule.trigger('retry', failed.length ? { only: failed } : {})
}

$('updateCheck').onclick = async () => {
  setUpdateMessage('正在检查官方最新版本…')
  try {
    await window.megaTools.checkHarnessUpdate?.()
    await refresh()
  } catch (error) {
    showError(error)
    setUpdateMessage(`检查失败：${error?.message || error}`, 'failed')
  }
}
$('updateApply').onclick = async () => {
  const update = latestSnapshot?.update || {}
  const target = update.latestVersion
  if (!target) return
  // Aligning the main harness restarts the app, so this is never implicit.
  const question = `将主 harness 从 ${update.currentVersion || '当前版本'} 更新到官方 ${target}，完成后 DS-Harness 会自动重启。继续？`
  if (typeof window.confirm === 'function' && !window.confirm(question)) return
  try {
    const result = await window.megaTools.applyHarnessUpdate?.()
    if (result && result.started === false) {
      setUpdateMessage(`更新未启动：${result.message || result.reason || '未知原因'}`, 'failed')
      await refresh()
      return
    }
    setUpdateMessage(`正在更新到 ${target}，DS-Harness 即将自动重启…`)
    $('updateCheck').disabled = true
    $('updateApply').disabled = true
  } catch (error) {
    showError(error)
    setUpdateMessage(`更新启动失败：${error?.message || error}`, 'failed')
  }
}

$('taskForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    const raw = $('startAt').value
    await window.megaTools.addTask({
      prompt: $('prompt').value,
      deliveryMode: $('deliveryMode').value,
      queuePosition: $('queuePosition').value,
      allowPeak: $('allowPeak').checked,
      startAt: raw ? new Date(raw).toISOString() : null
    })
    $('prompt').value = ''
    $('startAt').value = ''
    await refresh()
  } catch (error) {
    showError(error)
  }
}

document.addEventListener('click', async (event) => {
  const move = event.target?.dataset?.move
  const id = event.target?.dataset?.id
  const cancel = event.target?.dataset?.cancel
  const subTask = event.target?.closest?.('[data-sw-task]')?.dataset?.swTask
  try {
    if (subTask) {
      await openLiveView(subTask)
      return
    }
    if (move && id) {
      await window.megaTools.reorderTask(id, move)
      await refresh()
      return
    }
    if (cancel) {
      await window.megaTools.cancelTask(cancel)
      await refresh()
    }
  } catch (error) {
    showError(error)
  }
})

/* ------------------------- Sub-worker interaction ------------------------- */

$('swEnable').onclick = () => subWorkerAction('启用 Sub-worker', (api) => api.start())
$('swStart').onclick = () => subWorkerAction('启动 Sub-worker', (api) => api.start())
$('swStop').onclick = () => subWorkerAction('停止 Sub-worker', (api) => api.stop())
$('swRestart').onclick = () => subWorkerAction('重启 Sub-worker', (api) => api.restart())
$('swPause').onclick = () => subWorkerAction('暂停', (api) => api.pause('paused from Mega'))
$('swResume').onclick = () => subWorkerAction('恢复', (api) => api.resume('resumed from Mega'))
$('swCancel').onclick = () => subWorkerAction('取消任务', (api) => api.cancelTask('cancelled from Mega'))
$('swTakeOver').onclick = () => subWorkerAction('接管工作区', (api) => api.takeOver('take over from Mega'))
$('swLive').onclick = () => openLiveView()
$('lvClose').onclick = () => closeLiveView()
$('lvRefresh').onclick = () => refreshLiveView()
$('lvPause').onclick = () => subWorkerAction('暂停', (api) => api.pause('paused from Live View'))
$('lvResume').onclick = () => subWorkerAction('恢复', (api) => api.resume('resumed from Live View'))
$('lvCancel').onclick = () => subWorkerAction('取消任务', (api) => api.cancelTask('cancelled from Live View'))
$('lvStop').onclick = () => subWorkerAction('停止 Sub-worker', (api) => api.stop())
$('lvRestart').onclick = () => subWorkerAction('重启 Sub-worker', (api) => api.restart())
$('lvTakeOver').onclick = () => subWorkerAction('接管工作区', (api) => api.takeOver('take over from Live View'))
$('lvLog').onclick = async () => {
  const api = subWorkerApi()
  const taskId = liveViewTaskId || latestSubWorker?.task_id
  if (!api || !taskId) {
    setLiveViewNotice('暂无可读取的任务日志')
    return
  }
  try {
    const result = await api.readLog(taskId)
    setLiveViewNotice(result?.ok ? `日志：${result.file}` : `日志不可用：${result?.reason || 'unknown'}`)
    renderLiveView(latestSubWorker || {})
  } catch (error) {
    setLiveViewNotice(`日志读取失败：${error?.message || error}`)
  }
}

$('lvNoteForm').onsubmit = async (event) => {
  event.preventDefault()
  const api = subWorkerApi()
  const note = $('lvNote').value.trim()
  if (!api) {
    setLiveViewNotice('Sub-worker 控制通道不可用')
    return
  }
  if (!note) {
    setLiveViewNotice('请输入要注入的 Note')
    return
  }
  try {
    const result = await api.sendNote({ note })
    $('lvNote').value = ''
    setLiveViewNotice(result?.ok
      ? `Note 已进入 controller_note_queue（${result.delivered ? '已送达 worker，将在下一个执行边界生效' : '将在 worker 启动后注入'}）`
      : `Note 未接受：${result?.reason || 'unknown'}`)
    await refresh()
  } catch (error) {
    setLiveViewNotice(`Note 发送失败：${error?.message || error}`)
  }
}

$('swPickRepo').onclick = async () => {
  const api = subWorkerApi()
  if (!api) return
  try {
    const picked = await api.pickTargetRepo()
    if (picked) $('swTargetRepo').value = picked
  } catch (error) {
    showError(error)
  }
}

$('swResumeLast').onclick = () => subWorkerAction('恢复上次任务', (api) => api.resumeLast())

/* ---------------- adaptive multi-worker controls ---------------- */

$('swAdaptiveApply').onclick = async () => {
  const api = subWorkerApi()
  if (!api) {
    setSubWorkerStatus('Sub-worker 控制通道不可用')
    return
  }
  setSubWorkerStatus('正在应用自适应设置…')
  try {
    const enabled = $('swAdaptive').checked
    await api.updateConfig({ adaptiveWorkers: enabled })
    setSubWorkerStatus(enabled
      ? '已启用自适应多进程：调度器将按资源与任务量决定 Worker 数量'
      : '已关闭自适应：保持 1 Worker 兼容模式')
    await refresh()
  } catch (error) {
    setSubWorkerStatus(`应用失败：${error?.message || error}`)
  }
}

$('swTick').onclick = async () => {
  const api = subWorkerApi()
  if (!api?.tick) return
  try {
    setSubWorkerStatus('正在执行一次调度循环…')
    const result = await api.tick()
    setSubWorkerStatus(`调度完成：${result?.state || '—'} · ${result?.direction || '—'} → ${result?.desired ?? '—'} workers（${result?.reason || ''}）`)
    await refresh()
  } catch (error) {
    setSubWorkerStatus(`调度失败：${error?.message || error}`)
  }
}

$('swReleaseWorktree').onclick = async () => {
  const api = subWorkerApi()
  const target = $('swTargetRepo').value.trim()
  if (!api) {
    setSubWorkerStatus('Sub-worker 控制通道不可用')
    return
  }
  if (!target) {
    setSubWorkerStatus('请先填写或选择 target_repo')
    return
  }
  try {
    setSubWorkerStatus('正在释放隔离工作区…')
    const result = await api.releaseWorktree(target)
    setSubWorkerStatus(result?.ok
      ? (result.removed ? `已释放 ${result.worktree}` : `无隔离工作区可释放：${target}`)
      : `释放失败：${result?.reason || 'unknown'}`)
    await refresh()
  } catch (error) {
    setSubWorkerStatus(`释放失败：${error?.message || error}`)
  }
}

$('swTaskForm').onsubmit = async (event) => {
  event.preventDefault()
  const api = subWorkerApi()
  if (!api) {
    setSubWorkerStatus('Sub-worker 控制通道不可用')
    return
  }
  let task
  try {
    task = buildSubWorkerTask()
  } catch (error) {
    setSubWorkerStatus(String(error.message || error))
    return
  }
  if (!task.objective) {
    setSubWorkerStatus('objective 不能为空')
    return
  }
  if (!task.operations.length) {
    setSubWorkerStatus('必须提供 operations：worker 只执行明确 specification，不会自行设计实现方案')
    return
  }
  try {
    const result = await api.assignTask(task)
    if (result?.accepted) {
      setSubWorkerStatus(`任务 ${result.task_id} 已受理（队列 ${result.queue_length}）`)
      $('swObjective').value = ''
      $('swOperations').value = ''
    } else {
      setSubWorkerStatus(`任务未受理：${result?.reason || (result?.errors || []).join('; ') || result?.code || 'unknown'}`)
    }
    await refresh()
  } catch (error) {
    setSubWorkerStatus(`派发失败：${error?.message || error}`)
  }
}

$('subWorkerForm').onsubmit = async (event) => {
  event.preventDefault()
  const api = subWorkerApi()
  if (!api) {
    setSettingsStatus('Sub-worker 控制通道不可用')
    return
  }
  setSettingsStatus('保存中…')
  try {
    await api.updateConfig({
      enabledOnStartup: $('swEnabledOnStartup').checked,
      autoDelegate: $('swAutoDelegate').checked,
      workspaceMode: $('swCfgWorkspaceMode').value,
      maxWorkers: 1,
      keepChangesOnStop: $('swKeepChanges').checked,
      allowGitCommit: $('swAllowCommit').checked,
      showNotifications: $('swShowNotifications').checked
    })
    await refresh()
    setSettingsStatus('Sub-worker 已保存')
  } catch (error) {
    setSettingsStatus(`保存失败：${error?.message || error}`)
    showError(error)
  }
}

if (subWorkerApi()?.onOpenLiveView) {
  subWorkerApi().onOpenLiveView(() => openLiveView())
}

/**
 * Dual-UI mode switch (Update-Plan/Dual-UI.md 任务 12 / 任务 13).
 *
 * The dock is the shared control centre for both frontends: the collapsed rail
 * carries the one-click switch (H = Daily, D = Work) and the expanded panel
 * carries the labelled selector. Both render from the same shell-owned state, and
 * both ask the shell to switch - they never decide the mode themselves, so the
 * rail and the panel can never disagree.
 */
const MODE_LABEL = { daily: 'Daily', work: 'Work' }
const MODE_LETTER = { daily: 'H', work: 'D' }
const MODE_DESCRIPTION = {
  daily: 'HNS Native Frontend · 完整主题 / 角色 / 皮肤已启用',
  work: 'Official DeepSeek Harness UI · 兼容模式（不做深度换肤）'
}

function modeOf(snapshot) {
  const mode = String(snapshot?.frontend?.mode || 'daily')
  return MODE_LABEL[mode] ? mode : 'daily'
}

function renderMode(snapshot) {
  const frontend = snapshot?.frontend || {}
  const mode = modeOf(snapshot)
  const other = mode === 'daily' ? 'work' : 'daily'
  const available = frontend.available !== false

  const rail = $('railMode')
  if (rail) {
    rail.textContent = MODE_LETTER[mode]
    rail.dataset.mode = mode
    rail.title = `当前：${MODE_LABEL[mode]} Mode（点击切换到 ${MODE_LABEL[other]}）`
    rail.disabled = !available
  }
  const chip = $('modeStatus')
  if (chip) {
    chip.textContent = MODE_LABEL[mode]
    chip.dataset.mode = mode
  }
  for (const button of [$('modeDaily'), $('modeWork')]) {
    if (!button) continue
    const isActive = button.dataset.mode === mode
    button.classList.toggle('active', isActive)
    button.disabled = !available
    button.setAttribute('aria-selected', isActive ? 'true' : 'false')
  }
  const note = $('modeNote')
  if (note) {
    if (!available) {
      note.textContent = '前端模式切换不可用：桌面 shell 未提供模式管理器。'
      note.dataset.state = 'blocked'
    } else if (frontend.degraded) {
      note.textContent = `Daily 已降级并回退到 Work：${frontend.degraded.reason}`
      note.dataset.state = 'error'
    } else {
      note.textContent = MODE_DESCRIPTION[mode]
      note.dataset.state = ''
    }
  }
}

/** One switch request at a time: a second click cannot start a parallel switch. */
let modeSwitchPending = false
async function requestMode(mode) {
  if (modeSwitchPending) return
  if (!MODE_LABEL[mode]) return
  modeSwitchPending = true
  try {
    await window.megaTools.mode?.set?.(mode)
    await refresh()
  } catch (error) {
    showError(error)
  } finally {
    modeSwitchPending = false
  }
}

if ($('railMode')) $('railMode').onclick = () => requestMode(modeOf(latestSnapshot) === 'daily' ? 'work' : 'daily')
if ($('modeDaily')) $('modeDaily').onclick = () => requestMode('daily')
if ($('modeWork')) $('modeWork').onclick = () => requestMode('work')
// The shell pushes the mode after every switch, so an external change (the
// native frontend's own toggle) keeps the dock in step without a poll.
window.megaTools.mode?.onChanged?.(() => refresh())

window.megaTools.onChanged(refresh)
// The main process pushes this after a skill install or delete, including ones it
// performed itself (a local pick), so the list cannot drift from the filesystem.
window.megaTools.skills?.onChanged?.(() => {
  skillsPanel?.refresh?.()
})
refresh()
setInterval(refresh, 5000)
setInterval(updateLivePeriod, 1000)
