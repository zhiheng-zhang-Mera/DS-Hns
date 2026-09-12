'use strict'

/**
 * Unified Theme Surface model (Update-Plan/General-Theme.md 任务 1).
 *
 * The theme system used to answer one question: "which dock slots may I write?".
 * It now has to answer a second one: "which *layer* of the product may I touch,
 * and how much?". Four surfaces exist, and every one of them carries four
 * independent decisions instead of a single boolean:
 *
 *   hns_native        the HNS dock renderer — our own HTML/CSS/JS. Full write
 *                     access to tokens, slots, persona and assets.
 *   official_shell    the frame DS-Hns draws *around* the official renderer (its
 *                     own WebContentsView). Full write access to chrome-level
 *                     styling, so the outer shell can be re-skinned.
 *   official_overlay  a transparent WebContentsView stacked *above* the official
 *                     renderer. VISUAL ONLY: no DOM access, no input, no focus.
 *   official_renderer the official `@deepseek-ai/dsh` WebContentsView. PROTECTED:
 *                     never writable, never injectable, never screenshotted.
 *
 * `writable` / `assetWritable` are therefore *derived from the permission*, and
 * `assertWritable` is the single gate every writer (builder, asset pipeline,
 * overlay layout, package validator) goes through. A PROTECTED surface cannot be
 * written even by a caller that skips a higher-level check, because the gate is
 * data-driven and lives here.
 *
 * Boundary honesty: `access.dom === false` on the two official surfaces is not a
 * temporary limitation to be removed later. It is the architectural contract this
 * project is built on — the official renderer is owned by the harness, and DS-Hns
 * reaches it only by *stacking views around it*, never by reaching inside it.
 */
const contract = require('./contract')

/** The four canonical surfaces. Order is stable and used by the UI. */
const SURFACE_IDS = Object.freeze([
  'hns_native',
  'official_shell',
  'official_overlay',
  'official_renderer'
])

/**
 * Interaction contract of a surface. Overlay is the interesting one: it must not
 * participate in input at all, which is what keeps the official UI clickable,
 * typeable and scrollable underneath it.
 */
const VISUAL_ONLY_INPUT = Object.freeze({
  pointer: false,
  keyboard: false,
  focus: false,
  scroll: false,
  // Always true for the overlay: a visual layer never owns a hit target.
  passthrough: true
})

const FULL_INPUT = Object.freeze({
  pointer: true,
  keyboard: true,
  focus: true,
  scroll: true,
  passthrough: false
})

/** What a surface physically is, which is what the runtime paints. */
const SURFACES = Object.freeze({
  [contract.SURFACE.HNS_NATIVE]: Object.freeze({
    id: contract.SURFACE.HNS_NATIVE,
    label: 'HNS Native',
    order: 1,
    permission: contract.SURFACE_PERMISSION.FULL,
    writable: true,
    assetWritable: true,
    interactive: true,
    visualOnly: false,
    protected: false,
    owner: 'hns',
    renderer: 'app/extensions/mega/ui/dock.html',
    container: 'webContentsView',
    description: 'HNS Mega dock renderer (own stylesheets, own CSP): tokens, slots, persona and assets all apply here.',
    layers: Object.freeze(['tokens', 'slots', 'persona', 'asset', 'character', 'decoration']),
    input: FULL_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true })
  }),
  [contract.SURFACE.OFFICIAL_SHELL]: Object.freeze({
    id: contract.SURFACE.OFFICIAL_SHELL,
    label: 'Official Shell',
    order: 2,
    permission: contract.SURFACE_PERMISSION.FULL,
    writable: true,
    assetWritable: true,
    interactive: false,
    visualOnly: false,
    protected: false,
    owner: 'hns',
    renderer: 'app/extensions/mega/ui/hns-shell.html',
    container: 'webContentsView',
    description: 'The DS-Hns-drawn frame around the official renderer: background, border, radius, shadow, separator, frame and outer padding.',
    layers: Object.freeze(['tokens', 'slots', 'asset', 'decoration']),
    // The shell is a *frame*: it stays input-transparent so the official UI keeps
    // every pixel it had. Only the frame band itself is ever painted.
    input: VISUAL_ONLY_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true })
  }),
  [contract.SURFACE.OFFICIAL_OVERLAY]: Object.freeze({
    id: contract.SURFACE.OFFICIAL_OVERLAY,
    label: 'Official Overlay',
    order: 3,
    permission: contract.SURFACE_PERMISSION.VISUAL_ONLY,
    writable: true,
    assetWritable: true,
    interactive: false,
    visualOnly: true,
    protected: false,
    owner: 'hns',
    renderer: 'app/extensions/mega/ui/official-overlay.html',
    container: 'webContentsView',
    description: 'Transparent visual layer above the official renderer: tint, gradient, texture, skin, vignette, scanline, frame glow, corner decoration and the character.',
    layers: Object.freeze(['tokens', 'slots', 'asset', 'character', 'decoration', 'effect']),
    input: VISUAL_ONLY_INPUT,
    access: Object.freeze({ dom: true, css: true, script: true, capture: true, resize: true })
  }),
  [contract.SURFACE.OFFICIAL_RENDERER]: Object.freeze({
    id: contract.SURFACE.OFFICIAL_RENDERER,
    label: 'Official Renderer',
    order: 4,
    permission: contract.SURFACE_PERMISSION.PROTECTED,
    writable: false,
    assetWritable: false,
    interactive: true,
    visualOnly: false,
    protected: true,
    owner: 'harness',
    renderer: 'official @deepseek-ai/dsh WebContentsView',
    container: 'webContentsView',
    description: 'The official Harness renderer. Owned by the harness: no DOM, no CSS, no script, no input interception and no capture from DS-Hns.',
    layers: Object.freeze([]),
    input: FULL_INPUT,
    access: Object.freeze({ dom: false, css: false, script: false, capture: false, resize: false })
  })
})

/** Layer vocabulary a theme may target, in paint order. */
const LAYERS = Object.freeze(['tokens', 'slots', 'persona', 'asset', 'character', 'decoration', 'effect', 'layout'])

/** Asset kinds a surface may carry. Empty means "not asset-settable at all". */
const SURFACE_ASSET_KINDS = Object.freeze({
  [contract.SURFACE.HNS_NATIVE]: Object.freeze([
    'wallpaper',
    'persona_avatar',
    'hns_character',
    'decoration',
    'panel_texture',
    'icon_set',
    'background_illustration',
    'hud_decoration',
    'frame_decoration'
  ]),
  [contract.SURFACE.OFFICIAL_SHELL]: Object.freeze([
    'official_shell_frame',
    'frame_decoration',
    'wallpaper',
    'background_illustration'
  ]),
  [contract.SURFACE.OFFICIAL_OVERLAY]: Object.freeze([
    'official_skin',
    'official_overlay_texture',
    'official_character',
    'wallpaper',
    'background_illustration',
    'hud_decoration',
    'frame_decoration',
    'decoration'
  ]),
  [contract.SURFACE.OFFICIAL_RENDERER]: Object.freeze([])
})

/** Layout modes the official overlay understands (任务 9). */
const LAYOUT_MODES = Object.freeze(['corner', 'edge', 'floating', 'background', 'framed'])

/** Anchors a character/decoration may be placed at. */
const ANCHORS = Object.freeze([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
])

/** Feature switches that only exist on the overlay surface. */
const OVERLAY_FEATURES = Object.freeze([
  'tint',
  'gradient',
  'texture',
  'skin',
  'vignette',
  'scanline',
  'frame_glow',
  'corner_decoration',
  'character'
])

/** Surface database as a plain array, in canonical order. */
const SURFACE_LIST = Object.freeze(SURFACE_IDS.map((id) => SURFACES[id]))

function getSurface(id) {
  return SURFACES[id] || null
}

/** Is `id` one of the four canonical surfaces? */
function isSurface(id) {
  return Object.prototype.hasOwnProperty.call(SURFACES, String(id || ''))
}

function permissionOf(id) {
  return SURFACES[id]?.permission || null
}

/** May a theme generator write tokens/slots/plan entries on this surface? */
function isWritable(id) {
  return SURFACES[id]?.writable === true
}

/** May a theme generator attach an asset to this surface? */
function isAssetWritable(id) {
  return SURFACES[id]?.assetWritable === true
}

function isProtected(id) {
  return SURFACES[id]?.protected === true
}

/** May the theme system paint over this surface without stealing input? */
function isVisualOnly(id) {
  return SURFACES[id]?.visualOnly === true
}

/** Asset kinds this surface accepts (empty for the protected renderer). */
function assetKinds(id) {
  return (SURFACE_ASSET_KINDS[id] || []).slice()
}

function acceptsAssetKind(id, kind) {
  return (SURFACE_ASSET_KINDS[id] || []).includes(String(kind || ''))
}

/**
 * The single write gate.
 *
 * Every writer calls this before it touches a surface — the builder before it
 * writes an asset, the package validator before it accepts a plan entry, the
 * overlay layout engine before it lays anything out. It returns a *result* rather
 * than throwing, because the callers must be able to degrade (skip that one
 * asset, drop that one overlay module) instead of failing an entire theme.
 *
 * @param {string} surfaceId
 * @param {object} [options]
 * @param {'asset'|'component'|'layout'|'override'} [options.kind]
 * @param {string} [options.assetKind]
 * @param {string} [options.target]
 * @returns {{ok: boolean, code?: string, reason?: string, surface?: string, permission?: string}}
 */
function assertWritable(surfaceId, { kind = 'component', assetKind = null, target = null } = {}) {
  const id = String(surfaceId || '')
  const surface = SURFACES[id]
  if (!surface) {
    return {
      ok: false,
      surface: id || null,
      permission: null,
      code: 'surface_unknown',
      reason: `"${id}" is not one of the four Theme Surfaces (${SURFACE_IDS.join(', ')})`
    }
  }
  if (surface.protected || surface.permission === contract.SURFACE_PERMISSION.PROTECTED) {
    return {
      ok: false,
      surface: id,
      permission: surface.permission,
      code: 'surface_protected',
      reason: `${id} is PROTECTED: the official renderer is never modified by the theme system`,
      target: target || null
    }
  }
  if (kind === 'asset') {
    if (!surface.assetWritable) {
      return {
        ok: false,
        surface: id,
        permission: surface.permission,
        code: 'surface_asset_denied',
        reason: `${id} does not accept theme assets`,
        target: target || null
      }
    }
    if (assetKind && !acceptsAssetKind(id, assetKind)) {
      return {
        ok: false,
        surface: id,
        permission: surface.permission,
        code: 'surface_asset_kind_denied',
        reason: `${id} does not accept a "${assetKind}" asset (accepts: ${assetKinds(id).join(', ') || 'none'})`,
        target: target || null
      }
    }
  }
  if (!surface.writable) {
    return {
      ok: false,
      surface: id,
      permission: surface.permission,
      code: 'surface_write_denied',
      reason: `${id} is ${surface.permission} and cannot be written by the theme generator`,
      target: target || null
    }
  }
  return { ok: true, surface: id, permission: surface.permission }
}

/**
 * Reject a payload that tries to *write* a protected surface.
 *
 * Declaring the protected surface is not a violation — a `surface-plan.json` is
 * required to describe all four surfaces, including the one it refuses to write.
 * Only a reference that claims a write is rejected, which is the shape a
 * hand-written or imported package would have to use to smuggle one in:
 *
 *   { "surface": "official_renderer", "writes": true }        -> rejected
 *   { "target":  "official_renderer", "opacity": 0.4 }        -> rejected
 *   { "surface": "official_renderer", "writes": false }       -> allowed (honest)
 *
 * Used on user/imported packages and on model output, so neither can reach the
 * official renderer by writing its own plan.
 */
function violationsIn(value, trail = [], found = []) {
  const KEYS = ['surface', 'target', 'surface_target', 'target_surface']
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, path.concat(String(index))))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      const entry = node[key]
      if (typeof entry === 'string' && KEYS.includes(key) && isSurface(entry) && isProtected(entry)) {
        // An explicit `writes: false` is the honest way to name it.
        if (node.writes === false || node.written === false || node.themed === false) continue
        found.push({ path: path.concat(key).join('.'), value: entry, code: 'surface_protected' })
        continue
      }
      if (entry && typeof entry === 'object') visit(entry, path.concat(key))
    }
  }
  visit(value, trail)
  return found
}

/**
 * The surface a slot belongs to. Slot families carry their own surface so the
 * capability manifest and the package validator agree without a second table.
 */
function surfaceOfSlot(slotId) {
  const id = String(slotId || '')
  if (id.startsWith('official.overlay.')) return contract.SURFACE.OFFICIAL_OVERLAY
  if (id.startsWith('official.shell.')) return contract.SURFACE.OFFICIAL_SHELL
  if (id.startsWith('official.renderer.')) return contract.SURFACE.OFFICIAL_RENDERER
  return contract.SURFACE.HNS_NATIVE
}

/** Compact renderer/UI-safe description of every surface. */
function describe() {
  return SURFACE_LIST.map((surface) => ({
    id: surface.id,
    label: surface.label,
    permission: surface.permission,
    writable: surface.writable,
    assetWritable: surface.assetWritable,
    protected: surface.protected,
    visualOnly: surface.visualOnly,
    interactive: surface.interactive,
    owner: surface.owner,
    container: surface.container,
    layers: surface.layers.slice(),
    assetKinds: assetKinds(surface.id),
    input: { ...surface.input },
    access: { ...surface.access },
    description: surface.description
  }))
}

module.exports = {
  SURFACE_IDS,
  SURFACES,
  SURFACE_LIST,
  SURFACE_ASSET_KINDS,
  LAYERS,
  LAYOUT_MODES,
  ANCHORS,
  OVERLAY_FEATURES,
  VISUAL_ONLY_INPUT,
  FULL_INPUT,
  getSurface,
  isSurface,
  permissionOf,
  isWritable,
  isAssetWritable,
  isProtected,
  isVisualOnly,
  assetKinds,
  acceptsAssetKind,
  assertWritable,
  violationsIn,
  surfaceOfSlot,
  describe
}
