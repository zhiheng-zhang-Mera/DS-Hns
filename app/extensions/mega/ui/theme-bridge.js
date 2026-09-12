'use strict'

/**
 * Theme bridge — the single integration point between a dock UI module and the
 * HNS theme system.
 *
 * The dock has more than one UI module (Appearance, Skills), and the requirement
 * is that they adapt to each other in *both* directions:
 *
 *   theme -> module   a module registers the slots it renders, and the bridge
 *                     installs the active theme's payload on it as CSS custom
 *                     properties. A module never reads a token file or a theme
 *                     directory; it only ever receives declarative data.
 *
 *   module -> theme   a module reports the live geometry of the slots it owns, so
 *                     the UI inspector and the preview validator can see its real
 *                     elements. Without this a new panel would be invisible to
 *                     theme validation, and a theme could silently occlude it.
 *
 * A module that registers after the theme is already active still gets painted:
 * the bridge keeps the last payload and replays it on registration.
 *
 * Registration is per-slot-set: `registerModule({ id, slots, regions })` returns a
 * handle whose `paint(payload)`, `reportRegions()` and `refresh()` the module
 * calls. The bridge owns subscription, so a module cannot forget to unsubscribe
 * and cannot double-subscribe.
 */
;(function attachThemeBridge(global) {
  const SLOT_VAR = {
    background: 'background',
    label: 'label',
    border: 'border',
    radius: 'radius',
    shadow: 'shadow',
    color: 'color',
    accent: 'accent',
    placeholder: 'placeholder'
  }

  /**
   * Short aliases the dock stylesheet already consumes.
   *
   * The bridge writes every slot under its generic name
   * (`--hns-slot-<slot>-<property>`), so a panel added later needs no bridge change.
   * These aliases exist only so the long-standing dock rules keep working, and so
   * the dock stylesheet can keep using short, readable names for its own chrome.
   */
  const LEGACY_ALIAS = {
    'hns.window.shell': { background: '--hns-slot-shell-bg', border: '--hns-slot-shell-border', radius: '--hns-slot-shell-radius' },
    'hns.process.panel': { background: '--hns-slot-panel-bg', border: '--hns-slot-panel-border', radius: '--hns-slot-panel-radius', shadow: '--hns-slot-panel-shadow' },
    'hns.worker.card': { background: '--hns-slot-card-bg', border: '--hns-slot-card-border', radius: '--hns-slot-card-radius' },
    'hns.process.queue': { background: '--hns-slot-queue-bg', border: '--hns-slot-queue-border' },
    'hns.status.badge': { background: '--hns-slot-badge-bg', border: '--hns-slot-badge-border', radius: '--hns-slot-badge-radius' },
    'common.button.primary': { background: '--hns-slot-button-bg', label: '--hns-slot-button-label', radius: '--hns-slot-button-radius' },
    'common.input.default': { background: '--hns-slot-input-bg', border: '--hns-slot-input-border', radius: '--hns-slot-input-radius' },
    'hns.worker.header': { background: '--hns-slot-header-bg' }
  }

  /** Modules registered with the bridge, in registration order. */
  const modules = new Map()
  /** Last payload pushed by the engine, replayed to late registrations. */
  let lastPayload = null
  /** Engine subscriptions are installed once, on first registration. */
  let subscribed = false
  const listeners = { apply: [], changed: [], probe: [] }

  function api() {
    return global.megaTools && global.megaTools.theme ? global.megaTools.theme : null
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]))
  }

  function setVar(root, name, value) {
    if (value === undefined || value === null || value === '') root.style.removeProperty(name)
    else root.style.setProperty(name, String(value))
  }

  /**
   * Install one theme payload on every registered module.
   *
   * Slot styles land on `:root` as `--hns-slot-<slot with dots as dashes>-<prop>`
   * so a module's stylesheet can consume them without any JavaScript. This is what
   * lets a theme restyle a panel that did not exist when the theme was written.
   */
  function paint(payload) {
    if (!payload) return false
    lastPayload = payload
    const root = document.documentElement

    // The token block. Values are validated token data, never markup.
    if (typeof payload.css === 'string' && payload.css) {
      let sheet = document.getElementById('hnsThemeSheet')
      if (!sheet) {
        sheet = document.createElement('style')
        sheet.id = 'hnsThemeSheet'
        document.head.appendChild(sheet)
      }
      sheet.textContent = `:root {\n${payload.css}\n}`
    }

    const slots = payload.slots || {}
    for (const [slotId, properties] of Object.entries(slots)) {
      if (!properties || typeof properties !== 'object') continue
      const prefix = `--hns-slot-${slotId.replace(/\./g, '-')}`
      const aliases = LEGACY_ALIAS[slotId] || {}
      for (const [property, value] of Object.entries(properties)) {
        if (!(property in SLOT_VAR)) continue
        setVar(root, `${prefix}-${SLOT_VAR[property]}`, value)
        if (aliases[property]) setVar(root, aliases[property], value)
      }
    }

    // Personalization layer, shared by every dock module.
    const persona = payload.persona || {}
    document.body.classList.toggle('theme-persona', Boolean(persona.enabled))
    document.body.dataset.themeId = payload.id || ''
    document.body.dataset.themeEffect = String(payload.effectLevel ?? 0)
    document.body.dataset.effectLevel = String(payload.effectLevel ?? 0)
    setVar(root, '--hns-persona-decoration-opacity', persona.enabled ? persona.decorationOpacity : 0)
    setVar(root, '--hns-persona-banner-opacity', persona.enabled ? persona.bannerOpacity : 0)
    setVar(root, '--hns-persona-avatar', persona.avatarAsset && persona.avatarAsset !== 'none' ? `url("${persona.avatarAsset}")` : 'none')
    setVar(root, '--hns-persona-banner-asset', persona.bannerAsset && persona.bannerAsset !== 'none' ? `url("${persona.bannerAsset}")` : 'none')

    const decoration = slots['hns.persona.decoration'] || {}
    setVar(root, '--hns-decoration-asset', decoration.asset && decoration.asset !== 'none' ? `url("${decoration.asset}")` : 'none')
    setVar(root, '--hns-decoration-opacity', decoration.opacity)

    const preview = Boolean(payload.preview)
    document.body.classList.toggle('theme-preview', preview)

    for (const module of modules.values()) {
      try {
        module.onPaint(payload)
      } catch (error) {
        // One module failing to paint must never stop the others.
        if (typeof global.console?.error === 'function') global.console.error('[theme-bridge] paint failed', module.id, error)
      }
    }
    return true
  }

  /**
   * Collect the live geometry of every registered module's regions and slots.
   *
   * Regions are the protected areas the preview validator checks; slots are the
   * themable elements. Both end up in the same map the engine reads, because the
   * engine treats them identically (a bounding box keyed by id).
   */
  function reportRegions() {
    const engine = api()
    if (!engine || typeof engine.reportRegions !== 'function') return null
    const payload = {}
    for (const module of modules.values()) {
      try {
        const slotBoxes = measureMap(module.slotSelectors)
        const regionBoxes = measureMap(module.regionSelectors)
        Object.assign(payload, slotBoxes, regionBoxes)
      } catch (error) {
        if (typeof global.console?.error === 'function') global.console.error('[theme-bridge] measure failed', module.id, error)
      }
    }
    payload.componentTree = {
      root: '#detail',
      expanded: document.body.classList.contains('expanded'),
      theme: document.body.dataset.themeId || null,
      modules: [...modules.keys()],
      regions: Object.keys(payload).filter((key) => key !== 'componentTree')
    }
    try {
      engine.reportRegions(payload)
    } catch {
      // Geometry reporting is best-effort observation; never a dock failure.
    }
    return payload
  }

  function boundingBox(element) {
    if (!element) return null
    try {
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.left || 0),
        y: Math.round(rect.top || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      }
    } catch {
      return null
    }
  }

  /** Measure a selector map into `{ id: boundingBox }`, skipping absent nodes. */
  function measureMap(selectorMap) {
    const out = {}
    if (!selectorMap || typeof selectorMap !== 'object') return out
    for (const [id, selector] of Object.entries(selectorMap)) {
      const element = typeof selector === 'string' ? document.querySelector(selector) : selector
      const box = boundingBox(element)
      if (box) out[id] = box
    }
    return out
  }

  function ensureSubscribed() {
    if (subscribed) return
    const engine = api()
    if (!engine) return
    subscribed = true
    if (typeof engine.onApply === 'function') {
      engine.onApply((payload) => paint(payload))
    }
    if (typeof engine.onChanged === 'function') {
      engine.onChanged(() => {
        for (const module of modules.values()) {
          try {
            module.onChanged()
          } catch (error) {
            if (typeof global.console?.error === 'function') global.console.error('[theme-bridge] change failed', module.id, error)
          }
        }
      })
    }
    if (typeof engine.onProbeRegions === 'function') {
      engine.onProbeRegions(() => reportRegions())
    }
  }

  /**
   * Register one dock UI module.
   *
   * @param {object} options
   * @param {string} options.id           stable module id, e.g. 'appearance' | 'skills'
   * @param {string[]} [options.slots]    slot ids this module renders
   * @param {object} [options.slotSelectors] slot id -> selector, for geometry
   * @param {object} [options.regionSelectors] protected region id -> selector
   * @param {Function} [options.onPaint]  called with each payload
   * @param {Function} [options.onChanged] called when the theme list changes
   * @param {Function} [options.onReady]  called once the first payload arrives
   */
  function registerModule(options = {}) {
    const id = options.id || `module-${modules.size + 1}`
    const module = {
      id,
      slots: Array.isArray(options.slots) ? options.slots.slice() : [],
      slotSelectors: options.slotSelectors || {},
      regionSelectors: options.regionSelectors || {},
      onPaint: typeof options.onPaint === 'function' ? options.onPaint : () => {},
      onChanged: typeof options.onChanged === 'function' ? options.onChanged : () => {},
      onReady: typeof options.onReady === 'function' ? options.onReady : () => {}
    }
    modules.set(id, module)
    ensureSubscribed()

    // Replay the current payload so a panel that registers after the theme was
    // applied is painted immediately rather than on the next change.
    if (lastPayload) {
      try {
        module.onPaint(lastPayload)
      } catch (error) {
        if (typeof global.console?.error === 'function') global.console.error('[theme-bridge] replay failed', id, error)
      }
    }

    return {
      id,
      /** Apply a payload to this module only (used by its first paint). */
      paint: (payload) => {
        paint(payload)
        return true
      },
      reportRegions,
      measure: () => ({
        ...measureMap(module.slotSelectors),
        ...measureMap(module.regionSelectors)
      }),
      /** Ask the engine for the active theme and apply it. */
      refresh: async () => {
        const engine = api()
        if (!engine || typeof engine.paint !== 'function') return null
        try {
          const result = await engine.paint()
          if (result && result.ok && result.payload) paint(result.payload)
          module.onReady()
          return result
        } catch {
          return null
        }
      },
      dispose: () => modules.delete(id)
    }
  }

  /**
   * Bootstrap a module: register, fetch the active theme, paint, and report the
   * module's geometry. One call, so a new panel needs no knowledge of the engine.
   */
  async function attachModule(options = {}) {
    const handle = registerModule(options)
    await handle.refresh()
    reportRegions()
    return handle
  }

  // Layout changes are the only trigger for geometry reporting, so observation
  // stays fresh without polling.
  if (typeof global.ResizeObserver === 'function') {
    try {
      const observer = new global.ResizeObserver(() => reportRegions())
      const target = document.getElementById('detail')
      if (target) observer.observe(target)
    } catch {
      // Best-effort.
    }
  }
  if (typeof global.addEventListener === 'function') global.addEventListener('resize', reportRegions)

  global.megaThemeBridge = {
    registerModule,
    attachModule,
    paint,
    reportRegions,
    measureMap,
    boundingBox,
    slots: {
      'hns.skill.card': '#skillsList',
      'hns.skill.header': '#skillsPanel .panel-head',
      'hns.skill.badge': '#skillsStatus',
      'hns.skill.tag': '#skillsTags',
      'hns.skill.search': '#skillQuery',
      'hns.skill.danger': '#skillDeleteSelected'
    },
    /** Escape helper shared with the panels so markup interpolation is uniform. */
    esc,
    get lastPayload() {
      return lastPayload
    },
    get modules() {
      return [...modules.keys()]
    }
  }
})(window)
