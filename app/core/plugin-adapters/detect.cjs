'use strict'

/**
 * DS-Hns Core: what kind of plugin is this?
 *
 * Detection is deliberately separate from adaptation, and deliberately cheap. It answers one
 * question — *which* external shapes are present in this artifact — and it answers it by reading
 * files that are already on disk. It never imports the plugin, never runs it and never writes
 * anything, because the answer decides whether anything is allowed to run at all.
 *
 * Three properties are load-bearing:
 *
 *   * **Many detections, not one.** A directory that is both a node package and a Cordis bundle
 *     produces both, ordered by confidence. The registry then tries adapters in that order, which
 *     is what lets a more specific adapter win without either of them having to know about the
 *     other.
 *   * **Evidence, always.** Every detection carries the file and the field that produced it. A
 *     type with no evidence is a guess, and a guess is how "we adapted it as a Cordis plugin" gets
 *     said about something that was never one.
 *   * **A detector that throws is one detector, not the run.** Detectors read third-party files;
 *     a malformed `package.json`, a permission error and a path that is not a directory are all
 *     normal. Each is recorded as a fault against that detector and the remaining detectors still
 *     run, because a plugin whose `package.json` is unreadable must not stop the platform from
 *     classifying the next one.
 */

const fs = require('node:fs')
const path = require('node:path')

const { ADAPTER_FAULT_CODES, adapterFault } = require('./contract.cjs')

/**
 * The canonical plugin types the platform can name.
 *
 * These are *detection* types, not adapters: several can be adapted by one adapter, and one
 * adapter may accept several. Keeping the names here — in one frozen object — is what stops two
 * adapters inventing two spellings of `cordis.bundle`.
 */
const PLUGIN_TYPES = Object.freeze({
  /** The platform's own declared manifest file, `dshns-plugin.json`. */
  DECLARED: 'dshns.declared',
  /** An already-imported module that exports a standard plugin (the in-process case). */
  MODULE: 'dshns.module',
  /** A descriptor a previous compatibility pass derived and wrote beside the package. */
  COMPAT_DESCRIPTOR: 'compat.descriptor',
  /** A package that declares the other DSH host's bundle metadata. */
  CORDIS_BUNDLE: 'cordis.bundle',
  /** A package that declares the other DSH host's client metadata but no bundle patch. */
  CORDIS_CLIENT: 'cordis.client',
  /** An ES module package that looks like a plugin but declares nothing recognisable. */
  NODE_ESM: 'node.esm',
  /** A CommonJS package that looks like a plugin but declares nothing recognisable. */
  NODE_CJS: 'node.cjs',
  /** Nothing recognisable. */
  UNKNOWN: 'unknown'
})

/** Every type id, for validation and for the panel's vocabulary. */
const PLUGIN_TYPE_IDS = Object.freeze(Object.values(PLUGIN_TYPES))

const MANIFEST_FILE = 'dshns-plugin.json'
const COMPAT_FILE = 'dshns-plugin.compat.json'
const CORDIS_PATCH_FILE = 'cordis.patch.yml'

/** Read a JSON file, returning null instead of throwing: half of these files are optional. */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Normalise the artifact a caller hands in, so detectors can assume a shape. */
function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return null
  const dir = artifact.dir ? path.resolve(String(artifact.dir)) : null
  return {
    dir,
    module: artifact.module && typeof artifact.module === 'object' ? artifact.module : null,
    descriptor: artifact.descriptor && typeof artifact.descriptor === 'object' ? artifact.descriptor : null,
    plugin: artifact.plugin && typeof artifact.plugin === 'object' ? artifact.plugin : null,
    source: artifact.source ? String(artifact.source) : null,
    repo: artifact.repo ? String(artifact.repo) : null,
    branch: artifact.branch ? String(artifact.branch) : null,
    /** Free-form, adapter-specific input (a declared manifest, a settings block, …). */
    extra: artifact.extra && typeof artifact.extra === 'object' ? artifact.extra : {}
  }
}

/**
 * The built-in detectors, in priority order.
 *
 * Priority is a tie-break inside one artifact, not a statement about importance: a directory that
 * carries the platform's own manifest is a declared plugin even though it also has a
 * `package.json`, and that has to be true regardless of the order they were registered in.
 */
function builtinDetectors() {
  return [
    {
      id: 'declared-manifest',
      priority: 100,
      detect(artifact) {
        if (!artifact.dir) return null
        const file = path.join(artifact.dir, MANIFEST_FILE)
        if (!isFile(file)) return null
        const manifest = readJson(file)
        if (!manifest) {
          return {
            type: PLUGIN_TYPES.UNKNOWN,
            confidence: 0.4,
            evidence: [`${MANIFEST_FILE} exists but could not be parsed as a JSON object`]
          }
        }
        const version = String(manifest.api_version || '')
        return {
          type: PLUGIN_TYPES.DECLARED,
          confidence: version === 'dshns.plugin/v1' ? 1 : 0.6,
          evidence: [`${MANIFEST_FILE}#api_version=${version || '(absent)'}`],
          detail: { manifest, api_version: version }
        }
      }
    },
    {
      id: 'imported-module',
      priority: 95,
      detect(artifact) {
        if (!artifact.module) return null
        const manifest = artifact.module.manifest
        if (!manifest || typeof manifest !== 'object') return null
        return {
          type: PLUGIN_TYPES.MODULE,
          confidence: String(manifest.api_version || '') === 'dshns.plugin/v1' ? 1 : 0.5,
          evidence: ['the supplied module exports a manifest'],
          detail: { manifest }
        }
      }
    },
    {
      id: 'compat-descriptor',
      priority: 90,
      detect(artifact) {
        if (!artifact.dir) return null
        const file = path.join(artifact.dir, COMPAT_FILE)
        if (!isFile(file)) return null
        const descriptor = readJson(file)
        if (!descriptor) {
          return { type: PLUGIN_TYPES.UNKNOWN, confidence: 0.3, evidence: [`${COMPAT_FILE} exists but could not be parsed`] }
        }
        return {
          type: PLUGIN_TYPES.COMPAT_DESCRIPTOR,
          confidence: 0.95,
          evidence: [`${COMPAT_FILE}#compat_version=${descriptor.compat_version || '(absent)'}`],
          detail: { descriptor }
        }
      }
    },
    {
      id: 'node-package',
      priority: 50,
      detect(artifact) {
        if (!artifact.dir) return null
        const file = path.join(artifact.dir, 'package.json')
        if (!isFile(file)) return null
        const pkg = readJson(file)
        if (!pkg) {
          return { type: PLUGIN_TYPES.UNKNOWN, confidence: 0.2, evidence: ['package.json exists but could not be parsed'] }
        }
        const evidence = ['package.json']
        const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : null
        const hasPatch = Boolean(dsh && dsh.bundle && dsh.bundle.patch)
        const hasPatchFile = isFile(path.join(artifact.dir, CORDIS_PATCH_FILE))
        const isEsm = pkg.type === 'module'

        if (hasPatch) evidence.push(`package.json#dsh.bundle.patch=${dsh.bundle.patch}`)
        if (hasPatchFile) evidence.push(CORDIS_PATCH_FILE)
        if (isEsm) evidence.push('package.json#type=module')
        if (dsh && dsh.client) evidence.push('package.json#dsh.client')

        if (hasPatch || hasPatchFile) {
          return {
            type: PLUGIN_TYPES.CORDIS_BUNDLE,
            confidence: 0.9,
            evidence,
            detail: { package: pkg, patch: hasPatch ? String(dsh.bundle.patch) : CORDIS_PATCH_FILE }
          }
        }
        if (dsh) {
          return { type: PLUGIN_TYPES.CORDIS_CLIENT, confidence: 0.6, evidence, detail: { package: pkg } }
        }
        return {
          type: isEsm ? PLUGIN_TYPES.NODE_ESM : PLUGIN_TYPES.NODE_CJS,
          confidence: 0.3,
          evidence,
          detail: { package: pkg }
        }
      }
    }
  ]
}

/**
 * @param {object} [options]
 * @param {Function} [options.log]
 * @param {Array} [options.detectors] extra detectors, appended to the built-in set
 */
function createTypeDetector(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** Extra detectors are kept beside the built-ins rather than merged into them, so a caller can
   *  register a detector with the same id as a built-in and still be told which one answered. */
  const extra = []

  function register(detector) {
    if (!detector || typeof detector !== 'object') return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, 'a detector must be an object')
    const id = String(detector.id || '')
    if (!id) return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, 'a detector needs an id')
    if (typeof detector.detect !== 'function') return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, `detector ${id} has no detect function`)
    if (extra.some((entry) => entry.id === id)) {
      return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, `detector ${id} is already registered`)
    }
    extra.push({ id, priority: Number.isFinite(detector.priority) ? Number(detector.priority) : 0, detect: detector.detect })
    return { ok: true, id }
  }

  function all() {
    return [...builtinDetectors(), ...extra].sort((left, right) => right.priority - left.priority)
  }

  /**
   * Examine one artifact and return every type it matched, most confident first.
   *
   * The result is never a throw and never a bare null: an artifact nothing recognised is
   * `{ ok: false, code: ADAPTER_UNDETECTED }` with whatever evidence was collected, because
   * "nothing matched" and "the detector broke" are different reports.
   *
   * @param {object} rawArtifact
   * @returns {{ok:boolean, type?:string, confidence?:number, detections?:Array, faults?:Array, code?:string, reason?:string, artifact?:object}}
   */
  function detect(rawArtifact) {
    const artifact = normalizeArtifact(rawArtifact)
    if (!artifact) {
      return adapterFault(ADAPTER_FAULT_CODES.BAD_ARTIFACT, 'an artifact must be an object')
    }
    if (!artifact.dir && !artifact.module && !artifact.descriptor && !artifact.plugin) {
      return adapterFault(ADAPTER_FAULT_CODES.BAD_ARTIFACT, 'an artifact must name a directory, a module, a descriptor or a plugin', { artifact })
    }

    const detections = []
    const faults = []
    for (const detector of all()) {
      let outcome = null
      try {
        outcome = detector.detect(artifact)
      } catch (error) {
        // A detector reads third-party files. A throw is this detector's problem, and the next
        // detector still gets its turn.
        faults.push({
          code: ADAPTER_FAULT_CODES.DETECTOR_THREW,
          detector: detector.id,
          reason: String(error && error.message ? error.message : error)
        })
        log({ kind: 'adapter-detector-threw', detector: detector.id, reason: String(error && error.message ? error.message : error) })
        continue
      }
      if (!outcome || !outcome.type) continue
      detections.push({
        detector: detector.id,
        type: String(outcome.type),
        confidence: Number.isFinite(outcome.confidence) ? Number(outcome.confidence) : 0,
        evidence: Array.isArray(outcome.evidence) ? outcome.evidence.map(String) : [],
        detail: outcome.detail && typeof outcome.detail === 'object' ? outcome.detail : null
      })
    }

    detections.sort((left, right) => right.confidence - left.confidence)

    if (!detections.length) {
      return adapterFault(ADAPTER_FAULT_CODES.UNDETECTED, 'no detector recognised this artifact', {
        detections: [],
        faults,
        artifact
      })
    }
    const best = detections[0]
    return {
      ok: true,
      type: best.type,
      confidence: best.confidence,
      evidence: best.evidence,
      // The winning detection's own payload is surfaced here as well as inside `detections`, so an
      // adapter can read what the detector already parsed without walking the list and guessing
      // which entry won.
      detail: best.detail,
      detections,
      faults,
      artifact
    }
  }

  return {
    PLUGIN_TYPES,
    register,
    detect,
    /** The detector set, for tests and for the diagnostic surface. */
    list: () => all().map((detector) => ({ id: detector.id, priority: detector.priority })),
    /** The type names this detector set can produce, sorted, for the panel's vocabulary. */
    types: () => [...PLUGIN_TYPE_IDS].sort()
  }
}

module.exports = {
  PLUGIN_TYPES,
  PLUGIN_TYPE_IDS,
  MANIFEST_FILE,
  COMPAT_FILE,
  CORDIS_PATCH_FILE,
  createTypeDetector,
  normalizeArtifact,
  builtinDetectors,
  readJson
}
