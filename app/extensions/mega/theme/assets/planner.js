'use strict'

/**
 * Asset Planner (Update-Plan/General-Theme.md 任务 4 / 7 / 8).
 *
 * `planner` decides *what* to generate — and it is the only module that decides.
 * The generator never chooses its own subject, the builder never invents an asset,
 * and the image model is never asked for anything that is not in the plan.
 *
 * Three plans are produced together because they constrain each other:
 *
 *   surface_plan  which of the four surfaces this design writes, and with what
 *   overlay_plan  which overlay features are on, and how strongly
 *   asset_plan    one entry per asset, each naming the surface it targets, the
 *                 exact dimensions, whether it must be transparent, where it is
 *                 placed, how prominent it is, the safe region it must respect and
 *                 the prompt the generator receives.
 *
 * Planning is *observation-driven* (任务 8): the caller passes the UI observation,
 * and placement is derived from the real official view bounds and the real critical
 * interaction regions. With no observation the plan says so (`degraded: true`) and
 * falls back to conservative fractions of the viewport rather than pretending to
 * know the layout.
 *
 * Nothing here can plan an asset onto `official_renderer`: the surface table's
 * asset kinds are the only source of valid (surface, kind) pairs.
 */
const assets = require('../asset-factory')
const surfaceModule = require('../surface')
const contract = require('../contract')
const generator = require('./generator')

/** Placement of a character for each framing, as a fraction of the target box. */
const FRAMING_FRACTION = Object.freeze({
  avatar: { width: 0.14, height: 0.22 },
  bust: { width: 0.24, height: 0.34 },
  half_body: { width: 0.30, height: 0.52 },
  full_body: { width: 0.30, height: 0.76 },
  silhouette: { width: 0.34, height: 0.68 }
})

/** Fallback viewport when no observation reached the planner. */
const FALLBACK_VIEWPORT = Object.freeze({ width: 1280, height: 800 })

/** Prompt fragment per design language, so the generator is told the *style*. */
const STYLE_PROMPT = Object.freeze({
  future_research_workstation: 'clean future research workstation aesthetic, cold light, precise lines',
  cyber_hud: 'cyberpunk holographic HUD aesthetic, neon rim light, scanlines',
  minimal_neutral: 'minimal neutral aesthetic, flat surfaces, no ornament',
  anime_persona: 'anime illustration aesthetic, clean cel shading, expressive character',
  industrial_console: 'industrial control console aesthetic, rugged metal, warning accents'
})

const CHARACTER_PROMPT = Object.freeze({
  silver_hair_assistant: 'silver-haired assistant with pale platinum hair',
  android_operator: 'android operator with mechanical plating and a visor',
  operator_assistant: 'calm human operator in a technical uniform',
  anime_operator: 'anime-style operator character'
})

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.max(min, Math.min(max, numeric))
}

function round(value) {
  return Math.round(Number(value) || 0)
}

/** The four surfaces this design actually writes, with their write verdict. */
function planSurfaces({ intent = {}, observation = null } = {}) {
  const personaEnabled = intent.persona?.enabled === true
  const overlayWanted = intent.official?.overlay !== false
  const shellWanted = intent.official?.shell !== false

  const surfaces = surfaceModule.describe().map((surface) => {
    const gate = surfaceModule.assertWritable(surface.id, { kind: 'component' })
    let writes = false
    let reason = null
    if (surface.id === contract.SURFACE.HNS_NATIVE) {
      writes = true
      reason = 'the HNS renderer is always themed'
    } else if (surface.id === contract.SURFACE.OFFICIAL_SHELL) {
      writes = shellWanted
      reason = shellWanted
        ? 'the outer frame around the official renderer is themed'
        : 'the prompt asked for the official outer shell to stay default'
    } else if (surface.id === contract.SURFACE.OFFICIAL_OVERLAY) {
      writes = overlayWanted
      reason = overlayWanted
        ? 'the visual overlay above the official renderer is themed'
        : 'the prompt asked for no official overlay'
    } else {
      writes = false
      reason = 'PROTECTED: the official renderer is never written by the theme system'
    }
    return {
      surface: surface.id,
      label: surface.label,
      permission: surface.permission,
      protected: surface.protected,
      writable: surface.writable,
      writes: writes && gate.ok,
      layers: surface.layers.slice(),
      merged: false,
      reason,
      gate: gate.ok ? null : gate.code
    }
  })

  const observed = observation || null
  return {
    surfaces,
    hns_native: { themed: true },
    official_shell: {
      themed: shellWanted,
      padding: clamp(intent.official?.shell_padding ?? 6, 0, 24),
      frame: intent.official?.frame || 'outline',
      opacities: { background: clamp(intent.official?.shell_background_opacity ?? 0.85, 0, 1) }
    },
    official_overlay: { themed: overlayWanted, visual_only: true, pointer: false, keyboard: false },
    official_renderer: {
      themed: false,
      protected: true,
      reason: 'PROTECTED: the official renderer is owned by the harness',
      dom_access: false,
      css_injection: false,
      script_injection: false,
      capture: false
    },
    // 任务 8: the plan records what it observed, or says that it observed nothing.
    observed: Boolean(observed),
    degraded: !observed,
    observation_reason: observed ? null : 'no UI observation reached the planner; placement uses conservative viewport fractions'
  }
}

/** Character placement, derived from the real viewport and safe region. */
function planCharacterPlacement({ framing, intent, observation, kind = null }) {
  const viewport = observation?.viewport || observation?.window || FALLBACK_VIEWPORT
  const fraction = FRAMING_FRACTION[framing] || FRAMING_FRACTION.half_body
  const safe = observation?.safe_region || { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const scale = clamp(intent.official?.character_scale ?? 1, 0.4, 2)
  const requestedAnchor = intent.official?.character_anchor || intent.official?.anchor || 'bottom-right'
  const anchor = surfaceModule.ANCHORS.includes(requestedAnchor)
    ? requestedAnchor
    : (observation?.preferred_anchor && surfaceModule.ANCHORS.includes(observation.preferred_anchor)
        ? observation.preferred_anchor
        : 'bottom-right')
  const width = Math.max(64, round(viewport.width * fraction.width * scale))
  // The height follows the *asset's own* aspect ratio, not the framing's: a 512x768
  // half body placed in a 512x1024 full-body box would be stretched, and the layout
  // engine (correctly) refuses to distort a character.
  const base = kind ? assets.REAL_ASSET_CATALOG[kind] : null
  const aspect = base && base.width ? base.height / base.width : 1.5
  const height = Math.max(64, round(width * aspect))
  return {
    anchor,
    // A fraction of the viewport, so the preview and the acceptance run can check
    // the coverage limit without re-measuring anything.
    viewport_fraction: Number((fraction.width * scale).toFixed(4)),
    size: { width, height },
    safe_region: { x: round(safe.x), y: round(safe.y), width: round(safe.width), height: round(safe.height) },
    margin: round(Math.max(8, Math.min(viewport.width, viewport.height) * 0.02)),
    crop: intent.official?.character_crop || 'contain'
  }
}

/** Opacity the prompt asked for, already clamped to the overlay safety ceiling. */
function characterOpacity(intent, limits) {
  const requested = Number(intent.official?.character_opacity)
  const ceiling = limits?.character_opacity ?? 0.9
  if (!Number.isFinite(requested)) return Number(Math.min(0.85, ceiling).toFixed(3))
  return Number(clamp(requested, 0, ceiling).toFixed(3))
}

/**
 * Build the asset plan.
 *
 * @param {object} options
 * @param {object} options.intent       design intent
 * @param {object} [options.design]     resolved draft (palette/mode/style)
 * @param {object} [options.observation]UI observation (viewport, safe/critical regions)
 * @param {object} [options.limits]     overlay safety limits (see official/overlay-safety.js)
 */
function planAssets({ intent = {}, design = {}, observation = null, limits = null } = {}) {
  const personaEnabled = intent.persona?.enabled === true
  const styleTag = design.style_tag || intent.style_tag || 'research'
  const paletteLabel = design.palette_label || intent.palette_label || 'steel blue'
  const stylePhrase = STYLE_PROMPT[design.design_language || intent.design_language] || STYLE_PROMPT.future_research_workstation
  const characterKey = intent.persona?.character || 'operator_assistant'
  const characterPhrase = CHARACTER_PROMPT[characterKey] || CHARACTER_PROMPT.operator_assistant
  const overlayWanted = intent.official?.overlay !== false
  const shellWanted = intent.official?.shell !== false
  const decorationLevel = design.intent?.decoration || intent.decoration || 'medium_low'
  const withDecoration = decorationLevel !== 'none'
  const placement = planCharacterPlacement({ framing: 'half_body', intent, observation, kind: 'hns_character' })
  const viewport = observation?.viewport || observation?.window || FALLBACK_VIEWPORT
  const characterPlan = {
    width: placement.size.width,
    height: placement.size.height,
    framing: 'half_body',
    transparent: true,
    opacity: characterOpacity(intent, limits),
    anchor: placement.anchor,
    position: placement,
    prominence: clamp(intent.persona?.prominence ?? 0.25, 0, 0.4),
    safe_region: placement.safe_region,
    layout: 'corner',
    crop: placement.crop
  }

  const entries = []
  const push = (kind, overrides = {}) => {
    const base = assets.REAL_ASSET_CATALOG[kind]
    if (!base) return null
    // A width override carries its own height, derived from the catalog's aspect
    // ratio, so a placement-driven size never stretches the asset out of shape.
    const width = overrides.width || base.width
    const height = overrides.height || (overrides.width
      ? Math.max(64, round(overrides.width * ((base.height || width) / (base.width || width))))
      : base.height)
    const entry = {
      kind,
      asset_type: base.framing,
      label: base.label,
      surface: overrides.surface || base.surface,
      target: overrides.surface || base.surface,
      width,
      height,
      transparent: overrides.transparent === undefined ? base.transparent : overrides.transparent,
      // Positioning: every asset that is *placed* carries an anchor; a background
      // asset is stretched and therefore has none.
      position: overrides.position || null,
      anchor: overrides.anchor || (base.layout === 'background' ? null : base.anchor),
      layout: overrides.layout || base.layout,
      opacity: overrides.opacity === undefined ? 1 : overrides.opacity,
      prominence: overrides.prominence === undefined ? 0.5 : overrides.prominence,
      safe_region: overrides.safe_region || {
        x: 0,
        y: 0,
        width: round(viewport.width),
        height: round(viewport.height)
      },
      framing: overrides.framing || base.framing,
      crop: overrides.crop || 'contain',
      scale: overrides.scale === undefined ? 1 : overrides.scale,
      generation_prompt: overrides.generation_prompt || `${base.prompt}. Style: ${stylePhrase}. Palette: ${paletteLabel}.`,
      procedural_fallback: overrides.procedural_fallback || 'assets/fallback.js'
    }
    // The package path is decided here, not by the builder: the approved plan
    // names the exact file the installed package will carry.
    entries.push(generator.withPackagePath(entry))
    return entry
  }

  // ---- HNS native surface -------------------------------------------------
  push('wallpaper', {
    generation_prompt: `${STYLE_PROMPT[design.design_language || intent.design_language] || STYLE_PROMPT.future_research_workstation} desktop wallpaper, palette ${paletteLabel}, no text, no watermark, no UI elements`
  })
  push('panel_texture')
  push('icon_set')
  if (personaEnabled) {
    push('persona_avatar', {
      generation_prompt: `${characterPhrase}, head and shoulders portrait, transparent background, no text, palette ${paletteLabel}`
    })
    push('hns_character', {
      ...characterPlan,
      generation_prompt: `${characterPhrase}, half body, transparent background, no text, no watermark, ${stylePhrase}, palette ${paletteLabel}`
    })
  }

  // ---- official shell surface --------------------------------------------
  if (shellWanted) {
    push('frame_decoration', {
      opacity: clamp(intent.official?.frame_glow_opacity ?? 0.5, 0, 1),
      prominence: 0.35
    })
  }

  // ---- official overlay surface ------------------------------------------
  if (overlayWanted) {
    push('official_skin', {
      opacity: clamp(intent.official?.skin_opacity ?? 0.5, 0, 1),
      prominence: 0.4
    })
    push('official_overlay_texture', {
      opacity: clamp(intent.official?.texture_opacity ?? 0.16, 0, limits?.overlay_opacity ?? 0.22)
    })
    if (personaEnabled) {
      push('official_character', {
        ...characterPlan,
        generation_prompt: `${characterPhrase}, half body, transparent background, positioned ${placement.anchor} of the frame, must not cover the centre of the window, no text, ${stylePhrase}, palette ${paletteLabel}`
      })
    }
    if (withDecoration) {
      push('hud_decoration', {
        position: placement,
        anchor: placement.anchor,
        prominence: 0.25,
        opacity: clamp(decorationLevel === 'high' ? 0.6 : 0.35, 0, 1)
      })
    }
  }

  const perSurface = {}
  for (const entry of entries) {
    perSurface[entry.surface] = (perSurface[entry.surface] || 0) + 1
  }

  return {
    version: 1,
    asset_plan: entries,
    count: entries.length,
    per_surface: perSurface,
    character: personaEnabled
      ? {
          enabled: true,
          character: characterKey,
          framing: 'half_body',
          anchor: placement.anchor,
          opacity: characterPlan.opacity,
          surfaces: ['hns_native', 'official_overlay'].filter((surface) => entries.some((entry) => entry.surface === surface && /character/.test(entry.kind))),
          viewport_fraction: placement.viewport_fraction
        }
      : { enabled: false, character: null, surfaces: [] },
    decoration: withDecoration ? decorationLevel : 'none',
    degraded: !observation,
    reason: observation ? null : 'planned without a UI observation'
  }
}

/**
 * Build the overlay plan (任务 7).
 *
 * Every strength is clamped to the engineering ceiling rather than merely checked
 * later: the plan is the first line of defence, and the Overlay Safety validator
 * is the second. A prompt cannot ask for a 90%-opaque tint and get one.
 */
function planOverlay({ intent = {}, design = {}, observation = null, limits = null } = {}) {
  const enabled = intent.official?.overlay !== false
  const tone = intent.official?.tone || 'cool'
  const tintColor = intent.official?.tint_color || design.palette_values?.base || null
  const paletteLabel = design.palette_label || intent.palette_label || 'steel blue'
  const styleTag = design.style_tag || intent.style_tag || 'research'
  const personaEnabled = intent.persona?.enabled === true
  const placement = planCharacterPlacement({ framing: 'half_body', intent, observation })
  const maxOverlay = limits?.overlay_opacity ?? 0.22
  const maxVignette = limits?.vignette ?? 0.15
  const maxScanline = limits?.scanline ?? 0.05
  const maxCharacter = limits?.character_coverage ?? 0.22

  const tintOpacity = clamp(intent.official?.tint_opacity ?? 0.1, 0, maxOverlay)
  const vignetteOpacity = clamp(intent.official?.vignette_opacity ?? 0.1, 0, maxVignette)
  const scanlineOpacity = clamp(intent.official?.scanline_opacity ?? (styleTag === 'cyber' ? 0.04 : 0), 0, maxScanline)
  const glowOpacity = clamp(intent.official?.frame_glow_opacity ?? 0.35, 0, 0.6)
  const textureOpacity = clamp(intent.official?.texture_opacity ?? 0.16, 0, maxOverlay)
  const coverage = Math.min(maxCharacter, placement.viewport_fraction)

  return {
    version: 1,
    enabled,
    visual_only: true,
    input: { pointer: 'passthrough', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' },
    // 任务 9 layout modes, resolved to one primary mode plus its fallbacks.
    layout: {
      mode: intent.official?.layout || (personaEnabled ? 'corner' : 'framed'),
      anchor: placement.anchor,
      fallback_modes: ['corner', 'edge', 'framed', 'background', 'floating'],
      safe_region: placement.safe_region,
      margin: placement.margin,
      follow_view: 'official_view_bounds'
    },
    components: {
      global_tint: { enabled: tintOpacity > 0, color: tintColor, opacity: tintOpacity, mode: tone },
      gradient: {
        enabled: intent.official?.gradient !== false && tintOpacity > 0,
        angle: round(intent.official?.gradient_angle ?? 160),
        opacity: Number((tintOpacity * 0.8).toFixed(3)),
        stops: [
          { at: 0, color: design.palette_values?.overlay || design.palette_values?.base || '#0b0d12', alpha: 1 },
          { at: 1, color: design.palette_values?.layer2 || '#1b2130', alpha: 0.25 }
        ]
      },
      texture: { enabled: textureOpacity > 0, asset: 'assets/official/official-overlay-texture.png', opacity: textureOpacity, tile: true, scale: 1 },
      skin: { enabled: intent.official?.skin !== false, asset: 'assets/official/official-skin.png', opacity: clamp(intent.official?.skin_opacity ?? 0.5, 0, 1), layout: 'framed', inset: 0 },
      vignette: { enabled: vignetteOpacity > 0, opacity: vignetteOpacity, size: 0.78 },
      scanline: { enabled: scanlineOpacity > 0, opacity: scanlineOpacity, spacing: 4, width: 1 },
      frame_glow: { enabled: glowOpacity > 0, opacity: glowOpacity, width: round(2 + glowOpacity * 6), color: design.palette_values?.accent || '#4d93f8' },
      corner_decoration: {
        enabled: intent.official?.decoration !== 'none' && personaEnabled !== false,
        asset: 'assets/decorations/decoration-hud.png',
        opacity: clamp(intent.official?.decoration_opacity ?? 0.4, 0, 0.6),
        anchor: placement.anchor,
        scale: 1
      },
      character_primary: {
        enabled: personaEnabled,
        asset: 'assets/official/official-character.png',
        opacity: characterOpacity(intent, limits),
        anchor: placement.anchor,
        layout: 'corner',
        framing: 'half_body',
        crop: placement.crop,
        size: placement.size,
        coverage,
        safe_region: placement.safe_region
      },
      character_secondary: { enabled: false, asset: null, opacity: 0 }
    },
    limits: {
      overlay_opacity: maxOverlay,
      vignette: maxVignette,
      scanline: maxScanline,
      character_coverage: maxCharacter,
      critical_overlap: limits?.critical_overlap ?? 0.08
    },
    palette: paletteLabel,
    degraded: !observation,
    reason: observation ? null : 'planned without a UI observation; safe region falls back to the whole viewport'
  }
}

/**
 * The three plan documents a theme package carries (任务 15).
 *
 * They are produced from the plans the designer and the orchestrator already
 * agreed on, so the file on disk is a *record* of the decision, never a second
 * opinion. `asset-plan.json` additionally names the package-relative file each
 * entry is written to, which is what makes the package self-describing.
 */
function assetPlanDocument({ assetPlan = null, generatedAt = null } = {}) {
  const plan = assetPlan || { asset_plan: [], count: 0, per_surface: {}, character: { enabled: false }, degraded: true }
  const entries = (plan.asset_plan || []).map((entry) => ({
    // The full plan entry: every mandated field is spelled out by planAssets().
    ...entry,
    path: entry.path || null,
    // A byte count is filled in by the builder once the asset exists, so this
    // document can be validated against the real package.
    bytes: entry.bytes === undefined ? null : entry.bytes
  }))
  return {
    version: 1,
    generated_at: generatedAt || new Date().toISOString(),
    count: entries.length,
    per_surface: { ...(plan.per_surface || {}) },
    character: { ...(plan.character || { enabled: false }) },
    decoration: plan.decoration || 'none',
    degraded: Boolean(plan.degraded),
    reason: plan.reason || null,
    assets: entries
  }
}

/**
 * Fold the generated asset results back into the plan document.
 *
 * This is how the package ends up describing what it *actually* contains: which
 * asset the image model produced, which one fell back, which one was disabled and
 * what the validator measured. A degradation that is not written down is a
 * degradation nobody can find later.
 */
function recordAssetResults(assetPlan = null, results = []) {
  const byKind = new Map()
  for (const result of results || []) {
    if (!result) continue
    byKind.set(`${result.kind}:${result.path || ''}`, result)
  }
  const entries = (assetPlan?.asset_plan || []).map((entry) => {
    const supplied = entry.path || null
    const match = byKind.get(`${entry.kind}:${supplied}`) || byKind.get(`${entry.kind}:null`) || null
    return {
      ...entry,
      path: match?.path || supplied,
      bytes: match?.bytes ?? null,
      provenance: match?.provenance || null,
      degraded: match ? Boolean(match.degraded) : entry.degraded === true,
      disabled: match ? Boolean(match.disabled) : entry.disabled === true,
      disabled_reason: match?.reason || entry.disabled_reason || null,
      validation: match?.validation
        ? {
            ok: match.validation.ok,
            reason: match.validation.reason,
            width: match.validation.metrics?.width || 0,
            height: match.validation.metrics?.height || 0,
            transparent: match.validation.metrics?.transparent === true,
            opaque_ratio: match.validation.metrics?.opaqueRatio ?? 0,
            transparent_ratio: match.validation.metrics?.transparentRatio ?? 0,
            ink_ratio: match.validation.metrics?.inkRatio ?? 0,
            distinct_colors: match.validation.metrics?.distinctColors ?? 0,
            warnings: (match.validation.soft || []).map((issue) => issue.code)
          }
        : null
    }
  })
  return assetPlanDocument({ assetPlan: { ...(assetPlan || {}), asset_plan: entries } })
}

module.exports = {
  FRAMING_FRACTION,
  STYLE_PROMPT,
  CHARACTER_PROMPT,
  FALLBACK_VIEWPORT,
  planSurfaces,
  planOverlay,
  planAssets,
  planCharacterPlacement,
  assetPlanDocument,
  recordAssetResults
}
