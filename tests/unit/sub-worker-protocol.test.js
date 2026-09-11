'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const protocol = require('../../app/sub-worker/protocol.cjs')
const { redactSecrets, EventBus } = require('../../app/sub-worker/event-bus.cjs')

/**
 * Protocol level (plan §7, §8, §13, §23): the Controller and the worker are
 * coupled only through structured, versioned, validated messages.
 */

function validTask(overrides = {}) {
  return {
    version: 1,
    task_id: 'boss-kb-031',
    created_at: '2026-01-02T03:04:05.000Z',
    objective: 'Implement SQLite knowledge-store adapter',
    target_repo: 'D:\\Boss',
    allowed_paths: ['src/knowledge/**', 'tests/knowledge/**'],
    forbidden_paths: ['src/ipc/**'],
    acceptance: ['All existing tests pass'],
    permissions: { read: true, write: true, shell: true, git_commit: false, network: false },
    risk_level: 'L2',
    requires_vision: false,
    ...overrides
  }
}

test('the documented Task Object validates and is normalized', () => {
  const result = protocol.validateTask(validTask())
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.task.task_id, 'boss-kb-031')
  assert.equal(result.task.risk_level, 'L2')
  assert.deepEqual(result.task.allowed_paths, ['src/knowledge/**', 'tests/knowledge/**'])
  assert.deepEqual(result.task.forbidden_paths, ['src/ipc/**'])
  assert.deepEqual(result.task.permissions, { read: true, write: true, shell: true, git_commit: false, network: false })
  assert.equal(result.task.workspace_mode, 'isolated_worktree', 'isolated worktree is the documented default')
  assert.deepEqual(result.task.operations, [])
})

test('task validation reports every missing field instead of throwing', () => {
  const result = protocol.validateTask({})
  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 4)
  assert.ok(result.errors.some((error) => error.includes('task_id')))
  assert.ok(result.errors.some((error) => error.includes('objective')))
  assert.ok(result.errors.some((error) => error.includes('target_repo')))
  assert.ok(result.errors.some((error) => error.includes('version')))
})

test('an unsupported protocol version is rejected', () => {
  assert.equal(protocol.validateTask(validTask({ version: 2 })).ok, false)
  assert.equal(protocol.validateTask(validTask({ version: 0 })).ok, false)
  assert.equal(protocol.validateTask(validTask({ version: 1 })).ok, true)
})

test('an unknown risk level or workspace mode is rejected', () => {
  assert.equal(protocol.validateTask(validTask({ risk_level: 'L9' })).ok, false)
  assert.equal(protocol.validateTask(validTask({ workspace_mode: 'somewhere-else' })).ok, false)
  assert.equal(protocol.validateTask(validTask({ workspace_mode: 'shared' })).ok, true)
})

test('permissions default to the conservative reading of the plan', () => {
  const normalized = protocol.normalizePermissions(undefined)
  assert.deepEqual(normalized, { read: true, write: false, shell: false, git_commit: false, network: false })
})

test('task identifiers are sanitized into filesystem-safe names', () => {
  assert.equal(protocol.sanitizeTaskId('boss-kb-031'), 'boss-kb-031')
  assert.equal(protocol.sanitizeTaskId('../../etc/passwd'), 'etc-passwd')
  assert.equal(protocol.sanitizeTaskId('a b/c\\d'), 'a-b-c-d')
  assert.equal(protocol.sanitizeTaskId(''), '')
})

test('a task is only spec-complete with at least one executable operation', () => {
  assert.equal(protocol.hasExecutableSpecification({ operations: [] }), false)
  assert.equal(protocol.hasExecutableSpecification({ operations: [{ op: 'git_status' }] }), true)
  assert.equal(protocol.hasExecutableSpecification(null), false)
})

test('the Result Object carries exactly the documented contract fields', () => {
  const result = protocol.createResult('boss-kb-031', {
    status: 'completed',
    summary: 'SQLite adapter implemented and validated.',
    changed_files: ['src/knowledge/sqlite.ts', 'tests/knowledge/sqlite.test.ts'],
    tests: { passed: 43, failed: 0, skipped: 1 },
    git: { dirty: true, commit: null },
    warnings: [],
    needs_controller_review: true
  })
  assert.equal(result.task_id, 'boss-kb-031')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.changed_files, ['src/knowledge/sqlite.ts', 'tests/knowledge/sqlite.test.ts'])
  assert.deepEqual(result.tests, { passed: 43, failed: 0, skipped: 1 })
  assert.deepEqual(result.git.dirty, true)
  assert.equal(result.git.commit, null)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.needs_controller_review, true)
  assert.equal(result.ok, true)
  assert.equal(result.code, protocol.RESULT_CODES.OK)
})

test('every documented result status is accepted, anything else degrades to completed', () => {
  for (const status of protocol.RESULT_STATUSES) {
    assert.equal(protocol.createResult('t', { status }).status, status)
  }
  assert.equal(protocol.createResult('t', { status: 'nonsense' }).status, 'completed')
})

test('a blocked result follows the documented blocked shape', () => {
  const blocked = protocol.blockedResult('boss-kb-031', {
    code: protocol.RESULT_CODES.REQUIRES_CONTROLLER,
    reason: 'Existing public interface lacks transaction support.'
  })
  assert.equal(blocked.task_id, 'boss-kb-031')
  assert.equal(blocked.status, 'rejected')
  assert.equal(blocked.reason, 'Existing public interface lacks transaction support.')
  assert.equal(blocked.needs_controller_decision, true)
  assert.equal(blocked.requires_controller, true)
  assert.equal(blocked.ok, false)

  const unsupported = protocol.blockedResult('t', { code: protocol.RESULT_CODES.UNSUPPORTED_CAPABILITY, reason: 'vision' })
  assert.equal(unsupported.status, 'unsupported_capability')
})

test('risk levels are graded exactly as the plan requires', () => {
  assert.deepEqual([...protocol.ALLOWED_RISK_LEVELS], ['L0', 'L1', 'L2'])
  assert.deepEqual([...protocol.RISK_LEVELS], ['L0', 'L1', 'L2', 'L3', 'L4'])
  assert.equal(protocol.RISK_BY_TIER.L3, 'architecture_modification')
  assert.equal(protocol.RISK_BY_TIER.L4, 'product_direction')
})

test('risk_level is required: an omitted classification is never read as safe', () => {
  const missing = protocol.validateTask(validTask({ risk_level: undefined }))
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((error) => error.includes('risk_level is required')), missing.errors.join('; '))
  assert.equal(protocol.validateTask(validTask({ risk_level: '' })).ok, false)
  assert.equal(protocol.validateTask(validTask({ risk_level: 'L2' })).ok, true)
})

test('the declared capability set matches plan §23', () => {
  assert.equal(protocol.CAPABILITIES.code, true)
  assert.equal(protocol.CAPABILITIES.shell, true)
  assert.equal(protocol.CAPABILITIES.git, true)
  assert.equal(protocol.CAPABILITIES.browser, false)
  assert.equal(protocol.CAPABILITIES.vision, false)
})

test('the event vocabulary covers every documented worker action', () => {
  for (const type of [
    'task_received', 'task_started', 'inspection_started', 'file_read', 'file_write',
    'command_started', 'command_output', 'command_finished', 'test_started', 'test_result',
    'git_status', 'diff_generated', 'warning', 'error', 'blocked', 'task_completed', 'task_failed'
  ]) {
    assert.ok(protocol.EVENT_TYPES.includes(type), `${type} must be part of the event vocabulary`)
  }
})

test('the lifecycle and stage vocabularies cover the documented states', () => {
  for (const state of ['OFF', 'STARTING', 'IDLE', 'ASSIGNED', 'RUNNING', 'PAUSED', 'BLOCKED', 'READY_FOR_REVIEW', 'FAILED', 'STOPPING', 'CRASHED']) {
    assert.ok(protocol.WORKER_STATES.includes(state), `${state} must exist`)
  }
  // §15 Take Over adds HANDOFF; PAUSING makes the documented PAUSE sequence real.
  assert.ok(protocol.WORKER_STATES.includes('HANDOFF'))
  assert.ok(protocol.WORKER_STATES.includes('PAUSING'))
  for (const stage of ['INSPECTING', 'IMPLEMENTING', 'TESTING', 'FIXING', 'VALIDATING', 'REPORTING']) {
    assert.ok(protocol.EXECUTION_STAGES.includes(stage), `${stage} must exist`)
  }
  assert.ok(protocol.EXECUTION_STAGES.includes('PLANNING_EXECUTION'))
})

test('message validation is directional and version-locked', () => {
  const ok = protocol.validateMessage(protocol.envelope('assign_task', { task: {} }), 'controller-to-worker')
  assert.equal(ok.ok, true)

  // A worker message must not be accepted as a controller message.
  const wrongDirection = protocol.validateMessage(protocol.envelope('result', {}), 'controller-to-worker')
  assert.equal(wrongDirection.ok, false)
  assert.match(wrongDirection.error, /unexpected controller-to-worker message type: result/)

  const wrongVersion = protocol.validateMessage({ v: 99, type: 'ping', payload: {} }, 'controller-to-worker')
  assert.equal(wrongVersion.ok, false)

  const missingPayload = protocol.validateMessage({ v: 1, type: 'ping' }, 'controller-to-worker')
  assert.equal(missingPayload.ok, false)
})

test('the line codec survives arbitrary chunk boundaries', () => {
  const decoder = new protocol.LineDecoder()
  const payload = protocol.encode(protocol.envelope('ready', { worker_id: 'sub-1' }))
    + protocol.encode(protocol.envelope('heartbeat', { at: 1 }))

  // One byte at a time is the worst case for chunk splitting.
  const messages = []
  for (const char of payload) messages.push(...decoder.push(char))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].type, 'ready')
  assert.equal(messages[0].payload.worker_id, 'sub-1')
  assert.equal(messages[1].type, 'heartbeat')
  assert.equal(decoder.buffer, '')
})

test('mangled or oversized lines are dropped, never fatal', () => {
  const decoder = new protocol.LineDecoder({ maxLine: 32 })
  const messages = decoder.push('not json\n{"v":1,"type":"ready","payload":{}}\n')
  assert.equal(messages.length, 1)
  assert.equal(decoder.errors.length, 1)
  decoder.push('x'.repeat(64))
  assert.ok(decoder.errors.some((error) => error.includes('oversized')))
  assert.deepEqual(decoder.push('\n'), [])
})

test('secrets are redacted from anything the user can read', () => {
  assert.equal(/sk-abcdefghijklmno/.test(redactSecrets('key sk-abcdefghijklmno here')), false)
  assert.match(redactSecrets('key sk-abcdefghijklmno here'), /sk-\[REDACTED\]/)
  assert.match(redactSecrets('http://127.0.0.1:3080/?token=abc123def'), /token=\[REDACTED\]/)
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmn'), /Bearer \[REDACTED\]/)
  assert.match(redactSecrets('api_key=supersecretvalue'), /api_key=\[REDACTED\]/)
  assert.match(redactSecrets('password: hunter2hunter2'), /password=\[REDACTED\]/)
})

test('the event bus keeps a bounded, ordered, timestamped history', () => {
  const seen = []
  const bus = new EventBus({ taskId: 't-1', ringSize: 3, onEvent: (event) => seen.push(event) })
  const subscriberSeen = []
  bus.subscribe((event) => subscriberSeen.push(event.type))

  bus.emit('task_received', { summary: 'received' })
  bus.emit('file_write', { path: 'a.txt', summary: 'Updated a.txt' })
  bus.emit('command_started', { command: 'npm test' })
  bus.emit('error', { summary: 'boom' })

  assert.equal(bus.recent().length, 3, 'the ring buffer is bounded')
  assert.deepEqual(bus.recent().map((event) => event.type), ['file_write', 'command_started', 'error'])
  assert.equal(seen.length, 4, 'every event reaches the transport callback')
  assert.equal(subscriberSeen.length, 4)
  assert.equal(bus.recent()[0].task_id, 't-1')
  assert.match(bus.recent()[0].timestamp, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(bus.counts.file_write, 1)
})

test('a secret inside any event field never leaves the worker', () => {
  const bus = new EventBus({ taskId: 't-1' })
  const command = bus.emit('command_started', { command: 'curl "http://x.example/?token=supersecret123"' })
  assert.equal(/supersecret123/.test(command.command), false)
  assert.match(command.command, /token=\[REDACTED\]/)

  const blocked = bus.emit('blocked', { reason: 'api_key=abcdefghijklmnop is not allowed' })
  assert.equal(/abcdefghijklmnop/.test(blocked.reason), false)

  // Fields that are not on a hand-picked list are redacted too: a note carries
  // user text and can easily contain a key.
  const note = bus.emit('note_applied', { note: 'controller note api_key=sk-abcdefghijklmnopqrstuvwxyz', summary: 'note' })
  assert.equal(/sk-abcdefghijklmnopqrstuvwxyz/.test(note.note), false)
  assert.match(note.note, /api_key=\[REDACTED\]/)

  const output = bus.emit('command_output', { text: 'token=barebarebarebare' })
  assert.equal(/barebarebarebare/.test(output.text), false, 'a bare token= is redacted too')
})

test('a bare token assignment is redacted wherever it appears', () => {
  assert.equal(/abc123456789/.test(redactSecrets('token=abc123456789')), false)
  assert.match(redactSecrets('token=abc123456789'), /token=\[REDACTED\]/)
  assert.match(redactSecrets('?token=abc123456789&x=1'), /token=\[REDACTED\]/)
  assert.match(redactSecrets('access_token=abc123456789'), /access_token=\[REDACTED\]/)
  assert.match(redactSecrets('token: abc123456789'), /token=\[REDACTED\]/)
  // Ordinary prose is untouched.
  assert.equal(redactSecrets('the token budget is 100'), 'the token budget is 100')
})

test('the event bus never lets a broken observer break execution', () => {
  const bus = new EventBus({ taskId: 't-1' })
  bus.subscribe(() => { throw new Error('observer exploded') })
  assert.doesNotThrow(() => bus.emit('file_write', { path: 'a.txt' }))
  assert.equal(bus.recent().length, 1)
})

test('an unknown event type degrades to a warning instead of being lost', () => {
  const bus = new EventBus({ taskId: 't-1' })
  const event = bus.emit('not-a-real-event', { summary: 'hmm' })
  assert.equal(event.type, 'warning')
})

test('the wire envelope is versioned and self-describing', () => {
  const message = protocol.envelope('assign_task', { task: {} }, { task_id: 'boss-kb-031' })
  assert.equal(message.v, 1)
  assert.equal(message.type, 'assign_task')
  assert.equal(message.task_id, 'boss-kb-031')
  assert.equal(protocol.encode(message).endsWith('\n'), true)
  assert.deepEqual(JSON.parse(protocol.encode(message)), message)
})
