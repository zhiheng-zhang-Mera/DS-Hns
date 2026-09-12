'use strict'

/**
 * Theme Capability Manifest.
 *
 * The manifest is what the theme generator is allowed to believe about the app
 * (engineering spec §5). It is produced dynamically, every time a theme is
 * designed, so a prompt can never target a slot the running program does not
 * actually expose.
 *
 * For HNS the manifest is honest about a deliberate architectural boundary. The
 * four Theme Surfaces (Update-Plan/General-Theme.md 任务 1) replace the old
 * dock/shell/official triple, and each one declares its own permission:
 *
 *   hns_native        `full`        the HNS dock (`app/extensions/mega/ui`) —
 *                                   our own renderer, our own stylesheets.
 *   official_shell    `full`        the frame DS-Hns draws around the official
 *                                   renderer, as its own WebContentsView.
 *   official_overlay  `visual-only` a transparent WebContentsView above the
 *                                   official renderer: paint only, never input.
 *   official_renderer `protected`   the official `@deepseek-ai/dsh` WebContentsView
 *                                   is owned by the harness, and DS-Hns is
 *                                   contractually forbidden from injecting CSS, JS,
 *                                   scripts or selectors into it (see README
 *                                   "Black-screen protection rules" #2). It is
 *                                   exposed read-only: the theme system may carry a
 *                                   `light`/`dark` palette hint, which the official
 *                                   client applies through its own settings, and
 *                                   nothing else.
 */
const contract = require('./contract')
const surface = require('./surface')

/** Every asset kind the generator can produce, as a plain id list. */
const ASSET_KIND_NAMES = Object.freeze([
  'wallpaper',
  'panel_texture',
  'icon_set',
  'persona_avatar',
  'hns_character',
  'official_character',
  'official_skin',
  'official_overlay_texture',
  'hud_decoration',
  'frame_decoration'
])

/**
 * Overlay safety ceilings, declared here so the capability manifest can publish
 * them without importing the validator that enforces them (which would make the
 * manifest depend on the overlay subsystem it is supposed to describe).
 * `official/overlay-safety.js` holds the same numbers as its LIMITS table and a
 * test asserts the two agree.
 */
const OFFICIAL_OVERLAY_LIMITS = Object.freeze({
  overlay_opacity: 0.22,
  vignette: 0.15,
  scanline: 0.05,
  character_coverage: 0.22,
  critical_overlap: 0.08
})

/** Which product surfaces this build can actually theme. */
const SURFACES = Object.freeze(Object.fromEntries(
  surface.SURFACE_LIST.map((entry) => {
    const copy = {
      id: entry.id,
      label: entry.label,
      permission: entry.permission,
      themable: entry.writable,
      writable: entry.writable,
      assetWritable: entry.assetWritable,
      protected: entry.protected,
      visualOnly: entry.visualOnly,
      interactive: entry.interactive,
      owner: entry.owner,
      description: entry.description
    }
    if (entry.id === contract.SURFACE.OFFICIAL_RENDERER) {
      // Kept for the clients that only ever asked the palette question.
      copy.paletteHintOnly = true
      copy.hint = true
    }
    return [entry.id, copy]
  })
))

/** Slot id -> page id mapping used by the UI inspector and the snapshot package. */
const SLOT_PAGES = Object.freeze({
  'common.window.background': 'dashboard',
  'hns.window.background': 'dashboard',
  'hns.window.overlay': 'dashboard',
  'hns.window.shell': 'dashboard',
  'common.navigation.sidebar': 'dashboard',
  'common.navigation.topbar': 'dashboard',
  'common.panel.background': 'dashboard',
  'common.panel.border': 'dashboard',
  'hns.worker.card': 'worker',
  'hns.worker.header': 'worker',
  'hns.worker.status': 'worker',
  'hns.operator.avatar': 'worker',
  'hns.operator.widget': 'worker',
  'hns.persona.banner': 'worker',
  'hns.persona.status_avatar': 'worker',
  'hns.persona.decoration': 'dashboard',
  'hns.process.panel': 'process',
  'hns.process.queue': 'process',
  'hns.hardware.cpu': 'hardware',
  'hns.hardware.gpu': 'hardware',
  'hns.hardware.memory': 'hardware',
  'hns.hardware.power': 'hardware',
  'hns.log.panel': 'log',
  'hns.log.level': 'log',
  'hns.status.badge': 'dashboard',
  'hns.skill.card': 'skills',
  'hns.skill.header': 'skills',
  'hns.skill.badge': 'skills',
  'hns.skill.tag': 'skills',
  'hns.skill.search': 'skills',
  'hns.skill.danger': 'skills',
  'common.button.primary': 'settings',
  'common.button.secondary': 'settings',
  'common.input.default': 'settings',
  'common.dialog.default': 'settings',
  'common.notification.default': 'dashboard',
  'common.tooltip.default': 'dashboard',
  'common.scrollbar.default': 'log',
  'hns.tray.icon': 'tray',
  'hns.character.primary': 'dashboard',
  // Official surfaces. The shell and overlay pages are their own observations: the
  // theme system paints them, so it must be able to report their geometry, while
  // the official renderer's page stays read-only (it is never captured).
  'official.shell.background': 'official',
  'official.shell.border': 'official',
  'official.shell.radius': 'official',
  'official.shell.shadow': 'official',
  'official.shell.separator': 'official',
  'official.shell.frame': 'official',
  'official.shell.padding': 'official',
  'official.overlay.global_tint': 'official',
  'official.overlay.gradient': 'official',
  'official.overlay.texture': 'official',
  'official.overlay.skin': 'official',
  'official.overlay.vignette': 'official',
  'official.overlay.scanline': 'official',
  'official.overlay.frame_glow': 'official',
  'official.overlay.corner_decoration': 'official',
  'official.overlay.character_primary': 'official',
  'official.overlay.character_secondary': 'official',
  'official.renderer.dom': 'official',
  'official.renderer.stylesheet': 'official',
  'official.renderer.script': 'official',
  'official.renderer.events': 'official'
})

/**
 * Regions that a theme must never obscure. Consumed by the preview validator
 * (`criticalRegions`) and by the persona rules.
 */
const PROTECTED_REGIONS = Object.freeze([
  { id: 'queue-create', label: 'task creation form', page: 'process', critical: true },
  { id: 'queue-list', label: 'manual queue list', page: 'process', critical: true },
  { id: 'worker-summary', label: 'worker/process summary', page: 'dashboard', critical: true },
  { id: 'hardware-grid', label: 'hardware monitor grid', page: 'hardware', critical: true },
  { id: 'status-strip', label: 'state badges', page: 'dashboard', critical: true },
  { id: 'skills-search', label: 'skill search box', page: 'skills', critical: true },
  { id: 'skills-list', label: 'installed skill list', page: 'skills', critical: true },
  { id: 'settings-form', label: 'settings controls', page: 'settings', critical: false }
])

function slotPage(slotId) {
  return SLOT_PAGES[slotId] || 'dashboard'
}

/**
 * Build the capability manifest.
 *
 * @param {object} options
 * @param {object} [options.dockState]   live dock geometry/state, when known
 * @param {object} [options.pages]       observed page list (from the inspector)
 * @param {object} [options.load]        current load snapshot (degrades effects)
 */
function buildManifest({ dockState = null, pages = null, load = null, engineVersion = null } = {}) {
  const slots = {}
  for (const slotId of contract.SLOT_IDS) {
    const definition = contract.SLOTS[slotId]
    slots[slotId] = {
      type: definition.type,
      permission: definition.permission,
      properties: definition.properties.slice(),
      page: slotPage(slotId),
      // The surface is derived from the slot's own family, so the manifest and the
      // package validator can never disagree about what a slot addresses.
      surface: surface.surfaceOfSlot(slotId)
    }
  }

  const observedPages = new Map((pages || []).map((page) => [page.id, page]))
  const pageList = contract.HNS_PAGES.map((page) => {
    const observed = observedPages.get(page.id)
    return {
      id: page.id,
      name: page.name,
      surface: page.surface,
      enabled: page.surface === 'official' ? true : observed ? observed.enabled !== false : true,
      observed: Boolean(observed),
      slots: contract.SLOT_IDS.filter((slotId) => slotPage(slotId) === page.id)
    }
  })

  return {
    app: 'hns',
    app_version: engineVersion || null,
    theme_api_version: contract.THEME_API_VERSION,
    generated_at: new Date().toISOString(),
    themeable_surfaces: Object.values(SURFACES),
    capabilities: {
      custom_icons: true,
      persona: true,
      persona_max_prominence: 0.4,
      layout_override: false,
      assets: ['image/png', 'data-uri'],
      animations: contract.ANIMATION_PRESETS.slice(),
      animation_max_intensity: { ...contract.ANIMATION_MAX_INTENSITY },
      // The official renderer is never themed; the surfaces *around* and *above*
      // it are, which is a different statement from "the official UI is themable".
      can_theme_official_ui: false,
      can_theme_official_shell: true,
      can_theme_official_overlay: true,
      official_overlay_visual_only: true,
      official_overlay_input: { pointer: 'passthrough', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' },
      official_ui_palette_hint: ['light', 'dark'],
      // Published as plain strings so this descriptor does not pull the whole
      // asset pipeline (and its generators) into every manifest build.
      character_framings: ['avatar', 'bust', 'half_body', 'full_body', 'silhouette'],
      asset_kinds: ASSET_KIND_NAMES,
      real_assets: true,
      overlay_limits: { ...OFFICIAL_OVERLAY_LIMITS },
      max_package_bytes: 24 * 1024 * 1024
    },
    states: contract.HNS_STATES.slice(),
    protected_regions: PROTECTED_REGIONS.map((region) => ({ ...region })),
    pages: pageList,
    slots,
    surfaces: Object.fromEntries(Object.entries(SURFACES).map(([key, value]) => [key, { ...value }])),
    dock: dockState ? { ...dockState } : null,
    load: load ? { ...load } : null
  }
}

/** Generator-writable slot ids. */
function writableSlots() {
  return contract.SLOT_IDS.filter((slotId) => contract.GENERATOR_PERMISSIONS.includes(contract.SLOTS[slotId].permission))
}

/** Structural slot ids: described by the manifest, never generated. */
function structuralSlots() {
  return contract.SLOT_IDS.filter((slotId) => contract.SLOTS[slotId].permission === contract.PERMISSION.STRUCTURAL)
}

module.exports = {
  SURFACES,
  OFFICIAL_OVERLAY_LIMITS,
  SLOT_PAGES,
  PROTECTED_REGIONS,
  slotPage,
  buildManifest,
  writableSlots,
  structuralSlots
}
