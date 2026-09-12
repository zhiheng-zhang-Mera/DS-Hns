'use strict'

/**
 * Preview Renderer + Preview Validator.
 *
 * Preview-first is a hard rule (engineering spec §1.2 / §10.1): a package may
 * only be compiled after the user has seen the real UI wearing the candidate
 * design. There is no "describe a theme and install it" path.
 *
 * The preview here is *the live dock itself*: the runtime binds the candidate
 * tokens as CSS custom properties on the dock renderer and toggles a preview
 * flag, so what the user judges is exactly what they will get — not a mock-up
 * that can disagree with the real surface.
 *
 * The validator then answers the §10.2 checklist against that same rendering:
 *   readability / contrast / state distinction / critical-control visibility /
 *   background not covering content / persona not covering interaction /
 *   animation intensity within the allowed envelope.
 */
const contract = require('./contract')
const color = require('./color')
const validator = require('./validator')

/** Human-readable → CSS variable declaration block for a resolved theme. */
function toCssVariables(theme) {
  const tokens = theme.tokens || {}
  const lines = []
  for (const tokenName of contract.TOKEN_NAMES) {
    const definition = contract.TOKENS[tokenName]
    const value = tokens[tokenName]
    if (value === undefined || value === null || value === '') continue
    lines.push(`${definition.css}: ${value};`)
  }
  return lines.join('\n')
}

/** Payload the dock renderer consumes to paint a theme. */
function toRendererPayload(theme, { preview = false, draftId = null } = {}) {
  const animation = validator.normalizeAnimation(theme.components?.animation)
  const persona = theme.persona || { enabled: false }
  const slots = (theme.components?.slots) || {}
  return {
    id: theme.id,
    name: theme.manifest?.name || theme.id,
    preview,
    draftId,
    css: toCssVariables(theme),
    tokens: { ...theme.tokens },
    slots: { ...slots },
    animation,
    persona: {
      enabled: Boolean(persona.enabled),
      prominence: Number(persona.prominence) || 0,
      character: persona.character || null,
      decorationOpacity: Number(slots['hns.persona.decoration']?.opacity) || 0,
      bannerOpacity: Number(slots['hns.persona.banner']?.opacity) || 0,
      widgetOpacity: Number(slots['hns.operator.widget']?.opacity) || 0,
      bannerAsset: slots['hns.persona.banner']?.asset || 'none',
      avatarAsset: slots['hns.operator.avatar']?.asset || 'none'
    },
    officialPalette: theme.manifest?.official_palette === 'light' ? 'light' : 'dark'
  }
}

/**
 * Preview checklist (engineering spec §10.2).
 *
 * @param {object} options
 * @param {object} options.theme
 * @param {object} [options.regions]   live dock region map (slotId -> bbox)
 * @param {object} [options.viewport]  { width, height } of the dock renderer
 * @param {object} [options.snapshot]  latest UI snapshot package
 * @param {object} [options.load]      current system load snapshot
 */
function validatePreview({ theme, regions = {}, viewport = null, snapshot = null, load = null } = {}) {
  const checks = []
  const add = (id, label, ok, detail, severity = 'error') => {
    checks.push({ id, label, ok: Boolean(ok), detail: detail || null, severity })
  }
  const tokens = theme?.tokens || {}
  const slots = theme?.components?.slots || {}

  // ---- 1. readability / contrast (shared with the package validator) ----
  const readabilityIssues = validator.validateReadability(tokens)
  const contrastIssues = readabilityIssues.filter((issue) => issue.code.startsWith('contrast'))
  const stateIssues = readabilityIssues.filter((issue) => issue.code.startsWith('state'))
  add(
    'contrast',
    'text contrast',
    contrastIssues.length === 0,
    contrastIssues.length ? contrastIssues.map((issue) => issue.message).join('; ') : 'all validated pairs meet their requirement'
  )
  add(
    'state_distinction',
    'HNS state distinction',
    stateIssues.length === 0,
    stateIssues.length ? stateIssues.map((issue) => issue.message).join('; ') : `${contract.HNS_STATES.length} canonical states remain separable`
  )

  // ---- 2. token completeness ----
  const missing = contract.TOKEN_NAMES.filter((name) => {
    const value = tokens[name]
    return value === undefined || value === null || value === ''
  })
  add('token_completeness', 'token completeness', missing.length === 0, missing.length ? `missing: ${missing.slice(0, 8).join(', ')}` : 'every Theme API token resolves')

  // ---- 3. critical controls visible & unoccluded ----
  const protectedRegions = (snapshot && snapshot.protected_regions) || []
  const critical = protectedRegions.filter((region) => region.critical)
  const unmeasured = []
  const occluded = []
  for (const region of critical) {
    const box = region.boundingBox || regions[region.id]
    if (!box) {
      unmeasured.push(region.id)
      continue
    }
    if (!viewport) continue
    const outside = box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height
    if (outside) occluded.push(region.id)
  }
  add(
    'critical_controls',
    'critical controls visible',
    occluded.length === 0,
    occluded.length
      ? `critical regions outside the viewport: ${occluded.join(', ')}`
      : critical.length === 0
        ? 'no measured critical region (structure-only snapshot)'
        : `${critical.length} critical regions measured; none clipped`
  )
  add(
    'critical_controls_present',
    'critical regions present',
    critical.length === 0 || unmeasured.length === 0,
    critical.length === 0
      ? 'snapshot carried no critical region data'
      : unmeasured.length === 0
        ? `${critical.length}/${critical.length} critical regions located in the live dock`
        // Structure-only snapshot: the dock renderer reported no geometry, so the
        // checklist records this as *unverified* rather than failed. A theme is
        // never rejected for a capture that never happened.
        : `${unmeasured.length}/${critical.length} critical regions not measured by the live dock`,
    'warning'
  )

  // ---- 4. UI bounds ----
  const viewportChecks = []
  for (const [slotId, box] of Object.entries(regions)) {
    if (!box || !viewport) continue
    if (box.width > viewport.width || box.height > viewport.height) {
      viewportChecks.push(`${slotId} exceeds the dock viewport`)
    }
  }
  add('ui_bounds', 'UI bounds respected', viewportChecks.length === 0, viewportChecks.length ? viewportChecks.join('; ') : 'no themed element exceeds the viewport')

  // ---- 5. background does not swallow the content ----
  const panelOpacity = Number(tokens['opacity.panel'])
  const opacityOk = !Number.isFinite(panelOpacity) || (panelOpacity >= 0.72 && panelOpacity <= 1)
  add(
    'panel_opacity',
    'panel opacity keeps content readable',
    opacityOk,
    opacityOk ? `panel opacity ${Number.isFinite(panelOpacity) ? panelOpacity : 'default'}` : `panel opacity ${panelOpacity} would let the backdrop show through the content`
  )

  const labelVsWallpaper = color.contrastRatio(tokens['color.label.primary'], tokens['color.bg.layer1'])
  add(
    'wallpaper_layering',
    'background does not cover content',
    labelVsWallpaper === null || labelVsWallpaper >= 4.5,
    labelVsWallpaper === null ? 'unmeasurable' : `content layer contrast ${labelVsWallpaper.toFixed(2)}:1`
  )

  // ---- 6. persona must not cover interaction regions ----
  const persona = theme?.persona || { enabled: false }
  const personaIssues = []
  if (persona.enabled) {
    if (Number(persona.prominence) > 0.4) personaIssues.push(`prominence ${persona.prominence} exceeds the HNS limit 0.4`)
    if (persona.overlay_main === true) personaIssues.push('persona declares a main-UI overlay, which HNS forbids')
    if (Array.isArray(persona.occludes) && persona.occludes.length) {
      personaIssues.push(`persona declares occlusion of ${persona.occludes.join(', ')}`)
    }
    const widgetSlot = slots['hns.operator.widget'] || {}
    const position = String(widgetSlot.position || '')
    if (/center|main|queue/.test(position)) {
      personaIssues.push(`persona widget position "${position}" is not an allowed corner position`)
    }
  }
  add(
    'persona_placement',
    'persona does not cover interaction',
    personaIssues.length === 0,
    personaIssues.length ? personaIssues.join('; ') : persona.enabled ? 'persona confined to a corner widget' : 'persona disabled'
  )

  // ---- 7. animation envelope ----
  const declaredAnimation = theme?.components?.animation || { type: 'none', intensity: 0 }
  const normalized = validator.normalizeAnimation(declaredAnimation)
  const maxIntensity = contract.ANIMATION_MAX_INTENSITY[normalized.type] ?? 0
  const animationOk = normalized.intensity <= maxIntensity + 1e-9
  add(
    'animation_envelope',
    'animation within allowed intensity',
    animationOk,
    animationOk
      ? `${normalized.type} @ ${normalized.intensity} (max ${maxIntensity})`
      : `${normalized.type} @ ${normalized.intensity} exceeds max ${maxIntensity}`
  )

  // ---- 8. performance / load degradation (HNS specialization §6/§7) ----
  const highLoad = Boolean(load && (load.highLoad || load.degraded))
  const heavy = normalized.type !== 'none' && normalized.intensity > 0.2
  add(
    'load_adaptation',
    'load-aware effect budget',
    !(highLoad && heavy) || Boolean(theme?.components?.degraded),
    highLoad && heavy
      ? 'current load is high; heavy effects will be down-graded at runtime'
      : 'effect budget is compatible with the current load',
    'warning'
  )

  const failed = checks.filter((check) => !check.ok && check.severity !== 'warning')
  const warnings = checks.filter((check) => !check.ok && check.severity === 'warning')
  return {
    ok: failed.length === 0,
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    checks,
    failures: failed,
    warnings
  }
}

/** Slot styles that must never be generated for a protected/structural slot. */
function assertNoStructuralWrites(theme) {
  const slots = theme?.components?.slots || {}
  const violations = []
  for (const slotId of Object.keys(slots)) {
    const definition = contract.SLOTS[slotId]
    if (!definition) {
      violations.push({ slot: slotId, reason: 'not exposed by the Theme API' })
      continue
    }
    if (definition.permission === contract.PERMISSION.STRUCTURAL) {
      violations.push({ slot: slotId, reason: 'STRUCTURAL slots are never written by the theme generator' })
    }
  }
  return violations
}

module.exports = {
  toCssVariables,
  toRendererPayload,
  validatePreview,
  assertNoStructuralWrites
}
