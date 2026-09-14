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
const { cleanPath, parseSource } = require('./source.cjs')

/** The topic a DS-Hns plugin is expected to carry, so a plain search can find the set. */
const PLUGIN_TOPIC = 'dshns-plugin'
const MANIFEST_FILE = 'dshns-plugin.json'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 512 * 1024

/**
 * Where the channel talks by default, and what a user may point it at instead.
 *
 * GitHub is not one host. A rate limit is per-token and a private repository needs one, an
 * enterprise install answers on its own API, and a mirror in front of github.com is a normal
 * deployment. All three are the *same* three addresses with a different host, so they are
 * settings rather than a fork of this module — and they are resolved per call, so saving one
 * takes effect on the next search instead of on the next restart.
 */
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'
const DEFAULT_CLONE_BASE = 'https://github.com'

/** The setting names, in the order the store's own settings surface shows them. */
const GITHUB_SETTINGS = Object.freeze(['token', 'topic', 'apiBase', 'rawBase', 'cloneBase'])

/** What a value may be: a token is bounded, a topic is an identifier, a base is a URL. */
const SETTING_LIMITS = Object.freeze({
  token: Object.freeze({ max: 512 }),
  topic: Object.freeze({ max: 80 }),
  base: Object.freeze({ max: 512 })
})

/** A topic GitHub would accept: lowercase letters, digits, dots, dashes and underscores. */
const TOPIC_SAFE = /^[a-z0-9][a-z0-9._-]*$/

/** Loopback is the one place plain HTTP is not a secret on the wire. */
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

const STORE_REASONS = Object.freeze({
  RATE_LIMITED: 'STORE_RATE_LIMITED',
  UNREACHABLE: 'STORE_UNREACHABLE',
  BAD_QUERY: 'STORE_BAD_QUERY',
  NO_MANIFEST: 'STORE_NO_MANIFEST',
  BAD_MANIFEST: 'STORE_BAD_MANIFEST'
})

/**
 * A base URL the channel may build requests on, or the fallback.
 *
 * `https` is required for anything that is not loopback, because a token and a query both travel
 * on this URL: refusing plain HTTP to a remote host is the difference between a setting and a
 * credential leak. A trailing slash is trimmed so a copy-pasted URL does not double it.
 */
function normalizeBase(value, fallback) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  if (!text) return fallback
  if (text.length > SETTING_LIMITS.base.max) return fallback
  let parsed = null
  try {
    parsed = new URL(text)
  } catch {
    return fallback
  }
  if (parsed.protocol === 'https:') return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  if (parsed.protocol === 'http:' && LOOPBACK_HOST.test(parsed.hostname)) return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  return fallback
}

/** Whether a base URL is one this channel would accept, and why not when it is not. */
function checkBase(value, label, fallback) {
  const text = String(value || '').trim()
  if (!text) return { ok: true, value: fallback, source: 'default' }
  const normalized = normalizeBase(text, null)
  if (!normalized) {
    return {
      ok: false,
      value: fallback,
      source: 'default',
      reason: `${label} must be an https URL (http is accepted only for loopback): ${text}`
    }
  }
  return { ok: true, value: normalized, source: 'user' }
}

/** A plugin topic, or the fallback when the value is not one GitHub would accept. */
function normalizeTopic(value, fallback = PLUGIN_TOPIC) {
  const text = String(value || '').trim().toLowerCase()
  if (!text || text.length > SETTING_LIMITS.topic.max || !TOPIC_SAFE.test(text)) return fallback
  return text
}

/** Whether a topic is usable, and why not when it is not. */
function checkTopic(value, fallback = PLUGIN_TOPIC) {
  const text = String(value || '').trim()
  if (!text) return { ok: true, value: fallback, source: 'default' }
  const normalized = normalizeTopic(text, null)
  if (!normalized) {
    return {
      ok: false,
      value: fallback,
      source: 'default',
      reason: `a topic is lowercase letters, digits, dashes, dots and underscores (max ${SETTING_LIMITS.topic.max}): ${text}`
    }
  }
  return { ok: true, value: normalized, source: 'user' }
}

/**
 * The tail of a token, and never the token.
 *
 * The store has to be able to say *which* credential is in force — "I set one and it is being
 * ignored" is a real support question — without ever handing the secret back to a renderer. A
 * short token is masked completely, because four plus four characters of a nine-character token
 * is the token.
 */
function maskToken(token) {
  const text = String(token || '')
  if (!text) return null
  if (text.length < 16) return '•'.repeat(Math.min(8, Math.max(4, text.length)))
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * The settings in force for one call, from the user's own values with the environment behind them.
 *
 * `supplied` is what the shell read from `data/state/plugin-store.json`; anything absent, empty or
 * unusable falls back to the library default. The environment token is a *deployment* default
 * rather than a user choice, which is why the answer says which of the two is being used instead
 * of only whether one is: a user who set a token and still sees `environment` has learned that
 * their value did not land, and the panel can say so.
 *
 * @param {object} [supplied] `{ token, topic, apiBase, rawBase, cloneBase }`
 * @param {object} [options] `{ environmentToken }`
 */
function resolveGithubSettings(supplied = {}, options = {}) {
  const source = supplied && typeof supplied === 'object' ? supplied : {}
  const userToken = String(source.token || '').trim()
  const environmentToken = String(
    typeof options.environmentToken === 'string' ? options.environmentToken : process.env.GITHUB_TOKEN || ''
  ).trim()
  const token = userToken || environmentToken
  const topic = checkTopic(source.topic)
  const apiBase = checkBase(source.apiBase, 'the API base URL', DEFAULT_API_BASE)
  const rawBase = checkBase(source.rawBase, 'the raw content base URL', DEFAULT_RAW_BASE)
  const cloneBase = checkBase(source.cloneBase, 'the clone base URL', DEFAULT_CLONE_BASE)
  const refused = [topic, apiBase, rawBase, cloneBase].filter((checked) => checked.ok === false).map((checked) => checked.reason)
  return {
    token: token || null,
    tokenSource: userToken ? 'user' : environmentToken ? 'environment' : 'none',
    tokenMask: maskToken(token),
    topic: topic.value,
    topicSource: topic.source,
    apiBase: apiBase.value,
    apiBaseSource: apiBase.source,
    rawBase: rawBase.value,
    rawBaseSource: rawBase.source,
    cloneBase: cloneBase.value,
    cloneBaseSource: cloneBase.source,
    refused
  }
}

/** The `owner/name` half of a manifest URL, for a base that may carry a path of its own. */
function rawFileUrl(rawBase, id, branch, file) {
  const base = String(rawBase || DEFAULT_RAW_BASE).replace(/\/+$/, '')
  return `${base}/${id}/${branch || 'main'}/${file}`
}

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
  const sourcePath = cleanPath(extra.sourcePath)
  // The raw-content host is an input to the manifest URL, not a fact about the repository, so it
  // is consumed here rather than spread into the row the panel renders.
  const { rawBase, ...rest } = extra
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
    // A package inside a repository is part of the target: the row, the manifest check and the
    // clone all have to address the same directory.
    sourcePath: sourcePath || null,
    source: sourcePath && raw.full_name ? `${raw.full_name}#${sourcePath}` : raw.full_name || null,
    manifestUrl: raw.full_name ? manifestUrlFor(raw.full_name, raw.default_branch || 'main', sourcePath, rawBase) : null,
    ...rest
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
 * @param {string} [options.topic] the topic that marks a plugin repository
 * @param {string} [options.apiBase] the REST API base, for an enterprise install or a mirror
 * @param {string} [options.rawBase] the raw-content base the manifest probes use
 * @param {string} [options.cloneBase] the git host the installer clones from
 * @param {Function} [options.config] `() => settings`, read on every call so a saved setting
 *   takes effect on the next request rather than on the next restart
 * @param {Function} [options.log]
 */
function createPluginStore(options = {}) {
  const request = typeof options.request === 'function' ? options.request : defaultRequest
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** Values fixed at construction: the deployment defaults a `config` may override. */
  const fixed = {
    token: options.token,
    topic: options.topic,
    apiBase: options.apiBase,
    rawBase: options.rawBase,
    cloneBase: options.cloneBase
  }
  const config = typeof options.config === 'function' ? options.config : null
  const history = []
  /** Default branches already resolved this session, so the store asks GitHub once per repo. */
  const defaultBranches = new Map()

  /**
   * The settings for *this* call.
   *
   * Everything below reads the configuration here rather than closing over it, which is what makes
   * the store's settings live: the shell owns the file, this asks it, and a token saved in the
   * panel is in force for the next search with no restart. A configuration that throws is a
   * settings failure, not a store failure — the defaults stand and the reason is logged.
   */
  function settings() {
    let supplied = fixed
    if (config) {
      try {
        const resolved = config()
        if (resolved && typeof resolved === 'object') supplied = { ...fixed, ...resolved }
      } catch (error) {
        log(`the store settings could not be read (${error?.message || error}); the defaults stand`)
      }
    }
    return resolveGithubSettings(supplied, { environmentToken: options.environmentToken })
  }

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
  async function defaultBranch(repo, input = {}) {
    const full = String(repo || '').trim()
    if (!full) return null
    const active = settings()
    if (defaultBranches.has(full)) return defaultBranches.get(full)
    const answer = await request(`${active.apiBase}/repos/${full}`, { token: active.token, timeoutMs: input.timeoutMs })
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
    const active = settings()
    // A named repository is not a search: it is a target. Answering it with a topic filter would
    // report "nothing found" for a repository the user is looking at in another window. A named
    // *package* inside a repository is a target too — `owner/repo#packages/pet`.
    const named = parseSource(query)
    if (named) {
      const answer = await request(`${active.apiBase}/repos/${named.repo}`, { token: active.token, timeoutMs: input.timeoutMs })
      if (!answer || answer.ok !== true) {
        const code = (answer && answer.code) || STORE_REASONS.UNREACHABLE
        const reason = code === STORE_REASONS.NO_MANIFEST
          ? `${named.repo} does not exist, or the store is not allowed to read it`
          : (answer && answer.reason) || 'the repository could not be read'
        return remember({ ok: false, code, reason })
      }
      const result = describeRepository(answer.json, { sourcePath: named.path, rawBase: active.rawBase, installable: null, manifestReason: 'not checked yet' })
      log(`store fetched the named ${named.path ? 'package' : 'repository'} ${named.source}`)
      return remember({
        ok: true,
        query: named.source,
        named: true,
        topic: null,
        total: 1,
        results: [result],
        rateLimit: answer.headers && answer.headers['x-ratelimit-remaining'] ? Number(answer.headers['x-ratelimit-remaining']) : null,
        authenticated: Boolean(active.token)
      })
    }
    const q = [query, topicOnly ? `topic:${active.topic}` : ''].filter(Boolean).join(' ')
    const url = `${active.apiBase}/search/repositories?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(String(input.sort || 'stars'))}&order=desc&per_page=${limit}`
    const answer = await request(url, { token: active.token, timeoutMs: input.timeoutMs })
    if (!answer || answer.ok !== true) {
      return remember({ ok: false, code: (answer && answer.code) || STORE_REASONS.UNREACHABLE, reason: (answer && answer.reason) || 'the search failed', resetAt: answer && answer.resetAt ? answer.resetAt : null })
    }
    const items = answer.json && Array.isArray(answer.json.items) ? answer.json.items : []
    const results = items.map((item) => describeRepository(item, { rawBase: active.rawBase, installable: null, manifestReason: 'not checked yet' }))
    log(`store search "${q}" returned ${results.length} of ${answer.json?.total_count ?? '?'} repositories`)
    return remember({
      ok: true,
      query: q,
      topic: topicOnly ? active.topic : null,
      total: Number.isFinite(answer.json?.total_count) ? answer.json.total_count : results.length,
      results,
      rateLimit: answer.headers && answer.headers['x-ratelimit-remaining'] ? Number(answer.headers['x-ratelimit-remaining']) : null,
      authenticated: Boolean(active.token)
    })
  }

  /**
   * Read a package's metadata, which is what the compatibility layer can adopt.
   *
   * Only the *possibility* is decided here, from the two things GitHub can tell us without cloning:
   * that a `package.json` exists and what it declares. The real derivation — which entry exists,
   * whether it needs a build, which dependencies are missing — happens after the clone, in
   * `compat.cjs`, against the files themselves. Saying more than that here would be guessing.
   */
  async function probeCompat(input = {}) {
    const active = settings()
    const url = packageUrlFor(input.id, input.branch || 'main', input.sourcePath, active.rawBase)
    if (!url) return { possible: false, probed: false, reason: 'the package metadata URL could not be built' }
    const answer = await request(url, { token: active.token, timeoutMs: input.timeoutMs })
    if (!answer || answer.ok !== true) {
      const code = (answer && answer.code) || STORE_REASONS.UNREACHABLE
      return {
        possible: false,
        probed: false,
        url,
        code,
        reason: code === STORE_REASONS.NO_MANIFEST
          ? 'there is no package.json either, so there is nothing to adopt'
          : (answer && answer.reason) || 'the package metadata could not be read'
      }
    }
    const pkg = answer.json && typeof answer.json === 'object' ? answer.json : null
    if (!pkg) return { possible: false, probed: true, url, reason: 'the package metadata is not JSON' }
    const dependencies = Object.keys(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {})
    const peers = Object.keys(pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {})
    const build = (pkg.scripts && (pkg.scripts.build || pkg.scripts.prepare)) || null
    return {
      possible: true,
      probed: true,
      url,
      kind: pkg.dsh || pkg.cordis ? 'dsh-bundle' : 'package',
      name: pkg.name ? String(pkg.name) : null,
      version: pkg.version ? String(pkg.version) : null,
      format: pkg.type === 'module' ? 'esm' : null,
      entry: typeof pkg.main === 'string' ? pkg.main : null,
      build,
      packages: [...new Set([...dependencies, ...peers])].slice(0, 25),
      note: 'what the package metadata already says; the entry, its build and its installed dependencies are confirmed after the clone'
    }
  }

  /**
   * Inspect one result: fetch its manifest and decide whether it is installable.
   *
   * A repository without a manifest is not an error — it is a repository that is not a native
   * plugin. Whether it can be *adopted* is a second question, and it is answered here rather than
   * left to a failure after the clone: the verdict carries `compat`, and a caller in compatibility
   * mode treats `possible: true` as "stage it and find out on disk" instead of as a refusal.
   */
  async function inspect(input = {}) {
    const repository = input.repository && typeof input.repository === 'object' ? input.repository : null
    const id = String(input.id || (repository && repository.id) || '').trim()
    const sourcePath = cleanPath(input.path || (repository && repository.sourcePath))
    let branch = String(input.branch || (repository && repository.branch) || '').trim()
    const active = settings()
    // A search result already carries the default branch; a bare `owner/name` does not, and
    // guessing `main` is what produces a wrong "no manifest" verdict for a `dev`-defaulted
    // repository. One API call settles it, and being unable to settle it is not a refusal.
    if (!branch && !input.manifestUrl && id && !repository) {
      const resolved = await defaultBranch(id, input)
      if (resolved) branch = resolved
    }
    const url = input.manifestUrl || (repository && repository.manifestUrl) || manifestUrlFor(id, branch || 'main', sourcePath, active.rawBase)
    if (!url) return remember({ ok: false, code: STORE_REASONS.BAD_QUERY, reason: 'a repository or a manifest URL is required' })
    // `verified` is the difference between "we looked where the manifest has to be" and "we
    // looked where it usually is": only a verified absence may refuse an install.
    const verified = Boolean(input.manifestUrl || branch)
    const answer = await request(url, { token: active.token, timeoutMs: input.timeoutMs })
    if (!answer || answer.ok !== true) {
      const code = (answer && answer.code) || STORE_REASONS.UNREACHABLE
      const where = branch ? `at ${branch}` : 'at its default branch (which could not be resolved, so main was tried)'
      if (code === STORE_REASONS.NO_MANIFEST) {
        // The native manifest is absent. Is there something to adopt? This is the difference
        // between "not a plugin" and "a plugin of another kind", and the store owes the user the
        // second answer when it is true.
        const compat = verified
          ? await probeCompat({ id, branch, sourcePath, timeoutMs: input.timeoutMs })
          : { possible: false, probed: false, reason: 'the default branch could not be resolved, so nothing could be probed' }
        const reason = `this repository has no ${MANIFEST_FILE} ${where}, so it is not a native plugin`
          + (compat.possible
            ? `; it can be adopted in compatibility mode (${compat.kind})`
            : compat.probed
              ? `, and it has no package.json to adopt either`
              : `, and whether it could be adopted is unknown (${compat.reason})`)
        return remember({ ok: true, url, installable: false, verified, branch: branch || null, sourcePath, code, reason, compat })
      }
      const reason = (answer && answer.reason) || 'the manifest could not be read'
      return remember({ ok: true, url, installable: false, verified, branch: branch || null, sourcePath, code, reason, compat: null })
    }
    // GitHub's raw endpoint returns text; the transport parses JSON when it can, so accept
    // both a parsed object and the raw text.
    const checked = typeof answer.json === 'object' && answer.json !== null
      ? checkManifest(JSON.stringify(answer.json), repository && repository.id)
      : checkManifest(answer.text || '', repository && repository.id)
    return remember({ ok: true, url, verified, branch: branch || null, sourcePath, compat: null, ...checked })
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
    authenticated: () => Boolean(settings().token),
    /**
     * Forget what was learned against one deployment.
     *
     * A resolved default branch is cached per session, and a resolved branch belongs to the host
     * that answered. Saving a token, a topic or an enterprise base therefore has to drop the
     * cache, or the next probe would address the new host with a fact learned from the old one.
     */
    forget() {
      defaultBranches.clear()
      return true
    },
    /** What the UI shows about the channel itself, and the settings it is using. */
    describe() {
      const active = settings()
      return {
        topic: active.topic,
        manifestFile: MANIFEST_FILE,
        apiVersion: PLUGIN_API_VERSION,
        authenticated: Boolean(active.token),
        tokenSource: active.tokenSource,
        tokenMask: active.tokenMask,
        apiBase: active.apiBase,
        rawBase: active.rawBase,
        cloneBase: active.cloneBase,
        refused: active.refused,
        note: 'Search the plugin topic, or name a repository (owner/name or its URL) to check it directly. Installation is a deliberate act: stage the code, then enable it in the manager.'
      }
    },
    /** The settings in force, for the shell that renders and persists them. */
    settings: () => settings()
  }
}

/**
 * The manifest URL for a repository, a branch and an optional package inside it.
 *
 * The `sourcePath` argument is what makes a monorepo package checkable *before* it is cloned: the
 * manifest of `owner/repo#packages/pet` is `packages/pet/dshns-plugin.json`, not the repository's.
 * `rawBase` is the deployment's raw-content host, which is github.com's unless the user set one.
 */
function manifestUrlFor(id, branch, sourcePath, rawBase) {
  const full = String(id || '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return null
  const clean = cleanPath(sourcePath)
  const file = clean ? `${clean}/${MANIFEST_FILE}` : MANIFEST_FILE
  return rawFileUrl(rawBase, full, branch || 'main', file)
}

/** The package metadata URL for the same target: what the compatibility layer reads to decide. */
function packageUrlFor(id, branch, sourcePath, rawBase) {
  const full = String(id || '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return null
  const clean = cleanPath(sourcePath)
  const file = clean ? `${clean}/package.json` : 'package.json'
  return rawFileUrl(rawBase, full, branch || 'main', file)
}

module.exports = {
  createPluginStore,
  checkManifest,
  describeRepository,
  manifestUrlFor,
  packageUrlFor,
  namedRepository,
  defaultRequest,
  resolveGithubSettings,
  normalizeBase,
  normalizeTopic,
  maskToken,
  PLUGIN_TOPIC,
  MANIFEST_FILE,
  DEFAULT_API_BASE,
  DEFAULT_RAW_BASE,
  DEFAULT_CLONE_BASE,
  GITHUB_SETTINGS,
  SETTING_LIMITS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STORE_REASONS
}
