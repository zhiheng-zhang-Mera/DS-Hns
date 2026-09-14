'use strict'

/**
 * The frosted-glass layer, applied to this document.
 *
 * The layer itself is stylesheet rules (see the glass block at the end of `dock.css`); this
 * script only carries the three numbers those rules are made of — whether the layer is on, how
 * strong the blur is, and how much of the pane stays opaque — from `data/state/ui-glass.json`
 * into the document, and it is the dock's *only* source of appearance.
 *
 * It used to sit under a skin. The theme engine installed the active theme's tokens into this
 * document, and the layer mixed its tints out of them, which is why the dock read as a coloured
 * panel with a slightly transparent background rather than as glass. That path is gone: the
 * stylesheet's own palette is the material now, and nothing repaints over it.
 *
 * Why it is a script at all, rather than a class in the markup: the values are *user state*, so
 * they have to survive a reload and come from the shell that owns the file. The markup ships the
 * layer on, so a dock that never reaches the shell is still glass and there is no flash of an
 * unstyled panel while the first IPC round-trip is in flight; the persisted numbers replace the
 * defaults the moment the bridge answers.
 *
 * Nothing here can reach the official UI: this document is the dock, and the official renderer is
 * a different `WebContentsView` that never loads this file.
 */
;(function attachGlassLayer(global) {
  /** The shipped defaults, matching `app/extensions/mega/ui-glass.cjs`. */
  const DEFAULT_STATE = Object.freeze({ enabled: true, blur: 18, opacity: 62 })

  let state = { ...DEFAULT_STATE }
  const listeners = []

  function document_() {
    const document = global.document
    if (!document || !document.body || !document.documentElement) return null
    return document
  }

  /**
   * Apply one state.
   *
   * The boolean becomes the attribute the stylesheet keys off; the two numbers become the custom
   * properties it mixes with. No other module has to know the layer exists.
   *
   * This is the whole of "the effect renders live": a slider's `input` event calls this, and the
   * stylesheet recomputes on the next frame. Nothing is deferred to a save, and no skin repaints
   * over it afterwards.
   */
  function apply(next = {}) {
    state = {
      enabled: typeof next.enabled === 'boolean' ? next.enabled : state.enabled,
      blur: Number.isFinite(Number(next.blur)) ? Number(next.blur) : state.blur,
      opacity: Number.isFinite(Number(next.opacity)) ? Number(next.opacity) : state.opacity
    }
    const document = document_()
    if (!document || !document.body.dataset) return { ...state }
    const style = document.documentElement.style
    if (!style || typeof style.setProperty !== 'function') return { ...state }
    document.body.dataset.glass = state.enabled ? 'on' : 'off'
    style.setProperty('--hns-glass-blur', `${state.blur}px`)
    style.setProperty('--hns-glass-alpha', `${state.opacity}%`)
    for (const listener of listeners) {
      try {
        listener({ ...state })
      } catch {
        // A listener that throws is that listener's problem; the layer is already applied.
      }
    }
    return { ...state }
  }

  function bridge() {
    return global.megaTools && global.megaTools.glass ? global.megaTools.glass : null
  }

  /**
   * Change the layer.
   *
   * The shell owns the file and validates every value, so the change goes through it and the
   * answer — not the request — is what is applied. Without a bridge (a page opened outside the
   * shell) the patch is applied locally, which keeps the layer testable on its own.
   */
  async function set(patch = {}) {
    const api = bridge()
    if (!api || typeof api.set !== 'function') return apply(patch)
    try {
      const result = await api.set(patch)
      if (result && result.ok !== false) return apply(result)
      return { ...state }
    } catch {
      return { ...state }
    }
  }

  /** Flip the layer: what the Appearance panel's switch calls. */
  async function toggle() {
    return set({ enabled: !state.enabled })
  }

  /** Read the state in force from the shell and apply it. */
  async function refresh() {
    const api = bridge()
    if (!api || typeof api.describe !== 'function') return apply(state)
    try {
      const described = await api.describe()
      return described && described.ok !== false ? apply(described) : { ...state }
    } catch {
      return { ...state }
    }
  }

  global.hnsGlass = {
    DEFAULT_STATE,
    state: () => ({ ...state }),
    apply,
    set,
    toggle,
    refresh,
    /** Follow the layer: the panel shows the numbers, so it has to see every change. */
    onChange(listener) {
      if (typeof listener !== 'function') return false
      listeners.push(listener)
      return true
    }
  }

  // The markup ships the layer on, so this is only about replacing the defaults with the user's
  // own numbers — and about following them if another surface changes them.
  refresh()
  const api = bridge()
  if (api && typeof api.onChanged === 'function') {
    api.onChanged((payload) => {
      if (payload && payload.ok !== false) apply(payload)
    })
  }
})(window)
