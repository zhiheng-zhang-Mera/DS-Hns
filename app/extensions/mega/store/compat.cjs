'use strict'

/**
 * The compatibility layer's classification half.
 *
 * The store's first live target was the reason this exists: `zhu1090093659/dsh-web` is an
 * ecosystem of plugins for a *different* DSH host, and refusing it outright was honest but not
 * useful. "Not a `dshns.plugin/v1` plugin" and "not a plugin at all" are different statements,
 * and this module is what tells them apart.
 *
 * What it does is deliberately narrow and entirely offline: it reads a directory that is already
 * on disk — `package.json`, the declared entry, the presence of a build script — and answers one
 * question, *can this be adopted, and what would it need first*. It never runs anything, never
 * installs anything and never writes anything; the installer decides whether to keep the copy and
 * the host decides whether to load it.
 *
 * Three facts about the adopted plugin are recorded and shown to the user rather than smoothed
 * over:
 *
 *   1. **Where it came from.** A compat id is prefixed (`compat.`), so an adopted plugin can never
 *      be mistaken for one that declared the platform's own contract.
 *   2. **What it is missing.** A declared entry that is not in the repository (a TypeScript
 *      package whose `lib/` is built, not committed) is a plugin that needs a build before it can
 *      run, and `npm install` before that. Those are states, not failures.
 *   3. **What it does not get.** A compat plugin is loaded in an isolated process and its
 *      capabilities stay there: the host does not register them, so a compat plugin cannot satisfy
 *      another plugin's requirement. Saying so once, here, keeps every surface honest.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The descriptor a compat plugin is staged with, and the version of the derivation itself. */
const COMPAT_API_VERSION = 'dshns.compat/v1'
const COMPAT_FILE = 'dshns-plugin.compat.json'

/** What the compatibility layer believes the code is. */
const COMPAT_KINDS = Object.freeze({
  /** A package that declares the other DSH host's bundle metadata (the dsh-web ecosystem). */
  DSH_BUNDLE: 'dsh-bundle',
  /** A package with a plain `package.json`, adopted because its entry looks like a plugin. */
  PACKAGE: 'package',
  /** Nothing to adopt: no `package.json` at all. */
  NONE: 'none'
})

/** What the plugin's own API looks like, which is what the adapter has to bridge. */
const COMPAT_APIS = Object.freeze({
  /** Cordis: `export const apply = (ctx, config) => …` / `export { apply, inject }`. */
  CORDIS: 'cordis',
  /** This platform's own API, in a module format `require` cannot read (ESM). */
  DSHNS: 'dshns',
  /** Something else: it may still activate, but nothing is promised. */
  UNKNOWN: 'unknown'
})

/**
 * What has to happen before the plugin can be activated at all.
 *
 * These are states a user can act on, which is why they are distinct: `needs-dependencies` is
 * answered by an install, `needs-build` by a build, and `unsupported` by nothing at all.
 */
const COMPAT_STATES = Object.freeze({
  READY: 'ready',
  NEEDS_DEPENDENCIES: 'needs-dependencies',
  NEEDS_BUILD: 'needs-build',
  UNSUPPORTED: 'unsupported'
})

/**
 * The guarantees a compat plugin does not get.
 *
 * Fixed text rather than a flag, because the point is that the user reads it: a plugin loaded
 * this way is not part of the platform's contract and the panel must say so at the place where
 * the plugin is listed.
 */
const COMPAT_GUARANTEES = Object.freeze({
  cn: [
    '能力不会注册到宿主：兼容插件不能为其它插件提供能力',
    '不保证健康契约：只报告隔离进程是否还活着',
    '不进入产品锁文件，也不随应用一起校验',
    '不会被自动启用：启用始终是一次显式操作'
  ],
  en: [
    'capabilities stay in the isolated process: it cannot satisfy another plugin',
    'no health contract: only whether the isolated process is alive',
    'not part of the lockfile, and never validated with the product',
    'never enabled automatically: enabling is always an explicit act'
  ]
})

const ID_SAFE = /[^a-z0-9._-]+/g

/** Read a JSON file, returning null instead of throwing: half of these files are optional. */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** A plugin id derived from a package name, inside the platform's id alphabet. */
function compatIdFor(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '.')
    .replace(ID_SAFE, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
  return cleaned ? `compat.${cleaned}`.slice(0, 120) : null
}

/** A semantic version, or `0.0.0` when the package does not declare a usable one. */
function semverFor(value) {
  const match = String(value || '').trim().match(/^(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/)
  if (match) return { version: match[1], source: 'package' }
  const loose = String(value || '').trim().match(/^(\d+\.\d+)(?:\.(\d+))?/)
  if (loose) return { version: `${loose[1]}.${loose[2] || 0}`, source: 'package' }
  return { version: '0.0.0', source: 'unknown' }
}

/** A path as a repository writes it: always forward slashes, whatever platform derived it. */
function toPosix(value) {
  return String(value || '').split(path.sep).join('/').replace(/\\/g, '/')
}

/**
 * The entry point a package declares.
 *
 * The order matters and is the one npm itself uses: `main` first, then the root of `exports`
 * (which may be a string, a conditions object, or a nested map), then the conventional names.
 * `source` records which of those was used, because "we guessed" and "the package said so" are
 * different claims when the file turns out to be missing.
 */
function entryFor(dir, pkg) {
  const candidates = []
  if (typeof pkg.main === 'string' && pkg.main.trim()) candidates.push({ value: pkg.main.trim(), source: 'main' })
  const root = pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && pkg.exports['.'] !== undefined
    ? pkg.exports['.']
    : pkg.exports
  const fromExports = (value) => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return null
    for (const key of ['default', 'import', 'require', 'node', 'browser']) {
      const found = fromExports(value[key])
      if (found) return found
    }
    return null
  }
  const exported = fromExports(root)
  if (exported) candidates.push({ value: exported, source: 'exports' })
  for (const name of ['index.js', 'index.mjs', 'index.cjs', 'index.ts']) candidates.push({ value: name, source: 'convention' })

  for (const candidate of candidates) {
    const resolved = path.resolve(dir, candidate.value)
    // An entry that points outside the package is not an entry: a package must not be able to
    // make the host import a file that is not part of it.
    const relative = toPosix(path.relative(dir, resolved))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return { ...candidate, file: relative, exists: true }
    // The declared entry does not exist: remember the *declaration*, not the guess, because a
    // package that declares `lib/index.js` and ships `src/index.ts` needs a build, and the panel
    // has to be able to say exactly that.
    if (candidate.source !== 'convention') return { ...candidate, file: relative, exists: false }
  }
  return { value: null, source: null, file: null, exists: false }
}

/** The module format, from `type`, the entry's extension and the entry's own syntax. */
function formatFor(pkg, entry, entryText) {
  if (entry && /\.mjs$/i.test(entry.file || '')) return 'esm'
  if (entry && /\.cjs$/i.test(entry.file || '')) return 'cjs'
  if (pkg.type === 'module') return 'esm'
  if (entryText && /^\s*(export\s+(default|const|function|class|\{)|import\s+[^\n]+\s+from\s+['"])/m.test(entryText)) return 'esm'
  if (entryText && /module\.exports|exports\.[A-Za-z_$]/.test(entryText)) return 'cjs'
  return pkg.type === 'commonjs' ? 'cjs' : 'unknown'
}

/**
 * Which plugin API the entry exposes.
 *
 * The entry's own text is the strongest evidence, but not the only evidence: a package that ships
 * `cordis.patch.yml` (or declares `dsh.bundle.patch`) *is* a Cordis plugin by construction, and
 * saying "unknown" for it because its built entry happens not to be committed yet would leave the
 * panel unable to say what it is adapting to.
 */
function apiFor(entryText, pkg, markers = []) {
  const markedCordis = markers.includes('cordis.patch.yml') || markers.includes('package.json#dsh.client') || markers.some((marker) => /cordis\.patch\.yml$/.test(marker))
  if (entryText) {
    const cordis = /export\s+(?:const|function|async\s+function)?\s*\{?[^}\n]*\bapply\b/.test(entryText) || /apply\s*[=:(]/.test(entryText)
    const declaresInject = /\binject\b/.test(entryText)
    if (cordis && (declaresInject || /\bctx\b/.test(entryText) || /cordis/i.test(JSON.stringify(pkg.dependencies || {}) + JSON.stringify(pkg.peerDependencies || {}) + JSON.stringify(pkg.devDependencies || {})))) {
      return COMPAT_APIS.CORDIS
    }
    if (/\bmanifest\b/.test(entryText) && /\bload\b/.test(entryText)) return COMPAT_APIS.DSHNS
  }
  return markedCordis ? COMPAT_APIS.CORDIS : COMPAT_APIS.UNKNOWN
}

/** The runtime packages a plugin needs before its entry can even be imported. */
function runtimeDependencies(pkg) {
  const names = Object.keys(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {})
  // Peer dependencies are installed by the consumer in this ecosystem, so they are part of what
  // the plugin needs on disk; dev dependencies are not (they are the build's, not the runtime's).
  const peers = Object.keys(pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {})
  return [...new Set([...names, ...peers].map((name) => String(name).trim()).filter(Boolean))]
}

/**
 * Classify one directory as an adoptable plugin, or say why it is not.
 *
 * @param {string} dir an absolute path that already exists on disk
 * @param {object} [options]
 * @param {string} [options.repo] the source repository, recorded in the descriptor
 * @param {string} [options.branch]
 * @param {string} [options.sourcePath] the package's path inside the repository, when it is a subdirectory
 * @returns {{ok:boolean, code?:string, reason?:string, descriptor?:object}}
 */
function classifyCompatible(dir, options = {}) {
  const root = path.resolve(String(dir || ''))
  let stat = null
  try {
    stat = fs.statSync(root)
  } catch {
    return { ok: false, code: 'COMPAT_NO_DIRECTORY', reason: 'the plugin directory does not exist' }
  }
  if (!stat.isDirectory()) return { ok: false, code: 'COMPAT_NO_DIRECTORY', reason: 'the plugin path is not a directory' }

  const pkg = readJson(path.join(root, 'package.json'))
  if (!pkg) {
    return {
      ok: false,
      code: 'COMPAT_NO_PACKAGE_JSON',
      reason: 'the repository has neither dshns-plugin.json nor package.json, so there is nothing to adopt'
    }
  }

  const id = compatIdFor(pkg.name) || compatIdFor(path.basename(root))
  if (!id) return { ok: false, code: 'COMPAT_NO_ID', reason: 'the package declares no usable name' }

  const entry = entryFor(root, pkg)
  let entryText = null
  if (entry.exists && entry.file) {
    try {
      // Only the head of the file is inspected: the API marker is in the first screen of code,
      // and reading a large bundle to find it would be work for nothing.
      entryText = fs.readFileSync(path.join(root, entry.file), 'utf8').slice(0, 20_000)
    } catch {
      entryText = null
    }
  }

  const format = formatFor(pkg, entry, entryText)
  const nodeModules = fs.existsSync(path.join(root, 'node_modules'))
  const markers = []
  if (pkg.dsh && typeof pkg.dsh === 'object') markers.push('package.json#dsh')
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) markers.push(String(pkg.dsh.bundle.patch))
  if (pkg.dsh && pkg.dsh.client) markers.push('package.json#dsh.client')
  if (fs.existsSync(path.join(root, 'cordis.patch.yml'))) markers.push('cordis.patch.yml')
  if (format === 'esm') markers.push('type: module')
  if (pkg.engines && pkg.engines.dsh) markers.push(`engines.dsh ${pkg.engines.dsh}`)
  const api = apiFor(entryText, pkg, markers)

  const kind = pkg.dsh || markers.includes('cordis.patch.yml') ? COMPAT_KINDS.DSH_BUNDLE : COMPAT_KINDS.PACKAGE
  const dependencies = runtimeDependencies(pkg)
  /**
   * The build *script*, not the command inside it.
   *
   * `npm run` takes a script name, so what has to be recorded is `build`; the command text is kept
   * beside it because that is what the user has to be shown when they are asked to approve running
   * it. The first live run against a real package made this distinction concrete: the package's
   * build script is the command line `tsc -p tsconfig.build.json && tsdown`, and offering
   * `npm run tsc -p …` would have produced a command that cannot work.
   */
  const buildScript = pkg.scripts && typeof pkg.scripts === 'object'
    ? (pkg.scripts.build ? 'build' : pkg.scripts.prepare ? 'prepare' : null)
    : null
  const build = buildScript
  const buildCommand = buildScript ? String(pkg.scripts[buildScript]) : null

  // The states, in the order the user has to resolve them: a missing entry cannot be imported no
  // matter how many dependencies are installed, and dependencies cannot be installed for a
  // package that has no entry at all.
  let state = COMPAT_STATES.READY
  let stateReason = null
  if (!entry.value) {
    state = COMPAT_STATES.UNSUPPORTED
    stateReason = 'the package declares no entry point'
  } else if (!entry.exists) {
    if (build) {
      state = COMPAT_STATES.NEEDS_BUILD
      stateReason = `the declared entry ${entry.file} is not in the repository; the package's \`${build}\` script (\`${buildCommand}\`) produces it`
    } else {
      state = COMPAT_STATES.UNSUPPORTED
      stateReason = `the declared entry ${entry.file} is not in the repository and the package has no build script`
    }
  } else if (dependencies.length && !nodeModules) {
    state = COMPAT_STATES.NEEDS_DEPENDENCIES
    stateReason = `${dependencies.length} runtime dependencies are not installed`
  }

  const semver = semverFor(pkg.version)
  const descriptor = {
    compat_version: COMPAT_API_VERSION,
    id,
    kind,
    name: String(pkg.name || id),
    version: semver.version,
    version_source: semver.source,
    package_version: pkg.version ? String(pkg.version) : null,
    description: pkg.description ? String(pkg.description) : null,
    license: pkg.license ? String(pkg.license) : null,
    format,
    api,
    entry: entry.file,
    entry_declared: entry.value,
    entry_source: entry.source,
    entry_exists: entry.exists,
    dependencies,
    peer_dependencies: Object.keys(pkg.peerDependencies || {}),
    build,
    build_command: buildCommand,
    state,
    state_reason: stateReason,
    markers,
    source: {
      repo: options.repo ? String(options.repo) : null,
      branch: options.branch ? String(options.branch) : null,
      path: options.sourcePath ? toPosix(options.sourcePath) : null
    },
    guarantees: { cn: [...COMPAT_GUARANTEES.cn], en: [...COMPAT_GUARANTEES.en] },
    // The manifest the platform's manager is handed. It is a *real* `dshns.plugin/v1` manifest so
    // that every existing surface treats an adopted plugin as a plugin; compatibility is metadata
    // beside it, never a second kind of entry in the manager.
    manifest: {
      api_version: 'dshns.plugin/v1',
      id,
      name: String(pkg.name || id),
      version: semver.version,
      description: pkg.description ? String(pkg.description) : `compatibility-mode plugin from ${options.repo || 'a local directory'}`,
      provides: [],
      requires_capabilities: [],
      optional_capabilities: [],
      conflicts: [],
      default_enabled: false,
      hot_reload: false,
      model_specific: false,
      fault_level: 'soft',
      entry: null,
      config: {}
    }
  }
  return { ok: true, descriptor }
}

/** Read a descriptor written by a previous stage, validating the parts the host depends on. */
function readCompatDescriptor(dir) {
  const file = path.join(path.resolve(String(dir || '')), COMPAT_FILE)
  const raw = readJson(file)
  if (!raw) return null
  if (raw.compat_version !== COMPAT_API_VERSION) return null
  if (!raw.id || !raw.manifest || typeof raw.manifest !== 'object') return null
  return raw
}

module.exports = {
  COMPAT_API_VERSION,
  COMPAT_FILE,
  COMPAT_KINDS,
  COMPAT_APIS,
  COMPAT_STATES,
  COMPAT_GUARANTEES,
  compatIdFor,
  semverFor,
  classifyCompatible,
  readCompatDescriptor
}
