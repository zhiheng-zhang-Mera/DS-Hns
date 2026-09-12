'use strict'

/**
 * Settings Entry (Update-Plan/Dual-UI.md 任务 7: Settings Entry).
 *
 * Daily Mode shows the settings the adapter normalized (model, permission mode,
 * workspace) and links back to the Mega dock for everything richer. It never
 * writes a setting itself: the dock is the settings surface, so there is exactly
 * one writer.
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
    const dialog = byId('settingsPanel')
    if (open && dialog) open.addEventListener('click', () => handlers.onOpen?.())
    if (close && dialog) close.addEventListener('click', () => handlers.onClose?.())
    if (dialog) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) handlers.onClose?.()
      })
    }
  }

  ui.settings = { render, mount }
})(window)
