'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  analyzeCordisPlugin,
  auditPeers,
  patchRowsFor,
  injectFrom,
  insidePackage,
  PLUGIN_SHAPES,
  STRUCTURE_MARKERS
} = require('../../app/core/plugin-adapters/cordis-structure.cjs')

/**
 * Reading a community plugin's declarations.
 *
 * The adapter's whole claim is that it adapts plugins it has never seen, which is only true if it
 * reads *the convention* rather than a plugin. So these tests are about the convention's edges:
 * a patch file with comments and quoted names, an `inject` that a bundler moved to the bottom of
 * the file, a peer that is optional and one that is not, and a package that declares none of it.
 *
 * The last test runs against the two real community plugins this phase was accepted on, when they
 * are on disk. It is skipped rather than faked when they are not: a test that invented its own
 * "real" sample would prove nothing about the convention.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-structure-'))
  return {
    dir,
    write(relative, content) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8')
      return file
    },
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

/** A community plugin written the way the convention says, with the parts a test cares about. */
function communityPlugin(area, name, overrides = {}) {
  const relative = overrides.relative || String(name).replace(/[^a-z0-9]+/gi, '-')
  area.write(`${relative}/package.json`, {
    name,
    version: overrides.version || '1.2.3',
    type: 'module',
    main: overrides.main || 'lib/index.js',
    exports: overrides.exports || { '.': './lib/index.js', './client': './lib/client.js' },
    dsh: overrides.dsh === undefined
      ? { engines: { dsh: '>=0.1.5-rc.1' }, bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' } }
      : overrides.dsh,
    peerDependencies: overrides.peerDependencies || {},
    peerDependenciesMeta: overrides.peerDependenciesMeta || {}
  })
  if (overrides.patch !== null) {
    area.write(`${relative}/cordis.patch.yml`, overrides.patch === undefined
      ? ['# a bundle patch', '- insert:', `    - id: ${overrides.rowId || 'the-row'}`, `      name: '${name}'`, ''].join('\n')
      : overrides.patch)
  }
  if (overrides.entry !== null) {
    area.write(`${relative}/lib/index.js`, overrides.entry === undefined
      ? "export const inject = ['webServer']\nexport function apply(ctx) {}\n"
      : overrides.entry)
  }
  return area.path(relative)
}

test('the convention is read from all four places it is declared', () => {
  const area = scratch()
  try {
    const dir = communityPlugin(area, '@acme/dsh-widget', {
      rowId: 'widget-row',
      entry: "export const inject = { required: ['webServer'], optional: ['settings'] }\nexport function apply() {}\n"
    })
    const analysis = analyzeCordisPlugin(dir)
    assert.equal(analysis.ok, true, analysis.reason)
    const structure = analysis.structure

    assert.equal(structure.shape, PLUGIN_SHAPES.DSH_BUNDLE)
    assert.equal(structure.format, 'esm')
    assert.deepEqual(structure.bundle.rows, [{ id: 'widget-row', name: '@acme/dsh-widget', hasConfig: false }])
    assert.equal(structure.bundle.patch, './cordis.patch.yml')
    assert.equal(structure.bundle.exists, true)
    assert.equal(structure.client.declared, true)
    assert.deepEqual(structure.client.inject, ['@deepseek-ai/dsh-client-runtime'])
    assert.equal(structure.client.platform, 'web')
    assert.equal(structure.client.entry, 'lib/client.js')
    assert.equal(structure.engines.dsh, '>=0.1.5-rc.1')
    assert.deepEqual(structure.host.injectRequired, ['webServer'])
    assert.deepEqual(structure.host.injectOptional, ['settings'])
    assert.equal(structure.host.needsBridge, true)

    for (const marker of [STRUCTURE_MARKERS.BUNDLE_PATCH, STRUCTURE_MARKERS.CLIENT, STRUCTURE_MARKERS.PATCH_FILE, STRUCTURE_MARKERS.ENGINES_DSH]) {
      assert.ok(structure.markers.includes(marker), `${marker} was not reported`)
    }
  } finally {
    area.dispose()
  }
})

test('a patch file is read the way plugin authors actually write one', () => {
  const area = scratch()
  try {
    // Comments, a quoted name containing a slash, a config block, and two top-level entries.
    area.write('cordis.patch.yml', [
      '# wallpaper bundle patch.',
      '# a second comment line with an - id: that is not a row',
      '',
      '- insert:',
      '    - id: first-row',
      "      name: '@scope/pkg-one'",
      '      config:',
      '        enabled: true',
      '- insert:',
      '    - id: second-row',
      '      name: pkg-two   # trailing comment',
      ''
    ].join('\n'))
    const patch = patchRowsFor(area.dir, 'cordis.patch.yml')
    assert.equal(patch.exists, true)
    assert.deepEqual(patch.rows, [
      { id: 'first-row', name: '@scope/pkg-one', hasConfig: true },
      { id: 'second-row', name: 'pkg-two', hasConfig: false }
    ])

    // A file that is not there is reported as absent rather than as an empty patch.
    assert.equal(patchRowsFor(area.dir, 'nope.yml').exists, false)
  } finally {
    area.dispose()
  }
})

test('an inject a bundler moved to the bottom of the file is still read, and a local one is not', () => {
  const area = scratch()
  try {
    // The shape a real build produces: the binding near the end, the export list after it.
    area.write('bundled.js', [
      'function apply(ctx) {}',
      'const name = "ui-market";',
      'const inject = ["webServer"];',
      'const other = 1;',
      'export { apply, inject, name, other };',
      ''
    ].join('\n'))
    const bundled = injectFrom(area.path('bundled.js'))
    assert.equal(bundled.declared, true)
    assert.deepEqual(bundled.required, ['webServer'])

    // The direct spelling.
    area.write('direct.js', "export const inject = ['webServer', 'settings']\nexport function apply() {}\n")
    assert.deepEqual(injectFrom(area.path('direct.js')).required, ['webServer', 'settings'])

    // The object spelling, which is how a plugin says a dependency may be absent.
    area.write('optional.js', "export const inject = { required: ['webServer'], optional: ['slots'] }\n")
    const optional = injectFrom(area.path('optional.js'))
    assert.deepEqual(optional.required, ['webServer'])
    assert.deepEqual(optional.optional, ['slots'])

    // A local variable that happens to be called `inject` is not a declaration of anything: the
    // name has to actually be exported.
    area.write('local.js', 'const inject = ["webServer"];\nfunction apply() { return inject }\n')
    assert.equal(injectFrom(area.path('local.js')).declared, false)

    area.write('none.js', 'export function apply() {}\n')
    assert.equal(injectFrom(area.path('none.js')).declared, false)
    assert.equal(injectFrom(area.path('missing.js')).declared, false)
  } finally {
    area.dispose()
  }
})

test('a required peer and an optional peer are different facts', () => {
  const area = scratch()
  try {
    const dir = communityPlugin(area, '@acme/peers', {
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', 'left-pad': '^1.0.0', 'right-pad': '^2.0.0' },
      peerDependenciesMeta: { 'right-pad': { optional: true }, '@deepseek-ai/cordis': { optional: true } }
    })
    // One host root that provides exactly one of them.
    const root = path.join(area.dir, 'host-root')
    fs.mkdirSync(path.join(root, 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(root, 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0' }), 'utf8')

    const audit = auditPeers(dir, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), [root])
    // `right-pad` is marked optional in `peerDependenciesMeta`, so it is an optional peer however
    // it is spelled in `peerDependencies` — the meta block is what decides.
    assert.deepEqual(audit.required.map((peer) => peer.name), ['left-pad'])
    assert.deepEqual(audit.optional.map((peer) => peer.name).sort(), ['@deepseek-ai/cordis', 'right-pad'])
    // An optional peer that is absent is the plugin's own stated degradation, not a blocker.
    assert.deepEqual(audit.missing, [])
    assert.equal(audit.resolved['left-pad'].version, '1.3.0')
    assert.equal(audit.resolved['left-pad'].source, 'host')

    // A *required* peer nothing provides is a blocker, and it is named.
    const blocked = communityPlugin(area, '@acme/blocked', {
      relative: 'blocked',
      peerDependencies: { '@deepseek-ai/dsh-host-webserver': '>=0.1.0' }
    })
    const blockedAudit = auditPeers(blocked, JSON.parse(fs.readFileSync(path.join(blocked, 'package.json'), 'utf8')), [root])
    assert.deepEqual(blockedAudit.missing.map((peer) => peer.name), ['@deepseek-ai/dsh-host-webserver'])

    // The plugin's own copy wins over the host's: a plugin that vendors a dependency is entitled
    // to it.
    const local = communityPlugin(area, '@acme/local', {
      relative: 'local',
      peerDependencies: { 'left-pad': '^1.0.0' }
    })
    fs.mkdirSync(path.join(local, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(local, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '9.9.9' }), 'utf8')
    const localAudit = auditPeers(local, JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')), [root])
    assert.equal(localAudit.resolved['left-pad'].version, '9.9.9')
    assert.equal(localAudit.resolved['left-pad'].source, 'plugin')
  } finally {
    area.dispose()
  }
})

test('the shapes a package can have are told apart, and a non-plugin is refused', () => {
  const area = scratch()
  try {
    // A bundle: a patch layer and a host entry.
    assert.equal(analyzeCordisPlugin(communityPlugin(area, '@acme/bundle')).structure.shape, PLUGIN_SHAPES.DSH_BUNDLE)

    // A client-only extension: `dsh.client` and no patch anywhere.
    const clientOnly = communityPlugin(area, '@acme/client-only', {
      relative: 'client-only',
      dsh: { client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' } },
      patch: null
    })
    assert.equal(analyzeCordisPlugin(clientOnly).structure.shape, PLUGIN_SHAPES.DSH_CLIENT_ONLY)

    // A Cordis plugin without the DSH markers: recognised as Cordis, and not as a community bundle.
    const cordis = communityPlugin(area, '@acme/plain-cordis', {
      relative: 'plain-cordis',
      dsh: undefined,
      patch: null,
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      entry: 'export function apply() {}\n'
    })
    // `dsh: undefined` still writes the default block, so remove it explicitly for this shape.
    const manifest = JSON.parse(fs.readFileSync(path.join(cordis, 'package.json'), 'utf8'))
    delete manifest.dsh
    fs.writeFileSync(path.join(cordis, 'package.json'), JSON.stringify(manifest), 'utf8')
    assert.equal(analyzeCordisPlugin(cordis).structure.shape, PLUGIN_SHAPES.CORDIS_PLUGIN)

    // Nothing to read at all.
    fs.mkdirSync(area.path('empty'), { recursive: true })
    const missing = analyzeCordisPlugin(area.path('empty'))
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'CORDIS_NO_PACKAGE_JSON')
    assert.equal(analyzeCordisPlugin(area.path('nowhere')).code, 'CORDIS_NO_DIRECTORY')
  } finally {
    area.dispose()
  }
})

test('the client half is reported as a real half this host cannot serve', () => {
  const area = scratch()
  try {
    const dir = communityPlugin(area, '@acme/half', { relative: 'half' })
    const structure = analyzeCordisPlugin(dir).structure
    assert.equal(structure.client.declared, true)
    assert.equal(structure.client.servable, false)
    assert.match(structure.client.reason, /browser code for the web UI/)
    // A package with no client declaration says so rather than reporting an empty half.
    const hostOnly = communityPlugin(area, '@acme/host-only', {
      relative: 'host-only',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    })
    assert.equal(analyzeCordisPlugin(hostOnly).structure.client.declared, false)
  } finally {
    area.dispose()
  }
})

test('a package-relative path that could escape the package is not an entry', () => {
  assert.equal(insidePackage('C:/pkg', '../outside.js'), null)
  assert.equal(insidePackage('C:/pkg', 'C:/elsewhere.js'), null)
  assert.equal(insidePackage('C:/pkg', './lib/index.js'), 'lib/index.js')
  assert.equal(insidePackage('C:/pkg', null), null)
})

/**
 * The real plugins.
 *
 * They live outside this repository (they are clones of two public projects), so the test is
 * skipped when they are not on disk. That is deliberate: a substitute fixture would test the
 * fixture, not the convention.
 */
const SAMPLES = process.env.DSHNS_CORDIS_SAMPLES || 'D:/test-DSH/samples'
const REAL_SAMPLES = [
  {
    label: 'dsh-market',
    dir: path.join(SAMPLES, 'dsh-web', 'packages', 'dsh-market'),
    name: '@linxin666/dsh-client-ui-market',
    row: 'ui-market',
    clientInject: 3
  },
  {
    label: 'wallpaper-engine-dsh',
    dir: path.join(SAMPLES, 'wallpaper-engine-dsh'),
    name: 'wallpaper-engine-dsh',
    row: 'we-background',
    clientInject: 1
  }
]

for (const sample of REAL_SAMPLES) {
  const present = fs.existsSync(path.join(sample.dir, 'package.json'))
  test(`the real community plugin ${sample.label} is read correctly`, { skip: present ? false : `not on disk at ${sample.dir}` }, () => {
    const roots = (process.env.DSHNS_HOST_ROOTS || '').split(',').filter(Boolean)
    const analysis = analyzeCordisPlugin(sample.dir, { roots })
    assert.equal(analysis.ok, true, analysis.reason)
    const structure = analysis.structure

    assert.equal(structure.name, sample.name)
    assert.equal(structure.shape, PLUGIN_SHAPES.DSH_BUNDLE)
    assert.equal(structure.host.entryExists, true)
    assert.deepEqual(structure.bundle.rows.map((row) => row.id), [sample.row])
    assert.equal(structure.client.declared, true)
    assert.equal(structure.client.inject.length, sample.clientInject)
    assert.equal(structure.client.servable, false)
    // Both samples declare the service their host half cannot work without, which is exactly what
    // the bridge exists to mediate.
    assert.ok(structure.host.injectRequired.includes('webServer'), `inject was ${JSON.stringify(structure.host)}`)
    assert.equal(structure.host.needsBridge, true)
  })
}
