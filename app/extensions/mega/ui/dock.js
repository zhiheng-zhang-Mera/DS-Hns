'use strict'
const $ = (id) => document.getElementById(id)
let latestSnapshot = null

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

function renderBalance(snapshot) {
  const balance = snapshot.balance
  const sessions = snapshot.sessions || []
  const recentCost = sessions.slice(0, 8).reduce((sum, session) => sum + Number(session.cost?.costCny || 0), 0)
  const status = $('balanceStatus')
  const meta = $('balanceMeta')
  const cards = $('balanceCards')

  if (!balance) {
    status.textContent = '未刷新'
    status.className = 'status-chip neutral'
    meta.textContent = '余额与最近 Session 成本会在这里汇总。'
    cards.innerHTML = `<div class="balance-card"><span>最近 8 个 Session</span><b>${formatMoney(recentCost, 'CNY')}</b><small>依据已记录 Token 估算</small></div><div class="balance-empty">点击“刷新”读取 DeepSeek 账户余额。</div>`
    return
  }

  if (!balance.ok) {
    status.textContent = '读取失败'
    status.className = 'status-chip warn'
    meta.textContent = balance.error?.message || '无法读取余额'
    cards.innerHTML = `<div class="balance-card"><span>最近 8 个 Session</span><b>${formatMoney(recentCost, 'CNY')}</b><small>本地成本记录仍可用</small></div>`
    return
  }

  status.textContent = balance.isAvailable ? '可用' : '不可用'
  status.className = `status-chip ${balance.isAvailable ? 'ok' : 'warn'}`
  meta.textContent = `上次刷新 ${new Date(balance.fetchedAt || Date.now()).toLocaleTimeString()}`
  const rows = Array.isArray(balance.balances) ? balance.balances : []
  const primary = rows[0] || { currency: 'CNY', total: 0, toppedUp: 0, granted: 0 }
  cards.innerHTML = [
    ['总余额', formatMoney(primary.total, primary.currency), primary.currency, 'primary'],
    ['充值余额', formatMoney(primary.toppedUp, primary.currency), '自充值可用额度', ''],
    ['赠送余额', formatMoney(primary.granted, primary.currency), '平台赠送额度', ''],
    ['最近 8 个 Session', formatMoney(recentCost, 'CNY'), '依据已记录 Token 估算', '']
  ].map(([label, value, note, cls]) => `<div class="balance-card ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join('')
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

  $('sessions').innerHTML = (snapshot.sessions || []).slice(0, 8).map((session) => {
    const cost = session.cost ? `¥${Number(session.cost.costCny || 0).toFixed(4)}` : '—'
    return `<div class="session-item"><b>${esc(session.status || '—')}</b><span>${esc(session.model || '—')} · ${esc(tokenCount(session.usage).toLocaleString())} tok</span><span>${esc(cost)}</span></div>`
  }).join('') || '<div class="muted">暂无 Session</div>'

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
$('balance').onclick = async () => {
  try { await window.megaTools.fetchBalance(); await refresh() } catch (error) { showError(error) }
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
