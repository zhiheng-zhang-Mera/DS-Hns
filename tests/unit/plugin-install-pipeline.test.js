'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createNativeHnsAdapter } = require('../../app/core/plugin-adapters/adapters/native-hns.cjs')
const { createCordisAdapter } = require('../../app/core/plugin-adapters/adapters/cordis.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createInstallPipeline, VERDICTS, normalizeSource } = require('../../app/core/plugin-install/pipeline.cjs')
const { createInstallRecords, RECORD_STATES } = require('../../app/core/plugin-install/records.cjs')
const { assessRisk, degradationFor, buildPlan, summarize, RISK_LEVELS } = require('../../app/core/plugin-install/plan.cjs')

/**
 * The unified install pipeline.
 *
 * Two things are being pinned, and the second is the one that matters:
 *
 *   * the *plan* is derived from the same analysis the install uses, so what a person is shown is
 *     what happens;
 *   * **nothing executes because it was downloaded.** A plugin object is produced by an adapter or
 *     it does not exist, so an unrecognised format is refused by construction rather than by a
 *     check this module has to remember.
 *
 * The real GitHub fetch and the three-plugin end-to-end run live in
 * `scripts/install-pipeline-acceptance.cjs`; this suite is self-contained so it runs anywhere.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-install-'))
  return {
    dir,
    write(relative, content) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content, 'utf8')
      return file
    },
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

/** A directory that is a runnable native plugin: a declaration plus the entry it names. */
function nativePlugin(area, name, overrides = {}) {
  const relative = overrides.relative || name
  area.write(`${relative}/dshns-plugin.json`, `${JSON.stringify({
    api_version: 'dshns.plugin/v1',
    id: name,
    name,
    version: overrides.version || '1.0.0',
    main: 'index.cjs',
    permissions: { declares: overrides.declares || [] }
  }, null, 2)}\n`)
  area.write(`${relative}/index.cjs`, overrides.source || `
module.exports = {
  manifest: {
    api_version: 'dshns.plugin/v1',
    id: '${name}',
    name: '${name}',
    version: '${overrides.version || '1.0.0'}',
    provides: ${JSON.stringify(overrides.provides || [])},
    permissions: { declares: ${JSON.stringify(overrides.declares || [])} },
    default_enabled: false
  },
  load() { return { ok: true } },
  unload() { return { ok: true } },
  healthCheck() { return { status: 'healthy', reason: 'the test plugin is up' } }
}
`)
  return area.path(relative)
}

/** A pipeline over a real framework and manager, with an injectable fetch. */
function rig(area, options = {}) {
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeHnsAdapter())
  framework.register(createCordisAdapter({ nodeExe: process.execPath, log: () => {} }))
  const manager = createPluginManager({ log: () => {} })
  const pipeline = createInstallPipeline({
    framework,
    manager,
    storeDir: area.path('store'),
    recordsFile: area.path('records.json'),
    materialise: options.materialise,
    log: () => {}
  })
  return { framework, manager, pipeline }
}

test('a source is normalised from every shape a user can type', () => {
  assert.deepEqual(normalizeSource('acme/plugin'), { kind: 'github', repo: 'acme/plugin', path: null, spec: 'acme/plugin' })
  assert.deepEqual(normalizeSource('acme/mono#packages/thing'), { kind: 'github', repo: 'acme/mono', path: 'packages/thing', spec: 'acme/mono#packages/thing' })
  assert.deepEqual(normalizeSource('https://github.com/acme/plugin.git'), { kind: 'github', repo: 'acme/plugin', path: null, spec: 'https://github.com/acme/plugin.git' })
  // Anything absolute is a local directory, and so is anything that is not a two-part spec.
  assert.equal(normalizeSource('C:/plugins/thing').kind, 'local')
  assert.equal(normalizeSource(process.cwd()).kind, 'local')
  assert.deepEqual(normalizeSource({ repo: 'acme/plugin', path: 'sub' }), { kind: 'github', repo: 'acme/plugin', path: 'sub', branch: null, spec: 'acme/plugin' })
  assert.equal(normalizeSource(''), null)
  assert.equal(normalizeSource(null), null)
})

test('risk is assessed from reach, not from guesswork', () => {
  const low = assessRisk({
    manifest: { runtime: { kind: 'declarative', enforcement: 'declared-only' }, permissions: { granted: [], refused: [] } }
  })
  assert.equal(low.level, RISK_LEVELS.LOW)
  assert.equal(low.score, 0)

  const high = assessRisk({
    manifest: {
      runtime: { kind: 'in-process', enforcement: 'advisory' },
      permissions: { granted: ['process.spawn', 'fs.write', 'network'], refused: [] }
    }
  })
  assert.equal(high.level, RISK_LEVELS.HIGH)
  assert.ok(high.factors.some((factor) => factor.factor === 'permission' && factor.value === 'process.spawn'))
  assert.ok(high.factors.some((factor) => factor.factor === 'runtime'))

  // A refused permission is a lowering fact, not risk: it is shown, with weight zero.
  const refused = assessRisk({
    manifest: {
      runtime: { kind: 'isolated-process' },
      permissions: { granted: ['fs.read'], refused: [{ permission: 'network', reason: 'policy denies it' }] }
    }
  })
  const refusal = refused.factors.find((factor) => factor.factor === 'refused')
  assert.equal(refusal.weight, 0)
  assert.match(refusal.detail, /policy denies/)

  // A fatal fault level is the one thing that is scored as being about the *task*, not the host.
  const fatal = assessRisk({ manifest: { runtime: { kind: 'declarative' }, permissions: { granted: [] }, fault_level: 'fatal' } })
  assert.ok(fatal.factors.some((factor) => factor.factor === 'fault-level'))
  assert.equal(fatal.level, RISK_LEVELS.MEDIUM)
})

test('degradation is stated in the platform\'s own vocabulary', () => {
  const notes = degradationFor({
    manifest: {
      provides: ['restart-control'],
      permissions: { refused: [{ permission: 'network', reason: 'the deployment policy denies it' }] }
    },
    stats: { hasClientHalf: true, missingPeers: ['left-pad'] }
  })
  const kinds = notes.map((entry) => entry.of).sort()
  assert.deepEqual(kinds, ['capability', 'client-half', 'peer', 'permission'])
  // The capability note is the vocabulary's own fallback, not a sentence invented here.
  const capability = notes.find((entry) => entry.of === 'capability')
  assert.match(capability.detail, /unavailable/)
  // And a plugin with nothing to declare says so rather than producing an empty list.
  assert.equal(degradationFor({ manifest: {} })[0].of, 'none')
})

test('the plan carries every field a person needs, and summarises in one line', () => {
  const plan = buildPlan({
    manifest: {
      id: 'acme.thing',
      name: 'Thing',
      version: '2.0.0',
      provides: ['health-pressure'],
      runtime: { kind: 'isolated-process', enforcement: 'process-boundary', isolation: 'process', entry: 'lib/index.js' },
      permissions: { declared: ['network'], granted: ['network'], refused: [], unknown: [] }
    },
    adapter: { id: 'dshns.cordis-dsh', version: '1.0.0' },
    detectedType: 'cordis.bundle',
    confidence: 0.9,
    evidence: ['package.json#dsh.bundle.patch'],
    source: 'acme/thing',
    provenance: { kind: 'github', repo: 'acme/thing' },
    stats: { hasClientHalf: true }
  })
  assert.equal(plan.adapter.id, 'dshns.cordis-dsh')
  assert.equal(plan.adapter.detectedType, 'cordis.bundle')
  assert.equal(plan.runtime.kind, 'isolated-process')
  assert.deepEqual(plan.permissions.granted, ['network'])
  assert.ok(plan.risk.level)
  assert.ok(plan.degradation.length)
  assert.equal(plan.verdict, VERDICTS.INSTALL)
  assert.match(summarize(plan), /acme\.thing v2\.0\.0 via dshns\.cordis-dsh/)
})

test('a native plugin installs from a directory, and the plan matches what happens', async () => {
  const area = scratch()
  const r = rig(area)
  try {
    const dir = nativePlugin(area, 'acme.native', { provides: ['health-pressure'] })
    const planned = await r.pipeline.plan(dir)
    assert.equal(planned.ok, true, planned.reason)
    const plan = planned.plan
    assert.equal(plan.adapter.id, 'dshns.native')
    assert.equal(plan.adapter.detectedType, 'dshns.declared')
    assert.equal(plan.runtime.kind, 'in-process')
    assert.equal(plan.verdict, VERDICTS.INSTALL)

    const installed = await r.pipeline.install(dir, { plan, adapterOutput: planned.adapterOutput, dir: planned.dir, confirm: true })
    assert.equal(installed.ok, true, installed.reason)
    // The plan's id and version are the record's, which are the manager's.
    assert.equal(installed.record.id, plan.id)
    assert.equal(installed.record.version, plan.version)
    assert.equal(r.manager.has(plan.id), true)
    assert.equal(r.manager.entry(plan.id).enabled, false, 'an installed plugin is not enabled for the user')

    const listed = r.pipeline.list().find((entry) => entry.id === plan.id)
    assert.equal(listed.live.installed, true)
    assert.equal(listed.live.loaded, false)
    assert.equal(listed.adapter.id, 'dshns.native')
    assert.equal(listed.source, dir)
  } finally {
    area.dispose()
  }
})

test('an unrecognised format is refused, and no plugin object exists to install', async () => {
  const area = scratch()
  const r = rig(area)
  try {
    area.write('stranger/README.md', '# just files\n')
    const planned = await r.pipeline.plan(area.path('stranger'))
    assert.equal(planned.ok, true, planned.reason)
    assert.equal(planned.plan.verdict, VERDICTS.REFUSE)
    assert.equal(planned.code, 'INSTALL_UNDETECTED')
    assert.equal(planned.adapterOutput, null, 'a refusal must not produce a plugin object')

    // And the install refuses even when the caller insists.
    const blocked = await r.pipeline.install(area.path('stranger'), { confirm: true })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'INSTALL_UNDETECTED')
    assert.equal(r.manager.list().length, 0, 'nothing may reach the manager')

    // A missing directory is a different refusal, named as such.
    const missing = await r.pipeline.plan(area.path('nowhere'))
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'INSTALL_NO_SUCH_SOURCE')
  } finally {
    area.dispose()
  }
})

test('a remote source with no way to fetch it is refused rather than half-installed', async () => {
  const area = scratch()
  const r = rig(area) // no materialiser
  try {
    const planned = await r.pipeline.plan('acme/remote')
    assert.equal(planned.ok, false)
    assert.equal(planned.code, 'INSTALL_MATERIALISE_FAILED')
    assert.equal(r.pipeline.describe().canFetch, false)
  } finally {
    area.dispose()
  }
})

test('a fetched directory installs through the same path as a local one', async () => {
  const area = scratch()
  const remote = nativePlugin(area, 'acme.fetched', { relative: 'remote-src' })
  const r = rig(area, {
    materialise: async (source, storeDir) => {
      // A materialiser fetches; it does not run anything. Copying stands in for a clone.
      const target = path.join(String(storeDir), 'acme_fetched')
      fs.mkdirSync(target, { recursive: true })
      for (const file of fs.readdirSync(remote)) fs.copyFileSync(path.join(remote, file), path.join(target, file))
      return { ok: true, dir: target }
    }
  })
  try {
    const planned = await r.pipeline.plan('acme/fetched')
    assert.equal(planned.ok, true, planned.reason)
    assert.equal(planned.fetched, true, 'the plan must report that it fetched')
    const installed = await r.pipeline.install('acme/fetched', { plan: planned.plan, adapterOutput: planned.adapterOutput, dir: planned.dir, confirm: true })
    assert.equal(installed.ok, true, installed.reason)
    const listed = r.pipeline.list().find((entry) => entry.id === 'acme.fetched')
    assert.equal(listed.provenance.kind, 'github')
    assert.equal(listed.source, 'acme/fetched')
  } finally {
    area.dispose()
  }
})

test('nothing installs without a confirmation, and re-installing replaces rather than duplicates', async () => {
  const area = scratch()
  const r = rig(area)
  try {
    const dir = nativePlugin(area, 'acme.twice')
    const unconfirmed = await r.pipeline.install(dir)
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.code, 'INSTALL_NOT_CONFIRMED')
    assert.equal(r.manager.list().length, 0)

    const first = await r.pipeline.install(dir, { confirm: true })
    assert.equal(first.ok, true, first.reason)
    const second = await r.pipeline.install(dir, { confirm: true })
    assert.equal(second.ok, true, second.reason)
    assert.equal(r.manager.list().filter((entry) => entry.id === 'acme.twice').length, 1, 'a re-install must not duplicate the row')
    // The record keeps one history across both.
    const record = r.pipeline.list().find((entry) => entry.id === 'acme.twice')
    assert.equal(record.versions.length, 1)
    assert.ok(record.history.length >= 2, `history: ${JSON.stringify(record.history)}`)
  } finally {
    area.dispose()
  }
})

test('pin, update, rollback, quarantine and uninstall each refuse when they should', async () => {
  const area = scratch()
  const r = rig(area)
  try {
    const dir = nativePlugin(area, 'acme.lifecycle', { version: '1.0.0' })
    assert.equal((await r.pipeline.install(dir, { confirm: true })).ok, true)

    // Pin
    assert.equal(r.pipeline.pin('acme.lifecycle').ok, true)
    const blockedUpdate = await r.pipeline.update('acme.lifecycle')
    assert.equal(blockedUpdate.ok, false)
    assert.equal(blockedUpdate.code, 'INSTALL_RECORD_PINNED')
    // Pinning a version that is not the installed one is a move, not a pin, and says so.
    assert.equal(r.pipeline.pin('acme.lifecycle', '2.0.0').ok, false)
    assert.equal(r.pipeline.unpin('acme.lifecycle').ok, true)

    // Update: same version is a no-op, and it says so rather than reinstalling.
    const unchanged = await r.pipeline.update('acme.lifecycle')
    assert.equal(unchanged.ok, true)
    assert.equal(unchanged.unchanged, true)

    // Rollback: refused while only one version has ever been installed.
    const noRollback = await r.pipeline.rollback('acme.lifecycle')
    assert.equal(noRollback.ok, false)
    assert.equal(noRollback.code, 'INSTALL_NO_ROLLBACK')

    // Quarantine: unloads, blocks a re-install, and is reversible.
    r.manager.enable('acme.lifecycle')
    assert.equal((await r.manager.load('acme.lifecycle')).ok, true)
    const quarantined = await r.pipeline.quarantine('acme.lifecycle', 'test fault')
    assert.equal(quarantined.ok, true)
    assert.equal(r.manager.entry('acme.lifecycle').loaded, false, 'quarantine must unload')
    const blockedInstall = await r.pipeline.install(dir, { confirm: true })
    assert.equal(blockedInstall.ok, false)
    assert.equal(blockedInstall.code, 'INSTALL_RECORD_QUARANTINED')
    assert.equal((await r.pipeline.release('acme.lifecycle')).ok, true)
    assert.equal((await r.pipeline.install(dir, { confirm: true })).ok, true)

    // Uninstall: gone from the manager, gone from the records, files kept.
    const removed = await r.pipeline.uninstall('acme.lifecycle')
    assert.equal(removed.ok, true)
    assert.equal(r.manager.has('acme.lifecycle'), false)
    assert.equal(r.pipeline.list().some((entry) => entry.id === 'acme.lifecycle'), false)
    assert.equal(removed.filesKept, dir, 'the files stay so a reinstall is not a re-download')
  } finally {
    area.dispose()
  }
})

test('the record store keeps a bounded history and survives a reload', () => {
  const area = scratch()
  try {
    const file = area.path('records.json')
    const first = createInstallRecords({ file })
    first.upsert({ id: 'acme.one', name: 'One', version: '1.0.0' })
    first.upsert({ id: 'acme.one', version: '1.1.0' })
    first.upsert({ id: 'acme.one', version: '1.2.0' })
    assert.deepEqual(first.get('acme.one').versions, ['1.0.0', '1.1.0', '1.2.0'])
    assert.equal(first.rollbackTarget('acme.one').to, '1.1.0', 'the previous version is the newest that is not installed')

    // A fresh store over the same file sees the same records.
    const second = createInstallRecords({ file })
    assert.equal(second.count(), 1)
    assert.equal(second.get('acme.one').version, '1.2.0')
    assert.equal(second.get('acme.one').versions.length, 3)

    // Quarantine is a state, and release restores the previous one with the reason kept.
    second.quarantine('acme.one', 'flapping')
    assert.equal(second.get('acme.one').state, RECORD_STATES.QUARANTINED)
    assert.equal(second.get('acme.one').quarantine.reason, 'flapping')
    const released = second.release('acme.one')
    assert.match(released.released.reason, /flapping/)
    assert.equal(second.get('acme.one').state, RECORD_STATES.INSTALLED)

    // An unwritable file is reported, never thrown: losing the record is bad, losing the install
    // because the record could not be written is worse.
    const broken = createInstallRecords({ file: path.join(area.dir, 'nope', '\u0000', 'records.json') })
    assert.equal(broken.upsert({ id: 'x', version: '1.0.0' }).id, 'x')
  } finally {
    area.dispose()
  }
})

test('the pipeline names no particular plugin, so the next one needs no Core change', () => {
  const sources = [
    fs.readFileSync(path.join(ROOT, 'app', 'core', 'plugin-install', 'pipeline.cjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'app', 'core', 'plugin-install', 'plan.cjs'), 'utf8')
  ].join('\n')
  for (const word of ['dsh-market', 'wallpaper', 'health-scheduler', 'dsh-restart', 'cordis-dsh']) {
    assert.equal(sources.includes(word), false, `the pipeline must not know about "${word}"`)
  }
})
