'use strict'

/**
 * The frosted-glass layer's durable switch.
 *
 * The requirement is that every DS-Hns surface — the dock, its panels, its floats, every sheet
 * and every card — is translucent frosted glass, while the official UI is untouched, and that
 * the layer composes with whatever desktop skin is active rather than replacing it.
 *
 * Two decisions live here, and both are deliberately the smallest possible:
 *
 *  1. **What the layer is made of.** Three numbers: whether it is on, how strong the blur is,
 *     and how much of the active skin's surface colour survives in a glass panel. They are
 *     numbers and not colours because the *colours* must keep coming from the skin: the dock
 *     stylesheet mixes the skin's own tokens with transparency, so a theme installed after this
 *     feature still decides what the glass looks like. That is what "works alongside other
 *     desktop skin plugins" means in practice — the layer is an effect over the skin, never a
 *     palette beside it.
 *  2. **Where the numbers live.** `data/state/ui-glass.json`, beside the feature decisions and
 *     for the same reason: this is user state, not deployment configuration, so a theme package
 *     cannot overwrite it and an application update does not reset it.
 *
 * The shell owns the file and validates every patch; the dock receives the resolved state.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The shipped defaults: on, with a real blur and a tint that still reads as the skin. */
const GLASS_DEFAULT = Object.freeze({ enabled: true, blur: 18, opacity: 62 })

/** Values a patch is clamped into: a blur of 0 is "off by numbers" and 100 is "no glass at all". */
const GLASS_LIMITS = Object.freeze({
  blur: Object.freeze({ min: 0, max: 40 }),
  opacity: Object.freeze({ min: 20, max: 100 })
})

/**
 * @param {object} [options]
 * @param {string} [options.root] the repository root
 * @param {string} [options.file] an explicit state file
 * @param {object} [options.defaults] deployment defaults from config
 * @param {Function} [options.log]
 */
function createUiGlass(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()))
  const file = path.resolve(String(options.file || path.join(root, 'data', 'state', 'ui-glass.json')))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const defaults = { ...GLASS_DEFAULT, ...(options.defaults && typeof options.defaults === 'object' ? options.defaults : {}) }

  let cache = null

  /** One number, clamped into its own range; anything unreadable keeps the value it replaces. */
  function clamp(name, value, fallback) {
    const range = GLASS_LIMITS[name]
    const number = Number(value)
    if (!range || !Number.isFinite(number)) return fallback
    return Math.min(range.max, Math.max(range.min, Math.round(number)))
  }

  /**
   * The state in force, read once.
   *
   * A malformed file is not an error the user can act on — it is a preference that failed to
   * persist — so the defaults stand and the reason is logged rather than thrown at the panel.
   */
  function load() {
    if (cache) return cache
    cache = { enabled: defaults.enabled === true, blur: clamp('blur', defaults.blur, GLASS_DEFAULT.blur), opacity: clamp('opacity', defaults.opacity, GLASS_DEFAULT.opacity), source: 'default' }
    let raw = null
    try {
      if (!fs.existsSync(file)) return cache
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      log(`ui-glass.json is unreadable (${error?.message || error}); the defaults stand`)
      return cache
    }
    if (!raw || typeof raw !== 'object') return cache
    cache = {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : cache.enabled,
      blur: clamp('blur', raw.blur, cache.blur),
      opacity: clamp('opacity', raw.opacity, cache.opacity),
      source: 'user'
    }
    return cache
  }

  /** The state the dock applies, with the limits so the panel's controls match the validator. */
  function describe() {
    const state = load()
    return { ok: true, ...state, file, limits: { blur: { ...GLASS_LIMITS.blur }, opacity: { ...GLASS_LIMITS.opacity } } }
  }

  /**
   * Change the layer.
   *
   * Every accepted key is validated here, so the dock's toggle and the stylesheet cannot
   * disagree about what is in force, and an unknown key is ignored rather than stored.
   */
  function set(patch = {}) {
    const current = load()
    const next = { ...current, source: 'user' }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (patch.blur !== undefined) next.blur = clamp('blur', patch.blur, current.blur)
    if (patch.opacity !== undefined) next.opacity = clamp('opacity', patch.opacity, current.opacity)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ enabled: next.enabled, blur: next.blur, opacity: next.opacity }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, reason: `the glass preference could not be written: ${error?.message || error}`, code: 'GLASS_UNWRITABLE' }
    }
    cache = next
    log(`frosted glass ${next.enabled ? 'on' : 'off'} (blur ${next.blur}px, opacity ${next.opacity}%)`)
    return describe()
  }

  return { GLASS_DEFAULT, GLASS_LIMITS, describe, set, read: load, file }
}

module.exports = { createUiGlass, GLASS_DEFAULT, GLASS_LIMITS }
