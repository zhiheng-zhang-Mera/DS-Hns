'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createPluginStore,
  resolveGithubSettings,
  normalizeBase,
  normalizeTopic,
  maskToken,
  manifestUrlFor,
  DEFAULT_API_BASE,
  DEFAULT_RAW_BASE,
  DEFAULT_CLONE_BASE,
  PLUGIN_TOPIC,
  STORE_REASONS
} = require('../../app/extensions/mega/store/github-store.cjs')
const { createStoreInstaller } = require('../../app/extensions/mega/store/installer.cjs')

/**
 * The store's GitHub settings.
 *
 * A store that can only talk to github.com with whatever `GITHUB_TOKEN` the deployment happens to
 * export is a store a user cannot use: no token of their own, no company GitHub, no mirror. These
 * are the five values that make it usable, and the four properties that make them trustworthy:
 *
 *  * **They are read per call.** A setting saved in the panel is in force on the next request —
 *    no restart, and no second store instance holding a stale copy.
 *  * **The token is never returned.** The panel learns its tail and where it came from, which
 *    answers "is my token being used?" without putting a credential in a renderer.
 *  * **A value that will be ignored is refused, not stored.** A store that accepts a broken API
 *    base and then silently talks to github.com is worse than one that says the URL is wrong.
 *  * **No token still works.** Anonymous GitHub is rate limited, not unusable, and the answer says
 *    which of the two is in force rather than only whether one is.
 */

/** A transport that records every call and answers from a route table. */
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

const REPOSITORY = {
  full_name: 'acme/dshns-example',
  name: 'dshns-example',
  owner: { login: 'acme' },
  description: 'An example DS-Hns plugin',
  stargazers_count: 42,
  updated_at: '2026-01-01T00:00:00Z',
  default_branch: 'main',
  html_url: 'https://github.com/acme/dshns-example',
  topics: ['dshns-plugin']
}

test('the settings a user saves are the settings the next request uses', async () => {
  const transport = fakeTransport({ 'ghe.example.com': { ok: true, json: { total_count: 1, items: [REPOSITORY] }, headers: {} } })
  const store = createPluginStore({
    request: transport.request,
    config: () => ({
      token: 'ghp_averysecrettokenvalue1234567890',
      topic: 'company-plugin',
      apiBase: 'https://ghe.example.com/api/v3',
      rawBase: 'https://ghe.example.com/raw'
    })
  })
  const result = await store.search({ query: 'balance' })
  assert.equal(result.ok, true)
  // The API base is the deployment's, and the topic filter is the user's.
  assert.match(transport.calls[0].url, /^https:\/\/ghe\.example\.com\/api\/v3\/search\/repositories\?/)
  assert.match(transport.calls[0].url, /topic%3Acompany-plugin/)
  assert.equal(result.topic, 'company-plugin')
  // The token travels on the request, which is the whole point of having one.
  assert.equal(transport.calls[0].options.token, 'ghp_averysecrettokenvalue1234567890')
  assert.equal(result.authenticated, true)
  // And the raw host is the deployment's too, so a result's manifest is where that host serves it.
  assert.equal(result.results[0].manifestUrl, 'https://ghe.example.com/raw/acme/dshns-example/main/dshns-plugin.json')
  // The raw host is an input to that URL, not a fact about the repository.
  assert.equal(result.results[0].rawBase, undefined, 'the settings leaked into the row the panel renders')
})

test('the configuration is asked for on every call, so saving takes effect without a restart', async () => {
  const transport = fakeTransport({ 'example.com': { ok: true, json: { total_count: 0, items: [] }, headers: {} } })
  let settings = { topic: 'first-topic', apiBase: 'https://one.example.com' }
  const store = createPluginStore({ request: transport.request, config: () => settings })
  await store.search({ query: 'a' })
  assert.match(transport.calls[0].url, /^https:\/\/one\.example\.com\//)
  assert.match(transport.calls[0].url, /topic%3Afirst-topic/)

  // The shell wrote a new file; the very next call uses it.
  settings = { topic: 'second-topic', apiBase: 'https://two.example.com' }
  await store.search({ query: 'b' })
  assert.match(transport.calls[1].url, /^https:\/\/two\.example\.com\//)
  assert.match(transport.calls[1].url, /topic%3Asecond-topic/)
  // And the described channel moves with it, because it is described from the same resolution.
  assert.equal(store.describe().topic, 'second-topic')
  assert.equal(store.describe().apiBase, 'https://two.example.com')
})

test('a configuration that cannot be read is a settings failure, not a store failure', async () => {
  const transport = fakeTransport({ 'api.github.com': { ok: true, json: { total_count: 0, items: [] }, headers: {} } })
  const store = createPluginStore({
    request: transport.request,
    config: () => { throw new Error('the state file is on fire') }
  })
  const result = await store.search({ query: 'anything' })
  assert.equal(result.ok, true, 'a broken settings file must not take the store down')
  assert.match(transport.calls[0].url, /^https:\/\/api\.github\.com\//, 'the defaults must stand')
  assert.match(transport.calls[0].url, new RegExp(`topic%3A${PLUGIN_TOPIC}`))
})

test('an unusable setting falls back to the default instead of building a broken request', async () => {
  const transport = fakeTransport({ 'api.github.com': { ok: true, json: { total_count: 0, items: [] }, headers: {} } })
  const store = createPluginStore({
    request: transport.request,
    config: () => ({ apiBase: 'not a url', rawBase: 'ftp://files.example.com', topic: 'Not A Topic', cloneBase: 'javascript:alert(1)' })
  })
  const described = store.describe()
  assert.equal(described.apiBase, DEFAULT_API_BASE)
  assert.equal(described.rawBase, DEFAULT_RAW_BASE)
  assert.equal(described.cloneBase, DEFAULT_CLONE_BASE)
  assert.equal(described.topic, PLUGIN_TOPIC)
  await store.search({ query: 'x' })
  assert.match(transport.calls[0].url, /^https:\/\/api\.github\.com\/search\/repositories\?/)
})

test('the described settings never carry the token, only its tail and where it came from', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const store = createPluginStore({ request: async () => ({ ok: true, json: {} }), token: secret })
  const described = store.describe()
  assert.equal(described.authenticated, true)
  assert.equal(described.tokenSource, 'user')
  assert.equal(described.tokenMask, 'ghp_…6789')
  // The one assertion that matters: whatever else the describe payload grows, it cannot contain
  // the credential. This is the answer a renderer receives.
  assert.equal(JSON.stringify(described).includes(secret), false, 'the store handed a renderer the token')
  assert.equal(JSON.stringify(described).includes('abcdefghijklmnop'), false, 'the mask leaked the middle of the token')

  // Where it came from is part of the answer: a user who set a token and still sees `environment`
  // has learned that their value did not land.
  const fromEnvironment = resolveGithubSettings({}, { environmentToken: secret })
  assert.equal(fromEnvironment.tokenSource, 'environment')
  assert.equal(fromEnvironment.tokenMask, 'ghp_…6789')
  const none = resolveGithubSettings({}, { environmentToken: '' })
  assert.equal(none.tokenSource, 'none')
  assert.equal(none.token, null)
  assert.equal(none.tokenMask, null)
})

test('a user token wins over the environment, and clearing it falls back to the environment', () => {
  const environment = 'ghp_environment0000000000000000000000'
  const user = 'ghp_user00000000000000000000000000000'
  const chosen = resolveGithubSettings({ token: user }, { environmentToken: environment })
  assert.equal(chosen.token, user)
  assert.equal(chosen.tokenSource, 'user')
  // Clearing the field is not "no token at all": the deployment's own token is still there.
  const cleared = resolveGithubSettings({ token: '' }, { environmentToken: environment })
  assert.equal(cleared.token, environment)
  assert.equal(cleared.tokenSource, 'environment')
})

test('a token that is too short to hint at is masked completely', () => {
  // Four plus four characters of a nine-character token is the token.
  assert.equal(maskToken('short'), '•••••')
  assert.equal(maskToken('123456789012345'), '••••••••')
  assert.equal(maskToken('1234567890123456'), '1234…3456')
  assert.equal(maskToken(''), null)
  assert.equal(maskToken(null), null)
})

test('only https is accepted as a base, with loopback as the one exception', () => {
  assert.equal(normalizeBase('https://ghe.example.com/api/v3/', DEFAULT_API_BASE), 'https://ghe.example.com/api/v3')
  assert.equal(normalizeBase('http://ghe.example.com', DEFAULT_API_BASE), DEFAULT_API_BASE, 'a token must not travel over plain HTTP to a remote host')
  assert.equal(normalizeBase('http://localhost:3000', DEFAULT_API_BASE), 'http://localhost:3000')
  assert.equal(normalizeBase('http://127.0.0.1:8080', DEFAULT_API_BASE), 'http://127.0.0.1:8080')
  assert.equal(normalizeBase('', DEFAULT_RAW_BASE), DEFAULT_RAW_BASE)
  assert.equal(normalizeBase(`${'https://example.com/'}${'x'.repeat(600)}`, DEFAULT_RAW_BASE), DEFAULT_RAW_BASE)
  assert.equal(normalizeTopic('My-Plugins'), 'my-plugins')
  assert.equal(normalizeTopic('has space', PLUGIN_TOPIC), PLUGIN_TOPIC)
  assert.equal(normalizeTopic('', PLUGIN_TOPIC), PLUGIN_TOPIC)
  assert.equal(normalizeTopic('-leading', PLUGIN_TOPIC), PLUGIN_TOPIC)
})

test('the manifest URL follows the raw host the user set, and defaults when they set none', () => {
  assert.equal(
    manifestUrlFor('acme/example', 'dev', 'packages/pet'),
    `${DEFAULT_RAW_BASE}/acme/example/dev/packages/pet/dshns-plugin.json`
  )
  assert.equal(
    manifestUrlFor('acme/example', 'dev', null, 'https://raw.internal.example'),
    'https://raw.internal.example/acme/example/dev/dshns-plugin.json'
  )
  // A repository id that is not owner/name is refused whatever the base is.
  assert.equal(manifestUrlFor('not-a-repo', 'main', null, 'https://raw.internal.example'), null)
})

test('a named repository, a bare repository and a branch probe all use the configured API base', async () => {
  const transport = fakeTransport({
    'ghe.example.com/api/v3/repos/acme/example': { ok: true, json: { ...REPOSITORY, full_name: 'acme/example', default_branch: 'dev' }, headers: {} },
    'ghe.example.com/api/v3/repos/acme/named': { ok: true, json: { ...REPOSITORY, full_name: 'acme/named' }, headers: {} },
    'ghe.example.com/raw/acme/example/dev/dshns-plugin.json': { ok: true, json: null, text: '{"api_version":"dshns.plugin/v1","id":"a.b","name":"A","version":"1.0.0"}' }
  })
  const store = createPluginStore({
    request: transport.request,
    config: () => ({ apiBase: 'https://ghe.example.com/api/v3', rawBase: 'https://ghe.example.com/raw' })
  })
  const named = await store.search({ query: 'acme/named' })
  assert.equal(named.ok, true)
  assert.match(transport.calls[0].url, /^https:\/\/ghe\.example\.com\/api\/v3\/repos\/acme\/named$/)

  const inspected = await store.inspect({ id: 'acme/example' })
  assert.equal(inspected.branch, 'dev', 'the branch probe did not use the configured API base')
  assert.equal(inspected.installable, true)
  assert.match(inspected.url, /^https:\/\/ghe\.example\.com\/raw\//)
})

test('changing where the store talks forgets what the old host answered', async () => {
  const transport = fakeTransport({
    'one.example.com': { ok: true, json: { default_branch: 'dev' }, status: 200 },
    'two.example.com': { ok: true, json: { default_branch: 'main' }, status: 200 }
  })
  let settings = { apiBase: 'https://one.example.com' }
  const store = createPluginStore({ request: transport.request, config: () => settings })
  assert.equal(await store.defaultBranch('acme/example'), 'dev')
  // The same repository on another host is another repository: a cached branch would be a fact
  // about the wrong server.
  settings = { apiBase: 'https://two.example.com' }
  assert.equal(await store.defaultBranch('acme/example'), 'dev', 'the cached branch stands until the shell says otherwise')
  store.forget()
  assert.equal(await store.defaultBranch('acme/example'), 'main')
})

test('a search without a token is rate limited, not broken', async () => {
  const transport = fakeTransport({ 'api.github.com': { ok: true, json: { total_count: 0, items: [] }, headers: {} } })
  const store = createPluginStore({ request: transport.request, environmentToken: '' })
  const result = await store.search({ query: 'anything' })
  assert.equal(result.ok, true)
  assert.equal(result.authenticated, false)
  assert.equal(transport.calls[0].options.token, null, 'an absent token must not become the string "null"')
  assert.equal(store.authenticated(), false)
  assert.equal(store.describe().tokenSource, 'none')
})

test('the installer clones from the host the store searched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-clone-base-'))
  try {
    const clones = []
    const installer = createStoreInstaller({
      root: dir,
      probe: async () => null,
      log: () => {},
      cloneBase: () => 'https://git.internal.example',
      clone: (url, target, options) => {
        clones.push({ url, options })
        return { ok: false, reason: 'the clone is not the subject of this test' }
      }
    })
    const result = installer.stage({ repo: 'acme/example', branch: 'main' })
    assert.equal(result.ok, false)
    assert.equal(clones.length, 1, 'nothing was cloned')
    assert.equal(clones[0].url, 'https://git.internal.example/acme/example.git')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the installer falls back to github.com when no clone host is configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-clone-default-'))
  try {
    const clones = []
    const installer = createStoreInstaller({
      root: dir,
      probe: async () => null,
      log: () => {},
      clone: (url) => {
        clones.push(url)
        return { ok: false, reason: 'not the subject of this test' }
      }
    })
    installer.stage({ repo: 'acme/example', branch: 'main' })
    assert.equal(clones[0], `${DEFAULT_CLONE_BASE}/acme/example.git`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The wiring: a setting that no surface can set is not a setting.
 *
 * These are the assertions that keep the five values reachable from the place a user is standing —
 * the shell that owns the file, the bridge that crosses the process boundary, and the store tab
 * that renders them.
 */
test('the settings are wired end to end: shell file, channels, bridge and the store tab', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8')
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const featureManager = read('app/extensions/mega/ui/feature-manager.js')
  const store = read('app/extensions/mega/store/github-store.cjs')
  const installer = read('app/extensions/mega/store/installer.cjs')
  const css = read('app/extensions/mega/ui/dock.css')

  // The channels are declared for cleanup and registered.
  assert.match(index, /'mega:store-github', 'mega:store-github-set'/, 'the GitHub channels are not declared for cleanup')
  assert.match(index, /ipcMain\.handle\('mega:store-github'[\s\S]{0,120}describeStoreGithub\(\)/)
  assert.match(index, /ipcMain\.handle\('mega:store-github-set'[\s\S]{0,120}setStoreGithub\(/)
  // The settings live beside the compatibility decision, in the store's own state file.
  assert.match(index, /data', 'state', 'plugin-store\.json'/, 'the settings are not stored beside the other store state')
  // The store resolves them per call rather than taking a snapshot at construction.
  assert.match(index, /config: \(\) => \{[\s\S]{0,200}readStoreState\(\)\.github/, 'the store is created with a snapshot instead of a resolver')
  assert.match(store, /function settings\(\)[\s\S]{0,400}config\(\)/, 'the store never asks for its settings')
  // Installation follows the same host, or a mirror would list plugins it cannot fetch.
  assert.match(index, /cloneBase: \(\) => storeGithubSettings\(\)\.cloneBase/, 'the installer clones from a hard-coded host')
  assert.match(installer, /cloneUrlFor\(repo\)/, 'the clone URL is not built from the setting')
  // A refused value is refused, not silently stored.
  assert.match(index, /if \(refused\.length\) \{[\s\S]{0,200}ok: false, refused/, 'a refused setting is stored anyway')
  // Saving forgets what the previous host answered.
  assert.match(index, /pluginStore\.forget\(\)/, 'a changed host keeps the old host\'s cached branches')

  // The bridge: reading never carries the token, writing takes only what the caller names.
  assert.match(preload, /github: \(\) => ipcRenderer\.invoke\('mega:store-github'\)/)
  assert.match(preload, /setGithub: \(patch\) => ipcRenderer\.invoke\('mega:store-github-set', patch\)/)

  // The store tab renders them, and the token field is a password that is never prefilled.
  assert.match(featureManager, /function githubRow\(\)/, 'the store has no GitHub settings row')
  assert.match(featureManager, /body\.appendChild\(githubRow\(\)\)/, 'the settings row is not rendered in the store tab')
  assert.match(featureManager, /window\.megaTools\?\.store\?\.github\?\.\(\)/, 'the row never reads the settings in force')
  assert.match(featureManager, /window\.megaTools\?\.store\?\.setGithub\?\.\(patch\)/, 'the row never saves')
  assert.match(featureManager, /input\.type = options\.type \|\| 'text'/, 'the token field is not a password field')
  assert.match(featureManager, /if \(clearToken\) \{\s*patch\.token = ''/, 'an empty token field must not erase a working credential')
  assert.match(css, /\.pm-github-grid\{/, 'the settings row has no layout')
})
