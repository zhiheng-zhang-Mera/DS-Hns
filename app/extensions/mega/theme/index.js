'use strict'

/**
 * HNS Theme System — public engine facade.
 *
 * Assembly point for the whole subsystem. Nothing outside this directory should
 * need to reach past `createThemeEngine()`.
 *
 * Wiring:
 *   registry   durable theme list + active selection
 *   recovery   load guard; any failure degrades to Dark
 *   runtime    live paint target + load-aware effect budget
 *   snapshot   UI structure + visual snapshot service
 *   builder    approved design -> self-contained package
 *   lifecycle  install / delete / duplicate / restore / import
 *   orchestrator  the mandated Prompt -> ... -> Install pipeline
 */
const contract = require('./contract')
const capability = require('./capability')
const color = require('./color')
const validator = require('./validator')
const png = require('./png')
const assets = require('./asset-factory')
const designer = require('./designer')
const builder = require('./builder')
const registryModule = require('./registry')
const recoveryModule = require('./recovery')
const preview = require('./preview')
const inspector = require('./inspector')
const runtimeModule = require('./runtime')
const lifecycleModule = require('./lifecycle')
const orchestratorModule = require('./orchestrator')

/** Read the live system load for effect degradation, from the scheduler. */
function makeLoadReader({ scheduler, log }) {
  return function readLoad() {
    try {
      const described = scheduler && typeof scheduler.describe === 'function' ? scheduler.describe() : null
      const system = described?.system || null
      if (!system) return null
      const cpu = Number(system.cpu?.usagePercent)
      const freeGb = Number(system.memory?.freeGb)
      const running = Number(described?.activeQueue?.running || 0)
      const slots = Number(described?.activeQueue?.workerSlotsInUse || 0)
      const capacity = Number(described?.concurrency?.current || described?.concurrency?.cap || 0)
      return {
        cpuPercent: Number.isFinite(cpu) ? cpu : null,
        freeGb: Number.isFinite(freeGb) ? freeGb : null,
        running,
        slots: slots || capacity,
        capacity,
        sampledAt: new Date().toISOString()
      }
    } catch (error) {
      log?.(`theme load read failed: ${error?.message || error}`)
      return null
    }
  }
}

/**
 * Build the theme engine.
 *
 * @param {object} options
 * @param {Function} options.applyToRenderer async|sync (payload) => void
 * @param {object}   [options.scheduler]
 * @param {Function} [options.capture]         async ({ pages, dockWindow }) => { pageId: pngBuffer }
 * @param {Function} [options.dockRegions]     () => slotId -> bbox
 * @param {Function} [options.componentTree]   () => tree
 * @param {Function} [options.windowSize]      () => [w, h]
 * @param {Function} [options.dockState]       () => dock state
 * @param {Function} [options.modelInterpreter]
 * @param {Function} [options.log]
 * @param {Function} [options.onChanged]
 */
function createThemeEngine({
  applyToRenderer = () => {},
  scheduler = null,
  capture = null,
  dockRegions = () => ({}),
  componentTree = () => null,
  windowSize = () => null,
  dockState = () => null,
  modelInterpreter = null,
  log = () => {},
  onChanged = () => {}
} = {}) {
  const registry = registryModule.createRegistry({ log })

  const recovery = recoveryModule.createRecoveryManager({
    log,
    resolveDir: (id) => registry.dirFor(id),
    darkThemeDir: registry.dirFor(registryModule.SYSTEM_DARK_ID)
  })

  const runtime = runtimeModule.createThemeRuntime({
    registry,
    recovery,
    applyToRenderer,
    readLoad: makeLoadReader({ scheduler, log }),
    log
  })

  const snapshot = inspector.createSnapshotService({
    capture: capture || (async () => ({})),
    dockRegions,
    componentTree,
    windowSize,
    currentTheme: () => runtime.currentTheme(),
    dockState,
    manifest: () => runtime.manifest({ dockState: safeCall(dockState), engineVersion: null }),
    log
  })

  const lifecycle = lifecycleModule.createLifecycle({
    registry,
    builder,
    runtime,
    recovery,
    // The package loader is a module-level capability, not a guard-instance one:
    // duplication needs to read a source package without triggering recovery.
    loadPackage: recoveryModule.loadPackage,
    log,
    onChanged
  })

  const orchestrator = orchestratorModule.createOrchestrator({
    registry,
    recovery,
    runtime,
    lifecycle,
    snapshot,
    builder,
    log,
    onChanged,
    modelInterpreter,
    capturePreview: capture,
    readLoad: () => {
      try { return runtime.describe().load } catch { return null }
    }
  })

  let started = false

  function start() {
    if (started) return
    started = true
    try {
      runtime.start()
    } catch (error) {
      log(`theme runtime start failed, continuing with Dark: ${error?.message || error}`)
      try {
        runtime.activate(registryModule.RECOVERY_THEME_ID, { persist: false, reason: 'runtime-start-failed' })
      } catch (inner) {
        log(`theme recovery start failed: ${inner?.message || inner}`)
      }
    }
  }

  function stop() {
    if (!started) return
    started = false
    try { runtime.stop() } catch {}
  }

  return {
    contract,
    capability,
    color,
    validator,
    png,
    assets,
    designer,
    builder,
    preview,
    inspector,
    registry,
    recovery,
    runtime,
    lifecycle,
    orchestrator,
    start,
    stop,
    /** Renderer prep payload for the currently active theme. */
    paintPayload: () => runtime.rendererPayload(runtime.currentTheme(), { preview: Boolean(runtime.describe().previewing) }),
    describe: () => orchestrator.describe(),
    capabilities: () => orchestrator.capabilities(),
    setModelInterpreter: (fn) => orchestrator.setModelInterpreter(fn)
  }
}

function safeCall(fn) {
  try {
    return typeof fn === 'function' ? fn() : null
  } catch {
    return null
  }
}

module.exports = {
  createThemeEngine,
  makeLoadReader,
  // Re-exported so tests and the dock can use one import root.
  contract,
  capability,
  color,
  validator,
  png,
  assets,
  designer,
  builder,
  recovery: recoveryModule,
  registry: registryModule,
  inspector,
  lifecycle: lifecycleModule,
  orchestrator: orchestratorModule,
  runtime: runtimeModule,
  preview
}
