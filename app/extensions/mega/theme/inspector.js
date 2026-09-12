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
 *
 * Degrading is allowed, being *silent* about it is not: every package carries
 * `degraded` plus the reason, and a capture that came back empty, unreadable or
 * too small to be a UI is reported as such even when the renderer answered.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const capability = require('./capability')
const visualArtifact = require('./visual-artifact')

const SNAPSHOT_VERSION = 1

/** Why a snapshot has no picture; surfaced verbatim in the package. */
const VISUAL_REASON = Object.freeze({
  CAPTURED: 'visual snapshot captured',
  RENDERER_UNAVAILABLE: 'the dock renderer was not available for capture',
  NO_VISUAL_MODE: 'visual capture was disabled for this run',
  CAPTURE_EMPTY: 'the dock renderer answered the capture with no image',
  CAPTURE_UNREADABLE: 'the dock renderer answered with an image that is not a usable PNG',
  CAPTURE_FAILED: 'the dock capture raised an error'
})

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
 *
 * `visual` is the honest answer to "is there a usable picture of the running
 * UI"; `degraded` says a picture was expected and is missing, so a caller can
 * never mistake a structure-only package for a full observation.
 */
function buildSnapshotPackage({
  structure,
  screenshots = {},
  windowSize = null,
  currentTheme = null,
  dockState = null,
  manifest = null,
  capturedAt = null,
  visualExpectation = null,
  captureProblems = []
} = {}) {
  // Page id -> the PNG file name inside the snapshot directory. The buffers
  // themselves are only used by `persist`; they never enter the package.
  //
  // Built *before* `pages` on purpose: the per-page `screenshot` field used to be
  // derived from the raw `screenshots` map, which holds PNG buffers, so the
  // package serialised `"snapshot/<binary>"` — a mojibake path that named nothing
  // on disk while still looking like a captured screenshot in the JSON.
  const screenshotFiles = Object.fromEntries(
    Object.keys(screenshots).map((pageId) => [pageId, `snapshot/${pageId}.png`])
  )

  const pages = contract.HNS_PAGES.map((page) => ({
    name: page.name,
    id: page.id,
    surface: page.surface,
    screenshot: screenshotFiles[page.id] || null,
    observed: page.surface === 'official' ? false : Boolean(screenshotFiles[page.id]) || page.surface === 'dock',
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

  const visual = Object.keys(screenshots).length > 0
  const expectation = visualExpectation && typeof visualExpectation === 'object' ? visualExpectation : null
  const expected = Boolean(expectation?.expected)
  // Degraded = the run should have produced a picture and did not (or produced a
  // broken one). A capture that was never possible is recorded with its reason,
  // and a capture that *was* possible and still failed is an anomaly.
  const degraded = !visual && expected
  const reason = visual
    ? VISUAL_REASON.CAPTURED
    : (captureProblems.length ? captureProblems[0] : (expectation?.reason || VISUAL_REASON.RENDERER_UNAVAILABLE))

  return {
    version: SNAPSHOT_VERSION,
    app: 'hns',
    captured_at: capturedAt || new Date().toISOString(),
    visual,
    degraded,
    visual_expected: expected,
    visual_reason: reason,
    capture_problems: captureProblems.slice(),
    window: windowSize ? { width: windowSize[0], height: windowSize[1] } : null,
    dock: dockState ? { ...dockState } : null,
    pages,
    // Page id -> the PNG file name inside the snapshot directory. The buffers
    // themselves are only used by `persist`; they never enter the package.
    screenshots: screenshotFiles,
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

/** Slots the renderer actually reported a non-empty bounding box for. */
function observedSlots(structure) {
  const slots = Object.values(structure?.slots || {})
    .filter((slot) => slot.present && slot.boundingBox && Number(slot.boundingBox.width) > 0 && Number(slot.boundingBox.height) > 0)
  return {
    count: slots.length,
    ids: slots.map((slot) => slot.id),
    boundingBoxes: Object.fromEntries(slots.map((slot) => [slot.id, { ...slot.boundingBox }]))
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
 * @param {Function} [options.visualExpected] () => { expected, reason } | null
 * @param {object}   [options.limits]         capture size thresholds
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
  visualExpected = () => null,
  limits = {},
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
    // `dockRegions` may probe the live renderer and answer asynchronously (the
    // extension does exactly that), so it is awaited: a slot map that silently
    // came back empty is worse than a slow observation.
    try {
      regions = (await dockRegions()) || {}
    } catch (error) {
      log(`dock region probe failed: ${error?.message || error}`)
    }
    try {
      tree = componentTree()
    } catch (error) {
      log(`component tree probe failed: ${error?.message || error}`)
    }

    let screenshots = {}
    let captureProblems = []
    // Is a picture actually possible right now? The extension answers from the
    // dock adapter, so "nothing was captured" can be told apart from "the product
    // should have produced a screenshot and did not".
    let expectation = null
    try {
      expectation = visualExpected()
    } catch (error) {
      log(`visual expectation unavailable: ${error?.message || error}`)
      expectation = null
    }
    try {
      const files = await capture(targetPages)
      screenshots = files || {}
    } catch (error) {
      // A capture failure is not a design failure: snapshot degrades to structure.
      log(`visual capture unavailable: ${error?.message || error}`)
      screenshots = {}
      captureProblems.push(`${VISUAL_REASON.CAPTURE_FAILED}: ${error?.message || error}`)
    }

    // A returned buffer is not a screenshot: verify header, dimensions and size
    // before it is allowed to make the package look observed.
    const verdicts = {}
    for (const [pageId, buffer] of Object.entries(screenshots)) {
      const verdict = visualArtifact.inspectCapture(buffer, limits)
      verdicts[pageId] = verdict
      if (!verdict.ok) {
        captureProblems.push(`${pageId}: ${verdict.problems.join('; ')}`)
        delete screenshots[pageId]
      }
    }
    if (Object.keys(screenshots).length === 0 && captureProblems.length === 0 && expectedNow(expectation)) {
      captureProblems.push(VISUAL_REASON.CAPTURE_EMPTY)
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
      manifest: manifest(),
      visualExpectation: expectation,
      captureProblems
    })
    pkg.capture_verdicts = verdicts

    if (pkg.degraded) {
      log(`visual snapshot degraded (${pkg.visual_reason}); the design falls back to structure-only`)
    }

    const written = persist(pkg, screenshots)
    const files = written.files.map((file) => file.split(path.sep).join('/'))
    return { package: pkg, dir: written.dir, files, problems: captureProblems, verdicts }
  }

  function expectedNow(expectation) {
    if (Array.isArray(expectation)) return expectation.length > 0
    return Boolean(expectation && typeof expectation === 'object' && expectation.expected)
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

  /**
   * On-disk truth for the latest snapshot: the JSON, the PNGs it claims and a
   * verdict per file. Used by acceptance, which must fail on an empty or
   * malformed artifact rather than on a boolean.
   */
  function artifacts() {
    const dir = workspaceDir()
    const pkg = latest()
    const claimed = pkg && pkg.screenshots ? Object.values(pkg.screenshots) : []
    const files = claimed.map((name) => {
      const target = path.join(dir, String(name))
      let buffer = null
      let exists = false
      try {
        exists = fs.existsSync(target)
        if (exists) buffer = fs.readFileSync(target)
      } catch (error) {
        log(`snapshot artifact unreadable (${name}): ${error?.message || error}`)
      }
      return { name: String(name), path: target, exists, verdict: visualArtifact.inspectCapture(buffer, limits) }
    })
    return {
      dir,
      mapFile: path.join(dir, 'ui-map.json'),
      mapExists: Boolean(pkg),
      package: pkg,
      files,
      ok: files.length > 0 && files.every((file) => file.exists && file.verdict.ok)
    }
  }

  return {
    observe,
    latest,
    artifacts,
    persist,
    workspaceDir,
    observeStructure,
    observedSlots,
    buildSnapshotPackage,
    SNAPSHOT_VERSION,
    VISUAL_REASON
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  VISUAL_REASON,
  sanitizeThemeInfo,
  observeStructure,
  observedSlots,
  buildSnapshotPackage,
  createSnapshotService
}
