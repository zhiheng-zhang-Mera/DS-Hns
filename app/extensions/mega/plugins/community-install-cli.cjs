'use strict'

/**
 * The optional community plugins, as a command line — what `scripts\install-community-plugins.ps1` runs.
 *
 * This file is a *thin* entry point, and that is deliberate: the release pin lives in
 * `app/extensions/mega/plugins/index.cjs`, the installation channel lives in `installBundled()`, the
 * answer is recorded by `community-install.cjs`, and the compatibility check is the **adapter
 * framework's** (`dshns.harness-profile`, registered here exactly as `plugin-host.cjs` registers it).
 * Nothing about installing a plugin is implemented in this file, and nothing about it is implemented
 * a second time in PowerShell.
 *
 * ## Why the check goes through the adapter framework
 *
 * `dsh plugin --profile web add <pkg>@<ref>` answers "the CLI exited 0". It does not answer "the
 * package that landed is the community bundle this release pinned, and its host half is where its
 * manifest says". That second question is a question about *format*, which is the adapter layer's job
 * — so the installed directory is handed to the same framework the runtime uses, with
 * `channel: 'harness-profile'`, and the framework's own answer (detected type, selected adapter,
 * evidence, peers, browser half) is what this command reports and what the installer prints.
 *
 * A package the adapter layer cannot recognise is reported as a failure. It is not retried through a
 * second, weaker check, and an install is never called successful because a directory exists:
 * `INSTALLED` in the installer's summary means the CLI ran *and* the framework recognised the result.
 *
 * ## Usage
 *
 * ```
 *   node app\extensions\mega\plugins\community-install-cli.cjs --describe
 *   node app\extensions\mega\plugins\community-install-cli.cjs --install-market --install-wallpaper
 *   node app\extensions\mega\plugins\community-install-cli.cjs --skip
 *   node app\extensions\mega\plugins\community-install-cli.cjs --install-market --json
 * ```
 *
 * Exit code: `0` when every requested plugin was installed (or was already there), `1` when a
 * requested plugin failed. A failure never stops the caller's own installation — see
 * `scripts\install.ps1`, which warns and carries on.
 *
 * Stdout: one JSON document when `--json` is given (the machine-readable answer), otherwise the
 * human lines. Every diagnostic goes to stderr, so a caller parsing stdout is never confused by
 * progress output.
 */

const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..', '..')

const { BUNDLED_MANIFEST } = require('./index.cjs')
const community = require('./community-install.cjs')
const { createAdapterFramework } = require('../../../core/plugin-adapters/index.cjs')
const { createHarnessProfileAdapter } = require('../../../core/plugin-adapters/adapters/harness-profile.cjs')

/** The label the summary prints for each entry, so a report reads as the product's own vocabulary. */
const LABELS = Object.freeze({
  '@dsh-market/plugin': 'Plugin Market',
  'dsh-wallpaper-engine': 'Wallpaper Engine'
})

/**
 * The bilingual user-facing text, read from beside this file.
 *
 * It lives in a JSON file rather than in the installer's PowerShell for a reason worth stating: the
 * installer's PowerShell files are **ASCII-only by contract** (`installer-contract.test.js` asserts
 * it), because Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so a Chinese character written
 * into one of them corrupts the prompt or the parse. Node reads and writes UTF-8 whatever the console
 * code page is, so the prompt is asked from here and the person still reads their own language.
 */
function loadLabels() {
  try {
    return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'community-labels.json'), 'utf8'))
  } catch {
    return { prompt: {}, labels: {}, summary: {}, states: {} }
  }
}

/**
 * Ask about the optional plugins, one at a time.
 *
 * The default is *skip*, and it is the default that matters: a person who hits Enter installs
 * nothing optional. The two questions are separate -- never one combined switch -- so "the store but
 * not the wallpaper" is something a person can actually say.
 */
async function askSelected({ plan, labels, selection }) {
  const readline = require('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve))
  const prompt = labels.prompt || {}
  const answers = { market: selection.market, wallpaper: selection.wallpaper }
  try {
    write('')
    write(`  ${prompt.heading || 'Optional community plugins'}`)
    for (const line of String(prompt.intro || '').split('\n')) if (line.trim()) write(`  ${line}`)
    for (const line of String(prompt.default || '').split('\n')) if (line.trim()) write(`  ${line}`)
    // Wallpaper first: it is the one whose effect a person sees immediately.
    for (const id of ['dsh-wallpaper-engine', '@dsh-market/plugin']) {
      const entry = plan.find((candidate) => candidate.id === id)
      if (!entry || entry.installed) continue
      const text = (labels.labels || {})[id] || { en: LABELS[id] || id, zh: id, options: [] }
      const label = `${text.en} / ${text.zh}`
      write('')
      write(`  ${text.question || `Install ${label}?`}`)
      for (const option of text.options || []) write(option)
      let answer = ''
      while (answer !== '1' && answer !== '2') {
        const raw = await ask(`  ${String(prompt.choose || 'Choose 1 or 2').replace(/\{label\}/g, label)} `)
        answer = String(raw || '').trim()
        if (!answer) answer = '2'
        if (answer !== '1' && answer !== '2') write(`  ${prompt.invalid || 'Please answer 1 or 2.'}`)
      }
      const yes = answer === '1'
      if (id === 'dsh-wallpaper-engine') answers.wallpaper = yes
      else answers.market = yes
      write(`  ${yes ? String(prompt.selected || '{label} selected.').replace(/\{label\}/g, label) : String(prompt.declined || '{label} skipped.').replace(/\{label\}/g, label)}`)
    }
    return answers
  } finally {
    rl.close()
  }
}

function parseArgs(argv) {
  const args = {
    describe: false,
    installMarket: false,
    installWallpaper: false,
    skip: false,
    ask: false,
    json: false,
    report: '',
    fixture: '',
    extra: '',
    profile: process.env.DSH_PROFILE || 'web',
    dshHome: process.env.DSH_HOME || path.join(ROOT, 'data'),
    root: ROOT
  }
  for (const raw of argv) {
    const arg = String(raw)
    if (arg === '--describe') args.describe = true
    else if (arg === '--install-market') args.installMarket = true
    else if (arg === '--install-wallpaper') args.installWallpaper = true
    else if (arg === '--skip') args.skip = true
    else if (arg === '--ask') args.ask = true
    else if (arg === '--json') args.json = true
    else if (arg.startsWith('--report=')) args.report = arg.slice('--report='.length)
    else if (arg.startsWith('--fixture=')) args.fixture = arg.slice('--fixture='.length)
    else if (arg.startsWith('--extra=')) args.extra = arg.slice('--extra='.length)
    else if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--dsh-home=')) args.dshHome = arg.slice('--dsh-home='.length)
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length)
  }
  return args
}

/**
 * `--fixture=<file>`: a test seam, and only that.
 *
 * The installer test drives the real command line, but the real command line installs the *published*
 * packages from a registry — so a test would need the network, and would be testing the registry's
 * contents as much as this program. The fixture file names a local directory to stand in for each
 * package, so the stand-in Harness CLI materialises a package with the shape the pinned one publishes.
 *
 * It is a parameter rather than an environment variable on purpose: a variable could be left set in a
 * shell and silently redirect a real installation at a local directory, and a flag that a person has to
 * type is a flag that cannot be set by accident.
 */
function loadFixtureMap(file) {
  if (!file) return {}
  try {
    const parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    write(`the fixture map ${file} could not be read: ${error && error.message ? error.message : error}`)
    return {}
  }
}

/**
 * Put the machine-readable report where the caller can read it *as UTF-8*.
 *
 * A caller that captures stdout is at the mercy of its own encoding: Windows PowerShell decodes a
 * native command's output through the console code page, so a redirect can silently produce UTF-16 or
 * mojibake for anything but ASCII. `--report=<file>` writes the same document with Node's own UTF-8
 * writer, which is one decoding step fewer and the one that cannot be got wrong.
 */
function writeReport(file, report) {
  if (!file) return false
  try {
    require('node:fs').writeFileSync(file, `${JSON.stringify(report)}\n`, 'utf8')
    return true
  } catch (error) {
    write(`the report could not be written to ${file}: ${error && error.message ? error.message : error}`)
    return false
  }
}

function write(line) {
  process.stderr.write(`${line}\n`)
}

/**
 * Run one plugin's installation through the **Harness' own CLI**.
 *
 * The profile's plugin set is the Harness' business, and this is the invocation the product itself
 * uses at runtime (`installPinnedPlugin` in `app/extensions/mega/index.cjs`): the same Node binary,
 * the same `@deepseek-ai/dsh` entry, the same `plugin --profile <p> add <spec>` shape. A product that
 * wrote into another application's profile directory itself would be editing an install it does not own.
 */
function createHarnessAdd({ nodeExe, dshEntry, cwd, fixtures = {}, extraArgs = [] }) {
  const extra = (Array.isArray(extraArgs) ? extraArgs : []).map(String)
  return ({ profile, package: spec }) => {
    if (!require('node:fs').existsSync(dshEntry)) {
      return { ok: false, reason: `the Harness CLI is not installed (${dshEntry} is missing); run scripts\\install-deps.ps1 first` }
    }
    const args = [dshEntry, 'plugin', '--profile', profile, 'add', spec]
    const packageName = String(spec).replace(/@[^@/]*$/, '')
    const fixture = fixtures[packageName]
    if (fixture) args.push(`--fixture=${fixture}`)
    for (const argument of extra) args.push(argument)
    const result = require('node:child_process').spawnSync(nodeExe, args, {
      cwd,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    })
    if (result.error) return { ok: false, reason: `the Harness plugin command could not run: ${result.error.message}` }
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-4).join(' | ')
      return { ok: false, reason: `dsh plugin exited ${result.status}${detail ? `: ${detail}` : ''}` }
    }
    return { ok: true }
  }
}

/**
 * Build the adapter-layer compatibility check for one entry.
 *
 * The framework is constructed with the *same* registration the runtime uses — the profile adapter,
 * the bridged community adapter and the generic adoption adapter — so the answer this command reports
 * is the answer the running product would give for the same directory. A separate framework with only
 * the profile adapter registered would answer a different question.
 */
function createVerifier({ nodeExe, peerRoots, dshHome = null }) {
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createHarnessProfileAdapter({ roots: peerRoots, log: () => {} }))
  // The bridged and generic adapters are registered as a *fallback*, so the report can say what the
  // runtime would have done with this package had the profile channel not claimed it. The profile
  // adapter has the highest priority, so a package that really is a community bundle is never
  // silently re-classified by one of these.
  const { createCordisDshAdapter } = require('../../../core/plugin-adapters/adapters/cordis-dsh.cjs')
  const { createCordisAdapter } = require('../../../core/plugin-adapters/adapters/cordis.cjs')
  framework.register(createCordisDshAdapter({ nodeExe, roots: peerRoots, log: () => {} }))
  framework.register(createCordisAdapter({ nodeExe, log: () => {} }))

  return async ({ id, channel, profile, packageName }) => {
    const installed = community.readInstalled({ root: ROOT, profile, dshHome, packageName })
    if (installed.ok !== true || installed.installed !== true) {
      return {
        ok: false,
        code: community.COMMUNITY_FAULT_CODES.NOT_INSTALLED,
        reason: installed.reason || `${packageName} is not installed in profile ${profile}`
      }
    }
    const adapted = await framework.adapt({
      dir: installed.packageDir,
      channel,
      where: `profile ${profile}`,
      source: `${packageName}@${installed.version || installed.declared || ''}`,
      repo: null
    })
    if (adapted.ok !== true) {
      return {
        ok: false,
        code: adapted.code || community.COMMUNITY_FAULT_CODES.ADAPTER_REFUSED,
        reason: adapted.reason || 'the adapter layer did not recognise the installed package',
        attempts: adapted.attempts || []
      }
    }
    /**
     * The channel is a contract, so a different adapter's answer is a failure and not a pass.
     *
     * `dshns.cordis` adopts *any* node package into an isolated process — that is what it is for —
     * so a plain package installed in place of a community bundle would be adapted successfully as
     * something else entirely. Accepting that would let the installer print `INSTALLED` for a plugin
     * the Harness will never compose, which is exactly the comfortable claim this repository's rules
     * are written against. The profile channel has one adapter, and this is the check that keeps the
     * claim honest: the pinned package is the community bundle, or it failed.
     */
    const PROFILE_ADAPTER = 'dshns.harness-profile'
    if (adapted.adapter.id !== PROFILE_ADAPTER) {
      return {
        ok: false,
        code: community.COMMUNITY_FAULT_CODES.ADAPTER_REFUSED,
        reason: `the installed package was adapted as ${adapted.adapter.id} (${adapted.detection ? adapted.detection.type : 'unknown'}), not as a ${channel} community bundle; the pinned package is not what landed in the profile`,
        detectedType: adapted.detection ? adapted.detection.type : null,
        adapter: adapted.adapter.id
      }
    }
    const info = adapted.plugin && typeof adapted.plugin.runtimeInfo === 'function' ? adapted.plugin.runtimeInfo() : null
    // The lifecycle wrapper merges an adapter's own `runtimeInfo()` under `detail` (the standard
    // sections are the platform's, and an adapter's report is kept apart from them), so the structural
    // report is read from where the wrapper actually put it -- the same place `plugin-install/pipeline`
    // reads it from.
    const detail = info && info.detail ? info.detail : null
    return {
      ok: true,
      id,
      profile,
      adapter: { id: adapted.adapter.id, version: adapted.adapter.version },
      detectedType: adapted.detection ? adapted.detection.type : null,
      confidence: adapted.detection ? adapted.detection.confidence : null,
      evidence: adapted.detection ? adapted.detection.evidence : [],
      structure: detail ? detail.structure || null : null,
      client: detail ? detail.client || null : null,
      packageDir: installed.packageDir,
      version: installed.version || installed.declared || null
    }
  }
}

async function main(argv) {
  const args = parseArgs(argv)
  const selection = community.resolveSelection({
    installMarket: args.installMarket,
    installWallpaper: args.installWallpaper,
    skipOptional: args.skip
  })

  const plan = community.describeCommunity({ root: args.root, profile: args.profile, dshHome: args.dshHome, manifest: BUNDLED_MANIFEST })

  // `--describe` is the planning call the interactive prompt is built from: it reads the release pin,
  // the profile's manifest and the installed packages, and installs nothing.
  if (args.describe) {
    const answer = { ok: true, mode: 'describe', profile: args.profile, profileDir: plan.profileDir, plugins: plan.plugins }
    writeReport(args.report, answer)
    if (args.json) process.stdout.write(`${JSON.stringify(answer)}\n`)
    else {
      for (const plugin of plan.plugins) {
        process.stdout.write(`${plugin.id}\t${plugin.spec}\t${plugin.installed ? `installed (${plugin.installedVersion || plugin.declared})` : 'not installed'}\n`)
      }
    }
    return 0
  }

  if (selection.ok !== true) {
    // A conflict is an error with a reason, never a silent override.
    write(`conflicting parameters: ${selection.reason}`)
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, code: selection.code, reason: selection.reason })}\n`)
    return 2
  }

  // The interactive path: `--ask` is what the installer passes when there is a person at the
  // console. A parameter already answered the question, so asking would be asking twice -- the
  // parameters outrank the prompt, and they are never silently overridden by it.
  let marketRequested = selection.market
  let wallpaperRequested = selection.wallpaper
  if (args.ask && selection.unanswered) {
    const answers = await askSelected({ plan: plan.plugins, labels: loadLabels(), selection })
    marketRequested = answers.market
    wallpaperRequested = answers.wallpaper
  }

  const nodeExe = process.execPath
  const dshEntry = path.join(args.root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const harnessAdd = createHarnessAdd({
    nodeExe,
    dshEntry,
    cwd: args.root,
    fixtures: loadFixtureMap(args.fixture),
    // One more test seam, and the narrow one: extra arguments handed to the Harness CLI itself, so a
    // test can make the *channel* refuse without replacing the CLI the product's own plugin is
    // installed through. Never set by a person.
    extraArgs: args.extra ? String(args.extra).split(',').filter(Boolean) : []
  })
  const verify = createVerifier({
    nodeExe,
    // Where a profile plugin's peers are looked for, most specific first: the profile's own install
    // (pnpm resolved the plugin's dependencies there), then the product's harness install, which is
    // where the Harness' own packages live.
    peerRoots: [
      path.join(args.dshHome, 'profiles', args.profile, 'node_modules'),
      path.join(args.root, 'app', 'node_modules')
    ],
    dshHome: args.dshHome
  })
  const profile = args.profile

  const requested = {
    'dsh-wallpaper-engine': wallpaperRequested,
    '@dsh-market/plugin': marketRequested
  }

  const results = []
  for (const entry of community.communityEntries(BUNDLED_MANIFEST)) {
    const label = LABELS[entry.id] || entry.id
    if (requested[entry.id] !== true) {
      // Nobody asked for this one. In a non-interactive install that is the default the requirement
      // names: an optional community plugin is skipped, and the reason is on the record.
      const reason = selection.skip
        ? '-SkipOptionalPlugins was given'
        : 'not selected; optional community plugins are skipped unless they are asked for'
      results.push(community.skipped(entry.id, reason))
      write(`[community] ${label}: SKIPPED (${reason})`)
      continue
    }
    const outcome = await community.applyOptionalChoice({
      root: args.root,
      id: entry.id,
      install: true,
      profile,
      dshHome: args.dshHome,
      harnessAdd,
      verify,
      spec: `${entry.package}@${entry.ref}`
    })
    const record = {
      id: entry.id,
      label,
      ok: outcome.ok === true,
      state: outcome.ok === true ? (outcome.alreadyInstalled ? 'already-installed' : 'installed') : 'failed',
      reason: outcome.ok === true ? outcome.message || null : outcome.reason || 'the install returned no outcome',
      version: outcome.ok === true ? outcome.version || null : null,
      channel: outcome.channel || entry.channel || null,
      spec: outcome.spec || `${entry.package}@${entry.ref}`,
      verify: outcome.verify || null
    }
    write(`[community] ${label}: ${record.state.toUpperCase()}${record.reason ? ` - ${record.reason}` : ''}`)
    if (record.verify && record.verify.ok === true && record.verify.adapter) {
      write(`[community] ${label}: verified by ${record.verify.adapter.id} (${record.verify.detectedType})`)
    } else if (record.verify && record.verify.ok === false) {
      write(`[community] ${label}: NOT verified by the adapter layer - ${record.verify.reason || 'no reason given'}`)
    }
    results.push(record)
  }

  const failed = results.filter((result) => result.ok !== true)
  const report = {
    ok: failed.length === 0,
    mode: 'install',
    profile,
    profileDir: plan.profileDir,
    adapterRegistry: { id: 'dshns.harness-profile', channel: 'harness-profile', verified: results.filter((r) => r.verify && r.verify.ok === true).map((r) => r.id) },
    results
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`)
  else {
    for (const result of results) process.stdout.write(`${LABELS[result.id] || result.id}\t${result.state}\n`)
  }
  writeReport(args.report, report)
  return failed.length === 0 ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      write(`the community plugin install failed unexpectedly: ${error && error.stack ? error.stack : error}`)
      process.exitCode = 1
    })
}

module.exports = { parseArgs, createHarnessAdd, createVerifier, askSelected, loadLabels, loadFixtureMap, writeReport, main, LABELS }
