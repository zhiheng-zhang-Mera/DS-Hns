'use strict'

/**
 * Asset Validator (Update-Plan/General-Theme.md 任务 4).
 *
 * The asset pipeline's judge. Two rules shape it:
 *
 *   1. It judges the *artifact*, never a return value. Every check decodes the
 *      actual PNG bytes and measures the actual pixels — real dimensions, real
 *      alpha, real colour variance, real byte size. A generator that returns
 *      "ok: true" with an empty buffer fails here, which is the point.
 *   2. It returns data, never throws. A rejected asset must degrade to "this one
 *      asset is disabled" (任务 17), not to "the theme build crashed".
 *
 * Verdict shape:
 *   { ok, kind, hard: [], soft: [], metrics, reason }
 * `hard` failures reject the asset; `soft` failures are recorded and the asset is
 * kept with a downgrade note (for example a wallpaper that is byte-heavy).
 */
const png = require('../png')
const processor = require('./processor')

/** Byte ceilings per asset class, from the engineering budget (24MB/package). */
const MAX_BYTES = Object.freeze({
  character: 3_000_000,
  plate: 4_000_000,
  tile: 2_000_000,
  sheet: 400_000,
  icon: 200_000,
  generic: 6_000_000
})

/**
 * Minimum content an asset must carry to count as a real visual artifact.
 *
 * `MIN_DISTINCT_COLORS` is deliberately low (2) because a themed asset is allowed
 * to be *subtle* — a minimal theme's panel weave really is a nearly-flat two-tone
 * surface, and rejecting it would force every theme to be busy. What is not
 * allowed is an asset with no image content at all, which is what the ink-ratio
 * floor catches, and an opaque plate where the asset is placed over content, which
 * is what `asset_opaque_plate` catches.
 *
 * `MIN_INK_RATIO` is measured as the alpha-weighted fraction of the canvas, not as
 * a count of fully opaque pixels: a frame drawn at alpha 0.6 is real content, and
 * an opaque-pixel count would report it as an empty asset.
 */
const MIN_DISTINCT_COLORS = 2
const MIN_INK_RATIO = 0.005
const MAX_OPAQUE_RATIO = 0.985
const MIN_TRANSPARENT_RATIO = 0.05
/** Structures drawn over other things (rings, brackets) occupy little area. */
const SPARSE_FRAMINGS = Object.freeze(['frame', 'corner'])

function classify(kind, spec = {}) {
  if (spec.framing === 'frame' || spec.framing === 'plate') return 'plate'
  if (spec.framing === 'tile') return 'tile'
  if (spec.framing === 'sheet' && spec.width <= 128) return 'icon'
  if (spec.framing === 'sheet') return 'sheet'
  if (spec.requiresCharacter || /character|avatar/.test(String(kind || ''))) return 'character'
  return 'generic'
}

/**
 * Validate one generated asset.
 *
 * @param {object} options
 * @param {string} options.kind            asset kind from the plan
 * @param {Buffer} options.buffer          the encoded PNG
 * @param {object} [options.spec]          the plan entry (surface, dimensions, transparent...)
 * @param {object} [options.catalog]       asset catalog entry (dimensions/transparency baseline)
 * @param {boolean} [options.requireContent=true] reject a decorative-but-empty asset
 */
function validate({ kind, buffer, spec = null, catalog = null, requireContent = true } = {}) {
  const hard = []
  const soft = []
  const plan = spec || {}
  const base = catalog || {}
  const name = String(kind || 'asset')
  const metrics = {
    kind: name,
    bytes: 0,
    width: 0,
    height: 0,
    transparent: false,
    opaqueRatio: 0,
    transparentRatio: 0,
    distinctColors: 0,
    meanLuminance: 0
  }

  const fail = (code, message, detail) => hard.push({ code, message, detail: detail === undefined ? null : detail })
  const note = (code, message, detail) => soft.push({ code, message, detail: detail === undefined ? null : detail })

  if (!buffer || !buffer.length) {
    fail('asset_empty', `${name}: the generator produced no bytes`, { bytes: buffer ? buffer.length : 0 })
    return { ok: false, kind: name, hard, soft, metrics, reason: 'asset_empty' }
  }
  metrics.bytes = buffer.length

  const header = png.readPngHeader(buffer)
  if (!header) {
    fail('asset_not_png', `${name}: the bytes are not a PNG image`, { bytes: buffer.length })
    return { ok: false, kind: name, hard, soft, metrics, reason: 'asset_not_png' }
  }
  metrics.width = header.width
  metrics.height = header.height
  metrics.depth = header.depth
  metrics.colorType = header.colorType

  if (header.width < 16 || header.height < 16) {
    fail('asset_too_small', `${name}: ${header.width}x${header.height} is too small to be a usable asset`, header)
  }

  const expectedWidth = Number(plan.width || base.width || 0)
  const expectedHeight = Number(plan.height || base.height || 0)
  if (expectedWidth && expectedHeight) {
    // A 25% deviation means the generator ignored the plan, and the layout engine
    // would place something other than what the preview showed.
    const driftW = Math.abs(header.width - expectedWidth) / expectedWidth
    const driftH = Math.abs(header.height - expectedHeight) / expectedHeight
    if (driftW > 0.25 || driftH > 0.25) {
      fail(
        'asset_dimension_mismatch',
        `${name}: ${header.width}x${header.height} does not match the planned ${expectedWidth}x${expectedHeight}`,
        { actual: [header.width, header.height], planned: [expectedWidth, expectedHeight] }
      )
    } else if (driftW > 0.005 || driftH > 0.005) {
      note(
        'asset_dimension_approximate',
        `${name}: ${header.width}x${header.height} is within 25% of the planned ${expectedWidth}x${expectedHeight}`,
        { actual: [header.width, header.height], planned: [expectedWidth, expectedHeight] }
      )
    }
  }

  let canvas = null
  try {
    canvas = png.decodePng(buffer)
  } catch (error) {
    fail('asset_undecodable', `${name}: the PNG cannot be decoded (${error?.message || error})`)
    return { ok: false, kind: name, hard, soft, metrics, reason: 'asset_undecodable' }
  }

  const alpha = processor.alphaStats(canvas)
  const distinct = processor.distinctColors(canvas)
  const ink = processor.inkRatio(canvas)
  metrics.transparent = alpha.transparentRatio > 0.01
  metrics.opaqueRatio = alpha.opaqueRatio
  metrics.transparentRatio = alpha.transparentRatio
  metrics.inkRatio = ink
  metrics.distinctColors = distinct
  metrics.meanLuminance = Number(processor.meanLuminance(canvas).toFixed(4))

  const mustBeTransparent = plan.transparent === true || base.transparent === true
  if (mustBeTransparent) {
    if (alpha.transparentRatio < MIN_TRANSPARENT_RATIO) {
      fail(
        'asset_not_transparent',
        `${name}: the plan requires a transparent background but only ${(alpha.transparentRatio * 100).toFixed(1)}% of the pixels are transparent`,
        { transparentRatio: alpha.transparentRatio, required: MIN_TRANSPARENT_RATIO }
      )
    }
    // `asset_opaque_plate` is only meaningful where the asset is *placed over*
    // content. A frame or a tile is supposed to be a plate: that is what a frame
    // is, and the overlay's opacity ceilings are what keep it from hiding the UI.
    const framing = String(plan.framing || base.framing || '')
    if (!SPARSE_FRAMINGS.includes(framing) && framing !== 'tile' && alpha.opaqueRatio > MAX_OPAQUE_RATIO) {
      fail(
        'asset_opaque_plate',
        `${name}: ${(alpha.opaqueRatio * 100).toFixed(1)}% of the pixels are fully opaque, which would cover the surface underneath`,
        { opaqueRatio: alpha.opaqueRatio, max: MAX_OPAQUE_RATIO }
      )
    }
  }

  if (requireContent) {
    if (distinct < MIN_DISTINCT_COLORS) {
      fail(
        'asset_flat',
        `${name}: the image carries only ${distinct} distinct colour(s); that is not a visual asset`,
        { distinctColors: distinct, min: MIN_DISTINCT_COLORS }
      )
    }
    if (ink < MIN_INK_RATIO) {
      fail(
        'asset_empty_pixels',
        `${name}: the image carries almost no visible content (ink ${(ink * 100).toFixed(3)}% of the canvas)`,
        { inkRatio: ink, min: MIN_INK_RATIO, opaqueRatio: alpha.opaqueRatio }
      )
    }
  }

  const limit = MAX_BYTES[classify(name, { ...base, ...plan })] || MAX_BYTES.generic
  if (buffer.length > limit) {
    note(
      'asset_oversized',
      `${name}: ${buffer.length} bytes exceeds the ${limit}-byte budget for this class`,
      { bytes: buffer.length, limit }
    )
  }

  return {
    ok: hard.length === 0,
    kind: name,
    hard,
    soft,
    metrics,
    reason: hard.length ? hard[0].code : null
  }
}

/**
 * Validate the whole asset plan result. Returns a package-level verdict that the
 * builder and the preview report share, plus the list of disabled assets so the
 * UI can say which single item degraded instead of failing the theme.
 */
function validateBundle({ assets = [], catalog = {} } = {}) {
  const results = []
  for (const asset of assets) {
    const result = validate({
      kind: asset.kind,
      buffer: asset.buffer,
      spec: asset.plan || asset.spec || null,
      catalog: catalog[asset.kind] || null
    })
    results.push({ ...result, surface: asset.surface || asset.plan?.surface || null, path: asset.path || null })
  }
  const failed = results.filter((result) => !result.ok)
  const warned = results.filter((result) => result.ok && result.soft.length)
  return {
    ok: failed.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    failed,
    warned,
    results
  }
}

module.exports = {
  MAX_BYTES,
  MIN_DISTINCT_COLORS,
  MIN_INK_RATIO,
  MAX_OPAQUE_RATIO,
  MIN_TRANSPARENT_RATIO,
  SPARSE_FRAMINGS,
  classify,
  validate,
  validateBundle
}
