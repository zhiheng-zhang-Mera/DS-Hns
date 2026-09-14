'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { estimateAppearanceCost, APPEARANCE_BUDGETS } = require('../../app/extensions/mega/appearance/cost.cjs')

/**
 * The appearance cost ledger (`updateplan/startup2.md` §55-§57).
 *
 * It measures; it does not limit. The distinction is the point: the glass slider belongs to the user, so what
 * this can do is make a heavy appearance *visible* — in the log and in the Control Center — instead of leaving
 * the cost unexplained.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('the numbers in force are reported as they are, in one line for the log', () => {
  const cost = estimateAppearanceCost({ glass: { blur: 12, opacity: 82 }, windowBytes: 20_000, dockBytes: 0, layers: 1 })
  assert.equal(cost.glass.blur, 12)
  assert.equal(cost.glass.opacity, 82)
  assert.equal(cost.wallpaper.bytes, 20_000)
  assert.equal(cost.wallpaper.kilobytes, 20)
  assert.equal(cost.layers, 1)
  assert.deepEqual(cost.warnings, [])
  assert.match(cost.line, /^\[PERF\] appearance glass=12px\/82% pictures=20KB layers=1$/)
})

test('blur is warned about in two steps, and never clamped', () => {
  const comfortable = estimateAppearanceCost({ glass: { blur: 14, opacity: 60 } })
  assert.deepEqual(comfortable.warnings, [], '14px is inside §55\'s comfortable range')
  const heavy = estimateAppearanceCost({ glass: { blur: 22, opacity: 60 } })
  assert.equal(heavy.warnings[0].id, 'blur-over-comfort')
  assert.equal(heavy.warnings[0].comfort, true)
  assert.equal(heavy.glass.blur, 22, 'the ledger clamped the number the user chose')
  const past = estimateAppearanceCost({ glass: { blur: 44, opacity: 60 } })
  assert.equal(past.warnings[0].id, 'blur-over-ceiling')
  assert.match(past.line, /warnings=blur-over-ceiling/)
})

test('a picture that is heavier than the screen can show is reported', () => {
  const heavy = estimateAppearanceCost({ glass: { blur: 12, opacity: 82 }, windowBytes: 5 * 1024 * 1024, layers: 1 })
  assert.equal(heavy.warnings[0].id, 'wallpaper-heavy')
  assert.match(heavy.warnings[0].reason, /5120 KB/)
  assert.equal(heavy.wallpaper.kilobytes, 5120)
  assert.equal(heavy.wallpaper.bytes > APPEARANCE_BUDGETS.wallpaperBytesComfort, true)
})

test('an empty appearance costs nothing and warns about nothing', () => {
  const cost = estimateAppearanceCost()
  assert.deepEqual(cost.warnings, [])
  assert.equal(cost.wallpaper.bytes, 0)
  assert.equal(cost.layers, 0)
  assert.equal(cost.glass.opacity, null, 'an unknown opacity must be reported as unknown, not as zero')
  assert.match(cost.line, /glass=0px\/—/)
})

test('the layers report the bytes they carry, so the ledger never rebuilds a multi-megabyte string', () => {
  const wallpaper = read('app/extensions/mega/wallpaper.cjs')
  assert.match(wallpaper, /bytes: inlined\.dataUrl \? inlined\.dataUrl\.length : 0/)
  // Both layers: the main screen's window layer and the dock's own element.
  assert.equal((wallpaper.match(/bytes: inlined\.dataUrl \? inlined\.dataUrl\.length : 0/g) || []).length, 2)
})
