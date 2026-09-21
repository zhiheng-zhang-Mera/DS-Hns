'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { BRIDGE_ACTIONS } = require('../../app/core/governance-bridge.cjs')

/**
 * The Mega view model (`app/plugins/mega-core/lib/view.js`, `updateplan/pluginize.md` §4.2-§4.4).
 *
 * This is the whole of what the orb, its panel and the settings page say, derived from the governance
 * snapshot DS-Hns already answers with. It is tested here rather than through the UI because the rules worth
 * testing are not visual: which tone a state has, what counts as "attention", and — the one that matters most
 * — that "DS-Hns is not running" is its own status instead of a silently empty "healthy".
 *
 * The view carries **two** halves now, and both are asserted here because both are contracts: the eleven
 * governance fields of §4.4 (the Settings page), and the dashboard the old expanded dock used to draw itself —
 * the price window and its countdown, the account balance, the scheduler's queue and the parallelism. The
 * second half is read out of `controlCenter().dashboard`, so the two halves cannot disagree: there is one set
 * of numbers, and the countdown is the only thing this file computes (from the instant, against its own clock).
 */

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(ROOT, 'app', 'plugins', 'mega-core')
const read = (relative) => require('node:fs').readFileSync(path.join(ROOT, relative), 'utf8')

async function loadView() {
  return import(pathToFileURL(path.join(PLUGIN, 'lib', 'view.js')).href)
}

const { buildControlCenter } = require('../../app/extensions/mega/control-center.cjs')

/**
 * The dashboard block exactly as the Control Center builds it, with live-looking values: a peak window that
 * ends in fifteen minutes, a balance that has been read, a queue with work in it and a hardware cap.
 */
function dashboardSnapshot() {
  return buildControlCenter({
    snapshot: {
      scheduler: {
        counts: { RUNNING: 2, PENDING: 3, SUSPENDED: 1, BLOCKED: 0, RETRYING: 0, FAILED: 0 },
        activeQueue: { total: 6, running: 2, queued: 3, suspended: 1, workerSlotsInUse: 2 },
        concurrency: { current: 4, hardwareCap: 6 },
        peak: { peak: true, nextChange: { iso: '2026-09-15T06:00:00.000Z', statusAfter: 'OFF-PEAK', secondsLeft: 900 } },
        system: { cpu: { usagePercent: 31.6 }, memory: { freeGb: 12.34, usedGb: 20 } }
      },
      subWorker: { available: true, enabled: true, state: 'IDLE', config: { autoDelegate: false } }
    },
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
  })
}

/** A governance snapshot shaped exactly like `buildControlCenter`'s answer, with one degraded module. */
function snapshot(overrides = {}) {
  return {
    ok: true,
    sections: [],
    modules: [
      { id: 'bundled:dsh-wallpaper-engine', state: 'HEALTHY', version: '0.7.1', startMs: 12, retries: 0, lastError: null, fallback: null, tone: 'ok', actions: ['check', 'retry', 'reset-fallback'] },
      { id: 'mega:dock', state: 'DEGRADED', version: null, startMs: 40, retries: 2, lastError: 'the dock did not paint', fallback: 'simple-wallpaper', tone: 'warn', actions: ['check', 'retry', 'reset-fallback'] }
    ],
    plugins: [
      { id: 'dsh-wallpaper-engine', state: 'installed', installed: true, expected: 'v0.7.1', installedVersion: '0.7.1', channel: 'harness-profile', channelVerified: true, tested: true, tone: 'ok', actions: ['disable', 'repair'] }
    ],
    degraded: 1,
    failed: 0,
    failing: 0,
    ...overrides
  }
}

const BRIDGE = { available: true, host: '127.0.0.1', port: 51000, schema: 1 }
const plugin = { id: 'dsh-plugin-mega-core', version: '0.1.0' }

test('the view model asks governance for exactly the actions the bridge accepts', async () => {
  const { MEGA_ACTIONS } = await loadView()
  /**
   * Two lists, one closed set — and they are now one list.
   *
   * The plugin used to carry its own `MEGA_ACTIONS`, and the view offered service actions the bridge had
   * never heard of (`diagnostics`, `restart-plugin`, `manual-restart`, `reset-budget`): four buttons that
   * could only ever print a refusal. The vocabulary lives in `app/core/contracts/service-actions.cjs` now,
   * and this asserts the view's module recovery set is exactly the contract's non-balance half — so a new
   * action cannot be drawn without the bridge accepting it.
   */
  const { PRODUCT_ACTIONS, MODULE_ACTIONS, ACCEPTED_ACTIONS } = require('../../app/core/contracts/service-actions.cjs')
  const recovery = PRODUCT_ACTIONS.filter((action) => action.id !== 'refresh-balance').map((action) => action.id)
  assert.deepEqual([...MEGA_ACTIONS], [...recovery, ...MODULE_ACTIONS])
  for (const action of MEGA_ACTIONS) {
    assert.ok(ACCEPTED_ACTIONS.includes(action), `the bridge does not accept ${action}`)
    assert.ok(BRIDGE_ACTIONS.includes(action), `the bridge does not accept ${action}`)
  }
})

test('a degraded layer is degraded everywhere: status, hover, lines and fields agree', async () => {
  const { buildMegaView } = await loadView()
  const view = buildMegaView({ plugin, bridge: BRIDGE, governance: snapshot(), now: () => '2026-09-15T00:00:00.000Z' })

  assert.equal(view.available, true)
  assert.equal(view.at, '2026-09-15T00:00:00.000Z')
  assert.deepEqual(view.status, { tone: 'warn', label: 'Degraded', attention: 1, active: 2, total: 3, pending: 0, failing: 0 })
  // §4.2's hover, in the plan's order: who, how it is, how much is running, who is waiting.
  assert.deepEqual(view.hover, ['DS-Hns', 'Degraded', '2 of 3 plugin(s) active', '0 pending'])
  // Faults first, with the reason attached — a bare "degraded" would send the user to the logs for it.
  assert.deepEqual(view.lines[0], { tone: 'warn', text: '⚠ mega:dock degraded — the dock did not paint' })
  assert.ok(view.lines.some((entry) => entry.tone === 'ok' && /1 of 1 bundled plugin\(s\) installed/.test(entry.text)), JSON.stringify(view.lines))

  // §4.4's eleven fields, by id, so a later phase cannot quietly drop one.
  assert.deepEqual(view.fields.map((entry) => entry.id), [
    'health', 'dependencies', 'version', 'capabilities', 'retries', 'fallback', 'lastError', 'pending', 'recovery', 'compatibility', 'pin'
  ])
  const byId = Object.fromEntries(view.fields.map((entry) => [entry.id, entry]))
  assert.equal(byId.health.value, '1/2 module(s) healthy · 1/1 plugin(s) installed')
  assert.equal(byId.health.tone, 'warn')
  assert.equal(byId.retries.value, '2 across 1 module(s)')
  assert.equal(byId.retries.tone, 'warn')
  assert.equal(byId.fallback.value, 'mega:dock → simple-wallpaper')
  assert.equal(byId.lastError.value, 'mega:dock: the dock did not paint')
  assert.equal(byId.lastError.tone, 'warn')
  assert.equal(byId.pending.value, '0')
  assert.equal(byId.compatibility.value, 'compatible')
  assert.equal(byId.compatibility.tone, 'ok')
  assert.equal(byId.pin.value, 'dsh-wallpaper-engine @ v0.7.1')
  // The offered actions are the closed set's order, not the order the modules happened to list them in.
  assert.equal(byId.recovery.value, 'check, retry, reset-fallback')
  assert.match(byId.dependencies.value, /dsh-wallpaper-engine: installed @0\.7\.1 \(harness-profile · verified · tested\)/)
  assert.match(byId.version.value, /dsh-plugin-mega-core 0\.1\.0/)
  assert.match(byId.capabilities.value, /6 action\(s\): check, retry, reset-fallback, repair, disable, enable/)
})

test('nothing wrong is reported as fine, and only as fine', async () => {
  const { buildMegaView } = await loadView()
  const clean = snapshot({
    modules: [{ id: 'mega:dock', state: 'HEALTHY', retries: 0, lastError: null, fallback: null, tone: 'ok', actions: ['check', 'retry', 'reset-fallback'] }],
    degraded: 0
  })
  const view = buildMegaView({ plugin, bridge: BRIDGE, governance: clean })
  assert.equal(view.status.tone, 'ok')
  assert.equal(view.status.label, 'Healthy')
  assert.equal(view.status.attention, 0)
  assert.equal(view.lines.every((entry) => entry.tone === 'ok'), true, JSON.stringify(view.lines))
  assert.deepEqual(view.actions, ['check'], 'a healthy system still offers its cheapest health re-read')
  assert.equal(view.fields.find((entry) => entry.id === 'lastError').tone, 'ok')
})

test('a failed module outranks a degraded one, and pending human work reaches the badge', async () => {
  const { buildMegaView } = await loadView()
  const failed = buildMegaView({ plugin, bridge: BRIDGE, governance: snapshot({ failed: 1 }) })
  assert.equal(failed.status.tone, 'bad')
  assert.equal(failed.status.label, 'Failed')
  assert.equal(failed.status.attention, 2, 'the degraded module and the failed one both want attention')
  assert.equal(failed.fields.find((entry) => entry.id === 'compatibility').tone, 'ok')

  // §7's Human Gate is a later phase, so the count arrives as a top-level key when it exists and as zero
  // before that — zero being true, because with no gate nothing can be waiting.
  const pending = buildMegaView({ plugin, bridge: BRIDGE, governance: snapshot({ pending: 3 }) })
  assert.equal(pending.status.pending, 3)
  assert.equal(pending.status.attention, 4)
  assert.equal(pending.fields.find((entry) => entry.id === 'pending').tone, 'warn')
  assert.ok(pending.lines.some((entry) => /⏸ 3 task\(s\) waiting for human/.test(entry.text)), JSON.stringify(pending.lines))
})

test('DS-Hns not running is its own status, with the reason, and never an empty "healthy"', async () => {
  const { buildMegaView } = await loadView()
  const view = buildMegaView({
    plugin,
    bridge: { available: false, reason: 'DS-Hns is not running (no governance bridge file)' },
    governance: null
  })
  assert.equal(view.available, false)
  assert.equal(view.status.tone, 'unknown')
  assert.equal(view.status.label, 'Unavailable')
  assert.equal(view.status.active, 0)
  assert.match(view.reason, /not running/)
  assert.equal(view.lines[0].tone, 'warn')
  assert.match(view.lines[0].text, /no governance bridge file/)
  // The page still knows what it is and where the channel would be — that is the point of not bailing out.
  const byId = Object.fromEntries(view.fields.map((entry) => [entry.id, entry]))
  assert.match(byId.version.value, /dsh-plugin-mega-core 0\.1\.0/)
  assert.match(byId.bridge.value, /not running/)
  assert.deepEqual(view.actions, [], 'nothing is offered when nothing can be reached')
})

test('the dashboard carries the live numbers, and the governance fields are still all there', async () => {
  const { buildMegaView, COUNTDOWN_ROW } = await loadView()
  const governance = { ...snapshot(), dashboard: dashboardSnapshot().dashboard }
  const view = buildMegaView({ plugin, bridge: BRIDGE, governance, now: () => '2026-09-15T05:45:00.000Z' })

  // §4.4 did not move: the eleven fields are the same eleven, in the same order, with the same values.
  assert.deepEqual(view.fields.map((entry) => entry.id), [
    'health', 'dependencies', 'version', 'capabilities', 'retries', 'fallback', 'lastError', 'pending', 'recovery', 'compatibility', 'pin'
  ])
  assert.equal(view.fields.find((entry) => entry.id === 'health').value, '1/2 module(s) healthy · 1/1 plugin(s) installed')

  const rows = (group) => Object.fromEntries(group.rows.map((entry) => [entry.id, entry]))
  const price = view.dashboard.lines.find((entry) => entry.id === 'price')
  const balance = view.dashboard.lines.find((entry) => entry.id === 'balance')
  const execution = Object.fromEntries(view.dashboard.execution.map((entry) => [entry.id, entry]))
  const parallelism = Object.fromEntries(view.dashboard.parallelism.map((entry) => [entry.id, entry]))

  // The price window and its own schedule, out of the price list the scheduler bills against.
  assert.equal(rows(price)['price:window'].value, 'PEAK')
  assert.equal(rows(price)['price:window'].tone, 'warn')
  assert.equal(rows(price)['price:windows'].value, '09:00-12:00, 14:00-18:00 · Asia/Shanghai')
  assert.equal(rows(price)['price:source'].value, 'official · 2026-09-07')
  // The next change is printed as a clock time in the schedule's own **billing** zone (Asia/Shanghai): 06:00Z
  // is 14:00 there, and the price page the user compares against says 14:00. Printing it in UTC — or in
  // whatever zone this machine happens to be in — would name an hour that matches nothing.
  assert.equal(rows(price)['price:next-change'].value, '14:00 → 谷价 Off-peak')
  // The countdown: fifteen minutes from the snapshot, fifteen minutes from `now`, and nothing stale about it.
  assert.equal(rows(price)[COUNTDOWN_ROW].value, '15m 0s')
  assert.equal(rows(price)[COUNTDOWN_ROW].tone, 'ok')

  // The account, as the balance service describes it — never a fabricated zero for an account never read.
  assert.equal(rows(balance)['balance:total'].value, '¥ 12.50')
  assert.equal(rows(balance)['balance:topped-up'].value, '¥ 10.00')
  assert.equal(rows(balance)['balance:granted'].value, '¥ 2.50')
  assert.equal(rows(balance)['balance:state'].value, '正常 · ok')
  assert.equal(rows(balance)['balance:state'].tone, 'ok')

  // The queue, from the scheduler's own counts, and the parallelism it computed from the machine.
  assert.equal(execution['execution:running'].value, '2')
  assert.equal(execution['execution:running'].tone, 'busy')
  assert.equal(execution['execution:queued'].value, '3')
  assert.equal(execution['execution:total'].value, '6')
  assert.equal(parallelism['parallelism:current'].value, '4')
  assert.equal(parallelism['parallelism:hardware-cap'].value, '6')
  assert.equal(parallelism['parallelism:cpu'].value, '32%')
  assert.equal(parallelism['parallelism:free-ram'].value, '12.3 GB')
})

test('the countdown is re-derived from the instant, not read from the snapshot seconds', async () => {
  const { buildMegaView, COUNTDOWN_ROW } = await loadView()
  const governance = { ...snapshot(), dashboard: dashboardSnapshot().dashboard }
  const at = (iso) => buildMegaView({ plugin, bridge: BRIDGE, governance, now: () => iso })
  const countdown = (view) => view.dashboard.lines.find((entry) => entry.id === 'price').rows.find((entry) => entry.id === COUNTDOWN_ROW).value

  assert.equal(countdown(at('2026-09-15T05:45:00.000Z')), '15m 0s')
  // Three minutes later the same snapshot counts down three minutes less: a stored `secondsLeft` would have
  // been frozen at 15m, which is the whole reason the snapshot carries the instant instead.
  assert.equal(countdown(at('2026-09-15T05:48:00.000Z')), '12m 0s')
  assert.equal(countdown(at('2026-09-15T05:59:30.000Z')), '30s')
  // Past the change there is nothing left to wait for, and `0s` is the honest answer rather than a negative one.
  assert.equal(countdown(at('2026-09-15T06:10:00.000Z')), '0s')
})

test('a dashboard with no source says why, instead of drawing a queue of zero', async () => {
  const { buildMegaView } = await loadView()
  const withBlock = buildMegaView({ plugin, bridge: BRIDGE, governance: { ...snapshot(), dashboard: dashboardSnapshot().dashboard } })
  assert.equal(withBlock.dashboard.ok, true)
  assert.equal(withBlock.dashboard.reason, null)

  // A snapshot that answered without a dashboard block: governance is readable, the live numbers are not.
  const withoutBlock = buildMegaView({ plugin, bridge: BRIDGE, governance: snapshot() })
  assert.equal(withoutBlock.dashboard.ok, false)
  assert.match(withoutBlock.dashboard.reason, /did not publish a dashboard block/)
  assert.deepEqual(withoutBlock.dashboard.execution, [], 'an absent block is not a queue of zero')

  // And DS-Hns not answering at all: the fields still say what this plugin is, and the dashboard says why.
  const unreachable = buildMegaView({ plugin, bridge: { available: false, reason: 'DS-Hns is not running' }, governance: null })
  assert.equal(unreachable.dashboard.ok, false)
  assert.deepEqual(unreachable.dashboard.lines, [], 'nothing is claimed about a surface that did not answer')
  assert.match(unreachable.dashboard.reason, /dashboard block/)
})

test('the shipped files say what the view model assumes', () => {
  const view = read('app/plugins/mega-core/lib/view.js')
  const host = read('app/plugins/mega-core/lib/index.js')
  const control = read('app/extensions/mega/control-center.cjs')
  const extension = read('app/extensions/mega/index.cjs')
  // The pending key is read, never required: §7's gate is what will publish it.
  assert.match(view, /export const PENDING_KEY = 'pending'/)
  assert.match(view, /governance\[PENDING_KEY\]/)
  // The host composes the view (one place decides the tones), and the client renders it.
  assert.match(host, /import \{ buildMegaView \} from '\.\/view\.js'/)
  assert.match(host, /path: `\$\{BASE\}\/view`/)
  assert.match(read('app/plugins/mega-core/package.json'), /"lib\/view\.js"/)
  /**
   * The two halves agree on the countdown row **by string**, so both ends are asserted here: the id the view
   * looks for is the id the Control Center publishes, with the instant the view subtracts against. A rename on
   * one side would otherwise be a countdown that silently stops counting.
   */
  assert.match(view, /export const COUNTDOWN_ROW = 'price:until-off-peak'/)
  assert.match(control, /id: 'price:until-off-peak',\s*\n?\s*nextChangeIso/)
  // The dashboard is assembled from the Control Center's sources, not from a second reading of them.
  assert.match(control, /dashboard\.fields = \[/)
  assert.match(control, /row\('电费时段', 'Price window'/)
  assert.match(control, /id: 'execution:queued'/)
  // The two sources that never used to reach it — the account and the price list the cost is billed against.
  assert.match(extension, /balance: \(\(\) => \{[\s\S]{0,600}?balanceService\.describeCached\(\)/)
  assert.match(extension, /pricing: \(\(\) => \{[\s\S]{0,400}scheduler\.pricing\?\.getSchedule/)
  // The dashboard's own action list is carried through, id and all: the refresh button is the snapshot's, so a
  // surface cannot offer a read the Control Center withheld.
  assert.match(view, /actions: source && Array\.isArray\(source\.actions\)/)
  assert.match(control, /dashboard\.actions = balanceState === 'ok'/)
  assert.match(control, /id: 'refresh-balance'/)
  // The client half names the same id when it posts the action, and spells the countdown row the same way.
  const client = read('app/plugins/mega-core/lib/client.js')
  assert.match(client, /const COUNTDOWN_ROW = 'price:until-off-peak'/)
  assert.match(client, /onDashboardAction\(action\.id\)/)
  assert.match(client, /async function actDashboard\(action\)/)
})
