'use strict'

/**
 * Engineering Runtime: repository discovery and fingerprinting.
 *
 * Before the runtime changes anything it has to know what it is standing in:
 * which repository, on which branch, at which commit, with which dirt, and which
 * commands the project itself declares. Two rules shape this module.
 *
 *  1. **The workspace is explicit.** `process.cwd()` never becomes a project root
 *     by accident: the caller names a repository, the path is canonicalised and
 *     then *verified* to be a directory (and, when git is available, a repository
 *     root). A path that cannot be verified is a refusal, not a guess.
 *  2. **Dirt is data, not noise.** Files the user had already modified before the
 *     episode are recorded in the baseline snapshot so the runtime can tell its
 *     own changes from the user's and never overwrite the latter.
 *
 * Everything here is read-only: it inspects, it never mutates. The snapshot is a
 * short-lived object for one episode, and the fingerprint exists to detect that
 * the world moved underneath the runtime — it is not a learned profile.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

/** Manifest files whose presence identifies a project type. */
const MANIFEST_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'gradlew',
  'CMakeLists.txt', 'Makefile', 'makefile',
  '*.sln', '*.csproj'
])

/** Files that carry engineering instructions, in the precedence the plan states. */
const INSTRUCTION_FILES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'README.md',
  'README',
  'CODE_OF_CONDUCT.md'
])

/** CI definitions that name the real acceptance commands. */
const CI_FILES = Object.freeze([
  '.github/workflows',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.circleci/config.yml'
])

const DEFAULT_MAX_READ_BYTES = 256 * 1024

/**
 * Canonicalise and verify a repository path.
 *
 * @param {string} candidate
 * @param {object} [options]
 * @param {boolean} [options.requireGit] refuse when the path is not a git work tree
 * @returns {{ok:boolean, path:string|null, reason:string|null, gitRoot:string|null, canonical:boolean}}
 */
function verifyWorkspace(candidate, options = {}) {
  if (candidate === undefined || candidate === null || String(candidate).trim() === '') {
    return { ok: false, path: null, reason: 'no repository path was given', gitRoot: null, canonical: false }
  }
  const requested = path.resolve(String(candidate))
  let stats
  try {
    stats = fs.statSync(requested)
  } catch (error) {
    return { ok: false, path: null, reason: `the repository path is not accessible: ${error && error.message ? error.message : error}`, gitRoot: null, canonical: false }
  }
  if (!stats.isDirectory()) {
    return { ok: false, path: null, reason: `the repository path is not a directory: ${requested}`, gitRoot: null, canonical: false }
  }
  // `realpath` removes junctions, symlinks and 8.3 short names, so the same
  // repository always fingerprints the same way.
  let canonical = requested
  try {
    canonical = fs.realpathSync(requested)
  } catch {
    /* the resolved path is still usable */
  }
  const git = gitInfo(canonical)
  if (options.requireGit === true && !git.available) {
    return { ok: false, path: canonical, reason: `${canonical} is not a git work tree`, gitRoot: git.root, canonical: canonical !== requested }
  }
  return { ok: true, path: canonical, reason: null, gitRoot: git.root, canonical: canonical !== requested }
}

/**
 * Run one git command inside a workspace. Never throws: an unavailable git is a
 * reported fact, because a project without git is still a project.
 *
 * @returns {{ok:boolean, stdout:string, stderr:string, code:number|null, available:boolean}}
 */
function git(args, cwd, options = {}) {
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: Number.isFinite(options.maxBuffer) ? options.maxBuffer : 4 * 1024 * 1024
    })
    return {
      ok: result.status === 0,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      code: result.status,
      available: result.error === undefined || result.error === null
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error && error.message ? error.message : error), code: null, available: false }
  }
}

/** Is this a git work tree, and where is its root? */
function gitInfo(cwd) {
  const inside = git(['rev-parse', '--is-inside-work-tree'], cwd)
  if (!inside.available || !inside.ok || inside.stdout.trim() !== 'true') {
    return { available: false, root: null, reason: inside.available ? 'not a git work tree' : 'git is not available' }
  }
  const root = git(['rev-parse', '--show-toplevel'], cwd)
  return { available: true, root: root.ok ? path.resolve(root.stdout.trim()) : path.resolve(cwd), reason: null }
}

/**
 * The git state the runtime has to know about: which branch, which commit, what
 * is dirty, and whether HEAD is detached. Read-only on purpose — nothing in the
 * runtime may reset, clean or force-push without an explicit contract.
 */
function gitState(cwd) {
  const info = gitInfo(cwd)
  if (!info.available) {
    return {
      available: false,
      reason: info.reason,
      branch: null,
      head: null,
      detached: false,
      clean: null,
      modified: [],
      staged: [],
      untracked: [],
      conflicted: [],
      remotes: [],
      ahead: null,
      behind: null
    }
  }
  const root = info.root || cwd
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const head = git(['rev-parse', 'HEAD'], root)
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], root)
  const remotes = git(['remote', '-v'], root)
  const parsed = parsePorcelain(status.stdout)
  return {
    available: true,
    reason: null,
    root,
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    detached: branch.ok ? branch.stdout.trim() === 'HEAD' : false,
    clean: parsed.modified.length === 0 && parsed.staged.length === 0 && parsed.untracked.length === 0 && parsed.conflicted.length === 0,
    modified: parsed.modified,
    staged: parsed.staged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    remotes: remotes.ok ? remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
  }
}

/**
 * Parse `git status --porcelain=v1` into the four states the runtime acts on.
 *
 * The format is `XY path`, where X is the index and Y the work tree. `??` is
 * untracked, `UU`/`AA`/`DD` are conflicts, and a non-space X or Y is a change in
 * that side. Renames carry a second path, which is kept.
 */
function parsePorcelain(text) {
  const modified = []
  const staged = []
  const untracked = []
  const conflicted = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const x = line[0]
    const y = line[1]
    let file = line.slice(3).trim()
    if (file.includes(' -> ')) file = file.split(' -> ')[1].trim()
    if (x === '?' && y === '?') {
      untracked.push(file)
      continue
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicted.push(file)
      continue
    }
    if (x !== ' ' && x !== '?') staged.push(file)
    if (y !== ' ' && y !== '?') modified.push(file)
  }
  return { modified, staged, untracked, conflicted }
}

/** A short, stable hash of a value: used for fingerprints, never for security. */
function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** Hash the content of one file, or null when it cannot be read. */
function hashFile(file) {
  try {
    return shortHash(fs.readFileSync(file))
  } catch {
    return null
  }
}

/** The manifest and lock files present at the repository root. */
function manifestFiles(root) {
  const found = []
  for (const name of MANIFEST_FILES) {
    if (name.includes('*')) {
      const extension = name.replace('*', '')
      try {
        for (const entry of fs.readdirSync(root)) {
          if (entry.endsWith(extension)) found.push(entry)
        }
      } catch {
        /* unreadable root is reported by the caller */
      }
      continue
    }
    if (fs.existsSync(path.join(root, name))) found.push(name)
  }
  return [...new Set(found)].sort()
}

/**
 * A light fingerprint of the repository.
 *
 * It answers "did the world move?" — a different commit, a different branch, a
 * different set of dirty files, a different manifest — and nothing else. It is
 * recomputed, never remembered, and it is discarded with the episode.
 *
 * @param {object} input
 * @param {string} input.root the verified repository root
 * @param {object} [input.gitState] a pre-computed git state (avoids a second call)
 */
function fingerprint(input = {}) {
  const root = input.root
  const state = input.gitState || gitState(root)
  const dirtyFiles = [...state.modified, ...state.staged, ...state.untracked, ...state.conflicted].sort()
  const manifests = manifestFiles(root)
  const manifestHashes = {}
  for (const name of manifests) manifestHashes[name] = hashFile(path.join(root, name))
  const testConfigs = ['jest.config.js', 'jest.config.cjs', 'vitest.config.js', 'vitest.config.ts', 'pytest.ini', 'tox.ini', 'phpunit.xml']
  const testConfigHashes = {}
  for (const name of testConfigs) {
    const file = path.join(root, name)
    if (fs.existsSync(file)) testConfigHashes[name] = hashFile(file)
  }
  return {
    at: input.now === undefined ? null : input.now,
    branch: state.branch,
    head: state.head,
    detached: state.detached,
    dirtyFiles,
    dirtyHash: shortHash(dirtyFiles.map((file) => `${file}:${hashFile(path.join(root, file)) || 'gone'}`).join('|')),
    manifestHash: shortHash(JSON.stringify(manifestHashes)),
    manifestHashes,
    testConfigHash: shortHash(JSON.stringify(testConfigHashes)),
    testConfigHashes,
    untracked: state.untracked.slice(),
    remoteCount: state.remotes.length
  }
}

/** Compare two fingerprints and name what moved. */
function diffFingerprint(previous, current) {
  if (!previous) return { drifted: false, reasons: [] }
  const reasons = []
  if (previous.head !== current.head) reasons.push(`HEAD moved: ${previous.head} -> ${current.head}`)
  if (previous.branch !== current.branch) reasons.push(`branch changed: ${previous.branch} -> ${current.branch}`)
  if (previous.dirtyHash !== current.dirtyHash) reasons.push('the working tree changed')
  if (previous.manifestHash !== current.manifestHash) reasons.push('a manifest or lockfile changed')
  if (previous.testConfigHash !== current.testConfigHash) reasons.push('the test configuration changed')
  return { drifted: reasons.length > 0, reasons }
}

/** Read one text file, bounded. */
function readTextFile(file, maxBytes = DEFAULT_MAX_READ_BYTES) {
  try {
    const buffer = fs.readFileSync(file)
    const slice = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer
    return { ok: true, text: slice.toString('utf8'), truncated: buffer.length > maxBytes, bytes: buffer.length }
  } catch (error) {
    return { ok: false, text: '', truncated: false, bytes: 0, reason: String(error && error.message ? error.message : error) }
  }
}

/** The CI definitions present, with their workflow files. */
function ciDefinitions(root) {
  const found = []
  for (const relative of CI_FILES) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    const stats = fs.statSync(file)
    if (stats.isDirectory()) {
      try {
        for (const entry of fs.readdirSync(file)) {
          if (/\.ya?ml$/i.test(entry)) found.push(path.posix.join(relative.split(path.sep).join('/'), entry))
        }
      } catch {
        /* unreadable directory */
      }
    } else {
      found.push(relative.split(path.sep).join('/'))
    }
  }
  return found.sort()
}

/**
 * Build the repository snapshot one episode starts from.
 *
 * @param {object} input
 * @param {string} input.root the verified repository root
 * @param {Function} [input.now]
 * @returns {object} `{ root, git, fingerprint, manifests, instructions, ci, packageScripts }`
 */
function snapshot(input = {}) {
  const root = input.root
  const state = gitState(root)
  const manifests = manifestFiles(root)
  const instructions = []
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const read = readTextFile(file)
    instructions.push({ file: name, bytes: read.bytes, truncated: read.truncated, excerpt: summarizeText(read.text) })
  }
  for (const dir of ['docs']) {
    const file = path.join(root, dir)
    if (!fs.existsSync(file)) continue
    try {
      for (const entry of fs.readdirSync(file)) {
        if (!/\.md$/i.test(entry)) continue
        const target = path.join(file, entry)
        const read = readTextFile(target)
        instructions.push({ file: `${dir}/${entry}`, bytes: read.bytes, truncated: read.truncated, excerpt: summarizeText(read.text) })
      }
    } catch {
      /* docs are optional */
    }
  }
  return {
    root,
    at: typeof input.now === 'function' ? input.now() : null,
    git: state,
    fingerprint: fingerprint({ root, gitState: state, now: typeof input.now === 'function' ? input.now() : null }),
    manifests,
    instructions,
    ci: ciDefinitions(root),
    packageScripts: packageScripts(root)
  }
}

/** The `scripts` block of a package.json, when there is one. */
function packageScripts(root) {
  const file = path.join(root, 'package.json')
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? { ...parsed.scripts } : null
  } catch {
    return null
  }
}

/**
 * A short, bounded excerpt of a long document.
 *
 * The runtime never carries a whole README into its context: it carries the head,
 * and it says how much it left out. That is the difference between "the summary"
 * and "the file".
 */
function summarizeText(text, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 2_000
  const source = String(text || '')
  if (source.length <= limit) return source.trim()
  return `${source.slice(0, limit).trim()}\n[... ${source.length - limit} more characters]`
}

module.exports = {
  MANIFEST_FILES,
  INSTRUCTION_FILES,
  CI_FILES,
  verifyWorkspace,
  gitInfo,
  gitState,
  parsePorcelain,
  fingerprint,
  diffFingerprint,
  shortHash,
  hashFile,
  manifestFiles,
  ciDefinitions,
  packageScripts,
  summarizeText,
  snapshot
}
