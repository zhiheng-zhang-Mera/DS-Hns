'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

// Catch the product's missing quit transition when auxiliary windows remain.
// Execute the actual createWindow function; Electron is an external boundary.
// This is not a substitute for the real installed-profile close/relaunch Journey.
const source = fs.readFileSync(path.resolve(__dirname, '../../app/desktop-main.cjs'), 'utf8')
const start = source.indexOf('function createWindow() {')
const end = source.indexOf('\n/**', start)
assert.ok(start >= 0 && end > start)

for (const integrated of [true, false]) {
  test(`primary window closing requests desktop exit despite live auxiliary windows (integrated=${integrated})`, () => {
    const calls = []
    const context = {
      BrowserWindow: class extends EventEmitter { constructor() { super(); this.webContents = {} } },
      INTEGRATED_MEGA_DOCK: integrated,
      bilingualTitle: (cn, en) => en,
      resolveAppIcon: () => undefined,
      configureOfficialWebContents: () => {},
      layoutIntegratedViews: () => {},
      shuttingDown: false,
      mainWindow: null,
      megaDockView: { name: 'still-owned-dock' },
      officialView: { name: 'still-owned-official-view' },
      app: { quit() { calls.push('quit'); context.shuttingDown = true } }
    }
    vm.createContext(context)
    vm.runInContext(source.slice(start, end) + '\ncreateWindow()', context)
    context.mainWindow.emit('closed')
    assert.deepEqual(calls, ['quit'], 'closing the primary window must not wait for hidden auxiliaries to close')
    assert.equal(context.mainWindow, null)
  })
}

test('primary close during explicit shutdown does not request recursive quit', () => {
  const calls = []
  const context = {
    BrowserWindow: class extends EventEmitter { constructor() { super(); this.webContents = {} } },
    INTEGRATED_MEGA_DOCK: true, bilingualTitle: (cn, en) => en,
    resolveAppIcon: () => undefined, configureOfficialWebContents: () => {},
    layoutIntegratedViews: () => {}, shuttingDown: true, mainWindow: null,
    megaDockView: null, officialView: null, app: { quit: () => calls.push('quit') }
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, end) + '\ncreateWindow()', context)
  context.mainWindow.emit('closed')
  assert.deepEqual(calls, [])
  assert.equal(context.mainWindow, null)
})

test('secondary instance stops entry evaluation after declining the lock', () => {
  const lockStart = source.indexOf('const hasSingleInstanceLock =')
  const lockEnd = source.indexOf('\nfunction logPath()', lockStart)
  assert.ok(lockStart >= 0 && lockEnd > lockStart)
  const effects = []
  // CommonJS module wrapper allows early return. The sentinel models all later
  // startup registrations; no native crash causality is inferred by this test.
  vm.runInNewContext('(function () {\n' + source.slice(lockStart, lockEnd) + '\ncontinued();\n})()', {
    app: { requestSingleInstanceLock: () => false, quit: () => effects.push('quit') },
    continued: () => effects.push('continued-startup')
  })
  assert.deepEqual(effects, ['quit'])
})

test('primary instance continues entry evaluation after acquiring the lock', () => {
  const lockStart = source.indexOf('const hasSingleInstanceLock =')
  const lockEnd = source.indexOf('\nfunction logPath()', lockStart)
  const effects = []
  vm.runInNewContext('(function () {\n' + source.slice(lockStart, lockEnd) + '\ncontinued();\n})()', {
    app: { requestSingleInstanceLock: () => true, quit: () => effects.push('quit') },
    continued: () => effects.push('continued-startup')
  })
  assert.deepEqual(effects, ['continued-startup'])
})
