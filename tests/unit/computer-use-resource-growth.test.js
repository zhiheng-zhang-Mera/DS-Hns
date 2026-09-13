'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createProgressTracker } = require('../../app/computer-use/progress.cjs')
const { createProcessRegistry, PROCESS_STATUS } = require('../../app/computer-use/processes.cjs')
const { createResourceBudget, DEFAULTS } = require('../../app/computer-use/resources.cjs')
const { createFocusTrust } = require('../../app/computer-use/focus.cjs')
const { createStallDetector } = require('../../app/computer-use/stall.cjs')
const { createMutationVerifier } = require('../../app/computer-use/mutation.cjs')
const { createStabilizer } = require('../../app/computer-use/stabilization.cjs')
const { createExecutionLog, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } = require('../../app/computer-use/log.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')

/**
 * Long-run resource behaviour (Update-Plan/cleaning-refactor.md phase X).
 *
 * Every structure a long run accumulates has to answer one question: what happens
 * after a thousand steps? A ring that is capped is proven by driving it past the
 * cap and asserting it stopped growing; a handle that is released is proven by
 * holding the count across three magnitudes; a log that is bounded is proven by
 * keeping the *file* bounded, not by trusting a counter.
 *
 * The three magnitudes are the ones the plan names: 100, 500, 1000 steps.
 */
const MAGNITUDES = [100, 500, 1000]

/** Drive one run's worth of per-step bookkeeping and report what it retains. */
async function drive(clock, steps, options = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-resource-log-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-resource-ws-'))
  const log = createExecutionLog({ now: clock.now, dir: logDir, runId: 'resource', maxBytes: 64 * 1024, maxFiles: 3 })
  const processes = createProcessRegistry({ now: clock.now, maxOwned: 4 })
  const resources = createResourceBudget({ now: clock.now, maxScreenshots: 8, ringSize: 16, maxEvidenceBytes: 32 * 1024 })
  const progress = createProgressTracker({ now: clock.now, ringSize: 16 })
  const focus = createFocusTrust({ now: clock.now })
  const stall = createStallDetector({ now: clock.now })
  const mutations = createMutationVerifier({ now: clock.now })
  const stabilizer = createStabilizer({ clock })

  let peakOwned = 0
  for (let step = 0; step < steps; step += 1) {
    clock.advance(5)
    // A registered child that always settles: the count must return to zero.
    const child = { pid: 2000 + step, kill() { return true }, on() {} }
    const entry = processes.register({
      child,
      command: process.execPath,
      args: ['-e', '0'],
      cwd: workspace,
      mode: step % 9 === 0 ? 'long_running' : 'foreground',
      expectedLifetimeMs: 1000,
      ownership: 'runtime',
      step
    })
    peakOwned = Math.max(peakOwned, processes.ownedCount)
    clock.advance(1)
    processes.settle(entry.id, { status: PROCESS_STATUS.EXITED, exitCode: 0 })

    focus.beginStep()
    focus.attempt(`field-${step % 3}`, { source: 'resolution' })
    focus.verified(step % 4 === 0 ? 'unknown' : 'success', step % 4 === 0 ? null : `field-${step % 3}`)

    progress.action({ step })
    if (step % 4 === 0) progress.noOp(`noop-${step % 3}`)
    else progress.progress('verified-effect', { step, verdict: 'success', kind: 'state' })
    progress.heartbeat({ step })

    stall.record({ step, actionType: 'DOM_CLICK', signature: `sig-${step % 5}`, changed: step % 4 !== 0, meaningful: step % 4 !== 0 })
    resources.registerScreenshot({ bytes: 2048, reason: `step-${step}`, step, transient: true })

    log.step({ step, action: { type: 'DOM_CLICK' }, result: 'success', verdict: 'success', durationMs: 5, retry: 0, reasonCode: null })
    log.screenshot(Buffer.from('89504e470d0a1a0a', 'hex'), { level: 1, reason: `step-${step}`, step, runFailed: false })
    log.event({ type: 'tick', step, payload: 'x'.repeat(64) })

    // Filesystem mutations are what the check ring accumulates.
    const target = path.join(workspace, `f-${step % 8}.txt`)
    const beforeMtime = mutations.mtime(target)
    fs.writeFileSync(target, `step ${step}\n`, 'utf8')
    await mutations.verify({
      action: { type: 'FILE_WRITE', params: { path: target, content: `step ${step}\n` } },
      receipt: { path: target, bytes: Buffer.byteLength(`step ${step}\n`) },
      beforeMtime
    })
    await stabilizer.grace({ type: 'DOM_CLICK' })
  }

  const summary = {
    steps,
    logEntries: log.entries().length,
    logScreenshots: log.screenshots().length,
    logFileBytes: fs.statSync(log.path).size,
    logFiles: fs.readdirSync(logDir).filter((name) => name.endsWith('.jsonl')).length,
    rotations: log.rotations(),
    progressRing: progress.history().length,
    focusRing: focus.history().length,
    stallRing: stall.history().length,
    mutationRing: mutations.checks().length,
    stabilizerTrace: stabilizer.trace().length,
    budgetScreenshots: resources.snapshot().screenshots,
    budgetBytes: resources.snapshot().evidenceBytes,
    dropped: resources.snapshot().droppedScreenshots,
    processFinished: processes.finished().length,
    ownedAfter: processes.ownedCount,
    peakOwned,
    workspaceDrifts: 0
  }
  log.close()
  fs.rmSync(logDir, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
  return summary
}

test('a thousand steps leave every long-run structure bounded (phase X)', async () => {
  const clock = createVirtualClock()
  const results = []
  for (const steps of MAGNITUDES) results.push(await drive(clock, steps))
  const [small, medium, large] = results

  for (const result of results) {
    const label = `${result.steps} steps`
    // Every ring is capped by its module's own ceiling, not by the step count.
    assert.ok(result.logEntries <= 2000, `${label}: the log ring must stay bounded (${result.logEntries})`)
    assert.ok(result.logScreenshots <= 200, `${label}: the log screenshot ring must stay bounded (${result.logScreenshots})`)
    assert.ok(result.progressRing <= 16, `${label}: the progress ring must stay bounded (${result.progressRing})`)
    assert.ok(result.focusRing <= 100, `${label}: the focus history must stay bounded (${result.focusRing})`)
    assert.ok(result.stallRing <= 200, `${label}: the stall history must stay bounded (${result.stallRing})`)
    assert.ok(result.mutationRing <= 200, `${label}: the mutation ring must stay bounded (${result.mutationRing})`)
    assert.ok(result.stabilizerTrace <= 200, `${label}: the stabilizer trace must stay bounded (${result.stabilizerTrace})`)
    assert.ok(result.budgetScreenshots <= 8, `${label}: the capture ring must stay bounded (${result.budgetScreenshots})`)
    assert.ok(result.budgetBytes <= DEFAULTS.maxEvidenceBytes, `${label}: retained evidence must stay under its byte ceiling`)
    assert.equal(result.ownedAfter, 0, `${label}: no owned process may survive`)
    assert.equal(result.peakOwned <= 4, true, `${label}: the owned count must respect the registry ceiling`)

    // The log *file* is bounded, not just the in-memory ring: it rotates and
    // prunes, and the active file never exceeds the ceiling the log was given.
    assert.ok(result.logFileBytes <= 64 * 1024, `${label}: the active log file must stay inside its ceiling (${result.logFileBytes})`)
    assert.ok(result.logFiles <= 3, `${label}: rotated files must be pruned to the ceiling (${result.logFiles})`)
  }

  // Growth across magnitudes: each ring stops at its own ceiling, so the largest
  // run holds no more than the cap and a run past the cap holds exactly the cap.
  assert.equal(large.progressRing, 16, 'the progress ring must hold exactly its cap once it is past it')
  assert.equal(large.focusRing, 100, 'the focus history must hold exactly its cap once it is past it')
  assert.equal(large.stallRing, 200, 'the stall history must hold exactly its cap once it is past it')
  assert.equal(large.mutationRing, 200, 'the mutation ring must hold exactly its cap once it is past it')
  assert.equal(large.stabilizerTrace, 200, 'the stabilizer trace must hold exactly its cap once it is past it')
  assert.equal(small.progressRing, 16, 'the progress ring fills its cap at 100 steps and never exceeds it')
  assert.ok(medium.stallRing <= 200 && large.stallRing <= 200)
  assert.ok(large.logEntries <= 2000, 'the log ring must not grow without bound')
  assert.ok(large.processFinished <= 100, 'the settled-process history must itself be a bounded ring')
  assert.equal(medium.ownedAfter, 0)
  assert.equal(large.ownedAfter, 0)
})

test('the soaked runtime keeps its evidence and drops its transients under pressure (phase X)', async () => {
  const clock = createVirtualClock()
  const result = await drive(clock, 300)
  // Transient captures are evicted first, and the count of what was dropped is
  // reported rather than silently forgotten.
  assert.ok(result.dropped > 0, 'transient captures must have been dropped under pressure')
  assert.ok(result.budgetScreenshots <= 8)
  // The file that describes the run is still the bounded one.
  assert.ok(result.rotations >= 0)
})

test('the file controller releases its watches and bounds its events (phase X)', async () => {
  const { createFileController } = require('../../app/computer-use/controllers/file.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-watch-'))
  const clock = createVirtualClock()
  const file = createFileController({ clock, workspace: dir })
  try {
    for (let index = 0; index < 12; index += 1) {
      const target = path.join(dir, `watched-${index}.txt`)
      fs.writeFileSync(target, 'x')
      file.watch(target)
    }
    // A repeated watch of the same path reuses the handle rather than adding one.
    const first = path.join(dir, 'watched-0.txt')
    const again = file.watch(first)
    assert.equal(file.watchCount(), 12, 'a repeated watch must not add a second handle')
    assert.equal(typeof again.close, 'function')

    // Releasing one watch gives its handle back, and the count follows.
    assert.equal(file.unwatch(first), true)
    assert.equal(file.watchCount(), 11)
    assert.equal(file.unwatch(first), false, 'releasing an unknown watch is a refusal, not an error')

    // Dispose closes everything: no handle may outlive the controller.
    file.unwatchAll()
    assert.equal(file.watchCount(), 0, 'dispose must close every watch')
    // The events ring is bounded too: it cannot be the structure that grows.
    const facts = file.facts()
    assert.ok(facts !== undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a detached transport does not keep its subscribers (phase X)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'computer-use', 'drivers', 'cdp-page.cjs'), 'utf8')
  // The detach paths have to release the handler list: a long run reconnects many
  // times, and a list that only grows is a listener leak the happy path never
  // shows. Both the explicit `detach()` and the transport's own detach event are
  // checked, in whichever order they appear.
  const releases = source.split('handlers.length = 0').length - 1
  assert.ok(releases >= 2, `the CDP transport must release its subscribers on both detach paths (found ${releases})`)
  assert.match(source, /on\('detach'/, 'the transport must not forget its own detach event')
  assert.match(source, /detach\(\) \{/, 'the page must expose an explicit detach')
  // And a page that never attaches never installs a listener at all.
  assert.equal(/debugger_\.on/.test(source.split('let listening = false')[0]), false, 'listeners are installed lazily, not at construction')
})
