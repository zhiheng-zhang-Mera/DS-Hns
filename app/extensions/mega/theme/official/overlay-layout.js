'use strict'

/**
 * Official Overlay Layout Engine (Update-Plan/General-Theme.md 任务 9 / 任务 10).
 *
 * Pure geometry. Given the official view's bounds, the observed critical
 * interaction regions and the overlay plan, it answers exactly one question:
 * *where does every overlay element go?* It never touches a renderer, never reads
 * a DOM and never paints — which is what makes the safety rules testable without
 * launching Electron, and what lets the preview show the same numbers the live
 * overlay will use.
 *
 * Two region vocabularies, deliberately separate (任务 10):
 *
 *   safe region      the area overlay content MAY occupy. Derived by subtracting
 *                    the critical regions from the viewport, then narrowed by the
 *                    plan's margin. Always a union of rectangles, never a guess.
 *   critical region  the area overlay content MUST NOT occupy: the input box, the
 *                    send button, the central body of the conversation and the
 *                    primary interactive controls.
 *
 * When the real regions were not observed the engine says so (`degraded: true`)
 * and falls back to a band model — the outer frame plus a reserved centre block —
 * rather than pretending the centre is free. Conservative is the only safe default:
 * an overlay that lands on the input box is a functional regression, an overlay
 * that stays in the margin is merely plainer.
 *
 * Layout modes (任务 9): corner / edge / floating / background / framed.
 */
const surfaceModule = require('../surface')

/** Fraction of the viewport reserved as the central body when nothing was observed. */
const DEFAULT_CRITICAL_BAND = Object.freeze({ x: 0.05, y: 0.06, width: 0.9, height: 0.74 })
/** Fraction of the viewport reserved as the input band when nothing was observed. */
const DEFAULT_INPUT_BAND = Object.freeze({ x: 0.05, y: 0.82, width: 0.9, height: 0.14 })
/** Fraction of the viewport reserved as the send-button band. */
const DEFAULT_SEND_BAND = Object.freeze({ x: 0.83, y: 0.82, width: 0.14, height: 0.14 })

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.max(min, Math.min(max, numeric))
}

function round(value) {
  return Math.round(Number(value) || 0)
}

function normalizeBox(value) {
  if (!value || typeof value !== 'object') return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    width,
    height
  }
}

/** Area of the intersection of two boxes (0 when they do not overlap). */
function intersectionArea(a, b) {
  if (!a || !b) return 0
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/** Fraction of `box` covered by `other`. */
function overlapRatio(box, other) {
  if (!box || !other || box.width <= 0 || box.height <= 0) return 0
  return Number((intersectionArea(box, other) / (box.width * box.height)).toFixed(4))
}

/** Fraction of the viewport `box` occupies. */
function coverageRatio(box, viewport) {
  if (!box || !viewport || viewport.width <= 0 || viewport.height <= 0) return 0
  return Number((intersectionArea(box, viewport) / (viewport.width * viewport.height)).toFixed(4))
}

/** Intersect a box with the viewport. */
function clipBox(box, viewport) {
  if (!box) return null
  const x = Math.max(viewport.x, box.x)
  const y = Math.max(viewport.y, box.y)
  const right = Math.min(viewport.x + viewport.width, box.x + box.width)
  const bottom = Math.min(viewport.y + viewport.height, box.y + box.height)
  if (right <= x || bottom <= y) return { x: round(x), y: round(y), width: 0, height: 0 }
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) }
}

function scaleBox(viewport, fraction) {
  return {
    x: round(viewport.x + viewport.width * fraction.x),
    y: round(viewport.y + viewport.height * fraction.y),
    width: round(viewport.width * fraction.width),
    height: round(viewport.height * fraction.height)
  }
}

/**
 * The critical interaction regions of the official view (任务 10).
 *
 * `observed` wins whenever the inspector actually measured regions: those are real
 * boxes. Otherwise the band model is used and the result is marked unobserved, so
 * the safety validator can report "this was assumed" instead of claiming a pass.
 *
 * @param {object} options
 * @param {object} options.viewport      official view bounds in the overlay's own coordinate space
 * @param {object[]} [options.critical]  observed critical boxes
 * @param {boolean} [options.observed]
 */
function computeRegions({ viewport, critical = [], observed = false } = {}) {
  const view = normalizeBox(viewport) || { x: 0, y: 0, width: 1280, height: 800 }
  const boxes = (critical || []).map(normalizeBox).filter(Boolean)

  if (observed && boxes.length) {
    const merged = mergeBoxes(boxes)
    return {
      viewport: view,
      observed: true,
      critical: merged.map((box) => ({ ...clipBox(box, view), source: 'observed' })),
      assumed: [],
      reason: null
    }
  }

  const assumed = [
    { id: 'input_region', label: 'input area', box: scaleBox(view, DEFAULT_INPUT_BAND) },
    { id: 'send_region', label: 'send button area', box: scaleBox(view, DEFAULT_SEND_BAND) },
    { id: 'body_region', label: 'core body centre', box: scaleBox(view, DEFAULT_CRITICAL_BAND) }
  ]
  return {
    viewport: view,
    observed: false,
    critical: mergedOrRaw(boxes, view).map((box) => ({ ...clipBox(box, view), source: 'observed' }))
      .concat(assumed.map((entry) => ({ ...entry.box, id: entry.id, label: entry.label, source: 'assumed' }))),
    assumed: assumed.map((entry) => ({ id: entry.id, label: entry.label, box: entry.box })),
    reason: observed
      ? 'no critical region was measured by the running UI; the band model stands in for it'
      : 'the UI was not observed before layout; the band model stands in for it'
  }
}

function mergedOrRaw(boxes, view) {
  if (!boxes.length) return []
  return mergeBoxes(boxes).map((box) => clipBox(box, view))
}

/** Union overlapping/adjacent boxes so overlap is measured against real blocks. */
function mergeBoxes(boxes, gap = 4) {
  const list = boxes.map((box) => ({ ...box }))
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]
        const b = list[j]
        const touches = a.x - gap <= b.x + b.width && b.x - gap <= a.x + a.width
          && a.y - gap <= b.y + b.height && b.y - gap <= a.y + a.height
        if (!touches) continue
        const right = Math.max(a.x + a.width, b.x + b.width)
        const bottom = Math.max(a.y + a.height, b.y + b.height)
        const x = Math.min(a.x, b.x)
        const y = Math.min(a.y, b.y)
        list.splice(j, 1)
        list[i] = { x, y, width: right - x, height: bottom - y }
        changed = true
        break outer
      }
    }
  }
  return list
}

/**
 * The safe region (任务 10): the viewport minus the critical regions, as a margin
 * band. Returned as a set of rectangles plus the bounding box that contains them,
 * because a character is placed in the *box* while decorations may use any band.
 */
function computeSafeRegion({ viewport, critical = [], margin = 0 } = {}) {
  const view = normalizeBox(viewport) || { x: 0, y: 0, width: 1280, height: 800 }
  const pad = Math.max(0, Number(margin) || 0)
  const inner = {
    x: view.x + pad,
    y: view.y + pad,
    width: Math.max(0, view.width - pad * 2),
    height: Math.max(0, view.height - pad * 2)
  }
  // A margin band: the ring between the viewport edge and the first critical box,
  // measured per side so a character can still live in a wide margin.
  const blocks = (critical || []).map(normalizeBox).filter(Boolean)
  const left = blocks.length ? Math.min(...blocks.map((box) => box.x)) - view.x : inner.width
  const top = blocks.length ? Math.min(...blocks.map((box) => box.y)) - view.y : inner.height
  const right = blocks.length ? (view.x + view.width) - Math.max(...blocks.map((box) => box.x + box.width)) : inner.width
  const bottom = blocks.length ? (view.y + view.height) - Math.max(...blocks.map((box) => box.y + box.height)) : inner.height

  const bands = {
    left: round(Math.max(0, left - pad)),
    right: round(Math.max(0, right - pad)),
    top: round(Math.max(0, top - pad)),
    bottom: round(Math.max(0, bottom - pad))
  }
  const regions = []
  if (bands.left >= 48) regions.push({ id: 'safe-left', x: round(view.x + pad), y: round(inner.y), width: bands.left, height: inner.height })
  if (bands.right >= 48) {
    regions.push({
      id: 'safe-right',
      x: round(view.x + view.width - pad - bands.right),
      y: round(inner.y),
      width: bands.right,
      height: inner.height
    })
  }
  if (bands.bottom >= 48) {
    regions.push({
      id: 'safe-bottom',
      x: round(inner.x),
      y: round(view.y + view.height - pad - bands.bottom),
      width: inner.width,
      height: bands.bottom
    })
  }
  if (bands.top >= 48) regions.push({ id: 'safe-top', x: round(inner.x), y: round(view.y + pad), width: inner.width, height: bands.top })

  return {
    viewport: view,
    margin: pad,
    inner,
    bands,
    regions,
    // The largest single free band, which is where a character goes if it can.
    primary: regions.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0] || {
      id: 'safe-full',
      x: round(inner.x),
      y: round(inner.y),
      width: inner.width,
      height: inner.height
    }
  }
}

/** Resolve an anchor into the box placement inside `area`. */
function placeAtAnchor(box, area, anchor, margin) {
  const gap = Math.max(0, Number(margin) || 0)
  const usable = {
    x: area.x + gap,
    y: area.y + gap,
    width: Math.max(0, area.width - gap * 2),
    height: Math.max(0, area.height - gap * 2)
  }
  const [vertical, horizontal] = String(anchor || 'bottom-right').split('-')
  let x = usable.x
  let y = usable.y
  if (horizontal === 'center') x = usable.x + (usable.width - box.width) / 2
  else if (horizontal === 'right') x = usable.x + usable.width - box.width
  if (vertical === 'center') y = usable.y + (usable.height - box.height) / 2
  else if (vertical === 'bottom') y = usable.y + usable.height - box.height
  return { x: round(x), y: round(y), width: round(box.width), height: round(box.height) }
}

/** Nudge a box back inside the viewport. */
function keepInside(box, viewport) {
  const x = clamp(box.x, viewport.x, Math.max(viewport.x, viewport.x + viewport.width - box.width))
  const y = clamp(box.y, viewport.y, Math.max(viewport.y, viewport.y + viewport.height - box.height))
  return { x: round(x), y: round(y), width: round(box.width), height: round(box.height) }
}

/**
 * Scale a box down until it clears the critical regions, or report that it cannot.
 *
 * The search is coarse on purpose (102 steps of 2%): the geometry is only ever a
 * placement hint for a visual layer, and a dense search would make the preview
 * cost scale with the number of regions.
 */
function fitToSafeRegion(box, { safe, critical, anchor, margin, maxOverlap }) {
  const candidates = []
  let scale = 1
  const area = safe.primary
  const baseWidth = Math.min(box.width, Math.max(24, area.width))
  const baseHeight = Math.min(box.height, Math.max(24, area.height))
  for (let step = 0; step <= 50; step += 1) {
    const factor = 1 - step * 0.02
    if (factor <= 0.1) break
    const candidate = placeAtAnchor(
      { width: baseWidth * factor, height: baseHeight * factor },
      area,
      anchor,
      margin
    )
    const clipped = keepInside(candidate, safe.viewport)
    const worst = critical.reduce((acc, region) => Math.max(acc, overlapRatio(clipped, region)), 0)
    candidates.push({ box: clipped, worst, factor: Number(factor.toFixed(3)) })
    if (worst <= maxOverlap) break
  }
  const best = candidates[candidates.length - 1]
  const anyClear = candidates.find((candidate) => candidate.worst <= maxOverlap)
  return {
    box: (anyClear || best).box,
    scale: (anyClear || best).factor,
    overlap: (anyClear || best).worst,
    cleared: Boolean(anyClear),
    tried: candidates.length
  }
}

/**
 * Lay the overlay out.
 *
 * @param {object} options
 * @param {object} options.viewport     the official view bounds (overlay-local coordinates)
 * @param {object} options.plan         the overlay plan (see assets/planner.js)
 * @param {object[]} [options.critical] observed critical regions
 * @param {boolean} [options.observed]
 * @param {number} [options.criticalOverlap] allowed critical overlap (see overlay-safety.js)
 */
function layout({ viewport, plan = {}, critical = [], observed = false, criticalOverlap = 0.08 } = {}) {
  const view = normalizeBox(viewport) || { x: 0, y: 0, width: 1280, height: 800 }
  const layoutPlan = plan.layout || {}
  const margin = Math.max(0, Number(layoutPlan.margin) || 0)
  const regions = computeRegions({ viewport: view, critical, observed })
  const safe = computeSafeRegion({ viewport: view, critical: regions.critical, margin })
  const mode = surfaceModule.LAYOUT_MODES.includes(layoutPlan.mode) ? layoutPlan.mode : 'corner'
  const anchor = surfaceModule.ANCHORS.includes(layoutPlan.anchor) ? layoutPlan.anchor : 'bottom-right'
  const components = plan.components || {}

  const placements = {}
  const adjustments = []

  // ---- background layer: covers the viewport, never placed ----
  placements.background = {
    mode: mode === 'background' ? 'background' : 'framed',
    box: { x: round(view.x), y: round(view.y), width: round(view.width), height: round(view.height) },
    coverage: 1,
    anchor: null
  }

  // ---- frame: the outer ring, present in every mode ----
  const frameWidth = Math.max(1, Math.min(12, round(Number(components.frame_glow?.width) || 2)))
  placements.frame = {
    mode: 'framed',
    box: { x: round(view.x), y: round(view.y), width: round(view.width), height: round(view.height) },
    width: frameWidth,
    opacity: clamp(components.frame_glow?.opacity ?? 0, 0, 1),
    // The frame ring is a border band: its coverage is measured from the band
    // width, not from a filled rectangle.
    ring: true,
    coverage: Number((1 - Math.max(0, (view.width - frameWidth * 2) * (view.height - frameWidth * 2)) / (view.width * view.height)).toFixed(4)),
    anchor: null
  }

  // ---- character ----
  const characterPlan = components.character_primary || {}
  if (characterPlan.enabled) {
    const size = characterPlan.size || {}
    const wanted = {
      width: Math.max(48, Number(size.width) || Math.round(view.width * 0.3)),
      height: Math.max(48, Number(size.height) || Math.round(view.height * 0.5))
    }
    const effectiveAnchor = mode === 'edge' ? edgeAnchor(anchor) : anchor
    const fitted = fitToSafeRegion(wanted, {
      safe,
      critical: regions.critical,
      anchor: effectiveAnchor,
      margin,
      maxOverlap: Math.max(0, Number(criticalOverlap) || 0.08)
    })
    if (fitted.scale < 1) {
      adjustments.push({
        component: 'character_primary',
        action: fitted.cleared ? 'downscaled' : 'downscaled-and-moved',
        from: wanted,
        to: fitted.box,
        reason: fitted.cleared
          ? `scaled to ${(fitted.scale * 100).toFixed(0)}% so the character clears the critical interaction regions`
          : 'scaled to the smallest allowed size and kept inside the viewport; the critical region could not be fully cleared'
      })
    }
    placements.character_primary = {
      mode: surfaceModule.LAYOUT_MODES.includes(mode) ? mode : 'corner',
      anchor: effectiveAnchor,
      box: fitted.box,
      scale: fitted.scale,
      opacity: clamp(characterPlan.opacity ?? 0.8, 0, 1),
      // `contain` keeps the figure's aspect ratio; the crop mode is honoured by
      // the preview and by the overlay renderer.
      crop: characterPlan.crop || 'contain',
      coverage: coverageRatio(fitted.box, view),
      critical_overlap: fitted.overlap,
      cleared: fitted.cleared,
      safe_region: { x: round(safe.primary.x), y: round(safe.primary.y), width: round(safe.primary.width), height: round(safe.primary.height) }
    }
    if (!fitted.cleared) {
      adjustments.push({
        component: 'character_primary',
        action: 'flagged',
        reason: `critical overlap ${fitted.overlap} exceeds the ${criticalOverlap} ceiling even at the smallest size`
      })
    }
  } else {
    placements.character_primary = { mode, anchor: null, box: null, opacity: 0, coverage: 0, critical_overlap: 0, cleared: true, enabled: false }
  }

  const secondary = components.character_secondary || {}
  placements.character_secondary = secondary.enabled
    ? {
        mode,
        anchor: oppositeAnchor(anchor),
        box: fitToSafeRegion(
          { width: Math.round(view.width * 0.18), height: Math.round(view.height * 0.3) },
          { safe, critical: regions.critical, anchor: oppositeAnchor(anchor), margin, maxOverlap: Number(criticalOverlap) || 0.08 }
        ).box,
        opacity: clamp(secondary.opacity ?? 0.6, 0, 1),
        enabled: true
      }
    : { mode, anchor: null, box: null, opacity: 0, coverage: 0, critical_overlap: 0, cleared: true, enabled: false }

  // ---- decorations ----
  const decoration = components.corner_decoration || {}
  placements.corner_decoration = decoration.enabled
    ? {
        mode: 'corner',
        anchor: decoration.anchor || anchor,
        box: placeAtAnchor(
          { width: Math.round(view.width * 0.18), height: Math.round(view.height * 0.2) },
          safe.primary,
          decoration.anchor || anchor,
          margin
        ),
        opacity: clamp(decoration.opacity ?? 0.4, 0, 1),
        scale: Number(decoration.scale) || 1,
        enabled: true
      }
    : { mode: 'corner', anchor: null, box: null, opacity: 0, enabled: false }

  // ---- full-intensity decorative layers keep their box but are measured too ----
  placements.skin = {
    mode: 'framed',
    box: { x: round(view.x), y: round(view.y), width: round(view.width), height: round(view.height) },
    opacity: clamp(components.skin?.opacity ?? 0, 0, 1),
    inset: Number(components.skin?.inset) || 0,
    enabled: components.skin?.enabled !== false
  }
  placements.texture = {
    mode: 'background',
    box: { x: round(view.x), y: round(view.y), width: round(view.width), height: round(view.height) },
    opacity: clamp(components.texture?.opacity ?? 0, 0, 1),
    tile: true,
    enabled: components.texture?.enabled === true
  }
  placements.vignette = { mode: 'framed', opacity: clamp(components.vignette?.opacity ?? 0, 0, 1), size: components.vignette?.size ?? 0.78, enabled: components.vignette?.enabled === true }
  placements.scanline = { mode: 'background', opacity: clamp(components.scanline?.opacity ?? 0, 0, 1), spacing: components.scanline?.spacing ?? 4, enabled: components.scanline?.enabled === true }
  placements.global_tint = { mode: 'background', color: components.global_tint?.color || null, opacity: clamp(components.global_tint?.opacity ?? 0, 0, 1), enabled: components.global_tint?.enabled === true }
  placements.gradient = { mode: 'background', angle: components.gradient?.angle ?? 160, opacity: clamp(components.gradient?.opacity ?? 0, 0, 1), enabled: components.gradient?.enabled === true }

  return {
    version: 1,
    mode,
    anchor,
    viewport: view,
    follow: 'official_view_bounds',
    margin,
    safe_region: {
      bands: safe.bands,
      primary: { x: round(safe.primary.x), y: round(safe.primary.y), width: round(safe.primary.width), height: round(safe.primary.height) },
      regions: safe.regions
    },
    critical_regions: regions.critical,
    critical_assumed: regions.assumed,
    observed: regions.observed,
    degraded: !regions.observed,
    reason: regions.reason,
    placements,
    adjustments,
    // Re-layout triggers, recorded so the runtime and the acceptance run can check
    // that a resize actually re-runs the engine (任务 3 / 任务 9).
    triggers: ['resize', 'maximize', 'restore', 'dock-toggle', 'view-bounds-change']
  }
}

/** `edge` mode pulls a corner anchor onto the nearest edge centre. */
function edgeAnchor(anchor) {
  const [vertical, horizontal] = String(anchor || 'bottom-right').split('-')
  if (horizontal === 'center') return `${vertical === 'top' ? 'top' : 'bottom'}-center`
  return vertical === 'top' ? 'top-center' : 'bottom-center'
}

function oppositeAnchor(anchor) {
  const map = {
    'top-left': 'bottom-right',
    'top-center': 'bottom-center',
    'top-right': 'bottom-left',
    'center-left': 'center-right',
    'center': 'center',
    'center-right': 'center-left',
    'bottom-left': 'top-right',
    'bottom-center': 'top-center',
    'bottom-right': 'top-left'
  }
  return map[anchor] || 'top-left'
}

module.exports = {
  DEFAULT_CRITICAL_BAND,
  DEFAULT_INPUT_BAND,
  DEFAULT_SEND_BAND,
  normalizeBox,
  intersectionArea,
  overlapRatio,
  coverageRatio,
  clipBox,
  mergeBoxes,
  computeRegions,
  computeSafeRegion,
  placeAtAnchor,
  keepInside,
  fitToSafeRegion,
  layout,
  edgeAnchor,
  oppositeAnchor
}
