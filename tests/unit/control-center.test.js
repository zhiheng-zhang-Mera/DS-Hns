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
        activeQueue: { workerSlotsInUse: 2, queued: 3, suspended: 1, running: 2, total: 4 },
        concurrency: { current: 2, hardwareCap: 5 },
        peak: { peak: false },
        system: { cpu: { usagePercent: 34.4 }, memory: { usedGb: 12.44 } }
      },
      /**
       * The active queue, as `snapshot()` publishes it (`scheduler.listTasks()`).
       *
       * Two queued tasks and one running one: the dashboard's queue block is built from exactly this list, so a count
       * and the tasks under it cannot disagree — and only the queued ones are editable or reorderable.
       */
      tasks: [
        { id: 'task-a', prompt: '总结今天的构建日志', promptPreview: '总结今天的构建日志', status: 'SUSPENDED', reason: 'waiting-schedule', startAtMs: 1_789_468_752_929, allowPeak: false, deliveryMode: 'official-session', queueRank: 1 },
        { id: 'task-b', prompt: '把报告发到工作区', promptPreview: '把报告发到工作区', status: 'PENDING', reason: null, startAtMs: null, allowPeak: true, deliveryMode: 'official-session', queueRank: 2 },
        { id: 'task-c', prompt: '正在跑的那件', promptPreview: '正在跑的那件', status: 'RUNNING', reason: 'official-session', startAtMs: null, allowPeak: true, deliveryMode: 'official-session', queueRank: null }
      ],
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
        { id: 'dsh-wallpaper-engine', state: 'installed', present: true, expected: 'v0.7.1', installedVersion: 'v0.7.1', reason: null, channel: 'harness-profile', channelVerified: true, tested: false },
        { id: '@dsh-market/plugin', state: 'untested', present: false, expected: '2c34728', installedVersion: null, reason: 'nobody has tested it inside DS-Hns yet' }
      ]
    },
    boot: { state: 'ENHANCED', interactive: true, phases: [{ id: 'interactive' }], overBudget: [], ownOverhead: 2 },
    cache: { at: 1_700_000_000_000, warm: true, ageMs: 60_000, entries: { workspace: 'D:/work/one', appearance: { preset: 'reading' } } },
    appearance: { glass: { blur: 22, opacity: 82 }, wallpaper: { windowBytes: 5 * 1024 * 1024, dockBytes: 0, bytes: 5 * 1024 * 1024, kilobytes: 5120 }, warnings: [{ id: 'blur-over-comfort' }] },
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
  // §52: the cache is a hint about the previous run, and a cold start is not a fault.
  assert.equal(diagnostics.rows.find((row) => row.cn === '上次启动缓存').value, 'warm')
  assert.equal(diagnostics.rows.find((row) => row.cn === '上次工作区').value, 'D:/work/one')
  assert.equal(buildControlCenter().sections.find((section) => section.id === 'diagnostics').rows.find((row) => row.cn === '上次启动缓存').value, 'cold')
  // §55-§57: what the appearance costs, measured and never clamped — a heavy number is a warning, not a
  // refused value.
  assert.equal(resources.rows.find((row) => row.cn === '玻璃模糊').value, '22px')
  assert.equal(resources.rows.find((row) => row.cn === '玻璃模糊').tone, 'warn')
  assert.equal(resources.rows.find((row) => row.cn === '图片负载').value, '5120 KB')
  assert.equal(resources.rows.find((row) => row.cn === '性能警示').value, 'blur-over-comfort')
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

/**
 * The dashboard block: the live numbers the old expanded dock drew for itself, now part of the snapshot so the
 * view model can carry them to a surface that has no dock (the system orb's panel, the Mega plugin's page).
 *
 * Two rules are worth pinning here rather than in the view model, because they are about *this* module: it is
 * built from the same snapshot the sections above use, and the two facts it cannot get from the snapshot are
 * handed in (the account and the price list) rather than looked up a second time.
 */
test('the dashboard carries the scheduler\'s queue and parallelism, the price window and the account', () => {
  const built = buildControlCenter(fixture({
    pricing: {
      source: 'official',
      retrievedAt: '2026-09-07',
      currency: 'CNY',
      schedule: { timeZone: 'Asia/Shanghai', peakPeriods: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }] }
    },
    balance: {
      ok: true,
      refreshing: false,
      stale: false,
      hasData: true,
      failedProviders: [],
      lastUpdatedAt: Date.parse('2026-09-15T05:30:00.000Z'),
      balances: [{ currency: 'CNY', total: 12.5, toppedUp: 10, granted: 2.5 }]
    }
  }))
  const dashboard = built.dashboard
  assert.equal(dashboard.ok, true)
  const rows = (list) => Object.fromEntries(list.map((row) => [row.id, row]))
  const price = rows(dashboard.lines.find((entry) => entry.id === 'price').rows)
  const balance = rows(dashboard.lines.find((entry) => entry.id === 'balance').rows)

  // The same queue the execution section counts — one snapshot, so the two cannot disagree.
  const execution = built.sections.find((section) => section.id === 'execution')
  assert.equal(execution.rows.find((row) => row.cn === '排队任务').value, '3')
  assert.equal(rows(dashboard.execution)['execution:queued'].value, '3')
  assert.equal(rows(dashboard.execution)['execution:running'].value, '2')
  assert.equal(rows(dashboard.execution)['execution:running'].tone, 'busy')
  assert.equal(rows(dashboard.parallelism)['parallelism:current'].value, '2')
  assert.equal(rows(dashboard.parallelism)['parallelism:hardware-cap'].value, '5')
  assert.equal(rows(dashboard.parallelism)['parallelism:cpu'].value, '34%')
  assert.equal(rows(dashboard.parallelism)['parallelism:free-ram'].value, '—', 'an unprobed memory figure is not zero')

  // The price window: the fixture is off-peak with no scheduled transition, which is a state and not a fault.
  assert.equal(price['price:window'].value, 'OFF-PEAK')
  assert.equal(price['price:window'].tone, null)
  assert.equal(price['price:windows'].value, '09:00-12:00, 14:00-18:00 · Asia/Shanghai')
  assert.equal(price['price:source'].value, 'official · 2026-09-07')
  assert.equal(price['price:until-off-peak'].value, '—')
  assert.equal(price['price:until-off-peak'].nextChangeIso, null)

  // The account, from the billing service's answer: three amounts and the state of the last read.
  assert.equal(balance['balance:total'].value, '¥ 12.50')
  assert.equal(balance['balance:topped-up'].value, '¥ 10.00')
  assert.equal(balance['balance:granted'].value, '¥ 2.50')
  assert.equal(balance['balance:state'].value, '正常 · ok')
  assert.equal(balance['balance:state'].tone, 'ok')
  assert.equal(balance['balance:updated-at'].value, '2026-09-15T05:30:00.000Z')
  // And the flat list keeps every group, in reading order, for a surface that draws one column.
  assert.deepEqual(dashboard.fields.map((row) => row.id).slice(0, 2), ['price:window', 'price:windows'])
  assert.equal(dashboard.fields.length, dashboard.lines.reduce((sum, entry) => sum + entry.rows.length, 0) + dashboard.execution.length + dashboard.parallelism.length)
})

test('the queue is published as tasks, with the counts the shut fold shows', () => {
  /**
   * "挂起任务数量没有改变，也不能编辑，也不能调顺序": a count alone answers neither "which one" nor "when", and it cannot be
   * acted on. So the dashboard carries the tasks themselves — ids, the instant as an ISO instant (never a number of
   * seconds that was already stale when it was written), the decision the gate made, and the rank a surface draws.
   *
   * The count is derived from the *same* two fields the execution rows use (`activeQueue.queued` and `.suspended`), so
   * "已挂起 2 · 等待 1" and the list under it cannot disagree.
   */
  const built = buildControlCenter(fixture())
  const queue = built.dashboard.queue
  assert.equal(queue.ok, true)
  assert.deepEqual(queue.counts, { pending: 2, suspended: 1, running: 2, total: 4 })
  assert.equal(queue.headline, '已挂起 1 · 等待 2')
  // Only what has not run yet: a RUNNING task is a conversation that has already started, and is neither editable nor
  // reorderable — publishing it here would offer buttons the scheduler refuses.
  assert.deepEqual(queue.tasks.map((task) => task.id), ['task-a', 'task-b'])
  assert.deepEqual(queue.tasks[0], {
    id: 'task-a',
    prompt: '总结今天的构建日志',
    status: 'SUSPENDED',
    reason: 'waiting-schedule',
    startAtIso: new Date(1_789_468_752_929).toISOString(),
    allowPeak: false,
    deliveryMode: 'official-session',
    rank: 1
  })
  // A task with no instant says so rather than inventing one.
  assert.equal(queue.tasks[1].startAtIso, null)

  // The queue's own state line is the execution group's **first** row, because that is the value a shut fold keeps on
  // its heading — the number that moves when something is scheduled has to be the number that is visible.
  assert.equal(built.dashboard.execution[0].id, 'execution:state')
  assert.equal(built.dashboard.execution[0].value, '已挂起 1 · 等待 2')
  assert.equal(built.dashboard.execution[0].tone, 'busy', 'a task waiting for its time is "something is happening", not a fault')
  // ...and a queue with nothing in it is quiet rather than alarming.
  const empty = buildControlCenter(fixture({ snapshot: { ...fixture().snapshot, tasks: [] } }))
  assert.deepEqual(empty.dashboard.queue.tasks, [])
  assert.equal(empty.dashboard.queue.counts.suspended, 1, 'the counts are the scheduler\'s, not a second count of the list')
  assert.equal(empty.dashboard.execution[0].tone, 'busy')
  // A snapshot with no queue at all (an older DS-Hns) is an empty list, not a crash.
  const withoutTasks = buildControlCenter(fixture({ snapshot: { ...fixture().snapshot, tasks: undefined } }))
  assert.deepEqual(withoutTasks.dashboard.queue.tasks, [])
})

test('a countdown is published as the instant it ends, and a balance never read is not ¥ 0.00', () => {
  // The peak window that ends in fifteen minutes: the snapshot carries the instant, because the seconds would
  // be stale the moment a panel opened later than the snapshot (`view.js` re-derives the countdown).
  const peak = buildControlCenter(fixture({
    snapshot: {
      ...fixture().snapshot,
      scheduler: {
        ...fixture().snapshot.scheduler,
        peak: { peak: true, nextChange: { iso: '2026-09-15T06:00:00.000Z', statusAfter: 'OFF-PEAK', secondsLeft: 900 } }
      }
    }
  }))
  const row = peak.dashboard.lines.find((entry) => entry.id === 'price').rows.find((entry) => entry.id === 'price:until-off-peak')
  assert.equal(row.value, '15m 0s')
  assert.equal(row.tone, 'ok')
  assert.equal(row.nextChangeIso, '2026-09-15T06:00:00.000Z')

  // An account that has never been read answers `—` and says so; a fabricated `¥ 0.00` would be a lie about
  // money. The same for a read that failed after a success: the last good value is shown, marked stale.
  const unread = buildControlCenter(fixture()).dashboard
  const balanceRows = (dashboard) => Object.fromEntries(dashboard.lines.find((entry) => entry.id === 'balance').rows.map((entry) => [entry.id, entry]))
  assert.equal(balanceRows(unread)['balance:total'].value, '—')
  assert.equal(balanceRows(unread)['balance:total'].tone, null)
  assert.equal(balanceRows(unread)['balance:state'].value, '未刷新 · not read yet')

  const failed = buildControlCenter(fixture({
    balance: {
      ok: false,
      refreshing: false,
      stale: true,
      hasData: true,
      failedProviders: ['deepseek-official'],
      error: { code: 'TIMEOUT', message: 'provider timed out after 20000ms' },
      balances: [{ currency: 'CNY', total: 8, toppedUp: 8, granted: 0 }]
    }
  })).dashboard
  assert.equal(balanceRows(failed)['balance:total'].value, '¥ 8.00', 'a failed read must not blank the last good one')
  assert.equal(balanceRows(failed)['balance:total'].tone, 'warn')
  assert.equal(balanceRows(failed)['balance:state'].value, '上次成功值 · stale')
})

/**
 * The refresh button, which is the dashboard's one action.
 *
 * The account is the only number on this dashboard that a *read* makes newer, so it is the only thing a refresh
 * button can honestly promise — and it is offered exactly when a read could change the answer. A button that
 * re-reads a current balance would spend the rate limit to change nothing; a missing button on a stale account
 * would leave the user with a number they cannot update.
 */
test('the dashboard offers a balance refresh when a read could change it, and withholds it when it cannot', () => {
  const actions = (built) => built.dashboard.actions

  // Never read, stale, failed, unconfigured: all four are states a read can move, so all four offer the button.
  assert.deepEqual(actions(buildControlCenter(fixture())), [{ id: 'refresh-balance', cn: '刷新余额', en: 'Refresh balance', reason: 'unread' }])
  const stale = actions(buildControlCenter(fixture({
    balance: { ok: false, hasData: true, stale: true, failedProviders: [], error: { code: 'TIMEOUT', message: 'slow' }, balances: [] }
  })))
  assert.deepEqual(stale.map((entry) => entry.reason), ['stale'])
  const failed = actions(buildControlCenter(fixture({
    balance: { ok: false, hasData: false, stale: false, failedProviders: ['deepseek-official'], error: { code: 'HTTP_500', message: 'server error' }, balances: [] }
  })))
  assert.deepEqual(failed.map((entry) => entry.reason), ['failed'])
  // While a read is in flight the button stays: it is what asks again once that read has settled.
  const refreshing = actions(buildControlCenter(fixture({
    balance: { ok: false, hasData: false, refreshing: true, failedProviders: [], balances: [] }
  })))
  assert.deepEqual(refreshing.map((entry) => entry.reason), ['refreshing'])

  // A current balance offers nothing: there is no read that would change it.
  const current = buildControlCenter(fixture({
    balance: {
      ok: true,
      refreshing: false,
      stale: false,
      hasData: true,
      failedProviders: [],
      balances: [{ currency: 'CNY', total: 12.5, toppedUp: 10, granted: 2.5 }]
    }
  }))
  assert.deepEqual(current.dashboard.actions, [])
  assert.equal(current.dashboard.lines.find((entry) => entry.id === 'balance').rows.find((entry) => entry.id === 'balance:state').value, '正常 · ok')
})

test('a machine with no API key is unconfigured, not broken', () => {
  /**
   * The startup read runs on a machine that may have no DeepSeek key at all, so this state exists because of it:
   * a warning tone on every boot of such a machine would be a permanent alarm about a setting nobody was asked
   * for. `MISSING_CREDENTIAL` is therefore its own state — an ordinary colour, words that name the cause, and
   * the refresh button still offered, because configuring the key and pressing it is exactly how it gets fixed.
   */
  const built = buildControlCenter(fixture({
    balance: {
      ok: false,
      refreshing: false,
      stale: false,
      hasData: false,
      failedProviders: ['deepseek-official'],
      error: { code: 'MISSING_CREDENTIAL', message: 'DEEPSEEK_API_KEY is not set' },
      balances: []
    }
  }))
  const rows = Object.fromEntries(built.dashboard.lines.find((entry) => entry.id === 'balance').rows.map((entry) => [entry.id, entry]))
  assert.equal(rows['balance:state'].value, '未配置密钥 · no API key')
  assert.equal(rows['balance:state'].tone, null, 'an unconfigured key is not a fault to be alarmed about')
  assert.equal(rows['balance:total'].value, '—')
  assert.deepEqual(built.dashboard.actions.map((entry) => entry.reason), ['unconfigured'])
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
  // The dashboard's two extra sources are handed in from the extension, and they are the real services: the
  // account comes from the billing service's own description and the price list from the scheduler's own
  // repository (a second load could disagree with the rates a task is billed at).
  assert.match(index, /balance: \(\(\) => \{[\s\S]{0,600}?balanceService\.describeCached\(\)/)
  assert.match(index, /pricing: \(\(\) => \{[\s\S]{0,400}scheduler\.pricing\?\.getSchedule/)
  /**
   * Drawing must not be able to read the account.
   *
   * The Control Center is assembled on every poll (15 s while the ball is open, plus every plugin request), and
   * a provider fan-out hidden behind one of its getters is exactly the kind of thing that arrives later as "why
   * is my rate limit gone". So: no `refreshBalances` inside the body of `controlCenter()` itself — the two
   * places a read may start are the startup pass and the user's own refresh action.
   */
  const from = index.indexOf('function controlCenter()')
  const controlCenter = index.slice(from, from + 2600)
  assert.ok(controlCenter.length > 600, 'the controlCenter() slice found nothing to check')
  assert.equal(/refreshBalances/.test(controlCenter), false, 'building the Control Center started a balance read')
  // The account is read once as the product comes up, off the boot path: until this existed the dashboard said
  // 未刷新 until somebody clicked something. Every trigger shares the one refresh entry point (§MEGA-04).
  assert.match(index, /function scheduleStartupBalanceRead\(\)/)
  assert.match(index, /refreshBalance\('startup'\)/)
  assert.match(index, /scheduleStartupBalanceRead\(\)/)
  assert.match(index, /timer\.unref\(\)/, 'the startup read is on the boot path')
  // And the dashboard's refresh button is a real read, answered without waiting for the provider: a 20-second
  // timeout must not hold a 340px panel open.
  const actionsFrom = index.indexOf('async function controlAction')
  const controlActionResult = index.slice(actionsFrom, index.indexOf('\n}\n', actionsFrom))
  assert.match(controlActionResult, /if \(action === 'refresh-balance'\)/)
  assert.match(controlActionResult, /balanceRefreshInFlight/)
  assert.equal(/await refreshBalance\('manual'\)/.test(controlActionResult), false, 'a dashboard refresh blocks the caller for the whole account read')
  // The actions a panel can ask for are exactly the ones the layer has (§47).
  for (const action of ['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable']) {
    assert.match(index, new RegExp(`action === '${action}'`), `the ${action} action is not wired`)
  }
  assert.match(preload, /control: \{/)
  // The cache is recorded by the extension in the background, with the owners' own values.
  assert.match(index, /function startupCache\(\)/)
  assert.match(index, /function rememberStartup\(\)/)
  assert.match(index, /const \{ createStartupCache \} = require\('\.\/startup-cache\.cjs'\)/)
  assert.match(index, /\.then\(\(\) => rememberStartup\(\)\)/)
  assert.match(index, /session` is deliberately not written/, 'the cache must not keep a second copy of the Harness\' sessions')
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
  // The three claims the manifest keeps apart reach the panel: channel, whether it was exercised, whether it
  // has been run in this product.
  assert.match(element('controlPlugins').innerHTML, /harness-profile · verified · untested/)
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
