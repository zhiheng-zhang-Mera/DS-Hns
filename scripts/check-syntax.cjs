'use strict'

/**
 * Syntax gate for every hand-written source file in DS-Harness.
 *
 * The check used to be a single `node --check a && node --check b && …` command
 * string, which meant a newly added file was silently unchecked until somebody
 * remembered to append it. Keeping the list here makes the coverage explicit and
 * reviewable.
 *
 * `stdout` is inherited on purpose: this environment cannot capture a child's
 * output through a pipe, and a syntax error must be visible anyway.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const APP = path.join(path.resolve(__dirname, '..'), 'app')
const ROOT = path.resolve(APP, '..')

/** Directories searched for checked sources, relative to the app directory. */
const SOURCE_DIRS = [
  '.',
  // The frontend runtime (the official renderer's adapter, backend, model and probe).
  // The native frontend and its mode machinery were removed with Daily. Listed
  // explicitly because this collector is non-recursive by design - a new file must be
  // added here, or the directory it lives in must be, or it silently escapes the gate.
  'frontend-mode',
  'extensions',
  'extensions/mega/autonomy',
  'extensions/mega/billing',
  'extensions/mega/deepseek',
  // The extension's own root modules: the feature registry is one of them, and the
  // collector is non-recursive, so the bare directory has to be listed.
  'extensions/mega',
  'extensions/mega/dock',
  'extensions/mega/notifications',
  'extensions/mega/scheduler',
  'extensions/mega/settings',
  'extensions/mega/skills',
  'extensions/mega/store',
  'extensions/mega/theme',
  // The theme subsystem's own subdirectories. Listed explicitly because this
  // collector is non-recursive by design: a new file must be added here (or the
  // directory it lives in must be) or it silently escapes the gate.
  'extensions/mega/theme/assets',
  'extensions/mega/theme/official',
  'extensions/mega/tracker',
  'extensions/mega/ui',
  'extensions/mega/updater',
  'extensions/mega/utils',
  'sub-worker',
  // Computer Use runtime (Update-Plan/computer-use.md). The runtime core, its
  // controllers and its real drivers are separate directories, listed
  // explicitly because this collector is non-recursive by design: a new file
  // must be added here (or its directory must be) or it silently escapes the
  // gate.
  'computer-use',
  'computer-use/controllers',
  'computer-use/drivers',
  // The engineering runtime (Update-Plan/24h-1.md). A new directory has to be
  // listed here or its files escape the gate silently.
  'engineering',
  'engineering/adapters',
  // The plugin runtime core (Update-Plan/accleration.md). Same rule: the collector
  // is non-recursive, so every core directory must be named here.
  'core/contracts',
  'core/plugin-manager',
  // The scheduled restart: the plan model, its durable store, the operating system's half, and the
  // sequence they happen in.
  'reboot',
  // The compatibility layer: the isolated activation worker, the adapter that builds a plugin
  // object around it, and the described-and-confirmed dependency/build commands.
  'core/plugin-compat',
  'core/capability-registry',
  'core/event-bus',
  'core/config-manager',
  'core/lockfile',
  'core/resource-manager',
  'core/health-supervisor',
  // The plugin adapter framework and the Cordis/DSH community adapter. Phase 1 added the framework
  // and this phase added the bridge, and both escaped this gate until they were listed: the
  // collector is non-recursive, so a whole new subtree is silent by default. Named here for the
  // same reason as every other entry.
  'core/plugin-adapters',
  'core/plugin-adapters/adapters',
  'core/plugin-adapters/bridge',
  // The managed-process half: the process contract, the two transports and the supervisor that
  // starts, watches, bounds and stops a background plugin.
  'core/plugin-adapters/process',
  // The unified install pipeline: fetch, detect, plan, install, and the lifecycle operations over
  // the install records.
  'core/plugin-install',
  // The provider that carries the DeepSeek-specific knowledge, so no generic
  // plugin has to.
  'plugins/providers/deepseek',
  // The mounted feature set: the plugins that wrap the subsystems which already
  // exist. Listed because the collector is non-recursive.
  'plugins/mounted',
  // The health scheduler: the first plugin written for this platform under the adapter framework.
  // A new plugin directory has to be listed here or its files escape the gate silently.
  'plugins/health-scheduler',
  // The acceleration set (Update-Plan/accleration.md phases 5-13): the plugin entry
  // point plus one directory per accelerator, each listed because the collector is
  // non-recursive.
  'plugins/acceleration',
  'plugins/acceleration/command-cache',
  'plugins/acceleration/dirty-context',
  'plugins/acceleration/high-performance',
  'plugins/acceleration/incremental-validation',
  'plugins/acceleration/parallel-executor',
  'plugins/acceleration/patch-first',
  'plugins/acceleration/persistent-tools',
  'plugins/acceleration/reasoning-governor',
  'plugins/acceleration/repo-map',
  'plugins/acceleration/tool-batcher',
  'plugins/acceleration/workspace-isolation',
  // The Mega Core plugin (updateplan/pluginize.md Phase 1): its host half and view model are ESM modules next
  // to a package.json that says so, and its client half is the hand-written browser bundle the loader
  // materialises. All three are product code and all three belong in the gate.
  'plugins/mega-core/lib'
]

/** Files outside the app directory that still ship as product code. */
const EXTRA_FILES = [
  path.join(ROOT, 'scripts', 'check-syntax.cjs'),
  path.join(ROOT, 'scripts', 'acceptance.mjs'),
  path.join(ROOT, 'scripts', 'sub-worker-acceptance.cjs'),
  path.join(ROOT, 'scripts', 'computer-use-acceptance.cjs'),
  // The long-running half of the acceptance harness (Update-Plan/24h.md §23-§26):
  // the accelerated soak, the failure injections and scenarios A-G.
  path.join(ROOT, 'scripts', 'computer-use-longrun-acceptance.cjs'),
  // The Phase 0 baseline harness (Update-Plan/accleration.md): it times the suites
  // and records the metrics every acceleration claim is compared against.
  path.join(ROOT, 'scripts', 'dshns-baseline.cjs'),
  // The combined acceptance run: plugin acceptance A-D plus the engineering
  // completion checklist, with the evidence named for every check.
  path.join(ROOT, 'scripts', 'combined-acceptance.cjs'),
  // The Cordis/DSH community adapter acceptance: the two real community plugins plus a plugin the
  // script writes itself, through the whole install/enable/disable/reload/health/uninstall flow.
  path.join(ROOT, 'scripts', 'cordis-adapter-acceptance.cjs'),
  // The managed-process acceptance: the real dsh-restart-supervisor behind an external companion,
  // with DS-Hns holding nothing but a restart-control capability bridge.
  path.join(ROOT, 'scripts', 'process-adapter-acceptance.cjs'),
  // The unified install pipeline acceptance: a real GitHub fetch, one plugin of each kind, and the
  // refusal plus lifecycle paths.
  path.join(ROOT, 'scripts', 'install-pipeline-acceptance.cjs'),
  // The optional community plugin acceptance: the two real published packages, installed into a real
  // Harness profile from the registry and read back through the adapter layer. It is the one script
  // that answers "do the pinned packages really install", so it is checked like the others.
  path.join(ROOT, 'scripts', 'installer-community-acceptance.cjs'),
  // The stand-in Harness CLI the installer suites drive the real installation channel with.
  path.join(ROOT, 'tests', 'helpers', 'harness-cli-stub.cjs'),
  // The companion the process acceptance runs. It is a fixture, but it is executed, so it is
  // checked like any other program the repository ships.
  path.join(ROOT, 'tests', 'fixtures', 'process', 'restart-companion.mjs')
]

const CHECKED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])

function collect() {
  const files = []
  for (const relative of SOURCE_DIRS) {
    const dir = path.join(APP, relative)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // A missing optional directory must not fail the gate.
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!CHECKED_EXTENSIONS.has(path.extname(entry.name))) continue
      files.push(path.join(dir, entry.name))
    }
  }
  for (const file of EXTRA_FILES) {
    if (fs.existsSync(file)) files.push(file)
  }
  return [...new Set(files)].sort()
}

function main() {
  const files = collect()
  if (!files.length) {
    process.stderr.write('no source files found to check\n')
    return 1
  }
  const failed = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true })
    if (result.status !== 0) failed.push(path.relative(ROOT, file))
  }
  process.stdout.write(`checked ${files.length - failed.length}/${files.length} files\n`)
  if (failed.length) {
    process.stderr.write(`syntax check failed:\n${failed.map((file) => `  ${file}`).join('\n')}\n`)
    return 1
  }
  return 0
}

process.exit(main())
