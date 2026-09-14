'use strict'

/**
 * The wallpaper layer in the dock.
 *
 * The shell owns the file and decides what may be drawn; this applies its answer to two elements
 * that are already in the markup — an image div and a video — and nothing else. It is the dock's
 * lowest layer and the panels frost *it*, which is the point: a background behind frosted glass is
 * what makes the glass read as glass instead of as a flat tint.
 *
 * Three properties it has to keep, whichever way the user drives it:
 *
 *   * **It never takes an event.** The layer is `pointer-events: none` in the stylesheet and
 *     `aria-hidden` in the markup: it is a background, so every click, wheel and selection still
 *     lands on what is in front of it.
 *   * **A video is paused when nobody is looking.** A wallpaper that keeps decoding while the dock
 *     is hidden is a background that costs a laptop its battery, so visibility drives `play()` and
 *     `pause()` — and a paused video keeps its last frame, so nothing flashes.
 *   * **Nothing to draw is a complete answer.** The layer is emptied and hidden rather than left
 *     showing the previous wallpaper, so a file that was deleted or replaced is never still on
 *     screen pretending to be current.
 */
;(function attachWallpaperLayer(global) {
  let state = { active: false, kind: null, src: null, fit: 'cover', opacity: 55, blur: 0, scrim: 35, muted: true }

  function nodes() {
    const document = global.document
    if (!document || typeof document.getElementById !== 'function') return null
    const layer = document.getElementById('wallpaper')
    const video = document.getElementById('wallpaperVideo')
    if (!layer) return null
    return { layer, video, body: document.body }
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
   * @param {object} next what the shell said — `{ active, kind, src, fit, opacity, blur, scrim, muted }`
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
      muted: next.muted !== false
    }
    const found = nodes()
    if (!found) return { ...state }
    const { layer, video, body } = found

    const drawable = state.active && Boolean(state.src)
    const isVideo = drawable && state.kind === 'video'
    const isImage = drawable && !isVideo

    // Reset both first: one source must never survive into a state that did not ask for it.
    layer.style.backgroundImage = isImage ? `url("${state.src}")` : 'none'
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
    if (video) {
      if (isVideo) {
        if (video.getAttribute('src') !== state.src) video.setAttribute('src', state.src)
        video.muted = state.muted
        video.hidden = false
        // A hidden dock must not decode frames. Where the page cannot tell, it simply plays.
        if (!global.document || global.document.visibilityState !== 'hidden') {
          const played = typeof video.play === 'function' ? video.play() : null
          if (played && typeof played.catch === 'function') played.catch(() => {})
        }
      } else {
        if (typeof video.pause === 'function') video.pause()
        video.hidden = true
        video.removeAttribute('src')
      }
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

  // The dock is hidden and shown by the shell, not by a route change, so the fastest honest signal
  // is the document's own visibility plus the window's focus: a wallpaper nobody can see does not
  // need frames.
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('visibilitychange', () => {
      const found = nodes()
      if (!found || !found.video || found.video.hidden) return
      if (global.document && global.document.visibilityState === 'hidden') {
        if (typeof found.video.pause === 'function') found.video.pause()
      } else {
        const played = typeof found.video.play === 'function' ? found.video.play() : null
        if (played && typeof played.catch === 'function') played.catch(() => {})
      }
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
