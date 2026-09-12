'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createDockTarget,
  isDestroyed,
  isUsableWebContents,
  INTEGRATED_MODE,
  WINDOW_MODE,
  DETACHED_MODE
} = require('../../app/extensions/mega/dock/target')

/**
 * Dock Target Adapter.
 *
 * The product ships the dock as a `WebContentsView` owned by the shell, while the
 * legacy companion `BrowserWindow` must keep working. Both are exercised here
 * through the same interface, because "two backends, one code path" is the whole
 * point of the adapter: the theme system must not be able to tell them apart.
 */

function fakeWebContents({ send = [], destroyed = false, png = Buffer.from([0x89, 0x50, 0x4e, 0x47]) } = {}) {
  return {
    sent: send,
    isDestroyed: () => destroyed,
    send: (channel, payload) => send.push([channel, payload]),
    capturePage: async () => ({ toPNG: () => png })
  }
}

function integratedContext({ destroyed = false, bounds = { x: 100, y: 0, width: 560, height: 900 }, visible = true, png } = {}) {
  const contents = fakeWebContents({ destroyed, png })
  return {
    contents,
    ctx: {
      dockAdapter: {
        integrated: true,
        webContents: () => (destroyed ? { isDestroyed: () => true } : contents),
        bounds: () => bounds,
        visible: () => visible
      }
    }
  }
}

test('the integrated WebContentsView is the target the adapter resolves', async () => {
  const { contents, ctx } = integratedContext()
  const target = createDockTarget({ ctx, getLegacyWindow: () => null })

  assert.equal(target.mode(), INTEGRATED_MODE)
  assert.equal(target.isIntegrated(), true)
  assert.equal(target.hasTarget(), true)
  assert.equal(target.getWebContents(), contents)

  // send / capturePage / bounds / isDestroyed are all covered by the contract.
  assert.equal(target.send('mega:changed'), true)
  assert.deepEqual(contents.sent, [['mega:changed', undefined]])
  assert.equal(target.send('mega:theme-apply', { id: 'x' }), true)
  assert.deepEqual(contents.sent[1], ['mega:theme-apply', { id: 'x' }])

  const image = await target.capturePage()
  assert.ok(Buffer.isBuffer(image.toPNG()), 'capturePage reaches the view, not a window')

  assert.deepEqual(target.getBounds(), { x: 100, y: 0, width: 560, height: 900 })
  assert.deepEqual(target.getSize(), [560, 900])
  assert.equal(target.getVisible(), true)

  const state = target.getState({ expanded: true, expandedWidth: 560, collapsedWidth: 48 })
  assert.equal(state.mode, INTEGRATED_MODE)
  assert.equal(state.integrated, true)
  assert.equal(state.visible, true)
  assert.equal(state.width, 560)
  assert.equal(state.height, 900)
})

test('a destroyed view is not a target, and no capture is attempted', async () => {
  const { ctx } = integratedContext({ destroyed: true })
  const target = createDockTarget({ ctx, getLegacyWindow: () => null })

  assert.equal(target.hasTarget(), false)
  assert.equal(target.getWebContents(), null)
  assert.equal(target.send('mega:changed'), false, 'a push to a destroyed view reports failure')
  assert.equal(await target.capturePage(), null)
  assert.equal(target.getState({ expanded: true }).mode, DETACHED_MODE)
  assert.equal(target.getState({ expanded: true }).visible, false)
})

test('the legacy BrowserWindow backend still works through the same interface', async () => {
  const contents = fakeWebContents()
  const win = {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => true,
    getContentSize: () => [360, 800],
    getBounds: () => ({ x: 20, y: 20, width: 380, height: 840 })
  }
  const target = createDockTarget({ ctx: {}, getLegacyWindow: () => win })

  assert.equal(target.mode(), WINDOW_MODE)
  assert.equal(target.isIntegrated(), false)
  assert.equal(target.getWebContents(), contents)
  assert.equal(target.send('mega:changed'), true)
  assert.equal(await target.capturePage().then((image) => Buffer.isBuffer(image.toPNG())), true)
  assert.deepEqual(target.getSize(), [360, 800])
  assert.equal(target.getVisible(), true)

  const state = target.getState({ expanded: false, collapsedWidth: 48 })
  assert.equal(state.mode, WINDOW_MODE)
  assert.equal(state.integrated, false)
  assert.equal(state.width, 360)
})

test('an integrated target wins over a legacy window, and neither means detached', () => {
  const { ctx } = integratedContext()
  const legacy = { webContents: fakeWebContents(), isDestroyed: () => false, isVisible: () => true, getContentSize: () => [1, 1] }
  const both = createDockTarget({ ctx, getLegacyWindow: () => legacy })
  assert.equal(both.mode(), INTEGRATED_MODE, 'the shipped generation is preferred')

  const none = createDockTarget({ ctx: {}, getLegacyWindow: () => null })
  assert.equal(none.mode(), DETACHED_MODE)
  assert.equal(none.hasTarget(), false)
  assert.equal(none.getSize(), null)
  assert.equal(none.getVisible(), false)
  assert.equal(none.send('mega:changed'), false)
})

test('the legacy dockWebContents accessor is accepted as an integrated target', () => {
  // Older shells handed over the webContents (or a lazy accessor) directly; that
  // form must keep working now that the shipped form is a full adapter.
  const contents = fakeWebContents()
  const target = createDockTarget({ ctx: { dockWebContents: () => contents }, getLegacyWindow: () => null })
  assert.equal(target.mode(), INTEGRATED_MODE)
  assert.equal(target.isIntegrated(), true)
  assert.equal(target.getWebContents(), contents)
  // No geometry source: the adapter reports unknown, never a fake size.
  assert.equal(target.getBounds(), null)
  assert.equal(target.getSize(), null)
  assert.equal(target.getVisible(), true, 'a live view is the best evidence when the shell gave no visibility source')
})

test('a throwing adapter degrades to no target instead of crashing the caller', () => {
  const target = createDockTarget({
    ctx: {
      dockAdapter: {
        get webContents() { throw new Error('view gone') },
        bounds: () => { throw new Error('no bounds') },
        visible: () => { throw new Error('no visibility') }
      }
    },
    getLegacyWindow: () => { throw new Error('window gone') }
  })
  assert.equal(target.getWebContents(), null)
  assert.equal(target.hasTarget(), false)
  assert.equal(target.getBounds(), null)
  assert.equal(target.getSize(), null)
  assert.equal(target.getVisible(), false)
  assert.equal(target.send('mega:changed'), false)
})

test('isDestroyed and isUsableWebContents reject unusable targets', () => {
  assert.equal(isDestroyed(null), true)
  assert.equal(isDestroyed({ isDestroyed: () => false }), false)
  assert.equal(isDestroyed({ isDestroyed: () => { throw new Error('boom') } }), true)
  assert.equal(isUsableWebContents(null), false)
  assert.equal(isUsableWebContents({ isDestroyed: () => false }), false, 'a target must be able to receive a send')
  assert.equal(isUsableWebContents({ isDestroyed: () => false, send: () => {} }), true)
  assert.equal(isUsableWebContents({ isDestroyed: () => true, send: () => {} }), false)
})
