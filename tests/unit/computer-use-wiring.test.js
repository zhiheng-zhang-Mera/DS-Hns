'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Computer Use architecture gate (Update-Plan/computer-use.md).
 *
 * Same discipline as the theme, dual-UI and Sub-worker gates: a capability that
 * claim to be wired has to be wired *in the shipped files*, not only in its own
 * module. This test reads the shell, the dock, the preload, the config and the
 * CI definition and asserts the wiring is real — which is also what stops a
 * later refactor from quietly orphaning the runtime.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = (relative) => fs.existsSync(path.join(ROOT, relative))

const CORE_MODULES = [
  'app/computer-use/index.cjs',
  'app/computer-use/constants.cjs',
  'app/computer-use/errors.cjs',
  'app/computer-use/ports.cjs',
  'app/computer-use/contract.cjs',
  'app/computer-use/criteria.cjs',
  'app/computer-use/action.cjs',
  'app/computer-use/target.cjs',
  'app/computer-use/world-state.cjs',
  'app/computer-use/state-machine.cjs',
  'app/computer-use/safety.cjs',
  'app/computer-use/routing.cjs',
  'app/computer-use/log.cjs',
  'app/computer-use/stabilization.cjs',
  'app/computer-use/verification.cjs',
  'app/computer-use/miss.cjs',
  'app/computer-use/recovery.cjs',
  'app/computer-use/stall.cjs',
  'app/computer-use/observer.cjs',
  'app/computer-use/executor.cjs',
  'app/computer-use/isolation.cjs',
  'app/computer-use/autonomy.cjs',
  'app/computer-use/host-electron.cjs'
]

const CONTROLLERS = [
  'app/computer-use/controllers/browser.cjs',
  'app/computer-use/controllers/desktop.cjs',
  'app/computer-use/controllers/vision.cjs',
  'app/computer-use/controllers/shell.cjs',
  'app/computer-use/controllers/file.cjs'
]

const DRIVERS = [
  'app/computer-use/drivers/cdp-page.cjs',
  'app/computer-use/drivers/win32.cjs',
  'app/computer-use/drivers/win32-input.ps1',
  'app/computer-use/drivers/uia.cjs',
  'app/computer-use/drivers/uia.ps1',
  'app/computer-use/drivers/screenshot.cjs',
  'app/computer-use/drivers/screenshot.ps1'
]

test('every runtime module, controller and real driver is present', () => {
  for (const file of [...CORE_MODULES, ...CONTROLLERS, ...DRIVERS]) {
    assert.equal(exists(file), true, `${file} is missing`)
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 0, `${file} is empty`)
  }
})

test('the shell owns the runtime and registers its IPC surface', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /const COMPUTER_USE_CHANNELS = \[/)
  assert.match(shell, /function ensureComputerUseRuntime\(/)
  assert.match(shell, /function registerComputerUseIpc\(/)
  assert.match(shell, /function disposeComputerUseOnExit\(/)
  assert.match(shell, /function computerUseEnabled\(/)
  assert.match(shell, /function requestDestructiveConfirmation\(/)
  assert.match(shell, /createElectronHost\(\{/)
  // The runtime is created on demand, not during a normal boot.
  assert.match(shell, /registerComputerUseIpc\(\)/)
  assert.match(shell, /disposeComputerUseOnExit\('shell teardown'\)/)
  // The agent surface follows what the user is looking at.
  assert.match(shell, /function activeAgentSurface\(/)
  for (const channel of [
    'computer-use:snapshot',
    'computer-use:run',
    'computer-use:cancel',
    'computer-use:step',
    'computer-use:execute',
    'computer-use:health',
    'computer-use:page',
    'computer-use:log',
    'computer-use:screenshots',
    'computer-use:actions',
    'computer-use:capabilities'
  ]) {
    assert.ok(shell.includes(`'${channel}'`), `the shell does not register ${channel}`)
  }
})

test('the dock exposes a Computer Use panel and the preload bridges it', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const dock = read('app/extensions/mega/ui/dock.js')
  const panel = read('app/extensions/mega/ui/computer-use-panel.js')
  assert.match(html, /id="computerUsePanel"/)
  assert.match(html, /computer-use-panel\.js/)
  assert.match(html, /id="cuRun"/)
  assert.match(html, /id="cuCancel"/)
  assert.match(html, /id="cuHealth"/)
  assert.match(preload, /exposeInMainWorld\('megaComputerUse'/)
  assert.match(preload, /ipcRenderer\.invoke\('computer-use:run'/)
  assert.match(dock, /megaComputerUsePanel/)
  // The panel is a control surface: it edits a contract and reads reports, it
  // never drives the machine itself.
  assert.match(panel, /function buildContract\(/)
  assert.match(panel, /window\.megaComputerUse\.run/)
  assert.equal(/require\(|pyautogui|robotjs/.test(panel), false)
})

test('the runtime is configured in config/app.json with the documented defaults', () => {
  const config = JSON.parse(read('config/app.json'))
  assert.ok(config.computerUse, 'config/app.json has no computerUse block')
  assert.equal(typeof config.computerUse.enabled, 'boolean')
  assert.equal(config.computerUse.safety.destructiveActions, 'confirm')
  assert.equal(config.computerUse.safety.requireForegroundWindow, true)
  assert.equal(config.computerUse.safety.requireFocusForTyping, true)
  assert.equal(config.computerUse.vision.retention, 'failure')
  assert.ok(config.computerUse.limits.maxSteps >= 1)
  assert.ok(config.computerUse.timing.settleMinMs <= config.computerUse.timing.settlePreferredMs)
})

test('the syntax gate and the CI gate both cover the new directories', () => {
  const check = read('scripts/check-syntax.cjs')
  for (const dir of ["'computer-use'", "'computer-use/controllers'", "'computer-use/drivers'"]) {
    assert.ok(check.includes(dir), `check-syntax.cjs does not cover ${dir}`)
  }
  assert.ok(check.includes('computer-use-acceptance.cjs'), 'the acceptance harness is not syntax checked')

  const workflow = read('.github/workflows/verify.yml')
  assert.match(workflow, /branches: \[main, merging, Theme-Cover, computer-use\]/)
  assert.match(workflow, /name: Computer Use surface gate/)
  assert.match(workflow, /app\/computer-use\/executor\.cjs/)
  assert.match(workflow, /app\/computer-use\/drivers\/uia\.cjs/)
  assert.match(workflow, /app\/extensions\/mega\/ui\/computer-use-panel\.js/)
  assert.match(workflow, /docs\/computer-use\.md/)
})

test('the verification script asserts the same surface', () => {
  const verify = read('scripts/verify.ps1')
  assert.match(verify, /== Computer Use runtime/)
  assert.match(verify, /Computer Use core module/)
  assert.match(verify, /Computer Use real driver/)
  // verify.ps1 must stay ASCII-only for Windows PowerShell 5.1 (installer
  // contract), so the plan references appear as "(plan 6)" rather than "(plan §6)".
  assert.match(verify, /plan 6/)
  assert.match(verify, /plan 34/)
  assert.match(verify, /Computer Use reference doc exists/)
  assert.equal([...verify].some((character) => character.charCodeAt(0) > 127), false, 'verify.ps1 must stay ASCII-only')
})

test('the documentation and the acceptance harness ship with the runtime', () => {
  assert.equal(exists('docs/computer-use.md'), true)
  assert.equal(exists('scripts/computer-use-acceptance.cjs'), true)
  const doc = read('docs/computer-use.md')
  assert.match(doc, /Computer Use/)
  assert.match(doc, /Structure first/)
  assert.match(doc, /execution contract/i)
  const acceptance = read('scripts/computer-use-acceptance.cjs')
  assert.match(acceptance, /scenario/i)
})

test('the runtime never reaches into the official renderer or an Electron-only API', () => {
  for (const file of [...CORE_MODULES, ...CONTROLLERS]) {
    const source = read(file)
    assert.equal(/require\('electron'\)/.test(source), false, `${file} requires electron directly (only the host bridge may)`)
    assert.equal(/executeJavaScript/.test(source), false, `${file} must not script a renderer`)
    assert.equal(/insertCSS/.test(source), false, `${file} must not inject styles`)
  }
  // The host bridge is the single seam that knows about Electron objects.
  const host = read('app/computer-use/host-electron.cjs')
  assert.match(host, /createElectronDebuggerTransport/)
  assert.match(host, /createWin32Driver/)
  assert.match(host, /createUiaDriver/)
  assert.match(host, /createScreenshotDriver/)
})

test('no source file in the runtime learns anything about an application (plan §42)', () => {
  for (const file of [...CORE_MODULES, ...CONTROLLERS]) {
    const source = read(file)
    for (const forbidden of ['appProfile', 'userProfile', 'latencyModel', 'learnedProfile', 'reinforcement', 'chromeProfile']) {
      assert.equal(source.includes(forbidden), false, `${file} mentions ${forbidden}`)
    }
  }
})
