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
  // Dual-UI (Update-Plan/Dual-UI.md): the frontend-mode runtime and the native
  // frontend. Listed explicitly because this collector is non-recursive by
  // design - a new file must be added here, or the directory it lives in must
  // be, or it silently escapes the gate.
  'frontend-mode',
  'native-ui',
  'native-ui/components',
  'native-ui/state',
  'extensions',
  'extensions/mega/autonomy',
  'extensions/mega/billing',
  'extensions/mega/deepseek',
  'extensions/mega/dock',
  'extensions/mega/notifications',
  'extensions/mega/scheduler',
  'extensions/mega/settings',
  'extensions/mega/skills',
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
  'core/capability-registry',
  'core/event-bus',
  'core/config-manager',
  'core/lockfile',
  'core/resource-manager',
  'core/health-supervisor',
  // The provider that carries the DeepSeek-specific knowledge, so no generic
  // plugin has to.
  'plugins/providers/deepseek',
  // The mounted feature set: the plugins that wrap the subsystems which already
  // exist. Listed because the collector is non-recursive.
  'plugins/mounted',
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
  'plugins/acceleration/workspace-isolation'
]

/** Files outside the app directory that still ship as product code. */
const EXTRA_FILES = [
  path.join(ROOT, 'scripts', 'check-syntax.cjs'),
  path.join(ROOT, 'scripts', 'acceptance.mjs'),
  path.join(ROOT, 'scripts', 'dual-ui-acceptance.mjs'),
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
  path.join(ROOT, 'scripts', 'combined-acceptance.cjs')
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
