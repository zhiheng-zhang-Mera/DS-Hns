'use strict'

/**
 * Skill service: the only code that writes to the harness's user skill root.
 *
 * <dshHome>/skills is a *first-party* DSH root (rank 400, user-dsh) that the
 * running harness watches, so an install or a delete is picked up by the next
 * catalog read with no restart. Everything this service writes therefore becomes
 * live agent configuration, and the rules reflect that:
 *
 *   - a skill is validated with the harness's own rules before it is allowed in;
 *   - installation is staging-first: nothing appears in the root until the staged
 *     copy has been validated, so a failed install cannot leave a half-written
 *     skill behind;
 *   - deletion is confined to the skill root and re-checks the resolved path;
 *   - a batch operation never aborts on the first failure — it reports per item.
 *
 * A skill's *collection* membership is tracked separately from the skill itself,
 * so a repository installed with several skills can be deleted either as a group
 * or one skill at a time.
 */
const fs = require('node:fs')
const path = require('node:path')

const format = require('./skill-format')
const source = require('./skill-source')
const catalog = require('./skill-catalog')
const tar = require('./tar')
const { PATHS } = require('../utils/paths')

const META_DIR = '.hns-meta'
const MAX_SKILLS_PER_INSTALL = 64

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function isInside(parent, child) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * @param {object} options
 * @param {string} [options.root]      skill root (defaults to <dshHome>/skills)
 * @param {Function} [options.fetchBuffer]  async (url, {timeoutMs, maxBytes}) => Buffer
 * @param {Function} [options.fetchJson]    async (url) => object
 * @param {Function} [options.log]
 */
function createSkillService({ root = null, fetchBuffer = null, fetchJson = null, log = () => {}, now = () => new Date() } = {}) {
  const skillRoot = path.resolve(root || path.join(PATHS.DSH_HOME || PATHS.DATA, 'skills'))
  const stageRoot = path.join(PATHS.TEMP || path.join(PATHS.ROOT, 'temp'), 'skill-staging')
  const catalogInstance = catalog.createCatalog({ fetchJson, log })

  function metaDir() {
    return path.join(skillRoot, META_DIR)
  }

  function metaFileFor(name) {
    return path.join(metaDir(), `${name}.json`)
  }

  function readMeta(name) {
    return readJson(metaFileFor(name), null)
  }

  function writeMeta(name, value) {
    writeJson(metaFileFor(name), value)
  }

  function clearMeta(name) {
    try {
      fs.rmSync(metaFileFor(name), { force: true })
    } catch {
      // Metadata is advisory; a leftover file cannot resurrect a deleted skill.
    }
  }

  function ensureRoot() {
    fs.mkdirSync(skillRoot, { recursive: true })
  }

  /** Installed skills, merged with what the harness would discover from disk. */
  function list() {
    ensureRoot()
    const entries = format.scanSkillRoot(skillRoot).map((entry) => {
      const meta = readMeta(entry.name)
      const stat = (() => {
        try {
          return fs.statSync(entry.file)
        } catch {
          return null
        }
      })()
      return {
        name: entry.name,
        kind: entry.kind,
        dir: entry.dir,
        file: entry.file,
        path: entry.file,
        valid: entry.valid,
        reason: entry.reason,
        description: entry.skill ? entry.skill.description : null,
        whenToUse: entry.skill ? entry.skill.whenToUse : null,
        metadata: entry.skill ? entry.skill.metadata : {},
        modelInvocable: entry.skill ? entry.skill.modelInvocable : null,
        userInvocable: entry.skill ? entry.skill.userInvocable : null,
        bodyBytes: entry.skill && entry.skill.body ? Buffer.byteLength(entry.skill.body, 'utf8') : 0,
        installedAt: meta?.installedAt || (stat ? stat.birthtime.toISOString() : null),
        updatedAt: stat ? stat.mtime.toISOString() : null,
        origin: meta?.origin || 'local',
        collection: meta?.collection || null,
        sourceKind: meta?.sourceKind || null,
        sourceUrl: meta?.sourceUrl || null,
        sourcePath: meta?.sourcePath || null
      }
    })

    const collections = new Map()
    for (const entry of entries) {
      if (!entry.collection) continue
      if (!collections.has(entry.collection)) collections.set(entry.collection, [])
      collections.get(entry.collection).push(entry.name)
    }

    return {
      root: skillRoot,
      skills: entries,
      collections: [...collections.entries()].map(([id, skills]) => ({ id, skills, count: skills.length })),
      counts: {
        total: entries.length,
        valid: entries.filter((entry) => entry.valid).length,
        invalid: entries.filter((entry) => !entry.valid).length,
        modelInvocable: entries.filter((entry) => entry.valid && entry.modelInvocable !== false).length,
        userInvocable: entries.filter((entry) => entry.valid && entry.userInvocable !== false).length
      }
    }
  }

  /** Detail for one installed skill, including its body. */
  function detail(name) {
    const target = format.resolveInstalled(skillRoot, name)
    if (!target) return { ok: false, reason: 'not_found', name }
    const parsed = format.readSkillFile(target.file)
    if (!parsed.ok) return { ok: false, reason: parsed.reason, name, path: target.file }
    return {
      ok: true,
      name,
      kind: target.kind,
      path: target.file,
      dir: target.dir,
      meta: readMeta(name),
      body: parsed.skill.body,
      description: parsed.skill.description,
      whenToUse: parsed.skill.whenToUse,
      metadata: parsed.skill.metadata,
      modelInvocable: parsed.skill.modelInvocable,
      userInvocable: parsed.skill.userInvocable
    }
  }

  /** Write a staged skill into the root, honouring the conflict policy. */
  function commitStaged({ stagedDir, stagedFile, name, meta, conflict = 'rename', collection = null }) {
    ensureRoot()
    let finalName = name
    if (format.resolveInstalled(skillRoot, finalName)) {
      if (conflict === 'skip') return { ok: false, reason: 'exists', name: finalName }
      if (conflict === 'overwrite') {
        removeInstalled(finalName)
      } else {
        // `rename`: keep both, with a numeric suffix, which is what a user
        // installing two same-named skills from different sources expects.
        let index = 2
        while (format.resolveInstalled(skillRoot, `${name}-${index}`) && index < 500) index += 1
        finalName = `${name}-${index}`
      }
    }

    if (stagedDir) {
      const target = path.join(skillRoot, finalName)
      if (!isInside(skillRoot, target)) return { ok: false, reason: 'target_outside_root', name: finalName }
      rmrf(target)
      fs.cpSync(stagedDir, target, { recursive: true, force: true })
      writeMeta(finalName, { ...meta, name: finalName, requestedName: name, collection, installedAt: now().toISOString() })
      return { ok: true, name: finalName, kind: 'bundle', path: path.join(target, 'SKILL.md') }
    }

    const target = path.join(skillRoot, `${finalName}.md`)
    if (!isInside(skillRoot, target)) return { ok: false, reason: 'target_outside_root', name: finalName }
    fs.copyFileSync(stagedFile, target)
    writeMeta(finalName, { ...meta, name: finalName, requestedName: name, collection, installedAt: now().toISOString() })
    return { ok: true, name: finalName, kind: 'flat', path: target }
  }

  /** Stage a candidate into a scratch directory and validate it there. */
  function stageCandidate(candidate, index) {
    const staged = path.join(stageRoot, `${Date.now().toString(36)}-${process.pid}-${index}`)
    rmrf(staged)
    fs.mkdirSync(staged, { recursive: true })
    // A directory bundle is identified by carrying a `SKILL.md`; anything else
    // (a flat `<name>.md`, a downloaded document) is staged as a single file.
    const isBundle = Boolean(candidate.dir) && path.basename(candidate.file || '') === 'SKILL.md'
    if (isBundle) {
      fs.cpSync(candidate.dir, staged, {
        recursive: true,
        force: true,
        filter: (entry) => !entry.includes(`${path.sep}${META_DIR}`)
      })
      const file = path.join(staged, 'SKILL.md')
      const parsed = format.readSkillFile(file)
      if (!parsed.ok) return { ok: false, reason: parsed.reason, staged }
      return { ok: true, stagedDir: staged, stagedFile: file, skill: parsed.skill }
    }
    const file = path.join(staged, `${candidate.name}.md`)
    fs.copyFileSync(candidate.file, file)
    const parsed = format.readSkillFile(file)
    if (!parsed.ok) return { ok: false, reason: parsed.reason, staged }
    return { ok: true, stagedDir: null, stagedFile: file, skill: parsed.skill }
  }

  /**
   * Install a local path (directory, `SKILL.md`, flat `<name>.md`, or a folder of
   * several skills).
   */
  function installLocal(target, { conflict = 'rename', collection = null, requestedName = null } = {}) {
    const inspected = source.inspectLocalPath(target)
    if (!inspected.ok) return { ok: false, reason: inspected.reason, installed: [], skipped: [] }

    if (inspected.candidates.length > MAX_SKILLS_PER_INSTALL) {
      return { ok: false, reason: `该来源包含 ${inspected.candidates.length} 个技能，超过单次安装上限 ${MAX_SKILLS_PER_INSTALL}` }
    }

    const installed = []
    const skipped = []
    let index = 0
    for (const candidate of inspected.candidates) {
      index += 1
      const chosen = format.chooseName({ frontmatterName: candidate.skill?.name, dirName: candidate.name, explicit: requestedName })
      if (!chosen) {
        skipped.push({ name: candidate.name, reason: '无法得到合法的技能名（kebab-case）' })
        continue
      }
      const staged = stageCandidate(candidate, index)
      if (!staged.ok) {
        skipped.push({ name: chosen, reason: staged.reason })
        rmrf(staged.staged)
        continue
      }
      const result = commitStaged({
        stagedDir: staged.stagedDir,
        stagedFile: staged.stagedFile,
        name: chosen,
        collection,
        conflict,
        meta: {
          origin: collection ? 'collection' : 'local',
          sourceKind: 'local',
          sourcePath: inspected.source.path,
          description: staged.skill.description
        }
      })
      rmrf(staged.stagedDir || staged.stagedFile)
      if (result.ok) installed.push(result)
      else skipped.push({ name: chosen, reason: result.reason })
    }

    log(`skill install (local): ${installed.length} installed, ${skipped.length} skipped from ${inspected.source.path}`)
    return {
      ok: installed.length > 0,
      reason: installed.length ? null : (skipped[0]?.reason || 'no skill installed'),
      source: inspected.source,
      installed,
      skipped
    }
  }

  /** One HTTPS GET to a Buffer, with a size cap and a timeout. */
  async function defaultFetchBuffer(url, { timeoutMs = source.DEFAULT_TIMEOUT_MS, maxBytes = source.MAX_DOWNLOAD_BYTES } = {}) {
    const https = require('node:https')
    return new Promise((resolve, reject) => {
      const request = https.get(url, { headers: { 'user-agent': 'DS-Hns/1.0 (+skill-installer)', accept: '*/*' }, timeout: timeoutMs }, (response) => {
        const status = response.statusCode || 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          defaultFetchBuffer(new URL(response.headers.location, url).href, { timeoutMs, maxBytes }).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`HTTP ${status} for ${url}`))
          return
        }
        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          total += chunk.length
          if (total > maxBytes) {
            request.destroy(new Error(`download exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
      })
      request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)))
      request.on('error', reject)
    })
  }

  const downloadBuffer = typeof fetchBuffer === 'function' ? fetchBuffer : defaultFetchBuffer

  /**
   * Install from a GitHub reference (or any direct file URL).
   *
   * @param {string} url
   * @param {object} [options]
   * @param {'rename'|'overwrite'|'skip'} [options.conflict]
   * @param {string|null} [options.prefix]  collection namespace; defaults to the repo name
   * @param {string|null} [options.only]    install just this skill name from the collection
   */
  async function installRemote(url, { conflict = 'rename', prefix = undefined, only = null, requestedName = null } = {}) {
    const parsed = source.parseGithubReference(url)
    if (!parsed.ok) return { ok: false, reason: parsed.reason, installed: [], skipped: [] }
    const ref = parsed.ref

    // A plain URL: treat the response as a single skill document.
    if (ref.kind === 'url') {
      let body = null
      try {
        body = await downloadBuffer(ref.url)
      } catch (error) {
        return { ok: false, reason: `下载失败：${error?.message || error}`, installed: [], skipped: [] }
      }
      return installDocument(body.toString('utf8'), { conflict, requestedName, sourceUrl: ref.url })
    }

    if (ref.kind === 'rawFile') {
      const url = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/${ref.subpath || ''}`
      let body = null
      try {
        body = await downloadBuffer(url)
      } catch (error) {
        return { ok: false, reason: `下载失败：${error?.message || error}`, installed: [], skipped: [] }
      }
      return installDocument(body.toString('utf8'), {
        conflict,
        requestedName,
        sourceUrl: `https://github.com/${ref.owner}/${ref.repo}`,
        collection: prefix === undefined ? ref.repo : prefix
      })
    }

    // Repository archives. For `/tree/` and `/blob/` URLs the ref may contain
    // slashes, so every plausible split is tried until one downloads.
    const attempts = ref.refCandidates
      ? ref.refCandidates.map((candidate) => ({ branch: candidate.branch, subpath: candidate.subpath }))
      : [{ branch: ref.branch, subpath: ref.subpath || null }]

    let lastError = 'unable to download the repository archive'
    for (const attempt of attempts) {
      for (const archiveUrl of source.archiveUrls({ owner: ref.owner, repo: ref.repo, branch: attempt.branch })) {
        let buffer = null
        try {
          buffer = await downloadBuffer(archiveUrl)
        } catch (error) {
          lastError = error?.message || String(error)
          continue
        }
        const result = await installArchive(buffer, {
          owner: ref.owner,
          repo: ref.repo,
          subpath: attempt.subpath,
          conflict,
          prefix: prefix === undefined ? ref.repo : prefix,
          only,
          sourceUrl: ref.url || `https://github.com/${ref.owner}/${ref.repo}`
        })
        if (result.ok || result.reason !== 'no-skill-found') return result
        lastError = result.reason
      }
    }
    return { ok: false, reason: `未能从该仓库找到可安装的技能：${lastError}`, installed: [], skipped: [] }
  }

  async function installArchive(buffer, { owner, repo, subpath, conflict, prefix, only, sourceUrl }) {
    const staging = path.join(stageRoot, `${Date.now().toString(36)}-${process.pid}-archive`)
    rmrf(staging)
    fs.mkdirSync(staging, { recursive: true })
    try {
      tar.extractTar({ buffer, destDir: staging, stripComponents: 1 })
      const located = source.locateSkills(staging, { subpath })
      if (!located.candidates.length) {
        return { ok: false, reason: 'no-skill-found', installed: [], skipped: [] }
      }
      const selected = only ? located.candidates.filter((candidate) => candidate.name === only) : located.candidates
      if (!selected.length) {
        return { ok: false, reason: `该来源中没有名为 ${only} 的技能`, installed: [], skipped: [] }
      }
      if (selected.length > MAX_SKILLS_PER_INSTALL) {
        return { ok: false, reason: `该来源包含 ${selected.length} 个技能，超过单次安装上限 ${MAX_SKILLS_PER_INSTALL}`, installed: [], skipped: [] }
      }

      const installed = []
      const skipped = []
      let index = 0
      for (const candidate of selected) {
        index += 1
        const rawName = format.chooseName({ frontmatterName: candidate.name, dirName: candidate.name })
        if (!rawName) {
          skipped.push({ name: candidate.name, reason: '无法得到合法的技能名' })
          continue
        }
        // Namespace a multi-skill collection so two repositories can both ship a
        // skill called `review` without one silently winning.
        const namespaced = selected.length > 1 && prefix ? `${format.slugify(prefix)}-${rawName}` : rawName
        const chosen = format.chooseName({ frontmatterName: null, dirName: namespaced, explicit: namespaced })
        if (!chosen) {
          skipped.push({ name: rawName, reason: '无法得到合法的技能名' })
          continue
        }
        const staged = stageCandidate(candidate, index)
        if (!staged.ok) {
          skipped.push({ name: chosen, reason: staged.reason })
          rmrf(staged.staged)
          continue
        }
        const result = commitStaged({
          stagedDir: staged.stagedDir,
          stagedFile: staged.stagedFile,
          name: chosen,
          conflict,
          collection: prefix || repo,
          meta: {
            origin: 'github',
            sourceKind: 'github',
            sourceUrl,
            sourceRepo: `${owner}/${repo}`,
            upstreamName: rawName,
            description: staged.skill.description
          }
        })
        rmrf(staged.stagedDir || staged.stagedFile)
        if (result.ok) installed.push({ ...result, upstreamName: rawName })
        else skipped.push({ name: chosen, reason: result.reason })
      }

      log(`skill install (github ${owner}/${repo}): ${installed.length} installed, ${skipped.length} skipped`)
      return {
        ok: installed.length > 0,
        reason: installed.length ? null : (skipped[0]?.reason || 'no skill installed'),
        source: { kind: 'github', repo: `${owner}/${repo}`, subpath: subpath || null, url: sourceUrl },
        installed,
        skipped
      }
    } finally {
      rmrf(staging)
    }
  }

  /** Install a single skill document (used for raw URLs and pasted content). */
  function installDocument(text, { conflict = 'rename', requestedName = null, sourceUrl = null, collection = null } = {}) {
    const parsed = format.parseSkillText(text)
    if (!parsed.ok) return { ok: false, reason: `不是合法的技能文件：${parsed.reason}`, installed: [], skipped: [] }
    const chosen = format.chooseName({ frontmatterName: parsed.skill.name, explicit: requestedName })
    if (!chosen) return { ok: false, reason: '无法得到合法的技能名', installed: [], skipped: [] }

    const staging = path.join(stageRoot, `${Date.now().toString(36)}-${process.pid}-doc`)
    rmrf(staging)
    fs.mkdirSync(staging, { recursive: true })
    try {
      const file = path.join(staging, `${chosen}.md`)
      fs.writeFileSync(file, format.renderSkillDocument({
        name: chosen,
        description: parsed.skill.description,
        whenToUse: parsed.skill.whenToUse,
        metadata: parsed.skill.metadata,
        modelInvocable: parsed.skill.modelInvocable,
        userInvocable: parsed.skill.userInvocable,
        body: parsed.skill.body
      }), 'utf8')
      const result = commitStaged({
        stagedDir: null,
        stagedFile: file,
        name: chosen,
        conflict,
        collection,
        meta: {
          origin: sourceUrl ? 'github' : 'local',
          sourceKind: sourceUrl ? 'url' : 'document',
          sourceUrl,
          description: parsed.skill.description
        }
      })
      return {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        source: { kind: sourceUrl ? 'url' : 'document', url: sourceUrl },
        installed: result.ok ? [result] : [],
        skipped: result.ok ? [] : [{ name: chosen, reason: result.reason }]
      }
    } finally {
      rmrf(staging)
    }
  }

  /** Install one of the bundled starter skills — no network required. */
  function installBundled(id, { conflict = 'rename' } = {}) {
    const entry = catalogInstance.get(id)
    if (!entry || entry.origin !== 'bundled') return { ok: false, reason: 'not_found', installed: [], skipped: [] }
    const document = catalog.renderBundledSkill(entry)
    if (!document) return { ok: false, reason: 'bundled skill is malformed', installed: [], skipped: [] }
    const result = installDocument(document, { conflict, collection: null })
    if (result.ok && result.installed[0]) {
      const meta = readMeta(result.installed[0].name) || {}
      writeMeta(result.installed[0].name, { ...meta, origin: 'bundled', sourceKind: 'bundled', bundledId: id })
      result.installed[0].origin = 'bundled'
    }
    return result
  }

  /** Install a catalog entry (bundled or a GitHub collection). */
  async function installCatalogEntry(id, { conflict = 'rename', only = null } = {}) {
    const entry = catalogInstance.get(id)
    if (!entry) return { ok: false, reason: 'not_found', installed: [], skipped: [] }
    if (entry.origin === 'bundled') return installBundled(id, { conflict })
    const url = entry.subpath
      ? `https://github.com/${entry.owner}/${entry.repo}/tree/HEAD/${entry.subpath}`
      : `https://github.com/${entry.owner}/${entry.repo}`
    const result = await installRemote(url, { conflict, prefix: entry.id, only })
    if (!result.ok && entry.alternate !== true && result.reason === 'no-skill-found') {
      // A curated layout change should not silently produce "nothing found".
      const retry = await installRemote(`https://github.com/${entry.owner}/${entry.repo}`, { conflict, prefix: entry.id, only })
      return retry
    }
    return result
  }

  /** Remove one installed skill. Refuses anything outside the skill root. */
  function removeInstalled(name) {
    if (!format.isSkillName(name)) return { ok: false, reason: 'invalid_name', name }
    const target = format.resolveInstalled(skillRoot, name)
    if (!target) return { ok: false, reason: 'not_found', name }
    const paths = [target.dir, target.file].filter(Boolean)
    for (const item of paths) {
      if (!isInside(skillRoot, item)) return { ok: false, reason: 'outside_root', name }
    }
    try {
      if (target.kind === 'bundle') rmrf(target.dir)
      else fs.rmSync(target.file, { force: true })
    } catch (error) {
      return { ok: false, reason: `删除失败：${error?.message || error}`, name }
    }
    clearMeta(name)
    return { ok: true, name, kind: target.kind }
  }

  /** Delete one skill. */
  function deleteSkill(name) {
    const result = removeInstalled(name)
    if (result.ok) log(`skill deleted: ${name}`)
    return result
  }

  /** Delete several skills; every item is reported, none aborts the batch. */
  function deleteSkills(names) {
    const list = Array.isArray(names) ? names : []
    const deleted = []
    const failed = []
    const failedNames = new Set()
    for (const name of list) {
      if (failedNames.has(name)) continue
      const result = deleteSkill(name)
      if (result.ok) deleted.push(name)
      else {
        failed.push({ name, reason: result.reason })
        failedNames.add(name)
      }
    }
    return { ok: failed.length === 0, requested: list.length, deleted, failed }
  }

  /** Delete every skill that came from one collection. */
  function deleteCollection(collectionId) {
    const snapshot = list()
    const members = snapshot.collections.find((entry) => entry.id === collectionId)?.skills || []
    if (!members.length) return { ok: false, reason: 'collection_not_found', collection: collectionId, deleted: [], failed: [] }
    const result = deleteSkills(members)
    return { ...result, collection: collectionId }
  }

  /** Enable/disable a surface (model or user invocation) without reinstalling. */
  function setInvocation(name, { modelInvocable = undefined, userInvocable = undefined } = {}) {
    const target = format.resolveInstalled(skillRoot, name)
    if (!target) return { ok: false, reason: 'not_found', name }
    const parsed = format.readSkillFile(target.file)
    if (!parsed.ok) return { ok: false, reason: parsed.reason, name }
    const next = {
      ...parsed.skill,
      modelInvocable: modelInvocable === undefined ? parsed.skill.modelInvocable : Boolean(modelInvocable),
      userInvocable: userInvocable === undefined ? parsed.skill.userInvocable : Boolean(userInvocable)
    }
    try {
      fs.writeFileSync(target.file, format.renderSkillDocument(next), 'utf8')
    } catch (error) {
      return { ok: false, reason: `写入失败：${error?.message || error}`, name }
    }
    log(`skill invocation updated: ${name}`)
    return { ok: true, name, modelInvocable: next.modelInvocable, userInvocable: next.userInvocable }
  }

  /** Import several local paths in one action (drag-and-drop of many folders). */
  function installManyLocal(paths, options = {}) {
    const list = Array.isArray(paths) ? paths : []
    const installed = []
    const failed = []
    for (const target of list) {
      const result = installLocal(target, options)
      if (result.ok) installed.push(...result.installed)
      else failed.push({ source: target, reason: result.reason })
    }
    return { ok: failed.length === 0, installed, failed }
  }

  async function search(query, options = {}) {
    return catalogInstance.search({ query, ...options })
  }

  function snapshot() {
    const listing = list()
    return {
      root: skillRoot,
      ...listing,
      catalog: {
        bundled: catalogInstance.BUNDLED_SKILLS.length,
        curated: catalogInstance.CURATED_COLLECTIONS.length
      }
    }
  }

  return {
    root: skillRoot,
    stageRoot,
    list,
    detail,
    snapshot,
    installLocal,
    installManyLocal,
    installRemote,
    installDocument,
    installBundled,
    installCatalogEntry,
    deleteSkill,
    deleteSkills,
    deleteCollection,
    setInvocation,
    search,
    tags: () => catalogInstance.tags(),
    catalog: catalogInstance,
    downloadBuffer,
    metaDir
  }
}

module.exports = {
  META_DIR,
  MAX_SKILLS_PER_INSTALL,
  createSkillService,
  isInside
}
