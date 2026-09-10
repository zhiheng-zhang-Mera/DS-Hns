'use strict'
const $ = (id) => document.getElementById(id)
let current = null

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function fmtTime(ms) { return ms ? new Date(ms).toLocaleString() : '—' }
function tokens(u) { return u ? (Number(u.inputTokens||0)+Number(u.outputTokens||0)+Number(u.reasoningTokens||0)).toLocaleString() : '—' }
function showError(error) { $('error').textContent = error ? String(error.stack || error.message || error) : '' }
function isActive(t) { return t.status === 'RUNNING' || t.status === 'DISPATCHING' }

function renderHardware(d) {
  const hw = d.hardware || d.system?.hardware || {}
  const cpu = d.system?.cpu || {}
  const mem = d.system?.memory || {}
  const conc = d.concurrency || {}
  const gpuText = Array.isArray(hw.gpus) && hw.gpus.length
    ? hw.gpus.map((g) => `${g.name}${g.adapterRamGb ? ` (${g.adapterRamGb} GB)` : ''}`).join(' / ')
    : '未检测到可用 GPU 信息（不影响远程 API 任务）'
  const physical = hw.cpu?.physicalCores ? `${hw.cpu.physicalCores} physical / ` : ''
  $('hardwareInfo').innerHTML = [
    ['CPU', `${hw.cpu?.model || cpu.model || '—'} · ${physical}${hw.cpu?.logicalCores || cpu.logicalCores || cpu.cores || '—'} logical`],
    ['实时 CPU', `${Number(cpu.usagePercent || 0).toFixed(1)}% · CPU 上限 ${conc.byCpuLoad ?? '—'}`],
    ['内存', `${mem.freeGb ?? '—'} GB free / ${mem.totalGb ?? hw.memory?.totalGb ?? '—'} GB · RAM 上限 ${conc.byRam ?? '—'}`],
    ['GPU', gpuText],
    ['硬件安全上限', `${conc.hardwareCap ?? '—'} workers`],
    ['当前并行', `${conc.current ?? '—'} workers · hardware-auto`]
  ].map(([k,v]) => `<div class="hardware-item"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
}

function queueActions(t) {
  if (!['PENDING','SUSPENDED'].includes(t.status)) {
    return isActive(t) ? `<button data-cancel="${esc(t.id)}">取消</button>` : ''
  }
  return `<div class="queue-actions">
    <button title="置顶" data-id="${esc(t.id)}" data-move="top">⇈</button>
    <button title="上移" data-id="${esc(t.id)}" data-move="up">↑</button>
    <button title="下移" data-id="${esc(t.id)}" data-move="down">↓</button>
    <button title="置底" data-id="${esc(t.id)}" data-move="bottom">⇊</button>
    <button data-cancel="${esc(t.id)}">取消</button>
  </div>`
}

function targetLabel(t) {
  if (t.deliveryMode === 'headless') return 'Headless'
  return t.officialSessionId ? `官方 · ${String(t.officialSessionId).slice(0, 8)}` : '官方主界面'
}

function render(s) {
  current = s
  const d = s.scheduler || {}
  const peak = d.peak?.peak
  const conc = d.concurrency || {}
  $('summary').innerHTML = [
    ['计费时段', peak ? 'PEAK' : 'OFF-PEAK'],
    ['动态并发', `${conc.current ?? '—'} / HW ${conc.hardwareCap ?? '—'}`],
    ['队列等待', (s.tasks || []).filter((t) => ['PENDING','SUSPENDED'].includes(t.status)).length],
    ['正在运行', (s.tasks || []).filter(isActive).length]
  ].map(([k,v]) => `<div class="card"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')

  $('tasks').innerHTML = (s.tasks || []).map((t) => `<tr>
    <td>${t.queueRank ? '#'+esc(t.queueRank) : (t.status === 'DISPATCHING' ? 'SEND' : t.status === 'RUNNING' ? 'RUN' : '—')}</td>
    <td>${esc(t.status)}${t.error ? `<br><small class="error">${esc(typeof t.error === 'string' ? t.error : JSON.stringify(t.error))}</small>` : ''}</td>
    <td>${esc(targetLabel(t))}</td>
    <td title="${esc(t.prompt)}">${esc(t.promptPreview || t.prompt)}</td>
    <td>${t.allowPeak?'允许':'仅谷值'}</td>
    <td>${esc(t.startAtMs?fmtTime(t.startAtMs):'尽快')}</td>
    <td>${queueActions(t)}</td>
  </tr>`).join('') || '<tr><td colspan="7">暂无队列任务</td></tr>'

  $('sessions').innerHTML = (s.sessions || []).map((x) => `<tr><td>${esc(x.status)}</td><td>${esc(x.model||'—')}</td><td>${esc(tokens(x.usage))}</td><td>${esc(fmtTime(x.updatedAt||x.createdAt))}</td></tr>`).join('') || '<tr><td colspan="4">暂无 session</td></tr>'

  const c = d.config || {}
  $('minConcurrent').value = c.minConcurrent ?? 1
  $('maxConcurrent').value = c.maxConcurrent ?? 0
  $('cpuReservePercent').value = c.cpuReservePercent ?? 25
  $('memoryReserveGb').value = c.memoryReserveGb ?? 2
  $('memoryPerWorkerGb').value = c.memoryPerWorkerGb ?? 2.5
  $('defaultAllowPeak').checked = Boolean(c.defaultAllowPeak)
  $('interruptRunningAtPeak').checked = Boolean(c.interruptRunningAtPeak)
  renderHardware(d)

  const st = s.settings || {}
  $('model').innerHTML = (st.models || []).map((m)=>`<option value="${esc(m)}" ${m===st.defaultModel?'selected':''}>${esc(m)}</option>`).join('')
  $('globalPermission').value = st.permissionMode || 'workspace-write'
  $('telemetry').value = st.telemetryMode || 'DISABLED'
  $('soundEnabled').checked = st.sound?.enabled !== false
  $('volume').value = st.sound?.volume ?? 0.8
  $('notifyEnabled').checked = st.notifications?.enabled !== false
  $('notifyCancelled').checked = st.notifications?.onCancelled !== false
  $('workspaceText').textContent = `工作区: ${s.workspace || '—'} · API Key: ${st.apiKeyMasked || '未配置'} · 官方投递: ${d.officialDeliveryReady ? 'ready' : 'unavailable'} · 系统通知: ${st.notifications?.supported === false ? '不可用' : '可用'}`
  if (s.balance) $('balanceText').textContent = JSON.stringify(s.balance, null, 2)
}

async function refresh() {
  try { showError(); render(await window.megaTools.snapshot()) } catch (e) { showError(e) }
}

$('refresh').onclick = refresh
$('openMain').onclick = () => window.megaTools.openMain()
$('hardwareRefresh').onclick = async () => { try { await window.megaTools.refreshHardware(); await refresh() } catch(e){showError(e)} }
$('clearPending').onclick = async () => { try { await window.megaTools.clearPending(); await refresh() } catch(e){showError(e)} }
$('workspace').onclick = async () => { try { await window.megaTools.pickWorkspace(); await refresh() } catch(e){showError(e)} }
$('soundFile').onclick = async () => { try { await window.megaTools.pickSound(); await refresh() } catch(e){showError(e)} }

/**
 * Balance module (this window): opening it refreshes automatically through the
 * same main-process implementation used by the manual button.
 */
const balanceModule = window.megaBalanceModule.attachBalanceModule({
  panelSelector: '.balance-panel',
  refresh: async (trigger, options) => {
    $('balanceText').textContent = JSON.stringify(await window.megaTools.fetchBalance(trigger, options), null, 2)
    await refresh()
  },
  onBusy: (busy) => { $('balance').disabled = Boolean(busy) },
  onError: (error) => showError(error)
})
$('balance').onclick = () => balanceModule.trigger('manual')

$('taskForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    const raw = $('startAt').value
    await window.megaTools.addTask({
      prompt: $('prompt').value,
      deliveryMode: $('deliveryMode').value,
      queuePosition: $('queuePosition').value,
      allowPeak: $('allowPeak').checked,
      startAt: raw ? new Date(raw).toISOString() : null,
      permissionMode: $('permission').value || null
    })
    $('prompt').value = ''
    $('startAt').value = ''
    await refresh()
  } catch(e){showError(e)}
}

$('schedulerForm').onsubmit = async (event) => {
  event.preventDefault()
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
  } catch(e){showError(e)}
}

$('settingsForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    const patch = {
      model: $('model').value,
      permissionMode: $('globalPermission').value,
      telemetryMode: $('telemetry').value,
      sound: { enabled: $('soundEnabled').checked, volume: Number($('volume').value) },
      notifications: {
        enabled: $('notifyEnabled').checked,
        onCancelled: $('notifyCancelled').checked
      }
    }
    if ($('apiKey').value) patch.apiKey = $('apiKey').value
    await window.megaTools.updateSettings(patch)
    $('apiKey').value = ''
    await refresh()
  } catch(e){showError(e)}
}

document.addEventListener('click', async (event) => {
  const move = event.target?.dataset?.move
  const moveId = event.target?.dataset?.id
  const cancelId = event.target?.dataset?.cancel
  try {
    if (move && moveId) {
      await window.megaTools.reorderTask(moveId, move)
      await refresh()
      return
    }
    if (cancelId) {
      await window.megaTools.cancelTask(cancelId)
      await refresh()
    }
  } catch(e){showError(e)}
})

window.megaTools.onChanged(() => refresh())
refresh()
