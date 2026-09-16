'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { APPEARANCE_TOKEN_NAMES, FORBIDDEN_SURFACES, validate, toLayerPatch, toCss } = require('../../app/extensions/mega/appearance/tokens.cjs')

/**
 * The appearance token boundary (`updateplan/startup2.md` §27).
 *
 * The list is what a provider may touch; everything else is refused by name. The refusals are the interesting
 * half, because the plan's requirement is not "unusual values are unlikely" but "there is no vocabulary for
 * taking the interface over".
 */

test('the vocabulary is exactly the seven tokens the plan names', () => {
  assert.deepEqual(APPEARANCE_TOKEN_NAMES, [
    '--dsh-surface-opacity',
    '--dsh-surface-blur',
    '--dsh-surface-tint',
    '--dsh-wallpaper-brightness',
    '--dsh-wallpaper-contrast',
    '--dsh-wallpaper-saturation',
    '--dsh-wallpaper-darken'
  ])
})

test('a provider may paint, not take over: DOM, structure, layout, window and script names are refused', () => {
  for (const surface of FORBIDDEN_SURFACES) {
    const result = validate({ [`--dsh-${surface}-everything`]: 1 })
    assert.equal(result.ok, false, `"${surface}" was accepted`)
    assert.match(result.refused[0].reason, /may paint, not take over/)
  }
  // And a name that is merely unknown is refused for being unknown.
  const unknown = validate({ '--dsh-nonsense': 1 })
  assert.equal(unknown.ok, false)
  assert.match(unknown.refused[0].reason, /is not an appearance token/)
})

test('values are clamped into each token\'s own range, and nonsense is refused', () => {
  const clamped = validate({
    '--dsh-surface-opacity': 999,
    '--dsh-surface-blur': -4,
    '--dsh-wallpaper-brightness': 5,
    '--dsh-wallpaper-saturation': 0.2
  })
  assert.equal(clamped.accepted['--dsh-surface-opacity'], 100)
  assert.equal(clamped.accepted['--dsh-surface-blur'], 0)
  assert.equal(clamped.accepted['--dsh-wallpaper-brightness'], 1.2)
  assert.equal(clamped.accepted['--dsh-wallpaper-saturation'], 0.2)
  const refused = validate({ '--dsh-surface-blur': 'wide', '--dsh-surface-tint': 'reddish' })
  assert.equal(refused.ok, false)
  assert.equal(refused.refused.length, 2)
  assert.equal(validate({ '--dsh-surface-tint': '#0f1115' }).ok, true)
})

test('an accepted patch reaches only the glass and the picture', () => {
  const patch = toLayerPatch({ '--dsh-surface-opacity': 82, '--dsh-surface-blur': 12, '--dsh-wallpaper-brightness': 0.6, '--dsh-wallpaper-darken': 18 })
  assert.deepEqual(patch.glass, { opacity: 82, blur: 12 })
  // `darken` is the token's public name for the layer's own `scrim`: the patch speaks the layer's vocabulary so
  // the two names never become two numbers.
  assert.deepEqual(patch.wallpaper.main, { brightness: 0.6, scrim: 18 })
  assert.deepEqual(patch.wallpaper.dock, { brightness: 0.6, scrim: 18 }, 'a provider describes the appearance, not one strip')
  // A refused token contributes nothing at all — not a zero, not a default.
  const mixed = toLayerPatch({ '--dsh-surface-blur': 10, '--dsh-dom-tree': 1 })
  assert.deepEqual(mixed.glass, { blur: 10 })
  assert.deepEqual(mixed.wallpaper.main, {})
})

test('the stylesheet fragment carries the unit each token has', () => {
  const css = toCss({ '--dsh-surface-opacity': 82, '--dsh-surface-blur': 12, '--dsh-wallpaper-brightness': 0.6 })
  assert.match(css, /^:root:root \{/)
  assert.match(css, /--dsh-surface-opacity: 82%;/)
  assert.match(css, /--dsh-surface-blur: 12px;/)
  assert.match(css, /--dsh-wallpaper-brightness: 0\.6;/)
  assert.equal(toCss({}), '', 'an empty patch is no stylesheet at all')
  assert.equal(toCss({ '--dsh-nope': 1 }), '', 'a refused patch produces nothing to apply')
})
