(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // 官方权限预设语义
  const PERM_ZH = {
    'read-only': '仅可查看',
    'workspace-write': '工作区内修改',
    'danger-full-access': '完全权限'
  }
  const permLabel = (p) => PERM_ZH[p] || p || '—'

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

  // 历史元数据(别名/文件夹)、批量选择与右键菜单状态
  let historyMeta = { aliases: {}, folders: {} }
  let batchMode = false
  let selected = new Set()
  let ctxRowId = null

  const QUEUE_DIR_RE = /[\\/]active[\\/]([^\\/]+?)[\\/]?$/

  function mergeThreads() {
    const map = new Map()
    const upsert = (t) => {
      const old = map.get(t.id)
      if (!old) map.set(t.id, t)
      else map.set(t.id, { ...old, ...t })
    }
    // 队列行优先(保留队列生命周期与 prompt);挂起任务自动启动后,其 dsh 会话
    // 折叠进同一条对话,绝不再开一条新对话。
    for (const t of queueThreads) upsert(t)
    for (const t of allThreads) {
      const m = QUEUE_DIR_RE.exec(t.cwd || '')
      if (m && map.has(m[1])) {
        const base = map.get(m[1])
        const merged = { ...base }
        for (const k of ['usage', 'assistantText', 'model', 'provider', 'createdAt', 'updatedAt', 'endedAt', 'durationMs', 'costCny', 'estimated', 'error']) {
          if (merged[k] == null && t[k] != null) merged[k] = t[k]
        }
        if (t.status && merged.status !== 'RUNNING' && merged.status !== 'STARTING') merged.status = t.status
        if (!merged.promptPreview && (t.prompt || t.assistantText)) merged.promptPreview = (t.prompt || t.assistantText).slice(0, 160)
        merged.sessionStatus = t.status
        map.set(m[1], merged)
        continue
      }
      upsert(t)
    }
    const list = [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return currentView === 'queue' ? list.filter((t) => ['PENDING', 'SUSPENDED', 'RUNNING', 'STARTING'].includes(t.status)) : list
  }

  function aliasOf(id) {
    return historyMeta.aliases && historyMeta.aliases[id] ? historyMeta.aliases[id] : null
  }

  function titleOf(t) {
    return aliasOf(t.id) || (t.promptPreview || t.prompt || '').split('\n')[0] || t.id
  }

  function metaOf(t) {
    const time = t.endedAt || t.startedAt || t.createdAt
    const pieces = [fmtDate(time), t.model || '']
    if (t.estimated) pieces.push('费用为估计值')
    return pieces.filter(Boolean).join(' · ')
  }

  function groupList(list) {
    const folders = new Set()
    for (const t of list) folders.add(historyMeta.folders[t.id] || '')
    const names = [...folders].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'zh')))
    const groups = []
    for (const name of names) groups.push({ name, items: list.filter((t) => (historyMeta.folders[t.id] || '') === name) })
    return groups
  }

  let sideSearch = ''
  let sideFilter = 'all'

  function applyThreadList() {
    let out = mergeThreads()
    if (sideFilter === 'active') {
      out = out.filter((t) => ['RUNNING', 'STARTING', 'PENDING'].includes(String(t.status).toUpperCase()))
    } else if (sideFilter === 'suspended') {
      out = out.filter((t) => String(t.status).toUpperCase() === 'SUSPENDED')
    } else if (sideFilter === 'done') {
      out = out.filter((t) => String(t.status).toUpperCase() === 'COMPLETED')
    } else if (sideFilter === 'failed') {
      out = out.filter((t) => ['FAILED', 'INTERRUPTED', 'CANCELED'].includes(String(t.status).toUpperCase()))
    }
    const q = sideSearch.trim().toLowerCase()
    if (q) {
      out = out.filter((t) => {
        const hay = `${titleOf(t)} ${t.prompt || ''} ${t.id} ${t.model || ''} ${t.assistantText || ''} ${t.error && (t.error.code || '')}`.toLowerCase()
        return hay.includes(q)
      })
    }
    return out
  }

  function renderThreadList() {
    const listEl = $('threadList')
    const list = applyThreadList().slice(0, 200)
    listEl.innerHTML = ''
    if (!list.length) {
      const empty = document.createElement('div')
      empty.className = 't-title muted'
      empty.textContent = batchMode
        ? '无可管理任务'
        : sideSearch.trim() || sideFilter !== 'all'
          ? '没有匹配的任务(试试清除搜索/筛选)'
          : '暂无任务'
      listEl.appendChild(empty)
      return
    }
    const groups = groupList(list)
    const hasFolders = Object.keys(historyMeta.folders || {}).length > 0
    for (const group of groups) {
      if (hasFolders && groups.length > 1) {
        const head = document.createElement('div')
        head.className = 'thread-group'
        head.textContent = group.name || '未分组'
        const cnt = document.createElement('span')
        cnt.className = 'cnt'
        cnt.textContent = String(group.items.length)
        head.appendChild(cnt)
        listEl.appendChild(head)
      }
      for (const t of group.items) {
        const div = document.createElement('div')
        const st = String(t.status || 'PENDING').toUpperCase()
        div.className =
          'thread-item st-' + st + (t.id === selectedId ? ' active' : '') + (selected.has(t.id) ? ' sel' : '')
        div.dataset.id = t.id
        const alias = aliasOf(t.id)
        div.innerHTML =
          `<input type="checkbox" class="thread-check" ${selected.has(t.id) ? 'checked' : ''} />` +
          `<span class="t-dot"></span><div><div class="t-title">${esc(titleOf(t))}${alias ? '<span class="alias-tag">✎</span>' : ''}</div>` +
          `<div class="t-meta">${esc(t.status)} · ${esc(metaOf(t))}</div></div>`
        div.addEventListener('click', (ev) => {
          if (ev.target.closest('.thread-check')) {
            const cb = ev.target
            if (cb.checked) selected.add(t.id)
            else selected.delete(t.id)
            updateBatchBar()
            renderThreadList()
            return
          }
          if (batchMode) {
            if (selected.has(t.id)) selected.delete(t.id)
            else selected.add(t.id)
            updateBatchBar()
            renderThreadList()
            return
          }
          selectedId = t.id
          renderThreadList()
          renderConversation(t)
          $('chatColumn').scrollIntoView()
        })
        div.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          openThreadCtx(t, ev.clientX, ev.clientY)
        })
        listEl.appendChild(div)
      }
    }
    document.body.classList.toggle('batch-mode', batchMode)
    const bar = $('batchBar')
    if (bar) bar.hidden = !batchMode
  }

  /* ---------------- 右键菜单 / 重命名 / 文件夹 / 删除 / 批量 ---------------- */

  function openThreadCtx(t, x, y) {
    ctxRowId = t.id
    const menu = $('threadCtx')
    menu.innerHTML =
      `<button data-ctx="open">打开</button>` +
      `<button data-ctx="rename">重命名…</button>` +
      `<button data-ctx="folder">移动到文件夹…</button>` +
      `<button data-ctx="delete" class="danger">删除</button>` +
      `<hr />` +
      `<button data-ctx="batch">批量操作…</button>`
    menu.hidden = false
    const r = menu.getBoundingClientRect()
    let left = Math.min(x, window.innerWidth - r.width - 8)
    let top = Math.min(y, window.innerHeight - r.height - 8)
    menu.style.left = Math.max(4, left) + 'px'
    menu.style.top = Math.max(4, top) + 'px'
  }

  function closeCtx() {
    const menu = $('threadCtx')
    if (menu) menu.hidden = true
    ctxRowId = null
  }

  function modalShow(html) {
    const box = $('modalBox')
    box.innerHTML = html
    $('modalMask').hidden = false
  }

  function modalClose() {
    $('modalMask').hidden = true
  }

  async function doRename(id, title) {
    try {
      const resp = await postJson('/api/history/rename', { id, title })
      if (!resp.ok) throw new Error(resp.error || '重命名失败')
      historyMeta = resp.meta
      await refreshTasks()
      toast('已重命名')
    } catch (err) {
      toast('重命名失败:' + (err.message || err), 'error')
    }
  }

  function renameDialog(id) {
    const name = titleOf(mergeThreads().find((x) => x.id === id) || {})
    modalShow(
      `<h3>重命名</h3>` +
        `<input id="mdRenameVal" type="text" value="${esc(name)}" maxlength="200" />` +
        `<p class="muted">仅修改显示名称(存于本地元数据,不改动会话文件/队列 prompt)。</p>` +
        `<div class="modal-actions"><button class="btn mini-btn" id="mdRenameCancel" type="button">取消</button>` +
        `<button class="btn mini-btn" id="mdRenameOk" type="button">保存</button></div>`
    )
    const val = $('mdRenameVal')
    if (val) val.focus()
    const ok = $('mdRenameOk')
    if (ok) {
      ok.addEventListener('click', async () => {
        modalClose()
        await doRename(id, val.value)
      })
    }
    const cancel = $('mdRenameCancel')
    if (cancel) cancel.addEventListener('click', modalClose)
  }

  function folderDialog(ids) {
    const folders = [...new Set(Object.values(historyMeta.folders || {}).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))
    const opts = `<option value="">(未分组)</option>` + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')
    modalShow(
      `<h3>移动到文件夹 (${ids.length} 项)</h3>` +
        `<select id="mdFolderSel">${opts}</select>` +
        `<input id="mdFolderNew" type="text" placeholder="或输入新文件夹名…" maxlength="80" />` +
        `<div class="modal-actions"><button class="btn mini-btn" id="mdFolderCancel" type="button">取消</button>` +
        `<button class="btn mini-btn" id="mdFolderOk" type="button">移动</button></div>`
    )
    const ok = $('mdFolderOk')
    if (ok) {
      ok.addEventListener('click', async () => {
        const sel = $('mdFolderSel')
        const fresh = $('mdFolderNew')
        const folder = (fresh && fresh.value.trim()) || (sel && sel.value) || ''
        modalClose()
        try {
          const resp = await postJson('/api/history/move', { ids, folder })
          if (!resp.ok) throw new Error(resp.error || '移动失败')
          historyMeta = resp.meta
          await refreshTasks()
          toast(folder ? `已移动到“${folder}”` : '已移出文件夹(未分组)')
        } catch (err) {
          toast('移动失败:' + (err.message || err), 'error')
        }
      })
    }
    const cancel = $('mdFolderCancel')
    if (cancel) cancel.addEventListener('click', modalClose)
  }

  async function deleteIds(ids) {
    try {
      const resp = await postJson('/api/history/delete', { ids })
      if (!resp.ok) throw new Error(resp.error || '删除失败')
      for (const id of ids) {
        if (selectedId === id) selectedId = null
        selected.delete(id)
      }
      await refreshTasks()
      toast(`已删除 ${resp.removed || ids.length} 项`)
    } catch (err) {
      toast('删除失败:' + (err.message || err), 'error')
    }
  }

  function deleteConfirm(ids) {
    modalShow(
      `<h3>删除 ${ids.length} 项?</h3>` +
        `<p class="muted">将删除对应会话文件/队列记录与历史条目(队列中运行的任务会被终止)。此操作不可撤销。</p>` +
        `<div class="modal-actions"><button class="btn mini-btn" id="mdDelCancel" type="button">取消</button>` +
        `<button class="btn mini-btn danger" id="mdDelOk" type="button">删除</button></div>`
    )
    const ok = $('mdDelOk')
    if (ok) {
      ok.addEventListener('click', async () => {
        modalClose()
        await deleteIds(ids)
      })
    }
    const cancel = $('mdDelCancel')
    if (cancel) cancel.addEventListener('click', modalClose)
  }

  function setBatch(on) {
    batchMode = Boolean(on)
    if (!batchMode) selected.clear()
    renderThreadList()
    const bar = $('batchBar')
    if (bar) bar.hidden = !batchMode
    updateBatchBar()
  }

  function updateBatchBar() {
    const info = $('batchInfo')
    if (info) info.textContent = `已选 ${selected.size} 项`
    const all = $('batchSelAll')
    if (all) all.textContent = selected.size ? '取消全选' : '全选'
  }

  function bindHistoryExtras() {
    document.addEventListener('click', (ev) => {
      const menu = $('threadCtx')
      if (menu && !menu.hidden && !ev.target.closest('#threadCtx')) closeCtx()
      if (!ev.target.closest('#modalBox') && !ev.target.closest('.modal-actions') && !$('modalMask').hidden) {
        // close modal only when clicking the mask itself
        if (ev.target === $('modalMask')) modalClose()
      }
    })
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        closeCtx()
        modalClose()
        if (batchMode) setBatch(false)
      }
    })
    const menu = $('threadCtx')
    if (menu) {
      menu.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-ctx]')
        if (!btn) return
        const act = btn.dataset.ctx
        const id = ctxRowId
        closeCtx()
        const row = mergeThreads().find((x) => x.id === id) || null
        if (act === 'open' && row) {
          selectedId = id
          renderThreadList()
          renderConversation(row)
          $('chatColumn').scrollIntoView()
        } else if (act === 'rename' && row) {
          renameDialog(id)
        } else if (act === 'folder' && row) {
          folderDialog([id])
        } else if (act === 'delete' && row) {
          deleteConfirm([id])
        } else if (act === 'batch') {
          setBatch(true)
          if (id) {
            selected.add(id)
            updateBatchBar()
            renderThreadList()
          }
        }
      })
    }
    const bindBtn = (id, fn) => {
      const el = $(id)
      if (el) el.addEventListener('click', fn)
    }
    bindBtn('batchSelAll', () => {
      const list = mergeThreads()
      if (selected.size) selected.clear()
      else for (const t of list) selected.add(t.id)
      updateBatchBar()
      renderThreadList()
    })
    bindBtn('batchMove', () => {
      if (!selected.size) {
        toast('请先勾选要移动的任务', 'error')
        return
      }
      folderDialog([...selected])
    })
    bindBtn('batchDelete', () => {
      if (!selected.size) {
        toast('请先勾选要删除的任务', 'error')
        return
      }
      deleteConfirm([...selected])
    })
    bindBtn('batchCancel', () => setBatch(false))
    bindBtn('batchBar', null)
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
    if (Array.isArray(t.attachments) && t.attachments.length) {
      const att = document.createElement('div')
      att.className = 'msg-att'
      att.innerHTML = t.attachments.map((a) => `<span class="att-chip">📎 ${esc(a)}</span>`).join(' ')
      area.appendChild(att)
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
      body.textContent = suspendReasonText(t) + ' · 启动时间 ' + suspendStartText(t)
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
      (t.costCny != null ? ` · 费用 ¥${Number(t.costCny).toFixed(6)}${t.estimated ? '(估)' : ''}` : '') +
      (t.permissionMode ? ` · 权限 ${permLabel(t.permissionMode)}` : '') +
      (Array.isArray(t.attachments) && t.attachments.length ? ` · 📎 ${t.attachments.length}` : '')
    wrap.appendChild(meta)

    // ChatGPT/Codex 式消息操作:复制 / 停止(运行中、挂起、排队中)/ 再跑
    const actions = document.createElement('div')
    actions.className = 'msg-actions'
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'msg-btn ' + (cls || '')
      b.textContent = label
      b.addEventListener('click', () => fn(t))
      actions.appendChild(b)
    }
    mkBtn('复制回答', '', () => {
      const text = t.assistantText || body.innerText || ''
      copyText(text ? '回答已复制' : '该会话暂无可复制内容', text)
    })
    if (status === 'RUNNING' || status === 'STARTING' || status === 'PENDING' || status === 'SUSPENDED') {
      mkBtn('■ 停止', 'stop', () => doStop(t))
    }
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'INTERRUPTED' || status === 'CANCELED') {
      mkBtn('↻ 再跑', '', () => doRerun(t))
    }
    if (actions.childNodes.length) wrap.appendChild(actions)
    return wrap
  }

  function copyText(note, text) {
    if (!text) return
    const done = () => toast(note || '已复制')
    const fail = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        toast(note || '已复制')
      } catch (err) {
        toast('复制失败(请手动选择复制)', 'error')
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail)
    } else {
      fail()
    }
  }

  async function doStop(t) {
    try {
      const resp = await postJson('/api/queue/' + encodeURIComponent(t.id) + '/cancel', {})
      if (!resp.ok && resp.error && !/not found/.test(resp.error)) throw new Error(resp.error)
      toast('已请求停止任务')
      await refreshTasks()
    } catch (err) {
      toast('停止失败:' + (err.message || err), 'error')
    }
  }

  async function doRerun(t) {
    try {
      const resp = await postJson('/api/queue', {
        prompt: t.prompt || '',
        allowPeak: Boolean(t.allowPeak),
        startAt: null,
        permissionMode: t.permissionMode || null
      })
      if (!resp.ok) throw new Error(resp.error || '再跑失败')
      toast('已重新加入队列:' + (resp.task && resp.task.id))
      await refreshTasks()
    } catch (err) {
      toast('再跑失败:' + (err.message || err), 'error')
    }
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

  function suspendStartText(t) {
    if (t.startAtMs) return fmtDate(t.startAtMs)
    const nb = lastStatus && lastStatus.billing
    if (t.reason === 'peak-window' && nb && nb.nextChangeIso) return `谷价后≈${nb.nextChangeTime || ''}`
    return '—'
  }

  function suspendReasonText(t) {
    if (t.reason === 'waiting-schedule') return '等待计划启动'
    if (t.reason === 'peak-window') return '等待谷价(PEAK)'
    return t.reason || String(t.status || 'SUSPENDED')
  }

  function renderUsageStrip() {
    const t = pickUsageTask()
    const stateEl = $('uState')
    const set = (id, v) => {
      const el = $(id)
      if (el) el.textContent = v
    }
    const susWrap = $('usSusWrap')
    const atWrap = $('usAtWrap')
    const hideSus = () => {
      if (susWrap) susWrap.hidden = true
      if (atWrap) atWrap.hidden = true
    }
    if (!t) {
      if (stateEl) {
        stateEl.textContent = 'IDLE'
        stateEl.className = 'badge'
      }
      set('uModel', '—')
      set('uIn', '0')
      set('uCache', '0')
      set('uWrite', '0')
      set('uReason', '0')
      set('uOut', '0')
      set('uHit', '—')
      set('uCost', '—')
      set('uHint', '暂无任务 - 输入任务后在此常驻显示用量参考')
      hideSus()
      return
    }
    const u = t.usage || {}
    const st = String(t.status || '—').toUpperCase()
    if (stateEl) {
      stateEl.textContent = st
      stateEl.className = 'badge ' + String(t.status || '').toLowerCase()
    }
    set('uModel', esc(t.model || '—'))
    set('uIn', (u.inputTokens || 0).toLocaleString())
    set('uCache', (u.cacheReadTokens || 0).toLocaleString())
    set('uWrite', (u.cacheWriteTokens || 0).toLocaleString())
    set('uReason', (u.reasoningTokens || 0).toLocaleString())
    set('uOut', (u.outputTokens || 0).toLocaleString())
    const hit = hitRateOf(u)
    set('uHit', hit == null ? '—' : hit + '%')
    set('uCost', t.costCny != null ? Number(t.costCny).toFixed(6) + (t.estimated ? '(估)' : '') : '—')
    // 挂起状态 + 启动时间(计划开始或谷价下一档)额外显示
    if (st === 'SUSPENDED') {
      if (susWrap) {
        susWrap.hidden = false
        const rEl = $('uSusReason')
        if (rEl) rEl.textContent = suspendReasonText(t)
      }
      if (atWrap) {
        atWrap.hidden = false
        const aEl = $('uSusAt')
        if (aEl) aEl.textContent = suspendStartText(t)
      }
    } else {
      hideSus()
    }
    const title = esc((t.prompt || t.id || '').split('\n')[0]).slice(0, 40)
    const secs = Math.max(0, Math.floor(((t.endedAt || Date.now()) - (t.createdAt || Date.now())) / 1000))
    const stNote = st === 'SUSPENDED' ? ` · ${suspendReasonText(t)}` : ''
    set('uHint', `会话 ${title}…${stNote} · 时长 ${secs}s`)
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
      if (tasksData.meta) historyMeta = tasksData.meta
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

  // ---------------- 附件上传(发送前) ----------------
  let attachFiles = [] // { name, size, file }

  function fmtSize(b) {
    if (b == null) return ''
    if (b < 1024) return b + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    return (b / 1024 / 1024).toFixed(1) + ' MB'
  }

  function renderAttachChips() {
    const box = $('attachChips')
    if (!box) return
    box.hidden = !attachFiles.length
    box.innerHTML = ''
    attachFiles.forEach((f, i) => {
      const span = document.createElement('span')
      span.className = 'att-chip'
      span.innerHTML = `📎 ${esc(f.name)} <em>${fmtSize(f.size)}</em> <b class="att-x" data-i="${i}">×</b>`
      box.appendChild(span)
    })
  }

  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = reject
      r.readAsDataURL(file)
    })
  }

  function bindFileAttach() {
    const input = $('chatFiles')
    const box = $('attachChips')
    if (!input || !box) return
    input.addEventListener('change', () => {
      const picked = Array.from(input.files || [])
      for (const f of picked) {
        if (attachFiles.length >= 5) {
          toast('单次最多上传 5 个附件(已忽略其余)', 'error')
          break
        }
        if (f.size > 100 * 1024 * 1024) {
          toast(`附件过大(上限 100MB):${f.name}`, 'error')
          continue
        }
        if (!attachFiles.some((x) => x.name === f.name && x.size === f.size)) {
          attachFiles.push({ name: f.name, size: f.size, file: f })
        }
      }
      input.value = ''
      renderAttachChips()
    })
    box.addEventListener('click', (ev) => {
      const x = ev.target.closest('.att-x')
      if (!x) return
      const i = Number(x.dataset.i)
      if (!Number.isNaN(i)) attachFiles.splice(i, 1)
      renderAttachChips()
    })
  }

  // ---------------- 权限座椅(官方风险确认语义) ----------------
  let permSeatValue = 'workspace-write'
  let permAcked = false

  function resetPermSeat() {
    const sel = $('chatPerm')
    if (sel) sel.value = 'workspace-write'
    permSeatValue = 'workspace-write'
    permAcked = false
  }

  function bindPermSeat() {
    const sel = $('chatPerm')
    if (!sel) return
    sel.value = permSeatValue
    sel.addEventListener('change', () => {
      if (sel.value !== 'danger-full-access') {
        permSeatValue = sel.value
        return
      }
      if (permAcked) {
        permSeatValue = 'danger-full-access'
        return
      }
      modalShow(
        `<h3>确认启用完全权限?</h3>` +
          `<p class="muted">完全权限 = 任务可读写任意目录、不再逐次弹审批。请确认风险后继续。</p>` +
          `<label class="check-line"><input id="riskAck" type="checkbox" /> 我已了解风险，并愿意继续</label>` +
          `<div class="modal-actions"><button class="btn mini-btn" id="riskCancel" type="button">取消</button>` +
          `<button class="btn mini-btn danger" id="riskOk" type="button">启用完全权限</button></div>`
      )
      const ack = $('riskAck')
      const ok = $('riskOk')
      const cancel = $('riskCancel')
      const disable = () => {
        if (ok) ok.disabled = !ack.checked
      }
      if (ack) ack.addEventListener('change', disable)
      if (ok) {
        disable()
        ok.addEventListener('click', () => {
          modalClose()
          permAcked = true
          permSeatValue = 'danger-full-access'
          sel.value = 'danger-full-access'
        })
      }
      if (cancel) {
        cancel.addEventListener('click', () => {
          modalClose()
          sel.value = permSeatValue === 'danger-full-access' ? 'workspace-write' : permSeatValue
        })
      }
    })
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
      const files = attachFiles.slice()
      const taskId = files.length ? `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` : null
      const permissionMode = $('chatPerm') ? $('chatPerm').value : 'workspace-write'
      const send = $('sendBtn')
      send.disabled = true
      try {
        if (files.length) {
          // 1) 先把附件上传到 工作区\active\<taskId>\attachments\
          for (const f of files) {
            const data = await fileToB64(f.file)
            const up = await postJson('/api/attachments/upload', {
              taskId,
              files: [{ name: f.name, data }]
            })
            if (!up.ok) throw new Error(`附件上传失败(${f.name}):${up.error || '未知错误'}`)
          }
        }
        const body = {
          prompt,
          allowPeak: $('chatAllowPeak').checked,
          startAt: startVal ? new Date(startVal).toISOString() : null,
          taskId: taskId || null,
          permissionMode,
          attachments: files.map((f) => f.name)
        }
        const resp = await postJson('/api/queue', body)
        if (!resp.ok) throw new Error(resp.error || '任务添加失败')
        selectedId = resp.task?.id || taskId || null
        $('chatComposer').value = ''
        $('chatStartAt').value = ''
        $('chatAllowPeak').checked = false
        resetPermSeat()
        attachFiles = []
        renderAttachChips()
        await refreshTasks()
        const item = currentSelected()
        if (item) renderConversation(item)
        toast('已加入排队队列')
      } catch (err) {
        toast('任务添加失败:' + (err.message || err), 'error')
      } finally {
        send.disabled = false
      }
    })

    $('chatComposer').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        $('chatForm').dispatchEvent(new Event('submit', { cancelable: true }))
      }
    })

  }

  function bindSidebar() {
    const btn = document.getElementById('sideToggle')
    if (!btn) return
    const apply = (on) => {
      document.body.classList.toggle('side-collapsed', on)
      btn.textContent = on ? '»' : '«'
      btn.title = on ? '展开历史侧栏' : '收起历史侧栏'
      try {
        localStorage.setItem('dsside', on ? '1' : '0')
      } catch (err) {
        /* ignore */
      }
    }
    let collapsed = false
    try {
      collapsed = localStorage.getItem('dsside') === '1'
    } catch (err) {
      /* ignore */
    }
    apply(collapsed)
    btn.addEventListener('click', () => apply(!document.body.classList.contains('side-collapsed')))
  }

  // ---------------- 侧栏:搜索 / 视图筛选 / 添加工作区 ----------------
  let currentWorkspace = null

  async function refreshWorkspaceLabel() {
    try {
      const r = await fetchJson('/api/workspace')
      currentWorkspace = r.root || null
      const el = $('wsNow')
      if (el) {
        const parts = String(currentWorkspace || '').split(/[\\/]/).filter(Boolean)
        el.textContent = parts.length ? parts[parts.length - 1] + (parts.length > 1 ? '…' : '') : '未设置'
        el.title = currentWorkspace || ''
      }
    } catch (err) {
      /* offline */
    }
  }

  async function applyWorkspace(path) {
    try {
      const resp = await postJson('/api/workspace', { root: path })
      if (!resp.ok) throw new Error(resp.error || '设置失败')
      currentWorkspace = resp.root
      toast('工作区已切换:' + resp.root)
      await refreshWorkspaceLabel()
    } catch (err) {
      toast('工作区设置失败:' + (err.message || err), 'error')
    }
  }

  function bindSideControls() {
    const s = $('threadSearch')
    if (s) {
      s.addEventListener('input', () => {
        sideSearch = s.value
        renderThreadList()
      })
    }
    const chips = document.querySelectorAll('#viewFilter .filter-chip')
    for (const c of chips) {
      c.addEventListener('click', () => {
        sideFilter = c.dataset.filter || 'all'
        for (const x of document.querySelectorAll('#viewFilter .filter-chip')) x.classList.toggle('active', x === c)
        renderThreadList()
      })
    }
    const addBtn = $('wsAddBtn')
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        if (window.dsDesktop && window.dsDesktop.workspace) {
          try {
            const dir = await window.dsDesktop.workspace.pickDir()
            if (dir) await applyWorkspace(dir)
          } catch (err) {
            toast('选择目录失败', 'error')
          }
          return
        }
        modalShow(
          `<h3>添加 / 切换工作区</h3>` +
            `<input id="mdWsPath" type="text" placeholder="输入项目目录绝对路径…" />` +
            `<p class="muted">之后的新任务将在 该目录\\active\\&lt;任务ID&gt; 下执行。</p>` +
            `<div class="modal-actions"><button class="btn mini-btn" id="mdWsCancel" type="button">取消</button>` +
            `<button class="btn mini-btn primary" id="mdWsOk" type="button">应用</button></div>`
        )
        const ok = $('mdWsOk')
        const cancel = $('mdWsCancel')
        const inp = $('mdWsPath')
        if (inp) inp.focus()
        if (ok) {
          ok.addEventListener('click', async () => {
            const v = (inp && inp.value || '').trim()
            modalClose()
            if (v) await applyWorkspace(v)
          })
        }
        if (cancel) cancel.addEventListener('click', modalClose)
      })
    }
    refreshWorkspaceLabel()
  }

  function bindComposerAutoGrow() {
    const ta = document.getElementById('chatComposer')
    if (!ta) return
    const grow = () => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(180, Math.max(44, ta.scrollHeight)) + 'px'
    }
    ta.addEventListener('input', grow)
    grow()
  }

  function boot() {
    if (window.dsDesktop && window.dsDesktop.isElectron) {
      document.body.classList.add('electron')
    }
    bindEvents()
    bindFileAttach()
    bindPermSeat()
    bindSoundButton()
    bindPopovers()
    bindHistoryExtras()
    bindSidebar()
    bindSideControls()
    bindComposerAutoGrow()
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
