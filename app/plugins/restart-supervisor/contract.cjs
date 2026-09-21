'use strict'

/**
 * DS-Hns: the platform contract this plugin declares itself against — **from inside the package**.
 *
 * A plugin that ships in this repository is mounted two ways, and they resolve modules differently:
 *
 *   * in process, by `NativeHnsAdapter` from `app/plugins/<name>/`, where `require('../../core/contracts/plugin.cjs')`
 *     reaches the platform's own contract module; and
 *   * as an installed **profile package** (`data/profiles/<profile>/node_modules/<name>/`), where the Harness
 *     composes it from its own process and that relative path resolves to `node_modules/core/...` — which does
 *     not exist. The Harness then fails to start the whole profile, which is what "the plugin is installed but
 *     the product will not boot" looks like from the outside.
 *
 * So the contract travels *with* the package. The values below are this plugin's **declaration** — the API
 * version it was written against, the fault levels it may be given, the health vocabulary it answers in — and
 * they are not a second implementation of anything: the platform's module remains the source the app-side
 * mount prefers, and this file is what makes the installed copy self-contained.
 *
 * The lookup order is deliberate: the platform's module when it is reachable (so a future change to it is
 * picked up in the in-repo mount), and the local declaration otherwise.
 */

/** The API version this plugin declares. Kept in step with `app/core/contracts/plugin.cjs` by test. */
const PLUGIN_API_VERSION = 'dshns.plugin/v1'

/** What a fault costs the product when this plugin fails. */
const FAULT_LEVELS = Object.freeze({
  SOFT: 'soft',
  DEGRADED: 'degraded',
  FATAL: 'fatal'
})

/** The health vocabulary `healthCheck` answers in. */
const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
})

function platformContract() {
  try {
    // Only when it resolves: the installed package has no platform directory above it.
    return require('../../core/contracts/plugin.cjs')
  } catch {
    return null
  }
}

function contract() {
  const platform = platformContract()
  return {
    PLUGIN_API_VERSION: platform && platform.PLUGIN_API_VERSION ? platform.PLUGIN_API_VERSION : PLUGIN_API_VERSION,
    FAULT_LEVELS: platform && platform.FAULT_LEVELS ? platform.FAULT_LEVELS : FAULT_LEVELS,
    HEALTH_STATUS: platform && platform.HEALTH_STATUS ? platform.HEALTH_STATUS : HEALTH_STATUS,
    /** Which half answered — a diagnostic surface reads this rather than guessing. */
    source: platform ? 'app/core/contracts/plugin.cjs' : 'the plugin package itself'
  }
}

module.exports = { contract, platformContract, PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS }
