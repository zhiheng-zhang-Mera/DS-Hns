'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  createStartupManager,
  STARTUP_STATE,
  STARTUP_PHASES,
  STARTUP_BUDGETS,
  formatDuration
} = require('../../app/startup.cjs')

/**
 * The startup states.
 *
 * The behaviour these tests are about is one sentence long, and it is the plan's §3.3: **INTERACTIVE
 * is startup complete.** Everything after it is deferred work that cannot delay the user and cannot
 * fail the boot. The failure that removes is a boot which waited for the Harness, then for the
 * extension host, then for the dock's renderer before showing anything — so a slow optional module
 * was indistinguishable from a product that had not started.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** A manager with a clock the test drives, so the boot report is exact rather than timing-dependent. */
function clocked() {
  let current = 0
  const lines = []
  const manager = createStartupManager({
    now: () => current,
    log: (line) => lines.push(line)
  })
  return { manager, lines, advance: (ms) => { current += ms } }
}

test('the states are ordered, and only the phases before INTERACTIVE are allowed to block', () => {
  const { manager } = clocked()
  const table = manager.phaseTable()
  const ids = table.map((phase) => phase.id)
  assert.deepEqual(ids, [...STARTUP_PHASES.map((phase) => phase.id)], 'the phase table is not the shipped order')
  const interactiveAt = ids.indexOf('interactive')
  for (const phase of table) {
    // INTERACTIVE itself is on the critical path: it is the milestone the path leads to, not work
    // behind it.
    const onThePath = ids.indexOf(phase.id) <= interactiveAt
    assert.equal(phase.critical, onThePath, `${phase.id} is ${onThePath ? 'not' : ''} marked critical`)
  }
  // The plan's budgets are recorded for the phases it named, and nothing invented for the rest.
  assert.equal(table.find((phase) => phase.id === 'core-ready').budget, STARTUP_BUDGETS['core-ready'])
  assert.equal(table.find((phase) => phase.id === 'wallpaper-ready').budget, null, 'a deferred phase got a budget')
  assert.equal(formatDuration(438), '438ms')
  assert.equal(formatDuration(2410), '2.4s')
})

test('the boot reports itself in the log\'s own shape, and cannot move backwards', () => {
  const { manager, lines, advance } = clocked()
  advance(112)
  manager.mark('window-created')
  assert.equal(manager.state(), STARTUP_STATE.BOOTING)
  advance(56)
  manager.mark('shell-ready')
  assert.match(lines[0], /^\[BOOT\] window-created\s+112ms/)
  assert.match(lines[0], /budget 200ms/)
  assert.equal(lines[0].includes('OVER BUDGET'), false, 'a phase inside its budget was reported as late')

  advance(3000)
  manager.mark('harness-ready')
  manager.mark('core-ready')
  assert.equal(manager.state(), STARTUP_STATE.CORE_READY)
  manager.mark('interactive')
  assert.equal(manager.state(), STARTUP_STATE.INTERACTIVE)
  const interactive = manager.summary()
  assert.equal(interactive.interactive, true)
  assert.equal(interactive.enhanced, false)
  // The number the plan's budget is really about: the part of the wall clock this product owns.
  assert.equal(interactive.ownOverhead, 0)

  // A phase marked twice keeps its first answer: a report that moves when something repaints is a
  // report nobody can compare between runs.
  advance(500)
  manager.mark('interactive')
  assert.equal(manager.summary().phases.filter((phase) => phase.id === 'interactive').length, 1)
  assert.ok(lines.some((line) => /OVER BUDGET/.test(line)), 'a phase past its budget was not reported')
})

test('deferred work cannot fail the boot, and says so itself', async () => {
  const { manager } = clocked()
  const ran = []
  const ok = manager.defer('official-surfaces-ready', async () => {
    ran.push('surfaces')
    return 'painted'
  })
  const failed = manager.defer('dock-ready', async () => {
    ran.push('dock')
    throw new Error('the dock renderer is gone')
  })
  // Neither promise rejects: the caller is a boot, and a boot has nothing to do with the answer.
  const results = await Promise.all([ok, failed])
  assert.deepEqual(ran.sort(), ['dock', 'surfaces'])
  assert.deepEqual(results[0], { id: 'official-surfaces-ready', ok: true, value: 'painted' })
  assert.equal(results[1].ok, false)
  assert.match(results[1].error, /dock renderer is gone/)
  const summary = await manager.settle()
  assert.deepEqual(summary.failed, ['dock-ready'])
  assert.deepEqual(summary.unknown, [])
  // The phase it failed on is still a phase of the boot, and INTERACTIVE is untouched by it.
  assert.equal(summary.phases.find((phase) => phase.id === 'dock-ready').failed, true)
})

test('INTERACTIVE is observable, and ENHANCED only after the deferred work settles', async () => {
  const { manager } = clocked()
  const seen = []
  manager.onInteractive(() => seen.push('later'))
  assert.deepEqual(seen, [], 'a listener fired before the user could work')
  manager.mark('window-created')
  manager.mark('interactive')
  assert.deepEqual(seen, ['later'])
  // A listener registered once the user can already work runs immediately, which is what a late
  // caller (a panel opened during the boot) needs.
  manager.onInteractive(() => seen.push('immediately'))
  assert.deepEqual(seen, ['later', 'immediately'])

  let settled = false
  manager.defer('extensions-ready', () => new Promise((resolve) => setTimeout(() => { settled = true; resolve(null) }, 10)))
  await manager.complete()
  assert.equal(settled, true, 'ENHANCED was reported before the deferred work settled')
  assert.equal(manager.state(), STARTUP_STATE.ENHANCED)
  assert.equal(manager.summary().enhanced, true)
})

test('the shell starts the official UI first, and only then the optional layers', () => {
  const main = read('app/desktop-main.cjs').replace(/\r\n/g, '\n')
  const order = (pattern) => {
    const index = main.search(pattern)
    assert.notEqual(index, -1, `${pattern} is missing from the boot`)
    return index
  }
  const skeleton = order(/await showStartupSkeleton\(\)/)
  const harness = order(/const readyUrl = await waitForHarness\(\)/)
  const interactive = order(/startup\.mark\('interactive'\)/)
  const deferredSurfaces = order(/startup\.defer\('official-surfaces-ready'/)
  const extensions = order(/startup\.defer\('extensions-ready'/)
  const dock = order(/startup\.defer\('dock-ready'/)

  // The window is on screen with a skeleton before anything is asked of the Harness…
  assert.ok(skeleton < harness, 'the skeleton goes up after the Harness was asked for a URL')
  // …the user can work as soon as the official UI is the window page…
  assert.ok(harness < interactive, 'INTERACTIVE was declared before the official UI arrived')
  // …and every optional layer is deferred behind that moment: wallpaper, extension host, dock.
  assert.ok(interactive < deferredSurfaces, 'the wallpaper layer is still on the critical path')
  assert.ok(interactive < extensions, 'the extension host is still on the critical path')
  assert.ok(interactive < dock, 'the dock is still on the critical path')
  assert.match(main, /if \(!mainWindow\.isVisible\(\)\) mainWindow\.show\(\)/, 'the window is never shown with the official UI')
  assert.match(main, /await startup\.complete\(\)/, 'the boot never reaches ENHANCED')
  assert.match(main, /startup\?\.mark\('wallpaper-ready'/, 'the wallpaper is not a boot phase of its own')

  // The skeleton itself: ours, inert, and readable. A blank screen is a defect (§14).
  const splash = read('app/splash.html')
  assert.equal(/<script/.test(splash), false, 'the skeleton gained a script')
  assert.match(splash, /script-src 'none'/)
  assert.match(splash, /正在恢复工作区/)
  assert.match(splash, /the core UI comes first/)
  assert.match(main, /showStartupSkeleton[\s\S]{0,400}loadFile\(path\.join\(__dirname, 'splash\.html'\)\)/)
})
