'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createPersistentTools,
  TOOL_KINDS,
  HANDLE_STATES,
  DEFAULT_POLICY
} = require('../../app/plugins/acceleration/persistent-tools/index.cjs')

/**
 * The persistent tool runtime (Update-Plan/accleration.md phase 9).
 *
 * Keeping a shell or a browser alive between steps is the cheapest large win in the
 * whole plan, and it is also the easiest place to hide a bug: a session that died
 * quietly still looks alive, a handle that is never retired leaks for a day, and a
 * concurrent second acquire opens a second session nobody will ever close. The tests
 * are about those three failures, not about the happy path being fast.
 */

/** A controllable runtime: a fake clock, and start/stop/probe that are counted. */
function harness(options = {}) {
  let clock = 1_000
  const events = { started: [], stopped: [], probed: [] }
  let alive = true
  const runtime = createPersistentTools({
    now: () => clock,
    policy: options.policy,
    start: async (kind, key) => {
      const resource = { kind, key, pid: events.started.length + 1 }
      events.started.push(resource)
      return resource
    },
    stop: async (resource) => {
      events.stopped.push(resource)
    },
    check: async (resource) => {
      events.probed.push(resource)
      return typeof options.alive === 'function' ? options.alive(resource) : alive
    }
  })
  return {
    runtime,
    events,
    advance: (ms) => {
      clock += ms
    },
    setAlive: (value) => {
      alive = value
    }
  }
}

test('a second step reuses the session instead of starting another one', async () => {
  const { runtime, events } = harness()
  const first = await runtime.acquire(TOOL_KINDS.SHELL, 'workspace')
  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  const second = await runtime.acquire(TOOL_KINDS.SHELL, 'workspace')
  assert.equal(second.ok, true)
  assert.equal(second.reused, true, 'the same tool and key must reuse the session')
  assert.equal(second.resource, first.resource, 'the caller gets the same live resource')
  // The point of the whole module: one start, two uses.
  assert.equal(events.started.length, 1)
  assert.equal(events.stopped.length, 0)
  const stats = runtime.stats()
  assert.equal(stats.starts, 1)
  assert.equal(stats.reuses, 1)
  assert.equal(stats.avoidedStarts, 1, 'each reuse is a start/init/load/exit that did not happen')
  assert.equal(stats.reuseRatio, 0.5)
})

test('a different key is a different session, and an unknown kind is refused', async () => {
  const { runtime, events } = harness()
  await runtime.acquire(TOOL_KINDS.SHELL, 'one')
  await runtime.acquire(TOOL_KINDS.SHELL, 'two')
  assert.equal(events.started.length, 2, 'two workspaces are two shells')
  // A different kind with the same key is also a different session.
  await runtime.acquire(TOOL_KINDS.LSP, 'one')
  assert.equal(events.started.length, 3)
  const refused = await runtime.acquire('quantum-debugger', 'one')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not a known persistent tool kind/)
  assert.equal(runtime.stats().refused, 1)
})

test('two concurrent acquires share one start rather than racing into two sessions', async () => {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let starts = 0
  const runtime = createPersistentTools({
    start: async (kind, key) => {
      starts += 1
      await gate
      return { kind, key }
    },
    stop: async () => {}
  })
  const [first, second] = await Promise.all([
    runtime.acquire(TOOL_KINDS.BROWSER, 'session'),
    Promise.resolve().then(() => release()).then(() => runtime.acquire(TOOL_KINDS.BROWSER, 'session'))
  ])
  assert.equal(starts, 1, 'the in-flight start must be shared, not duplicated')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.resource, first.resource)
})

test('capacity is refused with a reason, after reaping what is legitimately idle', async () => {
  const { runtime, events, advance } = harness({ policy: { maxHandles: 2, idleTtlMs: 60_000 } })
  const one = await runtime.acquire(TOOL_KINDS.SHELL, 'one')
  const two = await runtime.acquire(TOOL_KINDS.SHELL, 'two')
  const refused = await runtime.acquire(TOOL_KINDS.SHELL, 'three')
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'no capacity: 2 of 2 persistent shell handles are live')
  assert.equal(runtime.size, 2, 'the ceiling is never exceeded quietly')
  assert.equal(events.started.length, 2)
  // An idle handle is a legitimate candidate to retire, so the same acquire succeeds
  // once the idle ones are reaped.
  await runtime.release(one.handle.id, { ok: true })
  await runtime.release(two.handle.id, { ok: true })
  advance(61_000)
  const third = await runtime.acquire(TOOL_KINDS.SHELL, 'three')
  assert.equal(third.ok, true)
  assert.equal(events.stopped.length, 2, 'the idle sessions were stopped, not leaked')
  assert.equal(runtime.stats().retired, 2)
})

test('an idle session is retired after its TTL, and a busy one never is', async () => {
  const { runtime, events, advance } = harness({ policy: { idleTtlMs: 5_000 } })
  const held = await runtime.acquire(TOOL_KINDS.SHELL, 'held')
  advance(60_000)
  const whileBusy = await runtime.reap()
  assert.deepEqual(whileBusy.stopped, [], 'a session a step is holding must not be closed underneath it')
  assert.equal(runtime.size, 1)
  await runtime.release(held.handle.id, { ok: true })
  advance(5_001)
  const afterIdle = await runtime.reap()
  assert.equal(afterIdle.stopped.length, 1)
  assert.equal(afterIdle.stopped[0].idleMs, 5_001)
  assert.equal(runtime.size, 0)
  assert.equal(events.stopped.length, 1)
  // The next step starts a fresh session rather than trusting a retired one.
  const next = await runtime.acquire(TOOL_KINDS.SHELL, 'held')
  assert.equal(next.reused, false)
  assert.equal(runtime.stats().starts, 2)
})

test('a session that died quietly is discarded by the probe, never handed to the next step', async () => {
  const { runtime, events, setAlive } = harness()
  const first = await runtime.acquire(TOOL_KINDS.MODEL_SERVER, 'provider')
  await runtime.release(first.handle.id, { ok: true })
  setAlive(false)
  const health = await runtime.healthAll()
  assert.equal(health.ok, false)
  assert.equal(health.dead.length, 1)
  assert.match(health.dead[0].reason, /health probe found it dead/)
  assert.equal(runtime.size, 0)
  assert.equal(events.stopped.length, 1, 'the dead resource was stopped, not left running')
  // A stale session must never be reused on faith.
  setAlive(true)
  const second = await runtime.acquire(TOOL_KINDS.MODEL_SERVER, 'provider')
  assert.equal(second.reused, false)
  assert.equal(second.resource.pid !== first.resource.pid, true)
  assert.equal(runtime.stats().recycled, 1)
})

test('enough consecutive failures recycle the session instead of retrying forever', async () => {
  const { runtime } = harness({ policy: { failuresBeforeRecycle: 2 } })
  const first = await runtime.acquire(TOOL_KINDS.SHELL, 'flaky')
  const one = await runtime.release(first.handle.id, { ok: false })
  assert.equal(one.recycled, false, 'one failure is not yet a verdict')
  const two = await runtime.release(first.handle.id, { ok: false })
  assert.equal(two.recycled, true)
  assert.match(two.reason, /2 consecutive failed uses/)
  assert.equal(runtime.size, 0)
  // The retry budget is bounded: the next use starts a clean session.
  const second = await runtime.acquire(TOOL_KINDS.SHELL, 'flaky')
  assert.equal(second.reused, false)
  assert.equal(runtime.stats().starts, 2)
  assert.equal(runtime.stats().recycled, 1)
})

test('a handle is retired after its bounded reuse count even without a single failure', async () => {
  const { runtime, events } = harness({ policy: { maxReusesBeforeRecycle: 3 } })
  let last = null
  for (let index = 0; index < 3; index += 1) {
    const acquired = await runtime.acquire(TOOL_KINDS.LSP, 'server')
    last = await runtime.release(acquired.handle.id, { ok: true })
    assert.equal(acquired.reused, index > 0)
  }
  assert.equal(last.recycled, true)
  assert.match(last.reason, /reused 3 times, past the recycling limit/)
  assert.equal(runtime.stats().starts, 1, 'the recycling happened without a restart race')
  const next = await runtime.acquire(TOOL_KINDS.LSP, 'server')
  assert.equal(next.reused, false)
  assert.equal(events.stopped.length, 1)
})

test('run() releases on both paths, so a throwing step cannot leak capacity', async () => {
  const { runtime } = harness({ policy: { maxHandles: 1, idleTtlMs: 60_000 } })
  const ok = await runtime.run(TOOL_KINDS.SHELL, 'w', async (resource) => resource.pid)
  assert.equal(ok.ok, true)
  assert.equal(ok.value, 1)
  const failed = await runtime.run(TOOL_KINDS.SHELL, 'w', async () => {
    throw new Error('the command timed out')
  })
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /the command timed out/)
  assert.equal(failed.recycled, false, 'one failure keeps the session')
  // Capacity is still one, and the session is still the same live one: nothing leaked.
  assert.equal(runtime.size, 1)
  const again = await runtime.run(TOOL_KINDS.SHELL, 'w', async (resource) => resource.pid)
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
})

test('dispose stops everything and refuses to hand out another session', async () => {
  const { runtime, events } = harness()
  await runtime.acquire(TOOL_KINDS.SHELL, 'a')
  await runtime.acquire(TOOL_KINDS.BROWSER, 'b')
  const disposed = await runtime.dispose()
  assert.equal(disposed.stopped.length, 2)
  assert.equal(events.stopped.length, 2)
  assert.equal(runtime.size, 0)
  assert.equal(runtime.disposed, true)
  const after = await runtime.acquire(TOOL_KINDS.SHELL, 'a')
  assert.equal(after.ok, false)
  assert.match(after.reason, /disposed/)
})

test('the defaults are the plan\'s bounded policy', () => {
  assert.equal(DEFAULT_POLICY.maxHandles, 8)
  assert.equal(DEFAULT_POLICY.idleTtlMs, 10 * 60 * 1000)
  assert.equal(DEFAULT_POLICY.failuresBeforeRecycle, 2)
  assert.deepEqual(Object.values(TOOL_KINDS).sort(), ['browser', 'computer-use', 'lsp', 'model-server', 'shell'])
  assert.equal(HANDLE_STATES.BUSY, 'busy')
})
