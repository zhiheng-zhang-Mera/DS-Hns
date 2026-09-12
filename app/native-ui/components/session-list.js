'use strict'

/**
 * Session Sidebar (Update-Plan/Daily-UX.md 任务 5).
 *
 * New session · search · grouped list (running / recent / archived) · active
 * state · rename · delete. Everything comes from the HNS Session model, so the
 * sidebar never reads the official DOM (任务 17).
 *
 * "Archived" has no Harness counterpart, so it is an explicitly *local* flag:
 * this renderer hides those sessions from the recent list and nothing about the
 * backend session changes. It is stored separately from the model precisely
 * because it is not a second copy of backend state.
 */
;(function attachSessionList(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId, timeAgo } = ui.dom

  const STATUS_LABEL = {
    RUNNING: 'running',
    IDLE: 'idle',
    COMPLETED: 'done',
    FAILED: 'failed',
    INTERRUPTED: 'stopped'
  }
  const ARCHIVE_KEY = 'ds-hns.native.archived'

  function archivedIds() {
    try {
      const raw = global.localStorage ? global.localStorage.getItem(ARCHIVE_KEY) : null
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  function toggleArchived(sessionId) {
    const id = String(sessionId || '')
    if (!id) return archivedIds()
    const next = new Set(archivedIds())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    const list = [...next]
    try {
      global.localStorage?.setItem(ARCHIVE_KEY, JSON.stringify(list))
    } catch {
      // Hiding is a convenience; the list still renders this session.
    }
    return list
  }

  function matches(session, query) {
    if (!query) return true
    const needle = String(query).trim().toLowerCase()
    if (!needle) return true
    return [session.title, session.id, session.cwd, session.model]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  }

  function row(session, activeId) {
    const id = String(session.id || '')
    const active = id && id === activeId
    const status = STATUS_LABEL[session.status] || String(session.status || 'idle').toLowerCase()
    return `<div class="session-row${active ? ' active' : ''}" role="listitem" data-session="${esc(id)}"` +
      `${session.running ? ' data-running="1"' : ''} title="${esc(session.title)}">` +
      `<span class="session-title">${esc(session.title)}</span>` +
      `<span class="session-meta"><span class="chip chip-${esc(status)}">${esc(status)}</span>` +
      `<time>${esc(timeAgo(session.updatedAt || session.createdAt))}</time>` +
      `<span class="session-actions">` +
      `<button type="button" class="session-action" data-session-action="rename" data-id="${esc(id)}" title="重命名">✎</button>` +
      `<button type="button" class="session-action" data-session-action="archive" data-id="${esc(id)}" title="归档（仅本机隐藏）">🗄</button>` +
      `<button type="button" class="session-action danger" data-session-action="delete" data-id="${esc(id)}" title="删除会话">🗑</button>` +
      `</span></span></div>`
  }

  function render(state) {
    const list = byId('sessionList')
    if (!list) return
    const sessions = Array.isArray(state.sessions) ? state.sessions : []
    const archived = new Set(archivedIds())
    const query = state.sessionQuery || ''
    byId('sessionCount').textContent = String(sessions.length)

    if (!sessions.length) {
      list.innerHTML = state.sessionsDegraded
        ? `<p class="empty">会话列表不可用${state.backend?.reason ? `：${esc(state.backend.reason)}` : ''}</p>`
        : '<p class="empty">还没有会话。创建一个开始工作。</p>'
      return
    }

    const visible = sessions.filter((session) => matches(session, query))
    const running = visible.filter((session) => session.running)
    const recent = visible.filter((session) => !session.running && !archived.has(String(session.id)))
    const hidden = visible.filter((session) => !session.running && archived.has(String(session.id)))
    const sections = [
      ['运行中', running],
      ['最近', recent],
      ['已归档（本机隐藏）', hidden]
    ].filter(([, entries]) => entries.length)

    if (!sections.length) {
      list.innerHTML = `<p class="empty">没有匹配 “${esc(query)}” 的会话</p>`
      return
    }
    list.innerHTML = sections
      .map(([label, entries]) =>
        `<div class="session-group">${esc(label)}</div>` + entries.map((session) => row(session, state.activeSessionId)).join(''))
      .join('')
  }

  /** Wire the sidebar's own controls; rows are delegated by `app.js`. */
  function mount(handlers = {}) {
    const create = byId('newSession')
    if (create && typeof create.addEventListener === 'function') create.addEventListener('click', () => handlers.onCreate?.())
    const search = byId('sessionSearch')
    if (search && typeof search.addEventListener === 'function') {
      search.addEventListener('input', (event) => handlers.onSearch?.(event && event.target ? event.target.value : ''))
    }
  }

  ui.sessionList = { render, mount, archivedIds, toggleArchived }
})(window)
