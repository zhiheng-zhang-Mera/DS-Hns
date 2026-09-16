'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const { syncShippedPackage, shadowManifests, shippedFiles } = require('../../app/harness-profile.cjs')

/**
 * The Mega Core Plugin, accepted at the **installation** level.
 *
 * The suites next to this one prove the two halves in isolation: `mega-core-plugin.test.js` drives the host
 * half from the *source* directory, and `mega-core-client.test.js` drives the browser half from the *source*
 * file. Neither answers the question a new machine asks, which is whether the thing the installer actually
 * puts on disk is discovered, is loadable, and reaches the official Settings.
 *
 * So this file builds the installed shape — the shipped package copied into a Harness profile's own
 * `node_modules`, which is what the Harness CLI materialises for a `file:` dependency — and then runs the
 * three facts in order against **that copy**:
 *
 *   1. **discovered** — the shipped bundle is on the list DS-Hns installs, its manifest is the shape the
 *      Harness bundle walk needs, and every file it declares is really in the package;
 *   2. **loaded** — the installed copy is complete, carries no shadow manifest that would stop the bundle
 *      walk early, and both halves load from it: the host mounts its routes on the Harness web server, the
 *      browser half is accepted by the module loader and asks the platform table for nothing it cannot have;
 *   3. **in Settings** — the browser half claims the official `settings.section` slot and renders the Mega
 *      page there, which is what "Mega appears in the official Settings" means;
 *   4. **in the platform's own plugin set** — the installed directory is handed to the same adapter
 *      framework the running product builds its plugin set with, and the result is a plugin the manager
 *      installs and the bundled-plugin manager can find. Step 3 proves the code files work; this step is
 *      what keeps *"the files exist and load"* from standing in for *"the product's own plugin pipeline
 *      picks it up"*, which is the difference between a checkout that happens to contain a plugin and an
 *      installation that has one.
 *
 * The React stand-in is deliberately tiny (element trees, hook slots and effects). It is not a substitute for
 * the manual UI review; it is what makes "the section renders" an assertion rather than a claim.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const SHIPPED = path.join(ROOT, 'app', 'plugins', 'mega-core')
const PACKAGE_NAME = 'dsh-plugin-mega-core'
const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), `dsh-mega-core-install-${process.pid}`)
/** The profile's own `node_modules`, exactly where the Harness resolves a client plugin's bundle from. */
const PROFILE_MODULES = path.join(SCRATCH, 'profiles', 'web', 'node_modules')
const INSTALLED = path.join(PROFILE_MODULES, PACKAGE_NAME)

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const installedPath = (relative) => path.join(INSTALLED, relative)
const shippedManifest = readJson(path.join(SHIPPED, 'package.json'))

test.before(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(PROFILE_MODULES, { recursive: true })
  // The install the Harness performs for a `file:` dependency: the package lands under its own name in the
  // profile's `node_modules`. Copying the shipped package is that step, with no builder in between.
  fs.cpSync(SHIPPED, INSTALLED, { recursive: true })
})
test.after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
})

// -----------------------------------------------------------------------------------------------------------
// 1. Discovered
// -----------------------------------------------------------------------------------------------------------

test('the installed Mega Core is a shipped bundle, and every file it declares is really in the package', () => {
  const manifest = shippedManifest

  // The identity the profile directory, the lockfile and the manager all agree on.
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.equal(manifest.private, true, 'a shipped first-party plugin is not a published package')
  assert.equal(manifest.type, 'module', 'the package is ESM, so the Harness loader imports it rather than requiring it')

  // The two halves, each named where the Harness looks for it.
  assert.equal(manifest.main, 'lib/index.js', 'the host half is the package entry point')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js', 'the browser half is a subpath export')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch is declared where the walk reads it')

  // The client half is announced to the official UI, not merely present on disk.
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true, 'the ball and the settings page are wanted at once, not on demand')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))

  // Everything the manifest promises is on disk. A `files` list that names a file the package does not
  // contain is how a copy ships half a plugin, so it is the discovery fact worth asserting directly.
  const declared = shippedFiles(manifest)
  assert.ok(declared.length >= 5, `the manifest declares too few files to be a plugin: ${declared.join(', ')}`)
  for (const relative of declared) {
    assert.equal(fs.existsSync(path.join(SHIPPED, relative)), true, `${relative} is declared but not shipped`)
  }
  for (const required of ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.ok(
      declared.includes(required) || fs.existsSync(path.join(SHIPPED, required)),
      `${required} is part of the plugin but nothing ships it`
    )
  }

  // The patch is what actually inserts the plugin into the Harness' composition, and it may only add.
  const patch = fs.readFileSync(path.join(SHIPPED, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /- id: mega-core/)
  assert.match(patch, new RegExp(`name: '${PACKAGE_NAME}'`))
  assert.equal(/(- remove:|replace:)/.test(patch), false, 'the patch must be additive only')
})

// -----------------------------------------------------------------------------------------------------------
// 2. Loaded
// -----------------------------------------------------------------------------------------------------------

test('the installed copy is complete and carries no manifest that would stop the bundle walk', () => {
  assert.equal(fs.existsSync(installedPath('package.json')), true, 'the package is not installed under its own name')

  // The copy is the shipped package, file for file...
  const installed = readJson(installedPath('package.json'))
  assert.equal(installed.name, PACKAGE_NAME)
  for (const relative of shippedFiles(shippedManifest)) {
    assert.equal(fs.existsSync(installedPath(relative)), true, `the installed copy is missing ${relative}`)
    assert.equal(
      fs.readFileSync(installedPath(relative), 'utf8'),
      fs.readFileSync(path.join(SHIPPED, relative), 'utf8'),
      `the installed copy of ${relative} differs from the shipped file`
    )
  }

  // ...because a copy that already matches is left alone, which is the repair being a no-op rather than a write.
  const changed = syncShippedPackage({ sourceDir: SHIPPED, modulesDir: PROFILE_MODULES })
  assert.deepEqual(changed, [], 'a freshly installed copy was reported as repaired')

  // The failure this whole step exists for: the Harness resolves a client plugin's bundle through the
  // *nearest* manifest that names the package. One below the package root makes it look for `lib\lib\client.js`.
  const shadows = shadowManifests(INSTALLED, PACKAGE_NAME)
  assert.deepEqual(shadows, [], `the installed copy shadows its own package root: ${shadows.join(', ')}`)
})

test('the installed host half mounts its routes on the Harness web server, and unwinds them', async () => {
  const routes = new Map()
  const disposed = []
  const webServer = {
    register({ kind, path: routePath, handler }) {
      routes.set(routePath, { kind, handler })
      return () => {
        disposed.push(routePath)
        routes.delete(routePath)
      }
    }
  }
  const logs = []
  // The host half is ESM and its module specifier is relative to the *installed* directory, so it is imported
  // by URL from where the installer put it rather than from the source tree.
  const host = await import(pathToFileURL(installedPath('lib/index.js')).href)

  assert.equal(host.name, PACKAGE_NAME)
  assert.deepEqual(host.inject, ['webServer'], 'the host half declares the Harness service it needs')

  const dispose = host.apply({ webServer, log: (line) => logs.push(String(line)) })
  assert.equal(typeof dispose, 'function', 'the plugin must be able to unwind itself')

  assert.ok(routes.size >= 5, `the plugin mounted too few routes to serve the UI: ${routes.size}`)
  const mounted = routes.size
  for (const [routePath, route] of routes) {
    assert.equal(route.kind, 'exact', `${routePath} is not an exact route`)
    assert.equal(typeof route.handler, 'function', `${routePath} has no handler`)
  }
  // The health route is the one the shell and the browser half both read, so it is asserted by name.
  const health = [...routes.keys()].find((routePath) => routePath.includes('health'))
  assert.ok(health, `no health route was mounted: ${[...routes.keys()].join(', ')}`)

  dispose()
  assert.equal(routes.size, 0, 'the routes outlived the plugin')
  assert.equal(disposed.length, mounted, 'every registration must be unwound by the disposer')
})

// -----------------------------------------------------------------------------------------------------------
// 3. In the official Settings
// -----------------------------------------------------------------------------------------------------------

/** The React stand-in: element trees, hook slots and effects — as much as "the section renders" needs. */
function createReactShim() {
  let current = null
  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { $$element: true, type, props: { ...(props || {}), children: kids } }
    },
    useState(initial) {
      const index = current.cursor++
      if (current.hooks.length <= index) {
        current.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = current.hooks[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn) {
      current.cursor++
      const cleanup = fn()
      if (typeof cleanup === 'function') current.cleanups.push(cleanup)
    },
    useRef(initial) {
      const index = current.cursor++
      if (current.hooks.length <= index) current.hooks[index] = { value: { current: initial } }
      return current.hooks[index].value
    },
    useCallback(fn) {
      current.cursor++
      return fn
    }
  }
  /** Render once and hand back the element tree. One pass is enough: the plugin's own suites drive the updates. */
  const render = (Component, props) => {
    const state = { hooks: [], cursor: 0, cleanups: [] }
    const previous = current
    current = state
    try {
      return { tree: Component(props), cleanups: state.cleanups }
    } finally {
      current = previous
    }
  }
  return { React, render }
}

/** Every element in a tree that matches, so a test can ask what the page actually drew. */
function find(element, predicate, out = []) {
  if (!element || typeof element !== 'object') return out
  if (Array.isArray(element)) {
    for (const child of element) find(child, predicate, out)
    return out
  }
  if (element.$$element === true) {
    if (predicate(element)) out.push(element)
    find(element.props.children, predicate, out)
  }
  return out
}

/**
 * The installed bundle, loaded the way the official shell loads it: as a classic script in a DOM context,
 * which hands its definition to the module loader and receives the platform table through the factory.
 *
 * `fetch` never settles here on purpose. The two halves poll DS-Hns on mount, and a request that stays
 * pending is the honest "installed but DS-Hns is not answering" state — it also keeps this test to the one
 * fact it is about, which is whether the section is claimed and drawn at all.
 */
function loadInstalledBundle() {
  const definitions = []
  const required = []
  const intervals = []
  const source = fs.readFileSync(installedPath('lib/client.js'), 'utf8')
  const document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    head: { appendChild() {} },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: '', dataset: {} }),
    querySelector: () => null
  }
  const pending = () => new Promise(() => {})
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length },
    clearInterval() {},
    document,
    window: { __ModuleLoader__: { load(definition) { definitions.push(definition) } }, fetch: pending, addEventListener() {}, removeEventListener() {} }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'installed-mega-core-client.js' })

  const definition = definitions[0]
  assert.ok(definition, 'the installed bundle did not hand a definition to the module loader')

  const shim = createReactShim()
  const plugin = definition.factory((name) => {
    required.push(name)
    if (name === 'react') return shim.React
    // The official primitives are imported by the bundle even when this page draws none of them, so the
    // stand-in is empty on purpose: a page that needed one would fail here, which is the fact under test.
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`the installed bundle required ${name}, which is not in the platform table`)
  })
  return { plugin, required, shim, intervals }
}

test('the installed browser half claims the official Settings section and renders the Mega page there', () => {
  const { plugin, required, shim, intervals } = loadInstalledBundle()

  // What the bundle asked the platform for: the React runtime, and the official primitives. Nothing that
  // would only exist inside a checkout.
  assert.ok(required.includes('react'), `the bundle never asked for React: ${required.join(', ')}`)
  for (const name of required) {
    assert.ok(
      ['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(name),
      `the installed bundle required ${name}, which the platform table does not carry`
    )
  }
  assert.equal(/require\(['"][^'"]*(fs|path|electron)/.test(fs.readFileSync(installedPath('lib/client.js'), 'utf8')), false)

  // The slot service, recording what the installed bundle claims.
  const injected = []
  const ctx = {
    slots: {
      inject(name, callback) { injected.push({ name, callback }) },
      register(descriptor, Component) { return { descriptor, Component } }
    },
    effect(fn) { fn() }
  }

  const dispose = plugin.apply(ctx)
  assert.deepEqual(
    injected.map((entry) => entry.name).sort(),
    ['conversation.session.header.actions', 'settings.section', 'shell.overlay'],
    'the installed bundle claims a different set of official seats than the shipped plugin'
  )

  // **The Settings fact.** `settings.section` is the official seat for a first-level settings page, and the
  // descriptor carries the id and label the user sees in the settings list.
  const settings = injected.find((entry) => entry.name === 'settings.section')
  const registration = settings.callback()
  assert.deepEqual(JSON.parse(JSON.stringify(registration.descriptor)), {
    name: 'settings.section',
    id: 'mega',
    order: 500,
    label: 'Mega'
  })

  // **The rendering fact.** The seat holds a component, and that component draws the Mega page rather than
  // returning nothing: an entry that renders an empty box is not "appearing in Settings". The registered
  // wrapper returns `createElement(MegaPage, { store })`, so the page — and the store it reads — come out of
  // the element the wrapper draws.
  const wrapper = registration.Component({})
  assert.ok(wrapper && wrapper.$$element === true, 'the Settings entry did not render an element')
  assert.equal(typeof wrapper.type, 'function', 'the Settings entry did not render a component')
  assert.ok(wrapper.props.store, 'the Mega page was drawn without the store it reads')

  // The page it draws is the real §4.4 surface, not a placeholder: it walks to content of its own.
  const page = shim.render(wrapper.type, wrapper.props)
  const text = find(page.tree, (element) => typeof element.props.children === 'string')
  assert.ok(text.length > 0, 'the Mega settings page drew no text at all')

  // One poller at boot, and it is claimed through the interval the plugin clears on unload.
  assert.equal(intervals.length <= 1, true, `the installed bundle started ${intervals.length} intervals at mount`)

  assert.equal(typeof dispose, 'function', 'the installed bundle did not return its disposer')
  assert.doesNotThrow(() => dispose())
})

// -----------------------------------------------------------------------------------------------------------
// 4. In the platform's own plugin set
// -----------------------------------------------------------------------------------------------------------

test('the installed copy is adapted by the platform adapter layer, not merely loadable by hand', async () => {
  const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
  const { createHarnessProfileAdapter } = require('../../app/core/plugin-adapters/adapters/harness-profile.cjs')
  const { createCordisDshAdapter } = require('../../app/core/plugin-adapters/adapters/cordis-dsh.cjs')
  const { createCordisAdapter } = require('../../app/core/plugin-adapters/adapters/cordis.cjs')
  const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')

  // The framework the running product builds, with the same registrations in the same order: the
  // profile channel first, then the bridged community adapter, then the generic adoption path.
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createHarnessProfileAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisDshAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisAdapter({ log: () => {} }))

  const adapted = await framework.adapt({ dir: INSTALLED, channel: 'harness-profile', where: 'profile web' })
  assert.equal(adapted.ok, true, `the installed Mega Core was not adapted: ${adapted.reason || ''}`)
  assert.equal(adapted.adapter.id, 'dshns.harness-profile')
  assert.equal(adapted.detection.type, 'cordis.bundle', 'the installed shape is not the bundle the Harness composes')

  // The plugin object the framework produced is one the manager accepts: the same contract every
  // plugin faces, checked before anything runs.
  const manager = createPluginManager({ log: () => {} })
  const installed = manager.install(adapted.plugin)
  assert.equal(installed.ok, true, `the manager refused the adapted Mega Core: ${installed.reason || ''}`)
  const entry = manager.entry(adapted.plugin.manifest.id)
  assert.ok(entry, 'the manager has no record of the plugin it just installed')
  assert.equal(entry.installed, true)
  // It is the Harness that composes it, so this platform must not enable it in its own runtime: a
  // second instance of a plugin the Harness owns is the failure this adapter exists to prevent.
  assert.equal(entry.enabled, false, 'a profile-owned client plugin was enabled in this product\'s own runtime')
  assert.match(String(entry.health_contract && entry.health_contract.contract), /adapter-profile/)

  // And the *bundled* plugin set a profile install is checked against: what the shipped manifest pins,
  // and whether the profile really carries it. The bundle is read from the profile's own dependencies —
  // by package name, then translated to the manifest's plugin id, which is the join `bundled()` makes.
  const { entryForPackage, createBundledPlugins } = require('../../app/extensions/mega/plugins/index.cjs')
  // The profile's own manifest, written the way the Harness CLI writes it for a `file:` dependency: the
  // package name as the dependency key and the absolute `file:` spec as its value.
  const profileFile = path.join(SCRATCH, 'profiles', 'web', 'package.json')
  const dependencies = { [PACKAGE_NAME]: `file:${SHIPPED.replace(/\\/g, '/')}` }
  fs.writeFileSync(profileFile, `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies }, null, 2)}\n`, 'utf8')
  const bundles = createBundledPlugins({
    installed: () => Object.entries(dependencies).map(([name, version]) => {
      const manifestEntry = entryForPackage(name)
      return { id: manifestEntry ? manifestEntry.id : name, package: name, version, dir: null, enabled: true, where: 'harness-profile' }
    }),
    // The entry the shipped manifest would carry for a first-party `file:` plugin: its own package name
    // and the same absolute spec the profile declares, so "the profile has the pinned reference" is the
    // fact under test rather than a version string this test invented.
    manifest: {
      version: 'acceptance',
      plugins: [{ id: 'dsh-plugin-mega-core', package: PACKAGE_NAME, role: 'governance', channel: 'harness-profile', ref: dependencies[PACKAGE_NAME], tested: true, required: true }]
    }
  })
  const state = bundles.describe().states['dsh-plugin-mega-core']
  assert.equal(state, 'installed', `the bundled set does not see the installed Mega Core: ${state}`)
})
