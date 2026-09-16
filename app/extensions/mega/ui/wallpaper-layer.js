'use strict'

/**
 * The wallpaper layer in the dock.
 *
 * The shell owns the file and decides what may be drawn; this applies its answer to the one element
 * already in the markup — the image div — and nothing else. It is the dock's lowest layer and the
 * panels frost *it*, which is the point: a background behind frosted glass is what makes the glass
 * read as glass instead of as a flat tint.
 *
 * The dock shows *part* of a picture that covers the whole window: the layer over the official page
 * draws the rest, and the dock's rectangle is cut out of it so the dock's own view (which sits under
 * that layer) stays visible. Both copies are placed against the same window box — the picture is the
 * window's, and this view starts at `frame.x`/`frame.y` inside it — so the two meet at the cut
 * without a seam. The frame is geometry the shell owns and reports through the shell's dock adapter;
 * with no frame at all (a dock that is not part of the main window) the layer falls back to its own
 * box, which is what it did before the layer above the official page existed.
 *
 * Two properties it has to keep, whichever way the user drives it:
 *
 *   * **It never takes an event.** The layer is `pointer-events: none` in the stylesheet and
 *     `aria-hidden` in the markup: it is a background, so every click, wheel and selection still
 *     lands on what is in front of it.
 *   * **Nothing to draw is a complete answer.** The layer is emptied rather than left showing the
 *     previous wallpaper, so a file that was deleted or replaced is never still on screen pretending
 *     to be current.
 *
 * It used to play a video too — the one kind of wallpaper a real element can carry and a stylesheet
 * cannot — with visibility driving `play()`/`pause()` so a hidden dock cost no frames. That pipeline
 * is the wallpaper plugin's now (`updateplan/pluginize.md` Phase 7), so it left with its element: a
 * copy of a feature is a second implementation to keep in step, and the plugin's is the better one.
 */
;(function attachWallpaperLayer(global) {
  let state = { active: false, kind: null, src: null, fit: 'cover', opacity: 55, blur: 0, scrim: 35, frame: null }

  function nodes() {
    const document = global.document
    if (!document || typeof document.getElementById !== 'function') return null
    const layer = document.getElementById('wallpaper')
    if (!layer) return null
    return { layer, body: document.body, root: document.documentElement }
  }

  /** The object fit a wallpaper's `fit` means on a CSS box. */
  function objectFit(fit) {
    if (fit === 'contain') return 'contain'
    if (fit === 'tile') return 'none'
    return 'cover'
  }

  /**
   * Apply one state.
   *
   * @param {object} next what the shell said — `{ active, kind, src, fit, opacity, blur, scrim }`
   */
  function apply(next = {}) {
    state = {
      active: next.active === true,
      kind: next.kind || null,
      src: typeof next.src === 'string' && next.src ? next.src : null,
      fit: next.fit || state.fit,
      opacity: Number.isFinite(Number(next.opacity)) ? Number(next.opacity) : state.opacity,
      blur: Number.isFinite(Number(next.blur)) ? Number(next.blur) : state.blur,
      scrim: Number.isFinite(Number(next.scrim)) ? Number(next.scrim) : state.scrim,
      // Kept when the answer does not carry one: a repaint of the picture is not a re-layout, and
      // forgetting the frame for one frame would move the dock's copy of the picture.
      frame: next.frame || state.frame
    }
    const found = nodes()
    if (!found) return { ...state }
    const { layer, body, root } = found

    const drawable = state.active && Boolean(state.src)

    // Emptied first: one picture must never survive into a state that did not ask for it.
    layer.style.backgroundImage = drawable ? `url("${state.src}")` : 'none'
    layer.style.backgroundSize = state.fit === 'tile' ? 'auto' : objectFit(state.fit)
    layer.style.backgroundRepeat = state.fit === 'tile' ? 'repeat' : 'no-repeat'
    layer.style.backgroundPosition = 'center'
    layer.style.filter = state.blur ? `blur(${state.blur}px)` : 'none'
    if (body && body.dataset) {
      body.dataset.wallpaper = drawable ? 'on' : 'off'
      // The numbers the stylesheet needs; the element carries the pixels, the stylesheet the wash.
      body.style.setProperty('--hns-wallpaper-opacity', String(state.opacity / 100))
      body.style.setProperty('--hns-wallpaper-scrim', String(state.scrim / 100))
    }
    if (root && root.style && typeof root.style.setProperty === 'function') {
      // Where this view starts inside the window: the picture is the window's, so the dock's copy
      // has to be offset by exactly this much (see the stylesheet's rule for `#wallpaper`).
      const frame = state.frame || {}
      const x = Number(frame.x)
      const y = Number(frame.y)
      root.style.setProperty('--hns-wallpaper-origin-x', `${Number.isFinite(x) ? Math.round(x) : 0}px`)
      root.style.setProperty('--hns-wallpaper-origin-y', `${Number.isFinite(y) ? Math.round(y) : 0}px`)
    }
    return { ...state }
  }

  function bridge() {
    return global.megaTools && global.megaTools.wallpaper ? global.megaTools.wallpaper : null
  }

  /** Change the wallpaper: the shell validates, and its answer is what is applied. */
  async function set(patch = {}) {
    const api = bridge()
    if (!api || typeof api.set !== 'function') return apply({ ...state, ...patch })
    try {
      const result = await api.set(patch)
      return result && result.ok !== false ? apply(result) : { ...state }
    } catch {
      return { ...state }
    }
  }

  /** Read the state in force from the shell and apply it. */
  async function refresh() {
    const api = bridge()
    if (!api || typeof api.layer !== 'function') return apply(state)
    try {
      const described = await api.layer()
      return described && described.ok !== false ? apply(described) : { ...state }
    } catch {
      return { ...state }
    }
  }

  global.hnsWallpaper = {
    state: () => ({ ...state }),
    apply,
    set,
    refresh
  }

  if (typeof global.addEventListener === 'function') {
    /**
     * The dock's rectangle inside the window changes whenever the dock is expanded, collapsed or
     * the window is resized — and the origin the dock's copy of the picture is offset by changes
     * with it. This view resizes when its own bounds change, which is exactly when that origin
     * moved, so the frame is re-read then; the shell has applied the new layout by that point (the
     * resize *is* it).
     *
     * Coalesced to one read per frame: dragging a window edge is a stream of resize events, and
     * asking the shell for the same geometry once per event would be a push per pixel.
     */
    let framePending = false
    global.addEventListener('resize', () => {
      if (framePending) return
      framePending = true
      const flush = () => {
        framePending = false
        refresh()
      }
      if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(flush)
      else setTimeout(flush, 16)
    })
  }

  refresh()
  const api = bridge()
  if (api && typeof api.onChanged === 'function') {
    api.onChanged((payload) => {
      if (payload && payload.ok !== false) apply(payload)
    })
  }
})(window)
