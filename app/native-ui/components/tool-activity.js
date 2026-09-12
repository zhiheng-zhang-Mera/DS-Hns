'use strict'

/**
 * Tool / Task Activity (Update-Plan/Dual-UI.md 任务 7: Tool / Task Result).
 *
 * Renders the HNS ToolEvent and Task models: what the Harness is running, what
 * finished, and what failed. A tool with no result yet is the "running" state,
 * which is why the timeline does not need a second spinner concept.
 */
;(function attachToolActivity(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId, timeAgo } = ui.dom

  const TOOL_LABEL = { running: 'running', ok: 'done', error: 'failed' }

  function render(state) {
    const panel = byId('toolActivity')
    if (!panel) return
    const tools = Array.isArray(state.toolEvents) ? state.toolEvents : []
    const tasks = Array.isArray(state.tasks) ? state.tasks : []
    const openTasks = tasks.filter((task) => ['RUNNING', 'PENDING', 'QUEUED'].includes(String(task.status).toUpperCase()))
    const runningTools = tools.filter((tool) => tool.status === 'running')
    const badge = byId('toolBadge')
    if (badge) {
      badge.textContent = String(runningTools.length + openTasks.length)
      badge.dataset.active = runningTools.length + openTasks.length > 0 ? '1' : '0'
    }
    if (!tools.length && !tasks.length) {
      panel.innerHTML = '<p class="empty">No tool or task activity in this session.</p>'
      return
    }
    const toolRows = tools.slice(-30).reverse().map((tool) => {
      const status = TOOL_LABEL[tool.status] || tool.status
      const detail = tool.error?.message || (typeof tool.output === 'string' ? tool.output : '')
      return `<li class="tool-row" data-tool-status="${esc(tool.status)}">` +
        `<span class="tool-name">${esc(tool.name)}</span>` +
        `<span class="chip chip-${esc(status)}">${esc(status)}</span>` +
        `<time>${esc(timeAgo(tool.finishedAt || tool.startedAt))}</time>` +
        (detail ? `<p class="tool-detail">${esc(String(detail).slice(0, 400))}</p>` : '') +
        `</li>`
    })
    const taskRows = tasks.slice(0, 20).map((task) => `<li class="task-row" data-task-status="${esc(task.status)}">` +
      `<span class="task-title">${esc(task.title)}</span>` +
      `<span class="chip chip-${esc(String(task.status).toLowerCase())}">${esc(String(task.status).toLowerCase())}</span>` +
      `</li>`)
    panel.innerHTML =
      (toolRows.length ? `<h3>Tools</h3><ul class="tool-list">${toolRows.join('')}</ul>` : '') +
      (taskRows.length ? `<h3>Tasks</h3><ul class="task-list">${taskRows.join('')}</ul>` : '')
  }

  ui.toolActivity = { render }
})(window)
