'use strict'

/**
 * DS-Hns Core: the plugin adapter framework.
 *
 * This is the seam the requirement is about. Above it, the plugin manager knows exactly one thing:
 * a plugin is a manifest plus four optional hooks. Below it, any number of external formats are
 * understood by adapters that can be added, replaced or removed without the manager changing.
 *
 * The pipeline, and why it is ordered this way:
 *
 * ```
 *   artifact ──► detect ──► select ──► adapt ──► validate ──► standardise ──► unify ──► plugin
 *                 │          │          │           │             │            │
 *              evidence   one of N   third-party  the output   the platform's  the standard
 *              on disk    adapters   code runs    is the       own manifest    interfaces
 *                                                 right shape  contract
 * ```
 *
 * **Nothing in this file throws.** That is the single most important property here, and it is a
 * requirement rather than a style: adapter code is third-party code that runs during startup, and
 * a framework that lets it throw is a framework that lets one malformed plugin directory stop the
 * application from starting. Every stage returns a coded value, every stage is wrapped, and the
 * caller's loop is written so that `adaptMany` cannot be broken by any one artifact.
 *
 * The framework also owns the **permission policy**, because that is the only place where the
 * adapter's proposal, the plugin's own declaration and the deployment's wishes can all be seen at
 * once. An adapter proposes; the framework decides.
 */

const {
  ADAPTER_API_VERSION,
  ADAPTER_FAULT_CODES,
  ADAPTER_PHASES,
  PERMISSIONS,
  PERMISSION_IDS,
  RUNTIME_KINDS,
  adapterFault,
  validateAdapterOutput,
  standardizeManifest
} = require('./contract.cjs')
const { createTypeDetector, PLUGIN_TYPES, PLUGIN_TYPE_IDS } = require('./detect.cjs')
const { createAdapterRegistry } = require('./registry.cjs')
const { unifyLifecycle, LIFECYCLE_STATES } = require('./lifecycle.cjs')

/** No more than this many artifacts are adapted by one `adaptMany` call unless a caller says so. */
const DEFAULT_ARTIFACT_LIMIT = 512

/**
 * @param {object} [options]
 * @param {object} [options.registry] a registry to reuse
 * @param {object} [options.detector] a detector to reuse
 * @param {object} [options.policy] `{ allow?: string[], deny?: string[] }`
 * @param {Function} [options.log]
 * @param {Function} [options.now]
 * @param {number} [options.errorLimit] per-plugin error ring size
 * @param {number} [options.artifactLimit]
 */
function createAdapterFramework(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const registry = options.registry || createAdapterRegistry({ log })
  const detector = options.detector || createTypeDetector({ log })
  const policy = options.policy && typeof options.policy === 'object' ? options.policy : {}
  const errorLimit = Number.isFinite(options.errorLimit) ? Number(options.errorLimit) : undefined
  const artifactLimit = Number.isFinite(options.artifactLimit) ? Number(options.artifactLimit) : DEFAULT_ARTIFACT_LIMIT

  function register(adapter, registerOptions) {
    return registry.register(adapter, registerOptions)
  }

  function detect(artifact) {
    try {
      return detector.detect(artifact)
    } catch (error) {
      // The detector already contains its own faults, so reaching here means something structural.
      return adapterFault(ADAPTER_FAULT_CODES.DETECTOR_THREW, `detection failed: ${String(error && error.message ? error.message : error)}`, {
        phase: ADAPTER_PHASES.DETECT
      })
    }
  }

  /**
   * Turn one artifact into a plugin the manager can install.
   *
   * @param {object} artifact
   * @param {object} [adaptOptions]
   * @returns {Promise<{ok:boolean, plugin?:object, manifest?:object, detection?:object, adapter?:object, selection?:object, code?:string, reason?:string, phase?:string}>}
   */
  async function adapt(artifact, adaptOptions = {}) {
    const detection = detect(artifact)
    if (!detection.ok) {
      return { ...detection, phase: detection.phase || ADAPTER_PHASES.DETECT }
    }

    const planned = registry.plan(detection, artifact)
    if (planned.ok !== true) {
      return { ...planned, phase: ADAPTER_PHASES.SELECT, detection }
    }

    /**
     * Every willing adapter is tried, in selection order, until one succeeds.
     *
     * The fallback matters more than it looks: a specific adapter that recognises a format but
     * cannot handle *this* artifact must not become the reason a broader adapter never gets a
     * turn. And every attempt is kept, because "adapter A said the entry is missing and adapter B
     * said the same thing" is a much better support report than "no adapter worked".
     */
    const attempts = []
    for (const entry of planned.plan) {
      const adapter = entry.adapter
      if (!entry.accepted) {
        attempts.push({ adapter: adapter.id, code: entry.refusal.code, reason: entry.refusal.reason })
        continue
      }

      // The adapter is third-party code between these lines. It may throw, return nothing, return
      // something that is not a descriptor, or refuse; all four are values below.
      let output = null
      try {
        output = await adapter.adapt(artifact, detection, adaptOptions)
      } catch (error) {
        const reason = `adapter ${adapter.id} threw: ${String(error && error.message ? error.message : error)}`
        attempts.push({ adapter: adapter.id, code: ADAPTER_FAULT_CODES.THREW, reason })
        log({ kind: 'adapter-threw', adapter: adapter.id, reason })
        continue
      }

      // A refusal is the adapter's own answer, not malformed output. Reporting it as
      // `ADAPTER_INVALID_OUTPUT` — which is what treating every return value as a descriptor does
      // — would replace an actionable reason ("the entry is not in the repository") with a
      // framework complaint about its own contract.
      if (output && output.ok === false) {
        attempts.push({
          adapter: adapter.id,
          code: output.code || ADAPTER_FAULT_CODES.REFUSED,
          reason: output.reason || 'the adapter refused this artifact'
        })
        continue
      }

      const shaped = validateAdapterOutput(output, adapter.id)
      if (!shaped.ok) {
        attempts.push({ adapter: adapter.id, code: shaped.code, reason: shaped.reason })
        log({ kind: 'adapter-invalid-output', adapter: adapter.id, reason: shaped.reason })
        continue
      }

      const standardized = standardizeManifest({
        manifest: output.manifest,
        adapter,
        permissions: output.permissions,
        runtime: output.runtime,
        policy: adaptOptions.policy || policy,
        health: output.health,
        sourceFormat: output.sourceFormat || detection.type,
        now
      })
      if (!standardized.ok) {
        attempts.push({ adapter: adapter.id, code: standardized.code, reason: standardized.reason })
        log({ kind: 'adapter-invalid-manifest', adapter: adapter.id, reason: standardized.reason })
        continue
      }

      // A plugin whose declaration could not be honoured in full is *reported*, not refused: an
      // unknown permission is a fact about the plugin that the panel must show, and refusing to
      // load it would be the platform taking a decision the user has not been offered.
      if (!standardized.permissions.complete) {
        log({
          kind: 'adapter-permissions-incomplete',
          adapter: adapter.id,
          plugin: standardized.manifest.id,
          refused: standardized.permissions.refused.map((refused) => refused.permission)
        })
      }

      const plugin = unifyLifecycle({
        descriptor: { ...output, manifest: standardized.manifest },
        adapter,
        runtime: standardized.manifest.runtime,
        log,
        now,
        errorLimit
      })

      // The adaptation itself is part of the plugin's record: which adapter ran, what it detected,
      // and what it was granted. This is what makes "why does this plugin look like this"
      // answerable without reproducing the machine it happened on.
      const alternatives = planned.plan
        .filter((other) => other.adapter.id !== adapter.id && other.accepted && other.priority === entry.priority)
        .map((other) => other.adapter.id)
      plugin.adaptation = {
        adapter: { id: adapter.id, version: adapter.version, api_version: adapter.api_version },
        detected_type: detection.type,
        confidence: detection.confidence,
        evidence: detection.evidence.slice(),
        alternatives,
        ambiguous: alternatives.length > 0,
        attempts,
        permissions: standardized.permissions,
        adapted_at: now()
      }
      plugin.standard = {
        api_version: ADAPTER_API_VERSION,
        runtime_kind: standardized.manifest.runtime.kind,
        enforcement: standardized.manifest.runtime.enforcement
      }

      log({
        kind: 'adapter-adapted',
        adapter: adapter.id,
        plugin: standardized.manifest.id,
        type: detection.type,
        runtime: standardized.manifest.runtime.kind
      })
      return {
        ok: true,
        plugin,
        manifest: standardized.manifest,
        detection,
        adapter,
        selection: { ok: true, adapter, considered: planned.plan.map((other) => other.adapter.id), ambiguous: alternatives.length > 0, alternatives },
        permissions: standardized.permissions
      }
    }

    const detail = attempts.map((attempt) => `${attempt.adapter}: ${attempt.reason}`).join('; ')
    return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `no adapter could adapt this artifact (${detail})`, {
      phase: ADAPTER_PHASES.ADAPT,
      detection,
      attempts
    })
  }

  /**
   * Adapt many artifacts, reporting a failure per artifact and never one for the batch.
   *
   * This is the function the host calls with the installed set. Its contract is the requirement
   * in one sentence: *however badly one adapter behaves, the others still produce plugins.*
   */
  async function adaptMany(artifacts, adaptOptions = {}) {
    const list = Array.isArray(artifacts) ? artifacts : []
    const limit = Number.isFinite(adaptOptions.limit) ? Math.max(0, Number(adaptOptions.limit)) : artifactLimit
    const plugins = []
    const failures = []
    /** One entry per input, in input order, so a caller can pair a result with the thing it asked about. */
    const results = []
    for (let index = 0; index < list.length; index += 1) {
      const artifact = list[index]
      if (index >= limit) {
        const exhausted = {
          ...adapterFault(ADAPTER_FAULT_CODES.BUDGET_EXCEEDED, `only the first ${limit} artifacts were adapted`, {
            phase: ADAPTER_PHASES.ADAPT
          }),
          index,
          artifact
        }
        failures.push(exhausted)
        results.push(exhausted)
        continue
      }
      let outcome = null
      try {
        outcome = await adapt(artifact, adaptOptions)
      } catch (error) {
        // `adapt` is written not to throw; this is the belt to that pair of braces, because the
        // cost of being wrong here is the application not starting.
        outcome = adapterFault(ADAPTER_FAULT_CODES.THREW, `adaptation failed unexpectedly: ${String(error && error.message ? error.message : error)}`, {
          phase: ADAPTER_PHASES.ADAPT
        })
      }
      if (outcome.ok) {
        plugins.push(outcome.plugin)
        results.push({ index, ok: true, plugin: outcome.plugin, artifact, outcome })
      } else {
        const failure = { ...outcome, index, artifact }
        failures.push(failure)
        results.push(failure)
      }
    }
    return { plugins, failures, results }
  }

  /** The panel's view of the framework: what it can detect, who adapts it, what it promises. */
  function describe() {
    return {
      api_version: ADAPTER_API_VERSION,
      adapters: registry.describe(),
      types: detector.types(),
      runtime_kinds: Object.values(RUNTIME_KINDS).map((kind) => ({ ...kind })),
      permissions: PERMISSION_IDS.map((id) => ({ id, ...PERMISSIONS[id] })),
      policy: {
        allow: Array.isArray(policy.allow) ? policy.allow.slice() : null,
        deny: Array.isArray(policy.deny) ? policy.deny.slice() : []
      },
      limits: { artifacts: artifactLimit, errors_per_plugin: errorLimit || null }
    }
  }

  return {
    ADAPTER_API_VERSION,
    PLUGIN_TYPES,
    LIFECYCLE_STATES,
    registry,
    detector,
    register,
    detect,
    adapt,
    adaptMany,
    describe,
    /** The permission vocabulary, for validation by callers that never adapt anything. */
    permissions: () => PERMISSION_IDS.slice(),
    types: () => PLUGIN_TYPE_IDS.slice(),
    /** The policy in force, so a caller can explain a refusal without re-deriving it. */
    policy: () => ({ allow: Array.isArray(policy.allow) ? policy.allow.slice() : null, deny: Array.isArray(policy.deny) ? policy.deny.slice() : [] })
  }
}

module.exports = {
  createAdapterFramework,
  DEFAULT_ARTIFACT_LIMIT,
  ADAPTER_API_VERSION,
  ADAPTER_FAULT_CODES,
  ADAPTER_PHASES,
  PLUGIN_TYPES,
  RUNTIME_KINDS,
  PERMISSIONS,
  PERMISSION_IDS,
  LIFECYCLE_STATES
}
