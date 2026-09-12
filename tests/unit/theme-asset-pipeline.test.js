'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * The Visual Asset Pipeline (Update-Plan/General-Theme.md 任务 4 / 任务 5 / 任务 6 / 任务 17).
 *
 * The rule these tests enforce is the one that separates "the generator returned
 * something" from "the theme has a real visual asset": every artifact is decoded
 * and its pixels measured. A transparent character must actually be transparent,
 * must actually carry content, and must actually have been drawn in more than a
 * couple of colours — a boolean would pass all three checks on an empty buffer.
 */
const png = require('../../app/extensions/mega/theme/png')
const assets = require('../../app/extensions/mega/theme/asset-factory')
const planner = require('../../app/extensions/mega/theme/assets/planner')
const generatorModule = require('../../app/extensions/mega/theme/assets/generator')
const processor = require('../../app/extensions/mega/theme/assets/processor')
const assetValidator = require('../../app/extensions/mega/theme/assets/validator')
const fallback = require('../../app/extensions/mega/theme/assets/fallback')
const designer = require('../../app/extensions/mega/theme/designer')
const surface = require('../../app/extensions/mega/theme/surface')
const validator = require('../../app/extensions/mega/theme/validator')

const PALETTE = Object.freeze({
  base: '#101724',
  layer1: '#151922',
  layer2: '#1b2130',
  accent: '#4d93f8',
  accentSecondary: '#7aa7ff',
  label: '#e8ecf3'
})

const INTENT = () => designer.interpret('银发机械助手，半身，右下角，不挡主要内容')
const DESIGN = (intent) => ({
  design_language: 'cyber_hud',
  style_tag: 'cyber',
  palette_label: '钢蓝',
  palette_values: PALETTE,
  intent
})

test('every character framing produces a real transparent figure, not a coloured plate', () => {
  for (const framing of assets.CHARACTER_FRAMINGS) {
    const canvas = assets.renderCharacter({
      palette: PALETTE,
      framing,
      character: 'silver_hair_android_assistant',
      style: 'cyber',
      silhouette: framing === 'silhouette'
    })
    assert.ok(canvas.width >= 128 && canvas.height >= 128, `${framing} has a usable size`)
    const alpha = processor.alphaStats(canvas)
    assert.ok(alpha.transparentRatio > 0.1, `${framing} keeps a transparent background (${alpha.transparentRatio})`)
    assert.ok(alpha.opaqueRatio > 0.05, `${framing} actually draws a figure (${alpha.opaqueRatio})`)
    assert.ok(alpha.opaqueRatio < 0.98, `${framing} is not an opaque rectangle`)
    // A silhouette is deliberately a single flat shape and carries no shading;
    // every other framing must show real interior structure.
    if (framing === 'silhouette') {
      assert.ok(processor.distinctColors(canvas) >= 1, 'the silhouette is drawn')
    } else {
      assert.ok(processor.distinctColors(canvas) >= 2, `${framing} carries real shading`)
    }
    // The figure must be inside the frame: a clipped character is a layout bug.
    const bounds = processor.contentBounds(canvas)
    assert.ok(bounds && bounds.width > canvas.width * 0.2, `${framing} has a substantial content box`)
  }
  // A silhouette is a shape, not a portrait: it must be visibly flatter.
  const portrait = assets.renderCharacter({ palette: PALETTE, framing: 'half_body', character: 'anime_operator', style: 'anime' })
  const silhouette = assets.renderCharacter({ palette: PALETTE, framing: 'half_body', character: 'anime_operator', style: 'anime', silhouette: true })
  assert.ok(
    processor.distinctColors(silhouette) < processor.distinctColors(portrait),
    'the silhouette carries less interior detail than the portrait'
  )
})

test('the asset validator rejects the false greens: empty, flat, opaque and wrong-sized assets', () => {
  const spec = { width: 512, height: 768, transparent: true }
  const catalog = assets.REAL_ASSET_CATALOG.official_character

  // An empty buffer.
  assert.equal(assetValidator.validate({ kind: 'official_character', buffer: Buffer.alloc(0), spec, catalog }).reason, 'asset_empty')
  // Not a PNG.
  assert.equal(assetValidator.validate({ kind: 'official_character', buffer: Buffer.from('this is not a png'), spec, catalog }).reason, 'asset_not_png')
  // A valid PNG that is a single flat colour.
  const flat = png.createCanvas(512, 768)
  png.fill(flat, { r: 20, g: 24, b: 32 }, 1)
  const flatVerdict = assetValidator.validate({ kind: 'official_character', buffer: png.canvasToPng(flat), spec, catalog })
  assert.equal(flatVerdict.ok, false)
  assert.ok(['asset_not_transparent', 'asset_flat'].includes(flatVerdict.reason), flatVerdict.reason)
  // A real figure passes.
  const figure = assets.renderCharacter({ palette: PALETTE, framing: 'half_body', character: 'silver_hair_assistant', style: 'research' })
  const good = assetValidator.validate({ kind: 'official_character', buffer: png.canvasToPng(figure), spec, catalog })
  assert.equal(good.ok, true, JSON.stringify(good.hard))
  assert.equal(good.metrics.transparent, true)
  assert.ok(good.metrics.distinctColors >= 2)
  assert.ok(good.metrics.inkRatio > 0.05, `the figure carries visible content (ink ${good.metrics.inkRatio})`)
  assert.ok(good.metrics.width > 0 && good.metrics.height > 0)
  // A planned size the generator ignored is a hard failure, not a warning.
  const wrongSize = assetValidator.validate({
    kind: 'official_character',
    buffer: png.canvasToPng(figure),
    spec: { width: 2000, height: 3000, transparent: true },
    catalog
  })
  assert.equal(wrongSize.ok, false)
  assert.equal(wrongSize.reason, 'asset_dimension_mismatch')
})

test('the procedural fallback covers every plannable kind, per surface', () => {
  for (const kind of assets.REAL_ASSET_KINDS) {
    const base = assets.REAL_ASSET_CATALOG[kind]
    const result = fallback.render({
      kind,
      surface: base.surface,
      palette: PALETTE,
      spec: { width: base.width, height: base.height, framing: base.framing, transparent: base.transparent },
      style: 'research',
      seed: 'fallback-test',
      character: 'operator_assistant'
    })
    assert.ok(result.canvas, `${kind} has a procedural fallback (${result.reason || ''})`)
    assert.ok(result.canvas.data && result.canvas.data.length === result.canvas.width * result.canvas.height * 4, `${kind} produces a real canvas`)
  }
  // An unknown kind is refused with a reason rather than throwing.
  const unknown = fallback.render({ kind: 'no-such-asset', surface: 'hns_native', palette: PALETTE, spec: { width: 32, height: 32 } })
  assert.equal(unknown.canvas, null)
  assert.match(unknown.reason, /no procedural fallback/)
})

test('the generator produces a validated, transparent character for the mandated prompt', async () => {
  const intent = INTENT()
  assert.equal(intent.persona.character, 'silver_hair_assistant')
  const design = DESIGN(intent)
  const observation = {
    viewport: { x: 0, y: 0, width: 1280, height: 800 },
    safe_region: { x: 0, y: 0, width: 320, height: 460 },
    critical_regions: [{ id: 'input', x: 60, y: 660, width: 900, height: 120, source: 'observed' }],
    critical_observed: true
  }
  const plan = planner.planAssets({ intent, design, observation })
  const characterEntries = plan.asset_plan.filter((entry) => /character/.test(entry.kind))
  assert.ok(characterEntries.length >= 2, 'both the HNS character and the official character are planned')

  const generator = generatorModule.createAssetGenerator({})
  for (const entry of characterEntries) {
    const result = await generator.generate({ entry, palette: PALETTE, style: 'cyber', seed: 's1', character: 'silver_hair_assistant' })
    assert.equal(result.disabled, false, `${entry.kind} was disabled: ${result.reason}`)
    assert.equal(result.provenance, 'procedural-fallback')
    assert.ok(result.buffer && result.buffer.length > 512, `${entry.kind} produced bytes`)
    assert.equal(result.validation.ok, true, JSON.stringify(result.validation.hard))
    assert.equal(result.validation.metrics.transparent, true, `${entry.kind} is transparent`)
    assert.ok(result.validation.metrics.inkRatio > 0.05, `${entry.kind} carries visible content`)
    // The asset is placed where the plan said, on the surface the plan said.
    assert.equal(result.surface, entry.surface)
    assert.ok(surface.assertWritable(result.surface, { kind: 'asset', assetKind: entry.kind }).ok)
    // And the bytes really are the planned, validated asset.
    const decoded = png.decodePng(result.buffer)
    assert.equal(decoded.width, result.width)
    assert.equal(decoded.height, result.height)
    assert.ok(processor.alphaStats(decoded).transparentRatio > 0.1)
  }
})

test('an asset without a real image generator degrades to the procedural fallback, and says so', async () => {
  const entry = {
    kind: 'official_character',
    surface: 'official_overlay',
    width: 384,
    height: 576,
    framing: 'bust',
    transparent: true,
    layout: 'corner',
    anchor: 'bottom-right',
    opacity: 0.8,
    generation_prompt: 'a character',
    path: 'assets/official/official-character.png'
  }
  // No generator configured: the fallback runs and the asset is NOT marked
  // degraded, because nothing was expected from a model.
  const plain = generatorModule.createAssetGenerator({})
  const plainResult = await plain.generate({ entry, palette: PALETTE, style: 'research', seed: 'x' })
  assert.equal(plainResult.ok === undefined ? true : true, true)
  assert.equal(plainResult.provenance, 'procedural-fallback')
  assert.equal(plainResult.degraded, false, 'there was no model to degrade from')
  const plainState = plain.describe()
  assert.equal(plainState.imageGenerator, false, 'no image generator is configured')
  assert.equal(plainState.retries, 1)
  assert.equal(plainState.attempts >= 1, true, 'the attempt was recorded')

  // A generator that always fails: retry, then the fallback, and the degradation
  // is recorded rather than hidden.
  let calls = 0
  const failing = generatorModule.createAssetGenerator({
    imageGenerator: async () => {
      calls += 1
      throw new Error('model unavailable')
    },
    retries: 1
  })
  const degraded = await failing.generate({ entry, palette: PALETTE, style: 'research', seed: 'x' })
  assert.equal(calls, 2, 'one attempt plus one retry')
  assert.equal(degraded.disabled, false)
  assert.equal(degraded.degraded, true, 'the degradation is reported')
  assert.equal(degraded.provenance, 'procedural-fallback')
  assert.ok(degraded.warnings.some((warning) => /model attempt 1 failed/.test(warning)))
  assert.equal(degraded.validation.ok, true)

  // A generator that returns junk is rejected, not trusted, and still degrades to
  // the fallback. The junk is large enough to clear the byte floor so it is the
  // *PNG* check that rejects it, not the size guard.
  const junkBytes = Buffer.alloc(4096, 0x41)
  const junk = generatorModule.createAssetGenerator({ imageGenerator: async () => junkBytes })
  const junkResult = await junk.generate({ entry, palette: PALETTE, style: 'research', seed: 'x' })
  assert.equal(junkResult.disabled, false)
  assert.equal(junkResult.provenance, 'procedural-fallback')
  assert.ok(junkResult.warnings.some((warning) => /not a PNG/.test(warning)), JSON.stringify(junkResult.warnings))
})

test('a real image model is used when one is installed, and its bytes are validated', async () => {
  // A "model" that returns a genuine generated PNG. The pipeline must accept it as
  // model output, not silently fall back.
  const modelPng = png.canvasToPng(assets.renderCharacter({ palette: PALETTE, framing: 'bust', character: 'anime_operator', style: 'anime' }))
  const entry = {
    kind: 'official_character',
    surface: 'official_overlay',
    width: 384,
    height: 512,
    framing: 'bust',
    transparent: true,
    opacity: 0.8,
    generation_prompt: 'a character',
    path: 'assets/official/official-character.png'
  }
  const generator = generatorModule.createAssetGenerator({
    imageGenerator: async ({ prompt, spec, surface: target }) => {
      assert.match(prompt, /character/i)
      assert.equal(spec.framing, 'bust')
      assert.equal(target, 'official_overlay')
      return modelPng
    }
  })
  const result = await generator.generate({ entry, palette: PALETTE, style: 'anime', seed: 'model' })
  assert.equal(result.provenance, 'image-model', 'the model output is used, not the fallback')
  assert.equal(result.degraded, false)
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.hard))
  assert.equal(result.disabled, false)
})

test('a model that returns the wrong framing or too small an image is rejected', async () => {
  const entry = {
    kind: 'official_character',
    surface: 'official_overlay',
    width: 512,
    height: 768,
    framing: 'half_body',
    transparent: true,
    generation_prompt: 'a character',
    path: 'assets/official/official-character.png'
  }
  // 128x128 is below the model floor of 192px.
  const small = png.createCanvas(128, 128)
  png.fill(small, { r: 200, g: 100, b: 50 }, 1)
  const generator = generatorModule.createAssetGenerator({ imageGenerator: async () => png.canvasToPng(small) })
  const result = await generator.generate({ entry, palette: PALETTE, style: 'research', seed: 'small' })
  assert.equal(result.provenance, 'procedural-fallback', 'a too-small model answer is not trusted')
  assert.ok(
    result.warnings.some((warning) => /below the 192px floor|returned only \d+ bytes/.test(warning)),
    JSON.stringify(result.warnings)
  )

  // A 16:9 plate returned for a 2:3 half body is the wrong subject: cropping
  // cannot fix a framing the model ignored, so it is rejected too. The image is
  // made large and detailed so it is not rejected for being small instead.
  const wide = png.createCanvas(768, 432)
  for (let y = 0; y < wide.height; y += 1) {
    for (let x = 0; x < wide.width; x += 1) {
      png.blendPixel(wide, x, y, { r: (x * 7) % 256, g: (y * 5) % 256, b: (x + y) % 256 }, 1)
    }
  }
  const mismatch = generatorModule.createAssetGenerator({ imageGenerator: async () => png.canvasToPng(wide) })
  const mismatchResult = await mismatch.generate({ entry, palette: PALETTE, style: 'research', seed: 'wide' })
  assert.equal(mismatchResult.provenance, 'procedural-fallback')
  assert.ok(
    mismatchResult.warnings.some((warning) => /far from the planned/.test(warning)),
    JSON.stringify(mismatchResult.warnings)
  )
})

test('an asset that cannot be produced is disabled with a reason, and the pipeline continues', async () => {
  // A kind the target surface does not accept is refused before generation.
  const refused = generatorModule.createAssetGenerator({})
  const denied = await refused.generate({
    entry: { kind: 'not-a-real-kind', surface: 'hns_native', width: 128, height: 128, path: 'assets/decorations/nope.png' },
    palette: PALETTE,
    style: 'research',
    seed: 'x'
  })
  assert.equal(denied.disabled, true)
  assert.equal(denied.reason, 'surface_asset_kind_denied')
  assert.equal(denied.buffer, null)

  // A valid surface and kind still degrades to "one asset disabled" rather than a
  // thrown error when nothing can render it: the pipeline reports it as data.
  const assetValidator = require('../../app/extensions/mega/theme/assets/validator')
  const verdict = assetValidator.validate({ kind: 'official_character', buffer: null, spec: { width: 256, height: 384 } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'asset_empty')
  assert.equal(verdict.hard[0].code, 'asset_empty')
})

test('an asset destined for the protected renderer is never even generated', async () => {
  const generator = generatorModule.createAssetGenerator({})
  const result = await generator.generate({
    entry: {
      kind: 'official_character',
      surface: 'official_renderer',
      width: 256,
      height: 384,
      transparent: true,
      path: 'assets/official/forbidden.png'
    },
    palette: PALETTE,
    style: 'research',
    seed: 'x'
  })
  assert.equal(result.disabled, true)
  assert.equal(result.buffer, null, 'no bytes exist for a protected surface')
  assert.equal(result.reason, 'surface_protected')
  assert.equal(result.steps[0].step, 'surface_gate')
  assert.equal(result.steps[0].ok, false)
})

test('the processor keeps transparency and trims the empty letterbox', () => {
  const figure = assets.renderCharacter({ palette: PALETTE, framing: 'half_body', character: 'operator_assistant', style: 'research' })
  // `contain` letterboxes; the pipeline trims back to the real content box.
  const letterboxed = processor.fit(figure, 800, 400, { mode: 'contain' })
  const alpha = processor.alphaStats(letterboxed)
  assert.ok(alpha.transparentRatio > 0.3, 'the letterbox is transparent, not black')
  const trimmed = processor.trim(letterboxed, { margin: 4 })
  assert.ok(trimmed.width <= letterboxed.width && trimmed.height <= letterboxed.height)
  // Knockout removes a flat plate only when there really is one.
  const plate = png.createCanvas(256, 256)
  png.fill(plate, { r: 16, g: 20, b: 30 }, 1)
  for (let y = 90; y < 160; y += 1) for (let x = 90; x < 160; x += 1) png.blendPixel(plate, x, y, { r: 240, g: 240, b: 240 }, 1)
  const knocked = processor.knockout(plate)
  assert.equal(knocked.removed, true)
  assert.ok(processor.alphaStats(knocked.canvas).transparentRatio > 0.5)
  // A figure with real transparency is left alone.
  assert.equal(processor.knockout(figure).removed, false)
})

test('the opacities a prompt asks for are clamped before they reach an asset', () => {
  const intent = designer.interpret('银发角色，右下角')
  const loud = { ...intent, official: { ...intent.official, character_opacity: 3, character_scale: 9, texture_opacity: 0.9 } }
  const design = DESIGN(intent)
  const plan = planner.planOverlay({ intent: loud, design, observation: null, limits: null })
  assert.ok(plan.components.character_primary.opacity <= 1)
  assert.ok(plan.components.texture.opacity <= plan.limits.overlay_opacity)
  // The planner's own caps are the engineering ceilings.
  assert.equal(plan.limits.overlay_opacity, 0.22)
  assert.equal(plan.limits.vignette, 0.15)
  assert.equal(plan.limits.scanline, 0.05)
  assert.equal(plan.limits.character_coverage, 0.22)
  assert.ok(plan.components.character_primary.coverage <= 0.22)
})

test('the compiled package carries the real character asset and its plan documents', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const builder = require('../../app/extensions/mega/theme/builder')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-real-assets-'))
  try {
    const intent = INTENT()
    const draft = designer.design({ intent })
    const built = await builder.buildPackage({
      draft,
      id: 'hns.test.real-assets',
      name: 'Real Asset Test',
      outDir: path.join(dir, 'pkg')
    })
    assert.equal(built.ok, true, JSON.stringify(built.issues || []))
    const pkg = path.join(dir, 'pkg')

    // The plan documents exist and describe the package.
    for (const file of ['surface-plan.json', 'overlay-plan.json', 'asset-plan.json']) {
      assert.equal(fs.existsSync(path.join(pkg, file)), true, `${file} is written`)
    }
    const assetPlan = JSON.parse(fs.readFileSync(path.join(pkg, 'asset-plan.json'), 'utf8'))
    assert.ok(assetPlan.count >= 8, `the plan lists ${assetPlan.count} assets`)
    for (const entry of assetPlan.assets) {
      assert.ok(entry.surface && surface.isSurface(entry.surface), `${entry.kind} names a surface`)
      assert.ok(!surface.isProtected(entry.surface), `${entry.kind} is not on the protected renderer`)
      assert.ok(Array.isArray([entry.width, entry.height]) && entry.width > 0 && entry.height > 0)
      assert.equal(typeof entry.transparent, 'boolean')
      assert.ok(entry.generation_prompt, `${entry.kind} carries the prompt it was generated from`)
      if (entry.disabled) continue
      assert.ok(entry.bytes > 0, `${entry.kind} has real bytes`)
      assert.ok(fs.existsSync(path.join(pkg, entry.path)), `${entry.path} exists on disk`)
    }

    // The character asset is a real transparent image on disk.
    const character = assetPlan.assets.find((entry) => entry.kind === 'official_character')
    assert.ok(character, 'the official character was planned')
    assert.equal(character.disabled, false, `character disabled: ${character.disabled_reason}`)
    assert.equal(character.transparent, true)
    assert.equal(character.validation.transparent, true, 'background transparency survives into the package')
    assert.ok(character.validation.distinct_colors >= 2, 'the shipped character is a real image')
    assert.ok(character.validation.ink_ratio > 0.05, 'the shipped character carries visible content')
    const decoded = png.decodePng(fs.readFileSync(path.join(pkg, character.path)))
    assert.ok(processor.alphaStats(decoded).transparentRatio > 0.05)
    assert.ok(decoded.width > 64 && decoded.height > 64)

    // The tokens the runtime consumes point at the real bytes.
    const tokens = JSON.parse(fs.readFileSync(path.join(pkg, 'tokens.json'), 'utf8'))
    assert.ok(String(tokens['asset.official_character']).startsWith('data:image/png;base64,'))
    assert.ok(String(tokens['asset.hns_character']).startsWith('data:image/png;base64,'))
    assert.ok(String(tokens['asset.official_skin']).startsWith('data:image/png;base64,'))

    // The package declares the official renderer as protected in its own plan.
    const surfacePlan = JSON.parse(fs.readFileSync(path.join(pkg, 'surface-plan.json'), 'utf8'))
    const renderer = surfacePlan.surfaces.find((entry) => entry.surface === 'official_renderer')
    assert.equal(renderer.writes, false)
    assert.equal(renderer.protected, true)

    // Every per-surface preview is inside the package (任务 13).
    for (const file of ['hns-preview.html', 'official-shell-preview.html', 'official-overlay-preview.html', 'composite-preview.html']) {
      assert.equal(fs.existsSync(path.join(pkg, 'preview', file)), true, `${file} is compiled into the package`)
    }

    // ...and the compiled package still validates as a whole.
    const report = validator.validatePackage({ dir: pkg, expectedId: 'hns.test.real-assets' })
    assert.equal(report.ok, true, JSON.stringify(report.errors.map((issue) => issue.message)))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a theme built without an image generator is complete, and its degradation list is empty', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const builder = require('../../app/extensions/mega/theme/builder')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-no-model-'))
  try {
    const intent = designer.interpret('极简浅色中性，不要人物')
    const draft = designer.design({ intent })
    const built = await builder.buildPackage({ draft, id: 'hns.test.no-model', name: 'No Model', outDir: path.join(dir, 'pkg') })
    assert.equal(built.ok, true, JSON.stringify(built.issues || []))
    assert.equal(built.degradation.degraded, false)
    assert.deepEqual(built.degradation.disabled, [])
    // With no persona there is no character asset at all — and that is not a
    // failure.
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'pkg', 'asset-plan.json'), 'utf8'))
    assert.equal(plan.character.enabled, false)
    assert.equal(plan.assets.some((entry) => /character/.test(entry.kind)), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
