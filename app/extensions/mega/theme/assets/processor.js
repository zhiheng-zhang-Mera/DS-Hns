'use strict'

/**
 * Asset Processor (Update-Plan/General-Theme.md 任务 4).
 *
 * The processor sits between "something produced pixels" and "the validator gets
 * to judge them". It is deliberately the only module allowed to transform an
 * asset, and it is a set of pure canvas -> canvas functions:
 *
 *   fit / cover      place an asset in the exact box the plan asked for
 *   crop / trim      cut to the declared framing, discard empty margins
 *   pad              give an asset the transparent margin the layout needs
 *   downscale        keep the package inside its byte budget
 *   knockout         turn a flat generated background into real transparency
 *   toPng            the single encode step, so every asset is encoded once
 *
 * Two properties matter and are enforced by the callers, not by convention:
 *   1. a processor never *invents* content. `fit`/`cover` resample, they do not
 *      synthesise; if the source is empty the result is empty and the validator
 *      will reject it.
 *   2. transparency is explicit. A real character asset is processed with
 *      `preserveAlpha` so the transparent background survives; a wallpaper is
 *      processed opaque. Getting this backwards is exactly the defect that makes
 *      an overlay cover the official UI with a rectangle.
 */
const png = require('../png')

const EMPTY = Object.freeze({ present: false, total: 0, opaque: 0, opaqueRatio: 0, partial: 0, fullyTransparent: 0 })

/** Alpha statistics of a canvas: the evidence that "transparent" is real. */
function alphaStats(canvas) {
  if (!canvas || !canvas.data) return { ...EMPTY }
  const pixels = canvas.width * canvas.height
  let opaque = 0
  let partial = 0
  let fullyTransparent = 0
  for (let index = 3; index < canvas.data.length; index += 4) {
    const alpha = canvas.data[index]
    if (alpha > 240) opaque += 1
    else if (alpha > 8) partial += 1
    else fullyTransparent += 1
  }
  return {
    present: true,
    total: pixels,
    opaque,
    opaqueRatio: pixels ? Number((opaque / pixels).toFixed(4)) : 0,
    partial,
    fullyTransparent,
    transparentRatio: pixels ? Number(((partial + fullyTransparent) / pixels).toFixed(4)) : 0
  }
}

/** Bounding box of the pixels that are not (nearly) transparent. */
function contentBounds(canvas, { threshold = 8 } = {}) {
  if (!canvas || !canvas.data) return null
  let minX = canvas.width
  let minY = canvas.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (canvas.data[(y * canvas.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Bilinear resample. Used for every scaling operation: nearest-neighbour makes a
 * character asset read as a pixel mess at the sizes the overlay actually uses.
 */
function resize(canvas, width, height) {
  const targetW = Math.max(1, Math.round(Number(width) || 1))
  const targetH = Math.max(1, Math.round(Number(height) || 1))
  if (!canvas || !canvas.data) return png.createCanvas(targetW, targetH)
  if (canvas.width === targetW && canvas.height === targetH) return canvas
  const out = png.createCanvas(targetW, targetH)
  const scaleX = canvas.width / targetW
  const scaleY = canvas.height / targetH
  for (let y = 0; y < targetH; y += 1) {
    const sy = (y + 0.5) * scaleY - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(canvas.height - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < targetW; x += 1) {
      const sx = (x + 0.5) * scaleX - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(canvas.width - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))
      const offsets = [
        (y0 * canvas.width + x0) * 4,
        (y0 * canvas.width + x1) * 4,
        (y1 * canvas.width + x0) * 4,
        (y1 * canvas.width + x1) * 4
      ]
      const weights = [
        (1 - fx) * (1 - fy),
        fx * (1 - fy),
        (1 - fx) * fy,
        fx * fy
      ]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let index = 0; index < 4; index += 1) {
        const offset = offsets[index]
        const weight = weights[index]
        const alpha = canvas.data[offset + 3] / 255
        // Premultiply so transparent pixels do not bleed their colour into edges.
        r += canvas.data[offset] * alpha * weight
        g += canvas.data[offset + 1] * alpha * weight
        b += canvas.data[offset + 2] * alpha * weight
        a += alpha * weight
      }
      const target = (y * targetW + x) * 4
      if (a <= 0.0001) continue
      out.data[target] = Math.max(0, Math.min(255, Math.round(r / a)))
      out.data[target + 1] = Math.max(0, Math.min(255, Math.round(g / a)))
      out.data[target + 2] = Math.max(0, Math.min(255, Math.round(b / a)))
      out.data[target + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
    }
  }
  return out
}

/** Copy a rectangle out of a canvas (clamped, never throws). */
function crop(canvas, { x = 0, y = 0, width, height } = {}) {
  const w = Math.max(1, Math.round(Number(width) || canvas?.width || 1))
  const h = Math.max(1, Math.round(Number(height) || canvas?.height || 1))
  const out = png.createCanvas(w, h)
  if (!canvas || !canvas.data) return out
  const ox = Math.round(Number(x) || 0)
  const oy = Math.round(Number(y) || 0)
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const sx = ox + col
      const sy = oy + row
      if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue
      const source = (sy * canvas.width + sx) * 4
      const target = (row * w + col) * 4
      out.data[target] = canvas.data[source]
      out.data[target + 1] = canvas.data[source + 1]
      out.data[target + 2] = canvas.data[source + 2]
      out.data[target + 3] = canvas.data[source + 3]
    }
  }
  return out
}

/**
 * Fit a canvas into a box without distortion. `mode`:
 *   contain  the whole asset is visible, letterboxed with transparency
 *   cover    the box is filled, overflow cropped
 *   stretch  aspect ratio is ignored (only for procedural tiles)
 */
function fit(canvas, width, height, { mode = 'contain', background = null } = {}) {
  const targetW = Math.max(1, Math.round(Number(width) || 1))
  const targetH = Math.max(1, Math.round(Number(height) || 1))
  const out = png.createCanvas(targetW, targetH)
  if (background) fillCanvas(out, background)
  if (!canvas || !canvas.data || !canvas.width || !canvas.height) return out
  if (mode === 'stretch') return resize(canvas, targetW, targetH)

  const scale = mode === 'cover'
    ? Math.max(targetW / canvas.width, targetH / canvas.height)
    : Math.min(targetW / canvas.width, targetH / canvas.height)
  const scaledW = Math.max(1, Math.round(canvas.width * scale))
  const scaledH = Math.max(1, Math.round(canvas.height * scale))
  const scaled = resize(canvas, scaledW, scaledH)
  const offsetX = Math.round((targetW - scaledW) / 2)
  const offsetY = Math.round((targetH - scaledH) / 2)
  for (let y = 0; y < scaledH; y += 1) {
    for (let x = 0; x < scaledW; x += 1) {
      const dx = offsetX + x
      const dy = offsetY + y
      if (dx < 0 || dy < 0 || dx >= targetW || dy >= targetH) continue
      const source = (y * scaledW + x) * 4
      const target = (dy * targetW + dx) * 4
      out.data[target] = scaled.data[source]
      out.data[target + 1] = scaled.data[source + 1]
      out.data[target + 2] = scaled.data[source + 2]
      out.data[target + 3] = scaled.data[source + 3]
    }
  }
  return out
}

/** Fill a canvas with a solid colour (helper for opaque assets). */
function fillCanvas(canvas, value) {
  const color = parseRgb(value)
  if (!color) return canvas
  for (let index = 0; index < canvas.data.length; index += 4) {
    canvas.data[index] = color.r
    canvas.data[index + 1] = color.g
    canvas.data[index + 2] = color.b
    canvas.data[index + 3] = 255
  }
  return canvas
}

function parseRgb(value) {
  const text = String(value || '').trim()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16)
    }
  }
  const rgb = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return null
}

/**
 * Trim fully transparent margins. A generated figure that only occupies 60% of
 * its canvas wastes overlay budget and makes the layout maths lie, so the
 * processor removes the empty border before the layout engine measures it.
 */
function trim(canvas, { threshold = 8, margin = 0 } = {}) {
  const box = contentBounds(canvas, { threshold })
  if (!box) return canvas
  const pad = Math.max(0, Math.round(Number(margin) || 0))
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const width = Math.min(canvas.width - x, box.width + pad * 2)
  const height = Math.min(canvas.height - y, box.height + pad * 2)
  if (x === 0 && y === 0 && width === canvas.width && height === canvas.height) return canvas
  return crop(canvas, { x, y, width, height })
}

/** Scale down so the longest edge is at most `maxEdge`; never upscales. */
function downscale(canvas, maxEdge) {
  const limit = Math.max(16, Math.round(Number(maxEdge) || 0))
  if (!canvas || !limit) return canvas
  const longest = Math.max(canvas.width, canvas.height)
  if (longest <= limit) return canvas
  const scale = limit / longest
  return resize(canvas, Math.round(canvas.width * scale), Math.round(canvas.height * scale))
}

/** Add a transparent margin around a canvas. */
function pad(canvas, { left = 0, top = 0, right = 0, bottom = 0 } = {}) {
  const width = canvas.width + Math.max(0, Math.round(left)) + Math.max(0, Math.round(right))
  const height = canvas.height + Math.max(0, Math.round(top)) + Math.max(0, Math.round(bottom))
  const out = png.createCanvas(width, height)
  const ox = Math.max(0, Math.round(left))
  const oy = Math.max(0, Math.round(top))
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const source = (y * canvas.width + x) * 4
      const target = ((y + oy) * width + (x + ox)) * 4
      out.data[target] = canvas.data[source]
      out.data[target + 1] = canvas.data[source + 1]
      out.data[target + 2] = canvas.data[source + 2]
      out.data[target + 3] = canvas.data[source + 3]
    }
  }
  return out
}

/**
 * Knock out a flat background.
 *
 * Some generators (including the image model, and the procedural fallback when a
 * request is "no transparency") return a solid plate. If the plan demands real
 * transparency and the plate is a single flat colour, it is removed rather than
 * accepted: a character asset with an opaque rectangle behind it is exactly the
 * defect the overlay safety limits exist to prevent.
 *
 * @returns {{canvas: object, removed: boolean, reason: string}}
 */
function knockout(canvas, { tolerance = 26, sampleFrom = 'corners' } = {}) {
  if (!canvas || !canvas.data) return { canvas, removed: false, reason: 'no canvas' }
  const samples = []
  const push = (x, y) => {
    const offset = (y * canvas.width + x) * 4
    samples.push([canvas.data[offset], canvas.data[offset + 1], canvas.data[offset + 2], canvas.data[offset + 3]])
  }
  if (sampleFrom === 'corners' || sampleFrom === 'edges') {
    push(0, 0)
    push(canvas.width - 1, 0)
    push(0, canvas.height - 1)
    push(canvas.width - 1, canvas.height - 1)
  }
  const opaqueSamples = samples.filter((sample) => sample[3] > 240)
  if (opaqueSamples.length < 3) {
    return { canvas, removed: false, reason: 'the background is already transparent' }
  }
  const reference = opaqueSamples[0]
  const spread = Math.max(...opaqueSamples.map((sample) => Math.max(
    Math.abs(sample[0] - reference[0]),
    Math.abs(sample[1] - reference[1]),
    Math.abs(sample[2] - reference[2])
  )))
  if (spread > tolerance) {
    return { canvas, removed: false, reason: 'the corners are not a single flat colour' }
  }

  const out = png.createCanvas(canvas.width, canvas.height)
  out.data.set(canvas.data)
  let removed = 0
  for (let index = 0; index < out.data.length; index += 4) {
    if (out.data[index + 3] === 0) continue
    const distance = Math.max(
      Math.abs(out.data[index] - reference[0]),
      Math.abs(out.data[index + 1] - reference[1]),
      Math.abs(out.data[index + 2] - reference[2])
    )
    if (distance <= tolerance) {
      out.data[index + 3] = 0
      removed += 1
    }
  }
  const ratio = removed / (canvas.width * canvas.height)
  if (ratio < 0.05) {
    // Barely anything matched: the "flat" corners were a coincidence, and the
    // asset is better left alone than riddled with holes.
    return { canvas, removed: false, reason: 'the flat colour covers almost none of the asset' }
  }
  return { canvas: out, removed: true, reason: `removed a flat background covering ${(ratio * 100).toFixed(1)}% of the asset` }
}

/** Encode a canvas, optionally after a final downscale. */
function toPng(canvas, { maxEdge = 0 } = {}) {
  const final = maxEdge ? downscale(canvas, maxEdge) : canvas
  return { buffer: png.canvasToPng(final), canvas: final, width: final.width, height: final.height }
}

/** Decode PNG bytes (or accept an existing canvas) into a canvas. */
function toCanvas(source) {
  if (!source) return null
  if (source.data && source.width && source.height) return source
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    try {
      return png.decodePng(source)
    } catch {
      return null
    }
  }
  return null
}

/**
 * How many distinct quantised colours the asset actually contains.
 *
 * Semi-transparent pixels count: an overlay asset is mostly alpha below 240, and
 * ignoring it would report a fully drawn frame as a single flat colour.
 */
function distinctColors(canvas, { quantise = 24, ignoreTransparent = true } = {}) {
  if (!canvas || !canvas.data) return 0
  const seen = new Set()
  const step = Math.max(1, Math.round(quantise))
  for (let index = 0; index < canvas.data.length; index += 4) {
    if (ignoreTransparent && canvas.data[index + 3] < 8) continue
    const key = `${Math.round(canvas.data[index] / step)}:${Math.round(canvas.data[index + 1] / step)}:${Math.round(canvas.data[index + 2] / step)}`
    seen.add(key)
    if (seen.size > 4096) break
  }
  return seen.size
}

/**
 * How much visible content the asset carries, as a fraction of a fully painted
 * canvas.
 *
 * `alphaStats.opaqueRatio` counts only alpha > 240, which is the wrong measure for
 * a themed asset: a frame, a texture and an overlay skin are *legitimately* drawn
 * at partial alpha, so an opaque-pixel count reports them as empty. The ink ratio
 * weights every pixel by its alpha, which is what "there is something here" means
 * visually.
 */
function inkRatio(canvas) {
  if (!canvas || !canvas.data) return 0
  const pixels = canvas.width * canvas.height
  if (!pixels) return 0
  let ink = 0
  for (let index = 3; index < canvas.data.length; index += 4) ink += canvas.data[index] / 255
  return Number((ink / pixels).toFixed(5))
}

/** Mean luminance of the non-transparent pixels (0..1). */
function meanLuminance(canvas) {
  if (!canvas || !canvas.data) return 0
  let total = 0
  let count = 0
  for (let index = 0; index < canvas.data.length; index += 4) {
    if (canvas.data[index + 3] < 16) continue
    total += (0.2126 * canvas.data[index] + 0.7152 * canvas.data[index + 1] + 0.0722 * canvas.data[index + 2]) / 255
    count += 1
  }
  return count ? total / count : 0
}

module.exports = {
  alphaStats,
  contentBounds,
  distinctColors,
  inkRatio,
  meanLuminance,
  resize,
  crop,
  fit,
  fillCanvas,
  trim,
  downscale,
  pad,
  knockout,
  toPng,
  toCanvas,
  parseRgb
}
