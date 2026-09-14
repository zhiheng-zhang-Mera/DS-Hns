'use strict'

/**
 * Where the appearance choice lives (`data/state/appearance.json`).
 *
 * The provider and the readability preset are the user's decisions, not a cache and not deployment config, so
 * they get their own small state file beside `wallpaper.json` and `ui-glass.json` — the same shape of file, with
 * the same rules: a file that cannot be read is the default, a value that makes no sense is dropped rather than
 * trusted, and a write that fails is a log line.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The defaults, matching the shipped experience: the simple wallpaper and the work preset. */
const APPEARANCE_STATE_DEFAULT = Object.freeze({ provider: 'simple', preset: 'work' })

/**
 * @param {object}   [options]
 * @param {string}   [options.root]
 * @param {string}   [options.file]
 * @param {string[]} [options.providers] the provider ids this build knows
 * @param {string[]} [options.presets]   the preset ids this build knows
 * @param {Function} [options.log]
 */
function createAppearanceState({ root = process.cwd(), file = null, providers = ['official', 'simple', 'community'], presets = ['work', 'immersive', 'reading'], log = () => {} } = {}) {
  const stateFile = path.resolve(String(file || path.join(root, 'data', 'state', 'appearance.json')))
  let cache = null

  function read() {
    if (cache) return cache
    cache = { ...APPEARANCE_STATE_DEFAULT, source: 'default' }
    try {
      if (!fs.existsSync(stateFile)) return cache
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object') return cache
      cache = {
        provider: providers.includes(raw.provider) ? raw.provider : cache.provider,
        preset: presets.includes(raw.preset) ? raw.preset : cache.preset,
        source: 'user'
      }
      if (raw.provider && !providers.includes(raw.provider)) log(`the saved appearance provider "${raw.provider}" is not one this build has; it was dropped`)
      if (raw.preset && !presets.includes(raw.preset)) log(`the saved appearance preset "${raw.preset}" is not one this build has; it was dropped`)
    } catch (error) {
      log(`appearance.json is unreadable (${error?.message || error}); the defaults stand`)
    }
    return cache
  }

  /** Change one or both decisions; anything this build does not have is refused rather than stored. */
  function set(patch = {}) {
    const current = read()
    const next = { ...current }
    if (patch.provider !== undefined) {
      if (!providers.includes(patch.provider)) return { ok: false, reason: `"${patch.provider}" is not an appearance provider` }
      next.provider = patch.provider
    }
    if (patch.preset !== undefined) {
      if (!presets.includes(patch.preset)) return { ok: false, reason: `"${patch.preset}" is not a readability preset` }
      next.preset = patch.preset
    }
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, `${JSON.stringify({ provider: next.provider, preset: next.preset }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, reason: `the appearance preference could not be written: ${error?.message || error}` }
    }
    cache = { ...next, source: 'user' }
    return { ok: true, ...cache, file: stateFile }
  }

  return { APPEARANCE_STATE_DEFAULT, read, set, describe: () => ({ ok: true, ...read(), file: stateFile }), file: stateFile }
}

module.exports = { createAppearanceState, APPEARANCE_STATE_DEFAULT }
