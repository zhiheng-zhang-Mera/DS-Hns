'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMegaItems, MEGA_ITEM_BUDGET } = require('../../app/extensions/mega/mega-items.cjs')

/**
 * MegaItemRegistry (`updateplan/startup2.md` §41, §44).
 *
 * The behaviour the rail needed: modules say what they have to say, a zero says nothing, and the rail
 * cannot grow past its budget. The plan's dedup work (§36-§43) is a consequence of those three rules
 * rather than a list of boxes somebody has to keep editing.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('items are ordered by priority and rendered generically', () => {
  const registry = createMegaItems()
  registry.register({ id: 'queue', priority: 40, current: () => ({ label: 'Q', value: 4, tone: 'busy' }) })
  registry.register({ id: 'workers', priority: 10, current: () => ({ label: 'RUN', value: 2 }) })
  const rail = registry.render({})
  assert.deepEqual(rail.items.map((item) => item.id), ['workers', 'queue'])
  assert.equal(rail.items[0].label, 'RUN')
  assert.equal(rail.items[1].tone, 'busy')
  assert.equal(rail.budget, MEGA_ITEM_BUDGET)
})

test('zero is not news: an item with nothing to say is absent, not a zero on screen', () => {
  const registry = createMegaItems()
  registry.register({ id: 'queue', priority: 40, current: (snapshot) => (snapshot.queued > 0 ? { label: 'Q', value: snapshot.queued } : null) })
  registry.register({ id: 'errors', priority: 50, current: (snapshot) => (snapshot.failed > 0 ? { label: 'ERR', value: snapshot.failed, tone: 'bad' } : null) })
  assert.deepEqual(registry.render({ queued: 0, failed: 0 }).items, [])
  assert.deepEqual(registry.render({ queued: 4, failed: 0 }).items.map((item) => item.id), ['queue'])
  assert.deepEqual(registry.render({ queued: 0, failed: 2 }).items.map((item) => item.id), ['errors'])
  // A caller that answers with a literal zero is treated as quiet as well: §43 is about the screen, not
  // about who is at fault for the zero.
  registry.register({ id: 'slots', priority: 20, current: () => ({ label: 'WKR', value: 0 }) })
  assert.deepEqual(registry.render({ queued: 0, failed: 0 }).items, [])
})

test('the rail has a budget, and what does not fit is counted rather than dropped', () => {
  const registry = createMegaItems({ budget: 3 })
  for (let index = 1; index <= 5; index += 1) {
    registry.register({ id: `item-${index}`, priority: index, current: () => ({ label: `L${index}`, value: index }) })
  }
  const rail = registry.render({})
  assert.deepEqual(rail.items.map((item) => item.id), ['item-1', 'item-2', 'item-3'])
  assert.equal(rail.overflow, 2)
  assert.deepEqual(rail.held, ['item-4', 'item-5'])
  assert.equal(rail.items.length, 3, 'the rail grew past its budget')
})

test('a broken item cannot take the rail with it, and ids cannot be claimed twice', () => {
  const registry = createMegaItems()
  registry.register({ id: 'boom', priority: 1, current: () => { throw new Error('no data') } })
  registry.register({ id: 'workers', priority: 2, current: () => ({ label: 'RUN', value: 1 }) })
  assert.deepEqual(registry.render({}).items.map((item) => item.id), ['workers'])
  assert.equal(registry.register({ id: 'workers', priority: 3, current: () => ({ label: 'X', value: 1 }) }).ok, false)
  assert.equal(registry.register({ id: '', current: () => null }).ok, false)
  assert.equal(registry.register({ id: 'nameless' }).ok, false)
})

test('the dock renders the registry instead of five fixed boxes', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const script = read('app/extensions/mega/ui/dock.js')
  const index = read('app/extensions/mega/index.cjs')
  // The old rail: one box per fact, updated by id. §36-§43 cannot be satisfied by that shape, and the
  // plan's "More" budget (§44) is impossible without a container to render into.
  for (const id of ['railRunning', 'railQueued', 'railWorkers', 'railSubWorker', 'railPeak']) {
    assert.equal(html.includes(`id="${id}"`), false, `${id} is still a fixed box in the rail`)
  }
  assert.match(html, /id="railItems"/, 'the rail has no container for registered items')
  assert.match(script, /railItems/, 'the dock does not render the registered items')
  assert.match(script, /megaItems/, 'the dock is not told what the rail holds')
  // The registry is MEGA's, registered at start, and pushed with the snapshot like every other fact.
  assert.match(index, /const \{ createMegaItems \} = require\('\.\/mega-items\.cjs'\)/)
  assert.match(index, /payload\.megaItems = megaItems\(\)\.render\(payload\)/)
  assert.match(index, /registerMegaItems\(\)/)
})
