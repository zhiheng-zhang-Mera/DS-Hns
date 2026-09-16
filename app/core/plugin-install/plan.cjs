'use strict'

/**
 * DS-Hns Core: the pre-install plan.
 *
 * Everything a person needs to decide whether to install something, produced *before* anything is
 * cloned, adapted or run. The requirement is a display — adapter type, run mode, permissions, risk
 * level, likely degradation — and the reason it is a module rather than a screen is that all five
 * have to be derived from the same analysis that the install itself will use. A confirmation dialog
 * that computes its own answer is a dialog that can disagree with what actually happens.
 *
 * So the plan *is* the install's own reasoning, rendered. `pipeline.install()` consumes the same
 * plan object it showed; if the two could drift, the display would be decoration.
 *
 * ## Risk is about what the plugin can reach, not how it feels
 *
 * The score is built from facts the platform already decided: the runtime kind's enforcement, the
 * permissions actually granted, and whether the plugin ships code that runs in the host's process.
 * A plugin with no code at all is the lowest risk that exists; a plugin holding `process.spawn` and
 * `fs.write` *in the host's process* is not. Nothing here is a guess about intent — an assessment
 * that needed to guess would be an assessment nobody should act on.
 */

const { RUNTIME_KINDS, PERMISSIONS } = require('../plugin-adapters/contract.cjs')

/** The risk levels, coarsened on purpose: a five-point scale nobody agrees on is worse than three. */
const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
})

/**
 * What each granted permission contributes, and why.
 *
 * The weight is the *reach* of the permission, not its scariness: `fs.read` restricted to a
 * plugin's own directory is nearly nothing, and spawning a process with the user's rights is nearly
 * everything.
 */
const PERMISSION_RISK = Object.freeze({
  'fs.read': 1,
  'config.read': 0,
  'bus.subscribe': 1,
  'bus.emit': 1,
  'capability.consume': 1,
  'ui.render': 2,
  'settings.write': 2,
  'capability.provide': 2,
  network: 5,
  'fs.write': 5,
  'worker.control': 6,
  'process.spawn': 8
})

/** How much the runtime boundary itself contributes. In-process code has no boundary at all. */
const RUNTIME_RISK = Object.freeze({
  'declarative': 0,
  'isolated-process': 2,
  'managed-process': 3,
  'in-process': 8,
  'remote': 4
})

/**
 * Assess one adapted plugin.
 *
 * @param {object} input
 * @param {object} input.manifest the standardized manifest
 * @param {object} [input.structure] a Cordis structure report, when the plugin has one
 * @param {object} [input.stats] extra facts: `{ peerCount, missingPeers, hasClientHalf, byteSize }`
 */
function assessRisk(input = {}) {
  const manifest = input.manifest || {}
  const permissions = manifest.permissions || { granted: [] }
  const runtime = manifest.runtime || {}
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {}

  const factors = []
  let score = 0

  const runtimeKind = runtime.kind || RUNTIME_KINDS.IN_PROCESS.id
  const runtimeWeight = RUNTIME_RISK[runtimeKind] === undefined ? 8 : RUNTIME_RISK[runtimeKind]
  score += runtimeWeight
  factors.push({
    factor: 'runtime',
    value: runtimeKind,
    weight: runtimeWeight,
    detail: runtime.enforcement
      ? `enforcement is ${runtime.enforcement}`
      : 'no enforcement is declared for this runtime'
  })

  for (const permission of permissions.granted || []) {
    const weight = PERMISSION_RISK[permission] === undefined ? 4 : PERMISSION_RISK[permission]
    score += weight
    if (weight >= 5) {
      factors.push({ factor: 'permission', value: permission, weight, detail: PERMISSIONS[permission] ? PERMISSIONS[permission].detail : 'not in the vocabulary' })
    }
  }
  // A refused permission is a *lowering* fact: the plugin asked for something and will not get it,
  // which is worth showing but is not risk.
  for (const refusal of permissions.refused || []) {
    factors.push({ factor: 'refused', value: refusal.permission, weight: 0, detail: refusal.reason })
  }

  if (stats.hasClientHalf) {
    score += 2
    factors.push({ factor: 'client-half', value: true, weight: 2, detail: 'ships a browser half that this host cannot serve' })
  }
  if (Number.isFinite(stats.missingPeers) && stats.missingPeers > 0) {
    score += 3
    factors.push({ factor: 'missing-peers', value: stats.missingPeers, weight: 3, detail: 'a required dependency is not provided by this host' })
  }
  if (manifest.fault_level === 'fatal') {
    score += 10
    factors.push({ factor: 'fault-level', value: 'fatal', weight: 10, detail: 'a fault stops the task rather than degrading it' })
  }

  const level = score >= 12 ? RISK_LEVELS.HIGH : score >= 5 ? RISK_LEVELS.MEDIUM : RISK_LEVELS.LOW
  return { level, score, factors }
}

/**
 * What happens if this plugin is absent, degrades or is refused — stated before it is installed.
 *
 * Two sources, and both are already the platform's own: the capability fallbacks for what the
 * plugin *provides* (a consumer of a capability nobody provides gets the documented fallback), and
 * the structural facts that mean part of the plugin will not work here (a browser half, a missing
 * peer).
 */
function degradationFor(input = {}) {
  const manifest = input.manifest || {}
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {}
  const { fallbackFor } = require('../contracts/capability.cjs')
  const notes = []

  for (const capability of manifest.provides || []) {
    notes.push({ of: 'capability', capability, detail: fallbackFor(capability) })
  }
  if (stats.hasClientHalf) {
    notes.push({
      of: 'client-half',
      capability: null,
      detail: 'the host half runs; the browser half is detected and reported, and is not served by a host-process bridge'
    })
  }
  if (Array.isArray(stats.missingPeers) && stats.missingPeers.length) {
    notes.push({ of: 'peer', capability: null, detail: `${stats.missingPeers.join(', ')} cannot be provided by this host; the plugin may refuse to load` })
  }
  for (const refusal of (manifest.permissions && manifest.permissions.refused) || []) {
    notes.push({ of: 'permission', capability: null, detail: `${refusal.permission} is refused (${refusal.reason})` })
  }
  if (!notes.length) notes.push({ of: 'none', capability: null, detail: 'no degradation is declared for this plugin' })
  return notes
}

/**
 * The plan document.
 *
 * Every field the requirement names, from the analysis the install will use:
 * `adapter`, `runtime`, `permissions`, `risk`, `degradation`. `verdict` is the pipeline's decision,
 * and it is deliberately one of three: install, refuse, or hand to a person.
 */
function buildPlan(input = {}) {
  const manifest = input.manifest || {}
  const structure = input.structure || null
  const stats = input.stats || {}
  const risk = assessRisk({ manifest, structure, stats })
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || null,
    source: input.source || null,
    provenance: input.provenance || null,
    /** Which adapter will run, and what it detected. */
    adapter: {
      id: input.adapter ? input.adapter.id : null,
      version: input.adapter ? input.adapter.version : null,
      detectedType: input.detectedType || null,
      confidence: Number.isFinite(input.confidence) ? input.confidence : null,
      evidence: Array.isArray(input.evidence) ? input.evidence.slice() : []
    },
    /** How it will run, and what that boundary actually enforces. */
    runtime: {
      kind: manifest.runtime ? manifest.runtime.kind : null,
      enforcement: manifest.runtime ? manifest.runtime.enforcement : null,
      isolation: manifest.runtime ? manifest.runtime.isolation : null,
      entry: manifest.runtime ? manifest.runtime.entry : null
    },
    /** What it asked for, what it will get, and what it will not. */
    permissions: manifest.permissions || { declared: [], granted: [], refused: [], unknown: [] },
    risk,
    degradation: degradationFor({ manifest, stats }),
    /** What it contributes to the platform, so a consumer can be told what it is gaining. */
    provides: (manifest.provides || []).slice(),
    /** The structure report, when there is one, because it is what a person will want next. */
    structure: structure
      ? {
          shape: structure.shape,
          markers: structure.markers,
          bundle: structure.bundle,
          client: structure.client,
          peers: { required: structure.peers.required.map((peer) => peer.name), optional: structure.peers.optional.map((peer) => peer.name), missing: structure.peers.missing.map((peer) => peer.name) },
          inject: structure.host ? { required: structure.host.injectRequired, optional: structure.host.injectOptional } : null
        }
      : null,
    /** Install, refuse, or hand to a person. */
    verdict: input.verdict || 'install',
    verdictReason: input.verdictReason || null,
    limitations: Array.isArray(input.limitations) ? input.limitations.slice() : []
  }
}

/** A one-line summary, for a log or a notification. */
function summarize(plan) {
  if (!plan) return 'no plan'
  const risk = plan.risk ? plan.risk.level : 'unknown'
  const runtime = plan.runtime && plan.runtime.kind ? plan.runtime.kind : 'unknown runtime'
  const adapter = plan.adapter && plan.adapter.id ? plan.adapter.id : 'no adapter'
  return `${plan.id} v${plan.version} via ${adapter} (${runtime}, ${risk} risk): ${plan.verdict}`
}

module.exports = {
  RISK_LEVELS,
  PERMISSION_RISK,
  RUNTIME_RISK,
  assessRisk,
  degradationFor,
  buildPlan,
  summarize
}
