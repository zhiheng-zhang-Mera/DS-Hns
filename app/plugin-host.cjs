'use strict'

/**
 * DS-Hns: the shell-side plugin host.
 *
 * The plugin manager, the registry, the bus, the configuration and the two plugin sets
 * have to live somewhere in the shipped application, and this is that place. It exists
 * so `desktop-main.cjs` stays an entry point rather than a runtime, and so the workbench
 * has exactly one object to talk to.
 *
 * Three properties matter for the panel that drives it:
 *
 *  1. **The renderer describes, it does not decide.** Nothing here accepts a plugin
 *     object, a capability name or a file path from the renderer. It accepts an *id* that
 *     is already installed, and a small set of settings whose keys it validates against a
 *     schema it owns. A plugin UI that could install arbitrary code would be a
 *     remote-code-execution surface wearing a settings panel.
 *  2. **Settings are written where the platform already reads them.** The execution
 *     settings become `config/plugins/<id>.json`, which is the config manager's "what the
 *     user decided for one plugin" layer — not a new store beside it. The world is then
 *     rebuilt, because the manager resolves plugin config at construction and pretending
 *     otherwise would leave the panel and the runtime disagreeing about what is set.
 *  3. **The lockfile is a refusal, not a warning.** Section 40 of the plan asks for a
 *     reproducible environment; a lock that only prints a warning reproduces nothing.
 *     Drift is reported with the plugins that moved, and the deployment may ask the host
 *     to refuse to load on it.
 */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createPluginManager } = require('./core/plugin-manager/index.cjs')
const { createEventBus } = require('./core/event-bus/index.cjs')
const { createCapabilityRegistry } = require('./core/capability-registry/index.cjs')
const { createConfigManager } = require('./core/config-manager/index.cjs')
const { createResourceManager, DEFAULT_LIMITS } = require('./core/resource-manager/index.cjs')
const { createHealthSupervisor } = require('./core/health-supervisor/index.cjs')
const { createPluginLock } = require('./core/lockfile/index.cjs')
const { describe: describeCapabilities } = require('./core/contracts/capability.cjs')
// The adapter framework. This host knows that plugins arrive in *some* external format and that
// an adapter turns them into the platform's model; it does not know which formats exist. Adding
// one is a registration, not an edit to this file.
const { createAdapterFramework } = require('./core/plugin-adapters/index.cjs')
const { createNativeHnsAdapter } = require('./core/plugin-adapters/adapters/native-hns.cjs')
const { createCordisAdapter } = require('./core/plugin-adapters/adapters/cordis.cjs')
const { createCordisDshAdapter } = require('./core/plugin-adapters/adapters/cordis-dsh.cjs')
const { createHarnessProfileAdapter } = require('./core/plugin-adapters/adapters/harness-profile.cjs')
const { createProcessPluginAdapter } = require('./core/plugin-adapters/adapters/process.cjs')
const { PARALLEL_MODES, MODE_POLICY } = require('./plugins/acceleration/parallel-executor/index.cjs')
const { mountedPlugins } = require('./plugins/mounted/index.cjs')
const { accelerationPlugins } = require('./plugins/acceleration/index.cjs')

/**
 * Where each plugin belongs in the plan's section 46 grouping.
 *
 * The grouping is data rather than a rule read off the id, because the panel has to show
 * a plugin the vocabulary does not know about (a project may add one) and an unknown
 * plugin must land somewhere sensible instead of vanishing from the list.
 */
const PLUGIN_GROUPS = Object.freeze({
  'dshns.shell-runtime': 'Execution',
  'dshns.computer-use': 'Execution',
  'dshns.ui-stability': 'Execution',
  'dshns.persistent-tools': 'Execution',
  'dshns.git-operator': 'Execution',
  'dshns.long-term-worker': 'Autonomy',
  'dshns.task-supervisor': 'Autonomy',
  'dshns.failure-recovery': 'Autonomy',
  'dshns.watchdog': 'Autonomy',
  'dshns.checkpoint': 'Autonomy',
  'dshns.session-keeper': 'Autonomy',
  'dshns.acceptance-gate': 'Autonomy',
  'dshns.repo-map': 'Coding',
  'dshns.dirty-context': 'Coding',
  'dshns.context-cache': 'Coding',
  'dshns.incremental-validation': 'Coding',
  'dshns.patch-first': 'Coding',
  'dshns.reasoning-governor': 'Performance',
  'dshns.tool-batcher': 'Performance',
  'dshns.command-cache': 'Performance',
  'dshns.parallel-executor': 'Performance',
  'dshns.workspace-isolation': 'Performance',
  'dshns.high-performance': 'Performance',
  'dshns.resource-manager': 'Performance',
  'dshns.telemetry': 'Observability',
  'dshns.model-runtime': 'Observability',
  // Health sampling and pressure scoring are an observability concern first: the plugin watches the
  // machine and the runtime and reports. Its maintenance window and its restart *request* are
  // downstream of that reading, not a separate capability of their own.
  'dshns.health-scheduler': 'Observability',
  /**
   * The restart authority sits in **Execution**, beside the shell runtime and the task supervisor,
   * and that is a statement rather than a convenience: it is the component that runs the product's
   * lifecycle, not one that observes it. `dshns.health-scheduler` above it decides; this one acts,
   * and a panel that grouped them together would blur the line the pair exists to keep.
   */
  'dshns.restart-supervisor': 'Execution'
})

const GROUP_ORDER = Object.freeze(['Execution', 'Autonomy', 'Coding', 'Performance', 'Observability'])

/**
 * The execution settings the panel may change, and the plugin that owns each one.
 *
 * `owner` is what makes a setting real: writing it goes into that plugin's config file and
 * the world is rebuilt, so the value the panel displays is the value the runtime uses.
 */
const EXECUTION_SCHEMA = Object.freeze({
  parallelTaskExecution: { type: 'boolean', default: true, owner: 'dshns.parallel-executor', label: 'Parallel task execution' },
  mode: { type: 'string', enum: Object.values(PARALLEL_MODES), default: PARALLEL_MODES.ADAPTIVE, owner: 'dshns.parallel-executor', label: 'Mode' },
  maxWorkers: { type: 'number', min: 1, max: 16, default: DEFAULT_LIMITS.maxWorkers, owner: 'dshns.resource-manager', label: 'Max workers' },
  parallelRead: { type: 'boolean', default: true, owner: 'dshns.parallel-executor', label: 'Parallel read' },
  parallelTests: { type: 'boolean', default: true, owner: 'dshns.parallel-executor', label: 'Parallel tests' },
  parallelModelCalls: { type: 'boolean', default: true, owner: 'dshns.parallel-executor', label: 'Parallel model calls' },
  parallelWrites: { type: 'string', enum: ['auto', 'never', 'isolated'], default: 'auto', owner: 'dshns.parallel-executor', label: 'Parallel writes' },
  workspaceIsolation: { type: 'string', enum: ['auto', 'off'], default: 'auto', owner: 'dshns.workspace-isolation', label: 'Workspace isolation' },
  cpuLimit: { type: 'number', min: 10, max: 100, default: DEFAULT_LIMITS.cpuPercent, owner: 'dshns.resource-manager', label: 'CPU limit' },
  ramLimit: { type: 'number', min: 10, max: 100, default: DEFAULT_LIMITS.ramPercent, owner: 'dshns.resource-manager', label: 'RAM limit' },
  gpuLimit: { type: 'number', min: 10, max: 100, default: DEFAULT_LIMITS.gpuPercent, owner: 'dshns.resource-manager', label: 'GPU limit' },
  // The high-performance options: one switch per option, owned by the module that
  // implements them, so the panel's toggles are the switches the module actually reads.
  speculativeDecoding: { type: 'boolean', default: true, owner: 'dshns.high-performance', label: 'Speculative decoding' },
  buildCache: { type: 'boolean', default: true, owner: 'dshns.high-performance', label: 'Advanced build cache' },
  autoScaling: { type: 'boolean', default: true, owner: 'dshns.high-performance', label: 'Automatic worker scaling' },
  advancedFim: { type: 'boolean', default: true, owner: 'dshns.high-performance', label: 'Advanced FIM editing' }
})

/**
 * Write one value at a dotted path, creating the intermediate objects.
 *
 * The one rule that matters: a segment that already holds something which is not an object is
 * *replaced* by an object rather than merged into, because "set `budget.maxRestarts`" against a
 * `budget` that is the number `3` has one sensible answer and it is not a crash.
 */
function setPath(target, key, value) {
  const parts = String(key).split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
  return target
}

/**
 * The **advanced** settings the Control Center may change: the two long-hosting plugins' own policy.
 *
 * They are dotted paths into the configuration the plugins already read, and every one of them is a
 * bound the plugin enforces rather than a display value: the thresholds the monitor escalates on, the
 * sampling interval, the hysteresis exit width, the cooldowns, the maintenance window and its two
 * deadlines, and — for the supervisor — the restart budget, the cooldown and backoff, the heartbeat
 * timeouts, the graceful and forced stop budgets and the readiness retry budget.
 *
 * The owners are the plugin ids, so a write lands in `config/plugins/dshns.health-scheduler.json` or
 * `config/plugins/dshns.restart-supervisor.json` and is read back by the plugin's own merge. Nothing
 * here is validated twice: `checkValue` is the host's one validator, and a value it refuses is
 * refused with its reason rather than clamped silently.
 */
const ADVANCED_SCHEMA = Object.freeze({
  // ---- dshns.health-scheduler ----
  intervalMs: { type: 'number', min: 1_000, max: 600_000, owner: 'dshns.health-scheduler', label: 'Sampling interval (ms)' },
  'thresholds.throttle.enter': { type: 'number', min: 1, max: 100, owner: 'dshns.health-scheduler', label: 'Throttle threshold' },
  'thresholds.throttle.exit': { type: 'number', min: 0, max: 100, owner: 'dshns.health-scheduler', label: 'Throttle exit (hysteresis)' },
  'thresholds.pause.enter': { type: 'number', min: 1, max: 100, owner: 'dshns.health-scheduler', label: 'Pause threshold' },
  'thresholds.pause.exit': { type: 'number', min: 0, max: 100, owner: 'dshns.health-scheduler', label: 'Pause exit (hysteresis)' },
  'thresholds.restart.enter': { type: 'number', min: 1, max: 100, owner: 'dshns.health-scheduler', label: 'Restart threshold' },
  'thresholds.restart.exit': { type: 'number', min: 0, max: 100, owner: 'dshns.health-scheduler', label: 'Restart exit (hysteresis)' },
  'cooldowns.restartMs': { type: 'number', min: 60_000, max: 86_400_000, owner: 'dshns.health-scheduler', label: 'Restart request cooldown (ms)' },
  'cooldowns.actionMs': { type: 'number', min: 0, max: 86_400_000, owner: 'dshns.health-scheduler', label: 'Action cooldown (ms)' },
  'restartRequiresSustainedMs': { type: 'number', min: 0, max: 86_400_000, owner: 'dshns.health-scheduler', label: 'Sustained pressure a restart requires (ms)' },
  'maintenance.enabled': { type: 'boolean', owner: 'dshns.health-scheduler', label: 'Maintenance window' },
  'maintenance.windowStart': { type: 'string', enum: hourClockValues(), owner: 'dshns.health-scheduler', label: 'Maintenance window start' },
  'maintenance.windowEnd': { type: 'string', enum: hourClockValues(), owner: 'dshns.health-scheduler', label: 'Maintenance window end' },
  'maintenance.maxDeferMs': { type: 'number', min: 60_000, max: 604_800_000, owner: 'dshns.health-scheduler', label: 'Maximum defer (ms)' },
  'maintenance.deadlineMs': { type: 'number', min: 60_000, max: 2_592_000_000, owner: 'dshns.health-scheduler', label: 'Maintenance deadline (ms)' },
  'model.debounceSamples': { type: 'number', min: 1, max: 10, owner: 'dshns.health-scheduler', label: 'Debounce samples' },
  'model.unknownCoverageBelow': { type: 'number', min: 0, max: 100, owner: 'dshns.health-scheduler', label: 'Coverage floor for UNKNOWN (%)' },
  'model.unknownConfidenceBelow': { type: 'number', min: 0, max: 1, owner: 'dshns.health-scheduler', label: 'Provider-confidence floor for UNKNOWN' },
  // ---- dshns.restart-supervisor ----
  'budget.maxRestarts': { type: 'number', min: 0, max: 50, owner: 'dshns.restart-supervisor', label: 'Restart budget' },
  'budget.windowMs': { type: 'number', min: 60_000, max: 86_400_000, owner: 'dshns.restart-supervisor', label: 'Restart budget window (ms)' },
  'budget.cooldownMs': { type: 'number', min: 0, max: 86_400_000, owner: 'dshns.restart-supervisor', label: 'Restart cooldown (ms)' },
  'budget.backoffMs': { type: 'number', min: 0, max: 86_400_000, owner: 'dshns.restart-supervisor', label: 'Restart backoff (ms)' },
  'budget.backoffMaxMs': { type: 'number', min: 0, max: 86_400_000, owner: 'dshns.restart-supervisor', label: 'Restart backoff ceiling (ms)' },
  'crashLoop.degradedAt': { type: 'number', min: 1, max: 50, owner: 'dshns.restart-supervisor', label: 'Failures before DEGRADED' },
  'crashLoop.safeModeAt': { type: 'number', min: 1, max: 50, owner: 'dshns.restart-supervisor', label: 'Failures before SAFE_MODE' },
  'crashLoop.safeModeOnLoop': { type: 'boolean', owner: 'dshns.restart-supervisor', label: 'Enter safe mode on a crash loop' },
  'heartbeat.intervalMs': { type: 'number', min: 500, max: 300_000, owner: 'dshns.restart-supervisor', label: 'Heartbeat interval (ms)' },
  'heartbeat.timeoutMs': { type: 'number', min: 1_000, max: 600_000, owner: 'dshns.restart-supervisor', label: 'Heartbeat stale timeout (ms)' },
  'heartbeat.livenessTimeoutMs': { type: 'number', min: 1_000, max: 600_000, owner: 'dshns.restart-supervisor', label: 'Process liveness timeout (ms)' },
  'heartbeat.forcedAfterMs': { type: 'number', min: 1_000, max: 3_600_000, owner: 'dshns.restart-supervisor', label: 'Forced restart after (ms)' },
  'heartbeat.gracefulRecoveryMs': { type: 'number', min: 0, max: 3_600_000, owner: 'dshns.restart-supervisor', label: 'Graceful recovery window (ms)' },
  'lifecycle.gracefulTimeoutMs': { type: 'number', min: 1_000, max: 600_000, owner: 'dshns.restart-supervisor', label: 'Graceful stop budget (ms)' },
  'lifecycle.forcedTimeoutMs': { type: 'number', min: 1_000, max: 600_000, owner: 'dshns.restart-supervisor', label: 'Forced stop budget (ms)' },
  'lifecycle.boundaryTimeoutMs': { type: 'number', min: 1_000, max: 3_600_000, owner: 'dshns.restart-supervisor', label: 'Safe-boundary wait (ms)' },
  'readiness.timeoutMs': { type: 'number', min: 1_000, max: 1_800_000, owner: 'dshns.restart-supervisor', label: 'Readiness budget (ms)' },
  'readiness.maxAttempts': { type: 'number', min: 1, max: 60, owner: 'dshns.restart-supervisor', label: 'Readiness attempts per gate' },
  'readiness.backoffMs': { type: 'number', min: 0, max: 300_000, owner: 'dshns.restart-supervisor', label: 'Readiness retry backoff (ms)' },
  'companion.enabled': { type: 'boolean', owner: 'dshns.restart-supervisor', label: 'Out-of-process companion' }
})

/** `HH:MM` on the hour and half hour: what a maintenance window is chosen from. */
function hourClockValues() {
  const values = []
  for (let hour = 0; hour < 24; hour += 1) {
    values.push(`${String(hour).padStart(2, '0')}:00`)
    values.push(`${String(hour).padStart(2, '0')}:30`)
  }
  return values
}

/**
 * Turn the shipped `plugins` block of `config/app.json` into the shape this host wants.
 *
 * The execution settings belong to the plugin that *owns* them, so the deployment's
 * defaults land in the same layer the panel writes to. That is why this mapping lives
 * here rather than in the shell: it decides what the panel displays on a fresh install,
 * and it has to be testable against the shipped configuration.
 */
function executionDefaults(block = {}) {
  const execution = block && typeof block.execution === 'object' && block.execution !== null ? block.execution : {}
  const plugins = {
    'dshns.parallel-executor': {
      mode: execution.mode,
      parallelTaskExecution: execution.parallelTaskExecution,
      parallelRead: execution.parallelRead,
      parallelTests: execution.parallelTests,
      parallelModelCalls: execution.parallelModelCalls,
      parallelWrites: execution.parallelWrites
    },
    'dshns.resource-manager': {
      maxWorkers: execution.maxWorkers,
      cpuLimit: execution.cpuLimit,
      ramLimit: execution.ramLimit,
      gpuLimit: execution.gpuLimit
    },
    'dshns.workspace-isolation': { workspaceIsolation: execution.workspaceIsolation },
    'dshns.high-performance': execution.highPerformance && typeof execution.highPerformance === 'object' ? { ...execution.highPerformance } : {}
  }
  for (const id of Array.isArray(block && block.disabled) ? block.disabled : []) plugins[String(id)] = { enabled: false }
  // Drop the keys the config did not actually declare, so the defaults layer stays honest
  // about what the deployment decided rather than filling in values nobody wrote.
  for (const [id, values] of Object.entries(plugins)) {
    plugins[id] = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
  }
  return { enabled: block && block.enabled !== false, enforceLock: block && block.enforceLock === true, plugins }
}

/**
 * @param {object} [options]
 * @param {string} [options.root] the repository root (defaults to the app's parent)
 * @param {string} [options.configDir] where plugin config files live
 * @param {object} [options.defaults] the shipped `plugins` block from `config/app.json`
 * @param {object} [options.profile] the active profile's config block
 * @param {string} [options.lockFile] an explicit lockfile path
 * @param {boolean} [options.enforceLock] refuse to load when the lock has drifted
 * @param {string} [options.nodeExe] the node binary an isolated adapter runs its plugin under
 * @param {number} [options.compatTimeoutMs] the activation budget for an isolated plugin
 * @param {object} [options.permissionPolicy] `{ allow?: string[], deny?: string[] }`, applied by
 *   the adapter framework when it decides what a plugin holds. It can only narrow.
 * @param {object} [options.hostServices] the real services a community plugin's host half may be
 *   mediated onto, currently `{ webServer, settings }`. Absent is a normal deployment: the shell is
 *   a different process from the harness, and the bridge reports the absence instead of faking it.
 * @param {string[]} [options.peerRoots] directories that provide a community plugin's
 *   peerDependencies. Defaults to this application's own `node_modules`, because a peer dependency
 *   is by definition the host's to provide.
 * @param {Function} [options.available] `() => boolean`
 * @param {Function} [options.reason] `() => string`
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
function createPluginHost(options = {}) {
  const root = path.resolve(String(options.root || path.join(__dirname, '..')))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const available = typeof options.available === 'function' ? options.available : () => true
  const reason = typeof options.reason === 'function' ? options.reason : () => 'the plugin runtime is disabled'
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {}
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {}
  /**
   * Core's task-continuity hooks, when the shell supplied them.
   *
   * They travel to the shipped plugins that declare a need for them (the restart supervisor) and to
   * nothing else. The host does not implement them: parking and resuming a task is Core's, and a
   * second implementation here would be a second answer to "what was interrupted".
   */
  const continuity = options.continuity && typeof options.continuity === 'object' ? options.continuity : null

  const bus = createEventBus({ now })
  const registry = createCapabilityRegistry({ now, bus })
  const config = createConfigManager({
    root,
    dir: options.configDir || path.join(root, 'config', 'plugins'),
    defaults: { plugins: defaults.plugins || {} },
    profile,
    log: (event) => log(`plugin config: ${JSON.stringify(event).slice(0, 200)}`)
  })
  const lock = createPluginLock({ root, file: options.lockFile, log: (message) => log(message) })

  /**
   * The adapter framework: the one place in this host that knows external plugin formats exist.
   *
   * Two adapters ship with the product — the platform's own format, and adoption of a foreign
   * package in an isolated process — and they are registered here rather than hard-coded below.
   * The registration is the extension point: a third format is one more `register` call, and the
   * mock adapter in `core/plugin-adapters/adapters/mock.cjs` is the worked example of that.
   *
   * The permission policy is the deployment's, and it can only narrow what a plugin holds. It is
   * deliberately empty by default: shipping a deny-list would make an adopted plugin refuse to
   * load for a reason the user never chose.
   */
  const adapters = createAdapterFramework({
    log: (event) => log(`adapter ${JSON.stringify(event).slice(0, 200)}`),
    policy: options.permissionPolicy && typeof options.permissionPolicy === 'object' ? options.permissionPolicy : {}
  })
  adapters.register(createNativeHnsAdapter())
  // Managed background processes: a plugin the host *runs* rather than loads. Registered without
  // services because the adapter needs none -- its whole surface is the process contract, which is
  // what makes it able to serve a supervisor, a Python server and a compiled binary alike.
  adapters.register(createProcessPluginAdapter({
    nodeExe: options.nodeExe,
    log: (event) => log(`process ${JSON.stringify(event).slice(0, 200)}`)
  }))
  adapters.register(createCordisDshAdapter({
    // The real services a community plugin's host half is allowed to reach, if this deployment has
    // any. The shell is a different process from the harness, so it usually has no `webServer` —
    // and that is *reported* rather than papered over: the bridge refuses a route registration with
    // `BRIDGE_SERVICE_UNAVAILABLE`, the plugin is degraded with that reason on its health surface,
    // and nothing pretends a route exists. A deployment that wants community plugins to serve
    // traffic passes the service in here.
    services: options.hostServices && typeof options.hostServices === 'object' ? options.hostServices : {},
    // peerDependencies are the host's to provide, so the harness's own install is a root by
    // default: a community plugin's `@deepseek-ai/dsh-host-webserver` resolves from it.
    roots: Array.isArray(options.peerRoots) && options.peerRoots.length
      ? options.peerRoots
      : [path.join(__dirname, 'node_modules')],
    nodeExe: options.nodeExe,
    log: (event) => log(`cordis-dsh ${JSON.stringify(event).slice(0, 200)}`)
  }))
  adapters.register(createCordisAdapter({
    nodeExe: options.nodeExe,
    timeoutMs: options.compatTimeoutMs,
    log: (event) => log(`compat ${JSON.stringify(event).slice(0, 200)}`)
  }))
  /**
   * The plugins that belong to a **Harness profile** rather than to this host: the community client
   * plugins DS-Hns offers at install time (`@dsh-market/plugin`, `dsh-plugin-wallpaper-engine`).
   *
   * It is registered above the bridged community adapter on purpose. `dshns.cordis-dsh` *runs* a
   * community bundle's host half in a mediated child process, which is the right answer for a plugin
   * this product hosts — and the wrong answer for one the Harness is already composing out of the
   * profile it boots, because that would be a second instance of it. This adapter only reads the
   * installed package and reports the format, the peers and the browser half; `load()` starts nothing.
   *
   * Same roots as the bridged adapter: a profile plugin's `peerDependencies` are the host's to
   * provide, and the harness's own install is a root by default.
   */
  adapters.register(createHarnessProfileAdapter({
    roots: Array.isArray(options.peerRoots) && options.peerRoots.length
      ? options.peerRoots
      : [path.join(__dirname, 'node_modules')],
    log: (event) => log(`harness-profile ${JSON.stringify(event).slice(0, 200)}`)
  }))

  /**
   * The resource manager, built from the *configured* limits.
   *
   * `cpuLimit`, `ramLimit`, `gpuLimit` and `maxWorkers` are panel settings, so they have
   * to reach the object that derives the worker count — otherwise the panel would be
   * writing values into a file that nothing reads, which is worse than having no settings
   * at all. Rebuilt whenever the world is.
   */
  function buildResources() {
    const configured = config.forPlugin('dshns.resource-manager').resolved
    const limits = {}
    if (Number.isFinite(configured.cpuLimit)) limits.cpuPercent = configured.cpuLimit
    if (Number.isFinite(configured.ramLimit)) limits.ramPercent = configured.ramLimit
    if (Number.isFinite(configured.gpuLimit)) limits.gpuPercent = configured.gpuLimit
    if (Number.isFinite(configured.maxWorkers)) limits.maxWorkers = configured.maxWorkers
    return createResourceManager({ now, limits })
  }
  let resources = buildResources()

  const events = []
  bus.onAny((payload, event) => {
    events.push({ type: event.type, at: event.at, plugin: payload && payload.plugin ? payload.plugin : null })
    if (events.length > 400) events.splice(0, events.length - 400)
  })

  let manager = null
  let supervisor = null
  let lockState = null
  let world = null
  const reloads = new Map()
  const errors = new Map()

  function disabled() {
    if (!available()) return { ok: false, error: reason(), code: 'PLUGIN_RUNTIME_DISABLED' }
    return null
  }

  /** What went wrong with any store-installed plugin, for the status and the manager. */
  const installedFailures = []

  /** The compatibility-mode plugins currently mounted, by id, for the panel and the setup flow. */
  const compatPlugins = new Map()

  /** Read a JSON file, returning null instead of throwing: package.json is optional here. */
  function readJsonFile(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Import one native plugin module.
   *
   * `require` cannot read an ES module, and an ESM plugin is a legitimate plugin: module format is
   * part of the same compatibility story as a foreign API, so a `.mjs` entry — or a `.js` entry
   * inside a `"type": "module"` package — is imported instead. The file's mtime is part of the URL
   * so that reinstalling changed code is picked up (the ESM cache cannot be purged the way
   * `require.cache` can) without creating a new module instance on every load.
   */
  async function importNativeModule(main, dir) {
    const pkg = readJsonFile(path.join(dir, 'package.json'))
    const esm = /\.mjs$/i.test(main) || Boolean(pkg && pkg.type === 'module' && /\.c?js$/i.test(main))
    if (!esm) {
      const loaded = require(main)
      return typeof loaded === 'function' ? loaded() : loaded
    }
    let stamp = 0
    try {
      stamp = fs.statSync(main).mtimeMs
    } catch {}
    const namespace = await import(`${pathToFileURL(main).href}?mtime=${stamp}`)
    const loaded = namespace && namespace.default !== undefined ? namespace.default : namespace
    return typeof loaded === 'function' ? loaded() : loaded
  }

  /**
   * Plugins the user installed from the store and enabled.
   *
   * This is the *second* stage of the store's two-step install and the only place in the product
   * that brings in code the user chose: staging put it on disk and verified its manifest (or
   * derived a compatibility descriptor for it), and `enabled: true` in
   * `data/plugins/installed.json` is the record that they asked for it to run. A plugin that
   * cannot be mounted is skipped and reported rather than taken down the whole host — a broken
   * third-party plugin must not stop the product from starting.
   *
   * **This host no longer knows what an external plugin format is.** It does two things and
   * neither of them names a format:
   *
   *   1. turn each recorded entry into an *artifact* — a directory, and the module the entry
   *      names when the plugin is one that runs in this process (an adopted plugin's code is
   *      deliberately not imported here: running it in the shell is the thing adoption exists to
   *      avoid);
   *   2. hand the artifacts to the adapter framework, which detects what each one is, selects an
   *      adapter and returns the platform's standard plugin model.
   *
   * Which formats exist, which adapter wins, and what a refusal is called are all decided below
   * this line. A new format is a detector and an adapter registered on the framework, and this
   * function does not change.
   */
  async function installedArtifacts() {
    const file = path.join(root, 'data', 'plugins', 'installed.json')
    const out = []
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return out
    }
    const entries = Array.isArray(raw && raw.plugins) ? raw.plugins : []

    /** Step 1: what the host can contribute without knowing anything about the format. */
    const artifacts = []
    for (const entry of entries) {
      if (!entry || entry.enabled !== true || !entry.dir) continue
      const id = String(entry.id || entry.dir)
      const dir = path.resolve(entry.dir)
      if (entry.compatibility === 'compat') {
        artifacts.push({ dir, repo: entry.repo || null, branch: entry.branch || null, source: entry.repo || dir, entry })
        continue
      }
      const main = path.resolve(dir, String(entry.main || 'index.cjs'))
      // The entry point must stay inside the plugin directory: a manifest that points elsewhere
      // would be a way to import arbitrary files by editing JSON.
      const relative = path.relative(dir, main)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        const reason = `${entry.main} escapes the plugin directory`
        installedFailures.push({ id, reason })
        log(`installed plugin ${id} could not be mounted: ${reason}`)
        continue
      }
      try {
        const imported = await importNativeModule(main, dir)
        artifacts.push({ dir, module: imported, repo: entry.repo || null, branch: entry.branch || null, source: entry.repo || dir, entry })
      } catch (error) {
        const reason = String(error && error.message ? error.message : error)
        installedFailures.push({ id, reason })
        log(`installed plugin ${id} could not be mounted: ${reason}`)
      }
    }

    /**
     * Everything this half can contribute is the artifact list.
     *
     * It deliberately does **not** adapt anything: `buildWorld` runs one adaptation pass over the
     * shipped artifacts and these together, so both halves go through the same detectors, the same
     * selection, the same standardisation and the same per-artifact fault isolation.
     */
    return artifacts
  }

  /**
   * The plugin artifacts this host runs: the product's own sets plus what the user installed.
   *
   * Both halves are *artifacts*, not plugin objects, and that is the point of this function. The
   * shipped sets used to be handed to the manager as ready-made plugins while store installs went
   * through the adapter framework — two loaders for one platform, with the product's own plugins
   * quietly skipping the standard sections and the per-artifact fault isolation. Now there is one
   * list and one adaptation pass, and a shipped plugin that cannot be adapted fails alone with a
   * coded reason exactly like any other.
   */
  async function pluginSets() {
    return [...shippedArtifacts(), ...(await installedArtifacts())]
  }

  /**
   * The product's own plugin sets, as artifacts for the framework to adapt.
   *
   * The shell's **continuity layer** is handed to the mounted set here, and only to it: the restart
   * supervisor is the plugin that asks "what is running, park it, continue it", and the answer is
   * Core's own (`app/core/task-continuity.cjs`), not something a plugin may implement for itself. A
   * store-installed plugin is never given it — a third-party plugin that could park the product's
   * tasks would be a plugin that can stop a user's work.
   */
  function shippedArtifacts() {
    const host = continuity && typeof continuity === 'object' ? { ...continuity } : null
    return [...mountedPlugins({ host, nodeExe: options.nodeExe, stateDir: options.restartSupervisorStateDir }), ...accelerationPlugins()].map((plugin) => ({
      module: plugin,
      source: 'the shipped plugin set',
      shipped: true
    }))
  }

  /** The ids that came from the store, so the lock can tell them from the shipped set. */
  const installedIds = new Set()

  /** Where a third-party plugin's code lands: the one subtree that may be reloaded. */
  function storeDirectory() {
    return path.join(root, 'data', 'plugins', 'store')
  }

  /**
   * Drop the module cache for everything under the store directory.
   *
   * `require` caches by resolved path, so a plugin that was removed and installed again —
   * or reinstalled from a newer commit — would otherwise be handed back as the *old* module
   * object, and the "reinstall" button would appear to do nothing. Only the store's own
   * subtree is purged: the product's shipped plugins are not reloadable from disk and must
   * keep their single instance.
   */
  function purgeInstalledCache() {
    const base = storeDirectory()
    let purged = 0
    for (const file of Object.keys(require.cache)) {
      const relative = path.relative(base, file)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      delete require.cache[file]
      purged += 1
    }
    return purged
  }

  /**
   * Re-read the installed set and, when the world is already built, rebuild it in place.
   *
   * Enabling, disabling, removing or reinstalling a store plugin used to need a restart,
   * because the world is built once and cached. This is the other half of that contract: the
   * shell calls it when the store reports that the installed set changed, the store's cached
   * modules are dropped, and the world is rebuilt — so the plugin set the panel shows and the
   * plugin set the runtime is running are the same set, without the user restarting DS-Hns.
   *
   * A world that was never built is deliberately *not* built here. It is built on first use
   * from the same file this would have re-read, so building it now would only make the user
   * pay for a plugin load they have not asked for; the answer says so instead of lying about
   * having reloaded something.
   */
  async function refreshInstalled(why = 'the installed plugin set changed') {
    const off = disabled()
    if (off) return off
    const before = new Set(installedIds)
    const purged = purgeInstalledCache()
    installedIds.clear()
    installedFailures.length = 0
    // The compat registry is a view of the installed set too: an entry left behind would keep
    // being listed, and its isolated process would be unreachable. The stop is awaited because
    // "unloaded" has to mean the process is gone, not merely signalled.
    for (const plugin of compatPlugins.values()) {
      try {
        await plugin.unload()
      } catch {}
    }
    compatPlugins.clear()
    if (!manager) {
      return {
        ok: true,
        rebuilt: false,
        built: false,
        why,
        purged,
        mounted: [],
        removed: [],
        failures: [],
        note: 'the plugin runtime has not been built yet; its first build reads the installed set from disk'
      }
    }
    const outcome = await rebuild()
    const after = new Set(installedIds)
    const mounted = [...after].filter((id) => !before.has(id))
    const removed = [...before].filter((id) => !after.has(id))
    const failures = installedFailures.slice()
    log(`installed plugin set refreshed (${why}): ${mounted.length} mounted, ${removed.length} removed, ${failures.length} failed, ${purged} cached module(s) dropped`)
    return {
      ok: outcome.ok !== false,
      rebuilt: true,
      built: true,
      why,
      purged,
      mounted,
      removed,
      failures,
      error: outcome.ok === false ? outcome.error : null
    }
  }

  /** The config block the manager is constructed with, resolved through the layering. */
  function managerConfig(plugins) {
    const out = { plugins: {} }
    for (const plugin of plugins) {
      const id = plugin.manifest.id
      const resolved = config.forPlugin(id)
      const fromStore = installedIds.has(id)
      out.plugins[id] = {
        // An entry in `installed.json` with `enabled: true` is the user's own decision, and it
        // outranks a manifest's `default_enabled: false`: without this, a store plugin that ships
        // switched off (every compatibility-mode plugin does) would be mounted and never loaded —
        // enabled in the panel and not running, with nothing saying why.
        // A later explicit lifecycle choice in plugin config outranks store
        // installation too; otherwise a disabled store plugin reappears on rebuild.
        enabled: resolved.sources.enabled === 'plugin-config' && typeof resolved.resolved.enabled === 'boolean'
          ? resolved.resolved.enabled
          : fromStore ? true : (typeof resolved.resolved.enabled === 'boolean' ? resolved.resolved.enabled : undefined),
        config: resolved.resolved
      }
    }
    return out
  }

  /**
   * Install and load both sets in capability order.
   *
   * Services are handed to every plugin context; the optional collaborators are resolved
   * *late* by the plugins themselves, so nothing here depends on the order two manifests
   * happen to be installed in.
   */
  async function buildWorld() {
    const artifacts = await pluginSets()

    /**
     * One adaptation pass over everything: the product's own sets and the user's installs.
     *
     * `adaptMany` reports a failure *per artifact* and never one for the batch, and the framework
     * never throws — so however badly one adapter behaves, the other plugins are still produced and
     * the shell still starts. Running it here, once, over both halves is what removes the second
     * loader: a shipped plugin and a store plugin now take the identical path, and a shipped plugin
     * that cannot be adapted is a coded failure rather than a failure of the world build.
     */
    const adapted = await adapters.adaptMany(artifacts)
    const plugins = adapted.plugins
    for (const result of adapted.results) {
      const artifact = result.artifact || {}
      const entry = artifact.entry || null
      if (result.ok === true) {
        const plugin = result.plugin
        const adaptation = plugin.adaptation || null
        // Only a store install is the user's addition; the shipped set is the product's own
        // composition and stays out of that bookkeeping.
        if (!artifact.shipped) installedIds.add(String(plugin.manifest.id))
        // The compat registry is a view of the adopted set, and the panel keys its badge off it.
        if (plugin.compatibility === 'compat') compatPlugins.set(String(plugin.manifest.id), plugin)
        log(
          `plugin adapted: ${plugin.manifest.id} v${plugin.manifest.version}`
          + ` via ${adaptation ? adaptation.adapter.id : 'no adapter'}`
          + ` (${adaptation ? adaptation.detected_type : 'unknown'}, ${plugin.standard ? plugin.standard.runtime_kind : 'unknown'} runtime)`
          + `${artifact.shipped ? ' [shipped]' : entry && entry.repo ? ` from ${entry.repo}` : ''}`
        )
        continue
      }
      const shippedId = artifact.module && artifact.module.manifest ? String(artifact.module.manifest.id) : null
      const id = entry ? String(entry.id || entry.dir) : (shippedId || `artifact[${result.index}]`)
      const reason = result.reason || 'the plugin could not be adapted'
      installedFailures.push({
        id,
        reason,
        code: result.code || null,
        phase: result.phase || null,
        adapter: result.adapter ? result.adapter.id : null
      })
      errors.set(id, { ok: false, code: result.code || null, reason })
      log(`plugin ${id} could not be adapted: ${reason}`)
    }

    const services = {
      root,
      workspace: root,
      resourceManagement: resources,
      get gitOperation() {
        return registry.resolve('git-operation', { optional: true })
      },
      get workspaceIsolation() {
        return registry.resolve('workspace-isolation', { optional: true })
      },
      get processSupervision() {
        return registry.resolve('process-supervision', { optional: true })
      }
    }
    const next = createPluginManager({ bus, registry, config: managerConfig(plugins), services, now, log: (event) => log(`plugin ${JSON.stringify(event).slice(0, 200)}`) })
    for (const plugin of plugins) {
      const installed = next.install(plugin)
      if (!installed.ok) errors.set(plugin.manifest.id, installed)
    }
    const meta = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin.manifest]))
    return { manager: next, meta, services }
  }

  /** Build the world if it is not built, checking the lock first. */
  async function ensure() {
    const off = disabled()
    if (off) return off
    if (manager) return { ok: true, manager, lock: lockState }
    world = await buildWorld()
    /**
     * The lock describes the *product's* composition, not the user's additions.
     *
     * A store-installed plugin is deliberately not part of it: `dshns-lock.yaml` pins the set
     * that ships, so a user who installs something is not "drift" — and enforcing the lock must
     * not be a way to make the product refuse to start because of a choice the user made in the
     * store.
     */
    const shipped = world.manager.list()
      .filter((entry) => !installedIds.has(entry.id))
      .map((entry) => ({ id: entry.id, version: entry.version }))
    lockState = lock.verify(shipped)
    // The lock is checked before anything loads, because a drifted composition is exactly
    // what a lockfile exists to prevent running.
    if (lockState.ok === false && options.enforceLock === true) {
      return { ok: false, error: `the plugin lock has drifted: ${lockState.reason}`, code: lockState.code, drift: lockState }
    }
    manager = world.manager
    await manager.loadAll()
    supervisor = createHealthSupervisor({ manager, bus, now, log: (event) => log(`plugin health: ${JSON.stringify(event).slice(0, 200)}`) })
    // One health pass at build time, so the first paint of the panel shows real health
    // rather than a blank column that appears when somebody clicks.
    await manager.checkAllHealth()
    for (const entry of manager.list()) {
      if (entry.health && entry.health.status !== 'healthy') errors.set(entry.id, entry.health)
      else errors.delete(entry.id)
    }
    return { ok: true, manager, lock: lockState }
  }

  /** Rebuild the world after a configuration change: the manager resolves config once. */
  async function rebuild() {
    if (manager) await manager.unloadAll()
    manager = null
    supervisor = null
    // A limit change has to reach the object that derives the worker count, so the
    // resource manager is rebuilt from the new configuration rather than left holding the
    // old numbers.
    resources = buildResources()
    return ensure()
  }

  /** One line per plugin, grouped the way the plan's section 46 draws it. */
  function list() {
    const off = disabled()
    if (off) return { ...off, groups: [], plugins: [] }
    if (!manager) return { ok: true, built: false, groups: [], plugins: [], lock: lockState }
    const plugins = manager.list().map((entry) => {
      // The manager's record holds the *normalized* manifest, so optional capabilities are
      // always a list even when the raw manifest omitted them.
      const record = manager.entry(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        group: PLUGIN_GROUPS[entry.id] || 'Other',
        installed: entry.installed,
        enabled: entry.enabled,
        loaded: entry.loaded,
        healthy: entry.healthy,
        health: entry.health ? entry.health.status : null,
        faultLevel: entry.faultLevel,
        fault: entry.fault ? String(entry.fault.reason || '') : null,
        provides: entry.provides,
        requires: entry.requires,
        optional: record ? record.optional.slice() : [],
        modelSpecific: entry.modelSpecific,
        restartCount: reloads.get(entry.id) || 0,
        error: errors.has(entry.id) ? String((errors.get(entry.id) || {}).reason || '') : null,
        // Whether the plugin declared this platform's contract itself or was adopted from another
        // ecosystem, plus the live state of the isolated process. A compat plugin is never shown
        // as an ordinary plugin with nothing said about it.
        compatibility: compatPlugins.has(entry.id) ? 'compat' : 'native',
        compat: compatPlugins.has(entry.id) ? compatPlugins.get(entry.id).compatibilityState() : null,
        guarantees: compatPlugins.has(entry.id) ? compatPlugins.get(entry.id).compatibilityInfo.guarantees || null : null,
        // The standard sections, straight off the manager's record. Every plugin has them,
        // including the ones that arrived in a foreign format, which is what makes one panel
        // able to show all of them.
        permissions: entry.permissions || null,
        runtime: entry.runtime || null,
        adapter: entry.adapter || null,
        adaptation: entry.adaptation || null,
        lifecycle: entry.lifecycle || null,
        errorCount: entry.errorCount || 0
      }
    })
    const groups = []
    for (const name of [...GROUP_ORDER, 'Other']) {
      const members = plugins.filter((plugin) => plugin.group === name)
      if (members.length) groups.push({ name, plugins: members })
    }
    return { ok: true, built: true, groups, plugins, lock: lockState }
  }

  /** Everything the panel shows when one plugin is clicked (plan section 46). */
  function describe(input = {}) {
    const off = disabled()
    if (off) return off
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, error: 'a plugin id is required', code: 'PLUGIN_ID_REQUIRED' }
    if (!manager) return { ok: false, error: 'the plugin runtime has not been built yet', code: 'PLUGIN_RUNTIME_NOT_BUILT' }
    const record = manager.entry(id)
    if (!record) return { ok: false, error: `no plugin ${id}`, code: 'PLUGIN_NOT_FOUND' }
    // The manager's own status() already carries state, dependencies and config with the
    // layer each value came from; the host adds the panel's grouping and its own counters.
    const status = manager.status(id)
    return {
      ...status,
      group: PLUGIN_GROUPS[id] || 'Other',
      version: record.version,
      apiVersion: record.api_version,
      // `status` carries the capability *detail* (each name with its providers); the
      // panel needs the plain names too, or it renders "[object Object]" beside the label.
      capabilities: record.capabilities.slice(),
      capabilityDetail: status.capabilities,
      requires: record.requires.slice(),
      optional: record.optional.slice(),
      modelSpecific: record.model_specific,
      configFile: config.fileFor(id),
      health: record.health ? { status: record.health.status, reason: record.health.reason, latencyMs: record.health.latency_ms, at: record.health.at } : null,
      latencyMs: record.health ? record.health.latency_ms : null,
      restartCount: reloads.get(id) || 0,
      error: record.fault ? String(record.fault.reason || '') : null,
      compatibility: compatPlugins.has(id) ? 'compat' : 'native',
      compat: compatPlugins.has(id) ? compatPlugins.get(id).compatibilityState() : null,
      guarantees: compatPlugins.has(id) ? compatPlugins.get(id).compatibilityInfo.guarantees || null : null,
      configIssues: config.issues().filter((issue) => issue.plugin === id)
    }
  }

  async function setEnabled(input = {}) {
    const off = disabled()
    if (off) return off
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, error: 'a plugin id is required', code: 'PLUGIN_ID_REQUIRED' }
    await ensure()
    if (!manager) return { ok: false, error: 'the plugin runtime could not be built', code: 'PLUGIN_RUNTIME_UNAVAILABLE' }
    if (!manager.has(id)) return { ok: false, error: `no plugin ${id}`, code: 'PLUGIN_NOT_FOUND' }
    const enabled = input.enabled !== false
    // Lifecycle choices must survive configure() rebuilding the manager and
    // subsequent desktop launches. Preserve the plugin's other settings, and
    // refuse unreadable/unwritable configuration before changing live state.
    const file = config.fileFor(id)
    let current = {}
    try {
      if (fs.existsSync(file)) {
        current = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('plugin config must be an object')
      }
    } catch (error) {
      return { ok: false, code: 'CONFIG_UNREADABLE', error: `cannot read ${file}: ${error.message}` }
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ ...current, enabled }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, code: 'CONFIG_UNWRITABLE', error: `cannot write ${file}: ${error.message}` }
    }
    config.refresh()
    const outcome = enabled ? manager.enable(id) : await manager.disable(id)
    if (outcome.ok) {
      const loaded = enabled ? await manager.load(id) : { ok: true, already: true }
      return { ok: loaded.ok !== false, id, enabled, load: { ok: loaded.ok !== false, code: loaded.code || null, reason: loaded.reason || null } }
    }
    return outcome
  }

  async function reload(input = {}) {
    const off = disabled()
    if (off) return off
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, error: 'a plugin id is required', code: 'PLUGIN_ID_REQUIRED' }
    await ensure()
    if (!manager) return { ok: false, error: 'the plugin runtime could not be built', code: 'PLUGIN_RUNTIME_UNAVAILABLE' }
    const outcome = await manager.reload(id)
    if (outcome.ok) {
      reloads.set(id, (reloads.get(id) || 0) + 1)
      errors.delete(id)
    } else {
      errors.set(id, outcome)
    }
    return { ...outcome, restartCount: reloads.get(id) || 0 }
  }

  async function health(input = {}) {
    const off = disabled()
    if (off) return off
    await ensure()
    if (!manager) return { ok: false, error: 'the plugin runtime could not be built', code: 'PLUGIN_RUNTIME_UNAVAILABLE' }
    if (input.id) {
      const id = String(input.id)
      if (!manager.has(id)) return { ok: false, error: `no plugin ${id}`, code: 'PLUGIN_NOT_FOUND' }
      const checked = await manager.checkHealth(id)
      if (checked.status !== 'healthy') errors.set(id, checked)
      else errors.delete(id)
      return { ok: true, id, health: checked, supervisor: supervisor ? supervisor.reactionTo(id, checked) : null }
    }
    const all = await manager.checkAllHealth()
    return { ok: true, health: all, supervisor: supervisor ? supervisor.status() : null }
  }

  /** The capability vocabulary, its declared providers and whether each one is provided. */
  function capabilities() {
    return {
      ok: true,
      capabilities: describeCapabilities().map((entry) => ({
        ...entry,
        provided: registry.has(entry.capability),
        actualProviders: registry.describe(entry.capability).map((provider) => provider.owner)
      }))
    }
  }

  /** The plan's section 45 block, resolved from the layered config with its source. */
  function execution() {
    const off = disabled()
    if (off) return off
    const fields = {}
    for (const [key, rule] of Object.entries(EXECUTION_SCHEMA)) {
      const resolved = config.forPlugin(rule.owner)
      const raw = Object.prototype.hasOwnProperty.call(resolved.resolved, key) ? resolved.resolved[key] : undefined
      const checked = config.checkValue(raw === undefined ? rule.default : raw, rule)
      fields[key] = {
        value: checked.ok ? checked.value : rule.default,
        default: rule.default,
        owner: rule.owner,
        label: rule.label,
        source: raw === undefined ? 'default' : resolved.sources[key] || 'plugin-config',
        valid: checked.ok,
        reason: checked.ok ? null : checked.reason
      }
    }
    const mode = fields.mode.value
    return {
      ok: true,
      fields,
      modePolicy: MODE_POLICY[mode] ? { mode, ...MODE_POLICY[mode] } : null,
      workerDecision: resources.effectiveWorkers({ maxWorkers: fields.maxWorkers.value }),
      modes: Object.values(PARALLEL_MODES),
      owners: [...new Set(Object.values(EXECUTION_SCHEMA).map((rule) => rule.owner))]
    }
  }

  /**
   * Change execution settings.
   *
   * Every key is validated against the schema this host owns; an unknown key or an
   * out-of-range value is refused with a reason rather than written. What is written goes
   * into the owning plugin's config file, and the world is rebuilt so the runtime and the
   * panel cannot disagree about what is set.
   *
   * A key may be **dotted** (`thresholds.throttle.enter`, `budget.maxRestarts`,
   * `maintenance.windowStart`), which is how the two long-hosting plugins' advanced settings are
   * addressed: their configuration is a small tree — thresholds with an enter and an exit, a
   * maintenance window with a start and an end, a restart budget with a window and a backoff — and
   * flattening it into one level of keys would be this host inventing a second shape for values the
   * plugins already read. A dotted write goes into the same file, at the same depth, so what the
   * panel sets is what `mergeConfig` in the plugin reads.
   *
   * The rebuild is what makes a change *take*: the plugins resolve their configuration at
   * construction, so a write without a reload would be a value stored in a file that nothing reads —
   * which is worse than refusing it.
   */
  async function configure(input = {}) {
    const off = disabled()
    if (off) return off
    const patch = input.settings && typeof input.settings === 'object' ? input.settings : input
    const schema = { ...EXECUTION_SCHEMA, ...ADVANCED_SCHEMA }
    const unknown = Object.keys(patch).filter((key) => !Object.prototype.hasOwnProperty.call(schema, key))
    if (unknown.length) return { ok: false, code: 'UNKNOWN_SETTING', error: `unknown setting(s): ${unknown.join(', ')}`, known: Object.keys(schema) }
    const accepted = {}
    const rejected = []
    const owners = new Set()
    for (const [key, raw] of Object.entries(patch)) {
      const rule = schema[key]
      const checked = config.checkValue(raw, rule)
      if (!checked.ok) {
        rejected.push({ key, value: raw, reason: checked.reason })
        continue
      }
      accepted[key] = checked.value
      owners.add(rule.owner)
    }
    if (rejected.length) return { ok: false, code: 'INVALID_SETTING', error: rejected.map((entry) => `${entry.key}: ${entry.reason}`).join('; '), rejected }
    if (!Object.keys(accepted).length) return { ok: true, changed: {}, reloaded: false, note: 'nothing to change', execution: execution() }

    const written = []
    for (const owner of owners) {
      const file = config.fileFor(owner)
      let current = {}
      try {
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
          if (parsed && typeof parsed === 'object') current = parsed
        }
      } catch (error) {
        return { ok: false, code: 'CONFIG_UNREADABLE', error: `cannot read ${file}: ${error && error.message ? error.message : error}` }
      }
      const block = { ...current }
      for (const [key, value] of Object.entries(accepted)) {
        if (schema[key].owner !== owner) continue
        if (key.includes('.')) setPath(block, key, value)
        else block[key] = value
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify(block, null, 2)}\n`, 'utf8')
      } catch (error) {
        return { ok: false, code: 'CONFIG_UNWRITABLE', error: `cannot write ${file}: ${error && error.message ? error.message : error}` }
      }
      written.push(file)
    }
    config.refresh()
    const rebuilt = manager ? await rebuild() : { ok: true }
    return { ok: rebuilt.ok !== false, changed: accepted, written, reloaded: Boolean(manager), execution: execution(), error: rebuilt.ok === false ? rebuilt.error : null }
  }

  /**
   * What a compatibility-mode plugin needs before it can run, as commands a user confirms.
   *
   * An adopted plugin is somebody else's package, and two of the states it can be in are answered
   * by real work on this machine: installing the dependencies it declares, and running the build
   * script that produces the entry it declares. Neither happens here — this only *describes* the
   * commands, in full, for the confirmation dialog, so what the user agrees to is exactly what
   * will run.
   */
  function compatSetup(input = {}) {
    const off = disabled()
    if (off) return off
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, error: 'a plugin id is required', code: 'PLUGIN_ID_REQUIRED' }
    const plugin = compatPlugins.get(id)
    if (!plugin) return { ok: false, code: 'PLUGIN_NOT_COMPAT', error: `${id} is not a compatibility-mode plugin` }
    const deps = require('./core/plugin-compat/deps.cjs')
    const state = plugin.compatibilityState()
    const plans = []
    if (Array.isArray(state.missing) && state.missing.length) {
      plans.push(deps.describeInstall({ dir: plugin.directory, packages: state.missing }))
    } else if (state.status === 'needs-dependencies' && state.dependencies.length) {
      plans.push(deps.describeInstall({ dir: plugin.directory, packages: state.dependencies }))
    }
    if (!state.entryExists && state.build) {
      // A build needs the package's own toolchain, which lives in its dev dependencies: install
      // everything first, then run the script. Two commands, one confirmation, shown in order —
      // and the script is named, with the command inside it shown beside it.
      plans.push(deps.describeFullInstall({ dir: plugin.directory }))
      plans.push(deps.describeBuild({ dir: plugin.directory, script: state.build, command: state.buildCommand }))
    }
    return {
      ok: true,
      id,
      plugin: plugin.manifest.id,
      state,
      plans: plans.filter((plan) => plan && plan.ok === true),
      refused: plans.filter((plan) => plan && plan.ok !== true),
      note: 'nothing is installed or built until these commands are confirmed'
    }
  }

  /**
   * Run the confirmed commands for one compat plugin, in order.
   *
   * The confirmation is passed down rather than assumed: `deps.runDescribed` refuses without it, so
   * a caller that forgot to ask the user cannot install anything by accident.
   */
  function compatApplySetups(input = {}) {
    const off = disabled()
    if (off) return off
    const id = String(input.id || '').trim()
    const plugin = compatPlugins.get(id)
    if (!plugin) return { ok: false, code: 'PLUGIN_NOT_COMPAT', error: `${id} is not a compatibility-mode plugin` }
    const described = compatSetup({ id })
    if (described.ok !== true) return described
    // Nothing to run is not a failure and needs no confirmation; anything else does, and the
    // confirmation check comes before a single command is described to the runner.
    if (!described.plans.length) return { ok: true, id, results: [], note: 'nothing to run' }
    if (input.confirm !== true) {
      return { ok: false, code: 'COMPAT_NOT_CONFIRMED', error: 'the user has not confirmed these commands', plans: described.plans }
    }
    const deps = require('./core/plugin-compat/deps.cjs')
    const results = []
    for (const plan of described.plans) {
      const result = deps.runDescribed(plan, { confirm: true, timeoutMs: input.timeoutMs })
      results.push(result)
      // The sequence is a sequence: a build after a failed install would only produce a second,
      // more confusing failure.
      if (result.ok !== true) break
    }
    return { ok: results.every((result) => result.ok === true), id, results }
  }

  /** Section 40: the lockfile, its state, and what it says about the shipped set. */
  function lockfile(input = {}) {
    const off = disabled()
    if (off) return off
    // Only the product's own plugins are lockable: a user's store installs are their choice,
    // and pinning them here would make the lock a record of the wrong thing.
    const shipped = manager ? manager.list().filter((entry) => !installedIds.has(entry.id)) : []
    const installed = shipped.map((entry) => ({ id: entry.id, version: entry.version }))
    if (input.write === true) {
      if (!manager) return { ok: false, error: 'the plugin runtime has not been built yet, so there is nothing to lock', code: 'PLUGIN_RUNTIME_NOT_BUILT' }
      const written = lock.write(installed, { apiVersion: 'dshns.plugin/v1' })
      lockState = lock.verify(installed)
      return { ...written, state: lockState }
    }
    return { ok: true, file: lock.file, read: lock.read(), state: lockState, installed: installed.length, fromStore: installedIds.size }
  }

  function status() {
    const off = disabled()
    if (off) return { ...off, built: false }
    const listed = list()
    const plugins = listed.plugins || []
    return {
      ok: true,
      built: Boolean(manager),
      root,
      plugins: plugins.length,
      byState: {
        installed: plugins.filter((plugin) => plugin.installed).length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        loaded: plugins.filter((plugin) => plugin.loaded).length,
        healthy: plugins.filter((plugin) => plugin.healthy === true).length,
        unhealthy: plugins.filter((plugin) => plugin.healthy === false).length,
        disabled: plugins.filter((plugin) => plugin.installed && !plugin.enabled).length
      },
      health: supervisor ? supervisor.status() : null,
      // Compatibility mode at a glance: how many adopted plugins there are, how many are running,
      // and how many are waiting on a decision only the user can make.
      compat: (() => {
        const states = [...compatPlugins.values()].map((plugin) => plugin.compatibilityState())
        return {
          total: states.length,
          running: states.filter((state) => state.status === 'running').length,
          needsDependencies: states.filter((state) => state.status === 'needs-dependencies').length,
          needsBuild: states.filter((state) => state.status === 'needs-build').length,
          failed: states.filter((state) => state.status === 'failed').length,
          unsupported: states.filter((state) => state.status === 'unsupported').length
        }
      })(),
      lock: lockState,
      capabilities: registry.capabilities(),
      events: events.slice(-40),
      configIssues: config.issues(),
      /**
       * Everything that is not working, from both halves of the plugin picture.
       *
       * The manager's map covers plugins that were mounted and then faulted. An entry that could
       * not be *adapted* never becomes a plugin and so never appears there — but it is exactly the
       * failure a user needs to see, which is why the adapter failures are merged in beside it
       * with the adapter and phase that produced them.
       */
      errors: [
        ...[...errors.entries()].map(([id, value]) => ({
          id,
          error: String((value || {}).reason || value || ''),
          source: 'plugin'
        })),
        ...installedFailures.map((failure) => ({
          id: failure.id,
          error: failure.reason,
          source: 'adapter',
          code: failure.code || null,
          phase: failure.phase || null,
          adapter: failure.adapter || null
        }))
      ],
      groups: GROUP_ORDER.slice()
    }
  }

  /**
   * One plugin as a **service record** — everything a management surface needs, from the sources that
   * own each fact.
   *
   * The plugin manager knows the four states, the capabilities and the fault; the adapter record
   * knows which format it arrived in; the plugin's own `domainDiagnostics()` knows what it is doing
   * right now. This merges them once so three surfaces (the official UI's settings section, the Mega
   * panel and the governance bridge) do not each invent their own join — and so a fact that is
   * missing is reported as missing rather than as healthy.
   *
   * `domainDiagnostics()` is read rather than the platform's standardised `diagnostics()`, and the
   * difference matters: the standard one is **async** (it runs a health check) and describes the
   * plugin's *lifecycle*, while the domain one is synchronous and describes the plugin's *subject* —
   * the monitor's pressure and trend, the supervisor's budget and companion. A service record has to
   * be a plain object: a panel, an IPC reply and the governance bridge all serialise it, and a
   * Promise in it would arrive as `{}`.
   *
   * It is called defensively: it is plugin code, and a plugin whose diagnostics throw must still
   * appear in the list with the fault named. That is the same per-plugin fault isolation the adapter
   * framework applies at load time, applied to the read path.
   */
  function serviceRecordOf(id) {
    const wanted = String(id)
    // `list()` is the host's own report (`{ ok, plugins, ... }`), not the manager's flat array: the
    // host's shape is the one that carries the standard sections a management surface reads.
    const described = list()
    const plugins = Array.isArray(described) ? described : (described && Array.isArray(described.plugins) ? described.plugins : [])
    const record = plugins.find((entry) => entry.id === wanted) || null
    if (!record) return { ok: false, id: wanted, reason: `${wanted} is not part of the plugin runtime` }
    const managed = manager ? manager.entry(wanted) : null
    let diagnostics = null
    let diagnosticsError = null
    try {
      const candidate = managed && managed.plugin ? managed.plugin : null
      if (candidate && typeof candidate.domainDiagnostics === 'function') {
        diagnostics = candidate.domainDiagnostics()
      } else if (candidate && typeof candidate.diagnostics === 'function') {
        // A plugin that only has the standard hook is still read — but only when it answers with a
        // value: a promise here would be serialised as an empty object, which is worse than `null`.
        const answer = candidate.diagnostics()
        diagnostics = answer && typeof answer.then === 'function' ? null : answer
      }
    } catch (error) {
      diagnosticsError = String(error && error.message ? error.message : error)
    }
    /**
     * The health answer, from the layer that owns it.
     *
     * `list()` publishes only the status *word* (`entry.health` is a string there, or null), while the
     * manager's own record holds the whole answer — status, reason, latency and the detail block a
     * panel reads (`heartbeat`, `fallback`). Reading the word and calling it the record produced a
     * health object with `status: undefined`, which every tone function then treated as "not
     * degraded", and a supervisor with no companion drew as merely unhealthy instead of degraded with
     * its reason. So the object is taken from the manager, and the word is the fallback for a plugin
     * whose record the manager no longer keeps (one unloaded between the two reads).
     */
    const managedHealth = managed && managed.health && typeof managed.health === 'object' ? managed.health : null
    const listedHealth = record.health
    const health = managedHealth || (typeof listedHealth === 'string' ? { status: listedHealth } : (listedHealth && typeof listedHealth === 'object' ? listedHealth : null))
    const detail = health && health.detail ? health.detail : {}
    return {
      ok: true,
      id: record.id,
      name: record.name,
      version: record.version,
      apiVersion: record.apiVersion,
      /** The four separate facts, never collapsed into one "on/off". */
      installed: record.installed === true,
      enabled: record.enabled === true,
      loaded: record.loaded === true,
      healthy: record.healthy,
      health: health ? { status: health.status, reason: health.reason || null, at: health.at || null } : null,
      /** The heartbeat, when the plugin reports one. Absent is `null`, which is never "fine". */
      heartbeat: detail.heartbeat || (diagnostics && diagnostics.heartbeat ? diagnostics.heartbeat : null),
      lastError: record.fault
        ? { code: record.fault.code, reason: record.fault.reason, at: record.fault.at || null }
        : (diagnosticsError ? { code: 'DIAGNOSTICS_THREW', reason: diagnosticsError } : null),
      capabilities: { provides: record.provides.slice(), requires: record.requires.slice() },
      fallback: detail.fallback || null,
      adapter: record.adapter || null,
      permissions: record.permissions || null,
      runtime: record.runtime || null,
      lifecycle: record.lifecycle || null,
      /** Whatever the plugin itself publishes, verbatim: the surfaces read, they do not interpret. */
      diagnostics: diagnostics || null,
      /** The bounded history a panel draws, not a live handle. */
      recentFaults: managed && Array.isArray(managed.faults) ? managed.faults.slice(-5).map((fault) => ({ code: fault.code, reason: fault.reason, at: fault.at || null })) : []
    }
  }

  /** Stop everything this host owns. Called on shell teardown. */
  async function dispose(why = 'shell teardown') {
    try {
      if (supervisor) supervisor.stop()
      // The isolated processes are the host's to end: leaving one behind would leave a
      // third-party plugin running after the product exited.
      for (const plugin of compatPlugins.values()) {
        try {
          await plugin.unload()
        } catch {}
      }
      compatPlugins.clear()
      if (manager) await manager.unloadAll()
    } catch (error) {
      log(`plugin host dispose failed: ${error && error.message ? error.message : error}`)
    }
    manager = null
    supervisor = null
    world = null
    log(`plugin host disposed (${why})`)
    return true
  }

  return {
    PLUGIN_CHANNELS: ['plugins:status', 'plugins:list', 'plugins:describe', 'plugins:enable', 'plugins:reload', 'plugins:health', 'plugins:refresh', 'plugins:compat-setup', 'plugins:compat-apply', 'plugins:capabilities', 'plugins:execution', 'plugins:configure', 'plugins:lock'],
    EXECUTION_SCHEMA,
    ADVANCED_SCHEMA,
    PLUGIN_GROUPS,
    ensure,
    status,
    list,
    describe,
    setEnabled,
    reload,
    refreshInstalled,
    health,
    capabilities,
    /**
     * The adapter framework's own view: every plugin type it can detect, which adapters take
     * them, what each adapter promises, and the permission vocabulary and policy in force.
     *
     * Read-only and side-effect free — it adapts nothing — so the panel can explain an adapted
     * plugin without holding a plugin object, which is the same rule the rest of this host
     * follows.
     */
    adapters: () => adapters.describe(),
    /**
     * One plugin as a **service record** — everything a management surface needs, from the sources
     * that own each fact.
     *
     * The plugin manager knows the four states, the capabilities and the fault; the adapter record
     * knows which format it arrived in; and the plugin's own `domainDiagnostics()` knows what it is
     * doing right now. This merges them once so three surfaces (the official UI's settings section,
     * the Mega panel and the governance bridge) do not each invent their own join — and so a fact
     * that is missing is reported as missing rather than as healthy.
     *
     * `domainDiagnostics()` is read rather than the platform's async, standardised `diagnostics()`:
     * a service record is serialised by all three surfaces, so it has to be a plain object rather
     * than a Promise, and the fields a panel draws are the plugin's own (see `serviceRecordOf`).
     */
    serviceReport: (id) => {
      try {
        return serviceRecordOf(id)
      } catch (error) {
        return { ok: false, id: String(id), reason: String(error && error.message ? error.message : error) }
      }
    },
    /**
     * The plugin world as **service records**, in one call.
     *
     * With no ids it answers for **every** plugin in the runtime, not for the two built-ins: the official
     * page is the surface every user has, and a roster that showed two of twenty-five plugins would make
     * the rest invisible exactly where they matter most. The two the requirement names are simply the
     * first two, and `serviceRecordOf` keeps their state apart like any other plugin's.
     */
    serviceReports: (ids) => {
      const all = list()
      const plugins = Array.isArray(all) ? all : (all && Array.isArray(all.plugins) ? all.plugins : [])
      const wanted = Array.isArray(ids) && ids.length
        ? ids.map(String)
        : (plugins.length ? plugins.map((entry) => entry.id) : ['dshns.health-scheduler', 'dshns.restart-supervisor'])
      return wanted.map((id) => {
        try {
          return serviceRecordOf(id)
        } catch (error) {
          return { ok: false, id, reason: String(error && error.message ? error.message : error) }
        }
      })
    },
    /**
     * The formal `restart_status`, as its own read.
     *
     * It is deliberately not only a field inside the supervisor's service record: "when did this
     * machine last restart, why, and what came back?" is the question a person asks a *product*, and a
     * surface that had to know which plugin owns it would be a surface that cannot show it when that
     * plugin is the thing that failed. The answer is read from the same record the official page draws,
     * and from the file that survives the process.
     */
    restartStatus: () => {
      try {
        const record = serviceRecordOf('dshns.restart-supervisor')
        const status = record && record.diagnostics ? record.diagnostics.restartStatus : null
        if (status) return status
        return {
          status: 'restart_status',
          phase: 'UNKNOWN',
          inFlight: false,
          reason: record && record.reason ? record.reason : 'the restart supervisor is not in this runtime',
          summary: 'no restart status is available',
          history: [],
          historyCount: 0
        }
      } catch (error) {
        return { status: 'restart_status', phase: 'UNKNOWN', inFlight: false, reason: String(error && error.message ? error.message : error), history: [], historyCount: 0 }
      }
    },
    /**
     * Start the out-of-process halves a plugin asks for **at boot**, and only at boot.
     *
     * The restart supervisor's companion is deliberately not started when its plugin loads: loading a
     * plugin is not a reason to fork a process, and a suite that mounts the shipped set would fork one
     * per mount. So the shell calls this once, from the boot sequence, and it asks the plugin that has
     * somewhere to run to start it — a plugin without one answers `skipped`, which is not an error.
     */
    startCompanions: () => {
      const started = []
      if (!manager) return { ok: true, built: false, started, note: 'the plugin runtime has not been built' }
      for (const record of manager.list()) {
        const plugin = manager.entry(record.id)
        const candidate = plugin && plugin.plugin ? plugin.plugin : null
        if (!candidate || typeof candidate.ensureCompanion !== 'function') continue
        try {
          started.push({ id: record.id, ...candidate.ensureCompanion({ force: true }) })
        } catch (error) {
          started.push({ id: record.id, ok: false, reason: String(error && error.message ? error.message : error) })
        }
      }
      return { ok: true, built: true, started }
    },
    /**
     * Tell the out-of-process halves to stand down, because the product is leaving on purpose.
     *
     * This is the other half of `startCompanions`, and it is what keeps a supervisor from mistaking a
     * normal exit for a crash: the companion watches a process table, and "the pid went away" reads the
     * same either way. The plugin that owns the state directory writes the note; the shell only relays
     * the fact that this is an exit and not a failure. A companion that is not running answers
     * `skipped`, and a plugin without one is not asked.
     */
    stopCompanions: (reason = 'the application is exiting normally') => {
      const stopped = []
      if (!manager) return { ok: true, built: false, stopped, note: 'the plugin runtime has not been built' }
      for (const record of manager.list()) {
        const plugin = manager.entry(record.id)
        const candidate = plugin && plugin.plugin ? plugin.plugin : null
        if (!candidate || typeof candidate.stopCompanion !== 'function') continue
        try {
          stopped.push({ id: record.id, ...candidate.stopCompanion(reason) })
        } catch (error) {
          stopped.push({ id: record.id, ok: false, reason: String(error && error.message ? error.message : error) })
        }
      }
      return { ok: true, built: true, stopped }
    },
    execution,
    configure,
    lockfile,
    compatSetup,
    compatApplySetups,
    dispose,
    /** The live manager, for the shell's own diagnostics only. */
    get manager() {
      return manager
    },
    get bus() {
      return bus
    },
    get registry() {
      return registry
    },
    get resources() {
      return resources
    },
    get root() {
      return root
    }
  }
}

module.exports = { createPluginHost, executionDefaults, EXECUTION_SCHEMA, ADVANCED_SCHEMA, PLUGIN_GROUPS, GROUP_ORDER }
