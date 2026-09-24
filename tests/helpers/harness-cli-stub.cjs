'use strict'

/**
 * A stand-in for the DeepSeek Harness' own plugin CLI, for tests.
 *
 * The installer never installs a plugin itself: it calls `dsh plugin --profile <name> add <spec>`
 * (`app/extensions/mega/plugins/community-install-cli.cjs`, which mirrors
 * `installPinnedPlugin` in the running product). That means the *installation channel* can be
 * exercised without a network, a registry or a multi-hundred-megabyte Harness install, by handing
 * the installer this program instead of `@deepseek-ai/dsh/lib/bin.js`.
 *
 * It does what the real CLI does for the two commands that matter here, and nothing else:
 *
 *   * `plugin --profile <name> add <spec>` — writes `<spec>` into the profile's `dependencies` and
 *     materialises the package into the profile's `node_modules`. The package contents come from the
 *     fixture directory named by `--fixture`, which is how a test decides whether the adapter layer
 *     will recognise the result.
 *   * `plugin --profile <name> remove <spec>` — the reverse, so removal can be exercised too.
 *
 * It also fails on demand, which is the other half of what the installer has to survive:
 *
 *   * `--fail-with <code>` — exit with that code and a message on stderr, exactly as a refused
 *     `pnpm add` or an unreachable registry does.
 *   * `--sleep <ms>` — do nothing for that long, for a caller that wants to test a timeout.
 *
 * Usage (the arguments are appended to the two the real CLI takes):
 *
 *   node tests/helpers/harness-cli-stub.cjs plugin --profile web add pkg@1.0.0 \
 *     --home <DSH_HOME> --fixture <directory>
 */

const fs = require('node:fs')
const path = require('node:path')

function parse(argv) {
  const args = { command: argv[0] || '', flags: {}, positional: [] }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--profile') {
      args.profile = String(argv[index + 1] || '')
      index += 1
    } else if (arg.startsWith('--profile=')) {
      args.profile = arg.slice('--profile='.length)
    } else if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split('=')
      args.flags[name] = value === undefined ? true : value
    } else {
      args.positional.push(arg)
    }
  }
  return args
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** The package name inside a `name@version` spec, including a scoped name. */
function packageNameOf(spec) {
  const text = String(spec || '')
  const at = text.lastIndexOf('@')
  return at > 0 ? text.slice(0, at) : text
}

/**
 * The package a spec names, and the version to record for it.
 *
 * A `file:` spec is what the installer uses for the plugin DS-Hns ships into the profile
 * (`file:<absolute path>`), and pnpm records it exactly as written. Its package name is not in the
 * spec at all — it is in the manifest the path points at, which is why this reads it rather than
 * guessing from the path.
 */
function resolveSpec(spec, { fixture }) {
  const text = String(spec || '')
  if (/^file:/i.test(text)) {
    const dir = text.slice('file:'.length).replace(/\//g, path.sep)
    const manifest = readJson(path.join(dir, 'package.json'))
    return { name: manifest && manifest.name ? String(manifest.name) : path.basename(dir), version: text, source: dir, kind: 'file' }
  }
  const name = packageNameOf(text)
  return { name, version: text.slice(name.length + 1) || '0.0.0', source: fixture || '', kind: 'registry' }
}

function main(argv) {
  const args = parse(argv)
  const home = String(args.flags.home || process.env.DSH_HOME || '')
  const profile = String(args.profile || 'web')
  const failWith = Number(args.flags['fail-with'])
  const sleep = Number(args.flags.sleep)

  if (Number.isFinite(sleep) && sleep > 0) {
    // Synchronous on purpose: the caller's own timeout is the thing under test.
    const until = Date.now() + sleep
    while (Date.now() < until) {
      /* spin */
    }
  }
  if (Number.isFinite(failWith) && failWith !== 0) {
    process.stderr.write(`harness-cli-stub: refusing (exit ${failWith})\n`)
    process.exit(failWith)
  }
  if (args.command !== 'plugin') {
    process.stderr.write(`harness-cli-stub: only "plugin" is implemented, got "${args.command}"\n`)
    process.exit(1)
  }

  const action = args.positional[0]
  const spec = args.positional[1] || ''
  const profileDir = path.join(home, 'profiles', profile)
  const modulesDir = path.join(profileDir, 'node_modules')
  const fixture = args.flags.fixture ? String(args.flags.fixture) : ''
  const resolved = resolveSpec(spec, { fixture })
  const packageName = resolved.name
  const packageDir = path.join(modulesDir, ...packageName.split('/'))

  if (action === 'add') {
    const manifestFile = path.join(profileDir, 'package.json')
    const manifest = readJson(manifestFile) || { name: `dsh-profile-${profile}`, private: true }
    manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    manifest.dependencies[packageName] = resolved.version
    manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
    manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
    if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
    writeJson(manifestFile, manifest)

    // A `file:` spec materialises what the path holds; a registry spec materialises the fixture the
    // caller named, so a test decides what the adapter layer will see.
    const source = resolved.kind === 'file' ? resolved.source : fixture
    if (source && fs.existsSync(source)) {
      fs.rmSync(packageDir, { recursive: true, force: true })
      fs.mkdirSync(packageDir, { recursive: true })
      fs.cpSync(source, packageDir, { recursive: true })
    } else if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
      writeJson(path.join(packageDir, 'package.json'), { name: packageName, version: resolved.version })
    }
    process.stdout.write(`harness-cli-stub: added ${packageName} (${resolved.version}) to ${profileDir}\n`)
    return 0
  }

  if (action === 'remove') {
    const manifestFile = path.join(profileDir, 'package.json')
    const manifest = readJson(manifestFile)
    if (manifest && manifest.dependencies && manifest.dependencies[packageName] !== undefined) {
      delete manifest.dependencies[packageName]
      writeJson(manifestFile, manifest)
    }
    fs.rmSync(packageDir, { recursive: true, force: true })
    process.stdout.write(`harness-cli-stub: removed ${packageName}\n`)
    return 0
  }

  process.stderr.write(`harness-cli-stub: only "add" and "remove" are implemented, got "${action}"\n`)
  return 1
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { main, parse, packageNameOf, resolveSpec }
