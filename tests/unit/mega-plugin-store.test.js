'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createPluginStore,
  checkManifest,
  manifestUrlFor,
  describeRepository,
  PLUGIN_TOPIC,
  MANIFEST_FILE,
  STORE_REASONS
} = require('../../app/extensions/mega/store/github-store.cjs')

/**
 * The plugin store channel.
 *
 * The store's whole job is to answer two questions honestly: *what exists on GitHub* and *is
 * this one actually a plugin*. The second is what keeps a search result from becoming
 * arbitrary code, so the tests are mostly about the refusals — a repository with no manifest,
 * a manifest the platform's own validator rejects, an API version this host does not speak,
 * a rate limit that must be reported rather than retried into a hang.
 */
function fakeTransport(routes) {
  const calls = []
  return {
    calls,
    request: async (url, options = {}) => {
      calls.push({ url, options })
      for (const [pattern, answer] of Object.entries(routes)) {
        if (url.includes(pattern)) return typeof answer === 'function' ? answer(url, options) : answer
      }
      return { ok: false, code: STORE_REASONS.UNREACHABLE, reason: `no route for ${url}` }
    }
  }
}

const VALID_MANIFEST = {
  api_version: 'dshns.plugin/v1',
  id: 'vendor.example-plugin',
  name: 'Example',
  version: '1.2.3',
  description: 'An example plugin',
  provides: ['dshns.example'],
  fault_level: 'soft'
}

function repository(overrides = {}) {
  return {
    full_name: 'acme/dshns-example',
    name: 'dshns-example',
    owner: { login: 'acme' },
    description: 'An example DS-Hns plugin',
    stargazers_count: 42,
    updated_at: '2026-01-01T00:00:00Z',
    default_branch: 'main',
    html_url: 'https://github.com/acme/dshns-example',
    topics: ['dshns-plugin', 'harness'],
    ...overrides
  }
}

test('a search asks GitHub for the plugin topic and normalises the answer', async () => {
  const transport = fakeTransport({
    'api.github.com/search/repositories': {
      ok: true,
      json: { total_count: 1, items: [repository()] },
      headers: { 'x-ratelimit-remaining': '9' }
    }
  })
  const store = createPluginStore({ request: transport.request })
  const result = await store.search({ query: 'balance' })
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 1)
  assert.equal(result.total, 1)
  const [repo] = result.results
  assert.equal(repo.id, 'acme/dshns-example')
  assert.equal(repo.stars, 42)
  assert.equal(repo.branch, 'main')
  assert.equal(repo.manifestUrl, `https://raw.githubusercontent.com/acme/dshns-example/main/${MANIFEST_FILE}`)
  assert.deepEqual(repo.topics.slice(0, 2), ['dshns-plugin', 'harness'])
  // The topic filter is what makes "a plugin" mean something; the free text rides along.
  assert.match(transport.calls[0].url, /q=balance\+topic%3Adshns-plugin|q=balance%20topic%3Adshns-plugin/)
  assert.equal(result.authenticated, false)
  assert.equal(store.describe().topic, PLUGIN_TOPIC)
  assert.match(store.describe().note, /installation is a deliberate act/i)
})

test('a search with no query still lists the topic, and the topic can be dropped', async () => {
  const transport = fakeTransport({ 'api.github.com': { ok: true, json: { items: [] }, headers: {} } })
  const store = createPluginStore({ request: transport.request })
  await store.search({})
  assert.match(transport.calls[0].url, /topic%3Adshns-plugin/)
  await store.search({ query: 'harness', topic: false })
  assert.equal(/topic%3A/.test(transport.calls[1].url), false, 'the topic filter must be optional')
})

test('a rate limit is a refusal with the reset time, not a retry', async () => {
  const transport = fakeTransport({
    'api.github.com': { ok: false, code: STORE_REASONS.RATE_LIMITED, status: 403, resetAt: 1_800_000_000_000, reason: 'the rate limit is exhausted' }
  })
  const store = createPluginStore({ request: transport.request })
  const result = await store.search({ query: 'anything' })
  assert.equal(result.ok, false)
  assert.equal(result.code, STORE_REASONS.RATE_LIMITED)
  assert.equal(result.resetAt, 1_800_000_000_000)
  assert.equal(transport.calls.length, 1, 'a refused search must not be retried')
})

test('an over-long query is refused before it reaches the network', async () => {
  const transport = fakeTransport({})
  const store = createPluginStore({ request: transport.request })
  const result = await store.search({ query: 'x'.repeat(200) })
  assert.equal(result.ok, false)
  assert.equal(result.code, STORE_REASONS.BAD_QUERY)
  assert.equal(transport.calls.length, 0)
})

test('a repository with no manifest is listed as not installable, with the reason', async () => {
  const transport = fakeTransport({
    'raw.githubusercontent.com': { ok: false, code: STORE_REASONS.NO_MANIFEST, status: 404, reason: 'not found' }
  })
  const store = createPluginStore({ request: transport.request })
  const result = await store.inspect({ repository: describeRepository(repository()) })
  assert.equal(result.ok, true)
  assert.equal(result.installable, false)
  assert.match(result.reason, /no dshns-plugin\.json/)
})

test('a manifest the platform rejects is not installable, and says why', async () => {
  const cases = [
    [{ api_version: 'dshns.plugin/v2', id: 'a.b', name: 'A', version: '1.0.0' }, /api_version|invalid/],
    [{ api_version: 'dshns.plugin/v1', name: 'A', version: '1.0.0' }, /invalid/],
    ['{ not json', /not valid JSON/]
  ]
  for (const [manifest, pattern] of cases) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    const transport = fakeTransport({ 'raw.githubusercontent.com': { ok: true, json: null, text: body } })
    const store = createPluginStore({ request: transport.request })
    const result = await store.inspect({ id: 'acme/example', branch: 'main' })
    assert.equal(result.installable, false, JSON.stringify(manifest))
    assert.equal(result.code, STORE_REASONS.BAD_MANIFEST)
    assert.match(result.reason, pattern)
  }
})

test('a valid manifest makes a result installable, with the facts the manager shows', async () => {
  const transport = fakeTransport({
    'raw.githubusercontent.com': { ok: true, json: VALID_MANIFEST, text: JSON.stringify(VALID_MANIFEST) }
  })
  const store = createPluginStore({ request: transport.request })
  const result = await store.inspect({ repository: describeRepository(repository()) })
  assert.equal(result.ok, true)
  assert.equal(result.installable, true)
  assert.equal(result.manifest.id, 'vendor.example-plugin')
  assert.equal(result.manifest.version, '1.2.3')
  assert.deepEqual(result.manifest.provides, ['dshns.example'])
  assert.equal(result.manifest.owner, 'acme/dshns-example')
  assert.equal(result.reason, null)
})

test('a token is used when the deployment has one, and the channel can be described', () => {
  const store = createPluginStore({ request: async () => ({ ok: true, json: { items: [] } }), token: 'ghp_example' })
  assert.equal(store.authenticated(), true)
  assert.equal(store.describe().authenticated, true)
  assert.equal(store.describe().apiVersion, 'dshns.plugin/v1')
  assert.equal(store.describe().manifestFile, 'dshns-plugin.json')
})

test('a repository id that is not owner/name produces no manifest URL', () => {
  assert.equal(manifestUrlFor('acme/example', 'main'), `https://raw.githubusercontent.com/acme/example/main/${MANIFEST_FILE}`)
  assert.equal(manifestUrlFor('not-a-repo', 'main'), null)
  assert.equal(manifestUrlFor('', 'main'), null)
  assert.equal(manifestUrlFor('a/b/c', 'main'), null)
  // The validator is exported so a future store front-end can check a pasted manifest too.
  assert.equal(checkManifest(JSON.stringify(VALID_MANIFEST)).installable, true)
})
