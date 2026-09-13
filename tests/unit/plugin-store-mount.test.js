'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginHost } = require('../../app/plugin-host.cjs')

/**
 * The second stage of a store install, end to end.
 *
 * Staging puts a plugin on disk; *enabling* is the step that lets the host import it. That
 * step is the one that runs somebody else's code, so what is checked here is exactly what the
 * host does with `data/plugins/installed.json`: it mounts what is enabled, it ignores what is
 * not, it refuses an entry point that points outside the plugin directory, and a plugin that
 * cannot be imported is reported instead of taking the product down with it.
 */
const ROOT = path.resolve(__dirname, '..', '..')

/** A temp root with a store-installed plugin written into it. */
function harness(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-installed-'))
  const storeDir = path.join(root, 'data', 'plugins', 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  const written = []
  for (const entry of entries) {
    if (entry.module !== undefined) {
      const dir = path.join(storeDir, entry.directory)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, entry.main || 'index.cjs'), entry.module, 'utf8')
      written.push(dir)
    }
  }
  fs.mkdirSync(path.join(root, 'data', 'plugins'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'data', 'plugins', 'installed.json'),
    `${JSON.stringify({ version: 1, plugins: entries.map((entry) => ({ ...entry, module: undefined })) }, null, 2)}\n`,
    'utf8'
  )
  const host = createPluginHost({ root, log: () => {} })
  return { host, root, written, dispose: async () => {
    await host.dispose('test teardown')
    fs.rmSync(root, { recursive: true, force: true })
  } }
}

function entry(overrides = {}) {
  const directory = overrides.directory || 'acme_dshns-example'
  return {
    id: 'vendor.example',
    repo: 'acme/dshns-example',
    branch: 'main',
    version: '1.0.0',
    main: 'index.cjs',
    name: 'Example plugin',
    directory,
    dir: path.join('__ROOT__', 'data', 'plugins', 'store', directory),
    stagedAt: 1,
    enabled: true,
    enabledAt: 2,
    ...overrides
  }
}

const MODULE = `'use strict'
module.exports = {
  manifest: {
    api_version: 'dshns.plugin/v1',
    id: 'vendor.example',
    name: 'Example plugin',
    version: '1.0.0',
    description: 'installed from the store',
    provides: ['example-capability'],
    fault_level: 'soft'
  },
  async load(context) { context.provide('example-capability', { hello: () => 'world' }) },
  async healthCheck() { return { status: 'healthy' } }
}
`

test('an enabled store-installed plugin is mounted; a staged one is not', async () => {
  const enabled = entry()
  const staged = entry({ id: 'vendor.other', directory: 'acme_other', main: 'index.cjs', enabled: false, module: MODULE.replace(/vendor\.example/g, 'vendor.other') })
  const harnessed = harness([
    { ...enabled, module: MODULE },
    { ...staged, module: staged.module }
  ])
  // The paths in the state file have to be absolute, so they are pointed at the temp root.
  const stateFile = path.join(harnessed.root, 'data', 'plugins', 'installed.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.plugins = state.plugins.map((item) => ({ ...item, dir: path.join(harnessed.root, 'data', 'plugins', 'store', item.directory) }))
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  try {
    const built = await harnessed.host.ensure()
    assert.equal(built.ok, true, built.error)
    const listed = harnessed.host.list().plugins
    const mounted = listed.find((plugin) => plugin.id === 'vendor.example')
    assert.ok(mounted, 'the enabled plugin was not mounted')
    assert.equal(mounted.loaded, true, 'the enabled plugin did not load')
    assert.deepEqual(mounted.provides, ['example-capability'])
    assert.equal(harnessed.host.registry.has('example-capability'), true, 'the plugin did not provide its capability')
    // The staged-but-not-enabled one is nowhere: enabling is what mounts it.
    assert.equal(listed.some((plugin) => plugin.id === 'vendor.other'), false)
    // And the lock describes the product, not the user's installs.
    const lock = harnessed.host.lockfile({})
    assert.equal(lock.fromStore, 1)
    assert.equal(lock.state.ok, true, `the shipped lock must not drift because of a store install: ${lock.state.reason}`)
  } finally {
    await harnessed.dispose()
  }
})

test('a plugin that cannot be imported is reported, not fatal', async () => {
  const broken = entry({ id: 'vendor.broken', directory: 'acme_broken', module: "throw new Error('this plugin is broken')\n" })
  const harnessed = harness([broken])
  const stateFile = path.join(harnessed.root, 'data', 'plugins', 'installed.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.plugins = state.plugins.map((item) => ({ ...item, dir: path.join(harnessed.root, 'data', 'plugins', 'store', item.directory) }))
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  try {
    const built = await harnessed.host.ensure()
    assert.equal(built.ok, true, 'a broken third-party plugin must not stop the host from building')
    // The product's own plugins are all still there.
    assert.ok(harnessed.host.list().plugins.length >= 25, 'the shipped set must survive a broken install')
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.broken'), false)
  } finally {
    await harnessed.dispose()
  }
})

test('an entry point that escapes the plugin directory is refused', async () => {
  const escaping = entry({ id: 'vendor.escaping', directory: 'acme_escaping', main: '../../../outside.cjs', module: "module.exports = { manifest: { id: 'vendor.escaping' } }\n" })
  const harnessed = harness([escaping])
  const stateFile = path.join(harnessed.root, 'data', 'plugins', 'installed.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.plugins = state.plugins.map((item) => ({ ...item, dir: path.join(harnessed.root, 'data', 'plugins', 'store', item.directory) }))
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  try {
    const built = await harnessed.host.ensure()
    assert.equal(built.ok, true)
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.escaping'), false, 'a manifest must not be able to import outside its own directory')
  } finally {
    await harnessed.dispose()
  }
})

test('a root with no installs behaves exactly as before', async () => {
  const harnessed = harness([])
  try {
    const built = await harnessed.host.ensure()
    assert.equal(built.ok, true, built.error)
    assert.equal(harnessed.host.lockfile({}).fromStore, 0)
    assert.ok(harnessed.host.list().plugins.length >= 25)
  } finally {
    await harnessed.dispose()
  }
})
