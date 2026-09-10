'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const lifecycle = require('../../app/extensions/mega/scheduler/lifecycle')

/** Canonical lifecycle vocabulary shared by the queue, history and notification layers. */

test('every persisted terminal status maps onto the canonical terminal set', () => {
  assert.equal(lifecycle.terminalState('COMPLETED'), lifecycle.CANONICAL_TERMINAL.COMPLETED)
  assert.equal(lifecycle.terminalState('FAILED'), lifecycle.CANONICAL_TERMINAL.FAILED_FINAL)
  assert.equal(lifecycle.terminalState('FAILED_FINAL'), lifecycle.CANONICAL_TERMINAL.FAILED_FINAL)
  assert.equal(lifecycle.terminalState('CANCELED'), lifecycle.CANONICAL_TERMINAL.CANCELLED)
  assert.equal(lifecycle.terminalState('CANCELLED'), lifecycle.CANONICAL_TERMINAL.CANCELLED)
  assert.equal(lifecycle.terminalState('INTERRUPTED'), lifecycle.CANONICAL_TERMINAL.CANCELLED)

  for (const nonTerminal of ['PENDING', 'SUSPENDED', 'RUNNING', 'DISPATCHING', '', null, undefined]) {
    assert.equal(lifecycle.terminalState(nonTerminal), null)
    assert.equal(lifecycle.isTerminalStatus(nonTerminal), false)
  }
})

test('queue/active classification is case and whitespace tolerant', () => {
  assert.equal(lifecycle.isQueuedStatus(' pending '), true)
  assert.equal(lifecycle.isQueuedStatus('suspended'), true)
  assert.equal(lifecycle.isActiveStatus('running'), true)
  assert.equal(lifecycle.isActiveStatus('dispatching'), true)
  assert.equal(lifecycle.isActiveStatus('PENDING'), false)
  assert.equal(lifecycle.isTerminalStatus('completed'), true)
})

test('persisted status keeps the legacy vocabulary', () => {
  assert.equal(lifecycle.persistedStatusFor(lifecycle.CANONICAL_TERMINAL.COMPLETED), 'COMPLETED')
  assert.equal(lifecycle.persistedStatusFor(lifecycle.CANONICAL_TERMINAL.FAILED_FINAL), 'FAILED')
  assert.equal(lifecycle.persistedStatusFor(lifecycle.CANONICAL_TERMINAL.CANCELLED), 'CANCELED')
  assert.equal(lifecycle.persistedStatusFor(lifecycle.CANONICAL_TERMINAL.CANCELLED, 'INTERRUPTED'), 'INTERRUPTED')
})

test('terminal keys are stable per transition and unique across transitions', () => {
  const base = { terminalKey: null }
  assert.equal(lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'COMPLETED'), 't1#COMPLETED#1000')
  assert.equal(lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'COMPLETED'), lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'COMPLETED'))
  assert.notEqual(lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'COMPLETED'), lifecycle.terminalKey({ id: 't1', endedAt: 2000 }, 'COMPLETED'))
  assert.notEqual(lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'COMPLETED'), lifecycle.terminalKey({ id: 't1', endedAt: 1000 }, 'FAILED'))
  assert.equal(lifecycle.terminalEpoch({ endedAt: 42 }), 42)
  assert.equal(lifecycle.terminalEpoch(base), 0)
})

test('task display names come from the task, its prompt or its id', () => {
  assert.equal(lifecycle.taskDisplayName({ name: 'explicit', prompt: 'ignored' }), 'explicit')
  assert.equal(lifecycle.taskDisplayName({ taskName: 'from event' }), 'from event')
  assert.equal(lifecycle.taskDisplayName({ prompt: 'first line\nsecond line' }), 'first line')
  assert.equal(lifecycle.taskDisplayName({ id: 'task-9' }), 'task-9')
  assert.equal(lifecycle.taskDisplayName(null), 'task')
  assert.equal(lifecycle.taskDisplayName({ prompt: 'x'.repeat(200) }).length <= 72, true)
})

test('error summaries normalize strings, objects and missing values', () => {
  assert.equal(lifecycle.errorSummary(null), null)
  assert.equal(lifecycle.errorSummary('   '), null)
  assert.equal(lifecycle.errorSummary('boom'), 'boom')
  assert.equal(lifecycle.errorSummary({ code: 'EXIT_1', message: 'dsh exited' }), 'EXIT_1: dsh exited')
  assert.equal(lifecycle.errorSummary({ message: 'only message' }), 'only message')
  assert.ok(lifecycle.errorSummary({ other: true }).length > 0)
})

test('terminal event payload carries the documented contract fields', () => {
  const task = {
    id: 'task-42',
    prompt: 'summarize the repository\nmore text',
    status: 'COMPLETED',
    createdAt: 1000,
    startedAt: 2000,
    endedAt: 6500,
    deliveryMode: 'official-session',
    officialSessionId: 'session-1',
    attempts: 2,
    error: null
  }
  const event = lifecycle.buildTerminalEvent(task, {
    finalStatus: 'COMPLETED',
    status: 'COMPLETED',
    reason: 'done',
    source: 'official-session',
    exitCode: 0
  })

  assert.equal(event.type, lifecycle.TERMINAL_EVENT)
  assert.equal(event.taskId, 'task-42')
  assert.equal(event.taskName, 'summarize the repository')
  assert.equal(event.finalStatus, 'COMPLETED')
  assert.equal(event.statusLabel, 'Completed')
  assert.equal(event.completedAt, 6500)
  assert.equal(event.shortResult, '5s')
  assert.equal(event.errorSummary, null)
  assert.equal(event.terminalKey, 'task-42#COMPLETED#6500')
  assert.equal(event.deliveryMode, 'official-session')
  assert.equal(event.officialSessionId, 'session-1')
  assert.equal(event.attempts, 2)

  const failed = lifecycle.buildTerminalEvent({ ...task, status: 'FAILED', error: 'network down' }, {
    finalStatus: 'FAILED_FINAL',
    status: 'FAILED'
  })
  assert.equal(failed.finalStatus, 'FAILED_FINAL')
  assert.equal(failed.statusLabel, 'Failed')
  assert.equal(failed.errorSummary, 'network down')
  assert.equal(failed.shortResult, null)
})
