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
 * Locate skill candidates inside an extracted repository archive.
 *
 * A repository is a valid source in three shapes, in priority order:
 *   1. the requested subpath is a skill bundle or a skill file;
 *   2. the repository root is a skill bundle;
 *   3. the repository contains a collection of skills (a `skills/` directory, or
 *      any set of per-directory "SKILL.md" files).
 *
 * The codeload tarball wraps everything in one leading `<owner>-<ref>/` component,
 * which the extractor strips before this runs.
 */
function locateSkills(extractDir, { subpath = null } = {}) {
  const top = readTopLevel(extractDir)
  // Do NOT require a single top-level entry: a repository normally also has a
  // README, a LICENSE and dotfiles at its root. Requiring exactly one entry made
  // every realistic repository resolve to nothing.
  const candidates = []
  const pushCandidate = (dir, name) => {
    candidates.push({ name: name || path.basename(dir), dir })
  }

  /** Skills sitting directly under `dir`: bundles and flat `<name>.md` files. */
  const collectFrom = (dir) => {
    const found = []
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const bundle = inspectForBundle(full)
        if (bundle) found.push({ name: entry.name, dir: full, file: bundle.file })
        continue
      }
      const flat = inspectForSkillFile(full)
      if (flat) found.push({ name: flat.name, dir, file: full })
    }
    return found
  }

  const absorb = (found) => {
    for (const item of found) candidates.push(item)
    return candidates
  }

  /** Run the search against one repository root. */
  const searchIn = (root) => {
    // 1. An explicitly requested subpath wins.
    if (subpath) {
      const target = path.join(root, ...subpath.split('/'))
      const bundle = inspectForBundle(target)
      if (bundle) return absorb([{ name: path.basename(target), dir: bundle.dir, file: bundle.file }])
      const flat = inspectForSkillFile(target)
      if (flat) return absorb([{ name: flat.name, dir: flat.dir, file: flat.file }])
      const nested = collectFrom(target)
      if (nested.length) return absorb(nested)
    }

    // 2. The repository root is itself a skill.
    const rootBundle = inspectForBundle(root)
    if (rootBundle) return absorb([{ name: path.basename(root), dir: rootBundle.dir, file: rootBundle.file }])
    const rootFile = inspectForSkillFile(path.join(root, 'SKILL.md'))
    if (rootFile) return absorb([{ name: path.basename(root), dir: rootFile.dir, file: rootFile.file }])

    // 3. The repository collects skills: flat at the top, inside a conventional
    //    `skills/` directory, or one level down.
    const direct = collectFrom(root)
    if (direct.length) return absorb(direct)

    const collectionRoot = firstDirectory(root, ['skills', 'skill'])
    if (collectionRoot) {
      const nested = collectFrom(collectionRoot)
      if (nested.length) return absorb(nested)
    }

    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory()) continue
      const nested = collectFrom(path.join(root, entry.name))
      if (nested.length) return absorb(nested)
    }
    return candidates
  }

  // The extractor normally strips the archive's wrapper component, so `extractDir`
  // is the repository root. When it did not (a tarball that kept its wrapper), the
  // single top-level directory is treated as the repository root as well.
  const directories = safeReaddir(extractDir).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  const roots = [extractDir]
  if (directories.length === 1) roots.push(path.join(extractDir, directories[0].name))

  for (const root of roots) {
    const found = searchIn(root)
    if (found.length) return { candidates: found, top: root }
  }
  return { candidates, top: null }
}

function readTopLevel(dir) {
  return safeReaddir(dir).map((entry) => entry.name)
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

/** A directory is a skill bundle when it holds a valid `SKILL.md`. */
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

  const candidates = []
  /** The most specific reason a skill-looking file was rejected. */
  const rejections = []
  const noteRejection = (label, reason) => {
    if (!rejections.some((item) => item.reason === reason)) rejections.push({ label, reason })
  }

  // The directory itself is a skill bundle.
  const ownFile = path.join(resolved, 'SKILL.md')
  if (fs.existsSync(ownFile)) {
    const parsed = format.readSkillFile(ownFile)
    if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: resolved, file: ownFile, skill: parsed.skill })
    else noteRejection('SKILL.md', parsed.reason)
  }

  // Or it collects skills one level down (and in a `skills/` child).
  if (!candidates.length) {
    for (const entry of safeReaddir(resolved)) {
      if (!entry.isDirectory()) continue
      const bundle = inspectForBundle(path.join(resolved, entry.name))
      if (!bundle) continue
      const parsed = format.readSkillFile(bundle.file)
      if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: bundle.dir, file: bundle.file, skill: parsed.skill })
      else noteRejection(`${entry.name}/SKILL.md`, parsed.reason)
    }
    const collection = firstDirectory(resolved, ['skills', 'skill'])
    if (collection && !candidates.length) {
      for (const entry of safeReaddir(collection)) {
        if (!entry.isDirectory()) continue
        const bundle = inspectForBundle(path.join(collection, entry.name))
        if (!bundle) continue
        const parsed = format.readSkillFile(bundle.file)
        if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: bundle.dir, file: bundle.file, skill: parsed.skill })
        else noteRejection(`${entry.name}/SKILL.md`, parsed.reason)
      }
    }
  }

  // Or it holds flat `<name>.md` skills.
  if (!candidates.length) {
    for (const entry of safeReaddir(resolved)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (entry.name.toLowerCase() === 'readme.md') continue
      const file = path.join(resolved, entry.name)
      const parsed = format.readSkillFile(file)
      if (parsed.ok) candidates.push({ name: parsed.skill.name, dir: resolved, file, skill: parsed.skill })
      else noteRejection(entry.name, parsed.reason)
    }
  }

  if (!candidates.length) {
    // A path that *looks* like a skill but failed validation must say why: "no skill
    // found" would send the user looking for a missing file that is right there.
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
  locateSkills,
  inspectLocalPath,
  inspectForBundle,
  inspectForSkillFile,
  safeReaddir,
  tar
}
