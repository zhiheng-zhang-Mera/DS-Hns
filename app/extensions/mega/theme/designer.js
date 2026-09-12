'use strict'

/**
 * Theme Designer.
 *
 * The Designer understands a natural-language prompt (plus any revision), reads
 * the capability manifest and the UI snapshot, and produces:
 *
 *   Design Intent (semantic, model-facing)
 *     -> Design Tokens + slot decisions (concrete, runtime-facing)
 *
 * It never writes to the production theme directory and never installs anything
 * (engineering spec §9.1). Its output is a draft the Preview Renderer shows and
 * the Theme Builder later compiles.
 *
 * Two engines are available and share the same output contract:
 *   - `designer.intent(prompt)`          local, deterministic, offline
 *   - `designer.interpretWithModel(...)` optional model-assisted refinement
 * The deterministic engine is authoritative: a model failure or a nonsensical
 * model answer can only be *ignored*, never break a theme build.
 */
const contract = require('./contract')
const color = require('./color')
const assets = require('./asset-factory')

const PALETTE_WORDS = [
  { match: /黑|暗黑|深色|charcoal|black|obsidian|ink/, palette: 'charcoal', base: '#0d0f13', label: '深炭黑' },
  { match: /银|白|silver|platinum|white|frost/, palette: 'silver', base: '#171a22', label: '冷银' },
  { match: /灰|灰蓝|steel|graphite|slate|gray|grey/, palette: 'steel', base: '#141821', label: '钢灰' },
  { match: /蓝|青蓝|steel_blue|navy|azure|cobalt/, palette: 'steel_blue', base: '#101724', label: '钢蓝' },
  { match: /紫|violet|purple|magenta|amethyst/, palette: 'violet', base: '#151024', label: '紫' },
  { match: /绿|翠|emerald|green|mint|jade/, palette: 'emerald', base: '#0d1a16', label: '翠绿' },
  { match: /红|绯|深红|crimson|red|scarlet/, palette: 'crimson', base: '#1a0f12', label: '绯红' },
  { match: /棕|暖|琥珀|amber|warm|sand|beige|sepia/, palette: 'amber', base: '#191410', label: '暖琥珀' }
]

const STYLE_WORDS = [
  { match: /科研|未来|工作站|实验室|research|station|lab|scientific|future/, style: 'future_research_workstation', tag: 'research' },
  { match: /赛博|霓虹|全息|hud|cyber|neon|hologram|mecha|机甲/, style: 'cyber_hud', tag: 'cyber' },
  { match: /极简|简约|干净|素|minimal|clean|plain|neutral|simple/, style: 'minimal_neutral', tag: 'minimal' },
  { match: /二次元|动漫|角色|立绘|anime|manga|persona|character|少女|少年/, style: 'anime_persona', tag: 'organic' },
  { match: /工业|监控|仪表|操作台|industrial|monitor|console|control/, style: 'industrial_console', tag: 'research' }
]

const CHARACTER_WORDS = [
  { match: /银发|白发|银白|silver_?hair|white_?hair|platinum/, character: 'silver_hair_assistant' },
  { match: /机娘|android|mecha|机器人|robot|droid/, character: 'android_operator' },
  { match: /助手|助理|assistant|operator|操作员/, character: 'operator_assistant' },
  { match: /少女|girl|anime|动漫|二次元/, character: 'anime_operator' }
]

const DENSITY_WORDS = [
  { match: /紧凑|密集|高密度|compact|dense|tight/, density: 'compact', scale: 0.86 },
  { match: /宽松|稀疏|舒适|spacious|airy|relaxed|loose/, density: 'spacious', scale: 1.18 },
  { match: /标准|常规|normal|standard|default/, density: 'normal', scale: 1 }
]

const MOTION_WORDS = [
  { match: /不要动|无动画|静态|still|no animation|static|subtle motion|别动/, motion: 'none' },
  { match: /微妙|轻微|克制|subtle|slight|minimal motion/, motion: 'subtle' },
  { match: /强烈|炫酷|动感|strong|flashy|dynamic|heavy motion/, motion: 'strong' }
]

const DECORATION_WORDS = [
  { match: /不要装饰|无装饰|素|no decoration|plain|bare/, decoration: 'none' },
  { match: /少装饰|轻微装饰|low|light decoration|subtle decoration/, decoration: 'low' },
  { match: /装饰|华丽|丰富|decoration|ornate|rich|heavy/, decoration: 'high' }
]

const PROMINENCE_WORDS = [
  { match: /别太抢|不要太显眼|小一点|不要挡|低调|small|subtle|less prominent|not too prominent|corner/, prominence: 0.18 },
  { match: /大一点|明显|突出|prominent|bigger|larger|bold/, prominence: 0.36 },
  { match: /隐藏|不要人物|无角色|hide|no persona|remove the character/, prominence: 0 }
]

const ACCESSIBILITY_WORDS = [
  { match: /可读|清晰|对比|readab|contrast|legible|clear text/, readability: 'high' }
]

const NEGATIONS = [/不要/, /别/, /no\s+/, /without/, /remove/]

function firstMatch(text, table, key) {
  for (const entry of table) {
    if (entry.match.test(text)) return entry
  }
  return null
}

/** Is the matched keyword negated by nearby text? */
function isNegated(text, keywordSource) {
  const index = text.search(keywordSource)
  if (index <= 0) return false
  const window = text.slice(Math.max(0, index - 6), index)
  return NEGATIONS.some((pattern) => pattern.test(window))
}

/**
 * Revision deltas.
 *
 * A revision prompt is not a fresh design brief: "a bit smaller", "less bright",
 * "more compact" are *increments* on the current design. Reading them as a fresh
 * prompt would silently drop the decision they refer to, so they are parsed into
 * explicit numeric adjustments and applied to the previous intent (spec §8:
 * preserve what was not asked to change, keep the change local).
 */
const PROMINENCE_DELTA = Object.freeze([
  { match: /(再|更|稍微|一点|有点)?\s*(小一点|小一些|小点|缩小|smaller|less prominent|too prominent)/, delta: -0.08 },
  { match: /(再|更|稍微|一点|有点)?\s*(大一点|大一些|大点|放大|bigger|larger|more prominent)/, delta: 0.08 }
])

const DECORATION_DELTA = Object.freeze([
  { match: /(更|再|稍微)?\s*(少|低|减|淡化|素)(一点|一些|点)?\s*(装饰|花纹|装饰物)?/, delta: -1 },
  { match: /(更|再|稍微)?\s*(多|高|加|丰富|华丽)(一点|一些|点)?\s*(装饰|花纹|装饰物)?/, delta: 1 }
])

const BRIGHTNESS_DELTA = Object.freeze([
  { match: /(不要太亮|太亮|别这么亮|不要这么亮|太刺眼|刺眼|less bright|too bright|dim(mer)?| soften)/, delta: -1 },
  { match: /(更亮|再亮|亮一点|brighter|more vivid|更鲜明)/, delta: 1 }
])

const DENSITY_DELTA = Object.freeze([
  { match: /(更|再|稍微)?\s*(紧凑|密集|紧)(一点|一些|点)?|compact(er)?|denser/, delta: -1 },
  { match: /(更|再|稍微)?\s*(宽松|稀疏|舒朗|松)(一点|一些|点)?|more spacious|airier/, delta: 1 }
])

const DECORATION_ORDER = ['none', 'low', 'medium_low', 'high']
const DENSITY_ORDER = ['compact', 'normal', 'spacious']

function shiftEnum(order, current, delta) {
  const index = order.indexOf(current)
  const base = index === -1 ? Math.floor(order.length / 2) : index
  const next = Math.max(0, Math.min(order.length - 1, base + delta))
  return order[next]
}

/**
 * Parse revision increments out of a modification prompt.
 * Every field is optional; a prompt with no recognisable increment yields an
 * empty object and the caller keeps the previous intent untouched.
 */
function parseRevisionDeltas(prompt) {
  const text = String(prompt || '').toLowerCase()
  const deltas = {}
  for (const entry of PROMINENCE_DELTA) {
    if (entry.match.test(text)) {
      deltas.personaProminence = (deltas.personaProminence || 0) + entry.delta
      break
    }
  }
  for (const entry of DECORATION_DELTA) {
    if (entry.match.test(text)) {
      deltas.decoration = (deltas.decoration || 0) + entry.delta
      break
    }
  }
  for (const entry of BRIGHTNESS_DELTA) {
    if (entry.match.test(text)) {
      deltas.brightness = entry.delta
      break
    }
  }
  for (const entry of DENSITY_DELTA) {
    if (entry.match.test(text)) {
      deltas.density = (deltas.density || 0) + entry.delta
      break
    }
  }
  if (/不要(太)?(强|炫|动)|别太动|更安静|less motion|quieter/.test(text)) deltas.motion = -1
  if (/更(动感|炫)|animation more|more motion/.test(text)) deltas.motion = 1
  if (/不要(人物|角色)|隐藏(人物|角色)|去掉(人物|角色)|no persona|hide the character|remove the character/.test(text)) {
    deltas.personaDisabled = true
  }
  return deltas
}

/** Apply parsed increments on top of a previous intent. */
function applyDeltas(intent, deltas) {
  if (!deltas || !Object.keys(deltas).length) return intent
  const next = { ...intent, persona: { ...intent.persona } }
  if (deltas.personaDisabled) {
    next.persona = { enabled: false, prominence: 0, character: null }
  } else if (deltas.personaProminence) {
    const prominence = Math.max(0, Math.min(0.4, Number(next.persona.prominence || 0) + deltas.personaProminence))
    next.persona = {
      ...next.persona,
      enabled: prominence > 0,
      prominence,
      character: next.persona.character || (prominence > 0 ? 'operator_assistant' : null)
    }
  }
  if (deltas.decoration) next.decoration = shiftEnum(DECORATION_ORDER, next.decoration || 'medium_low', deltas.decoration)
  if (deltas.density) next.density = shiftEnum(DENSITY_ORDER, next.density || 'compact', deltas.density)
  if (deltas.motion) {
    next.motion = shiftEnum(['none', 'subtle', 'strong'], next.motion || 'subtle', deltas.motion)
  }
  if (deltas.brightness) {
    // "Less bright" is always a request for less glow and softer accents; the
    // accent itself is only nudged, never abandoned (the design language stays).
    const motion = next.motion || 'subtle'
    if (deltas.brightness < 0) {
      next.motion = motion === 'strong' ? 'subtle' : motion === 'subtle' ? 'none' : motion
      next.brightness = Math.max(-0.4, (Number(next.brightness) || 0) - 0.25)
    } else {
      next.motion = motion === 'none' ? 'subtle' : motion === 'subtle' ? 'strong' : motion
      next.brightness = Math.min(0.4, (Number(next.brightness) || 0) + 0.25)
    }
  }
  return next
}

/**
 * Local intent interpretation. Always succeeds — unknown input lands on a
 * conservative, readable default rather than an error.
 */
function interpret(prompt, { previousIntent = null } = {}) {
  const text = String(prompt || '').toLowerCase()
  const notes = []

  let paletteEntry = null
  for (const entry of PALETTE_WORDS) {
    if (entry.match.test(text) && !isNegated(text, entry.match)) {
      paletteEntry = entry
      break
    }
  }
  let styleEntry = firstMatch(text, STYLE_WORDS)
  let characterEntry = firstMatch(text, CHARACTER_WORDS)
  const densityEntry = firstMatch(text, DENSITY_WORDS)
  const motionEntry = firstMatch(text, MOTION_WORDS)
  const decorationEntry = firstMatch(text, DECORATION_WORDS)
  const prominenceEntry = firstMatch(text, PROMINENCE_WORDS)
  const accessibilityEntry = firstMatch(text, ACCESSIBILITY_WORDS)

  // An explicit "no persona" wins over any character keyword.
  const personaOff = /不要人物|无角色|隐藏角色|no persona|hide the character|remove the character/.test(text)
  if (personaOff) {
    characterEntry = null
    notes.push('persona disabled by the prompt')
  }

  const previous = previousIntent || null
  const palette = paletteEntry ? paletteEntry.palette : previous?.palette?.[0] || 'steel_blue'
  const designLanguage = styleEntry?.style || previous?.design_language || 'future_research_workstation'
  const styleTag = styleEntry?.tag || previous?.style_tag || 'research'
  const density = densityEntry?.density || previous?.density || 'compact'
  const motion = motionEntry?.motion || previous?.motion || 'subtle'
  const decoration = decorationEntry?.decoration || previous?.decoration || 'medium_low'
  const readability = accessibilityEntry?.readability || previous?.readability_priority || 'high'

  const personaEnabled = !personaOff && Boolean(
    characterEntry || previous?.persona?.enabled || designLanguage === 'anime_persona'
  )
  const prominence = prominenceEntry
    ? prominenceEntry.prominence
    : personaEnabled
      ? Math.min(0.4, previous?.persona?.prominence ?? 0.25)
      : 0

  const character = characterEntry?.character
    || previous?.persona?.character
    || (personaEnabled ? 'operator_assistant' : null)

  const baseIntent = {
    version: 1,
    design_language: designLanguage,
    style_tag: styleTag,
    palette: paletteEntry ? [paletteEntry.palette] : (previous?.palette || [palette]),
    palette_label: paletteEntry?.label || previous?.palette_label || '钢蓝',
    base_hint: paletteEntry?.base || previous?.base_hint || '#101724',
    density,
    density_scale: densityEntry?.scale ?? previous?.density_scale ?? 0.86,
    persona: {
      enabled: personaEnabled,
      prominence: personaEnabled ? color.clamp(prominence, 0, 0.4) : 0,
      character
    },
    motion,
    decoration,
    brightness: Number(previous?.brightness) || 0,
    readability_priority: readability,
    notes,
    prompt: String(prompt || ''),
    interpreted_at: new Date().toISOString()
  }

  // Increments from this prompt are layered on top of the previous design.
  const deltas = previous ? parseRevisionDeltas(text) : {}
  const applied = applyDeltas(baseIntent, deltas)
  if (Object.keys(deltas).length) applied.deltas = deltas
  return applied
}

/**
 * Apply a revision on top of an existing intent. The spec is explicit: a
 * revision must be incremental and must not re-roll the whole design (§8), so
 * only the fields the revision actually mentions change.
 */
function revise(previousIntent, revisionPrompt) {
  const next = interpret(revisionPrompt, { previousIntent })
  const changed = []
  const keys = ['design_language', 'style_tag', 'density', 'motion', 'decoration', 'readability_priority']
  for (const key of keys) {
    if (previousIntent && previousIntent[key] !== next[key]) changed.push(key)
  }
  if (previousIntent && JSON.stringify(previousIntent.palette) !== JSON.stringify(next.palette)) changed.push('palette')
  if (previousIntent && JSON.stringify(previousIntent.persona) !== JSON.stringify(next.persona)) changed.push('persona')
  return { intent: next, changed }
}

/** Accent hue per palette. Kept explicit so themes are reproducible. */
const PALETTE_SPECS = Object.freeze({
  charcoal: { accent: '#6b7a8f', accent2: '#93a3b8', mode: 'dark' },
  silver: { accent: '#8fa6c4', accent2: '#b9cbe4', mode: 'dark' },
  steel: { accent: '#5b7fa6', accent2: '#87a8cc', mode: 'dark' },
  steel_blue: { accent: '#4d93f8', accent2: '#7aa7ff', mode: 'dark' },
  violet: { accent: '#8f6bf0', accent2: '#b79bff', mode: 'dark' },
  emerald: { accent: '#2fbf8f', accent2: '#6fdcb4', mode: 'dark' },
  crimson: { accent: '#e0564f', accent2: '#ff8b7f', mode: 'dark' },
  amber: { accent: '#e8a33d', accent2: '#ffc978', mode: 'dark' }
})

/**
 * Canonical state palette. The Designer may never move these beyond the point
 * where the runtime validator would reject the theme, and it can never merge
 * two states — the validator enforces the minimum perceptual distance.
 */
function stateTokens(mode) {
  return mode === 'light'
    ? {
        'state.idle': '#8a929f',
        'state.running': '#2f6fe0',
        'state.waiting': '#a07a10',
        'state.blocked': '#8646b8',
        'state.warning': '#c47a10',
        'state.failed': '#c0392b',
        'state.completed': '#1f8a53',
        'state.resource_limit': '#a83a24',
        'state.primary_worker': '#1f7fa8',
        'state.sub_worker': '#3f7d74'
      }
    : {
        'state.idle': '#8b93a1',
        'state.running': '#4d93f8',
        'state.waiting': '#c9a227',
        'state.blocked': '#b06bd6',
        'state.warning': '#f0a63a',
        'state.failed': '#ef5d5d',
        'state.completed': '#3fbf7f',
        'state.resource_limit': '#d9553f',
        'state.primary_worker': '#4ea8de',
        'state.sub_worker': '#6fa8a0'
      }
}

const DENSITY_SPECS = Object.freeze({
  compact: { unit: '4px', gap: '6px', panel: '10px', body: '12px', caption: '10px', title: '15px', titleWeight: '600' },
  normal: { unit: '4px', gap: '8px', panel: '12px', body: '13px', caption: '11px', title: '16px', titleWeight: '600' },
  spacious: { unit: '4px', gap: '12px', panel: '16px', body: '14px', caption: '12px', title: '18px', titleWeight: '600' }
})

const MOTION_SPECS = Object.freeze({
  none: { type: 'none', intensity: 0, glow: '0', blur: '0px' },
  subtle: { type: 'fade', intensity: 0.3, glow: '0.12', blur: '2px' },
  strong: { type: 'pulse', intensity: 0.5, glow: '0.4', blur: '6px' }
})

const DECORATION_OPACITY = Object.freeze({ none: 0, low: 0.12, medium_low: 0.2, high: 0.34 })

/**
 * Surface ramp anchors, as HSL lightness.
 *
 * The surface stack is anchored rather than derived by repeatedly shading the
 * requested base. That matters: shading a mid-tone base yields a compressed
 * stack whose layers are nearly identical, which is both visually wrong and the
 * exact condition that makes a theme unreadable. Anchoring keeps the stack's
 * internal contrast constant for any base the user asks for, while the base's
 * own hue and saturation (and the palette accent) still carry the design.
 */
const SURFACE_RAMP = Object.freeze({
  light: { overlay: 0.925, base: 0.964, layer1: 1, layer2: 0.951, raised: 1 },
  dark: { overlay: 0.057, base: 0.071, layer1: 0.108, layer2: 0.147, raised: 0.163 }
})

/**
 * Build the surface stack from the requested base by taking its hue/saturation
 * and an anchored lightness for the requested polarity. A low-chroma base (a
 * neutral grey) would otherwise produce a colourless, mid-tone stack that no
 * legible palette can sit on, so chroma is lifted to the design system's floor.
 */
function surfaceRamp(baseHint, mode) {
  const parsed = color.parseColor(baseHint)
  const hsl = parsed ? color.rgbToHsl(baseHint) : null
  const anchors = SURFACE_RAMP[mode] || SURFACE_RAMP.dark
  // Keep the tint but never let the stack collapse to pure grey.
  const saturation = Math.max(hsl ? hsl.s : 0, mode === 'dark' ? 0.16 : 0.06)
  const hue = hsl ? hsl.h : 220
  const at = (lightness) => color.toHex(color.hslToRgb({ h: hue, s: saturation, l: lightness }))
  return {
    base: at(anchors.base),
    layer1: at(anchors.layer1),
    layer2: at(anchors.layer2),
    overlay: at(anchors.overlay),
    raised: at(anchors.raised)
  }
}

/** Convert a resolved palette into the full token set for a design. */
function paletteToTokens({ intent, palette, mode, specimen }) {
  const spec = PALETTE_SPECS[palette] || PALETTE_SPECS.steel_blue
  const accent = spec.accent
  const accent2 = spec.accent2
  const density = DENSITY_SPECS[intent.density] || DENSITY_SPECS.compact
  const motion = MOTION_SPECS[intent.motion] || MOTION_SPECS.subtle
  const decorationOpacity = DECORATION_OPACITY[intent.decoration] ?? 0.2
  const dark = mode !== 'light'
  // "Less bright" must reach the compiled theme, so the glow token follows the
  // revision's brightness delta; the accent stays recognisable.
  const brightness = color.clamp(Number(intent.brightness) || 0, -0.45, 0.45)
  const glow = String(Math.max(0, Number(motion.glow) + brightness).toFixed(3))

  const ramp = surfaceRamp(specimen.base, mode)
  const base = ramp.base
  const layer1 = ramp.layer1
  const layer2 = ramp.layer2
  const overlay = ramp.overlay
  const raised = ramp.raised
  const labelPrimary = dark ? '#eef2f8' : '#182029'
  // Label tints follow the surface polarity: the same grey cannot serve a light
  // and a dark content layer, and getting this wrong is exactly the kind of
  // "generated theme is unreadable" failure the spec forbids.
  const labelSecondary = dark ? '#a7b1c2' : '#4f5866'
  const labelTertiary = dark ? '#7c8798' : '#6f7885'
  const labelInverse = dark ? '#0d1016' : '#ffffff'
  const borderL1 = dark ? (color.mix(layer2, accent, 0.16) || '#252d3d') : (color.mix(layer2, accent, 0.1) || '#dfe4ec')
  const borderL2 = dark ? (color.mix(layer2, accent, 0.3) || '#33405a') : (color.mix(layer2, accent, 0.22) || '#c6cedb')

  return {
    'color.bg.base': base,
    'color.bg.layer1': layer1,
    'color.bg.layer2': layer2,
    'color.bg.overlay': overlay,
    'color.bg.raised': raised,
    'color.label.primary': labelPrimary,
    'color.label.secondary': labelSecondary,
    'color.label.tertiary': labelTertiary,
    'color.label.inverse': labelInverse,
    'color.border.l1': borderL1,
    'color.border.l2': borderL2,
    'color.accent.primary': accent,
    'color.accent.secondary': accent2,
    'color.accent.contrast': color.bestOn(accent, ['#ffffff', '#0d1016']) || labelInverse,
    ...stateTokens(mode),
    'font.family': '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    'font.family.mono': 'Consolas, "SF Mono", "JetBrains Mono", monospace',
    'font.size.body': density.body,
    'font.size.caption': density.caption,
    'font.size.title': density.title,
    'font.weight.body': '400',
    'font.weight.title': density.titleWeight,
    'space.unit': density.unit,
    'space.gap': density.gap,
    'space.panel': density.panel,
    'radius.sm': intent.design_language === 'minimal_neutral' ? '3px' : '4px',
    'radius.md': intent.design_language === 'minimal_neutral' ? '6px' : '10px',
    'radius.lg': intent.design_language === 'minimal_neutral' ? '10px' : '16px',
    'shadow.l1': dark ? '0 1px 3px rgba(0,0,0,.42)' : '0 1px 2px rgba(16,24,40,.08)',
    'shadow.l2': dark ? '0 8px 22px rgba(0,0,0,.52)' : '0 8px 20px rgba(16,24,40,.13)',
    'opacity.panel': String(dark ? 0.96 : 1),
    'effect.blur': motion.blur,
    'effect.glow': glow,
    _decorationOpacity: decorationOpacity,
    _mode: mode
  }
}

/**
 * Contrast remediation.
 *
 * The Designer must never be able to emit a draft that the validator will
 * reject — a prompt is not allowed to produce an unreadable theme, and the user
 * is never asked to understand contrast. Every validated pair is measured here
 * and the offending colour is moved along its own lightness axis until the
 * requirement is met, keeping hue and saturation so the design language
 * survives the correction.
 *
 * Returns the repaired token map plus the list of adjustments so the preview can
 * tell the user "the accent was darkened for readability".
 */
function enforceContrast(tokens, { maxSteps = 60, step = 0.02 } = {}) {
  const repaired = { ...tokens }
  const adjustments = []

  // The accent may be the background of a validated pair. When neither black nor
  // white reaches the required ratio the accent itself is too mid-toned to carry
  // text, so move the accent (hue and saturation preserved) instead.
  {
    const label = repaired['color.label.inverse']
    let accent = repaired['color.accent.primary']
    let ratio = color.contrastRatio(label, accent)
    if (ratio !== null && ratio + 1e-6 < 3) {
      const original = accent
      // Move the accent away from the label: a light label needs a darker
      // surface behind it, a dark label needs a lighter one.
      const direction = color.isLight(label) ? -1 : 1
      let best = accent
      let bestRatio = ratio
      for (let index = 1; index <= maxSteps; index += 1) {
        const candidate = color.shade(original, direction * step * index, { saturationScale: 1.02 })
        if (!candidate) break
        const candidateRatio = color.contrastRatio(label, candidate)
        if (candidateRatio === null) break
        if (candidateRatio > bestRatio) {
          best = candidate
          bestRatio = candidateRatio
        }
        if (candidateRatio + 1e-6 >= 3) break
      }
      if (bestRatio + 1e-6 >= 3) {
        repaired['color.accent.primary'] = best
        accent = best
        adjustments.push({
          token: 'color.accent.primary',
          from: original,
          to: best,
          reason: `accent deepened so that labels keep ${bestRatio.toFixed(2)}:1 contrast (required 3:1)`
        })
      }
    }
  }

  for (const requirement of contract.CONTRAST_REQUIREMENTS) {
    let foreground = repaired[requirement.foreground]
    const background = repaired[requirement.background]
    let ratio = color.contrastRatio(foreground, background)
    if (ratio === null || ratio + 1e-6 >= requirement.min) continue

    const original = foreground
    // Direction is decided by measuring which absolute extreme contrasts better
    // against the surface, not by a lightness threshold: a mid-tone surface (a
    // neutral grey) sits on the wrong side of every threshold, and the two
    // extremes are exactly the two candidates the sweep converges to.
    const onBlack = color.contrastRatio('#000000', background) ?? -1
    const onWhite = color.contrastRatio('#ffffff', background) ?? -1
    const backgroundIsLight = onBlack >= onWhite
    const direction = backgroundIsLight ? -1 : 1
    let best = foreground
    let bestRatio = ratio

    // The full sweep is walked rather than stopping at the first decline: on a
    // mid-tone surface the ratio is not monotonic, so the best candidate may sit
    // past the point where the ratio starts falling again. The sweep always
    // reaches the pure extreme (black or white), which contrasts against any
    // surface, so a validated pair can always be satisfied.
    for (let index = 1; index <= maxSteps; index += 1) {
      const candidate = color.shade(original, direction * step * index, { saturationScale: 1.02 })
      if (!candidate) break
      const candidateRatio = color.contrastRatio(candidate, background)
      if (candidateRatio === null) break
      if (candidateRatio > bestRatio) {
        best = candidate
        bestRatio = candidateRatio
      }
      // Keep sweeping to the extreme even after the requirement is met: a later
      // candidate may contrast better and costs nothing.
    }

    // If pure lightness movement is not enough, fall back to the design system's
    // own extremes: near-black or near-white always contrasts.
    if (bestRatio + 1e-6 < requirement.min) {
      const extremes = backgroundIsLight
        ? ['#0b0f14', '#101720', '#182029']
        : ['#ffffff', '#f4f7fb', '#e8ecf3']
      for (const extreme of extremes) {
        const extremeRatio = color.contrastRatio(extreme, background)
        if (extremeRatio !== null && extremeRatio > bestRatio) {
          best = extreme
          bestRatio = extremeRatio
        }
        if (bestRatio + 1e-6 >= requirement.min) break
      }
    }

    if (bestRatio + 1e-6 >= requirement.min) {
      repaired[requirement.foreground] = best
      foreground = best
      adjustments.push({
        token: requirement.foreground,
        from: original,
        to: best,
        reason: `contrast against ${requirement.background} raised to ${bestRatio.toFixed(2)}:1 (required ${requirement.min}:1)`
      })
    }
  }

  return { tokens: repaired, adjustments }
}

/**
 * Resolve a design intent into a complete draft.
 *
 * @param {object} options
 * @param {object} options.intent
 * @param {object} [options.darkTokens]  engine fallback token set
 * @param {boolean} [options.withAssets] generate the asset bundle (build only)
 */
function design({ intent, darkTokens, withAssets = false } = {}) {
  const palette = intent.palette?.[0] || 'steel_blue'
  const spec = PALETTE_SPECS[palette] || PALETTE_SPECS.steel_blue
  const specimen = { base: intent.base_hint || spec.accent }
  // Light/dark follows the surface the design actually derives, not the palette
  // name: an intent that asks for a light base must get dark labels even when it
  // borrows a dark palette's accent.
  const mode = color.isLight(intent.base_hint || '') ? 'light' : spec.mode
  const tokenDraft = paletteToTokens({ intent, palette, mode, specimen })
  const decorationOpacity = tokenDraft._decorationOpacity
  const resolvedMode = tokenDraft._mode
  delete tokenDraft._decorationOpacity
  delete tokenDraft._mode

  const persona = {
    enabled: Boolean(intent.persona?.enabled),
    prominence: color.clamp(Number(intent.persona?.prominence) || 0, 0, 0.4),
    character: intent.persona?.character || 'operator_assistant',
    states: {},
    occludes: [],
    overlay_main: false,
    notes: 'HNS allows a lightweight persona only: small operator avatar, status avatar, corner widget, light banner.'
  }

  const tokens = { ...tokenDraft }
  // Remediation runs before assets so the compiled wallpaper palette matches the
  // corrected surface and accent colours.
  const contrastFix = enforceContrast(tokens)
  const finalTokens = contrastFix.tokens
  const assetTokens = {}
  if (withAssets) {
    // Preview-only convenience: inline the assets so the renderer can show a
    // draft without touching the filesystem. The Theme Builder never uses this
    // path — it compiles real files into the package and rewrites these tokens
    // to package-relative `assets/...` references.
    const inline = assets.buildInlineAssets({
      palette: {
        base: finalTokens['color.bg.base'],
        layer1: finalTokens['color.bg.layer1'],
        layer2: finalTokens['color.bg.layer2'],
        accent: finalTokens['color.accent.primary'],
        accentSecondary: finalTokens['color.accent.secondary'],
        label: finalTokens['color.label.primary']
      },
      style: intent.style_tag,
      seed: `${palette}:${intent.design_language}:${intent.density}`,
      persona
    })
    assetTokens['asset.wallpaper'] = inline.wallpaper
    assetTokens['asset.overlay'] = inline.overlay
    assetTokens['asset.panel_texture'] = inline.panelTexture
    assetTokens['asset.icon_set'] = inline.iconSet
    if (persona.enabled) {
      assetTokens['asset.persona_avatar'] = inline.personaAvatar
      assetTokens['asset.persona_banner'] = inline.personaBanner
    }
  }

  // Raw colours the asset generator consumes at build time. Tokens already hold
  // the resolved values; keeping the palette separate lets the Builder generate
  // assets without re-deriving anything from a prompt.
  const paletteValues = {
    base: finalTokens['color.bg.base'],
    layer1: finalTokens['color.bg.layer1'],
    layer2: finalTokens['color.bg.layer2'],
    accent: finalTokens['color.accent.primary'],
    accentSecondary: finalTokens['color.accent.secondary'],
    label: finalTokens['color.label.primary']
  }

  const stateCount = contract.HNS_STATES.length
  const slottedComponents = {
    slots: {
      'hns.window.background': {
        background: 'var(--hns-asset-wallpaper)',
        overlay: 'var(--hns-asset-overlay)'
      },
      'hns.window.overlay': {
        background: 'var(--hns-asset-overlay)',
        opacity: decorationOpacity,
        blur: tokens['effect.blur'],
        blend: 'normal'
      },
      'hns.worker.card': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-md)',
        shadow: 'var(--hns-shadow-l1)',
        label: 'var(--hns-color-label-primary)'
      },
      'hns.worker.status': {
        background: 'transparent',
        label: 'var(--hns-color-label-secondary)',
        border: '1px solid var(--hns-color-border-l2)'
      },
      'hns.process.panel': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-md)',
        shadow: 'var(--hns-shadow-l2)'
      },
      'hns.process.queue': {
        background: 'var(--hns-color-bg-layer2)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-sm)',
        label: 'var(--hns-color-label-secondary)'
      },
      'hns.hardware.cpu': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-primary)' },
      'hns.hardware.gpu': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-secondary)' },
      'hns.hardware.memory': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-primary)' },
      'hns.hardware.power': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-state-warning)' },
      'hns.log.panel': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-sm)',
        label: 'var(--hns-color-label-secondary)'
      },
      'hns.log.level': { color: 'var(--hns-color-label-secondary)', label: 'var(--hns-color-label-secondary)', weight: '500' },
      'hns.status.badge': {
        background: 'var(--hns-color-bg-layer2)',
        label: 'var(--hns-color-label-primary)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-sm)'
      },
      'hns.window.shell': {
        background: 'var(--hns-color-bg-layer1)',
        label: 'var(--hns-color-label-primary)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-md)'
      },
      'hns.operator.avatar': persona.enabled
        ? { asset: 'assets/persona/avatar.png', size: '32px' }
        : { asset: 'none', size: '24px' },
      'hns.operator.widget': {
        background: 'var(--hns-color-bg-layer2)',
        opacity: persona.enabled ? 0.9 : 0,
        position: 'corner-bottom-right',
        size: 'compact',
        animation: 'none'
      },
      'hns.persona.banner': {
        asset: persona.enabled ? 'assets/persona/banner.png' : 'none',
        opacity: persona.enabled ? decorationOpacity : 0,
        position: 'top',
        height: '64px'
      },
      'hns.persona.status_avatar': persona.enabled
        ? { asset: 'assets/persona/avatar.png', size: '28px', position: 'top-right' }
        : { asset: 'none', size: '24px', position: 'top-right' },
      'hns.persona.decoration': {
        asset: 'assets/decorations/corners.png',
        opacity: decorationOpacity,
        animation: resolvedMode === 'dark' && intent.motion !== 'none' ? 'fade' : 'none',
        position: 'corners'
      },
      'common.button.primary': {
        background: 'var(--hns-color-accent-primary)',
        label: 'var(--hns-color-accent-contrast)',
        radius: 'var(--hns-radius-md)',
        glow: tokens['effect.glow']
      },
      'common.button.secondary': {
        background: 'var(--hns-color-bg-layer2)',
        label: 'var(--hns-color-label-primary)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-md)'
      },
      'common.input.default': {
        background: 'var(--hns-color-bg-layer2)',
        label: 'var(--hns-color-label-primary)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-sm)',
        placeholder: 'var(--hns-color-label-tertiary)'
      },
      'common.dialog.default': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l2)',
        radius: 'var(--hns-radius-lg)',
        shadow: 'var(--hns-shadow-l2)',
        overlay: 'var(--hns-color-bg-overlay)'
      },
      'common.notification.default': {
        background: 'var(--hns-color-bg-layer2)',
        border: '1px solid var(--hns-color-border-l1)',
        label: 'var(--hns-color-label-primary)',
        radius: 'var(--hns-radius-sm)'
      },
      'common.tooltip.default': {
        background: 'var(--hns-color-bg-raised)',
        label: 'var(--hns-color-label-primary)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-sm)'
      },
      'common.scrollbar.default': {
        thumb: 'var(--hns-color-border-l2)',
        track: 'transparent',
        width: '8px'
      },
      'common.navigation.sidebar': {
        background: 'var(--hns-color-bg-layer2)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: '0'
      },
      'common.navigation.topbar': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l1)',
        label: 'var(--hns-color-label-primary)'
      },
      'common.panel.background': {
        background: 'var(--hns-color-bg-layer1)',
        border: '1px solid var(--hns-color-border-l1)',
        radius: 'var(--hns-radius-md)',
        shadow: 'var(--hns-shadow-l1)'
      },
      'common.panel.border': { border: '1px solid var(--hns-color-border-l1)' },
      'common.window.background': { background: 'var(--hns-color-bg-base)', overlay: 'none' }
    },
    animation: MOTION_SPECS[intent.motion] || MOTION_SPECS.subtle,
    state_count: stateCount
  }

  return {
    design_language: intent.design_language,
    palette,
    palette_label: intent.palette_label,
    mode: resolvedMode,
    style_tag: intent.style_tag,
    tokens: { ...finalTokens, ...assetTokens },
    palette_values: paletteValues,
    components: slottedComponents,
    persona,
    animation: slottedComponents.animation,
    contrast_adjustments: contrastFix.adjustments,
    intent
  }
}

/** Human-readable summary for the preview panel. */
function describe(designDraft) {
  const intent = designDraft.intent || {}
  const persona = designDraft.persona || {}
  return [
    `design_language=${designDraft.design_language}`,
    `palette=${designDraft.palette}`,
    `density=${intent.density || 'compact'}`,
    `motion=${intent.motion || 'subtle'}`,
    `decoration=${intent.decoration || 'medium_low'}`,
    `readability=${intent.readability_priority || 'high'}`,
    `persona=${persona.enabled ? `${persona.character}@${persona.prominence}` : 'off'}`,
    `mode=${designDraft.mode}`
  ].join(' · ')
}

module.exports = {
  PALETTE_SPECS,
  DENSITY_SPECS,
  MOTION_SPECS,
  DECORATION_OPACITY,
  interpret,
  revise,
  design,
  describe,
  enforceContrast,
  stateTokens
}
