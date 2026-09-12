'use strict'

/**
 * UI Inspector + Visual Snapshot Service.
 *
 * The theme generator is required to observe the real UI before it may design
 * anything (engineering spec §1.3 / §6): structure from the live Theme API
 * surface, plus a visual snapshot of the running dock, mapped back to slots.
 *
 * The user is never asked to take a screenshot. When the dock cannot be captured
 * (headless tests, dock disabled, capture failure) the snapshot degrades to a
 * structure-only package with an explicit `visual: false` flag — a missing
 * screenshot never blocks a design, and never fakes one.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const capability = require('./capability')

const SNAPSHOT_VERSION = 1

function sanitizeThemeInfo(theme) {
  if (!theme) return null
  return {
    id: theme.id,
    name: theme.manifest?.name || theme.id,
    source: theme.manifest?.source || null,
    protected: Boolean(theme.manifest?.protected),
    theme_api_version: theme.manifest?.theme_api_version || null,
    official_palette: theme.manifest?.official_palette || null,
    token_count: theme.tokens ? Object.keys(theme.tokens).length : 0,
    slot_count: theme.components?.slots ? Object.keys(theme.components.slots).length : 0
  }
}

/**
 * Structure observation: what the running program exposes right now.
 */
function observeStructure({ manifest, dockRegions = {}, componentTree = null } = {}) {
  const slots = {}
  for (const slotId of contract.SLOT_IDS) {
    const definition = contract.SLOTS[slotId]
    const region = dockRegions[slotId] || null
    slots[slotId] = {
      id: slotId,
      page: capability.slotPage(slotId),
      type: definition.type,
      permission: definition.permission,
      properties: definition.properties.slice(),
      present: Boolean(region) || definition.type === 'struct',
      boundingBox: region ? { ...region } : null
    }
  }
  return {
    apiVersion: contract.THEME_API_VERSION,
    slotCount: Object.keys(slots).length,
    writableSlotCount: capability.writableSlots().length,
    structuralSlotCount: capability.structuralSlots().length,
    slots,
    componentTree: componentTree || null,
    protectedRegions: capability.PROTECTED_REGIONS.map((region) => ({ ...region }))
  }
}

/**
 * Build the UI Snapshot Package (engineering spec §6.2).
 */
function buildSnapshotPackage({
  structure,
  screenshots = {},
  windowSize = null,
  currentTheme = null,
  dockState = null,
  manifest = null,
  capturedAt = null
} = {}) {
  const pages = contract.HNS_PAGES.map((page) => ({
    name: page.name,
    id: page.id,
    surface: page.surface,
    screenshot: screenshots[page.id] ? `snapshot/${screenshots[page.id]}` : null,
    observed: page.surface === 'official' ? false : Boolean(screenshots[page.id]) || page.surface === 'dock',
    note: page.surface === 'official'
      ? 'official UI is not captured: DS-Hns must not touch the official renderer'
      : null
  }))

  const visibleComponents = Object.values(structure?.slots || {})
    .filter((slot) => slot.present && slot.type !== 'struct')
    .map((slot) => ({ slot: slot.id, page: slot.page, type: slot.type, boundingBox: slot.boundingBox }))

  const occludedRegions = (structure?.protectedRegions || []).map((region) => ({
    id: region.id,
    label: region.label,
    page: region.page,
    critical: region.critical,
    boundingBox: region.boundingBox || null
  }))

  return {
    version: SNAPSHOT_VERSION,
    app: 'hns',
    captured_at: capturedAt || new Date().toISOString(),
    visual: Object.keys(screenshots).length > 0,
    window: windowSize ? { width: windowSize[0], height: windowSize[1] } : null,
    dock: dockState ? { ...dockState } : null,
    pages,
    screenshots: { ...screenshots },
    page_names: pages.map((page) => page.name),
    visible_components: visibleComponents,
    slot_map: Object.fromEntries(Object.entries(structure?.slots || {}).map(([id, slot]) => [id, {
      page: slot.page,
      permission: slot.permission,
      present: slot.present,
      boundingBox: slot.boundingBox
    }])),
    protected_regions: occludedRegions,
    current_theme: sanitizeThemeInfo(currentTheme),
    capability_manifest_summary: manifest
      ? {
          theme_api_version: manifest.theme_api_version,
          animations: manifest.capabilities.animations,
          persona: manifest.capabilities.persona,
          can_theme_official_ui: manifest.capabilities.can_theme_official_ui,
          states: manifest.states
        }
      : null
  }
}

/**
 * Snapshot service: captures, persists and reads back snapshot packages.
 *
 * @param {object} options
 * @param {Function} options.capture          async (pageIds) => { pageId: pngBuffer }
 * @param {Function} [options.dockRegions]    () => { slotId: {x,y,width,height} }
 * @param {Function} [options.componentTree]  () => tree | null
 * @param {Function} [options.windowSize]     () => [width, height]
 * @param {Function} [options.currentTheme]   () => resolved theme
 * @param {Function} [options.dockState]      () => dock state
 * @param {Function} [options.registry]       () => registry facade
 * @param {Function} options.log
 */
function createSnapshotService({
  capture,
  dockRegions = () => ({}),
  componentTree = () => null,
  windowSize = () => null,
  currentTheme = () => null,
  dockState = () => null,
  manifest = () => null,
  log = () => {}
} = {}) {
  function workspaceDir() {
    return path.join(require('../utils/paths').PATHS.DATA, 'theme-workspace', 'snapshot')
  }

  /**
   * Capture a fresh UI Snapshot Package.
   *
   * @param {object} [options]
   * @param {string[]} [options.pages]  page ids to capture (default: themable dock pages)
   */
  async function observe({ pages = null } = {}) {
    const targetPages = (pages && pages.length ? pages : contract.HNS_PAGES
      .filter((page) => page.surface === 'dock')
      .map((page) => page.id))
      .filter((id) => {
        const page = contract.HNS_PAGES.find((entry) => entry.id === id)
        return page && page.surface === 'dock'
      })

    let regions = {}
    let tree = null
    try {
      regions = dockRegions() || {}
    } catch (error) {
      log(`dock region probe failed: ${error?.message || error}`)
    }
    try {
      tree = componentTree()
    } catch (error) {
      log(`component tree probe failed: ${error?.message || error}`)
    }

    let screenshots = {}
    try {
      const files = await capture(targetPages)
      screenshots = files || {}
    } catch (error) {
      // A capture failure is not a design failure: snapshot degrades to structure.
      log(`visual capture unavailable: ${error?.message || error}`)
      screenshots = {}
    }

    const structure = observeStructure({ manifest: manifest(), dockRegions: regions, componentTree: tree })
    const pkg = buildSnapshotPackage({
      structure,
      screenshots,
      windowSize: (() => {
        try { return windowSize() } catch { return null }
      })(),
      currentTheme: (() => {
        try { return currentTheme() } catch { return null }
      })(),
      dockState: (() => {
        try { return dockState() } catch { return null }
      })(),
      manifest: manifest()
    })

    const written = persist(pkg, screenshots)
    return { package: pkg, dir: written.dir, files: written.files }
  }

  /** Write the snapshot package (JSON + PNGs) into the theme workspace. */
  function persist(pkg, screenshots) {
    const dir = workspaceDir()
    const files = []
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const [pageId, name] of Object.entries(pkg.screenshots)) {
        const buffer = screenshots[pageId]
        if (!buffer) continue
        const target = path.join(dir, String(name))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, buffer)
        files.push(path.relative(dir, target).split(path.sep).join('/'))
      }
      const mapFile = path.join(dir, 'ui-map.json')
      fs.writeFileSync(mapFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
      files.push('ui-map.json')
    } catch (error) {
      log(`snapshot persist failed: ${error?.message || error}`)
    }
    return { dir, files }
  }

  /** Read back the most recent snapshot package, or null. */
  function latest() {
    try {
      return JSON.parse(fs.readFileSync(path.join(workspaceDir(), 'ui-map.json'), 'utf8'))
    } catch {
      return null
    }
  }

  return {
    observe,
    latest,
    persist,
    workspaceDir,
    observeStructure,
    buildSnapshotPackage,
    SNAPSHOT_VERSION
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  sanitizeThemeInfo,
  observeStructure,
  buildSnapshotPackage,
  createSnapshotService
}
