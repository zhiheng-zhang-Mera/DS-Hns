'use strict'

/**
 * Composer (Update-Plan/Dual-UI.md 任务 7: Composer / Send Message / Stop).
 *
 * The composer never guesses whether it may send: it renders the ComposerState
 * the adapter derived from the real backend session, so "running" and "no
 * session" produce a disabled box with the reason attached instead of a send
 * that silently fails.
 */
;(function attachComposer(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  let handlers = {}

  function render(state) {
    const input = byId('composerInput')
    const send = byId('composerSend')
    const stop = byId('composerStop')
    const hint = byId('composerHint')
    const composer = state.composer || {}
    if (!input || !send) return
    if (handlers.mounted) {
      input.disabled = !composer.ready
      input.placeholder = composer.placeholder || 'Message the Harness...'
      send.disabled = !composer.canSend || !String(input.value || '').trim()
      stop.hidden = !composer.canStop
      const permission = byId('permissionSelect')
      if (permission) {
        const configured = state.settings?.permissionMode
        if (configured && permission.value !== configured) permission.value = configured
        permission.disabled = !composer.ready
      }
      if (hint) {
        hint.textContent = composer.ready
          ? (composer.reason || 'Enter to send · Shift+Enter for a new line')
          : (composer.reason || 'Backend unavailable')
        hint.dataset.state = composer.ready ? 'ok' : 'blocked'
      }
    }
  }

  function setDraft(store, value) {
    store.set({ draft: String(value || '') })
    const send = byId('composerSend')
    if (send) send.disabled = !store.get().composer?.canSend || !String(value || '').trim()
  }

  function mount(store, incoming = {}) {
    handlers = incoming
    const form = byId('composer')
    const input = byId('composerInput')
    const stop = byId('composerStop')
    if (!form || !input) return
    handlers.mounted = true
    input.addEventListener('input', () => setDraft(store, input.value))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit(store)
      }
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit(store)
    })
    if (stop) stop.addEventListener('click', () => handlers.onStop?.())
    const permission = byId('permissionSelect')
    if (permission && typeof permission.addEventListener === 'function') {
      permission.addEventListener('change', (event) => {
        const value = event && event.target ? event.target.value : ''
        if (value) handlers.onPermissionChange?.(value)
      })
    }
    render(store.get())
  }

  function focus() {
    const input = byId('composerInput')
    if (input && !input.disabled) {
      try {
        input.focus()
      } catch {
        // Focusing is cosmetic.
      }
    }
  }

  function submit(store) {
    const input = byId('composerInput')
    if (!input) return
    const text = String(input.value || '').trim()
    const state = store.get()
    if (!text || !state.composer?.canSend) return
    input.value = ''
    setDraft(store, '')
    handlers.onSend?.(text)
  }

  ui.composer = { render, mount, focus, setDraft, esc }
})(window)
