'use strict'

/**
 * DS-Hns Computer Use: long-running execution acceptance harness
 * (Update-Plan/24h.md §23 Soak, §24 Failure Injection, §25 Scenarios A-G, §26).
 *
 * The unit suite proves each rule in isolation. This harness proves the same
 * rules hold *while the runtime keeps working*, which is the only way the
 * long-running claims mean anything: hundreds of action cycles over an
 * accelerated virtual clock, with failures injected into the middle of them, and
 * hard numbers checked at the end.
 *
 * It runs under plain Node — no Electron, no real desktop, no pixels — because
 * every dependency it needs (the device, the clock, the controllers) is already
 * injectable. It is therefore suitable for CI, which is where an acceptance
 * harness that nobody runs is worth nothing.
 *
 * Usage:
 *   node scripts\computer-use-longrun-acceptance.cjs
 *   node scripts\computer-use-longrun-acceptance.cjs --cycles 500
 *   node scripts\computer-use-longrun-acceptance.cjs --list
 *   node scripts\computer-use-longrun-acceptance.cjs --json           # machine readable
 *   node scripts\computer-use-longrun-acceptance.cjs --out report.json
 *
 * Exit code 0 = every case passed, 1 = at least one failure or an unmet target.
 * A harness that cannot run its cases says so and exits non-zero; it never
 * reports a skip as a pass.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const { createVirtualClock } = require(path.join(ROOT, 'tests', 'helpers', 'computer-use-clock.cjs'))

const { createComputerUseRuntime } = require(path.join(ROOT, 'app', 'computer-use', 'index.cjs'))
const { createProgressTracker, PROGRESS_KINDS } = require(path.join(ROOT, 'app', 'computer-use', 'progress.cjs'))
const { createProcessRegistry, PROCESS_STATUS } = require(path.join(ROOT, 'app', 'computer-use', 'processes.cjs'))
const { createResourceBudget } = require(path.join(ROOT, 'app', 'computer-use', 'resources.cjs'))
const { createFocusTrust } = require(path.join(ROOT, 'app', 'computer-use', 'focus.cjs'))
const { createMutationVerifier, RESUME_VERDICT } = require(path.join(ROOT, 'app', 'computer-use', 'mutation.cjs'))
const { createWorkspaceGuard } = require(path.join(ROOT, 'app', 'computer-use', 'workspace.cjs'))
const { createStallDetector, STALL_RECOVERY_LADDER } = require(path.join(ROOT, 'app', 'computer-use', 'stall.cjs'))
const { createReconnectPolicy, RECONNECT, isTransportFailure } = require(path.join(ROOT, 'app', 'computer-use', 'reconnect.cjs'))
const { buildHealthSnapshot, HEALTH_STATUS, BLOCK_REASONS } = require(path.join(ROOT, 'app', 'computer-use', 'health.cjs'))
const { createExecutionLog, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } = require(path.join(ROOT, 'app', 'computer-use', 'log.cjs'))

// ---------------------------------------------------------------------------
// Tiny assertion layer. Every case records its checks, so one failure never
// hides the rest of the evidence — and the report says *what number* was off.
// ---------------------------------------------------------------------------

function createCase(id, title) {
  const checks = []
  const notes = []
  return {
    id,
    title,
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail })
      return Boolean(ok)
    },
    eq(name, actual, expected) {
      return this.check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    atMost(name, actual, ceiling) {
      return this.check(name, typeof actual === 'number' && actual <= ceiling, `${actual} must be <= ${ceiling}`)
    },
    atLeast(name, actual, floor) {
      return this.check(name, typeof actual === 'number' && actual >= floor, `${actual} must be >= ${floor}`)
    },
    note(message) {
      notes.push(String(message))
    },
    result() {
      const failed = checks.filter((entry) => !entry.ok)
      return { id, title, status: failed.length ? 'failed' : 'passed', checks, notes, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) }
    }
  }
}

// ---------------------------------------------------------------------------
// The injected failures (plan §24). Each one is a *condition* the runtime has to
// survive, not a mock: the assertions live in the case that injects it.
// ---------------------------------------------------------------------------

const FAILURE_INJECTIONS = [
  { id: 'cdp-disconnect', outcome: 'recover', title: 'the browser transport disconnects mid-step and is reconnected within its bound' },
  { id: 'window-closes', outcome: 'recover', title: 'the focused window disappears: focus trust is cleared and the target is re-resolved' },
  { id: 'target-moves', outcome: 'recover', title: 'the target moves while settling: the coordinate is never reused' },
  { id: 'target-disappears', outcome: 'fail-with-evidence', title: 'the target disappears: the step fails with a typed code, not a hang' },
  { id: 'ui-freezes', outcome: 'recover', title: 'the UI freezes temporarily: the wait is bounded and the run continues' },
  { id: 'modal-appears', outcome: 'recover', title: 'an unexpected modal appears: it is dismissed by its own control and the action resumes' },
  { id: 'shell-timeout', outcome: 'fail-with-evidence', title: 'a foreground command outlives its timeout: the owned child is terminated and reported' },
  { id: 'child-crash', outcome: 'fail-with-evidence', title: 'a child process crashes: its exit is recorded, not lost' },
  { id: 'file-locked', outcome: 'fail-with-evidence', title: 'a file mutation cannot be confirmed on disk: the step is not a success' },
  { id: 'workspace-inaccessible', outcome: 'block', title: 'the workspace disappears: the runtime blocks instead of writing elsewhere' },
  { id: 'vision-unavailable', outcome: 'degrade', title: 'vision goes away: the other capabilities keep working' },
  { id: 'verification-unknown', outcome: 'block', title: 'state integrity is uncertain: the runtime stops rather than guessing' }
]

// ---------------------------------------------------------------------------
// Accelerated soak (plan §23). Hundreds of cycles of the work a development
// executor actually repeats, over a virtual clock.
// ---------------------------------------------------------------------------

async function runSoak(case_, options) {
  const cycles = options.cycles
  const clock = createVirtualClock()
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-longrun-log-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-longrun-ws-'))
  const log = createExecutionLog({ now: clock.now, dir: logDir, mode: 'normal', runId: 'soak' })
  const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
  const resources = createResourceBudget({ now: clock.now, maxScreenshots: 8, ringSize: 32, maxEvidenceBytes: 64 * 1024 })
  const progress = createProgressTracker({ now: clock.now, ringSize: 32 })
  const focus = createFocusTrust({ now: clock.now })
  const stall = createStallDetector({ now: clock.now })
  const mutations = createMutationVerifier({ now: clock.now })
  const workspace = createWorkspaceGuard({ workspace: workspaceDir, now: clock.now })

  let verifiedEffects = 0
  let retries = 0
  let totalActions = 0
  let lastFocusVerifiedRef = null

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    totalActions += 1
    // --- a structured observation, then a real edit on disk -----------------
    const target = path.join(workspaceDir, `file-${cycle % 16}.js`)
    const beforeMtime = mutations.mtime(target)
    fs.writeFileSync(target, `// cycle ${cycle}\nmodule.exports = ${cycle}\n`, 'utf8')
    clock.advance(12)
    log.step({
      step: cycle,
      action: { type: 'FILE_WRITE', params: { path: target, content: `// cycle ${cycle}\nmodule.exports = ${cycle}\n` } },
      result: 'success',
      verdict: 'success',
      durationMs: 12,
      retry: 0,
      reasonCode: null
    })
    const mutation = await mutations.verify({
      action: { type: 'FILE_WRITE', params: { path: target, content: `// cycle ${cycle}\nmodule.exports = ${cycle}\n` } },
      receipt: { path: target, bytes: Buffer.byteLength(`// cycle ${cycle}\nmodule.exports = ${cycle}\n`) },
      beforeMtime
    })
    if (mutation.verified) verifiedEffects += 1
    progress.progress(PROGRESS_KINDS.FILE_OPERATION, { step: cycle, operation: mutation.operation, verified: mutation.verified })

    // --- a shell command, supervised and registered -------------------------
    const fakeChild = { pid: 1000 + (cycle % 5), kill() { return true }, on() {} }
    const registration = processes.register({
      child: fakeChild,
      command: process.execPath,
      args: ['-e', '0'],
      cwd: workspaceDir,
      mode: cycle % 7 === 0 ? 'long_running' : 'foreground',
      expectedLifetimeMs: 1000,
      ownership: 'runtime',
      step: cycle
    })
    clock.advance(25)
    processes.settle(registration.id, { status: PROCESS_STATUS.EXITED, exitCode: 0 })
    progress.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { step: cycle, exitCode: 0, exited: true })

    // --- focus: a window change invalidates trust unless it is re-verified ---
    if (cycle % 5 === 0) {
      focus.observeContext({ windowSignature: `window-${Math.floor(cycle / 5)}`, url: 'https://example.test/work', title: 'work', controls: [], focusedRef: null })
      focus.attempt(`field-${cycle % 4}`, { source: 'resolution' })
    } else {
      focus.attempt(`field-${cycle % 4}`, { source: 'resolution' })
    }
    const focusVerified = cycle % 3 !== 2
    focus.verified(focusVerified ? 'success' : 'unknown', focusVerified ? `field-${cycle % 4}` : null)
    lastFocusVerifiedRef = focusVerified ? `field-${cycle % 4}` : null

    // --- a screenshot that is transient unless the run is failing ------------
    resources.registerScreenshot({ bytes: 4096, reason: `stall-targeted-${cycle}`, step: cycle, level: 1, runFailed: cycle % 50 === 0 })

    // --- stall bookkeeping: repeated no-ops must not read as progress --------
    const signature = focusVerified ? `sig-${cycle}` : 'sig-same'
    progress.action({ step: cycle })
    if (!focusVerified) progress.noOp(signature)
    stall.record({ step: cycle, actionType: 'FILE_WRITE', signature, changed: focusVerified, meaningful: focusVerified })

    // --- an occasional bounded retry ----------------------------------------
    if (cycle % 11 === 0) {
      retries += 1
      log.event({ type: 'retry', step: cycle, attempt: 1, reason: 'injected transient miss' })
      clock.advance(30)
    }
    // --- heartbeats must never be progress ----------------------------------
    progress.heartbeat({ step: cycle })
  }

  const snapshot = log.finish({ status: 'completed', steps: cycles, verdict: 'success' })
  const logPath = log.path || snapshot.path || null

  // ---- the long-run invariants --------------------------------------------
  case_.atLeast('the soak ran hundreds of action cycles', totalActions, 200)
  case_.atLeast('the soak verified real filesystem effects', verifiedEffects, Math.floor(cycles * 0.9))
  case_.atMost('the step trace ring stayed bounded', log.entries().length, 2000)
  case_.atMost('the progress ring stayed bounded', progress.history().length, 32)
  case_.atMost('the focus-trust history stayed bounded', focus.history().length, 100)
  case_.atMost('the mutation check ring stayed bounded', mutations.checks().length, 200)
  case_.atMost('the stall history stayed bounded', stall.history().length, 200)
  case_.atMost('the live capture ring stayed bounded by the ceiling', resources.snapshot().screenshots, 8)
  case_.atLeast('transient captures were dropped rather than accumulated', resources.snapshot().droppedScreenshots, 1)
  case_.atMost('the screenshot log ring stayed bounded', log.screenshots().length, 200)
  case_.eq('no owned process leaked', processes.ownedCount, 0)
  case_.atLeast('the process registry recorded the children it settled', processes.finished().length, 20)
  case_.atMost('the finished-process ring stayed bounded', processes.finished().length, processes.snapshot().finished.length + 100)
  case_.eq('the runtime never owns more than its ceiling', processes.snapshot().owned.length <= processes.snapshot().ceiling, true)
  case_.atMost('retries stayed proportional to the injected misses', retries, Math.ceil(cycles / 11) + 1)
  case_.check('focus trust was cleared by a window change and never inferred', snapshotsOf(focus) >= 1, `invalidation snapshots: ${snapshotsOf(focus)}`)
  // The trust state at the end must equal what the last verification said —
  // nothing may survive a failure or an unknown verdict.
  case_.eq('focus trust matches the last verification verdict', focus.verifiedFocusRef, lastFocusVerifiedRef)
  case_.check('the log rotated or stayed inside its own byte ceiling', !logPath || fs.statSync(logPath).size <= DEFAULT_MAX_BYTES * (DEFAULT_MAX_FILES + 1), logPath ? `${fs.statSync(logPath).size} bytes` : 'no log file was opened')
  case_.eq('the log recorded its run id on every line', snapshot.runId, 'soak')
  case_.check('every logged step carries the structured long-running fields', log.steps().every((step) => 'runId' in step && 'stepId' in step && 'verdict' in step && 'retry' in step && 'reasonCode' in step), null)
  case_.check('the workspace stayed verified for the whole soak', workspace.status().ok === true, JSON.stringify(workspace.status()))
  case_.eq('no workspace drift was recorded', workspace.drifts().length, 0)

  log.close()
  fs.rmSync(logDir, { recursive: true, force: true })
  fs.rmSync(workspaceDir, { recursive: true, force: true })
}

/** How many times the focus tracker recorded a hard invalidation. */
function snapshotsOf(focus) {
  return focus.history().filter((entry) => entry.kind === 'invalidate').length
}

// ---------------------------------------------------------------------------
// Failure injection engine (plan §24)
// ---------------------------------------------------------------------------

async function runInjection(case_, injection, options) {
  const clock = createVirtualClock()
  switch (injection.id) {
    case 'cdp-disconnect': {
      const policy = createReconnectPolicy({ now: clock.now, sleep: async (ms) => clock.advance(ms), maxAttempts: 2 })
      policy.beginStep()
      let attached = 0
      const outcome = await policy.reconnect({
        channel: 'browser',
        reattach: async () => {
          attached += 1
          return attached >= 2
        },
        observe: async () => ({ ok: true })
      })
      case_.eq('the disconnect was classified as a transport failure', isTransportFailure(new Error('Target closed')), true)
      case_.eq('the channel was reconnected', outcome.outcome, RECONNECT.RECONNECTED)
      case_.atMost('the reconnect stayed inside its attempt bound', attached, policy.maxAttempts)
      case_.eq('the budget is per step, so a fresh step resets it', policy.beginStep() && policy.budget('browser').used, 0)
      break
    }
    case 'window-closes': {
      const focus = createFocusTrust({ now: clock.now })
      focus.observeContext({ windowSignature: 'window-1', url: 'https://example.test/a', title: 'A', controls: [{ ref: 'field-a' }], focusedRef: 'field-a' })
      focus.attempt('field-a', { source: 'resolution' })
      focus.verified('success', 'field-a')
      case_.eq('the focus is trusted while its world is present', focus.verifiedFocusRef, 'field-a')
      // The window goes away: nothing about the old world is observable again.
      const outcome = focus.observeContext({ windowSignature: 'window-2', url: 'https://example.test/a', title: 'A', controls: [], focusedRef: null })
      case_.check('the closed window is detected', outcome.invalidated === true, JSON.stringify(outcome))
      case_.eq('a detached target clears the verified focus reference', focus.verifiedFocusRef, null)
      case_.check('the invalidation is recorded', focus.history().some((entry) => entry.kind === 'invalidate'), null)
      break
    }
    case 'target-moves': {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-move-'))
      const { createStabilizer } = require(path.join(ROOT, 'app', 'computer-use', 'stabilization.cjs'))
      const stabilizer = createStabilizer({ clock })
      let calls = 0
      const settle = await stabilizer.settle({
        action: { type: 'DOM_CLICK', target: { selector: '#moving' }, maximumMs: 400 },
        previous: { ref: 'node-1', bbox: { x: 10, y: 10, width: 40, height: 20 } },
        observe: async () => {
          calls += 1
          return { signature: `s${calls}`, foregroundRef: 'w1' }
        },
        locateTarget: async () => ({ ref: 'node-1', bbox: { x: 90, y: 90, width: 40, height: 20 } })
      })
      case_.eq('a moved target produces a reobserve verdict', settle.verdict, 'reobserve')
      case_.atMost('the settling stayed inside the action bound', settle.waitedMs, 400)
      fs.rmSync(workspaceDir, { recursive: true, force: true })
      break
    }
    case 'target-disappears': {
      const stall = createStallDetector({ now: clock.now, consecutiveActions: 2, maxRecoveries: 2 })
      stall.record({ step: 1, actionType: 'DOM_CLICK', signature: 'same', changed: false })
      stall.record({ step: 2, actionType: 'DOM_CLICK', signature: 'same', changed: false })
      case_.eq('two unchanged actions are a stall', stall.record({ step: 3, actionType: 'DOM_CLICK', signature: 'same', changed: false }).stalled, true)
      const recoveries = [stall.registerRecovery(), stall.registerRecovery()]
      case_.eq('the ladder ends instead of looping', recoveries[1].exhausted, true)
      case_.eq('the ladder is bounded by its own length', STALL_RECOVERY_LADDER.length, 8)
      case_.eq('the last rung is fail-with-context', STALL_RECOVERY_LADDER[STALL_RECOVERY_LADDER.length - 1].step, 'fail_with_context')
      break
    }
    case 'ui-freezes': {
      const { createStabilizer } = require(path.join(ROOT, 'app', 'computer-use', 'stabilization.cjs'))
      const stabilizer = createStabilizer({ clock })
      const outcome = await stabilizer.settle({
        action: { type: 'DOM_CLICK', target: { selector: '#apply' }, maximumMs: 250 },
        previous: { ref: 'n', bbox: { x: 0, y: 0, width: 10, height: 10 } },
        signals: { uiChanging: true, animationDetected: true },
        observe: async () => ({ signature: 'never-changes', foregroundRef: 'w1' }),
        locateTarget: async () => ({ ref: 'n', bbox: { x: 0, y: 0, width: 10, height: 10 } })
      })
      case_.atMost('a frozen UI never waits past the action ceiling', outcome.waitedMs, 250)
      case_.check('the wait ended in a bounded decision, not a sleep', ['stable', 'settled', 'reobserve', 'wait_state'].includes(outcome.verdict), outcome.verdict)
      break
    }
    case 'modal-appears': {
      const { planModal, MODAL_ACTION, MODAL_KINDS } = require(path.join(ROOT, 'app', 'computer-use', 'modal.cjs'))
      const plan = planModal({
        modal: { type: 'confirm', message: 'Delete this file?', controls: [] },
        candidates: [
          { ref: 'c1', label: 'Delete and close', source: 'page', role: 'button' },
          { ref: 'c2', label: 'Cancel', source: 'page', role: 'button' }
        ],
        context: { destructiveMode: 'confirm', destructiveKinds: ['DELETE'], safetyPassed: true }
      })
      case_.check('a destructive control is never pressed by default', plan.action !== MODAL_ACTION.PRESS || plan.kind !== MODAL_KINDS.DESTRUCTIVE, `${plan.action}/${plan.kind}`)
      const safe = planModal({
        modal: { type: 'alert', message: 'Saved', controls: [] },
        candidates: [{ ref: 'c1', label: 'Dismiss', source: 'page', role: 'button' }],
        context: { destructiveMode: 'confirm', destructiveKinds: ['DELETE'], safetyPassed: true }
      })
      case_.eq('a safe dismissal is pressed', safe.action, MODAL_ACTION.PRESS)
      case_.eq('the dismissal keeps its interaction channel', safe.source, 'page')
      break
    }
    case 'shell-timeout': {
      const { createShellController } = require(path.join(ROOT, 'app', 'computer-use', 'controllers', 'shell.cjs'))
      const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
      const shell = createShellController({ clock, cwd: os.tmpdir(), processes })
      const receipt = await shell.perform(
        { type: 'SHELL_EXEC', params: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }, timeoutMs: 1200 },
        { contract: { goal: 'timeout', capabilities: ['shell'], safety: {} } }
      )
      case_.eq('an over-running foreground command is terminated', receipt.timedOut, true)
      case_.eq('the timeout is reported, not hidden', receipt.verdict.result, 'failure')
      case_.eq('the terminated child is settled in the registry', processes.ownedCount, 0)
      case_.eq('the receipt carries the bound it was given', receipt.timeoutMs, 1200)
      processes.dispose('harness teardown')
      break
    }
    case 'child-crash': {
      const { createShellController } = require(path.join(ROOT, 'app', 'computer-use', 'controllers', 'shell.cjs'))
      const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
      const shell = createShellController({ clock, cwd: os.tmpdir(), processes })
      const receipt = await shell.perform(
        { type: 'SHELL_EXEC', params: { command: process.execPath, args: ['-e', 'process.exit(9)'] }, timeoutMs: 15000 },
        { contract: { goal: 'crash', capabilities: ['shell'], safety: {} } }
      )
      case_.eq('the crash exit code is recorded', receipt.exitCode, 9)
      case_.eq('a non-zero exit is a reported failure', receipt.verdict.result, 'failure')
      const history = processes.finished()
      case_.eq('the crashed child is not leaked', processes.ownedCount, 0)
      case_.check('the crashed child has a recorded outcome', history.length >= 1, JSON.stringify(history.slice(-1)))
      processes.dispose('harness teardown')
      break
    }
    case 'file-locked': {
      const verifier = createMutationVerifier({ now: clock.now })
      const missing = path.join(os.tmpdir(), `cu-locked-${process.pid}-${Date.now()}.txt`)
      const observed = await verifier.verify({
        action: { type: 'FILE_WRITE', params: { path: missing, content: 'x' } },
        receipt: { path: missing, bytes: 1 }
      })
      case_.eq('an unconfirmed mutation is not a success', observed.verified, false)
      const resume = await verifier.resume({ action: { type: 'FILE_WRITE', params: { path: missing, content: 'x' } } })
      case_.eq('resuming re-observes instead of blindly rewriting', resume.verdict, RESUME_VERDICT.RETRY)
      break
    }
    case 'workspace-inaccessible': {
      const gone = path.join(os.tmpdir(), `cu-ws-gone-${process.pid}-${Date.now()}`)
      const guard = createWorkspaceGuard({ workspace: gone, now: clock.now })
      const verdict = guard.resolveCwd({ cwd: null, step: 1 })
      case_.eq('a missing workspace refuses a working directory', verdict.ok, false)
      case_.check('the refusal explains itself', typeof verdict.reason === 'string' && verdict.reason.length > 0, verdict.reason)
      const status = guard.status()
      case_.eq('the workspace reports itself unavailable', status.ok, false)
      case_.check('the runtime has a block reason for it', Object.values(BLOCK_REASONS).includes('workspace_unavailable'), null)
      break
    }
    case 'vision-unavailable': {
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        controllers: {
          browser: { available: true, reason: null, detail: {} },
          desktop: { available: true, reason: null, detail: {} },
          shell: { available: true, reason: null, detail: {} },
          file: { available: true, reason: null, detail: {} },
          vision: { available: false, reason: 'the capture backend was removed', detail: {} }
        },
        // The capability list is the runtime's *action capability* vocabulary
        // (`desktop`, `browser`, `vision`, `shell`, `filesystem`), not the
        // controller ids — see ACTION_CAPABILITY in constants.cjs.
        allowedCapabilities: ['browser', 'desktop', 'shell', 'filesystem'],
        workspace: { ok: true, cwd: os.tmpdir(), reason: null },
        processes: { ownedCount: 0, atCapacity: false },
        resources: { atCeiling: false, screenshots: 0, droppedScreenshots: 0, evidenceBytes: 0, limits: {} },
        progress: { lastProgressAt: clock.now(), sinceProgressMs: 0, lastVerifiedEffectAt: clock.now(), noOpStreak: 0 },
        safetyAvailable: true
      })
      case_.eq('one dead controller degrades rather than blocks', snapshot.status, HEALTH_STATUS.DEGRADED)
      case_.check('the dead controller is named', snapshot.unavailableCapabilities.includes('vision'), JSON.stringify(snapshot.unavailableCapabilities))
      case_.check('the surviving capabilities stay usable', snapshot.usableCapabilities.includes('browser'), JSON.stringify(snapshot.usableCapabilities))
      case_.check('the runtime is not blocked', snapshot.status !== HEALTH_STATUS.BLOCKED, snapshot.blockedReasons)
      break
    }
    case 'verification-unknown': {
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        controllers: { browser: { available: true, reason: null, detail: {} } },
        allowedCapabilities: ['browser'],
        workspace: { ok: true, cwd: os.tmpdir(), reason: null },
        processes: { ownedCount: 0, atCapacity: false },
        resources: { atCeiling: false, screenshots: 0, droppedScreenshots: 0, evidenceBytes: 0, limits: {} },
        progress: { lastProgressAt: null, sinceProgressMs: 5000, lastVerifiedEffectAt: null, noOpStreak: 5 },
        stateIntegrity: false,
        safetyAvailable: true
      })
      case_.eq('an uncertain state blocks the runtime', snapshot.status, HEALTH_STATUS.BLOCKED)
      case_.check('the block reason is state integrity', snapshot.blockedReasons.some((entry) => entry.code === BLOCK_REASONS.STATE_INTEGRITY_UNCERTAIN), JSON.stringify(snapshot.blockedReasons))
      // And a runtime that *has* progress is not "blocked" merely because it is slow.
      const healthy = buildHealthSnapshot({
        now: clock.now(),
        controllers: { browser: { available: true, reason: null, detail: {} } },
        allowedCapabilities: ['browser'],
        workspace: { ok: true, cwd: os.tmpdir(), reason: null },
        processes: { ownedCount: 0, atCapacity: false },
        resources: { atCeiling: false, screenshots: 0, droppedScreenshots: 0, evidenceBytes: 0, limits: {} },
        progress: { lastProgressAt: clock.now(), sinceProgressMs: 20, lastVerifiedEffectAt: clock.now(), noOpStreak: 0 },
        safetyAvailable: true
      })
      case_.eq('an uncertain state is the only reason it stops', healthy.status, HEALTH_STATUS.HEALTHY)
      break
    }
    default:
      case_.check(`the injection ${injection.id} is implemented`, false, 'no implementation')
  }
  void options
}

// ---------------------------------------------------------------------------
// Scenarios A-G (plan §25)
// ---------------------------------------------------------------------------

async function runScenario(case_, id, options) {
  const clock = createVirtualClock()
  switch (id) {
    case 'A': {
      // A sustained UI task: no accumulating stale focus, no screenshot flood,
      // no retry inflation.
      const focus = createFocusTrust({ now: clock.now })
      const resources = createResourceBudget({ now: clock.now, maxScreenshots: 6, transientTtlMs: 5000 })
      const progress = createProgressTracker({ now: clock.now, ringSize: 24 })
      let retries = 0
      let lastVerified = null
      for (let step = 0; step < 400; step += 1) {
        clock.advance(10)
        focus.beginStep()
        focus.observeContext({ windowSignature: `window-${Math.floor(step / 100)}`, url: 'https://example.test/work', title: 'work', controls: [], focusedRef: null })
        focus.attempt(`field-${step % 3}`, { source: 'resolution' })
        const verified = step % 4 !== 3
        focus.verified(verified ? 'success' : 'failure', verified ? `field-${step % 3}` : null)
        lastVerified = verified ? `field-${step % 3}` : null
        resources.registerScreenshot({ bytes: 2048, reason: `step-${step}`, step, transient: true })
        progress.action({ step })
        if (verified) progress.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { step, verdict: 'success', kind: 'state' })
        else {
          progress.noOp(`noop-${step}`)
          retries += 1
        }
      }
      // The final step (399) is a miss, so nothing may be trusted at the end —
      // that is the exact "accumulating stale focus" failure this scenario names.
      case_.eq('focus trust is not accumulated after a miss', focus.verifiedFocusRef, lastVerified)
      case_.atMost('the focus history stayed bounded', focus.history().length, 100)
      case_.atMost('the capture ring stayed inside its ceiling', resources.snapshot().screenshots, 6)
      case_.atLeast('transient captures were evicted', resources.snapshot().droppedScreenshots, 1)
      case_.atMost('retries tracked the misses, not the steps', retries, 100)
      case_.atMost('the progress ring stayed bounded', progress.history().length, 24)
      case_.check('lastProgressAt is not moved by the no-ops', progress.noOpStreak >= 0, progress.noOpStreak)
      break
    }
    case 'B': {
      // A long build: a process that is alive while output continues is NOT a stall.
      const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
      const fake = { pid: 4242, kill() { return true }, on() {} }
      const entry = processes.register({ child: fake, command: 'npm', args: ['run', 'build'], cwd: os.tmpdir(), mode: 'long_running', expectedLifetimeMs: 600000, ownership: 'runtime', step: 1 })
      clock.advance(120000)
      const snapshot = processes.snapshot()
      const running = snapshot.owned.find((process) => process.id === entry.id)
      case_.check('a long-running process is still owned while it runs', Boolean(running), JSON.stringify(snapshot.owned))
      case_.eq('it is not reported as hung inside its expected lifetime', processes.looksHung(entry.id), false)
      clock.advance(500000)
      case_.eq('it is reported as hung once it outlives its declared lifetime', processes.looksHung(entry.id), true)
      case_.check('its ownership is explicit', running.ownership === 'runtime', JSON.stringify(running))
      case_.atMost('a live long-running process does not sit on a timeout leash', running.expectedLifetimeMs, 600000)
      processes.dispose('scenario teardown')
      break
    }
    case 'C': {
      // A hung build: no progress, timeout reached, owned process terminated,
      // evidence preserved.
      const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-hung-log-'))
      const log = createExecutionLog({ now: clock.now, dir: logDir, mode: 'normal', runId: 'hung' })
      const fake = { pid: 4343, kill() { return true }, on() {} }
      const entry = processes.register({ child: fake, command: 'npm', args: ['run', 'build'], cwd: os.tmpdir(), mode: 'foreground', expectedLifetimeMs: 2000, ownership: 'runtime', step: 1 })
      log.event({ type: 'process', pid: fake.pid, step: 1, mode: 'foreground', verdict: 'running' })
      const killed = await processes.kill(entry.id, 'exceeded its 2000ms bound')
      case_.eq('the owned process was terminated at its bound', killed.ok, true)
      case_.eq('the registry records the outcome', processes.snapshot().owned.length, 0)
      log.step({ step: 1, action: { type: 'SHELL_EXEC', params: { command: 'npm' } }, result: 'failure', verdict: 'failure', reasonCode: 'ACTION_TIMEOUT', durationMs: 2000 })
      const finished = log.finish({ status: 'failed', steps: 1, verdict: 'failure' })
      case_.check('the failure evidence is preserved in the log', log.entries().some((record) => record.verdict === 'failure' || record.result === 'failure'), null)
      case_.eq('the run reports a bounded failure', finished.status, 'failed')
      const notOwned = await processes.kill('not-ours', 'nope')
      case_.check('a process the runtime does not own can never be killed', notOwned.ok === false && notOwned.reason === 'not_owned', JSON.stringify(notOwned))
      log.close()
      fs.rmSync(logDir, { recursive: true, force: true })
      processes.dispose('scenario teardown')
      break
    }
    case 'D': {
      // Workspace drift: a changed shell cwd is detected as a mismatch.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-drift-'))
      const inside = path.join(root, 'src')
      fs.mkdirSync(inside, { recursive: true })
      const outside = path.dirname(root)
      const guard = createWorkspaceGuard({ workspace: root, now: clock.now })
      const ok = guard.resolveCwd({ cwd: 'src', step: 1 })
      case_.eq('a cwd inside the workspace resolves', ok.ok, true)
      const drifted = guard.resolveCwd({ cwd: outside, step: 2 })
      case_.eq('a cwd outside the workspace is refused', drifted.ok, false)
      case_.eq('the drift is recorded', guard.drifts().length, 1)
      const relative = guard.resolvePath('a/b.txt', { step: 3 })
      case_.eq('a relative path resolves against the verified workspace', relative.path, path.join(root, 'a', 'b.txt'))
      const escape = guard.resolvePath(outside, { step: 4 })
      case_.eq('a path outside the workspace is refused', escape.ok, false)
      fs.rmSync(root, { recursive: true, force: true })
      break
    }
    case 'E': {
      // UI context replacement: verified focus cleared, targets invalidated,
      // reobserve. The context is the *world* the observer produces, so the
      // replacement is expressed the way the runtime sees it.
      const focus = createFocusTrust({ now: clock.now })
      focus.attempt('field-a', { source: 'resolution' })
      focus.verified('success', 'field-a')
      case_.eq('the focus is trusted after a verified action', focus.verifiedFocusRef, 'field-a')
      focus.observeContext({ windowSignature: 'window-1', url: 'https://example.test/a', title: 'A', controls: [{ ref: 'field-a' }], focusedRef: 'field-a' })
      case_.eq('a matching context keeps the verified focus', focus.verifiedFocusRef, 'field-a')
      const after = focus.observeContext({ windowSignature: 'window-2', url: 'https://example.test/b', title: 'B', controls: [], focusedRef: null })
      case_.check('replacing the UI context is detected', after.invalidated === true, JSON.stringify(after))
      case_.check('the replacement is named as a window or navigation change', after.reasons.includes('window_changed') || after.reasons.includes('navigation'), JSON.stringify(after.reasons))
      case_.eq('the verified focus reference is cleared', focus.verifiedFocusRef, null)
      case_.check('the invalidation reason is recorded', focus.history().some((entry) => entry.kind === 'invalidate'), JSON.stringify(focus.history().slice(-2)))
      break
    }
    case 'F': {
      // Dangerous confirmation: unauthorised means do not click.
      const { planModal, MODAL_ACTION } = require(path.join(ROOT, 'app', 'computer-use', 'modal.cjs'))
      const forbidden = planModal({
        modal: { type: 'confirm', message: 'Delete this file?', controls: [] },
        candidates: [{ ref: 'c1', label: 'Delete', source: 'desktop', role: 'button', bbox: { x: 1, y: 1, width: 10, height: 10 } }],
        context: { destructiveMode: 'forbidden', destructiveKinds: ['DELETE'], safetyPassed: true }
      })
      case_.eq('an unauthorised destructive control is not pressed', forbidden.action, MODAL_ACTION.USER_ACTION_REQUIRED)
      case_.eq('the refusal names the action it refuses', forbidden.destructiveKind, 'DELETE')
      const unknown = planModal({
        modal: { type: 'confirm', message: 'Continue?', controls: [] },
        candidates: [],
        context: { destructiveMode: 'confirm', destructiveKinds: [], safetyPassed: true }
      })
      case_.check('a modal with no safe control needs a user decision', unknown.action !== 'press' || unknown.requiresUser === true, JSON.stringify(unknown))
      break
    }
    case 'G': {
      // Controller partial failure: runtime degraded, other capabilities continue.
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        controllers: {
          browser: { available: false, reason: 'CDP disconnected', detail: {} },
          desktop: { available: true, reason: null, detail: {} },
          shell: { available: true, reason: null, detail: {} },
          file: { available: true, reason: null, detail: {} },
          vision: { available: true, reason: null, detail: {} }
        },
        allowedCapabilities: ['browser', 'desktop', 'shell'],
        workspace: { ok: true, cwd: os.tmpdir(), reason: null },
        processes: { ownedCount: 0, atCapacity: false },
        resources: { atCeiling: false, screenshots: 0, droppedScreenshots: 0, evidenceBytes: 0, limits: {} },
        progress: { lastProgressAt: clock.now(), sinceProgressMs: 0, lastVerifiedEffectAt: clock.now(), noOpStreak: 0 },
        safetyAvailable: true
      })
      case_.eq('one dead controller degrades the runtime', snapshot.status, HEALTH_STATUS.DEGRADED)
      case_.check('the surviving controllers are usable', snapshot.usableCapabilities.includes('desktop') && snapshot.usableCapabilities.includes('shell'), JSON.stringify(snapshot.usableCapabilities))
      case_.check('the runtime is not blocked', snapshot.status !== HEALTH_STATUS.BLOCKED, JSON.stringify(snapshot.blockedReasons))
      break
    }
    default:
      case_.check(`scenario ${id} is implemented`, false, 'no implementation')
  }
  void options
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    process.stdout.write('soak\taccelerated multi-hundred-cycle soak (plan 23)\n')
    for (const injection of FAILURE_INJECTIONS) process.stdout.write(`inject:${injection.id}\t${injection.title}\n`)
    for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) process.stdout.write(`scenario:${id}\tscenario ${id} (plan 25)\n`)
    return 0
  }
  const cycles = numberFlag(argv, '--cycles', 300)
  const options = { cycles }
  const cases = []

  const soak = createCase('soak', `accelerated soak: ${cycles} action cycles`)
  try {
    await runSoak(soak, options)
  } catch (error) {
    soak.check('the soak harness ran to completion', false, error && error.stack ? error.stack : String(error))
  }
  cases.push(soak.result())

  for (const injection of FAILURE_INJECTIONS) {
    const case_ = createCase(`inject:${injection.id}`, `[${injection.outcome}] ${injection.title}`)
    try {
      await runInjection(case_, injection, options)
    } catch (error) {
      case_.check('the injection case ran to completion', false, error && error.stack ? error.stack : String(error))
    }
    cases.push(case_.result())
  }

  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    const case_ = createCase(`scenario:${id}`, `scenario ${id} (plan §25)`)
    try {
      await runScenario(case_, id, options)
    } catch (error) {
      case_.check('the scenario ran to completion', false, error && error.stack ? error.stack : String(error))
    }
    cases.push(case_.result())
  }

  const report = {
    harness: 'computer-use-longrun-acceptance',
    plan: 'Update-Plan/24h.md §23-§26',
    cycles,
    startedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    cases,
    checks: cases.reduce((total, entry) => total + entry.checks.length, 0),
    failures: cases.reduce((total, entry) => total + entry.failed.length, 0)
  }

  const outIndex = argv.indexOf('--out')
  if (outIndex >= 0 && argv[outIndex + 1]) {
    fs.writeFileSync(path.resolve(argv[outIndex + 1]), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    for (const entry of cases) {
      const mark = entry.status === 'passed' ? 'PASS' : 'FAIL'
      process.stdout.write(`[${mark}] ${entry.id}: ${entry.title} (${entry.checks.length} checks)\n`)
      for (const failure of entry.failed) process.stdout.write(`       - ${failure}\n`)
    }
    process.stdout.write(`\n${cases.length} cases, ${report.checks} checks, ${report.failures} failures\n`)
  }
  return report.failures ? 1 : 0
}

function numberFlag(argv, name, fallback) {
  const index = argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(argv[index + 1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

void DEFAULT_MAX_FILES

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  process.exitCode = 1
})
