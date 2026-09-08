'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const scheduler = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'scheduler', 'scheduler.js'), 'utf8')
const preload = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'preload.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'renderer.js'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'index.html'), 'utf8')

test('queued tasks have persistent explicit ordering', () => {
  assert.match(scheduler, /queueOrder/)
  assert.match(scheduler, /ensureQueueOrders/)
  assert.match(scheduler, /reorderTask\(id, move/)
  assert.match(scheduler, /queuePosition === 'top'/)
})

test('scheduler launches queued tasks in queueOrder rather than createdAt order', () => {
  assert.match(scheduler, /filter\(isQueued\)\.sort\(\(a, b\) => \(a\.queueOrder \|\| 0\) - \(b\.queueOrder \|\| 0\)\)/)
  assert.match(scheduler, /queueRank/)
})

test('Mega renderer exposes manual add and four-way ordering controls', () => {
  assert.match(html, /id="queuePosition"/)
  assert.match(html, /新增队列任务/)
  for (const move of ['top', 'up', 'down', 'bottom']) assert.match(renderer, new RegExp(`data-move="${move}"`))
  assert.match(preload, /reorderTask/)
})

test('hardware-auto mode is visible in the Mega UI', () => {
  assert.match(html, /硬件自适应并行/)
  assert.match(html, /0 = 完全按硬件自动/)
  assert.match(renderer, /hardwareCap/)
  assert.match(renderer, /refreshHardware/)
})
