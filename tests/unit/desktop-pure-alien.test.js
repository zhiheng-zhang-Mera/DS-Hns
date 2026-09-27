'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.resolve(__dirname, '../../app/desktop-main.cjs'), 'utf8')
const policy = source.split(/\r?\n/).find(line => line.startsWith('const INTEGRATED_MEGA_DOCK ='))
const start = source.indexOf('async function showIntegratedMegaDock() {')
const show = source.slice(start, source.indexOf('\nfunction hideIntegratedMegaDock()', start))

// Execute the shipped policy and entrypoint, with only Electron view creation
// replaced. A disabled extension must not leave a dead reserved dock reachable.
for (const dock of [undefined, '1']) {
  test(`PureAlien refuses dock creation even when integrated preference is ${dock}`, async () => {
    let created = 0
    let layouts = 0
    const context = vm.createContext({
      process: { env: { DSH_DISABLE_MEGA: '1', DSH_MEGA_INTEGRATED_DOCK: dock } },
      megaDockShown: false, megaDockView: null,
      createIntegratedMegaDock: async () => { created++; context.megaDockView = { setVisible() {} } },
      layoutIntegratedViews: () => { layouts++ }, logLine: () => {}
    })
    const open = vm.runInContext(`${policy}\n${show}\nshowIntegratedMegaDock`, context)
    assert.equal(await open(), false)
    assert.equal(created, 0)
    assert.equal(layouts, 0)
    assert.equal(context.megaDockShown, false)
  })
}

test('normal enhanced launch still creates and shows the requested dock', async () => {
  let visible = false
  const context = vm.createContext({
    process: { env: { DSH_MEGA_INTEGRATED_DOCK: '1' } }, megaDockShown: false, megaDockView: null,
    createIntegratedMegaDock: async () => { context.megaDockView = { setVisible(value) { visible = value } } },
    layoutIntegratedViews() {}, logLine() {}
  })
  const open = vm.runInContext(`${policy}\n${show}\nshowIntegratedMegaDock`, context)
  assert.equal(await open(), true)
  assert.equal(visible, true)
})
