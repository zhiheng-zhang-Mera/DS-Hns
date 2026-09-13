'use strict'

/**
 * Computer Use Runtime: self-health snapshot
 * (Update-Plan/24h.md Task 19, Task 20, §21/§22 of the plan).
 *
 * The upper layer needs one question answered cheaply and honestly:
 *
 *   can this executor keep working right now?
 *
 * The answer is a snapshot, not a plan. It reports which controllers are usable,
 * what the runtime owns, how much resource pressure there is and whether progress
 * is still happening — and it answers `blocked` when continuing would mean acting
 * on a state the runtime cannot vouch for.
 *
 * The block conditions are deliberately narrow (24h.md Task 20): a single failed
 * action must not make a task fatal, and a single failed controller must not make
 * the runtime fatal. What stops the runtime is a condition under which *no*
 * correct action exists:
 *
 *   workspace unavailable            there is nowhere safe to write
 *   all required capabilities gone   no channel can carry the next action
 *   safety authorization unavailable  a destructive action cannot be authorized
 *   resource ceiling exceeded        the runtime cannot start anything safely
 *   state integrity uncertain        the runtime cannot tell what is true
 */

/** The health vocabulary. Three values, and nothing else can be reported. */
const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  BLOCKED: 'blocked'
})

/** Why a runtime is blocked. Every entry is a condition with no correct action. */
const BLOCK_REASONS = Object.freeze({
  WORKSPACE_UNAVAILABLE: 'workspace_unavailable',
  ALL_CAPABILITIES_UNAVAILABLE: 'all_required_capabilities_unavailable',
  SAFETY_UNAVAILABLE: 'safety_authorization_unavailable',
  RESOURCE_CEILING: 'resource_ceiling_exceeded',
  STATE_INTEGRITY_UNCERTAIN: 'state_integrity_uncertain'
})

/**
 * The capability names an action declares and the controllers that carry them do
 * not always agree (`filesystem` is carried by the `file` controller, `vision`
 * by the `vision` controller). This is the one place that mapping is stated, so
 * "is the capability this action needs usable?" has a single answer in health and
 * in `canExecute`.
 */
const CAPABILITY_CONTROLLERS = Object.freeze({
  browser: ['browser'],
  dom: ['browser'],
  desktop: ['desktop'],
  accessibility: ['desktop'],
  vision: ['vision'],
  screenshot: ['vision'],
  shell: ['shell'],
  process: ['shell'],
  filesystem: ['file'],
  file: ['file']
})

/** The controller ids that could carry `capability`. */
function controllerIdsFor(capability) {
  return CAPABILITY_CONTROLLERS[String(capability || '')] || [String(capability || '')]
}

/** Is the channel that carries `capability` usable right now? */
function capabilityIsUsable(capabilities, capability) {
  const name = String(capability || '')
  // The caller may name either a capability an action declares (`filesystem`)
  // or the controller id that carries it (`file`); `probeControllers()` keys by
  // controller id, so a direct hit is checked first.
  const ids = capabilities[name] ? [name] : controllerIdsFor(name)
  const known = ids.filter((id) => capabilities[id])
  if (!known.length) return false
  return known.some((id) => capabilities[id].available)
}

/**
 * Build the snapshot.
 *
 * @param {object} input
 * @param {object} input.controllers controller id -> probe result `{available, reason, detail}`
 * @param {string[]} [input.allowedCapabilities] the contract's allowed capabilities
 * @param {object} [input.workspace] `{ ok, cwd, reason }` from the workspace guard
 * @param {object} [input.resources] output of `resources.snapshot()`
 * @param {object} [input.processes] output of `processes.snapshot()`
 * @param {object} [input.progress] output of `progress.status()`
 * @param {number} [input.stallLevel]
 * @param {object} [input.step] `{ id, index }` of the step in flight
 * @param {boolean} [input.stateIntegrity] false when the runtime cannot vouch for its own state
 * @param {boolean} [input.safetyAvailable]
 * @param {number} [input.now]
 */
function buildHealthSnapshot(input = {}) {
  const now = input.now === undefined ? Date.now() : input.now
  const controllers = input.controllers || {}
  const allowed = Array.isArray(input.allowedCapabilities) ? input.allowedCapabilities : null

  const capabilities = {}
  const blockedReasons = []
  for (const [id, probe] of Object.entries(controllers)) {
    const available = probe ? probe.available !== false : false
    const degraded = Boolean(probe && probe.detail && probe.detail.degraded) || (!available)
    capabilities[id] = {
      status: available ? (degraded ? HEALTH_STATUS.DEGRADED : HEALTH_STATUS.HEALTHY) : 'unavailable',
      available,
      degraded,
      reason: probe && probe.reason ? probe.reason : null
    }
  }

  // `usable`/`unavailable` describe the *runtime*: what an upper layer can rely
  // on right now, whether or not the current contract allows it. A dead channel
  // that the contract happens not to need is still a degraded runtime, and
  // hiding it would misreport what was lost.
  const usable = Object.entries(capabilities).filter(([, entry]) => entry.available).map(([id]) => id)
  const blockedControllers = Object.entries(capabilities).filter(([, entry]) => !entry.available).map(([id]) => id)

  const workspace = input.workspace || null
  if (workspace && workspace.ok === false) {
    blockedReasons.push({ code: BLOCK_REASONS.WORKSPACE_UNAVAILABLE, reason: workspace.reason || 'no verified workspace' })
  }

  // A controller the contract does not allow is not "required", so its absence
  // must not block the run — but the absence of *every* allowed channel must.
  const allowedUsable = allowed ? allowed.filter((capability) => capabilityIsUsable(capabilities, capability)) : usable
  if (allowed && allowed.length > 0 && allowedUsable.length === 0) {
    blockedReasons.push({ code: BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE, reason: `none of the allowed capabilities are usable (${allowed.join(', ')})` })
  }

  const resources = input.resources || null
  if (resources && resources.atCeiling === true) {
    blockedReasons.push({
      code: BLOCK_REASONS.RESOURCE_CEILING,
      reason: `the runtime is at its evidence ceiling: ${resources.screenshots} captures held, ${resources.droppedScreenshots} already dropped, ${resources.evidenceBytes} bytes retained`
    })
  }
  const processes = input.processes || null
  if (processes && processes.atCapacity === true) {
    blockedReasons.push({ code: BLOCK_REASONS.RESOURCE_CEILING, reason: `the runtime already owns ${processes.ownedCount} processes (ceiling ${processes.ceiling})` })
  }

  if (input.safetyAvailable === false) {
    blockedReasons.push({ code: BLOCK_REASONS.SAFETY_UNAVAILABLE, reason: 'no confirmation channel is available for a destructive action' })
  }
  if (input.stateIntegrity === false) {
    blockedReasons.push({ code: BLOCK_REASONS.STATE_INTEGRITY_UNCERTAIN, reason: 'the runtime cannot vouch for its own state' })
  }

  const degradedCapabilities = Object.entries(capabilities).filter(([, entry]) => entry.degraded).map(([id]) => id)
  const status = blockedReasons.length
    ? HEALTH_STATUS.BLOCKED
    : (degradedCapabilities.length || blockedControllers.length ? HEALTH_STATUS.DEGRADED : HEALTH_STATUS.HEALTHY)

  return {
    at: now,
    status,
    capabilities,
    usableCapabilities: usable,
    degradedCapabilities,
    unavailableCapabilities: blockedControllers,
    blockedReasons,
    workspace: workspace
      ? { ok: workspace.ok !== false, cwd: workspace.cwd || null, reason: workspace.reason || null }
      : null,
    activeOwnedProcesses: processes ? processes.ownedCount : 0,
    resourcePressure: resources
      ? {
          screenshots: resources.screenshots,
          retainedScreenshots: resources.retainedScreenshots,
          droppedScreenshots: resources.droppedScreenshots,
          evidenceBytes: resources.evidenceBytes,
          ceilings: resources.limits
        }
      : null,
    lastProgressAt: input.progress ? input.progress.lastProgressAt : null,
    sinceProgressMs: input.progress ? input.progress.sinceProgressMs : null,
    lastVerifiedEffectAt: input.progress ? input.progress.lastVerifiedEffectAt : null,
    noOpStreak: input.progress ? input.progress.noOpStreak : 0,
    stallLevel: Number.isInteger(input.stallLevel) ? input.stallLevel : 0,
    currentStep: input.step || null
  }
}

/**
 * Can this runtime execute an action that needs `capability`?
 *
 * A missing capability is `CAPABILITY_UNAVAILABLE` — a reported outcome for that
 * action, never a runtime crash (24h.md Task 9).
 */
function capabilityVerdict(snapshot, capability) {
  if (!capability) return { ok: true, reason: 'the action declares no capability' }
  const capabilities = snapshot && snapshot.capabilities ? snapshot.capabilities : null
  if (!capabilities) return { ok: false, reason: 'the runtime has no health snapshot' }
  const ids = controllerIdsFor(capability)
  const known = ids.filter((id) => capabilities[id])
  // No controller claims this capability at all. That is *not* "fine": an action
  // that needs a channel nobody carries cannot run (Task 9).
  if (!known.length) return { ok: false, reason: `no controller carries the "${capability}" capability` }
  if (capabilityIsUsable(capabilities, capability)) {
    const degraded = known.every((id) => capabilities[id].degraded)
    return { ok: true, reason: degraded ? `${capability} is degraded but usable` : `${capability} is available`, controllers: known }
  }
  const reason = known.map((id) => `${id}: ${capabilities[id].reason || 'unavailable'}`).join('; ')
  return { ok: false, reason: `${capability} is unavailable (${reason})`, controllers: known }
}

module.exports = { HEALTH_STATUS, BLOCK_REASONS, CAPABILITY_CONTROLLERS, buildHealthSnapshot, capabilityVerdict, capabilityIsUsable, controllerIdsFor }
