'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { classifyCompatible, readCompatDescriptor, compatIdFor, semverFor, COMPAT_FILE, COMPAT_STATES, COMPAT_KINDS, COMPAT_APIS } = require('../../app/extensions/mega/store/compat.cjs')
const { parseSource, directoryNameFor, createStoreInstaller, INSTALL_REASONS } = require('../../app/extensions/mega/store/installer.cjs')
const { createCompatPlugin, COMPAT_LOAD_REASONS } = require('../../app/core/plugin-compat/index.cjs')
const deps = require('../../app/core/plugin-compat/deps.cjs')
const { createPluginHost } = require('../../app/plugin-host.cjs')

/**
 * Compatibility mode: three levels, and the boundaries of each.
 *
 * The store's first live target is an ecosystem of plugins for a different DSH host, so "refuse"
 * was honest but useless. This file is about the alternative being honest too:
 *
 *   * **manifest** —a package without `dshns-plugin.json` is classified and given a descriptor
 *     derived from what it declares, with the states a user can actually act on (needs an install,
 *     needs a build) rather than a flat failure;
 *   * **format** —an ES module entry, which `require` cannot read;
 *   * **API** —a Cordis `apply(ctx)` plugin, activated with a small shim.
 *
 * And about the guarantees being real: an adopted plugin is activated in its own process, so its
 * crashes, its `process.exit` and its hangs do not reach this one; a missing dependency is reported
 * as a package name; and nothing is installed or built without an explicit confirmation.
 */

/** A temp directory that is removed afterwards. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-compat-'))
  return {
    dir,
    // Windows keeps a directory busy while a just-started child still holds it, so the removal is
    // retried: a test that fails because a *cleanup* raced a child would hide the real result.
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** A package on disk with a given package.json, entry and node_modules presence. */
function packageDir(root, overrides = {}) {
  const dir = path.join(root, overrides.name || 'pkg')
  fs.mkdirSync(dir, { recursive: true })
  const pkg = {
    name: overrides.packageName || '@acme/dsh-pet',
    version: overrides.version || '0.3.22',
    description: 'a plugin from another ecosystem',
    type: overrides.type || 'module',
    main: overrides.main === undefined ? 'lib/index.js' : overrides.main,
    dependencies: overrides.dependencies || { schemastery: '^3.18.0' },
    ...(overrides.scripts ? { scripts: overrides.scripts } : {})
  }
  writeJson(path.join(dir, 'package.json'), pkg)
  if (overrides.entrySource !== undefined && overrides.entryPath) {
    const entry = path.join(dir, overrides.entryPath)
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, overrides.entrySource, 'utf8')
  }
  if (overrides.nodeModules) fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  if (overrides.cordisPatch) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n', 'utf8')
  return dir
}

test('a package inside a monorepo is addressable, and a path that could escape is not', () => {
  assert.deepEqual(parseSource('acme/dshns-example'), { repo: 'acme/dshns-example', path: null, source: 'acme/dshns-example' })
  assert.deepEqual(parseSource('zhu1090093659/dsh-web#packages/dsh-pet'), {
    repo: 'zhu1090093659/dsh-web',
    path: 'packages/dsh-pet',
    source: 'zhu1090093659/dsh-web#packages/dsh-pet'
  })
  assert.equal(parseSource('https://github.com/acme/repo.git#a/b').source, 'acme/repo#a/b')
  // Everything that could mean something other than "a directory inside the repository".
  for (const value of ['a/b#../etc', 'a/b#a/../../b', 'a/b#a\\b', 'a/b#C:/windows', 'a/b##a']) {
    assert.equal(parseSource(value), null, `${value} must not parse as a source`)
  }
  // A leading slash is redundant rather than dangerous: git paths are repository-relative.
  assert.deepEqual(parseSource('a/b#/abs'), { repo: 'a/b', path: 'abs', source: 'a/b#abs' })
  // A trailing `#` names the repository itself.
  assert.deepEqual(parseSource('a/b#'), { repo: 'a/b', path: null, source: 'a/b' })
  assert.equal(parseSource('not a repo'), null)
  // Two packages from one repository are two installations, so their directories differ.
  assert.notEqual(directoryNameFor('acme/repo', 'packages/a'), directoryNameFor('acme/repo', 'packages/b'))
  assert.equal(directoryNameFor('acme/repo', 'packages/a'), 'acme_repo__packages_a')
})

test('the classifier derives a descriptor from what a package declares', () => {
  const { dir, dispose } = scratch()
  try {
    const root = packageDir(dir, {
      packageName: '@linxin666/dsh-pet',
      type: 'module',
      main: 'lib/index.js',
      scripts: { build: 'tsc -b && tsdown' },
      cordisPatch: true,
      entrySource: 'export const apply = (ctx) => {}\n',
      entryPath: 'lib/index.js'
    })
    writeJson(path.join(root, 'package.json'), {
      ...JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
      dsh: { engines: { dsh: '>=0.1.5-rc.1' }, bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      peerDependencies: { react: '^18.2.0' }
    })
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })

    const classified = classifyCompatible(root, { repo: 'zhu1090093659/dsh-web', branch: 'dev', sourcePath: 'packages/dsh-pet' })
    assert.equal(classified.ok, true, classified.reason)
    const descriptor = classified.descriptor
    // The id is derived, prefixed and in the platform's own alphabet: an adopted plugin can never
    // be mistaken for one that declared the contract.
    assert.equal(descriptor.id, 'compat.linxin666.dsh-pet')
    assert.match(descriptor.id, /^[a-z0-9][a-z0-9._-]*$/)
    assert.equal(descriptor.kind, COMPAT_KINDS.DSH_BUNDLE)
    assert.equal(descriptor.api, COMPAT_APIS.CORDIS)
    assert.equal(descriptor.format, 'esm')
    assert.equal(descriptor.entry, 'lib/index.js')
    assert.equal(descriptor.entry_exists, true)
    assert.equal(descriptor.state, COMPAT_STATES.READY)
    assert.deepEqual(descriptor.dependencies, ['schemastery', 'react'])
    assert.equal(descriptor.source.repo, 'zhu1090093659/dsh-web')
    assert.equal(descriptor.source.path, 'packages/dsh-pet')
    assert.deepEqual(descriptor.markers.slice(0, 2), ['package.json#dsh', './cordis.patch.yml'])
    // The manifest handed to the manager is a real one, and an adopted plugin is never auto-on.
    assert.equal(descriptor.manifest.api_version, 'dshns.plugin/v1')
    assert.equal(descriptor.manifest.id, descriptor.id)
    assert.equal(descriptor.manifest.default_enabled, false)
    assert.equal(descriptor.manifest.fault_level, 'soft')
    assert.equal(descriptor.guarantees.cn.length >= 4, true)
    assert.equal(descriptor.guarantees.en.length, descriptor.guarantees.cn.length)
  } finally {
    dispose()
  }
})

test('the classifier names the step a package still needs instead of failing it', () => {
  const { dir, dispose } = scratch()
  try {
    // The real shape of the live target: a TypeScript package whose `lib/` is built, not committed.
    const needsBuild = packageDir(dir, {
      name: 'needs-build',
      main: 'lib/index.js',
      scripts: { build: 'tsc -b && tsdown' },
      entrySource: 'export const apply = () => {}\n',
      entryPath: 'src/index.ts'
    })
    const build = classifyCompatible(needsBuild)
    assert.equal(build.descriptor.state, COMPAT_STATES.NEEDS_BUILD)
    assert.equal(build.descriptor.entry_exists, false)
    assert.match(build.descriptor.state_reason, /lib\/index\.js is not in the repository/)
    assert.match(build.descriptor.state_reason, /tsc -b && tsdown/)

    // A declared entry that is missing with no way to produce it is not adoptable at all.
    const noBuild = packageDir(dir, { name: 'no-build', main: 'lib/index.js' })
    const unsupported = classifyCompatible(noBuild)
    assert.equal(unsupported.descriptor.state, COMPAT_STATES.UNSUPPORTED)
    assert.match(unsupported.descriptor.state_reason, /no build script/)

    // An entry that exists but whose dependencies are not installed needs an install, not a build.
    const needsDeps = packageDir(dir, {
      name: 'needs-deps',
      main: 'lib/index.js',
      entrySource: 'export const apply = () => {}\n',
      entryPath: 'lib/index.js',
      dependencies: { schemastery: '^3.18.0', clsx: '^2.1.1' }
    })
    const install = classifyCompatible(needsDeps)
    assert.equal(install.descriptor.state, COMPAT_STATES.NEEDS_DEPENDENCIES)
    assert.deepEqual(install.descriptor.dependencies, ['schemastery', 'clsx'])

    // With the dependencies present it is ready, and the markers say why.
    fs.mkdirSync(path.join(needsDeps, 'node_modules'), { recursive: true })
    assert.equal(classifyCompatible(needsDeps).descriptor.state, COMPAT_STATES.READY)

    // Nothing to adopt at all is a refusal, not a state.
    const empty = path.join(dir, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    const nothing = classifyCompatible(empty)
    assert.equal(nothing.ok, false)
    assert.equal(nothing.code, 'COMPAT_NO_PACKAGE_JSON')
  } finally {
    dispose()
  }
})

test('id and version derivation stay inside the platform alphabet', () => {
  assert.equal(compatIdFor('@scope/Name.With Caps'), 'compat.scope.name.with-caps')
  assert.equal(compatIdFor(''), null)
  assert.equal(compatIdFor('../../etc/passwd'), 'compat.etc.passwd')
  assert.deepEqual(semverFor('0.3.22'), { version: '0.3.22', source: 'package' })
  assert.deepEqual(semverFor('1.2.3-rc.1'), { version: '1.2.3', source: 'package' })
  assert.deepEqual(semverFor('2.0'), { version: '2.0.0', source: 'package' })
  assert.deepEqual(semverFor('not-a-version'), { version: '0.0.0', source: 'unknown' })
})

test('staging adopts a package when compatibility mode is on, and refuses it when it is off', () => {
  const { dir, dispose } = scratch()
  try {
    const calls = []
    const installer = createStoreInstaller({
      root: dir,
      storeDir: path.join(dir, 'data', 'plugins', 'store'),
      stateFile: path.join(dir, 'data', 'plugins', 'installed.json'),
      historyFile: path.join(dir, 'data', 'plugins', 'history.json'),
      log: () => {},
      clone: (url, target, options = {}) => {
        calls.push({ url, target, sparse: options.sparse || null })
        fs.mkdirSync(target, { recursive: true })
        // What a clone of the real monorepo package brings: package.json + src, no lib, no manifest.
        writeJson(path.join(target, 'package.json'), {
          name: '@linxin666/dsh-pet',
          version: '0.3.22',
          type: 'module',
          main: 'lib/index.js',
          dependencies: { schemastery: '^3.18.0' },
          scripts: { build: 'tsdown' },
          dsh: { bundle: { patch: './cordis.patch.yml' } }
        })
        return { ok: true }
      }
    })

    // Compatibility mode off: nothing is adopted, and the refusal says nothing was downloaded.
    const refused = installer.stage({ source: 'acme/target', compat: false })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, INSTALL_REASONS.BAD_MANIFEST)
    assert.equal(fs.existsSync(path.join(installer.storeDir, 'acme_target')), false)

    // Compatibility mode on: the copy is kept and a descriptor is derived beside it.
    const staged = installer.stage({ source: 'acme/target', compat: true })
    assert.equal(staged.ok, true, staged.reason)
    assert.equal(staged.compatibility, 'compat')
    assert.equal(staged.entry.compatibility, 'compat')
    assert.equal(staged.entry.compatKind, 'dsh-bundle')
    assert.equal(staged.entry.compatApi, 'cordis')
    assert.equal(staged.entry.format, 'esm')
    assert.equal(staged.entry.compatState, COMPAT_STATES.NEEDS_BUILD)
    assert.deepEqual(staged.entry.dependencies, ['schemastery'])
    const descriptor = readCompatDescriptor(staged.entry.dir)
    assert.ok(descriptor, 'no compatibility descriptor was written')
    assert.equal(descriptor.manifest.id, 'compat.linxin666.dsh-pet')
    // The package's own files are untouched: the descriptor is an addition, never a replacement.
    assert.equal(fs.existsSync(path.join(staged.entry.dir, 'package.json')), true)
    assert.equal(fs.existsSync(path.join(staged.entry.dir, 'dshns-plugin.json')), false)

    // And enabling it is a normal enable that reports the state rather than a failure.
    const enabled = installer.enable({ id: staged.entry.id })
    assert.equal(enabled.ok, true, enabled.reason)
    assert.equal(enabled.compatibility, 'compat')
    assert.equal(enabled.state, COMPAT_STATES.NEEDS_BUILD)
    const listed = installer.list().find((entry) => entry.id === staged.entry.id)
    assert.equal(listed.state, 'enabled')
    assert.equal(listed.compatibility, 'compat')
    assert.equal(listed.compatState, COMPAT_STATES.NEEDS_BUILD)
    assert.equal(installer.describe().compat, 1)
  } finally {
    dispose()
  }
})

test('a package inside a monorepo is cloned sparsely, copied out, and falls back when it must', () => {
  const { dir, dispose } = scratch()
  try {
    const calls = []
    const installer = createStoreInstaller({
      root: dir,
      storeDir: path.join(dir, 'data', 'plugins', 'store'),
      stateFile: path.join(dir, 'data', 'plugins', 'installed.json'),
      historyFile: path.join(dir, 'data', 'plugins', 'history.json'),
      log: () => {},
      clone: (url, target, options = {}) => {
        calls.push({ url, target, sparse: options.sparse || null })
        if (calls.length === 1) return { ok: false, reason: 'filtering not supported' }
        // The fallback is a full clone: the whole tree, with the package inside it.
        fs.mkdirSync(path.join(target, 'packages', 'pet'), { recursive: true })
        writeJson(path.join(target, 'packages', 'pet', 'package.json'), { name: '@acme/pet', version: '1.0.0', type: 'module', main: 'index.js' })
        fs.writeFileSync(path.join(target, 'packages', 'pet', 'index.js'), 'export const apply = () => {}\n', 'utf8')
        writeJson(path.join(target, 'package.json'), { name: 'monorepo', private: true })
        return { ok: true }
      }
    })
    const staged = installer.stage({ source: 'acme/mono#packages/pet', compat: true })
    assert.equal(staged.ok, true, staged.reason)
    // First attempt sparse, second attempt whole: a server without partial clone support must not
    // make a monorepo package uninstallable.
    assert.equal(calls[0].sparse, 'packages/pet')
    assert.equal(calls[1].sparse, null)
    assert.equal(calls[0].target, calls[1].target)
    // What is staged is the package, not the repository around it.
    assert.equal(fs.existsSync(path.join(staged.entry.dir, 'package.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.entry.dir, 'package.json'), 'utf8')).name, '@acme/pet')
    assert.equal(fs.existsSync(path.join(staged.entry.dir, 'packages')), false, 'the repository around the package was staged')
    assert.equal(staged.entry.sourcePath, 'packages/pet')
    assert.equal(staged.entry.source, 'acme/mono#packages/pet')

    // A path that is not in the repository is reported as exactly that.
    const missing = installer.stage({ source: 'acme/mono#packages/ghost', compat: true })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, INSTALL_REASONS.SOURCE_PATH_MISSING)
    assert.match(missing.reason, /has no directory packages\/ghost/)
    // And nothing is left behind by the failure.
    assert.equal(fs.existsSync(path.join(installer.storeDir, directoryNameFor('acme/mono', 'packages/ghost'))), false)
  } finally {
    dispose()
  }
})

test('the pre-flight refuses only what neither the contract nor the compatibility layer can take', async () => {
  const { dir, dispose } = scratch()
  try {
    const verdict = {
      ok: true,
      installable: false,
      verified: true,
      branch: 'dev',
      code: 'STORE_NO_MANIFEST',
      reason: 'no manifest',
      compat: { possible: true, probed: true, kind: 'dsh-bundle', name: '@linxin666/dsh-pet', entry: 'lib/index.js', build: 'tsdown', packages: ['schemastery'] }
    }
    const installer = createStoreInstaller({
      root: dir,
      storeDir: path.join(dir, 'store'),
      stateFile: path.join(dir, 'installed.json'),
      historyFile: path.join(dir, 'history.json'),
      probe: async () => verdict,
      clone: () => {
        throw new Error('a refused target must not be cloned')
      },
      log: () => {}
    })
    const withCompat = await installer.preflight({ source: 'acme/target', branch: 'dev', compat: true })
    assert.equal(withCompat.ok, true, 'an adoptable package is not a refusal in compatibility mode')
    assert.equal(withCompat.compat.kind, 'dsh-bundle')

    const withoutCompat = await installer.preflight({ source: 'acme/target', branch: 'dev', compat: false })
    assert.equal(withoutCompat.ok, false)
    assert.match(withoutCompat.reason, /could be installed in compatibility mode \(dsh-bundle\), which is switched off/)

    // Nothing to adopt at all is still refused, with the reason the store gave.
    const nothing = createStoreInstaller({
      root: dir,
      storeDir: path.join(dir, 'store2'),
      stateFile: path.join(dir, 'installed2.json'),
      historyFile: path.join(dir, 'history2.json'),
      probe: async () => ({ ...verdict, compat: { possible: false, probed: true, reason: 'there is no package.json either' } }),
      log: () => {}
    })
    const refused = await nothing.preflight({ source: 'acme/plain', compat: true })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /nothing was downloaded/)
  } finally {
    dispose()
  }
})

test('the dependency and build commands are described in full, and refuse anything unsafe', () => {
  const { dir, dispose } = scratch()
  try {
    const root = packageDir(dir, { name: 'deps', entrySource: 'export const apply = () => {}\n', entryPath: 'index.js', main: 'index.js' })

    const install = deps.describeInstall({ dir: root, packages: ['schemastery', '@acme/thing'] })
    assert.equal(install.ok, true)
    assert.deepEqual(install.command, ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', 'schemastery', '@acme/thing'])
    assert.equal(install.scripts, false, 'lifecycle scripts must be off by default')
    assert.match(install.note, /disabled/)
    assert.equal(install.cwd, root)

    // A name that could be read as a flag, a path or a shell fragment is refused, not escaped.
    for (const bad of ['--force', 'a; rm -rf /', '../evil', 'a b']) {
      const rejected = deps.describeInstall({ dir: root, packages: [bad] })
      assert.equal(rejected.ok, false, `${bad} was accepted as a package name`)
      assert.equal(rejected.code, deps.DEP_REASONS.BAD_PACKAGE)
    }
    assert.equal(deps.describeInstall({ dir: root, packages: [] }).code, deps.DEP_REASONS.NO_PACKAGES)
    assert.equal(deps.describeInstall({ dir: path.join(dir, 'ghost'), packages: ['x'] }).code, deps.DEP_REASONS.BAD_DIRECTORY)

    // The build needs the toolchain, so its install enables scripts —and says so.
    const full = deps.describeFullInstall({ dir: root })
    assert.equal(full.ok, true)
    assert.equal(full.scripts, true)
    assert.match(full.display, /^npm install/)
    const build = deps.describeBuild({ dir: root, script: 'tsc -b && tsdown' })
    assert.deepEqual(build.command, ['npm', 'run', 'tsc -b && tsdown'], 'the script name must be one argv entry, never a shell line')
    assert.equal(deps.describeBuild({ dir: root }).ok, false)

    // pnpm is detected from the lockfile beside the package.
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
    assert.equal(deps.managerFor(root), 'pnpm')
    assert.deepEqual(deps.describeInstall({ dir: root, packages: ['clsx'] }).command.slice(0, 2), ['pnpm', 'add'])
  } finally {
    dispose()
  }
})

test('nothing is run without a confirmation, and a confirmed command really runs', () => {
  const { dir, dispose } = scratch()
  try {
    const marker = path.join(dir, 'ran.txt')
    const node = process.execPath
    const plan = {
      ok: true,
      action: 'install',
      manager: 'npm',
      command: [node, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
      display: 'node -e …',
      cwd: dir,
      packages: ['x'],
      scripts: false,
      note: 'test'
    }
    // Without the confirmation the command must not run at all —this is the rule, not a comment.
    const unconfirmed = deps.runDescribed(plan, {})
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.code, deps.DEP_REASONS.NOT_CONFIRMED)
    assert.equal(fs.existsSync(marker), false, 'a command ran without a confirmation')

    const confirmed = deps.runDescribed(plan, { confirm: true })
    assert.equal(confirmed.ok, true, confirmed.stderr)
    assert.equal(fs.existsSync(marker), true, 'a confirmed command did not run')

    // A failing command is reported with its exit code, never thrown.
    const failing = deps.runDescribed({ ...plan, command: [node, '-e', 'process.exit(3)'], display: 'node -e exit(3)' }, { confirm: true })
    assert.equal(failing.ok, false)
    assert.equal(failing.code, deps.DEP_REASONS.RUN_FAILED)
    assert.match(failing.reason, /exited with 3/)
  } finally {
    dispose()
  }
})

/**
 * The isolated activation, with a real child process.
 *
 * These are the tests that cannot be faked: whether an ES module loads at all, whether a Cordis
 * `apply` is called, whether a crash stays in the child, and whether the report survives the trip
 * back. `nodeExe` is this test's own node, so the worker is the real worker.
 */
function compatHarness(entrySource, options = {}) {
  const { dir, dispose } = scratch()
  const root = path.join(dir, 'plugin')
  fs.mkdirSync(root, { recursive: true })
  writeJson(path.join(root, 'package.json'), { name: options.packageName || '@acme/plug', version: '1.0.0', type: 'module', main: 'index.js' })
  fs.writeFileSync(path.join(root, 'index.js'), entrySource, 'utf8')
  const classified = classifyCompatible(root, { repo: 'acme/plug' })
  assert.equal(classified.ok, true, classified.reason)
  const plugin = createCompatPlugin({
    descriptor: classified.descriptor,
    dir: root,
    nodeExe: process.execPath,
    log: () => {},
    timeoutMs: options.timeoutMs || 15_000
  })
  return {
    plugin,
    root,
    dir,
    descriptor: classified.descriptor,
    // A live isolated process has to be stopped before its directory can be removed on Windows.
    dispose: async () => {
      try {
        await plugin.unload()
      } catch {}
      dispose()
    }
  }
}

test('a Cordis-style ES module plugin is activated in its own process', async () => {
  const harnessed = compatHarness(`
export const inject = ['thing']
export const apply = (ctx) => {
  ctx.log('pet plugin online')
  ctx.provide('pet-registry', { pets: 3 })
  ctx.effect(() => () => {})
  setInterval(() => {}, 1000)
}
`)
  try {
    const outcome = await harnessed.plugin.load({ config: { name: 'whale' } })
    assert.equal(outcome.ok, true, outcome.reason)
    assert.equal(outcome.api, 'apply')
    assert.deepEqual(outcome.provided, [{ name: 'pet-registry', kind: 'object' }])
    assert.deepEqual(outcome.logs, ['pet plugin online'])
    const state = harnessed.plugin.compatibilityState()
    assert.equal(state.status, 'running')
    assert.equal(state.running, true)
    assert.equal(typeof state.pid, 'number')
    // The process is not this one: that is the whole containment claim.
    assert.notEqual(state.pid, process.pid)
    const health = await harnessed.plugin.healthCheck()
    assert.equal(health.status, 'healthy')
    await harnessed.plugin.unload()
    assert.equal(harnessed.plugin.compatibilityState().running, false)
  } finally {
    await harnessed.dispose()
  }
})

test('a plugin that registers nothing is reported as finished, not as running or as broken', async () => {
  const harnessed = compatHarness('export const apply = (ctx) => { ctx.log("done") }\n')
  try {
    const outcome = await harnessed.plugin.load({})
    assert.equal(outcome.ok, true, outcome.reason)
    // The child had nothing keeping it alive, so it ends; the host notices and says so rather than
    // claiming a process that is gone.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const state = harnessed.plugin.compatibilityState()
    assert.equal(state.exit && state.exit.code, 0)
    assert.equal(state.status, 'exited')
    assert.equal(state.running, false)
    const health = await harnessed.plugin.healthCheck()
    assert.equal(health.status, 'degraded')
    assert.match(health.reason, /exited cleanly/)
  } finally {
    await harnessed.dispose()
  }
})

test('a missing dependency is reported as the package name, which is what an install can fix', async () => {
  const harnessed = compatHarness("import 'dshns-nonexistent-package-for-tests'\nexport const apply = () => {}\n")
  try {
    await assert.rejects(() => harnessed.plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.MISSING_DEPENDENCIES)
      return true
    })
    const state = harnessed.plugin.compatibilityState()
    assert.deepEqual(state.missing, ['dshns-nonexistent-package-for-tests'])
    assert.equal(state.status, 'needs-dependencies')
    assert.match(state.reason, /dshns-nonexistent-package-for-tests is not installed/)
  } finally {
    await harnessed.dispose()
  }
})

test('an unsupported export shape and a throwing plugin are distinguished, not merged', async () => {
  const unsupported = compatHarness('export const notAPlugin = 1\nexport default { something: true }\n')
  try {
    await assert.rejects(() => unsupported.plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.UNSUPPORTED_API)
      return true
    })
    assert.equal(unsupported.plugin.compatibilityState().status, 'failed')
  } finally {
    await unsupported.dispose()
  }

  const throwing = compatHarness('export const apply = () => { throw new Error("this plugin is broken") }\n')
  try {
    await assert.rejects(() => throwing.plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.ACTIVATION_FAILED)
      assert.match(error.message, /this plugin is broken/)
      return true
    })
  } finally {
    await throwing.dispose()
  }
})

test('a plugin that kills its own process, or hangs, is contained', async () => {
  // `process.exit` in a foreign plugin is the worst case for loading it in the shell: this test is
  // the reason it is not loaded in the shell.
  const suicidal = compatHarness('export const apply = () => { process.exit(7) }\n')
  try {
    await assert.rejects(() => suicidal.plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.EXITED)
      assert.match(error.message, /exited before reporting \(code 7\)/)
      return true
    })
    // This test is still running, which is the containment claim.
    assert.equal(process.exitCode === 7, false)
  } finally {
    await suicidal.dispose()
  }

  const hanging = compatHarness(
    // The timer is what keeps the child alive: without it the process would simply end, which is a
    // different (also handled) outcome than a hang.
    'export const apply = async () => { setInterval(() => {}, 1000); await new Promise(() => {}) }\n',
    { timeoutMs: 700 }
  )
  try {
    const started = Date.now()
    await assert.rejects(() => hanging.plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.ACTIVATION_TIMEOUT)
      return true
    })
    // Bounded: the wait ended because the timeout did, and the child was killed.
    assert.equal(Date.now() - started < 8000, true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(hanging.plugin.process, null)
  } finally {
    await hanging.dispose()
  }
})

test('a plugin whose declared entry is not in the repository needs a build, not a load', async () => {
  const harnessed = compatHarness('export const apply = () => {}\n')
  try {
    // The descriptor is the real shape of the live target: `main` is `lib/index.js`, the repository
    // ships `src/index.ts`, and the package has a build script.
    const descriptor = {
      ...harnessed.descriptor,
      entry: 'lib/index.js',
      entry_declared: 'lib/index.js',
      entry_exists: false,
      build: 'tsdown',
      state: 'needs-build',
      state_reason: 'the declared entry lib/index.js is not in the repository; the package builds it with `tsdown`'
    }
    const plugin = createCompatPlugin({ descriptor, dir: harnessed.root, nodeExe: process.execPath, log: () => {} })
    await assert.rejects(() => plugin.load({}), (error) => {
      assert.equal(error.code, COMPAT_LOAD_REASONS.ENTRY_MISSING)
      return true
    })
    const state = plugin.compatibilityState()
    assert.equal(state.status, 'needs-build')
    assert.equal(state.build, 'tsdown')
    assert.match(state.reason, /builds it with `tsdown`/)
  } finally {
    await harnessed.dispose()
  }
})

test('the host mounts an adopted plugin, reports its state, and keeps it out of the lock', async () => {
  const { dir, dispose } = scratch()
  try {
    const root = path.join(dir, 'scratch-root')
    const store = path.join(root, 'data', 'plugins', 'store', 'acme_plug')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'package.json'), JSON.stringify({ name: '@acme/plug', version: '2.0.0', type: 'module', main: 'index.js' }), 'utf8')
    fs.writeFileSync(path.join(store, 'index.js'), 'export const apply = (ctx) => { setInterval(() => {}, 1000) }\n', 'utf8')
    const classified = classifyCompatible(store, { repo: 'acme/plug', branch: 'main' })
    assert.equal(classified.ok, true, classified.reason)
    fs.writeFileSync(path.join(store, COMPAT_FILE), `${JSON.stringify(classified.descriptor, null, 2)}\n`, 'utf8')
    writeJson(path.join(root, 'data', 'plugins', 'installed.json'), {
      version: 1,
      plugins: [
        {
          id: classified.descriptor.id,
          dir: store,
          repo: 'acme/plug',
          branch: 'main',
          compatibility: 'compat',
          version: '2.0.0',
          main: 'index.js',
          name: '@acme/plug',
          enabled: true,
          enabledAt: 1
        }
      ]
    })

    const host = createPluginHost({ root, log: () => {}, nodeExe: process.execPath })
    try {
      const built = await host.ensure()
      assert.equal(built.ok, true, built.error)
      const listed = host.list().plugins.find((plugin) => plugin.id === classified.descriptor.id)
      assert.ok(listed, 'the adopted plugin is not in the list')
      assert.equal(listed.compatibility, 'compat')
      assert.equal(listed.compat.kind, 'package')
      assert.equal(listed.compat.status, 'running')
      assert.equal(listed.loaded, true)
      assert.equal(Array.isArray(listed.guarantees.cn), true)
      // The guarantees are the point of the mode: an adopted plugin provides nothing.
      assert.deepEqual(listed.provides, [])
      const status = host.status()
      assert.equal(status.compat.total, 1)
      assert.equal(status.compat.running, 1)
      // It is the user's install, so the product's lock does not describe it.
      const lock = host.lockfile({})
      assert.equal(lock.fromStore, 1)
      assert.equal(lock.state.ok, true, lock.state.reason)
      // And the setup flow describes commands rather than running them.
      const setup = host.compatSetup({ id: classified.descriptor.id })
      assert.equal(setup.ok, true)
      assert.deepEqual(setup.plans, [], 'a ready plugin needs no install')
      assert.match(setup.note, /nothing is installed or built until these commands are confirmed/)
      const refused = host.compatApplySetups({ id: classified.descriptor.id })
      assert.equal(refused.ok, true, 'nothing to run is not a failure')
      const unconfirmed = host.compatApplySetups({ id: classified.descriptor.id, confirm: false })
      assert.equal(unconfirmed.ok, true)
      // A plugin that is not compat is refused by the compat surface.
      assert.equal(host.compatSetup({ id: 'dshns.telemetry' }).code, 'PLUGIN_NOT_COMPAT')

      // A refresh re-reads the installed set. An entry that is still enabled is re-mounted — and
      // one that is switched off unmounts *and* stops its isolated process, which is the hot-reload
      // path this whole mode has to fit into.
      const again = await host.refreshInstalled('test refresh')
      assert.equal(again.rebuilt, true)
      assert.equal(host.status().compat.total, 1, 'an enabled entry must be re-mounted by a refresh')

      const stateFile = path.join(root, 'data', 'plugins', 'installed.json')
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      state.plugins = state.plugins.map((entry) => ({ ...entry, enabled: false }))
      fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      const disabled = await host.refreshInstalled('test disable')
      assert.equal(disabled.removed.includes(classified.descriptor.id), true, 'the disabled compat plugin was not reported as removed')
      assert.equal(host.status().compat.total, 0, 'a disabled compat plugin is still in the compat registry')
    } finally {
      await host.dispose('test teardown')
    }
  } finally {
    dispose()
  }
})

test('the compatibility flow is wired end to end: store, shell dialog, bridge and panels', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8')
  const index = read('app/extensions/mega/index.cjs')
  const main = read('app/desktop-main.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const installer = read('app/extensions/mega/store/installer.cjs')
  const store = read('app/extensions/mega/store/github-store.cjs')

  // The store preference is user state, and it reaches both the stage path and the queue.
  assert.match(index, /'mega:store-compat', 'mega:store-compat-set'/)
  assert.match(index, /data', 'state', 'plugin-store\.json'/)
  assert.match(index, /const compat = typeof payload\.compat === 'boolean' \? payload\.compat : storePreference\(\)\.compat[\s\S]{0,400}installer\(\)\.preflight\(\{ source: payload\.source \|\| payload\.repo, branch: payload\.branch, compat \}\)/)
  assert.match(index, /runQueue\(\{ replace: payload\.replace === true, compat \}\)/)
  // The probe is told the package path: a monorepo package's manifest is not the repository's.
  assert.match(index, /probe: \(input\) => store\(\)\.inspect\(\{ id: input\.repo, branch: input\.branch, path: input\.path, compat: input\.compat \}\)/)
  assert.match(store, /function packageUrlFor\(/)
  assert.match(store, /it can be adopted in compatibility mode/)

  // The shell owns the confirmation, and the dialog is what stands between the panel and a command.
  assert.match(main, /'plugins:compat-setup'/)
  assert.match(main, /'plugins:compat-apply'/)
  assert.match(main, /dialog\.showMessageBox\(mainWindow, \{[\s\S]{0,900}compatibility-mode plugin needs a step/)
  assert.match(main, /if \(answer\.response !== 1\) \{[\s\S]{0,200}COMPAT_DECLINED/)
  assert.match(main, /host\(\)\.compatApplySetups\(\{ id, confirm: true \}\)/, 'the shell must pass the confirmation it obtained')
  assert.match(main, /nodeExe: safeNodeExe\(\)/, 'the isolated worker has no node binary to run with')
  // Nothing in the store or the installer may run an installer on its own.
  assert.equal(/spawnSync\(['"](npm|pnpm|yarn)['"]/.test(installer), false, 'the installer runs a package manager by itself')
  assert.equal(/runDescribed\(plan, \{ confirm: true/.test(read('app/core/plugin-compat/index.cjs')), false, 'the adapter runs commands')

  // The renderer's side.
  assert.match(preload, /compat: \(\) => ipcRenderer\.invoke\('mega:store-compat'\)/)
  assert.match(preload, /setCompat: \(enabled\) => ipcRenderer\.invoke\('mega:store-compat-set'/)
  assert.match(preload, /compatSetup: \(input\) => ipcRenderer\.invoke\('plugins:compat-setup', input\)/)
  assert.match(preload, /applyCompatSetup: \(input\) => ipcRenderer\.invoke\('plugins:compat-apply', input\)/)

  // The UI: a switch where the decision is made, a badge where the reduced guarantee applies, and a
  // button that only asks. Every one of them names the bridge call it makes.
  const featureManager = read('app/extensions/mega/ui/feature-manager.js')
  const pluginPanel = read('app/extensions/mega/ui/plugin-panel.js')
  const css = read('app/extensions/mega/ui/dock.css')

  assert.match(featureManager, /function compatRow\(\)/, 'the store has no compatibility switch')
  assert.match(featureManager, /window\.megaTools\?\.store\?\.setCompat\?\.\(enabled === true\)/, 'the switch does not reach the shell')
  assert.match(featureManager, /兼容模式 · Compatibility mode/, 'the switch does not say what it costs')
  assert.match(featureManager, /body\.appendChild\(compatRow\(\)\)/, 'the switch is not rendered in the store tab')
  assert.match(featureManager, /result\.compat && result\.compat\.possible[\s\S]{0,600}兼容模式 · compat/, 'an adoptable repository is shown as not installable')
  assert.match(featureManager, /source: result\.source \|\| result\.repo \|\| result\.id/, 'the stage request loses the package path')
  assert.match(featureManager, /needs-dependencies', 'needs-build'\][\s\S]{0,200}Install & build/, 'an adopted plugin that needs a step offers no way to take it')
  assert.match(featureManager, /window\.megaPlugins\?\.applyCompatSetup\?\.\(\{ id \}\)/, 'the setup button does not reach the shell')
  assert.match(featureManager, /plugin\.compatibility === 'compat'[\s\S]{0,300}compatState/, 'the installed row does not say what an adopted plugin is')
  assert.match(pluginPanel, /plugin\.compatibility === 'compat'[\s\S]{0,300}bi\('兼容模式', `compat \$\{status\}`\)/, 'the platform panel does not label an adopted plugin')
  assert.match(pluginPanel, /bi\('兼容模式不保证', 'not guaranteed'\)/, 'the platform panel never states the reduced guarantees')
  assert.match(pluginPanel, /function runCompatSetup\(id\)/, 'the platform panel cannot offer the step either')
  assert.match(css, /\.pm-compat\{/, 'the compatibility switch is unstyled')
  assert.match(css, /\.pm-badge\.warn\{/, 'the compatibility badge is unstyled')
})
