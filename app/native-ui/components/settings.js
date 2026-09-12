'use strict'

/**
 * Settings Page (Update-Plan/Dual-UI.md 任务 7; Daily refactor 任务 2).
 *
 * Settings is a *page*, never the default view: Daily opens on the workspace and
 * this page is reached from the top bar (or from Mega). It shows the settings the
 * adapter normalized and points at Mega for everything richer. It never writes a
 * setting itself - the two the top bar owns go through the same main-process
 * writer the dock uses, so there is exactly one settings path.
 */
;(function attachSettings(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  function render(state) {
    const panel = byId('settingsBody')
    if (!panel) return
    const settings = state.settings || {}
    const backend = state.backend || {}
    const diagnostics = state.diagnostics || null
    const rows = [
      ['Backend', `${backend.state}${backend.version ? ` · ${backend.version}` : ''}`],
      ['Origin', backend.origin || '—'],
      ['Model', settings.model || '—'],
      ['Models available', settings.models?.length ? settings.models.join(', ') : '—'],
      ['Permission mode', settings.permissionMode || '—'],
      ['Workspace', settings.workspace || '—'],
      ['Frontend mode', `${state.mode} (${state.modeState})`],
      ['HNS model', diagnostics?.adapter?.model ? `v${diagnostics.adapter.model}` : '—'],
      ['Adapter contract', diagnostics?.adapter?.contract ? `v${diagnostics.adapter.contract}` : '—'],
      ['Compatibility', diagnostics?.compatibility?.nativeFrontend || 'not probed'],
      ['Degraded', state.degraded ? state.degraded.reason : 'no']
    ]
    panel.innerHTML = rows
      .map(([label, value]) => `<div class="setting-row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`)
      .join('')
  }

  function mount(handlers = {}) {
    const open = byId('openSettings')
    const close = byId('closeSettings')
    const page = byId('settingsPage')
    if (open && page && typeof open.addEventListener === 'function') open.addEventListener('click', () => handlers.onOpen?.())
    if (close && typeof close.addEventListener === 'function') close.addEventListener('click', () => handlers.onClose?.())
  }

  ui.settings = { render, mount }
})(window)
