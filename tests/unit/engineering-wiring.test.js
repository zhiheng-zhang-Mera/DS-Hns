'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
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

  // Starting an episode against a directory that is not a repository is refused by
  // the host's own describe-equivalent path rather than starting a doomed run.
  const refused = host.run({ workspace: path.join(ROOT, 'this-does-not-exist'), goal: 'fix' })
  assert.equal(refused.ok, true, 'the host accepts the request and lets the supervisor verify the workspace')
  const settled = await host.settled()
  assert.equal(settled.result, 'BLOCKED')
  assert.ok(settled.validation.reasons.length >= 1)
  assert.equal(host.running, false)
  host.dispose('test teardown')
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
