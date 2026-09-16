'use strict'

/**
 * `ProcessPluginAdapter` — plugins that should not run inside DS-Hns at all.
 *
 * A supervisor that must outlive the application, a Python model server with its own interpreter, a
 * compiled helper with its own lifetime. None of these can be adapted by *loading* them, so this
 * adapter does not load anything: it starts a process, talks to it over a declared transport, and
 * stops it.
 *
 * ## The rule this file is written around
 *
 * > The adapter understands processes. It does not understand what any process is for.
 *
 * Everything here is generic. A plugin declares a command, a transport, a heartbeat expectation, a
 * restart policy and the capabilities it offers with their methods. The adapter starts it, watches
 * it, bounds its restarts, collects its logs, and routes capability calls over the wire. The word
 * "restart" appears in this file only as *process* restart, in the sense of starting a process
 * again — never as an opinion about what should be restarted, when, or why. That is what lets one
 * adapter serve a restart supervisor, a model server and a compiled binary with no branch for any
 * of them, and it is asserted structurally by the test suite: this module must not contain the
 * vocabulary of any particular plugin's business.
 *
 * ## Why its capabilities *do* register here, unlike an adopted plugin's
 *
 * An adopted Cordis plugin's capabilities stay in its child, and its manifest says `provides: []`.
 * A managed process is the opposite, and the difference is the transport rather than a policy: the
 * capability is reached by sending the process a declared method call and reading the reply, so the
 * host is not handing over an object — it is sending a message. The runtime block says exactly
 * that: `kind: managed-process`, `enforcement: protocol`.
 *
 * ## Fault isolation
 *
 * A companion process that crashes, hangs, ignores shutdown or floods its stdout is a plugin with a
 * bad status. It is never an exception, and it is never a reason for DS-Hns to stop: the host does
 * not depend on the process to stay alive, and the process cannot reach into the host to change
 * that.
 */

const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')
const { PLUGIN_TYPES } = require('../detect.cjs')
const { validateProcessManifest, PROCESS_API_VERSION, PROCESS_MANIFEST_FILE, PROCESS_STATES } = require('../process/contract.cjs')
const { createProcessSupervisor } = require('../process/supervisor.cjs')

/** Derive a platform-legal plugin id from a process manifest's name. */
function processPluginIdFor(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '.')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
  return cleaned ? `process.${cleaned}`.slice(0, 120) : null
}

/**
 * What the host proposes on the plugin's behalf.
 *
 * `process.spawn` because the host starts it, `fs.read` because it is read from disk. Everything
 * else the plugin asked for in its own `permissions.declares` is added by the framework, which
 * remains the only thing that decides what is granted.
 */
function permissionsFor(manifest) {
  const permissions = new Set(['fs.read', 'process.spawn'])
  for (const declared of manifest.permissions.declares) permissions.add(declared)
  return [...permissions].sort()
}

/**
 * @param {object} [options]
 * @param {string} [options.nodeExe]
 * @param {Function} [options.spawn] injectable, for tests
 * @param {Function} [options.log]
 * @param {Function} [options.now]
 */
function createProcessPluginAdapter(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}

  return {
    id: 'dshns.process',
    name: 'Managed background process',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a standalone Node/Python/EXE plugin, started, watched and reached over a declared protocol',
    supports: [PLUGIN_TYPES.PROCESS],
    /** Above the generic adoption paths: a process declaration is unambiguous. */
    priority: 80,
    runtime_kind: RUNTIME_KINDS.MANAGED_PROCESS.id,
    guarantees: [
      'the plugin runs as its own process, so its crashes, hangs and exit codes are its own',
      'no HNS object is handed over: every interaction is a declared frame on a declared transport',
      'its capabilities are declared in the manifest, never discovered by asking it at runtime',
      'restarts are bounded by a rolling budget and end in a terminal safe mode, never a loop',
      'the adapter understands processes and holds no knowledge of what the process does'
    ],

    /** Only a directory that really declares a process plugin is this adapter's business. */
    accepts(artifact) {
      if (!artifact || !artifact.dir) return { ok: false, code: 'PROCESS_NO_DIRECTORY', reason: 'this adapter reads a plugin directory' }
      const fs = require('node:fs')
      const file = path.join(artifact.dir, PROCESS_MANIFEST_FILE)
      let raw = null
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return { ok: false, code: 'PROCESS_NO_MANIFEST', reason: `the directory has no readable ${PROCESS_MANIFEST_FILE}` }
      }
      const validated = validateProcessManifest(raw, { dir: artifact.dir })
      if (validated.ok !== true) {
        return { ok: false, code: 'PROCESS_BAD_MANIFEST', reason: `the process declaration was refused: ${validated.errors.join('; ')}` }
      }
      return true
    },

    async adapt(artifact, detection) {
      const fs = require('node:fs')
      const file = path.join(artifact.dir, PROCESS_MANIFEST_FILE)
      let raw = null
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `${PROCESS_MANIFEST_FILE} could not be read: ${error && error.message ? error.message : error}`)
      }
      const validated = validateProcessManifest(raw, { dir: artifact.dir })
      if (validated.ok !== true) {
        return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the process declaration was refused: ${validated.errors.join('; ')}`, { errors: validated.errors })
      }
      const declaration = validated.manifest
      const id = processPluginIdFor(declaration.name || declaration.id)
      if (!id) return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the process name ${declaration.name} yields no legal plugin id`)

      void detection
      const adapterLog = (event) => log({ adapter: 'dshns.process', plugin: id, ...event })
      let supervisor = null

      const capabilityNames = declaration.provides.capabilities.map((capability) => capability.name)

      return {
        manifest: {
          api_version: 'dshns.plugin/v1',
          id,
          name: declaration.name,
          version: declaration.version,
          description: declaration.description || `managed process ${declaration.name}`,
          // Declared, not discovered: the host registers exactly what the manifest lists, and the
          // supervisor refuses a call to anything the process did not declare at handshake either.
          provides: capabilityNames,
          requires_capabilities: [],
          optional_capabilities: [],
          conflicts: [],
          // A background process is not started behind the user's back: enabling it is an act.
          default_enabled: false,
          hot_reload: false,
          model_specific: false,
          fault_level: declaration.fault_level,
          entry: declaration.command.join(' '),
          config: {}
        },
        permissions: permissionsFor(declaration),
        runtime: {
          kind: RUNTIME_KINDS.MANAGED_PROCESS.id,
          entry: declaration.command.join(' '),
          source: artifact.repo || artifact.source || artifact.dir,
          provides: capabilityNames
        },
        health: {
          contract: 'process-liveness',
          detail: 'process state, heartbeat freshness, exit history and the restart budget'
        },

        install() {
          return { ok: true }
        },

        /**
         * Start the process and bridge what it declared.
         *
         * The bridge is generated from the manifest rather than written per capability: for each
         * declared capability, an object whose methods forward to `supervisor.invoke`. Nothing here
         * knows what any of those methods mean, which is why adding one needs no change to this
         * file.
         */
        async load(context) {
          supervisor = createProcessSupervisor({
            manifest: declaration,
            dir: artifact.dir,
            nodeExe: options.nodeExe,
            spawn: options.spawn,
            log: adapterLog,
            now: options.now
          })
          const started = await supervisor.start({ reason: 'load' })
          if (started.ok !== true) {
            // The start failed, but the supervisor may already be cycling through its bounded
            // restarts. Saying only "it exited" would tell the user the plugin is dead while it is
            // in fact still trying, so the state is reported alongside the reason.
            const cycling = supervisor.state === PROCESS_STATES.RESTARTING
            const error = new Error(
              cycling
                ? `${started.reason}; a bounded restart is in progress and will stop after ${declaration.restart.maxRestarts} attempts in ${declaration.restart.windowMs}ms`
                : started.reason
            )
            error.code = started.code
            error.processState = supervisor.state
            throw error
          }

          const registered = []
          for (const capability of declaration.provides.capabilities) {
            const implementation = {}
            for (const method of capability.methods) {
              implementation[method] = (...args) => supervisor.invoke(capability.name, method, args)
            }
            const provided = context && typeof context.provide === 'function'
              ? context.provide(capability.name, implementation, { detail: { via: 'managed-process', transport: declaration.transport.kind } })
              : { ok: false, reason: 'the context cannot provide capabilities' }
            registered.push({ capability: capability.name, methods: capability.methods, ok: provided && provided.ok !== false, reason: provided && provided.reason ? provided.reason : null })
          }
          adapterLog({ kind: 'process-adapter-loaded', pid: started.pid, capabilities: registered.map((entry) => entry.capability) })
          return { ok: true, pid: started.pid, capabilities: registered }
        },

        async unload() {
          if (!supervisor) return { ok: true, skipped: true }
          const outcome = await supervisor.dispose('plugin unload')
          supervisor = null
          return outcome
        },

        async healthCheck() {
          if (!supervisor) return { status: 'unknown', reason: 'the process has not been started' }
          const status = supervisor.status()
          if (status.state === PROCESS_STATES.RUNNING) return { status: 'healthy', reason: `process ${status.pid} is running with ${status.capabilities.length} declared capability(ies)` }
          if (status.state === PROCESS_STATES.DEGRADED) return { status: 'degraded', reason: `the heartbeat is ${status.heartbeat.ageMs}ms old, past the declared ${status.heartbeat.timeoutMs}ms` }
          if (status.state === PROCESS_STATES.RESTARTING) return { status: 'degraded', reason: `restarting (attempt ${status.restarts.attempts} of ${status.restarts.maxRestarts})` }
          if (status.state === PROCESS_STATES.SAFE_MODE) return { status: 'unhealthy', reason: 'the restart budget was exhausted; a human has to look at this before it runs again' }
          return { status: 'unhealthy', reason: `the process is ${status.state}` }
        },

        runtimeInfo: () => ({
          process: supervisor ? supervisor.status() : null,
          declaration: {
            command: declaration.command,
            transport: declaration.transport,
            heartbeat: declaration.heartbeat,
            restart: declaration.restart,
            capabilities: declaration.provides.capabilities
          },
          logs: supervisor ? supervisor.logs().slice(-20) : []
        }),

        errorReport: () => (supervisor
          ? {
              process: supervisor.id,
              state: supervisor.state,
              faults: supervisor.faults().length,
              byCode: supervisor.faults().reduce((accumulator, entry) => {
                accumulator[entry.code] = (accumulator[entry.code] || 0) + 1
                return accumulator
              }, {}),
              last: supervisor.faults().length ? supervisor.faults()[supervisor.faults().length - 1] : null,
              exits: supervisor.exits().slice(-5)
            }
          : { process: null, faults: 0, byCode: {}, last: null, exits: [] }),

        /** For the acceptance and for a host that must inspect the child directly. */
        get supervisor() {
          return supervisor
        },
        get declaration() {
          return declaration
        }
      }
    },

    describe() {
      return {
        formats: [PROCESS_MANIFEST_FILE],
        protocol: PROCESS_API_VERSION,
        transports: ['stdio-jsonl', 'localhost-jsonl'],
        manages: ['start', 'stop', 'status', 'heartbeat', 'exit codes', 'bounded restart', 'logs'],
        does_not: 'understand the plugin\'s business logic, or decide what a capability means'
      }
    }
  }
}

module.exports = { createProcessPluginAdapter, processPluginIdFor, permissionsFor }
