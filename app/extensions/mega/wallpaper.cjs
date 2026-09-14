'use strict'

/**
 * The wallpaper layer.
 *
 * This is DS-Hns's own answer to a Wallpaper Engine background, and it is deliberately *not* a
 * port of the plugin that asked the question. That plugin is a Cordis **client** plugin: it runs
 * inside the official web GUI and rewrites it (`dsh.client.platform: web`, `dsh-client-ui-slots`),
 * which is the one thing this product never does — the official renderer is never scripted and
 * never styled. A wallpaper that has to reach inside the official page is not a wallpaper this
 * product can have.
 *
 * What it can have is every surface DS-Hns owns, which is where a background actually belongs:
 *
 *   * **the dock** — a scripted document of ours, so it takes an image *or* a video, behind the
 *     frosted glass, at full fidelity;
 *   * **the official overlay and shell** — two views DS-Hns already draws above the official page
 *     with `insertCSS`. They are input-transparent and script-free by construction, and their CSP
 *     allows exactly one kind of asset: an inline `data:` image. That is the whole reason a video
 *     cannot go there, and it is a limit of the safe path rather than of this module.
 *
 * Three rules keep it from being a way to break the product:
 *
 *   1. **The official UI keeps the last word.** A wallpaper over it is capped (see
 *      `OFFICIAL_OPACITY_CEILING`) and always carries a scrim, because the official interface is
 *      what the user is actually working in: a background that makes it unreadable is worse than
 *      no background.
 *   2. **A missing or unreadable file removes the layer.** A background that cannot be loaded is
 *      not a broken view, it is no background — the state stays on disk so the path can be fixed,
 *      and every surface is told to draw nothing.
 *   3. **Nothing here executes.** The file is read, size-checked, inlined as `data:` and handed to
 *      a stylesheet. There is no scripting surface, and the dock's own layer is `pointer-events:
 *      none` behind the content.
 *
 * State lives in `data/state/wallpaper.json`, beside the glass preference and for the same reason:
 * it is the user's choice, not deployment configuration.
 */

const fs = require('node:fs')
const path = require('node:path')

/** What a wallpaper may be. An extension is not a guarantee, but it is the check that costs nothing. */
const WALLPAPER_KINDS = Object.freeze({
  // Stills, animations and vectors: everything a CSS background can draw. An SVG is safe *here*
  // precisely because of where it is drawn — a background image is loaded as an image document, so
  // its scripts never run and it can never become a page — and an animated GIF or WebP animates
  // without any of that changing.
  image: Object.freeze([
    '.png', '.apng', '.jpg', '.jpeg', '.jfif', '.pjpeg', '.webp', '.gif',
    '.avif', '.svg', '.svgz', '.bmp', '.ico'
  ]),
  video: Object.freeze(['.mp4', '.webm', '.m4v'])
})

/** The surfaces a wallpaper can be drawn on, and what each of them can carry. */
const WALLPAPER_TARGETS = Object.freeze(['dock', 'overlay', 'shell'])

/** Which of those can carry a video: only the scripted document, and that is not a preference. */
const VIDEO_TARGETS = Object.freeze(['dock'])

const WALLPAPER_DEFAULT = Object.freeze({
  enabled: true,
  file: null,
  fit: 'cover',
  opacity: 55,
  blur: 0,
  scrim: 35,
  muted: true
})

const WALLPAPER_LIMITS = Object.freeze({
  opacity: Object.freeze({ min: 0, max: 100 }),
  blur: Object.freeze({ min: 0, max: 40 }),
  scrim: Object.freeze({ min: 0, max: 100 })
})

const WALLPAPER_FITS = Object.freeze(['cover', 'contain', 'tile'])

/**
 * How opaque a wallpaper may be *over the official UI*.
 *
 * The dock can take any value the user asks for: it is our own surface and the user is looking at
 * it on purpose. The official interface is different — it is where the work happens, and a
 * background over it is always a tax on reading it. Past this the scrim is doing more work than
 * the wallpaper, which is the point at which the wallpaper has stopped being a background and
 * started being an obstruction.
 */
const OFFICIAL_OPACITY_CEILING = 45

/** A single inlined asset has to survive a CSS parse; this is where that stops being reasonable. */
const MAX_ASSET_BYTES = 12 * 1024 * 1024

/** The mime type of a `data:` URL, from the extension. */
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v'
})

/** Which kind a file is, or null when it is not a wallpaper at all. */
function kindOf(file) {
  const extension = path.extname(String(file || '')).toLowerCase()
  if (WALLPAPER_KINDS.image.includes(extension)) return 'image'
  if (WALLPAPER_KINDS.video.includes(extension)) return 'video'
  return null
}

/** One number, clamped into its own range; anything unreadable keeps the value it replaces. */
function clamp(name, value, fallback) {
  const range = WALLPAPER_LIMITS[name]
  const number = Number(value)
  if (!range || !Number.isFinite(number)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(number)))
}

/**
 * @param {object} [options]
 * @param {string} [options.root] the repository root
 * @param {string} [options.file] an explicit state file
 * @param {Function} [options.log]
 */
function createWallpaper(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()))
  const file = path.resolve(String(options.file || path.join(root, 'data', 'state', 'wallpaper.json')))
  const log = typeof options.log === 'function' ? options.log : () => {}

  let cache = null
  /** The inlined asset, keyed by path and mtime: reading a 4K image on every repaint is waste. */
  let asset = { key: null, kind: null, dataUrl: null, missing: false }

  /**
   * The state in force, read once.
   *
   * A malformed file is a preference that failed to persist, not a crash: the defaults stand and
   * the reason is logged rather than thrown at the panel.
   */
  function load() {
    if (cache) return cache
    cache = { ...WALLPAPER_DEFAULT, source: 'default' }
    let raw = null
    try {
      if (!fs.existsSync(file)) return cache
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      log(`wallpaper.json is unreadable (${error?.message || error}); the defaults stand`)
      return cache
    }
    if (!raw || typeof raw !== 'object') return cache
    const chosen = raw.file ? String(raw.file) : null
    cache = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : cache.enabled,
      // A file that is no longer a wallpaper (renamed, or a type this build does not draw) is
      // dropped rather than kept as a path nothing can use.
      file: chosen && kindOf(chosen) ? chosen : null,
      fit: WALLPAPER_FITS.includes(raw.fit) ? raw.fit : cache.fit,
      opacity: clamp('opacity', raw.opacity, cache.opacity),
      blur: clamp('blur', raw.blur, cache.blur),
      scrim: clamp('scrim', raw.scrim, cache.scrim),
      muted: typeof raw.muted === 'boolean' ? raw.muted : cache.muted,
      source: 'user'
    }
    if (chosen && !cache.file) log(`the saved wallpaper "${chosen}" is not an image or a video this build can draw; it was dropped`)
    return cache
  }

  /**
   * Whether a file is on disk right now.
   *
   * A wallpaper that is gone draws nothing, everywhere — so this is asked before a path is
   * accepted as well as before it is drawn, and it takes the path it is asked about rather than
   * only the one that happens to be saved.
   *
   * @param {string} [candidate] a path to check; the saved one when omitted
   */
  function present(candidate) {
    const target = candidate === undefined ? load().file : candidate
    if (!target) return false
    try {
      return fs.statSync(target).isFile()
    } catch {
      return false
    }
  }

  /**
   * The wallpaper as an inline `data:` URL.
   *
   * The official overlay's CSP is `img-src data:` and nothing else, so this is not an
   * optimisation — it is the only shape that surface can be handed. It is also why the dock gets
   * the same URL rather than a `file://` path: one asset, one rule, no second policy to keep right.
   */
  function inline() {
    const state = load()
    if (!state.file) return { kind: null, dataUrl: null, missing: false, reason: 'no wallpaper is chosen' }
    const kind = kindOf(state.file)
    let stat = null
    try {
      stat = fs.statSync(state.file)
    } catch {
      return { kind, dataUrl: null, missing: true, reason: 'the file is not on disk' }
    }
    if (!stat.isFile()) return { kind, dataUrl: null, missing: true, reason: 'the path is not a file' }
    if (stat.size > MAX_ASSET_BYTES) {
      return { kind, dataUrl: null, missing: false, reason: `the file is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB a single inlined asset may be` }
    }
    const key = `${state.file}:${stat.size}:${stat.mtimeMs}`
    if (asset.key === key && asset.kind === kind) return asset
    try {
      const bytes = fs.readFileSync(state.file)
      asset = {
        key,
        kind,
        dataUrl: `data:${MIME_BY_EXTENSION[path.extname(state.file).toLowerCase()] || 'application/octet-stream'};base64,${bytes.toString('base64')}`,
        missing: false
      }
      log(`wallpaper loaded: ${path.basename(state.file)} (${kind}, ${Math.round(stat.size / 1024)} KB)`)
    } catch (error) {
      asset = { key: null, kind, dataUrl: null, missing: true, reason: `the file could not be read: ${error?.message || error}` }
      log(`wallpaper could not be read: ${error?.message || error}`)
    }
    return asset
  }

  /** The state the panel renders, with the limits its controls match and what can be drawn where. */
  function describe() {
    const state = load()
    const kind = state.file ? kindOf(state.file) : null
    const inlined = kind ? inline() : { dataUrl: null, missing: false, reason: null }
    return {
      ok: true,
      ...state,
      kind,
      name: state.file ? path.basename(state.file) : null,
      present: Boolean(state.file) && present(),
      drawable: Boolean(state.enabled && inlined.dataUrl),
      reason: inlined.reason || null,
      file: state.file,
      limits: {
        opacity: { ...WALLPAPER_LIMITS.opacity },
        blur: { ...WALLPAPER_LIMITS.blur },
        scrim: { ...WALLPAPER_LIMITS.scrim }
      },
      fits: [...WALLPAPER_FITS],
      targets: [...WALLPAPER_TARGETS],
      videoTargets: [...VIDEO_TARGETS],
      // What the panel says about a video on a surface that cannot carry one, so the rule is
      // visible where the choice is made instead of being discovered as a blank area.
      note: kind === 'video'
        ? 'a video draws in the dock only: the official surfaces are script-free documents whose CSP allows an inline image and nothing else'
        : null
    }
  }

  /** Change the wallpaper. Every accepted key is validated here, so no surface can disagree. */
  function set(patch = {}) {
    const current = load()
    const next = { ...current, source: 'user' }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.muted === 'boolean') next.muted = patch.muted
    if (patch.fit !== undefined) {
      if (!WALLPAPER_FITS.includes(patch.fit)) return { ok: false, reason: `"${patch.fit}" is not a fit; expected one of ${WALLPAPER_FITS.join(', ')}` }
      next.fit = patch.fit
    }
    if (patch.opacity !== undefined) next.opacity = clamp('opacity', patch.opacity, current.opacity)
    if (patch.blur !== undefined) next.blur = clamp('blur', patch.blur, current.blur)
    if (patch.scrim !== undefined) next.scrim = clamp('scrim', patch.scrim, current.scrim)
    if (patch.file !== undefined) {
      // Clearing is a real choice and an empty string is how it is said.
      const chosen = patch.file === null || patch.file === '' ? null : String(patch.file)
      if (chosen && !kindOf(chosen)) {
        return { ok: false, reason: `"${path.basename(chosen)}" is not a wallpaper: expected ${[...WALLPAPER_KINDS.image, ...WALLPAPER_KINDS.video].join(', ')}` }
      }
      if (chosen && !present(chosen)) return { ok: false, reason: `"${chosen}" is not a file this process can read` }
      next.file = chosen
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({
        enabled: next.enabled,
        file: next.file,
        fit: next.fit,
        opacity: next.opacity,
        blur: next.blur,
        scrim: next.scrim,
        muted: next.muted
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, reason: `the wallpaper preference could not be written: ${error?.message || error}` }
    }
    cache = next
    asset = { key: null, kind: null, dataUrl: null, missing: false }
    log(`wallpaper ${next.enabled && next.file ? `set to ${path.basename(next.file)}` : 'cleared'} (fit ${next.fit}, opacity ${next.opacity}%, blur ${next.blur}px, scrim ${next.scrim}%)`)
    return describe()
  }

  /**
   * The CSS one surface needs.
   *
   * Returning a stylesheet rather than touching a document is what keeps this module free of every
   * surface's DOM: the dock applies it with a custom property, and the two official views are
   * handed it through their existing `insertCSS` path. `none` is a complete answer — it is what
   * every surface is told when there is no wallpaper, so "remove the layer" is the same code path
   * as "paint it", and cannot be forgotten by one of them.
   *
   * @param {string} target `dock` | `overlay` | `shell`
   */
  function layerCss(target) {
    if (!WALLPAPER_TARGETS.includes(target)) throw new Error(`unknown wallpaper target: ${target}`)
    const state = load()
    const inlined = state.file ? inline() : { kind: null, dataUrl: null }
    // The dock is not a CSS layer: it is a real element behind the glass, because that is where a
    // video can live. Answering `none` here keeps one contract for all three callers.
    if (target === 'dock') return 'none'
    // The opacity is the user's, on every surface. A ceiling would be this module deciding how much
    // of their own screen they may cover; the scrim is the readability dial, and it is theirs.
    if (!state.enabled || !inlined.dataUrl || inlined.kind === 'video') return { image: 'none', opacity: 0, scrim: 0, blur: 0, fit: state.fit }
    return {
      image: `url("${inlined.dataUrl}")`,
      opacity: state.opacity,
      scrim: state.scrim,
      blur: state.blur,
      fit: state.fit,
      // A video is a real element with real attributes; the stylesheet cannot describe one, which
      // is why the dock is told separately.
      kind: inlined.kind
    }
  }

  /** Everything the dock's own layer needs, in one object: it is a document, not a stylesheet. */
  function dockLayer() {
    const state = load()
    const inlined = state.file ? inline() : { kind: null, dataUrl: null }
    if (!state.enabled || !state.file) return { active: false, kind: null, src: null, fit: state.fit, opacity: state.opacity, blur: state.blur, scrim: state.scrim, muted: state.muted }
    return {
      active: Boolean(inlined.dataUrl),
      kind: inlined.kind,
      // A video is fetched by the element itself rather than inlined: a base64 video would be a
      // string the size of the file, and the dock is a document we own, so it may read a path.
      src: inlined.kind === 'video' ? `file://${state.file.replace(/\\/g, '/')}` : inlined.dataUrl,
      fit: state.fit,
      opacity: state.opacity,
      blur: state.blur,
      scrim: state.scrim,
      muted: state.muted,
      reason: inlined.reason || null
    }
  }

  /**
   * The stylesheet the two official surfaces are handed.
   *
   * It sets the overlay's own wallpaper variables and nothing else, so it never competes with the
   * theme's stylesheet: that one writes `--ov-tint-*` and its siblings, this one writes
   * `--ov-wallpaper*`, and the surface manager keeps the two under separate keys so a theme repaint
   * cannot take the wallpaper with it.
   *
   * **The opacity is the user's, unclamped.** A ceiling here would be this module deciding how much
   * of their own screen they are allowed to cover; the scrim is the dial for readability, and it is
   * theirs as well. What is *not* negotiable is everything else: an inline image, because that is
   * all those documents' policy allows, and `none` for anything they cannot draw.
   */
  function officialCss() {
    const layer = layerCss('overlay')
    const size = fitFor('overlay') === 'tile' ? 'auto' : fitFor('overlay') === 'contain' ? 'contain' : 'cover'
    return [
      ':root {',
      `  --ov-wallpaper: ${layer.image};`,
      `  --ov-wallpaper-opacity: ${(layer.opacity || 0) / 100};`,
      `  --ov-wallpaper-size: ${size};`,
      `  --ov-wallpaper-repeat: ${fitFor('overlay') === 'tile' ? 'repeat' : 'no-repeat'};`,
      `  --ov-wallpaper-blur: ${layer.blur || 0}px;`,
      `  --ov-wallpaper-scrim: ${(layer.scrim || 0) / 100};`,
      '}'
    ].join('\n')
  }

  /** The fit in force, which is a property of the wallpaper rather than of one surface. */
  function fitFor() {
    return load().fit
  }

  return {
    WALLPAPER_DEFAULT,
    WALLPAPER_LIMITS,
    WALLPAPER_FITS,
    WALLPAPER_KINDS,
    OFFICIAL_OPACITY_CEILING,
    MAX_ASSET_BYTES,
    kindOf,
    describe,
    set,
    read: load,
    present,
    inline,
    layerCss,
    officialCss,
    dockLayer,
    file
  }
}

module.exports = {
  createWallpaper,
  kindOf,
  WALLPAPER_DEFAULT,
  WALLPAPER_LIMITS,
  WALLPAPER_FITS,
  WALLPAPER_KINDS,
  WALLPAPER_TARGETS,
  VIDEO_TARGETS,
  OFFICIAL_OPACITY_CEILING,
  MAX_ASSET_BYTES
}
