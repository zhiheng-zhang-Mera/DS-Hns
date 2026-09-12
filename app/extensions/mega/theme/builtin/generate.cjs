'use strict'
/**
 * One-shot generator for the built-in HNS theme packages.
 *
 * Run from `app/`:
 *   node extensions/mega/theme/builtin/generate.cjs
 *
 * The built-in packages are committed as real, self-contained directories. This
 * script only regenerates them when the system palettes change; the runtime
 * never depends on it.
 */
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const contract = require('../contract')

function write(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function manifest(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    author: overrides.author || 'HNS Theme Engine',
    version: '1.0.0',
    source: overrides.source,
    protected: overrides.protected === true,
    deletable: overrides.protected !== true,
    editable: false,
    system_theme: overrides.source === 'system',
    theme_api_version: contract.THEME_API_VERSION,
    supported_apps: ['hns'],
    required_theme_api: '>=1.0',
    created_at: '2026-09-11T00:00:00.000Z',
    generated_prompt: overrides.generated_prompt || null,
    revision_history: [],
    derived_from: null,
    official_palette: overrides.official_palette || 'dark',
    animation: overrides.animation || { type: 'none', intensity: 0 },
    preview: null
  }
}

/** Shared slot payload builder so every built-in theme stays structurally identical. */
function slotMap(options) {
  const {
    label, secondary, tertiary, border, accent, accentContrast,
    layer1, layer2, panelOpacity, blur, glow, radius
  } = options
  return {
    'common.window.background': { background: layer1, overlay: 'none' },
    'common.navigation.sidebar': { background: layer2, border, radius },
    'common.navigation.topbar': { background: layer1, border, label },
    'common.panel.background': { background: layer1, border, radius, shadow: 'var(--hns-shadow-l2)' },
    'common.panel.border': { border },
    'common.button.primary': { background: accent, label: accentContrast, radius, glow },
    'common.button.secondary': { background: layer2, label: secondary, border, radius },
    'common.input.default': { background: layer2, label, border, radius, placeholder: tertiary },
    'common.dialog.default': { background: layer1, border, radius, overlay: 'none' },
    'common.notification.default': { background: layer2, border, label, radius },
    'common.tooltip.default': { background: layer2, label, border, radius },
    'common.scrollbar.default': { thumb: border, track: 'transparent', width: '8px' },
    'hns.window.shell': { background: layer1, label, border, radius },
    'hns.window.background': { background: 'var(--hns-asset-wallpaper)', overlay: 'none' },
    'hns.window.overlay': { background: 'var(--hns-asset-overlay)', opacity: panelOpacity, blur, blend: 'normal' },
    'hns.worker.card': { background: layer1, border, radius, shadow: 'var(--hns-shadow-l1)', label },
    'hns.worker.header': { background: layer2, label, border },
    'hns.worker.status': { background: 'transparent', label: secondary, border },
    'hns.process.panel': { background: layer1, border, radius, shadow: 'var(--hns-shadow-l1)' },
    'hns.process.queue': { background: layer2, border, radius, label },
    'hns.hardware.cpu': { background: 'transparent', label: secondary, color: accent },
    'hns.hardware.gpu': { background: 'transparent', label: secondary, color: accent },
    'hns.hardware.memory': { background: 'transparent', label: secondary, color: accent },
    'hns.hardware.power': { background: 'transparent', label: secondary, color: 'var(--hns-state-warning)' },
    'hns.log.panel': { background: layer1, border, radius, label },
    'hns.log.level': { color: secondary, label: secondary, weight: '500' },
    'hns.status.badge': { background: layer2, label, border, radius },
    // Skills management surface. The system themes style it from their own tokens so
    // the panel is themed without the theme having to know it exists.
    'hns.skill.card': { background: layer1, border, radius, shadow: 'none', label },
    'hns.skill.header': { background: layer2, label, border },
    'hns.skill.badge': { background: layer2, label: secondary, border, radius },
    'hns.skill.tag': { background: 'var(--hns-color-accent-subtle)', label: secondary, border, radius: '999px' },
    'hns.skill.search': { background: layer2, label, border, radius, placeholder: tertiary },
    'hns.skill.danger': { color: 'var(--hns-state-failed)' },
    // System themes are deliberately asset-free: they are the flat, always-working
    // baseline, so every asset slot declares `none` instead of a missing file.
    'hns.tray.icon': { asset: 'none' },
    'hns.operator.avatar': { asset: 'none', size: '24px' },
    'hns.operator.widget': { background: layer2, opacity: 0, position: 'corner-bottom-right', size: 'compact', animation: 'none' },
    'hns.persona.banner': { asset: 'none', opacity: 0, position: 'top', height: '0px' },
    'hns.persona.status_avatar': { asset: 'none', size: '24px', position: 'top-right' },
    'hns.persona.decoration': { asset: 'none', opacity: 0, animation: 'none', position: 'corners' }
  }
}

/** System-theme slot map: every value references the theme's own tokens. */
function systemComponents(panelOpacity) {
  const slots = slotMap({
    label: 'var(--hns-color-label-primary)',
    secondary: 'var(--hns-color-label-secondary)',
    tertiary: 'var(--hns-color-label-tertiary)',
    border: '1px solid var(--hns-color-border-l1)',
    accent: 'var(--hns-color-accent-primary)',
    accentContrast: 'var(--hns-color-accent-contrast)',
    layer1: 'var(--hns-color-bg-layer1)',
    layer2: 'var(--hns-color-bg-layer2)',
    panelOpacity,
    blur: '0px',
    glow: '0',
    radius: 'var(--hns-radius-md)'
  })
  return { slots, animation: { type: 'none', intensity: 0 } }
}

const COMMON_TOKENS = {
  'font.family': '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  'font.family.mono': 'Consolas, "SF Mono", "JetBrains Mono", monospace',
  'font.size.body': '13px',
  'font.size.caption': '11px',
  'font.size.title': '16px',
  'font.weight.body': '400',
  'font.weight.title': '600',
  'space.unit': '4px',
  'space.gap': '8px',
  'space.panel': '12px',
  'radius.sm': '4px',
  'radius.md': '8px',
  'radius.lg': '14px'
}

const DARK_TOKENS = {
  ...COMMON_TOKENS,
  'color.bg.base': '#0f1115',
  'color.bg.layer1': '#151922',
  'color.bg.layer2': '#1b2130',
  'color.bg.overlay': '#0b0d12',
  'color.bg.raised': '#232c3d',
  'color.label.primary': '#e8ecf3',
  'color.label.secondary': '#a7b1c2',
  'color.label.tertiary': '#7b8698',
  'color.label.inverse': '#0d1016',
  'color.border.l1': '#252d3d',
  'color.border.l2': '#33405a',
  'color.accent.primary': '#4d93f8',
  'color.accent.secondary': '#7aa7ff',
  'color.accent.contrast': '#0d1016',
  'color.accent.subtle': '#1a2740',
  'state.idle': '#8b93a1',
  'state.running': '#4d93f8',
  'state.waiting': '#c9a227',
  'state.blocked': '#b06bd6',
  'state.warning': '#f0a63a',
  'state.failed': '#ef5d5d',
  'state.completed': '#3fbf7f',
  'state.resource_limit': '#d9553f',
  'state.primary_worker': '#4ea8de',
  'state.sub_worker': '#6fa8a0',
  'shadow.l1': '0 1px 3px rgba(0,0,0,.42)',
  'shadow.l2': '0 6px 18px rgba(0,0,0,.5)',
  'opacity.panel': '0.97',
  'effect.blur': '0px',
  'effect.glow': '0'
}

const LIGHT_TOKENS = {
  ...COMMON_TOKENS,
  'color.bg.base': '#f7f8fa',
  'color.bg.layer1': '#ffffff',
  'color.bg.layer2': '#eff2f6',
  'color.bg.overlay': '#e7ebf1',
  'color.bg.raised': '#ffffff',
  'color.label.primary': '#1b2027',
  'color.label.secondary': '#525b68',
  'color.label.tertiary': '#79828f',
  'color.label.inverse': '#ffffff',
  'color.border.l1': '#dfe4ec',
  'color.border.l2': '#c6cedb',
  'color.accent.primary': '#2f6fe0',
  'color.accent.secondary': '#4a86ea',
  'color.accent.contrast': '#ffffff',
  'color.accent.subtle': '#e8eefb',
  'state.idle': '#8a929f',
  'state.running': '#2f6fe0',
  'state.waiting': '#a07a10',
  'state.blocked': '#8646b8',
  'state.warning': '#c47a10',
  'state.failed': '#c0392b',
  'state.completed': '#1f8a53',
  'state.resource_limit': '#a83a24',
  'state.primary_worker': '#1f7fa8',
  'state.sub_worker': '#3f7d74',
  'shadow.l1': '0 1px 2px rgba(16,24,40,.08)',
  'shadow.l2': '0 6px 18px rgba(16,24,40,.12)',
  'opacity.panel': '1',
  'effect.blur': '0px',
  'effect.glow': '0'
}

const THEMES = [
  {
    dir: path.join(HERE, 'system', 'dark'),
    manifest: manifest({
      id: 'hns.system.dark',
      name: 'Dark',
      source: 'system',
      protected: true,
      official_palette: 'dark'
    }),
    tokens: DARK_TOKENS,
    components: systemComponents(0.97),
    note: 'System theme. `protected = true`, `deletable = false`, `editable = false`.\nDark is also the global last-resort fallback for the whole theme engine.'
  },
  {
    dir: path.join(HERE, 'system', 'light'),
    manifest: manifest({
      id: 'hns.system.light',
      name: 'Light',
      source: 'system',
      protected: true,
      official_palette: 'light'
    }),
    tokens: LIGHT_TOKENS,
    components: systemComponents(1),
    note: 'System theme. `protected = true`, `deletable = false`, `editable = false`.\nThe engine keeps Light permanently available next to Dark.'
  }
]

for (const theme of THEMES) {
  write(theme.dir, 'manifest.json', theme.manifest)
  write(theme.dir, 'tokens.json', theme.tokens)
  write(theme.dir, 'components.json', theme.components)
  write(theme.dir, 'persona.json', {
    enabled: false,
    prominence: 0,
    character: null,
    states: {},
    occludes: [],
    overlay_main: false,
    sounds: []
  })
  write(theme.dir, 'README.md', `# ${theme.manifest.name} (built-in, protected)\n\n${theme.note}\n`)
  // System themes are deliberately asset-free: they are the flat, always-working
  // baseline, and the runtime resolves any declared-but-absent asset to `none`.
  fs.mkdirSync(path.join(theme.dir, 'assets'), { recursive: true })
  console.log(`wrote ${theme.manifest.id} -> ${theme.dir}`)
}
