'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/**
 * MEGA-02 + refix.md §7: the "Recent Session Cost" metric is gone and Mega no
 * longer mirrors the official Harness session history at all, while the billing
 * layer and the session tracker stay intact.
 */

test('the Mega UI renders no session list and no cost metric', () => {
  const dockHtml = read('app/extensions/mega/ui/dock.html')
  const dockJs = read('app/extensions/mega/ui/dock.js')
  const megaIndex = read('app/extensions/mega/index.cjs')

  for (const [name, source] of [['dock.html', dockHtml], ['dock.js', dockJs]]) {
    assert.equal(/最近\s*Session/.test(source), false, `${name} still renders a Recent Session panel`)
    assert.equal(/recentSessionCost|sessionCost|recent_cost|costCny/.test(source), false, `${name} still binds a cost field`)
    assert.equal(/id="sessions"/.test(source), false, `${name} still has a session list container`)
    assert.equal(/tokenCount/.test(source), false, `${name} still aggregates session tokens`)
  }
  assert.equal(/最近\s*8\s*个\s*Session/.test(dockJs + dockHtml), false)
  assert.equal(/costForSession/.test(megaIndex), false, 'the cost aggregation helper is removed')
  assert.equal(/calculateTaskCost/.test(megaIndex), false, 'the UI no longer computes session cost')
})

test('snapshot exposes no session payload and no session projection module remains', () => {
  const megaIndex = read('app/extensions/mega/index.cjs')
  // The *dock* snapshot must not mirror the official session history. The
  // Dual-UI native frontend has its own HNS model (Update-Plan/Dual-UI.md
  // 任务 9) which legitimately carries `sessions`; that is a different consumer,
  // so this assertion is scoped to the dock snapshot builder.
  const dockSnapshot = megaIndex.split('function snapshot()')[1].split('\nfunction ')[0]
  assert.equal(/\bsessions:/.test(dockSnapshot), false, 'dock snapshot.sessions must be gone')
  assert.equal(/sessionReader\.listSessions\(\{ limit: 40 \}\)/.test(megaIndex), false)
  assert.equal(/toSessionViews/.test(megaIndex), false, 'the UI-only session projection is deleted')
  assert.equal(fs.existsSync(path.join(ROOT, 'app/extensions/mega/tracker/session-view.js')), false)
  // The tracker layer itself stays: the terminal observer reads sessions from it.
  assert.equal(fs.existsSync(path.join(ROOT, 'app/extensions/mega/tracker/session-reader.js')), true)
  assert.match(read('app/extensions/mega/tracker/terminal-observer.js'), /session-reader|listSessions/)
})

test('the billing layer stays intact and operational', () => {
  for (const file of [
    'app/extensions/mega/billing/cost-calculator.js',
    'app/extensions/mega/billing/pricing-repository.js',
    'app/extensions/mega/billing/peak-engine.js',
    'app/extensions/mega/billing/balance-service.js'
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

test('legacy session records carrying cost fields are ignored safely', () => {
  const { parseSessionFile } = require('../../app/extensions/mega/tracker/session-reader')
  const os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-session-'))
  const file = path.join(dir, 'session.jsonl')
  const lines = [
    { type: 'session', id: 'legacy-1', createdAt: 1, cwd: 'C:\\work', version: 'x', recentSessionCost: 4.2, sessionCost: { costCny: 4.2 }, costCny: 4.2 },
    { type: 'user/message', seq: 1, time: 2, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'success' }, costCny: 4.2, recent_cost: 4.2 } }
  ]
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const parsed = parseSessionFile(file)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.status, 'COMPLETED')
  assert.equal(parsed.firstUserText, 'hello')
  assert.equal(JSON.stringify(parsed).includes('4.2'), false, 'legacy cost values are never surfaced')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the balance panel keeps a valid grid after the fourth card was removed', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(css, /\.balance-grid\{[^}]*auto-fit/)
  assert.equal(/\.balance-grid\{[^}]*repeat\(4,/.test(css), false, 'the 4-column grid would leave an empty cell')
  assert.match(css, /\.provider-list/)
  assert.equal(/\.session-list/.test(css), false, 'the removed session list has no dead styles left')
})
