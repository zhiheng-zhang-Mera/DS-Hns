'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createGovernanceBridge } = require('../../app/core/governance-bridge.cjs')

/**
 * The Mega Core Plugin's host half (`updateplan/pluginize.md` Phase 1).
 *
 * The plugin package is the thing that makes Mega appear inside the official UI, and the host half is the only
 * part of it that can be verified without a browser: it must mount its routes on the Harness' web server, mirror
 * DS-Hns' governance bridge faithfully — including "unavailable" — and unwind everything when it is unloaded.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(ROOT, 'app', 'plugins', 'mega-core')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** The host half is ESM, so it is imported by URL like the Cordis loader would. */
async function loadHost() {
  return import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
}

/** A stub web server that records registrations and can call them, like the Harness' own service. */
function stubWebServer() {
  const routes = new Map()
  const disposed = []
  return {
    routes,
    disposed,
    register({ kind, path: routePath, handler }) {
      routes.set(routePath, { kind, handler })
      return () => {
        disposed.push(routePath)
        routes.delete(routePath)
      }
    }
  }
}

/** A request/response pair with just what the handlers use. */
function fakeExchange({ method = 'GET', body = null } = {}) {
  const request = {
    method,
    _handlers: new Map(),
    on(event, handler) {
      this._handlers.set(event, handler)
      return this
    },
    _send(payload) {
      // A string body is already JSON (that is what a request carries); an object is serialised like `fetch` does.
      const text = payload === null || payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
      this._handlers.get('data')?.(Buffer.from(text))
      this._handlers.get('end')?.()
    },
    destroy() {}
  }
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text }
  }
  if (body !== null) setImmediate(() => request._send(body))
  return { request, response }
}

test('the package declares the bundle patch, the client half and the web platform', () => {
  const pkg = JSON.parse(read('app/plugins/mega-core/package.json'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime'])
  assert.equal(pkg.dsh.client.immediately, true)
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.type, 'module')
  // The patch inserts one host row and never overrides a shipped one (a patch replaces a row's whole config).
  const patch = read('app/plugins/mega-core/cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /- id: mega-core/)
  assert.match(patch, /name: 'dsh-plugin-mega-core'/)
  assert.equal(/- remove:|replace:/.test(patch), false, 'the patch must be additive only')
})

test('the host half mounts its six routes and unwinds them on unload', async () => {
  const host = await loadHost()
  const server = stubWebServer()
  const dispose = host.apply({ webServer: server })
  // No `/orb`: the only ball is the system one (`app/extensions/mega/system-orb.cjs`), which keeps its own
  // position in its own file. A route here for a surface that no longer exists would be a surface to keep in
  // step for nothing. `/timing` and `/task` are the scheduled-task pair (pluginize Phase 2).
  assert.deepEqual([...server.routes.keys()].sort(), ['/mega-core/action', '/mega-core/governance', '/mega-core/health', '/mega-core/task', '/mega-core/timing', '/mega-core/view'])
  for (const route of server.routes.values()) assert.equal(route.kind, 'exact')
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(server.routes.size, 0, 'the routes outlived the plugin')
  assert.deepEqual(server.disposed.sort(), ['/mega-core/action', '/mega-core/governance', '/mega-core/health', '/mega-core/task', '/mega-core/timing', '/mega-core/view'])
  // `inject` is what makes the loader wait for the web server, so it must be declared.
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(host.name, 'dsh-plugin-mega-core')
})

test('the host half mirrors DS-Hns\' governance bridge, token and all', async () => {
  const host = await loadHost()
  // The bridge writes `<stateDir>/governance-bridge.json`, and the plugin looks for
  // `<DSH_HOME>/state/governance-bridge.json` — the same relationship the product has with `data/` and
  // `data/state/`.
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-'))
  const stateDir = path.join(dshHome, 'state')
  const bridge = createGovernanceBridge({
    stateDir,
    // The snapshot shape DS-Hns actually answers with (`controlCenter()`), plus the two extra reports the
    // Control Center itself carries, so the view is composed from the real thing rather than from a stub.
    snapshot: () => ({
      modules: [{ id: 'mega-dock', state: 'HEALTHY', version: '0.1.0', startMs: 5, retries: 0, lastError: null, fallback: null, tone: 'ok', actions: ['check', 'retry', 'reset-fallback'] }],
      plugins: [{ id: 'dsh-wallpaper-engine', state: 'installed', expected: 'v0.7.1', installedVersion: '0.7.1', channel: 'harness-profile', channelVerified: true, tested: true, tone: 'ok', actions: ['disable', 'repair'] }],
      degraded: 0,
      failed: 0,
      failing: 0,
      protection: { modules: [{ id: 'mega-dock', state: 'HEALTHY' }], degraded: [], failed: [] },
      boot: { state: 'ENHANCED' }
    }),
    act: async ({ action, id }) => ({ ok: action === 'retry', action, id, reason: action === 'retry' ? null : 'refused by the layer' }),
    log: () => {}
  })
  await bridge.start()
  try {
    const env = { DSH_HOME: dshHome }
    const server = stubWebServer()
    host.apply({ webServer: server }, { env })

    const health = fakeExchange()
    await server.routes.get('/mega-core/health').handler(health.request, health.response)
    const healthBody = JSON.parse(health.response.body)
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.governance.available, true)
    assert.equal(healthBody.governance.port, bridge.describe().port)
    // §4.4 asks the page to report a version; it is read from the package manifest, never typed twice.
    assert.equal(healthBody.plugin.id, 'dsh-plugin-mega-core')
    assert.match(healthBody.plugin.version, /^\d+\.\d+\.\d+$/)
    // The discovery file's own schema: 2 carries the two opt-in timing halves (/timing, /task).
    assert.equal(healthBody.governance.schema, 2)

    // The composed view: the same snapshot, in the shape the orb and the page draw. One route rather than
    // two fetches composed in the browser, because the tones and the field names are rules worth testing.
    const view = fakeExchange()
    await server.routes.get('/mega-core/view').handler(view.request, view.response)
    assert.equal(view.response.statusCode, 200)
    const viewBody = JSON.parse(view.response.body)
    assert.equal(viewBody.ok, true)
    assert.equal(viewBody.available, true)
    assert.equal(viewBody.status.tone, 'ok', 'a healthy bridge file and a healthy module is not a fault')
    assert.deepEqual(viewBody.status, { tone: 'ok', label: 'Healthy', attention: 0, active: 2, total: 2, pending: 0, failing: 0 })
    assert.equal(viewBody.version.plugin, healthBody.plugin.version)
    assert.equal(viewBody.version.schema, 2)
    assert.deepEqual(viewBody.hover, ['DS-Hns', 'Healthy', '2 of 2 plugin(s) active', '0 pending'])
    assert.equal(viewBody.fields.length, 11, '§4.4 names eleven fields')

    const governance = fakeExchange()
    await server.routes.get('/mega-core/governance').handler(governance.request, governance.response)
    assert.equal(governance.response.statusCode, 200)
    assert.equal(JSON.parse(governance.response.body).protection.modules[0].id, 'mega-dock')

    const retry = fakeExchange({ method: 'POST', body: JSON.stringify({ action: 'retry', id: 'mega-dock' }) })
    await server.routes.get('/mega-core/action').handler(retry.request, retry.response)
    assert.equal(retry.response.statusCode, 200)
    assert.equal(JSON.parse(retry.response.body).ok, true)

    // A refused action keeps the bridge's own status: the plugin does not turn a refusal into a success.
    const refused = fakeExchange({ method: 'POST', body: JSON.stringify({ action: 'repair', id: 'mega-dock' }) })
    await server.routes.get('/mega-core/action').handler(refused.request, refused.response)
    assert.equal(refused.response.statusCode, 409)
    assert.match(JSON.parse(refused.response.body).result.reason, /refused by the layer/)

    // A GET on the action route is refused by method, not silently treated as a read.
    const wrongMethod = fakeExchange({ method: 'GET' })
    await server.routes.get('/mega-core/action').handler(wrongMethod.request, wrongMethod.response)
    assert.equal(wrongMethod.response.statusCode, 405)

    /**
     * The timing surface: what the new-task dialog is allowed to offer, answered by DS-Hns rather than guessed by
     * the dialog. A host that predates it answers 404 with its own sentence, which the dialog shows.
     */
    const timing = fakeExchange()
    await server.routes.get('/mega-core/timing').handler(timing.request, timing.response)
    assert.equal(timing.response.statusCode, 404)
    assert.match(JSON.parse(timing.response.body).reason, /does not answer timing questions/)

    // And scheduling: the plugin passes the body through and keeps DS-Hns' own status and words, so a refusal the
    // scheduler made is a refusal the user reads.
    const noPrompt = fakeExchange({ method: 'POST', body: JSON.stringify({ prompt: '' }) })
    await server.routes.get('/mega-core/task').handler(noPrompt.request, noPrompt.response)
    assert.equal(noPrompt.response.statusCode, 404)
    assert.match(JSON.parse(noPrompt.response.body).reason, /cannot schedule tasks/)

    const wrongTaskMethod = fakeExchange({ method: 'GET' })
    await server.routes.get('/mega-core/task').handler(wrongTaskMethod.request, wrongTaskMethod.response)
    assert.equal(wrongTaskMethod.response.statusCode, 405)
  } finally {
    await bridge.stop()
    fs.rmSync(dshHome, { recursive: true, force: true })
  }
})

test('the host half schedules through the bridge and keeps DS-Hns\' own answer', async () => {
  const host = await loadHost()
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-task-'))
  const stateDir = path.join(dshHome, 'state')
  /** What the product's own bridge would hold: the two halves the extension passes in. */
  const scheduled = []
  const bridge = createGovernanceBridge({
    stateDir,
    snapshot: () => ({ modules: [], plugins: [], degraded: 0, failed: 0, failing: 0 }),
    act: async () => ({ ok: true }),
    timing: () => ({
      ok: true,
      kind: 'scheduled-task',
      defaults: { startAt: '2026-09-15T09:00:00.000Z', allowPeak: false, deliveryMode: 'official-session' },
      schedule: { timeZone: 'Asia/Shanghai', weekdayPeak: true, peakPeriods: [{ start: '09:00', end: '12:00' }] },
      peak: { peak: true, nextChange: { iso: '2026-09-15T04:00:00.000Z', statusAfter: 'OFF-PEAK', secondsLeft: 600 } },
      interruptRunningAtPeak: false,
      limits: { minStartOffsetSeconds: 0, maxStartAheadDays: 365 },
      deliveryModes: [{ id: 'official-session', cn: '官方对话', en: 'Official conversation', default: true }]
    }),
    createTask: async (input) => {
      scheduled.push(input)
      if (!String(input.prompt || '').trim()) return { ok: false, reason: 'a task needs a prompt', field: 'prompt' }
      if (input.startAt && Number.isNaN(Date.parse(input.startAt))) return { ok: false, reason: `"${input.startAt}" is not a time this scheduler can read`, field: 'startAt' }
      return { ok: true, task: { id: 'task-1', prompt: input.prompt, status: 'PENDING', startAtMs: Date.parse(input.startAt), deliveryMode: 'official-session' } }
    },
    log: () => {}
  })
  await bridge.start()
  try {
    const server = stubWebServer()
    host.apply({ webServer: server }, { env: { DSH_HOME: dshHome } })

    const timing = fakeExchange()
    await server.routes.get('/mega-core/timing').handler(timing.request, timing.response)
    assert.equal(timing.response.statusCode, 200)
    const surface = JSON.parse(timing.response.body)
    assert.equal(surface.ok, true)
    assert.equal(surface.defaults.deliveryMode, 'official-session')
    assert.equal(surface.schedule.timeZone, 'Asia/Shanghai')
    assert.equal(surface.peak.peak, true, 'the dialog needs to know a peak window is on to explain a suspension')

    const made = fakeExchange({ method: 'POST', body: JSON.stringify({ prompt: '总结今天的构建日志', startAt: '2026-09-15T09:30:00.000Z', allowPeak: false, deliveryMode: 'official-session' }) })
    await server.routes.get('/mega-core/task').handler(made.request, made.response)
    assert.equal(made.response.statusCode, 200)
    const task = JSON.parse(made.response.body)
    assert.equal(task.ok, true)
    assert.equal(task.task.id, 'task-1')
    // The request reached DS-Hns exactly as the dialog wrote it: the plugin has no opinion about a task.
    assert.deepEqual(scheduled, [{ prompt: '总结今天的构建日志', startAt: '2026-09-15T09:30:00.000Z', allowPeak: false, deliveryMode: 'official-session' }])

    // A refusal keeps DS-Hns' status and sentence — a dialog that cannot say why is a dialog that makes the user
    // guess.
    const refused = fakeExchange({ method: 'POST', body: JSON.stringify({ prompt: '   ' }) })
    await server.routes.get('/mega-core/task').handler(refused.request, refused.response)
    assert.equal(refused.response.statusCode, 400)
    const refusal = JSON.parse(refused.response.body)
    assert.equal(refusal.ok, false)
    assert.match(refusal.reason, /a task needs a prompt/)
    assert.equal(refusal.field, 'prompt')
  } finally {
    await bridge.stop()
    fs.rmSync(dshHome, { recursive: true, force: true })
  }
})

test('when DS-Hns is not running the plugin says so instead of inventing an answer', async () => {
  const host = await loadHost()
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-empty-'))
  try {
    const server = stubWebServer()
    host.apply({ webServer: server }, { env: { DSH_HOME: stateDir } })
    const health = fakeExchange()
    await server.routes.get('/mega-core/health').handler(health.request, health.response)
    const healthBody = JSON.parse(health.response.body)
    assert.equal(healthBody.ok, true, 'the plugin itself is up')
    assert.equal(healthBody.governance.available, false)
    assert.match(healthBody.governance.reason, /not running|no governance bridge file/)

    const governance = fakeExchange()
    await server.routes.get('/mega-core/governance').handler(governance.request, governance.response)
    assert.equal(governance.response.statusCode, 503)
    const body = JSON.parse(governance.response.body)
    assert.equal(body.ok, false)
    assert.equal(body.available, false)

    /**
     * The composed view is different on purpose: `200`, with `available: false` and the reason inside.
     *
     * The client is asking "what should I draw", and "a grey orb that says DS-Hns is not running" is a
     * complete answer — one that has to survive the trip to the browser to be drawable at all. Only the
     * *governance* route answers 503, because a caller that asked for the snapshot itself must see that it
     * did not get one.
     */
    const view = fakeExchange()
    await server.routes.get('/mega-core/view').handler(view.request, view.response)
    assert.equal(view.response.statusCode, 200)
    const viewBody = JSON.parse(view.response.body)
    assert.equal(viewBody.ok, true)
    assert.equal(viewBody.available, false)
    assert.equal(viewBody.status.tone, 'unknown')
    assert.equal(viewBody.status.label, 'Unavailable')
    assert.match(viewBody.reason, /not running|no governance bridge file/)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a bridge file that claims a non-loopback host is refused', async () => {
  const host = await loadHost()
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-far-'))
  try {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state', 'governance-bridge.json'), JSON.stringify({ host: '10.0.0.5', port: 1, token: 'x' }), 'utf8')
    const discovery = host.readDiscovery({ DSH_HOME: stateDir })
    assert.equal(discovery.available, false)
    assert.match(discovery.reason, /not loopback/)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
