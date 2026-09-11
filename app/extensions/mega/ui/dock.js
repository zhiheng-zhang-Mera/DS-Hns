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
  // The settings layer lives inside the dock, so a collapsed dock closes it.
  if (!expanded) setSettingsOpen(false)
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
  failed: '上次更新失败',
  interrupted: '上次更新未完成',
  updating: '上次更新进行中'
}

function updateNoteText(update) {
  const last = update.lastUpdate
  const parts = []
  if (last) {
    const from = last.from ? ` ${last.from}` : ''
    const to = last.to ? ` → ${last.to}` : ''
    const when = last.finishedAt ? ` · ${fmtTime(last.finishedAt)}` : ''
    parts.push(`${LAST_UPDATE_TEXT[last.status] || '上次更新'}${from}${to}${when}`)
    if (last.error?.message) parts.push(`原因：${last.error.message}`)
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
    const failed = update.status === 'failed' || update.lastUpdate?.status === 'failed'
    note.textContent = updateMessage ? updateMessage.text : fallback
    note.dataset.state = updateMessage ? updateMessage.state : (failed ? 'failed' : '')
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
  if (event.key === 'Escape' && isSettingsOpen()) setSettingsOpen(false)
})

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
