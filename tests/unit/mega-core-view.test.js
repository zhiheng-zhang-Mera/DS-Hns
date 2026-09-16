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
 */

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(ROOT, 'app', 'plugins', 'mega-core')
const read = (relative) => require('node:fs').readFileSync(path.join(ROOT, relative), 'utf8')

async function loadView() {
  return import(pathToFileURL(path.join(PLUGIN, 'lib', 'view.js')).href)
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
  // Two lists, one closed set: if the bridge gains or loses an action and the plugin does not follow, this is
  // the test that says so — rather than a button in the official UI that silently does nothing.
  assert.deepEqual([...MEGA_ACTIONS], [...BRIDGE_ACTIONS])
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

test('the shipped files say what the view model assumes', () => {
  const view = read('app/plugins/mega-core/lib/view.js')
  const host = read('app/plugins/mega-core/lib/index.js')
  // The pending key is read, never required: §7's gate is what will publish it.
  assert.match(view, /export const PENDING_KEY = 'pending'/)
  assert.match(view, /governance\[PENDING_KEY\]/)
  // The host composes the view (one place decides the tones), and the client renders it.
  assert.match(host, /import \{ buildMegaView \} from '\.\/view\.js'/)
  assert.match(host, /path: `\$\{BASE\}\/view`/)
  assert.match(read('app/plugins/mega-core/package.json'), /"lib\/view\.js"/)
})
