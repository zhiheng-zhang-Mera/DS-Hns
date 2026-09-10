'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createController, attachBalanceModule } = require('../../app/extensions/mega/ui/balance-module')

/**
 * MEGA-04 renderer side: the Balance module refreshes exactly once per real
 * "open", never on re-render/resize/state-sync, coalesces duplicate triggers and
 * refreshes again after close -> reopen.
 */

function harness({ open = false, refreshImpl = null } = {}) {
  const calls = []
  const observed = { handler: null, detached: 0 }
  const events = { busy: [], errors: [] }
  const observer = {
    observe(_panel, handler) {
      observed.handler = handler
      return () => { observed.detached += 1 }
    }
  }
  const state = { open }
  const controller = createController({
    panel: { id: 'balance-panel' },
    isOpen: () => state.open,
    observe: observer.observe,
    refresh: async (trigger, options) => {
      calls.push({ trigger, options })
      if (refreshImpl) return refreshImpl(trigger, options)
      return { ok: true }
    },
    onBusy: (busy) => events.busy.push(busy),
    onError: (error) => events.errors.push(error)
  })
  return {
    controller,
    calls,
    observed,
    events,
    setOpen: (value) => { state.open = Boolean(value) },
    /** Simulates the panel entering/leaving the visible area. */
    setVisible: (value) => controller.setIntersecting(Boolean(value))
  }
}

test('a re-render while the module stays open does not refresh again', async () => {
  const h = harness({ open: true })

  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].trigger, 'module-open')

  // Renders, resizes, state sync and focus flicker all look like this: the
  // visibility state does not change, so nothing is refreshed.
  for (let i = 0; i < 25; i++) {
    h.controller.sync()
    h.setVisible(true)
  }
  await Promise.resolve()
  assert.equal(h.calls.length, 1, 'no request storm from DOM/state churn')
})

test('close then reopen refreshes again', async () => {
  const h = harness({ open: true })
  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 1)

  h.setVisible(false)
  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 2, 'reopening the module refreshes again')

  h.setVisible(false)
  h.setOpen(false)
  h.setOpen(true)
  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 3)
})

test('a collapsed host does not count as an open module', async () => {
  const h = harness({ open: false })
  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 0, 'visible but collapsed host is not an open Balance module')

  h.setOpen(true)
  h.controller.sync()
  await Promise.resolve()
  assert.equal(h.calls.length, 1)
})

test('manual and automatic triggers share one implementation and are coalesced', async () => {
  const pending = []
  const h = harness({
    open: true,
    refreshImpl: (trigger) => {
      if (trigger === 'retry') return Promise.resolve({ ok: true })
      return new Promise((resolve) => { pending.push(resolve) })
    }
  })

  h.setVisible(true)
  await Promise.resolve()
  assert.equal(h.calls.length, 1)

  // Fast clicking while the automatic refresh is still running.
  const manual1 = h.controller.trigger('manual')
  const manual2 = h.controller.trigger('manual')
  await Promise.resolve()
  assert.equal(h.calls.length, 1, 'duplicate requests are coalesced, not fanned out')
  assert.equal(h.controller.state.coalesced, 2)
  assert.equal(await manual1, null)
  assert.equal(await manual2, null)
  assert.equal(h.calls[0].trigger, 'module-open', 'the automatic trigger is the one that runs')

  for (const resolve of pending.splice(0)) resolve({ ok: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h.controller.state.inFlight, false)

  await h.controller.trigger('retry', { only: ['B'] })
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls[1], { trigger: 'retry', options: { only: ['B'] } })
})

test('the busy hook drives the temporary Refresh disable and always clears', async () => {
  const h = harness({ open: true })
  h.setVisible(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(h.events.busy, [true, false])
})

test('a refresh failure is reported and never rejects or wedges the controller', async () => {
  const h = harness({
    open: true,
    refreshImpl: () => { throw new Error('balance endpoint down') }
  })
  h.setVisible(true)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(h.events.errors.length, 1)
  assert.match(h.events.errors[0].message, /endpoint down/)
  assert.equal(h.controller.state.inFlight, false)

  // A later successful refresh still works.
  const h2 = harness({ open: true })
  h2.setVisible(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h2.calls.length, 1)
})

test('without an intersection observer the rendered module counts as open', async () => {
  const calls = []
  const controller = attachBalanceModule({
    panel: null,
    refresh: async (trigger) => { calls.push(trigger) },
    observe: null
  })
  await Promise.resolve()
  assert.equal(controller.isVisible(), true)
  assert.deepEqual(calls, ['module-open'])
})

test('openOnIntersect: false binds the automatic refresh to host visibility', async () => {
  const calls = []
  const observed = { count: 0 }
  const state = { open: false }
  const controller = attachBalanceModule({
    openOnIntersect: false,
    panelSelector: '.balance-panel',
    isOpen: () => state.open,
    refresh: async (trigger) => { calls.push(trigger) },
    observe: () => { observed.count += 1; return () => {} }
  })
  await Promise.resolve()
  assert.equal(observed.count, 0, 'no scroll observer is installed for a host-visibility module')
  assert.deepEqual(calls, [])

  state.open = true
  controller.sync()
  await Promise.resolve()
  assert.deepEqual(calls, ['module-open'])

  state.open = false
  controller.sync()
  state.open = true
  controller.sync()
  await Promise.resolve()
  assert.deepEqual(calls, ['module-open', 'module-open'], 'close then reopen refreshes again')
})
