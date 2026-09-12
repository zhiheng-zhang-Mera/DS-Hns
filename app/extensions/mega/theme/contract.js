'use strict'

/**
 * HNS Theme System — contract layer.
 *
 * This module is the single source of truth for:
 *   - the Theme API version every theme package must declare,
 *   - the semantic UI Slot vocabulary,
 *   - per-slot permission levels (SAFE / STYLE / STRUCTURAL),
 *   - the design-token schema (colors / typography / spacing / radius / shadow),
 *   - the HNS canonical worker state vocabulary.
 *
 * Hard rules carried by this file (from the unified theme engineering spec):
 *   - Slot permissions are declarative data; STRUCTURAL slots are never writable
 *     by the automatic theme generator.
 *   - Themes are declarative data only. No executable payload is representable
 *     in this schema, so no generated theme can smuggle code into the runtime.
 *   - HNS state visuals are a protected capability: every canonical state must
 *     stay distinguishable, so state colours are validated by the package
 *     validator instead of being trusted from the prompt.
 */

/** Theme API version exposed by this engine. */
const THEME_API_VERSION = '1.0'

/** Minimum API version a theme package may declare and still be loaded. */
const THEME_API_MIN_SUPPORTED = '1.0'

/** Permission levels, ordered by how much a generator may touch. */
const PERMISSION = Object.freeze({
  SAFE: 'SAFE',
  STYLE: 'STYLE',
  STRUCTURAL: 'STRUCTURAL'
})

/**
 * Generator-writable permission levels. STRUCTURAL slots exist in the manifest so
 * the runtime can describe itself honestly, but the automatic theme generator is
 * forbidden from targeting them (engineering spec §4.3 / §25).
 */
const GENERATOR_PERMISSIONS = Object.freeze([PERMISSION.SAFE, PERMISSION.STYLE])

/**
 * The four Theme Surfaces (Update-Plan/General-Theme.md 任务 1).
 *
 * Declared here — the contract layer — because they are part of the Theme API
 * vocabulary, exactly like slots and tokens. `surface.js` owns the behaviour
 * (permissions, the write gate, the layout vocabulary); this file owns the names,
 * so a theme package that declares a surface is validated against the same
 * constant the runtime paints.
 */
const SURFACE = Object.freeze({
  HNS_NATIVE: 'hns_native',
  OFFICIAL_SHELL: 'official_shell',
  OFFICIAL_OVERLAY: 'official_overlay',
  OFFICIAL_RENDERER: 'official_renderer'
})

/** How much of a surface the theme system may write. */
const SURFACE_PERMISSION = Object.freeze({
  FULL: 'full',
  VISUAL_ONLY: 'visual-only',
  PROTECTED: 'protected'
})

/** The official renderer is never writable by any theme writer. */
const PROTECTED_SURFACES = Object.freeze([SURFACE.OFFICIAL_RENDERER])

/** Property categories understood by the builder. */
const PROPERTY_KIND = Object.freeze({
  COLOR: 'color',
  LENGTH: 'length',
  NUMBER: 'number',
  SHADOW: 'shadow',
  FONT: 'font',
  ASSET: 'asset',
  ENUM: 'enum'
})

/**
 * Canonical HNS worker/process states. The theme may restyle them but must keep
 * them mutually distinguishable (HNS specialization §3).
 */
const HNS_STATES = Object.freeze([
  'idle',
  'running',
  'waiting',
  'blocked',
  'warning',
  'failed',
  'completed',
  'resource_limit',
  'primary_worker',
  'sub_worker'
])

/** Canonical HNS pages the UI inspector observes (HNS specialization §5). */
const HNS_PAGES = Object.freeze([
  { id: 'dashboard', name: 'Main Dashboard', surface: 'dock' },
  { id: 'worker', name: 'Worker View', surface: 'dock' },
  { id: 'process', name: 'Process View', surface: 'dock' },
  { id: 'hardware', name: 'Hardware Monitor', surface: 'dock' },
  { id: 'log', name: 'Log View', surface: 'dock' },
  { id: 'skills', name: 'Skills', surface: 'dock' },
  { id: 'settings', name: 'Settings', surface: 'dock' },
  { id: 'tray', name: 'Tray / Popup', surface: 'shell' },
  { id: 'official', name: 'Official Harness UI', surface: 'official' }
])

/**
 * Slot table. `type` describes what the runtime accepts, `permission` what the
 * generator is allowed to do, `properties` the writable property names.
 *
 * Naming is `<app>.<domain>.<component>[.<property>]`, where `<app>` is one of
 * `common`, `hns` (the hns_native surface) or `official` (the official_shell /
 * official_overlay surfaces, plus the protected official_renderer slots that are
 * described only).
 */
const SLOTS = Object.freeze({
  // ---- common / generic slots (THEME_INTERFACE_SPEC §3) ----
  'common.window.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'common.window.overlay': slot('image_or_color', PERMISSION.STYLE, ['background', 'opacity', 'blur', 'blend']),
  'common.navigation.sidebar': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius']),
  'common.navigation.topbar': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'label']),
  'common.panel.background': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow']),
  'common.panel.border': slot('color', PERMISSION.SAFE, ['border']),
  'common.button.primary': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'shadow', 'glow']),
  'common.button.secondary': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'common.input.default': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'placeholder']),
  'common.dialog.default': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'overlay']),
  'common.notification.default': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'label', 'radius']),
  'common.status.success': slot('color', PERMISSION.SAFE, ['color']),
  'common.status.warning': slot('color', PERMISSION.SAFE, ['color']),
  'common.status.error': slot('color', PERMISSION.SAFE, ['color']),
  'common.tooltip.default': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'common.scrollbar.default': slot('component_style', PERMISSION.SAFE, ['thumb', 'track', 'width']),

  // ---- HNS dock shell (the themable HNS product surface) ----
  'hns.window.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'hns.window.overlay': slot('image_or_color', PERMISSION.STYLE, ['background', 'opacity', 'blur', 'blend']),
  'hns.window.shell': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'hns.worker.card': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'label']),
  'hns.worker.header': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border']),
  'hns.worker.status': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'color']),
  'hns.process.panel': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow']),
  'hns.process.queue': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'label']),
  'hns.hardware.cpu': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'hns.hardware.gpu': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'hns.hardware.memory': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'hns.hardware.power': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'color']),
  'hns.log.panel': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'label']),
  'hns.log.level': slot('component_style', PERMISSION.SAFE, ['color', 'label', 'weight']),
  'hns.status.badge': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'hns.tray.icon': slot('asset_ref', PERMISSION.SAFE, ['asset']),
  'hns.operator.avatar': slot('asset_ref', PERMISSION.SAFE, ['asset', 'size']),
  'hns.operator.widget': slot('component_style', PERMISSION.STYLE, ['background', 'opacity', 'position', 'size', 'animation']),

  // ---- skills management surface ----
  'hns.skill.card': slot('component_style', PERMISSION.SAFE, ['background', 'border', 'radius', 'shadow', 'label']),
  'hns.skill.header': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border']),
  'hns.skill.badge': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'hns.skill.tag': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius']),
  'hns.skill.search': slot('component_style', PERMISSION.SAFE, ['background', 'label', 'border', 'radius', 'placeholder']),
  'hns.skill.danger': slot('color', PERMISSION.SAFE, ['color']),

  // ---- persona layer ----
  'hns.persona.banner': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'height']),
  'hns.persona.status_avatar': slot('asset_ref', PERMISSION.STYLE, ['asset', 'size', 'position']),
  'hns.persona.decoration': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'animation', 'position']),
  // The HNS surface's real character asset (Update-Plan 任务 5): a transparent
  // bust / half body / full body placed by the layout engine, not the small
  // abstract avatar of the persona layer.
  'hns.character.primary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),

  // ---- official shell surface (our own frame around the official renderer) ----
  'official.shell.background': slot('image_or_color', PERMISSION.SAFE, ['background', 'overlay']),
  'official.shell.border': slot('component_style', PERMISSION.SAFE, ['border', 'radius']),
  'official.shell.radius': slot('component_style', PERMISSION.SAFE, ['radius', 'background']),
  'official.shell.shadow': slot('component_style', PERMISSION.STYLE, ['shadow', 'background']),
  'official.shell.separator': slot('component_style', PERMISSION.SAFE, ['border', 'color']),
  'official.shell.frame': slot('component_style', PERMISSION.STYLE, ['border', 'radius', 'padding', 'shadow', 'background']),
  'official.shell.padding': slot('component_style', PERMISSION.SAFE, ['padding', 'background']),

  // ---- official overlay surface (visual-only layer above the renderer) ----
  'official.overlay.global_tint': slot('image_or_color', PERMISSION.STYLE, ['color', 'opacity', 'blend']),
  'official.overlay.gradient': slot('component_style', PERMISSION.STYLE, ['angle', 'stops', 'opacity']),
  'official.overlay.texture': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'scale', 'blend', 'tile']),
  'official.overlay.skin': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'blend', 'layout', 'inset']),
  'official.overlay.vignette': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'size']),
  'official.overlay.scanline': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'spacing', 'width']),
  'official.overlay.frame_glow': slot('component_style', PERMISSION.STYLE, ['opacity', 'color', 'glow', 'width']),
  'official.overlay.corner_decoration': slot('image_or_color', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor']),
  'official.overlay.character_primary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),
  'official.overlay.character_secondary': slot('asset_ref', PERMISSION.STYLE, ['asset', 'opacity', 'position', 'scale', 'anchor', 'crop', 'layout']),

  // ---- protected official renderer: described, never written ----
  'official.renderer.dom': slot('struct', PERMISSION.STRUCTURAL, []),
  'official.renderer.stylesheet': slot('struct', PERMISSION.STRUCTURAL, []),
  'official.renderer.script': slot('struct', PERMISSION.STRUCTURAL, []),
  'official.renderer.events': slot('struct', PERMISSION.STRUCTURAL, []),
  // ---- structural slots: described, never generated ----
  'hns.layout.dock_width': slot('struct', PERMISSION.STRUCTURAL, []),
  'hns.layout.navigation_hierarchy': slot('struct', PERMISSION.STRUCTURAL, []),
  'hns.layout.critical_button_position': slot('struct', PERMISSION.STRUCTURAL, []),
  'hns.layout.information_hierarchy': slot('struct', PERMISSION.STRUCTURAL, [])
})

function slot(type, permission, properties) {
  return Object.freeze({
    type,
    permission,
    properties: Object.freeze(properties.slice())
  })
}

/** Slot id list, stable order. */
const SLOT_IDS = Object.freeze(Object.keys(SLOTS))

/**
 * Motion presets. The engine clamps intensity; a theme can never request a
 * custom easing/keyframe payload (spec §20).
 */
const ANIMATION_PRESETS = Object.freeze(['none', 'fade', 'pulse', 'glow', 'slide', 'soft_blur'])

/** Maximum accepted animation intensity per preset. */
const ANIMATION_MAX_INTENSITY = Object.freeze({
  none: 0,
  fade: 0.6,
  pulse: 0.5,
  glow: 0.6,
  slide: 0.4,
  soft_blur: 0.35
})

/**
 * Token schema. Each entry maps a semantic token name to:
 *   css     — the CSS custom property the runtime binds it to
 *   kind    — validation kind
 *   group   — token group used by the builder/validator
 *   fallback— the Dark value used whenever a theme omits the token
 */
const TOKENS = Object.freeze({
  'color.bg.base': token('--hns-color-bg-base', PROPERTY_KIND.COLOR, 'color', '#0f1115'),
  'color.bg.layer1': token('--hns-color-bg-layer1', PROPERTY_KIND.COLOR, 'color', '#151922'),
  'color.bg.layer2': token('--hns-color-bg-layer2', PROPERTY_KIND.COLOR, 'color', '#1b2130'),
  'color.bg.overlay': token('--hns-color-bg-overlay', PROPERTY_KIND.COLOR, 'color', '#0b0d12'),
  'color.bg.raised': token('--hns-color-bg-raised', PROPERTY_KIND.COLOR, 'color', '#222a3a'),
  'color.label.primary': token('--hns-color-label-primary', PROPERTY_KIND.COLOR, 'color', '#e8ecf3'),
  'color.label.secondary': token('--hns-color-label-secondary', PROPERTY_KIND.COLOR, 'color', '#a7b1c2'),
  'color.label.tertiary': token('--hns-color-label-tertiary', PROPERTY_KIND.COLOR, 'color', '#7b8698'),
  'color.label.inverse': token('--hns-color-label-inverse', PROPERTY_KIND.COLOR, 'color', '#0d1016'),
  'color.border.l1': token('--hns-color-border-l1', PROPERTY_KIND.COLOR, 'color', '#232b3b'),
  'color.border.l2': token('--hns-color-border-l2', PROPERTY_KIND.COLOR, 'color', '#2f3a4e'),
  'color.accent.primary': token('--hns-color-accent-primary', PROPERTY_KIND.COLOR, 'color', '#4d93f8'),
  'color.accent.secondary': token('--hns-color-accent-secondary', PROPERTY_KIND.COLOR, 'color', '#7aa7ff'),
  'color.accent.contrast': token('--hns-color-accent-contrast', PROPERTY_KIND.COLOR, 'color', '#0d1016'),
  'color.accent.subtle': token('--hns-color-accent-subtle', PROPERTY_KIND.COLOR, 'color', '#1a2740'),

  'state.idle': token('--hns-state-idle', PROPERTY_KIND.COLOR, 'state', '#8b93a1'),
  'state.running': token('--hns-state-running', PROPERTY_KIND.COLOR, 'state', '#4d93f8'),
  'state.waiting': token('--hns-state-waiting', PROPERTY_KIND.COLOR, 'state', '#c9a227'),
  'state.blocked': token('--hns-state-blocked', PROPERTY_KIND.COLOR, 'state', '#b06bd6'),
  'state.warning': token('--hns-state-warning', PROPERTY_KIND.COLOR, 'state', '#f0a63a'),
  'state.failed': token('--hns-state-failed', PROPERTY_KIND.COLOR, 'state', '#ef5d5d'),
  'state.completed': token('--hns-state-completed', PROPERTY_KIND.COLOR, 'state', '#3fbf7f'),
  'state.resource_limit': token('--hns-state-resource-limit', PROPERTY_KIND.COLOR, 'state', '#d9553f'),
  'state.primary_worker': token('--hns-state-primary-worker', PROPERTY_KIND.COLOR, 'state', '#4ea8de'),
  'state.sub_worker': token('--hns-state-sub-worker', PROPERTY_KIND.COLOR, 'state', '#6fa8a0'),

  'font.family': token('--hns-font-family', PROPERTY_KIND.FONT, 'typography', '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'),
  'font.family.mono': token('--hns-font-family-mono', PROPERTY_KIND.FONT, 'typography', 'Consolas, "SF Mono", monospace'),
  'font.size.body': token('--hns-font-size-body', PROPERTY_KIND.LENGTH, 'typography', '13px'),
  'font.size.caption': token('--hns-font-size-caption', PROPERTY_KIND.LENGTH, 'typography', '11px'),
  'font.size.title': token('--hns-font-size-title', PROPERTY_KIND.LENGTH, 'typography', '16px'),
  'font.weight.body': token('--hns-font-weight-body', PROPERTY_KIND.NUMBER, 'typography', '400'),
  'font.weight.title': token('--hns-font-weight-title', PROPERTY_KIND.NUMBER, 'typography', '600'),

  'space.unit': token('--hns-space-unit', PROPERTY_KIND.LENGTH, 'spacing', '4px'),
  'space.gap': token('--hns-space-gap', PROPERTY_KIND.LENGTH, 'spacing', '8px'),
  'space.panel': token('--hns-space-panel', PROPERTY_KIND.LENGTH, 'spacing', '12px'),

  'radius.sm': token('--hns-radius-sm', PROPERTY_KIND.LENGTH, 'radius', '4px'),
  'radius.md': token('--hns-radius-md', PROPERTY_KIND.LENGTH, 'radius', '8px'),
  'radius.lg': token('--hns-radius-lg', PROPERTY_KIND.LENGTH, 'radius', '14px'),

  'shadow.l1': token('--hns-shadow-l1', PROPERTY_KIND.SHADOW, 'shadow', '0 1px 3px rgba(0,0,0,.4)'),
  'shadow.l2': token('--hns-shadow-l2', PROPERTY_KIND.SHADOW, 'shadow', '0 4px 14px rgba(0,0,0,.45)'),

  'opacity.panel': token('--hns-opacity-panel', PROPERTY_KIND.NUMBER, 'effect', '0.96'),
  'effect.blur': token('--hns-effect-blur', PROPERTY_KIND.LENGTH, 'effect', '0px'),
  'effect.glow': token('--hns-effect-glow', PROPERTY_KIND.NUMBER, 'effect', '0'),

  'asset.wallpaper': token('--hns-asset-wallpaper', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.overlay': token('--hns-asset-overlay', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.panel_texture': token('--hns-asset-panel-texture', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.icon_set': token('--hns-asset-icon-set', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.persona_avatar': token('--hns-asset-persona-avatar', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.persona_banner': token('--hns-asset-persona-banner', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.decoration': token('--hns-asset-decoration', PROPERTY_KIND.ASSET, 'asset', 'none'),

  // Real character / skin / decoration assets (Update-Plan 任务 5 + 任务 6).
  // `hns_character.*` paints on the HNS dock surface; `official_*` paints on the
  // official_overlay surface; nothing here can ever address official_renderer.
  'asset.hns_character': token('--hns-asset-hns-character', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.official_character': token('--hns-asset-official-character', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.official_character_secondary': token('--hns-asset-official-character-secondary', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.official_skin': token('--hns-asset-official-skin', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.official_overlay_texture': token('--hns-asset-official-overlay-texture', PROPERTY_KIND.ASSET, 'asset', 'none'),
  'asset.official_shell_frame': token('--hns-asset-official-shell-frame', PROPERTY_KIND.ASSET, 'asset', 'none'),

  // Official overlay effect strengths. Validated by the Overlay Safety validator
  // (任务 11) against the engineering limits; declared here so a package cannot
  // invent an effect the runtime does not know.
  'official.tint.opacity': token('--hns-official-tint-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.vignette.opacity': token('--hns-official-vignette-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.scanline.opacity': token('--hns-official-scanline-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.frame_glow.opacity': token('--hns-official-frame-glow-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.texture.opacity': token('--hns-official-texture-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.character.opacity': token('--hns-official-character-opacity', PROPERTY_KIND.NUMBER, 'effect', '0'),
  'official.character.coverage': token('--hns-official-character-coverage', PROPERTY_KIND.NUMBER, 'effect', '0'),

  // Official shell chrome strengths.
  'official.shell.padding': token('--hns-official-shell-padding', PROPERTY_KIND.LENGTH, 'spacing', '0px'),
  'official.shell.border_width': token('--hns-official-shell-border-width', PROPERTY_KIND.LENGTH, 'spacing', '0px'),
  'official.shell.radius': token('--hns-official-shell-radius', PROPERTY_KIND.LENGTH, 'radius', '0px')
})

function token(css, kind, group, fallback) {
  return Object.freeze({ css, kind, group, fallback })
}

const TOKEN_NAMES = Object.freeze(Object.keys(TOKENS))

/** Token groups, exposed for the builder and the UI. */
const TOKEN_GROUPS = Object.freeze(
  TOKEN_NAMES.reduce((acc, name) => {
    const group = TOKENS[name].group
    if (!acc[group]) acc[group] = []
    acc[group].push(name)
    return acc
  }, {})
)

/**
 * Pairs validated for readability. `min` is the minimum WCAG contrast ratio the
 * package validator enforces before a theme may be installed.
 *
 * Canonical state colours are deliberately absent: they are *swatches*, not
 * text, and forcing each of the ten onto a text-grade contrast ratio against the
 * surface is what would collapse them into two identical extremes. State
 * legibility is enforced instead by `STATE_VISIBILITY_MIN` (a swatch must be
 * visible at all) plus `STATE_MIN_DISTANCE` (states must stay distinguishable) —
 * see `validateReadability`.
 */
const CONTRAST_REQUIREMENTS = Object.freeze([
  { foreground: 'color.label.primary', background: 'color.bg.base', min: 4.5, label: 'primary label on base' },
  { foreground: 'color.label.primary', background: 'color.bg.layer1', min: 4.5, label: 'primary label on layer1' },
  { foreground: 'color.label.primary', background: 'color.bg.layer2', min: 4.5, label: 'primary label on layer2' },
  { foreground: 'color.label.secondary', background: 'color.bg.layer1', min: 3, label: 'secondary label on layer1' },
  { foreground: 'color.label.tertiary', background: 'color.bg.layer1', min: 2, label: 'tertiary label on layer1' },
  { foreground: 'color.label.inverse', background: 'color.accent.primary', min: 3, label: 'inverse label on accent' }
])

/**
 * Minimum contrast a state swatch needs against the content layer to be legible
 * at all. Well below the text threshold on purpose: the requirement is "you can
 * see the state", not "the state is body text".
 */
const STATE_VISIBILITY_MIN = 1.6

/** Minimum perceptual spacing required between two canonical state colours. */
const STATE_MIN_DISTANCE = 24

module.exports = {
  THEME_API_VERSION,
  THEME_API_MIN_SUPPORTED,
  SURFACE,
  SURFACE_PERMISSION,
  PROTECTED_SURFACES,
  PERMISSION,
  GENERATOR_PERMISSIONS,
  PROPERTY_KIND,
  HNS_STATES,
  HNS_PAGES,
  SLOTS,
  SLOT_IDS,
  ANIMATION_PRESETS,
  ANIMATION_MAX_INTENSITY,
  TOKENS,
  TOKEN_NAMES,
  TOKEN_GROUPS,
  CONTRAST_REQUIREMENTS,
  STATE_VISIBILITY_MIN,
  STATE_MIN_DISTANCE
}
