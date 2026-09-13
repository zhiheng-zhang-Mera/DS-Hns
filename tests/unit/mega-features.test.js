'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MEGA_FEATURES,
  FEATURE_GROUPS,
  isKnownFeature,
  featureFor,
  featureForChannel,
  createFeatureState
} = require('../../app/extensions/mega/features.cjs')

/**
 * The Mega feature registry.
 *
 * The dock's features were markup plus IPC channels until this registry existed, which meant
 * nothing could enumerate them and nothing could switch one off. What the tests are about is
 * therefore the two properties that make a *manager* honest: the set is complete and
 * describable (every feature the dock renders is in it, with both languages), and "disabled"
 * is real state rather than a hidden element — a disabled feature's channels refuse, and an
 * id nobody knows is refused rather than stored.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function tempState(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-features-'))
  const state = createFeatureState({ file: path.join(dir, 'mega-features.json'), log: () => {}, ...options })
  return { state, dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('every feature has both names, a group and a purpose', () => {
  assert.ok(MEGA_FEATURES.length >= 10, `the dock renders more features than this (${MEGA_FEATURES.length})`)
  const ids = new Set()
  for (const feature of MEGA_FEATURES) {
    assert.match(feature.id, /^mega\.[a-z-]+$/, `${feature.id} is not a feature id`)
    assert.equal(ids.has(feature.id), false, `${feature.id} is listed twice`)
    ids.add(feature.id)
    assert.ok(feature.cn && feature.cn.length > 0, `${feature.id} has no Chinese name`)
    assert.ok(feature.en && feature.en.length > 0, `${feature.id} has no English name`)
    assert.ok(feature.purpose.cn && feature.purpose.en, `${feature.id} has no purpose in both languages`)
    assert.ok(FEATURE_GROUPS.includes(feature.group), `${feature.id} has an unknown group "${feature.group}"`)
    assert.ok(Array.isArray(feature.panels) && Array.isArray(feature.elements) && Array.isArray(feature.channels), `${feature.id} has a malformed declaration`)
    // A feature that owns nothing and answers nothing could not be switched off.
    assert.ok(feature.panels.length + feature.elements.length + feature.channels.length > 0, `${feature.id} declares no surface at all`)
  }
})

test('the registry covers the panels the dock actually renders', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const declared = new Set(MEGA_FEATURES.flatMap((feature) => feature.panels))
  const panels = [...html.matchAll(/<section class="panel[^"]*" id="([A-Za-z]+)"/g)].map((match) => match[1])
  assert.ok(panels.length >= 8, `expected the dock's panels (${panels.length})`)
  for (const panel of panels) {
    assert.ok(declared.has(panel), `${panel} is rendered by the dock but no feature declares it`)
  }
  // The reverse direction matters too: a feature that names a panel the dock does not have
  // is a switch that would silently do nothing.
  for (const panel of declared) {
    assert.match(html, new RegExp(`id="${panel}"`), `${panel} is declared by a feature but not rendered`)
  }
})

test('the marked elements exist, so disabling a feature hides something real', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const elements = MEGA_FEATURES.flatMap((feature) => feature.elements)
  assert.ok(elements.length >= 4, 'the peak/valley controls are the shared-panel case')
  for (const id of elements) {
    assert.match(html, new RegExp(`id="${id}"`), `the element ${id} is declared but not rendered`)
  }
})

test('a channel resolves to the feature that answers it', () => {
  assert.equal(featureForChannel('mega:balance').id, 'mega.balance')
  assert.equal(featureForChannel('engineering:run').id, 'mega.engineering')
  assert.equal(featureForChannel('sub-worker:snapshot').id, 'mega.sub-worker')
  assert.equal(featureForChannel('computer-use:snapshot').id, 'mega.computer-use')
  assert.equal(featureForChannel('plugins:status').id, 'mega.plugins')
  assert.equal(featureForChannel('mega:theme-apply').id, 'mega.theme')
  assert.equal(featureForChannel('mega:not-a-thing'), null)
  assert.equal(featureForChannel(''), null)
  assert.equal(isKnownFeature('mega.balance'), true)
  assert.equal(isKnownFeature('mega.nope'), false)
  assert.equal(featureFor('mega.nope'), null)
})

test('the state is durable, and an unknown id is refused rather than stored', () => {
  const { state, dir, dispose } = tempState()
  try {
    assert.equal(state.isEnabled('mega.balance'), true, 'features start on')
    assert.equal(state.setEnabled('mega.balance', false).ok, true)
    assert.equal(state.isEnabled('mega.balance'), false)
    assert.equal(state.setEnabled('mega.nope', false).code, 'FEATURE_NOT_FOUND')

    // A second reader sees the same state: it is on disk, not in memory.
    const reopened = createFeatureState({ file: path.join(dir, 'mega-features.json'), log: () => {} })
    assert.equal(reopened.isEnabled('mega.balance'), false)
    assert.equal(reopened.isEnabled('mega.theme'), true)
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'mega-features.json'), 'utf8'))
    assert.deepEqual(stored.features, { 'mega.balance': false })

    // An explicit "on" is written down too, so a feature shipped off by default can be
    // turned on and the decision survives a restart.
    assert.equal(state.setEnabled('mega.balance', true).ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'mega-features.json'), 'utf8')).features, { 'mega.balance': true })
  } finally {
    dispose()
  }
})

test('a state file with an unknown id reports the problem instead of trusting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-features-'))
  try {
    const file = path.join(dir, 'mega-features.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, features: { 'mega.balance': false, 'mega.ghost': false } }), 'utf8')
    const state = createFeatureState({ file, log: () => {} })
    assert.equal(state.isEnabled('mega.balance'), false, 'the known id still applies')
    assert.equal(state.issues().length, 1)
    assert.match(state.issues()[0], /unknown feature "mega\.ghost"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('describe reports the whole set with the dock map beside it', () => {
  const { state, dispose } = tempState()
  try {
    state.setEnabled('mega.theme', false)
    const described = state.describe()
    assert.equal(described.length, MEGA_FEATURES.length)
    const theme = described.find((entry) => entry.id === 'mega.theme')
    assert.equal(theme.enabled, false)
    assert.equal(theme.kind, 'feature')
    assert.equal(theme.group, 'Interface')
    assert.match(theme.cn, /主题/)
    const map = state.enabledMap()
    assert.equal(map['mega.theme'], false)
    assert.equal(map['mega.balance'], true)
    assert.equal(Object.keys(map).length, MEGA_FEATURES.length)
  } finally {
    dispose()
  }
})

test('a defaults map can ship a feature switched off', () => {
  const { state, dispose } = tempState({ defaults: { 'mega.update': false } })
  try {
    assert.equal(state.isEnabled('mega.update'), false)
    assert.equal(state.isEnabled('mega.balance'), true)
    // Turning it on overrides the default and is durable.
    state.setEnabled('mega.update', true)
    assert.equal(state.isEnabled('mega.update'), true)
  } finally {
    dispose()
  }
})
