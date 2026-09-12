'use strict'

/**
 * HNS Native Frontend controller (Update-Plan/Dual-UI.md 任务 6 / 任务 7 / 任务 20).
 *
 * Wires the HNS model to the components:
 *
 *   main process  --snapshot-->  store  --render-->  components
 *   components    --intent---->  main process (create / select / send / cancel)
 *
 * Failure policy (任务 20): a renderer-side failure never leaves a blank window.
 * It is reported to the shell, which moves the product to Work Mode while the
 * Harness keeps running. The render loop is guarded per component, so one broken
 * panel degrades only itself until the shell decides otherwise.
 */
;(function main(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { byId, esc, delegate } = ui.dom
  const bridge = global.hnsNative
  const store = global.hnsStore.createStore(global.hnsStore.initialState())

  const TOKEN_NONCE = 'hns-native-tokens'
  /** Poll cadence while Daily is on screen. Paused when Work Mode is visible. */
  const POLL_MS = 2500
  let pollTimer = null
  let visible = true
  let inFlight = false
  /**
   * Monotonic request id: a snapshot that was requested before a newer state
   * arrived must not be allowed to overwrite it. Without this, a slow response
   * from before a mode change (or a degrade) lands late and silently restores
   * the older state.
   */
  let refreshSeq = 0
  let adoptedSeq = 0
  let failureCount = 0
  let lastFailureReport = 0

  /* ------------------------------- rendering ------------------------------ */

  const COMPONENTS = [
    ['sessionList', () => ui.sessionList.render(store.get())],
    ['conversation', () => ui.conversation.render(store.get())],
    ['toolActivity', () => ui.toolActivity.render(store.get())],
    ['composer', () => ui.composer.render(store.get())],
    ['settings', () => ui.settings.render(store.get())]
  ]

  function renderShell() {
    const state = store.get()
    const title = byId('sessionTitle')
    if (title) title.textContent = state.session?.title || 'Daily Mode'
    const sub = byId('sessionSub')
    if (sub) {
      const pieces = []
      if (state.session?.model) pieces.push(state.session.model)
      if (state.session?.cwd) pieces.push(state.session.cwd)
      if (state.session?.status) pieces.push(state.session.status)
      sub.textContent = pieces.join(' · ')
    }
    const modeChip = byId('modeChip')
    if (modeChip) {
      modeChip.textContent = state.mode === 'work' ? 'Work' : 'Daily'
      modeChip.dataset.mode = state.mode
    }
    const banner = byId('banner')
    if (banner) {
      const message = state.error || state.notice || (state.degraded ? `Daily degraded: ${state.degraded.reason}` : null)
      banner.hidden = !message
      banner.dataset.kind = state.error ? 'error' : state.degraded ? 'warn' : 'info'
      banner.textContent = message || ''
    }
    const dialog = byId('settingsPanel')
    if (dialog) dialog.hidden = !state.settingsOpen
    document.body.dataset.mode = state.mode
    document.body.dataset.backend = state.backend?.state || 'unknown'
  }

  const RENDERERS = [['shell', renderShell], ...COMPONENTS]

  function render() {
    let failed = 0
    for (const [id, render] of RENDERERS) {
      try {
        render()
      } catch (error) {
        failed += 1
        console.error(`[hns-native] ${id} render failed`, error)
      }
    }
    if (failed) {
      failureCount += failed
      reportFailure(`${failed} native component(s) failed to render`)
    } else {
      failureCount = 0
    }
  }

  /**
   * Tell the shell the native frontend is failing (任务 20).
   *
   * Rate-limited: a broken component that throws every frame must not become an
   * IPC flood, but the first failure is always reported immediately.
   */
  function reportFailure(reason) {
    const now = Date.now()
    if (failureCount > 0 && now - lastFailureReport < 5000) return
    lastFailureReport = now
    try {
      bridge?.session?.reportFailure?.(reason)
    } catch (error) {
      console.error('[hns-native] failure report failed', error)
    }
  }

  /* --------------------------- theme (任务 14 / 15) ----------------------- */

  function applyTheme(payload) {
    if (!payload) return
    const root = document.documentElement
    if (typeof payload.css === 'string' && payload.css) {
      let sheet = document.getElementById('hnsNativeThemeSheet')
      if (!sheet) {
        sheet = document.createElement('style')
        sheet.id = 'hnsNativeThemeSheet'
        sheet.setAttribute('nonce', TOKEN_NONCE)
        document.head.appendChild(sheet)
      }
      sheet.textContent = `:root {\n${payload.css}\n}`
    }
    const slots = payload.slots || {}
    for (const [slotId, properties] of Object.entries(slots)) {
      if (!properties || typeof properties !== 'object') continue
      const prefix = `--hns-slot-${String(slotId).replace(/\./g, '-')}`
      for (const [property, value] of Object.entries(properties)) {
        if (value === undefined || value === null || value === '') continue
        root.style.setProperty(`${prefix}-${property}`, String(value))
      }
    }
    // Character, wallpaper, skin and decoration all land here (任务 15): the
    // native document owns the layers, the theme only supplies the asset.
    //
    // A slot value wins; when a theme only fills its *tokens* (which is how the
    // built-in packages declare their wallpaper, persona and decoration), the
    // property is removed so the stylesheet falls back to `var(--hns-asset-*)`.
    // Removing rather than writing `none` is what makes that fallback reachable.
    const persona = payload.persona || {}
    document.body.classList.toggle('theme-persona', Boolean(persona.enabled))
    document.body.dataset.themeId = payload.id || ''
    const background = slots['hns.window.background'] || slots['common.window.background'] || {}
    // A theme authored for the retired official overlay still carries its figure
    // on the overlay slot. Daily Mode is now where a character belongs, so that
    // asset is read here too: existing packages keep their character instead of
    // silently losing it (任务 15).
    const character = slots['hns.character.primary'] || slots['official.overlay.character_primary'] || {}
    const decoration = slots['hns.persona.decoration'] || slots['official.overlay.corner_decoration'] || {}
    setAssetVar(root, '--hns-native-background', imageOf(background))
    setAssetVar(root, '--hns-native-character', imageOf(character))
    setAssetVar(root, '--hns-native-decoration', imageOf(decoration))
    setAssetVar(root, '--hns-native-persona-avatar', imageOf(slots['hns.operator.avatar']) || imageOf(slots['hns.persona.status_avatar']))
    setAssetVar(root, '--hns-native-persona-banner', imageOf(slots['hns.persona.banner']))
    setVar(root, '--hns-native-character-opacity', character.opacity ?? 0)
    setVar(root, '--hns-native-decoration-opacity', decoration.opacity ?? 0)
    setVar(root, '--hns-native-background-opacity', background.opacity ?? 1)
    setVar(root, '--hns-native-persona-banner-opacity', persona.enabled ? (persona.bannerOpacity || 0.25) : 0)
    setVar(root, '--hns-native-persona-avatar-opacity', persona.enabled ? Math.min(1, (persona.decorationOpacity || 0.2) * 5) : 0)
  }

  /** The image a slot payload carries, whichever property name it used. */
  function imageOf(payload) {
    if (!payload || typeof payload !== 'object') return null
    for (const property of ['asset', 'image', 'background', 'overlay']) {
      const value = payload[property]
      if (typeof value !== 'string' || !value) continue
      if (value === 'none' || /^(#|rgb|hsl|linear-gradient|radial-gradient|transparent$)/i.test(value)) continue
      return value
    }
    return null
  }

  function setVar(root, name, value) {
    if (value === undefined || value === null || value === '') root.style.removeProperty(name)
    else root.style.setProperty(name, String(value))
  }

  function setAssetVar(root, name, asset) {
    // No asset from the theme: drop the property so the stylesheet's
    // `var(--hns-asset-*)` fallback can supply the token value.
    if (!asset || asset === 'none') root.style.removeProperty(name)
    else if (/^url\(|^var\(/i.test(asset)) setVar(root, name, asset)
    else setVar(root, name, `url("${String(asset).replace(/"/g, '%22')}")`)
  }

  /** Live slot geometry for the theme validator (the dock's contract, reused). */
  function reportRegions() {
    const measured = {}
    const map = {
      'hns.window.shell': '#hnsNative',
      'hns.process.panel': '#conversation',
      'hns.process.queue': '#sessionList',
      'hns.status.badge': '#modeChip',
      'common.input.default': '#composerInput',
      'common.button.primary': '#composerSend',
      'common.navigation.sidebar': '#sidebar'
    }
    for (const [slotId, selector] of Object.entries(map)) {
      const node = document.querySelector(selector)
      if (!node) continue
      try {
        const rect = node.getBoundingClientRect()
        measured[slotId] = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      } catch {
        // Measurement is best-effort observation.
      }
    }
    measured.componentTree = {
      root: '#hnsNative',
      mode: store.get().mode,
      theme: document.body.dataset.themeId || null,
      regions: Object.keys(measured).filter((key) => key !== 'componentTree')
    }
    try {
      bridge?.theme?.reportRegions?.(measured)
    } catch (error) {
      console.error('[hns-native] region report failed', error)
    }
    return measured
  }

  /* ------------------------------- data flow ------------------------------ */

  function adopt(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return
    const state = store.get()
    const activeSessionId = snapshot.session?.id || state.activeSessionId
    // Drop the local echo once the durable user message has arrived.
    let pendingEcho = state.pendingEcho
    if (pendingEcho && (snapshot.messages || []).some((message) =>
      message.role === 'user' && String(message.content || '').trim() === pendingEcho.prompt)) {
      pendingEcho = null
    }
    store.set({
      mode: snapshot.mode || state.mode,
      modeState: snapshot.modeState || state.modeState,
      degraded: snapshot.degraded ?? state.degraded,
      backend: snapshot.backend || state.backend,
      capability: snapshot.capability || state.capability,
      sessions: snapshot.sessions || [],
      sessionsDegraded: Boolean(snapshot.sessionsDegraded),
      activeSessionId,
      session: snapshot.session || null,
      messages: snapshot.messages || [],
      toolEvents: snapshot.toolEvents || [],
      conversation: snapshot.conversation || null,
      tasks: snapshot.tasks || [],
      composer: snapshot.composer || state.composer,
      settings: snapshot.settings || state.settings,
      diagnostics: snapshot.diagnostics || state.diagnostics,
      pendingEcho,
      error: snapshot.ok === false && snapshot.backend?.reason ? snapshot.backend.reason : state.error
    })
  }

  async function refresh({ quiet = false } = {}) {
    if (!bridge?.session?.snapshot || inFlight) return null
    const seq = ++refreshSeq
    inFlight = true
    try {
      const state = store.get()
      const snapshot = await bridge.session.snapshot(state.activeSessionId || undefined)
      if (seq < adoptedSeq) return snapshot
      adoptedSeq = seq
      if (snapshot && snapshot.mode === undefined) snapshot.mode = state.mode
      if (snapshot && snapshot.modeState === undefined) snapshot.modeState = state.modeState
      adopt(snapshot)
      // A *successful* snapshot clears a stale UI error; a failed one keeps the
      // reason the adapter reported, because that is the user's only explanation.
      if (snapshot?.ok) store.set({ error: null })
      return snapshot
    } catch (error) {
      const message = String(error?.message || error)
      console.error('[hns-native] snapshot failed', error)
      store.set({ error: `Snapshot failed: ${message}`, sessionsDegraded: true })
      reportFailure(`snapshot failed: ${message}`)
      return null
    } finally {
      inFlight = false
    }
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      if (!visible) return
      refresh({ quiet: true })
    }, POLL_MS)
  }

  function stopPolling() {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  /** Hidden renderers do no periodic work (任务 17 performance contract). */
  function setVisible(next) {
    visible = Boolean(next)
    if (visible) {
      refresh({ quiet: true })
      startPolling()
    } else {
      stopPolling()
    }
    document.body.dataset.visible = visible ? '1' : '0'
  }

  /* -------------------------------- actions ------------------------------- */

  async function onCreateSession() {
    try {
      const result = await bridge.session.create()
      if (!result?.ok) store.set({ error: result?.message || result?.reason || 'session/create failed' })
      await refresh()
    } catch (error) {
      store.set({ error: `Create session failed: ${error?.message || error}` })
    }
  }

  async function onSelectSession(sessionId) {
    if (!sessionId) return
    store.set({ activeSessionId: sessionId, pendingEcho: null })
    try {
      await bridge.session.select(sessionId)
    } catch (error) {
      store.set({ error: `Select failed: ${error?.message || error}` })
    }
    await refresh()
  }

  async function onSend(prompt) {
    const state = store.get()
    const sessionId = state.activeSessionId
    if (!sessionId || !prompt) return
    store.set({ sending: true, pendingEcho: { prompt, at: Date.now() }, error: null })
    try {
      const result = await bridge.session.send(sessionId, prompt)
      if (!result?.ok) {
        store.set({ error: result?.message || result?.reason || 'send failed', pendingEcho: null })
      }
    } catch (error) {
      store.set({ error: `Send failed: ${error?.message || error}`, pendingEcho: null })
    } finally {
      store.set({ sending: false })
      await refresh()
    }
  }

  async function onStop() {
    const state = store.get()
    if (!state.activeSessionId) return
    try {
      const result = await bridge.session.cancel(state.activeSessionId)
      if (!result?.ok) store.set({ error: result?.message || result?.reason || 'cancel failed' })
    } catch (error) {
      store.set({ error: `Cancel failed: ${error?.message || error}` })
    }
    await refresh()
  }

  async function onToggleMode() {
    try {
      await bridge.mode.toggle()
      await refresh()
    } catch (error) {
      store.set({ error: `Mode switch failed: ${error?.message || error}` })
    }
  }

  /**
   * Collapsible side modules (UI-local state).
   *
   * Sessions and Activity are the two big modules around the conversation; a
   * narrow window can fold either away. The choice is persisted per renderer and
   * never synchronised, because it belongs to this frontend's layout and not to
   * the shared session.
   */
  const PANEL_STATE_KEY = 'ds-hns.native.panels'

  function readPanelState() {
    try {
      const raw = global.localStorage ? global.localStorage.getItem(PANEL_STATE_KEY) : null
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writePanelState(state) {
    try {
      global.localStorage?.setItem(PANEL_STATE_KEY, JSON.stringify(state))
    } catch {
      // Collapsing still works for this session when storage is unavailable.
    }
  }

  function setupCollapsiblePanels() {
    const saved = readPanelState()
    for (const [panelId, buttonId] of [['sidebar', 'collapseSessions'], ['toolPanel', 'collapseActivity']]) {
      const panel = byId(panelId)
      const button = byId(buttonId)
      if (!panel || !button) continue
      const apply = (collapsed) => {
        panel.dataset.collapsed = collapsed ? '1' : ''
        button.textContent = collapsed ? '▸' : '▾'
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      }
      apply(Boolean(saved[panelId]))
      button.addEventListener('click', (event) => {
        event.stopPropagation?.()
        const collapsed = panel.dataset.collapsed !== '1'
        apply(collapsed)
        const state = readPanelState()
        state[panelId] = collapsed
        writePanelState(state)
      })
    }
  }

  /* --------------------------------- boot --------------------------------- */

  function bind() {
    setupCollapsiblePanels()
    ui.sessionList.mount({ onCreate: onCreateSession })
    ui.composer.mount(store, { onSend, onStop })
    ui.settings.mount({
      onOpen: () => store.set({ settingsOpen: true }),
      onClose: () => store.set({ settingsOpen: false })
    })
    delegate(byId('sessionList'), (event) => {
      const row = event.target?.closest?.('[data-session]')
      if (row) onSelectSession(row.dataset.session)
    })
    const modeButton = byId('toggleMode')
    if (modeButton) modeButton.addEventListener('click', onToggleMode)

    bridge?.mode?.onChange?.((payload) => {
      const degraded = payload?.degraded?.active ? payload.degraded : null
      store.set({
        mode: payload?.mode || store.get().mode,
        modeState: payload?.state || store.get().modeState,
        degraded
      })
      refresh({ quiet: true })
    })
    bridge?.session?.onChange?.((snapshot) => {
      // A push is authoritative and immediate: it also invalidates any snapshot
      // response that is still in flight, so an older read cannot undo it.
      adoptedSeq = ++refreshSeq
      adopt(snapshot)
      // A push only ever arrives for the visible renderer; keep the poll timer
      // in step with the mode the shell reported.
      setVisible(store.get().mode === 'daily')
    })
    bridge?.theme?.onApply?.((payload) => applyTheme(payload))
    bridge?.theme?.onProbeRegions?.(() => reportRegions())
    store.subscribe(() => render())
  }

  async function boot() {
    bind()
    render()
    try {
      const mode = await bridge?.mode?.get?.()
      if (mode) {
        store.set({
          mode: mode.mode || 'daily',
          modeState: mode.state || 'DAILY_ACTIVE',
          // The shell always reports `{ active, reason, at }`; only an *active*
          // degradation is a degradation.
          degraded: mode.degraded?.active ? mode.degraded : null
        })
      }
      const paint = await bridge?.theme?.paint?.()
      if (paint?.ok && paint.payload) applyTheme(paint.payload)
      const diagnostics = await bridge?.diagnostics?.describe?.()
      if (diagnostics) store.set({ diagnostics })
    } catch (error) {
      store.set({ error: `Startup failed: ${error?.message || error}` })
    }
    await refresh()
    setVisible(store.get().mode === 'daily')
    ui.composer.focus()
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', () => reportRegions())
    }
  }

  global.hnsNativeApp = {
    store,
    refresh,
    adopt,
    applyTheme,
    reportRegions,
    setVisible,
    onSend,
    onStop,
    onSelectSession,
    onCreateSession,
    onToggleMode,
    boot
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(window)
