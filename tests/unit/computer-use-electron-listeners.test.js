'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createElectronDebuggerTransport } = require('../../app/computer-use/drivers/cdp-page.cjs')
const { createElectronHost, pageFromWebContents } = require('../../app/computer-use/host-electron.cjs')

// Electron is the OS boundary; retain the real EventEmitter listener accounting.
function contents() {
  const debugger_ = new EventEmitter()
  let attached = false
  debugger_.isAttached = () => attached
  debugger_.attach = () => { attached = true }
  debugger_.detach = () => { attached = false; debugger_.emit('detach') }
  debugger_.sendCommand = async () => ({})
  return { debugger: debugger_, isDestroyed: () => false }
}

test('Electron transport detach removes owned native listeners across reconnects', async () => {
  const wc = contents()
  const transport = createElectronDebuggerTransport(wc)
  let events = 0
  for (let i = 0; i < 4; i++) {
    transport.onEvent(method => { if (method === 'Page.loadEventFired') events++ })
    await transport.send('Runtime.enable', {})
    assert.equal(wc.debugger.listenerCount('message'), 1)
    assert.equal(wc.debugger.listenerCount('detach'), 1)
    wc.debugger.emit('message', {}, 'Page.loadEventFired', {})
    assert.equal(events, i + 1)
    transport.detach()
    assert.equal(wc.debugger.listenerCount('message'), 0)
    assert.equal(wc.debugger.listenerCount('detach'), 0)
  }
})

test('Electron host reuses one adapter for repeated observation of the same view', async () => {
  const wc = contents()
  const host = createElectronHost({ getWebContents: () => wc })
  const first = host.refreshPage()
  try {
    for (let i = 0; i < 4; i++) {
      const page = host.refreshPage()
      assert.equal(page, first)
      await page.transport.send('Runtime.enable', {})
    }
    assert.equal(wc.debugger.listenerCount('message'), 1)
    assert.equal(wc.debugger.listenerCount('detach'), 1)
  } finally { first.transport.detach() }
})

test('Electron host releases old view transport before observing its replacement', async () => {
  const old = contents()
  let current = old
  const host = createElectronHost({ getWebContents: () => current })
  const first = host.refreshPage()
  await first.transport.send('Runtime.enable', {})
  current = contents()
  const next = host.refreshPage()
  assert.notEqual(next, first)
  assert.equal(old.debugger.listenerCount('message'), 0)
  assert.equal(old.debugger.listenerCount('detach'), 0)
  next.transport.detach()
})

test('a detached cached page re-enables its CDP domains before the next observation', async () => {
  const wc = contents()
  const commands = []
  wc.debugger.sendCommand = async method => { commands.push(method); return {} }
  const page = pageFromWebContents(wc)
  await page.attach()
  wc.debugger.detach()
  await page.attach()
  assert.equal(commands.filter(method => method === 'Runtime.enable').length, 2)
  assert.equal(wc.debugger.listenerCount('message'), 1)
  page.transport.detach()
})

test('native detach releases old subscribers and reconnect delivers only new subscriptions', async () => {
  const wc = contents()
  const transport = createElectronDebuggerTransport(wc)
  let oldEvents = 0
  let newEvents = 0
  transport.onEvent(method => { if (method === 'Page.loadEventFired') oldEvents++ })
  await transport.send('Page.enable', {})
  wc.debugger.detach()
  transport.onEvent(method => { if (method === 'Page.loadEventFired') newEvents++ })
  await transport.send('Page.enable', {})
  wc.debugger.emit('message', {}, 'Page.loadEventFired', {})
  assert.equal(oldEvents, 0)
  assert.equal(newEvents, 1)
  transport.detach()
})
