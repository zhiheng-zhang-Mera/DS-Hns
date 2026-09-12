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
const surface = require('./surface')
const capability = require('./capability')
const color = require('./color')
const validator = require('./validator')
const png = require('./png')
const assets = require('./asset-factory')
const assetPlanner = require('./assets/planner')
const assetGenerator = require('./assets/generator')
const assetProcessor = require('./assets/processor')
const assetValidator = require('./assets/validator')
const assetFallback = require('./assets/fallback')
const overlayLayout = require('./official/overlay-layout')
const overlaySafety = require('./official/overlay-safety')
const designer = require('./designer')
const builder = require('./builder')
const registryModule = require('./registry')
const recoveryModule = require('./recovery')
const preview = require('./preview')
const inspector = require('./inspector')
const runtimeModule = require('./runtime')
const lifecycleModule = require('./lifecycle')
const orchestratorModule = require('./orchestrator')
const modelAdapterModule = require('./model-adapter')

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
 * @param {Function} [options.visualExpected]  () => { expected, reason } — is a screenshot possible right now?
 * @param {Function} [options.officialBounds]  () => { x, y, width, height } — the protected official view's real bounds
 * @param {Function} [options.imageGenerator]  async ({ prompt, spec, kind, surface }) => PNG bytes (optional)
 * @param {Function} [options.paintSurfaces]   (payload, placement) => { ok } — paints official_shell + official_overlay
 * @param {Function} [options.resetSurfaces]   () => { ok } — restores the default official frame
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
  visualExpected = () => null,
  officialBounds = null,
  imageGenerator = null,
  paintSurfaces = null,
  resetSurfaces = null,
  modelInterpreter = null,
  log = () => {},
  onChanged = () => {}
} = {}) {
  const registry = registryModule.createRegistry({ log })

  /**
   * The overlay layout the latest design produced.
   *
   * The prepaint wrapper needs it to place the official overlay's character box,
   * and it must be readable before the orchestrator exists (the wrapper is created
   * first), so it is a small forward reference rather than a second source of
   * truth: the orchestrator assigns it whenever it plans.
   */
  let currentPlacement = null
  const latestPlacement = () => currentPlacement

  const recovery = recoveryModule.createRecoveryManager({
    log,
    resolveDir: (id) => registry.dirFor(id),
    darkThemeDir: registry.dirFor(registryModule.SYSTEM_DARK_ID)
  })

  const runtime = runtimeModule.createThemeRuntime({
    registry,
    recovery,
    // Every repaint reaches the official surfaces too. The wrapper is what makes
    // "the theme is applied" and "the official shell and overlay are applied" one
    // operation from the caller's point of view, while a surface failure can only
    // disable the surfaces (任务 18) — the dock is painted first and always.
    applyToRenderer: (payload) => {
      applyToRenderer(payload)
      if (typeof paintSurfaces !== 'function') return
      try {
        const placement = latestPlacement()
        paintSurfaces(payload, placement)
      } catch (error) {
        log(`official surface paint failed (surfaces degraded, HNS theme kept): ${error?.message || error}`)
      }
    },
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
    visualExpected,
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

  /**
   * The optional AI designer. It is a refinement layer only: with no worker
   * configured the adapter stays disabled and the deterministic interpreter
   * produces the same output contract, so the AI layer is never a boot
   * dependency.
   */
  const modelAdapter = modelAdapterModule.createModelAdapter({
    interpret: modelInterpreter,
    log: (message) => log(`model: ${message}`)
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
    modelInterpreter: modelAdapter.interpreter,
    capturePreview: capture,
    // The protected official view's bounds are a rectangle, nothing more: the
    // layout engine needs to know where the frame is, never what is inside it.
    officialBounds,
    imageGenerator,
    onPlanned: (planned) => { currentPlacement = planned?.placement || null },
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
    surface,
    capability,
    color,
    validator,
    png,
    assets,
    assetPipeline: {
      planner: assetPlanner,
      generator: assetGenerator,
      processor: assetProcessor,
      validator: assetValidator,
      fallback: assetFallback
    },
    official: {
      layout: overlayLayout,
      safety: overlaySafety
    },
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
    /** The three plan documents + the overlay layout for the latest design. */
    plans: () => {
      const latest = [...orchestrator.sessions().values()].pop() || null
      return latest?.plans || null
    },
    /**
     * Paint the two official surfaces (Update-Plan 任务 2 / 任务 3).
     *
     * The hook is optional and failure-isolated: with nothing wired the official
     * surfaces simply are not painted, and a throwing hook can only disable them
     * (任务 18) — never the HNS theme.
     */
    paintSurfaces: (payload, placement = null) => {
      try {
        return typeof paintSurfaces === 'function' ? paintSurfaces(payload, placement) : { ok: false, reason: 'no_surface_target' }
      } catch (error) {
        log(`official surface paint failed (surfaces disabled, HNS theme kept): ${error?.message || error}`)
        return { ok: false, reason: 'surface_paint_failed', error: String(error?.message || error) }
      }
    },
    /** Reset the official surfaces to the default frame. */
    resetSurfaces: () => {
      try {
        return typeof resetSurfaces === 'function' ? resetSurfaces() : { ok: false, reason: 'no_surface_target' }
      } catch (error) {
        log(`official surface reset failed: ${error?.message || error}`)
        return { ok: false, reason: 'surface_reset_failed' }
      }
    },
    /** On-disk truth for the latest snapshot: JSON + verified PNGs. */
    snapshotArtifacts: () => snapshot.artifacts(),
    modelAdapter,
    setModelInterpreter: (fn) => {
      const adapter = modelAdapterModule.createModelAdapter({ interpret: fn, log: (message) => log(`model: ${message}`) })
      orchestrator.setModelInterpreter(adapter.interpreter)
      return adapter.describe()
    },
    setImageGenerator: (fn) => orchestrator.setImageGenerator(fn),
    setOfficialBounds: (fn) => orchestrator.setOfficialBounds(fn)
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
  surface,
  capability,
  color,
  validator,
  png,
  assets,
  assetPipeline: {
    planner: assetPlanner,
    generator: assetGenerator,
    processor: assetProcessor,
    validator: assetValidator,
    fallback: assetFallback
  },
  official: {
    layout: overlayLayout,
    safety: overlaySafety
  },
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
