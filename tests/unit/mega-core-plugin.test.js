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

/** Every `/mega-core/...` URL the browser half calls, read out of its own source. */
function clientRouteUrls() {
  const source = read('app/plugins/mega-core/lib/client.js')
  const urls = new Set()
  for (const match of source.matchAll(/['"](\/mega-core\/[a-z-]+)['"]/g)) urls.add(match[1])
  return [...urls].sort()
}

test('the host half mounts every route the browser half calls, and unwinds them on unload', async () => {
  const host = await loadHost()
  const server = stubWebServer()
  const dispose = host.apply({ webServer: server })
  const routes = [...server.routes.keys()].sort()
  assert.deepEqual(routes, [
    '/mega-core/action',
    '/mega-core/governance',
    '/mega-core/health',
    '/mega-core/orb',
    '/mega-core/task',
    '/mega-core/task-edit',
    '/mega-core/task-move',
    '/mega-core/timing',
    '/mega-core/view'
  ])
  for (const route of server.routes.values()) assert.equal(route.kind, 'exact')

  /**
   * The contract, asserted **between the two halves** rather than as a list of names on this side.
   *
   * The list above is a snapshot; this is the rule. Twice now a route was deleted here on the theory that its
   * caller had moved — `/orb` when the in-UI ball was removed, then `/timing` + `/task` when the new-task form was
   * thought to live only in the system ball's window — and both times the caller came back first and the route did
   * not. The failure was silent by construction: a 404 with an empty body, and the client's own `response.json()`
   * throwing `SyntaxError: Unexpected end of JSON input` where a sentence about the problem belonged. A test that
   * reads the URLs out of the client half cannot be fooled by that reasoning again.
   */
  const called = clientRouteUrls()
  assert.ok(called.length >= 5, `no route constants found in the browser half: ${called.join(', ')}`)
  assert.deepEqual(called.filter((url) => !routes.includes(url)), [], `the browser half calls a route this half does not serve: ${called.join(', ')}`)

  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(server.routes.size, 0, 'the routes outlived the plugin')
  assert.deepEqual(server.disposed.sort(), routes)
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
  } finally {
    await bridge.stop()
    fs.rmSync(dshHome, { recursive: true, force: true })
  }
})

test('the new-task pair proxies DS-Hns, its refusals included, and the ball position is a file', async () => {
  /**
   * The two routes the task form calls, plus the two the ball's position uses — driven end to end through a real
   * governance bridge, because "the plugin mirrors DS-Hns" is a claim about the pair, not about either half.
   *
   * Both were deleted once and both are back (see the host half's own note): what a caller does is not evidence
   * about a route's life, and this is where that lesson is a test rather than a paragraph.
   */
  const host = await loadHost()
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-task-'))
  const created = []
  const moved = []
  const startAt = new Date(Date.now() + 3 * 60_000).toISOString()
  const bridge = createGovernanceBridge({
    stateDir: path.join(dshHome, 'state'),
    snapshot: () => ({ modules: [], plugins: [], degraded: 0, failed: 0, failing: 0 }),
    act: async () => ({ ok: true }),
    timing: () => ({
      ok: true,
      kind: 'scheduled-task',
      defaults: { startAt, allowPeak: false, deliveryMode: 'official-session' },
      schedule: { timeZone: 'Asia/Shanghai', peakPeriods: [] },
      // The surface says what the scheduler will accept, and the scheduler refuses a past instant (`addTask`).
      limits: { minStartOffsetSeconds: 1, maxStartAheadDays: 365 }
    }),
    createTask: async (input) => {
      created.push(input)
      if (!String(input.prompt || '').trim()) return { ok: false, reason: 'a task needs a prompt', field: 'prompt' }
      return { ok: true, task: { id: 'task-1', status: 'SUSPENDED', reason: 'waiting-schedule', startAtMs: Date.parse(input.startAt) } }
    },
    /** The queue's two operations, as the extension wires them (`editScheduledTask` / `moveScheduledTask`). */
    editTask: async (input) => {
      if (!input.taskId) return { ok: false, reason: 'editing a task needs its id', field: 'taskId' }
      if (!String(input.prompt || '').trim()) return { ok: false, reason: 'a task needs a prompt', field: 'prompt' }
      return { ok: true, task: { id: input.taskId, status: 'SUSPENDED', reason: 'waiting-schedule' } }
    },
    moveTask: async (input) => {
      moved.push(input)
      if (!['top', 'up', 'down', 'bottom'].includes(String(input.move || ''))) {
        return { ok: false, reason: `"${input.move}" is not a queue move; expected top, up, down or bottom`, field: 'move' }
      }
      return { ok: true, task: { id: input.taskId, queueRank: 1 } }
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
    assert.equal(surface.kind, 'scheduled-task')
    assert.equal(surface.defaults.startAt, startAt)
    assert.equal(surface.limits.minStartOffsetSeconds, 1, 'the form must not offer a time the scheduler refuses')

    const made = fakeExchange({ method: 'POST', body: JSON.stringify({ prompt: '总结今天的构建日志', startAt, allowPeak: false, deliveryMode: 'official-session' }) })
    await server.routes.get('/mega-core/task').handler(made.request, made.response)
    assert.equal(made.response.statusCode, 200)
    const task = JSON.parse(made.response.body).task
    assert.equal(task.id, 'task-1')
    // A task that is waiting for its instant is what the form reports back to the user, reason and all.
    assert.equal(task.status, 'SUSPENDED')
    assert.equal(task.reason, 'waiting-schedule')
    assert.equal(created[0].prompt, '总结今天的构建日志')

    // A refusal keeps the bridge's own status (400) and its own words: the plugin does not turn one into a success.
    const refused = fakeExchange({ method: 'POST', body: JSON.stringify({ prompt: '   ' }) })
    await server.routes.get('/mega-core/task').handler(refused.request, refused.response)
    assert.equal(refused.response.statusCode, 400)
    assert.match(JSON.parse(refused.response.body).reason, /a task needs a prompt/)

    const wrongMethod = fakeExchange({ method: 'GET' })
    await server.routes.get('/mega-core/task').handler(wrongMethod.request, wrongMethod.response)
    assert.equal(wrongMethod.response.statusCode, 405)

    /**
     * The queue's two operations — what "不能编辑，也不能调顺序" needed and did not have.
     *
     * /view carries the queue itself (`dashboard.queue`), so these are the *actions*: each is proxied to the
     * scheduler's own method, each keeps the bridge's status and words on a refusal, and each is refused by method
     * rather than treated as a read.
     */
    const edited = fakeExchange({ method: 'POST', body: JSON.stringify({ taskId: 'task-1', prompt: '改过的内容', allowPeak: true }) })
    await server.routes.get('/mega-core/task-edit').handler(edited.request, edited.response)
    assert.equal(edited.response.statusCode, 200)
    assert.equal(JSON.parse(edited.response.body).task.id, 'task-1')

    const refusedEdit = fakeExchange({ method: 'POST', body: JSON.stringify({ taskId: 'task-1', prompt: '   ' }) })
    await server.routes.get('/mega-core/task-edit').handler(refusedEdit.request, refusedEdit.response)
    assert.equal(refusedEdit.response.statusCode, 400)
    assert.equal(JSON.parse(refusedEdit.response.body).field, 'prompt', 'the field a refusal is about did not survive')

    const movedRequest = fakeExchange({ method: 'POST', body: JSON.stringify({ taskId: 'task-1', move: 'top' }) })
    await server.routes.get('/mega-core/task-move').handler(movedRequest.request, movedRequest.response)
    assert.equal(movedRequest.response.statusCode, 200)
    assert.deepEqual(moved[0], { taskId: 'task-1', move: 'top' })

    const badMove = fakeExchange({ method: 'POST', body: JSON.stringify({ taskId: 'task-1', move: 'sideways' }) })
    await server.routes.get('/mega-core/task-move').handler(badMove.request, badMove.response)
    assert.equal(badMove.response.statusCode, 400)
    assert.match(JSON.parse(badMove.response.body).reason, /not a queue move/)

    const wrongMethodMove = fakeExchange({ method: 'GET' })
    await server.routes.get('/mega-core/task-move').handler(wrongMethodMove.request, wrongMethodMove.response)
    assert.equal(wrongMethodMove.response.statusCode, 405)
    assert.match(JSON.parse(wrongMethodMove.response.body).reason, /moved with POST/)

    /**
     * The ball's position: a file under `$DSH_HOME/state`, not `localStorage`.
     *
     * The official UI is served from a `--port 0` loopback URL, so its origin — and every `localStorage` entry with
     * it — changes on every restart. A file is origin-independent, which is the property "the ball comes back where
     * I put it" needs.
     */
    const empty = fakeExchange()
    await server.routes.get('/mega-core/orb').handler(empty.request, empty.response)
    assert.equal(empty.response.statusCode, 200)
    assert.deepEqual(JSON.parse(empty.response.body), { ok: true, position: null })

    const stored = fakeExchange({ method: 'POST', body: JSON.stringify({ position: { right: 14, bottom: 220, edge: 'right' } }) })
    await server.routes.get('/mega-core/orb').handler(stored.request, stored.response)
    assert.equal(stored.response.statusCode, 200)
    assert.deepEqual(JSON.parse(stored.response.body).position, { right: 14, bottom: 220, edge: 'right' })
    assert.equal(host.readOrbPosition({ DSH_HOME: dshHome }).bottom, 220, 'the position did not survive the answer')

    // Something that is not two finite numbers is refused rather than written: the file is the ball's memory.
    const nonsense = fakeExchange({ method: 'POST', body: JSON.stringify({ position: { right: 'left', bottom: null } }) })
    await server.routes.get('/mega-core/orb').handler(nonsense.request, nonsense.response)
    assert.equal(nonsense.response.statusCode, 400)
    assert.match(JSON.parse(nonsense.response.body).reason, /finite x and y/)
    assert.equal(host.readOrbPosition({ DSH_HOME: dshHome }).bottom, 220, 'a refused write changed the stored position')
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

    /**
     * The timing surface is a 503 with a reason, and it is a *different* answer from the view's: a caller that
     * asked what a task may be must see that it was not told, so the form can say "start DS-Hns" rather than
     * drawing an empty time field that looks like a choice.
     */
    const timing = fakeExchange()
    await server.routes.get('/mega-core/timing').handler(timing.request, timing.response)
    assert.equal(timing.response.statusCode, 503)
    const timingBody = JSON.parse(timing.response.body)
    assert.equal(timingBody.ok, false)
    assert.equal(timingBody.available, false)
    assert.match(timingBody.reason, /not running|no governance bridge file/)

    // The ball's position needs no bridge at all: it is this half's own file, and "nothing stored yet" is a
    // complete answer to it.
    const orb = fakeExchange()
    await server.routes.get('/mega-core/orb').handler(orb.request, orb.response)
    assert.equal(orb.response.statusCode, 200)
    assert.deepEqual(JSON.parse(orb.response.body), { ok: true, position: null })
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
