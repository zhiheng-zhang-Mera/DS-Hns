'use strict'

/**
 * A mock adapter — the proof that the framework is extensible, and the worked example of how.
 *
 * This file is not part of the product's plugin set. It exists because "the architecture supports
 * new formats" is a claim, and a claim about extensibility is worth exactly as much as a second
 * format that was actually added. This is that second format, written the way a third party would
 * write it: **one detector and one adapter, in one file, with no change to the framework, the
 * registry, the contract or the plugin manager.**
 *
 * The format it understands is deliberately unlike anything the platform ships:
 *
 * ```json
 * // mock-plugin.json
 * {
 *   "mock_format": 1,
 *   "name": "@acme/demo",
 *   "version": "2.1.0",
 *   "handler": "handler.js",
 *   "capabilities": ["demo"],
 *   "permissions": ["fs.read", "bus.emit"],
 *   "config": { "greeting": "hi" }
 * }
 * ```
 *
 * ```js
 * // handler.js — CommonJS, and not a Cordis plugin in any sense
 * module.exports = {
 *   start: (ctx) => ({ ok: true, detail: `started for ${ctx.id}` }),
 *   stop:  () => true,
 *   health: () => ({ status: 'healthy', reason: 'the demo handler is up' })
 * }
 * ```
 *
 * Four things the example is chosen to demonstrate, because each is a place a naive adapter
 * framework fails:
 *
 *   1. **A new type.** `mock.manifest` is not in the platform's type vocabulary; the detector
 *      introduces it and the registry routes it. Neither was modified to allow that.
 *   2. **A new lifecycle shape.** The handler's `start`/`stop`/`health` are mapped onto the
 *      platform's `load`/`unload`/`healthCheck` *by the adapter* — the manager sees the standard
 *      four hooks and has no idea they are translations.
 *   3. **Permissions that are the framework's to grant.** The adapter proposes what the manifest
 *      declares; the framework decides, and a deployment policy can refuse it.
 *   4. **A refusal that stays a value.** A missing handler, a handler that is not a module, a
 *      `start` that throws — all three are coded refusals here, and none of them reaches the
 *      caller's loop or the application's startup.
 */

const fs = require('node:fs')
const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')

/** The file the mock format is declared in, and the type name it detects as. */
const MOCK_FORMAT_FILE = 'mock-plugin.json'
const MOCK_PLUGIN_TYPE = 'mock.manifest'

/** Read a JSON file, returning null instead of throwing. */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The detector for the mock format.
 *
 * Registered through `detector.register(...)`, the same door a real third-party format would use.
 * It reads one file, reports the evidence it found, and nothing else.
 */
function createMockDetector() {
  return {
    id: 'mock-format',
    priority: 80,
    detect(artifact) {
      if (!artifact || !artifact.dir) return null
      const file = path.join(artifact.dir, MOCK_FORMAT_FILE)
      let stat = null
      try {
        stat = fs.statSync(file)
      } catch {
        return null
      }
      if (!stat.isFile()) return null
      const declaration = readJson(file)
      if (!declaration) {
        return { type: 'unknown', confidence: 0.2, evidence: [`${MOCK_FORMAT_FILE} exists but could not be parsed`] }
      }
      return {
        type: MOCK_PLUGIN_TYPE,
        confidence: 0.85,
        evidence: [`${MOCK_FORMAT_FILE}#mock_format=${declaration.mock_format || '(absent)'}`],
        detail: { declaration }
      }
    }
  }
}

/**
 * The adapter for the mock format.
 *
 * @param {object} [options]
 * @param {Function} [options.log]
 * @param {Function} [options.require] injectable module loader, for tests
 */
function createMockAdapter(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const load = typeof options.require === 'function' ? options.require : (file) => require(file)

  /** The handler module, refused if it tries to escape the plugin directory. */
  function handlerFor(dir, relative) {
    if (!relative) return adapterFault(ADAPTER_FAULT_CODES.REFUSED, 'the mock manifest declares no handler')
    const resolved = path.resolve(dir, String(relative))
    const inside = path.relative(dir, resolved)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      // A manifest that points outside its own directory would be a way to import arbitrary files
      // by editing JSON, which is exactly the kind of thing an adapter is responsible for.
      return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the mock handler ${relative} escapes the plugin directory`)
    }
    if (!fs.existsSync(resolved)) {
      return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the mock handler ${relative} is not in the plugin directory`)
    }
    let exported = null
    try {
      exported = load(resolved)
    } catch (error) {
      return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the mock handler could not be imported: ${String(error && error.message ? error.message : error)}`)
    }
    if (!exported || typeof exported !== 'object') {
      return adapterFault(ADAPTER_FAULT_CODES.REFUSED, 'the mock handler does not export an object')
    }
    return { ok: true, handler: exported, resolved }
  }

  return {
    id: 'mock.format',
    name: 'Mock third-party format',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a demonstration format proving a new plugin type can be added without touching the platform',
    supports: [MOCK_PLUGIN_TYPE],
    priority: 60,
    runtime_kind: RUNTIME_KINDS.IN_PROCESS.id,
    guarantees: [
      'the manifest is derived from the format\'s own declaration',
      'the handler is loaded only from inside the plugin directory',
      'the demonstration adapter is not part of the shipped plugin set'
    ],

    accepts(artifact, detection) {
      const declaration = detection && detection.detail ? detection.detail.declaration : null
      if (!declaration) return { ok: false, code: 'MOCK_NO_DECLARATION', reason: 'the detection carried no declaration' }
      if (declaration.mock_format !== undefined && Number(declaration.mock_format) !== 1) {
        return { ok: false, code: 'MOCK_FORMAT_VERSION', reason: `mock_format ${declaration.mock_format} is newer than this adapter understands` }
      }
      return true
    },

    async adapt(artifact, detection) {
      const declaration = detection && detection.detail ? detection.detail.declaration : null
      if (!declaration) return adapterFault(ADAPTER_FAULT_CODES.REFUSED, 'the mock declaration could not be read')
      const name = String(declaration.name || path.basename(artifact.dir))
      const id = `mock.${name.replace(/^@/, '').replace(/[/\\]+/g, '.').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`

      const loaded = handlerFor(artifact.dir, declaration.handler)
      if (loaded.ok !== true) return loaded
      const handler = loaded.handler

      let started = false
      return {
        manifest: {
          api_version: 'dshns.plugin/v1',
          id,
          name,
          version: String(declaration.version || '0.0.0'),
          description: declaration.description ? String(declaration.description) : `mock-plugin format plugin ${name}`,
          provides: Array.isArray(declaration.capabilities) ? declaration.capabilities.map(String) : [],
          requires_capabilities: Array.isArray(declaration.requires) ? declaration.requires.map(String) : [],
          optional_capabilities: [],
          conflicts: [],
          default_enabled: declaration.default_enabled === true,
          hot_reload: false,
          model_specific: false,
          fault_level: 'soft',
          entry: path.relative(artifact.dir, loaded.resolved).split(path.sep).join('/'),
          config: declaration.config && typeof declaration.config === 'object' ? declaration.config : {}
        },
        // The adapter proposes; the framework decides. `permissions` here is a *request*.
        permissions: Array.isArray(declaration.permissions) ? declaration.permissions.map(String) : [],
        async load(context) {
          if (typeof handler.start !== 'function') return { ok: true, skipped: true }
          const outcome = await handler.start(context, context && context.config ? context.config : {})
          started = true
          log({ kind: 'mock-started', plugin: id, detail: outcome && outcome.detail ? String(outcome.detail) : null })
          return outcome && typeof outcome === 'object' ? outcome : { ok: true }
        },
        async unload() {
          if (!started || typeof handler.stop !== 'function') return { ok: true, skipped: true }
          started = false
          await handler.stop()
          return { ok: true }
        },
        async healthCheck() {
          if (!started) return { status: 'unknown', reason: 'the mock handler is not started' }
          if (typeof handler.health !== 'function') return { status: 'unknown', reason: 'the mock handler implements no health()' }
          return handler.health()
        },
        runtimeInfo: () => ({ handler: path.relative(artifact.dir, loaded.resolved).split(path.sep).join('/'), started }),
        runtime: {
          kind: RUNTIME_KINDS.IN_PROCESS.id,
          entry: path.relative(artifact.dir, loaded.resolved).split(path.sep).join('/'),
          source: artifact.source || artifact.dir
        },
        health: {
          contract: typeof handler.health === 'function' ? 'full' : 'none',
          detail: 'the mock handler answers health() when it implements one'
        },
        sourceFormat: MOCK_PLUGIN_TYPE
      }
    },

    describe() {
      return {
        formats: [MOCK_FORMAT_FILE],
        note: 'a demonstration adapter: it exists to show a new format needs no platform change',
        extension_points_used: ['detector.register', 'adapter registry']
      }
    }
  }
}

/**
 * Register the whole mock format — detector and adapter — on a framework.
 *
 * This is the entire integration cost of a new external format, and that is the point of exporting
 * it as one function: two calls, no edits to anything the platform ships.
 */
function registerMockFormat(framework) {
  const detector = framework.detector.register(createMockDetector())
  if (detector.ok !== true) return detector
  const adapter = framework.register(createMockAdapter())
  if (adapter.ok !== true) return adapter
  return { ok: true, detector: detector.id || 'mock-format', adapter: adapter.adapter.id }
}

module.exports = {
  MOCK_FORMAT_FILE,
  MOCK_PLUGIN_TYPE,
  createMockDetector,
  createMockAdapter,
  registerMockFormat
}
