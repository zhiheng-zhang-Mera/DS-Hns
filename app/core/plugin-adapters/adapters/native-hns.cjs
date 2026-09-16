'use strict'

/**
 * `NativeHnsAdapter` — `dshns.plugin/v1`, the platform's own format.
 *
 * This is the adapter every plugin written *for* DS-Hns goes through, and the word "every" is the
 * point. There used to be two paths: store-installed plugins were adapted, while the product's own
 * shipped sets were handed to the manager as ready-made objects. That second path was not an
 * optimisation — it was a second loader, and it meant the platform's own plugins skipped the
 * standard sections (permissions, runtime, adapter, health), the per-artifact fault isolation and
 * the adaptation record that every other plugin had.
 *
 * Formalising it as an adapter rather than a fast path is what removes that asymmetry. The shipped
 * sets now arrive as *artifacts* like everything else, so:
 *
 *   * the native case is the **reference** adapter — whatever shape the framework hands the manager
 *     is, by construction, exactly what a first-class plugin looks like;
 *   * a shipped plugin that fails to adapt fails *alone*, with a coded reason, instead of taking
 *     the world build with it;
 *   * there is no privileged format for the framework to special-case again.
 *
 * Two artifact shapes arrive here:
 *
 *   * **declared** — a directory with `dshns-plugin.json`. That file is the manifest; when it
 *     names a `main` and the caller has imported it, the module's own hooks are used, and when it
 *     does not, the plugin is *declarative*: it contributes a manifest and nothing to run.
 *   * **module** — a module already imported by the caller, exporting `{ manifest, load, … }`. This
 *     is the shape the product's shipped sets arrive in, which is why routing them through here
 *     costs them nothing.
 *
 * The permissions it proposes are exactly what the plugin declared for itself. Nothing is inferred:
 * this is the one format where the author could have said what they need and the adapter has no
 * business guessing on their behalf.
 */

const path = require('node:path')

const { ADAPTER_API_VERSION, RUNTIME_KINDS, adapterFault, ADAPTER_FAULT_CODES } = require('../contract.cjs')
const { PLUGIN_TYPES } = require('../detect.cjs')

/** The manifest a declared plugin writes, and the entry it may name. */
function manifestFromDeclaration(declaration, dir) {
  const main = declaration.main ? String(declaration.main) : null
  return {
    ...declaration,
    api_version: 'dshns.plugin/v1',
    /** `main` is the store's spelling; `entry` is the manifest's. Both are carried. */
    entry: declaration.entry ? String(declaration.entry) : main,
    config: declaration.config && typeof declaration.config === 'object' ? declaration.config : {}
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.policy] unused here — the framework owns the policy — but accepted so
 *   every adapter is constructed the same way.
 */
function createNativeHnsAdapter(options = {}) {
  return {
    id: 'dshns.native',
    name: 'DS-Hns native plugin',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    summary: 'a plugin that declares dshns.plugin/v1 itself, in the platform\'s own format',
    supports: [PLUGIN_TYPES.DECLARED, PLUGIN_TYPES.MODULE],
    priority: 100,
    runtime_kind: RUNTIME_KINDS.IN_PROCESS.id,
    guarantees: [
      'the manifest is the plugin author\'s own declaration, not a derivation',
      'the plugin\'s own lifecycle hooks run unchanged',
      'the plugin is subject to the platform health contract'
    ],

    /** Only a well-formed declaration is taken; a broken one is refused with the reason. */
    accepts(artifact) {
      if (!artifact) return false
      if (artifact.module && artifact.module.manifest) return true
      if (!artifact.dir) return false
      return true
    },

    async adapt(artifact, detection) {
      // Already-imported module: the platform's own shape, passed through.
      if (artifact.module && artifact.module.manifest) {
        const module_ = artifact.module
        return {
          manifest: module_.manifest,
          install: typeof module_.install === 'function' ? module_.install : undefined,
          load: typeof module_.load === 'function' ? module_.load : undefined,
          unload: typeof module_.unload === 'function' ? module_.unload : undefined,
          healthCheck: typeof module_.healthCheck === 'function' ? module_.healthCheck : undefined,
          runtimeInfo: typeof module_.runtimeInfo === 'function' ? module_.runtimeInfo : undefined,
          permissions: Array.isArray(module_.permissions) ? module_.permissions : undefined,
          runtime: {
            kind: RUNTIME_KINDS.IN_PROCESS.id,
            source: artifact.source || (artifact.dir ? artifact.dir : null)
          },
          health: { contract: 'full', detail: typeof module_.healthCheck === 'function' ? 'the plugin implements healthCheck' : 'the plugin implements no healthCheck' },
          sourceFormat: PLUGIN_TYPES.MODULE
        }
      }

      const declaration = detection && detection.detail && detection.detail.manifest
        ? detection.detail.manifest
        : null
      if (!declaration) {
        return adapterFault(ADAPTER_FAULT_CODES.REFUSED, 'the declared manifest could not be read')
      }

      const manifest = manifestFromDeclaration(declaration, artifact.dir)
      // A declaration with no entry contributes no code. Saying so here rather than inventing a
      // runtime is what keeps `declarative` an honest description instead of a silent failure.
      const hasEntry = Boolean(manifest.entry)
      return {
        manifest,
        permissions: manifest.permissions && Array.isArray(manifest.permissions.declares)
          ? manifest.permissions.declares
          : undefined,
        runtime: {
          kind: hasEntry ? RUNTIME_KINDS.IN_PROCESS.id : RUNTIME_KINDS.DECLARATIVE.id,
          entry: hasEntry ? path.join(artifact.dir || '', manifest.entry) : null,
          source: artifact.source || artifact.dir || null
        },
        health: {
          contract: hasEntry ? 'full' : 'none',
          detail: hasEntry
            ? 'the plugin implements no healthCheck'
            : 'a declarative plugin contributes no code, so there is nothing to ask'
        },
        sourceFormat: PLUGIN_TYPES.DECLARED
      }
    },

    describe() {
      return { formats: ['dshns-plugin.json', 'an imported module exporting a manifest'] }
    }
  }
}

module.exports = { createNativeHnsAdapter, manifestFromDeclaration }
