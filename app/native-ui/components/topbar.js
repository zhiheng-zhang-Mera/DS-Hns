'use strict'

/**
 * Daily Top Bar (Update-Plan/daily-refactorr.md 任务 3).
 *
 * Shows the working context and only the working context:
 *
 *   Workspace · Current Session · Model · Permission Mode · Task Status ·
 *   Backend Status
 *
 * The two switches the plan allows here (workspace, model) go through the main
 * process; everything else is display. Updater, Sub-worker detail, the theme
 * generator and diagnostics are deliberately absent: they are system management
 * and belong to Mega.
 */
;(function attachTopbar(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  const ACTIVE_TASK_STATES = ['RUNNING', 'DISPATCHING', 'PENDING', 'SUSPENDED', 'QUEUED']

  function workspaceLabel(settings) {
    const value = settings && settings.workspace
    if (!value) return 'workspace: —'
    const parts = String(value).split(/[\\/]/).filter(Boolean)
    return `workspace: ${parts[parts.length - 1] || value}`
  }

  /** Running/queued counts, from the same Task model the context panel uses. */
  function taskSummary(tasks) {
    const active = (Array.isArray(tasks) ? tasks : []).filter((task) =>
      ACTIVE_TASK_STATES.includes(String(task && task.status).toUpperCase()))
    const running = active.filter((task) => String(task.status).toUpperCase() === 'RUNNING').length
    const queued = active.length - running
    return { active: active.length, running, queued, text: `tasks: ${running} running · ${queued} queued` }
  }

  function render(state) {
    const settings = state.settings || {}
    const workspace = byId('workspaceChip')
    if (workspace) {
      workspace.textContent = workspaceLabel(settings)
      workspace.title = settings.workspace || '未配置工作区'
    }
    const model = byId('modelSelect')
    if (model) {
      const available = Array.isArray(settings.models) ? settings.models : []
      const current = settings.model || ''
      const options = available.length ? available : (current ? [current] : [])
      const signature = options.join('|')
      if (model.dataset.options !== signature) {
        model.innerHTML = options.map((entry) => `<option value="${esc(entry)}">${esc(entry)}</option>`).join('')
        model.dataset.options = signature
      }
      if (current && model.value !== current) model.value = current
      model.disabled = options.length === 0
      model.title = current ? `当前模型：${current}` : '模型不可用'
    }
    const permission = byId('permissionChip')
    if (permission) permission.textContent = `permission: ${settings.permissionMode || '—'}`
    const summary = taskSummary(state.tasks)
    const taskChip = byId('taskChip')
    if (taskChip) {
      taskChip.textContent = summary.text
      taskChip.dataset.active = summary.active ? '1' : '0'
    }
    const backend = byId('backendChip')
    if (backend) {
      const status = state.backend || {}
      backend.textContent = `backend: ${status.state || 'unknown'}${status.version ? ` · ${status.version}` : ''}`
      backend.dataset.state = status.state || 'unknown'
      backend.title = status.reason || status.origin || 'Harness backend'
    }
    const title = byId('sessionTitle')
    if (title) title.textContent = (state.session && state.session.title) || 'Daily Workspace'
    const sub = byId('sessionSub')
    if (sub) {
      const pieces = []
      if (state.session && state.session.model) pieces.push(state.session.model)
      if (state.session && state.session.cwd) pieces.push(state.session.cwd)
      if (state.session && state.session.status) pieces.push(state.session.status)
      sub.textContent = pieces.join(' · ') || '未选择会话'
    }
    const mode = byId('modeChip')
    if (mode) {
      mode.textContent = state.mode === 'work' ? 'Work' : 'Daily'
      mode.dataset.mode = state.mode
    }
    const toggle = byId('toggleMode')
    if (toggle) toggle.textContent = state.mode === 'work' ? 'Daily Mode' : 'Work Mode'
  }

  function mount(handlers = {}) {
    const wire = (id, event, run) => {
      const element = byId(id)
      if (element && typeof element.addEventListener === 'function') element.addEventListener(event, run)
    }
    wire('workspaceChip', 'click', () => handlers.onPickWorkspace && handlers.onPickWorkspace())
    wire('modelSelect', 'change', (event) => handlers.onModelChange && handlers.onModelChange(event && event.target ? event.target.value : ''))
    wire('taskChip', 'click', () => handlers.onShowTasks && handlers.onShowTasks())
    wire('openSettings', 'click', () => handlers.onOpenSettings && handlers.onOpenSettings())
    wire('toggleMode', 'click', () => handlers.onToggleMode && handlers.onToggleMode())
  }

  ui.topbar = { render, mount, taskSummary, workspaceLabel }
})(window)
