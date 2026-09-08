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

test('Mega tray and full tools remain available alongside the dock', () => {
  assert.match(main, /Tray, Menu, nativeImage, screen/)
  assert.match(mega, /function createTray\(/)
  assert.match(mega, /Expand Mega Dock/)
  assert.match(mega, /Full Mega Tools/)
  assert.match(mega, /function openTools\(/)
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
