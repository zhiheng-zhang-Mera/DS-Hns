'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * Intent interpretation + Theme Designer.
 *
 * The behaviour under test is the specification's user-experience contract:
 * a prompt is never a file generator, a revision is always incremental, and the
 * designer can never emit a theme that the validator would reject for
 * readability or HNS state reasons.
 */
const designer = require('../../app/extensions/mega/theme/designer')
const contract = require('../../app/extensions/mega/theme/contract')
const color = require('../../app/extensions/mega/theme/color')
const png = require('../../app/extensions/mega/theme/png')
const assets = require('../../app/extensions/mega/theme/asset-factory')

// ---------------------------------------------------------------------------
// intent interpretation
// ---------------------------------------------------------------------------

test('a natural-language prompt becomes a structured design intent', () => {
  const { intent } = { intent: designer.interpret('银发角色，黑灰蓝色调，看起来像未来科研工作站，人物别太抢屏') }
  assert.equal(intent.design_language, 'future_research_workstation')
  assert.equal(intent.density, 'compact')
  assert.equal(intent.readability_priority, 'high')
  assert.ok(['charcoal', 'steel', 'steel_blue'].includes(intent.palette[0]), 'a dark cool palette is recognised')
  assert.equal(intent.persona.enabled, true)
  assert.equal(intent.persona.character, 'silver_hair_assistant')
  assert.ok(intent.persona.prominence <= 0.2, '"别太抢屏" lowers persona prominence')
})

test('an unrecognised prompt still yields a valid, conservative intent', () => {
  const intent = designer.interpret('随便来点什么')
  assert.equal(intent.design_language, 'future_research_workstation')
  assert.equal(intent.density, 'compact')
  assert.ok(Array.isArray(intent.palette) && intent.palette.length)
  assert.ok(intent.persona.prominence <= 0.4)
})

test('an empty prompt is tolerated and never throws', () => {
  const intent = designer.interpret('')
  assert.equal(intent.prompt, '')
  assert.ok(intent.palette.length)
})

test('"no persona" overrides any character keyword in the same prompt', () => {
  const intent = designer.interpret('二次元少女角色，但是不要人物出现在界面上')
  assert.equal(intent.persona.enabled, false)
  assert.equal(intent.persona.prominence, 0)
})

test('persona prominence is clamped to the HNS limit even when asked for more', () => {
  const intent = designer.interpret('非常大的角色立绘，要非常突出')
  assert.ok(intent.persona.prominence <= 0.4, `prominence ${intent.persona.prominence} must respect the HNS ceiling`)
})

test('every requested motion/decoration level maps onto a known preset', () => {
  const strong = designer.interpret('强烈动感，装饰华丽')
  assert.equal(strong.motion, 'strong')
  assert.equal(strong.decoration, 'high')
  const still = designer.interpret('不要动画，无装饰')
  assert.equal(still.motion, 'none')
  assert.equal(still.decoration, 'none')
})

// ---------------------------------------------------------------------------
// incremental revision (spec §8)
// ---------------------------------------------------------------------------

test('a revision preserves every decision it does not mention', () => {
  const first = designer.interpret('银发角色，紫蓝色调，未来科研工作站，紧凑，轻量人物')
  const { intent: revised, changed } = designer.revise(first, '人物再小一点')
  assert.equal(revised.design_language, first.design_language, 'design language is untouched')
  assert.deepEqual(revised.palette, first.palette, 'palette is untouched')
  assert.equal(revised.density, first.density, 'density is untouched')
  assert.ok(revised.persona.prominence < first.persona.prominence, 'only persona prominence moved')
  assert.deepEqual(changed, ['persona'])
})

test('"人物再小一点" is understood as a decrement, not as a fresh brief', () => {
  const first = designer.interpret('二次元角色，紫蓝色调')
  const before = first.persona.prominence
  const after = designer.interpret('人物再小一点', { previousIntent: first })
  assert.ok(after.persona.prominence < before, `${after.persona.prominence} < ${before}`)
  assert.equal(after.persona.character, first.persona.character, 'the character survives the revision')
})

test('"按钮不要这么亮" reduces glow without abandoning the design', () => {
  const first = designer.interpret('赛博霓虹风格')
  const after = designer.interpret('按钮不要这么亮', { previousIntent: first })
  assert.ok(after.brightness < 0)
  assert.equal(after.design_language, first.design_language)
  assert.equal(after.palette[0], first.palette[0])
  const draft = designer.design({ intent: after })
  assert.equal(Number(draft.tokens['effect.glow']), 0, 'the compiled glow token follows the revision')
})

test('a revision can move decoration and density by one step', () => {
  const first = designer.interpret('标准密度，装饰丰富')
  const muted = designer.interpret('装饰再少一点', { previousIntent: first })
  assert.equal(muted.decoration, 'medium_low')
  const tighter = designer.interpret('更紧凑一点', { previousIntent: first })
  assert.equal(tighter.density, 'compact')
})

test('revision of a revision keeps accumulating instead of resetting', () => {
  let intent = designer.interpret('二次元角色，紫蓝色调')
  const start = intent.persona.prominence
  intent = designer.interpret('人物再小一点', { previousIntent: intent })
  intent = designer.interpret('人物再小一点', { previousIntent: intent })
  assert.ok(intent.persona.prominence < start)
  assert.ok(intent.persona.prominence >= 0)
})

// ---------------------------------------------------------------------------
// designer output
// ---------------------------------------------------------------------------

test('the designer emits a complete token set and a writable slot set', () => {
  const intent = designer.interpret('赛博全息 HUD，黑灰蓝，扫描线')
  const draft = designer.design({ intent })
  for (const name of contract.TOKEN_NAMES) {
    const value = draft.tokens[name]
    if (contract.TOKENS[name].kind === contract.PROPERTY_KIND.ASSET) continue
    assert.notEqual(value, undefined, `token ${name} is present in the draft`)
  }
  assert.ok(Object.keys(draft.components.slots).length >= 25)
  for (const slotId of Object.keys(draft.components.slots)) {
    const slot = contract.SLOTS[slotId]
    assert.ok(slot, `designer only writes exposed slots (${slotId})`)
    assert.notEqual(slot.permission, contract.PERMISSION.STRUCTURAL, `designer never writes ${slotId}`)
  }
})

test('the designer never writes a STRUCTURAL layout slot', () => {
  for (const prompt of ['赛博 HUD', '极简浅色', '二次元角色', '未来科研工作站', '']) {
    const draft = designer.design({ intent: designer.interpret(prompt) })
    for (const slotId of Object.keys(draft.components.slots)) {
      if (slotId.startsWith('hns.layout.')) assert.fail(`structural slot ${slotId} was written for prompt "${prompt}"`)
    }
  }
})

test('contrast remediation guarantees the designer cannot emit an unreadable theme', () => {
  // A deliberately hostile intent: a mid-tone accent on a mid-tone surface.
  const intent = {
    ...designer.interpret('中性'),
    palette: ['silver'],
    base_hint: '#808080',
    brightness: 0
  }
  const draft = designer.design({ intent })
  for (const requirement of contract.CONTRAST_REQUIREMENTS) {
    const ratio = color.contrastRatio(draft.tokens[requirement.foreground], draft.tokens[requirement.background])
    assert.ok(
      ratio === null || ratio + 1e-6 >= requirement.min,
      `${requirement.label} contrast ${ratio} must reach ${requirement.min}`
    )
  }
})

test('the designer reports the adjustments it made for readability', () => {
  const intent = { ...designer.interpret('中性'), palette: ['silver'], base_hint: '#f4f6f9' }
  const draft = designer.design({ intent })
  assert.ok(Array.isArray(draft.contrast_adjustments))
  for (const adjustment of draft.contrast_adjustments) {
    assert.ok(adjustment.token.startsWith('color.') || adjustment.token.startsWith('state.'))
    assert.ok(adjustment.reason.includes('contrast'))
  }
})

test('light and dark follow the requested surface, not the palette name', () => {
  const lightIntent = { ...designer.interpret('浅色中性'), base_hint: '#f4f6f9', palette: ['silver'] }
  const lightDraft = designer.design({ intent: lightIntent })
  assert.equal(lightDraft.mode, 'light')
  assert.ok(color.isLight(lightDraft.tokens['color.bg.layer1']), 'a light theme has a light content layer')
  assert.ok(!color.isLight(lightDraft.tokens['color.label.primary']), 'and dark labels')

  const darkIntent = { ...designer.interpret('深色'), base_hint: '#0d0f13', palette: ['charcoal'] }
  const darkDraft = designer.design({ intent: darkIntent })
  assert.equal(darkDraft.mode, 'dark')
  assert.ok(!color.isLight(darkDraft.tokens['color.bg.layer1']), 'a dark theme has a dark content layer')
  assert.ok(color.isLight(darkDraft.tokens['color.label.primary']), 'and light labels')
})

test('the designer keeps every HNS state token distinct', () => {
  for (const prompt of ['赛博 HUD', '极简浅色', '二次元角色', '深色工业监控台', '']) {
    const draft = designer.design({ intent: designer.interpret(prompt) })
    for (let index = 0; index < contract.HNS_STATES.length; index += 1) {
      for (let other = index + 1; other < contract.HNS_STATES.length; other += 1) {
        const a = contract.HNS_STATES[index]
        const b = contract.HNS_STATES[other]
        const distance = color.distance(draft.tokens[`state.${a}`], draft.tokens[`state.${b}`])
        assert.ok(distance >= contract.STATE_MIN_DISTANCE, `${a} and ${b} are ${distance} apart for "${prompt}"`)
      }
    }
  }
})

test('designer.design is deterministic for the same intent', () => {
  const intent = designer.interpret('赛博全息 HUD，黑灰蓝')
  const first = designer.design({ intent })
  const second = designer.design({ intent })
  assert.deepEqual(first.tokens, second.tokens)
  assert.deepEqual(first.components, second.components)
})

test('the asset bundle is deterministic and complete', () => {
  const palette = { base: '#0f1115', layer1: '#151922', layer2: '#1b2130', accent: '#4d93f8', accentSecondary: '#7aa7ff', label: '#e8ecf3' }
  const args = { palette, style: 'cyber', seed: 'determinism', persona: { enabled: true, character: 'silver_hair_assistant' } }
  const first = assets.buildAssetBundle(args)
  const second = assets.buildAssetBundle(args)
  assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort())
  for (const key of Object.keys(first)) {
    assert.ok(Buffer.isBuffer(first[key]), `${key} is a Buffer`)
    assert.ok(first[key].equals(second[key]), `${key} is byte-identical across runs`)
  }
  for (const key of ['assets/wallpapers/main.png', 'assets/panels/panel.png', 'assets/persona/avatar.png', 'assets/persona/banner.png', 'assets/decorations/corners.png', 'assets/icons/set.png', 'assets/icons/tray.png']) {
    assert.ok(first[key], `bundle contains ${key}`)
  }
})

test('an asset-free persona produces no persona assets', () => {
  const palette = { base: '#0f1115', layer1: '#151922', layer2: '#1b2130', accent: '#4d93f8', accentSecondary: '#7aa7ff', label: '#e8ecf3' }
  const bundle = assets.buildAssetBundle({ palette, style: 'minimal', seed: 'no-persona', persona: { enabled: false } })
  assert.equal(bundle['assets/persona/avatar.png'], undefined)
  assert.ok(bundle['assets/wallpapers/main.png'])
})

test('generated assets are structurally valid PNG files', () => {
  const palette = { base: '#0f1115', layer1: '#151922', layer2: '#1b2130', accent: '#4d93f8', accentSecondary: '#7aa7ff', label: '#e8ecf3' }
  const bundle = assets.buildAssetBundle({ palette, style: 'research', seed: 'png', persona: { enabled: true, character: 'android_operator' } })
  for (const [key, buffer] of Object.entries(bundle)) {
    assert.ok(buffer.subarray(0, 8).equals(png.SIGNATURE), `${key} starts with the PNG signature`)
    assert.equal(buffer.readUInt32BE(8), 13, `${key} has an IHDR chunk`)
    assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR')
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    assert.ok(width > 0 && height > 0, `${key} declares a real size (${width}x${height})`)
    assert.equal(buffer.readUInt8(24), 8, `${key} is 8-bit`)
    assert.ok([2, 6].includes(buffer.readUInt8(25)), `${key} is truecolour`)
    assert.equal(buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii'), 'IEND', `${key} is terminated`)
  }
})

test('the PNG encoder rejects malformed input instead of writing a corrupt file', () => {
  assert.throws(() => png.encodePng({ width: 0, height: 4, data: Buffer.alloc(4) }), /invalid PNG width/)
  assert.throws(() => png.encodePng({ width: 2, height: 2, data: Buffer.alloc(4), channels: 5 }), /invalid PNG channel count/)
  assert.throws(() => png.encodePng({ width: 4, height: 4, data: Buffer.alloc(8) }), /pixel buffer too small/)
})

test('the PNG encoder round-trips a known pixel layout', () => {
  const canvas = png.createCanvas(2, 2)
  png.blendPixel(canvas, 0, 0, { r: 255, g: 0, b: 0 }, 1)
  png.blendPixel(canvas, 1, 1, { r: 0, g: 0, b: 255 }, 1)
  const encoded = png.canvasToPng(canvas)
  assert.ok(encoded.length > 40)
  assert.equal(encoded.readUInt32BE(16), 2)
  assert.equal(encoded.readUInt32BE(20), 2)
})

test('designer.describe summarises the design in one line', () => {
  const draft = designer.design({ intent: designer.interpret('银发角色，黑灰蓝色调') })
  const summary = designer.describe(draft)
  assert.match(summary, /design_language=/)
  assert.match(summary, /palette=/)
  assert.match(summary, /persona=/)
  assert.match(summary, /mode=/)
})
