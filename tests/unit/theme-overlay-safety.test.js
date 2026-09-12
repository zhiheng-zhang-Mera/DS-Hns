'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * Official Overlay Layout + Safety (Update-Plan/General-Theme.md 任务 9 / 任务 10 / 任务 11).
 *
 * These are the gates that make "the overlay must not break the official UI" a
 * measurement instead of a promise. Every check runs on the *layout that will be
 * painted*, so "the character does not cover the input box" is arithmetic with a
 * number attached, and every number is asserted against the engineering ceiling.
 */
const layout = require('../../app/extensions/mega/theme/official/overlay-layout')
const safety = require('../../app/extensions/mega/theme/official/overlay-safety')
const surface = require('../../app/extensions/mega/theme/surface')
const planner = require('../../app/extensions/mega/theme/assets/planner')
const designer = require('../../app/extensions/mega/theme/designer')

const VIEWPORT = Object.freeze({ x: 0, y: 0, width: 1200, height: 800 })
/** The four critical interaction regions 任务 10 names explicitly. */
const CRITICAL = Object.freeze([
  { id: 'input_region', x: 80, y: 640, width: 900, height: 110 },
  { id: 'send_region', x: 990, y: 640, width: 130, height: 110 },
  { id: 'body_region', x: 120, y: 60, width: 960, height: 520 },
  { id: 'controls_region', x: 40, y: 20, width: 200, height: 40 }
])

function planFor(intent, observation = null) {
  const design = {
    design_language: 'cyber_hud',
    style_tag: 'cyber',
    palette_label: '钢蓝',
    palette_values: { base: '#101724', layer1: '#151922', layer2: '#1b2130', accent: '#4d93f8', overlay: '#0b0d12' },
    intent
  }
  return planner.planOverlay({ intent, design, observation, limits: null })
}

test('the safe region is the viewport minus the critical regions, per side', () => {
  const critical = layout.computeRegions({ viewport: VIEWPORT, critical: CRITICAL, observed: true })
  assert.equal(critical.observed, true)
  assert.equal(critical.critical.length >= 1, true, 'the observed regions are carried through')
  const safe = layout.computeSafeRegion({ viewport: VIEWPORT, critical: critical.critical, margin: 8 })
  // The critical blocks span the middle, so the free bands are left/right.
  assert.ok(safe.bands.left >= 48 || safe.bands.right >= 48, JSON.stringify(safe.bands))
  assert.ok(safe.primary.width > 0 && safe.primary.height > 0)
  // The primary band must be outside the critical block it was derived from.
  for (const region of critical.critical) {
    assert.equal(
      layout.overlapRatio(safe.primary, region) < 1,
      true,
      'the safe band is not entirely inside a critical region'
    )
  }
})

test('with nothing observed the layout assumes the band model and says it degraded', () => {
  const result = layout.layout({ viewport: VIEWPORT, plan: { layout: { mode: 'corner', anchor: 'bottom-right' } }, observed: false })
  assert.equal(result.observed, false)
  assert.equal(result.degraded, true)
  assert.match(result.reason, /band model/)
  assert.equal(result.critical_assumed.length, 3, 'input, send and body are the assumed regions')
  assert.ok(result.critical_regions.length >= 3)
  for (const assumed of result.critical_assumed) {
    assert.equal(Boolean(assumed.id && assumed.label), true, `${assumed.id} is named, not just a box`)
  }
})

test('every layout mode places a character fully inside the official view', () => {
  const plan = planFor(designer.interpret('银发角色，右下角'))
  for (const mode of surface.LAYOUT_MODES) {
    const result = layout.layout({
      viewport: VIEWPORT,
      plan: { ...plan, layout: { ...plan.layout, mode } },
      critical: CRITICAL,
      observed: true
    })
    assert.equal(result.mode, mode)
    const box = result.placements.character_primary.box
    assert.ok(box, `${mode} places the character`)
    assert.ok(box.x >= VIEWPORT.x - 1, `${mode}: the character is not left of the view`)
    assert.ok(box.y >= VIEWPORT.y - 1, `${mode}: the character is not above the view`)
    assert.ok(box.x + box.width <= VIEWPORT.x + VIEWPORT.width + 1, `${mode}: the character is not off the right edge`)
    assert.ok(box.y + box.height <= VIEWPORT.y + VIEWPORT.height + 1, `${mode}: the character is not off the bottom edge`)
    // The frame ring is always present and its coverage is measured from the band.
    assert.equal(result.placements.frame.ring, true)
    assert.ok(result.placements.frame.coverage > 0 && result.placements.frame.coverage < 1)
    assert.deepEqual(result.triggers, ['resize', 'maximize', 'restore', 'dock-toggle', 'view-bounds-change'])
  }
})

test('a character is scaled and moved until it clears the critical regions', () => {
  const intent = designer.interpret('银发角色，大一点，右下角')
  const plan = planFor(intent)
  const result = layout.layout({
    viewport: VIEWPORT,
    plan,
    critical: CRITICAL,
    observed: true,
    criticalOverlap: 0.08
  })
  const placement = result.placements.character_primary
  assert.ok(placement.critical_overlap <= 0.08 + 1e-9, `worst critical overlap ${placement.critical_overlap}`)
  assert.equal(placement.cleared, true)
  assert.equal(placement.coverage <= 0.22 + 1e-9, true, `coverage ${placement.coverage}`)
  // The adjustment is recorded so the preview can explain the smaller figure.
  if (placement.scale < 1) {
    assert.ok(result.adjustments.some((entry) => entry.component === 'character_primary'), JSON.stringify(result.adjustments))
  }
})

test('the overlay safety validator enforces every engineering ceiling numerically', () => {
  const intent = designer.interpret('赛博 HUD，扫描线，很浓的蒙版')
  // Deliberately over the ceiling: the prompt is not allowed to win.
  const loud = {
    version: 1,
    enabled: true,
    layout: { mode: 'corner', anchor: 'bottom-right', margin: 8 },
    components: {
      global_tint: { enabled: true, color: '#0b0d12', opacity: 0.9 },
      gradient: { enabled: true, opacity: 0.8, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#111111' }] },
      texture: { enabled: true, opacity: 0.7, asset: 'assets/official/official-overlay-texture.png' },
      skin: { enabled: true, opacity: 0.6, asset: 'assets/official/official-skin.png' },
      vignette: { enabled: true, opacity: 0.9 },
      scanline: { enabled: true, opacity: 0.4, spacing: 4, width: 2 },
      frame_glow: { enabled: true, opacity: 0.5, width: 6 },
      corner_decoration: { enabled: true, opacity: 0.5, anchor: 'bottom-right' },
      character_primary: { enabled: true, opacity: 1, size: { width: 900, height: 700 }, coverage: 0.9, anchor: 'bottom-right' }
    },
    limits: { ...safety.LIMITS }
  }
  const placement = layout.layout({ viewport: VIEWPORT, plan: loud, critical: CRITICAL, observed: true })
  const report = safety.check({ plan: loud, placement, background: '#0f1115' })
  assert.equal(report.ok, false, 'an over-strong overlay must not pass')
  const failed = new Set(report.failures.map((entry) => entry.id))
  for (const id of ['overlay_opacity', 'texture_opacity', 'skin_opacity', 'vignette', 'scanline']) {
    assert.ok(failed.has(id), `${id} must fail; failed: ${[...failed].join(', ')}`)
  }
  for (const failure of report.failures) {
    assert.ok(failure.limit !== null, `${failure.id} reports the limit it exceeded`)
    assert.ok(failure.actual !== null, `${failure.id} reports the value it measured`)
    assert.equal(failure.actual > failure.limit, true, `${failure.id}: ${failure.actual} > ${failure.limit}`)
  }
  void intent
})

test('enforcement downgrades an over-strong overlay until it passes, and reports each step', () => {
  const loud = {
    version: 1,
    enabled: true,
    layout: { mode: 'corner', anchor: 'bottom-right', margin: 8 },
    components: {
      global_tint: { enabled: true, color: '#0b0d12', opacity: 0.9 },
      gradient: { enabled: true, opacity: 0.8, stops: [] },
      texture: { enabled: true, opacity: 0.7, asset: 'assets/official/official-overlay-texture.png' },
      skin: { enabled: true, opacity: 0.6, asset: 'assets/official/official-skin.png' },
      vignette: { enabled: true, opacity: 0.9 },
      scanline: { enabled: true, opacity: 0.4, spacing: 4, width: 1 },
      frame_glow: { enabled: true, opacity: 0.5, width: 6 },
      corner_decoration: { enabled: true, opacity: 0.5, anchor: 'bottom-right' },
      character_primary: { enabled: false, opacity: 0, coverage: 0 }
    },
    limits: { ...safety.LIMITS }
  }
  const result = safety.enforce({
    plan: loud,
    viewport: VIEWPORT,
    critical: CRITICAL,
    observed: true,
    background: '#0f1115'
  })
  assert.equal(result.ok, true, JSON.stringify(result.report.failures))
  assert.ok(result.adjustments.length >= 1, 'the downgrade is recorded')
  assert.equal(result.degradation.disabled, false)
  assert.ok(result.degradation.level >= 1, 'the overlay is marked downgraded, not silently accepted')
  // The enforced plan really is within the ceilings.
  assert.ok(Number(result.plan.components.global_tint.opacity) <= safety.LIMITS.overlay_opacity)
  assert.ok(Number(result.plan.components.vignette.opacity) <= safety.LIMITS.vignette)
  assert.ok(Number(result.plan.components.scanline.opacity) <= safety.LIMITS.scanline)
})

test('an overlay that cannot satisfy the ceilings at any strength is disabled as a whole', () => {
  // The whole view is critical, so no placement and no size can clear it. The
  // ceiling is a normal 8% here: the point is that *clearing it is impossible*,
  // not that the ceiling is zero.
  const impossible = [{ id: 'everything', x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }]
  const plan = {
    version: 1,
    enabled: true,
    layout: { mode: 'corner', anchor: 'bottom-right', margin: 8 },
    components: {
      global_tint: { enabled: false, opacity: 0 },
      character_primary: { enabled: true, opacity: 0.9, size: { width: 400, height: 260 }, coverage: 0.2, anchor: 'bottom-right' }
    },
    limits: { ...safety.LIMITS }
  }
  const result = safety.enforce({ plan, viewport: VIEWPORT, critical: impossible, observed: true, background: '#0f1115' })
  assert.equal(result.ok, false)
  assert.equal(result.degradation.disabled, true)
  assert.equal(result.degradation.label, 'disabled')
  // Whichever limit ran out first, the reason names it: the character either
  // overlapped the critical region or had to shrink below a placeable size.
  assert.match(result.degradation.reason, /critical_overlap|character_placed|character_coverage/)
  assert.ok(result.adjustments.length >= 1, 'every downgrade attempt is recorded')
  // The failing check carries the measurement that caused it.
  const failing = result.report.failures.map((entry) => entry.id)
  assert.ok(
    failing.includes('critical_overlap') || failing.includes('character_placed'),
    `expected an overlap or placement failure, got ${failing.join(', ')}`
  )
  for (const failure of result.report.failures) {
    assert.ok(failure.limit !== null && failure.actual !== null, `${failure.id} reports both numbers`)
  }
})

test('brightness and contrast loss are measured against the content layer', () => {
  const mild = {
    version: 1,
    enabled: true,
    components: {
      global_tint: { enabled: true, color: '#0b0d12', opacity: 0.1 },
      vignette: { enabled: true, opacity: 0.1 }
    },
    limits: { ...safety.LIMITS }
  }
  const mildEffect = safety.measureEffect({
    stack: safety.stackOf(mild.components),
    background: '#151922'
  })
  assert.ok(mildEffect)
  assert.ok(mildEffect.brightness_delta <= safety.LIMITS.brightness_delta, `brightness delta ${mildEffect.brightness_delta}`)
  assert.ok(mildEffect.contrast_loss <= safety.LIMITS.contrast_loss, `contrast loss ${mildEffect.contrast_loss}`)
  assert.equal(mildEffect.effective.startsWith('#'), true)

  const heavy = {
    global_tint: { enabled: true, color: '#000000', opacity: 0.8 },
    vignette: { enabled: true, opacity: 0.6 }
  }
  const heavyEffect = safety.measureEffect({ stack: safety.stackOf(heavy), background: '#e8ecf3' })
  assert.ok(heavyEffect.contrast_loss > mildEffect.contrast_loss, 'a heavy dark overlay loses more contrast on a light layer')
  assert.equal(safety.composite({ tint: '#000000', background: '#ffffff', opacity: 0.5 }), '#808080')
})

test('the safety report is plain data: every check names its limit and its measurement', () => {
  const plan = planFor(designer.interpret('极简浅色中性'))
  const placement = layout.layout({ viewport: VIEWPORT, plan, critical: CRITICAL, observed: true })
  const report = safety.check({ plan, placement, background: '#101724' })
  assert.equal(typeof report.ok, 'boolean')
  assert.equal(report.total, report.checks.length)
  assert.equal(report.passed, report.checks.filter((entry) => entry.ok).length)
  for (const check of report.checks) {
    assert.equal(typeof check.id, 'string')
    assert.equal(typeof check.label, 'string')
    assert.equal(typeof check.ok, 'boolean')
    assert.ok(check.detail, `${check.id} explains itself`)
  }
  // The layout checks are part of the same report, not a separate one.
  const ids = report.checks.map((entry) => entry.id)
  for (const id of ['overlay_opacity', 'vignette', 'scanline', 'character_coverage', 'critical_overlap', 'layout_overflow', 'layout_follows_view', 'asset_size', 'brightness', 'contrast_loss']) {
    assert.ok(ids.includes(id), `${id} is part of the safety report`)
  }
})

test('an oversized overlay asset fails the asset-size check', () => {
  const plan = planFor(designer.interpret('银发角色'))
  const placement = layout.layout({ viewport: VIEWPORT, plan, critical: CRITICAL, observed: true })
  const report = safety.check({
    plan,
    placement,
    assets: { official_character: { bytes: safety.LIMITS.asset_max_bytes + 1 } },
    background: '#101724'
  })
  const size = report.checks.find((entry) => entry.id === 'asset_size')
  assert.equal(size.ok, false)
  assert.equal(size.limit, safety.LIMITS.asset_max_bytes)
})
