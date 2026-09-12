'use strict'

/**
 * Overlay Safety Validator (Update-Plan/General-Theme.md 任务 11).
 *
 * The overlay is a visual layer stacked above a renderer DS-Hns does not own, so
 * "it looked fine" is not an acceptable safety argument. This module enforces the
 * engineering ceilings numerically, on the *layout that will actually be painted*:
 *
 *   overlay opacity          <= 0.22   (every tint/gradient/texture layer)
 *   vignette                 <= 0.15
 *   scanline                 <= 0.05
 *   character viewport       <= 22%
 *   critical-region overlap  <= 8%
 *
 * plus brightness, contrast loss, asset size and layout overflow.
 *
 * Two entry points, because the two directions matter equally:
 *
 *   check(...)    report — used by the preview, the acceptance run and the UI.
 *   enforce(...)  repair — used before painting. It *downgrades* (lowers the
 *                 offending strength, shrinks the character) and re-checks, and
 *                 only disables the overlay when repair cannot reach the ceiling.
 *                 A violation must never silently pass, so every repair is
 *                 returned in `adjustments` and every unrepairable violation in
 *                 `blockers`.
 *
 * Contrast loss is measured, not asserted: an overlay at opacity `a` over a
 * background composites to a known colour, and the checks compare the
 * label-on-background ratio before and after. The model is deliberately explicit
 * (label `#eef2f8` and `#182029` on the theme's content layer) so the number is
 * reproducible instead of depending on a screenshot of a renderer we cannot read.
 */
const color = require('../color')
const layoutEngine = require('./overlay-layout')

/** Engineering ceilings. These are the spec numbers, not tunables. */
const LIMITS = Object.freeze({
  overlay_opacity: 0.22,
  vignette: 0.15,
  scanline: 0.05,
  character_coverage: 0.22,
  critical_overlap: 0.08,
  // 任务 11 extras.
  max_overlay_opacity_total: 0.55,
  brightness_delta: 0.18,
  contrast_loss: 0.35,
  asset_max_bytes: 4_000_000
})

/** Effort ladder used by `enforce`: each step multiplies the offending strength. */
const DOWNGRADE_STEPS = Object.freeze([1, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1])

/**
 * Below this the figure is not placeable: a safe region that can only hold a
 * handful of pixels cannot hold a character, and reporting a 0x0 placement as a
 * pass would be exactly the silent failure the ceilings exist to prevent.
 */
const MIN_CHARACTER_EDGE = 32

/** Nominal label colours used for the contrast-loss model. */
const MODEL_LABELS = Object.freeze(['#eef2f8', '#182029', '#a7b1c2'])

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.max(min, Math.min(max, numeric))
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000
}

/** Relative luminance of a colour, 0..1. */
function luminance(value) {
  const parsed = color.parseColor(value)
  if (!parsed) return null
  const channel = (raw) => {
    const c = raw / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b)
}

/** Measure the effect of compositing `tint` at `opacity` over `background`. */
function composite({ tint, background, opacity }) {
  const top = color.parseColor(tint)
  const bottom = color.parseColor(background)
  if (!top || !bottom) return null
  const alpha = clamp(opacity, 0, 1)
  const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha))
  return color.toHex({ r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) })
}

/**
 * Brightness shift and contrast loss caused by one overlay stack over one
 * background. Returns null when it cannot be measured (unparseable colours), which
 * callers treat as "not verified" rather than "verified fine".
 */
function measureEffect({ stack = [], background, labels = MODEL_LABELS }) {
  const base = color.parseColor(background)
  if (!base) return null
  let current = color.toHex(base)
  let totalOpacity = 0
  for (const layer of stack) {
    const opacity = clamp(layer.opacity, 0, 1)
    if (opacity <= 0 || !layer.color) continue
    totalOpacity += opacity * (layer.weight === undefined ? 1 : Number(layer.weight) || 0)
    const next = composite({ tint: layer.color, background: current, opacity })
    if (next) current = next
  }
  const baseLum = luminance(color.toHex(base))
  const afterLum = luminance(current)
  let worstLoss = 0
  let worstRatioBefore = null
  let worstRatioAfter = null
  for (const label of labels) {
    const before = color.contrastRatio(label, color.toHex(base))
    const after = color.contrastRatio(label, current)
    if (before === null || after === null || before <= 0) continue
    const loss = Math.max(0, (before - after) / before)
    if (loss > worstLoss) {
      worstLoss = loss
      worstRatioBefore = Number(before.toFixed(3))
      worstRatioAfter = Number(after.toFixed(3))
    }
  }
  return {
    background: color.toHex(base),
    effective: current,
    brightness_delta: Number(Math.abs((afterLum ?? baseLum) - baseLum).toFixed(4)),
    brightness_before: Number((baseLum || 0).toFixed(4)),
    brightness_after: Number((afterLum || 0).toFixed(4)),
    contrast_loss: Number(worstLoss.toFixed(4)),
    contrast_before: worstRatioBefore,
    contrast_after: worstRatioAfter,
    total_opacity: Number(totalOpacity.toFixed(4))
  }
}

/** The overlay stack a plan actually paints, in paint order. */
function stackOf(components = {}) {
  const stack = []
  if (components.global_tint?.enabled) stack.push({ layer: 'global_tint', color: components.global_tint.color, opacity: components.global_tint.opacity })
  if (components.gradient?.enabled) {
    const stop = components.gradient.stops?.[0]?.color || components.global_tint?.color
    stack.push({ layer: 'gradient', color: stop, opacity: components.gradient.opacity })
  }
  if (components.texture?.enabled) stack.push({ layer: 'texture', color: '#ffffff', opacity: components.texture.opacity })
  if (components.vignette?.enabled) stack.push({ layer: 'vignette', color: '#000000', opacity: components.vignette.opacity })
  // A scanline is a periodic dark line, not a coverage layer: its average
  // contribution is opacity * (width / spacing).
  if (components.scanline?.enabled) {
    const duty = clamp((Number(components.scanline.width) || 1) / Math.max(1, Number(components.scanline.spacing) || 4), 0, 1)
    stack.push({ layer: 'scanline', color: '#000000', opacity: Number((components.scanline.opacity * duty).toFixed(4)), weight: 1 })
  }
  return stack
}

/**
 * Check a laid-out overlay against the ceilings.
 *
 * @param {object} options
 * @param {object} options.plan        overlay plan
 * @param {object} options.placement   output of overlay-layout.layout()
 * @param {object} [options.assets]    { kind: { bytes, width, height } } for the size check
 * @param {object} [options.background] the theme content layer the overlay sits over
 * @param {object} [options.limits]
 */
function check({ plan = {}, placement = null, assets = {}, background = null, limits = {} } = {}) {
  const ceiling = { ...LIMITS, ...(limits || {}), ...(plan.limits || {}) }
  const checks = []
  const blockers = []
  const components = plan.components || {}
  const placed = placement || layoutEngine.layout({
    viewport: plan.layout?.safe_region
      ? { x: 0, y: 0, width: plan.layout.safe_region.width, height: plan.layout.safe_region.height }
      : { x: 0, y: 0, width: 1280, height: 800 },
    plan,
    observed: false,
    criticalOverlap: ceiling.critical_overlap
  })
  const viewport = placed.viewport || { x: 0, y: 0, width: 1280, height: 800 }

  const add = (id, label, ok, detail, limit, actual) => {
    const entry = { id, label, ok: Boolean(ok), detail: detail || null, limit: limit === undefined ? null : limit, actual: actual === undefined ? null : actual }
    checks.push(entry)
    if (!entry.ok) blockers.push(entry)
    return entry
  }

  // ---- 1. opacity ceilings -------------------------------------------------
  const opacityFields = [
    ['overlay_opacity', 'global tint opacity', components.global_tint?.opacity ?? 0, ceiling.overlay_opacity],
    ['texture_opacity', 'overlay texture opacity', components.texture?.opacity ?? 0, ceiling.overlay_opacity],
    ['gradient_opacity', 'gradient opacity', components.gradient?.opacity ?? 0, ceiling.overlay_opacity],
    ['skin_opacity', 'official skin opacity', components.skin?.opacity ?? 0, ceiling.overlay_opacity],
    ['vignette', 'vignette opacity', components.vignette?.opacity ?? 0, ceiling.vignette],
    ['scanline', 'scanline opacity', components.scanline?.opacity ?? 0, ceiling.scanline]
  ]
  for (const [id, label, value, limit] of opacityFields) {
    const actual = Number(value) || 0
    add(
      id,
      `${label} <= ${limit}`,
      actual <= limit + 1e-9,
      actual <= limit + 1e-9 ? `${round(actual)} within the ${limit} ceiling` : `${round(actual)} exceeds the ${limit} ceiling`,
      limit,
      round(actual)
    )
  }

  // ---- 2. coverage ---------------------------------------------------------
  const character = placed.placements?.character_primary || {}
  const coverage = Number(character.coverage) || 0
  add(
    'character_coverage',
    `character viewport coverage <= ${ceiling.character_coverage}`,
    coverage <= ceiling.character_coverage + 1e-9,
    coverage <= ceiling.character_coverage + 1e-9
      ? `${(coverage * 100).toFixed(1)}% of the viewport`
      : `${(coverage * 100).toFixed(1)}% of the viewport exceeds the ${(ceiling.character_coverage * 100).toFixed(0)}% ceiling`,
    ceiling.character_coverage,
    coverage
  )
  /**
   * An "enabled" character that collapsed to nothing is not a safety pass: it means
   * the safe region could not hold it at all. Reporting it as a failure is what
   * makes "the layout could not clear the critical regions" a *measured* outcome
   * instead of a silent 0x0 placement.
   */
  const characterEnabled = components.character_primary?.enabled === true
  const characterWidth = Number(character.box?.width) || 0
  const characterHeight = Number(character.box?.height) || 0
  if (characterEnabled) {
    add(
      'character_placed',
      'the character has a usable placement inside the safe region',
      characterWidth >= MIN_CHARACTER_EDGE && characterHeight >= MIN_CHARACTER_EDGE,
      characterWidth >= MIN_CHARACTER_EDGE && characterHeight >= MIN_CHARACTER_EDGE
        ? `${characterWidth}x${characterHeight} inside the safe region`
        : `the safe region could only hold ${characterWidth}x${characterHeight}, below the ${MIN_CHARACTER_EDGE}px floor`,
      MIN_CHARACTER_EDGE,
      Math.min(characterWidth, characterHeight)
    )
  }

  // ---- 3. critical overlap -------------------------------------------------
  const worstOverlap = Number(character.critical_overlap) || 0
  add(
    'critical_overlap',
    `critical-region overlap <= ${ceiling.critical_overlap}`,
    worstOverlap <= ceiling.critical_overlap + 1e-9,
    worstOverlap <= ceiling.critical_overlap + 1e-9
      ? `${(worstOverlap * 100).toFixed(2)}% worst-case overlap`
      : `${(worstOverlap * 100).toFixed(2)}% of a critical interaction region would be covered`,
    ceiling.critical_overlap,
    worstOverlap
  )
  add(
    'critical_regions_observed',
    'critical interaction regions were measured',
    placed.observed === true,
    placed.observed
      ? `${(placed.critical_regions || []).length} region(s) measured in the live UI`
      : (placed.reason || 'the regions were assumed, not measured'),
    null,
    placed.observed === true
  )

  // ---- 4. layout overflow --------------------------------------------------
  const overflow = []
  for (const [name, entry] of Object.entries(placed.placements || {})) {
    if (!entry || !entry.box) continue
    const clipped = layoutEngine.clipBox(entry.box, viewport)
    if (!clipped || clipped.width < entry.box.width || clipped.height < entry.box.height) {
      overflow.push(`${name} (${entry.box.width}x${entry.box.height}) exceeds the official view bounds`)
    }
  }
  add(
    'layout_overflow',
    'no overlay element exceeds the official view bounds',
    overflow.length === 0,
    overflow.length ? overflow.join('; ') : `${Object.keys(placed.placements || {}).length} placements fit inside ${viewport.width}x${viewport.height}`
  )
  add(
    'layout_follows_view',
    'the layout follows the official view bounds',
    placed.follow === 'official_view_bounds',
    placed.follow === 'official_view_bounds' ? 'bound to the live view bounds' : `follow=${placed.follow}`
  )

  // ---- 5. asset size -------------------------------------------------------
  const oversized = []
  for (const [kind, info] of Object.entries(assets || {})) {
    const bytes = Number(info?.bytes) || 0
    if (bytes > ceiling.asset_max_bytes) oversized.push(`${kind} (${bytes} bytes)`)
  }
  add(
    'asset_size',
    `overlay asset size <= ${ceiling.asset_max_bytes} bytes`,
    oversized.length === 0,
    oversized.length ? oversized.join('; ') : `${Object.keys(assets || {}).length} overlay asset(s) within budget`,
    ceiling.asset_max_bytes,
    oversized.length ? Math.max(...Object.values(assets || {}).map((info) => Number(info?.bytes) || 0)) : 0
  )

  // ---- 6. brightness + contrast loss --------------------------------------
  const backgroundValue = background || plan.palette_background || '#0f1115'
  const effect = measureEffect({ stack: stackOf(components), background: backgroundValue })
  if (!effect) {
    add('brightness', 'overlay brightness shift is measurable', false, `cannot measure a brightness shift over ${backgroundValue}`)
    add('contrast_loss', 'content contrast loss is measurable', false, `cannot measure contrast loss over ${backgroundValue}`)
  } else {
    add(
      'brightness',
      `brightness shift <= ${ceiling.brightness_delta}`,
      effect.brightness_delta <= ceiling.brightness_delta + 1e-9,
      `brightness ${effect.brightness_before} -> ${effect.brightness_after} (delta ${effect.brightness_delta})`,
      ceiling.brightness_delta,
      effect.brightness_delta
    )
    add(
      'contrast_loss',
      `content contrast loss <= ${(ceiling.contrast_loss * 100).toFixed(0)}%`,
      effect.contrast_loss <= ceiling.contrast_loss + 1e-9,
      effect.contrast_before === null
        ? 'no measurable label/background pair'
        : `worst label contrast ${effect.contrast_before}:1 -> ${effect.contrast_after}:1 (loss ${(effect.contrast_loss * 100).toFixed(1)}%)`,
      ceiling.contrast_loss,
      effect.contrast_loss
    )
    add(
      'overlay_opacity_total',
      `total overlay opacity <= ${ceiling.max_overlay_opacity_total}`,
      effect.total_opacity <= ceiling.max_overlay_opacity_total + 1e-9,
      `stacked overlay opacity ${effect.total_opacity}`,
      ceiling.max_overlay_opacity_total,
      effect.total_opacity
    )
  }

  const failures = checks.filter((entry) => !entry.ok)
  return {
    ok: failures.length === 0,
    checks,
    failures,
    blockers,
    passed: checks.length - failures.length,
    total: checks.length,
    effect,
    limits: ceiling
  }
}

/** Scale every strength in a plan by `factor` (used by the downgrade ladder). */
function scaleStrengths(plan, factor) {
  const components = { ...(plan.components || {}) }
  const scale = (entry, keys) => {
    if (!entry) return entry
    const next = { ...entry }
    for (const key of keys) {
      if (next[key] === undefined || next[key] === null) continue
      next[key] = Number((Number(next[key]) * factor).toFixed(4))
    }
    return next
  }
  components.global_tint = scale(components.global_tint, ['opacity'])
  components.texture = scale(components.texture, ['opacity'])
  components.gradient = scale(components.gradient, ['opacity'])
  components.vignette = scale(components.vignette, ['opacity'])
  components.scanline = scale(components.scanline, ['opacity'])
  components.skin = scale(components.skin, ['opacity'])
  components.character_primary = scale(components.character_primary, ['opacity'])
  components.corner_decoration = scale(components.corner_decoration, ['opacity'])
  return { ...plan, components }
}

/** Shrink the character's planned box (a resize, not just an alpha change). */
function scaleCharacter(plan, factor) {
  const components = { ...(plan.components || {}) }
  const character = { ...(components.character_primary || {}) }
  const size = character.size || {}
  character.size = {
    width: Math.max(48, Math.round((Number(size.width) || 256) * factor)),
    height: Math.max(48, Math.round((Number(size.height) || 384) * factor))
  }
  character.coverage = Number(Math.min(LIMITS.character_coverage, (Number(character.coverage) || 0) * factor).toFixed(4))
  components.character_primary = character
  return { ...plan, components }
}

/**
 * Downgrade until the ceilings hold (任务 11: "超过限制自动降级或重新布局").
 *
 * @returns {{ok, plan, placement, report, adjustments, degradation}}
 *   `ok: false` means even the smallest allowed overlay still violates a ceiling;
 *   in that case `degradation.disabled` is true and the caller disables the overlay
 *   (and *only* the overlay) rather than painting it anyway.
 */
function enforce({
  plan = {},
  viewport = null,
  critical = [],
  observed = false,
  assets = {},
  background = null,
  limits = {}
} = {}) {
  const ceiling = { ...LIMITS, ...(limits || {}), ...(plan.limits || {}) }
  const adjustments = []
  const layoutFor = (candidate) => layoutEngine.layout({
    viewport: viewport || candidate.layout?.safe_region || { x: 0, y: 0, width: 1280, height: 800 },
    plan: candidate,
    critical,
    observed,
    criticalOverlap: ceiling.critical_overlap
  })

  let candidate = plan
  let placement = layoutFor(candidate)
  let report = check({ plan: candidate, placement, assets, background, limits: ceiling })

  if (report.ok) {
    return {
      ok: true,
      plan: candidate,
      placement,
      report,
      adjustments,
      degradation: { disabled: false, level: 0, label: 'full' }
    }
  }

  // Pass 1: lower strengths. Pass 2: also shrink the character.
  //
  // Both are tried inside one step: a strength reduction alone cannot fix an
  // overlap problem, and shrinking alone cannot fix an opacity problem, so trying
  // them separately would spend the whole ladder on the wrong axis.
  for (const factor of DOWNGRADE_STEPS.slice(1)) {
    const scaled = scaleStrengths(candidate, factor)
    let shrunk = scaleCharacter(scaled, factor)
    // Never grow the figure back: the smallest attempt so far is the safest.
    const previous = shrunk.components.character_primary?.size
    const smallest = candidate.components.character_primary?.size
    if (previous && smallest && (previous.width > smallest.width || previous.height > smallest.height)) {
      shrunk = scaleCharacter(scaled, 1)
    }
    const scaledPlacement = layoutFor(scaled)
    const scaledReport = check({ plan: scaled, placement: scaledPlacement, assets, background, limits: ceiling })
    const shrunkPlacement = layoutFor(shrunk)
    const shrunkReport = check({ plan: shrunk, placement: shrunkPlacement, assets, background, limits: ceiling })

    // Prefer the candidate that satisfies the ceilings; otherwise keep shrinking.
    const chosen = scaledReport.ok
      ? { plan: scaled, placement: scaledPlacement, report: scaledReport, action: 'scale_strengths' }
      : { plan: shrunk, placement: shrunkPlacement, report: shrunkReport, action: 'scale_strengths_and_shrink_character' }

    candidate = chosen.plan
    placement = chosen.placement
    report = chosen.report
    adjustments.push({
      action: chosen.action,
      factor,
      reason: `overlay strengths scaled to ${(factor * 100).toFixed(0)}%${chosen.action.includes('shrink') ? ' and the character scaled down' : ''} to satisfy the safety ceilings`,
      remaining: report.failures.map((entry) => entry.id)
    })
    if (report.ok) {
      return {
        ok: true,
        plan: candidate,
        placement,
        report,
        adjustments,
        degradation: { disabled: false, level: 1, label: chosen.action.includes('shrink') ? 'downgraded-and-resized' : 'downgraded', factor }
      }
    }
  }

  return {
    ok: false,
    plan: candidate,
    placement,
    report,
    adjustments,
    degradation: {
      disabled: true,
      level: 3,
      label: 'disabled',
      reason: `the overlay cannot satisfy ${report.failures.map((entry) => entry.id).join(', ')} at any allowed strength`
    }
  }
}

module.exports = {
  LIMITS,
  DOWNGRADE_STEPS,
  MIN_CHARACTER_EDGE,
  MODEL_LABELS,
  luminance,
  composite,
  measureEffect,
  stackOf,
  scaleStrengths,
  scaleCharacter,
  check,
  enforce
}
