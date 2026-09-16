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
 * Load a declared plugin's entry module.
 *
 * A `dshns-plugin.json` names a `main`, and until this existed the adapter ignored it: a declared
 * plugin became *declarative* — a manifest and no code — even when it shipped an entry beside it.
 * That made the format distributable but not runnable, which is not a plugin format, it is a
 * descriptor format. Loading the entry is what turns a repository of files into something the
 * store can install.
 *
 * CommonJS first, then ESM: `require` cannot read an ES module, and the reverse guess would break
 * every `.cjs` plugin. The resolved path is checked against the plugin directory by the caller.
 */
async function importDeclaredEntry(file) {
  const { createRequire } = require('node:module')
  const { pathToFileURL } = require('node:url')
  const requireFrom = createRequire(file)
  try {
    const loaded = requireFrom(file)
    return typeof loaded === 'function' ? loaded() : loaded
  } catch (error) {
    const esmOnly = error && (error.code === 'ERR_REQUIRE_ESM' || /Cannot use import statement|Unexpected token 'export'/.test(String(error.message || '')))
    if (!esmOnly) throw error
    const namespace = await import(pathToFileURL(file).href)
    const loaded = namespace && namespace.default !== undefined ? namespace.default : namespace
    return typeof loaded === 'function' ? loaded() : loaded
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
      const entryPath = hasEntry ? path.resolve(artifact.dir || '.', manifest.entry) : null
      if (entryPath) {
        // The entry must stay inside the plugin directory: a declaration that could import an
        // arbitrary file on the machine is a declaration that makes the directory meaningless.
        const inside = path.relative(artifact.dir || '.', entryPath)
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
          return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the declared entry ${manifest.entry} escapes the plugin directory`)
        }
      }

      let loaded = null
      if (entryPath) {
        try {
          loaded = await importDeclaredEntry(entryPath)
        } catch (error) {
          return adapterFault(
            ADAPTER_FAULT_CODES.REFUSED,
            `the declared entry ${manifest.entry} could not be imported: ${error && error.message ? error.message : error}`
          )
        }
        if (!loaded || typeof loaded !== 'object') {
          return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `the declared entry ${manifest.entry} does not export a plugin object`)
        }
      }

      // The module's own manifest wins where it speaks: it is the plugin's declaration about
      // itself, and the JSON file is the distribution wrapper around it.
      const merged = loaded && loaded.manifest && typeof loaded.manifest === 'object'
        ? { ...manifest, ...loaded.manifest, entry: manifest.entry }
        : manifest

      return {
        manifest: merged,
        install: loaded && typeof loaded.install === 'function' ? loaded.install : undefined,
        load: loaded && typeof loaded.load === 'function' ? loaded.load : undefined,
        unload: loaded && typeof loaded.unload === 'function' ? loaded.unload : undefined,
        healthCheck: loaded && typeof loaded.healthCheck === 'function' ? loaded.healthCheck : undefined,
        runtimeInfo: loaded && typeof loaded.runtimeInfo === 'function' ? loaded.runtimeInfo : undefined,
        permissions: merged.permissions && Array.isArray(merged.permissions.declares)
          ? merged.permissions.declares
          : undefined,
        runtime: {
          kind: hasEntry ? RUNTIME_KINDS.IN_PROCESS.id : RUNTIME_KINDS.DECLARATIVE.id,
          entry: entryPath,
          source: artifact.source || artifact.dir || null
        },
        health: {
          contract: hasEntry ? 'full' : 'none',
          detail: hasEntry
            ? (loaded && typeof loaded.healthCheck === 'function' ? 'the plugin implements healthCheck' : 'the plugin implements no healthCheck')
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
