'use strict'

/**
 * Theme Runtime.
 *
 * Owns the live theme state of the HNS product surface:
 *   - which theme is active (always resolvable, always recoverable to Dark);
 *   - what the renderer is currently painting (active theme or preview draft);
 *   - how effects adapt to machine load (HNS specialization §6 / §7).
 *
 * Performance contract (engineering spec §21 / HNS §6):
 *   - nothing here blocks the dock renderer: the payload is pushed as data, the
 *     renderer applies it in its own frame;
 *   - the load probe runs on an unref'd timer at a low frequency and never
 *     touches the scheduler, the hardware monitor or the log pipeline;
 *   - a degraded theme only ever *reduces* work (fewer animations, less blur,
 *     no decorative refresh).
 */
const path = require('node:path')

const contract = require('./contract')
const preview = require('./preview')
const capability = require('./capability')
const validator = require('./validator')

const LOAD_POLL_MS = 15_000
const CPU_HEAVY_PERCENT = 75
const MEMORY_TIGHT_GB = 1.5

/** Per-level effect budgets. Level 0 is the full design; level 2 is minimal. */
const EFFECT_BUDGET = Object.freeze({
  0: { label: 'full', allowAnimation: true, animationScale: 1, allowBlur: true, allowDecoration: true, allowAssets: true },
  1: { label: 'reduced', allowAnimation: true, animationScale: 0.5, allowBlur: false, allowDecoration: false, allowAssets: true },
  2: { label: 'minimal', allowAnimation: false, animationScale: 0, allowBlur: false, allowDecoration: false, allowAssets: false }
})

function createThemeRuntime({
  registry,
  recovery,
  applyToRenderer,
  readLoad = () => null,
  log = () => {},
  now = () => Date.now()
} = {}) {
  let active = null
  let activeId = null
  let previewState = null
  let effectLevel = 0
  let lastLoad = null
  let loadTimer = null
  const listeners = new Set()

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        log(`theme listener failed: ${error?.message || error}`)
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Dark token set used as the engine-wide fallback. */
  function darkTokens() {
    try {
      return registry.darkTokens()
    } catch {
      return {}
    }
  }

  function resolveDir(id) {
    if (!id) return null
    return registry.dirFor(id)
  }

  function loadTheme(id) {
    const result = recovery.guard(id)
    return result
  }

  /** Compute the effect budget from the current load. */
  function computeEffectLevel(load) {
    if (!load) return 0
    const cpu = Number(load.cpuPercent)
    const freeGb = Number(load.freeGb)
    const saturated = Number(load.running) > 0 && Number(load.slots) > 0 && Number(load.running) >= Number(load.slots)
    let level = 0
    if (Number.isFinite(cpu) && cpu >= CPU_HEAVY_PERCENT) level = 1
    if (Number.isFinite(freeGb) && freeGb < MEMORY_TIGHT_GB) level = 1
    if ((Number.isFinite(cpu) && cpu >= 92) || (Number.isFinite(freeGb) && freeGb < 0.6) || saturated) level = 2
    return level
  }

  /**
   * Apply the effect budget to a theme without mutating the package: the runtime
   * compiles a *degraded view* of the same design (HNS §7 — the theme may be
   * down-graded, the scheduling may not be touched).
   */
  function degradeTheme(theme, level) {
    if (!theme || level === 0) return theme
    const budget = EFFECT_BUDGET[level] || EFFECT_BUDGET[1]
    const tokens = { ...theme.tokens }
    const slots = { ...(theme.components?.slots || {}) }
    const animation = validator.normalizeAnimation(theme.components?.animation)

    if (!budget.allowBlur) tokens['effect.blur'] = '0px'
    if (!budget.allowAssets) {
      for (const tokenName of contract.TOKEN_NAMES) {
        if (contract.TOKENS[tokenName].kind !== contract.PROPERTY_KIND.ASSET) continue
        if (tokenName === 'asset.wallpaper') {
          // Keep the base surface instead of the wallpaper image.
          tokens[tokenName] = 'none'
        }
      }
      if (slots['hns.window.background']) {
        slots['hns.window.background'] = { ...slots['hns.window.background'], background: 'var(--hns-color-bg-base)' }
      }
      if (slots['hns.persona.decoration']) slots['hns.persona.decoration'] = { ...slots['hns.persona.decoration'], asset: 'none', opacity: 0 }
      if (slots['hns.persona.banner']) slots['hns.persona.banner'] = { ...slots['hns.persona.banner'], asset: 'none', opacity: 0 }
    }
    if (!budget.allowDecoration) {
      if (slots['hns.persona.decoration']) slots['hns.persona.decoration'] = { ...slots['hns.persona.decoration'], opacity: 0, animation: 'none' }
      if (slots['hns.window.overlay']) slots['hns.window.overlay'] = { ...slots['hns.window.overlay'], opacity: 0 }
    }

    const scaled = budget.allowAnimation
      ? { type: animation.type, intensity: Number((animation.intensity * budget.animationScale).toFixed(3)) }
      : { type: 'none', intensity: 0 }

    return {
      ...theme,
      tokens,
      components: { ...theme.components, slots, animation: scaled, degraded: { level, label: budget.label } },
      degraded: { level, label: budget.label }
    }
  }

  function rendererPayload(theme, options) {
    const degraded = degradeTheme(theme, effectLevel)
    const payload = preview.toRendererPayload(degraded, options)
    payload.effectLevel = effectLevel
    payload.effectLabel = (EFFECT_BUDGET[effectLevel] || EFFECT_BUDGET[0]).label
    return payload
  }

  /** Push the current paint target (active theme or preview) to the renderer. */
  function repaint() {
    try {
      if (previewState) applyToRenderer(rendererPayload(previewState.theme, { preview: true, draftId: previewState.draftId }))
      else if (active) applyToRenderer(rendererPayload(active, { preview: false }))
    } catch (error) {
      // A renderer failure must not break the theme subsystem: recover to Dark.
      log(`theme repaint failed: ${error?.message || error}; recovering to Dark`)
      const guard = recovery.guard(registry.RECOVERY_THEME_ID)
      active = guard.theme
      activeId = guard.theme.id
      try {
        applyToRenderer(rendererPayload(active, { preview: false }))
      } catch (innerError) {
        log(`theme recovery repaint failed: ${innerError?.message || innerError}`)
      }
    }
  }

  /**
   * Activate a theme by id. Returns a status describing what actually happened
   * (including whether Dark recovery kicked in).
   */
  function activate(id, { persist = true, reason = 'user' } = {}) {
    const guard = loadTheme(id)
    active = guard.theme
    activeId = guard.theme.id
    if (persist) {
      try {
        registry.writeActiveId(activeId, { reason, recovered: guard.recovered })
      } catch (error) {
        log(`active theme persist failed: ${error?.message || error}`)
      }
    }
    repaint()
    const status = {
      id: activeId,
      name: active.manifest?.name || activeId,
      requested: id,
      recovered: guard.recovered,
      reason: guard.reason,
      issues: guard.issues ? guard.issues.slice(0, 6) : [],
      effectLevel,
      effectLabel: (EFFECT_BUDGET[effectLevel] || EFFECT_BUDGET[0]).label,
      previewing: Boolean(previewState)
    }
    emit({ type: 'activated', status })
    log(`active theme: ${activeId}${guard.recovered ? ` (recovered from ${id}: ${guard.reason})` : ''}`)
    return status
  }

  /** Start a live preview of a draft theme. Nothing is registered or installed. */
  function startPreview(theme, draftId) {
    previewState = { theme, draftId, startedAt: now() }
    repaint()
    emit({ type: 'preview-started', draftId })
    return { draftId, previewing: true }
  }

  function updatePreview(theme, draftId) {
    if (!previewState || previewState.draftId !== draftId) return startPreview(theme, draftId)
    previewState = { ...previewState, theme }
    repaint()
    emit({ type: 'preview-updated', draftId })
    return { draftId, previewing: true }
  }

  /** Leave preview without installing: the previous active theme comes back. */
  function cancelPreview() {
    const draftId = previewState?.draftId || null
    previewState = null
    repaint()
    emit({ type: 'preview-cancelled', draftId })
    return { draftId, previewing: false, activeId }
  }

  /** Leave preview and make the previewed theme permanent. */
  function commitPreview() {
    if (!previewState) return { ok: false, reason: 'no_preview' }
    const id = previewState.theme.id || activeId
    previewState = null
    const status = activate(id, { persist: true, reason: 'preview-approved' })
    return { ok: true, ...status }
  }

  function currentTheme() {
    return previewState ? previewState.theme : active
  }

  function describe() {
    const budget = EFFECT_BUDGET[effectLevel] || EFFECT_BUDGET[0]
    return {
      active: activeId,
      activeName: active?.manifest?.name || activeId,
      themeApiVersion: contract.THEME_API_VERSION,
      previewing: Boolean(previewState),
      previewDraftId: previewState?.draftId || null,
      effectLevel,
      effect: { ...budget },
      load: lastLoad,
      degraded: effectLevel > 0,
      animation: active ? validator.normalizeAnimation(active.components?.animation) : { type: 'none', intensity: 0 },
      recovery: recovery.history().slice(-5)
    }
  }

  /** One load sample: cheap, isolated, and never throws into the caller. */
  function sampleLoad() {
    let load = null
    try {
      load = readLoad()
    } catch (error) {
      log(`load sample failed: ${error?.message || error}`)
      return lastLoad
    }
    if (!load) return lastLoad
    lastLoad = load
    const nextLevel = computeEffectLevel(load)
    if (nextLevel !== effectLevel) {
      const previous = effectLevel
      effectLevel = nextLevel
      log(`theme effect level ${previous} -> ${nextLevel} (${(EFFECT_BUDGET[nextLevel] || {}).label})`)
      repaint()
      emit({ type: 'effect-level', level: nextLevel, previous, load })
    }
    return lastLoad
  }

  function start() {
    if (loadTimer) return
    sampleLoad()
    loadTimer = setInterval(sampleLoad, LOAD_POLL_MS)
    loadTimer.unref?.()
    activeId = registry.readActiveId()
    activate(activeId, { persist: false, reason: 'startup' })
  }

  function stop() {
    if (loadTimer) {
      clearInterval(loadTimer)
      loadTimer = null
    }
    listeners.clear()
  }

  /** Capability manifest for the currently running configuration. */
  function manifest(extra = {}) {
    return capability.buildManifest({
      dockState: extra.dockState || null,
      pages: extra.pages || null,
      load: lastLoad,
      engineVersion: extra.engineVersion || null
    })
  }

  return {
    LOAD_POLL_MS,
    EFFECT_BUDGET,
    start,
    stop,
    subscribe,
    activate,
    startPreview,
    updatePreview,
    cancelPreview,
    commitPreview,
    repaint,
    describe,
    currentTheme,
    sampleLoad,
    manifest,
    darkTokens,
    resolveDir,
    computeEffectLevel,
    degradeTheme,
    rendererPayload,
    get activeId() { return activeId }
  }
}

module.exports = {
  LOAD_POLL_MS,
  CPU_HEAVY_PERCENT,
  MEMORY_TIGHT_GB,
  EFFECT_BUDGET,
  createThemeRuntime
}
