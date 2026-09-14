'use strict'

/**
 * Appearance (外观) — the frosted-glass layer's control surface.
 *
 * This module used to be the theme panel: the HNS theme system's only user-facing surface, with a
 * natural-language prompt, a live preview on the real dock, a theme list and a detail view. The
 * dock is no longer skinned, so none of that has anything left to control, and the module is what
 * the requirement says it should be — the switch and the two numbers the glass is made of.
 *
 * Three decisions are implemented here:
 *
 *   1. **Live, not on save.** A slider's `input` event applies the new number to the document
 *      immediately (`hnsGlass.apply`), and only the `change` event — the release — writes the
 *      state file through the shell. The effect the user is dragging is the effect they get, and
 *      the disk is written once per decision rather than once per pixel.
 *   2. **The panel reflects the layer, it does not own it.** The numbers live in
 *      `data/state/ui-glass.json` and are validated by the shell; this module renders whatever the
 *      layer reports, including a change made by another surface, so the controls cannot disagree
 *      with the dock.
 *   3. **It cannot fail the dock.** A missing bridge, a rejecting shell or an absent control all
 *      degrade to "the layer keeps the values it already has" — the panel is a convenience over
 *      chrome that is in force whether or not anyone ever opened it.
 */
;(function attachAppearancePanel() {
  const $ = (id) => document.getElementById(id)

  /** The layer this panel drives, published by `glass-layer.js`, which loads first. */
  function layer() {
    return window.hnsGlass || null
  }

  const state = { message: null, busy: false }

  function setMessage(text, kind = '') {
    state.message = text ? { text, kind } : null
    renderMessage()
  }

  function renderMessage() {
    const node = $('glassMessage')
    if (!node) return
    node.textContent = state.message ? state.message.text : ''
    node.className = state.message && state.message.kind ? `theme-message ${state.message.kind}` : 'theme-message'
  }

  /**
   * Draw the state in force.
   *
   * Every control takes its value from the layer rather than from the event that changed it, so
   * a value the shell clamped — or one another surface set — is what the user sees.
   */
  function render(next) {
    const current = next || (layer() ? layer().state() : null)
    if (!current) return null
    const enabled = current.enabled !== false
    const toggle = $('glassEnabled')
    const blur = $('glassBlur')
    const opacity = $('glassOpacity')
    if (toggle && 'checked' in toggle) toggle.checked = enabled
    if (blur && 'value' in blur) blur.value = String(current.blur)
    if (opacity && 'value' in opacity) opacity.value = String(current.opacity)
    const row = $('glassRow')
    if (row && row.dataset) row.dataset.enabled = enabled ? '1' : '0'
    const blurValue = $('glassBlurValue')
    const opacityValue = $('glassOpacityValue')
    if (blurValue) blurValue.textContent = String(current.blur)
    if (opacityValue) opacityValue.textContent = String(current.opacity)
    const status = $('glassStatus')
    if (status) {
      status.textContent = enabled ? `磨砂玻璃 ${current.blur}px · ${current.opacity}%` : '磨砂玻璃已关闭 · glass off'
      status.className = `status-chip ${enabled ? 'ok' : 'neutral'}`
    }
    return current
  }

  /**
   * Wire the three controls.
   *
   * A slider previews on `input` and persists on `change`; the switch goes through the shell on
   * `change` and re-renders from the answer. Both paths end in `render`, which is what keeps the
   * readouts and the pane in step.
   */
  function bindControls() {
    const api = layer()
    if (!api) return false
    const toggle = $('glassEnabled')
    if (toggle && typeof toggle.addEventListener === 'function') {
      toggle.addEventListener('change', () => {
        api.set({ enabled: toggle.checked === true }).then(render)
      })
    }
    const sliders = [[$('glassBlur'), 'blur'], [$('glassOpacity'), 'opacity']]
    for (const [input, key] of sliders) {
      if (!input || typeof input.addEventListener !== 'function') continue
      // Live: the value reaches the stylesheet on the frame the user moves the handle.
      input.addEventListener('input', () => render(api.apply({ [key]: Number(input.value) })))
      input.addEventListener('change', () => {
        api.set({ [key]: Number(input.value) }).then(render)
      })
    }
    return true
  }

  /**
   * The wallpaper controls.
   *
   * The layer below is the glass's and this one is the wallpaper's, but both answer the same
   * question — what the dock looks like — so they are the same card and the same shape of wiring:
   * the shell owns the file and validates every value, the panel renders what it reports, and a
   * slider previews on the frame it moves.
   */
  let wallpaperState = null

  function wallpaperApi() {
    return window.megaTools && window.megaTools.wallpaper ? window.megaTools.wallpaper : null
  }

  function renderWallpaper(next) {
    if (next) wallpaperState = next
    const state = wallpaperState
    if (!state) return null
    const toggle = $('wallpaperEnabled')
    if (toggle && 'checked' in toggle) toggle.checked = state.enabled === true && Boolean(state.file)
    const name = $('wallpaperName')
    if (name) {
      const label = state.file
        ? `${state.name || state.file}${state.kind ? ` · ${state.kind}` : ''}${state.present === false ? ' · 文件缺失 · file missing' : ''}`
        : '未选择 · none chosen'
      name.textContent = label
      const small = document.createElement('small')
      small.textContent = state.note || '图片或视频；画在面板与磨砂玻璃之下，不遮挡、不拦截任何操作。'
      name.appendChild(document.createElement('br'))
      name.appendChild(small)
    }
    for (const [id, key] of [['wallpaperOpacity', 'opacity'], ['wallpaperBlur', 'blur'], ['wallpaperScrim', 'scrim']]) {
      const input = $(id)
      if (input && 'value' in input) input.value = String(state[key])
      const readout = $(`${id}Value`)
      if (readout) readout.textContent = String(state[key])
    }
    const fit = $('wallpaperFit')
    if (fit && 'value' in fit) fit.value = state.fit || 'cover'
    const clear = $('wallpaperClear')
    if (clear) clear.disabled = !state.file
    return state
  }

  async function loadWallpaper() {
    const api = wallpaperApi()
    if (!api || typeof api.describe !== 'function') return renderWallpaper({ enabled: false, file: null, name: null, kind: null, present: true, fit: 'cover', opacity: 55, blur: 0, scrim: 35, note: null })
    try {
      const described = await api.describe()
      return renderWallpaper(described && described.ok !== false ? described : null)
    } catch {
      return null
    }
  }

  function bindWallpaperControls() {
    const api = wallpaperApi()
    if (!api || typeof api.set !== 'function') return false
    const report = (result) => {
      if (result && result.ok === false) {
        setMessage(result.reason || '壁纸操作未被接受 · the wallpaper change was refused', 'error')
        return null
      }
      setMessage('')
      return renderWallpaper(result)
    }
    const pick = $('wallpaperPick')
    if (pick && typeof pick.addEventListener === 'function') {
      pick.addEventListener('click', () => {
        Promise.resolve(api.pick ? api.pick() : null).then((result) => {
          if (result && result.canceled === true) return
          report(result)
        })
      })
    }
    const clear = $('wallpaperClear')
    if (clear && typeof clear.addEventListener === 'function') {
      clear.addEventListener('click', () => Promise.resolve(api.set({ file: '', enabled: false })).then(report))
    }
    const enabled = $('wallpaperEnabled')
    if (enabled && typeof enabled.addEventListener === 'function') {
      enabled.addEventListener('change', () => Promise.resolve(api.set({ enabled: enabled.checked === true })).then(report))
    }
    const fit = $('wallpaperFit')
    if (fit && typeof fit.addEventListener === 'function') {
      fit.addEventListener('change', () => Promise.resolve(api.set({ fit: fit.value })).then(report))
    }
    for (const [id, key] of [['wallpaperOpacity', 'opacity'], ['wallpaperBlur', 'blur'], ['wallpaperScrim', 'scrim']]) {
      const input = $(id)
      if (!input || typeof input.addEventListener !== 'function') continue
      // Like the glass: the number reaches the layer on the frame it moves and the file is written
      // once, on release. No preview here — the shell owns the value, and a preview that disagreed
      // with it would be a second opinion about the same pixel.
      input.addEventListener('input', () => {
        const readout = $(`${id}Value`)
        if (readout) readout.textContent = String(input.value)
      })
      input.addEventListener('change', () => Promise.resolve(api.set({ [key]: Number(input.value) })).then(report))
    }
    return true
  }

  function attach() {
    const panel = $('appearancePanel')
    if (!panel) return null
    const api = layer()
    if (!api) {
      panel.dataset.unavailable = '1'
      setMessage('磨砂玻璃层不可用：这个页面没有加载 glass-layer.js', 'error')
      return null
    }
    bindControls()
    bindWallpaperControls()
    // Follow the layer, so a change made anywhere else lands on these controls too.
    api.onChange(render)
    render()
    loadWallpaper()

    return {
      render,
      /** Re-read the state in force from the shell. */
      refresh: () => Promise.all([api.refresh().then(render), loadWallpaper()]),
      /** The layer in force, for a caller that wants the numbers rather than the controls. */
      state: () => api.state(),
      /** Resolves once the panel's current work is done; there is no queue, only this. */
      settled: async () => true
    }
  }

  renderMessage()
  window.megaAppearancePanel = { attach, render, renderWallpaper }
})()
