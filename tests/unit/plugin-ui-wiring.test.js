'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginHost } = require('../../app/plugin-host.cjs')
const { parseLock, renderLock, compareLock } = require('../../app/core/lockfile/index.cjs')

/**
 * Plugin platform wiring gate (Update-Plan/accleration.md sections 40, 45, 46, 50).
 *
 * Same discipline as the engineering and Computer Use gates: a capability that claims to
 * be wired has to be wired *in the shipped files* — the shell, the preload, the dock, the
 * panel, the config and the CI definition — and not only in a module with a nice test.
 * The host itself is driven here too, because an IPC surface registered against a host
 * that cannot answer is not wiring.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = (relative) => fs.existsSync(path.join(ROOT, relative))

/** A host with its own config and lock directories, so no test touches the repository. */
function tempHost(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-plugin-host-'))
  const host = createPluginHost({
    root: ROOT,
    configDir: path.join(dir, 'plugins'),
    lockFile: path.join(dir, 'dshns-lock.yaml'),
    log: () => {},
    ...options
  })
  return { host, dir, dispose: async () => {
    await host.dispose('test teardown')
    fs.rmSync(dir, { recursive: true, force: true })
  } }
}

test('the shell owns the plugin host and registers its IPC surface', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /const PLUGIN_CHANNELS = \[/)
  assert.match(shell, /function ensurePluginHost\(/)
  assert.match(shell, /function registerPluginIpc\(/)
  assert.match(shell, /function disposePluginsOnExit\(/)
  assert.match(shell, /function pluginsEnabled\(/)
  assert.match(shell, /function pluginDefaults\(/)
  for (const channel of [
    'plugins:status',
    'plugins:list',
    'plugins:describe',
    'plugins:capabilities',
    'plugins:enable',
    'plugins:reload',
    'plugins:health',
    'plugins:execution',
    'plugins:configure',
    'plugins:lock'
  ]) {
    assert.ok(shell.includes(`'${channel}'`), `the shell does not register ${channel}`)
  }
  // Registered at boot, created on the first call, and disposed with the shell.
  assert.match(shell, /registerPluginIpc\(\)/)
  assert.match(shell, /disposePluginsOnExit\('shell teardown'\)/)
  assert.match(shell, /plugins: runtime available on demand/)
})

test('the preload bridges the plugin surface and exposes no installer', () => {
  const preload = read('app/extensions/mega/ui/preload.cjs')
  assert.match(preload, /exposeInMainWorld\('megaPlugins'/)
  for (const method of ['status', 'list', 'describe', 'capabilities', 'enable', 'reload', 'health', 'execution', 'configure', 'lock']) {
    assert.match(preload, new RegExp(`${method}: \\(`), `the bridge does not expose ${method}`)
  }
  for (const channel of ['plugins:status', 'plugins:list', 'plugins:describe', 'plugins:capabilities', 'plugins:enable', 'plugins:reload', 'plugins:health', 'plugins:execution', 'plugins:configure', 'plugins:lock']) {
    assert.ok(preload.includes(`'${channel}'`), `the bridge does not invoke ${channel}`)
  }
  // The bridge hands the renderer no way to install, load or require anything: the only
  // verbs are the host operations, by id.
  const bridge = preload.slice(preload.indexOf("exposeInMainWorld('megaPlugins'"), preload.indexOf('megaSubWorker'))
  assert.equal(/[^a-zA-Z]install:|[^a-zA-Z]load:\s*\(|require\(/.test(bridge), false, 'the bridge must not expose an installation path')
})

test('the dock exposes a plugin panel and nothing in it executes', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const dock = read('app/extensions/mega/ui/dock.js')
  const panel = read('app/extensions/mega/ui/plugin-panel.js')
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(html, /id="pluginsPanel"/)
  assert.match(html, /plugin-panel\.js/)
  assert.match(html, /id="plugGroups"/)
  assert.match(html, /id="plugExecution"/)
  assert.match(html, /id="plugDetail"/)
  assert.match(html, /id="plugLock"/)
  assert.match(dock, /megaPluginPanel/)
  assert.match(dock, /pluginPanel\?\.refresh/)
  assert.match(css, /\.plugins-panel|\.plug-row/)
  // The panel is a control surface: it reads reports and edits settings, and reaches the
  // runtime only through the bridge.
  assert.match(panel, /window\.megaPlugins/)
  assert.match(panel, /api\.configure\(/)
  assert.match(panel, /api\.enable\(/)
  assert.match(panel, /api\.reload\(/)
  assert.match(panel, /api\.describe\(/)
  assert.equal(/require\(|child_process|spawn|exec\(|robotjs|pyautogui/.test(panel), false, 'the panel must not execute anything')
  assert.equal(/readFileSync|writeFileSync|fs\./.test(panel), false, 'the panel must not touch the filesystem')
})

test('the platform is configured in config/app.json with the execution defaults', () => {
  const config = JSON.parse(read('config/app.json'))
  assert.ok(config.plugins, 'config/app.json has no plugins block')
  assert.equal(typeof config.plugins.enabled, 'boolean')
  const execution = config.plugins.execution
  assert.ok(execution, 'config/app.json has no plugins.execution block')
  assert.ok(['off', 'safe', 'adaptive', 'aggressive'].includes(execution.mode))
  assert.ok(execution.maxWorkers >= 1 && execution.maxWorkers <= 16)
  for (const key of ['cpuLimit', 'ramLimit', 'gpuLimit']) {
    assert.ok(execution[key] > 0 && execution[key] <= 100, `${key} is not a percentage`)
  }
  assert.ok(['auto', 'off'].includes(execution.workspaceIsolation))
})

test('the host lists, describes and groups the real plugin set', async () => {
  const { host, dispose } = tempHost()
  try {
    const built = await host.ensure()
    assert.equal(built.ok, true, built.error)
    const status = host.status()
    assert.equal(status.built, true)
    assert.ok(status.plugins >= 25, `expected the whole set (${status.plugins})`)
    assert.equal(status.byState.installed, status.plugins)
    assert.ok(status.byState.loaded >= 25, JSON.stringify(status.byState))
    // Health was probed at build time, so the panel's first paint is not blank.
    assert.ok(status.byState.healthy + status.byState.unhealthy >= 1, 'no plugin reported health')

    const listed = host.list()
    assert.deepEqual(listed.groups.map((group) => group.name), ['Execution', 'Autonomy', 'Coding', 'Performance', 'Observability'])
    const coded = listed.groups.find((group) => group.name === 'Coding')
    assert.ok(coded.plugins.some((plugin) => plugin.id === 'dshns.repo-map'), 'the repo map is not grouped as coding')
    for (const plugin of listed.plugins) {
      assert.ok(plugin.group, `${plugin.id} has no group`)
      assert.equal(typeof plugin.enabled, 'boolean')
      assert.equal(typeof plugin.loaded, 'boolean')
    }

    const described = host.describe({ id: 'dshns.parallel-executor' })
    assert.equal(described.ok, true)
    assert.equal(described.version, '1.0.0')
    assert.equal(described.apiVersion, 'dshns.plugin/v1')
    assert.deepEqual(described.capabilities, ['parallel-execution'])
    assert.ok(Array.isArray(described.capabilityDetail) && described.capabilityDetail[0].capability === 'parallel-execution')
    assert.ok(described.requires.includes('resource-management'))
    assert.ok(described.optional.includes('workspace-isolation'))
    assert.equal(described.group, 'Performance')
    assert.ok(described.config, 'the describe reply carries no config')
    assert.equal(host.describe({ id: 'nope' }).code, 'PLUGIN_NOT_FOUND')
    assert.equal(host.describe({}).code, 'PLUGIN_ID_REQUIRED')
  } finally {
    await dispose()
  }
})

test('the shipped config/app.json decides what the panel shows on a fresh install', async () => {
  const { executionDefaults } = require('../../app/plugin-host.cjs')
  const block = JSON.parse(read('config/app.json')).plugins
  const defaults = executionDefaults(block)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.enforceLock, false)
  assert.equal(defaults.plugins['dshns.parallel-executor'].mode, block.execution.mode)
  assert.equal(defaults.plugins['dshns.resource-manager'].cpuLimit, block.execution.cpuLimit)

  // With no config file present, the execution block must resolve to the shipped values
  // and say that they came from the defaults layer rather than from a file.
  const { host, dispose } = tempHost({ defaults })
  try {
    await host.ensure()
    const execution = host.execution()
    assert.equal(execution.fields.mode.value, block.execution.mode)
    assert.equal(execution.fields.mode.source, 'defaults')
    assert.equal(execution.fields.cpuLimit.value, block.execution.cpuLimit)
    assert.equal(execution.fields.cpuLimit.source, 'defaults')
    assert.equal(execution.fields.workspaceIsolation.value, block.execution.workspaceIsolation)
    // And the shipped limit reached the object that derives the worker count.
    assert.equal(host.resources.limits.cpuPercent, block.execution.cpuLimit)
    assert.equal(host.resources.limits.ramPercent, block.execution.ramLimit)
  } finally {
    await dispose()
  }
})

test('the capability view answers what is provided and what the fallback is', async () => {
  const { host, dispose } = tempHost()
  try {
    await host.ensure()
    const view = host.capabilities()
    const repoMap = view.capabilities.find((entry) => entry.capability === 'repo-map')
    assert.equal(repoMap.provided, true)
    assert.deepEqual(repoMap.actualProviders, ['dshns.repo-map'])
    assert.match(repoMap.fallback, /text search/)
    // Every capability the platform promises says what happens without it.
    for (const entry of view.capabilities) {
      assert.ok(entry.description && entry.fallback, `${entry.capability} promises nothing`)
    }
  } finally {
    await dispose()
  }
})

test('an execution setting reaches the plugin that owns it, and a bad one is refused', async () => {
  const { host, dir, dispose } = tempHost()
  try {
    await host.ensure()
    const before = host.execution()
    assert.equal(before.fields.mode.source, 'default')
    assert.equal(before.fields.mode.value, 'adaptive')

    const configured = await host.configure({ mode: 'safe', cpuLimit: 60, workspaceIsolation: 'off' })
    assert.equal(configured.ok, true, configured.error)
    assert.deepEqual(configured.changed, { mode: 'safe', cpuLimit: 60, workspaceIsolation: 'off' })
    assert.equal(configured.written.length, 3, JSON.stringify(configured.written))
    // The settings landed in the platform's own per-plugin config layer.
    const executorFile = path.join(dir, 'plugins', 'dshns.parallel-executor.json')
    assert.equal(fs.existsSync(executorFile), true)
    assert.equal(JSON.parse(fs.readFileSync(executorFile, 'utf8')).mode, 'safe')

    const after = host.execution()
    assert.equal(after.fields.mode.value, 'safe')
    assert.equal(after.fields.mode.source, 'plugin-config')
    assert.equal(after.fields.cpuLimit.value, 60)
    // The limit reached the object that derives the worker count, not just a file.
    assert.equal(host.resources.limits.cpuPercent, 60)
    // The executor came back up with the new mode: the panel and the runtime agree.
    assert.equal(host.registry.resolve('parallel-execution').mode, 'safe')
    assert.equal(host.registry.has('parallel-execution'), true, 'the rebuilt world must still provide the capability')

    // An unknown key and an out-of-range value are refused with a reason, never written.
    const unknown = await host.configure({ nonsense: true })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'UNKNOWN_SETTING')
    const invalid = await host.configure({ cpuLimit: 500 })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, 'INVALID_SETTING')
    assert.match(invalid.error, /above the maximum/)
    assert.equal(host.execution().fields.cpuLimit.value, 60, 'a refused value must not change anything')
  } finally {
    await dispose()
  }
})

test('enabling and restarting a plugin is visible in the states, and off means off', async () => {
  const { host, dispose } = tempHost()
  try {
    await host.ensure()
    const off = await host.setEnabled({ id: 'dshns.computer-use', enabled: false })
    assert.equal(off.ok, true)
    assert.equal(host.registry.has('computer-use'), false, 'a disabled plugin provides nothing')
    const listed = host.list().plugins.find((plugin) => plugin.id === 'dshns.computer-use')
    assert.equal(listed.enabled, false)
    assert.equal(listed.loaded, false)
    // The thing that did not need it still works, which is acceptance A.
    assert.equal(host.registry.has('parallel-execution'), true)

    const on = await host.setEnabled({ id: 'dshns.computer-use', enabled: true })
    assert.equal(on.ok, true)
    assert.equal(host.registry.has('computer-use'), true)

    const reloaded = await host.reload({ id: 'dshns.repo-map' })
    assert.equal(reloaded.ok, true)
    assert.equal(reloaded.restartCount, 1)
    assert.equal(host.registry.has('repo-map'), true, 'the capability is back after the restart')
    assert.equal((await host.reload({})).code, 'PLUGIN_ID_REQUIRED')
  } finally {
    await dispose()
  }
})

test('a disabled runtime refuses every entry point with one shape', async () => {
  const { host, dispose } = tempHost({ available: () => false, reason: () => 'switched off for the test' })
  try {
    const ensured = await host.ensure()
    assert.equal(ensured.ok, false)
    assert.equal(ensured.code, 'PLUGIN_RUNTIME_DISABLED')
    for (const result of [host.status(), host.list(), host.describe({ id: 'dshns.repo-map' }), host.execution(), host.lockfile({})]) {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'PLUGIN_RUNTIME_DISABLED')
      assert.equal(result.error, 'switched off for the test')
    }
    assert.equal((await host.configure({ mode: 'off' })).code, 'PLUGIN_RUNTIME_DISABLED')
    assert.equal((await host.setEnabled({ id: 'dshns.repo-map', enabled: true })).code, 'PLUGIN_RUNTIME_DISABLED')
  } finally {
    await dispose()
  }
})

test('the lockfile pins the composition, and drift is reported rather than shrugged at', async () => {
  const { host, dir, dispose } = tempHost()
  try {
    await host.ensure()
    const written = host.lockfile({ write: true })
    assert.equal(written.ok, true)
    assert.ok(written.plugins >= 25)
    const text = fs.readFileSync(path.join(dir, 'dshns-lock.yaml'), 'utf8')
    assert.match(text, /^plugins:$/m)
    assert.match(text, /dshns\.parallel-executor:/)

    const verified = host.lockfile({})
    assert.equal(verified.read.ok, true)
    assert.equal(verified.state.ok, true, verified.state.reason)
    assert.equal(verified.state.locked, true)

    // The lockfile that ships must describe the set that ships: a committed lock that has
    // gone stale is a reproducibility claim that is not true.
    const shipped = compareLock(
      parseLock(read('dshns-lock.yaml')).plugins,
      host.manager.list().map((entry) => ({ id: entry.id, version: entry.version }))
    )
    assert.equal(shipped.ok, true, `dshns-lock.yaml is stale: ${shipped.reason}`)
    assert.equal(shipped.drift, 0)

    // A version that moved is drift, and the reply names the plugin and both versions.
    const parsed = parseLock(text)
    const compared = compareLock(parsed.plugins, [
      ...Object.entries(parsed.plugins).map(([id, entry]) => ({ id, version: entry.version })),
      { id: 'dshns.newcomer', version: '0.1.0' }
    ])
    assert.equal(compared.ok, false)
    assert.equal(compared.added.length, 1)
    assert.match(compared.reason, /dshns\.newcomer added/)

    const moved = compareLock(parsed.plugins, [
      ...Object.entries(parsed.plugins).map(([id, entry]) => ({ id, version: id === 'dshns.repo-map' ? '2.0.0' : entry.version })),
      { id: 'dshns.newcomer', version: '0.1.0' }
    ].filter((entry) => entry.id !== 'dshns.telemetry'))
    assert.equal(moved.ok, false)
    assert.equal(moved.changed.length, 1)
    assert.match(moved.reason, /dshns\.repo-map 1\.0\.0 -> 2\.0\.0/)
    assert.match(moved.reason, /dshns\.telemetry missing/)
  } finally {
    await dispose()
  }
})

test('a drifted lock refuses to load when the deployment enforces it', async () => {
  const { host, dir, dispose } = tempHost({ enforceLock: true })
  try {
    // Write a lock for a composition that does not exist, then enforce it.
    fs.mkdirSync(path.join(dir), { recursive: true })
    fs.writeFileSync(path.join(dir, 'dshns-lock.yaml'), renderLock({ 'dshns.ghost': { version: '9.9.9' } }), 'utf8')
    const ensured = await host.ensure()
    assert.equal(ensured.ok, false)
    assert.equal(ensured.code, 'PLUGIN_LOCK_DRIFT')
    assert.match(ensured.error, /dshns\.ghost missing/)
    assert.equal(host.status().built, false, 'a refused host must not report a built world')
  } finally {
    await dispose()
  }
})

test('the lockfile parser refuses what it does not understand', () => {
  assert.equal(parseLock('plugins:\n  a:\n    version: 1.0.0\n').ok, true)
  assert.equal(parseLock('plugins:\n  a:\n    version: 1.0.0\n').plugins.a.version, '1.0.0')
  // A second top-level key, a duplicate id, a missing version and a stray list are all
  // refusals with a line number: a parser that guesses reports a stability it never had.
  const cases = [
    ['version: 1\nplugins:\n', /only top-level key/],
    ['plugins:\n  a:\n    version: 1.0.0\n  a:\n    version: 2.0.0\n', /listed twice/],
    ['plugins:\n  a:\n    version:\n', /expected "version:" under a|empty version|no version/],
    ['plugins:\n  a:\n    - 1\n', /expected "version:" under a|unexpected indentation or key/],
    ['plugins: {}\n', /only top-level key/],
    ['', /no "plugins:" key/]
  ]
  for (const [text, pattern] of cases) {
    const parsed = parseLock(text)
    assert.equal(parsed.ok, false, `must refuse: ${JSON.stringify(text)}`)
    assert.match(parsed.reason, pattern)
  }
  // Comments and blank lines are allowed, and the renderer round-trips through the parser.
  const rendered = renderLock({ b: { version: '2.0.0' }, a: { version: '1.0.0' } })
  const round = parseLock(`# a comment\n\n${rendered}`)
  assert.equal(round.ok, true)
  assert.deepEqual(Object.keys(round.plugins), ['a', 'b'], 'ids are sorted so the file only changes when it must')
})

test('the syntax gate and the CI gate both cover the plugin surface', () => {
  const check = read('scripts/check-syntax.cjs')
  for (const dir of ["'core/lockfile'", "'plugins/acceleration'", "'plugins/mounted'"]) {
    assert.ok(check.includes(dir), `check-syntax.cjs does not cover ${dir}`)
  }
  assert.equal(exists('app/plugin-host.cjs'), true)
  assert.equal(exists('app/extensions/mega/ui/plugin-panel.js'), true)
  assert.equal(exists('dshns-lock.yaml'), true, 'the shipped lockfile is missing')

  const workflow = read('.github/workflows/verify.yml')
  assert.match(workflow, /name: Plugin runtime surface gate/)
  assert.match(workflow, /app\/plugin-host\.cjs/)
  assert.match(workflow, /app\/core\/lockfile\/index\.cjs/)
  assert.match(workflow, /plugin-panel\.js/)
  assert.match(workflow, /tests\/unit\/plugin-ui-wiring\.test\.js/)
  // The shipped lockfile must describe the shipped set, so it cannot silently go stale.
  assert.match(workflow, /dshns-lock\.yaml/)

  const testAll = read('scripts/test-all.ps1')
  assert.ok(testAll.includes('plugin-ui-wiring.test.js'), 'test-all.ps1 does not list the plugin UI suite')
})

test('no file in the plugin platform or its panel needs a plan document', () => {
  const files = []
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) files.push([`${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name), 'utf8')])
    }
  }
  walk(path.join(ROOT, 'app', 'plugins', 'acceleration'))
  walk(path.join(ROOT, 'app', 'core', 'lockfile'))
  files.push(['plugin-host.cjs', read('app/plugin-host.cjs')])
  files.push(['plugin-panel.js', read('app/extensions/mega/ui/plugin-panel.js')])
  for (const [name, source] of files) {
    assert.equal(/(plan\s*§|accleration\.md|Update-Plan)/.test(source), false, `${name} must not cite a one-time plan`)
  }
})
