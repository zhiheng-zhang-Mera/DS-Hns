'use strict'
const $ = (id) => document.getElementById(id)
let current = null

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function fmtTime(ms) { return ms ? new Date(ms).toLocaleString() : '—' }
function tokens(u) { return u ? (Number(u.inputTokens||0)+Number(u.outputTokens||0)+Number(u.reasoningTokens||0)).toLocaleString() : '—' }
function showError(error) { $('error').textContent = error ? String(error.stack || error.message || error) : '' }

function render(s) {
  current = s
  const d = s.scheduler || {}
  const peak = d.peak?.peak
  $('summary').innerHTML = [
    ['计费时段', peak ? 'PEAK' : 'OFF-PEAK'],
    ['动态并发', d.concurrency?.current ?? '—'],
    ['队列任务', (s.tasks || []).length],
    ['最近 Session', (s.sessions || []).length]
  ].map(([k,v]) => `<div class="card"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')

  $('tasks').innerHTML = (s.tasks || []).map((t) => `<tr><td>${esc(t.status)}</td><td title="${esc(t.prompt)}">${esc(t.promptPreview || t.prompt)}</td><td>${t.allowPeak?'允许':'仅谷值'}</td><td>${esc(t.startAtMs?fmtTime(t.startAtMs):'尽快')}</td><td>${['PENDING','SUSPENDED','RUNNING'].includes(t.status)?`<button data-cancel="${esc(t.id)}">取消</button>`:''}</td></tr>`).join('') || '<tr><td colspan="5">暂无队列任务</td></tr>'

  $('sessions').innerHTML = (s.sessions || []).map((x) => `<tr><td>${esc(x.status)}</td><td>${esc(x.model||'—')}</td><td>${esc(tokens(x.usage))}</td><td>${x.cost?esc('¥'+Number(x.cost.costCny||0).toFixed(4)):'—'}</td><td>${esc(fmtTime(x.updatedAt||x.createdAt))}</td></tr>`).join('') || '<tr><td colspan="5">暂无 session</td></tr>'

  const c = d.config || {}
  $('minConcurrent').value = c.minConcurrent ?? 1
  $('maxConcurrent').value = c.maxConcurrent ?? 4
  $('defaultAllowPeak').checked = Boolean(c.defaultAllowPeak)
  $('interruptRunningAtPeak').checked = Boolean(c.interruptRunningAtPeak)

  const st = s.settings || {}
  $('model').innerHTML = (st.models || []).map((m)=>`<option value="${esc(m)}" ${m===st.defaultModel?'selected':''}>${esc(m)}</option>`).join('')
  $('globalPermission').value = st.permissionMode || 'workspace-write'
  $('telemetry').value = st.telemetryMode || 'DISABLED'
  $('soundEnabled').checked = st.sound?.enabled !== false
  $('volume').value = st.sound?.volume ?? 0.8
  $('workspaceText').textContent = `工作区: ${s.workspace || '—'} · API Key: ${st.apiKeyMasked || '未配置'}`
  if (s.balance) $('balanceText').textContent = JSON.stringify(s.balance, null, 2)
}

async function refresh() {
  try { showError(); render(await window.megaTools.snapshot()) } catch (e) { showError(e) }
}

$('refresh').onclick = refresh
$('openMain').onclick = () => window.megaTools.openMain()
$('balance').onclick = async () => { try { $('balanceText').textContent = JSON.stringify(await window.megaTools.fetchBalance(), null, 2); await refresh() } catch(e){showError(e)} }
$('clearPending').onclick = async () => { try { await window.megaTools.clearPending(); await refresh() } catch(e){showError(e)} }
$('workspace').onclick = async () => { try { await window.megaTools.pickWorkspace(); await refresh() } catch(e){showError(e)} }
$('soundFile').onclick = async () => { try { await window.megaTools.pickSound(); await refresh() } catch(e){showError(e)} }

$('taskForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    const raw = $('startAt').value
    await window.megaTools.addTask({
      prompt: $('prompt').value,
      allowPeak: $('allowPeak').checked,
      startAt: raw ? new Date(raw).toISOString() : null,
      permissionMode: $('permission').value || null
    })
    $('prompt').value = ''
    await refresh()
  } catch(e){showError(e)}
}

$('schedulerForm').onsubmit = async (event) => {
  event.preventDefault()
  try {
    await window.megaTools.updateScheduler({
      minConcurrent: Number($('minConcurrent').value),
      maxConcurrent: Number($('maxConcurrent').value),
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
      sound: { enabled: $('soundEnabled').checked, volume: Number($('volume').value) }
    }
    if ($('apiKey').value) patch.apiKey = $('apiKey').value
    await window.megaTools.updateSettings(patch)
    $('apiKey').value = ''
    await refresh()
  } catch(e){showError(e)}
}

document.addEventListener('click', async (event) => {
  const id = event.target?.dataset?.cancel
  if (!id) return
  try { await window.megaTools.cancelTask(id); await refresh() } catch(e){showError(e)}
})
window.megaTools.onChanged(() => refresh())
refresh()
