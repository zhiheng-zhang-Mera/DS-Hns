'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * The unified Theme Surface model (Update-Plan/General-Theme.md 任务 1).
 *
 * These assertions are the enforcement layer for the architectural boundary the
 * whole feature rests on: four surfaces, four permissions, and a protected official
 * renderer that no writer can reach — not through a slot, not through a plan, and
 * not through a package that declares its own surface plan.
 */
const contract = require('../../app/extensions/mega/theme/contract')
const surface = require('../../app/extensions/mega/theme/surface')
const capability = require('../../app/extensions/mega/theme/capability')
const validator = require('../../app/extensions/mega/theme/validator')
const designer = require('../../app/extensions/mega/theme/designer')
const planner = require('../../app/extensions/mega/theme/assets/planner')

test('the model exposes exactly the four canonical surfaces with their permissions', () => {
  assert.deepEqual([...surface.SURFACE_IDS], ['hns_native', 'official_shell', 'official_overlay', 'official_renderer'])
  const expected = {
    hns_native: { permission: 'full', writable: true, assetWritable: true, protected: false, visualOnly: false },
    official_shell: { permission: 'full', writable: true, assetWritable: true, protected: false, visualOnly: false },
    official_overlay: { permission: 'visual-only', writable: true, assetWritable: true, protected: false, visualOnly: true },
    official_renderer: { permission: 'protected', writable: false, assetWritable: false, protected: true, visualOnly: false }
  }
  for (const [id, want] of Object.entries(expected)) {
    const entry = surface.getSurface(id)
    assert.ok(entry, `${id} is independently queryable`)
    for (const [key, value] of Object.entries(want)) {
      assert.equal(entry[key], value, `${id}.${key} must be ${value}`)
    }
  }
  // The names are shared with the contract, so a package declaring a surface is
  // validated against the same constant the runtime paints.
  assert.equal(contract.SURFACE.HNS_NATIVE, 'hns_native')
  assert.equal(contract.SURFACE.OFFICIAL_SHELL, 'official_shell')
  assert.equal(contract.SURFACE.OFFICIAL_OVERLAY, 'official_overlay')
  assert.equal(contract.SURFACE.OFFICIAL_RENDERER, 'official_renderer')
  assert.deepEqual([...contract.PROTECTED_SURFACES], ['official_renderer'])
})

test('the official overlay is visual-only: no pointer, keyboard, focus or scroll', () => {
  const overlay = surface.getSurface('official_overlay')
  assert.equal(overlay.visualOnly, true)
  assert.equal(overlay.interactive, false)
  for (const key of ['pointer', 'keyboard', 'focus', 'scroll']) {
    assert.equal(overlay.input[key], false, `the overlay must not take ${key}`)
  }
  assert.equal(overlay.input.passthrough, true)
  // The protected renderer is interactive *because* DS-Hns never layers input on
  // top of it: it keeps every event it always had.
  assert.equal(surface.getSurface('official_renderer').interactive, true)
  // The two surfaces DS-Hns paints around the official view are input-transparent.
  for (const id of ['official_shell', 'official_overlay']) {
    assert.equal(surface.getSurface(id).input.passthrough, true, `${id} must pass input through`)
  }
})

test('the official renderer can never be written, for any write kind or asset kind', () => {
  for (const kind of ['asset', 'component', 'layout', 'override']) {
    const verdict = surface.assertWritable('official_renderer', { kind, assetKind: 'official_character' })
    assert.equal(verdict.ok, false, `a ${kind} write to the official renderer must be refused`)
    assert.equal(verdict.code, 'surface_protected')
    assert.equal(verdict.surface, 'official_renderer')
    assert.equal(verdict.permission, 'protected')
  }
  // The refusal is a *gate*, not a convention: it is the same call every writer
  // makes before it touches a surface.
  assert.equal(surface.assertWritable('official_renderer').ok, false)
  assert.equal(surface.isWritable('official_renderer'), false)
  assert.equal(surface.isAssetWritable('official_renderer'), false)
  assert.deepEqual(surface.assetKinds('official_renderer'), [])
  for (const id of ['hns_native', 'official_shell', 'official_overlay']) {
    assert.equal(surface.assertWritable(id).ok, true, `${id} is writable by the generator`)
  }
})

test('an unknown surface is refused instead of defaulting to a writable one', () => {
  const verdict = surface.assertWritable('official', { kind: 'asset' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'surface_unknown')
  assert.match(verdict.reason, /not one of the four Theme Surfaces/)
  assert.equal(surface.assertWritable('').ok, false)
  assert.equal(surface.isSurface('dock'), false, 'the legacy dock/shell/official triple is not a surface')
})

test('asset kinds are per surface, so no character can be planned onto the renderer', () => {
  for (const [id, kinds] of Object.entries(surface.SURFACE_ASSET_KINDS)) {
    for (const kind of kinds) {
      assert.equal(
        surface.assertWritable(id, { kind: 'asset', assetKind: kind }).ok,
        id !== 'official_renderer',
        `${kind} on ${id}`
      )
    }
  }
  // A kind the surface does not accept is refused too.
  assert.equal(surface.assertWritable('official_overlay', { kind: 'asset', assetKind: 'persona_avatar' }).ok, false)
  assert.equal(surface.assertWritable('official_overlay', { kind: 'asset', assetKind: 'official_character' }).ok, true)
  assert.equal(surface.assertWritable('official_shell', { kind: 'asset', assetKind: 'frame_decoration' }).ok, true)
  assert.equal(surface.assertWritable('hns_native', { kind: 'asset', assetKind: 'hns_character' }).ok, true)
})

test('a payload that claims a write into the protected renderer is detected anywhere in a package', () => {
  // A smuggled write is rejected...
  const smuggled = surface.violationsIn({
    asset_plan: { assets: [{ kind: 'official_character', surface: 'official_renderer' }] }
  })
  assert.equal(smuggled.length, 1)
  assert.equal(smuggled[0].code, 'surface_protected')
  assert.match(smuggled[0].path, /surface$/)
  // ...and the same for the `target` spelling, at any depth.
  const nested = surface.violationsIn({
    overlay_plan: { layout: { components: [{ target: 'official_renderer', opacity: 0.4 }] } }
  })
  assert.equal(nested.length, 1)
  // Naming the surface truthfully, with `writes: false`, is required and allowed:
  // a surface plan has to describe all four surfaces, including the protected one.
  assert.deepEqual(
    surface.violationsIn({ surfaces: [{ surface: 'official_renderer', writes: false, protected: true }] }),
    []
  )
  // Free text that merely mentions the surface is not a write.
  assert.deepEqual(surface.violationsIn({ note: 'official_renderer is protected' }), [])
})

test('the capability manifest attributes every slot to its real surface', () => {
  const manifest = capability.buildManifest({})
  assert.equal(surface.surfaceOfSlot('hns.worker.card'), 'hns_native')
  assert.equal(surface.surfaceOfSlot('official.shell.frame'), 'official_shell')
  assert.equal(surface.surfaceOfSlot('official.overlay.character_primary'), 'official_overlay')
  assert.equal(surface.surfaceOfSlot('official.renderer.dom'), 'official_renderer')
  for (const slotId of contract.SLOT_IDS) {
    assert.equal(manifest.slots[slotId].surface, surface.surfaceOfSlot(slotId), `${slotId} declares its surface`)
  }
  // The protected renderer's slots are described honestly and are never writable.
  const rendererSlots = Object.entries(manifest.slots).filter(([, slot]) => slot.surface === 'official_renderer')
  assert.ok(rendererSlots.length >= 4, 'the protected surface is described')
  for (const [slotId, slot] of rendererSlots) {
    assert.equal(slot.permission, contract.PERMISSION.STRUCTURAL, `${slotId} is STRUCTURAL`)
  }
  // The manifest's surface list is the canonical one, not the legacy triple.
  assert.deepEqual(manifest.themeable_surfaces.map((entry) => entry.id), [...surface.SURFACE_IDS])
  assert.equal(manifest.capabilities.can_theme_official_ui, false)
  assert.equal(manifest.capabilities.can_theme_official_shell, true)
  assert.equal(manifest.capabilities.can_theme_official_overlay, true)
  assert.equal(manifest.capabilities.official_overlay_visual_only, true)
})

test('the overlay safety ceilings the manifest publishes are the ones the validator enforces', () => {
  const safety = require('../../app/extensions/mega/theme/official/overlay-safety')
  const published = capability.buildManifest({}).capabilities.overlay_limits
  for (const key of ['overlay_opacity', 'vignette', 'scanline', 'character_coverage', 'critical_overlap']) {
    assert.equal(published[key], safety.LIMITS[key], `${key} must not be published with a different value than it is enforced with`)
  }
  // The engineering numbers themselves.
  assert.equal(safety.LIMITS.overlay_opacity, 0.22)
  assert.equal(safety.LIMITS.vignette, 0.15)
  assert.equal(safety.LIMITS.scanline, 0.05)
  assert.equal(safety.LIMITS.character_coverage, 0.22)
  assert.equal(safety.LIMITS.critical_overlap, 0.08)
})

test('a design plans only onto surfaces it may write, and never onto the renderer', () => {
  const intent = designer.interpret('银发机械助手，半身，右下角，不挡主要内容')
  const draft = designer.design({ intent })
  const plan = draft.surface_plan
  assert.deepEqual(plan.surfaces.map((entry) => entry.surface), [...surface.SURFACE_IDS])
  for (const entry of plan.surfaces) {
    if (entry.surface === 'official_renderer') {
      assert.equal(entry.writes, false, 'the renderer is never written')
      assert.equal(entry.permission, 'protected')
      continue
    }
    assert.equal(entry.writes, true, `${entry.surface} is written by this design`)
    assert.equal(surface.assertWritable(entry.surface).ok, true)
  }
  // Every planned asset names a surface that accepts its kind.
  for (const entry of draft.asset_plan.asset_plan) {
    const verdict = surface.assertWritable(entry.surface, { kind: 'asset', assetKind: entry.kind })
    assert.equal(verdict.ok, true, `${entry.kind} -> ${entry.surface}: ${verdict.reason || ''}`)
  }
  assert.equal(plan.official_renderer.dom_access, false)
  assert.equal(plan.official_renderer.css_injection, false)
  assert.equal(plan.official_renderer.script_injection, false)
  assert.equal(plan.official_renderer.capture, false)
})

test('a package whose surface plan claims a write into the renderer is rejected', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-surface-plan-'))
  try {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      id: 'hns.test.surface',
      name: 'Surface Test',
      version: '1.0.0',
      source: 'generated',
      theme_api_version: contract.THEME_API_VERSION,
      supported_apps: ['hns']
    }), 'utf8')
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ 'color.bg.base': '#101724' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify({ slots: {} }), 'utf8')
    fs.writeFileSync(path.join(dir, 'surface-plan.json'), JSON.stringify({
      version: 1,
      surfaces: [
        { surface: 'hns_native', writes: true },
        { surface: 'official_renderer', writes: true }
      ]
    }), 'utf8')
    const report = validator.validatePackage({ dir })
    const codes = report.issues.map((issue) => issue.code)
    assert.ok(codes.includes('surface_protected'), `expected surface_protected, got ${codes.join(', ')}`)
    assert.equal(report.ok, false)

    // The honest plan passes the same check.
    fs.writeFileSync(path.join(dir, 'surface-plan.json'), JSON.stringify({
      version: 1,
      surfaces: [
        { surface: 'hns_native', writes: true },
        { surface: 'official_shell', writes: true },
        { surface: 'official_overlay', writes: true },
        { surface: 'official_renderer', writes: false, protected: true }
      ]
    }), 'utf8')
    const honest = validator.validatePackage({ dir })
    assert.equal(
      honest.issues.some((issue) => issue.code === 'surface_protected' || issue.code === 'surface_write_denied'),
      false,
      JSON.stringify(honest.issues.map((issue) => issue.message))
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an overlay plan that does not pass input through is rejected', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-overlay-plan-'))
  try {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      id: 'hns.test.overlay',
      name: 'Overlay Test',
      version: '1.0.0',
      source: 'generated',
      theme_api_version: contract.THEME_API_VERSION,
      supported_apps: ['hns']
    }), 'utf8')
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ 'color.bg.base': '#101724' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify({ slots: {} }), 'utf8')
    fs.writeFileSync(path.join(dir, 'overlay-plan.json'), JSON.stringify({
      version: 1,
      enabled: true,
      input: { pointer: 'capture', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' }
    }), 'utf8')
    const report = validator.validatePackage({ dir })
    assert.ok(
      report.issues.some((issue) => issue.code === 'overlay_input_not_passthrough'),
      JSON.stringify(report.issues.map((issue) => issue.code))
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('planning is observation driven: the plans say so when nothing was observed', () => {
  const intent = designer.interpret('银发角色，右下角')
  const design = { design_language: 'future_research_workstation', style_tag: 'research', palette_label: '钢蓝', palette_values: {}, intent }
  const blind = planner.planAssets({ intent, design, observation: null })
  assert.equal(blind.degraded, true)
  assert.match(blind.reason, /without a UI observation/)
  const blindOverlay = planner.planOverlay({ intent, design, observation: null })
  assert.equal(blindOverlay.degraded, true)

  const observed = {
    viewport: { x: 0, y: 0, width: 1200, height: 800 },
    safe_region: { x: 0, y: 0, width: 300, height: 440 },
    critical_regions: [{ id: 'input', x: 100, y: 640, width: 800, height: 120, source: 'observed' }],
    critical_observed: true
  }
  const sighted = planner.planAssets({ intent, design, observation: observed })
  assert.equal(sighted.degraded, false)
  const character = sighted.asset_plan.find((entry) => entry.kind === 'official_character')
  assert.ok(character, 'the official character is planned for the official overlay')
  assert.equal(character.safe_region.width, 300, 'the plan carries the observed safe region')
  // A 1200px viewport at the conservative 30% character fraction.
  assert.equal(character.width, 360)
})
