'use strict'

/**
 * The frosted-glass layer, applied to this document.
 *
 * The layer itself is stylesheet rules (see the glass block at the end of `dock.css`); this
 * script only carries the three numbers those rules are made of — whether the layer is on, how
 * strong the blur is, and how much of the skin's surface colour survives in a pane — from
 * `data/state/ui-glass.json` into the document.
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
    syncControls
  }

  /**
   * The switch and the two sliders the Appearance panel renders.
   *
   * They are wired here rather than by the panel module because the layer is product chrome: it
   * is in force whether or not that panel has ever been attached, and its controls are static
   * markup. Dragging a slider previews locally and writes once on release, so the state file is
   * written when the user has chosen a value rather than while they are choosing it.
   */
  function syncControls(next = state) {
    const document = document_()
    if (!document || typeof document.getElementById !== 'function') return false
    const toggle = document.getElementById('themeGlass')
    const blur = document.getElementById('themeGlassBlur')
    const opacity = document.getElementById('themeGlassOpacity')
    const row = document.getElementById('themeGlassRow')
    if (toggle && 'checked' in toggle) toggle.checked = next.enabled !== false
    if (blur && 'value' in blur) blur.value = String(next.blur)
    if (opacity && 'value' in opacity) opacity.value = String(next.opacity)
    if (row && row.dataset) row.dataset.enabled = next.enabled === false ? '0' : '1'
    return true
  }

  function wireControls() {
    const document = document_()
    if (!document || typeof document.getElementById !== 'function') return false
    const toggle = document.getElementById('themeGlass')
    const blur = document.getElementById('themeGlassBlur')
    const opacity = document.getElementById('themeGlassOpacity')
    if (toggle && typeof toggle.addEventListener === 'function') {
      toggle.addEventListener('change', () => {
        set({ enabled: toggle.checked === true }).then(syncControls)
      })
    }
    for (const [input, key] of [[blur, 'blur'], [opacity, 'opacity']]) {
      if (!input || typeof input.addEventListener !== 'function') continue
      input.addEventListener('input', () => syncControls(apply({ [key]: Number(input.value) })))
      input.addEventListener('change', () => {
        set({ [key]: Number(input.value) }).then(syncControls)
      })
    }
    return syncControls()
  }

  // The markup ships the layer on, so this is only about replacing the defaults with the user's
  // own numbers — and about following them if another surface changes them.
  wireControls()
  refresh().then(syncControls)
  const api = bridge()
  if (api && typeof api.onChanged === 'function') {
    api.onChanged((payload) => {
      if (payload && payload.ok !== false) syncControls(apply(payload))
    })
  }
})(window)
