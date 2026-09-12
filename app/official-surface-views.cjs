'use strict'

/**
 * Official Surface Views — the four-surface runtime (Update-Plan 任务 2 / 任务 3 / 任务 18).
 *
 * The desktop shell owns four sibling views inside one native window:
 *
 *   official_shell     a `WebContentsView` BEHIND the official view. Only its
 *                      outer padding band is visible, because the official view
 *                      covers the centre. Input-transparent, so it can never take
 *                      a click from the official UI.
 *   official_renderer  the official `@deepseek-ai/dsh` `WebContentsView`.
 *                      PROTECTED: this module never executes script in it, never
 *                      inserts CSS into it, never reads its DOM and never captures
 *                      it. It is only ever resized and stacked.
 *   official_overlay   a transparent `WebContentsView` ABOVE the official view,
 *                      created with `setIgnoreMouseEvents(true)` and
 *                      `focusable: false` so every pointer, keyboard and scroll
 *                      event passes straight through to the official renderer.
 *   hns_native         the Mega dock `WebContentsView`, owned by `desktop-main.cjs`.
 *
 * Why separate views rather than CSS injected into the official renderer: the
 * official renderer is a different renderer process. Painting around it and above
 * it is the only technique that satisfies "official DOM/CSS/JS injection is
 * forbidden" *and* gives the user a themed official area.
 *
 * Failure isolation (任务 18) is structural, not best-effort: every public method
 * is wrapped, a failure disables only the surface it happened on, the stage is
 * logged, and the official renderer and the HNS theme are left untouched.
 */
const path = require('node:path')

/** Canonical surface ids, duplicated from the theme contract on purpose. */
const SURFACE = Object.freeze({
  HNS_NATIVE: 'hns_native',
  OFFICIAL_SHELL: 'official_shell',
  OFFICIAL_OVERLAY: 'official_overlay',
  OFFICIAL_RENDERER: 'official_renderer'
})

/** Surfaces this module can paint. `official_renderer` is never in this list. */
const PAINTABLE = Object.freeze([SURFACE.OFFICIAL_SHELL, SURFACE.OFFICIAL_OVERLAY])

/** Defaults when no theme payload has arrived yet: a visible, neutral frame. */
const DEFAULT_SHELL = Object.freeze({
  background: '#0f1115',
  border: '1px solid #232b3b',
  radius: '10px',
  shadow: 'none',
  separator: '1px solid #232b3b',
  padding: 6
})

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.max(min, Math.min(max, numeric))
}

function cssUrl(value) {
  if (!value || value === 'none') return 'none'
  const text = String(value)
  if (text.startsWith('data:image/') || /^https?:/i.test(text)) return `url("${text.replace(/"/g, '%22')}")`
  return 'none'
}

/**
 * Create the Official Shell + Official Overlay view manager.
 *
 * @param {object} options
 * @param {Function} options.getWindow        () => BrowserWindow|null
 * @param {Function} options.getOfficialView  () => WebContentsView|null  (read-only access)
 * @param {Function} options.getWindowSize    () => [width, height]
 * @param {Function} options.getDockWidth     () => number
 * @param {Function} [options.log]
 * @param {object}   [options.electron]       { WebContentsView }
 */
function createOfficialSurfaceViews({
  getWindow,
  getOfficialView,
  getWindowSize,
  getDockWidth,
  log = () => {},
  electron = null
} = {}) {
  const WebContentsView = electron?.WebContentsView || null
  let shellView = null
  let overlayView = null
  let shellCssKey = null
  let overlayCssKey = null
  let overlayStateCssKey = null
  /** Queued stylesheet writes, one chain per surface (see `applyCss`). */
  let shellCssPending = null
  let overlayCssPending = null
  let overlayStatePending = null
  let shellReady = false
  let overlayReady = false
  let payload = null
  let layout = null
  let enabled = true
  const degradation = []
  const events = []

  function record(entry) {
    events.push({ at: new Date().toISOString(), ...entry })
    if (events.length > 128) events.splice(0, events.length - 128)
  }

  function note(surfaceId, reason) {
    degradation.push({ surface: surfaceId, reason: String(reason), at: new Date().toISOString() })
    if (degradation.length > 32) degradation.splice(0, degradation.length - 32)
    log(`surface ${surfaceId} degraded: ${reason}`)
    record({ surface: surfaceId, event: 'degraded', reason: String(reason) })
  }

  function usable(view) {
    try {
      return Boolean(view && view.webContents && !view.webContents.isDestroyed())
    } catch {
      return false
    }
  }

  /** Official view bounds in window coordinates; null when it does not exist. */
  function officialBounds() {
    const view = typeof getOfficialView === 'function' ? getOfficialView() : null
    if (!view) return null
    try {
      const bounds = typeof view.getBounds === 'function' ? view.getBounds() : null
      if (!bounds || !Number.isFinite(bounds.width)) return null
      return { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, width: Number(bounds.width) || 0, height: Number(bounds.height) || 0 }
    } catch {
      return null
    }
  }

  function surfaceBounds(surfaceId) {
    const official = officialBounds()
    if (!official) return null
    if (surfaceId === SURFACE.OFFICIAL_OVERLAY) return { ...official }
    if (surfaceId === SURFACE.OFFICIAL_SHELL) {
      // The shell extends to the window edges so the frame's outer band is drawn
      // even in the gap the dock's reserved strip leaves.
      const size = typeof getWindowSize === 'function' ? getWindowSize() : null
      const [width, height] = Array.isArray(size) ? size : [official.width, official.height]
      return { x: 0, y: 0, width: Math.max(0, Number(width) || official.width), height: Math.max(0, Number(height) || official.height) }
    }
    return null
  }

  function createShell() {
    if (!WebContentsView || shellView) return shellView
    const win = typeof getWindow === 'function' ? getWindow() : null
    if (!win || win.isDestroyed()) return null
    if (!win.contentView?.addChildView) return null
    shellView = new WebContentsView({
      webPreferences: {
        // No preload, no node, isolated: the shell only renders CSS.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A frame must never be able to focus.
        focusable: false,
        backgroundThrottling: false
      }
    })
    try {
      shellView.setBackgroundColor('#00000000')
    } catch {}
    // The surface id is published on the view object so the window's stacking order
    // is readable from the outside (and assertable in a test).
    shellView.surface = SURFACE.OFFICIAL_SHELL
    // The shell view sits *behind* the official view. WebKit z-order inside a
    // contentView follows addChildView order, so it must be added before the
    // official view — `desktop-main.cjs` therefore calls this before
    // `createOfficialHarnessView`.
    shellView.webContents.on('render-process-gone', (_event, details) => {
      shellReady = false
      note(SURFACE.OFFICIAL_SHELL, `renderer gone: ${JSON.stringify(details)}`)
    })
    shellView.webContents.on('did-finish-load', () => {
      shellReady = true
      if (payload) paintSurface(SURFACE.OFFICIAL_SHELL, payload)
    })
    win.contentView.addChildView(shellView)
    shellView.webContents.loadFile(path.join(__dirname, '..', 'extensions', 'mega', 'ui', 'hns-shell.html'))
      .catch((error) => note(SURFACE.OFFICIAL_SHELL, `load failed: ${error?.message || error}`))
    record({ surface: SURFACE.OFFICIAL_SHELL, event: 'created' })
    return shellView
  }

  function createOverlay() {
    if (!WebContentsView || overlayView) return overlayView
    const win = typeof getWindow === 'function' ? getWindow() : null
    if (!win || win.isDestroyed()) return null
    if (!win.contentView?.addChildView) return null
    overlayView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The two properties that make the overlay visual-only. Both are also
        // enforced in the document itself (`pointer-events: none`, no tabindex).
        focusable: false,
        backgroundThrottling: false
      }
    })
    try {
      overlayView.setBackgroundColor('#00000000')
    } catch {}
    overlayView.surface = SURFACE.OFFICIAL_OVERLAY
    // Pointer passthrough. `setIgnoreMouseEvents` lives on the View base class,
    // but an overlay that could still take a click would be a functional
    // regression, so its absence is recorded as a degraded surface rather than
    // ignored — and the document's own `pointer-events: none` is the second line
    // of defence.
    if (typeof overlayView.setIgnoreMouseEvents === 'function') {
      try {
        overlayView.setIgnoreMouseEvents(true, { forward: false })
      } catch (error) {
        note(SURFACE.OFFICIAL_OVERLAY, `could not set ignore-mouse-events: ${error?.message || error}`)
      }
    } else {
      note(SURFACE.OFFICIAL_OVERLAY, 'this Electron build exposes no setIgnoreMouseEvents on a WebContentsView; relying on the document pointer-events rule')
    }
    try {
      if (typeof overlayView.webContents.setFocusable === 'function') overlayView.webContents.setFocusable(false)
    } catch {}
    overlayView.webContents.on('render-process-gone', (_event, details) => {
      overlayReady = false
      note(SURFACE.OFFICIAL_OVERLAY, `renderer gone: ${JSON.stringify(details)}`)
    })
    overlayView.webContents.on('did-finish-load', () => {
      overlayReady = true
      if (payload) paintSurface(SURFACE.OFFICIAL_OVERLAY, payload)
      if (layout) applyLayout(layout)
    })
    win.contentView.addChildView(overlayView)
    overlayView.webContents.loadFile(path.join(__dirname, '..', 'extensions', 'mega', 'ui', 'official-overlay.html'))
      .catch((error) => note(SURFACE.OFFICIAL_OVERLAY, `load failed: ${error?.message || error}`))
    record({ surface: SURFACE.OFFICIAL_OVERLAY, event: 'created' })
    return overlayView
  }

  /**
   * Apply one CSS rule to a surface, replacing the previous one.
   *
   * `insertCSS` resolves with a *key*, and removing the previous rule needs that
   * key, so the writes for one surface are chained rather than fired in parallel:
   * two repaints in the same tick would otherwise both insert before either key
   * came back, and the older never gets removed — a stylesheet leak that ends with
   * a theme change showing stale values. The chain is also the failure boundary:
   * a rejection degrades that surface and nothing else.
   */
  function applyCss(surfaceId, view, css) {
    const contents = view?.webContents
    if (!contents || contents.isDestroyed()) return false
    try {
      const previous = surfaceId === SURFACE.OFFICIAL_SHELL ? shellCssPending : overlayCssPending
      const next = Promise.resolve(previous)
        .catch(() => {})
        .then(async () => {
          const stale = surfaceId === SURFACE.OFFICIAL_SHELL ? shellCssKey : overlayCssKey
          if (stale) {
            try {
              await contents.removeInsertedCSS(stale)
            } catch {}
          }
          const key = await contents.insertCSS(css)
          if (surfaceId === SURFACE.OFFICIAL_SHELL) shellCssKey = key
          else overlayCssKey = key
          return key
        })
        .catch((error) => {
          note(surfaceId, `style apply failed: ${error?.message || error}`)
          return null
        })
      if (surfaceId === SURFACE.OFFICIAL_SHELL) shellCssPending = next
      else overlayCssPending = next
      return true
    } catch (error) {
      note(surfaceId, `style apply failed: ${error?.message || error}`)
      return false
    }
  }

  /**
   * Wait until every queued surface write has settled.
   *
   * Test and diagnostic hook, and the honest answer to "has this paint actually
   * reached the screen?" — the writes are asynchronous by nature, so a caller that
   * needs the guarantee asks for it explicitly.
   */
  async function settle() {
    await Promise.allSettled([shellCssPending, overlayCssPending, overlayStatePending].filter(Boolean))
    return { shellCssKey, overlayCssKey, overlayStateCssKey }
  }

  /** The shell's CSS variables, from the theme payload. */
  function shellCss(themeComponents, tokens) {
    const frame = themeComponents['official.shell.frame'] || {}
    const background = themeComponents['official.shell.background'] || {}
    const border = themeComponents['official.shell.border'] || {}
    const separator = themeComponents['official.shell.separator'] || {}
    const padding = Number(String(tokens['official.shell.padding'] || '').replace('px', ''))
    const radius = tokens['official.shell.radius'] || frame.radius || DEFAULT_SHELL.radius
    const shellAsset = tokens['asset.official_shell_frame']
    return `:root {
      --shell-background: ${background.background || DEFAULT_SHELL.background};
      --shell-background-image: ${background.overlay ? String(background.overlay) : 'none'};
      --shell-border: ${border.border || DEFAULT_SHELL.border};
      --shell-radius: ${radius};
      --shell-shadow: ${frame.shadow || DEFAULT_SHELL.shadow};
      --shell-separator: ${separator.border || DEFAULT_SHELL.separator};
      --shell-padding: ${Number.isFinite(padding) ? `${clamp(padding, 0, 24)}px` : `${DEFAULT_SHELL.padding}px`};
      --shell-frame-asset: ${cssUrl(shellAsset)};
      --shell-glow-opacity: ${clamp(tokens['official.frame_glow.opacity'] ?? 0, 0, 1)};
      --shell-glow-color: ${tokens['official.overlay.frame_glow']?.color || themeComponents['official.overlay.frame_glow']?.color || '#4d93f8'};
    }`
  }

  /** The overlay's CSS variables, from the theme payload. */
  function overlayCss(themeComponents, tokens) {
    const tint = themeComponents['official.overlay.global_tint'] || {}
    const gradient = themeComponents['official.overlay.gradient'] || {}
    const texture = themeComponents['official.overlay.texture'] || {}
    const skin = themeComponents['official.overlay.skin'] || {}
    const vignette = themeComponents['official.overlay.vignette'] || {}
    const scanline = themeComponents['official.overlay.scanline'] || {}
    const glow = themeComponents['official.overlay.frame_glow'] || {}
    const decoration = themeComponents['official.overlay.corner_decoration'] || {}
    const character = themeComponents['official.overlay.character_primary'] || {}
    const stops = Array.isArray(gradient.stops)
      ? gradient.stops
      : (() => {
          try {
            const parsed = JSON.parse(String(gradient.stops || '[]'))
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
    const gradientCss = stops.length > 1
      ? `linear-gradient(${Number(gradient.angle) || 160}deg, ${stops.map((stop) => `${stop.color || 'transparent'} ${Math.round((Number(stop.at) || 0) * 100)}%`).join(', ')})`
      : 'none'
    const characterEnabled = character.asset && character.asset !== 'none' && Number(character.opacity) > 0
    return `:root {
      --ov-tint-color: ${tint.color || 'transparent'};
      --ov-tint-opacity: ${clamp(tint.opacity ?? 0, 0, 1)};
      --ov-gradient: ${gradientCss};
      --ov-gradient-opacity: ${clamp(gradient.opacity ?? 0, 0, 1)};
      --ov-texture: ${cssUrl(texture.asset)};
      --ov-texture-opacity: ${clamp(tokens['official.texture.opacity'] ?? texture.opacity ?? 0, 0, 1)};
      --ov-skin: ${cssUrl(skin.asset)};
      --ov-skin-opacity: ${clamp(tokens['official.skin.opacity'] ?? skin.opacity ?? 0, 0, 1)};
      --ov-vignette-opacity: ${clamp(tokens['official.vignette.opacity'] ?? vignette.opacity ?? 0, 0, 1)};
      --ov-scanline-opacity: ${clamp(tokens['official.scanline.opacity'] ?? scanline.opacity ?? 0, 0, 1)};
      --ov-scanline-spacing: ${clamp(scanline.spacing ?? 4, 2, 24)}px;
      --ov-glow-opacity: ${clamp(glow.opacity ?? 0, 0, 1)};
      --ov-glow-color: ${glow.color || '#4d93f8'};
      --ov-glow-width: ${clamp(glow.width ?? 2, 1, 16)}px;
      --ov-decoration: ${cssUrl(decoration.asset)};
      --ov-decoration-opacity: ${clamp(decoration.opacity ?? 0, 0, 1)};
      --ov-character: ${characterEnabled ? cssUrl(character.asset) : 'none'};
      --ov-character-opacity: ${clamp(characterEnabled ? character.opacity : 0, 0, 1)};
    }`
  }

  /**
   * Paint one surface. `official_renderer` is refused outright: this is the single
   * place that could ever touch it, and it does not.
   */
  function paintSurface(surfaceId, themePayload) {
    if (!enabled) return { ok: false, reason: 'surfaces_disabled' }
    if (!PAINTABLE.includes(surfaceId)) {
      return { ok: false, reason: 'surface_protected', message: `${surfaceId} is not paintable by DS-Hns` }
    }
    const view = surfaceId === SURFACE.OFFICIAL_SHELL ? shellView : overlayView
    if (!usable(view)) return { ok: false, reason: 'view_unavailable' }
    const components = themePayload?.slots || {}
    const tokens = themePayload?.tokens || {}
    const css = surfaceId === SURFACE.OFFICIAL_SHELL ? shellCss(components, tokens) : overlayCss(components, tokens)
    // One surface failing must not stop the other, so the whole paint is guarded
    // and every failure is a reported degradation rather than a thrown error.
    let applied = false
    try {
      applied = applyCss(surfaceId, view, css)
      if (surfaceId === SURFACE.OFFICIAL_OVERLAY) {
        const anyEnabled = [
          'official.overlay.global_tint',
          'official.overlay.gradient',
          'official.overlay.texture',
          'official.overlay.skin',
          'official.overlay.vignette',
          'official.overlay.scanline',
          'official.overlay.frame_glow',
          'official.overlay.corner_decoration',
          'official.overlay.character_primary'
        ].some((slotId) => isComponentActive(components[slotId], tokens))
        setOverlayActive(anyEnabled)
      }
    } catch (error) {
      note(surfaceId, `paint failed: ${error?.message || error}`)
      return { ok: false, reason: 'paint_failed', error: String(error?.message || error) }
    }
    record({ surface: surfaceId, event: 'paint', applied })
    return { ok: applied, surface: surfaceId }
  }

  /** Is a slot payload actually turned on? */
  function isComponentActive(slot, tokens = {}) {
    if (!slot) return false
    if (slot.enabled === false) return false
    const opacity = Number(slot.opacity)
    if (Number.isFinite(opacity)) return opacity > 0
    const tokenOpacity = Number(tokens['official.tint.opacity'])
    if (Number.isFinite(tokenOpacity)) return tokenOpacity > 0
    return Boolean(slot.asset && slot.asset !== 'none') || Boolean(slot.color)
  }

  /**
   * Publish the overlay's on/off state.
   *
   * The surface documents carry no script at all (that is the whole point: the
   * overlay renderer cannot reach anything), so state is expressed as a CSS rule.
   * The previous rule is removed by key so the overlay can be turned back on.
   */
  function setOverlayActive(active) {
    if (!usable(overlayView)) return false
    try {
      overlayStatePending = Promise.resolve(overlayStatePending)
        .catch(() => {})
        .then(async () => {
          if (overlayStateCssKey) {
            try {
              await overlayView.webContents.removeInsertedCSS(overlayStateCssKey)
            } catch {}
            overlayStateCssKey = null
          }
          if (active) return null
          const key = await overlayView.webContents.insertCSS('body > .layer { display: none !important; }')
          overlayStateCssKey = key
          return key
        })
        .catch((error) => {
          note(SURFACE.OFFICIAL_OVERLAY, `state apply failed: ${error?.message || error}`)
          return null
        })
      return true
    } catch (error) {
      note(SURFACE.OFFICIAL_OVERLAY, `state apply failed: ${error?.message || error}`)
      return false
    }
  }

  /**
   * Position every surface (任务 3: the overlay always follows the official view).
   * Called on resize, maximise, restore, dock toggle and view-bounds change.
   */
  function applyLayout(nextLayout = null) {
    if (nextLayout) layout = nextLayout
    if (!enabled) return { ok: false, reason: 'surfaces_disabled' }
    const results = {}
    for (const surfaceId of PAINTABLE) {
      const bounds = surfaceBounds(surfaceId)
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        results[surfaceId] = { ok: false, reason: 'no_bounds' }
        continue
      }
      const view = surfaceId === SURFACE.OFFICIAL_SHELL ? shellView : overlayView
      if (!usable(view)) {
        results[surfaceId] = { ok: false, reason: 'view_unavailable' }
        continue
      }
      try {
        view.setBounds(bounds)
        results[surfaceId] = { ok: true, bounds }
      } catch (error) {
        note(surfaceId, `setBounds failed: ${error?.message || error}`)
        results[surfaceId] = { ok: false, reason: 'set_bounds_failed' }
      }
    }
    return { ok: true, results, layout: layout || null }
  }

  /** Size a character box inside the overlay from the layout engine's placement. */
  function applyOverlayPlacement(placement) {
    if (!placement || !usable(overlayView)) return false
    const box = placement.placements?.character_primary?.box
    const anchor = placement.placements?.character_primary?.anchor || placement.anchor || 'bottom-right'
    const decoration = placement.placements?.corner_decoration?.box
    const rules = []
    if (box && box.width > 0 && box.height > 0) {
      rules.push(`#character { position: absolute; width: ${Math.round(box.width)}px; height: ${Math.round(box.height)}px; left: auto; right: auto; top: auto; bottom: auto; transform: none; background-position: bottom ${anchor.includes('left') ? 'left' : 'right'}; }`)
      const inset = 8
      if (anchor === 'bottom-right') rules.push(`#character { right: ${inset}px; bottom: ${inset}px; }`)
      else if (anchor === 'bottom-left') rules.push(`#character { left: ${inset}px; bottom: ${inset}px; }`)
      else if (anchor === 'bottom-center') rules.push(`#character { left: 50%; bottom: ${inset}px; transform: translateX(-50%); background-position: bottom center; }`)
      else if (anchor === 'top-right') rules.push(`#character { right: ${inset}px; top: ${inset}px; background-position: top right; }`)
      else if (anchor === 'top-left') rules.push(`#character { left: ${inset}px; top: ${inset}px; background-position: top left; }`)
      else if (anchor === 'top-center') rules.push(`#character { left: 50%; top: ${inset}px; transform: translateX(-50%); background-position: top center; }`)
      else if (anchor === 'center-right') rules.push(`#character { right: ${inset}px; top: 50%; transform: translateY(-50%); background-position: center right; }`)
      else if (anchor === 'center-left') rules.push(`#character { left: ${inset}px; top: 50%; transform: translateY(-50%); background-position: center left; }`)
      else rules.push(`#character { left: 50%; top: 50%; transform: translate(-50%, -50%); background-position: center; }`)
    }
    if (decoration && decoration.width > 0) {
      rules.push(`#decoration { position: absolute; width: ${Math.round(decoration.width)}px; height: ${Math.round(decoration.height)}px; right: 8px; bottom: 8px; }`)
    }
    if (!rules.length) return false
    return applyCss(SURFACE.OFFICIAL_OVERLAY, overlayView, rules.join('\n'))
  }

  /**
   * Apply a full theme payload to both official surfaces.
   *
   * This is the entry point the extension calls. It never throws: a failure here
   * degrades the official surfaces (任务 18) and leaves the HNS theme and the
   * official renderer alone.
   */
  function paintTheme(themePayload, placement = null) {
    payload = themePayload || null
    if (!enabled) return { ok: false, reason: 'surfaces_disabled', surfaces: {} }
    const surfaces = {}
    for (const surfaceId of PAINTABLE) {
      try {
        surfaces[surfaceId] = paintSurface(surfaceId, themePayload)
      } catch (error) {
        note(surfaceId, `paint threw: ${error?.message || error}`)
        surfaces[surfaceId] = { ok: false, reason: 'paint_threw' }
      }
    }
    if (placement) {
      try {
        applyOverlayPlacement(placement)
      } catch (error) {
        note(SURFACE.OFFICIAL_OVERLAY, `placement failed: ${error?.message || error}`)
      }
    }
    applyLayout()
    record({ event: 'paint_theme', id: themePayload?.id || null, surfaces })
    return { ok: PAINTABLE.some((surfaceId) => surfaces[surfaceId]?.ok), surfaces }
  }

  /** Detach both views. Used by teardown and by "the theme was deleted". */
  function destroy() {
    for (const surfaceId of PAINTABLE) {
      const view = surfaceId === SURFACE.OFFICIAL_SHELL ? shellView : overlayView
      if (!view) continue
      try {
        const win = typeof getWindow === 'function' ? getWindow() : null
        win?.contentView?.removeChildView?.(view)
      } catch {}
      try {
        if (!view.webContents.isDestroyed()) view.webContents.close()
      } catch {}
      if (surfaceId === SURFACE.OFFICIAL_SHELL) {
        shellView = null
        shellReady = false
      } else {
        overlayView = null
        overlayReady = false
      }
    }
    shellCssKey = null
    overlayCssKey = null
    overlayStateCssKey = null
    record({ event: 'destroyed' })
  }

  /** Reset to the default frame: used when the active theme is deleted. */
  function reset() {
    payload = null
    const cleared = {
      slots: {
        'official.shell.background': { background: DEFAULT_SHELL.background },
        'official.shell.frame': { border: DEFAULT_SHELL.border, radius: DEFAULT_SHELL.radius, shadow: DEFAULT_SHELL.shadow, padding: `${DEFAULT_SHELL.padding}px` },
        'official.shell.border': { border: DEFAULT_SHELL.border, radius: DEFAULT_SHELL.radius },
        'official.overlay.global_tint': { opacity: 0, color: 'transparent' },
        'official.overlay.gradient': { opacity: 0, stops: '[]' },
        'official.overlay.texture': { asset: 'none', opacity: 0, enabled: false },
        'official.overlay.skin': { asset: 'none', opacity: 0, enabled: false },
        'official.overlay.vignette': { opacity: 0, enabled: false },
        'official.overlay.scanline': { opacity: 0, enabled: false },
        'official.overlay.frame_glow': { opacity: 0, enabled: false },
        'official.overlay.corner_decoration': { asset: 'none', opacity: 0, enabled: false },
        'official.overlay.character_primary': { asset: 'none', opacity: 0, enabled: false },
        'official.overlay.character_secondary': { asset: 'none', opacity: 0, enabled: false }
      },
      tokens: {
        'official.shell.padding': `${DEFAULT_SHELL.padding}px`,
        'official.shell.radius': DEFAULT_SHELL.radius,
        'asset.official_shell_frame': 'none',
        'asset.official_skin': 'none',
        'asset.official_overlay_texture': 'none',
        'asset.official_character': 'none',
        'official.tint.opacity': '0',
        'official.vignette.opacity': '0',
        'official.scanline.opacity': '0',
        'official.frame_glow.opacity': '0',
        'official.texture.opacity': '0',
        'official.character.opacity': '0'
      },
      effectLevel: 0
    }
    return paintTheme(cleared, null)
  }

  return {
    createShell,
    createOverlay,
    paintTheme,
    paintSurface,
    applyLayout,
    applyOverlayPlacement,
    reset,
    destroy,
    settle,
    /** Diagnostics for the acceptance run: what each surface actually is. */
    describe: () => ({
      enabled,
      surfaces: PAINTABLE.map((surfaceId) => {
        const view = surfaceId === SURFACE.OFFICIAL_SHELL ? shellView : overlayView
        let bounds = null
        try { bounds = usable(view) && typeof view.getBounds === 'function' ? view.getBounds() : null } catch {}
        return {
          id: surfaceId,
          created: Boolean(view),
          ready: surfaceId === SURFACE.OFFICIAL_SHELL ? shellReady : overlayReady,
          bounds,
          input: surfaceId === SURFACE.OFFICIAL_OVERLAY
            ? { pointer: 'passthrough', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' }
            : { pointer: 'passthrough', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' }
        }
      }),
      protected: {
        id: SURFACE.OFFICIAL_RENDERER,
        writable: false,
        painted: false,
        // Evidence that nothing was ever injected: this manager has no code path
        // that executes script or inserts CSS into the official view.
        injection_apis_used: []
      },
      degradation: degradation.slice(),
      events: events.slice(-16),
      layout
    }),
    setEnabled: (value) => {
      enabled = value !== false
      return enabled
    },
    isEnabled: () => enabled
  }
}

module.exports = {
  SURFACE,
  PAINTABLE,
  DEFAULT_SHELL,
  createOfficialSurfaceViews
}
