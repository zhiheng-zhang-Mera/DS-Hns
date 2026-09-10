'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const { toSessionView, toSessionViews, withoutLegacyCostFields } = require('../../app/extensions/mega/tracker/session-view')

/**
 * MEGA-02: the "Recent Session Cost" product/UI feature is gone while the
 * billing layer, session tracking and legacy session data stay safe.
 */

test('the session projection never forwards a cost field', () => {
  const view = toSessionView({
    id: 'session-1',
    status: 'COMPLETED',
    model: 'deepseek-v4-flash',
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
    cost: { costCny: 1.23, estimated: false },
    usageEvents: [{ time: 1, inputTokens: 10 }]
  })
  assert.deepEqual(Object.keys(view).sort(), [
    'createdAt', 'cwd', 'error', 'fileMtimeMs', 'group', 'id', 'lastSeq', 'model', 'provider', 'status', 'updatedAt', 'usage'
  ].sort())
  assert.equal('cost' in view, false)
  assert.equal('costCny' in view, false)
  assert.equal(view.usage.totalTokens, 16)
})

test('legacy cost keys in old session data or settings are ignored safely', () => {
  const legacy = {
    id: 'old-session',
    status: 'COMPLETED',
    recentSessionCost: 9.99,
    sessionCost: { costCny: 9.99 },
    recent_cost: 9.99,
    costCny: 9.99,
    estimatedCost: 9.99,
    cost: { costCny: 9.99 },
    usageEvents: [{ time: 1 }]
  }
  const cleaned = withoutLegacyCostFields(legacy)
  for (const key of ['recentSessionCost', 'sessionCost', 'recent_cost', 'costCny', 'estimatedCost', 'cost']) {
    assert.equal(key in cleaned, false, `${key} must be dropped`)
  }
  assert.equal(cleaned.id, 'old-session')

  const view = toSessionView(legacy)
  assert.equal(view.id, 'old-session')
  assert.equal(view.usage.totalTokens, 0)
  assert.equal(JSON.stringify(view).includes('9.99'), false)
})

test('the projection tolerates missing, malformed and hostile records', () => {
  for (const input of [null, undefined, 0, '', 'text', [], { usage: 'nope' }, { usage: { inputTokens: 'abc' } }]) {
    assert.doesNotThrow(() => toSessionView(input))
  }
  const view = toSessionView({ status: null, usage: { inputTokens: 'x', outputTokens: -3 } })
  assert.equal(view.status, 'UNKNOWN')
  assert.equal(view.createdAt, null)
  assert.equal(view.usage.inputTokens, 0)
  assert.equal(view.usage.outputTokens, -3)
  assert.equal(Number.isFinite(view.usage.totalTokens), true)
  assert.deepEqual(toSessionViews(null), [])
  assert.deepEqual(toSessionViews([null, 'x', 3]), [])
  assert.equal(toSessionViews([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { limit: 2 }).length, 2)
})

test('the Mega UI no longer binds a Recent Session Cost metric', () => {
  const dockJs = read('app/extensions/mega/ui/dock.js')
  const rendererJs = read('app/extensions/mega/ui/renderer.js')
  const dockHtml = read('app/extensions/mega/ui/dock.html')
  const indexHtml = read('app/extensions/mega/ui/index.html')
  const megaIndex = read('app/extensions/mega/index.cjs')

  for (const [name, source] of [['dock.js', dockJs], ['renderer.js', rendererJs], ['dock.html', dockHtml], ['index.html', indexHtml]]) {
    assert.equal(/recentSessionCost|sessionCost|recent_cost|costCny/.test(source), false, `${name} still binds a session cost field`)
    assert.equal(/最近\s*8\s*个\s*Session/.test(source), false, `${name} still renders the recent-session cost card`)
  }
  assert.equal(/costForSession/.test(megaIndex), false, 'the cost aggregation helper is removed')
  assert.equal(/calculateTaskCost/.test(megaIndex), false, 'the UI no longer computes session cost')
  assert.equal(/cost: costForSession/.test(megaIndex), false)
  assert.equal(/<th>成本<\/th>/.test(indexHtml), false, 'the cost column header is gone')
})

test('the billing layer stays intact and operational', () => {
  for (const file of [
    'app/extensions/mega/billing/cost-calculator.js',
    'app/extensions/mega/billing/pricing-repository.js',
    'app/extensions/mega/billing/peak-engine.js'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${file} must remain available for accounting`)
  }
  const { calculateTaskCost } = require('../../app/extensions/mega/billing/cost-calculator')
  const PricingRepository = require('../../app/extensions/mega/billing/pricing-repository')
  const pricing = new PricingRepository()
  const model = pricing.getModel('deepseek-v4-flash')
  assert.ok(model, 'the pricing snapshot still resolves models')
  const cost = calculateTaskCost({
    model,
    schedule: pricing.getSchedule(),
    events: [{ time: Date.now(), inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  })
  assert.ok(cost.costCny > 0, 'cost calculation still works for telemetry/accounting')
})

test('the balance panel keeps a valid grid after the fourth card was removed', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(css, /\.balance-grid\{[^}]*auto-fit/)
  assert.equal(/\.balance-grid\{[^}]*repeat\(4,/.test(css), false, 'the 4-column grid would leave an empty cell')
  assert.match(css, /\.provider-list/)
})
