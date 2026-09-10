'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const scheduler = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'scheduler', 'scheduler.js'), 'utf8')
const preload = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'preload.cjs'), 'utf8')
const dock = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'dock.js'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'dock.html'), 'utf8')

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

test('the Mega dock exposes manual add and four-way ordering controls', () => {
  assert.match(html, /id="queuePosition"/)
  assert.match(html, /加入队列/)
  for (const move of ['top', 'up', 'down', 'bottom']) {
    assert.match(dock, new RegExp(`\\['${move}',`), `dock must offer the ${move} queue move`)
  }
  assert.match(dock, /data-move="\$\{move\}"/)
  assert.match(preload, /reorderTask/)
})

test('hardware-auto mode is visible in the Mega dock', () => {
  assert.match(html, /硬件自适应并行/)
  assert.match(html, /0 = 硬件自动/)
  assert.match(dock, /hardwareCap/)
  assert.match(dock, /refreshHardware/)
})
