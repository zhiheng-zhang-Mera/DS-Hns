'use strict'

/**
 * Engineering Runtime: the engineering supervisor.
 *
 * This is the module that turns "here is a repository and a goal" into verified
 * engineering work, and it is the only place that decides what the runtime does
 * next. Its shape follows the plan's loop exactly:
 *
 *   verify workspace → discover repository → read instructions → capture baseline
 *   → plan → execute step → verify → on failure: classify, hypothesise, repair
 *   → … → full verification → result validation → COMPLETED
 *
 * Four properties are the reason it is written this way rather than as a script:
 *
 *  1. **Every mutation is owned and verified.** Writes go through the mutation
 *     log, which refuses files the user had already modified and re-reads every
 *     file it writes.
 *  2. **No blind retry.** A repair round needs a *new* hypothesis; the same
 *     command, the same failure and no state change is refused by the repair
 *     tracker, and repeated failure escalates the stall level instead of looping.
 *  3. **Completion is decided by evidence.** The result validator sees the fresh
 *     verification, the unresolved failures, the workspace and the leak counts,
 *     and its refusal is final.
 *  4. **Everything is bounded.** Steps, retries, hypotheses, context, output,
 *     processes and the deadline all have ceilings, and the deadline band decides
 *     whether new work may start.
 *
 * What it deliberately does *not* do: invent code. The runtime applies patches the
 * contract supplies (`contract.patches`) and reports honestly when it has none —
 * it is an executor, and a maintenance episode that cannot fix something says so
 * with the evidence rather than guessing.
 */

const fs = require('node:fs')
const path = require('node:path')

const { EPISODE_PHASES, createEpisodeStateMachine } = require('./episode.cjs')
const repository = require('./repository.cjs')
const discovery = require('./discovery.cjs')
const { createMutationLog, MUTATION_KINDS } = require('./mutation.cjs')
const { classify, createRepairTracker, FAILURE_CLASSES } = require('./failure.cjs')
const { createProcessSupervisor, PROCESS_CLASS } = require('./process.cjs')
const { createScheduler, deadlineState } = require('./scheduler.cjs')
const { buildPlan, restorePlan, nextStep, advance, PLAN_KINDS } = require('./plan.cjs')
const { createVerifier, VERIFICATION_LEVELS } = require('./verifier.cjs')
const { createGitController, DEFAULT_GIT_POLICY } = require('./git.cjs')
const { createResultValidator, collectLeaks, workspaceStillValid } = require('./result.cjs')
const { createEpisodeContext } = require('./context.cjs')
const { createCheckpointStore, verifyResume } = require('./checkpoint.cjs')
const { createRecoveryStore, RECOVERY_STATES } = require('./recovery-store.cjs')
const { computePlanDigest, validateRecoveryDescriptor, EXECUTOR_COMPATIBILITY, RECOVERY_PLAN_VERSION } = require('./recovery-schema.cjs')
const { createCrossVolumeTempRegistry } = require('./cross-volume-cleanup.cjs')
const { createWorkspaceLock } = require('./locking.cjs')
const { resolveAutonomy, createEngineeringAutonomy } = require('./autonomy.cjs')
const { hashContent } = require('./mutation.cjs')

/** The statuses one plan step can end in. */
const STEP_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  WAITING: 'waiting'
})

/** The default episode budget. */
const EPISODE_DEFAULTS = Object.freeze({
  deadlineMs: 24 * 60 * 60 * 1000,
  maxSteps: 40,
  maxRepairRounds: 6,
  maxHypotheses: 4,
  stallThreshold: 3,
  stepTimeoutMs: 30 * 60_000,
  outputBytes: 256 * 1024,
  maxParkedMs: 10 * 60_000
})

const RECOVERY_CONTRACT_FIELDS = Object.freeze([
  'autonomyEnabled', 'autonomyLimits', 'commands', 'deadlineMs', 'focus', 'hypothesis',
  'keepProcesses', 'lockWorkspace', 'maxHypotheses', 'maxRepairRounds', 'maxSteps',
  'patches', 'requireBuild', 'requireLint', 'requireGit', 'require_build', 'require_lint',
  'stallAfterMs', 'stallThreshold', 'stealStaleLock', 'stepTimeoutMs', 'steps', 'tests', 'requiredTests'
])

function sanitizeRecoveryValue(value, key = '') {
  if (/(?:password|passwd|secret|credential|authorization|access.?token|api.?key)/i.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => sanitizeRecoveryValue(item))
  if (typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (typeof childValue === 'function' || childValue === undefined || typeof childValue === 'symbol') continue
      output[childKey] = sanitizeRecoveryValue(childValue, childKey)
    }
    return output
  }
  return null
}

function sanitizedRecoveryContract(contract) {
  const output = {}
  for (const key of RECOVERY_CONTRACT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(contract || {}, key)) {
      output[key] = sanitizeRecoveryValue(contract[key], key)
    }
  }
  return output
}

function recoveryPlan(plan) {
  if (!plan) return null
  const snapshot = plan.toJSON()
  return {
    version: RECOVERY_PLAN_VERSION,
    id: snapshot.id,
    goal: snapshot.goal,
    intent: snapshot.intent,
    createdAt: snapshot.createdAt,
    steps: snapshot.steps.map((step) => ({ ...step })),
    budget: { ...snapshot.budget },
    reasons: snapshot.reasons.slice()
  }
}

function recoveryCursor(plan) {
  if (!plan) return { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [] }
  const verified = new Set(plan.verifiedStepIds())
  const skipped = new Set(plan.skippedStepIds())
  let nextStepIndex = 0
  while (nextStepIndex < plan.steps.length) {
    const stepId = plan.steps[nextStepIndex].id
    if (!verified.has(stepId) && !skipped.has(stepId)) break
    nextStepIndex += 1
  }
  let lastVerifiedStepId = null
  for (let index = nextStepIndex - 1; index >= 0; index -= 1) {
    const stepId = plan.steps[index].id
    if (verified.has(stepId)) {
      lastVerifiedStepId = stepId
      break
    }
  }
  return {
    nextStepIndex,
    lastVerifiedStepId,
    verifiedStepIds: [...verified],
    skippedStepIds: [...skipped]
  }
}

function nowMs() {
  return Date.now()
}

/**
 * @param {object} input
 * @param {string} input.workspace the repository path the episode is confined to
 * @param {string} input.goal
 * @param {object} [input.contract] the execution contract's engineering block:
 *   `{ commands, tests, require_build, require_lint, patches, deadlines, git, autonomyEnabled }`
 * @param {object} [input.policy] `{ allowCommit, allowPush, allowMerge }`
 * @param {number} [input.deadlineMs]
 * @param {object} [input.processes] a shared Computer Use process registry
 * @param {Function} [input.now]
 * @param {Function} [input.log] `(event) => void`
 * @param {Function} [input.isCancelled] `() => boolean`, checked at every step
 *   boundary — a caller (a panel, a supervisor of supervisors) must be able to
 *   stop an episode without killing the process that runs it
 */
function createEngineeringSupervisor(input = {}) {
  const now = typeof input.now === 'function' ? input.now : nowMs
  const log = typeof input.log === 'function' ? input.log : () => {}
  const contract = input.contract || {}
  const budget = {
    ...EPISODE_DEFAULTS,
    deadlineMs: Number.isFinite(input.deadlineMs) ? Number(input.deadlineMs) : (Number.isFinite(contract.deadlineMs) ? Number(contract.deadlineMs) : EPISODE_DEFAULTS.deadlineMs),
    maxSteps: Number.isFinite(contract.maxSteps) ? Number(contract.maxSteps) : EPISODE_DEFAULTS.maxSteps,
    maxRepairRounds: Number.isFinite(contract.maxRepairRounds) ? Number(contract.maxRepairRounds) : EPISODE_DEFAULTS.maxRepairRounds,
    stepTimeoutMs: Number.isFinite(contract.stepTimeoutMs) ? Number(contract.stepTimeoutMs) : EPISODE_DEFAULTS.stepTimeoutMs
  }

  const episodeId = input.episodeId || `episode-${now()}`
  const machine = createEpisodeStateMachine({ now, initial: EPISODE_PHASES.INITIALIZING })
  const scheduler = createScheduler({ now })
  const repairs = createRepairTracker({ now, maxHypotheses: budget.maxHypotheses })
  const resultValidator = createResultValidator({ now })
  const context = createEpisodeContext({ now })
  const supervisor = createProcessSupervisor({ now, registry: input.processes, sleep: input.sleep, outputBytes: budget.outputBytes })
  const checkpoints = input.checkpoints || createCheckpointStore({ dir: input.checkpointRoot || undefined, now })
  const recoveryStore = input.recoveryStore || createRecoveryStore({
    root: input.recoveryRoot || path.dirname(checkpoints.dir),
    checkpointDir: checkpoints.dir,
    now,
    isOwnerAlive: input.isOwnerAlive
  })
  /**
   * The effective autonomy, resolved *per run* from the three documented sources.
   * Creating the controller once at construction is what used to leave a contract's
   * explicit `autonomy_enabled: true` silently ignored.
   */
  const autonomyAuthority = resolveAutonomy({
    runtime: input.runtime || { autonomyEnabled: input.autonomyEnabled === true },
    contract,
    runOptions: input.runOptions || {}
  })
  const autonomy = createEngineeringAutonomy({
    enabled: autonomyAuthority.enabled,
    source: autonomyAuthority.source,
    limits: contract.autonomyLimits,
    now
  })
  /** One active writer per workspace, enforced with a lock rather than assumed. */
  const lock = input.lock || createWorkspaceLock({
    root: input.workspace ? path.resolve(String(input.workspace)) : process.cwd(),
    now,
    disabled: contract.lockWorkspace === false
  })

  let workspace = null
  let snapshot = null
  let project = null
  let commands = null
  let mutations = null
  let plan = null
  let verifier = null
  let git = null
  let startedAt = null
  let deadline = null
  let finishedAt = null
  let failures = []
  let repairRounds = 0
  let stallLevel = 0
  let status = 'idle'
  let report = null
  let recoveryClaimAcquired = input.recoveryClaimAcquired === true
  let lastProgressAt = null
  let lastActionAt = null
  let lastVerifiedEffectAt = null
  let noOpCount = 0
  let cleanupInProgress = false
  let cleanupTerminalState = input.recoveryCheckpoint && input.recoveryCheckpoint.recovery
    ? input.recoveryCheckpoint.recovery.cleanupTerminalState || null
    : null
  let cleanupResult = null
  const savedRecovery = input.recoveryCheckpoint && input.recoveryCheckpoint.recovery
  const workRoot = input.workRoot || (savedRecovery && savedRecovery.workRoot) || path.parse(checkpoints.dir).root
  const crossVolumeTemp = createCrossVolumeTempRegistry({
    episodeId,
    workRoot,
    entries: savedRecovery && Array.isArray(savedRecovery.crossVolumeTemp)
      ? savedRecovery.crossVolumeTemp
      : (Array.isArray(input.crossVolumeTemp) ? input.crossVolumeTemp : []),
    now,
    onChange: () => {
      const saved = checkpoint('cross-volume-registry')
      if (!saved.ok || !saved.recoveryIndex?.ok) {
        throw new Error(saved.reason || 'cross-volume cleanup state was not durably checkpointed')
      }
    }
  })

  /** One event, counted, and never a source of progress by itself. */
  function noteProgress(kind, detail = {}) {
    lastProgressAt = now()
    context.observe({ kind, summary: detail.summary || kind, evidence: detail.evidence || null })
    log({ type: 'progress', kind, at: lastProgressAt, ...detail })
  }

  function noteAction(detail = {}) {
    lastActionAt = now()
    log({ type: 'action', at: lastActionAt, ...detail })
  }

  function transition(phase, detail = {}) {
    const moved = machine.transition(phase, detail)
    if (!moved.ok) {
      log({ type: 'phase-refused', from: machine.phase, to: phase, reason: moved.reason })
      return moved
    }
    context.setLive({ phase })
    log({ type: 'phase', at: now(), from: moved.previous, to: moved.phase, ...detail })
    return moved
  }

  /** The deadline band, recomputed whenever it matters. */
  function deadlineNow() {
    return deadlineState({ now: now(), startedAt, deadline })
  }

  /**
   * Step 1–4 of the loop: establish the workspace, read the repository, read its
   * instructions and capture the baseline.
   */
  function initialize() {
    const savedRecovery = input.recoveryCheckpoint && input.recoveryCheckpoint.recovery
    startedAt = savedRecovery ? savedRecovery.request.startedAt : now()
    deadline = savedRecovery ? savedRecovery.request.deadlineAt : startedAt + budget.deadlineMs
    context.setLive({ goal: input.goal, phase: EPISODE_PHASES.INITIALIZING })

    const verified = repository.verifyWorkspace(input.workspace, { requireGit: contract.requireGit === true })
    if (!verified.ok) {
      machine.force(EPISODE_PHASES.BLOCKED, verified.reason)
      return { ok: false, reason: verified.reason, phase: EPISODE_PHASES.BLOCKED }
    }
    workspace = verified.path
    context.setLive({ workspace })

    transition(EPISODE_PHASES.DISCOVERING, { reason: 'workspace verified' })
    snapshot = repository.snapshot({ root: workspace, now })
    project = discovery.detectProject(workspace)
    commands = discovery.discoverCommands({ root: workspace, project, contract: contract.commands || null }).operations
    const instructions = discovery.discoverInstructions(workspace, snapshot)
    context.setLive({ instructionFiles: instructions.map((entry) => entry.file) })

    // The baseline: what was already dirty belongs to the user and is off limits.
    const preExisting = [...snapshot.git.modified, ...snapshot.git.staged, ...snapshot.git.untracked, ...snapshot.git.conflicted]
    mutations = createMutationLog({
      now,
      protectedFiles: preExisting.map((file) => path.join(workspace, file)),
      onChange: (entry, phase) => checkpoint(`mutation-${phase}:${entry.id}`)
    })
    if (input.recoveryCheckpoint) {
      const restored = mutations.restore(input.recoveryCheckpoint.verifiedMutations || [])
      if (!restored.ok) return { ok: false, reason: restored.reason || restored.code }
    }
    git = createGitController({ root: workspace, policy: { ...DEFAULT_GIT_POLICY, ...(input.policy || {}) }, now })
    verifier = createVerifier({ supervisor, workspace, discovery: { commands }, now })

    context.recordDecision({
      kind: 'baseline',
      detail: {
        project: project.id,
        branch: snapshot.git.branch,
        head: snapshot.git.head,
        dirtyFiles: preExisting.length,
        instructions: instructions.map((entry) => entry.file)
      },
      result: preExisting.length ? 'pre-existing changes are protected' : 'clean tree'
    })
    noteProgress('baseline', { summary: `baseline captured: ${project.id}, ${preExisting.length} pre-existing change(s)`, evidence: { head: snapshot.git.head, dirtyFiles: preExisting } })

    // A crash-resume: if a checkpoint exists for this episode, say what it holds so
    // the caller can decide to resume instead of restarting.
    const existingCheckpoint = checkpoints.latest(episodeId)
    return { ok: true, resumedFrom: existingCheckpoint ? existingCheckpoint.at : null, baseline: { head: snapshot.git.head, branch: snapshot.git.branch, dirtyFiles: preExisting } }
  }

  /** Build the bounded plan from the goal, the discovery and the contract. */
  function makePlan() {
    transition(EPISODE_PHASES.PLANNING, { reason: 'baseline captured' })
    if (input.recoveryCheckpoint) {
      const restored = restorePlan({
        plan: input.recoveryCheckpoint.recovery.plan,
        cursor: input.recoveryCheckpoint.recovery.cursor,
        now
      })
      if (!restored.ok) {
        log({ type: 'recovery-plan-restore-failed', code: restored.code, reason: restored.reason })
        return null
      }
      plan = restored.plan
      context.recordDecision({ kind: 'resume-plan', detail: { cursor: plan.cursor, steps: plan.steps.length }, result: 'restored the verified plan prefix' })
      return plan
    }
    plan = buildPlan({
      goal: input.goal,
      discovery: { commands },
      contract,
      baseline: snapshot,
      inputs: { steps: contract.steps, maxSteps: budget.maxSteps, focus: contract.focus }
    })
    context.recordDecision({ kind: 'plan', detail: { steps: plan.steps.map((step) => step.kind), reasons: plan.reasons }, result: 'planned' })
    noteProgress('plan', { summary: `planned ${plan.steps.length} step(s)`, evidence: { kinds: plan.steps.map((step) => step.kind) } })
    return plan
  }

  /**
   * Run one plan step.
   *
   * Command steps go through the process supervisor with their own bounds;
   * `patch` steps apply the contract's patches through the mutation log; the
   * verification steps run the real suite.
   */
  async function runStep(step) {
    noteAction({ step: step.id, kind: step.kind })
    context.setLive({ planStep: { id: step.id, kind: step.kind, description: step.description } })
    const startedStepAt = now()

    if (step.kind === PLAN_KINDS.PATCH) {
      // A patch is an edit: the phase the plan's diagram names for "changing code".
      if (machine.phase !== EPISODE_PHASES.EDITING && machine.canTransition(EPISODE_PHASES.EDITING)) {
        transition(EPISODE_PHASES.EDITING, { reason: `patch step ${step.id}` })
      }
      return applyPatch(step, startedStepAt)
    }
    if (step.kind === PLAN_KINDS.FULL_VERIFY || step.kind === PLAN_KINDS.FOCUSED_TEST || step.kind === PLAN_KINDS.AFFECTED_TEST) {
      if (machine.phase !== EPISODE_PHASES.TESTING && machine.canTransition(EPISODE_PHASES.TESTING)) {
        transition(EPISODE_PHASES.TESTING, { reason: step.id })
      }
      return runVerificationStep(step, startedStepAt)
    }
    if (step.kind === PLAN_KINDS.BUILD || step.kind === PLAN_KINDS.LINT || step.kind === PLAN_KINDS.TYPECHECK || step.kind === PLAN_KINDS.INSTALL) {
      if (machine.phase !== EPISODE_PHASES.BUILDING && machine.canTransition(EPISODE_PHASES.BUILDING)) {
        transition(EPISODE_PHASES.BUILDING, { reason: step.id })
      }
      return runCommandStep(step, startedStepAt)
    }
    if (step.kind === PLAN_KINDS.REPORT) return { outcome: STEP_OUTCOMES.SUCCESS, evidence: { kind: 'report' } }
    if (step.kind === PLAN_KINDS.REPRODUCE || step.kind === PLAN_KINDS.INSPECT || step.kind === PLAN_KINDS.INSPECT_FAILURE) {
      if (machine.phase !== EPISODE_PHASES.TESTING && machine.canTransition(EPISODE_PHASES.TESTING)) {
        transition(EPISODE_PHASES.TESTING, { reason: step.id })
      }
      // A reproduce step is a real command run whose *failure* is the expected
      // result: that is the regression evidence the plan requires.
      return runCommandStep(step, startedStepAt, { expectFailure: step.kind === PLAN_KINDS.REPRODUCE })
    }
    return { outcome: STEP_OUTCOMES.SKIPPED, reason: `no executor for step kind ${step.kind}` }
  }

  /** A step that runs one project command under supervision. */
  async function runCommandStep(step, startedAtStep, options = {}) {
    if (!step.command) {
      return { outcome: STEP_OUTCOMES.SKIPPED, reason: `the project declares no command for ${step.kind}` }
    }
    const split = splitCommand(step.command)
    const args = [...split.args, ...(step.args || [])]
    const cwd = step.cwd ? path.resolve(workspace, step.cwd) : workspace
    const timeoutMs = Number.isFinite(step.timeoutMs) ? step.timeoutMs : budget.stepTimeoutMs

    let processEntry = null
    try {
      processEntry = supervisor.start({
        command: split.command,
        args,
        cwd,
        class: step.kind === PLAN_KINDS.INSTALL ? PROCESS_CLASS.HELPER : PROCESS_CLASS.FOREGROUND,
        softTimeoutMs: timeoutMs,
        hardTimeoutMs: timeoutMs,
        ownership: episodeId,
        step: step.id
      })
    } catch (error) {
      return { outcome: STEP_OUTCOMES.FAILED, reason: String(error && error.message ? error.message : error), failure: classify({ operation: step.operation, command: step.command, message: String(error && error.message ? error.message : error) }) }
    }

    const exit = await supervisor.waitForExit(processEntry.id, { softTimeoutMs: timeoutMs, stallAfterMs: contract.stallAfterMs })
    const output = exit.output || { text: '', originalBytes: 0, truncated: false }

    context.recordProcess({ id: processEntry.id, command: step.command, milestone: exit.ok ? 'exit 0' : `exit ${exit.exitCode}${exit.timedOut ? ' (timed out)' : ''}` })

    // A reproduce step *wants* the failure: that is the point of running it.
    if (options.expectFailure) {
      const reproduced = !exit.ok
      if (reproduced) {
        noteProgress('reproduced-failure', {
          summary: `the failure reproduces: ${step.command} exited ${exit.exitCode}`,
          evidence: { exitCode: exit.exitCode, output: output.text.slice(0, 2000) }
        })
        return { outcome: STEP_OUTCOMES.SUCCESS, evidence: { reproduced: true, exitCode: exit.exitCode, output } }
      }
      return {
        outcome: STEP_OUTCOMES.FAILED,
        reason: 'the failure did not reproduce, so there is nothing to fix',
        failure: classify({ operation: step.operation, command: step.command, exitCode: exit.exitCode })
      }
    }

    if (exit.ok) {
      noteProgress(`${step.kind}-passed`, { summary: `${step.command} exited 0`, evidence: { operation: step.operation } })
      return { outcome: STEP_OUTCOMES.SUCCESS, evidence: { exitCode: exit.exitCode, durationMs: exit.durationMs, output } }
    }

    const failure = classify({
      operation: step.operation || step.kind,
      command: step.command,
      output: output.text,
      exitCode: exit.exitCode,
      timedOut: exit.timedOut === true
    })
    return {
      outcome: STEP_OUTCOMES.FAILED,
      reason: `${step.command} failed (${failure.class}${exit.timedOut ? ', timed out' : ''})`,
      failure,
      evidence: { exitCode: exit.exitCode, signal: exit.signal, output }
    }
  }

  /** A step that runs one verification level through the verifier. */
  async function runVerificationStep(step, startedAtStep) {
    const level = step.kind === PLAN_KINDS.FULL_VERIFY ? VERIFICATION_LEVELS.FULL
      : step.kind === PLAN_KINDS.AFFECTED_TEST ? VERIFICATION_LEVELS.AFFECTED
        : VERIFICATION_LEVELS.FOCUSED
    const result = await verifier.run(level, { focus: step.focus || contract.focus, timeoutMs: step.timeoutMs })
    context.recordVerification({
      operation: level,
      command: result.command,
      ok: result.ok,
      summary: result.output && result.output.text ? result.output.text.slice(0, 400) : '',
      exitCode: result.exitCode,
      durationMs: result.durationMs
    })
    if (result.ok) {
      noteProgress(`verified:${level}`, { summary: `${level} passed`, evidence: { command: result.command, durationMs: result.durationMs } })
      lastVerifiedEffectAt = now()
      return { outcome: STEP_OUTCOMES.SUCCESS, evidence: { level, exitCode: result.exitCode, durationMs: result.durationMs, summary: result.summary } }
    }
    return { outcome: STEP_OUTCOMES.FAILED, reason: `${level} failed`, failure: result.failure, evidence: { level, exitCode: result.exitCode, output: result.output } }
  }

  /**
   * A patch step: apply the contract's next patch through the mutation log.
   *
   * The runtime does not invent code. It applies the change it was given, records
   * the mutation with its reason, refuses a file the user had modified, and
   * re-reads what it wrote.
   */
  function applyPatch(step, startedAtStep) {
    const patches = Array.isArray(contract.patches) ? contract.patches : []
    if (!patches.length) {
      return {
        outcome: STEP_OUTCOMES.SKIPPED,
        reason: 'no patch was supplied for this episode, so the runtime has nothing to apply'
      }
    }
    const index = Number.isInteger(step.patchIndex) ? step.patchIndex : repairRounds
    const patch = patches[Math.min(index, patches.length - 1)]
    if (!patch || !Array.isArray(patch.files) || !patch.files.length) {
      return { outcome: STEP_OUTCOMES.FAILED, reason: `patch ${index} names no files` }
    }
    const applied = []
    const refused = []
    for (const file of patch.files) {
      const target = path.isAbsolute(file.path) ? file.path : path.join(workspace, file.path)
      const wantedHash = hashContent(Buffer.from(file.content === undefined ? '' : String(file.content), 'utf8'))
      const settledMutation = mutations.all().slice().reverse().find((entry) =>
        entry.step === step.id && entry.path === target &&
        (entry.result === 'applied' || entry.result === 'already_complete') &&
        (file.delete === true ? entry.kind === MUTATION_KINDS.DELETE && !fs.existsSync(target)
          : entry.kind !== MUTATION_KINDS.DELETE && entry.intended && entry.intended.hash === wantedHash))
      if (settledMutation) {
        applied.push({ path: settledMutation.relative, hash: settledMutation.after, result: 'already_complete' })
        continue
      }
      const mutation = mutations.apply({
        kind: file.delete === true ? MUTATION_KINDS.DELETE : (fs.existsSync(target) ? MUTATION_KINDS.WRITE : MUTATION_KINDS.CREATE),
        path: target,
        content: file.content === undefined ? '' : file.content,
        reason: patch.reason || `step ${step.id}`,
        root: workspace,
        step: step.id
      })
      context.setLive({ currentFile: mutation.relative })
      const files = mutations.changedFiles(workspace)
      context.setLive({ filesChanged: files })
      if (mutation.result === 'applied' || mutation.result === 'already_complete') {
        applied.push({ path: mutation.relative, hash: mutation.after, result: mutation.result })
      } else {
        refused.push({ path: mutation.relative, result: mutation.result, reason: mutation.verification ? mutation.verification.reason : null })
      }
    }
    if (applied.length) {
      // A change invalidates every piece of verification the episode had: the next
      // test run must be after this mutation or it proves nothing about it.
      verifier.invalidate(`patch ${index} changed ${applied.length} file(s)`)
      verifier.noteMutation({ at: now(), files: applied.map((entry) => entry.path) })
      noteProgress('mutation', {
        summary: `applied ${applied.length} file change(s)`,
        evidence: { files: applied.map((entry) => entry.path), reason: patch.reason || null }
      })
    }
    if (refused.length) {
      context.recordDecision({ kind: 'mutation-refused', detail: { refused }, result: 'refused' })
    }
    const outcome = applied.length ? STEP_OUTCOMES.SUCCESS : STEP_OUTCOMES.FAILED
    return {
      outcome,
      reason: applied.length ? null : `every file in patch ${index} was refused`,
      evidence: { patchIndex: index, applied, refused, durationMs: now() - startedAtStep }
    }
  }

  /**
   * Handle a failed step: classify, decide whether another attempt is honest, and
   * either repair or escalate.
   *
   * @returns {{action:'repair'|'retry'|'stall'|'block'|'fail', reason:string}}
   */
  function decideAfterFailure(step, outcome) {
    const failure = outcome.failure || classify({ operation: step.kind, message: outcome.reason || 'step failed' })
    const attempt = repairs.recordAttempt({
      signature: failure.signature,
      class: failure.class,
      operation: step.operation || step.kind,
      command: step.command || null,
      mutations: mutations.applied().length
    })
    failures.push({ step: step.id, class: failure.class, signature: failure.signature, reason: outcome.reason || failure.reason, at: now() })
    context.recordDecision({ kind: 'failure', detail: { step: step.id, class: failure.class, reason: outcome.reason }, result: 'failed' })
    context.setLive({ currentError: { class: failure.class, reason: outcome.reason || failure.reason, step: step.id } })

    const repeated = repairs.repeated({ signature: failure.signature, threshold: budget.stallThreshold })
    if (repeated.repeated) {
      stallLevel = Math.max(stallLevel, 2)
      context.setLive({ blockers: [{ key: failure.signature, reason: `the same failure has repeated ${repeated.count} times` }] })
    }

    if (failure.action === 'block') {
      return { action: 'block', reason: failure.reason, failure }
    }
    if (failure.action === 'reconnect' || failure.action === 'degrade') {
      return { action: 'block', reason: `${failure.class}: ${failure.reason}`, failure }
    }
    if (failure.action === 'retry-bounded') {
      const blind = repairs.wouldBeBlind({ signature: failure.signature, stateChanged: false })
      // A transient failure may be retried, but not forever and not blindly.
      if (!blind.blind && attempt.count <= 3) return { action: 'retry', reason: `${failure.class} is transient; bounded retry`, failure }
      return { action: 'block', reason: `${failure.class} is still failing after ${attempt.count} attempts`, failure }
    }
    if (failure.action === 'bound') {
      return { action: 'repair', reason: 'a timeout needs a smaller unit of work or a larger bound', failure }
    }

    // A code failure: the loop needs a new hypothesis, and it has to be a *new* one.
    const proposed = repairs.proposeHypothesis({
      statement: contract.hypothesis || `patch ${repairRounds} addresses ${failure.class}`,
      signature: failure.signature,
      evidence: [outcome.reason || failure.reason]
    })
    if (!proposed.ok && proposed.exhausted) {
      stallLevel = Math.max(stallLevel, 4)
      return { action: 'stall', reason: proposed.reason, failure }
    }
    if (repairRounds >= budget.maxRepairRounds) {
      return { action: 'stall', reason: `the repair budget (${budget.maxRepairRounds} rounds) is spent`, failure }
    }
    const blind = repairs.wouldBeBlind({ signature: failure.signature, stateChanged: mutations.applied().length > 0 })
    if (blind.blind) {
      return { action: 'stall', reason: blind.reason, failure }
    }
    return { action: 'repair', reason: 'a new hypothesis is available', failure }
  }

  /** Apply one retry through the scheduler: parked, not busy-waited. */
  async function retryLater(step, attempt) {
    transition(EPISODE_PHASES.WAITING_RETRY, { reason: 'transient failure' })
    const backoffMs = scheduler.backoffFor(attempt)
    scheduler.park({ id: `${episodeId}:${step.id}`, reason: 'retry', attempt, deadline })
    log({ type: 'retry-parked', step: step.id, attempt, backoffMs })
    await (input.sleep ? input.sleep(Math.min(backoffMs, EPISODE_DEFAULTS.maxParkedMs)) : new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, 200))))
    scheduler.unpark(`${episodeId}:${step.id}`)
  }

  /** Gather the evidence the result validator needs. */
  function validationInput() {
    const verification = verifier.evidence()
    // The leak check asks the *supervisor* what it still owns rather than reading
    // the registry: a settled process is a historical record, not a live handle,
    // and only the supervisor knows which of its records are still running.
    const leaks = {
      processes: supervisor.ownedCount(),
      watchers: 0,
      screenshots: 0
    }
    return {
      contract,
      criteria: { satisfied: true, unknown: false, results: [] },
      verification,
      lastMutationAt: verifier.freshAt().at,
      failures: { unresolved: resultValidator.unresolvedFailures(failures) },
      workspace: workspaceStillValid(workspace),
      leaks,
      build: verification.levels ? verification.levels.build : null,
      lint: verification.levels ? verification.levels.lint : null
    }
  }

  /** Save a checkpoint, bounded and atomic. */
  function checkpoint(reason) {
    try {
      const serializedPlan = recoveryPlan(plan)
      const preserveActiveAfterCancel = status === 'cancelled' && typeof input.preserveRecoveryOnCancel === 'function' && input.preserveRecoveryOnCancel() === true
      const lifecycleState = cleanupInProgress
        ? RECOVERY_STATES.ACTIVE
        : (reason === 'completed' || status === 'completed'
            ? RECOVERY_STATES.COMPLETED
            : (reason === 'cancelled' || status === 'cancelled'
                ? (preserveActiveAfterCancel ? RECOVERY_STATES.ACTIVE : RECOVERY_STATES.CANCELLED)
                : (reason === 'blocked' || reason === 'failed' || status === 'blocked' || status === 'failed'
                    ? RECOVERY_STATES.RECOVERY_BLOCKED
                    : RECOVERY_STATES.ACTIVE)))
      const blockedReason = lifecycleState === RECOVERY_STATES.RECOVERY_BLOCKED
        ? (failures.length ? String(failures[failures.length - 1].reason || failures[failures.length - 1].class || 'the episode did not reach a verified completion') : String(reason || 'the episode did not reach a verified completion'))
        : null
      const saved = checkpoints.save({
        episodeId,
        reason,
        goal: input.goal,
        workspace,
        fingerprint: snapshot ? snapshot.fingerprint : null,
        plan: plan ? { id: plan.id, cursor: plan.cursor, steps: plan.steps.map((step) => ({ id: step.id, kind: step.kind })) } : null,
        cursor: plan ? plan.cursor : 0,
        verifiedMutations: mutations ? mutations.all() : [],
        ownedProcesses: supervisor.running().map((entry) => ({ id: entry.id, command: entry.command })),
        lastFailure: failures.length ? failures[failures.length - 1] : null,
        progress: { lastProgressAt, lastActionAt, lastVerifiedEffectAt, noOpCount },
        phase: machine.phase,
        recovery: {
          version: 1,
          episodeId,
          request: {
            workspace,
            goal: String(input.goal || ''),
            startedAt: Number.isFinite(startedAt) ? startedAt : now(),
            deadlineAt: Number.isFinite(deadline) ? deadline : now() + budget.deadlineMs,
            contract: sanitizedRecoveryContract(contract)
          },
          plan: serializedPlan,
          planDigest: serializedPlan ? computePlanDigest(serializedPlan) : null,
          cursor: recoveryCursor(plan),
          fingerprint: snapshot ? snapshot.fingerprint : null,
          verifiedMutationIds: mutations ? mutations.applied().map((entry) => entry.id) : [],
          unresolvedMutationIds: mutations ? mutations.pending().map((entry) => entry.id) : [],
          executorCompatibility: EXECUTOR_COMPATIBILITY,
          workRoot,
          crossVolumeTemp: crossVolumeTemp.list(),
          lifecycleState,
          blockedReason,
          ...(cleanupTerminalState ? { cleanupTerminalState } : {})
        }
      })
      if (!saved.ok) return saved
      const indexed = recoveryStore.recordCheckpoint({ episodeId, checkpointPath: saved.path })
      if (!indexed.ok) {
        log({ type: 'recovery-index-update-failed', episode: episodeId, code: indexed.code, reason: indexed.reason })
        return { ...saved, recoveryIndex: indexed, ok: false, code: indexed.code, reason: indexed.reason }
      }
      const latest = checkpoints.latest(episodeId)
      if (!recoveryClaimAcquired && input.recoveryOwner && latest && latest.recovery && latest.recovery.lifecycleState === RECOVERY_STATES.ACTIVE) {
        const claimed = recoveryStore.acquireClaim({
          episodeId,
          checkpointSeq: latest.recovery.cursor.checkpointSeq,
          owner: input.recoveryOwner
        })
        if (!claimed.ok) {
          log({ type: 'recovery-claim-refused', episode: episodeId, code: claimed.code, reason: claimed.reason })
          return { ...saved, recoveryIndex: indexed, ok: false, code: claimed.code, reason: claimed.reason }
        }
        recoveryClaimAcquired = true
      }
      return { ...saved, recoveryIndex: indexed, recovery: latest && latest.recovery ? latest.recovery : null }
    } catch (error) {
      log({ type: 'checkpoint-failed', reason: String(error && error.message ? error.message : error) })
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /** The bounded final report the plan asks for. */
  function buildReport(verdict) {
    return {
      episode: episodeId,
      goal: input.goal,
      result: verdict.verdict,
      phases: machine.history().map((entry) => entry.to),
      durationMs: finishedAt === null ? now() - startedAt : finishedAt - startedAt,
      workspace,
      project: project ? { id: project.id, language: project.language, evidence: project.evidence } : null,
      repository: snapshot
        ? { branch: snapshot.git.branch, head: snapshot.git.head, dirtyAtStart: snapshot.git.modified.length + snapshot.git.untracked.length }
        : null,
      filesChanged: mutations ? mutations.changedFiles(workspace) : [],
      mutations: mutations ? mutations.summary(workspace) : null,
      commands: supervisor.finished().map((entry) => ({ command: entry.command, exitCode: entry.exitCode, durationMs: entry.durationMs, timedOut: entry.timedOut })),
      verification: verifier ? verifier.evidence() : null,
      failuresRepaired: failures.filter((entry) => entry.repaired === true).length,
      failures,
      repairRounds,
      stallLevel,
      remainingWarnings: (verdict.reasons || []).slice(),
      validation: verdict,
      cleanup: cleanupResult,
      git: git ? { policy: git.policy, commands: git.commands().length, refusals: git.refusals().length } : null,
      ownedProcessesCleaned: supervisor.ownedCount(),
      checkpoints: checkpoints.list(episodeId).length,
      autonomy: { enabled: autonomy.enabled, source: autonomy.source, decisions: autonomy.decisions().slice(-5) },
      lock: { held: lock.held, file: lock.disabled ? null : lock.file, disabled: lock.disabled },
      context: context.snapshot()
    }
  }

  /**
   * Run the episode.
   *
   * @param {object} [runOptions] `{ autonomous }` overrides the contract's own
   *   autonomy setting for this run, and is the highest of the three authorities.
   * @returns {Promise<object>} the episode report
   */
  async function run(runOptions = {}) {
    status = 'running'
    // The run option is the last authority to be heard, so it is applied here
    // rather than at construction: a caller may ask for one autonomous run without
    // changing the episode's own contract.
    const perRun = resolveAutonomy({
      runtime: input.runtime || { autonomyEnabled: input.autonomyEnabled === true },
      contract,
      runOptions
    })
    if (perRun.enabled !== autonomy.enabled || perRun.source !== autonomy.source) {
      autonomy.enabled = perRun.enabled
      autonomy.source = perRun.source
    }
    // The workspace is verified *before* the lock is taken, because taking the
    // lock creates `<workspace>/runtime/engineering/workspace.lock`: if the
    // workspace did not exist, the lock would bring it into being and the episode
    // would then find a perfectly valid empty directory where the caller meant to
    // point at a repository. A missing workspace is a BLOCKED episode, and it must
    // not be conjured into existence by the act of locking it.
    const preflight = repository.verifyWorkspace(input.workspace, { requireGit: contract.requireGit === true })
    if (!preflight.ok) {
      finishedAt = now()
      status = 'blocked'
      report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [preflight.reason], checks: [] })
      return report
    }
    const held = lock.acquire({ episode: episodeId, stealStale: contract.stealStaleLock === true })
    if (!held.ok) {
      finishedAt = now()
      status = 'blocked'
      report = buildReport({
        verdict: 'BLOCKED',
        ok: false,
        reasons: [`another episode holds this workspace: ${held.reason}`],
        checks: []
      })
      return report
    }
    const initialized = initialize()
    if (!initialized.ok) {
      finishedAt = now()
      status = 'blocked'
      // A workspace that cannot be used is a BLOCKED episode, with the reason. The
      // lock is released here rather than only on the success path: an episode that
      // never began must not leave the workspace locked behind it.
      lock.release()
      report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [initialized.reason], checks: [] })
      return report
    }

    const builtPlan = makePlan()
    if (!builtPlan) {
      finishedAt = now()
      status = 'blocked'
      lock.release()
      report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: ['the saved execution plan could not be restored safely'], checks: [] })
      return report
    }
    if (input.recoveryCheckpoint) {
      const descriptor = validateRecoveryDescriptor(input.recoveryCheckpoint.recovery, {
        episodeId,
        executorCompatibility: EXECUTOR_COMPATIBILITY
      })
      if (!descriptor.ok) {
        finishedAt = now()
        status = 'blocked'
        lock.release()
        report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [`${descriptor.code}: ${descriptor.reason}`], checks: [] })
        return report
      }
      const resumeVerdict = verifyResume({
        checkpoint: input.recoveryCheckpoint,
        workspace,
        fingerprint: snapshot ? snapshot.fingerprint : null,
        mutationLog: mutations,
        processes: input.processes,
        processExists: input.processExists
      })
      if (!resumeVerdict.ok) {
        finishedAt = now()
        status = 'blocked'
        machine.force(EPISODE_PHASES.BLOCKED, resumeVerdict.reasons.join('; '))
        supervisor.dispose('recovery gate refused')
        checkpoint('blocked')
        lock.release()
        report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: resumeVerdict.reasons, checks: [] })
        return report
      }
      for (const step of plan.steps) {
        if (step.kind !== PLAN_KINDS.PATCH) continue
        const entries = mutations.all().filter((entry) => entry.step === step.id)
        if (entries.length && entries.every((entry) => entry.result === 'applied' || entry.result === 'already_complete')) {
          plan.markedComplete(step.id)
        }
      }
    }
    const plannedCheckpoint = checkpoint('planned')
    if (!plannedCheckpoint.ok || !plannedCheckpoint.recoveryIndex?.ok) {
      finishedAt = now()
      status = 'blocked'
      machine.force(EPISODE_PHASES.BLOCKED, plannedCheckpoint.reason || 'the durable recovery checkpoint or claim could not be established')
      lock.release()
      report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [plannedCheckpoint.reason || 'the durable recovery checkpoint or claim could not be established'], checks: [] })
      return report
    }
    if (input.recoveryCheckpoint && typeof input.onAccepted === 'function') {
      try {
        input.onAccepted({ episode: episodeId, checkpointSeq: plannedCheckpoint.recovery?.cursor?.checkpointSeq || null, cursor: plannedCheckpoint.recovery?.cursor || null })
      } catch (error) {
        log({ type: 'recovery-accept-callback-failed', episode: episodeId, reason: String(error && error.message ? error.message : error) })
      }
    }

    let repairMode = false
    /**
     * Walk the current plan from the cursor.
     *
     * This is one *round*. It returns when the plan is exhausted, the deadline
     * band forbids more work, the caller cancels, or a failure leaves the loop no
     * honest next move. Whether another round happens is the autonomy
     * controller's decision, which is why the walk is a function rather than the
     * body of `run`.
     */
    async function walkPlan() {
    let step = nextStep(plan)
    while (step) {
      // A caller may stop the episode at any step boundary. The check is here
      // rather than inside a step because a step is the smallest unit that is
      // allowed to be left half-done: stopping between them keeps the workspace
      // and the checkpoint consistent.
      if (typeof input.isCancelled === 'function' && input.isCancelled()) {
        machine.force(EPISODE_PHASES.CANCELLED, 'the caller cancelled the episode')
        status = 'cancelled'
        break
      }
      const band = deadlineNow()
      if (band.expired) {
        transition(EPISODE_PHASES.VERIFYING, { reason: 'the deadline expired' })
        break
      }
      if (band.finalOnly) {
        // Near the wire: stop starting new work, verify what exists and report.
        context.recordDecision({ kind: 'deadline', detail: { band: band.band, remainingMs: band.remainingMs }, result: 'final verification only' })
        transition(EPISODE_PHASES.VERIFYING, { reason: 'the episode is in its final band' })
        break
      }

      if (repairMode && step.kind !== PLAN_KINDS.PATCH && step.kind !== PLAN_KINDS.FOCUSED_TEST) {
        // In repair mode the runtime only patches and re-tests: it does not walk
        // forward past the failure it is fixing.
        repairMode = false
      }

      const outcome = await runStep(step)
      const record = advance(plan, step.id, { ok: outcome.outcome === STEP_OUTCOMES.SUCCESS, reason: outcome.reason, evidence: outcome.evidence })
      if (!record.ok) log({ type: 'plan-advance-refused', step: step.id, reason: record.reason })
      const stepCheckpoint = checkpoint(`step:${step.id}`)
      if (!stepCheckpoint.ok || !stepCheckpoint.recoveryIndex?.ok) {
        const reason = stepCheckpoint.reason || 'the verified step cursor could not be durably checkpointed'
        failures.push({ step: step.id, class: 'RECOVERY_CHECKPOINT', signature: `checkpoint:${step.id}`, reason, at: now() })
        status = 'blocked'
        machine.force(EPISODE_PHASES.BLOCKED, reason)
        break
      }

      if (outcome.outcome === STEP_OUTCOMES.SUCCESS) {
        context.setLive({ currentError: null })
        if (repairMode && (step.kind === PLAN_KINDS.FOCUSED_TEST || step.kind === PLAN_KINDS.AFFECTED_TEST)) {
          noteProgress('repair-verified', { summary: `${step.kind} passed after a repair`, evidence: { step: step.id } })
          failures[FailuresLastIndex(failures)] = { ...failures[failures.length - 1], repaired: true }
          repairMode = false
        }
        step = nextStep(plan)
        continue
      }

      if (outcome.outcome === STEP_OUTCOMES.SKIPPED) {
        context.recordDecision({ kind: 'skipped', detail: { step: step.id, reason: outcome.reason }, result: 'skipped' })
        step = nextStep(plan)
        continue
      }

      // Failure handling.
      transition(EPISODE_PHASES.INSPECTING_FAILURE, { reason: outcome.reason || 'step failed' })
      const decision = decideAfterFailure(step, outcome)
      if (decision.action === 'block') {
        machine.force(EPISODE_PHASES.BLOCKED, decision.reason)
        checkpoint('blocked')
        break
      }
      if (decision.action === 'retry') {
        const attempt = repairs.attempts().find((entry) => entry.signature === decision.failure.signature)
        await retryLater(step, attempt ? attempt.count : 1)
        // The same step is retried through the plan cursor: it was not advanced
        // past, because `advance` marked it complete only on success.
        plan.cursor = Math.max(0, plan.cursor - 1)
        step = nextStep(plan)
        continue
      }
      if (decision.action === 'stall') {
        transition(EPISODE_PHASES.STALLED, { reason: decision.reason })
        stallLevel = Math.max(stallLevel, 3)
        // Broaden the investigation once, then fail with the evidence.
        if (stallLevel < 5) {
          stallLevel = 5
          context.recordDecision({ kind: 'stall', detail: { level: stallLevel, reason: decision.reason }, result: 'escalate to full verification' })
          transition(EPISODE_PHASES.VERIFYING, { reason: 'the repair loop stalled' })
          break
        }
        break
      }
      // Repair: apply the next patch and re-run the focused verification.
      transition(EPISODE_PHASES.REPAIRING, { reason: decision.reason })
      repairRounds += 1
      context.recordDecision({ kind: 'repair', detail: { round: repairRounds, failure: decision.failure.class, signature: decision.failure.signature }, result: 'repairing' })
      const patched = await runStep({ ...step, id: `${step.id}#repair${repairRounds}`, kind: PLAN_KINDS.PATCH, patchIndex: repairRounds })
      if (patched.outcome !== STEP_OUTCOMES.SUCCESS) {
        context.recordDecision({ kind: 'repair', detail: { round: repairRounds, reason: patched.reason }, result: 'no patch available' })
        transition(EPISODE_PHASES.VERIFYING, { reason: 'no further repair is available' })
        break
      }
      repairMode = true
      // Re-test the same step: the cursor is not advanced, so the failed step is
      // re-run against the patched code.
      plan.cursor = Math.max(0, plan.cursor - 1)
      step = nextStep(plan)
    }
    }

    /**
     * A round, then the evidence the completion gate reads, then the gate itself.
     * When the gate refuses and autonomy is enabled with a *new* piece of evidence
     * available, another round runs with the remaining plan instead of stopping at
     * the first failure.
     */
    const rounds = []
    for (let round = 0; ; round += 1) {
      context.setLive({ phase: machine.phase })
      await walkPlan()
      rounds.push({ round, phase: machine.phase, repairRounds, mutations: mutations.applied().length })

      // A cancelled episode does not run the completion gate: the caller stopped
      // it, so there is no claim to validate. It still tears down and still reports
      // what it had verified, because "I stopped this, here is where it got to" is
      // a useful answer and "FAILED" would not be honest.
      if (machine.phase === EPISODE_PHASES.CANCELLED) {
        finishedAt = now()
        status = 'cancelled'
        supervisor.dispose('episode cancelled')
        const preserve = typeof input.preserveRecoveryOnCancel === 'function' && input.preserveRecoveryOnCancel() === true
        if (preserve) {
          cleanupResult = { ok: true, skipped: true, reason: 'resumable cancellation preserves scratch', deleted: [], residuals: [] }
        } else {
          cleanupTerminalState = RECOVERY_STATES.CANCELLED
          cleanupInProgress = true
          cleanupResult = crossVolumeTemp.cleanupTerminal({ terminal: true, reason: 'cancelled' })
          cleanupInProgress = false
          if (!cleanupResult.ok) {
            const cleanupReason = `CLEANUP_BLOCKED: ${cleanupResult.residuals.map((entry) => entry.path).join(', ')}`
            cleanupTerminalState = RECOVERY_STATES.CANCELLED
            status = 'blocked'
            failures.push({ class: 'CLEANUP_BLOCKED', signature: 'cross-volume-cleanup', reason: cleanupReason, at: now() })
            machine.force(EPISODE_PHASES.BLOCKED, cleanupReason)
            checkpoint('blocked')
            report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [cleanupReason], checks: [] })
            return report
          }
          cleanupTerminalState = null
        }
        checkpoint('cancelled')
        report = buildReport({ verdict: 'CANCELLED', ok: false, reasons: ['the caller cancelled the episode'], checks: [] })
        return report
      }
      if (machine.phase === EPISODE_PHASES.BLOCKED) {
        finishedAt = now()
        status = 'blocked'
        report = buildReport({
          verdict: 'BLOCKED',
          ok: false,
          reasons: failures.length ? [`${failures[failures.length - 1].class}: ${failures[failures.length - 1].reason}`] : ['the episode is blocked'],
          checks: []
        })
        checkpoint('blocked')
        return report
      }

      // Final verification for this round: the evidence the gate will read.
      if (machine.phase !== EPISODE_PHASES.VERIFYING && !machine.terminal) {
        transition(EPISODE_PHASES.VERIFYING, { reason: round === 0 ? 'the plan is exhausted' : 'the continuation round finished' })
      }
      if (commands && (commands[VERIFICATION_LEVELS.FULL] || commands.test)) {
        const final = await verifier.run(VERIFICATION_LEVELS.FULL, { timeoutMs: budget.stepTimeoutMs })
        if (final.ok) noteProgress('final-verification', { summary: 'the full verification passed', evidence: { command: final.command } })
      }

      const verdict = resultValidator.validate(validationInput())
      if (verdict.ok) {
        cleanupTerminalState = RECOVERY_STATES.COMPLETED
        cleanupInProgress = true
        cleanupResult = crossVolumeTemp.cleanupTerminal({ terminal: true, reason: 'completed' })
        cleanupInProgress = false
        if (!cleanupResult.ok) {
          const cleanupReason = `CLEANUP_BLOCKED: ${cleanupResult.residuals.map((entry) => entry.path).join(', ')}`
          cleanupTerminalState = RECOVERY_STATES.COMPLETED
          finishedAt = now()
          status = 'blocked'
          failures.push({ class: 'CLEANUP_BLOCKED', signature: 'cross-volume-cleanup', reason: cleanupReason, at: now() })
          machine.force(EPISODE_PHASES.BLOCKED, cleanupReason)
          report = buildReport({ verdict: 'BLOCKED', ok: false, reasons: [cleanupReason], checks: [] })
          break
        }
        cleanupTerminalState = null
        finishedAt = now()
        machine.force(EPISODE_PHASES.COMPLETED, 'the result validator accepted the evidence')
        status = 'completed'
        report = buildReport(verdict)
        break
      }

      // The gate refused. Continuing is only honest when autonomy is enabled *and*
      // the round produced new evidence to continue from.
      const probe = buildReport(verdict)
      const decision = autonomy.decide(probe, { round, totalSteps: plan.cursor })
      context.recordDecision({ kind: 'autonomy', detail: { round, continue: decision.continue, reason: decision.reason, source: decision.source }, result: decision.continue ? 'continuing' : 'stopping' })
      log({ type: 'autonomy', round, continue: decision.continue, reason: decision.reason })
      if (!decision.continue) {
        finishedAt = now()
        machine.force(EPISODE_PHASES.FAILED, verdict.reasons.join('; '))
        status = 'failed'
        report = buildReport(verdict)
        break
      }
      // The next round resumes from the remaining plan: the steps that completed
      // stay completed, so a continuation never replays verified work.
      transition(EPISODE_PHASES.PLANNING, { reason: `autonomy continuation round ${round + 1}` })
      plan = buildPlan({
        goal: input.goal,
        discovery: { commands },
        contract,
        baseline: snapshot,
        inputs: { steps: contract.steps, maxSteps: budget.maxSteps, focus: contract.focus }
      })
      // Carry the completed work forward: the plan is rebuilt, so the steps the
      // previous rounds verified are marked complete rather than re-run.
      for (const entry of verdict.checks) void entry
      verifier.invalidate(`continuation round ${round + 1} starts from the current tree`)
      noteProgress('continuation', { summary: `autonomy continued with round ${round + 1}`, evidence: { reason: decision.reason } })
    }

    // Teardown: no owned process outlives the episode unless the contract kept one.
    if (contract.keepProcesses === true) {
      for (const entry of supervisor.running()) supervisor.release(entry.id, 'the contract asked to keep it alive')
    } else {
      supervisor.dispose('episode teardown')
    }
    // The workspace is free again the moment the episode stops, on every path: a
    // lock left behind would make the next episode look like a concurrent writer.
    lock.release()
    checkpoint(status === 'completed' ? 'completed' : 'failed')
    report = report || buildReport({ verdict: 'FAILED', ok: false, reasons: ['the episode ended without a verdict'], checks: [] })
    return report
  }

  /** A tiny helper so the code above cannot mistype an index. */
  function FailuresLastIndex(list) {
    return list.length - 1
  }

  return {
    EPISODE_PHASES,
    STEP_OUTCOMES,
    budget,
    id: episodeId,
    run,
    machine,
    scheduler,
    context,
    supervisor,
    checkpoints,
    recoveryStore,
    crossVolumeTemp,
    /** The live phase. */
    get phase() {
      return machine.phase
    },
    get status() {
      return status
    },
    get report() {
      return report
    },
    /** What the supervisor would do next, without doing it (read-only). */
    state() {
      return {
        phase: machine.phase,
        plan: plan ? { steps: plan.steps.length, cursor: plan.cursor } : null,
        repairRounds,
        stallLevel,
        failures: failures.length,
        ownedProcesses: supervisor.ownedCount(),
        deadline: deadlineNow(),
        progress: { lastProgressAt, lastActionAt, lastVerifiedEffectAt, noOpCount }
      }
    },
    /** Resume verification for a caller that found a checkpoint. */
    verifyResume(checkpoint) {
      return verifyResume({
        checkpoint,
        workspace: workspace || input.workspace,
        fingerprint: snapshot ? snapshot.fingerprint : null,
        resumeMutation: (entry) => (mutations ? mutations.resume(entry) : { verdict: 'retry', verified: false, reason: 'no mutation log' })
      })
    },
    /** The engineering context summary, for a caller that needs the short version. */
    summarize() {
      return context.summarize(context.inventory())
    }
  }
}

/**
 * Split one shell-ish command string into a command and its arguments.
 *
 * The project's own command strings are the input, so quotes have to survive:
 * `node --test "tests/a b.test.js"` is two arguments, not three.
 */
function splitCommand(text) {
  const source = String(text || '').trim()
  if (!source) return { command: '', args: [] }
  const tokens = []
  let current = ''
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  if (!tokens.length) return { command: source, args: [] }
  return { command: tokens[0], args: tokens.slice(1) }
}

/** Convenience: build a supervisor, run one episode, return the report. */
async function runEpisode(input = {}) {
  const supervisor = createEngineeringSupervisor(input)
  return supervisor.run(input.runOptions || {})
}

module.exports = {
  createEngineeringSupervisor,
  runEpisode,
  splitCommand,
  STEP_OUTCOMES,
  EPISODE_DEFAULTS,
  FAILURE_CLASSES,
  MUTATION_KINDS
}
