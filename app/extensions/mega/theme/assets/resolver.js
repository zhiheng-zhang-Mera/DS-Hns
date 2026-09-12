'use strict'

/**
 * Theme Asset Resolver — the runtime half of the "self-contained package" rule.
 *
 * A theme package declares its imagery one of three ways:
 *
 *   1. an inline data URI            `data:image/png;base64,...`   (nothing to do)
 *   2. a package-relative reference  `assets/persona/banner.png`   (needs reading)
 *   3. an asset-variable reference   `var(--hns-asset-wallpaper)`  (needs resolving)
 *
 * `builder.js` resolves (2) and (3) when *it* compiles a package, and
 * `validator.js` accepts both forms on the way in — but a package that arrives by
 * any other route (the built-in demo themes, an imported package, a hand-written
 * one) reached the renderer with the raw reference in place. A renderer treats a
 * slot's `asset` as a URL, so `assets/persona/banner.png` resolved against the
 * renderer's own document (a broken image) and `var(--hns-asset-wallpaper)` was a
 * custom-property reference in a place that expects a URL (an invalid
 * declaration). The visible result was *exactly* "the theme only changed colours":
 * every token landed, every asset was dropped.
 *
 * This module closes that gap at paint time, for every surface at once (the HNS
 * dock, the official shell/overlay and the native frontend all consume the same
 * payload), so any accepted package is painted the way its author declared it.
 *
 * Failure policy: an asset that cannot be read degrades to the same role's token
 * value and then to `none`. It is recorded in `unresolved`, never thrown, because
 * a missing image must not be able to stop a theme from applying.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('../contract')

/** Image extensions a package may carry, with the MIME type used to inline them. */
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
})

/**
 * Slot -> the token that carries the same role's asset.
 *
 * Used for two things: resolving a `var(--hns-asset-*)` reference (which is how a
 * generated package writes it) and as the fallback when a declared file is
 * missing.
 */
const SLOT_ASSET_TOKEN = Object.freeze({
  'hns.window.background': 'asset.wallpaper',
  'common.window.background': 'asset.wallpaper',
  'hns.window.overlay': 'asset.overlay',
  'hns.worker.card': 'asset.panel_texture',
  'hns.process.panel': 'asset.panel_texture',
  'hns.persona.decoration': 'asset.decoration',
  'hns.persona.banner': 'asset.persona_banner',
  'hns.persona.status_avatar': 'asset.persona_avatar',
  'hns.operator.avatar': 'asset.persona_avatar',
  'hns.character.primary': 'asset.hns_character',
  'official.overlay.character_primary': 'asset.official_character',
  'official.overlay.character_secondary': 'asset.official_character_secondary',
  'official.overlay.skin': 'asset.official_skin',
  'official.overlay.texture': 'asset.official_overlay_texture',
  'official.shell.background': 'asset.official_shell_frame'
})

/** Properties that can carry an image on a slot payload. */
const ASSET_PROPERTIES = Object.freeze(['asset', 'background', 'overlay', 'image'])

/** `var(--hns-asset-x)` inside a slot value. */
const ASSET_VAR_REFERENCE = /var\(\s*(--hns-asset-[a-z0-9-]+)\s*\)/g

/** Values that are already usable and must not be touched. */
const PASSTHROUGH = /^(data:|https?:|file:|url\(|var\(|none$|transparent$|inherit$|currentcolor$)/i

/** Read cache: asset files are re-read only when their size or mtime changes. */
const fileCache = new Map()

function extensionOf(value) {
  const match = /\.[a-z0-9]+$/i.exec(String(value || ''))
  return match ? match[0].toLowerCase() : ''
}

/** Is this a package-relative asset reference (`assets/...`)? */
function isAssetReference(value) {
  return typeof value === 'string' && /^assets\/[^\s]+$/i.test(value)
}

/** Does this look like an image path at all? */
function looksLikeImagePath(value) {
  return typeof value === 'string' && MIME_BY_EXTENSION[extensionOf(value)] !== undefined && !PASSTHROUGH.test(value)
}

/** CSS variable name -> asset token name, for the token block the runtime emits. */
function assetTokensByCssVariable(tokens = {}) {
  const map = {}
  for (const tokenName of contract.TOKEN_NAMES) {
    const definition = contract.TOKENS[tokenName]
    if (!definition || definition.kind !== contract.PROPERTY_KIND.ASSET) continue
    const value = tokens[tokenName]
    if (typeof value === 'string' && value && value !== 'none') map[definition.css] = value
  }
  return map
}

/** Inline one file as a data URI, cached by path + size + mtime. */
function readAsDataUri(file, { log } = {}) {
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`
  const cached = fileCache.get(key)
  if (cached) return cached
  try {
    const mime = MIME_BY_EXTENSION[extensionOf(file)] || 'application/octet-stream'
    const dataUri = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
    if (fileCache.size > 64) fileCache.clear()
    fileCache.set(key, dataUri)
    return dataUri
  } catch (error) {
    log?.(`asset ${file} could not be read: ${error?.message || error}`)
    return null
  }
}

/**
 * Resolve one asset-ish value.
 *
 * @param {string} value
 * @param {object} context
 * @param {string} [context.dir]         package directory
 * @param {object} context.tokenByCss    `--hns-asset-*` -> compiled token value
 * @param {string} [context.roleToken]   the token name for this slot's role
 * @param {string} [context.roleValue]   the compiled value of that token
 * @returns {{value: string, resolved: boolean, from: string|null}}
 */
function resolveValue(value, { dir = null, tokenByCss = {}, roleToken = null, roleValue = null, log } = {}) {
  if (typeof value !== 'string' || !value) return { value, resolved: true, from: null }
  // 1. an asset-variable reference: substitute the compiled token value.
  if (ASSET_VAR_REFERENCE.test(value)) {
    ASSET_VAR_REFERENCE.lastIndex = 0
    let substituted = false
    const next = value.replace(ASSET_VAR_REFERENCE, (match, cssName) => {
      const compiled = tokenByCss[cssName]
      if (compiled) substituted = true
      // Only the *referenced* token may be substituted. Falling back to the
      // slot's own role token here would paint a different role's image (the
      // wallpaper in an overlay slot, for instance).
      return compiled || 'none'
    })
    return { value: next, resolved: substituted, from: substituted ? 'token' : null }
  }
  // 2. anything already usable stays exactly as the author wrote it.
  if (PASSTHROUGH.test(value) || !looksLikeImagePath(value)) return { value, resolved: true, from: null }
  // 3. a real file: inline it.
  if (dir) {
    const relative = isAssetReference(value) ? value : value
    const candidate = path.resolve(dir, relative)
    // Never read outside the package: a theme must not be able to point a slot at
    // an arbitrary file on the machine.
    const root = path.resolve(dir) + path.sep
    if (candidate.startsWith(root)) {
      const dataUri = readAsDataUri(candidate, { log })
      if (dataUri) return { value: dataUri, resolved: true, from: 'file' }
    }
  }
  // 4. the declared file is gone: fall back to the same role's token.
  if (roleValue && roleValue !== 'none' && typeof roleValue === 'string') {
    return { value: roleValue, resolved: true, from: 'token-fallback' }
  }
  return { value: 'none', resolved: false, from: null }
}

/**
 * Resolve every asset reference a theme declares.
 *
 * @param {object} theme  a loaded theme ({ tokens, components: { slots }, dir })
 * @param {object} [options]
 * @param {Function} [options.log]
 * @returns {{slots: object, tokens: object, resolved: object[], unresolved: object[]}}
 */
function resolveThemeAssets(theme, { log } = {}) {
  const slots = (theme && theme.components && theme.components.slots) || {}
  const tokens = (theme && theme.tokens) || {}
  const dir = (theme && theme.dir) || null
  const tokenByCss = assetTokensByCssVariable(tokens)
  const resolved = []
  const unresolved = []
  const out = {}

  for (const [slotId, payload] of Object.entries(slots)) {
    if (!payload || typeof payload !== 'object') {
      out[slotId] = payload
      continue
    }
    const roleToken = SLOT_ASSET_TOKEN[slotId] || null
    const roleValue = roleToken ? tokens[roleToken] : null
    const next = {}
    for (const [property, value] of Object.entries(payload)) {
      if (!ASSET_PROPERTIES.includes(property)) {
        next[property] = value
        continue
      }
      const result = resolveValue(value, { dir, tokenByCss, roleToken, roleValue, log })
      next[property] = result.value
      if (result.from === 'file' || result.from === 'token' || result.from === 'token-fallback') {
        resolved.push({ slot: slotId, property, from: result.from, source: String(value).slice(0, 64) })
      } else if (result.resolved === false) {
        unresolved.push({ slot: slotId, property, source: String(value).slice(0, 64), reason: 'asset_unreadable' })
      }
    }
    out[slotId] = next
  }

  // A persona declared with a relative avatar/banner reference is the same
  // problem in a different document.
  let persona = theme && theme.persona ? { ...theme.persona } : null
  if (persona) {
    for (const [property, tokenName] of [['avatar', 'asset.persona_avatar'], ['banner', 'asset.persona_banner']]) {
      const value = persona[property]
      if (typeof value !== 'string' || !looksLikeImagePath(value)) continue
      const result = resolveValue(value, { dir, tokenByCss, roleValue: tokens[tokenName], log })
      persona[property] = result.value
    }
  }

  return { slots: out, tokens, persona, resolved, unresolved }
}

module.exports = {
  MIME_BY_EXTENSION,
  SLOT_ASSET_TOKEN,
  ASSET_PROPERTIES,
  isAssetReference,
  looksLikeImagePath,
  assetTokensByCssVariable,
  readAsDataUri,
  resolveValue,
  resolveThemeAssets
}
