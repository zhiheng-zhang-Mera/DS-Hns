'use strict'

/**
 * Session List (Update-Plan/Dual-UI.md 任务 7: Session List / Session Create /
 * Session Select).
 *
 * Renders `{ id, title, status, createdAt, updatedAt }` rows straight from the
 * HNS Session model. It has no idea that `session/list` exists.
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

  function render(state) {
    const list = byId('sessionList')
    if (!list) return
    const sessions = Array.isArray(state.sessions) ? state.sessions : []
    const activeId = state.activeSessionId
    byId('sessionCount').textContent = String(sessions.length)
    if (!sessions.length) {
      list.innerHTML = state.sessionsDegraded
        ? `<p class="empty">Session list unavailable${state.backend?.reason ? `: ${esc(state.backend.reason)}` : ''}</p>`
        : '<p class="empty">No sessions yet. Create one to start.</p>'
      return
    }
    list.innerHTML = sessions
      .map((session) => {
        const id = String(session.id || '')
        const active = id && id === activeId
        const status = STATUS_LABEL[session.status] || String(session.status || 'idle').toLowerCase()
        const running = session.running ? ' data-running="1"' : ''
        return `<button class="session-row${active ? ' active' : ''}" type="button" data-session="${esc(id)}"${running} ` +
          `title="${esc(session.title)}">` +
          `<span class="session-title">${esc(session.title)}</span>` +
          `<span class="session-meta"><span class="chip chip-${esc(status)}">${esc(status)}</span>` +
          `<time>${esc(timeAgo(session.updatedAt || session.createdAt))}</time></span>` +
          `</button>`
      })
      .join('')
  }

  /** Wire the sidebar's create button; selection is delegated by `app.js`. */
  function mount(handlers = {}) {
    const create = byId('newSession')
    if (create && typeof handlers.onCreate === 'function') {
      create.addEventListener('click', () => handlers.onCreate())
    }
  }

  ui.sessionList = { render, mount }
})(window)
