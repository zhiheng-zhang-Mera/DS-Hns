'use strict'

/**
 * Slim Top Bar (Update-Plan/Daily-UX.md 任务 3).
 *
 * The top bar answers four questions and nothing else:
 *
 *   which workspace · which model · which frontend · where is Settings
 *
 * Permission mode, task counts, backend status and diagnostics used to live here
 * and made the bar read like a monitoring dashboard. They moved to secondary
 * status in the utility drawer's Context tab, or to Mega.
 */
;(function attachTopbar(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  function workspaceLabel(settings) {
    const value = settings && settings.workspace
    if (!value) return 'workspace: —'
    const parts = String(value).split(/[\\/]/).filter(Boolean)
    return `workspace: ${parts[parts.length - 1] || value}`
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

    const mode = byId('modeChip')
    if (mode) {
      mode.textContent = state.mode === 'work' ? 'Work' : 'Daily'
      mode.dataset.mode = state.mode
    }
    const toggle = byId('toggleMode')
    if (toggle) toggle.textContent = state.mode === 'work' ? 'Daily Mode' : 'Work Mode'

    const title = byId('sessionTitle')
    if (title) title.textContent = (state.session && state.session.title) || 'Daily'
    const sub = byId('sessionSub')
    if (sub) {
      const pieces = []
      if (state.session && state.session.model) pieces.push(state.session.model)
      if (state.session && state.session.cwd) pieces.push(state.session.cwd)
      if (state.session && state.session.status) pieces.push(state.session.status)
      sub.textContent = pieces.join(' · ') || '未选择会话'
    }
  }

  function mount(handlers = {}) {
    const wire = (id, event, run) => {
      const element = byId(id)
      if (element && typeof element.addEventListener === 'function') element.addEventListener(event, run)
    }
    wire('workspaceChip', 'click', () => handlers.onPickWorkspace && handlers.onPickWorkspace())
    wire('modelSelect', 'change', (event) => handlers.onModelChange && handlers.onModelChange(event && event.target ? event.target.value : ''))
    wire('openSettings', 'click', () => handlers.onOpenSettings && handlers.onOpenSettings())
    wire('toggleMode', 'click', () => handlers.onToggleMode && handlers.onToggleMode())
  }

  ui.topbar = { render, mount, workspaceLabel }
})(window)
