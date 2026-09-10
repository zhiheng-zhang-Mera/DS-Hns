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

function tokenCount(usage) {
  if (!usage) return 0
  return Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0) + Number(usage.reasoningTokens || 0)
}

function showError(error) {
  $('error').textContent = error ? String(error.stack || error.message || error) : ''
}

function setExpanded(expanded) {
  document.body.classList.toggle('expanded', Boolean(expanded))
  document.body.classList.toggle('collapsed', !expanded)
  $('railToggle').textContent = expanded ? '›' : '‹'
  $('rail').title = expanded ? '折叠 Mega Dock' : '展开 Mega Dock'
  // Collapse/expand is the dock's "module open" event: closing the dock and
  // reopening it is what allows another automatic balance refresh to fire.
  balanceModule?.sync()
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

  const config = scheduler.config || {}
  $('minConcurrent').value = config.minConcurrent ?? 1
  $('maxConcurrent').value = config.maxConcurrent ?? 0
  $('cpuReservePercent').value = config.cpuReservePercent ?? 25
  $('memoryReserveGb').value = config.memoryReserveGb ?? 2
  $('memoryPerWorkerGb').value = config.memoryPerWorkerGb ?? 2.5

  renderBalance(snapshot)

  $('sessions').innerHTML = (snapshot.sessions || []).slice(0, 8).map((session) => (
    `<div class="session-item"><b>${esc(session.status || '—')}</b><span>${esc(session.model || '—')} · ${esc(tokenCount(session.usage).toLocaleString())} tok</span><span>${esc(fmtTime(session.updatedAt || session.createdAt))}</span></div>`
  )).join('') || '<div class="muted">暂无 Session</div>'

  updateLivePeriod()
}

async function refresh() {
  try {
    showError()
    render(await window.megaTools.snapshot())
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

$('schedulerForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    await window.megaTools.updateScheduler({
      minConcurrent: Number($('minConcurrent').value),
      maxConcurrent: Number($('maxConcurrent').value),
      cpuReservePercent: Number($('cpuReservePercent').value),
      memoryReserveGb: Number($('memoryReserveGb').value),
      memoryPerWorkerGb: Number($('memoryPerWorkerGb').value)
    })
    await refresh()
  } catch (error) {
    showError(error)
  }
}

document.addEventListener('click', async (event) => {
  const move = event.target?.dataset?.move
  const id = event.target?.dataset?.id
  const cancel = event.target?.dataset?.cancel
  try {
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

window.megaTools.onChanged(refresh)
refresh()
setInterval(refresh, 5000)
setInterval(updateLivePeriod, 1000)
