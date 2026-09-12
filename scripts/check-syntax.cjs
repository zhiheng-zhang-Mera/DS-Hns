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
  'sub-worker'
]

/** Files outside the app directory that still ship as product code. */
const EXTRA_FILES = [
  path.join(ROOT, 'scripts', 'check-syntax.cjs'),
  path.join(ROOT, 'scripts', 'acceptance.mjs'),
  path.join(ROOT, 'scripts', 'sub-worker-acceptance.cjs')
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
