'use strict'

/**
 * `CordisDshAdapter` — community DeepSeek Harness / Cordis plugins, with no bespoke code per plugin.
 *
 * ## The claim this adapter exists to make true
 *
 * Before this, every foreign plugin that needed to work rather than merely be listed would have
 * needed its own compatibility code: one branch for the plugin that wants `webServer`, another for
 * the one that wants `settings`, another for the next service after that. The acceptance test for
 * this file is not "the market plugin works" — it is **"a plugin nobody has seen before works"**,
 * because the adapter reads the convention instead of the plugin.
 *
 * The convention is what `cordis-structure.cjs` reads:
 *
 * | Declaration | What the adapter does with it |
 * | --- | --- |
 * | `dsh.bundle.patch` | reads the patch, takes the row ids/names, marks the plugin a bundle |
 * | `dsh.client.inject` | records the browser half and reports honestly that this host cannot serve it |
 * | `cordis.patch.yml` | the row names the bundle expects to be mounted as |
 * | `peerDependencies` | split into required and optional, audited against the host's roots |
 * | `export const inject` | the host services that must be mediated — `webServer`, `settings` |
 *
 * ## What it does not do
 *
 * **It never touches the plugin's files.** No shim is written into the plugin, no `package.json`
 * is rewritten, no dependency is installed into its tree, no entry is patched. Everything the
 * plugin needs is provided *around* it — dependencies resolve out of the host's roots through a
 * resolve hook, and host services arrive through the bridge. A community plugin's checkout stays
 * byte-identical to what its author published, which is what makes an update a `git pull`.
 *
 * **It never hands over a host object.** See `bridge/contract.cjs`; the plugin's `ctx.webServer` is
 * a local object whose `register` serialises a description of a route. A test in the suite walks
 * the context the plugin actually receives and asserts that not one value in it originates outside
 * the child process.
 *
 * ## The honest limit
 *
 * A community bundle has two halves. The host half runs here, through the bridge. The **client
 * half** is browser code that ships to the web UI, and a host-process bridge cannot serve it: that
 * needs the harness's client-module host. So the adapter detects the client half, reports its
 * inject list and platform, and marks the plugin *degraded* rather than healthy — because a plugin
 * whose visible half is not rendering is not a plugin that is working, and saying otherwise would
 * be the kind of comfortable claim this codebase's docs argue against.
 */

const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')
const { PLUGIN_TYPES } = require('../detect.cjs')
const { analyzeCordisPlugin, PLUGIN_SHAPES } = require('../cordis-structure.cjs')
const { createCordisBridge, createHostWebServer } = require('../bridge/host.cjs')

/** The id prefix an adapted community plugin gets, so it is never mistaken for a native one. */
const ID_PREFIX = 'cordis.'

/** Derive a platform-legal plugin id from a package name. */
function pluginIdFor(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '.')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
  return cleaned ? `${ID_PREFIX}${cleaned}`.slice(0, 120) : null
}

/**
 * The permissions a community plugin's *declarations* justify.
 *
 * Derived from evidence rather than granted wholesale, and deliberately not the maximal set: the
 * isolated-process containment is already described by the runtime block (`process-boundary`), and
 * the adapter's guarantees state what the bridge withholds. What is listed here is what the plugin
 * demonstrably does — it reads its own package, it may ship a browser half, it may register routes
 * on the host's server.
 */
function permissionsFor(structure) {
  const permissions = new Set(['fs.read'])
  if (structure.bundle && structure.bundle.patch) permissions.add('config.read')
  if (structure.client && structure.client.declared) permissions.add('ui.render')
  if (structure.host.injectRequired.includes('webServer') || structure.host.injectOptional.includes('webServer')) permissions.add('network')
  if (structure.host.injectRequired.includes('settings') || structure.host.injectOptional.includes('settings')) permissions.add('settings.write')
  return [...permissions].sort()
}

/**
 * @param {object} [options]
 * @param {object} [options.services] the real host services the bridge mediates: `{ webServer, settings }`
 * @param {boolean} [options.ownWebServer] when true and no `webServer` is supplied, the adapter
 *   starts one of its own for the plugins it adapts. Off by default, because a plugin quietly
 *   serving on a port the application does not know about is a deployment decision, not a default.
 * @param {string[]} [options.roots] directories providing host dependencies (peerDependencies)
 * @param {string} [options.nodeExe]
 * @param {object} [options.limits] bridge budgets
 * @param {Function} [options.log]
 */
function createCordisDshAdapter(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const nodeExe = options.nodeExe ? String(options.nodeExe) : process.execPath
  const roots = Array.isArray(options.roots) ? options.roots.map(String) : []
  let ownServer = null

  /** The services object the bridge gets, starting a private server only if asked. */
  async function servicesFor(bridgeLog) {
    if (options.services && typeof options.services === 'object' && options.services.webServer) return options.services
    if (options.ownWebServer !== true) return options.services && typeof options.services === 'object' ? options.services : {}
    if (!ownServer) {
      ownServer = createHostWebServer({ log: bridgeLog })
      const listening = await ownServer.listen({ port: Number.isInteger(options.ownWebServerPort) ? options.ownWebServerPort : 0 })
      bridgeLog({ kind: 'cordis-dsh-own-webserver', host: listening.host, port: listening.port })
    }
    return { ...(options.services || {}), webServer: ownServer }
  }

  return {
    id: 'dshns.cordis-dsh',
    name: 'DeepSeek Harness community plugin',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a community DSH/Cordis bundle, adapted from its own declarations and mediated by a controlled bridge',
    supports: [PLUGIN_TYPES.CORDIS_BUNDLE, PLUGIN_TYPES.CORDIS_CLIENT],
    /**
     * Above the generic adoption adapter: a package that declares the DSH bundle convention is a
     * community plugin with a host half worth mediating, and only when this adapter declines does
     * the generic isolated-adoption path get its turn.
     */
    priority: 50,
    runtime_kind: RUNTIME_KINDS.ISOLATED_PROCESS.id,
    guarantees: [
      'the plugin is never modified: dependencies resolve from the host, services arrive through the bridge',
      'the plugin process holds no HNS Core object, no real service and no live handle',
      'every host interaction is a named capability call the host validates and can refuse',
      'a refused call is reported on the plugin\'s health surface rather than silently dropped',
      'the browser half is detected and reported, and is not served by a host-process bridge'
    ],

    /** Only a directory that really declares the community convention is this adapter's business. */
    accepts(artifact, detection) {
      if (!artifact || !artifact.dir) return { ok: false, code: 'CORDIS_NO_DIRECTORY', reason: 'this adapter reads a plugin directory' }
      const analysis = analyzeCordisPlugin(artifact.dir, { roots })
      if (analysis.ok !== true) return { ok: false, code: analysis.code, reason: analysis.reason }
      const structure = analysis.structure
      const declared = structure.shape === PLUGIN_SHAPES.DSH_BUNDLE || structure.shape === PLUGIN_SHAPES.DSH_CLIENT_ONLY
      if (!declared) {
        return {
          ok: false,
          code: 'CORDIS_NOT_COMMUNITY',
          reason: `${structure.name} declares no dsh.bundle.patch and no dsh.client, so it is not a community DSH bundle`
        }
      }
      if (!structure.host.entryExists) {
        return {
          ok: false,
          code: 'CORDIS_ENTRY_MISSING',
          reason: `the declared entry ${structure.host.declaredEntry || '(none)'} is not in the package`
        }
      }
      void detection
      return true
    },

    async adapt(artifact, detection) {
      const analysis = analyzeCordisPlugin(artifact.dir, { roots })
      if (analysis.ok !== true) return adapterFault(analysis.code, analysis.reason)
      const structure = analysis.structure
      const id = pluginIdFor(structure.name)
      if (!id) return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the package name ${structure.name} yields no legal plugin id`)

      const bridgeLog = (event) => log({ adapter: 'dshns.cordis-dsh', plugin: id, ...event })
      let bridge = null

      return {
        manifest: {
          api_version: 'dshns.plugin/v1',
          id,
          name: structure.name,
          version: structure.version || '0.0.0',
          description: structure.description || `community DSH bundle ${structure.name}`,
          // Capabilities stay in the plugin's process, exactly as they do for any adopted plugin:
          // the bridge does not forward `provide`, so a bridged plugin cannot satisfy another
          // plugin's requirement and saying it provides something would be a lie.
          provides: [],
          requires_capabilities: [],
          optional_capabilities: [],
          conflicts: [],
          default_enabled: false,
          hot_reload: false,
          model_specific: false,
          fault_level: 'soft',
          entry: structure.host.entry,
          config: {}
        },
        permissions: permissionsFor(structure),
        runtime: {
          kind: RUNTIME_KINDS.ISOLATED_PROCESS.id,
          entry: structure.host.entry,
          source: artifact.repo || artifact.source || artifact.dir
        },
        health: {
          contract: 'bridge-mediated',
          detail: 'process liveness, bridged routes, host refusals and the state of the browser half'
        },

        install() {
          return { ok: true }
        },

        async load(context) {
          const services = await servicesFor(bridgeLog)
          bridge = createCordisBridge({
            id,
            name: structure.name,
            dir: artifact.dir,
            entry: structure.host.entry,
            api: 'cordis',
            config: (context && context.config) || {},
            roots,
            services,
            nodeExe,
            limits: options.limits,
            log: bridgeLog
          })
          const outcome = await bridge.activate()
          if (outcome.ok !== true) {
            const error = new Error(outcome.reason)
            error.code = outcome.code
            error.missing = outcome.missing || []
            throw error
          }
          bridgeLog({ kind: 'cordis-dsh-activated', api: outcome.api, routes: outcome.routes.length, ms: outcome.ms })
          return { ok: true, routes: outcome.routes, settings: outcome.settings, api: outcome.api }
        },

        async unload() {
          if (!bridge) return { ok: true, skipped: true }
          const stopped = await bridge.stop()
          bridge = null
          return stopped
        },

        async healthCheck() {
          if (!bridge) return { status: 'unknown', reason: 'the plugin has not been loaded' }
          const health = bridge.healthCheck()
          // A bundle with a browser half is only half-working here, and reporting it healthy would
          // hide the half that is not rendering.
          if (health.status === 'healthy' && structure.client.declared) {
            return {
              status: 'degraded',
              reason: `the host half is running, but the browser half (${structure.client.inject.join(', ') || 'no inject'}) is not served by a host-process bridge`
            }
          }
          return health
        },

        runtimeInfo: () => ({
          bridge: bridge ? bridge.runtimeInfo() : null,
          structure: {
            shape: structure.shape,
            format: structure.format,
            markers: structure.markers,
            bundle: { patch: structure.bundle.patch, rows: structure.bundle.rows },
            engines: structure.engines,
            peers: {
              required: structure.peers.required.map((peer) => peer.name),
              optional: structure.peers.optional.map((peer) => peer.name),
              missing: structure.peers.missing.map((peer) => peer.name),
              resolved: structure.peers.resolved
            },
            inject: { required: structure.host.injectRequired, optional: structure.host.injectOptional }
          },
          client: structure.client,
          capabilities: bridge ? bridge.capabilityReport() : null
        }),

        errorReport: () => (bridge
          ? bridge.errorReport()
          : { bridge: null, refusals: 0, byCode: {}, last: null }),

        /** For the acceptance and for teardown when the adapter started its own server. */
        async closeOwnWebServer() {
          if (!ownServer) return false
          const closed = await ownServer.close()
          ownServer = null
          return closed
        },
        get structure() {
          return structure
        }
      }
    },

    describe() {
      return {
        formats: ['package.json#dsh.bundle.patch', 'package.json#dsh.client', 'cordis.patch.yml', 'peerDependencies'],
        mediation: 'a controlled bridge: named capabilities, validated host-side, JSON only',
        withholds: 'no Cordis container, no HNS Core object, no real service instance',
        limitation: 'the browser half is reported, not served',
        roots: roots.slice(),
        services: options.services && typeof options.services === 'object'
          ? Object.keys(options.services)
          : (options.ownWebServer === true ? ['webServer (adapter-owned)'] : [])
      }
    }
  }
}

module.exports = { createCordisDshAdapter, pluginIdFor, permissionsFor, ID_PREFIX }
