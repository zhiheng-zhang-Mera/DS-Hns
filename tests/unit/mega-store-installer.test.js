'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createStoreInstaller,
  normalizeRepo,
  directoryNameFor,
  INSTALL_REASONS,
  defaultClone
} = require('../../app/extensions/mega/store/installer.cjs')

/**
 * The two-stage store installer.
 *
 * Installing a plugin puts somebody else's code on this machine and then runs it, so the
 * interesting behaviour is always the boundary: staging must never load anything, enabling must
 * re-verify what is actually on disk, a failed clone must not leave a half-populated directory
 * behind that the next attempt treats as "already staged", and a manifest that changed after
 * staging must be refused rather than trusted.
 */
const MANIFEST = {
  api_version: 'dshns.plugin/v1',
  id: 'vendor.example-plugin',
  name: 'Example plugin',
  version: '1.0.0',
  provides: ['dshns.example'],
  fault_level: 'soft'
}

/** A clone that writes a plugin into the target directory, like a real one would. */
function fakeClone(behaviour = {}) {
  const calls = []
  return {
    calls,
    clone: (url, dir, options = {}) => {
      calls.push({ url, dir, branch: options.branch || null })
      if (behaviour.fail) return { ok: false, reason: behaviour.fail }
      fs.mkdirSync(dir, { recursive: true })
      const manifest = behaviour.manifest === undefined ? MANIFEST : behaviour.manifest
      if (manifest !== null) fs.writeFileSync(path.join(dir, 'dshns-plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2), 'utf8')
      const main = (behaviour.manifest === undefined ? MANIFEST : manifest || {}).main || 'index.cjs'
      if (behaviour.omitMain !== true) fs.writeFileSync(path.join(dir, main), "'use strict'\nmodule.exports = { manifest: { api_version: 'dshns.plugin/v1' } }\n", 'utf8')
      // A real clone brings its repository metadata with it.
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n', 'utf8')
      // The first attempt of a flaky network dies halfway; the next one works, which is what
      // "the retry must not be refused as already staged" needs to observe.
      if (behaviour.halfThenFail && calls.length === 1) {
        fs.rmSync(path.join(dir, 'dshns-plugin.json'), { force: true })
        return { ok: false, reason: 'connection reset' }
      }
      return { ok: true }
    }
  }
}

function harness(behaviour = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-store-'))
  const fake = fakeClone(behaviour)
  const installer = createStoreInstaller({
    root: dir,
    clone: fake.clone,
    probe: behaviour.probe,
    now: () => 1_700_000_000_000,
    log: () => {},
    storeDir: path.join(dir, 'data', 'plugins', 'store'),
    stateFile: path.join(dir, 'data', 'plugins', 'installed.json'),
    historyFile: path.join(dir, 'data', 'plugins', 'history.json')
  })
  return { installer, dir, fake, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a repository name is validated before anything is cloned', () => {
  assert.equal(normalizeRepo('acme/dshns-example'), 'acme/dshns-example')
  assert.equal(normalizeRepo('https://github.com/acme/dshns-example'), 'acme/dshns-example')
  assert.equal(normalizeRepo('https://github.com/acme/dshns-example.git'), 'acme/dshns-example')
  assert.equal(normalizeRepo('not-a-repo'), null)
  assert.equal(normalizeRepo('a/b/c'), null)
  assert.equal(normalizeRepo(''), null)
  assert.equal(directoryNameFor('acme/dshns-example'), 'acme_dshns-example')
  assert.equal(directoryNameFor('../../etc/passwd'), '.._.._etc_passwd')
})

test('staging puts the code on disk, verifies it, and runs nothing', () => {
  const { installer, fake, dispose } = harness()
  try {
    const staged = installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(staged.ok, true, staged.reason)
    assert.equal(staged.staged, true)
    assert.equal(staged.entry.id, 'vendor.example-plugin')
    assert.equal(staged.entry.version, '1.0.0')
    assert.equal(staged.entry.enabled, false, 'staging must not enable anything')
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].url, 'https://github.com/acme/dshns-example.git')
    assert.equal(fake.calls[0].branch, null)
    // The clone's repository metadata is not part of a plugin.
    assert.equal(fs.existsSync(path.join(staged.entry.dir, '.git')), false)
    assert.equal(fs.existsSync(path.join(staged.entry.dir, 'index.cjs')), true)
    // Staged, not enabled: the state says so.
    assert.deepEqual(installer.list().map((entry) => `${entry.id}:${entry.state}`), ['vendor.example-plugin:staged'])
    assert.equal(installer.history()[0].action, 'stage')
  } finally {
    dispose()
  }
})

test('a failed clone leaves nothing behind, and the next attempt is not "already staged"', () => {
  const { installer, dir, dispose } = harness({ halfThenFail: true })
  try {
    const failed = installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, INSTALL_REASONS.CLONE_FAILED)
    assert.equal(fs.existsSync(path.join(dir, 'data', 'plugins', 'store', 'acme_dshns-example')), false, 'a half-populated directory must not survive')
    assert.equal(installer.list().length, 0)
    assert.equal(installer.history()[0].ok, false)
    // The retry reaches the clone again rather than being refused as a duplicate.
    const retry = installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(retry.ok, true, retry.reason)
  } finally {
    dispose()
  }
})

test('a manifest the platform rejects is refused, and the copy is removed', () => {
  const cases = [
    [{ api_version: 'dshns.plugin/v2', id: 'a.b', name: 'A', version: '1.0.0' }, /api_version|invalid/],
    [{ api_version: 'dshns.plugin/v1', name: 'A', version: '1.0.0' }, /invalid/],
    ['{ not json', /not valid JSON/],
    [null, /has no dshns-plugin\.json/]
  ]
  for (const [manifest, pattern] of cases) {
    const { installer, dir, dispose } = harness({ manifest })
    try {
      const staged = installer.stage({ repo: 'acme/dshns-example' })
      assert.equal(staged.ok, false, JSON.stringify(manifest))
      assert.equal(staged.code, INSTALL_REASONS.BAD_MANIFEST)
      assert.match(staged.reason, pattern)
      assert.equal(fs.existsSync(path.join(dir, 'data', 'plugins', 'store', 'acme_dshns-example')), false)
    } finally {
      dispose()
    }
  }
})

test('a manifest whose entry point is missing or escapes the directory is refused', () => {
  const escapes = { ...MANIFEST, main: '../../../etc/passwd' }
  const { installer, dispose } = harness({ manifest: escapes, omitMain: true })
  try {
    const staged = installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(staged.ok, false)
    assert.equal(staged.code, INSTALL_REASONS.BAD_MANIFEST)
    assert.match(staged.reason, /main/)
  } finally {
    dispose()
  }
  const missing = harness({ omitMain: true })
  try {
    const staged = missing.installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(staged.ok, false)
    assert.equal(staged.code, INSTALL_REASONS.MISSING_FILES)
    assert.match(staged.reason, /entry point index\.cjs is missing/)
  } finally {
    missing.dispose()
  }
})

test('enabling re-reads the manifest, so files changed after staging are refused', () => {
  const { installer, dispose } = harness()
  try {
    const staged = installer.stage({ repo: 'acme/dshns-example' })
    assert.equal(staged.ok, true)
    // Somebody edits the staged copy into something the host would not accept.
    fs.writeFileSync(path.join(staged.entry.dir, 'dshns-plugin.json'), JSON.stringify({ ...MANIFEST, api_version: 'dshns.plugin/v9' }), 'utf8')
    const enabled = installer.enable({ id: 'vendor.example-plugin' })
    assert.equal(enabled.ok, false, 'an enable must verify what is on disk now')
    assert.equal(enabled.code, INSTALL_REASONS.BAD_MANIFEST)
    assert.equal(installer.list()[0].state, 'staged', 'a refused enable leaves it staged')
  } finally {
    dispose()
  }
})

test('the two stages are recorded, and a removal keeps the history for a reinstall', () => {
  const { installer, dispose } = harness()
  try {
    const staged = installer.stage({ repo: 'acme/dshns-example', branch: 'main' })
    assert.equal(installer.enable({ id: staged.entry.id }).ok, true)
    assert.equal(installer.list()[0].state, 'enabled')
    assert.equal(installer.describe().enabled, 1)
    assert.equal(installer.describe().staged, 0)

    const removed = installer.remove({ id: staged.entry.id })
    assert.equal(removed.ok, true)
    assert.equal(installer.list().length, 0)
    assert.equal(fs.existsSync(staged.entry.dir), false)

    // The history still knows where it came from, so reinstalling is one call.
    const actions = installer.history().map((entry) => entry.action)
    assert.deepEqual(actions.slice(0, 3), ['remove', 'enable', 'stage'])
    const again = installer.reinstall({ id: staged.entry.id })
    assert.equal(again.ok, true, again.reason)
    assert.equal(again.enabled, true, 'a plugin that was enabled is re-enabled on reinstall')
    assert.equal(installer.list()[0].state, 'enabled')
  } finally {
    dispose()
  }
})

test('a plugin whose directory disappeared is reported rather than enabled', () => {
  const { installer, dispose } = harness()
  try {
    const staged = installer.stage({ repo: 'acme/dshns-example' })
    fs.rmSync(staged.entry.dir, { recursive: true, force: true })
    const state = installer.list()[0]
    assert.equal(state.present, false)
    assert.equal(state.state, 'missing')
    const enabled = installer.enable({ id: staged.entry.id })
    assert.equal(enabled.ok, false)
    assert.equal(enabled.code, INSTALL_REASONS.MISSING_FILES)
  } finally {
    dispose()
  }
})

test('the queue installs one by one, stages only, and reports each outcome', async () => {
  const { installer, dir, fake, dispose } = harness()
  try {
    // Two candidates, one of which cannot be cloned.
    let call = 0
    const twoAtATime = createStoreInstaller({
      root: dir,
      now: () => 1,
      log: () => {},
      storeDir: path.join(dir, 'data', 'plugins', 'store'),
      stateFile: path.join(dir, 'data', 'plugins', 'installed.json'),
      historyFile: path.join(dir, 'data', 'plugins', 'history.json'),
      clone: (url, target, options) => {
        call += 1
        if (url.includes('broken')) return { ok: false, reason: 'repository not found' }
        return fake.clone(url, target, options)
      }
    })
    assert.equal(twoAtATime.enqueue({ repo: 'acme/one' }).ok, true)
    assert.equal(twoAtATime.enqueue({ repo: 'acme/broken' }).ok, true)
    assert.equal(twoAtATime.enqueue({ repo: 'nope' }).ok, false, 'an invalid candidate is refused at enqueue time')
    assert.equal(twoAtATime.queue().length, 2)

    const run = await twoAtATime.runQueue()
    assert.equal(run.results.length, 2)
    assert.deepEqual(run.results.map((item) => item.status), ['staged', 'failed'])
    assert.match(run.results[1].reason, /not found|repository/)
    assert.equal(run.ok, false, 'a failed candidate makes the run unsuccessful, but the others still staged')
    assert.equal(run.staged, 1)
    assert.match(run.note, /enabling is the step that runs the plugin/i)
    // One clone per candidate, sequential: the queue is not a fan-out.
    assert.equal(call, 2)
    // Staged, not enabled.
    assert.equal(twoAtATime.list().every((entry) => entry.state === 'staged'), true)
    twoAtATime.clearQueue()
    assert.equal(twoAtATime.queue().length, 0)
  } finally {
    dispose()
  }
})

test('an unknown id is refused by every acting call', () => {
  const { installer, dispose } = harness()
  try {
    for (const result of [installer.enable({ id: 'nope' }), installer.disable({ id: 'nope' }), installer.remove({ id: 'nope' })]) {
      assert.equal(result.ok, false)
      assert.equal(result.code, INSTALL_REASONS.NOT_STAGED)
    }
    assert.equal(installer.entry('nope'), null)
  } finally {
    dispose()
  }
})

/**
 * The pre-flight: one request instead of one download.
 *
 * This exists because of a real repository — a 933 MB monorepo whose root has no manifest, so
 * cloning it to learn that one fact costs a gigabyte of disk and half a minute. The refusal is
 * only allowed on a *verified* absence: a rate limit, an unresolved default branch or a missing
 * probe must fall through to the clone, because refusing somebody's real plugin is worse than
 * downloading it.
 */
test('a repository with no manifest is refused before anything is downloaded', async () => {
  const probed = []
  const harnessed = harness({
    probe: async (input) => {
      probed.push({ ...input })
      return { ok: true, installable: false, verified: true, branch: 'dev', code: 'STORE_NO_MANIFEST', reason: 'this repository has no dshns-plugin.json at dev' }
    }
  })
  try {
    const checked = await harnessed.installer.preflight({ repo: 'zhu1090093659/dsh-web', branch: 'dev' })
    assert.equal(checked.ok, false)
    assert.equal(checked.code, INSTALL_REASONS.BAD_MANIFEST)
    assert.match(checked.reason, /nothing was downloaded/, 'the refusal must say that nothing was fetched')
    assert.equal(harnessed.fake.calls.length, 0, 'a refused repository must not be cloned')

    // The same verdict handed to `stage` refuses there too, still without touching the disk.
    const staged = harnessed.installer.stage({
      repo: 'zhu1090093659/dsh-web',
      branch: 'dev',
      verdict: { installable: false, verified: true, branch: 'dev' }
    })
    assert.equal(staged.ok, false)
    assert.equal(staged.code, INSTALL_REASONS.BAD_MANIFEST)
    assert.match(staged.reason, /not a DS-Hns plugin/)
    assert.equal(harnessed.fake.calls.length, 0)
    const dir = path.join(harnessed.installer.storeDir, directoryNameFor('zhu1090093659/dsh-web'))
    assert.equal(fs.existsSync(dir), false, 'a refused repository must not leave a directory behind')
    // The probe is told the exact target and whether a foreign plugin may be adopted: a compat
    // verdict depends on both, so a probe that was not told cannot answer for the right thing.
    assert.deepEqual(probed, [{ repo: 'zhu1090093659/dsh-web', branch: 'dev', path: null, compat: false }])
  } finally {
    harnessed.dispose()
  }
})

/**
 * A pinned **revision** — the market plugin's case, since its repository publishes no tags.
 *
 * The fake clone above cannot answer the question this test is about, because "did the pin actually pin?" is a
 * property of the real git call. So this one builds a real repository in a temporary directory, pins a commit,
 * then moves the branch on: a store that cloned the branch would install the newer tree, and one that fetched
 * the revision installs the commit that was named.
 */
test('a revision pin installs that commit, not whatever the default branch holds now', async () => {
  const { spawnSync } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-store-revision-'))
  const origin = path.join(dir, 'origin')
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`)
    return result.stdout.trim()
  }
  try {
    fs.mkdirSync(origin, { recursive: true })
    git(origin, ['init', '--quiet', '--initial-branch=main'])
    git(origin, ['config', 'user.email', 'test@example.invalid'])
    git(origin, ['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(origin, 'dshns-plugin.json'), JSON.stringify({ ...MANIFEST, version: '1.0.0' }, null, 2), 'utf8')
    fs.writeFileSync(path.join(origin, 'index.cjs'), "'use strict'\nmodule.exports = {}\n", 'utf8')
    git(origin, ['add', '-A'])
    git(origin, ['commit', '--quiet', '-m', 'v1'])
    const pinned = git(origin, ['rev-parse', 'HEAD'])
    // The branch moves on after the pin was recorded.
    fs.writeFileSync(path.join(origin, 'dshns-plugin.json'), JSON.stringify({ ...MANIFEST, version: '2.0.0' }, null, 2), 'utf8')
    git(origin, ['add', '-A'])
    git(origin, ['commit', '--quiet', '-m', 'v2'])

    const storeDir = path.join(dir, 'store')
    const installer = createStoreInstaller({
      root: dir,
      // The real clone, so the revision path is exercised end to end; only the URL is redirected to the local
      // origin, which keeps the test off the network without replacing the code under test.
      clone: (url, target, options) => defaultClone(`file://${origin.replace(/\\/g, '/')}`, target, options),
      log: () => {},
      storeDir,
      stateFile: path.join(dir, 'installed.json'),
      historyFile: path.join(dir, 'history.json')
    })
    const staged = await installer.stage({ source: 'acme/dshns-example', revision: pinned })
    assert.equal(staged.ok, true, staged.reason)
    assert.equal(staged.entry.version, '1.0.0', 'the branch tip was installed instead of the pinned commit')
    assert.equal(staged.entry.revision, pinned, 'the state file does not record which revision was installed')
    assert.equal(staged.entry.branch, null)
    // A revision and a branch together are a question with two answers, so they are refused.
    assert.equal((await installer.stage({ source: 'acme/dshns-example', branch: 'main', revision: pinned })).ok, false)
    assert.equal((await installer.stage({ source: 'acme/dshns-example', revision: 'not-a-commit' })).ok, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an inconclusive manifest check refuses nothing: the clone decides', async () => {
  const harnessed = harness({
    probe: async () => ({ ok: true, installable: false, verified: false, reason: 'the default branch could not be resolved' })
  })
  try {
    const checked = await harnessed.installer.preflight({ repo: 'acme/dshns-example' })
    assert.equal(checked.ok, true, 'an unverified absence must not refuse an install')
    assert.equal(checked.verdict.verified, false)
    const staged = harnessed.installer.stage({ repo: 'acme/dshns-example', verdict: checked.verdict })
    assert.equal(staged.ok, true, staged.reason)
    assert.equal(harnessed.fake.calls.length, 1, 'the clone must still happen and verify the manifest itself')
  } finally {
    harnessed.dispose()
  }
})

test('a probe that throws is reported as inconclusive rather than as a refusal', async () => {
  const harnessed = harness({ probe: async () => { throw new Error('socket hang up') } })
  try {
    const checked = await harnessed.installer.preflight({ repo: 'acme/dshns-example' })
    assert.equal(checked.ok, true)
    assert.equal(checked.verdict, null)
    assert.match(checked.note, /socket hang up/)
    assert.equal(harnessed.installer.stage({ repo: 'acme/dshns-example', verdict: checked.verdict }).ok, true)
  } finally {
    harnessed.dispose()
  }
})

test('an installer with no probe behaves exactly as it always did', async () => {
  const harnessed = harness()
  try {
    const checked = await harnessed.installer.preflight({ repo: 'acme/dshns-example' })
    assert.equal(checked.ok, true)
    assert.equal(checked.verdict, null)
    assert.match(checked.note, /no manifest probe/)
    assert.equal(harnessed.installer.stage({ repo: 'acme/dshns-example' }).ok, true)
  } finally {
    harnessed.dispose()
  }
})

test('the queue refuses a candidate that is not a plugin without cloning it', async () => {
  const harnessed = harness({
    probe: async ({ repo }) => (repo === 'acme/not-a-plugin'
      ? { ok: true, installable: false, verified: true, reason: 'this repository has no dshns-plugin.json at main' }
      : { ok: true, installable: true, verified: true })
  })
  try {
    harnessed.installer.enqueue({ repo: 'acme/not-a-plugin' })
    harnessed.installer.enqueue({ repo: 'acme/dshns-example' })
    const run = await harnessed.installer.runQueue()
    assert.deepEqual(run.results.map((item) => item.status), ['failed', 'staged'])
    assert.match(run.results[0].reason, /no dshns-plugin\.json/)
    assert.equal(run.staged, 1)
    // The refused candidate cost one request; only the real plugin was downloaded.
    assert.equal(harnessed.fake.calls.length, 1, 'the refused candidate must not have been cloned')
    assert.equal(harnessed.fake.calls[0].url, 'https://github.com/acme/dshns-example.git')
  } finally {
    harnessed.dispose()
  }
})
