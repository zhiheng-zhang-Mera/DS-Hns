'use strict'

/**
 * The frontend runtime — official renderer only.
 *
 * This module used to be the Dual-UI assembly point: two renderers (a native HNS frontend
 * called "Daily" and the official DeepSeek Harness Web UI called "Work"), a mode state
 * machine between them, and a synchronisation layer that tried to keep the two views on the
 * same session. **Daily is gone**, and with it the state machine, the visibility switch and
 * the sync layer: the official renderer is the product's frontend, not one of two.
 *
 * What remains is what was always the useful part, and it is the part the dock reads:
 *
 *   backend  the Harness bridge (unary RPC + durable journal) for the official session
 *   adapter  backend -> the HNS domain model the dock renders
 *   model    the domain vocabulary (sessions, tasks, timeline, settings, backend state)
 *   probe    the DSH compatibility probe and its upgrade verdict
 *
 * The directory keeps its historical name because renaming it would be churn with no
 * behaviour behind it; nothing here has a *mode* any more, and the tests assert that no
 * `MODE`, no state file and no sync module survives.
 */
const modelModule = require('./model.cjs')
const backendModule = require('./backend.cjs')
const adapterModule = require('./adapter.cjs')
const probeModule = require('./probe.cjs')

/**
 * Build the lazily-created official session client.
 *
 * The origin is the authenticated Harness the shell already started; the cookie comes from
 * Electron's default session, which is the same store the official renderer authenticated
 * against. A missing Electron (unit tests) simply means no client, and the adapter reports
 * a degraded backend instead of failing.
 */
function createLazyClient({ log = () => {} } = {}) {
  let client = null
  return function getClient() {
    if (client) return client
    try {
      const { OfficialSessionClient, defaultOriginProvider, defaultCookieProvider } = require('../extensions/mega/deepseek/official-session-client.js')
      client = new OfficialSessionClient({
        originProvider: () => process.env.DSH_OFFICIAL_ORIGIN || defaultOriginProvider(),
        cookieProvider: defaultCookieProvider,
        log: (message) => log(`session client: ${message}`)
      })
    } catch (error) {
      log(`official session client unavailable: ${error?.message || error}`)
      client = null
    }
    return client
  }
}

/**
 * @param {object}   [options]
 * @param {Function} [options.tasks]            () => raw scheduler tasks
 * @param {Function} [options.settings]         () => raw settings snapshot
 * @param {Function} [options.installedVersion]
 * @param {Function} [options.latestVersion]
 * @param {Function} [options.log]
 */
function createFrontendRuntime({
  tasks = () => [],
  settings = () => null,
  installedVersion = () => null,
  latestVersion = async () => null,
  log = () => {}
} = {}) {
  // The client is a lazy getter: the bridge resolves it on first use, so neither startup nor
  // a unit test depends on Electron's session store being available.
  const bridge = backendModule.createBackendBridge({ client: createLazyClient({ log }), log })
  const adapter = adapterModule.createAdapter({ bridge, harnessVersion: null, tasks, settings, log })
  const probe = probeModule.createCompatibilityProbe({ adapter, tasks, settings, installedVersion, latestVersion, log })

  return {
    bridge,
    adapter,
    probe,
    /** The compatibility snapshot the dock and diagnostics show. */
    async compatibility(options = {}) {
      try {
        return await probe.run(options)
      } catch (error) {
        log(`compatibility probe failed: ${error?.message || error}`)
        return null
      }
    },
    describe() {
      return {
        frontend: 'official',
        adapter: adapter.describe(),
        backend: bridge.describe(),
        model: modelModule.describeModel()
      }
    }
  }
}

module.exports = {
  ...modelModule,
  backend: backendModule,
  adapter: adapterModule,
  probe: probeModule,
  createFrontendRuntime,
  createLazyClient
}
