'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildControlCenter, moduleActions, pluginActions } = require('../../app/extensions/mega/control-center.cjs')

/**
 * The MEGA Control Center (`updateplan/startup2.md` §45-§47).
 *
 * The data is the contract: one source (the dock's own snapshot), the actions each state actually allows,
 * and a diagnostics section that says what the boot cost. The panel renders it, the shell answers the
 * actions, and neither invents a number.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function fixture(overrides = {}) {
  return {
    snapshot: {
      scheduler: {
        counts: { RUNNING: 2, PENDING: 3, FAILED: 0 },
        activeQueue: { workerSlotsInUse: 2, queued: 3 },
        concurrency: { current: 2, hardwareCap: 5 },
        peak: { peak: false },
        system: { cpu: { usagePercent: 34.4 }, memory: { usedGb: 12.44 } }
      },
      subWorker: { available: true, enabled: true, state: 'RUNNING', config: { autoDelegate: true } },
      features: { 'mega.balance': true, 'mega.theme': false }
    },
    protection: {
      modules: [
        { id: 'wallpaper-layer', state: 'HEALTHY', version: null, startMs: 12, retries: 0, lastError: null, fallback: 'idle' },
        { id: 'dsh-wallpaper-engine', state: 'DEGRADED', version: null, startMs: 240, retries: 2, lastError: 'renderer timeout', fallback: 'simple-wallpaper' }
      ],
      degraded: ['dsh-wallpaper-engine'],
      failed: [],
      events: [{ module: 'dsh-wallpaper-engine', event: 'fallback', state: 'simple-wallpaper' }]
    },
    bundled: {
      plugins: [
        { id: 'dsh-wallpaper-engine', state: 'installed', present: true, expected: 'v0.7.1', installedVersion: 'v0.7.1', reason: null },
        { id: '@dsh-market/plugin', state: 'untested', present: false, expected: '2c34728', installedVersion: null, reason: 'nobody has tested it inside DS-Hns yet' }
      ]
    },
    boot: { state: 'ENHANCED', interactive: true, phases: [{ id: 'interactive' }], overBudget: [], ownOverhead: 2 },
    ...overrides
  }
}

test('the sections are built from the dock\'s own snapshot, not from a second query', () => {
  const built = buildControlCenter(fixture())
  assert.deepEqual(built.sections.map((section) => section.id), ['execution', 'automation', 'resources', 'extensions', 'protection', 'diagnostics'])
  const execution = built.sections.find((section) => section.id === 'execution')
  assert.deepEqual(execution.rows.map((row) => row.value), ['2', '3', '0', '0', '0'])
  // Zero is quiet: a fault count of zero is reported as `0` and never carries a tone (§36).
  assert.equal(execution.rows.find((row) => row.cn === '失败').tone, null)
  const resources = built.sections.find((section) => section.id === 'resources')
  assert.equal(resources.rows.find((row) => row.cn === '并发 / 上限').value, '2 / 5')
  assert.equal(resources.rows.find((row) => row.cn === 'CPU').value, '34%')
  const diagnostics = built.sections.find((section) => section.id === 'diagnostics')
  assert.equal(diagnostics.rows.find((row) => row.cn === '本产品开销').value, '2ms')
  assert.equal(diagnostics.rows.find((row) => row.cn === '超预算阶段').value, 'none')
})

test('every state offers the actions the layer can actually honour', () => {
  assert.deepEqual(moduleActions('HEALTHY'), ['check', 'retry', 'reset-fallback'])
  assert.deepEqual(moduleActions('DISABLED'), ['retry'])
  assert.deepEqual(pluginActions('installed'), ['disable', 'repair'])
  assert.deepEqual(pluginActions('user-disabled'), ['enable'], 'a disabled plugin is offered no way to be overwritten')
  assert.deepEqual(pluginActions('missing'), ['repair'])
  const built = buildControlCenter(fixture())
  const degraded = built.modules.find((module) => module.id === 'dsh-wallpaper-engine')
  assert.equal(degraded.tone, 'warn')
  assert.equal(degraded.lastError, 'renderer timeout')
  assert.equal(degraded.fallback, 'simple-wallpaper')
  assert.equal(built.degraded, 1)
  assert.equal(built.failed, 0)
})

test('a snapshot with nothing in it is a panel of zeros, not a crash', () => {
  const built = buildControlCenter()
  assert.equal(built.ok, true)
  assert.deepEqual(built.modules, [])
  assert.deepEqual(built.plugins, [])
  assert.equal(built.sections.length, 6)
  assert.equal(built.sections.find((section) => section.id === 'diagnostics').rows[0].value, '—')
})

test('the Control Center is wired: data, actions, panel and feature', () => {
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const html = read('app/extensions/mega/ui/dock.html')
  const features = read('app/extensions/mega/features.cjs')
  const panel = read('app/extensions/mega/ui/control-panel.js')
  assert.match(index, /const \{ buildControlCenter \} = require\('\.\/control-center\.cjs'\)/)
  assert.match(index, /ipcMain\.handle\('mega:control-center'/)
  assert.match(index, /ipcMain\.handle\('mega:control-action'/)
  assert.match(index, /'mega:control-center', 'mega:control-action'/, 'the channels are not declared for cleanup')
  // The actions a panel can ask for are exactly the ones the layer has (§47).
  for (const action of ['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable']) {
    assert.match(index, new RegExp(`action === '${action}'`), `the ${action} action is not wired`)
  }
  assert.match(preload, /control: \{/)
  assert.match(html, /id="controlPanel"/)
  assert.match(html, /id="controlModules"/)
  assert.match(html, /id="controlPlugins"/)
  assert.match(html, /src="control-panel\.js"/)
  assert.match(features, /id: 'mega\.control-center'/)
  assert.match(features, /panels: \['controlPanel'\]/)
  assert.match(panel, /data-control-action/)
  assert.match(panel, /window\.megaControlPanel = \{ attach, render, refresh \}/)
})

/**
 * The panel itself, run against a minimal document: what it renders, and what a click does.
 *
 * This is the behaviour the plan is about — the actions live here (§47) and the panel is a view of the
 * shell's answer, so a click has to reach the shell's channel and the row has to show the refusal when
 * there is one.
 */
function loadPanel({ describe, action }) {
  const nodes = new Map()
  const element = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        className: '',
        listeners: new Map(),
        addEventListener(event, handler) { this.listeners.set(event, handler) },
        fire(event, payload) {
          const handler = this.listeners.get(event)
          return handler ? handler(payload) : undefined
        }
      })
    }
    return nodes.get(id)
  }
  for (const id of ['controlPanel', 'controlSections', 'controlModules', 'controlPlugins', 'controlSummary', 'controlMessage']) element(id)
  const document = { getElementById: element }
  const window = { document, megaTools: { control: { describe, action } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', read('app/extensions/mega/ui/control-panel.js'))(window, document)
  return { window, element, panel: window.megaControlPanel }
}

test('the panel renders the sections and the modules, and a click reaches the shell', async () => {
  const calls = []
  const data = buildControlCenter(fixture())
  const { panel, element } = loadPanel({
    describe: async () => data,
    action: async (payload) => { calls.push(payload); return { ok: true } }
  })
  panel.attach()
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(element('controlSections').innerHTML, /data-section="execution"/)
  assert.match(element('controlSections').innerHTML, /data-section="diagnostics"/)
  assert.match(element('controlModules').innerHTML, /data-module="dsh-wallpaper-engine"/)
  assert.match(element('controlModules').innerHTML, /renderer timeout/)
  assert.match(element('controlModules').innerHTML, /fallback simple-wallpaper/)
  assert.match(element('controlPlugins').innerHTML, /data-plugin="@dsh-market\/plugin"/)
  assert.match(element('controlSummary').textContent, /1 降级/)
  assert.equal(element('controlSummary').className, 'status-chip warn')

  // A click on a rendered action is the panel's whole purpose: it reaches the shell's channel with the
  // action and the id the row carries, and the panel re-reads the answer afterwards.
  await element('controlPanel').fire('click', { target: { getAttribute: (name) => (name === 'data-control-action' ? 'retry' : 'dsh-wallpaper-engine') } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls[0], { action: 'retry', id: 'dsh-wallpaper-engine' })
  assert.match(element('controlMessage').textContent, /retry dsh-wallpaper-engine/)
})

test('a refused action is a message, not a broken panel', async () => {
  const { panel, element } = loadPanel({
    describe: async () => buildControlCenter(fixture()),
    action: async () => ({ ok: false, reason: 'nothing to repair against: v0.7.1 has not been tested inside DS-Hns yet' })
  })
  panel.attach()
  await new Promise((resolve) => setImmediate(resolve))
  await element('controlPanel').fire('click', { target: { getAttribute: (name) => (name === 'data-control-action' ? 'repair' : '@dsh-market/plugin') } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(element('controlMessage').textContent, /not been tested inside DS-Hns/)
})

test('a panel with no bridge says so instead of rendering nothing', async () => {
  const nodes = new Map()
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', listeners: new Map(), addEventListener() {}, fire() {} })
    return nodes.get(id)
  }
  const document = { getElementById: element }
  const window = { document }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', read('app/extensions/mega/ui/control-panel.js'))(window, document)
  window.megaControlPanel.attach()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(element('controlModules').innerHTML, /no protected modules registered/)
  assert.match(element('controlPlugins').innerHTML, /no bundled plugins/)
})
