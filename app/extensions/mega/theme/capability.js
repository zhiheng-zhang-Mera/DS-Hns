'use strict'

/**
 * Theme Capability Manifest.
 *
 * The manifest is what the theme generator is allowed to believe about the app
 * (engineering spec §5). It is produced dynamically, every time a theme is
 * designed, so a prompt can never target a slot the running program does not
 * actually expose.
 *
 * For HNS the manifest is honest about a deliberate architectural boundary:
 *   - `surface: "dock"`      the HNS dock (`app/extensions/mega/ui`) is fully
 *                            themable — it is our own renderer and stylesheets.
 *   - `surface: "shell"`     the Electron shell chrome (tray icon) is themable
 *                            through a declared asset slot.
 *   - `surface: "official"`  the official `@deepseek-ai/dsh` Web UI is owned by
 *                            the harness, and DS-Hns is contractually forbidden
 *                            from injecting CSS/JS into it (see README
 *                            "Black-screen protection rules" #2). It is exposed
 *                            read-only: the theme system may only carry a
 *                            `light`/`dark` palette hint, which the official
 *                            client applies through its own settings.
 */
const contract = require('./contract')

/** Which product surfaces this build can actually theme. */
const SURFACES = Object.freeze({
  dock: {
    id: 'dock',
    themable: true,
    description: 'HNS Mega dock renderer (own stylesheets, own CSP)',
    renderer: 'app/extensions/mega/ui/dock.html'
  },
  shell: {
    id: 'shell',
    themable: true,
    description: 'Electron shell chrome (tray icon)',
    renderer: 'app/desktop-main.cjs'
  },
  official: {
    id: 'official',
    themable: false,
    description: 'Official @deepseek-ai/dsh Web UI — owned by the harness; DS-Hns must not inject styles or scripts',
    paletteHintOnly: true
  }
})

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
  'common.button.primary': 'settings',
  'common.button.secondary': 'settings',
  'common.input.default': 'settings',
  'common.dialog.default': 'settings',
  'common.notification.default': 'dashboard',
  'common.tooltip.default': 'dashboard',
  'common.scrollbar.default': 'log',
  'hns.tray.icon': 'tray'
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
      surface: slotId.startsWith('hns.tray') ? 'shell' : 'dock'
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
      can_theme_official_ui: false,
      official_ui_palette_hint: ['light', 'dark'],
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
  SLOT_PAGES,
  PROTECTED_REGIONS,
  slotPage,
  buildManifest,
  writableSlots,
  structuralSlots
}
