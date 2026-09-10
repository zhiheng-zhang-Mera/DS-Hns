'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), `dsh-notify-test-${process.pid}`)
process.env.DSH_ROOT = SCRATCH
fs.rmSync(SCRATCH, { recursive: true, force: true })
fs.mkdirSync(path.join(SCRATCH, 'config'), { recursive: true })

const notificationService = require('../../app/extensions/mega/notifications/notification-service')
const { TERMINAL_EVENT, CANONICAL_TERMINAL } = require('../../app/extensions/mega/scheduler/lifecycle')

/** MEGA-03: one terminal transition, at most one notification, never fatal. */

function recordingFactory() {
  const created = []
  const factory = function FakeNotification(options) {
    created.push({ options, handlers: {}, shown: 0 })
    const record = created[created.length - 1]
    record.on = (name, handler) => { record.handlers[name] = handler }
    record.show = () => { record.shown += 1 }
    return record
  }
  factory.created = created
  return factory
}

function terminalEvent(overrides = {}) {
  const base = {
    type: TERMINAL_EVENT,
    taskId: 'task-1',
    taskName: 'write the report',
    finalStatus: CANONICAL_TERMINAL.COMPLETED,
    status: 'COMPLETED',
    completedAt: Date.UTC(2026, 0, 2, 6, 32, 0),
    terminalKey: 'task-1#COMPLETED#1',
    errorSummary: null
  }
  return { ...base, ...overrides }
}

test('completed and failed tasks produce the documented short content', () => {
  const completed = notificationService.buildTerminalNotification(terminalEvent())
  assert.equal(completed.title, 'DS-Hns')
  assert.match(completed.body, /^Task completed: write the report/)
  assert.match(completed.body, /Status: Completed/)
  assert.match(completed.body, /Finished: \d{2}:\d{2}/)

  const failed = notificationService.buildTerminalNotification(terminalEvent({
    finalStatus: CANONICAL_TERMINAL.FAILED_FINAL,
    status: 'FAILED',
    terminalKey: 'task-1#FAILED_FINAL#1',
    errorSummary: 'EXIT_1: dsh exited with code 1'
  }))
  assert.match(failed.body, /^Task failed: write the report/)
  assert.match(failed.body, /EXIT_1: dsh exited with code 1/)

  const cancelled = notificationService.buildTerminalNotification(terminalEvent({
    finalStatus: CANONICAL_TERMINAL.CANCELLED,
    status: 'CANCELED'
  }))
  assert.match(cancelled.body, /^Task cancelled: write the report/)
})

test('a live terminal transition notifies exactly once', () => {
  const factory = recordingFactory()
  const service = new notificationService.NotificationService({ createNotification: factory })
  const event = terminalEvent()

  const first = service.notifyTerminal(event)
  const second = service.notifyTerminal(event)

  assert.equal(first.sent, true)
  assert.equal(second.sent, false)
  assert.equal(second.reason, 'duplicate')
  assert.equal(factory.created.length, 1)
  assert.equal(factory.created[0].shown, 1)

  // A different task still notifies.
  const other = service.notifyTerminal(terminalEvent({ taskId: 'task-2', terminalKey: 'task-2#COMPLETED#9' }))
  assert.equal(other.sent, true)
  assert.equal(factory.created.length, 2)
})

test('scheduler, tracker and renderer style duplicates share one dedup key', () => {
  const factory = recordingFactory()
  const service = new notificationService.NotificationService({ createNotification: factory })
  const event = terminalEvent({ taskId: 'same-task' })
  // Three independent lifecycle observers all reporting the same transition.
  const results = [
    service.notifyTerminal({ ...event }),
    service.notifyTerminal({ ...event, source: 'tracker-sync' }),
    service.notifyTerminal({ ...event, source: 'renderer-refresh' })
  ]
  assert.equal(results.filter((r) => r.sent).length, 1)
  assert.equal(factory.created.length, 1)
})

test('settings gate completed/failed/cancelled notifications', () => {
  const factory = recordingFactory()
  const service = new notificationService.NotificationService({ createNotification: factory })
  notificationService.saveConfig({ enabled: true, onCompleted: true, onFailed: true, onCancelled: false })

  assert.equal(service.notifyTerminal(terminalEvent({ taskId: 'a', terminalKey: 'a#1' })).sent, true)
  assert.equal(service.notifyTerminal(terminalEvent({
    taskId: 'b',
    terminalKey: 'b#1',
    finalStatus: CANONICAL_TERMINAL.CANCELLED,
    status: 'CANCELED'
  })).reason, 'state-disabled:CANCELLED')
  assert.equal(service.notifyTerminal(terminalEvent({
    taskId: 'c',
    terminalKey: 'c#1',
    finalStatus: CANONICAL_TERMINAL.FAILED_FINAL,
    status: 'FAILED',
    errorSummary: 'boom'
  })).sent, true)

  notificationService.saveConfig({ onCancelled: true, enabled: false })
  assert.equal(service.notifyTerminal(terminalEvent({ taskId: 'd', terminalKey: 'd#1' })).reason, 'disabled')

  notificationService.saveConfig({ enabled: true, onCancelled: true })
})

test('bulk cancellation and silent continuations are intentionally suppressed', () => {
  const factory = recordingFactory()
  const service = new notificationService.NotificationService({ createNotification: factory })
  assert.equal(service.notifyTerminal(terminalEvent({ taskId: 'bulk', terminalKey: 'bulk#1', bulk: true })).reason, 'bulk-suppressed')
  assert.equal(service.notifyTerminal(terminalEvent({ taskId: 'silent', terminalKey: 'silent#1', silent: true })).reason, 'silent')
  assert.equal(factory.created.length, 0)
})

test('notification failure never escapes and never marks the task failed', () => {
  const logs = []
  const throwing = new notificationService.NotificationService({
    createNotification: function Broken() { throw new Error('notification backend unavailable') },
    log: (message) => logs.push(message)
  })
  const result = throwing.notifyTerminal(terminalEvent({ taskId: 'x', terminalKey: 'x#1' }))
  assert.equal(result.sent, false)
  assert.match(result.reason, /^error:/)
  assert.ok(logs.some((line) => /backend unavailable/.test(line)))

  const showThrows = new notificationService.NotificationService({
    createNotification: function Broken({ }) {
      return { on: () => {}, show: () => { throw new Error('show failed') } }
    }
  })
  const second = showThrows.notifyTerminal(terminalEvent({ taskId: 'y', terminalKey: 'y#1' }))
  assert.equal(second.sent, false)
  assert.match(second.reason, /^error:/)

  const unsupported = new notificationService.NotificationService({})
  assert.equal(unsupported.notifyTerminal(terminalEvent({ taskId: 'z', terminalKey: 'z#1' })).reason, 'unsupported')

  const noSupport = new notificationService.NotificationService({
    createNotification: Object.assign(function Noop() {}, { isSupported: () => false })
  })
  assert.equal(noSupport.notifyTerminal(terminalEvent({ taskId: 'w', terminalKey: 'w#1' })).reason, 'unsupported')
})

test('non terminal payloads are ignored instead of raising', () => {
  const factory = recordingFactory()
  const service = new notificationService.NotificationService({ createNotification: factory })
  for (const payload of [null, undefined, { finalStatus: 'RUNNING' }, { type: 'SOMETHING_ELSE' }]) {
    const result = service.notifyTerminal(payload)
    assert.equal(result.sent, false)
  }
  assert.equal(factory.created.length, 0)
})
