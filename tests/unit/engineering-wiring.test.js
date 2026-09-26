'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createEngineeringHost } = require('../../app/engineering-host.cjs')

/**
 * Engineering architecture gate (Update-Plan/24h-1.md).
 *
 * Same discipline as the Computer Use gate: a capability that claims to be wired
 * has to be wired *in the shipped files*, not only in its own module. This reads
 * the shell, the dock, the preload, the config and the CI definition and asserts
 * the wiring is real — and it drives the host object itself, because a channel that
 * is registered against a host that cannot answer is not wiring.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = (relative) => fs.existsSync(path.join(ROOT, relative))

test('the shell owns the engineering host and registers its IPC surface', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /const ENGINEERING_CHANNELS = \[/)
  assert.match(shell, /function ensureEngineeringHost\(/)
  assert.match(shell, /function registerEngineeringIpc\(/)
  assert.match(shell, /function disposeEngineeringOnExit\(/)
  assert.match(shell, /function engineeringEnabled\(/)
  for (const channel of [
    'engineering:status',
    'engineering:describe',
    'engineering:checkpoints',
    'engineering:run',
    'engineering:cancel'
  ]) {
    assert.ok(shell.includes(`'${channel}'`), `the shell does not register ${channel}`)
  }
  // The runtime is created on demand and torn down with the rest of the shell.
  assert.match(shell, /registerEngineeringIpc\(\)/)
  assert.match(shell, /disposeEngineeringOnExit\('shell teardown'\)/)
  // A 24-hour episode cannot be awaited inside an IPC handler, so the handler
  // returns as soon as the host accepts it.
  const runHandler = shell.slice(shell.indexOf("ipcMain.handle('engineering:run'"), shell.indexOf("ipcMain.handle('engineering:cancel'"))
  assert.ok(!/await host\(\)\.run/.test(runHandler), 'the run handler must not await the episode')
})

test('the preload bridges the engineering surface and exposes no executor', () => {
  const preload = read('app/extensions/mega/ui/preload.cjs')
  assert.match(preload, /exposeInMainWorld\('megaEngineering'/)
  for (const method of ['status', 'describe', 'checkpoints', 'run', 'cancel']) {
    assert.match(preload, new RegExp(`${method}: \\(`), `the bridge does not expose ${method}`)
  }
  for (const channel of ['engineering:status', 'engineering:describe', 'engineering:checkpoints', 'engineering:run', 'engineering:cancel']) {
    assert.ok(preload.includes(`'${channel}'`), `the bridge does not invoke ${channel}`)
  }
})

test('the dock exposes an engineering panel and nothing in it executes', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const dock = read('app/extensions/mega/ui/dock.js')
  const panel = read('app/extensions/mega/ui/engineering-panel.js')
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(html, /id="engineeringPanel"/)
  assert.match(html, /engineering-panel\.js/)
  assert.match(html, /id="engWorkspace"/)
  assert.match(html, /id="engGoal"/)
  assert.match(html, /id="engDescribe"/)
  assert.match(html, /id="engRun"/)
  assert.match(html, /id="engCancel"/)
  assert.match(dock, /megaEngineeringPanel/)
  assert.match(dock, /engineeringPanel\?\.refresh/)
  assert.match(css, /\.engineering-panel/)
  // The panel is a control surface: it edits a request and reads reports, it never
  // drives the machine itself. It reaches the runtime only through the bridge.
  assert.match(panel, /window\.megaEngineering/)
  assert.match(panel, /bridge\.run\(/)
  assert.match(panel, /bridge\.cancel\(/)
  assert.match(panel, /bridge\.describe\(/)
  assert.equal(/require\(|child_process|spawn|exec\(|robotjs|pyautogui/.test(panel), false, 'the panel must not execute anything')
  assert.equal(/readFileSync|writeFileSync|fs\./.test(panel), false, 'the panel must not touch the filesystem')
})

test('the runtime is configured in config/app.json with a closed git policy', () => {
  const config = JSON.parse(read('config/app.json'))
  assert.ok(config.engineering, 'config/app.json has no engineering block')
  assert.equal(typeof config.engineering.enabled, 'boolean')
  assert.equal(config.engineering.git.allowCommit, false, 'commits must be off unless the contract says otherwise')
  assert.equal(config.engineering.git.allowPush, false)
  assert.equal(config.engineering.git.allowMerge, false)
  assert.ok(config.engineering.limits.deadlineMs > 0)
  assert.ok(config.engineering.limits.maxSteps >= 1)
})

test('the host accepts, reports and cancels an episode, and refuses a second one', async () => {
  const host = createEngineeringHost({ log: () => {}, policy: { allowCommit: false } })
  // Nothing running yet, and the phase vocabulary is reported so a panel can label
  // the states it will see.
  const idle = host.status()
  assert.equal(idle.ok, true)
  assert.equal(idle.running, false)
  assert.ok(idle.phases.includes('DISCOVERING'))
  assert.ok(idle.phases.includes('BLOCKED'))

  // A missing workspace and a missing goal are refusals, not crashes.
  assert.equal(host.run({}).ok, false)
  assert.equal(host.run({ workspace: 'D:/nope', goal: '' }).code, 'GOAL_REQUIRED')
  assert.equal(host.cancel({}).cancelled, false, 'cancelling nothing is a no-op, not an error')

  // Describe answers for a real directory without starting anything.
  const described = host.describe({ workspace: ROOT })
  assert.equal(described.ok, true)
  assert.ok(described.project.id.length > 0)
  assert.ok(described.workspace.length > 0)

  // A disabled subsystem refuses every entry point with the same shape.
  const disabled = createEngineeringHost({ available: () => false, reason: () => 'switched off for the test' })
  for (const result of [disabled.status(), disabled.describe({ workspace: ROOT }), disabled.run({ workspace: ROOT, goal: 'x' })]) {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ENGINEERING_DISABLED')
    assert.equal(result.error, 'switched off for the test')
  }

  // Starting an episode against a workspace that does not exist is a BLOCKED
  // episode, not a crash and not a completed one. The path is a genuine child of a
  // temporary directory that is then removed, so the assertion cannot depend on
  // whether some other test happened to leave the directory behind — a test that
  // passes only because a path is missing is a test that fails on the machine
  // where it is not.
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-missing-'))
  const missing = path.join(holder, 'gone')
  fs.rmSync(missing, { recursive: true, force: true })
  try {
    const refused = host.run({ workspace: missing, goal: 'fix' })
    assert.equal(refused.ok, true, 'the host accepts the request and lets the supervisor verify the workspace')
    const settled = await host.settled()
    assert.equal(settled.result, 'BLOCKED', JSON.stringify({ result: settled.result, phases: settled.phases, reasons: settled.validation && settled.validation.reasons }))
    assert.ok(settled.validation.reasons.length >= 1)
    assert.equal(host.running, false)
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
  host.dispose('test teardown')
})

test('an injected checkpointRoot is treated as the exact checkpoint directory', () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoint-root-'))
  const checkpointRoot = path.join(holder, 'runtime', 'engineering', 'checkpoints')
  try {
    const { createCheckpointStore } = require('../../app/engineering/checkpoint.cjs')
    const store = createCheckpointStore({ dir: checkpointRoot })
    const saved = store.save({ episodeId: 'root-probe', goal: 'probe' })
    assert.equal(saved.ok, true)

    const host = createEngineeringHost({ checkpointRoot })
    const listed = host.checkpoints({ episodeId: 'root-probe' })
    assert.equal(listed.ok, true)
    assert.equal(listed.checkpoints.length, 1, 'the host and supervisor must use the configured directory directly')
    assert.equal(listed.checkpoints[0].path, saved.path)
    host.dispose('test teardown')
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('the supervisor persists a replay-safe recovery descriptor and indexes each saved checkpoint', async () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-recovery-supervisor-'))
  const checkpointRoot = path.join(holder, 'runtime', 'engineering', 'checkpoints')
  try {
    const { createEngineeringSupervisor } = require('../../app/engineering/supervisor.cjs')
    const supervisor = createEngineeringSupervisor({
      workspace: ROOT,
      goal: 'persist the next safe step',
      checkpointRoot,
      deadlineMs: 60_000,
      contract: { commands: {}, steps: [{ kind: 'report' }], lockWorkspace: false, tests: [] },
      log: () => {}
    })
    const report = await supervisor.run()
    const latest = supervisor.checkpoints.latest(report.episode)
    const recovery = latest && latest.recovery

    assert.ok(recovery, 'the final persisted checkpoint must contain the cross-process recovery descriptor')
    assert.equal(recovery.version, 1)
    assert.equal(recovery.episodeId, report.episode)
    assert.equal(recovery.request.workspace, ROOT)
    assert.equal(recovery.request.goal, 'persist the next safe step')
    assert.equal(recovery.request.deadlineAt - recovery.request.startedAt, 60_000)
    assert.equal(recovery.plan.version, 1)
    assert.equal(recovery.plan.steps.length, 1)
    assert.match(recovery.planDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(recovery.cursor.nextStepIndex, 1)
    assert.equal(recovery.cursor.lastVerifiedStepId, recovery.plan.steps[0].id)
    assert.equal(recovery.lifecycleState, 'RECOVERY_BLOCKED', 'a refused final result is retained but not blindly resumed')

    const store = require('../../app/engineering/recovery-store.cjs').createRecoveryStore({
      root: path.dirname(checkpointRoot),
      checkpointDir: checkpointRoot
    })
    assert.equal(store.get(report.episode).state, 'RECOVERY_BLOCKED')
    assert.equal(store.get(report.episode).latestCheckpointSeq, latest.recovery.cursor.checkpointSeq)
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

/**
 * A missing workspace must not be created by the act of locking it.
 *
 * The lock lives at `<workspace>/runtime/engineering/workspace.lock`, so taking it
 * creates the workspace directory. That turned "point at a repository that is not
 * there" into "run an episode in a brand new empty directory" — the bug this test
 * exists to keep closed.
 */
test('a missing workspace is reported, never created by the runtime', async () => {
  const { createEngineeringSupervisor } = require('../../app/engineering/supervisor.cjs')
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-nolock-'))
  const missing = path.join(holder, 'gone')
  try {
    const supervisor = createEngineeringSupervisor({ workspace: missing, goal: 'fix', log: () => {} })
    const report = await supervisor.run()
    assert.equal(report.result, 'BLOCKED')
    assert.match(String(report.validation.reasons[0]), /not accessible|does not exist|no repository path/)
    assert.equal(fs.existsSync(missing), false, 'the runtime must not create a workspace that was not there')
    assert.deepEqual(fs.readdirSync(holder), [], 'and it must leave no directory behind at all')
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('a workspace is locked while an episode runs, and never stolen from a live owner', () => {
  const { createWorkspaceLock } = require('../../app/engineering/locking.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-lock-'))
  try {
    const first = createWorkspaceLock({ root: dir })
    const taken = first.acquire({ episode: 'episode-a' })
    assert.equal(taken.ok, true)
    assert.equal(fs.existsSync(first.file), true, 'the lock must be on disk, because the excluded writer is another process')

    // A second writer in the same workspace is refused, and told who holds it.
    const second = createWorkspaceLock({ root: dir })
    const blocked = second.acquire({ episode: 'episode-b' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'held')
    assert.equal(blocked.lock.episode, 'episode-a')

    // A live owner's lock is never stolen, however old it is.
    const aged = second.acquire({ episode: 'episode-b', stealStale: true })
    assert.equal(aged.ok, false, 'a lock whose owner is alive must not be reclaimed')

    // Release is verified: only the holder may remove it.
    assert.equal(second.release().ok, false, 'a non-holder must not delete the lock')
    assert.equal(first.heartbeat().ok, true, 'the holder can refresh its own lock')
    assert.equal(first.release().ok, true)
    assert.equal(fs.existsSync(first.file), false, 'the lock is gone once released')

    // A lock whose owner is gone is *reported* as stale, and only reclaimed when
    // the caller says so.
    fs.mkdirSync(path.dirname(first.file), { recursive: true })
    fs.writeFileSync(first.file, JSON.stringify({ version: 1, episode: 'dead', pid: 999999999, token: 'x', at: Date.now() - 10 * 60_000 }), 'utf8')
    const third = createWorkspaceLock({ root: dir })
    const stale = third.acquire({ episode: 'episode-c' })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale')
    assert.match(stale.reason, /pass stealStale/)
    const reclaimed = third.acquire({ episode: 'episode-c', stealStale: true })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.lock.episode, 'episode-c')
    third.release()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the syntax gate and the CI gate both cover the engineering surface', () => {
  const check = read('scripts/check-syntax.cjs')
  for (const dir of ["'engineering'", "'engineering/adapters'"]) {
    assert.ok(check.includes(dir), `check-syntax.cjs does not cover ${dir}`)
  }
  assert.equal(exists('scripts/computer-use-longrun-acceptance.cjs'), true)

  const workflow = read('.github/workflows/verify.yml')
  assert.match(workflow, /name: Engineering runtime surface gate/)
  assert.match(workflow, /app\/engineering\/supervisor\.cjs/)
  assert.match(workflow, /app\/engineering\/adapters\/index\.cjs/)
  assert.match(workflow, /tests\/unit\/engineering-scenarios\.test\.js/)
  assert.match(workflow, /engineering-panel\.js/)

  const verify = read('scripts/verify.ps1')
  assert.match(verify, /== Engineering runtime/)
  assert.match(verify, /Engineering module/)
  assert.equal([...verify].some((character) => character.charCodeAt(0) > 127), false, 'verify.ps1 must stay ASCII-only')

  const testAll = read('scripts/test-all.ps1')
  assert.ok(testAll.includes('engineering-scenarios.test.js'), 'test-all.ps1 does not list the engineering suite')
})

test('no file in the engineering runtime or its panel needs a plan document', () => {
  const files = []
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) files.push([`${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name), 'utf8')])
    }
  }
  walk(path.join(ROOT, 'app', 'engineering'))
  files.push(['engineering-host.cjs', read('app/engineering-host.cjs')])
  files.push(['engineering-panel.js', read('app/extensions/mega/ui/engineering-panel.js')])
  for (const [name, source] of files) {
    assert.equal(/(plan\s*§|24h-1\.md|Update-Plan)/.test(source), false, `${name} must not cite a one-time plan`)
  }
})
