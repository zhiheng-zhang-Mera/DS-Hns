'use strict'

/**
 * Colour helpers for the theme engine.
 *
 * Deliberately dependency-free: validation of a candidate theme must never
 * depend on a heavyweight library, because a validator failure would otherwise
 * be able to take the theme system (and therefore the dock) down.
 */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)$/i

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isHex(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim())
}

/**
 * Parse a CSS colour into {r,g,b,a} (0-255 / 0-1). Returns null when the value
 * is not a colour the validator understands. `transparent` and `none` are
 * intentionally not colours — callers treat them as "no surface".
 */
function parseColor(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  if (raw.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (HEX_RE.test(raw)) {
    let hex = raw.slice(1)
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  const match = raw.match(RGB_RE)
  if (!match) return null
  const channel = (text) => (text.endsWith('%') ? Math.round((parseFloat(text) / 100) * 255) : Math.round(parseFloat(text)))
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4])
  return {
    r: clamp(channel(match[1]), 0, 255),
    g: clamp(channel(match[2]), 0, 255),
    b: clamp(channel(match[3]), 0, 255),
    a: clamp(alpha, 0, 1)
  }
}

/** RGB -> #rrggbb. */
function toHex(value) {
  const parsed = toRgba(value)
  if (!parsed) return null
  const part = (channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')
  return `#${part(parsed.r)}${part(parsed.g)}${part(parsed.b)}`
}

/**
 * Normalise anything colour-shaped into `{r,g,b,a}`.
 *
 * Both a CSS string and an already-parsed `{r,g,b,a}` object are accepted, because
 * the theme engine really does pass both: a token is a string, while the asset
 * generators work with the parsed palette. A non-colour (an object without
 * channels, a malformed string) returns `null` so the caller can fall back instead
 * of propagating `NaN` into a generated image.
 */
function toRgba(value) {
  if (typeof value === 'string') return parseColor(value)
  if (!value || typeof value !== 'object') return null
  const r = Number(value.r)
  const g = Number(value.g)
  const b = Number(value.b)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  const a = value.a === undefined ? 1 : Number(value.a)
  return {
    r: clamp(r, 0, 255),
    g: clamp(g, 0, 255),
    b: clamp(b, 0, 255),
    a: Number.isFinite(a) ? clamp(a, 0, 1) : 1
  }
}

/** Compose a colour over an opaque base, honouring the alpha channel. */
function flatten(color, base) {
  // `toRgba` returns the value unchanged for a well-formed object; the `slice` is
  // what stops this from handing the caller's own object back to be mutated.
  const parsed = toRgba(color)
  if (!parsed) return null
  if (parsed.a >= 1) return { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 }
  const under = toRgba(base) || { r: 0, g: 0, b: 0, a: 1 }
  const a = parsed.a
  return {
    r: parsed.r * a + under.r * (1 - a),
    g: parsed.g * a + under.g * (1 - a),
    b: parsed.b * a + under.b * (1 - a),
    a: 1
  }
}

function srgbToLinear(channel) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an opaque colour. */
function relativeLuminance(color) {
  const flat = flatten(color)
  if (!flat) return null
  return 0.2126 * srgbToLinear(flat.r) + 0.7152 * srgbToLinear(flat.g) + 0.0722 * srgbToLinear(flat.b)
}

/**
 * WCAG contrast ratio between two colours. Semi-transparent foregrounds are
 * composited over the background first, so `rgba(...)` text is measured the way
 * it actually renders.
 */
function contrastRatio(foreground, background) {
  const bg = typeof background === 'string' ? parseColor(background) : background
  const fgParsed = typeof foreground === 'string' ? parseColor(foreground) : foreground
  if (!bg || !fgParsed) return null
  const bgFlat = flatten(bg) || bg
  const fgFlat = flatten(fgParsed, bgFlat)
  const l1 = relativeLuminance(fgFlat)
  const l2 = relativeLuminance(bgFlat)
  if (l1 === null || l2 === null) return null
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/** HSL conversion used by the deterministic palette synthesis. */
function rgbToHsl(color) {
  const flat = flatten(color)
  if (!flat) return null
  const r = flat.r / 255
  const g = flat.g / 255
  const b = flat.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return { h: h * 360, s, l }
}

function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360 / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v, a: 1 }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t) => {
    let value = t
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
    a: 1
  }
}

/** Shift lightness by `amount` (-1..1) and/or rotate hue by `degrees`. */
function shade(color, amount, { hueShift = 0, saturationScale = 1 } = {}) {
  const hsl = rgbToHsl(color)
  if (!hsl) return null
  return toHex(hslToRgb({
    h: hsl.h + hueShift,
    s: clamp(hsl.s * saturationScale, 0, 1),
    l: clamp(hsl.l + amount, 0, 1)
  }))
}

/** Mix two colours; `weight` is how much of `color` ends up in the result. */
function mix(color, other, weight = 0.5) {
  const a = flatten(color)
  const b = flatten(other)
  if (!a || !b) return null
  const w = clamp(weight, 0, 1)
  return toHex({
    r: a.r * w + b.r * (1 - w),
    g: a.g * w + b.g * (1 - w),
    b: a.b * w + b.b * (1 - w)
  })
}

/** Perceptual (weighted RGB) distance, used for state separability. */
function distance(a, b) {
  const x = flatten(a)
  const y = flatten(b)
  if (!x || !y) return null
  const rMean = (x.r + y.r) / 2
  const dr = x.r - y.r
  const dg = x.g - y.g
  const db = x.b - y.b
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db)
}

/** Is the colour perceptually light? Used to pick readable label colours. */
function isLight(color) {
  const luminance = relativeLuminance(color)
  return luminance !== null && luminance > 0.45
}

/** Pick whichever of two candidates contrasts better against `background`. */
function bestOn(background, candidates) {
  let best = null
  let bestRatio = -1
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background)
    if (ratio !== null && ratio > bestRatio) {
      bestRatio = ratio
      best = candidate
    }
  }
  return best
}

module.exports = {
  clamp,
  isHex,
  parseColor,
  toRgba,
  toHex,
  flatten,
  relativeLuminance,
  contrastRatio,
  rgbToHsl,
  hslToRgb,
  shade,
  mix,
  distance,
  isLight,
  bestOn
}
