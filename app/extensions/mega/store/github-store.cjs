'use strict'

/**
 * The plugin store channel: search GitHub for existing plugins.
 *
 * DS-Hns plugins are repositories, so "a store" is really two questions — *what exists* and
 * *is this one actually a plugin*. This module answers both, and it is deliberately pedantic
 * about the second, because the contract is the only thing standing between a search result
 * and arbitrary code:
 *
 *   * a result is **installable** only when the repository carries a `dshns-plugin.json`
 *     manifest that passes the platform's own `validateManifest` and declares an API version
 *     the host accepts. Anything else is listed as *not installable* with the reason, which
 *     is more useful than hiding it: a repository that is one manifest away from working is
 *     exactly what a store should show.
 *   * the search is bounded and rate-limit aware. GitHub's unauthenticated search allows a
 *     handful of requests per minute, so a refusal is reported as a refusal — with the reset
 *     time — rather than being retried until the user gives up.
 *   * nothing is downloaded and nothing is executed here. Installation is a deliberate act
 *     (clone into the plugin directory, then enable it in the manager); a store that loads
 *     code on one click would be a remote-code-execution surface wearing a search box.
 *
 * `request` is injectable so the tests exercise the real parsing and the real validation
 * without a network, which is also how the module stays honest about what it does with a
 * GitHub answer it did not expect.
 */

const { validateManifest } = require('../../../core/contracts/plugin.cjs')
const { PLUGIN_API_VERSION } = require('../../../core/contracts/plugin.cjs')

/** The topic a DS-Hns plugin is expected to carry, so a plain search can find the set. */
const PLUGIN_TOPIC = 'dshns-plugin'
const MANIFEST_FILE = 'dshns-plugin.json'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 512 * 1024

const STORE_REASONS = Object.freeze({
  RATE_LIMITED: 'STORE_RATE_LIMITED',
  UNREACHABLE: 'STORE_UNREACHABLE',
  BAD_QUERY: 'STORE_BAD_QUERY',
  NO_MANIFEST: 'STORE_NO_MANIFEST',
  BAD_MANIFEST: 'STORE_BAD_MANIFEST'
})

/** A bounded HTTPS GET that returns parsed JSON, or a reason. */
function defaultRequest(url, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let client = null
    try {
      client = require('node:https')
    } catch (error) {
      finish({ ok: false, code: STORE_REASONS.UNREACHABLE, reason: `https is unavailable: ${error?.message || error}` })
      return
    }
    const request = client.get(
      url,
      {
        headers: {
          'user-agent': 'DS-Hns-plugin-store',
          accept: 'application/vnd.github+json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > MAX_BODY_BYTES) {
            request.destroy()
            finish({ ok: false, code: STORE_REASONS.UNREACHABLE, reason: `the response exceeded ${MAX_BODY_BYTES} bytes` })
          }
        })
        response.on('end', () => {
          if (response.statusCode === 403 || response.statusCode === 429) {
            finish({
              ok: false,
              code: STORE_REASONS.RATE_LIMITED,
              status: response.statusCode,
              resetAt: response.headers['x-ratelimit-reset'] ? Number(response.headers['x-ratelimit-reset']) * 1000 : null,
              reason: 'GitHub refused the search: the rate limit is exhausted. Wait for the reset or set GITHUB_TOKEN.'
            })
            return
          }
          if (response.statusCode === 404) {
            finish({ ok: false, code: STORE_REASONS.NO_MANIFEST, status: 404, reason: 'not found' })
            return
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish({ ok: false, code: STORE_REASONS.UNREACHABLE, status: response.statusCode, reason: `GitHub answered ${response.statusCode}` })
            return
          }
          try {
            finish({ ok: true, status: response.statusCode, json: JSON.parse(body), bytes: body.length })
          } catch (error) {
            finish({ ok: false, code: STORE_REASONS.UNREACHABLE, reason: `the response was not JSON: ${error?.message || error}` })
          }
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      finish({ ok: false, code: STORE_REASONS.UNREACHABLE, reason: `the request timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms` })
    })
    request.on('error', (error) => finish({ ok: false, code: STORE_REASONS.UNREACHABLE, reason: String(error?.message || error) }))
  })
}

/** One repository, in the shape the manager renders. */
function describeRepository(raw, extra = {}) {
  return {
    id: raw.full_name || raw.name || null,
    name: raw.name || null,
    owner: raw.owner && raw.owner.login ? raw.owner.login : null,
    description: raw.description || '',
    stars: Number.isFinite(raw.stargazers_count) ? raw.stargazers_count : 0,
    updatedAt: raw.updated_at || null,
    branch: raw.default_branch || 'main',
    url: raw.html_url || null,
    topics: Array.isArray(raw.topics) ? raw.topics.slice(0, 12) : [],
    manifestUrl: raw.full_name ? `https://raw.githubusercontent.com/${raw.full_name}/${raw.default_branch || 'main'}/${MANIFEST_FILE}` : null,
    ...extra
  }
}

/**
 * Validate a manifest the store fetched.
 *
 * The platform's own validator decides, so the store cannot be more permissive than the host
 * that will load the plugin.
 */
function checkManifest(text, owner) {
  let parsed = null
  try {
    parsed = JSON.parse(String(text || ''))
  } catch (error) {
    return { installable: false, code: STORE_REASONS.BAD_MANIFEST, reason: `${MANIFEST_FILE} is not valid JSON: ${error?.message || error}` }
  }
  const manifest = parsed && typeof parsed.manifest === 'object' ? parsed.manifest : parsed
  const validated = validateManifest(manifest)
  if (!validated.ok) {
    return { installable: false, code: STORE_REASONS.BAD_MANIFEST, reason: `the manifest is invalid: ${validated.errors.join('; ')}` }
  }
  if (manifest.api_version !== PLUGIN_API_VERSION) {
    return {
      installable: false,
      code: STORE_REASONS.BAD_MANIFEST,
      reason: `the plugin declares ${manifest.api_version}, and this host speaks ${PLUGIN_API_VERSION}`
    }
  }
  return {
    installable: true,
    code: null,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      provides: Array.isArray(manifest.provides) ? manifest.provides : [],
      requires: Array.isArray(manifest.requires_capabilities) ? manifest.requires_capabilities : [],
      faultLevel: manifest.fault_level || null,
      owner: owner || null
    },
    reason: null
  }
}

/**
 * `owner/name`, a GitHub URL, or nothing.
 *
 * This is the shape of a repository the user *named*, as opposed to one they described. The
 * difference matters: GitHub currently has no repositories carrying this platform's topic at all,
 * so a store that can only search the topic answers "0 results" to a user who pasted the exact
 * repository they want. A named repository is fetched directly instead, and its own verdict is
 * what the panel reports.
 */
function namedRepository(value) {
  const text = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? text : null
}

/**
 * @param {object} [options]
 * @param {Function} [options.request] injectable transport, `(url, options) => Promise`
 * @param {string} [options.token] a GitHub token, when the deployment has one
 * @param {Function} [options.log]
 */
function createPluginStore(options = {}) {
  const request = typeof options.request === 'function' ? options.request : defaultRequest
  const log = typeof options.log === 'function' ? options.log : () => {}
  const token = options.token || process.env.GITHUB_TOKEN || null
  const history = []
  /** Default branches already resolved this session, so the store asks GitHub once per repo. */
  const defaultBranches = new Map()

  function remember(entry) {
    history.push(entry)
    if (history.length > 50) history.splice(0, history.length - 50)
    return entry
  }

  /**
   * The repository's real default branch, or null when it cannot be established.
   *
   * A manifest URL cannot be guessed. The store's first live target defaults to `dev`, so a
   * probe of `main` answers 404 for a repository that is perfectly fine, and a 404 read as "no
   * manifest" would be a false verdict about somebody else's repository. `null` is deliberately
   * a different answer from "main": unknown means the caller must not refuse anything, only the
   * clone can decide.
   */
  async function defaultBranch(repo, settings = {}) {
    const full = String(repo || '').trim()
    if (!full) return null
    if (defaultBranches.has(full)) return defaultBranches.get(full)
    const answer = await request(`https://api.github.com/repos/${full}`, { token, timeoutMs: settings.timeoutMs })
    const branch = answer && answer.ok === true && answer.json && answer.json.default_branch ? String(answer.json.default_branch) : null
    if (branch) defaultBranches.set(full, branch)
    return branch
  }

  /**
   * Search GitHub.
   *
   * The default query is the plugin *topic*, because that is the only thing that reliably
   * means "this repository is a DS-Hns plugin"; a free-text query is passed through with the
   * topic as an additional filter when the caller asks for it.
   */
  async function search(input = {}) {
    const query = String(input.query || '').trim()
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(input.limit) ? Number(input.limit) : DEFAULT_LIMIT))
    const topicOnly = input.topic !== false
    if (query.length > 120) {
      return remember({ ok: false, code: STORE_REASONS.BAD_QUERY, reason: 'the query is longer than 120 characters' })
    }
    // A named repository is not a search: it is a target. Answering it with a topic filter would
    // report "nothing found" for a repository the user is looking at in another window.
    const named = namedRepository(query)
    if (named) {
      const answer = await request(`https://api.github.com/repos/${named}`, { token, timeoutMs: input.timeoutMs })
      if (!answer || answer.ok !== true) {
        const code = (answer && answer.code) || STORE_REASONS.UNREACHABLE
        const reason = code === STORE_REASONS.NO_MANIFEST
          ? `${named} does not exist, or the store is not allowed to read it`
          : (answer && answer.reason) || 'the repository could not be read'
        return remember({ ok: false, code, reason })
      }
      const result = describeRepository(answer.json, { installable: null, manifestReason: 'not checked yet' })
      log(`store fetched the named repository ${named}`)
      return remember({
        ok: true,
        query: named,
        named: true,
        topic: null,
        total: 1,
        results: [result],
        rateLimit: answer.headers && answer.headers['x-ratelimit-remaining'] ? Number(answer.headers['x-ratelimit-remaining']) : null,
        authenticated: Boolean(token)
      })
    }
    const q = [query, topicOnly ? `topic:${PLUGIN_TOPIC}` : ''].filter(Boolean).join(' ')
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(String(input.sort || 'stars'))}&order=desc&per_page=${limit}`
    const answer = await request(url, { token, timeoutMs: input.timeoutMs })
    if (!answer || answer.ok !== true) {
      return remember({ ok: false, code: (answer && answer.code) || STORE_REASONS.UNREACHABLE, reason: (answer && answer.reason) || 'the search failed', resetAt: answer && answer.resetAt ? answer.resetAt : null })
    }
    const items = answer.json && Array.isArray(answer.json.items) ? answer.json.items : []
    const results = items.map((item) => describeRepository(item, { installable: null, manifestReason: 'not checked yet' }))
    log(`store search "${q}" returned ${results.length} of ${answer.json?.total_count ?? '?'} repositories`)
    return remember({
      ok: true,
      query: q,
      topic: topicOnly ? PLUGIN_TOPIC : null,
      total: Number.isFinite(answer.json?.total_count) ? answer.json.total_count : results.length,
      results,
      rateLimit: answer.headers && answer.headers['x-ratelimit-remaining'] ? Number(answer.headers['x-ratelimit-remaining']) : null,
      authenticated: Boolean(token)
    })
  }

  /**
   * Inspect one result: fetch its manifest and decide whether it is installable.
   *
   * A repository without a manifest is not an error — it is a repository that is not a plugin
   * yet, and saying so is the store's most useful answer.
   */
  async function inspect(input = {}) {
    const repository = input.repository && typeof input.repository === 'object' ? input.repository : null
    const id = String(input.id || (repository && repository.id) || '').trim()
    let branch = String(input.branch || (repository && repository.branch) || '').trim()
    // A search result already carries the default branch; a bare `owner/name` does not, and
    // guessing `main` is what produces a wrong "no manifest" verdict for a `dev`-defaulted
    // repository. One API call settles it, and being unable to settle it is not a refusal.
    if (!branch && !input.manifestUrl && id && !repository) {
      const resolved = await defaultBranch(id, input)
      if (resolved) branch = resolved
    }
    const url = input.manifestUrl || (repository && repository.manifestUrl) || manifestUrlFor(id, branch || 'main')
    if (!url) return remember({ ok: false, code: STORE_REASONS.BAD_QUERY, reason: 'a repository or a manifest URL is required' })
    // `verified` is the difference between "we looked where the manifest has to be" and "we
    // looked where it usually is": only a verified absence may refuse an install.
    const verified = Boolean(input.manifestUrl || branch)
    const answer = await request(url, { token, timeoutMs: input.timeoutMs })
    if (!answer || answer.ok !== true) {
      const code = (answer && answer.code) || STORE_REASONS.UNREACHABLE
      const where = branch ? `at ${branch}` : 'at its default branch (which could not be resolved, so main was tried)'
      const reason = code === STORE_REASONS.NO_MANIFEST
        ? `this repository has no ${MANIFEST_FILE} ${where}, so it is not installable yet`
        : (answer && answer.reason) || 'the manifest could not be read'
      return remember({ ok: true, url, installable: false, verified, branch: branch || null, code, reason })
    }
    // GitHub's raw endpoint returns text; the transport parses JSON when it can, so accept
    // both a parsed object and the raw text.
    const checked = typeof answer.json === 'object' && answer.json !== null
      ? checkManifest(JSON.stringify(answer.json), repository && repository.id)
      : checkManifest(answer.text || '', repository && repository.id)
    return remember({ ok: true, url, verified, branch: branch || null, ...checked })
  }

  return {
    PLUGIN_TOPIC,
    MANIFEST_FILE,
    search,
    inspect,
    defaultBranch,
    checkManifest,
    describeRepository,
    namedRepository,
    history: () => history.slice(),
    authenticated: () => Boolean(token),
    /** What the UI shows about the channel itself. */
    describe() {
      return {
        topic: PLUGIN_TOPIC,
        manifestFile: MANIFEST_FILE,
        apiVersion: PLUGIN_API_VERSION,
        authenticated: Boolean(token),
        note: 'Search the plugin topic, or name a repository (owner/name or its URL) to check it directly. Installation is a deliberate act: stage the code, then enable it in the manager.'
      }
    }
  }
}

function manifestUrlFor(id, branch) {
  const full = String(id || '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return null
  return `https://raw.githubusercontent.com/${full}/${branch || 'main'}/${MANIFEST_FILE}`
}

module.exports = {
  createPluginStore,
  checkManifest,
  describeRepository,
  manifestUrlFor,
  namedRepository,
  defaultRequest,
  PLUGIN_TOPIC,
  MANIFEST_FILE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STORE_REASONS
}
