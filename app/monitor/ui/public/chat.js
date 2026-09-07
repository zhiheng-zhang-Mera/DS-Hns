(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  let allThreads = []
  let queueThreads = []
  let selectedId = null
  let currentView = 'tasks'
  let lastBellSeq = 0

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
    return res.json()
  }

  function toast(text, kind) {
    const box = $('toastWrap')
    const div = document.createElement('div')
    div.className = 'toast' + (kind === 'error' ? ' error' : '')
    div.textContent = text
    box.appendChild(div)
    setTimeout(() => div.remove(), 4200)
  }

  // Ringtone bells also reach the chat view (toast + sound when not Electron;
  // under Electron the hidden audio host plays the ringtone for every view).
  async function pollBells() {
    try {
      const data = await fetchJson('/api/bells?after=' + lastBellSeq)
      for (const bell of data.bells || []) {
        toast(`${bell.event} — ${bell.taskId.slice(0, 12)}`)
        if (!DSSound.isElectron()) DSSound.playEvent(bell.event)
      }
      if (data.latest > lastBellSeq) lastBellSeq = data.latest
    } catch {
      /* no-op */
    }
  }

  function syncSoundButton() {
    const btn = $('soundBtnChat')
    if (!btn) return
    btn.textContent = DSSound.masterEnabled() ? '铃声:开' : '铃声:关'
  }

  function bindSoundButton() {
    const btn = $('soundBtnChat')
    if (!btn) return
    syncSoundButton()
    btn.addEventListener('click', async () => {
      try {
        await DSSound.setServerEnabled(!DSSound.masterEnabled())
      } catch (err) {
        toast('铃声开关保存失败:' + (err.message || err), 'error')
      }
      syncSoundButton()
    })
  }

  function fmtDate(ms) {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function mergeThreads() {
    const map = new Map()
    const upsert = (t) => {
      const old = map.get(t.id)
      if (!old) map.set(t.id, t)
      else map.set(t.id, { ...old, ...t })
    }
    for (const t of allThreads) upsert(t)
    for (const t of queueThreads) upsert(t)
    const list = [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return currentView === 'queue' ? list.filter((t) => ['PENDING', 'SUSPENDED', 'RUNNING', 'STARTING'].includes(t.status)) : list
  }

  function titleOf(t) {
    return (t.promptPreview || t.prompt || '').split('\n')[0] || t.id
  }

  function metaOf(t) {
    const time = t.endedAt || t.startedAt || t.createdAt
    const pieces = [fmtDate(time), t.model || '']
    if (t.estimated) pieces.push('费用为估计值')
    return pieces.filter(Boolean).join(' · ')
  }

  function renderThreadList() {
    const listEl = $('threadList')
    const list = mergeThreads().slice(0, 200)
    listEl.innerHTML = ''
    if (!list.length) {
      const empty = document.createElement('div')
      empty.className = 't-title muted'
      empty.textContent = '暂无任务'
      listEl.appendChild(empty)
      return
    }
    for (const t of list) {
      const div = document.createElement('div')
      div.className = 'thread-item st-' + String(t.status).toUpperCase() + (t.id === selectedId ? ' active' : '')
      div.dataset.id = t.id
      div.innerHTML =
        `<span class="t-dot"></span><div><div class="t-title">${esc(titleOf(t))}</div>` +
        `<div class="t-meta">${esc(t.status)} · ${esc(metaOf(t))}</div></div>`
      div.addEventListener('click', () => {
        selectedId = t.id
        renderThreadList()
        renderConversation(t)
        $('chatColumn').scrollIntoView()
      })
      listEl.appendChild(div)
    }
  }

  function currentSelected() {
    return mergeThreads().find((t) => t.id === selectedId) || null
  }

  function renderConversation(t) {
    const area = $('chatMessages')
    const empty = $('emptyState')
    if (!t) {
      area.innerHTML = ''
      area.appendChild(empty)
      empty.hidden = false
      $('threadState').textContent = '新会话'
      return
    }
    empty.hidden = true
    area.innerHTML = ''
    const status = String(t.status || 'PENDING').toUpperCase()
    const threadState = $('threadState')
    threadState.textContent = `${status}${t.reason ? ' · ' + t.reason : ''}`

    const prompt = t.prompt || t.promptPreview || ''
    if (prompt) {
      area.appendChild(msgUser(prompt))
    } else {
      area.appendChild(msgUser(`任务 ${t.id}`))
    }
    area.appendChild(msgAgentFor(t))
    area.scrollTop = area.scrollHeight
  }

  function msgUser(text) {
    const div = document.createElement('div')
    div.className = 'msg-user'
    div.textContent = text
    return div
  }

  function msgAgentFor(t) {
    const wrap = document.createElement('div')
    wrap.className = 'msg-agent'
    const head = document.createElement('div')
    head.className = 'agent-head'
    head.innerHTML = `<span class="dot"></span> DeepSeek Harness · ${esc(t.model || 'deepseek-v4-flash')}`
    wrap.appendChild(head)

    const body = document.createElement('div')
    const status = String(t.status || 'PENDING').toUpperCase()
    if (status === 'RUNNING' || status === 'STARTING') {
      body.className = 'agent-body status'
      body.innerHTML =
        `<div class="status-line"><span class="bar"><i></i></span>正在执行任务…` +
        `${t.startedAt ? ' 已运行 ' + Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000)) + 's' : ''}</div>`
      if (t.schedulerHint) {
        const hint = document.createElement('div')
        hint.className = 'mini'
        hint.textContent = t.schedulerHint
        body.appendChild(hint)
      }
    } else if (status === 'PENDING') {
      body.className = 'agent-body status'
      body.textContent = '已加入队列,等待调度…'
    } else if (status === 'SUSPENDED') {
      body.className = 'agent-body status'
      body.textContent = t.reason === 'peak-window'
        ? '任务已挂起:当前为高峰时段(PEAK),进入谷价后自动开始。'
        : t.reason === 'waiting-schedule'
          ? '任务已挂起:等待计划开始时间。'
          : '任务已挂起。'
    } else if (status === 'COMPLETED') {
      body.className = 'agent-body'
      const answer = t.assistantText || '任务已完成。查看日志可获取完整输出。'
      body.textContent = answer
    } else if (status === 'FAILED') {
      body.className = 'agent-body error'
      const msg = (t.error && (t.error.message || t.error)) || t.reason || '任务失败'
      body.textContent = `执行失败:${msg}`
    } else if (status === 'INTERRUPTED') {
      body.className = 'agent-body error'
      body.textContent = t.reason === 'user-cancel' ? '任务已取消。' : '任务已中断。'
    } else {
      body.className = 'agent-body status'
      body.textContent = t.status || '任务状态未知'
    }
    wrap.appendChild(body)

    const meta = document.createElement('div')
    meta.className = 'mini'
    meta.textContent =
      `开始 ${fmtDate(t.startedAt) || '—'} · 结束 ${fmtDate(t.endedAt) || '—'}` +
      (t.costCny != null ? ` · 费用 ¥${Number(t.costCny).toFixed(6)}${t.estimated ? '(估)' : ''}` : '')
    wrap.appendChild(meta)
    return wrap
  }

  let lastStatus = null
  let lastQueueData = null

  /* ------- usage strip: 对话框下常驻 输入/输出/命中率/成本 ------- */
  function pickUsageTask() {
    if (selectedId) {
      const t = currentSelected()
      if (t) return t
    }
    return mergeThreads().find((x) => x.usage || x.costCny != null) || null
  }

  function hitRateOf(u) {
    if (!u) return null
    const denom = (u.inputTokens || 0) + (u.cacheReadTokens || 0)
    return denom > 0 ? Math.round(((u.cacheReadTokens || 0) / denom) * 1000) / 10 : null
  }

  function renderUsageStrip() {
    const t = pickUsageTask()
    const stateEl = $('uState')
    const set = (id, v) => {
      const el = $(id)
      if (el) el.textContent = v
    }
    if (!t) {
      if (stateEl) {
        stateEl.textContent = 'IDLE'
        stateEl.className = 'badge'
      }
      set('uModel', '—')
      set('uIn', '0')
      set('uCache', '0')
      set('uOut', '0')
      set('uHit', '—')
      set('uCost', '—')
      set('uHint', '暂无任务 - 输入任务后在此常驻显示用量参考')
      return
    }
    const u = t.usage || {}
    if (stateEl) {
      stateEl.textContent = String(t.status || '—').toUpperCase()
      stateEl.className = 'badge ' + String(t.status || '').toLowerCase()
    }
    set('uModel', esc(t.model || '—'))
    set('uIn', (u.inputTokens || 0).toLocaleString())
    set('uCache', (u.cacheReadTokens || 0).toLocaleString())
    set('uOut', (u.outputTokens || 0).toLocaleString())
    const hit = hitRateOf(u)
    set('uHit', hit == null ? '—' : hit + '%')
    set('uCost', t.costCny != null ? Number(t.costCny).toFixed(6) + (t.estimated ? '(估)' : '') : '—')
    const title = esc((t.prompt || t.id || '').split('\n')[0]).slice(0, 40)
    const secs = Math.max(0, Math.floor(((t.endedAt || Date.now()) - (t.createdAt || Date.now())) / 1000))
    set('uHint', `会话 ${title}… · 时长 ${secs}s`)
  }

  /* ------- 小图标 + 鼠标悬浮概要窗 ------- */
  function hoverPop(kind, anchor) {
    const card = $('hoverPop')
    if (!card) return
    let html = ''
    if (kind === 'queue') {
      const s = (lastQueueData && lastQueueData.scheduler) || {}
      const counts = s.counts || {}
      const total = lastQueueData && lastQueueData.tasks ? lastQueueData.tasks.length : 0
      html =
        `<b>定时队列</b>` +
        `<div class="hp-row">等待 ${counts.PENDING || 0} · 挂起 ${counts.SUSPENDED || 0} · 运行 ${counts.RUNNING || 0}</div>` +
        `<div class="hp-row muted">已完成 ${counts.COMPLETED || 0} · 共 ${total} 条</div>` +
        `<div class="hp-hint">点击:切到“排队”面板管理/查看</div>`
    } else if (kind === 'balance') {
      const b = lastStatus && lastStatus.balance
      if (b && b.ok) {
        const cny = b.balances.find((x) => x.currency === 'CNY') || b.balances[0]
        html = cny
          ? `<b>账户余额</b>` +
            `<div class="hp-row">TOTAL <b>${Number(cny.total).toFixed(6)}</b></div>` +
            `<div class="hp-row">TOP-UP ${Number(cny.toppedUp).toFixed(6)}</div>` +
            `<div class="hp-row muted">GRANTED ${Number(cny.granted).toFixed(6)}</div>` +
            `<div class="hp-hint">点击:打开监控视图(成本/价格)</div>`
          : `<b>账户余额</b><div class="hp-row">无货币数据</div>`
      } else {
        const code = b && b.error && b.error.code
        html = `<b>账户余额</b><div class="hp-row">${code === 'MISSING_CREDENTIAL' ? '未配置 API Key' : 'API 暂不可用'}</div>`
      }
    } else if (kind === 'sound') {
      const st = DSSound.getState().sounds || { enabled: true, events: {} }
      const ev = st.events || {}
      const parts = ['COMPLETED', 'FAILED', 'INTERRUPTED']
        .map((n) => {
          const e = ev[n]
          return `${e && e.enabled !== false ? '●' : '○'} ${n}`
        })
        .join(' ')
      html =
        `<b>铃声 ${st.enabled === false ? '关' : '开'} · 音量 ${Math.round((st.volume || 0.8) * 100)}%</b>` +
        `<div class="hp-row muted">${esc(parts)}</div>` +
        `<div class="hp-hint">点击:总开关;设置页可换预设/上传/试听</div>`
    } else if (kind === 'peak') {
      const b = lastStatus && lastStatus.billing
      const peak = b ? b.status : null
      const nextTxt =
        b && b.nextChangeIso
          ? `${b.statusAfter || ''} @ ${b.nextChangeTime || ''}${b.secondsLeft != null ? ' (' + Math.floor(b.secondsLeft / 60) + ' 分后)' : ''}`
          : '无下一档'
      html =
        `<b>峰谷 ${peak || '—'}</b>` +
        `<div class="hp-row ${peak === 'PEAK' ? 'peak-t' : 'off-t'}">当前 ${peak === 'PEAK' ? '高峰' : '谷价'} · 谷价任务 ${peak === 'PEAK' ? '挂起等待' : '自动开始'}</div>` +
        `<div class="hp-row muted">下一档: ${esc(nextTxt)}</div>` +
        `<div class="hp-hint">点击:打开监控视图(时间轴)</div>`
    }
    card.innerHTML = html
    const r = anchor.getBoundingClientRect()
    const cw = card.offsetWidth || 260
    let left = Math.min(r.left, window.innerWidth - cw - 8)
    left = Math.max(6, left)
    let top = r.bottom + 8
    if (top + 150 > window.innerHeight) top = Math.max(6, r.top - (card.offsetHeight || 120) - 8)
    card.style.left = left + 'px'
    card.style.top = top + 'px'
    card.hidden = false
  }

  function hidePop() {
    const card = $('hoverPop')
    if (card) card.hidden = true
  }

  function bindPopovers() {
    const anchors = [
      ['queue', 'popQueueBtn'],
      ['balance', 'popBalBtn'],
      ['sound', 'soundBtnChat'],
      ['peak', 'periodBadge']
    ]
    for (const item of anchors) {
      const kind = item[0]
      const el = document.getElementById(item[1])
      if (!el) continue
      el.addEventListener('mouseenter', () => hoverPop(kind, el))
      el.addEventListener('click', () => {
        hidePop()
        if (kind === 'queue') {
          currentView = 'queue'
          for (const x of document.querySelectorAll('.nav-tab')) x.classList.toggle('active', x.dataset.view === 'queue')
          refreshTasks()
        } else if (kind === 'balance' || kind === 'peak') {
          window.location.href = '/'
        }
      })
    }
    const card = $('hoverPop')
    if (card) {
      card.addEventListener('mouseenter', () => {
        if (card._hideTimer) clearTimeout(card._hideTimer)
      })
      card.addEventListener('mouseleave', () => {
        card._hideTimer = setTimeout(hidePop, 120)
      })
    }
    document.addEventListener('click', (ev) => {
      if (ev.target.closest && !ev.target.closest('#hoverPop') && !ev.target.closest('.head-actions')) hidePop()
    })
  }

  function refreshRunningTimers() {
    const list = mergeThreads()
    const t = list.find((x) => x.id === selectedId)
    if (t && (t.status === 'RUNNING' || t.status === 'STARTING')) renderConversation(t)
    renderUsageStrip()
  }

  async function refreshTasks() {
    try {
      const [tasksData, queueData] = await Promise.all([
        fetchJson('/api/tasks'),
        fetchJson('/api/queue')
      ])
      allThreads = tasksData.tasks || []
      queueThreads = queueData.tasks || []
      lastQueueData = queueData
      // scheduler peak hint is attached by the server only to queue rows; keep statuses for direct sessions too.
      for (const q of queueThreads) q.schedulerHint = q.reason || ''
      renderThreadList()
      if (selectedId && currentSelected()) renderConversation(currentSelected())
      else if (!selectedId) renderConversation(null)
      renderUsageStrip()
    } catch {
      /* offline */
    }
  }

  async function applyStatus() {
    try {
      const s = await fetchJson('/api/status')
      lastStatus = s
      const badge = $('periodBadge')
      badge.textContent = s.billing?.status || 'OFF-PEAK'
      badge.className = 'badge ' + (s.billing?.status === 'PEAK' ? 'peak' : 'off')
      const hint = $('composerHint')
      hint.textContent = s.billing?.status === 'PEAK'
        ? '当前高峰时段:默认任务将排队等待谷价'
        : '当前谷价时段:任务可自动开始'
      $('modelLabel').textContent = s.model || 'deepseek-v4-flash'
    } catch {
      /* no-op */
    }
  }

  function bindEvents() {
    const newBtn = $('newChatBtn')
    const clearNew = () => {
      selectedId = null
      $('chatComposer').value = ''
      $('chatStartAt').value = ''
      $('chatAllowPeak').checked = false
      renderThreadList()
      renderConversation(null)
      $('chatComposer').focus()
    }
    newBtn.addEventListener('click', clearNew)

    for (const tab of document.querySelectorAll('.nav-tab')) {
      tab.addEventListener('click', () => {
        currentView = tab.dataset.view
        for (const x of document.querySelectorAll('.nav-tab')) x.classList.toggle('active', x === tab)
        refreshTasks()
      })
    }

    $('chatForm').addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const prompt = $('chatComposer').value.trim()
      if (!prompt) return
      const startVal = $('chatStartAt').value
      const body = {
        prompt,
        allowPeak: $('chatAllowPeak').checked,
        startAt: startVal ? new Date(startVal).toISOString() : null
      }
      const send = $('sendBtn')
      send.disabled = true
      const resp = await postJson('/api/queue', body)
      send.disabled = false
      if (!resp.ok) {
        toast('任务添加失败:' + (resp.error || '未知错误'), 'error')
        return
      }
      selectedId = resp.task?.id || null
      $('chatComposer').value = ''
      $('chatStartAt').value = ''
      await refreshTasks()
      const item = currentSelected()
      if (item) renderConversation(item)
      toast('已加入排队队列')
    })

    $('chatComposer').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        $('chatForm').dispatchEvent(new Event('submit', { cancelable: true }))
      }
    })

  }

  function boot() {
    if (window.dsDesktop && window.dsDesktop.isElectron) {
      document.body.classList.add('electron')
    }
    bindEvents()
    bindSoundButton()
    bindPopovers()
    DSSound.refresh().then(syncSoundButton)
    refreshTasks()
    applyStatus()
    renderConversation(null)
    setInterval(applyStatus, 2000)
    setInterval(refreshTasks, 3000)
    setInterval(refreshRunningTimers, 1000)
    setInterval(pollBells, 1500)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
