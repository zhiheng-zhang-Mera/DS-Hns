'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createTerminalDispatcher } = require('../../app/extensions/mega/notifications/terminal-dispatch')
const { TERMINAL_EVENT, CANONICAL_TERMINAL } = require('../../app/extensions/mega/scheduler/lifecycle')

/** One terminal state -> at most one ringtone and one desktop notification. */

function event(overrides = {}) {
  return {
    type: TERMINAL_EVENT,
    taskId: 'task-1',
    taskName: 'write the report',
    finalStatus: CANONICAL_TERMINAL.COMPLETED,
    status: 'COMPLETED',
    terminalKey: 'task-1#COMPLETED#1000',
    completedAt: 1000,
    ...overrides
  }
}

function makeDispatcher(overrides = {}) {
  const rung = []
  const notified = []
  const logs = []
  const dispatcher = createTerminalDispatcher({
    ring: (e) => { rung.push(e.terminalKey) },
    notify: (e) => { notified.push(e.terminalKey); return { sent: true, reason: 'sent' } },
    log: (message) => logs.push(message),
    ...overrides
  })
  return { dispatcher, rung, notified, logs }
}

test('the same terminal state rings and notifies exactly once', () => {
  const { dispatcher, rung, notified } = makeDispatcher()
  const first = dispatcher.dispatch(event())
  const second = dispatcher.dispatch(event())

  assert.equal(first.delivered, true)
  assert.equal(first.rung, true)
  assert.equal(first.notified, true)
  assert.equal(second.delivered, false)
  assert.equal(second.reason, 'duplicate')
  assert.deepEqual(rung, ['task-1#COMPLETED#1000'])
  assert.deepEqual(notified, ['task-1#COMPLETED#1000'])
  assert.equal(dispatcher.describe().duplicates, 1)
})

test('scheduler and session observer reports for one transition collapse into one alert', () => {
  const { dispatcher, rung, notified } = makeDispatcher()
  // Same task id / state / epoch, reported twice with different provenance.
  dispatcher.dispatch(event({ source: 'official-session' }))
  dispatcher.dispatch(event({ source: 'session-observer' }))
  assert.equal(rung.length, 1)
  assert.equal(notified.length, 1)
})

test('different tasks and different terminal epochs each alert', () => {
  const { dispatcher, rung } = makeDispatcher()
  dispatcher.dispatch(event())
  dispatcher.dispatch(event({ taskId: 'task-2', terminalKey: 'task-2#COMPLETED#1000' }))
  dispatcher.dispatch(event({ terminalKey: 'task-1#COMPLETED#2000' }))
  dispatcher.dispatch(event({ terminalKey: 'task-1#FAILED_FINAL#1000', finalStatus: CANONICAL_TERMINAL.FAILED_FINAL }))
  assert.equal(rung.length, 4)
})

test('a ringtone failure never blocks the notification, and vice versa', () => {
  const notified = []
  const logs = []
  const ringFails = createTerminalDispatcher({
    ring: () => { throw new Error('audio device unavailable') },
    notify: (e) => { notified.push(e.taskId); return { sent: true, reason: 'sent' } },
    log: (message) => logs.push(message)
  })
  const result = ringFails.dispatch(event({ taskId: 'a', terminalKey: 'a#1' }))
  assert.equal(result.delivered, true)
  assert.equal(result.rung, false)
  assert.equal(result.notified, true)
  assert.equal(notified.length, 1)
  assert.ok(logs.some((line) => /audio device unavailable/.test(line)))
  assert.equal(ringFails.describe().ringFailures, 1)

  const notifyFails = createTerminalDispatcher({
    ring: () => {},
    notify: () => { throw new Error('notification backend offline') },
    log: (message) => logs.push(message)
  })
  const second = notifyFails.dispatch(event({ taskId: 'b', terminalKey: 'b#1' }))
  assert.equal(second.delivered, true)
  assert.equal(second.rung, true)
  assert.equal(second.notified, false)
  assert.equal(notifyFails.describe().notifyFailures, 1)

  const refused = createTerminalDispatcher({ ring: () => {}, notify: () => ({ sent: false, reason: 'unsupported' }) })
  const third = refused.dispatch(event({ taskId: 'c', terminalKey: 'c#1' }))
  assert.equal(third.notified, false)
  assert.equal(third.delivered, true, 'a refused notification still counts as a delivered alert attempt')
})

test('non terminal payloads are ignored', () => {
  const { dispatcher, rung, notified } = makeDispatcher()
  for (const payload of [null, undefined, {}, { finalStatus: 'RUNNING' }, { type: 'OTHER_EVENT', finalStatus: 'COMPLETED' }]) {
    const result = dispatcher.dispatch(payload)
    assert.equal(result.delivered, false)
  }
  assert.equal(rung.length, 0)
  assert.equal(notified.length, 0)
})

test('the dedup window is bounded', () => {
  const { dispatcher } = makeDispatcher({ dedupLimit: 3 })
  for (let i = 0; i < 5; i++) dispatcher.dispatch(event({ taskId: `t${i}`, terminalKey: `t${i}#1` }))
  assert.equal(dispatcher.describe().delivered, 3)
  // The oldest key dropped out of the window, so it can alert again; the newest
  // entries are still deduplicated.
  assert.equal(dispatcher.has('t4#1'), true)
  assert.equal(dispatcher.has('t0#1'), false)
})
