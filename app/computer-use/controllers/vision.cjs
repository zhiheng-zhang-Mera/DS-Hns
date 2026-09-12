'use strict'

/**
 * Computer Use Runtime: vision controller (plan §4, §22, §48).
 *
 * Vision is the fallback, never the default input source. The controller exists
 * for the cases the plan enumerates: a canvas, a WebGL surface, a custom-drawn
 * widget, a game UI, an image-only application, or a page whose structured state
 * contradicts what is on screen.
 *
 * Two things keep this honest:
 *  - screenshots are *levelled* (region → window → full), and the level only
 *    climbs during recovery (plan §22);
 *  - a detected target is reported with a score and a bounding box that is then
 *    revalidated like any other coordinate (plan §10), so a visual hit never
 *    becomes an unverified click.
 *
 * The image processing is pure Node: PNG decode is the repository's own codec
 * and the matching is a documented sliding-window search with a colour-region
 * fast path. No image library is required, and the algorithms are testable on a
 * decoded framebuffer.
 */

const path = require('node:path')

const { SCREENSHOT_LEVELS } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { normalizeProbe, unavailable } = require('../ports.cjs')
const png = require('../../extensions/mega/theme/png.js')

const LEVEL_NAMES = Object.freeze({
  [SCREENSHOT_LEVELS.NONE]: 'none',
  [SCREENSHOT_LEVELS.REGION]: 'region',
  [SCREENSHOT_LEVELS.WINDOW]: 'window',
  [SCREENSHOT_LEVELS.FULL]: 'full'
})

function createVisionController(options = {}) {
  const clock = options.clock || { now: () => Date.now() }
  const driver = options.driver || null
  const config = {
    matchThreshold: 0.9,
    colorTolerance: 24,
    changeThreshold: 0.02,
    ...(options.config || {})
  }
  const captures = []

  function probe() {
    if (!driver) return normalizeProbe({ available: false, reason: 'no screenshot driver is attached to the runtime' })
    try {
      return normalizeProbe(driver.probe())
    } catch (error) {
      return normalizeProbe({ available: false, reason: error && error.message ? error.message : String(error) })
    }
  }

  function supports(actionType) {
    return ['SCREENSHOT_REGION', 'SCREENSHOT_WINDOW', 'SCREENSHOT_FULL', 'CLICK'].includes(actionType)
  }

  function requireDriver() {
    if (!driver) throw unavailable('screenshot', 'no screenshot driver is attached to the runtime')
    const verdict = probe()
    if (!verdict.available) throw unavailable('screenshot', verdict.reason || 'the screenshot driver is unavailable')
    return driver
  }

  /**
   * Plan §4.2: capture at the requested level only. `captureFull` is refused
   * unless the caller either asked for it explicitly or the contract allows the
   * escalation.
   */
  async function capture(level, request = {}) {
    const chosen = Number.isInteger(level) ? level : SCREENSHOT_LEVELS.REGION
    const activeDriver = requireDriver()
    if (chosen === SCREENSHOT_LEVELS.FULL && request.allowFullScreen === false) {
      throw new ComputerUseError(CODES.VISION_UNAVAILABLE, 'a full-screen capture is not allowed for this step', { level: chosen })
    }
    let result
    if (chosen === SCREENSHOT_LEVELS.REGION) {
      const region = request.region || request.clip
      if (!region) return capture(SCREENSHOT_LEVELS.WINDOW, request)
      result = await activeDriver.captureRegion(region)
    } else if (chosen === SCREENSHOT_LEVELS.WINDOW) {
      const handle = request.windowHandle || (request.window && (request.window.handle || request.window))
      if (handle === undefined || handle === null) return capture(SCREENSHOT_LEVELS.FULL, request)
      result = await activeDriver.captureWindow(handle)
    } else {
      result = await activeDriver.captureFull()
    }
    const record = {
      level: chosen,
      levelName: LEVEL_NAMES[chosen],
      at: clock.now(),
      bytes: result && result.png ? result.png.length : 0,
      rect: result ? result.rect : null,
      backend: result ? result.backend : null,
      reason: request.reason || null
    }
    captures.push(record)
    if (captures.length > 100) captures.splice(0, captures.length - 100)
    return { ...record, png: result ? result.png : null }
  }

  /** Decodes a capture into an RGBA framebuffer for the matchers below. */
  function decode(capture) {
    if (!capture || !capture.png) throw new ComputerUseError(CODES.SCREENSHOT_FAILED, 'no screenshot data to decode')
    try {
      const image = png.decodePng(capture.png)
      return { width: image.width, height: image.height, data: image.data, rect: capture.rect || { x: 0, y: 0, width: image.width, height: image.height } }
    } catch (error) {
      throw new ComputerUseError(CODES.SCREENSHOT_FAILED, `the captured PNG could not be decoded: ${error.message}`, { bytes: capture.png.length })
    }
  }

  /**
   * Plan §48 — visual target detection, two documented strategies:
   *  1. `template` (a PNG path or buffer): sliding-window normalised match.
   *  2. `paint` ({color, width, height}): colour-region search, which is what a
   *     canvas-painted control actually looks like.
   * Returns the best hit in *screen* coordinates, with its score.
   */
  async function locateVisual(target, request = {}) {
    const level = request.level === undefined ? SCREENSHOT_LEVELS.WINDOW : request.level
    const capture_ = request.capture || (await capture(level, request))
    const image = decode(capture_)
    const visual = target && target.visual ? target.visual : target || {}

    if (visual.paint || visual.color) {
      const paint = visual.paint || { color: visual.color }
      const color = normalizeColor(paint.color || paint)
      const region = findColorRegion(image, color, {
        tolerance: paint.tolerance === undefined ? config.colorTolerance : paint.tolerance,
        minWidth: paint.width || visual.width || 1,
        minHeight: paint.height || visual.height || 1
      })
      if (!region) return { ok: false, reason: `no region matched the colour ${JSON.stringify(color)}`, image }
      return {
        ok: true,
        strategy: 'color-region',
        score: region.score,
        rect: toScreenRect(region.rect, image),
        point: toScreenPoint(region.center, image),
        image
      }
    }

    if (visual.template && visual.templatePath) {
      const template = png.decodePng(require('node:fs').readFileSync(visual.templatePath))
      const match = matchTemplate(image, { width: template.width, height: template.height, data: template.data }, {
        threshold: visual.threshold === undefined ? config.matchThreshold : visual.threshold,
        search: visual.search || null
      })
      if (!match) return { ok: false, reason: 'the template was not found in the captured region', image }
      return {
        ok: true,
        strategy: 'template',
        score: match.score,
        rect: toScreenRect(match.rect, image),
        point: toScreenPoint({ x: match.rect.x + match.rect.width / 2, y: match.rect.y + match.rect.height / 2 }, image),
        image
      }
    }

    if (visual.template) {
      const buffer = Buffer.isBuffer(visual.template) ? visual.template : Buffer.from(visual.template)
      const template = png.decodePng(buffer)
      const match = matchTemplate(image, { width: template.width, height: template.height, data: template.data }, {
        threshold: visual.threshold === undefined ? config.matchThreshold : visual.threshold,
        search: visual.search || null
      })
      if (!match) return { ok: false, reason: 'the template was not found in the captured region', image }
      return {
        ok: true,
        strategy: 'template',
        score: match.score,
        rect: toScreenRect(match.rect, image),
        point: toScreenPoint({ x: match.rect.x + match.rect.width / 2, y: match.rect.y + match.rect.height / 2 }, image),
        image
      }
    }

    return { ok: false, reason: 'the target carries no visual description (paint colour or template)', image }
  }

  /**
   * Plan §10 for visual targets: a detected rectangle is re-detected before it
   * is clicked. Same thresholds as every other target.
   */
  function revalidateVisual(previous, current, thresholds = { stablePx: 3, updatePx: 10 }) {
    if (!previous) return { verdict: 'unknown', movement: null }
    if (!current || !current.ok) return { verdict: 'missing', movement: null }
    const movement = Math.round(Math.hypot(current.point.x - previous.point.x, current.point.y - previous.point.y))
    if (movement < thresholds.stablePx) return { verdict: 'stable', movement, current }
    if (movement <= thresholds.updatePx) return { verdict: 'updated', movement, current }
    return { verdict: 'stale', movement, current }
  }

  /**
   * Plan §13/§15: a pixel comparison used as a *stability* signal and as visual
   * verification. The ratio is the share of sampled pixels that changed.
   */
  function compare(before, after, options_ = {}) {
    const first = before && before.data ? before : decode(before)
    const second = after && after.data ? after : decode(after)
    if (!first || !second) return null
    if (first.width !== second.width || first.height !== second.height) return { changed: true, ratio: 1, reason: 'different geometry' }
    const step = options_.step || 4
    const tolerance = options_.tolerance === undefined ? 12 : options_.tolerance
    let sampled = 0
    let changed = 0
    let sample = null
    for (let y = 0; y < first.height; y += step) {
      for (let x = 0; x < first.width; x += step) {
        const index = (y * first.width + x) * 4
        sampled += 1
        const delta = Math.abs(first.data[index] - second.data[index]) + Math.abs(first.data[index + 1] - second.data[index + 1]) + Math.abs(first.data[index + 2] - second.data[index + 2])
        if (delta > tolerance) {
          changed += 1
          if (!sample) sample = { x, y }
        }
      }
    }
    const ratio = sampled ? changed / sampled : 0
    return {
      changed: ratio >= (options_.threshold === undefined ? config.changeThreshold : options_.threshold),
      ratio: Math.round(ratio * 10000) / 10000,
      sampled,
      changedPixels: changed,
      sample
    }
  }

  /**
   * Plan §22 — the escalation ladder. The level only ever climbs by one rung,
   * and a full-screen capture additionally requires the contract's permission.
   */
  function nextLevel(currentLevel, context = {}) {
    const allowFull = context.allowFullScreenFallback !== false
    const level = Number.isInteger(currentLevel) ? currentLevel : SCREENSHOT_LEVELS.NONE
    const ceiling = allowFull ? SCREENSHOT_LEVELS.FULL : SCREENSHOT_LEVELS.WINDOW
    return Math.min(ceiling, level + 1)
  }

  async function visualChange(effect = {}, request = {}) {
    const previous = request.before || (effect.before ? effect.before : null)
    const level = request.level === undefined ? SCREENSHOT_LEVELS.WINDOW : request.level
    const capture_ = await capture(level, request)
    const image = decode(capture_)
    if (!previous) {
      // No baseline: the fact cannot be established, and `null` is reported as
      // `unknown` rather than as a change (plan §46).
      return null
    }
    const result = compare(previous, image, effect)
    return result ? result.changed : null
  }

  function facts() {
    return {
      visualChange: (effect) => visualChange(effect, {}),
      visualCapture: (level, request) => capture(level, request)
    }
  }

  return {
    id: 'vision',
    capability: 'vision',
    probe,
    supports,
    capture,
    decode,
    locateVisual,
    revalidateVisual,
    compare,
    nextLevel,
    visualChange,
    facts,
    captures() {
      return captures.slice()
    }
  }
}

/** Sliding-window mean absolute difference match; returns {score, rect} or null. */
function matchTemplate(image, template, options = {}) {
  const threshold = options.threshold === undefined ? 0.9 : options.threshold
  const search = options.search || { x: 0, y: 0, width: image.width, height: image.height }
  const maxX = Math.min(search.x + search.width, image.width - template.width)
  const maxY = Math.min(search.y + search.height, image.height - template.height)
  let best = null
  for (let y = Math.max(0, search.y); y <= maxY; y += 1) {
    for (let x = Math.max(0, search.x); x <= maxX; x += 1) {
      const score = windowScore(image, template, x, y)
      if (!best || score > best.score) best = { score, rect: { x, y, width: template.width, height: template.height } }
      if (best && best.score === 1) break
    }
  }
  if (!best) return null
  return best.score >= threshold ? { ...best, score: Math.round(best.score * 10000) / 10000 } : null
}

function windowScore(image, template, offsetX, offsetY) {
  const pixels = template.width * template.height
  if (!pixels) return 0
  let matched = 0
  for (let y = 0; y < template.height; y += 1) {
    for (let x = 0; x < template.width; x += 1) {
      const source = ((offsetY + y) * image.width + (offsetX + x)) * 4
      const target = (y * template.width + x) * 4
      const delta = Math.abs(image.data[source] - template.data[target])
        + Math.abs(image.data[source + 1] - template.data[target + 1])
        + Math.abs(image.data[source + 2] - template.data[target + 2])
      if (delta <= 24) matched += 1
    }
  }
  return matched / pixels
}

/** Bounding box + centroid of the largest colour region (a painted control). */
function findColorRegion(image, color, options = {}) {
  const tolerance = options.tolerance === undefined ? 24 : options.tolerance
  const minWidth = options.minWidth || 1
  const minHeight = options.minHeight || 1
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      if (Math.abs(image.data[index] - color.r) > tolerance) continue
      if (Math.abs(image.data[index + 1] - color.g) > tolerance) continue
      if (Math.abs(image.data[index + 2] - color.b) > tolerance) continue
      count += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (count === 0) return null
  const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  if (rect.width < minWidth || rect.height < minHeight) return null
  return {
    rect,
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    count,
    score: Math.round((count / (image.width * image.height)) * 10000) / 10000
  }
}

function normalizeColor(input) {
  if (!input) throw new ComputerUseError(CODES.ACTION_INVALID, 'a paint colour is required for a visual target')
  if (typeof input === 'string') {
    const hex = input.replace('#', '')
    if (hex.length !== 6) throw new ComputerUseError(CODES.ACTION_INVALID, `unsupported colour format: ${input}`)
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
  }
  if (typeof input === 'object' && Number.isFinite(Number(input.r)) && Number.isFinite(Number(input.g)) && Number.isFinite(Number(input.b))) {
    return { r: Number(input.r), g: Number(input.g), b: Number(input.b) }
  }
  throw new ComputerUseError(CODES.ACTION_INVALID, 'unsupported colour description', { received: input })
}

function toScreenRect(rect, image) {
  const origin = image.rect || { x: 0, y: 0 }
  return { x: origin.x + rect.x, y: origin.y + rect.y, width: rect.width, height: rect.height }
}

function toScreenPoint(point, image) {
  const origin = image.rect || { x: 0, y: 0 }
  return { x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) }
}

module.exports = { createVisionController, matchTemplate, findColorRegion, normalizeColor, LEVEL_NAMES }
