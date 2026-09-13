'use strict'

/**
 * The two actions a compatibility-mode plugin may need before it can run, and the rule that
 * neither of them happens on its own.
 *
 * A compat plugin is somebody else's package, and a package that declares `schemastery` needs it
 * installed; one whose `lib/` is built rather than committed needs a build. Both are real work on
 * the user's machine, both run third-party code, and neither is something the product may do
 * because it decided to.
 *
 * So this module only ever *describes* the command, in full, for a confirmation dialog: the exact
 * executable, the exact arguments, the directory and whether lifecycle scripts are enabled. The
 * running half takes an explicit `confirm: true`, and every package name is validated first — a
 * name from a package.json is attacker-controlled input the moment a plugin is adopted, and a
 * shell is exactly what must not be involved.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * A package name npm would accept, and nothing that could be read as a flag or a path.
 *
 * The first character has to be alphanumeric: a leading `-` is how `npm install --force` becomes a
 * different command than the one the dialog showed, and this list comes from a package.json that
 * belongs to somebody else.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i

const DEP_REASONS = Object.freeze({
  BAD_PACKAGE: 'COMPAT_BAD_PACKAGE_NAME',
  NO_PACKAGES: 'COMPAT_NO_PACKAGES',
  BAD_DIRECTORY: 'COMPAT_BAD_DIRECTORY',
  RUN_FAILED: 'COMPAT_RUN_FAILED',
  NOT_CONFIRMED: 'COMPAT_NOT_CONFIRMED'
})

/** The package manager this package was set up with, from what is on disk beside it. */
function managerFor(dir) {
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (fs.existsSync(path.join(dir, file))) return 'pnpm'
  }
  for (const file of ['yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']) {
    if (fs.existsSync(path.join(dir, file))) return file.startsWith('yarn') ? 'yarn' : 'npm'
  }
  return 'npm'
}

/** The packages a descriptor asks for, filtered to the ones that are safe to pass as arguments. */
function validatePackages(packages) {
  const accepted = []
  const rejected = []
  for (const entry of Array.isArray(packages) ? packages : []) {
    const name = String(entry || '').trim()
    if (!name) continue
    if (!PACKAGE_NAME.test(name)) rejected.push(name)
    else accepted.push(name)
  }
  return { accepted: [...new Set(accepted)], rejected }
}

/**
 * The exact install command, for a dialog.
 *
 * Lifecycle scripts stay off unless the caller asks for them: a third-party `postinstall` is the
 * single most dangerous thing in this flow, and the product's default is to run none of them.
 * `--ignore-scripts` is stated in the description so the dialog is not ambiguous about it.
 */
function describeInstall(input = {}) {
  const dir = String(input.dir || '')
  if (!dir || !fs.existsSync(dir)) return { ok: false, code: DEP_REASONS.BAD_DIRECTORY, reason: 'the plugin directory does not exist' }
  const { accepted, rejected } = validatePackages(input.packages)
  if (rejected.length) {
    return { ok: false, code: DEP_REASONS.BAD_PACKAGE, reason: `${rejected.join(', ')} ${rejected.length === 1 ? 'is not a package name' : 'are not package names'}`, rejected }
  }
  if (!accepted.length) return { ok: false, code: DEP_REASONS.NO_PACKAGES, reason: 'nothing is missing, so there is nothing to install' }
  const manager = String(input.manager || managerFor(dir))
  const scripts = input.scripts === true
  const args = manager === 'yarn'
    ? ['add', ...(scripts ? [] : ['--ignore-scripts']), ...accepted]
    : manager === 'pnpm'
      ? ['add', ...(scripts ? [] : ['--ignore-scripts']), ...accepted]
      : ['install', ...(scripts ? [] : ['--ignore-scripts']), '--no-audit', '--no-fund', ...accepted]
  return {
    ok: true,
    action: 'install',
    manager,
    command: [manager, ...args],
    display: `${manager} ${args.join(' ')}`,
    cwd: dir,
    packages: accepted,
    scripts,
    note: scripts
      ? 'lifecycle scripts are ENABLED for this run'
      : 'lifecycle scripts are disabled (--ignore-scripts)'
  }
}

/**
 * Install everything the package declares, which is what a build needs.
 *
 * A build runs the package's own toolchain out of its dev dependencies, so this is the one command
 * in this module where lifecycle scripts are enabled by default: `tsdown`, `tsc` and friends are
 * reached through scripts, and a toolchain install without them produces a build that fails for a
 * reason that has nothing to do with the plugin. The dialog says so.
 */
function describeFullInstall(input = {}) {
  const dir = String(input.dir || '')
  if (!dir || !fs.existsSync(dir)) return { ok: false, code: DEP_REASONS.BAD_DIRECTORY, reason: 'the plugin directory does not exist' }
  const manager = String(input.manager || managerFor(dir))
  const args = manager === 'yarn'
    ? ['install']
    : manager === 'pnpm'
      ? ['install']
      : ['install', '--no-audit', '--no-fund']
  return {
    ok: true,
    action: 'install-all',
    manager,
    command: [manager, ...args],
    display: `${manager} ${args.join(' ')}`,
    cwd: dir,
    packages: [],
    scripts: true,
    note: 'installs every declared dependency, including the build toolchain, with lifecycle scripts enabled'
  }
}

/** The exact build command, for the same dialog: a package whose built entry is not committed. */
function describeBuild(input = {}) {
  const dir = String(input.dir || '')
  if (!dir || !fs.existsSync(dir)) return { ok: false, code: DEP_REASONS.BAD_DIRECTORY, reason: 'the plugin directory does not exist' }
  const script = String(input.script || '').trim()
  if (!script) return { ok: false, code: DEP_REASONS.NO_PACKAGES, reason: 'the package declares no build script' }
  const manager = String(input.manager || managerFor(dir))
  // `npm run` takes a *script name*: the command inside the script is what the user is shown, but
  // what is executed is the name, because interpolating a command line here would be a shell.
  const args = manager === 'yarn' ? [script] : ['run', script]
  const inner = input.command ? String(input.command).trim() : null
  return {
    ok: true,
    action: 'build',
    manager,
    command: [manager, ...args],
    display: `${manager} ${args.join(' ')}`,
    cwd: dir,
    script,
    commandInner: inner,
    // A build genuinely needs the dev dependencies and their scripts, so this one says so.
    scripts: true,
    note: inner
      ? `a build runs the package's own toolchain: \`${inner}\`, including its install and build scripts`
      : 'a build runs the package\'s own toolchain, including its install and build scripts'
  }
}

/**
 * Run a described command.
 *
 * `shell: false` and an argv array: nothing from a package.json is ever handed to a shell. The
 * caller must have asked the user first — this function is the second half of a decision the
 * confirmation dialog made, which is why it insists on the confirmation being passed along rather
 * than trusting the caller to have shown one.
 */
function runDescribed(plan, input = {}) {
  if (!plan || plan.ok !== true) return plan || { ok: false, code: DEP_REASONS.RUN_FAILED, reason: 'no command was described' }
  if (input.confirm !== true) {
    return { ok: false, code: DEP_REASONS.NOT_CONFIRMED, reason: 'the user has not confirmed this command', plan }
  }
  const [executable, ...args] = plan.command
  const started = Date.now()
  let result = null
  try {
    result = spawnSync(executable, args, {
      cwd: plan.cwd,
      shell: false,
      windowsHide: true,
      timeout: Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A local registry mirror or a cache directory in the environment must survive, but nothing
      // from the plugin is exported into the command's environment.
      env: { ...process.env }
    })
  } catch (error) {
    return { ok: false, code: DEP_REASONS.RUN_FAILED, reason: String((error && error.message) || error), plan }
  }
  const ok = result.status === 0
  return {
    ok,
    code: ok ? null : DEP_REASONS.RUN_FAILED,
    action: plan.action,
    command: plan.display,
    cwd: plan.cwd,
    status: result.status,
    ms: Date.now() - started,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || result.error?.message || '').slice(-4000),
    reason: ok ? null : `\`${plan.display}\` exited with ${result.status === null ? 'a timeout or a signal' : result.status}`
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEP_REASONS,
  PACKAGE_NAME,
  managerFor,
  validatePackages,
  describeInstall,
  describeFullInstall,
  describeBuild,
  runDescribed
}
