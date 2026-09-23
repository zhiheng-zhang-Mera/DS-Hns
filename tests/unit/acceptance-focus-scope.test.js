'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the actual renderer probe, replacing only the DOM event-delivery
// boundary. Descendant control focus is not renderer/window focus ownership.
function probe() {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/acceptance.mjs'), 'utf8')
  const start = source.indexOf('window.__hnsAcceptanceInput =')
  const end = source.indexOf('return true', start)
  const listeners = new Map()
  const window = { addEventListener(name, fn) { listeners.set(name, fn) } }
  vm.runInNewContext(source.slice(start, end), { window })
  return { window, dispatch(name, target) { listeners.get(name)({ target }) } }
}

test('official input probe excludes descendant blur from window focus balance', () => {
  const p = probe()
  p.dispatch('blur', { tagName: 'BUTTON' })
  p.dispatch('focus', { tagName: 'TEXTAREA' })
  assert.equal(p.window.__hnsAcceptanceInput.blur, 0)
  assert.equal(p.window.__hnsAcceptanceInput.focus, 0)
})

test('official input probe retains an actual window focus loss and recovery', () => {
  const p = probe()
  p.dispatch('blur', p.window)
  assert.equal(p.window.__hnsAcceptanceInput.blur, 1)
  assert.equal(p.window.__hnsAcceptanceInput.focus, 0)
  p.dispatch('focus', p.window)
  assert.equal(p.window.__hnsAcceptanceInput.focus, 1)
})
