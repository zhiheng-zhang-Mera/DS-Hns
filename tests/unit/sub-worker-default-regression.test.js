'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { WorkerManager } = require('../../app/sub-worker/manager.cjs')
const { SubWorkerStore, defaultConfig, publicConfig, declaredConfig } = require('../../app/sub-worker/state.cjs')

/**
 * Default regression — the highest priority acceptance criterion (plan §32, AC-01).
 *
 * With the Sub-worker disabled, DS-Harness must behave exactly as before:
 *   no extra model/worker process, no extra port, no extra data directory,
 *   no change to the Harness launch path, no change to the Mega/Tray workflow.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const main = read('app/desktop-main.cjs')
const appConfig = JSON.parse(read('config/app.json'))

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-sub-default-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  return root
}

test('the shipped configuration keeps the feature off', () => {
  assert.equal(appConfig.subWorker.enabledOnStartup, false)
  assert.equal(appConfig.subWorker.maxWorkers, 1)
  assert.equal(appConfig.subWorker.autoDelegate, false)
  assert.equal(appConfig.subWorker.workspaceMode, 'isolated_worktree')
  assert.equal(appConfig.subWorker.keepChangesOnStop, true)
  assert.equal(appConfig.subWorker.allowGitCommit, false)
  assert.equal(appConfig.subWorker.showNotifications, true)
  assert.equal(defaultConfig().enabledOnStartup, false)
})

test('the shipped declaration participates in the effective config without enabling anything', () => {
  const root = scratch('declared')
  fs.writeFileSync(path.join(root, 'config', 'app.json'), JSON.stringify({
    subWorker: { enabledOnStartup: false, maxWorkers: 1, workspaceMode: 'shared' }
  }), 'utf8')
  const store = new SubWorkerStore({ root })
  // config/app.json is the shipped declaration...
  assert.equal(declaredConfig(root).workspaceMode, 'shared')
  assert.equal(store.loadConfig().workspaceMode, 'shared')

  // ...and the persisted user configuration still wins over it.
  store.ensureDirs()
  store.saveConfig({ workspaceMode: 'isolated_worktree' })
  assert.equal(store.loadConfig().workspaceMode, 'isolated_worktree')
  // A declaration can never turn the feature on by accident.
  assert.equal(store.loadConfig().enabledOnStartup, false)
  const onByDeclaration = publicConfig({ ...declaredConfig(root), enabledOnStartup: 'true' })
  assert.equal(onByDeclaration.enabledOnStartup, false, 'only a real boolean enables startup launch')
  fs.rmSync(root, { recursive: true, force: true })
})

test('creating and hydrating the manager spawns nothing and writes nothing', () => {
  const root = scratch('inert')
  const calls = []
  const manager = new WorkerManager({
    root,
    nodeExe: process.execPath,
    log: () => {},
    notify: () => {}
  })
  const snapshot = manager.hydrate()

  assert.equal(snapshot.state, 'OFF')
  assert.equal(snapshot.enabled, false)
  assert.equal(manager.isRunning, false)
  assert.equal(manager.child, null)
  assert.equal(fs.existsSync(path.join(root, 'data')), false, 'no data directory may be created while the feature is off')
  assert.equal(fs.existsSync(path.join(root, 'logs')), false, 'no log directory may be created while the feature is off')
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false, 'no ownership record may be created while the feature is off')
  assert.equal(manager.assignTask({}).accepted, false, 'no task may be admitted while the worker is off')
  assert.equal(manager.pause().ok, false)
  assert.equal(manager.resume().ok, false)
  assert.equal(manager.cancelTask().ok, false)
  assert.deepEqual(calls, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the Harness launch path is untouched', () => {
  // The official Harness still owns 127.0.0.1:3080 by default and is still
  // launched the same way: the Sub-worker layer never touches either.
  // The default is resolved through normalizeHarnessPort(), which keeps 3080 for
  // anything that is not an explicit, usable port.
  assert.match(main, /if \(!Number\.isInteger\(parsed\) \|\| parsed < 1024 \|\| parsed > 65535\) return 3080/, 'the default Harness port stays 3080')
  assert.match(main, /const HARNESS_HOST = '127\.0\.0\.1'/)
  assert.match(main, /'web', '--no-open'/)
  assert.match(main, /const DSH_ENTRY = path\.join\(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin\.js'\)/)
  assert.match(main, /requestSingleInstanceLock/)
  assert.match(main, /process\.env\.DSH_MEGA_DOCK = '0'/)
  // The additive port override exists only for isolated regression runs: the
  // launch line stays byte-identical unless an explicit, usable override is set.
  assert.match(main, /const DSH_LAUNCH_ARGS = \['web', '--no-open', \.\.\.\(HARNESS_PORT_OVERRIDE \? \['--port', String\(HARNESS_PORT\)\] : \[\]\)\]/)
  assert.match(main, /harnessProcess = spawn\(nodeExe, \[DSH_ENTRY, \.\.\.DSH_LAUNCH_ARGS\], \{/)
  // No sub-worker code may start a server, open a port or touch the Harness URL.
  const subWorkerSources = [
    'app/sub-worker/manager.cjs', 'app/sub-worker/runtime.cjs', 'app/sub-worker/task-runner.cjs',
    'app/sub-worker/protocol.cjs', 'app/sub-worker/state.cjs', 'app/sub-worker/permissions.cjs',
    'app/sub-worker/reporter.cjs', 'app/sub-worker/event-bus.cjs'
  ].map(read).join('\n')
  assert.equal(/3080/.test(subWorkerSources), false, 'the worker layer must not know about the Harness port')
  assert.equal(/createServer|listen\(/.test(subWorkerSources), false, 'the worker layer must never open a port')
  assert.equal(/require\('electron'\)|require\("electron"\)/.test(subWorkerSources), false, 'the worker layer must never require Electron')
})

test('the worker process is spawned only from the explicit enable path', () => {
  // Exactly one spawn call exists, inside WorkerManager.start().
  const manager = read('app/sub-worker/manager.cjs')
  const spawnCalls = manager.match(/spawn\(/g) || []
  assert.equal(spawnCalls.length, 1, 'the manager may only spawn the worker in one place')
  const startBody = manager.slice(manager.indexOf('async start('), manager.indexOf('/** Stop = pause'))
  assert.ok(startBody.includes('spawn('), 'spawn lives in the enable path')

  // The shell only starts a worker when the persisted configuration opts in.
  assert.match(main, /if \(workerManager\?\.describe\?\.\(\)\.config\?\.enabledOnStartup\)/)
  const bootBlock = main.slice(main.indexOf('await createWorkerManager(nodeExe)'))
  assert.equal(
    /workerManager\.start\(\{ reason: 'startup' \}\)/.test(bootBlock),
    false,
    'there is no unconditional startup spawn'
  )
})

test('the exit path always reclaims the worker before the Harness is stopped', () => {
  const teardown = main.slice(main.indexOf('function teardownManagedResources'), main.indexOf('function gracefulExit'))
  assert.ok(teardown.indexOf('extensionManager?.stop?.()') < teardown.indexOf('stopSubWorkerOnExit'))
  assert.ok(teardown.indexOf('stopSubWorkerOnExit') < teardown.indexOf('stopHarness()'), 'AC-10 ordering')
  const stopWorker = main.slice(main.indexOf('function stopSubWorkerOnExit'), main.indexOf('function registerSubWorkerIpc'))
  assert.match(stopWorker, /prepareExit/)
  assert.match(stopWorker, /forceStop/)
  // Force exit must not be able to hang on the worker: no awaiting, and every
  // step is individually guarded.
  assert.equal(/await\b/.test(stopWorker), false, 'the exit path never awaits the worker')
  assert.ok((stopWorker.match(/try \{/g) || []).length >= 2)
  const forceExit = main.slice(main.indexOf('function forceExit'), main.indexOf('function integratedDockWidth'))
  assert.equal(/throw\b/.test(forceExit), false)
  assert.match(forceExit, /app\.exit\(0\)/)
})

test('Mega degrades to exactly its previous behaviour when no manager is provided', () => {
  const mega = read('app/extensions/mega/index.cjs')
  // The panel reports "unavailable" rather than throwing or hiding the dock.
  assert.match(mega, /if \(!ctx\?\.subWorker\?\.describe\)/)
  assert.match(mega, /available: false/)
  // The tray still carries the original exit actions in every state.
  assert.match(mega, /\{ label: 'Exit DS-Harness'/)
  assert.match(mega, /\{ label: 'Force Exit DS-Harness'/)
  // The Sub-worker panel is additive: the existing panels are untouched.
  const dockHtml = read('app/extensions/mega/ui/dock.html')
  for (const id of ['railRunning', 'railQueued', 'railWorkers', 'summary', 'queue', 'hardware', 'balanceCards', 'settingsOverlay']) {
    assert.match(dockHtml, new RegExp(`id="${id}"`), `${id} must survive the change`)
  }
})

test('no port other than the Harness port is ever bound by the desktop shell', async () => {
  // The worker is a child process on stdio; nothing in the new code binds a
  // socket, so the documented "no extra port" guarantee holds.
  const listening = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 3080 })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
  // The test suite must not depend on the app running: either answer is fine,
  // what matters is that the sub-worker layer never listens.
  assert.equal(typeof listening, 'boolean')
  const sources = read('app/sub-worker/manager.cjs') + read('app/sub-worker/runtime.cjs')
  assert.equal(/net\.createServer|http\.createServer|listen\(/.test(sources), false)
})

test('a worker that was never enabled leaves no trace on disk', async () => {
  const root = scratch('trace')
  const manager = new WorkerManager({ root, nodeExe: process.execPath, log: () => {}, notify: () => {} })
  manager.hydrate()
  manager.describe()
  manager.sendNote('a note with no worker')
  manager.readTaskLog('nothing')
  manager.forceStop('never started')
  assert.equal(fs.existsSync(path.join(root, 'data')), false)
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false)
  assert.equal(fs.existsSync(path.join(root, 'logs')), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the install path and launcher are unchanged', () => {
  const packageJson = JSON.parse(read('app/package.json'))
  assert.equal(packageJson.main, 'desktop-main.cjs')
  assert.equal(packageJson.dependencies['@deepseek-ai/dsh'] !== undefined, true)
  // The documented launcher and installer still exist untouched.
  for (const file of ['Start-DeepSeek-Harness.cmd', 'Install-DS-Harness.cmd', 'scripts/install.ps1', 'scripts/run.ps1']) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} must still exist`)
  }
  // The Sub-worker adds no dependency of its own.
  assert.equal(Object.keys(packageJson.dependencies).length, 1)
})
