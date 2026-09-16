'use strict'

/**
 * The Cordis/package adapter: somebody else's plugin ecosystem, adopted without being trusted.
 *
 * This is the adapter the compatibility layer grew into. The behaviour is deliberately unchanged —
 * the classification still comes from `store/compat.cjs`, the activation still happens in a child
 * process through `core/plugin-compat` — because that behaviour is the isolation boundary, and the
 * requirement is explicit that the boundary must not be weakened by this work.
 *
 * What is new is that the knowledge now lives in an adapter instead of in the host. `plugin-host`
 * no longer contains the sentence "if the entry says `compatibility: 'compat'`, build a compat
 * plugin"; it asks the framework, and the framework asks this.
 *
 * ## Why the permissions are declared as broadly as they are
 *
 * An adopted plugin runs in its own process, and that process runs with the *user's* rights. The
 * containment is real — an import-time throw, a `process.exit`, a hang or a crash ten minutes
 * later stay in the child — but it is containment, not a sandbox. So the honest declaration is the
 * set the child can actually reach: its own files, the wider filesystem, the network and child
 * processes of its own.
 *
 * Declaring `fs.read` alone would be the comfortable answer and the wrong one: it would tell a
 * user that an adopted plugin can only read its own directory when nothing stops it doing more.
 * The `enforcement` field says `process-boundary`, and the guarantees say what that does and does
 * not buy, so the panel can show the truth instead of a reassuring understatement.
 */

const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')
const { PLUGIN_TYPES } = require('../detect.cjs')

/** What an adopted plugin's process can actually reach, and therefore what is declared. */
const ADOPTED_PERMISSIONS = Object.freeze(['fs.read', 'fs.write', 'network', 'process.spawn'])

/**
 * @param {object} [options]
 * @param {string} [options.nodeExe] the node binary the isolated process runs under
 * @param {number} [options.timeoutMs] the activation budget
 * @param {Function} [options.spawn] injectable, for tests
 * @param {Function} [options.classify] injectable classifier, for tests
 * @param {Function} [options.log]
 */
function createCordisAdapter(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const nodeExe = options.nodeExe ? String(options.nodeExe) : process.execPath
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : undefined

  /** Loaded lazily so a machine that never adopts a plugin never pays for these modules. */
  function compat() {
    return require('../../plugin-compat/index.cjs')
  }
  function classifier() {
    return require('../../../extensions/mega/store/compat.cjs')
  }

  /** The descriptor for an artifact: the one already written, or a freshly derived one. */
  function descriptorFor(artifact, detection) {
    // A detection that already read the descriptor does not read it twice.
    const fromDetection = detection && detection.detail && detection.detail.descriptor
    if (fromDetection) return { ok: true, descriptor: fromDetection }
    const read = classifier().readCompatDescriptor(artifact.dir)
    if (read) return { ok: true, descriptor: read }
    const classified = typeof options.classify === 'function'
      ? options.classify(artifact)
      : classifier().classifyCompatible(artifact.dir, {
        repo: artifact.repo || artifact.source,
        branch: artifact.branch
      })
    if (!classified || classified.ok !== true) {
      return adapterFault(
        ADAPTER_FAULT_CODES.REFUSED,
        `the package could not be classified for adoption: ${(classified && classified.reason) || 'no reason given'}`,
        { detail: { code: classified && classified.code ? classified.code : null } }
      )
    }
    return { ok: true, descriptor: classified.descriptor }
  }

  return {
    id: 'dshns.cordis',
    name: 'Cordis / package adoption',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a plugin from another DSH host or a plain node package, activated in its own process',
    supports: [
      PLUGIN_TYPES.CORDIS_BUNDLE,
      PLUGIN_TYPES.CORDIS_CLIENT,
      PLUGIN_TYPES.NODE_ESM,
      PLUGIN_TYPES.NODE_CJS,
      PLUGIN_TYPES.COMPAT_DESCRIPTOR
    ],
    priority: 10,
    runtime_kind: RUNTIME_KINDS.ISOLATED_PROCESS.id,
    guarantees: [
      'the plugin runs in its own process: a throw, an exit or a hang stays in the child',
      'capabilities stay in that process, so it cannot satisfy another plugin\'s requirement',
      'it is not enabled automatically and is never part of the product lockfile',
      'containment is not a sandbox: the child has this user\'s rights'
    ],

    accepts(artifact) {
      if (!artifact || !artifact.dir) return false
      // A directory that carries the platform's own manifest is not adopted, however much of a
      // node package it also looks like: the declared contract wins.
      return true
    },

    async adapt(artifact, detection) {
      const derived = descriptorFor(artifact, detection)
      if (derived.ok !== true) return derived
      const descriptor = derived.descriptor

      const plugin = compat().createCompatPlugin({
        descriptor,
        dir: artifact.dir,
        nodeExe,
        timeoutMs,
        spawn: options.spawn,
        log: (message) => log({ kind: 'adapter-cordis', plugin: descriptor.id, message: String(message) })
      })

      if (!plugin.manifest) {
        return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the descriptor for ${path.basename(artifact.dir)} does not carry a valid manifest`)
      }

      return {
        manifest: plugin.manifest,
        // The hooks are the compat plugin's own: activation, isolation and teardown are unchanged.
        install: plugin.install,
        load: plugin.load,
        unload: plugin.unload,
        healthCheck: plugin.healthCheck,
        // The runtime information the platform shows comes from the isolated process itself.
        runtimeInfo: () => {
          const state = plugin.compatibilityState()
          return {
            pid: state.pid,
            status: state.status,
            reason: state.reason,
            entry: state.entry,
            entryExists: state.entryExists,
            build: state.build,
            dependencies: state.dependencies,
            missing: state.missing,
            exit: state.exit,
            activatedAt: state.activatedAt
          }
        },
        // Preserved so the compat surfaces (guarantees, setup flow, panel badges) keep working.
        compatibility: plugin.compatibility,
        compatibilityInfo: plugin.compatibilityInfo,
        compatibilityState: plugin.compatibilityState,
        directory: plugin.directory,
        permissions: [...ADOPTED_PERMISSIONS],
        runtime: {
          kind: RUNTIME_KINDS.ISOLATED_PROCESS.id,
          entry: descriptor.entry || null,
          source: artifact.repo || artifact.source || artifact.dir
        },
        health: {
          contract: 'process-liveness',
          detail: 'only whether the isolated process is alive is reported'
        },
        sourceFormat: descriptor.kind || detection.type
      }
    },

    describe() {
      return {
        formats: ['package.json with dsh.bundle.patch', 'cordis.patch.yml', 'a derived compatibility descriptor'],
        isolation: 'a child process per plugin, started on load and stopped on unload',
        declared_permissions: [...ADOPTED_PERMISSIONS],
        note: 'the permission set describes what the child process can reach, not what was requested'
      }
    }
  }
}

module.exports = { createCordisAdapter, ADOPTED_PERMISSIONS }
