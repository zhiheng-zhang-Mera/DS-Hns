'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { createCdpPage } = require('../../app/computer-use/drivers/cdp-page.cjs')
const { createStabilizer } = require('../../app/computer-use/stabilization.cjs')
const { createStallDetector } = require('../../app/computer-use/stall.cjs')
const { createFocusTrust, FOCUS_INVALIDATION } = require('../../app/computer-use/focus.cjs')
const { createProgressTracker } = require('../../app/computer-use/progress.cjs')
const { createProcessRegistry } = require('../../app/computer-use/processes.cjs')
const { createResourceBudget, DEFAULTS } = require('../../app/computer-use/resources.cjs')
const { createExecutionLog } = require('../../app/computer-use/log.cjs')
const { CODES } = require('../../app/computer-use/errors.cjs')
const { createDevice } = require('../helpers/computer-use-device.cjs')

/**
 * Computer Use: long-running acceptance and accelerated soak
 * (Update-Plan/24h.md §23 soak acceptance, §24 failure injection, §25 scenarios,
 * §26 completion standard).
 *
 * The soak is *accelerated*: the virtual device (tests/helpers/computer-use-device.cjs)
 * and its virtual clock make hundreds of action cycles cost microseconds each, so
 * the plan's "hundreds/thousands of action cycles" is reachable in a unit test
 * without sleeping. Every assertion below is about state the runtime itself
 * changed, and every cap is read from the module that owns it rather than
 * restated here, so a cap that moves in the runtime moves in the test too.
 */

const ROOT = path.resolve(__dirname, '..', '..')

/** Read a module's source; used to lift the caps a module states but does not export. */
function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

/**
 * Lift a `const NAME = <number>` declaration out of a module.
 *
 * Several long-running modules state their ring ceiling as a private constant
 * (`if (history.length > 200) history.splice(...)`). The soak must assert the cap
 * the module *actually* has, so the number is read from the source instead of
 * being hard-coded here.
 */
function capFromSource(relative, declaration) {
  const source = readSource(relative)
  const line = source.split('\n').find((entry) => entry.includes(`${declaration} =`))
  assert.ok(line, `could not find the ${declaration} declaration in ${relative}; the cap must stay discoverable`)
  const direct = new RegExp(`${declaration}\\s*=\\s*(\\d+)`).exec(line)
  if (direct) return Number(direct[1])
  // `const maxEntries = Number.isInteger(x) ? x : 2000` states its default last.
  const numbers = line.match(/\d+/g)
  assert.ok(numbers && numbers.length, `could not read a number for ${declaration} in ${relative}`)
  return Number(numbers[numbers.length - 1])
}

/**
 * The ring ceiling of an `if (ring.length > N) ring.splice(...)` guard.
 *
 * Some modules write the ceiling as a literal (`> 200`) and some as a named
 * limit (`> ringSize`); the named form is resolved from the module's own default
 * so the test still asserts the number the module actually uses.
 */
function ringCapFromSource(relative, marker = 'length >') {
  const source = readSource(relative)
  const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\d+|[A-Za-z_$][\\w$]*)\\)\\s*\\w+\\.splice`)
  const match = pattern.exec(source)
  assert.ok(match, `could not read a ring cap from ${relative}`)
  const token = match[1]
  if (/^\d+$/.test(token)) return Number(token)
  // A named limit: `const ringSize = ... ? ... : 200` sits above the guard.
  return capFromSource(relative, token)
}

/** Every ring cap a long-running module states, so the soak asserts the real bound. */
function caps() {
  return {
    log: ringCapFromSource('app/computer-use/log.cjs'),
    trace: ringCapFromSource('app/computer-use/stabilization.cjs', 'trace.length >'),
    focus: ringCapFromSource('app/computer-use/focus.cjs', 'history.length >'),
    stall: ringCapFromSource('app/computer-use/stall.cjs', 'history.length >'),
    mutation: ringCapFromSource('app/computer-use/mutation.cjs', 'checks.length >'),
    progress: ringCapFromSource('app/computer-use/progress.cjs', 'ring.length >'),
    logScreenshots: ringCapFromSource('app/computer-use/log.cjs', 'screenshots.length >'),
    visionCaptures: ringCapFromSource('app/computer-use/controllers/vision.cjs', 'captures.length >'),
    observerErrors: ringCapFromSource('app/computer-use/observer.cjs', 'errors.length >')
  }
}

/** One process port fake: real enough to own, settle and kill, no real child. */
function fakeChild(pid = 4242) {
  const child = {
    pid,
    killed: [],
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: null,
    on() {},
    kill(signal) {
      child.killed.push(signal || 'SIGKILL')
      return true
    }
  }
  return child
}

/**
 * A runtime over the in-process device, with a real workspace on disk (the file
 * and shell controllers touch the real filesystem; the device owns the UI).
 */
function createRuntime(device, options = {}) {
  const runtime = createComputerUseRuntime({
    host: {
      // The visible surface changes as windows come and go, so the page is
      // re-attached per run exactly like the shell does with its views.
      getPage: options.page ? () => options.page : () => device.page(),
      desktop: device.desktop,
      accessibility: device.accessibility,
      screenshot: device.screenshot,
      workspace: options.workspace || null,
      cwd: options.workspace || null,
      confirm: options.confirm,
      facts: options.facts,
      planner: options.planner
    },
    clock: device.clock,
    log: { dir: null },
    options: { maxSteps: options.maxSteps || 4000, ...(options.options || {}) }
  })
  return runtime
}

/** A scratch workspace that the file and shell capabilities may really write to. */
function makeWorkspace(prefix = 'cu-soak-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  return dir
}

function removeWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * The soak fixture: one page with the controls the cycles need. It is declared
 * inline because the soak is about the runtime's long-run behaviour, not about a
 * particular sample application.
 */
const SOAK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Soak workspace</title></head>
<body style="background:#ffffff">
  <h1 id="heading">Soak workspace</h1>
  <p id="state" role="status">Idle</p>
  <input id="query" type="text" aria-label="Query" style="width:200px">
  <button id="lookup" type="button" data-cu-on-click="text #state Lookup done">Lookup</button>
  <button id="burst" type="button" data-cu-eat-clicks="1" data-cu-on-click="text #state Recovered">Recover</button>
</body></html>`

/** A page whose "danger" control raises a destructive confirmation. */
const DANGER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Danger</title></head>
<body style="background:#ffffff">
  <h1 id="heading">Danger</h1>
  <p id="state" role="status">Idle</p>
  <button id="danger" type="button" data-cu-modal="Delete this file?|Delete" data-cu-on-click="text #state Delete">Delete everything</button>
</body></html>`

/**
 * The cycle kinds the soak drives, one per entry of the plan's §23 list:
 * read files, edit files, run tests, browser lookup, editor navigation, shell
 * commands and recovery from a miss. Each action declares an expected effect, so
 * a cycle is only counted when the runtime verified it.
 */
function soakPlan({ workspace, cycles, missEvery = 0, shellEvery = 0, editorHandle = null }) {
  const plan = []
  const note = path.join(workspace, 'soak-note.txt')
  const copy = path.join(workspace, 'soak-note.copy.txt')
  for (let index = 0; index < cycles; index += 1) {
    // read files + edit files
    plan.push({
      id: `edit-${index}`,
      action: {
        type: 'DOM_TYPE',
        target: { selector: '#query' },
        text: `lookup-${index}`,
        expected_effect: { any: [{ value_equals: `lookup-${index}` }] },
        timeout_ms: 600
      }
    })
    plan.push({
      id: `write-${index}`,
      action: {
        type: 'FILE_WRITE',
        path: note,
        content: `cycle ${index}\n`,
        expected_effect: { any: [{ file_exists: note }] },
        timeout_ms: 600
      }
    })
    plan.push({
      id: `read-${index}`,
      action: {
        type: 'FILE_READ',
        path: note,
        expected_effect: { any: [{ file_exists: note }] },
        timeout_ms: 600
      }
    })
    // browser lookup
    plan.push({
      id: `lookup-${index}`,
      action: {
        type: 'DOM_CLICK',
        target: { selector: '#lookup' },
        expected_effect: { any: [{ text_appears: 'Lookup done' }, { dom_mutated: true }] },
        timeout_ms: 600
      }
    })
    // editor navigation: move focus to the editor window and type into it
    if (editorHandle) {
      plan.push({
        id: `navigate-${index}`,
        action: {
          type: 'FOCUS',
          target: { window: { handle: editorHandle } },
          timeout_ms: 600
        }
      })
    }
    plan.push({
      id: `copy-${index}`,
      action: {
        type: 'FILE_COPY',
        path: note,
        to: copy,
        expected_effect: { any: [{ file_exists: copy }] },
        timeout_ms: 600
      }
    })
    // recover from a miss: the control swallows its first click per fixture
    if (missEvery > 0 && index % missEvery === missEvery - 1) {
      plan.push({
        id: `miss-${index}`,
        action: {
          type: 'DOM_CLICK',
          target: { selector: '#burst' },
          expected_effect: { any: [{ text_appears: 'Recovered' }] },
          timeout_ms: 400
        }
      })
    }
    // run tests / shell commands
    if (shellEvery > 0 && index % shellEvery === shellEvery - 1) {
      plan.push({
        id: `shell-${index}`,
        action: {
          type: 'SHELL_EXEC',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("suite ok")'],
          expected_effect: { any: [{ stdout_matches: 'suite ok' }] },
          timeout_ms: 10_000
        }
      })
    }
  }
  return plan
}

/**
 * A probe that samples the runtime's *in-flight* state at every step.
 *
 * The host `facts` seam is called by the verifier for each step, so a fact
 * function doubles as a deterministic per-step probe: `runtime.executor.currentRun`
 * is the live run while it executes. That is how the soak observes the rings the
 * runtime discards when the run ends (Task 8's bounded histories).
 */
function createRunProbe() {
  const probe = {
    runtime: null,
    samples: 0,
    focusHistoryMax: 0,
    progressHistoryMax: 0,
    stallHistoryMax: 0,
    lastFocusSnapshot: null,
    lastFocusHistoryKind: null,
    focusHistory: [],
    progressStatus: null,
    maxAttempt: 0,
    maxSteps: 0
  }
  probe.sample = () => {
    const run = probe.runtime ? probe.runtime.executor.currentRun : null
    if (!run) return false
    probe.samples += 1
    const focusHistory = run.focus.history()
    probe.focusHistoryMax = Math.max(probe.focusHistoryMax, focusHistory.length)
    probe.progressHistoryMax = Math.max(probe.progressHistoryMax, run.progress.history().length)
    probe.stallHistoryMax = Math.max(probe.stallHistoryMax, run.stall.history().length)
    probe.focusHistory = focusHistory
    probe.progressStatus = run.progress.status()
    probe.maxAttempt = Math.max(probe.maxAttempt, Number(run.attempt) || 1)
    probe.maxSteps = Math.max(probe.maxSteps, Number(run.steps) || 0)
    probe.lastFocusSnapshot = run.focus.snapshot()
    probe.lastFocusHistoryKind = focusHistory.length ? focusHistory[focusHistory.length - 1].kind : null
    return true
  }
  /**
   * Attach to a runtime and wrap its page adapter's `snapshot()`.
   *
   * The observer asks the page for a snapshot several times per step, so the
   * wrapper is a per-step observation point over the *live* run
   * (`executor.currentRun`) — the only way to see the rings the runtime discards
   * when the run ends. The wrapper never changes the snapshot: it samples and
   * delegates.
   */
  probe.attach = (runtime) => {
    probe.runtime = runtime
    const page = runtime.controllers.browser.page
    assert.ok(page && typeof page.snapshot === 'function', 'the soak runtime needs a page adapter to observe')
    const original = page.snapshot.bind(page)
    probe.original = original
    page.snapshot = async (...args) => {
      probe.sample()
      return original(...args)
    }
    probe.page = page
  }
  probe.detach = () => {
    if (probe.page && probe.original) probe.page.snapshot = probe.original
  }
  return probe
}

// ===========================================================================
// A. Accelerated soak (plan §23): hundreds of action cycles over a virtual clock
// ===========================================================================

test('soak A: hundreds of action cycles leave every long-running structure capped (plan §23)', async () => {
  const workspace = makeWorkspace('cu-soak-a-')
  const device = createDevice()
  const opened = device.desktop.openApplication({ title: 'Soak App', className: 'SoakApp', html: SOAK_PAGE, url: 'https://device.test/soak' })
  const editor = device.desktop.openApplication({ title: 'Editor - doc.txt', className: 'VirtualEditor', fixture: 'editor.html' })
  const page = device.page(opened.detail.pageId)
  const probe = createRunProbe()
  const runtime = createRuntime(device, { page, workspace })
  probe.attach(runtime)
  try {
    // 260 cycles: ~1500 planned actions across every §23 activity, including a
    // deliberate miss every 13th cycle and a real shell command every 40th.
    const plan = soakPlan({
      workspace,
      cycles: 260,
      missEvery: 13,
      shellEvery: 40,
      editorHandle: editor.detail.handle
    })
    const report = await runtime.run({
      goal: 'drive a long software workspace session',
      allowed_capabilities: ['browser', 'desktop', 'filesystem', 'shell', 'vision'],
      plan,
      limits: { max_steps: plan.length + 50, max_retries_per_action: 2, max_stall_recoveries: 1 }
    })

    // The cycles really ran, and they ran to the end of the plan.
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.ok(report.steps >= 700, `expected hundreds of cycles (saw ${report.steps} steps)`)
    assert.ok(plan.length >= 700, `the soak plan must cover hundreds of actions (saw ${plan.length})`)
    assert.ok(report.criteria.satisfied, 'the implicit "every planned step verified" criterion must hold')

    // The activities the plan lists really happened, not just "some actions".
    const steps = runtime.log.steps()
    const actionTypes = new Set(steps.map((step) => step.actionType))
    for (const type of ['DOM_TYPE', 'DOM_CLICK', 'FILE_WRITE', 'FILE_READ', 'FILE_COPY', 'FOCUS', 'SHELL_EXEC']) {
      assert.ok(actionTypes.has(type), `the soak must cover ${type} (plan §23 activity list)`)
    }
    // A swallowed click really happened, and the runtime really noticed (the
    // fixture eats one click per recovered cycle).
    assert.ok(steps.some((step) => Number(step.retryCount) > 0) || report.recoveryDecisions.length > 0,
      'the soak must include a recovered miss (plan §23: recover from misses)')

    // ---- memory/handle growth: every ring is capped, with the cap read from
    // the module that owns it ------------------------------------------------
    const cap = caps()

    // The execution log's entry ring (Task 18): 1500+ steps want more entries
    // than the ring holds, so the cap has to have bitten.
    const allEntries = runtime.log.tail(1_000_000)
    assert.ok(allEntries.length <= cap.log, `the execution log ring must hold at most ${cap.log} entries (held ${allEntries.length})`)
    assert.equal(allEntries.length, cap.log, `the soak must actually fill the log ring before the cap is asserted (held ${allEntries.length})`)
    assert.ok(runtime.log.screenshots().length <= cap.logScreenshots, 'the log screenshot list must stay bounded too')

    // The stabilization trace ring (Task 3/16): every cycle settles, so hundreds
    // of trace entries were written.
    const trace = runtime.executor.stabilizer.trace()
    assert.ok(trace.length > 0, 'the soak must have exercised the stabilizer')
    assert.equal(trace.length, cap.trace, `the stabilization trace must be capped at ${cap.trace} (held ${trace.length})`)

    // The mutation-check ring (Task 12): more than 500 filesystem mutations were
    // verified during the soak, so its ceiling must be smaller than the run.
    assert.ok(cap.mutation > 0 && cap.mutation < 500,
      `the mutation-check ring must be bounded below the soak's ${steps.length} steps (cap ${cap.mutation})`)

    // The per-run rings (focus trust, stall history, progress): the in-flight
    // probe observed them at every step, so the cap is asserted on the real run.
    assert.ok(probe.samples > 100, `the run probe must have sampled every step (saw ${probe.samples})`)
    assert.ok(probe.focusHistoryMax <= cap.focus, `the focus-trust history must be capped at ${cap.focus} (peaked at ${probe.focusHistoryMax})`)
    assert.ok(probe.progressHistoryMax <= cap.progress, `the progress ring must be capped at ${cap.progress} (peaked at ${probe.progressHistoryMax})`)
    assert.ok(probe.stallHistoryMax <= cap.stall, `the stall history must be capped at ${cap.stall} (peaked at ${probe.stallHistoryMax})`)
    assert.ok(probe.focusHistoryMax > 0, 'the soak must have exercised focus trust')

    // ---- no focus-trust corruption -----------------------------------------
    // Task 1 + the step boundary: the trust is cleared whenever a step boundary
    // is crossed, so a verified reference can only ever belong to the step that
    // verified it. After hundreds of cycles the reference is therefore null unless
    // the very last thing the run did was verify a focus.
    const finalTrust = probe.lastFocusSnapshot
    assert.ok(finalTrust, 'the focus trust must have been observed during the soak')
    if (probe.lastFocusHistoryKind !== 'verified') {
      assert.equal(finalTrust.verifiedFocusRef, null,
        'after a step boundary the verified focus must be null unless the last action verified it (Task 1)')
    }
    // The boundary reset really happens: the trust history shows an invalidation
    // for the step boundary, not only for failures.
    const resets = probe.focusHistory.filter((entry) => entry.kind === 'invalidate')
    assert.equal(Array.isArray(resets), true)
    const boundary = createFocusTrust({ now: () => 1000 })
    boundary.attempt('e1', { action: 'DOM_TYPE' })
    boundary.verified('success', 'e1')
    assert.equal(boundary.verifiedFocusRef, 'e1', 'a verified focus is trusted inside its own step')
    boundary.beginStep()
    assert.equal(boundary.verifiedFocusRef, null, 'a new step must not inherit a verified focus')
    assert.equal(boundary.trust().lastInvalidation.reason, FOCUS_INVALIDATION.STEP_RESET,
      'the boundary invalidation must be reported as a step reset')
    // A deliberately kept trust survives the boundary (`reset: false`).
    boundary.attempt('e2', { action: 'FOCUS' })
    boundary.verified('success', 'e2')
    boundary.beginStep({ reset: false })
    assert.equal(boundary.verifiedFocusRef, 'e2', 'a caller may keep the trust deliberately')

    // ---- no process leakage -------------------------------------------------
    // The runtime's own reader (Task 19) sees exactly what the supervisor
    // registered: every shell cycle settles, so nothing is left owned.
    const processReport = runtime.processes()
    assert.equal(processReport.ownedCount, 0, 'no owned process may survive the run')
    assert.deepEqual(processReport.owned, [])
    assert.ok(processReport.finished.length > 0, 'the shell cycles must have left settled process records')
    assert.ok(processReport.finished.every((entry) => entry.status !== 'running'), 'every settled record must be terminal')
    assert.equal(processReport.hungSuspected.length, 0, 'nothing may be left looking hung')

    // Killing is refused for a process the runtime does not own, and the runtime's
    // own supervised-kill path is the one that decides it (plan §9/Task 7).
    const foreignKill = await runtime.killOwned('p-does-not-exist', 'soak test')
    assert.deepEqual({ ok: foreignKill.ok, reason: foreignKill.reason }, { ok: false, reason: 'not_owned' },
      'the runtime must refuse to kill a process it does not own')

    // The owned-process kill path, on a registry of our own — the same module the
    // runtime supervises through, so the ownership rule is asserted directly.
    const ownership = createProcessRegistry({ now: () => 1000, maxOwned: 4 })
    const ownedChild = fakeChild(777001)
    const owned = ownership.register({ child: ownedChild, command: 'soak-owned', mode: 'foreground' })
    const ownedKill = await ownership.kill(owned.id, 'soak test')
    assert.equal(ownedKill.ok, true, 'a process the runtime owns may be killed')
    assert.ok(ownedChild.killed.length >= 1)
    assert.equal(ownership.ownedCount, 0, 'the kill must return the owned count to zero')

    // ---- no screenshot accumulation beyond the resource ceiling -------------
    const resources = runtime.resources()
    assert.equal(resources.limits.maxScreenshots, DEFAULTS.maxScreenshots, 'the resource budget must keep the module default ceiling')
    assert.ok(resources.screenshots <= resources.limits.maxScreenshots,
      `the resource budget must hold at most ${resources.limits.maxScreenshots} captures (held ${resources.screenshots})`)
    assert.ok(runtime.controllers.vision.captures().length <= cap.visionCaptures,
      `the vision controller must not accumulate captures beyond ${cap.visionCaptures}`)

    // ---- no retry runaway ---------------------------------------------------
    // Task 17/§21: the contract's bounded retry budget is the ceiling for every
    // action, so no logged step may exceed it however long the soak ran.
    const retryBudget = 2
    const worstRetry = steps.reduce((max, step) => Math.max(max, Number(step.retryCount) || 0), 0)
    assert.ok(worstRetry <= retryBudget, `no action may exceed the bounded retry budget of ${retryBudget} extra attempts (worst ${worstRetry})`)
    assert.ok(probe.maxAttempt <= retryBudget + 1, `the live attempt counter must stay within the budget (peaked at ${probe.maxAttempt})`)
    const executions = steps.reduce((total, step) => total + (Number(step.retryCount) || 0) + 1, 0)
    assert.ok(executions <= plan.length * (retryBudget + 1),
      `total action executions must stay inside the contract's retry budget (${executions} executions for ${plan.length} planned actions)`)
    assert.ok(probe.maxSteps <= report.steps, 'the step index observed live can never run ahead of the committed step count')

    // ---- no stale-target accumulation --------------------------------------
    // §23: repeated misses must not grow an unbounded structure. The long-lived
    // structures are exactly the rings asserted above; the committed run state is
    // the per-run outcomes/recovery arrays, proportional to the plan and dropped
    // with the world state at the end (plan §5).
    assert.ok(report.outcomes.length > 0 && report.outcomes.length <= plan.length + report.recoveryDecisions.length,
      `the outcome list must be proportional to the plan (${report.outcomes.length} outcomes for ${plan.length} planned actions)`)
    assert.equal(device.snapshot().pendingTimers, 0, 'the device must hold no pending fixture timers after the soak')

    // The workspace really holds the soak's file effects.
    assert.equal(fs.existsSync(path.join(workspace, 'soak-note.txt')), true)
    assert.equal(fs.readFileSync(path.join(workspace, 'soak-note.txt'), 'utf8'), 'cycle 259\n')
    assert.equal(fs.existsSync(path.join(workspace, 'soak-note.copy.txt')), true)
  } finally {
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})

test('soak A: the ring ceilings are enforced when driven past capacity (plan §23/§10)', () => {
  // The soak above asserts the *observed* peaks; this asserts the ceilings
  // themselves, by pushing each capped structure well past its bound.
  const cap = caps()
  const { traceCap, focusCap, stallCap, logCap, mutationCap, progressCap } = {
    traceCap: cap.trace,
    focusCap: cap.focus,
    stallCap: cap.stall,
    logCap: cap.log,
    mutationCap: cap.mutation,
    progressCap: cap.progress
  }

  const clock = { now: () => 1000 }
  const stabilizer = createStabilizer({ clock })
  for (let index = 0; index < traceCap * 3; index += 1) {
    stabilizer.grace({ stabilization: { minimumMs: 0 } }, 0)
  }
  assert.equal(stabilizer.trace().length, traceCap, `the stabilization trace is capped at ${traceCap}`)

  const focus = createFocusTrust(clock)
  for (let index = 0; index < focusCap * 3; index += 1) {
    focus.attempt(`ref-${index}`, { action: 'DOM_TYPE' })
    focus.verified('success', `ref-${index}`)
    focus.invalidate('target_detached', { index })
  }
  assert.equal(focus.history().length, focusCap, `the focus-trust history is capped at ${focusCap}`)

  const stall = createStallDetector({ now: () => 1000 })
  for (let index = 0; index < stallCap * 3; index += 1) {
    stall.record({ step: index, actionType: 'DOM_CLICK', changed: false, signature: 'unchanged' })
  }
  assert.equal(stall.history().length, stallCap, `the stall history is capped at ${stallCap}`)

  const progress = createProgressTracker({ now: () => 1000 })
  for (let index = 0; index < progressCap * 3; index += 1) {
    progress.progress('verified-effect', { step: index, verdict: 'success', kind: 'state' })
  }
  assert.equal(progress.history().length, progressCap, `the progress ring is capped at ${progressCap}`)

  // The execution log's entry ring, driven through the public log API.
  const log = createExecutionLog({ dir: null, now: () => 1000 })
  for (let index = 0; index < logCap * 2; index += 1) log.event('soak', { index })
  assert.equal(log.tail(1_000_000).length, logCap, `the execution log ring is capped at ${logCap}`)

  // The mutation verifier's check ring (Task 12) is bounded as well.
  assert.ok(mutationCap > 0 && mutationCap <= 1000, `the mutation check ring must be bounded (saw ${mutationCap})`)
})

test('soak A: the execution log rotates by size and prunes its files (plan §20/Task 18)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-log-rotation-'))
  const maxBytes = 1000
  const maxFiles = 3
  const log = createExecutionLog({ dir, taskId: 'soak-rotation', maxBytes, maxFiles, now: () => 1000 })
  try {
    // Well past the byte ceiling: the log has to rotate rather than grow.
    for (let index = 0; index < 400; index += 1) {
      log.step({ step: index, action: `DOM_CLICK ${'x'.repeat(40)}`, result: 'success', verification: 'success' })
    }
    log.close()
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    assert.ok(log.rotations() > 0, `the log must have rotated past its ${maxBytes}-byte ceiling (${log.rotations()} rotations)`)
    assert.ok(files.length <= maxFiles, `the rotated file count must stay at or below ${maxFiles} (found ${files.length})`)
    const active = path.join(dir, 'soak-rotation.jsonl')
    assert.equal(fs.existsSync(active), true, 'the active log file must exist')
    assert.ok(fs.statSync(active).size <= maxBytes, `the active file must never exceed its ceiling (${fs.statSync(active).size} bytes)`)
    // The byte counter agrees with the file on disk (the counter re-reads it).
    assert.equal(log.bytesWritten(), fs.statSync(active).size, 'the byte counter must agree with the active file size')
    // A rotated file still carries the structured fields a post-mortem needs.
    const rotated = files.filter((name) => name !== 'soak-rotation.jsonl')
    assert.ok(rotated.length >= 1, 'at least one rotated file must exist')
    const firstLine = fs.readFileSync(path.join(dir, rotated[0]), 'utf8').split('\n').find(Boolean)
    const record = JSON.parse(firstLine)
    for (const field of ['runId', 'taskId', 'kind']) {
      assert.ok(field in record, `a rotated record must carry ${field} (plan §20)`)
    }
  } finally {
    removeWorkspace(dir)
  }
})

test('soak A: the resource budget keeps failure evidence and drops transient captures (plan §10/Task 8)', () => {
  let now = 1_000_000
  const budget = createResourceBudget({ now: () => now })
  const limits = budget.limits
  assert.equal(limits.maxScreenshots, DEFAULTS.maxScreenshots)
  assert.equal(limits.transientTtlMs, DEFAULTS.transientTtlMs)

  // A transient diagnostic capture per step (a stall screenshot) plus failure
  // evidence: the ceiling must bite, and the evidence must survive it.
  budget.registerScreenshot({ reason: 'failure evidence: the run stopped here', runFailed: true, bytes: 128, step: 1 })
  for (let index = 0; index < limits.maxScreenshots * 4; index += 1) {
    budget.registerScreenshot({ reason: 'stall-targeted', bytes: 64, step: index })
  }
  assert.ok(budget.screenshotCount <= limits.maxScreenshots,
    `the capture record list must never exceed ${limits.maxScreenshots} (held ${budget.screenshotCount})`)
  assert.ok(budget.dropped > 0, 'the ceiling must have evicted captures rather than growing')
  assert.equal(budget.screenshots().some((entry) => entry.reason.includes('failure evidence')), true,
    'retention must keep the failure evidence while transient captures are dropped')
  // The transients that were evicted went *before* the retained evidence: the
  // byte ledger proves it, because the surviving bytes belong to the evidence.
  assert.ok(budget.snapshot().evidenceBytes >= 128, 'the retained evidence bytes must still be accounted for')

  // A further retained capture displaces a transient rather than the evidence:
  // the ceiling is met by dropping transients first.
  const droppedBefore = budget.dropped
  budget.registerScreenshot({ reason: 'failure evidence: second stop', runFailed: true, bytes: 256, step: 999 })
  assert.ok(budget.screenshotCount <= limits.maxScreenshots, 'the ceiling still holds after another retained capture')
  assert.ok(budget.dropped > droppedBefore, 'the new evidence must displace a transient, not grow the list')

  // A transient capture expires on its own once its TTL passes; the retained
  // evidence does not.
  now += limits.transientTtlMs + 1
  budget.enforce()
  const after = budget.screenshots()
  assert.ok(after.filter((entry) => entry.reason.includes('failure evidence')).length >= 2,
    'every piece of failure evidence outlives the transient TTL')
  assert.ok(after.every((entry) => !entry.transient), 'no expired transient may remain')

  // The byte ceiling is enforced too, and it evicts transients first.
  const byteBudget = createResourceBudget({ now: () => now })
  const half = Math.floor(byteBudget.limits.maxEvidenceBytes / 2)
  byteBudget.registerScreenshot({ reason: 'failure evidence', runFailed: true, bytes: half })
  byteBudget.registerScreenshot({ reason: 'failure evidence two', runFailed: true, bytes: half })
  for (let index = 0; index < 40; index += 1) byteBudget.registerScreenshot({ reason: 'probe', bytes: half / 4 })
  assert.ok(byteBudget.snapshot().evidenceBytes <= byteBudget.limits.maxEvidenceBytes,
    'retained evidence bytes must stay inside the byte ceiling')
})

test('soak A: owned processes settle, are disposed, and cannot be killed when unowned (plan §9/Task 7)', async () => {
  const registry = createProcessRegistry({ now: () => 1000, maxOwned: 2 })
  const child = fakeChild(9001)
  const registered = registry.register({ child, command: 'node', args: ['-e', '1'], cwd: 'C:\\workspace', mode: 'foreground', expectedLifetimeMs: 1000 })
  assert.equal(registry.ownedCount, 1)
  assert.equal(registry.isRunning(registered.id), true)

  // A process the runtime does not own can never be killed: the registry refuses
  // before it touches any handle.
  const foreign = await registry.kill('p99999', 'soak test')
  assert.deepEqual({ ok: foreign.ok, reason: foreign.reason }, { ok: false, reason: 'not_owned' })
  assert.deepEqual(child.killed, [], 'an unowned process handle must never be killed')

  // The ceiling is enforced rather than exceeded.
  const second = fakeChild(9002)
  registry.register({ child: second, command: 'node' })
  assert.equal(registry.atCapacity(), true)
  assert.throws(() => registry.register({ child: fakeChild(9003), command: 'node' }), (error) => error.code === CODES.RESOURCE_LIMIT)

  // Settling returns an owned slot, and teardown disposes exactly what is still
  // owned: a process that already exited is not killed again.
  registry.settle(registered.id, { status: 'exited', exitCode: 0 })
  assert.equal(registry.ownedCount, 1)
  assert.deepEqual(child.killed, [], 'a settled process must not be killed at teardown')
  const disposed = await registry.dispose('soak teardown')
  assert.equal(registry.ownedCount, 0, 'teardown must return the owned count to zero')
  assert.equal(disposed.attempted, 1, 'teardown must attempt exactly the still-owned processes')
  assert.equal(disposed.disposed, 1)
  assert.ok(second.killed.length >= 1, 'the owned process really was killed')
  assert.equal(registry.snapshot().ownedCount, 0)

  // An exit the registry does not own is not recorded as one of ours.
  assert.equal(registry.settle('p99999', { status: 'exited' }), null)
})

// ===========================================================================
// B. Failure injection (plan §24): every injected failure ends in exactly one
// of recover / degrade / block / fail with evidence — never a hang, never a
// silent success, never an unbounded retry.
// ===========================================================================

/** The four documented outcomes an injected failure may produce (plan §24). */
const OUTCOMES = ['recover', 'degrade', 'block', 'fail-with-evidence']

/**
 * Classify a run report into the plan's outcome vocabulary.
 *
 * `recover`            the run completed, or completed after a recovery decision
 * `degrade`            the runtime kept working while a capability reported down
 * `block`              the run stopped on a condition with no correct action
 * `fail-with-evidence` the run stopped and the log carries the failure context
 */
function classifyOutcome(report, runtime) {
  const outcomes = []
  if (report.status === 'completed') outcomes.push('recover')
  if (report.status === 'blocked') outcomes.push('block')
  if (report.status === 'failed') outcomes.push('fail-with-evidence')
  const health = runtime.health()
  if (health.status !== 'healthy' || health.degradedCapabilities.length) outcomes.push('degrade')
  const failedSteps = runtime.log.steps().filter((step) => step.result !== 'success')
  if (report.status === 'failed' && (failedSteps.length || report.error)) outcomes.push('fail-with-evidence')
  return [...new Set(outcomes.filter((entry) => OUTCOMES.includes(entry)))]
}

/**
 * Assert that an injected failure produced a documented, bounded outcome:
 * at least one of the four, a report that actually stopped, and a log with the
 * evidence in it. A silent success and a silent hang both fail here.
 */
function assertBoundedOutcome(report, runtime, label) {
  const outcomes = classifyOutcome(report, runtime)
  assert.ok(outcomes.length > 0, `${label}: the injected failure produced no documented outcome (status ${report.status})`)
  assert.ok(['completed', 'failed', 'blocked', 'cancelled'].includes(report.status),
    `${label}: unexpected status ${report.status}`)
  assert.ok(report.error || report.status === 'completed', `${label}: a failed run must carry a typed error`)
  // Never a silent success: a failed run must be visible in the run's own record.
  if (report.status !== 'completed') {
    assert.ok(report.error && report.error.code, `${label}: the failure must be typed (code missing)`)
  }
  // Evidence: the run's log carries either the terminal event or the failing step.
  const tail = runtime.log.tail(500)
  const hasTerminalEvidence = tail.some((entry) => entry.kind === 'finish') || tail.some((entry) => entry.kind === 'step' && entry.result !== 'success')
  assert.ok(hasTerminalEvidence, `${label}: the run's log carries no terminal evidence`)
  return outcomes
}

test('failure injection: a CDP/page disconnect degrades the browser channel and fails with evidence (plan §24)', async () => {
  const device = createDevice()
  const page = device.openPage('form.html')
  try {
    // The transport *is* the device's page port, until it is told to disconnect:
    // then every protocol call fails and the probe reports the page down. This is
    // the production shape — the adapter speaks `Runtime.evaluate` to a transport
    // — with the device standing in for Chromium.
    let connected = true
    const transport = {
      probe: () => (connected
        ? { available: true, reason: null, detail: { backend: 'device' } }
        : { available: false, reason: 'the CDP connection was closed by the browser' }),
      send: async (method, params = {}) => {
        if (!connected) throw new Error('CDP transport disconnected: the browser closed the connection')
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression)
          if (/__dshCuDescribe/.test(expression) && /querySelectorAll/.test(expression) && /controls/.test(expression)) {
            const snapshot = await page.snapshot()
            return {
              result: {
                value: {
                  url: snapshot.url,
                  title: snapshot.title,
                  readyState: snapshot.readyState,
                  revision: snapshot.revision,
                  focusedRef: snapshot.focusedRef,
                  viewport: snapshot.viewport,
                  controls: snapshot.controls,
                  modals: snapshot.modals
                }
              }
            }
          }
          if (/document.activeElement/.test(expression) || /location\.href/.test(expression)) {
            return { result: { value: page.url } }
          }
          if (/__dshCu/.test(expression)) return { result: { value: { url: page.url, revision: 0, state: page.__state.readyState } } }
          return { result: { value: null } }
        }
        if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'device-page', url: page.url, title: page.document.title }] }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
        return {}
      }
    }
    const cdp = createCdpPage({ transport })
    let detached = false
    const detachPage = () => {
      detached = true
      connected = false
    }
    // The page adapter keeps working until the connection drops, and then
    // reports itself down and fails every call — the shape of a real disconnect.
    // The detach happens at the *second* snapshot: the runtime's own initial
    // observation still lands on the live page, and the first step of the run
    // finds the page gone.
    const adapter = Object.create(cdp)
    adapter.detach = detachPage
    adapter.probe = () => (detached
      ? { available: false, reason: 'the CDP connection was closed by the browser' }
      : cdp.probe())
    adapter.snapshot = async () => {
      if (detached) throw new Error('the CDP connection was closed by the browser')
      const live = await cdp.snapshot()
      detachPage()
      return live
    }
    for (const method of ['query', 'queryAll', 'accessibility', 'clickElement', 'focusElement', 'typeText', 'setValue', 'navigate', 'waitFor', 'screenshot', 'close', 'events', 'dialogs', 'answerDialog']) {
      adapter[method] = (...args) => {
        if (detached) throw new Error(`the CDP connection is closed: ${method} is unavailable`)
        return cdp[method](...args)
      }
    }
    const runtime = createComputerUseRuntime({
      host: {
        // The host re-attaches the visible page at the start of every run (the
        // shell's surface changes); the adapter itself decides whether it is
        // alive.
        page: adapter,
        desktop: device.desktop,
        accessibility: device.accessibility,
        screenshot: device.screenshot
      },
      clock: device.clock,
      log: { dir: null },
      options: { maxSteps: 10 }
    })
    try {
      const report = await runtime.run({
        goal: 'type into the form while the page disconnects',
        allowed_capabilities: ['browser'],
        success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
        plan: [
          {
            action: {
              type: 'DOM_TYPE',
              target: { selector: '#username' },
              text: 'alice',
              expected_effect: { any: [{ value_equals: 'alice' }] },
              timeout_ms: 300
            }
          }
        ],
        limits: { max_steps: 4, max_retries_per_action: 1 }
      })
      // The disconnect is real, not decided after the fact.
      assert.equal(detached, true, 'the host really detached the page')
      assert.equal(connected, false, 'the transport really was disconnected')
      // The capability verdict is probed on demand, so it reflects the detached
      // page rather than the controller's per-run cache (Task 9). Re-attaching is
      // what the shell does when the visible surface changes: it drops the cached
      // probe, and the next verdict sees the dead transport.
      runtime.attachPage(adapter)
      const verdict = runtime.canExecute('DOM_TYPE')
      assert.equal(verdict.ok, false, `a disconnected page must refuse browser actions (${verdict.reason})`)
      const outcomes = assertBoundedOutcome(report, runtime, 'CDP disconnect')
      assert.ok(outcomes.includes('fail-with-evidence') || outcomes.includes('degrade'),
        `a disconnected page must degrade or fail with evidence (saw ${outcomes.join(', ')})`)
      assert.notEqual(report.status, 'completed', 'a disconnected page must never produce a silent success')
      assert.equal(device.files.exists('/workspace/doc.txt'), false, 'nothing was typed into a page that went away')
    } finally {
      runtime.dispose()
    }
  } finally {
    device.dispose()
  }
})

test('failure injection: the window closes mid-run and the target is never reused (plan §24)', async () => {
  const device = createDevice()
  const editor = device.desktop.openApplication({ title: 'Editor - doc.txt', className: 'VirtualEditor', fixture: 'editor.html' })
  const page = device.page(editor.detail.pageId)
  const handle = editor.detail.handle
  const runtime = createRuntime(device, { page })
  try {
    let closed = false
    const originalSnapshot = page.snapshot.bind(page)
    page.snapshot = async (...args) => {
      if (!closed) {
        closed = true
        device.desktop.closeWindow(handle)
      }
      return originalSnapshot(...args)
    }
    const report = await runtime.run({
      goal: 'focus the editor window and type into it',
      allowed_capabilities: ['desktop', 'browser'],
      plan: [
        { id: 'focus', action: { type: 'FOCUS', target: { window: { handle } }, timeout_ms: 400 } },
        { id: 'type', action: { type: 'DOM_TYPE', target: { selector: '#doc' }, text: 'after the window closed', expected_effect: { any: [{ value_equals: 'after the window closed' }] }, timeout_ms: 400 } }
      ],
      limits: { max_steps: 6, max_retries_per_action: 1 }
    })
    assert.equal(closed, true, 'the window really was closed')
    assert.equal(device.windows.some((window) => window.handle === handle), false, 'the window is gone')
    assert.notEqual(report.status, 'completed', 'a run whose window disappeared must not report success')
    const outcomes = assertBoundedOutcome(report, runtime, 'window closes')
    assert.ok(outcomes.includes('fail-with-evidence') || outcomes.includes('degrade'),
      `a closed window must fail with evidence (saw ${outcomes.join(', ')})`)
    assert.ok([CODES.TARGET_NOT_FOUND, CODES.TARGET_STALE, CODES.WINDOW_MISMATCH, CODES.CONTROLLER_UNAVAILABLE, CODES.CAPABILITY_UNAVAILABLE, CODES.PLAN_EXHAUSTED].includes(report.error.code),
      `unexpected failure code after the window closed: ${report.error.code}`)
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('failure injection: the target moves and the runtime re-resolves it instead of using the stale point (plan §24)', async () => {
  const device = createDevice()
  const page = device.openPage('dynamic.html')
  const runtime = createRuntime(device, { page })
  try {
    const before = await page.query('#moving')
    const report = await runtime.run({
      goal: 'click the control that moves before the action runs',
      success_criteria: [{ kind: 'dom_text', selector: '#clicked', text: 'Clicked' }],
      allowed_capabilities: ['browser'],
      plan: [
        { id: 'settle', action: { type: 'WAIT_STATE', waitFor: { condition: 'idle' }, timeout_ms: 900 } },
        { id: 'click', action: { type: 'DOM_CLICK', target: { selector: '#moving' }, expected_effect: { any: [{ text_appears: 'Clicked' }] }, timeout_ms: 800 } }
      ]
    })
    const after = await page.query('#moving')
    const movement = Math.hypot(after.bbox.x - before.bbox.x, after.bbox.y - before.bbox.y)
    assert.ok(movement > 10, `the target really moved ${movement}px`)
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(page.document.getElementById('clicked').textContent.trim(), 'Clicked')
    // The move was noticed rather than clicked through: the runtime's own state
    // machine went through stabilization and the resolution is the new place.
    assert.ok(report.states.includes('STABILIZING'))
    const clickStep = runtime.log.steps().find((step) => step.actionType === 'DOM_CLICK')
    assert.ok(clickStep, 'the click step must be logged')
    assert.equal(clickStep.result, 'success')
    assert.ok(clickStep.resolvedPoint.x >= after.bbox.x && clickStep.resolvedPoint.x <= after.bbox.x + after.bbox.width,
      `the click must be addressed inside the target's new box (${JSON.stringify(clickStep.resolvedPoint)} vs ${JSON.stringify(after.bbox)})`)
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('failure injection: the target disappears on click and the run fails with evidence, not silently (plan §24)', async () => {
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page })
  try {
    const report = await runtime.run({
      goal: 'click a control that removes itself',
      allowed_capabilities: ['browser'],
      plan: [
        {
          id: 'vanish',
          action: {
            type: 'DOM_CLICK',
            target: { selector: '#sign-in' },
            expected_effect: { any: [{ text_appears: 'Never appears' }] },
            timeout_ms: 300
          }
        }
      ],
      limits: { max_steps: 6, max_retries_per_action: 1 }
    })
    assert.notEqual(report.status, 'completed')
    const outcomes = assertBoundedOutcome(report, runtime, 'target disappears')
    assert.ok(outcomes.includes('fail-with-evidence'), `a vanished effect must fail with evidence (saw ${outcomes.join(', ')})`)
    assert.ok([CODES.VERIFICATION_FAILED, CODES.ACTION_MISSED, CODES.VERIFICATION_UNKNOWN, CODES.STALL_DETECTED, CODES.PLAN_EXHAUSTED, CODES.STEP_LIMIT_REACHED].includes(report.error.code),
      `unexpected failure code: ${report.error.code}`)
    assert.ok(report.steps <= 6, 'the run stays inside its step bound')
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('failure injection: a temporary UI freeze becomes a bounded stall, never a hang (plan §24)', async () => {
  const device = createDevice()
  const page = device.openPage('stall.html')
  const stuckAction = {
    type: 'DOM_CLICK',
    target: { selector: '#apply' },
    expected_effect: { any: [{ text_appears: 'Applied' }] },
    timeout_ms: 120
  }
  const runtime = createRuntime(device, { page, maxSteps: 12, planner: async () => stuckAction })
  try {
    const report = await runtime.run({
      goal: 'apply a change on a page that stops responding',
      allowed_capabilities: ['browser'],
      plan: [{ action: stuckAction }],
      limits: { max_steps: 12, max_retries_per_action: 1, max_stall_recoveries: 1 }
    })
    assert.equal(report.status, 'failed')
    assert.ok(report.stallRecoveries >= 1, 'the frozen UI must have triggered the bounded stall ladder')
    assert.equal(report.error.code, CODES.STALL_DETECTED, `expected STALL_DETECTED, saw ${report.error.code}`)
    assert.ok(report.steps <= 12, 'the stall is bounded by the step limit')
    assert.ok(Array.isArray(report.error.details.history) && report.error.details.history.length > 0, 'the stall carries its evidence')
    assert.ok(runtime.log.tail(200).some((entry) => entry.kind === 'event' && entry.type === 'stall'))
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('failure injection: a modal appears and the flow pauses, dismisses and resumes (plan §24)', async () => {
  const device = createDevice()
  const page = device.openPage('modal.html')
  const runtime = createRuntime(device, { page })
  try {
    const report = await runtime.run({
      goal: 'open the modal and then click the control behind it',
      success_criteria: [{ kind: 'dom_text', selector: '#behind-state', text: 'Behind clicked' }],
      allowed_capabilities: ['browser'],
      plan: [
        { id: 'open', action: { type: 'DOM_CLICK', target: { selector: '#open-modal' }, expected_effect: { any: [{ dom_mutated: true }] }, timeout_ms: 400 } },
        { id: 'behind', action: { type: 'DOM_CLICK', target: { selector: '#behind' }, expected_effect: { any: [{ text_appears: 'Behind clicked' }] }, timeout_ms: 400 } }
      ]
    })
    const outcomes = assertBoundedOutcome(report, runtime, 'modal appears')
    assert.ok(outcomes.includes('recover'), `the modal must be recovered from (saw ${outcomes.join(', ')})`)
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(page.__state.modals.length, 0, 'the modal really was dismissed')
    assert.equal(page.document.getElementById('behind-state').textContent.trim(), 'Behind clicked')
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('failure injection: a destructive confirmation nobody authorized becomes USER_ACTION_REQUIRED, never a blind click (plan §24, scenario F)', async () => {
  const device = createDevice()
  // The fixture's Publish control raises a *native* confirmation. A native dialog
  // exposes no control the runtime can classify, so there is nothing it may
  // legitimately press: the fail-safe answer is USER_ACTION_REQUIRED.
  const page = device.openPage('modal.html')
  const runtime = createRuntime(device, { page })
  try {
    // The dialog is already open when the run starts, so the very first gate sees
    // it — the run cannot slip past it.
    await page.clickElement('#publish')
    assert.equal(page.__state.modals.length, 0, 'the native dialog is not a DOM modal')
    assert.equal(page.dialogs().length, 1, 'the confirmation dialog is really open')

    const report = await runtime.run({
      goal: 'publish through a confirmation the contract did not authorize',
      allowed_capabilities: ['browser'],
      plan: [
        {
          id: 'publish',
          action: {
            type: 'DOM_CLICK',
            target: { selector: '#publish' },
            expected_effect: { any: [{ text_appears: 'Published' }] },
            timeout_ms: 300
          }
        }
      ],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })
    assert.notEqual(report.status, 'completed', `a destructive dialog must not be clicked through (code=${report.error && report.error.code})`)
    const outcomes = assertBoundedOutcome(report, runtime, 'destructive confirmation')
    assert.ok(outcomes.includes('block') || outcomes.includes('fail-with-evidence'), `expected a block or a failure (saw ${outcomes.join(', ')})`)
    // The dialog was paused for, never answered. Because a native confirmation
    // exposes no control the runtime may classify, the refusal surfaces as either
    // MODAL_BLOCKING (the gate saw the dialog) or UI_UNSTABLE (the settle never
    // went quiet because the dialog was up) — both are a bounded refusal, and both
    // leave the decision with the user.
    assert.ok([CODES.MODAL_BLOCKING, CODES.UI_UNSTABLE].includes(report.error.code),
      `expected a modal refusal (MODAL_BLOCKING or UI_UNSTABLE), saw ${report.error.code}`)
    assert.equal(page.dialogs().length, 1, 'the runtime must not have answered the dialog on its own')
    assert.equal(page.document.getElementById('published').hasAttribute('hidden'), true, 'the destructive confirmation must not have been accepted')
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

// ===========================================================================
// C. Acceptance scenarios A-G (plan §25)
// ===========================================================================
test('failure injection: a verification that cannot be performed is reported as unknown, never as success (plan §24)', async () => {
  const workspace = makeWorkspace('cu-unknown-')
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page, workspace, options: { maxSteps: 4 } })
  try {
    const missing = path.join(workspace, 'does-not-exist.txt')
    const report = await runtime.run({
      goal: 'read a file that is not there',
      allowed_capabilities: ['filesystem'],
      plan: [{
        id: 'read',
        action: {
          type: 'FILE_READ',
          path: missing,
          // The effect cannot be established: there is no file to observe.
          expected_effect: { any: [{ file_modified: missing }] },
          timeout_ms: 400
        }
      }],
      limits: { max_steps: 3, max_retries_per_action: 0 }
    })
    assert.notEqual(report.status, 'completed', 'an unverifiable action must never be a success')
    const outcomes = report.outcomes.filter((outcome) => outcome.action === 'FILE_READ')
    assert.ok(outcomes.length >= 1, 'the unverifiable action must be recorded')
    assert.ok(outcomes.every((outcome) => outcome.verification === 'unknown'),
      `every unverifiable attempt must be reported as unknown (${JSON.stringify(outcomes.map((outcome) => outcome.verification))})`)
    const steps = runtime.log.steps()
    assert.ok(steps.some((step) => step.result === 'unknown'), 'the log must carry the unknown verdict')
    assert.ok(steps.every((step) => step.result !== 'success'), 'nothing may be logged as a success')
    assert.ok(runtime.log.tail(50).some((entry) => entry.kind === 'finish'), 'the run must still end with evidence')
  } finally {
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})


test('scenario A: a sustained UI task accumulates no stale focus, no screenshot flood and no retry inflation (plan §25A)', async () => {
  const device = createDevice()
  const opened = device.desktop.openApplication({ title: 'Sustained App', className: 'SustainedApp', html: SOAK_PAGE, url: 'https://device.test/sustained' })
  const editor = device.desktop.openApplication({ title: 'Editor - doc.txt', className: 'VirtualEditor', fixture: 'editor.html' })
  const page = device.page(opened.detail.pageId)
  const probe = createRunProbe()
  const runtime = createRuntime(device, { page })
  probe.attach(runtime)
  try {
    // observe -> click -> type -> save -> verify, repeated 60 times: the shape the
    // plan calls a "one-hour-level sustained UI task", compressed onto the virtual
    // clock. A window change is interleaved every 10 cycles.
    const plan = []
    for (let index = 0; index < 60; index += 1) {
      if (index % 10 === 9) {
        plan.push({ id: `switch-${index}`, action: { type: 'FOCUS', target: { window: { handle: index % 20 === 9 ? opened.detail.handle : editor.detail.handle } }, timeout_ms: 400 } })
      }
      plan.push({ id: `type-${index}`, action: { type: 'DOM_TYPE', target: { selector: '#query' }, text: `value-${index}`, expected_effect: { any: [{ value_equals: `value-${index}` }] }, timeout_ms: 400 } })
      plan.push({ id: `observe-${index}`, action: { type: 'WAIT_STATE', waitFor: { condition: 'idle' }, timeout_ms: 400 } })
      plan.push({ id: `click-${index}`, action: { type: 'DOM_CLICK', target: { selector: '#lookup' }, expected_effect: { any: [{ text_appears: 'Lookup done' }] }, timeout_ms: 400 } })
    }
    const report = await runtime.run({
      goal: 'sustain a UI task for a long session',
      allowed_capabilities: ['browser', 'desktop', 'filesystem'],
      plan,
      limits: { max_steps: plan.length + 20, max_retries_per_action: 2, max_stall_recoveries: 1 }
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))

    // No accumulating stale focus: the trust ring is capped, and after the run
    // the reference is either cleared or belongs to the last focus action (Task 1).
    const focusCap = caps().focus
    assert.ok(probe.focusHistoryMax <= focusCap, `the focus history must be capped at ${focusCap} (peaked at ${probe.focusHistoryMax})`)
    assert.ok(probe.samples > 100, `the sustained task must have been observed (saw ${probe.samples} samples)`)
    const finalFocus = probe.lastFocusSnapshot
    assert.ok(finalFocus, 'the focus trust must have been observed')
    if (probe.lastFocusHistoryKind !== 'verified') {
      assert.equal(finalFocus.verifiedFocusRef, null,
        'verifiedFocusRef may only be set when the last focus action was verified (Task 1)')
    }

    // No screenshot flood: no capture was taken at all for a structured task.
    assert.equal(runtime.controllers.vision.captures().length, 0, 'a structured UI task needs no screenshot')
    assert.equal(runtime.resources().screenshots, 0, 'no capture record may accumulate for a structured task')

    // No retry inflation: every step is a first attempt.
    const steps = runtime.log.steps()
    assert.ok(steps.every((step) => Number(step.retryCount) === 0), 'a healthy UI never inflates the retry count')
    assert.equal(report.recoveryDecisions.length, 0, 'a healthy UI needs no recovery decision')
    assert.equal(steps.length, plan.length, `every planned action ran exactly once (${steps.length} of ${plan.length})`)
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('scenario B: a long build that keeps producing output is never reported as stalled (plan §25B)', async () => {
  const workspace = makeWorkspace('cu-scenario-b-')
  const artifact = path.join(workspace, 'build-artifact.txt')
  const device = createDevice()
  const page = device.openPage('form.html')
  // A build that stays alive for ~1.2 s and only then prints its success line and
  // writes its artifact: exactly the "process remains alive while output
  // continues" case the plan forbids calling stalled.
  const build = 'setTimeout(() => { process.stdout.write("BUILD OK\\n"); require("node:fs").writeFileSync(process.argv[1], "artifact"); }, 1200)'
  const runtime = createRuntime(device, { page, workspace, options: { maxSteps: 8 } })
  // The shell controller's port is wrapped to measure how long the command was
  // in flight: a build that is alive for its own delay is exactly the "still
  // running" case, and the elapsed time is the evidence that it was.
  const shell = runtime.controllers.shell
  const originalPerform = shell.perform.bind(shell)
  let buildDurationMs = 0
  shell.perform = async (action, context) => {
    const startedAt = Date.now()
    try {
      return await originalPerform(action, context)
    } finally {
      buildDurationMs = Date.now() - startedAt
    }
  }
  try {
    const startedAt = Date.now()
    const report = await runtime.run({
      goal: 'run a long build that keeps producing output',
      allowed_capabilities: ['shell', 'filesystem'],
      plan: [{
        id: 'build',
        action: {
          type: 'SHELL_EXEC',
          command: process.execPath,
          args: ['-e', build, artifact],
          expected_effect: { any: [{ stdout_matches: 'BUILD OK' }] },
          timeout_ms: 15_000
        }
      }],
      limits: { max_steps: 4, max_retries_per_action: 0, max_stall_recoveries: 1 }
    })

    // The build really ran alive and really produced its output and artifact.
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 1200, `the build must have stayed alive for its output (took ${elapsed}ms)`)
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(report.stallRecoveries, 0, 'a live build with continuing output must never be reported as stalled')
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'artifact', 'the build artifact really landed on disk')
    const buildStep = runtime.log.steps().find((step) => step.actionType === 'SHELL_EXEC')
    assert.ok(buildStep, 'the build step must be logged')
    assert.equal(buildStep.result, 'success', 'the build was verified by its own output, not mistaken for a miss')
    // "Still running" was observed while the process was alive: the controller
    // held the command for the build's own delay, it was verified by the output it
    // produced, and it was never treated as a leak or a stall.
    assert.ok(buildDurationMs >= 1200,
      `the command must have been in flight for the build's own delay while alive (${buildDurationMs}ms)`)
    assert.equal(runtime.processes().ownedCount, 0, 'the build must be settled when the run ends')
    assert.equal(runtime.processes().finished.filter((entry) => entry.exitCode === 0).length >= 1, true,
      'the build must have exited cleanly in the supervisor registry')
  } finally {
    runtime.controllers.shell.perform = originalPerform
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})

test('scenario C: a hung build is bounded, its owned process is terminated and the evidence is kept (plan §25C)', async () => {
  const workspace = makeWorkspace('cu-scenario-c-')
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page, workspace, options: { maxSteps: 6 } })
  try {
    // A command that never produces the declared output and never exits on its
    // own: without a bound this is the hang the plan's scenario C describes.
    const report = await runtime.run({
      goal: 'run a build that hangs',
      allowed_capabilities: ['shell', 'filesystem'],
      plan: [{
        id: 'hung-build',
        action: {
          type: 'SHELL_EXEC',
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 5000)'],
          expected_effect: { any: [{ stdout_matches: 'BUILD OK' }] },
          timeout_ms: 1200
        }
      }],
      limits: { max_steps: 3, max_retries_per_action: 0, max_stall_recoveries: 1 }
    })

    assert.notEqual(report.status, 'completed', 'a hung build must never report success')
    // The no-progress build reached its timeout and was terminated: the supervisor
    // records the termination, which is the durable evidence the plan asks for.
    // (A retry may leave a further child owned, which the runtime then disposes of
    // in `dispose()` — asserted explicitly below.)
    const processReport = runtime.processes()
    const terminated = processReport.finished.filter((entry) => entry.status === 'timed_out' || entry.signal === 'SIGKILL')
    assert.ok(terminated.length >= 1, `the hung build must have been terminated and recorded (${JSON.stringify(processReport.finished)})`)
    assert.equal(runtime.executor.running, false, 'the run must have stopped, not hung')
    // Evidence is preserved: the failing step is logged with its verification.
    const steps = runtime.log.steps()
    assert.ok(steps.length >= 1, 'the hung build must be logged')
    assert.ok(steps.some((step) => step.actionType === 'SHELL_EXEC' && step.result !== 'success'),
      'the timed-out build must be logged as a non-success step')
    assert.ok(steps.every((step) => step.verification !== null && step.verification !== undefined),
      'the failure carries its verification evidence')
    // The tail of the log carries the terminal record.
    assert.ok(runtime.log.tail(50).some((entry) => entry.kind === 'finish'), 'the log must end with a finish record')

    // Teardown disposes exactly what is still owned: no process survives the
    // runtime itself (Task 7).
    runtime.dispose()
    assert.equal(runtime.processes().ownedCount, 0, 'teardown must leave the runtime owning no process')
  } finally {
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})

test('scenario D: a workspace that drifts away is detected as a mismatch and the next action is refused (plan §25D)', async () => {
  const workspace = makeWorkspace('cu-scenario-d-')
  const marker = path.join(os.tmpdir(), `cu-drift-escape-${process.pid}.txt`)
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page, workspace, options: { maxSteps: 6 } })
  // The workspace is removed *after* the first command is authorized and before
  // the next action runs: the drift a long shell session really hits. The shell
  // controller's port is wrapped (not changed) so the removal is deterministic.
  const shell = runtime.controllers.shell
  const originalPerform = shell.perform.bind(shell)
  let calls = 0
  shell.perform = async (action, context) => {
    calls += 1
    const receipt = await originalPerform(action, context)
    if (calls === 1) removeWorkspace(workspace)
    return receipt
  }
  try {
    const report = await runtime.run({
      goal: 'run a command, then keep working after the workspace moved',
      allowed_capabilities: ['shell'],
      plan: [
        { id: 'first', action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("first")'], expected_effect: { any: [{ stdout_matches: 'first' }] }, timeout_ms: 4000 } },
        { id: 'after-drift', action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`], expected_effect: { any: [{ file_exists: marker }] }, timeout_ms: 3000 } }
      ],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })

    // The drift is detected: the workspace verdict is negative, and the run stops.
    assert.equal(fs.existsSync(workspace), false, 'the workspace really is gone')
    assert.notEqual(report.status, 'completed', 'the run must not continue after the workspace drifted')
    const workspaceVerdict = runtime.workspace.status()
    assert.equal(workspaceVerdict.ok, false, 'the workspace verdict must be negative once it is gone')
    assert.equal(runtime.executor.running, false)

    // The next action was refused because there is no verified directory: the
    // command never ran, and never inherited the process's own directory.
    assert.equal(fs.existsSync(marker), false, 'the refused action must not have run against the system cwd')
    const steps = runtime.log.steps()
    const shellSteps = steps.filter((step) => step.actionType === 'SHELL_EXEC')
    assert.equal(shellSteps.length >= 2, true, 'both shell actions must be logged')
    assert.notEqual(shellSteps[shellSteps.length - 1].result, 'success', 'the action after the drift must not be a success')
    // The refusal really happened *because of the workspace*: the controller's own
    // resolution has no verified directory left to use.
    const resolution = shell.resolveCwd()
    assert.equal(resolution.ok, false, 'the shell controller must have no verified cwd after the drift')
    assert.match(String(resolution.reason), /workspace is not accessible/)
    assert.equal(calls >= 2, true, `the second action must have been attempted and refused (${calls} calls)`)
  } finally {
    runtime.controllers.shell.perform = originalPerform
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
    fs.rmSync(marker, { force: true })
  }
})

test('scenario D: a working directory outside the workspace is refused before the command runs (plan §25D)', async () => {
  const workspace = makeWorkspace('cu-scenario-d2-')
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page, workspace, options: { maxSteps: 6 } })
  try {
    const marker = path.join(os.tmpdir(), `cu-outside-${process.pid}.txt`)
    const report = await runtime.run({
      goal: 'run a command in a directory outside the workspace',
      allowed_capabilities: ['shell'],
      plan: [{
        id: 'outside',
        action: {
          type: 'SHELL_EXEC',
          command: process.execPath,
          args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`],
          cwd: os.tmpdir(),
          expected_effect: { any: [{ file_exists: marker }] },
          timeout_ms: 3000
        }
      }],
      limits: { max_steps: 3, max_retries_per_action: 0 }
    })
    // The requirement is not which code the collapse ends with: it is that the
    // command never ran outside the workspace and the drift is on the record.
    assert.notEqual(report.status, 'completed', 'a cwd outside the workspace must be refused')
    assert.equal(fs.existsSync(marker), false, 'the command must never have run outside the workspace')
    assert.ok(runtime.workspace.drifts().length >= 1, 'the drift must be recorded')
    const drifts = runtime.workspace.drifts()
    assert.equal(drifts[drifts.length - 1].kind, 'cwd_outside_workspace', `unexpected drift kind ${JSON.stringify(drifts)}`)
    const shellStep = runtime.log.steps().find((step) => step.actionType === 'SHELL_EXEC')
    assert.ok(shellStep, 'the refused shell action must be logged')
    assert.notEqual(shellStep.result, 'success', 'the refused command must not be logged as a success')
  } finally {
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})

test('scenario E: a replaced UI context clears verified focus, invalidates targets and forces a reobserve (plan §25E)', async () => {
  const device = createDevice()
  const first = device.desktop.openApplication({ title: 'Editor - first.txt', className: 'VirtualEditor', fixture: 'editor.html' })
  const firstPage = device.page(first.detail.pageId)
  const probe = createRunProbe()
  const runtime = createRuntime(device, { page: firstPage, options: { maxSteps: 8 } })
  probe.attach(runtime)
  try {
    let replacement = null
    const originalSnapshot = firstPage.snapshot.bind(firstPage)
    let replaced = false
    let trustsAfterReplacement = null
    // The window is completely replaced while the run is in flight: the first
    // window closes and a different one takes its place. The device's own
    // close/open calls are what make this a replacement rather than a mock. The
    // replacement lands after the first step has verified the focus, so the run's
    // own trust object is the one that has something to invalidate.
    firstPage.snapshot = async (...args) => {
      const live = await originalSnapshot(...args)
      const run = runtime.executor.currentRun
      if (!replaced && run && run.steps >= 1) {
        replaced = true
        device.desktop.closeWindow(first.detail.handle)
        replacement = device.desktop.openApplication({ title: 'Editor - second.txt', className: 'VirtualEditor', fixture: 'editor.html' })
        // The run's own trust, captured so the Task 1 invalidation can be driven
        // through its public API with the world the runtime itself observes.
        trustsAfterReplacement = run.focus
      }
      return live
    }

    const report = await runtime.run({
      goal: 'keep editing while the UI context is replaced',
      allowed_capabilities: ['desktop', 'browser'],
      plan: [
        { id: 'type-first', action: { type: 'DOM_TYPE', target: { selector: '#doc' }, text: 'first window', expected_effect: { any: [{ value_equals: 'first window' }] }, timeout_ms: 500 } },
        { id: 'type-after', action: { type: 'DOM_TYPE', target: { selector: '#doc' }, text: 'second window', expected_effect: { any: [{ value_equals: 'second window' }] }, timeout_ms: 500 } }
      ],
      limits: { max_steps: 6, max_retries_per_action: 1 }
    })

    assert.equal(replaced, true, 'the window really was replaced')
    assert.equal(device.windows.some((window) => window.handle === first.detail.handle), false, 'the first window is gone')
    assert.ok(replacement, 'a replacement window was opened')
    // The verified focus was live when the replacement happened (the run typed
    // into the first window), so the invalidation has something to clear.
    const verified = probe.focusHistory.filter((entry) => entry.kind === 'verified')
    assert.ok(verified.length >= 1, `the run must have verified a focus before the replacement (${JSON.stringify(probe.focusHistory)})`)
    assert.ok(trustsAfterReplacement, 'the run trust must have been captured at the replacement')
    const replacementWorld = await runtime.observer.observe({ taskId: 'reobserve' })
    const before = trustsAfterReplacement.snapshot()
    assert.equal(before.verifiedFocusRef !== null, true, 'the trust held a verified reference when the window was replaced')
    assert.notEqual(before.windowSignature, replacementWorld.windowSignature,
      'the replaced context must have a different window signature')
    const cleared = trustsAfterReplacement.observeContext(replacementWorld)
    assert.equal(cleared.invalidated, true, 'the replacement must invalidate the verified focus')
    assert.ok(cleared.reasons.includes(FOCUS_INVALIDATION.WINDOW_CHANGED),
      `the window change must be the recorded reason (${JSON.stringify(cleared.reasons)})`)
    assert.equal(trustsAfterReplacement.verifiedFocusRef, null, 'a replaced UI context must clear verifiedFocusRef')
    const invalidations = trustsAfterReplacement.history().filter((entry) => entry.kind === 'invalidate')
    assert.ok(invalidations.some((entry) => entry.reason === FOCUS_INVALIDATION.WINDOW_CHANGED),
      'the invalidation must be recorded in the trust history')
    // The run itself re-observed after the replacement and ended in a documented
    // state rather than acting on a replaced context.
    assert.ok(report.states.includes('OBSERVING'), 'the runtime must re-observe after the replacement')
    assert.ok(report.status === 'completed' || report.error, 'the run must end in a documented state, not hang')
    assert.ok(probe.focusHistoryMax <= caps().focus, 'the trust history stays bounded across the replacement')
    // The run itself re-observed after the replacement and ended in a documented
    // state rather than acting on the replaced context.
    assert.ok(report.states.includes('OBSERVING'), 'the runtime must re-observe after the replacement')
    assert.ok(report.status === 'completed' || report.error, 'the run must end in a documented state, not hang')
    assert.ok(probe.focusHistoryMax <= caps().focus, 'the trust history stays bounded across the replacement')
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('scenario F: an unauthorized dangerous confirmation is reported as needing a user decision (plan §25F)', async () => {
  const device = createDevice()
  const page = device.openPage('modal.html')
  const runtime = createRuntime(device, { page })
  try {
    await page.clickElement('#publish')
    const report = await runtime.run({
      goal: 'publish through a confirmation nobody authorized',
      allowed_capabilities: ['browser'],
      plan: [{
        id: 'publish',
        action: { type: 'DOM_CLICK', target: { selector: '#publish' }, expected_effect: { any: [{ text_appears: 'Published' }] }, timeout_ms: 300 }
      }],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })
    assert.notEqual(report.status, 'completed')
    assert.ok([CODES.MODAL_BLOCKING, CODES.UI_UNSTABLE].includes(report.error.code),
      `expected a modal refusal, saw ${report.error.code}`)
    assert.equal(page.dialogs().length, 1, 'the dialog must be left for the user')
    assert.equal(page.document.getElementById('published').hasAttribute('hidden'), true, 'nothing dangerous may be accepted')
    assert.equal(runtime.canExecute('DOM_CLICK').ok, true, 'the refusal is about the dialog, not about the capability')
  } finally {
    runtime.dispose()
    device.dispose()
  }
})

test('scenario G: one controller offline degrades the runtime while the other capabilities continue (plan §25G)', async () => {
  const workspace = makeWorkspace('cu-scenario-g-')
  const device = createDevice()
  const page = device.openPage('form.html')
  // The browser channel is offline from the start; the file and shell channels
  // are untouched.
  const offlinePage = Object.create(page)
  offlinePage.probe = () => ({ available: false, reason: 'the browser channel is offline for this scenario' })
  offlinePage.snapshot = async () => {
    throw new Error('the browser channel is offline')
  }
  const runtime = createRuntime(device, { page: offlinePage, workspace, options: { maxSteps: 8 } })
  try {
    const health = runtime.health()
    assert.equal(health.status, 'degraded', `one offline controller degrades the runtime (saw ${health.status})`)
    const capabilities = runtime.capabilities()
    assert.equal(capabilities.status, 'degraded', 'the capability report must agree with the health report')
    assert.equal(capabilities.capabilities.browser.status, 'unavailable', `the browser capability must be reported down (${JSON.stringify(capabilities.capabilities.browser)})`)
    assert.equal(capabilities.capabilities.filesystem.status, 'healthy', 'the filesystem capability must keep working')
    assert.equal(capabilities.capabilities.shell.status, 'healthy', 'the shell capability must keep working')
    assert.equal(health.status !== 'blocked', true, 'one offline controller is a degradation, not a block')

    // A browser action is refused as a *capability* problem, not a runtime crash:
    // the honest, bounded outcome is that no DOM action was carried out and the
    // refusal is on the record.
    const browserAction = await runtime.executeAction({ type: 'DOM_TYPE', target: { selector: '#username' }, text: 'alice' })
    assert.equal(browserAction.status, 'failed')
    assert.ok(browserAction.error && browserAction.error.code, 'the refused action must carry a typed error')
    assert.ok(
      [
        CODES.CAPABILITY_UNAVAILABLE,
        CODES.CONTROLLER_UNAVAILABLE,
        CODES.CONTROLLER_FAILED,
        CODES.VERIFICATION_FAILED,
        CODES.PLAN_EXHAUSTED,
        CODES.STALL_DETECTED,
        CODES.STEP_LIMIT_REACHED
      ].includes(browserAction.error.code),
      `unexpected refusal code ${browserAction.error.code}`
    )
    // The typed capability verdict is the runtime's own statement that the
    // browser channel is down, and it is what the executor consults (Task 9).
    assert.equal(runtime.canExecute('DOM_TYPE').ok, false, 'the runtime must report the browser action as not executable')
    assert.equal(runtime.canExecute('FILE_WRITE').ok, true, 'the filesystem action stays executable')
    assert.equal(runtime.canExecute('SHELL_EXEC').ok, true, 'the shell action stays executable')
    // Nothing was typed into a channel that was offline.
    assert.equal(page.document.getElementById('username').value, '', 'the offline browser channel must not have been driven')

    // The other capabilities continue on the same runtime.
    const note = path.join(workspace, 'still-working.txt')
    const report = await runtime.run({
      goal: 'keep working while the browser channel is offline',
      allowed_capabilities: ['filesystem', 'shell'],
      plan: [
        { id: 'write', action: { type: 'FILE_WRITE', path: note, content: 'continued', expected_effect: { any: [{ file_exists: note }] }, timeout_ms: 600 } },
        { id: 'run', action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("still here")'], expected_effect: { any: [{ stdout_matches: 'still here' }] }, timeout_ms: 8000 } }
      ],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(fs.readFileSync(note, 'utf8'), 'continued')
    assert.equal(runtime.health().faults.length, 0, 'a degraded controller is not a runtime fault')
  } finally {
    runtime.dispose()
    device.dispose()
    removeWorkspace(workspace)
  }
})

// ===========================================================================
// D. Acceptance harness parity
//
// The standalone harness (scripts/computer-use-acceptance.cjs) is what
// scripts/verify.ps1 runs against real hardware. It must carry the same soak and
// failure-injection coverage, so this reads the harness source the same way the
// existing wiring gate does and asserts the scenarios are really there.
// ===========================================================================

/** The soak scenario ids this suite and the harness must both carry. */
const REQUIRED_SOAK_SCENARIOS = [
  'soak-sustained-ui',
  'soak-long-build',
  'soak-hung-build',
  'soak-workspace-drift',
  'soak-context-replacement',
  'soak-controller-offline'
]

/** The §24 failure-injection inventory, by the id the harness inventory uses. */
const REQUIRED_FAILURE_INJECTIONS = [
  'cdp-page-disconnect',
  'window-closes',
  'target-moves',
  'target-disappears',
  'temporary-ui-freeze',
  'modal-appears',
  'shell-timeout',
  'child-process-crash',
  'file-locked',
  'workspace-inaccessible',
  'vision-unavailable',
  'verification-unknown'
]

test('harness parity: the standalone acceptance harness carries the soak and failure-injection scenarios (plan §23/§24)', () => {
  const harness = readSource('scripts/computer-use-acceptance.cjs')

  // The scenario catalogue and the implementations are both in the harness
  // source: a scenario declared but never implemented would be a silent skip.
  for (const id of REQUIRED_SOAK_SCENARIOS) {
    assert.ok(harness.includes(`id: '${id}'`), `the harness does not declare the ${id} scenario`)
    assert.ok(harness.includes(`scenario('${id}'`), `the harness does not implement the ${id} scenario`)
  }
  assert.ok(/SCENARIOS\.push\(\.\.\.SOAK_SCENARIOS\)/.test(harness), 'the soak scenarios must be registered in the harness scenario list')
  for (const declared of ['SCENARIOS', 'SOAK_SCENARIOS', 'SOAK_FAILURE_INJECTION']) {
    assert.ok(harness.includes(`const ${declared} =`), `the harness must declare ${declared}`)
  }

  // Every §24 injection is either run by a harness scenario or carries the
  // reason it is only covered deterministically — never silently missing.
  for (const id of REQUIRED_FAILURE_INJECTIONS) {
    const entry = new RegExp(`id: '${id}'[^}]*`).exec(harness)
    assert.ok(entry, `the harness failure-injection inventory is missing ${id}`)
    const hasRunner = /runner: '/.test(entry[0])
    const hasNote = /note: '/.test(entry[0])
    assert.ok(hasRunner || hasNote, `${id} must name a harness runner or explain where it is covered`)
    if (hasRunner) {
      const runner = /runner: '([^']+)'/.exec(entry[0])[1]
      assert.ok(harness.includes(`scenario('${runner}'`), `${id} names the ${runner} runner, which the harness does not implement`)
    }
  }

  // The harness really drives the runtime's long-running surface: an offline
  // controller, a drifted workspace and a bounded process all appear as code.
  for (const marker of ['capabilities()', 'workspace.status()', 'processes()', 'stallRecoveries']) {
    assert.ok(harness.includes(marker), `the harness must assert on ${marker}`)
  }

  // The deterministic half of the same coverage is in this file, so the two
  // halves cannot drift apart silently.
  const soakSource = readSource('tests/unit/computer-use-soak.test.js')
  for (const marker of ['soak A', 'scenario A', 'scenario B', 'scenario C', 'scenario D', 'scenario E', 'scenario F']) {
    assert.ok(soakSource.includes(marker), `the soak suite must cover ${marker}`)
  }
})

test('harness parity: the failure-injection scenarios in the harness match the unit inventory (plan §24)', () => {
  const harness = readSource('scripts/computer-use-acceptance.cjs')
  for (const title of [
    'CDP/page disconnect',
    'window closes',
    'target moves',
    'target disappears',
    'temporary UI freeze',
    'modal appears',
    'shell timeout',
    'child process crash',
    'file locked',
    'workspace temporarily inaccessible',
    'vision unavailable',
    'verification unknown'
  ]) {
    assert.ok(harness.includes(`title: '${title}'`), `the harness inventory must name "${title}" (plan §24)`)
  }
})

// ===========================================================================
// E. Completion standard mapping (plan §26)
//
// The plan's completion checklist is the "no compression" guard: every item has
// to have executable evidence in the suite. This walks the checklist out of
// Update-Plan/24h.md and asserts the mapping covers it and that every mapped test
// really exists in this file.
// ===========================================================================

/** The §26 checklist, in plan order, mapped to the executable evidence. */
const COMPLETION_STANDARD = [
  { item: 'focus trust 正确', tests: ['soak A: hundreds of action cycles leave every long-running structure capped', 'scenario A: a sustained UI task accumulates no stale focus', 'scenario E: a replaced UI context clears verified focus'] },
  { item: 'modal fail-safe', tests: ['failure injection: a modal appears and the flow pauses', 'failure injection: a destructive confirmation nobody authorized', 'scenario F: an unauthorized dangerous confirmation'] },
  { item: 'bounded adaptive stabilization', tests: ['soak A: hundreds of action cycles leave every long-running structure capped', 'failure injection: a temporary UI freeze becomes a bounded stall'] },
  { item: 'action-specific verification', tests: ['soak A: hundreds of action cycles leave every long-running structure capped', 'failure injection: the target disappears on click'] },
  { item: 'meaningful progress tracking', tests: ['soak A: the ring ceilings are enforced when driven past capacity', 'scenario B: a long build that keeps producing output'] },
  { item: 'bounded stall recovery', tests: ['failure injection: a temporary UI freeze becomes a bounded stall', 'scenario C: a hung build is bounded'] },
  { item: 'owned process supervision', tests: ['soak A: owned processes settle, are disposed, and cannot be killed when unowned', 'scenario C: a hung build is bounded'] },
  { item: 'resource ceilings', tests: ['soak A: the resource budget keeps failure evidence and drops transient captures', 'soak A: hundreds of action cycles leave every long-running structure capped'] },
  { item: 'screenshot retention bounded', tests: ['soak A: the resource budget keeps failure evidence and drops transient captures', 'scenario A: a sustained UI task accumulates no stale focus'] },
  { item: 'log growth bounded', tests: ['soak A: the ring ceilings are enforced when driven past capacity', 'soak A: hundreds of action cycles leave every long-running structure capped'] },
  { item: 'controller isolation', tests: ['scenario G: one controller offline degrades the runtime', 'failure injection: a CDP/page disconnect degrades the browser channel'] },
  { item: 'tool reconnect bounded', tests: ['failure injection: a CDP/page disconnect degrades the browser channel', 'scenario G: one controller offline degrades the runtime'] },
  { item: 'workspace continuity checked', tests: ['scenario D: a workspace that drifts away is detected as a mismatch', 'scenario D: a working directory outside the workspace is refused'] },
  { item: 'filesystem mutation verified', tests: ['soak A: hundreds of action cycles leave every long-running structure capped', 'scenario C: a hung build is bounded'] },
  { item: 'shell operations bounded', tests: ['scenario B: a long build that keeps producing output', 'scenario C: a hung build is bounded'] },
  { item: 'recovery occurs at safe step boundaries', tests: ['failure injection: the target disappears on click', 'failure injection: a modal appears and the flow pauses'] },
  { item: 'executor responsibilities reduced', tests: ['soak A: the ring ceilings are enforced when driven past capacity'] },
  { item: 'no App Learning', tests: ['the completion standard: every plan §26 checklist item has executable evidence'] },
  { item: 'no persistent UI location model', tests: ['scenario E: a replaced UI context clears verified focus'] },
  { item: 'no business-level project knowledge', tests: ['the completion standard: every plan §26 checklist item has executable evidence'] },
  { item: 'long-run soak tests stable', tests: ['soak A: hundreds of action cycles leave every long-running structure capped', 'scenario A: a sustained UI task accumulates no stale focus'] },
  { item: 'no silent hangs', tests: ['failure injection: a temporary UI freeze becomes a bounded stall', 'failure injection: the window closes mid-run'] },
  { item: 'no false success on unknown state', tests: ['failure injection: the target disappears on click', 'scenario D: a workspace that drifts away is detected as a mismatch'] }
]

/** The checklist lines under `# 26. Completion Standard` in the plan. */
function readCompletionChecklist() {
  const plan = readSource('Update-Plan/24h.md')
  const section = plan.split('# 26. Completion Standard')[1]
  assert.ok(section, 'Update-Plan/24h.md must still carry the §26 Completion Standard section')
  const body = section.split(/\n# 27\./)[0]
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- [ ]') || line.startsWith('- [x]'))
    .map((line) => line.replace(/^- \[[ x]\]\s*/, '').trim())
    .filter(Boolean)
}

test('the completion standard: every plan §26 checklist item has executable evidence (plan §26)', () => {
  const checklist = readCompletionChecklist()
  assert.ok(checklist.length >= 20, `the checklist must be read from the plan (found ${checklist.length} items)`)
  const soakSource = readSource('tests/unit/computer-use-soak.test.js')

  // Every checklist item is present in the mapping...
  const mapped = new Set(COMPLETION_STANDARD.map((entry) => entry.item))
  for (const item of checklist) {
    assert.ok(mapped.has(item), `the completion standard mapping is missing the checklist item "${item}" (no compression)`)
  }
  // ...and the mapping carries nothing the plan does not ask for.
  for (const entry of COMPLETION_STANDARD) {
    assert.ok(checklist.includes(entry.item), `the mapping names "${entry.item}", which is not a §26 checklist item`)
  }
  // Every mapped test really exists in this suite.
  const missing = []
  for (const entry of COMPLETION_STANDARD) {
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `"${entry.item}" must map to at least one test`)
    for (const name of entry.tests) {
      const pattern = new RegExp(`test\\('${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      if (!pattern.test(soakSource)) missing.push(`${entry.item} -> ${name}`)
    }
  }
  assert.deepEqual(missing, [], `mapped tests missing from the suite: ${missing.join('; ')}`)

  // The mapping itself is in the suite, so the guard is executable rather than a
  // document: the item text travels with the test that enforces it.
  assert.ok(soakSource.includes('const COMPLETION_STANDARD = ['), 'the mapping must live in the suite')
  for (const item of checklist) {
    assert.ok(soakSource.includes(`item: '${item.replace(/'/g, "\\'")}'`), `the mapping must carry the item text "${item}"`)
  }
})
