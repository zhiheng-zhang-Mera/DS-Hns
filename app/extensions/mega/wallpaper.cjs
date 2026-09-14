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
 *   * **the window** — a script-free document of ours in a click-through window over the official
 *     page (`app/wallpaper-window.cjs`), which is what "the picture backs the whole interface"
 *     means. Its CSP allows exactly one kind of asset, an inline `data:` image, and that is the
 *     whole reason a video cannot go there: a limit of the safe path rather than of this module.
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
 *   3. **Nothing here executes, and nothing here takes an event.** The file is read, size-checked,
 *      inlined as `data:` and handed to a stylesheet. There is no scripting surface, the dock's own
 *      layer is `pointer-events: none` behind the content, and the window over the official page is
 *      a window that ignores mouse events — the one shape this Electron build lets us make
 *      input-transparent, which is why that layer is not a `WebContentsView` (see
 *      `app/wallpaper-window.cjs` for the measurements).
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

/**
 * The two backdrops, and they are **set separately**:
 *
 *   * `main` — the main screen, drawn by the click-through window over the official page
 *     (`app/wallpaper-window.cjs`), handed a stylesheet;
 *   * `dock` — the Mega interface, drawn by the dock's own document
 *     (`app/extensions/mega/ui/dock.html`), which can also carry a video.
 *
 * They used to share one picture and one set of numbers. Wanting a different picture behind the
 * dock than behind the app is not a strange want — the dock is a narrow strip of frosted glass and
 * the main screen is a whole interface — so each surface carries its own file, fit, opacity, blur
 * and scrim, and `null` for one of them is a complete answer meaning "this one has no picture".
 * An older state file (one picture, one set of numbers) is read as *both* surfaces inheriting it,
 * which is exactly what it meant.
 */
const WALLPAPER_SURFACES = Object.freeze(['main', 'dock'])

/** Which of those can carry a video: only the scripted document, and that is not a preference. */
const VIDEO_TARGETS = Object.freeze(['dock'])

/** One surface's own picture and its own numbers. */
const WALLPAPER_SURFACE_DEFAULT = Object.freeze({
  enabled: true,
  file: null,
  fit: 'cover',
  opacity: 55,
  blur: 0,
  scrim: 35,
  // The picture's own filter (`updateplan/startup2.md` §27's `--dsh-wallpaper-*` tokens, which are the public
  // names of exactly these numbers). `1` is "as the file is": a wallpaper the user chose is not automatically
  // dimmed, and the appearance presets are what ask for anything else.
  brightness: 1,
  contrast: 1,
  saturation: 1,
  // Only the dock has an element that can play something, so only the dock has a use for this.
  muted: true
})

const WALLPAPER_DEFAULT = Object.freeze({
  /** The master switch: off means both surfaces draw nothing, whatever they were set to. */
  enabled: true,
  main: { ...WALLPAPER_SURFACE_DEFAULT },
  dock: { ...WALLPAPER_SURFACE_DEFAULT }
})

const WALLPAPER_LIMITS = Object.freeze({
  opacity: Object.freeze({ min: 0, max: 100 }),
  blur: Object.freeze({ min: 0, max: 40 }),
  scrim: Object.freeze({ min: 0, max: 100 }),
  // §27's token ranges, for the picture's filter.
  brightness: Object.freeze({ min: 0.4, max: 1.2 }),
  contrast: Object.freeze({ min: 0.4, max: 1.2 }),
  saturation: Object.freeze({ min: 0, max: 1.5 })
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

/**
 * One number, clamped into its own range; anything unreadable keeps the value it replaces.
 *
 * `integer` is false for the filter numbers, whose ranges are fractional — rounding `0.6` to `1` would make the
 * vocabulary unable to say what it is for.
 */
function clamp(name, value, fallback, integer = true) {
  const range = WALLPAPER_LIMITS[name]
  const number = Number(value)
  if (!range || !Number.isFinite(number)) return fallback
  const bounded = Math.min(range.max, Math.max(range.min, number))
  return integer ? Math.round(bounded) : Math.round(bounded * 1000) / 1000
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
  /**
   * The inlined assets, keyed by path and mtime: reading a 4K image on every repaint is waste.
   *
   * A map rather than one slot, because the two surfaces may point at two different files and one
   * slot would re-read a multi-megabyte photograph on every alternating push.
   */
  const assets = new Map()
  const ASSET_CACHE_LIMIT = 4

  /** One surface's block, normalised from whatever the file (or nothing) held for it. */
  function surfaceFrom(block, inherited) {
    const source = block && typeof block === 'object' ? block : {}
    const chosen = source.file !== undefined ? (source.file ? String(source.file) : null) : inherited.file
    // A file that is no longer a wallpaper (renamed, or a type this build does not draw) is dropped
    // rather than kept as a path nothing can use.
    const usable = chosen && kindOf(chosen) ? chosen : null
    if (chosen && !usable) log(`the saved wallpaper "${chosen}" is not an image or a video this build can draw; it was dropped`)
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : inherited.enabled,
      file: usable,
      fit: WALLPAPER_FITS.includes(source.fit) ? source.fit : inherited.fit,
      opacity: clamp('opacity', source.opacity, inherited.opacity),
      blur: clamp('blur', source.blur, inherited.blur),
      scrim: clamp('scrim', source.scrim, inherited.scrim),
      brightness: clamp('brightness', source.brightness, inherited.brightness, false),
      contrast: clamp('contrast', source.contrast, inherited.contrast, false),
      saturation: clamp('saturation', source.saturation, inherited.saturation, false),
      muted: typeof source.muted === 'boolean' ? source.muted : inherited.muted
    }
  }

  /**
   * The state in force, read once.
   *
   * A malformed file is a preference that failed to persist, not a crash: the defaults stand and
   * the reason is logged rather than thrown at the panel.
   *
   * **The one-picture shape is what every file written before the two surfaces existed looks like**,
   * and it is read as what it meant: both surfaces inherit it. That is also how `set()` treats the
   * legacy keys, so an older caller (or the acceptance run) keeps meaning "both".
   */
  function load() {
    if (cache) return cache
    cache = {
      enabled: WALLPAPER_DEFAULT.enabled,
      main: { ...WALLPAPER_DEFAULT.main },
      dock: { ...WALLPAPER_DEFAULT.dock },
      source: 'default'
    }
    let raw = null
    try {
      if (!fs.existsSync(file)) return cache
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      log(`wallpaper.json is unreadable (${error?.message || error}); the defaults stand`)
      return cache
    }
    if (!raw || typeof raw !== 'object') return cache
    /** What a file from before the two surfaces existed means, key by key. */
    const legacy = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : WALLPAPER_DEFAULT.main.enabled,
      file: raw.file ? String(raw.file) : null,
      fit: WALLPAPER_FITS.includes(raw.fit) ? raw.fit : WALLPAPER_DEFAULT.main.fit,
      opacity: clamp('opacity', raw.opacity, WALLPAPER_DEFAULT.main.opacity),
      blur: clamp('blur', raw.blur, WALLPAPER_DEFAULT.main.blur),
      scrim: clamp('scrim', raw.scrim, WALLPAPER_DEFAULT.main.scrim),
      muted: typeof raw.muted === 'boolean' ? raw.muted : WALLPAPER_DEFAULT.main.muted
    }
    cache = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : WALLPAPER_DEFAULT.enabled,
      main: surfaceFrom(raw.main, legacy),
      dock: surfaceFrom(raw.dock, legacy),
      source: 'user'
    }
    return cache
  }

  /**
   * Whether a file is on disk right now.
   *
   * A wallpaper that is gone draws nothing, everywhere — so this is asked before a path is
   * accepted as well as before it is drawn, and it takes the path it is asked about rather than
   * only the one that happens to be saved.
   *
   * @param {string|null} [candidate] a path to check; the main screen's own when omitted
   */
  function present(candidate) {
    const target = candidate === undefined ? load().main.file : candidate
    if (!target) return false
    try {
      return fs.statSync(target).isFile()
    } catch {
      return false
    }
  }

  /**
   * One picture as an inline `data:` URL.
   *
   * The layer over the official page is a script-free document whose policy allows an inline image,
   * so this is not an optimisation — it is the only shape that surface can be handed. It is also why
   * the dock gets the same URL rather than a `file://` path for an image: one asset, one rule, no
   * second policy to keep right. (A video is the exception, and only because the dock is a document
   * we own with a real element to hand a source to.)
   *
   * @param {string|null} chosen the file to read
   */
  function inline(chosen) {
    if (!chosen) return { kind: null, dataUrl: null, missing: false, reason: 'no wallpaper is chosen' }
    const kind = kindOf(chosen)
    let stat = null
    try {
      stat = fs.statSync(chosen)
    } catch {
      return { kind, dataUrl: null, missing: true, reason: 'the file is not on disk' }
    }
    if (!stat.isFile()) return { kind, dataUrl: null, missing: true, reason: 'the path is not a file' }
    if (stat.size > MAX_ASSET_BYTES) {
      return { kind, dataUrl: null, missing: false, reason: `the file is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB a single inlined asset may be` }
    }
    const key = `${chosen}:${stat.size}:${stat.mtimeMs}`
    const cached = assets.get(key)
    if (cached && cached.kind === kind) return cached
    try {
      const bytes = fs.readFileSync(chosen)
      const entry = {
        key,
        kind,
        dataUrl: `data:${MIME_BY_EXTENSION[path.extname(chosen).toLowerCase()] || 'application/octet-stream'};base64,${bytes.toString('base64')}`,
        missing: false
      }
      assets.set(key, entry)
      while (assets.size > ASSET_CACHE_LIMIT) assets.delete(assets.keys().next().value)
      log(`wallpaper loaded: ${path.basename(chosen)} (${kind}, ${Math.round(stat.size / 1024)} KB)`)
      return entry
    } catch (error) {
      log(`wallpaper could not be read: ${error?.message || error}`)
      return { key: null, kind, dataUrl: null, missing: true, reason: `the file could not be read: ${error?.message || error}` }
    }
  }

  /** One surface, as the panel and the diagnostics read it. */
  function describeSurface(state, surfaceId) {
    const surface = state[surfaceId]
    const kind = surface.file ? kindOf(surface.file) : null
    const inlined = kind ? inline(surface.file) : { dataUrl: null, missing: false, reason: null }
    return {
      enabled: surface.enabled,
      file: surface.file,
      name: surface.file ? path.basename(surface.file) : null,
      kind,
      present: Boolean(surface.file) && present(surface.file),
      fit: surface.fit,
      opacity: surface.opacity,
      blur: surface.blur,
      scrim: surface.scrim,
      muted: surface.muted,
      /**
       * Whether this surface draws anything, master switch included: `false` is a complete answer and
       * the caller acts on it (the window layer comes off the screen, the dock layer is emptied).
       * A video counts as drawable only where something can play it.
       */
      drawable: Boolean(state.enabled && surface.enabled && inlined.dataUrl && (surfaceId === 'dock' || inlined.kind !== 'video')),
      reason: inlined.reason || null
    }
  }

  /** The state the panel renders, with the limits its controls match and what can be drawn where. */
  function describe() {
    const state = load()
    const main = describeSurface(state, 'main')
    const dock = describeSurface(state, 'dock')
    return {
      ok: true,
      /** The master switch, then each surface's own settings. */
      enabled: state.enabled,
      source: state.source,
      /**
       * The main screen is what "the wallpaper" means at the top level, and that is kept because it
       * is what every older caller asked about: the file, its kind, whether it can be drawn, and the
       * numbers a single-surface panel renders.
       */
      ...main,
      main,
      dock,
      /** Whether the two surfaces are showing the same picture (which is drawn as one image). */
      shared: sharesPicture(),
      limits: {
        opacity: { ...WALLPAPER_LIMITS.opacity },
        blur: { ...WALLPAPER_LIMITS.blur },
        scrim: { ...WALLPAPER_LIMITS.scrim }
      },
      fits: [...WALLPAPER_FITS],
      surfaces: [...WALLPAPER_SURFACES],
      videoTargets: [...VIDEO_TARGETS],
      // What the panel says about a video on a surface that cannot carry one, so the rule is
      // visible where the choice is made instead of being discovered as a blank area.
      note: main.kind === 'video'
        ? 'a video draws in Mega only: the main screen\'s layer is a script-free document whose policy allows an inline image and nothing else'
        : null
    }
  }

  /**
   * One surface's block, from a patch.
   *
   * Every accepted key is validated here, so no surface can disagree about what is in force; the
   * answer is `{ ok: false, reason }` for anything a caller could not have meant, and the file on
   * disk is not touched in that case.
   */
  function applySurface(target, surfaceId, block, previous) {
    const next = { ...previous }
    if (typeof block.enabled === 'boolean') next.enabled = block.enabled
    if (typeof block.muted === 'boolean') next.muted = block.muted
    if (block.fit !== undefined) {
      if (!WALLPAPER_FITS.includes(block.fit)) return { ok: false, reason: `"${block.fit}" is not a fit; expected one of ${WALLPAPER_FITS.join(', ')}` }
      next.fit = block.fit
    }
    if (block.opacity !== undefined) next.opacity = clamp('opacity', block.opacity, previous.opacity)
    if (block.blur !== undefined) next.blur = clamp('blur', block.blur, previous.blur)
    if (block.scrim !== undefined) next.scrim = clamp('scrim', block.scrim, previous.scrim)
    // §27's filter tokens, with the same names a provider would use.
    if (block.brightness !== undefined) next.brightness = clamp('brightness', block.brightness, previous.brightness, false)
    if (block.contrast !== undefined) next.contrast = clamp('contrast', block.contrast, previous.contrast, false)
    if (block.saturation !== undefined) next.saturation = clamp('saturation', block.saturation, previous.saturation, false)
    // `darken` is the §27 token name for the scrim: one number with two audiences, so a provider that speaks
    // the token vocabulary and the settings page that speaks the layer's cannot end up storing two of them.
    if (block.darken !== undefined) next.scrim = clamp('scrim', block.darken, previous.scrim)
    if (block.file !== undefined) {
      // Clearing is a real choice and an empty string is how it is said.
      const chosen = block.file === null || block.file === '' ? null : String(block.file)
      if (chosen && !kindOf(chosen)) {
        return { ok: false, reason: `"${path.basename(chosen)}" is not a wallpaper: expected ${[...WALLPAPER_KINDS.image, ...WALLPAPER_KINDS.video].join(', ')}` }
      }
      if (chosen && !present(chosen)) return { ok: false, reason: `"${chosen}" is not a file this process can read` }
      next.file = chosen
    }
    target[surfaceId] = next
    return { ok: true }
  }

  /**
   * Change the wallpaper.
   *
   * Two shapes are accepted, and both mean something a caller can predict:
   *
   *   * `{ main: {…}, dock: {…} }` — the same keys, for one surface each. This is what the panel
   *     sends, and it is how the main screen and Mega are set separately;
   *   * the historical flat shape (`{ file, fit, opacity, blur, scrim, muted }`) — **both** surfaces,
   *     because that is what one picture with one set of numbers used to mean. `enabled` stays the
   *     master switch either way.
   */
  function set(patch = {}) {
    const current = load()
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      main: { ...current.main },
      dock: { ...current.dock },
      source: 'user'
    }
    const flat = {}
    for (const key of ['file', 'fit', 'opacity', 'blur', 'scrim', 'muted']) {
      if (patch[key] !== undefined) flat[key] = patch[key]
    }
    for (const surfaceId of WALLPAPER_SURFACES) {
      const block = patch[surfaceId] && typeof patch[surfaceId] === 'object' ? patch[surfaceId] : null
      if (!block && !Object.keys(flat).length) continue
      const applied = applySurface(next, surfaceId, { ...flat, ...(block || {}) }, current[surfaceId])
      if (applied.ok === false) return applied
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({
        enabled: next.enabled,
        main: next.main,
        dock: next.dock
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, reason: `the wallpaper preference could not be written: ${error?.message || error}` }
    }
    cache = next
    assets.clear()
    const summary = WALLPAPER_SURFACES
      .map((surfaceId) => `${surfaceId}=${next[surfaceId].file ? path.basename(next[surfaceId].file) : 'none'}`)
      .join(', ')
    log(`wallpaper set (${summary})${next.enabled ? '' : ' — the master switch is off'}`)
    return describe()
  }

  /**
   * The CSS one surface needs.
   *
   * Returning a stylesheet rather than touching a document is what keeps this module free of every
   * surface's DOM: the main screen's layer is handed it through an `insertCSS` path, and the dock
   * draws a real element instead (see `dockLayer`). `none` is a complete answer — it is what the
   * caller is told when there is nothing to draw, so "remove the layer" is the same code path as
   * "paint it", and cannot be forgotten.
   *
   * @param {string} target `main` | `dock`
   */
  function layerCss(target) {
    if (!WALLPAPER_SURFACES.includes(target)) throw new Error(`unknown wallpaper target: ${target}`)
    const state = load()
    const surface = state[target]
    const inlined = surface.file ? inline(surface.file) : { kind: null, dataUrl: null }
    // The dock is not a CSS layer: it is a real element behind the glass, because that is where a
    // video can live. Answering `none` here keeps one contract for both callers.
    if (target === 'dock') return 'none'
    // The opacity is the user's, on every surface. A ceiling would be this module deciding how much
    // of their own screen they may cover; the scrim is the readability dial, and it is theirs.
    if (!state.enabled || !surface.enabled || !inlined.dataUrl || inlined.kind === 'video') {
      return { image: 'none', opacity: 0, scrim: 0, blur: 0, fit: surface.fit, kind: inlined.kind || null }
    }
    return {
      image: `url("${inlined.dataUrl}")`,
      opacity: surface.opacity,
      scrim: surface.scrim,
      blur: surface.blur,
      fit: surface.fit,
      // A video is a real element with real attributes; the stylesheet cannot describe one, which
      // is why the dock is told separately.
      kind: inlined.kind
    }
  }

  /**
   * Everything the dock's own layer needs, in one object: it is a document, not a stylesheet.
   *
   * From the **dock's** own picture, which is the whole point: the Mega interface can show a
   * different image from the main screen, and `active: false` (nothing chosen, switched off, or a
   * file that has gone) is how the dock is told to draw nothing at all rather than keep the last
   * picture on screen.
   */
  function dockLayer() {
    const state = load()
    const surface = state.dock
    const inlined = surface.file ? inline(surface.file) : { kind: null, dataUrl: null }
    const settings = {
      fit: surface.fit,
      opacity: surface.opacity,
      blur: surface.blur,
      scrim: surface.scrim,
      muted: surface.muted
    }
    if (!state.enabled || !surface.enabled || !surface.file) {
      return { active: false, kind: null, src: null, ...settings, reason: null }
    }
    return {
      active: Boolean(inlined.dataUrl),
      kind: inlined.kind,
      // A video is fetched by the element itself rather than inlined: a base64 video would be a
      // string the size of the file, and the dock is a document we own, so it may read a path.
      src: inlined.kind === 'video' ? `file://${surface.file.replace(/\\/g, '/')}` : inlined.dataUrl,
      ...settings,
      reason: inlined.reason || null
    }
  }

  /**
   * Whether the two surfaces are showing the same picture.
   *
   * It matters for one thing only, and it is a visual one: when both surfaces have the same file, the
   * dock's copy is placed against the *window* box and the two meet at the cut as one image. With two
   * different files that would be wrong — the dock would be showing a slice of its own photograph —
   * so each then fits its own box.
   */
  function sharesPicture() {
    const state = load()
    return Boolean(state.main.file && state.dock.file && state.main.file === state.dock.file)
  }

  /**
   * The stylesheet the window over the official page is handed.
   *
   * It sets the layer's own variables and nothing else, so it never competes with anything else
   * writing into that document — the shell writes the dock's cut (`--wp-notch-*`) on its own key,
   * and the two are replaced independently.
   *
   * **The opacity is the user's, unclamped.** A ceiling here would be this module deciding how much
   * of their own screen they are allowed to cover; the scrim is the dial for readability, and it is
   * theirs as well. What is *not* negotiable is everything else: an inline image, because that is
   * all that document's policy allows, and `none` for anything it cannot draw.
   *
   * **The selector is `:root:root` on purpose, and it is not decoration.** The document carries its
   * own defaults for these variables, and `insertCSS` does *not* beat them: the inserted sheet sits
   * before the document's own, so with equal specificity the document wins and the layer draws
   * nothing (measured: `:root { --probe: X }` inserted into a document that declares `--probe` loses
   * to the document; the same rule written `:root:root` wins). Doubling the selector is how "the
   * shell's answer wins over the document's default" is said in one line.
   *
   * **The picture is a direct declaration, not a custom property.** A custom property holding a
   * multi-megabyte `data:` URL is *dropped* by the CSS engine: measured, `--probe: '<1280 KB>'` arrives
   * and `--probe: '<2048 KB>'` never does (the value comes back empty), while the same bytes in a
   * `url()` inside a normal declaration arrive and apply at 6 MB. That is the whole difference between
   * a wallpaper that appears and one that silently does not — and a 2.7 MB photograph is exactly the
   * size that trips it, while a 15 KB icon is exactly the size that does not.
   */
  function windowCss() {
    const layer = layerCss('main')
    const fit = fitFor('main')
    const size = fit === 'tile' ? 'auto' : fit === 'contain' ? 'contain' : 'cover'
    return [
      ':root:root {',
      `  --wp-opacity: ${(layer.opacity || 0) / 100};`,
      `  --wp-size: ${size};`,
      `  --wp-repeat: ${fit === 'tile' ? 'repeat' : 'no-repeat'};`,
      `  --wp-blur: ${layer.blur || 0}px;`,
      `  --wp-scrim: ${(layer.scrim || 0) / 100};`,
      // §27: the picture's filter, under the names a provider is allowed to use. They are the same numbers as
      // the layer's own, so an appearance provider and the settings page cannot describe two different pictures.
      `  --dsh-wallpaper-brightness: ${filterOf('brightness')};`,
      `  --dsh-wallpaper-contrast: ${filterOf('contrast')};`,
      `  --dsh-wallpaper-saturation: ${filterOf('saturation')};`,
      `  --dsh-wallpaper-darken: ${(layer.scrim || 0) / 100};`,
      '}',
      // `!important` because the document's own rule for this element sets the picture from a variable
      // and sits after an inserted sheet in the cascade: this is the same statement as `:root:root`
      // above, made against an element rule instead of the root.
      `#wallpaper { background-image: ${layer.image} !important; }`
    ].join('\n')
  }

  /**
   * The fit in force for one surface. The stylesheet needs it in words (`cover`/`contain`/`auto`)
   * as well as in the payload, and the two must come from the same place.
   *
   * @param {string} surfaceId
   */
  function fitFor(surfaceId) {
    return load()[surfaceId].fit
  }

  /** One of the picture's filter numbers, from the main screen's layer (the window's own picture). */
  function filterOf(name) {
    const value = Number(load().main[name])
    return Number.isFinite(value) ? value : 1
  }

  /**
   * Everything the click-through window over the official page needs: the stylesheet it is handed,
   * and whether there is anything to draw at all. From the **main** surface — that is what the main
   * screen's backdrop is.
   *
   * The second half is not decoration. That layer is a real window, so "nothing to draw" has to be
   * a decision someone can act on: the shell hides it — and never creates it in the first place —
   * rather than leaving a transparent window over the official UI for the rest of the session.
   */
  function windowLayer() {
    const state = load()
    const surface = state.main
    const inlined = surface.file ? inline(surface.file) : { kind: null, dataUrl: null }
    const drawable = Boolean(state.enabled && surface.enabled && inlined.dataUrl && inlined.kind !== 'video')
    return { css: windowCss(), drawable, kind: inlined.kind || null, reason: inlined.reason || null }
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
    windowCss,
    windowLayer,
    dockLayer,
    sharesPicture,
    file
  }
}

module.exports = {
  createWallpaper,
  kindOf,
  WALLPAPER_DEFAULT,
  WALLPAPER_SURFACE_DEFAULT,
  WALLPAPER_LIMITS,
  WALLPAPER_FITS,
  WALLPAPER_KINDS,
  WALLPAPER_SURFACES,
  VIDEO_TARGETS,
  OFFICIAL_OPACITY_CEILING,
  MAX_ASSET_BYTES
}
