'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Theme contract + package validator.
 *
 * These tests are the enforcement layer for the hard rules of the unified theme
 * engineering spec: slot permissions, declarative-only packages, self-containment,
 * API compatibility, readability and HNS state separability.
 */
const contract = require('../../app/extensions/mega/theme/contract')
const color = require('../../app/extensions/mega/theme/color')
const validator = require('../../app/extensions/mega/theme/validator')

const BUILTIN = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'theme', 'builtin')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hns-theme-validator-'))
}

function writeTheme(dir, { manifest, tokens, components, persona, extraFiles = {} }) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  const write = (name, value) => {
    if (value === undefined) return
    fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
  write('manifest.json', manifest)
  write('tokens.json', tokens)
  write('components.json', components)
  write('persona.json', persona)
  for (const [name, value] of Object.entries(extraFiles)) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
  return dir
}

function baseManifest(overrides = {}) {
  return {
    id: 'hns.test.theme',
    name: 'Test Theme',
    version: '1.0.0',
    source: 'generated',
    protected: false,
    theme_api_version: contract.THEME_API_VERSION,
    supported_apps: ['hns'],
    generated_prompt: null,
    revision_history: [],
    derived_from: null,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('the Theme API exposes a versioned slot table', () => {
  assert.equal(contract.THEME_API_VERSION, '1.0')
  assert.ok(contract.SLOT_IDS.length >= 30, 'the slot vocabulary is materially larger than the generic list')
  // `common` and `hns` address the hns_native surface; `official` addresses the
  // official shell / overlay surfaces (and describes the protected renderer).
  for (const slotId of contract.SLOT_IDS) {
    const slot = contract.SLOTS[slotId]
    assert.match(slotId, /^(common|hns|official)\./, `slot ${slotId} follows the <app>.<domain>.<component> naming rule`)
    assert.ok(Object.values(contract.PERMISSION).includes(slot.permission), `slot ${slotId} declares a known permission`)
    assert.ok(Array.isArray(slot.properties))
  }
})

test('the four Theme Surfaces are part of the contract and the protected one is never writable', () => {
  const surface = require('../../app/extensions/mega/theme/surface')
  assert.deepEqual([...contract.SURFACE_PERMISSION ? Object.keys(contract.SURFACE_PERMISSION) : []].sort(), ['FULL', 'PROTECTED', 'VISUAL_ONLY'])
  assert.deepEqual([...surface.SURFACE_IDS].sort(), ['hns_native', 'official_overlay', 'official_renderer', 'official_shell'])
  // Every surface is independently queryable and declares its own permission.
  const byId = Object.fromEntries(surface.describe().map((entry) => [entry.id, entry]))
  assert.equal(byId.hns_native.permission, 'full')
  assert.equal(byId.official_shell.permission, 'full')
  assert.equal(byId.official_overlay.permission, 'visual-only')
  assert.equal(byId.official_renderer.permission, 'protected')
  assert.equal(byId.hns_native.writable, true)
  assert.equal(byId.official_shell.writable, true)
  assert.equal(byId.official_overlay.writable, true)
  assert.equal(byId.official_renderer.writable, false)
  // The visual-only layer may not participate in input at all.
  for (const key of ['pointer', 'keyboard', 'focus', 'scroll']) {
    assert.equal(byId.official_overlay.input[key], false, `the overlay must not take ${key} input`)
  }
  assert.equal(byId.official_overlay.input.passthrough, true)
})

test('no theme writer can address the protected official renderer', () => {
  const surface = require('../../app/extensions/mega/theme/surface')
  for (const kind of ['asset', 'component', 'layout', 'override']) {
    const verdict = surface.assertWritable(contract.SURFACE.OFFICIAL_RENDERER, { kind, assetKind: 'official_character' })
    assert.equal(verdict.ok, false, `${kind} writes to the official renderer must be refused`)
    assert.equal(verdict.code, 'surface_protected')
  }
  // ...and the refusal names the surface and the permission, so a caller can log it.
  const verdict = surface.assertWritable('official_renderer')
  assert.equal(verdict.surface, 'official_renderer')
  assert.equal(verdict.permission, 'protected')
  assert.match(verdict.reason, /PROTECTED/)
  // An asset kind the surface does not accept is refused too, per surface.
  assert.equal(surface.assertWritable('official_overlay', { kind: 'asset', assetKind: 'persona_avatar' }).ok, false)
  assert.equal(surface.assertWritable('official_overlay', { kind: 'asset', assetKind: 'official_character' }).ok, true)
  assert.equal(surface.assertWritable('official_shell', { kind: 'asset', assetKind: 'frame_decoration' }).ok, true)
  // A payload that names a protected surface as a target is detected anywhere.
  const hits = surface.violationsIn({ overlay_plan: { components: { character: { surface: 'official_renderer' } } } }, ['pkg'])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].code, 'surface_protected')
  assert.equal(surface.violationsIn({ note: 'official_renderer is protected' }, ['pkg']).length, 0)
})

test('the slots a surface owns are attributed to that surface, not to the dock', () => {
  const capability = require('../../app/extensions/mega/theme/capability')
  const surface = require('../../app/extensions/mega/theme/surface')
  assert.equal(surface.surfaceOfSlot('hns.worker.card'), 'hns_native')
  assert.equal(surface.surfaceOfSlot('official.shell.frame'), 'official_shell')
  assert.equal(surface.surfaceOfSlot('official.overlay.character_primary'), 'official_overlay')
  assert.equal(surface.surfaceOfSlot('official.renderer.dom'), 'official_renderer')
  const manifest = capability.buildManifest({})
  for (const slotId of contract.SLOT_IDS) {
    assert.equal(
      manifest.slots[slotId].surface,
      surface.surfaceOfSlot(slotId),
      `manifest slot ${slotId} declares the surface it actually belongs to`
    )
  }
  // The protected renderer's slots are described but never generator-writable.
  const rendererSlots = Object.entries(manifest.slots).filter(([, slot]) => slot.surface === contract.SURFACE.OFFICIAL_RENDERER)
  assert.ok(rendererSlots.length >= 4, 'the protected surface is described honestly')
  for (const [slotId, slot] of rendererSlots) {
    assert.equal(slot.permission, contract.PERMISSION.STRUCTURAL, `${slotId} must be STRUCTURAL`)
    assert.ok(!contract.GENERATOR_PERMISSIONS.includes(slot.permission))
  }
})

test('every HNS-specialization slot family is exposed', () => {
  for (const prefix of ['hns.window.', 'hns.worker.', 'hns.process.', 'hns.hardware.', 'hns.log.', 'hns.status.', 'hns.tray.', 'hns.operator.']) {
    assert.ok(
      contract.SLOT_IDS.some((slotId) => slotId.startsWith(prefix)),
      `slot family ${prefix}* is exposed by the runtime`
    )
  }
})

test('structural slots exist in the manifest but are excluded from generator permissions', () => {
  const structural = contract.SLOT_IDS.filter((id) => contract.SLOTS[id].permission === contract.PERMISSION.STRUCTURAL)
  assert.ok(structural.length >= 3, 'layout slots are described so the manifest is honest')
  for (const slotId of structural) {
    assert.ok(!contract.GENERATOR_PERMISSIONS.includes(contract.SLOTS[slotId].permission))
  }
})

test('the canonical HNS state vocabulary is exactly the specialization list', () => {
  assert.deepEqual([...contract.HNS_STATES], [
    'idle', 'running', 'waiting', 'blocked', 'warning', 'failed',
    'completed', 'resource_limit', 'primary_worker', 'sub_worker'
  ])
  for (const state of contract.HNS_STATES) {
    assert.ok(contract.TOKENS[`state.${state}`], `state token for ${state} is part of the token schema`)
  }
})

test('every token declares a css variable, a kind and a fallback', () => {
  for (const name of contract.TOKEN_NAMES) {
    const token = contract.TOKENS[name]
    assert.match(token.css, /^--hns-/, `token ${name} binds an --hns-* custom property`)
    assert.ok(Object.values(contract.PROPERTY_KIND).includes(token.kind), `token ${name} declares a known kind`)
    assert.notEqual(token.fallback, undefined, `token ${name} declares a Dark fallback`)
  }
})

test('animation presets expose a bounded intensity envelope', () => {
  assert.deepEqual([...contract.ANIMATION_PRESETS], ['none', 'fade', 'pulse', 'glow', 'slide', 'soft_blur'])
  for (const preset of contract.ANIMATION_PRESETS) {
    const max = contract.ANIMATION_MAX_INTENSITY[preset]
    assert.equal(typeof max, 'number')
    assert.ok(max <= 0.6, `preset ${preset} is clamped to a modest intensity`)
  }
  assert.equal(contract.ANIMATION_MAX_INTENSITY.none, 0)
})

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

test('contrast ratio matches known WCAG reference values', () => {
  assert.equal(Number(color.contrastRatio('#000000', '#ffffff').toFixed(2)), 21)
  assert.equal(Number(color.contrastRatio('#ffffff', '#ffffff').toFixed(2)), 1)
  assert.equal(Number(color.contrastRatio('#767676', '#ffffff').toFixed(2)), 4.54)
})

test('semi-transparent foregrounds are composited before measuring', () => {
  const opaque = color.contrastRatio('#000000', '#ffffff')
  const translucent = color.contrastRatio('rgba(0,0,0,0.5)', '#ffffff')
  assert.ok(translucent < opaque, 'a translucent label contrasts less than an opaque one')
  assert.ok(translucent > 1)
})

test('perceptual distance separates distinct colours and collapses identical ones', () => {
  assert.equal(color.distance('#4d93f8', '#4d93f8'), 0)
  assert.ok(color.distance('#4d93f8', '#ef5d5d') > contract.STATE_MIN_DISTANCE)
  assert.ok(color.distance('#4d93f8', '#4d95fa') < contract.STATE_MIN_DISTANCE)
})

test('invalid colour strings are rejected instead of guessed', () => {
  assert.equal(color.parseColor('not-a-colour'), null)
  assert.equal(color.parseColor(''), null)
  assert.equal(color.parseColor(undefined), null)
  assert.equal(color.contrastRatio('not-a-colour', '#ffffff'), null)
})

// ---------------------------------------------------------------------------
// validator: built-in packages
// ---------------------------------------------------------------------------

test('every built-in theme package passes the package validator', () => {
  const records = [
    ['system/dark', 'hns.system.dark'],
    ['system/light', 'hns.system.light'],
    ['demo/minimal-neutral', 'hns.demo.minimal'],
    ['demo/anime-persona', 'hns.demo.anime-persona'],
    ['demo/cyber-hud', 'hns.demo.cyber-hud']
  ]
  for (const [relative, id] of records) {
    const dir = path.join(BUILTIN, relative)
    assert.ok(fs.existsSync(dir), `built-in package ${relative} is committed`)
    const report = validator.validatePackage({ dir, expectedId: id })
    const messages = report.errors.map((issue) => `${issue.code}: ${issue.message}`).join('\n')
    assert.ok(report.ok, `built-in theme ${id} validates\n${messages}`)
    assert.equal(report.metadata.id, id)
  }
})

test('Dark is the protected system theme and the documented fallback source', () => {
  const dir = path.join(BUILTIN, 'system', 'dark')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.protected, true)
  assert.equal(manifest.deletable, false)
  assert.equal(manifest.editable, false)
  assert.equal(manifest.system_theme, true)
  assert.equal(manifest.source, 'system')
})

test('Light is equally protected', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'system', 'light', 'manifest.json'), 'utf8'))
  assert.equal(manifest.protected, true)
  assert.equal(manifest.deletable, false)
  assert.equal(manifest.editable, false)
  assert.equal(manifest.system_theme, true)
})

// ---------------------------------------------------------------------------
// validator: rejection paths
// ---------------------------------------------------------------------------

test('a missing manifest is rejected', () => {
  const dir = tempDir()
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'manifest_missing'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unparsable manifest is rejected rather than throwing', () => {
  const dir = writeTheme(tempDir(), { manifest: '{ not json' })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'manifest_unparsable'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a theme requiring a newer Theme API is refused', () => {
  const dir = writeTheme(tempDir(), { manifest: baseManifest({ theme_api_version: '2.0' }), tokens: {} })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'api_version_unsupported'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an older Theme API version is accepted so legacy themes keep working', () => {
  const dir = writeTheme(tempDir(), { manifest: baseManifest({ theme_api_version: '1.0' }), tokens: {} })
  const report = validator.validatePackage({ dir })
  assert.ok(!report.errors.some((issue) => issue.code.startsWith('api_version')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runtime theme dependencies are illegal in the manifest', () => {
  for (const field of ['parent_theme', 'required_theme', 'extends', 'inherits', 'base_theme', 'depends_on']) {
    const dir = writeTheme(tempDir(), { manifest: baseManifest({ [field]: 'theme-x' }), tokens: {} })
    const report = validator.validatePackage({ dir })
    assert.equal(report.ok, false, `${field} must be rejected`)
    assert.ok(report.errors.some((issue) => issue.code === 'manifest_forbidden_dependency'))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('derived_from is accepted as metadata only', () => {
  const dir = writeTheme(tempDir(), { manifest: baseManifest({ derived_from: 'theme-a' }), tokens: {} })
  const report = validator.validatePackage({ dir })
  assert.ok(report.ok, 'derived_from never participates in resolution, so it is legal metadata')
  assert.equal(report.metadata.id, 'hns.test.theme')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('any executable file inside a package is rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: {},
    extraFiles: { 'assets/icons/payload.js': 'module.exports = 1', 'assets/panels/helper.ps1': 'Write-Host x' }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  const codes = report.errors.map((issue) => issue.code)
  assert.equal(codes.filter((code) => code === 'executable_payload').length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a declared asset that is missing from the package is rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'asset.wallpaper': 'assets/wallpapers/main.png' }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'asset_missing'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a declared asset that exists inside the package is accepted', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'asset.wallpaper': 'assets/wallpapers/main.png' },
    extraFiles: { 'assets/wallpapers/main.png': 'not-a-real-png-but-present' }
  })
  const report = validator.validatePackage({ dir })
  assert.ok(report.ok, report.errors.map((issue) => issue.message).join('\n'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cross-theme paths are rejected everywhere they can appear', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'asset.wallpaper': 'themes/other-theme/assets/bg.png' },
    components: { slots: { 'hns.worker.card': { background: '../another-theme/bg.png' } } }
  })
  const report = validator.validatePackage({ dir })
  const codes = report.errors.map((issue) => issue.code)
  assert.ok(codes.includes('cross_theme_reference') || codes.includes('asset_missing'))
  assert.ok(codes.includes('cross_theme_reference'), 'a path escaping the package is a cross-theme reference')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unknown slot is rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    components: { slots: { 'hns.not.a.real.slot': { background: '#000' } } }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'slot_unknown'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a STRUCTURAL slot can never be written by a theme', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    components: { slots: { 'hns.layout.dock_width': { background: '#000' } } }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'slot_permission_denied'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a property a slot does not allow is rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    components: { slots: { 'common.panel.border': { background: '#000' } } }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'slot_property_denied'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unknown token name is rejected', () => {
  const dir = writeTheme(tempDir(), { manifest: baseManifest(), tokens: { 'color.bg.invented': '#000000' } })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'token_unknown'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a token with the wrong value kind is rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'color.bg.base': 'not-a-colour', 'font.size.body': 'large', 'opacity.panel': 'lots' }
  })
  const report = validator.validatePackage({ dir })
  const codes = report.errors.map((issue) => issue.code)
  assert.ok(codes.includes('token_color_invalid'))
  assert.ok(codes.includes('token_length_invalid'))
  assert.ok(codes.includes('token_number_invalid'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an inline data:image asset is accepted as a self-contained asset', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'asset.wallpaper': 'data:image/png;base64,AAAA' }
  })
  const report = validator.validatePackage({ dir })
  assert.ok(report.ok, report.errors.map((issue) => issue.message).join('\n'))
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// validator: readability, states, persona, animation
// ---------------------------------------------------------------------------

test('an unreadable theme is rejected on contrast grounds', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: {
      'color.bg.base': '#ffffff',
      'color.bg.layer1': '#ffffff',
      'color.bg.layer2': '#ffffff',
      'color.label.primary': '#fdfdfd'
    }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'contrast_too_low'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('two HNS states rendered in the same colour are rejected', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    tokens: { 'state.running': '#4d93f8', 'state.primary_worker': '#4d93f8' }
  })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  const issue = report.errors.find((entry) => entry.code === 'state_indistinguishable')
  assert.ok(issue, 'state separability is enforced')
  assert.deepEqual(issue.detail.states.sort(), ['primary_worker', 'running'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('HNS persona rules are enforced at package validation time', () => {
  const cases = [
    [{ enabled: true, prominence: 0.9 }, 'persona_prominence_excessive'],
    [{ enabled: true, prominence: 0.3, overlay_main: true }, 'persona_overlay_forbidden'],
    [{ enabled: true, prominence: 0.3, occludes: ['log'] }, 'persona_occludes_critical_region']
  ]
  for (const [persona, expectedCode] of cases) {
    const dir = writeTheme(tempDir(), { manifest: baseManifest(), persona })
    const report = validator.validatePackage({ dir })
    assert.equal(report.ok, false, `${expectedCode} must fail the package`)
    assert.ok(report.errors.some((issue) => issue.code === expectedCode), `expected ${expectedCode}`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a lightweight persona inside the HNS limit is accepted', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    persona: { enabled: true, prominence: 0.2, character: 'operator_assistant', occludes: [], overlay_main: false }
  })
  const report = validator.validatePackage({ dir })
  assert.ok(report.ok, report.errors.map((issue) => issue.message).join('\n'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('animation intensity is clamped to the preset envelope', () => {
  assert.deepEqual(validator.normalizeAnimation({ type: 'pulse', intensity: 9 }), { type: 'pulse', intensity: 0.5, clamped: true })
  assert.deepEqual(validator.normalizeAnimation({ type: 'slide', intensity: 0.2 }), { type: 'slide', intensity: 0.2, clamped: false })
  assert.deepEqual(validator.normalizeAnimation({ type: 'invented', intensity: 0.5 }), { type: 'none', intensity: 0, clamped: false })
  assert.deepEqual(validator.normalizeAnimation(null), { type: 'none', intensity: 0 })
})

test('an over-strong animation is reported as clamped, not as a hard failure', () => {
  const dir = writeTheme(tempDir(), {
    manifest: baseManifest(),
    components: { slots: {}, animation: { type: 'pulse', intensity: 5 } }
  })
  const report = validator.validatePackage({ dir })
  assert.ok(report.ok)
  assert.ok(report.warnings.some((issue) => issue.code === 'animation_clamped'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the engine only accepts themes that declare HNS support', () => {
  const dir = writeTheme(tempDir(), { manifest: baseManifest({ supported_apps: ['boss'] }), tokens: {} })
  const report = validator.validatePackage({ dir })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'manifest_app_unsupported'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveTokens always yields a complete token set', () => {
  const resolved = validator.resolveTokens({ 'color.bg.base': '#010203' }, { 'color.bg.layer1': '#111111' })
  assert.equal(Object.keys(resolved).length, contract.TOKEN_NAMES.length)
  assert.equal(resolved['color.bg.base'], '#010203', 'a provided token wins')
  assert.equal(resolved['color.bg.layer1'], '#111111', 'a missing token falls back to Dark')
  assert.equal(resolved['color.label.primary'], contract.TOKENS['color.label.primary'].fallback, 'and finally to the schema default')
})

test('version comparison handles dotted versions and rejects junk', () => {
  assert.equal(validator.compareVersions('1.0', '1.0.0'), 0)
  assert.equal(validator.compareVersions('1.2', '1.10'), -1)
  assert.equal(validator.compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(validator.compareVersions('abc', '1.0'), null)
})
