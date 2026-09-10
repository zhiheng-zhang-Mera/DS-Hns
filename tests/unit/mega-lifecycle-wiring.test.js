'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/**
 * Presentation/lifecycle wiring contracts for the MEGA cleanup:
 * one terminal event source, one balance refresh implementation and a settings
 * entry point for desktop notifications.
 */

test('the scheduler emits one canonical terminal event and no per-handler notification', () => {
  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /require\('\.\/lifecycle'\)/)
  assert.match(scheduler, /this\.emitSafe\(TERMINAL_EVENT, event\)/)
  assert.equal(/emit\('task-terminal'/.test(scheduler), false, 'the legacy event must not survive as a second source')
  // Every terminal path funnels through terminate().
  for (const method of ['cancelTask', 'interruptTask', 'clearPending', 'removeTasks', 'finish']) {
    assert.match(scheduler, new RegExp(`${method}\\(`))
  }
  const terminateCalls = (scheduler.match(/this\.terminate\(|return this\.terminate\(/g) || []).length
  assert.ok(terminateCalls >= 4, 'all cancellation paths share the terminal transition')
  assert.match(scheduler, /removeFromActiveQueue/)
  assert.match(scheduler, /isTerminalStatus\(t\.status\)\) return false/)
})

test('the extension entry point owns terminal side effects exactly once', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /scheduler\.on\(TERMINAL_EVENT/)
  assert.equal((mega.match(/scheduler\.on\(TERMINAL_EVENT/g) || []).length, 1)
  const listenerCount = (mega.match(/notificationService\.notifyTerminal/g) || []).length
  assert.equal(listenerCount, 1, 'notification dispatch is not scattered per task handler')
  assert.match(mega, /SOUND_EVENT_BY_TERMINAL/)
  assert.equal(/scheduler\.on\('task-terminal'/.test(mega), false)
})

test('dock and full tools load the one shared Balance module controller', () => {
  for (const file of ['app/extensions/mega/ui/dock.html', 'app/extensions/mega/ui/index.html']) {
    const html = read(file)
    assert.match(html, /<script src="balance-module\.js"><\/script>/)
    assert.ok(html.indexOf('balance-module.js') < html.indexOf('renderer.js') || html.indexOf('balance-module.js') < html.indexOf('dock.js'))
  }
  for (const file of ['app/extensions/mega/ui/dock.js', 'app/extensions/mega/ui/renderer.js']) {
    const js = read(file)
    assert.match(js, /attachBalanceModule/)
    assert.equal((js.match(/fetchBalance\(/g) || []).length, 1, `${file} must not define a second refresh path`)
  }
  const preload = read('app/extensions/mega/ui/preload.cjs')
  assert.match(preload, /fetchBalance: \(trigger = 'manual', options = \{\}\) => ipcRenderer\.invoke\('mega:balance', trigger, options\)/)
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /balanceService\.refreshBalances\(/)
  assert.equal((mega.match(/refreshBalances\(/g) || []).length, 1, 'one balance refresh implementation')
  assert.equal(/balanceService\.fetchBalance/.test(mega), false)
})

test('desktop notifications have a real settings entry point', () => {
  const settings = read('app/extensions/mega/settings/settings-service.js')
  assert.match(settings, /notificationService\.describe\(\)/)
  assert.match(settings, /notificationService\.updateConfig\(patch\)/)
  const html = read('app/extensions/mega/ui/index.html')
  assert.match(html, /id="notifyEnabled"/)
  assert.match(html, /id="notifyCancelled"/)
  const renderer = read('app/extensions/mega/ui/renderer.js')
  assert.match(renderer, /notifications: \{/)
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /notifications: patch\.notifications/)
})

test('the shell hands the notification capability to the extension', () => {
  const main = read('app/desktop-main.cjs')
  assert.match(main, /screen, Notification \} = require\('electron'\)/)
  assert.match(main, /electron: \{ app, BrowserWindow, dialog, shell, ipcMain, Tray, Menu, nativeImage, screen, Notification \}/)
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /notificationService\.setCreateNotification\(ctx\.electron\?\.Notification \|\| null\)/)
  assert.ok(
    mega.indexOf('notificationService.setCreateNotification') < mega.indexOf('scheduler.start()'),
    'the notifier must be bound before any task can reach a terminal state'
  )
})

test('the active queue and the history layer are both exposed to the UI', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /tasks: scheduler\.listTasks/)
  assert.match(mega, /history: recent/)
  assert.match(mega, /toSessionViews\(sessionReader\.listSessions/)
  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /listHistory\(/)
  assert.match(scheduler, /activeQueue: \{/)
})
