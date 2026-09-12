'use strict'

/**
 * Frontend Mode runtime — the Dual-UI assembly point
 * (Update-Plan/Dual-UI.md 任务 2 / 任务 3 / 任务 8 / 任务 9 / 任务 16 / 任务 20).
 *
 *   state    durable mode + per-mode session memory
 *   backend  the Harness bridge (unary RPC + durable journal)
 *   adapter  backend -> HNS domain model
 *   sync     Daily <-> Work session/navigation synchronization
 *   manager  mode state machine, renderer visibility, failure fallback
 *   probe    DSH compatibility probe + report + upgrade verdict
 *
 * The shell owns the two renderers and therefore owns the manager: it creates the
 * runtime here, wires `applyVisibility` to its own views, and exposes the
 * assembled object to the Mega extension (which owns the theme engine, the
 * scheduler and the settings service the adapter reads).
 */
const stateModule = require('./state.cjs')
const modelModule = require('./model.cjs')
const backendModule = require('./backend.cjs')
const adapterModule = require('./adapter.cjs')
const syncModule = require('./sync.cjs')
const managerModule = require('./manager.cjs')
const probeModule = require('./probe.cjs')

/**
 * The frontend this build opens in.
 *
 * Daily is the product's default: it is the chat-first native workspace
 * (Update-Plan/Daily-UX.md). Work is the official frontend, reached from the mode
 * switch, and it is also where a Daily failure falls back to.
 * `DSH_FRONTEND_MODE=work` overrides the startup frontend for a single run.
 */
const DEFAULT_STARTUP_MODE = 'daily'

/**
 * Build the lazily-created official session client.
 *
 * The origin is the authenticated Harness the shell already started; the cookie
 * comes from Electron's default session, which is the same store the official
 * renderer authenticated against. A missing Electron (unit tests) simply means
 * no client, and the adapter reports a degraded backend instead of failing.
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
      log(`native backend client unavailable: ${error?.message || error}`)
      client = null
    }
    return client
  }
}

/**
 * @param {object}   options
 * @param {string}   options.stateFile        durable frontend-mode state path
 * @param {string}   [options.startupMode]    force the startup mode for this run
 * @param {Function} options.applyVisibility  ({ mode, from }) => void (shell-owned views)
 * @param {Function} [options.tasks]          () => raw scheduler tasks
 * @param {Function} [options.settings]       () => raw settings snapshot
 * @param {Function} [options.installedVersion]
 * @param {Function} [options.latestVersion]
 * @param {Function} [options.navigateOfficial]  optional; absent = honestly unsupported
 * @param {Function} [options.log]
 */
function createFrontendModeRuntime({
  stateFile = null,
  startupMode = null,
  applyVisibility = () => {},
  tasks = () => [],
  settings = () => null,
  installedVersion = () => null,
  latestVersion = async () => null,
  navigateOfficial = null,
  log = () => {}
} = {}) {
  const state = stateModule.createModeState({ file: stateFile, log })
  state.read()
  // `DSH_FRONTEND_MODE` (任务 2: a configurable startup mode) selects which
  // frontend this run opens in without rewriting the user's saved preference: an
  // acceptance run or a shortcut can ask for a deterministic mode, and the next
  // launch still honours whatever the user last chose.
  const forcedMode = stateModule.normalizeMode(startupMode, null) || DEFAULT_STARTUP_MODE
  log(`startup mode ${forcedMode}${startupMode ? ' (from DSH_FRONTEND_MODE)' : ' (build default)'}`)
  // The client is a lazy getter: the bridge resolves it on first use, so neither
  // startup nor a unit test depends on Electron's session store being available.
  const bridge = backendModule.createBackendBridge({ client: createLazyClient({ log }), log })
  const adapter = adapterModule.createAdapter({ bridge, harnessVersion: null, tasks, settings, log })
  const sync = syncModule.createSync({ state, adapter, navigateOfficial, log })
  const manager = managerModule.createModeManager({ state, sync, applyVisibility, log, initialMode: forcedMode })
  const probe = probeModule.createCompatibilityProbe({ adapter, tasks, settings, installedVersion, latestVersion, log })

  return {
    MODE: stateModule.MODE,
    MODES: stateModule.MODES,
    state,
    bridge,
    adapter,
    sync,
    manager,
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
        mode: manager.describe().mode,
        manager: manager.describe(),
        adapter: adapter.describe(),
        backend: bridge.describe(),
        sync: sync.describe(),
        model: modelModule.describeModel()
      }
    }
  }
}

module.exports = {
  ...stateModule,
  ...modelModule,
  DEFAULT_STARTUP_MODE,
  backend: backendModule,
  adapter: adapterModule,
  sync: syncModule,
  manager: managerModule,
  probe: probeModule,
  createFrontendModeRuntime,
  createLazyClient
}
