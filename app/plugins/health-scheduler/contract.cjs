'use strict'

/**
 * DS-Hns: the platform contract this plugin declares itself against — **from inside the package**.
 *
 * A plugin that ships in this repository is mounted two ways, and they resolve modules differently:
 * in process by `NativeHnsAdapter` from `app/plugins/<name>/`, and as an installed **profile package**
 * (`data/profiles/<profile>/node_modules/<name>/`), where the Harness composes it from its own process and a
 * relative path like `../../core/contracts/plugin.cjs` resolves to `node_modules/core/...`, which does not
 * exist. The Harness then fails to start the whole profile — the plugin is installed and the product will not
 * boot.
 *
 * So the contract travels with the package. These values are this plugin's **declaration** (the API version
 * it was written against, the fault levels it may be given, the health vocabulary it answers in), not a second
 * implementation: the platform's module is preferred whenever it resolves, which keeps the in-repo mount
 * reading the platform's own copy.
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
    source: platform ? 'app/core/contracts/plugin.cjs' : 'the plugin package itself'
  }
}

module.exports = { contract, platformContract, PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS }
