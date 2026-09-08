'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
const runtime = fs.readFileSync(path.join(ROOT, 'app', 'runtime-process.cjs'), 'utf8')
const mega = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')

test('official main BrowserWindow has no preload injection', () => {
  const createWindowBody = main.slice(main.indexOf('function createWindow()'), main.indexOf('async function startExtensions'))
  assert.equal(/preload\s*:/.test(createWindowBody), false)
})

test('legacy monitor app is removed from core', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'monitor')), false)
})

test('Mega lives under optional extensions and has a kill switch', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs')), true)
  assert.match(main, /DSH_DISABLE_MEGA/)
})

test('Mega companion remains an isolated child window instead of injecting into official renderer', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'widget.html')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'widget.js')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'widget.css')), true)
  assert.match(mega, /function createWidget\(/)
  assert.match(mega, /parent: ctx\.mainWindow/)
  assert.match(mega, /skipTaskbar: true/)
  assert.match(mega, /DSH_MEGA_WIDGET/)
  assert.doesNotMatch(main.slice(main.indexOf('function createWindow()'), main.indexOf('async function startExtensions')), /preload\s*:/)
})

test('Mega tray and full tools entrances are restored without replacing the Alien shell', () => {
  assert.match(main, /Tray, Menu, nativeImage, screen/)
  assert.match(mega, /function createTray\(/)
  assert.match(mega, /Mega Extensions/)
  assert.match(mega, /Show Mega Companion/)

  // Validate the actual Ctrl+Shift+M behavior instead of requiring a literal
  // documentation string such as "Ctrl+Shift+M" to exist in the source.
  const shortcutStart = mega.indexOf('shortcutHandler =')
  const shortcutEnd = mega.indexOf("ctx.mainWindow.webContents.on('before-input-event'", shortcutStart)
  assert.ok(shortcutStart >= 0)
  assert.ok(shortcutEnd > shortcutStart)
  const shortcut = mega.slice(shortcutStart, shortcutEnd)
  assert.match(shortcut, /input\.control/)
  assert.match(shortcut, /input\.shift/)
  assert.match(shortcut, /key\s*===\s*['\"]m['\"]/)
  assert.match(shortcut, /openTools\(\)/)
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
