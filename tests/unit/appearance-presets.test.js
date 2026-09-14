'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createAppearanceController, APPEARANCE_PRESETS, APPEARANCE_PRESET_IDS, defaultPreset, presetFor } = require('../../app/extensions/mega/appearance/index.cjs')
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * The appearance presets (`updateplan/startup2.md` §26-§28, §5).
 *
 * The numbers are the plan's: Work is the default, Immersive trades readability for picture, Reading does
 * the opposite, and every preset has to make sense with no wallpaper at all — which is what "readability
 * first" means when the user has chosen no picture.
 */

test('the three presets exist, and exactly one of them is the default', () => {
  assert.deepEqual(APPEARANCE_PRESET_IDS, ['work', 'immersive', 'reading'])
  const defaults = APPEARANCE_PRESET_IDS.filter((id) => APPEARANCE_PRESETS[id].default)
  assert.deepEqual(defaults, ['work'])
  assert.equal(defaultPreset().id, 'work')
})

test('the numbers are inside the ranges the two layers clamp to, and reading is the strictest', () => {
  for (const id of APPEARANCE_PRESET_IDS) {
    const preset = APPEARANCE_PRESETS[id]
    assert.ok(preset.glass.blur >= 0 && preset.glass.blur <= 40, `${id}'s glass blur is outside 0-40px`)
    assert.ok(preset.glass.opacity >= 5 && preset.glass.opacity <= 100, `${id}'s glass opacity is outside 5-100%`)
    for (const surface of ['main', 'dock']) {
      const layer = preset.wallpaper[surface]
      assert.ok(layer.opacity >= 0 && layer.opacity <= 100, `${id}/${surface} opacity is outside 0-100%`)
      assert.ok(layer.scrim >= 0 && layer.scrim <= 100, `${id}/${surface} scrim is outside 0-100%`)
    }
  }
  // §5: Work is the balance, Immersive shows more picture, Reading protects the text.
  assert.ok(APPEARANCE_PRESETS.immersive.wallpaper.main.opacity > APPEARANCE_PRESETS.work.wallpaper.main.opacity)
  assert.ok(APPEARANCE_PRESETS.immersive.wallpaper.main.scrim < APPEARANCE_PRESETS.work.wallpaper.main.scrim)
  assert.ok(APPEARANCE_PRESETS.reading.glass.opacity > APPEARANCE_PRESETS.work.glass.opacity)
  assert.ok(APPEARANCE_PRESETS.reading.wallpaper.main.opacity < APPEARANCE_PRESETS.work.wallpaper.main.opacity)
  assert.ok(APPEARANCE_PRESETS.reading.wallpaper.main.scrim > APPEARANCE_PRESETS.work.wallpaper.main.scrim)
})

test('applying a preset writes both layers with that preset\'s numbers', async () => {
  const writes = []
  const controller = createAppearanceController({
    glass: async (patch) => { writes.push({ layer: 'glass', patch }); return { ok: true } },
    wallpaper: async (patch) => { writes.push({ layer: 'wallpaper', patch }); return { ok: true } }
  })
  const result = await controller.apply('reading')
  assert.equal(result.ok, true)
  assert.deepEqual(writes[0], { layer: 'glass', patch: { blur: 14, opacity: 90 } })
  // The layer numbers, plus what the §27 tokens derived from the same preset: the filter the picture gets.
  assert.deepEqual(writes[1].patch.main, { opacity: 45, blur: 14, scrim: 22, brightness: 0.55, contrast: 0.95, saturation: 0.8 })
  assert.deepEqual(writes[1].patch.dock, { opacity: 90, blur: 14, scrim: 22, brightness: 0.55, contrast: 0.95, saturation: 0.8 })
  assert.deepEqual(result.tokens.refused, [], 'a shipped preset used a token outside the §27 vocabulary')
  // The two shapes describe one appearance: the tokens and the layer numbers must agree.
  for (const id of APPEARANCE_PRESET_IDS) {
    const preset = APPEARANCE_PRESETS[id]
    assert.equal(preset.tokens['--dsh-surface-opacity'], preset.glass.opacity, `${id}: the surface token and the glass number disagree`)
    assert.equal(preset.tokens['--dsh-surface-blur'], preset.glass.blur, `${id}: the blur token and the glass number disagree`)
    assert.equal(preset.tokens['--dsh-wallpaper-darken'], preset.wallpaper.main.scrim, `${id}: the darkening token and the scrim disagree`)
  }
  assert.equal(controller.describe().lastApplied, 'reading')
})

test('the glass goes first, and its failure does not take the wallpaper with it', async () => {
  const writes = []
  const controller = createAppearanceController({
    glass: async () => { throw new Error('the glass layer is unavailable') },
    wallpaper: async (patch) => { writes.push(patch); return { ok: true } }
  })
  const result = await controller.apply('work')
  assert.equal(result.ok, false, 'a failed layer was reported as success')
  assert.match(result.glass.reason, /glass layer is unavailable/)
  assert.equal(result.wallpaper.ok, true)
  assert.equal(writes.length, 1, 'the wallpaper was skipped because the glass failed')
})

test('an unknown preset is refused by name', async () => {
  const controller = createAppearanceController({})
  const result = await controller.apply('neon')
  assert.equal(result.ok, false)
  assert.match(result.reason, /not an appearance preset/)
})

test('the preset in force is read from the numbers, and a mixture is a mixture', () => {
  const work = APPEARANCE_PRESETS.work
  assert.equal(presetFor({ glass: { ...work.glass }, wallpaper: { main: { ...work.wallpaper.main }, dock: { ...work.wallpaper.dock } } }), 'work')
  assert.equal(presetFor({ glass: { blur: 12, opacity: 82 }, wallpaper: { main: { opacity: 61, blur: 12, scrim: 18 } } }), null, 'a hand-tuned mixture was snapped to a preset')
  // With only the glass numbers available (no wallpaper chosen at all) the answer is still the preset:
  // that is the "every preset works with no wallpaper" case.
  assert.equal(presetFor({ glass: { ...APPEARANCE_PRESETS.reading.glass } }), 'reading')
})

test('the presets are wired: one control in the panel, one channel pair in the extension', () => {
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const html = read('app/extensions/mega/ui/dock.html')
  const panel = read('app/extensions/mega/ui/appearance-panel.js')
  assert.match(index, /const \{ createAppearanceController \} = require\('\.\/appearance\/index\.cjs'\)/)
  assert.match(index, /ipcMain\.handle\('mega:appearance'/)
  assert.match(index, /ipcMain\.handle\('mega:appearance-set'/)
  assert.match(index, /'mega:appearance', 'mega:appearance-set'/, 'the channels are not declared for cleanup')
  // The controller is handed the two layers' own setters, and the numbers in force are read back from
  // those layers rather than remembered here.
  assert.match(index, /glass: \(patch\) => glass\(\)\.set\(patch\)/)
  assert.match(index, /wallpaper: \(patch\) => wallpaper\(\)\.set\(patch\)/)
  assert.match(index, /const glassState = glass\(\)\.describe\(\)/)
  assert.match(preload, /appearance: \{/)
  assert.match(html, /id="appearancePreset"/)
  assert.match(panel, /function loadAppearancePresets\(/)
  assert.match(panel, /appearanceApi\(\)/)
})
