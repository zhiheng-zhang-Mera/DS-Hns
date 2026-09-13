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
  'dshns.model-runtime': 'Observability'
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

  /** The product's own plugin sets, in install order. */
  function shippedPlugins() {
    return [...mountedPlugins(), ...accelerationPlugins()]
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
   * that imports code the user brought: staging put it on disk and verified its manifest (or
   * derived a compatibility descriptor for it), and `enabled: true` in
   * `data/plugins/installed.json` is the record that they asked for it to run. A module that
   * cannot be imported is skipped and reported rather than taken down the whole host — a broken
   * third-party plugin must not stop the product from starting.
   *
   * Two kinds of entry arrive here, and they are loaded differently on purpose:
   *
   *   * **native** — the plugin declared `dshns.plugin/v1` itself, so its module is imported and
   *     its own manifest is used;
   *   * **compat** — the plugin was adopted from another ecosystem, so its module is activated in
   *     an isolated process and the manifest comes from the descriptor the installer derived.
   */
  async function installedPlugins() {
    const file = path.join(root, 'data', 'plugins', 'installed.json')
    const out = []
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return out
    }
    const entries = Array.isArray(raw && raw.plugins) ? raw.plugins : []
    for (const entry of entries) {
      if (!entry || entry.enabled !== true || !entry.dir) continue
      const id = String(entry.id || entry.dir)
      try {
        const dir = path.resolve(entry.dir)
        if (entry.compatibility === 'compat') {
          // The descriptor is the store's own file format, and this host is the only reader of it;
          // resolving it here rather than copying the shape keeps one definition of the format.
          const { readCompatDescriptor, COMPAT_FILE } = require('./extensions/mega/store/compat.cjs')
          const descriptor = readCompatDescriptor(dir)
          if (!descriptor) throw new Error(`${COMPAT_FILE} is missing or unreadable, so the plugin cannot be adopted again`)
          const { createCompatPlugin } = require('./core/plugin-compat/index.cjs')
          const plugin = createCompatPlugin({
            descriptor,
            dir,
            nodeExe: options.nodeExe,
            compatTimeoutMs: options.compatTimeoutMs,
            log
          })
          if (!plugin.manifest) throw new Error('the compatibility descriptor does not carry a valid manifest')
          out.push(plugin)
          compatPlugins.set(String(plugin.manifest.id), plugin)
          installedIds.add(String(plugin.manifest.id))
          log(`compat plugin mounted: ${plugin.manifest.id} (${descriptor.kind}, ${descriptor.api}, ${descriptor.format}, ${descriptor.state}) from ${entry.repo}`)
          continue
        }
        const main = path.resolve(dir, String(entry.main || 'index.cjs'))
        // The entry point must stay inside the plugin directory: a manifest that points
        // elsewhere would be a way to import arbitrary files by editing JSON.
        if (path.relative(dir, main).startsWith('..')) throw new Error(`${entry.main} escapes the plugin directory`)
        const plugin = await importNativeModule(main, dir)
        if (!plugin || typeof plugin.manifest !== 'object') throw new Error('the module does not export a plugin with a manifest')
        out.push(plugin)
        installedIds.add(String(plugin.manifest.id))
        log(`installed plugin mounted: ${plugin.manifest.id} v${plugin.manifest.version} from ${entry.repo}`)
      } catch (error) {
        const reason = String(error && error.message ? error.message : error)
        installedFailures.push({ id, reason })
        log(`installed plugin ${id} could not be mounted: ${reason}`)
      }
    }
    return out
  }

  /** The plugin objects this host runs: the product's own sets plus what the user installed. */
  async function pluginSets() {
    return [...shippedPlugins(), ...(await installedPlugins())]
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
        enabled: fromStore ? true : (typeof resolved.resolved.enabled === 'boolean' ? resolved.resolved.enabled : undefined),
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
    const plugins = await pluginSets()
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
        guarantees: compatPlugins.has(entry.id) ? compatPlugins.get(entry.id).compatibilityInfo.guarantees || null : null
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
   */
  async function configure(input = {}) {
    const off = disabled()
    if (off) return off
    const patch = input.settings && typeof input.settings === 'object' ? input.settings : input
    const unknown = Object.keys(patch).filter((key) => !Object.prototype.hasOwnProperty.call(EXECUTION_SCHEMA, key))
    if (unknown.length) return { ok: false, code: 'UNKNOWN_SETTING', error: `unknown setting(s): ${unknown.join(', ')}`, known: Object.keys(EXECUTION_SCHEMA) }
    const accepted = {}
    const rejected = []
    const owners = new Set()
    for (const [key, raw] of Object.entries(patch)) {
      const rule = EXECUTION_SCHEMA[key]
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
      for (const [key, value] of Object.entries(accepted)) if (EXECUTION_SCHEMA[key].owner === owner) block[key] = value
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
      errors: [...errors.entries()].map(([id, value]) => ({ id, error: String((value || {}).reason || value || '') })),
      groups: GROUP_ORDER.slice()
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

module.exports = { createPluginHost, executionDefaults, EXECUTION_SCHEMA, PLUGIN_GROUPS, GROUP_ORDER }
