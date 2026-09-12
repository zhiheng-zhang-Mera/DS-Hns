'use strict'

/**
 * Skill sources: turn a user-supplied location into something installable.
 *
 * Two kinds of source are supported, matching how people actually share skills:
 *
 *   local      a directory bundle, a `SKILL.md`, a flat `<name>.md`, or a folder
 *              that contains several skills (all of them are offered)
 *   github     a repository URL, a `/tree/<ref>/<dir>` URL, a `/blob/<ref>/…/SKILL.md`
 *              URL, a `raw.githubusercontent.com` URL, or a bare `owner/repo`
 *
 * Both resolve through the same tiered scanner, so a directory installed from disk
 * and the same directory downloaded as a repository archive can never disagree
 * about which of its files are the skills.
 *
 * Every network read goes through one injectable `fetchBuffer`, so the whole
 * module is testable offline and the installer never reaches the network by
 * accident.
 */
const fs = require('node:fs')
const path = require('node:path')

const format = require('./skill-format')
const tar = require('./tar')

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const RAW_HOSTS = new Set(['raw.githubusercontent.com'])
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024

/**
 * Directory names that are scaffolding rather than a skill. A repository that
 * ships a starter `template/SKILL.md` beside its real `skills/` collection must
 * not have the template installed instead of the collection.
 */
const SCAFFOLD_DIRS = new Set([
  'template', 'templates', 'example', 'examples', 'sample', 'samples',
  'spec', 'specs', 'docs', 'doc', 'test', 'tests', 'fixtures', 'fixture'
])

/**
 * Parse any supported GitHub reference.
 *
 * @param {string} input
 * @returns {{ok: true, ref: object} | {ok: false, reason: string}}
 */
function parseGithubReference(input) {
  const text = String(input || '').trim()
  if (!text) return { ok: false, reason: 'empty reference' }

  // `owner/repo` shorthand, optionally with `@ref` and a `/sub/path`.
  if (!/^https?:\/\//i.test(text) && !text.includes(':')) {
    const at = text.indexOf('@')
    const repoPart = at === -1 ? text : text.slice(0, at)
    const rest = at === -1 ? '' : text.slice(at + 1)
    const shorthand = repoPart.match(/^([\w.-]+)\/([\w.-]+)$/)
    if (!shorthand) return { ok: false, reason: 'not a recognised GitHub reference' }
    // `@ref/sub/path`: a branch name may contain slashes, so prefer the split
    // that treats the first segment as the ref (the overwhelmingly common case)
    // and let the installer recover if the archive for it does not exist.
    let branch = null
    let subpath = null
    if (rest) {
      const segments = rest.replace(/^\/+/, '').split('/').filter(Boolean)
      branch = segments.shift() || null
      subpath = segments.length ? normalizeSubpath(segments.join('/')) : null
    }
    return {
      ok: true,
      ref: {
        kind: 'repo',
        owner: shorthand[1],
        repo: shorthand[2].replace(/\.git$/, ''),
        branch,
        subpath,
        url: `https://github.com/${shorthand[1]}/${shorthand[2]}`
      }
    }
  }

  // `git@github.com:owner/repo.git` — the form people copy from a clone dialog.
  const scp = text.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (scp) {
    return {
      ok: true,
      ref: { kind: 'repo', owner: scp[1], repo: scp[2], branch: null, subpath: null, url: `https://github.com/${scp[1]}/${scp[2]}` }
    }
  }

  let parsed = null
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'only http(s) URLs are supported' }
  }

  const host = parsed.hostname.toLowerCase()

  if (RAW_HOSTS.has(host)) {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 4) return { ok: false, reason: 'incomplete raw.githubusercontent.com URL' }
    return {
      ok: true,
      ref: {
        kind: 'rawFile',
        owner: segments[0],
        repo: segments[1],
        branch: segments[2],
        subpath: normalizeSubpath(segments.slice(3).join('/')),
        url: parsed.href
      }
    }
  }

  if (!GITHUB_HOSTS.has(host)) {
    // Any other http(s) URL is treated as a directly downloadable skill file.
    return { ok: true, ref: { kind: 'url', url: parsed.href } }
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return { ok: false, reason: 'GitHub URL must reference a repository' }
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')

  if (segments.length === 2) {
    return { ok: true, ref: { kind: 'repo', owner, repo, branch: null, subpath: null, url: `https://github.com/${owner}/${repo}` } }
  }

  const mode = segments[2]
  if (mode === 'tree' || mode === 'blob') {
    // The ref may itself contain slashes, so the longest prefix that is not part
    // of a path is unknowable offline. `resolveArchive` disambiguates by probing.
    const rest = segments.slice(3)
    if (!rest.length) return { ok: false, reason: `GitHub ${mode} URL is missing a ref` }
    return {
      ok: true,
      ref: {
        kind: mode === 'blob' ? 'blobFile' : 'treeDir',
        owner,
        repo,
        refCandidates: refCandidates(rest),
        url: parsed.href
      }
    }
  }

  if (mode === 'releases' && segments[3] === 'download') {
    return { ok: true, ref: { kind: 'url', url: parsed.href } }
  }

  return { ok: false, reason: `unsupported GitHub URL form "/${mode}/"; use a repository, /tree/, /blob/ or a raw link` }
}

/** Candidate (ref, subpath) splits, longest ref first. */
function refCandidates(rest) {
  const candidates = []
  for (let index = rest.length; index >= 1; index -= 1) {
    candidates.push({
      branch: rest.slice(0, index).join('/'),
      subpath: rest.length > index ? normalizeSubpath(rest.slice(index).join('/')) : null
    })
  }
  return candidates
}

function normalizeSubpath(value) {
  let text = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

/** Ordered archive URLs to try for a repository reference. */
function archiveUrls(ref) {
  const base = `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz`
  const urls = []
  if (ref.branch) urls.push(`${base}/refs/heads/${encodeURIComponent(ref.branch)}`)
  urls.push(`${base}/refs/heads/main`, `${base}/refs/heads/master`)
  if (ref.branch && !refsAsBranch(ref.branch)) urls.push(`${base}/${encodeURIComponent(ref.branch)}`)
  return [...new Set(urls)]
}

function refsAsBranch(branch) {
  return branch === 'main' || branch === 'master'
}

/**
 * Locate skill bundles under one directory, most specific answer only.
 *
 * People share a skill in every one of these shapes, and the shapes are strictly
 * ordered because picking the wrong one is silent: installing a repository's
 * starter `template/` instead of the nineteen skills beside it looks like success.
 *
 *   1. `subpath`, when the caller asked for a specific place in the tree
 *   2. the directory *is* a skill (it has a `SKILL.md`)
 *   3. a conventional `skills/` (or `skill/`) collection
 *   4. sibling directories that are each a skill
 *   5. flat `<name>.md` files in the directory itself
 *
 * Scaffolding is skipped at every level, and a directory deeper than one level is
 * never descended into here: the caller re-runs this scan with that directory as
 * its root, which is what keeps a repository's nested layout intact.
 *
 * @param {string} dir        directory to scan
 * @param {object} [options]
 * @param {string|null} [options.subpath]  slash-separated path inside `dir`
 * @returns {{bundles: Array<{name: string, dir: string, file: string}>, files: Array<object>, isBundle: boolean}}
 */
function scanDirectory(dir, { subpath = null } = {}) {
  if (subpath) {
    const target = path.join(dir, ...subpath.split('/'))
    const own = inspectForBundle(target)
    if (own) return { bundles: [{ name: path.basename(target), dir: target, file: own.file }], files: [], isBundle: true }
    const flat = inspectForSkillFile(target)
    if (flat) return { bundles: [], files: [{ name: flat.name, dir: flat.dir, file: flat.file }], isBundle: true }
    // A subpath may also name a whole collection, in which case its contents are
    // the answer — still scaffold-filtered, so a subpath that points at a
    // repository root does not resolve to that repository's `spec/`.
    const within = scanDirectory(target)
    if (within.bundles.length || within.files.length) return within
  }

  // The directory is itself a skill bundle.
  if (inspectForBundle(dir)) return { bundles: [{ name: path.basename(dir), dir, file: path.join(dir, 'SKILL.md') }], files: [], isBundle: true }

  // A conventional collection directory.
  const collectionRoot = firstDirectory(dir, ['skills', 'skill'])
  if (collectionRoot) {
    const collection = collectFrom(collectionRoot, { skipScaffold: true })
    if (collection.bundles.length) return { ...collection, isBundle: false }
  }

  // Sibling directories that are skills, one level down only.
  const entries = safeReaddir(dir).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SCAFFOLD_DIRS.has(entry.name.toLowerCase()))
  const siblings = entries
    .filter((entry) => path.join(dir, entry.name) !== collectionRoot)
    .flatMap((entry) => collectFrom(path.join(dir, entry.name), { skipScaffold: true }).bundles)
  if (siblings.length) return { bundles: siblings, files: [], isBundle: false }

  // Flat `<name>.md` skills in the directory itself.
  return { ...collectFrom(dir, { skipScaffold: true }), isBundle: false }
}

/**
 * Skills sitting directly under `dir`, split into the two shapes they come in:
 * per-directory bundles (`<name>/SKILL.md`) and flat `<name>.md` files.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {boolean} [options.skipScaffold]
 * @returns {{bundles: Array<object>, files: Array<object>}}
 */
function collectFrom(dir, { skipScaffold = false } = {}) {
  const bundles = []
  const files = []
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Scaffold names are skipped at every depth, not just at the top: a starter
      // `template/` sitting *inside* the `skills/` collection is just as much of a
      // starter, and installing it beside the real skills is the bug this rule
      // exists to prevent.
      if (skipScaffold && SCAFFOLD_DIRS.has(entry.name.toLowerCase())) continue
      const bundle = inspectForBundle(full)
      if (bundle) bundles.push({ name: entry.name, dir: full, file: bundle.file })
      continue
    }
    const flat = inspectForSkillFile(full)
    if (flat) files.push({ name: flat.name, dir, file: full })
  }
  return { bundles, files }
}

/**
 * Locate skill candidates inside an extracted repository archive.
 *
 * The codeload tarball normally wraps everything in one leading `<owner>-<ref>/`
 * component, which the extractor strips before this runs. A tarball that kept its
 * wrapper is handled too: when the extracted directory holds exactly one
 * subdirectory, that subdirectory is treated as the repository root as well.
 *
 * A candidate root that *is* a skill outranks anything found by descending from an
 * outer directory. Without that precedence a kept wrapper made the outer directory
 * look like a collection of the wrapped repository, so the wrapped repository
 * itself was never tried and its own `SKILL.md` never won.
 *
 * @param {string} extractDir
 * @param {object} [options]
 * @param {string|null} [options.subpath]
 * @returns {{candidates: Array<object>, top: string|null}}
 */
function locateSkills(extractDir, { subpath = null } = {}) {
  const directories = safeReaddir(extractDir).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  const roots = [extractDir]
  if (directories.length === 1) roots.push(path.join(extractDir, directories[0].name))

  let first = null
  for (const root of roots) {
    const found = scanDirectory(root, { subpath })
    const candidates = [...found.bundles, ...found.files]
    if (!candidates.length) continue
    // `found.isBundle` is what makes this an answer rather than a coincidence: a
    // nested `SKILL.md` one level down also matches `inspectForBundle(extractDir)`
    // when the repository root happens to be the only subdirectory.
    if (found.isBundle) return { candidates, top: root }
    if (!first) first = { candidates, top: root }
  }
  return first || { candidates: [], top: null }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function firstDirectory(root, names) {
  for (const name of names) {
    const candidate = path.join(root, name)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/** A directory is a skill bundle when it holds a `SKILL.md`. */
function inspectForBundle(dir) {
  const file = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(file)) return null
  return { dir, file, name: path.basename(dir) }
}

/** A path that is a Markdown file containing frontmatter is a flat skill. */
function inspectForSkillFile(target) {
  try {
    if (!fs.statSync(target).isFile()) return null
  } catch {
    return null
  }
  if (!target.toLowerCase().endsWith('.md')) return null
  const parsed = format.readSkillFile(target)
  if (!parsed.ok) return null
  return { dir: path.dirname(target), file: target, name: path.basename(target, path.extname(target)) }
}

/**
 * Inspect a local path and produce installable candidates.
 *
 * Resolves through the same scanner as a downloaded repository, so a directory
 * that installs as `['alpha', 'beta']` locally installs the same way from GitHub.
 *
 * @param {string} target
 * @returns {{ok: true, source: object, candidates: Array<object>} | {ok: false, reason: string}}
 */
function inspectLocalPath(target) {
  const resolved = path.resolve(String(target || ''))
  let stat = null
  try {
    stat = fs.statSync(resolved)
  } catch {
    return { ok: false, reason: `path does not exist: ${resolved}` }
  }

  if (stat.isFile()) {
    if (!resolved.toLowerCase().endsWith('.md')) {
      return { ok: false, reason: 'only .md skill files or skill directories can be installed' }
    }
    const parsed = format.readSkillFile(resolved)
    if (!parsed.ok) return { ok: false, reason: `not a valid skill file: ${parsed.reason}` }
    return {
      ok: true,
      source: { kind: 'local', path: resolved },
      candidates: [{ name: parsed.skill.name, dir: path.dirname(resolved), file: resolved, skill: parsed.skill }]
    }
  }

  const found = scanDirectory(resolved)
  const located = [...found.bundles, ...found.files]

  const candidates = []
  /** The most specific reason a skill-looking file was rejected. */
  const rejections = []
  const noteRejection = (label, reason) => {
    if (!rejections.some((item) => item.reason === reason)) rejections.push({ label, reason })
  }
  for (const item of located) {
    const parsed = format.readSkillFile(item.file)
    if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: item.dir, file: item.file, skill: parsed.skill })
    else noteRejection(path.relative(resolved, item.file) || path.basename(item.file), parsed.reason)
  }

  // A directory that holds a `SKILL.md` which does not validate must not be
  // reported as "no skill found": the file the user pointed at is right there.
  if (!candidates.length && fs.existsSync(path.join(resolved, 'SKILL.md'))) {
    const parsed = format.readSkillFile(path.join(resolved, 'SKILL.md'))
    if (!parsed.ok) noteRejection('SKILL.md', parsed.reason)
  }

  if (!candidates.length) {
    if (rejections.length) {
      const detail = rejections.map((item) => `${item.label}: ${item.reason}`).join('；')
      return { ok: false, reason: `该路径下的技能文件未通过校验 → ${detail}` }
    }
    return { ok: false, reason: 'no skill found: expected SKILL.md, <name>/SKILL.md or <name>.md with a name and description' }
  }
  return { ok: true, source: { kind: 'local', path: resolved }, candidates }
}

module.exports = {
  GITHUB_HOSTS,
  RAW_HOSTS,
  DEFAULT_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  parseGithubReference,
  refCandidates,
  normalizeSubpath,
  archiveUrls,
  scanDirectory,
  locateSkills,
  inspectLocalPath,
  inspectForBundle,
  inspectForSkillFile,
  safeReaddir,
  tar
}
