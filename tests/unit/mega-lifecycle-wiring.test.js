'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/**
 * Presentation/lifecycle wiring contracts after the refix收敛:
 * one terminal pipeline for every task path, one balance refresh implementation,
 * one in-dock settings layer and no secondary Mega window.
 */

test('the scheduler emits one canonical terminal event and no per-handler notification', () => {
  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /require\('\.\/lifecycle'\)/)
  assert.match(scheduler, /this\.emitSafe\(TERMINAL_EVENT, event\)/)
  assert.equal(/emit\('task-terminal'/.test(scheduler), false, 'the legacy event must not survive as a second source')
  for (const method of ['cancelTask', 'interruptTask', 'clearPending', 'removeTasks', 'finish']) {
    assert.match(scheduler, new RegExp(`${method}\\(`))
  }
  const terminateCalls = (scheduler.match(/this\.terminate\(|return this\.terminate\(/g) || []).length
  assert.ok(terminateCalls >= 4, 'all cancellation paths share the terminal transition')
  assert.match(scheduler, /removeFromActiveQueue/)
  assert.match(scheduler, /isTerminalStatus\(t\.status\)\) return false/)
})

test('every terminal path feeds one unified alert pipeline', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /const \{ createTerminalDispatcher \} = require\('\.\/notifications\/terminal-dispatch'\)/)
  assert.match(mega, /const \{ TerminalObserver \} = require\('\.\/tracker\/terminal-observer'\)/)
  assert.match(mega, /scheduler\.on\(TERMINAL_EVENT, dispatchTerminal\)/)
  assert.match(mega, /terminalObserver\.on\(TERMINAL_EVENT, dispatchTerminal\)/)
  assert.match(mega, /isManagedSession: \(sessionId\) => scheduler\.isManagedOfficialSession\(sessionId\)/)
  assert.match(mega, /notify: \(event\) => notificationService\.notifyTerminal\(event\)/, 'the only notification call sits inside the dispatcher')
  assert.equal(/scheduler\.on\([^)]*notifyTerminal/.test(mega), false, 'no per-observer notification handler')
  assert.match(mega, /terminalDispatcher\.dispatch\(event\)/)
  // The observer must be primed before it can alert (no boot alert storm).
  const observer = read('app/extensions/mega/tracker/terminal-observer.js')
  assert.match(observer, /prime\(\)/)
  assert.match(observer, /if \(!this\.primed\) this\.prime\(\)/)
  assert.match(observer, /sawUserMessage/)
  assert.match(observer, /delegationDepth/)
  assert.match(observer, /isMegaLaunchedCwd/)
})

test('the dock hosts the settings layer and the shared Balance module controller', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  assert.match(html, /<script src="balance-module\.js"><\/script>/)
  assert.ok(html.indexOf('balance-module.js') < html.indexOf('dock.js'))
  assert.match(html, /id="settingsOverlay"/)
  assert.match(html, /id="openSettings"/)
  const js = read('app/extensions/mega/ui/dock.js')
  assert.match(js, /attachBalanceModule/)
  assert.equal((js.match(/fetchBalance\(/g) || []).length, 1, 'the dock must not define a second refresh path')
  assert.match(js, /setSettingsOpen/)
  assert.equal(/new BrowserWindow/.test(js), false)
  const preload = read('app/extensions/mega/ui/preload.cjs')
  assert.match(preload, /fetchBalance: \(trigger = 'manual', options = \{\}\) => ipcRenderer\.invoke\('mega:balance', trigger, options\)/)
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /balanceService\.refreshBalances\(/)
  assert.equal((mega.match(/refreshBalances\(/g) || []).length, 1, 'one balance refresh implementation')
})

test('all former Full Mega Tools capabilities are reachable from the dock settings layer', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const js = read('app/extensions/mega/ui/dock.js')
  const mega = read('app/extensions/mega/index.cjs')
  // General
  for (const id of ['model', 'globalPermission', 'telemetry', 'apiKey']) assert.match(html, new RegExp(`id="${id}"`))
  // Notifications
  for (const id of ['soundEnabled', 'volume', 'soundCompleted', 'soundFailed', 'soundInterrupted', 'soundFile', 'notifyEnabled', 'notifyCancelled']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  // Workspace
  assert.match(html, /id="workspaceText"/)
  assert.match(html, /id="workspace"/)
  // Scheduler
  for (const id of ['minConcurrent', 'maxConcurrent', 'cpuReservePercent', 'memoryReserveGb', 'memoryPerWorkerGb', 'defaultAllowPeak', 'interruptRunningAtPeak']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  // The settings backend is reused, not duplicated.
  assert.match(js, /window\.megaTools\.updateSettings/)
  assert.match(js, /window\.megaTools\.updateScheduler/)
  assert.match(js, /window\.megaTools\.pickWorkspace/)
  assert.match(js, /window\.megaTools\.pickSound/)
  assert.equal(/require\(/.test(js), false, 'the dock stays a plain renderer script')
  assert.equal(/dock-settings-service|settingsServiceV2|settings-service-v2/.test(js + mega), false)
  // General/Notifications are open, advanced groups default to collapsed.
  assert.equal((html.match(/<details class="settings-group" open>/g) || []).length, 2)
})

test('the active queue and the history layer are both exposed to the UI', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /tasks: scheduler\.listTasks/)
  assert.match(mega, /history: recent/)
  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /listHistory\(/)
  assert.match(scheduler, /activeQueue: \{/)
  assert.match(scheduler, /managedOfficialSessionIds\(/)
})
