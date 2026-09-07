(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const soundEnabled = () => localStorage.getItem('dsSound') !== 'off'
  const audioCache = {}

  function playSound(name) {
    if (!soundEnabled()) return
    const map = { COMPLETED: '/sounds/completed.wav', FAILED: '/sounds/failed.wav', INTERRUPTED: '/sounds/interrupted.wav' }
    const url = map[name]
    if (!url) return
    let audio = audioCache[name]
    if (!audio) {
      audio = new Audio(url)
      audioCache[name] = audio
    }
    audio.currentTime = 0
    audio.play().catch(() => {})
  }

  let lastBellSeq = 0

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c])

  function fmtClock(date) {
    const p = (n) => String(n).padStart(2, '0')
    return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  }

  function fmtCountdown(seconds) {
    seconds = Math.max(0, Math.floor(seconds))
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    const p = (n) => String(n).padStart(2, '0')
    return `${p(h)}:${p(m)}:${p(s)}`
  }

  function fmtDuration(ms) {
    if (ms == null) return '—'
    const s = Math.max(0, Math.floor(ms / 1000))
    const p = (n) => String(n).padStart(2, '0')
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
  }

  function fmtDate(ms) {
    if (!ms) return '—'
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function money(x) {
    if (x == null) return '—'
    return Number(x).toFixed(4)
  }

  function money6(x) {
    if (x == null) return '—'
    return Number(x).toFixed(6)
  }

  function showToast(text, cls) {
    const t = $('toast')
    t.textContent = text
    t.className = 'toast' + (cls ? ' ' + cls : '')
    t.hidden = false
    clearTimeout(showToast._timer)
    showToast._timer = setTimeout(() => { t.hidden = true }, 5000)
  }

  function applyStatus(s) {
    // Local/billing clocks update every second; labels come from server status.
    if (s.billing) {
      const badge = $('peakBadge')
      badge.textContent = s.billing.status
      badge.className = 'badge ' + (s.billing.status === 'PEAK' ? 'peak' : 'off')
      const next = s.billing.nextChangeIso
      $('nextChange').textContent = next
        ? `下一档: ${s.billing.statusAfter} @ ${s.billing.nextChangeTime} (${fmtCountdown(s.billing.secondsLeft)})`
        : '下一档: —'
      $('billingLabel').textContent = (s.billing.label || 'BILLING · BEIJING') + ' · ' + s.billing.timeZone
    }
    $('localLabel').textContent = s.local?.label || 'LOCAL'
    $('localZone').textContent = s.local?.browserZone || ''
    $('billingTime').textContent = s.billing?.time || '--:--:--'

    // Model / pricing card.
    const modelId = s.model
    $('curModel').textContent = modelId
    const period = s.billing?.status || 'OFF-PEAK'
    renderPriceCard(modelId, period, s.pricesSource)

    // Balance.
    const b = s.balance
    if (b && b.ok) {
      const cny = b.balances.find((x) => x.currency === 'CNY') || b.balances[0]
      if (cny) {
        $('balTotal').textContent = money6(cny.total)
        $('balTopup').textContent = money6(cny.toppedUp)
        $('balGranted').textContent = money6(cny.granted)
        $('balanceState').textContent = b.isAvailable ? '可用' : '余额不足'
        $('balanceMeta').textContent = '获取于 ' + fmtDate(b.fetchedAt)
      } else {
        $('balanceMeta').textContent = '账户未返回余额信息'
      }
    } else {
      $('balTotal').textContent = '—'
      $('balTopup').textContent = '—'
      $('balGranted').textContent = '—'
      const code = b?.error?.code || ''
      $('balanceState').textContent = code === 'MISSING_CREDENTIAL' ? '未配置 API Key' : 'API 不可用'
      $('balanceMeta').textContent = b?.error?.message || '余额服务暂不可用 (不影响 Harness)'
    }

    // Task state.
    renderTask(s.activeTask)
    renderTimeline(window._timeline)

  }

  let pricingCache = null
  async function renderPriceCard(modelId, period, src) {
    if (!pricingCache) pricingCache = await fetchJson('/api/pricing')
    const model = (pricingCache.models || []).find((m) => m.id === modelId) || pricingCache.models?.[0]
    if (!model) return
    const rate = period === 'PEAK' ? 'peak' : 'offPeak'
    $('curPeriod').textContent = period
    $('curPeriod').className = 'badge ' + (period === 'PEAK' ? 'peak' : 'off')
    $('curInput').textContent = money(model.inputCacheMiss?.[rate])
    $('curCache').textContent = money(model.inputCacheHit?.[rate])
    $('curOutput').textContent = money(model.output?.[rate])
    $('curSaving').textContent = period === 'PEAK' ? '—' : '半价 (off-peak 50%)'
    $('priceSource').textContent =
      `价格源: ${src.source} · ${src.currency}/1M tokens · ${src.retrievedAt || ''}`
  }

  function renderTask(task) {
    const badge = $('taskState')
    if (!task) {
      badge.textContent = 'IDLE'
      badge.className = 'badge'
      $('taskDuration').textContent = '—'
      $('taskTokens').textContent = '—'
      $('taskCost').textContent = '—'
      $('taskModel').textContent = '—'
      $('taskInfo').textContent = '空闲 — 尚无任务记录'
    } else {
      badge.textContent = task.status + (task.stale ? ' (stale)' : '')
      badge.className = 'badge ' + task.status.toLowerCase()
      $('taskDuration').textContent = fmtDuration(task.status === 'RUNNING' || task.status === 'STARTING' ? Date.now() - task.createdAt : task.durationMs)
      const u = task.usage || {}
      const total = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0)
      $('taskTokens').textContent = total ? String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0'
      $('taskCost').textContent = task.costCny != null ? money6(task.costCny) + (task.estimated ? ' (估)' : '') : '—'
      $('taskModel').textContent = task.model || '—'
      const err = task.error ? ` · ${task.error.code}: ${task.error.message}` : ''
      $('taskInfo').textContent =
        `工作目录: ${task.cwd || '—'}${err} · 开始 ${fmtDate(task.createdAt)}`
      $('tokIn').textContent = 'in ' + (u.inputTokens || 0).toLocaleString()
      $('tokCache').textContent = 'cache-hit ' + (u.cacheReadTokens || 0).toLocaleString()
      $('tokOut').textContent = 'out ' + (u.outputTokens || 0).toLocaleString()
    }

  }

  function renderTimeline(s) {
    const box = $('timeline')
    box.innerHTML = ''
    const segs = s.timeline?.segments || []
    const start = s.timeline?.dayStartMs || 0
    const end = s.timeline?.dayEndMs || start + 86400000
    const now = Date.now()
    for (const seg of segs) {
      const div = document.createElement('div')
      div.className = 'tl-seg ' + (seg.status === 'PEAK' ? 'peak' : 'off')
      const w = Math.max(1, ((seg.untilMs - seg.fromMs) / (end - start)) * 100)
      div.style.width = w + '%'
      div.textContent = seg.status === 'PEAK' ? `${seg.fromBeijing}-${seg.untilBeijing}` : ''
      box.appendChild(div)
    }
    if (start && end && now >= start && now < end) {
      const mark = document.createElement('div')
      mark.className = 'now-mark'
      mark.style.left = `calc(${((now - start) / (end - start)) * 100}% - 1px)`
      box.appendChild(mark)
    }
  }

  function renderTasksTable(list) {
    const tb = $('taskTable').querySelector('tbody')
    tb.innerHTML = ''
    if (!list || !list.length) {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td colspan="7">暂无任务</td>'
      tb.appendChild(tr)
      return
    }
    for (const t of list) {
      const tr = document.createElement('tr')
      const u = t.usage || {}
      const total = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0)
      const err = t.error ? (t.error.code ? t.error.code + ' ' : '') + (t.error.message || '').slice(0, 70) : ''
      tr.innerHTML =
        `<td>${fmtDate(t.createdAt)}</td>` +
        `<td><span class="badge ${String(t.status).toLowerCase()}">${t.status}</span></td>` +
        `<td>${t.model || '—'}</td>` +
        `<td>${total.toLocaleString()}</td>` +
        `<td>${t.costCny != null ? money6(t.costCny) + (t.estimated ? ' (估)' : '') : '—'}</td>` +
        `<td>${fmtDuration(t.durationMs)}</td>` +
        `<td class="muted">${err || (t.cwd || '').split('\\').pop() || ''}</td>`
      tb.appendChild(tr)
    }
  }

  async function renderPriceTable(period) {
    if (!pricingCache) pricingCache = await fetchJson('/api/pricing')
    const tb = $('priceTable').querySelector('tbody')
    tb.innerHTML = ''
    const models = pricingCache.models || []
    const currentModel = $('curModel').textContent
    for (const model of models) {
      for (const p of ['peak', 'offPeak']) {
        const tr = document.createElement('tr')
        const isModel = model.id === currentModel
        const isPeriod = p === (period === 'PEAK' ? 'peak' : 'offPeak')
        const cls = (isModel ? 'hl-model' : '') + (isPeriod ? ' hl-period' : '')
        tr.className = cls
        tr.innerHTML =
          `<td>${model.id}${isModel ? ' ◀' : ''}</td>` +
          `<td>${p === 'peak' ? 'PEAK' : 'OFF-PEAK'}${isPeriod ? ' ◀' : ''}</td>` +
          `<td>${money(model.inputCacheHit?.[p])}</td>` +
          `<td>${money(model.inputCacheMiss?.[p])}</td>` +
          `<td>${money(model.output?.[p])}</td>`
        tb.appendChild(tr)
      }
    }
  }

  async function renderTasks() {
    try {
      const data = await fetchJson('/api/tasks')
      renderTasksTable(data.tasks)
    } catch {
      renderTasksTable([])
    }
  }

  async function renderTimelineAsync() {
    try {
      const tl = await fetchJson('/api/timeline')
      window._timeline = tl
      const marker = $('nowMarkerLegend')
      marker.textContent = ''
    } catch {
      /* no-op */
    }
  }

  async function pollBells() {
    try {
      const data = await fetchJson('/api/bells?after=' + lastBellSeq)
      for (const bell of data.bells || []) {
        playSound(bell.event)
        showToast(`${bell.event} — ${bell.taskId.slice(0, 8)}`)
      }
      if (data.latest > lastBellSeq) lastBellSeq = data.latest
    } catch {
      /* no-op */
    }
  }

  let queueState = { tasks: [], scheduler: null }

  async function renderQueue() {
    try {
      const data = await fetchJson('/api/queue')
      queueState = data
      const s = data.scheduler || {}
      const counts = s.counts || {}
      const total = data.tasks?.length || 0
      $('queueCounts').textContent =
        `共 ${total} · 等待 ${counts.PENDING || 0} · 挂起 ${counts.SUSPENDED || 0} · 运行 ${counts.RUNNING || 0} · 完成 ${counts.COMPLETED || 0}`
      $('queueHint').textContent = s.peak?.peak
        ? '当前为高峰时段(PEAK):谷价策略任务保持挂起,进入谷价后自动开始。'
        : '当前为谷价时段(OFF-PEAK):谷价策略任务可自动开始。'
      if (s.config) {
        const interrupt = $('cfgInterruptPeak')
        if (document.activeElement !== interrupt) interrupt.checked = Boolean(s.config.interruptRunningAtPeak)
        const minEl = $('cfgMin')
        const maxEl = $('cfgMax')
        if (document.activeElement !== minEl) minEl.value = s.config.minConcurrent
        if (document.activeElement !== maxEl) maxEl.value = s.config.maxConcurrent
      }
      renderQueueTable(data.tasks || [])
    } catch {
      /* no-op */
    }
  }

  function fmtPolicy(t) {
    if (!t.allowPeak) return '谷价优先'
    return '任意时段'
  }

  function renderQueueTable(list) {
    const tb = $('queueTable').querySelector('tbody')
    tb.innerHTML = ''
    if (!list.length) {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td colspan="7">队列为空 - 在上方添加任务</td>'
      tb.appendChild(tr)
      return
    }
    for (const t of list) {
      const tr = document.createElement('tr')
      const id = esc(t.id)
      const preview = esc(t.promptPreview || '')
      const title = esc(t.prompt || '')
      const reason = esc(t.reason || (t.error && (t.error.message || t.error)) || '')
      const cls = String(t.status).toLowerCase()
      const cancelBtn =
        t.status === 'PENDING' || t.status === 'SUSPENDED' || t.status === 'RUNNING'
          ? `<button class="action-btn" data-action="cancel" data-id="${id}">取消</button>`
          : ''
      const retryBtn =
        t.status === 'FAILED' || t.status === 'INTERRUPTED' || t.status === 'CANCELED'
          ? `<button class="action-btn" data-action="retry" data-id="${id}">再跑</button>`
          : ''
      const startInfo = t.startedAt ? fmtDate(t.startedAt) : '—'
      const endInfo = t.endedAt ? fmtDate(t.endedAt) : '—'
      tr.innerHTML =
        `<td title="${title}">${id}<div class="muted">${preview}</div></td>` +
        `<td><span class="badge ${cls}">${t.status}</span></td>` +
        `<td>${fmtPolicy(t)}</td>` +
        `<td>${t.startAtMs ? fmtDate(t.startAtMs) : '立即(窗口允许时)'}</td>` +
        `<td>${startInfo}<br><span class="muted">${endInfo}</span></td>` +
        `<td class="muted">${reason}${t.attempts > 1 ? ' · 尝试 ' + t.attempts : ''}</td>` +
        `<td>${cancelBtn}${retryBtn}</td>`
      tb.appendChild(tr)
    }
  }

  async function renderSystem() {
    try {
      const data = await fetchJson('/api/system')
      const s = data.system || {}
      const c = data.concurrency || {}
      $('sysCores').textContent = s.cpu ? `${s.cpu.cores} (${s.cpu.arch})` : '—'
      $('sysRam').textContent = s.memory ? `${s.memory.freeGb} / ${s.memory.totalGb} GB` : '—'
      $('sysCpu').textContent = s.cpu ? `${s.cpu.usagePercent.toFixed(1)}%` : '—'
      const badge = $('sysMax')
      badge.textContent = String(c.current || '—')
      badge.className = 'badge accent'
      if (c.current >= c.max) badge.textContent += ' (已达上限)'
    } catch {
      /* no-op */
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
    return res.json()
  }

  function bindQueueControls() {
    $('queueForm').addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const prompt = $('qPrompt').value.trim()
      const body = {
        prompt,
        taskId: $('qTaskId').value.trim() || null,
        allowPeak: $('qAllowPeak').checked,
        startAt: $('qStartAt').value ? new Date($('qStartAt').value).toISOString() : null
      }
      const resp = await postJson('/api/queue', body)
      if (resp.ok) {
        $('qPrompt').value = ''
        $('qStartAt').value = ''
        $('qTaskId').value = ''
        $('qAllowPeak').checked = false
        showToast('任务已加入队列')
        renderQueue()
      } else {
        showToast('加入失败: ' + (resp.error || '未知错误'), 'error-text')
      }
    })

    document.querySelector('#queueTable tbody').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action]')
      if (!btn) return
      const id = btn.dataset.id
      const action = btn.dataset.action
      if (action === 'cancel') {
        await postJson(`/api/queue/${encodeURIComponent(id)}/cancel`, {})
        renderQueue()
      } else if (action === 'retry') {
        const found = queueState.tasks?.find((t) => t.id === id)
        if (found) {
          const resp = await postJson('/api/queue', {
            prompt: found.prompt,
            allowPeak: found.allowPeak,
            startAt: found.startAtMs ? new Date(found.startAtMs).toISOString() : null
          })
          if (!resp.ok) showToast('重排失败: ' + resp.error, 'error-text')
          else renderQueue()
        }
      }
    })

    $('clearQueue').addEventListener('click', async () => {
      const resp = await postJson('/api/queue/clear', {})
      showToast(`已清空 ${resp.cleared || 0} 个等待任务`)
      renderQueue()
    })

    $('cfgSave').addEventListener('click', async () => {
      const resp = await postJson('/api/queue/config', {
        minConcurrent: Number($('cfgMin').value) || 1,
        maxConcurrent: Number($('cfgMax').value) || 4,
        interruptRunningAtPeak: $('cfgInterruptPeak').checked
      })
      if (resp.ok) showToast('并发设置已保存并立即生效')
      else showToast('保存失败: ' + (resp.error || ''), 'error-text')
      renderQueue()
      renderSystem()
    })
  }

  async function tick() {
    const now = new Date()
    $('localTime').textContent = fmtClock(now)
    try {
      const s = await fetchJson('/api/status')
      applyStatus(s)
      await renderPriceTable(s.billing?.status)
      void now
    } catch {
      showToast('Monitor 后端暂时不可用', 'error-text')
    }
  }

  function boot() {
    const runtime = $('runtimeBadge')
    if (window.dsDesktop && window.dsDesktop.isElectron) {
      document.body.classList.add('electron')
      runtime.hidden = false
      runtime.textContent = 'Electron ' + window.dsDesktop.versions.electron
      document.title = 'DeepSeek Harness (Desktop)'
    } else {
      runtime.hidden = false
      runtime.textContent = '浏览器模式'
    }
    $('soundToggle').textContent = soundEnabled() ? '铃声: 开' : '铃声: 关'
    $('soundToggle').addEventListener('click', () => {
      if (soundEnabled()) localStorage.setItem('dsSound', 'off')
      else localStorage.removeItem('dsSound')
      $('soundToggle').textContent = soundEnabled() ? '铃声: 开' : '铃声: 关'
    })
    bindQueueControls()
    renderTasks()
    renderTimelineAsync()
    renderQueue()
    renderSystem()
    tick()
    setInterval(tick, 2000)
    setInterval(renderQueue, 3000)
    setInterval(renderSystem, 5000)
    setInterval(pollBells, 1500)
    setInterval(renderTimelineAsync, 60000)
    setInterval(renderTasks, 8000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
