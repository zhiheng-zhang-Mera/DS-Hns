'use strict'

/**
 * Computer Use Runtime: target resolution and revalidation (plan §7, §10).
 *
 * A target is *how to find the thing*, never "x=821, y=440". The resolution
 * ladder is fixed and documented:
 *
 *   DOM selector  →  accessibility node  →  semantic element  →  bounding box  →  visual point
 *
 * Coordinates are the last rung and are labelled as such in the log, because a
 * raw coordinate is the one identifier that silently rots when the UI moves.
 *
 * `revalidate()` is the other half of the same idea (plan §10): the coordinate a
 * target resolved to once is not trusted at action time. The caller re-resolves,
 * compares the two boxes, and either acts, refreshes the coordinate or declares
 * the target stale and goes back to observing.
 */

const { TARGET_MOVEMENT } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')

/** The ladder, cheapest and most stable first (plan §7). */
const TARGET_KINDS = Object.freeze([
  { kind: 'selector', rank: 1, label: 'DOM selector' },
  { kind: 'accessibility', rank: 2, label: 'accessibility node' },
  { kind: 'semantic', rank: 3, label: 'semantic element' },
  // A window is a structured identifier too (title / handle / process), and it
  // is what FOCUS / SWITCH_WINDOW / CLOSE_WINDOW address (plan §27).
  { kind: 'window', rank: 4, label: 'window' },
  { kind: 'bbox', rank: 5, label: 'bounding box' },
  // A visual description (paint colour or template) is how a canvas, a WebGL
  // surface or a custom-drawn control is addressed (plan §4/§48).
  { kind: 'visual', rank: 6, label: 'visual target' },
  { kind: 'point', rank: 7, label: 'visual coordinate' }
])

const KIND_BY_NAME = new Map(TARGET_KINDS.map((entry) => [entry.kind, entry]))

function invalid(message, details) {
  return new ComputerUseError(CODES.TARGET_INVALID, message, details)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Accepts the many shapes an author writes (`"#save"`, `{ selector: '#save' }`,
 * `{ accessibility: { role, name } }`, `{ point: { x, y } }`, `{ text: 'Save' }`)
 * and produces one normalized target.
 */
function normalizeTarget(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) throw invalid('a target string may not be empty')
    if (looksLikeSelector(trimmed)) return build({ selector: trimmed })
    return build({ semantic: { text: trimmed } })
  }
  if (Array.isArray(input)) {
    // An ordered list of candidate targets *is* the ladder written out by hand.
    const candidates = input.map((entry) => normalizeTarget(entry))
    return build({ candidates })
  }
  if (!isPlainObject(input)) throw invalid('a target must be a string, object or array of candidates', { received: typeof input })

  const raw = input
  const target = {}
  if (raw.selector) target.selector = String(raw.selector)
  if (raw.dom_selector) target.selector = String(raw.dom_selector)

  const accessibility = raw.accessibility || raw.ax || (raw.role || raw.automation_id || raw.automationId || raw.control_type ? raw : null)
  if (accessibility) {
    target.accessibility = compact({
      role: accessibility.role ? String(accessibility.role) : undefined,
      name: accessibility.name ? String(accessibility.name) : undefined,
      controlType: accessibility.control_type || accessibility.controlType ? String(accessibility.control_type || accessibility.controlType) : undefined,
      automationId: accessibility.automation_id || accessibility.automationId ? String(accessibility.automation_id || accessibility.automationId) : undefined,
      className: accessibility.class_name || accessibility.className ? String(accessibility.class_name || accessibility.className) : undefined,
      index: Number.isInteger(accessibility.index) ? accessibility.index : undefined,
      exact: accessibility.exact === undefined ? undefined : Boolean(accessibility.exact)
    })
  }

  const semanticSource = raw.semantic || (raw.text || raw.label || raw.placeholder ? raw : null)
  if (semanticSource) {
    target.semantic = compact({
      text: semanticSource.text ? String(semanticSource.text) : undefined,
      label: semanticSource.label ? String(semanticSource.label) : undefined,
      placeholder: semanticSource.placeholder ? String(semanticSource.placeholder) : undefined,
      role: semanticSource.role ? String(semanticSource.role) : undefined,
      name: semanticSource.name ? String(semanticSource.name) : undefined,
      inside: semanticSource.inside ? String(semanticSource.inside) : undefined
    })
  }

  if (raw.bbox || raw.box || raw.rect) target.bbox = normalizeRect(raw.bbox || raw.box || raw.rect)
  if (raw.visual || raw.paint || raw.template) {
    const visual = raw.visual || { paint: raw.paint, template: raw.template, templatePath: raw.template_path }
    target.visual = compact({
      paint: visual.paint || visual.color
        ? compact({
            color: visual.paint ? (visual.paint.color || visual.paint) : visual.color,
            width: visual.paint && visual.paint.width ? Number(visual.paint.width) : undefined,
            height: visual.paint && visual.paint.height ? Number(visual.paint.height) : undefined,
            tolerance: visual.paint && visual.paint.tolerance !== undefined ? Number(visual.paint.tolerance) : undefined
          })
        : undefined,
      templatePath: visual.templatePath || visual.template_path ? String(visual.templatePath || visual.template_path) : undefined,
      template: visual.template && !visual.templatePath ? visual.template : undefined,
      threshold: visual.threshold !== undefined ? Number(visual.threshold) : undefined,
      search: visual.search || undefined,
      level: Number.isInteger(visual.level) ? visual.level : undefined
    })
  }
  if (raw.point || raw.coordinate || raw.coordinates) target.point = normalizePoint(raw.point || raw.coordinate || raw.coordinates)
  if (raw.x !== undefined && raw.y !== undefined) target.point = normalizePoint({ x: raw.x, y: raw.y })
  if (raw.window) target.window = normalizeWindowRef(raw.window)
  if (raw.page || raw.tab || raw.tabId) target.page = String(raw.page || raw.tab || raw.tabId)
  if (raw.ref) target.ref = String(raw.ref)
  if (Array.isArray(raw.candidates)) target.candidates = raw.candidates.map((entry) => normalizeTarget(entry))
  if (raw.description) target.description = String(raw.description)

  return build(target)
}

function build(target) {
  const kinds = targetKinds(target)
  if (!kinds.length) {
    throw invalid('a target must carry at least one of: selector, accessibility, semantic, window, bbox, point, ref', { received: target })
  }
  return {
    ...target,
    kinds,
    // The declared rank is the best (lowest) rank present, which is what the
    // execution log records as "how this target was addressed".
    rank: Math.min(...kinds.map((kind) => KIND_BY_NAME.get(kind).rank)),
    primaryKind: kinds[0]
  }
}

/** Every addressing mode present on the target, best first. */
function targetKinds(target) {
  const kinds = []
  if (target.ref) kinds.push('accessibility')
  if (target.selector) kinds.push('selector')
  if (target.accessibility) kinds.push('accessibility')
  if (target.semantic) kinds.push('semantic')
  // A window is a *locator context* when another rung is present ("this point
  // inside that window", "this painted control in that window"); it is only a
  // standalone target when it is all the target says.
  const specific = target.selector || target.accessibility || target.semantic || target.visual || target.bbox || target.point || target.ref
  if (target.window && !specific) kinds.push('window')
  if (target.bbox) kinds.push('bbox')
  if (target.visual) kinds.push('visual')
  if (target.point) kinds.push('point')
  if (target.candidates && target.candidates.length) for (const candidate of target.candidates) for (const kind of candidate.kinds) if (!kinds.includes(kind)) kinds.push(kind)
  return [...new Set(kinds)].sort((a, b) => KIND_BY_NAME.get(a).rank - KIND_BY_NAME.get(b).rank)
}

function normalizeRect(rect) {
  if (!isPlainObject(rect)) throw invalid('bbox must be an object with x, y, width, height', { received: typeof rect })
  const x = Number(rect.x ?? rect.left)
  const y = Number(rect.y ?? rect.top)
  const width = Number(rect.width ?? rect.w)
  const height = Number(rect.height ?? rect.h)
  if (![x, y, width, height].every(Number.isFinite)) throw invalid('bbox needs finite x, y, width and height', { received: rect })
  if (width <= 0 || height <= 0) throw invalid('bbox must have a positive width and height', { received: rect })
  return { x, y, width, height }
}

function normalizePoint(point) {
  if (!isPlainObject(point)) throw invalid('point must be an object with x and y', { received: typeof point })
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw invalid('point needs finite x and y', { received: point })
  return { x, y }
}

function normalizeWindowRef(window) {
  if (typeof window === 'string') return { title: window }
  if (!isPlainObject(window)) throw invalid('window must be a string or an object', { received: typeof window })
  return compact({
    title: window.title ? String(window.title) : undefined,
    handle: window.handle !== undefined ? String(window.handle) : undefined,
    processId: Number.isInteger(window.processId) ? window.processId : Number.isInteger(window.pid) ? window.pid : undefined,
    className: window.className ? String(window.className) : undefined,
    process: window.process ? String(window.process) : undefined
  })
}

function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value
  return out
}

function looksLikeSelector(text) {
  return /^[#.[][^\s]*$/.test(text) || /^[a-z][a-z0-9-]*(\[[^\]]*\])?$/.test(text) || text.includes('>') || text.includes('#') && !text.includes(' ')
}

/** A short label for the execution log. Never contains a coordinate unless the coordinate *is* the target. */
function describeTarget(target) {
  if (!target) return '(no target)'
  if (target.selector) return `selector:${target.selector}`
  if (target.accessibility) {
    const ax = target.accessibility
    return `ax:${[ax.role, ax.name, ax.automationId].filter(Boolean).join('/') || '(any)'}`
  }
  if (target.semantic) return `semantic:${target.semantic.text || target.semantic.label || target.semantic.name || target.semantic.placeholder}`
  if (target.window) return `window:${target.window.title || target.window.handle || target.window.process || '(any)'}`
  if (target.visual) return `visual:${target.visual.paint ? JSON.stringify(target.visual.paint.color) : 'template'}`
  if (target.bbox) return `bbox:${target.bbox.x},${target.bbox.y},${target.bbox.width}x${target.bbox.height}`
  if (target.point) return `point:${target.point.x},${target.point.y}`
  return '(unresolved)'
}

/**
 * Walks the ladder and returns the first rung that produced a unique hit.
 *
 * `resolvers` are supplied by the controllers, so this module stays pure:
 *   { selector(selector) -> ElementDescriptor[],
 *     accessibility(query) -> AxNode[],
 *     semantic(query) -> ElementDescriptor[],
 *     bbox(rect) -> ElementDescriptor[] }
 * A resolver that is missing or throws degrades the ladder instead of failing it
 * (plan §37) — the next rung gets its turn and the reason is recorded.
 */
function resolveTarget(target, world, resolvers = {}) {
  if (!target) return { ok: false, resolved: null, attempts: [], error: invalid('no target to resolve') }
  const attempts = []

  const candidates = target.candidates && target.candidates.length ? [...target.candidates, target] : [target]
  for (const candidate of candidates) {
    for (const kind of candidate.kinds) {
      const attempt = { kind, ok: false, count: 0, reason: null }
      attempts.push(attempt)
      try {
        const hits = resolveKind(candidate, kind, world, resolvers)
        attempt.count = Array.isArray(hits) ? hits.length : hits ? 1 : 0
        const chosen = Array.isArray(hits) ? hits[0] : hits
        if (chosen) {
          attempt.ok = true
          return {
            ok: true,
            kind,
            resolved: buildResolved(candidate, kind, chosen, attempt.count),
            attempts,
            // Plan §7: an explicit coordinate target is labelled, so a run can be
            // audited for "did this really need to be a pixel click?".
            coordinateFallback: kind === 'point' || kind === 'bbox'
          }
        }
        attempt.reason = 'no match'
      } catch (error) {
        attempt.reason = error && error.code ? error.code : String(error && error.message ? error.message : error)
      }
    }
  }
  return {
    ok: false,
    resolved: null,
    attempts,
    error: new ComputerUseError(CODES.TARGET_NOT_FOUND, `target not found: ${describeTarget(target)}`, {
      target: describeTarget(target),
      attempts: attempts.map((entry) => ({ kind: entry.kind, reason: entry.reason }))
    })
  }
}

function resolveKind(target, kind, world, resolvers) {
  const state = world || {}
  switch (kind) {
    case 'selector': {
      if (typeof resolvers.selector === 'function') return firstHits(resolvers.selector(target.selector))
      return matchInWorld(state, (element) => element.selector === target.selector || element.id === target.selector || element.attributes?.id === target.selector)
    }
    case 'accessibility': {
      if (typeof resolvers.accessibility === 'function') {
        const query = target.accessibility || (target.ref ? { ref: target.ref } : null)
        if (!query) return null
        return firstHits(resolvers.accessibility(query))
      }
      if (target.ref) {
        const node = (state.ax || []).find((entry) => entry.ref === target.ref)
        return node ? [node] : []
      }
      return matchAx(state, target.accessibility)
    }
    case 'semantic': {
      if (typeof resolvers.semantic === 'function') return firstHits(resolvers.semantic(target.semantic))
      return matchInWorld(state, (element) => matchesSemantic(element, target.semantic))
    }
    case 'bbox': {
      if (typeof resolvers.bbox === 'function') return firstHits(resolvers.bbox(target.bbox))
      const cx = target.bbox.x + target.bbox.width / 2
      const cy = target.bbox.y + target.bbox.height / 2
      return matchInWorld(state, (element) => element.bbox && containsPoint(element.bbox, cx, cy))
    }
    case 'window': {
      if (typeof resolvers.window === 'function') return firstHits(resolvers.window(target.window))
      return (state.windows || []).filter((window) => matchesWindow(window, target.window))
    }
    case 'visual': {
      // Vision is never resolved from the world state: it needs a capture, which
      // the executor performs through the vision controller (plan §4/§48).
      if (typeof resolvers.visual === 'function') return firstHits(resolvers.visual(target.visual))
      return null
    }
    case 'point': {
      const inBounds = matchInWorld(state, (element) => element.bbox && containsPoint(element.bbox, target.point.x, target.point.y))
      if (inBounds.length) return inBounds
      return [{ ref: null, kind: 'point', bbox: { x: target.point.x, y: target.point.y, width: 1, height: 1 }, point: target.point, synthetic: true }]
    }
    default:
      return null
  }
}

function firstHits(hits) {
  if (!hits) return []
  return Array.isArray(hits) ? hits : [hits]
}

function matchInWorld(world, predicate) {
  const pool = [...(world.controls || []), ...(world.visibleTargets || [])]
  return pool.filter((element) => element && predicate(element))
}

function matchAx(world, query) {
  if (!query) return []
  // An accessibility query is answered from the automation tree when there is
  // one, and from the page's own controls otherwise: both carry role/name, and
  // for a web page the DOM element *is* the accessible object.
  const pool = [...(world.ax || []), ...(world.controls || [])]
  return pool.filter((node) => matchesAccessibility(node, query))
}

function matchesAccessibility(node, query) {
  if (!node) return false
  const exact = query.exact === true
  const same = (actual, expected) => {
    if (expected === undefined || expected === null) return true
    const a = String(actual === undefined || actual === null ? '' : actual).toLowerCase()
    const b = String(expected).toLowerCase()
    return exact ? a === b : a.includes(b)
  }
  if (!same(node.role, query.role) && !same(node.controlType, query.role)) return false
  if (!same(node.controlType, query.controlType)) return false
  if (!same(node.name, query.name)) return false
  if (query.automationId !== undefined && String(node.automationId || '') !== String(query.automationId)) return false
  if (!same(node.className, query.className)) return false
  return true
}

function matchesSemantic(element, query) {
  if (!element || !query) return false
  const text = [element.name, element.text, element.value, element.attributes?.placeholder, element.attributes?.label].filter(Boolean).join(' ').toLowerCase()
  if (query.text && !text.includes(String(query.text).toLowerCase())) return false
  if (query.label && !text.includes(String(query.label).toLowerCase())) return false
  if (query.placeholder && !text.includes(String(query.placeholder).toLowerCase())) return false
  if (query.name && !text.includes(String(query.name).toLowerCase())) return false
  if (query.role && String(element.role || '').toLowerCase() !== String(query.role).toLowerCase()) return false
  return true
}

function containsPoint(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/** Window matching by handle, process or title substring (plan §27). */
function matchesWindow(window, query) {
  if (!window || !query) return false
  if (query.handle !== undefined && String(window.handle) !== String(query.handle)) return false
  if (query.processId !== undefined && Number(window.processId) !== Number(query.processId)) return false
  if (query.className && String(window.className || '').toLowerCase() !== String(query.className).toLowerCase()) return false
  if (query.title && !String(window.title || '').toLowerCase().includes(String(query.title).toLowerCase())) return false
  return true
}

function buildResolved(target, kind, hit, count) {
  const bbox = hit.bbox || (hit.bounds ? hit.bounds : null)
  return {
    kind,
    ref: hit.ref || null,
    handle: hit.handle || null,
    bbox: bbox ? { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height } : null,
    point: bbox ? centerOf(bbox) : hit.point || null,
    role: hit.role || null,
    name: hit.name || null,
    selector: hit.selector || target.selector || null,
    disabled: hit.disabled === undefined ? hit.enabled === undefined ? null : !hit.enabled : Boolean(hit.disabled),
    visible: hit.visible === undefined ? (hit.offscreen === undefined ? null : !hit.offscreen) : Boolean(hit.visible),
    element: hit,
    candidates: count,
    coordinateFallback: kind === 'point' || kind === 'bbox',
    resolvedAt: null
  }
}

function centerOf(rect) {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

/**
 * Plan §10 — compare where a target was with where it is now.
 *
 *   movement < 3 px     -> 'stable'  : act where it was
 *   3 px .. 10 px       -> 'updated' : act on the refreshed coordinate
 *   movement > 10 px    -> 'stale'   : re-observe, do not click
 *   target gone         -> 'missing' : re-observe
 */
function revalidate(previous, current, thresholds = TARGET_MOVEMENT) {
  const stablePx = Number.isFinite(Number(thresholds.stablePx)) ? Number(thresholds.stablePx) : TARGET_MOVEMENT.stablePx
  const updatePx = Number.isFinite(Number(thresholds.updatePx)) ? Number(thresholds.updatePx) : TARGET_MOVEMENT.updatePx
  if (!previous) return { verdict: 'unknown', movement: null, reason: 'no previous resolution to compare with', current: current || null }
  if (!current) return { verdict: 'missing', movement: null, reason: 'target is no longer present', previous }

  const sameIdentity = Boolean(previous.ref) && Boolean(current.ref) && previous.ref === current.ref
  const previousPoint = previous.point || (previous.bbox ? centerOf(previous.bbox) : null)
  const currentPoint = current.point || (current.bbox ? centerOf(current.bbox) : null)
  if (!previousPoint || !currentPoint) {
    return {
      verdict: sameIdentity ? 'stable' : 'unknown',
      movement: null,
      reason: sameIdentity ? 'same node identity, no geometry to compare' : 'no geometry available',
      current
    }
  }
  const movement = distance(previousPoint, currentPoint)
  if (!sameIdentity && movement > updatePx) {
    return { verdict: 'stale', movement, reason: `target moved ${movement}px and is a different node`, previous, current }
  }
  if (movement < stablePx) return { verdict: 'stable', movement, current }
  if (movement <= updatePx) return { verdict: 'updated', movement, reason: `target moved ${movement}px - using the refreshed coordinate`, current }
  return { verdict: 'stale', movement, reason: `target moved ${movement}px - re-observe before acting`, previous, current }
}

function distance(a, b) {
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100
}

module.exports = {
  TARGET_KINDS,
  normalizeTarget,
  targetKinds,
  describeTarget,
  resolveTarget,
  revalidate,
  distance,
  centerOf,
  containsPoint,
  matchesSemantic,
  matchesAccessibility,
  matchesWindow
}
