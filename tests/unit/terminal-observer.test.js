'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { TerminalObserver, isMegaLaunchedCwd, sessionDisplayName } = require('../../app/extensions/mega/tracker/terminal-observer')
const { TERMINAL_EVENT, CANONICAL_TERMINAL } = require('../../app/extensions/mega/scheduler/lifecycle')

/**
 * refix.md §8: the ordinary official Harness session must also produce a
 * terminal alert, together with scheduler and headless tasks, without alert
 * storms or duplicates.
 */

function session(overrides = {}) {
  return {
    id: 'session-1',
    cwd: 'C:\\work',
    status: 'RUNNING',
    lastSeq: 1,
    endedAt: null,
    updatedAt: Date.now(),
    delegationDepth: 0,
    sawUserMessage: true,
    firstUserText: 'write the report',
    model: 'deepseek-v4-flash',
    error: null,
    ...overrides
  }
}

function makeObserver({ sessions = [], managed = [] } = {}) {
  const state = { list: sessions }
  const observer = new TerminalObserver({
    listSessions: () => state.list,
    isManagedSession: (id) => managed.includes(String(id)),
    log: () => {}
  })
  const events = []
  observer.on(TERMINAL_EVENT, (event) => events.push(event))
  return { observer, events, state }
}

test('pre-existing session history never alerts (no boot storm)', () => {
  const finished = session({ status: 'COMPLETED', lastSeq: 9, endedAt: 1000 })
  const { observer, events } = makeObserver({ sessions: [finished, session({ id: 'session-2', status: 'FAILED' })] })

  observer.prime()
  assert.deepEqual(observer.poll(), [])
  assert.equal(events.length, 0)

  // A poll with no changes stays silent as well.
  observer.poll()
  observer.poll()
  assert.equal(events.length, 0)
})

test('an ordinary Harness session reaching a terminal state alerts once', () => {
  const running = session({ status: 'RUNNING' })
  const { observer, events, state } = makeObserver({ sessions: [running] })
  observer.prime()

  state.list = [session({ status: 'COMPLETED', lastSeq: 5, endedAt: 1700000000000 })]
  const emitted = observer.poll()

  assert.equal(emitted.length, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, TERMINAL_EVENT)
  assert.equal(events[0].finalStatus, CANONICAL_TERMINAL.COMPLETED)
  assert.equal(events[0].taskId, 'session:session-1')
  assert.equal(events[0].taskName, 'write the report')
  assert.equal(events[0].source, 'session-observer')
  assert.equal(events[0].officialSessionId, 'session-1')
  assert.equal(events[0].completedAt, 1700000000000)

  // Repeated polls of the same state are idempotent at the source level.
  assert.deepEqual(observer.poll(), [])
  assert.equal(events.length, 1)
})

test('every user turn of one session alerts separately', () => {
  const { observer, events, state } = makeObserver({ sessions: [session({ status: 'RUNNING', lastSeq: 1 })] })
  observer.prime()

  state.list = [session({ status: 'COMPLETED', lastSeq: 3, endedAt: 1700000000000 })]
  observer.poll()
  // The user sends another prompt: the session returns to RUNNING first.
  state.list = [session({ status: 'RUNNING', lastSeq: 5, endedAt: 1700000000000 })]
  observer.poll()
  state.list = [session({ status: 'COMPLETED', lastSeq: 7, endedAt: 1700000100000 })]
  observer.poll()

  assert.equal(events.length, 2)
  assert.notEqual(events[0].terminalKey, events[1].terminalKey)
  assert.deepEqual(events.map((e) => e.finalStatus), [CANONICAL_TERMINAL.COMPLETED, CANONICAL_TERMINAL.COMPLETED])
})

test('a brand new session that already finished is still announced exactly once', () => {
  const { observer, events, state } = makeObserver({ sessions: [] })
  observer.prime()
  state.list = [session({ id: 'fresh', status: 'COMPLETED', lastSeq: 2, endedAt: 1700000009999 })]
  assert.equal(observer.poll().length, 1)
  assert.equal(observer.poll().length, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0].taskId, 'session:fresh')
})

test('scheduler- and headless-launched sessions are filtered out', () => {
  const { observer, events, state } = makeObserver({
    sessions: [
      session({ id: 'scheduler-session', status: 'RUNNING' }),
      session({ id: 'headless-session', status: 'RUNNING', cwd: 'D:\\DS-Hns\\workspace\\active\\task-7' })
    ],
    managed: ['scheduler-session']
  })
  observer.prime()

  state.list = [
    session({ id: 'scheduler-session', status: 'COMPLETED', lastSeq: 9, endedAt: 1700000000001 }),
    session({ id: 'headless-session', status: 'COMPLETED', lastSeq: 4, endedAt: 1700000000002, cwd: 'D:\\DS-Hns\\workspace\\active\\task-7' })
  ]
  assert.deepEqual(observer.poll(), [])
  assert.equal(events.length, 0, 'the scheduler already reports those tasks')
})

test('session filter rules are explicit and documented', () => {
  const { observer, events, state } = makeObserver({
    sessions: [
      session({ id: 'agent-only', status: 'RUNNING', sawUserMessage: false }),
      session({ id: 'delegated', status: 'RUNNING', delegationDepth: 2 }),
      session({ id: 'mine', status: 'RUNNING' })
    ]
  })
  observer.prime()
  state.list = [
    session({ id: 'agent-only', status: 'COMPLETED', lastSeq: 3, sawUserMessage: false }),
    session({ id: 'delegated', status: 'COMPLETED', lastSeq: 3, delegationDepth: 2 }),
    session({ id: 'mine', status: 'INTERRUPTED', lastSeq: 3, endedAt: 1700000000003 })
  ]
  observer.poll()
  assert.equal(events.length, 1)
  assert.equal(events[0].finalStatus, CANONICAL_TERMINAL.CANCELLED)
  assert.equal(events[0].taskId, 'session:mine')

  assert.equal(isMegaLaunchedCwd('C:\\work\\active\\task-1'), true)
  assert.equal(isMegaLaunchedCwd('C:\\work\\active\\task-1\\'), true)
  assert.equal(isMegaLaunchedCwd('C:\\work'), false)
  assert.equal(isMegaLaunchedCwd(null), false)
})

test('a failing session store never throws and never stops the observer', () => {
  let calls = 0
  const observer = new TerminalObserver({
    listSessions: () => { calls += 1; throw new Error('session store unavailable') },
    log: () => {}
  })
  assert.doesNotThrow(() => observer.prime())
  assert.doesNotThrow(() => observer.poll())
  assert.equal(observer.primed, true)
  assert.ok(calls >= 2)

  // A managed-session check that throws also stays isolated.
  const broken = new TerminalObserver({
    listSessions: () => [session({ status: 'COMPLETED', lastSeq: 4 })],
    isManagedSession: () => { throw new Error('registry unavailable') },
    log: () => {}
  })
  broken.prime()
  assert.doesNotThrow(() => broken.poll())
})

test('the observer runs on an interval and can be stopped', () => {
  const { observer } = makeObserver({ sessions: [] })
  const started = observer.start()
  assert.equal(started, true)
  assert.equal(observer.primed, true)
  assert.equal(observer.start(), false, 'starting twice is a no-op')
  observer.stop()
  assert.equal(observer.timer, null)
  observer.stop()
})

test('session display names fall back to the workspace folder', () => {
  assert.equal(sessionDisplayName({ firstUserText: 'first line\nsecond' }), 'first line')
  assert.equal(sessionDisplayName({ cwd: 'D:\\projects\\demo\\' }), 'demo')
  assert.equal(sessionDisplayName({ id: 'abcdef123456' }), 'session abcdef12')
})
