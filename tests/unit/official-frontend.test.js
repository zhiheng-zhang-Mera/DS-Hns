'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The official renderer is the only frontend.
 *
 * Daily — the native HNS frontend — was removed, and with it the mode state machine, the
 * native `WebContentsView`, the mode IPC surface, the dock's mode panel and the sync layer.
 * A deletion of that size is only trustworthy if something fails when a reference survives,
 * because the dangling references are exactly the ones no unit test exercises: an IPC
 * handler nobody calls yet, a view the shell no longer creates, a channel the preload still
 * invokes. So this suite sweeps every shipped file for the removed vocabulary, and asserts
 * the positive shape of the end state: one view, rendered at boot, with no mode anywhere.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = (relative) => fs.existsSync(path.join(ROOT, relative))

/** Every shipped source file that must be free of the removed vocabulary. */
function shippedSources() {
  const roots = [path.join(ROOT, 'app'), path.join(ROOT, 'scripts')]
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(cjs|mjs|js|html|css)$/.test(entry.name)) continue
      files.push(full)
    }
  }
  for (const root of roots) walk(root)
  return files
}

/**
 * The CI workflow is deliberately *not* in that list.
 *
 * Its job is to name the removed paths as negative assertions — "this directory must not
 * exist" — so a mention there is the guard, not a reference. The workflow is asserted
 * separately, below, for exactly that.
 */

/**
 * The vocabulary that must not survive.
 *
 * Each entry is a name that only existed to serve Daily, the mode switch, or the native
 * renderer's data plane — so any occurrence is a leftover reference, not a coincidence.
 */
const FORBIDDEN = [
  ['native-ui', /native-ui/],
  ['nativeView', /\bnativeView\b/],
  ['frontend-mode state/manager/sync modules', /frontend-mode\/(state|manager|sync)\.cjs/],
  ['the mode runtime factory', /createFrontendModeRuntime/],
  ['the mode object', /\bMODE\.DAILY\b|\bMODE\.WORK\b|\bDEFAULT_STARTUP_MODE\b/],
  ['the mode store', /createModeState|normalizeMode\(|otherMode\(/],
  ['the mode manager', /createModeManager|ACTIVE_STATE/],
  ['the sync layer', /createSync\(|recordActiveSession/],
  ['the shell mode adapter', /createNativeModeAdapter|nativeMode\b|frontendModes\b/],
  ['the native theme target', /nativeThemeTarget|createNativeThemeAdapter|nativeRegionListeners|onNativeRegions/],
  ['the native IPC surface', /hns:native-/],
  ['the mode IPC surface', /mega:mode-/],
  ['the startup mode environment variable', /DSH_FRONTEND_MODE/],
  ['the dock mode panel', /modePanel|modeDaily|modeWork|modeStatus|modeNote|requestMode|renderMode\(|MODE_LABEL/],
  ['the apply-visibility switch', /applyFrontendVisibility|applyVisibility/],
  ['the native diagnostic field', /nativeFrontend/]
]

/**
 * Names deliberately *not* above, and why: `hns_native` is the HNS theme surface, which is
 * the dock — still our own renderer, still painted. `describeNativeData` is the extension's
 * report of the official model. Neither is the removed frontend, and a sweep that flagged
 * the bare word "native" would have to be ignored to stay useful.
 */

test('no shipped file still references Daily, the native view or the mode machinery', () => {
  const survivors = []
  for (const file of shippedSources()) {
    const source = fs.readFileSync(file, 'utf8')
    for (const [label, pattern] of FORBIDDEN) {
      const match = source.match(pattern)
      if (!match) continue
      const line = source.slice(0, match.index).split('\n').length
      survivors.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line} ${label} (${match[0]})`)
    }
  }
  assert.deepEqual(survivors, [], `references to the removed Daily frontend survive:\n  ${survivors.join('\n  ')}`)
})

test('the removed files are gone and the remaining runtime has no mode', () => {
  for (const file of [
    'app/native-ui/index.html',
    'app/native-ui/app.js',
    'app/native-ui/preload.cjs',
    'app/frontend-mode/state.cjs',
    'app/frontend-mode/manager.cjs',
    'app/frontend-mode/sync.cjs',
    'scripts/dual-ui-acceptance.mjs',
    'tests/unit/dual-ui.test.js',
    'tests/unit/native-ui-render.test.js'
  ]) {
    assert.equal(exists(file), false, `${file} should have been removed with Daily`)
  }
  // What is left of the frontend runtime is the official adapter, its backend and the probe.
  const runtime = require('../../app/frontend-mode/index.cjs')
  assert.equal(typeof runtime.createFrontendRuntime, 'function')
  assert.equal(runtime.MODE, undefined, 'the mode vocabulary must not be exported')
  assert.equal(runtime.MODES, undefined)
  assert.equal(runtime.createModeState, undefined)
  assert.equal(runtime.createFrontendModeRuntime, undefined)
  assert.equal(runtime.createSync, undefined)
})

test('the shell renders the official view and never hides it', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /const nextOfficialView = new WebContentsView/)
  assert.match(shell, /officialView = nextOfficialView/)
  // The official view is shown, and nothing parks it: the native branch that used to
  // shadow it is gone, so there is exactly one frontend to look at.
  assert.match(shell, /showOfficialFrontend\(/)
  assert.equal(/setBounds\(showNative|parked/.test(shell), false, 'the official view must not be parked for another frontend')
  // The runtime the shell builds is the official one.
  assert.match(shell, /createFrontendRuntime\(/)
  assert.equal(/createFrontendModes\(/.test(shell), false)
})

test('the dock and the tray carry no mode control', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const dock = read('app/extensions/mega/ui/dock.js')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  assert.equal(/id="modePanel"/.test(html), false, 'the dock still has an Interface Mode panel')
  assert.equal(/mode-option|mode-selector/.test(html), false)
  assert.equal(/\bmode\b/.test(dock.slice(dock.indexOf('const MODE_LABEL') === -1 ? 0 : dock.indexOf('const MODE_LABEL'), dock.indexOf('const MODE_LABEL') + 600)), false)
  assert.equal(/hns:native-|mega:mode-/.test(preload), false, 'the preload still bridges the removed surfaces')  // The panels that remain are still there.
  for (const id of ['pluginsPanel', 'balancePanel', 'engineeringPanel', 'computerUsePanel', 'skillsPanel']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} disappeared with the mode panel`)
  }
})

test('the CI gate refuses a re-introduced native frontend', () => {
  const workflow = read('.github/workflows/verify.yml')
  // The workflow is the one place that *names* the removed paths, as negative assertions.
  assert.match(workflow, /app\/native-ui/, 'the gate no longer checks for the removed native frontend')
  assert.match(workflow, /frontend-mode\/state\.cjs/)
  assert.match(workflow, /Write-Error "\$gone should have been removed with the Daily frontend"/)
  // And it must not require any of them to exist.
  assert.equal(/\$required = @\([^)]*native-ui/s.test(workflow), false, 'the gate still requires a removed file')
})

test('the documentation records the decision instead of the removed plan', () => {
  const doc = read('docs/dual-ui.md')
  assert.match(doc, /official/i)
  assert.match(doc, /removed|no longer|only frontend/i)
  assert.equal(exists('scripts/dual-ui-acceptance.mjs'), false)
})
