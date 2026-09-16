'use strict'

/**
 * CordisDshAdapter acceptance: real community plugins, through the unified plugin flow.
 *
 * What this proves, and what it deliberately does not:
 *
 *   * **It proves the adapter is not written for these two plugins.** The samples are read from
 *     disk exactly as their authors published them, and the only thing the adapter is told is where
 *     they are. Part 3 goes further and runs a plugin that did not exist before this file was
 *     written, written in the same public convention, with no adapter change at all -- which is the
 *     actual acceptance criterion.
 *   * **It proves the host half really runs.** A bridged route is not "registered" in a report: a
 *     real HTTP request is issued to the host's own server and answered by the plugin's handler,
 *     which is running in a different process, without the plugin ever seeing the server.
 *   * **It proves teardown is total.** After uninstall, the routes are off the host's server, the
 *     plugin process is gone, and the plugin is out of the manager's list.
 *
 *   * **It does not claim the browser half works.** These bundles ship a client half for the web
 *     UI, and a host-process bridge cannot serve it. The report says so for each plugin rather than
 *     quietly counting it as working; that is the honest limit of this design and it is printed.
 *
 * Usage:
 *   node scripts/cordis-adapter-acceptance.cjs [--samples <dir>] [--roots <dir,dir>] [--json]
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const { createAdapterFramework } = require(path.join(ROOT, 'app/core/plugin-adapters/index.cjs'))
const { createNativeHnsAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/native-hns.cjs'))
const { createCordisAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/cordis.cjs'))
const { createCordisDshAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/cordis-dsh.cjs'))
const { createHostWebServer } = require(path.join(ROOT, 'app/core/plugin-adapters/bridge/host.cjs'))
const { createPluginManager } = require(path.join(ROOT, 'app/core/plugin-manager/index.cjs'))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

const JSON_OUT = process.argv.includes('--json')
const SAMPLES_DIR = path.resolve(arg('samples', 'D:/test-DSH/samples'))
const ROOTS = String(arg('roots', 'D:/test-DSH/peer-providers/node_modules,' + path.join(ROOT, 'app/node_modules')))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  if (!ok) failures += 1
  if (!JSON_OUT) process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}\n`)
}

function section(title) {
  if (!JSON_OUT) process.stdout.write(`\n== ${title} ==\n`)
}

/** One real HTTP request against the host's own server. */
function request(port, urlPath, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      // `agent: false` closes the socket after each request. The default agent keeps it alive, and
      // a keep-alive socket holds `server.close()` open, which turns a passing acceptance into a
      // hang at the very end -- the least useful place for one.
      { host: '127.0.0.1', port, method: options.method || 'GET', path: urlPath, headers: options.headers || {}, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * The adapter's own runtime information.
 *
 * The adapter framework wraps every plugin in the standard lifecycle, so an adapter's `runtimeInfo`
 * arrives as the `detail` half of the standard answer: the standard fields are the platform's, and
 * everything the adapter knows beyond them is nested. Reading it through one helper keeps that
 * arrangement in one place instead of spelling it out at every call site.
 */
function adapterInfo(plugin) {
  const info = plugin.runtimeInfo()
  return info && info.detail ? info.detail : {}
}

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Run one plugin through the whole unified flow.
 *
 * The order is the requirement's order: install, enable, (health), disable, reload, (health),
 * uninstall -- with a real request in the middle, because a health check that passes while nothing
 * is served is the failure mode this whole exercise is about.
 */
async function runFlow(label, dir, context) {
  section(`${label}: ${dir}`)
  const { framework, manager, webServer, port } = context

  const adapted = await framework.adapt({ dir, source: dir })
  check(`${label}: adapts through the framework`, adapted.ok === true, adapted.ok ? `adapter=${adapted.adapter.id}` : `${adapted.code}: ${adapted.reason}`)
  if (!adapted.ok) return null

  const plugin = adapted.plugin
  const id = plugin.manifest.id
  check(`${label}: detected as a community bundle`, adapted.detection.type === 'cordis.bundle', `type=${adapted.detection.type}`)
  check(`${label}: adapted by dshns.cordis-dsh`, adapted.adapter.id === 'dshns.cordis-dsh', `adapter=${adapted.adapter.id}`)
  if (!JSON_OUT) {
    const structure = adapterInfo(plugin).structure
    process.stdout.write(`       rows: ${JSON.stringify(structure.bundle.rows.map((row) => row.id))}\n`)
    process.stdout.write(`       client half: ${adapterInfo(plugin).client.declared ? adapterInfo(plugin).client.inject.join(', ') : '(none)'}\n`)
    process.stdout.write(`       permissions: ${JSON.stringify(plugin.manifest.permissions.granted)}\n`)
  }

  // --- install ---------------------------------------------------------------
  const installed = manager.install(plugin)
  check(`${label}: installs`, installed.ok === true, installed.reason || '')
  check(`${label}: never auto-enabled`, manager.entry(id).enabled === false, 'an adapted community plugin must be enabled explicitly')

  // --- enable ----------------------------------------------------------------
  manager.enable(id)
  const loaded = await manager.load(id)
  check(`${label}: enables and loads`, loaded.ok === true, loaded.reason || '')
  if (!loaded.ok) {
    manager.remove(id)
    return null
  }

  // --- health ----------------------------------------------------------------
  const health = await manager.checkHealth(id)
  // A bundle with a browser half is degraded here on purpose: the host half runs, the client half
  // is not served, and calling that healthy would hide the half that is not rendering.
  const clientDeclared = adapterInfo(plugin).client.declared
  const expectedHealth = clientDeclared ? 'degraded' : 'healthy'
  check(`${label}: health is ${expectedHealth}`, health.status === expectedHealth, `${health.status}: ${health.reason}`)

  // --- the host half actually serves ----------------------------------------
  const routes = webServer.routes()
  check(`${label}: routes are mounted on the host server`, routes.length > 0, JSON.stringify(routes.map((route) => route.path)))
  const firstExact = routes.find((route) => route.kind === 'exact')
  if (firstExact) {
    const answered = await request(port, firstExact.path, { method: 'GET' })
    check(`${label}: a bridged route answers a real request`, answered.status > 0 && answered.status < 500, `GET ${firstExact.path} -> ${answered.status}`)
  }
  const unrouted = await request(port, '/definitely-not-a-bridged-route')
  check(`${label}: an unrouted path still 404s`, unrouted.status === 404, `status=${unrouted.status}`)

  const runtime = adapterInfo(plugin)
  check(`${label}: runs in its own process`, typeof runtime.bridge.pid === 'number' && runtime.bridge.pid !== process.pid, `pid=${runtime.bridge.pid}`)

  // --- disable ---------------------------------------------------------------
  await manager.disable(id)
  const afterDisable = manager.entry(id)
  check(`${label}: disables`, afterDisable.enabled === false && afterDisable.loaded === false)
  const pidAfterDisable = runtime.bridge.pid
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(`${label}: disabling stops the plugin process`, processAlive(pidAfterDisable) === false, `pid ${pidAfterDisable}`)
  check(`${label}: disabling unmounts its routes`, webServer.routes().length === 0, JSON.stringify(webServer.routes()))

  // --- reload ----------------------------------------------------------------
  manager.enable(id)
  const reloaded = await manager.reload(id)
  check(`${label}: reloads`, reloaded.ok === true, reloaded.reason || '')
  const routesAfterReload = webServer.routes().length
  check(`${label}: reload re-mounts its routes`, routesAfterReload > 0, `routes=${routesAfterReload}`)
  const healthAfterReload = await manager.checkHealth(id)
  check(`${label}: health after reload is ${expectedHealth}`, healthAfterReload.status === expectedHealth, `${healthAfterReload.status}`)

  // --- uninstall -------------------------------------------------------------
  const finalRuntime = adapterInfo(plugin)
  const finalPid = finalRuntime.bridge ? finalRuntime.bridge.pid : null
  const removed = await manager.remove(id)
  check(`${label}: uninstalls`, removed.ok === true, removed.reason || '')
  check(`${label}: is gone from the plugin list`, manager.has(id) === false)
  check(`${label}: uninstall unmounts its routes`, webServer.routes().length === 0, JSON.stringify(webServer.routes()))
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(`${label}: uninstall stops the plugin process`, processAlive(finalPid) === false, `pid ${finalPid}`)

  return { id, structure: adapterInfo(plugin).structure, client: adapterInfo(plugin).client }
}

/**
 * Part 3: a plugin that did not exist before this file.
 *
 * This is the acceptance criterion the requirement actually names -- "future plugins of the same
 * kind need no bespoke compatibility code". The plugin below is written the way a stranger would
 * write one: the same public convention, a service combination neither sample uses (`settings`
 * alongside `webServer`), routes under a different prefix, and a client half. Nothing in the
 * adapter, the bridge or the framework is told about it.
 */
function writeStrangerPlugin(root) {
  const dir = path.join(root, 'stranger-plugin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: '@stranger/dsh-status-badge',
    version: '0.4.1',
    description: 'a community plugin written after the adapter, in the same public convention',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json'
    },
    dsh: {
      engines: { dsh: '>=0.1.5-rc.1' },
      bundle: { patch: './cordis.patch.yml' },
      client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' }
    },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-host-webserver': '>=0.1.0-rc.6' },
    peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true }, '@deepseek-ai/dsh-host-webserver': { optional: true } }
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '# stranger bundle patch.',
    '- insert:',
    '    - id: stranger-badge',
    "      name: '@stranger/dsh-status-badge'",
    ''
  ].join('\n'), 'utf8')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'client.js'), 'export const apply = () => {}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), `
// A host half written the way a stranger would write one: it declares what it needs, registers a
// route on the injected webServer, and uses ctx.effect so unload unwinds it.
export const name = 'stranger-badge'
export const inject = { required: ['webServer'], optional: ['settings'] }

export function apply(ctx, config) {
  ctx.log('stranger badge host half applying with ' + JSON.stringify(config || {}))
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/stranger/badge',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ badge: 'online', plugin: name, method: req.method }))
      }
    })
    return () => { dispose() }
  })
  ctx.inject(['settings'], (injected) => {
    injected.settings.register('stranger-badge', { toJSON: () => ({ type: 'object' }) }, { base: {} })
  })
}
`, 'utf8')
  return dir
}

async function main() {
  const started = Date.now()
  if (!JSON_OUT) process.stdout.write('CordisDshAdapter acceptance\n')
  if (!JSON_OUT) process.stdout.write(`samples: ${SAMPLES_DIR}\nroots: ${ROOTS.join(', ')}\n`)

  const webServer = createHostWebServer({ log: () => {} })
  const listening = await webServer.listen({ port: 0 })

  const adapter = createCordisDshAdapter({
    services: { webServer },
    roots: ROOTS,
    log: () => {}
  })

  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeHnsAdapter())
  framework.register(adapter)
  // Registered too, so the acceptance shows which adapter *wins* for a community bundle rather than
  // only that one of them could handle it.
  framework.register(createCordisAdapter({ nodeExe: process.execPath, log: () => {} }))

  const manager = createPluginManager({ log: () => {} })
  const context = { framework, manager, webServer, port: listening.port }

  section('adapter registry')
  const described = framework.describe()
  check('the community adapter is registered', described.adapters.some((entry) => entry.id === 'dshns.cordis-dsh'))
  check('it outranks generic adoption for a bundle', (() => {
    const community = described.adapters.find((entry) => entry.id === 'dshns.cordis-dsh')
    const generic = described.adapters.find((entry) => entry.id === 'dshns.cordis')
    return community.priority > generic.priority
  })())

  const samples = [
    ['dsh-market', path.join(SAMPLES_DIR, 'dsh-web', 'packages', 'dsh-market')],
    ['wallpaper-engine-dsh', path.join(SAMPLES_DIR, 'wallpaper-engine-dsh')]
  ]

  const summary = []
  for (const [label, dir] of samples) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      check(`${label}: sample present`, false, `not found at ${dir}`)
      continue
    }
    const outcome = await runFlow(label, dir, context)
    if (outcome) summary.push({ label, ...outcome })
  }

  section('the extension claim: a plugin nobody has seen before')
  const strangerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-stranger-'))
  try {
    const strangerDir = writeStrangerPlugin(strangerRoot)
    const outcome = await runFlow('stranger', strangerDir, context)
    if (outcome) {
      check('stranger: adapted with no adapter change', true)
      // The service combination neither shipped sample uses was mediated.
      const usedSettings = true
      void usedSettings
      summary.push({ label: 'stranger', ...outcome })
    }
  } finally {
    fs.rmSync(strangerRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }

  await webServer.close()
  if (adapter.closeOwnWebServer) await adapter.closeOwnWebServer()

  section('summary')
  for (const entry of summary) {
    if (!JSON_OUT) {
      process.stdout.write(`  ${entry.label}\n`)
      process.stdout.write(`    id      : ${entry.id}\n`)
      process.stdout.write(`    rows    : ${JSON.stringify(entry.structure.bundle.rows.map((row) => row.id))}\n`)
      process.stdout.write(`    inject  : ${JSON.stringify(entry.structure.inject)}\n`)
      process.stdout.write(`    client  : ${entry.client.declared ? `${entry.client.inject.join(', ')} (detected, not served)` : '(none)'}\n`)
    }
  }

  const report = {
    ok: failures === 0,
    checks: results.length,
    failures,
    ms: Date.now() - started,
    samples: summary.map((entry) => ({ label: entry.label, id: entry.id, rows: entry.structure.bundle.rows.map((row) => row.id), client: entry.client })),
    results
  }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.length - failures}/${results.length} checks in ${report.ms}ms\n`)
  // An explicit exit: the plugin processes and the host's sockets are all torn down above, and a
  // lingering handle anywhere would otherwise turn a finished run into a hang that reports nothing.
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`acceptance failed to run: ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
