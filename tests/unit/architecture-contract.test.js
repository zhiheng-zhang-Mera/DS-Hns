'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

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
  // The rail is a container the dock renders registered items into, not a set of fixed boxes
  // (updateplan/startup2.md §41-§44): that is what makes "no duplicated Harness state" and the
  // collapsed budget possible without editing the dock for every number.
  assert.match(dockHtml, /id="railItems"/)
  assert.match(dockHtml, /id="railItemTemplate"/)
  assert.match(dockJs, /function renderRail\(/)
  assert.match(dockJs, /snapshot\.megaItems/)
  assert.match(dockHtml, /手动队列/)
  assert.match(dockHtml, /硬件自适应并行/)
  assert.match(dockJs, /reorderTask/)
  assert.match(dockJs, /hardwareCap/)
})

test('the tray keeps its exit actions, adds the documented Sub-worker controls and has no secondary Mega window', () => {
  assert.match(main, /Tray, Menu, nativeImage, screen/)
  assert.match(mega, /function createTray\(/)
  assert.match(mega, /function applyTrayMenu\(/)
  // The exit actions are still there, and their labels are bilingual like every other
  // title in the product (Chinese first, English second).
  assert.match(mega, /\{ label: bilingualTitle\('退出 DS-Harness', 'Exit DS-Harness'\)/)
  assert.match(mega, /\{ label: bilingualTitle\('强制退出 DS-Harness', 'Force Exit DS-Harness'\)/)
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

test('拓展状态 module aligns the main harness without touching the official renderer', () => {
  const updater = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'updater', 'harness-updater.js'), 'utf8')
  const runner = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'updater', 'update-runner.js'), 'utf8')

  // The dock owns the button; the extension owns the IPC; neither installs.
  assert.match(dockHtml, /拓展状态/)
  assert.match(dockHtml, /id="updateApply"/)
  assert.match(dockHtml, /id="updateCheck"/)
  assert.match(dockJs, /megaTools\.applyHarnessUpdate/)
  assert.match(dockJs, /megaTools\.checkHarnessUpdate/)
  assert.match(mega, /mega:update-check/)
  assert.match(mega, /mega:update-apply/)
  assert.match(mega, /scheduleRestart/)

  // Installing is delegated to a detached runner: npm can not replace the
  // harness while the shell still holds it open on Windows.
  assert.match(updater, /detached: true/)
  assert.match(updater, /registry\.npmjs\.org/)
  assert.doesNotMatch(updater, /spawnSync|execSync|execFile/, 'the extension never runs npm itself, it only hands off')
  assert.match(runner, /waitForParentExit/)
  assert.match(runner, /taskkill\.exe/)
  assert.match(runner, /restoreManifests/)
  // The pin is what stops scripts\install-deps.ps1 from reverting the update.
  assert.match(runner, /dependencies\[PACKAGE_NAME\] = rt\.target/)
  assert.match(runner, /relaunch/)

  // It never injects anything into the official renderer or resizes it.
  assert.equal(/WebContentsView|executeJavaScript|insertCSS/.test(runner), false)
})

test('exit paths are graceful and force-exit capable in the shell', () => {
  assert.match(main, /function gracefulExit\(/)
  assert.match(main, /function forceExit\(/)
  assert.match(main, /function teardownManagedResources\(/)
  assert.match(main, /shutdown: \{/)
  assert.match(main, /taskkill\.exe', \['\/pid', String\(childPid\), '\/T', '\/F'\]/)
  assert.match(main, /app\.exit\(0\)/)
  // State is persisted (extension stop) before the engine is released.
  //
  // The engine is released by detaching from the Runtime that owns it; the
  // in-process stop remains as a fallback for a shell that never attached, and
  // both spellings are accepted so the ordering cannot be satisfied by renaming
  // the call. What must stay true is unchanged: the extension stop — which is what
  // persists the scheduler queue and the task history — happens first.
  const teardown = main.slice(main.indexOf('function teardownManagedResources'), main.indexOf('function gracefulExit'))
  const extensionStopAt = teardown.indexOf('extensionManager?.stop?.()')
  const releaseAt = (() => {
    const direct = teardown.indexOf('stopHarness()')
    if (direct >= 0) return direct
    const inProcess = teardown.indexOf('stopHarnessInProcess()')
    if (inProcess >= 0) return inProcess
    return teardown.indexOf('runtimeClient.detach()')
  })()
  assert.ok(extensionStopAt >= 0, 'the extension stop is no longer on the teardown path')
  assert.ok(releaseAt >= 0, 'the teardown no longer releases the Harness')
  assert.ok(extensionStopAt < releaseAt, 'normal exit must flush/persist state before releasing the managed Harness')
  // Force exit keeps going even when a cleanup step fails.
  const forceMatch = main.match(/function forceExit\([^)]*\) \{([\s\S]*?)^\}/m)
  const force = forceMatch ? forceMatch[1] : ''
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
  const shortcutEnd = mega.indexOf("shortcutWebContents.on('before-input-event'", shortcutStart)
  assert.ok(shortcutStart >= 0)
  assert.ok(shortcutEnd > shortcutStart)
  const shortcut = mega.slice(shortcutStart, shortcutEnd)
  assert.match(shortcut, /shortcutWebContents = ctx\.officialWebContents \|\| ctx\.mainWindow\.webContents/)
  assert.match(shortcut, /input\.control/)
  assert.match(shortcut, /input\.shift/)
  assert.match(shortcut, /key\s*===\s*['\"]m['\"]/)
  assert.match(shortcut, /toggleDock\(/)
})

test('startup detects any listener on the Harness port instead of treating authenticated 401 as free', () => {
  // The detection itself is still a connect probe rather than an HTTP status
  // check, because DSH answers 401 at bare `/` until the token exchange
  // completes. It now lives in the Harness service, which the Runtime Host owns.
  const harnessService = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'harness-service.cjs'), 'utf8')
  assert.match(harnessService, /function isPortListening/)
  assert.match(harnessService, /net\.createConnection/)
  assert.doesNotMatch(harnessService, /isPortListening[\s\S]{0,200}response\.statusCode/)
  // The refusal to treat an HTTP answer as "free" is what the original assertion
  // was protecting, and it holds in the new location.
  assert.doesNotMatch(main, /if \(await requestHarness\(HARNESS_URL\)\)/)
})

test('the harness port is canonical by default and only overridable by opt-in', () => {
  // The default launch line, the port and the startup guard are unchanged; the
  // override exists so an acceptance run can start a second instance beside the
  // normal one instead of colliding on 3080.
  assert.match(main, /function normalizeHarnessPort/)
  assert.match(main, /const HARNESS_PORT = normalizeHarnessPort\(HARNESS_PORT_RAW\)/)
  assert.match(main, /if \(!Number\.isInteger\(parsed\) \|\| parsed < 1024 \|\| parsed > 65535\) return 3080/)
  // The port reaches the managed child only through the composed launch line.
  assert.match(main, /const DSH_LAUNCH_ARGS = \['web', '--no-open', \.\.\.\(HARNESS_PORT_OVERRIDE \? \['--port', String\(HARNESS_PORT\)\] : \[\]\)\]/)
  assert.match(main, /spawn\(nodeExe, \[DSH_ENTRY, \.\.\.DSH_LAUNCH_ARGS\]/)
  assert.match(main, /const HARNESS_PORT_OVERRIDE = Number\.isInteger\(HARNESS_PORT_RAW\) && HARNESS_PORT_RAW === HARNESS_PORT/)
  assert.match(main, /allowedHarnessNavigation[\s\S]*?HARNESS_PORT/)
  /**
   * The environment variable is read in exactly two places, and both are the same
   * decision seen from two sides: the shell's canonical launch line, and the
   * *request* it hands the instance resolver. Nothing else may read it, because a
   * third reader is a third answer to "which port is this instance on?".
   */
  const envReads = main.match(/process\.env\.DSH_HARNESS_PORT/g) || []
  assert.equal(envReads.length, 2, `the port env var is read ${envReads.length} times`)
  const instanceReads = main.match(/requestedPort: Number\(process\.env\.DSH_HARNESS_PORT\)/g) || []
  assert.equal(instanceReads.length, 1, 'the instance resolver must receive the requested port exactly once')
})

test('the launch line is byte-identical when the port is not overridden', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const source = require('node:fs').readFileSync(${JSON.stringify(path.join(ROOT, 'app', 'desktop-main.cjs'))}, 'utf8')
    const helper = source.match(/function normalizeHarnessPort[\\s\\S]*?\\n\\}/)[0]
    const normalize = new Function(helper + '; return normalizeHarnessPort')()
    const derive = (raw) => {
      const port = normalize(raw)
      const override = Number.isInteger(Number(raw)) && Number(raw) === port
      return { port, args: ['web', '--no-open', ...(override ? ['--port', String(port)] : [])] }
    }
    console.log(JSON.stringify({ none: derive(undefined), canonical: derive('3080'), alternate: derive('3091'), junk: derive('nope') }))
  `], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.none.args, ['web', '--no-open'], 'no override keeps the canonical line')
  assert.equal(parsed.none.port, 3080)
  assert.deepEqual(parsed.canonical.args, ['web', '--no-open', '--port', '3080'])
  assert.deepEqual(parsed.alternate.args, ['web', '--no-open', '--port', '3091'])
  assert.deepEqual(parsed.junk.args, ['web', '--no-open'], 'junk input falls back to the canonical line')
  assert.equal(parsed.junk.port, 3080)
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

test('owned stale DSH recovery runs before the Harness is asked to start', () => {
  /**
   * The invariant is unchanged — this instance's own orphaned Harness is reclaimed
   * before anything starts a new one — but the ordering moved with ownership. The
   * shell now resolves its instance and attaches; the recovery happens inside the
   * Runtime Host's `harness.start`, which is *before* it spawns the child and
   * before it decides the port is blocked.
   */
  const host = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'host.cjs'), 'utf8')
  const startBlock = host.slice(host.indexOf('async function startHarness()'), host.indexOf('function stopHarness()'))
  const recovery = startBlock.indexOf('recoverOwnedStale')
  const spawn = startBlock.indexOf('await harness.start()')
  assert.ok(recovery >= 0, 'the host no longer reclaims a stale Harness')
  assert.ok(spawn > recovery, 'recovery must run before a new Harness is spawned')
  // And the port check runs before the spawn too, so a foreign listener is
  // reported rather than fought over.
  assert.ok(startBlock.indexOf('isPortListening') < spawn, 'the port is not checked before spawning')
  assert.match(runtime, /isExpectedDshProcess/)
  assert.match(runtime, /taskkill\.exe/)
})

test('hidden integrated dock reserves no strip and creates no wallpaper notch', () => {
  const { computeIntegratedLayout } = require(path.join(ROOT, 'app', 'extensions', 'mega', 'dock', 'integrated-layout.cjs'))
  const hidden = computeIntegratedLayout({
    contentWidth: 1472,
    contentHeight: 900,
    dockShown: false,
    expanded: false
  })
  assert.equal(hidden.dockVisible, false)
  assert.equal(hidden.dockBounds.width, 0)
  assert.equal(hidden.officialBounds.width, 1472)

  const verifier = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.ps1'), 'utf8')
  assert.match(verifier, /integrated-layout\.cjs/, 'the architecture gate must inspect the current layout helper')
  assert.ok(verifier.includes(String.raw`return layout\.dockVisible \? \{ x: layout\.dockBounds\.x, y: layout\.dockBounds\.y \} : null`),
    'the architecture gate must verify the wallpaper notch is visibility-gated')
})
