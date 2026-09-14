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
   *
   * **There are two backdrops, and they are set separately**: the main screen (the picture over the
   * official UI, cut around the dock) and Mega itself. The scope selector says which one the rest of
   * the card edits — `both` is the shorthand for "the same picture in both places", which is also the
   * only case where the two copies are drawn as one image. The controls stay a *view* of the shell's
   * answer either way: they render the surface the scope names, including a value changed elsewhere.
   */
  let wallpaperState = null
  /** Which backdrop this card edits: `both`, `main` or `dock`. */
  let wallpaperScope = 'both'

  function wallpaperApi() {
    return window.megaTools && window.megaTools.wallpaper ? window.megaTools.wallpaper : null
  }

  function renderWallpaper(next) {
    if (next) wallpaperState = next
    const state = wallpaperState
    if (!state) return null
    const surface = state[wallpaperScope] || state.main || state
    const toggle = $('wallpaperEnabled')
    if (toggle && 'checked' in toggle) toggle.checked = state.enabled === true && (Boolean(surface.file) || wallpaperScope === 'both')
    const name = $('wallpaperName')
    if (name) {
      const scopeLabel = wallpaperScope === 'both'
        ? '两处一起 · both'
        : wallpaperScope === 'main' ? '主屏幕 · main screen' : 'Mega 界面 · Mega'
      const label = surface.file
        ? `${surface.name || surface.file}${surface.kind ? ` · ${surface.kind}` : ''}${surface.present === false ? ' · 文件缺失 · file missing' : ''}`
        : '未选择 · none chosen'
      name.textContent = label
      const small = document.createElement('small')
      const differ = wallpaperScope === 'both'
        && (state.main && state.dock)
        && (state.main.file !== state.dock.file)
        ? '两处当前不是同一张图 · the two backdrops differ right now'
        : null
      small.textContent = differ
        || state.note
        || `${scopeLabel}：图片或视频，铺在界面之下，不拦截任何操作。`
      name.appendChild(document.createElement('br'))
      name.appendChild(small)
    }
    for (const [id, key] of [['wallpaperOpacity', 'opacity'], ['wallpaperBlur', 'blur'], ['wallpaperScrim', 'scrim']]) {
      const input = $(id)
      if (input && 'value' in input) input.value = String(surface[key])
      const readout = $(`${id}Value`)
      if (readout) readout.textContent = String(surface[key])
    }
    const fit = $('wallpaperFit')
    if (fit && 'value' in fit) fit.value = surface.fit || 'cover'
    const scope = $('wallpaperScope')
    if (scope && 'value' in scope) scope.value = wallpaperScope
    const clear = $('wallpaperClear')
    if (clear) clear.disabled = !surface.file
    // The master switch dims the whole card, the same way the glass switch dims its own controls:
    // "off" is a state of the card, not of one control.
    const row = $('wallpaperRow')
    if (row && row.dataset) row.dataset.enabled = state.enabled === false ? '0' : '1'
    return state
  }

  /** The patch one control write means: the flat shape is "both", a named surface is that one. */
  function wallpaperPatch(values) {
    return wallpaperScope === 'both' ? { ...values } : { [wallpaperScope]: { ...values } }
  }

  async function loadWallpaper() {
    const api = wallpaperApi()
    // No bridge at all (the page was opened outside the shell): the card shows its shipped defaults
    // rather than nothing, in the shape the renderer reads — one block per backdrop.
    const offline = {
      enabled: false,
      main: { enabled: true, file: null, name: null, kind: null, present: true, fit: 'cover', opacity: 55, blur: 0, scrim: 35 },
      dock: { enabled: true, file: null, name: null, kind: null, present: true, fit: 'cover', opacity: 55, blur: 0, scrim: 35 }
    }
    if (!api || typeof api.describe !== 'function') return renderWallpaper(offline)
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
        Promise.resolve(api.pick ? api.pick({ scope: wallpaperScope }) : null).then((result) => {
          if (result && result.canceled === true) return
          report(result)
        })
      })
    }
    const clear = $('wallpaperClear')
    if (clear && typeof clear.addEventListener === 'function') {
      clear.addEventListener('click', () => Promise.resolve(api.set(wallpaperPatch({ file: '' }))).then(report))
    }
    const enabled = $('wallpaperEnabled')
    if (enabled && typeof enabled.addEventListener === 'function') {
      enabled.addEventListener('change', () => Promise.resolve(api.set({ enabled: enabled.checked === true })).then(report))
    }
    const scope = $('wallpaperScope')
    if (scope && typeof scope.addEventListener === 'function') {
      scope.addEventListener('change', () => {
        wallpaperScope = ['both', 'main', 'dock'].includes(scope.value) ? scope.value : 'both'
        renderWallpaper()
      })
    }
    const fit = $('wallpaperFit')
    if (fit && typeof fit.addEventListener === 'function') {
      fit.addEventListener('change', () => Promise.resolve(api.set(wallpaperPatch({ fit: fit.value }))).then(report))
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
      input.addEventListener('change', () => Promise.resolve(api.set(wallpaperPatch({ [key]: Number(input.value) }))).then(report))
    }
    return true
  }

  /**
   * The readability presets (`updateplan/startup2.md` §26-§28).
   *
   * One control over two layers, and the panel renders what the *shell* reports: the preset list comes
   * from the controller (so a new preset needs no change here), and the selected entry is what the
   * numbers in force look like — a hand-tuned mixture leaves the select on "custom" rather than
   * pretending to be the nearest preset.
   */
  function appearanceApi() {
    return window.megaTools && window.megaTools.appearance ? window.megaTools.appearance : null
  }

  async function loadAppearancePresets() {
    const api = appearanceApi()
    const select = $('appearancePreset')
    if (!select || !api || typeof api.describe !== 'function') return null
    try {
      const described = await api.describe()
      if (!described || described.ok === false) return null
      const options = []
      for (const preset of described.presets || []) {
        const option = document.createElement('option')
        option.value = preset.id
        option.textContent = preset.label
        if (preset.note) option.title = preset.note
        options.push(option)
      }
      const custom = document.createElement('option')
      custom.value = ''
      custom.textContent = '自定义 · custom'
      options.push(custom)
      select.innerHTML = ''
      for (const option of options) select.appendChild(option)
      select.value = described.active || ''
      return described
    } catch {
      return null
    }
  }

  function bindAppearancePresets() {
    const api = appearanceApi()
    const select = $('appearancePreset')
    if (!select || !api || typeof api.set !== 'function') return false
    select.addEventListener('change', () => {
      const preset = String(select.value || '')
      if (!preset) return
      Promise.resolve(api.set(preset)).then((result) => {
        if (result && result.ok === false) {
          setMessage(result.reason || '该预设未被接受 · the preset was refused', 'error')
          return
        }
        setMessage('')
        // The layers changed underneath the sliders, so the card re-reads them rather than guessing.
        loadWallpaper()
        return loadAppearancePresets()
      })
    })
    return loadAppearancePresets().then(() => true)
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
    bindAppearancePresets()
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
