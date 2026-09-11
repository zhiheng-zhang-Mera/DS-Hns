'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
const runtime = fs.readFileSync(path.join(ROOT, 'app', 'runtime-process.cjs'), 'utf8')
const mega = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')
const dockHtml = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'dock.html'), 'utf8')
const dockJs = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'dock.js'), 'utf8')

function officialCreateWindowBody() {
  return main.slice(main.indexOf('function createWindow()'), main.indexOf('async function startExtensions'))
}

test('official main BrowserWindow has no preload injection', () => {
  assert.equal(/preload\s*:/.test(officialCreateWindowBody()), false)
})

test('legacy monitor app is removed from core', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'monitor')), false)
})

test('Mega lives under optional extensions and has a kill switch', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs')), true)
  assert.match(main, /DSH_DISABLE_MEGA/)
})

test('Mega right dock is an isolated BrowserWindow and never mutates official renderer', () => {
  for (const file of ['dock.html', 'dock.js', 'dock.css']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', file)), true)
  }
  assert.match(mega, /function createDock\(/)
  assert.match(mega, /parent: ctx\.mainWindow/)
  assert.match(mega, /skipTaskbar: true/)
  assert.match(mega, /DOCK_COLLAPSED_WIDTH\s*=\s*48/)
  assert.match(mega, /DOCK_DEFAULT_WIDTH\s*=\s*560/)
  assert.match(mega, /DSH_MEGA_DOCK/)
  assert.doesNotMatch(officialCreateWindowBody(), /preload\s*:/)
})

test('Mega dock never shrinks the official DSH BrowserWindow to make room', () => {
  assert.doesNotMatch(mega, /ctx\.mainWindow\.(?:setBounds|setSize|setContentSize)\s*\(/)
  assert.match(mega, /dockWindow\.setBounds\(/)
})

test('dock collapse state is persisted independently of official DSH state', () => {
  assert.match(mega, /mega-dock\.json/)
  assert.match(mega, /loadDockState/)
  assert.match(mega, /saveDockState/)
  assert.match(mega, /setDockExpanded/)
  assert.match(mega, /dockExpanded/)
})

test('collapsed rail remains useful and expanded dock contains queue and hardware controls', () => {
  assert.match(dockHtml, /id="rail"/)
  assert.match(dockHtml, /id="railRunning"/)
  assert.match(dockHtml, /id="railQueued"/)
  assert.match(dockHtml, /id="railWorkers"/)
  assert.match(dockHtml, /手动队列/)
  assert.match(dockHtml, /硬件自适应并行/)
  assert.match(dockJs, /reorderTask/)
  assert.match(dockJs, /hardwareCap/)
})

test('the tray keeps its exit actions, adds the documented Sub-worker controls and has no secondary Mega window', () => {
  assert.match(main, /Tray, Menu, nativeImage, screen/)
  assert.match(mega, /function createTray\(/)
  assert.match(mega, /function applyTrayMenu\(/)
  assert.match(mega, /\{ label: 'Exit DS-Harness'/)
  assert.match(mega, /\{ label: 'Force Exit DS-Harness'/)
  // No navigation/control items and no Full Mega Tools product concept.
  for (const removed of ['Expand Mega Dock', 'Collapse Mega Dock', 'Show Mega Dock', 'Hide Mega Dock', 'Full Mega Tools']) {
    assert.equal(new RegExp(removed).test(mega), false, `tray menu must not offer ${removed}`)
  }
  assert.equal(/function openTools\(/.test(mega), false)
  assert.equal(/toolsWindow/.test(mega), false)
  assert.equal(/mega:open-tools/.test(mega), false)
  assert.equal(/mega:open-main/.test(mega), false)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'index.html')), false)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'renderer.js')), false)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'style.css')), false)
  // Settings live inside the dock as an overlay, not in a second window.
  assert.match(dockHtml, /id="settingsOverlay"/)
  assert.match(dockHtml, /id="openSettings"/)
  assert.equal(/new BrowserWindow/.test(dockJs), false)
  // The tray is a second entry point for the optional Sub-worker (plan §16):
  // the worker has no window of its own, so Start/Stop/Restart/Pause and the
  // Live View shortcut must be reachable without opening the dock first.
  assert.match(mega, /function subWorkerTrayItem\(/)
  assert.match(mega, /submenu: template/)
  for (const action of ['Start', 'Stop', 'Restart', 'Pause', 'Resume', 'Open Live View', 'Cancel Current Task', 'Take Over Workspace', 'Restart Worker']) {
    assert.ok(mega.includes(`'${action}'`), `the tray Sub-worker submenu must offer ${action}`)
  }
  // The busy line required by §16 is part of the submenu header.
  assert.match(mega, /Sub-worker: BUSY/)
  assert.match(mega, /Task: \$\{taskId \|\| 'Idle'\}/)
  assert.match(dockHtml, /id="liveView"/)
})

test('exit paths are graceful and force-exit capable in the shell', () => {
  assert.match(main, /function gracefulExit\(/)
  assert.match(main, /function forceExit\(/)
  assert.match(main, /function teardownManagedResources\(/)
  assert.match(main, /shutdown: \{/)
  assert.match(main, /taskkill\.exe', \['\/pid', String\(childPid\), '\/T', '\/F'\]/)
  assert.match(main, /app\.exit\(0\)/)
  // State is persisted (extension stop) before the managed child is killed.
  const teardown = main.slice(main.indexOf('function teardownManagedResources'), main.indexOf('function gracefulExit'))
  assert.ok(teardown.indexOf('extensionManager?.stop?.()') >= 0)
  assert.ok(
    teardown.indexOf('extensionManager?.stop?.()') < teardown.indexOf('stopHarness()'),
    'normal exit must flush/persist state before stopping the managed Harness'
  )
  // Force exit keeps going even when a cleanup step fails.
  const force = main.slice(main.indexOf('function forceExit'), main.indexOf('function integratedDockWidth'))
  assert.ok(force.length > 0 && force.length < 2000, 'the force exit body must be extractable')
  assert.equal(/throw\b/.test(force), false, 'no cleanup step may abort the force exit')
  assert.match(force, /app\.exit\(0\)/)
  // The extension routes both tray actions to the shell hook.
  assert.match(mega, /function requestShutdown\(mode = 'graceful'\)/)
  assert.match(mega, /hook\.force\('tray'\)/)
  assert.match(mega, /hook\.graceful\('tray'\)/)
  assert.match(mega, /tray\.on\('double-click', focusMain\)/)
})

test('Ctrl+Shift+M toggles the dock using actual input logic', () => {
  const shortcutStart = mega.indexOf('shortcutHandler =')
  const shortcutEnd = mega.indexOf("ctx.mainWindow.webContents.on('before-input-event'", shortcutStart)
  assert.ok(shortcutStart >= 0)
  assert.ok(shortcutEnd > shortcutStart)
  const shortcut = mega.slice(shortcutStart, shortcutEnd)
  assert.match(shortcut, /input\.control/)
  assert.match(shortcut, /input\.shift/)
  assert.match(shortcut, /key\s*===\s*['\"]m['\"]/)
  assert.match(shortcut, /toggleDock\(/)
})

test('startup detects any listener on 3080 instead of treating authenticated 401 as free', () => {
  assert.match(main, /function isHarnessPortListening/)
  assert.match(main, /net\.createConnection/)
  assert.match(main, /if \(await isHarnessPortListening\(\)\)/)
  assert.doesNotMatch(main, /if \(await requestHarness\(HARNESS_URL\)\)/)
})

test('startup token capture tolerates chunk boundaries and either output stream', () => {
  assert.match(main, /STARTUP_BUFFER_LIMIT/)
  assert.match(main, /startupOutput = `\$\{startupOutput\}\$\{clean\}`/)
  assert.match(main, /observeStartupOutput\('stdout'/)
  assert.match(main, /observeStartupOutput\('stderr'/)
  assert.match(main, /localhost/)
})

test('startup failures expose the runtime log tail', () => {
  assert.match(main, /function readLogTail/)
  assert.match(main, /desktop-runtime\.log \(tail\)/)
  assert.match(main, /Log: \$\{logPath\(\)\}/)
})

test('runtime ownership is written for the spawned DSH child and cleared on exit', () => {
  assert.match(main, /runtimeProcess\.writeOwnership/)
  assert.match(main, /runtimeProcess\.clearOwnership/)
  assert.match(runtime, /dsh-process\.json/)
  assert.match(runtime, /childPid/)
  assert.match(runtime, /parentPid/)
})

test('owned stale DSH recovery runs before the port-3080 conflict check', () => {
  const startupBlock = main.slice(main.indexOf('app.whenReady()'))
  const recovery = startupBlock.indexOf('recoverOwnedStale')
  const portCheck = startupBlock.indexOf('isHarnessPortListening()')
  assert.ok(recovery >= 0)
  assert.ok(portCheck > recovery)
  assert.match(runtime, /isExpectedDshProcess/)
  assert.match(runtime, /taskkill\.exe/)
})
