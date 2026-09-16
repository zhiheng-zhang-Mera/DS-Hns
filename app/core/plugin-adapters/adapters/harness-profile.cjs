'use strict'

/**
 * `HarnessProfileAdapter` — a plugin that belongs to a **Harness profile**, not to this host.
 *
 * ## Why this adapter exists
 *
 * Two community plugins DS-Hns offers at install time — the plugin market
 * (`@dsh-market/plugin`, repository `2BingLing/dsh-market`) and the wallpaper engine
 * (`dsh-plugin-wallpaper-engine`, repository `elysia395/dsh-wallpaper-engine`) — are DeepSeek
 * Harness *client* plugins. Their `package.json` declares `dsh.bundle.patch` and `dsh.client`, and
 * the Harness' own CLI (`dsh plugin --profile <name> add <package>@<ref>`) puts them into the
 * profile the product boots. The Harness composes them; this product does not load them.
 *
 * That leaves a real question the installer has to be able to answer, and it is a question about
 * *format*, which is exactly what the adapter layer is for:
 *
 * > the files are on disk — are they the community-bundle shape DS-Hns claims they are, and is the
 * > half this product cannot serve declared honestly?
 *
 * Answering it in the PowerShell installer would be a second implementation of
 * `cordis-structure.cjs` and a second answer to a question the adapter framework already owns. So
 * the channel gets an adapter, registered on the same framework as every other format, and the
 * installer asks *it*.
 *
 * ## What it does not do
 *
 * **It never runs the plugin, and it never bridges it.** The host half of a community bundle is
 * mediated by `dshns.cordis-dsh` when this product hosts one; a profile plugin's host half is
 * composed *by the Harness, inside the Harness*. Running it here would be a second instance of a
 * plugin the Harness is already running — so `load()` answers `loaded: false` with that reason
 * instead of starting anything, and the runtime kind is `declarative`. Nothing this adapter returns
 * can make a community plugin load in the shell process: that is the whole point of it.
 *
 * **It never touches the plugin's files.** It reads the installed package's `package.json`,
 * `cordis.patch.yml` and host entry through `analyzeCordisPlugin`, adds one fact the structure
 * reader cannot know — where the package is installed (a Harness profile's own `node_modules`) —
 * and stops. A community plugin's checkout stays byte-identical to what its author published.
 *
 * **It refuses a package that is not one.** The `channel` in the artifact has to be
 * `harness-profile`, and the package has to really declare the DSH bundle or client convention.
 * A plain node package in a `node_modules` directory is not this adapter's business and is refused
 * with the structure reader's own reason, so `dshns.cordis` still gets its turn.
 *
 * ## The honest limit, inherited and restated
 *
 * A community bundle has two halves. The **client half** is browser code the Harness ships to the
 * web UI; whether it renders is the Harness' answer, not this product's. The adapter detects it,
 * reports its inject list and platform, and marks the plugin **degraded rather than healthy** for
 * any host that would run it here — saying "healthy" about a plugin whose visible half is not
 * rendering is the kind of comfortable claim this codebase's documentation argues against.
 */

const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')
const { PLUGIN_TYPES } = require('../detect.cjs')
const { analyzeCordisPlugin, PLUGIN_SHAPES } = require('../cordis-structure.cjs')

/** The id prefix a profile-installed community plugin gets, so it is never mistaken for ours. */
const ID_PREFIX = 'profile.'

/** The installation channel this adapter is the compatibility check for. */
const CHANNEL = 'harness-profile'

/**
 * Derive a platform-legal plugin id from a package name.
 *
 * Scoped names lose their `@` and `/` the same way `dshns.cordis-dsh` does it, so
 * `@dsh-market/plugin` and `dsh-plugin-wallpaper-engine` both produce a legal id.
 */
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
 * The permissions a profile plugin's *declarations* justify here.
 *
 * Deliberately narrow, and narrower than the bridged community adapter's set: this adapter reports
 * a plugin the host does not run. What it genuinely does — and all it declares — is read its own
 * package to answer the compatibility question.
 */
function permissionsFor() {
  return ['fs.read']
}

/**
 * @param {object} [options]
 * @param {string[]} [options.roots] directories providing host dependencies (`peerDependencies`)
 * @param {Function} [options.log]
 */
function createHarnessProfileAdapter(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const roots = Array.isArray(options.roots) ? options.roots.map(String) : []

  /**
   * The structural analysis, plus the one fact this adapter adds: where the package is installed.
   *
   * `where` is the profile's own `node_modules`, which is what makes the artifact a *profile* plugin
   * rather than a store plugin — and it is read from the artifact rather than assumed, because an
   * artifact that was not handed a directory must not be claimed as one.
   */
  function analyze(artifact) {
    const analysis = analyzeCordisPlugin(artifact.dir, { roots })
    if (analysis.ok !== true) return analysis
    const structure = analysis.structure
    if (structure.shape !== PLUGIN_SHAPES.DSH_BUNDLE && structure.shape !== PLUGIN_SHAPES.DSH_CLIENT_ONLY) {
      return adapterFault(
        ADAPTER_FAULT_CODES.REFUSED,
        `${structure.name} declares no dsh.bundle.patch and no dsh.client, so it is not a community DSH bundle`,
        { code: 'PROFILE_NOT_COMMUNITY' }
      )
    }
    return analysis
  }

  return {
    id: 'dshns.harness-profile',
    name: 'DeepSeek Harness profile plugin',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a community DSH/Cordis client plugin owned by a Harness profile, verified from its own declarations and run by the Harness',
    supports: [PLUGIN_TYPES.CORDIS_BUNDLE, PLUGIN_TYPES.CORDIS_CLIENT],
    /**
     * Above `dshns.cordis-dsh`: a profile-installed community bundle is not something this host may
     * bridge, and the more specific adapter has to win so `load()` cannot start a second instance of
     * a plugin the Harness is already composing.
     */
    priority: 60,
    runtime_kind: RUNTIME_KINDS.DECLARATIVE.id,
    guarantees: [
      'the plugin is never modified and never run by this host: it belongs to a Harness profile',
      'the artifact is verified by its own declarations, read from disk without executing anything',
      'a package that declares no DSH bundle convention is refused with the structure reader\'s reason',
      'the browser half is detected and reported, never claimed as served'
    ],

    /**
     * Only a profile-channel artifact that really declares the community convention is this
     * adapter's business.
     *
     * The `channel` check is first and it is not a formality: without it every community package in
     * any `node_modules` would be claimed by this adapter rather than by the one that would actually
     * host it.
     */
    accepts(artifact) {
      if (!artifact || !artifact.dir) {
        return { ok: false, code: 'PROFILE_NO_DIRECTORY', reason: 'this adapter reads an installed plugin directory' }
      }
      const channel = artifact.channel ? String(artifact.channel) : null
      if (channel !== CHANNEL) {
        return {
          ok: false,
          code: 'PROFILE_WRONG_CHANNEL',
          reason: `this adapter verifies the "${CHANNEL}" channel, not "${channel || '(none)'}"`
        }
      }
      const analysis = analyze(artifact)
      if (analysis.ok !== true) return { ok: false, code: analysis.code === ADAPTER_FAULT_CODES.REFUSED ? 'PROFILE_NOT_COMMUNITY' : analysis.code, reason: analysis.reason }
      if (!analysis.structure.host.entryExists) {
        return {
          ok: false,
          code: 'PROFILE_ENTRY_MISSING',
          reason: `the declared entry ${analysis.structure.host.declaredEntry || '(none)'} is not in the installed package`
        }
      }
      return true
    },

    async adapt(artifact) {
      const analysis = analyze(artifact)
      if (analysis.ok !== true) return analysis
      const structure = analysis.structure
      const id = pluginIdFor(structure.name)
      if (!id) return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the package name ${structure.name} yields no legal plugin id`)

      const reason = `the Harness owns this client plugin: it is composed by a Harness profile (${path.basename(path.dirname(artifact.dir))}) and is not run by this host`
      log({ kind: 'adapter-harness-profile', plugin: id, where: artifact.where || null, shape: structure.shape })

      return {
        manifest: {
          api_version: 'dshns.plugin/v1',
          id,
          name: structure.name,
          version: structure.version || '0.0.0',
          description: structure.description || `community DSH bundle ${structure.name}, installed into a Harness profile`,
          // Nothing is offered or required here: the plugin's life is the Harness', and claiming
          // capabilities on its behalf would be this host inventing a contract nobody declared.
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
        permissions: permissionsFor(),
        runtime: {
          kind: RUNTIME_KINDS.DECLARATIVE.id,
          entry: structure.host.entry,
          source: artifact.repo || artifact.source || artifact.dir
        },
        health: {
          contract: 'adapter-profile',
          detail: 'whether the installed package is the community bundle its manifest claims, and the state of the browser half this host cannot serve'
        },

        install() {
          return { ok: true }
        },

        /**
         * Deliberately does nothing, and says so.
         *
         * A profile plugin's host half is composed by the Harness. Loading it here would be a second
         * instance of a plugin the Harness is already running, so the answer is a report rather than
         * a start — and it is `ok: true` because "this host does not run it" is not a failure.
         */
        async load() {
          return { ok: true, loaded: false, reason }
        },

        async unload() {
          return { ok: true, skipped: true, reason }
        },

        async healthCheck() {
          // The structure was read at adaptation time and the files are not re-read here: a health
          // check that re-reads disk on every call would make a panel poll a filesystem.
          if (structure.client.declared) {
            return {
              status: 'degraded',
              reason: `the package is installed and is the community bundle it declares, but its browser half (${structure.client.inject.join(', ') || 'no inject'}) renders inside the Harness, not here`
            }
          }
          return { status: 'healthy', reason: 'the package is installed and is the community bundle it declares' }
        },

        runtimeInfo: () => ({
          channel: CHANNEL,
          where: artifact.where || 'harness-profile',
          packageDir: artifact.dir,
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
              providedAtRuntime: (structure.peers.providedAtRuntime || []).map((peer) => peer.name),
              resolved: structure.peers.resolved
            },
            inject: { required: structure.host.injectRequired, optional: structure.host.injectOptional }
          },
          client: structure.client
        }),

        errorReport: () => ({ bridge: null, refusals: 0, byCode: {}, last: null }),

        get structure() {
          return structure
        }
      }
    },

    describe() {
      return {
        formats: ['package.json#dsh.bundle.patch', 'package.json#dsh.client', 'cordis.patch.yml', 'peerDependencies'],
        channel: CHANNEL,
        mediation: 'none: the artifact is read and reported, never executed',
        withholds: 'no host object, no bridge, no second instance of a plugin the Harness owns',
        limitation: 'whether the browser half renders is the Harness\' answer, not this product\'s',
        roots: roots.slice()
      }
    }
  }
}

module.exports = { createHarnessProfileAdapter, pluginIdFor, permissionsFor, ID_PREFIX, CHANNEL }
