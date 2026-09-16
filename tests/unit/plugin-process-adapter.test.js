'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  PROCESS_API_VERSION,
  PROCESS_MANIFEST_FILE,
  PROCESS_FRAMES,
  PROCESS_FAULT_CODES,
  PROCESS_STATES,
  RESTART_POLICIES,
  classifyExit,
  policyWantsRestart,
  validateProcessManifest,
  environmentFor,
  encodeFrame,
  decodeFrame
} = require('../../app/core/plugin-adapters/process/contract.cjs')
const { createLineSplitter, createStdioTransport, createLocalhostTransport, createTransport } = require('../../app/core/plugin-adapters/process/transport.cjs')
const { createProcessSupervisor } = require('../../app/core/plugin-adapters/process/supervisor.cjs')
const { createProcessPluginAdapter, processPluginIdFor, permissionsFor } = require('../../app/core/plugin-adapters/adapters/process.cjs')
const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')

/**
 * The process adapter.
 *
 * Three things are being pinned here, and each is a way a process supervisor goes wrong:
 *
 *   * **the contract is closed** — an argv array rather than a shell string, a named transport, a
 *     bounded frame vocabulary, and an environment that is granted rather than inherited;
 *   * **the loops are bounded** — the restart budget ends in a terminal state, and the exit count
 *     stops growing. That is asserted against a real child process that really dies;
 *   * **the adapter is business-free** — it routes capabilities it never interprets, and its source
 *     must not contain the vocabulary of any particular plugin's job.
 *
 * The real companion (`dsh-restart-supervisor`) is exercised by
 * `scripts/process-adapter-acceptance.cjs`; this suite is self-contained so it runs anywhere.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-process-'))
  return {
    dir,
    write(relative, content) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content, 'utf8')
      return file
    },
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

/** A child that speaks the protocol properly. */
const WELL_BEHAVED = `
const send = (f) => process.stdout.write(JSON.stringify(f) + '\\n')
send({ kind: 'ready', capabilities: [{ name: 'demo', methods: ['ping', 'hang'] }] })
const beat = setInterval(() => send({ kind: 'heartbeat' }), 120)
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i = buffer.indexOf('\\n')
  while (i !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
    let frame = null
    try { frame = JSON.parse(line) } catch {}
    if (frame && frame.kind === 'invoke' && frame.method === 'ping') {
      send({ kind: 'result', id: frame.id, ok: true, result: { pong: frame.args } })
    }
    if (frame && frame.kind === 'shutdown') { clearInterval(beat); process.exit(0) }
    i = buffer.indexOf('\\n')
  }
})
`

function declaration(overrides = {}) {
  return {
    api_version: PROCESS_API_VERSION,
    id: 'demo',
    name: 'demo',
    version: '1.0.0',
    command: ['node', 'child.cjs'],
    transport: 'stdio-jsonl',
    heartbeat: { intervalMs: 120, timeoutMs: 2000, handshakeTimeoutMs: 8000 },
    restart: { policy: 'on-failure', maxRestarts: 2, windowMs: 60000, backoffMs: 60, backoffMaxMs: 200 },
    provides: { capabilities: [{ name: 'demo', methods: ['ping'] }] },
    limits: { invokeTimeoutMs: 1500, stopTimeoutMs: 3000 },
    ...overrides
  }
}

/** A plugin directory holding a child and its declaration. */
function processPlugin(area, childSource, overrides = {}) {
  const name = overrides.relative || 'plugin'
  area.write(`${name}/child.cjs`, childSource)
  area.write(`${name}/${PROCESS_MANIFEST_FILE}`, `${JSON.stringify(declaration(overrides.declaration || {}), null, 2)}\n`)
  return area.path(name)
}

/** A supervisor over one child, with teardown that always runs. */
async function rig(area, childSource, overrides = {}) {
  const dir = processPlugin(area, childSource, overrides)
  const validated = validateProcessManifest(JSON.parse(fs.readFileSync(path.join(dir, PROCESS_MANIFEST_FILE), 'utf8')), { dir })
  assert.equal(validated.ok, true, validated.errors && validated.errors.join('; '))
  const supervisor = createProcessSupervisor({ manifest: validated.manifest, dir, log: () => {} })
  return {
    supervisor,
    dir,
    async dispose() {
      await supervisor.dispose('test teardown')
    }
  }
}

test('a process declaration is validated before anything is executed', () => {
  const good = validateProcessManifest(declaration())
  assert.equal(good.ok, true, good.errors && good.errors.join('; '))
  assert.equal(good.manifest.heartbeat.timeoutMs, 2000)
  assert.deepEqual(good.manifest.provides.capabilities, [{ name: 'demo', methods: ['ping'], detail: null }])

  // Each of these is a way a declaration can be wrong, and each must be refused before a spawn.
  const cases = [
    [{ command: 'node child.js' }, /argv array/],
    [{ command: [] }, /argv array/],
    [{ command: ['node', ''] }, /non-empty string/],
    [{ version: 'latest' }, /semantic version/],
    [{ id: 'Not An Id' }, /not a valid plugin id/],
    [{ transport: 'carrier-pigeon' }, /is not one of/],
    [{ restart: { policy: 'sometimes' } }, /restart.policy/],
    [{ restart: { backoffMs: 5000, backoffMaxMs: 100 } }, /must not exceed/],
    [{ heartbeat: { intervalMs: 5000, timeoutMs: 1000 } }, /must exceed heartbeat.intervalMs/],
    [{ provides: { capabilities: [{ name: 'x', methods: [] }] } }, /non-empty methods array/]
  ]
  for (const [override, pattern] of cases) {
    const result = validateProcessManifest(declaration(override))
    assert.equal(result.ok, false, `${JSON.stringify(override)} was accepted`)
    assert.match(result.errors.join('; '), pattern)
  }
  assert.equal(validateProcessManifest(null).ok, false)

  // A command that reaches outside the plugin directory is refused: a manifest that can run any
  // binary on the machine makes the plugin directory meaningless.
  const escape = validateProcessManifest(declaration({ command: ['node', '../../outside.js'] }), { dir: 'C:/plugins/demo' })
  assert.equal(escape.ok, false)
  assert.match(escape.errors.join('; '), /resolves outside the plugin directory/)
})

test('a process is granted an environment rather than inheriting one', () => {
  const validated = validateProcessManifest(declaration({ env: { MY_SETTING: 'yes' } }))
  const env = environmentFor(validated.manifest, { token: 'abc' })
  assert.equal(env.MY_SETTING, 'yes')
  assert.equal(env.DSHNS_PROCESS_ID, 'demo')
  assert.equal(env.DSHNS_PROCESS_PROTOCOL, PROCESS_API_VERSION)
  assert.equal(env.DSHNS_PROCESS_TOKEN, 'abc')
  // The host's own environment must not ride along: a managed process is third-party code, and
  // inheriting everything hands it every key the host happens to be carrying.
  assert.equal('DEEPSEEK_API_KEY' in env, false)
  assert.equal('DSH_HOME' in env, false)
  assert.deepEqual(Object.keys(env).sort(), [
    'DSHNS_PROCESS_ID', 'DSHNS_PROCESS_PROTOCOL', 'DSHNS_PROCESS_TOKEN',
    'ELECTRON_RUN_AS_NODE', 'MY_SETTING', 'PATH', 'SystemRoot'
  ])
})

test('the frame vocabulary is closed in both directions', () => {
  const encoded = encodeFrame({ kind: PROCESS_FRAMES.HEARTBEAT, seq: 1 }, 4096)
  assert.equal(encoded.ok, true)
  assert.equal(encoded.line.endsWith('\n'), true)
  assert.equal(encodeFrame({ kind: 'heartbeat', pad: 'x'.repeat(5000) }, 4096).code, PROCESS_FAULT_CODES.FRAME_TOO_LARGE)

  assert.deepEqual(decodeFrame('{"kind":"ready"}', 4096).frame, { kind: 'ready' })
  assert.equal(decodeFrame('not json', 4096).code, PROCESS_FAULT_CODES.MALFORMED_FRAME)
  assert.equal(decodeFrame('[1,2]', 4096).code, PROCESS_FAULT_CODES.MALFORMED_FRAME)
  assert.equal(decodeFrame('{"kind":"take-over-the-host"}', 4096).code, PROCESS_FAULT_CODES.UNKNOWN_FRAME)
  assert.equal(decodeFrame(JSON.stringify({ kind: 'heartbeat', pad: 'x'.repeat(5000) }), 4096).code, PROCESS_FAULT_CODES.FRAME_TOO_LARGE)
})

test('a line splitter keeps partial lines and a transport routes frames and logs apart', () => {
  const splitter = createLineSplitter()
  assert.deepEqual(splitter.push('a\nb'), ['a'])
  assert.equal(splitter.pending, 'b')
  assert.deepEqual(splitter.push('\nc\n'), ['b', 'c'])

  // On stdio, stdout is protocol and stderr is log. They are never each other.
  const frames = []
  const faults = []
  const transport = createStdioTransport({ maxFrameBytes: 4096 })
  transport.onFrame((frame) => frames.push(frame))
  transport.onFault((fault) => faults.push(fault))
  const handlers = {}
  transport.attach({
    stdout: { setEncoding() {}, on: (type, handler) => { handlers[`stdout:${type}`] = handler } },
    stderr: { setEncoding() {}, on: (type, handler) => { handlers[`stderr:${type}`] = handler } },
    stdin: { write() {}, destroyed: false }
  })
  handlers['stdout:data']('{"kind":"heartbeat"}\n{"kind":"nonsense"}\n')
  handlers['stderr:data']('a stack trace\n')
  assert.equal(frames.filter((frame) => frame.kind === 'heartbeat').length, 1)
  assert.equal(frames.filter((frame) => frame.stream === 'stderr').length, 1, 'stderr must arrive as a log frame')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].code, PROCESS_FAULT_CODES.UNKNOWN_FRAME)
})

test('an unimplemented transport is refused by name', () => {
  const validated = validateProcessManifest(declaration())
  const bad = createTransport({ ...validated.manifest, transport: { kind: 'carrier-pigeon' } }, { log: () => {} })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, PROCESS_FAULT_CODES.UNSUPPORTED_TRANSPORT)
  assert.deepEqual(bad.available, ['stdio-jsonl', 'localhost-jsonl'])
  assert.equal(createTransport(validated.manifest, { log: () => {} }).transport.kind, 'stdio-jsonl')
  assert.equal(createLocalhostTransport({ maxFrameBytes: 4096 }).kind, 'localhost-jsonl')
})

test('how a process left decides whether it is restarted', () => {
  assert.deepEqual(classifyExit(0, null), { kind: 'clean', code: 0, signal: null })
  assert.equal(classifyExit(3, null).kind, 'failure')
  assert.equal(classifyExit(null, 'SIGTERM').kind, 'signal')

  // A clean exit is not a failure: restarting it forever under `on-failure` is how a supervisor
  // becomes a fork bomb.
  assert.equal(policyWantsRestart(RESTART_POLICIES.ON_FAILURE, 'clean'), false)
  assert.equal(policyWantsRestart(RESTART_POLICIES.ON_FAILURE, 'failure'), true)
  assert.equal(policyWantsRestart(RESTART_POLICIES.NEVER, 'failure'), false)
  assert.equal(policyWantsRestart(RESTART_POLICIES.ALWAYS, 'clean'), true)
})

test('a process plugin is started, bridged, health-checked and stopped', async () => {
  const area = scratch()
  const r = await rig(area, WELL_BEHAVED)
  try {
    const started = await r.supervisor.start()
    assert.equal(started.ok, true, started.reason)
    assert.equal(r.supervisor.state, PROCESS_STATES.RUNNING)
    // The manifest is the authoritative surface, and the child's announcement is a confirmation of
    // it. The child here offers `ping` and `hang` while the manifest declares only `ping`, so the
    // excess is refused and recorded rather than adopted.
    assert.deepEqual(r.supervisor.declared(), [{ name: 'demo', methods: ['ping'], confirmed: ['ping'] }])
    assert.ok(
      r.supervisor.faults().some((fault) => fault.code === PROCESS_FAULT_CODES.UNDECLARED_CAPABILITY),
      `an undeclared method must be recorded: ${JSON.stringify(r.supervisor.faults().map((fault) => fault.code))}`
    )

    // The capability is reached over the wire, and the answer is the child's own.
    const pong = await r.supervisor.invoke('demo', 'ping', ['hello'])
    assert.deepEqual(pong, { ok: true, result: { pong: ['hello'] } })

    // A method the manifest never declared is refused without being sent, even though the process
    // announced it -- the announcement does not widen the contract.
    const undeclared = await r.supervisor.invoke('demo', 'hang', [])
    assert.equal(undeclared.code, PROCESS_FAULT_CODES.NO_SUCH_CAPABILITY)

    // A capability nobody declared is refused too.
    const unknown = await r.supervisor.invoke('nope', 'ping', [])
    assert.equal(unknown.code, PROCESS_FAULT_CODES.NO_SUCH_CAPABILITY)

    // The heartbeat keeps it healthy.
    assert.equal(r.supervisor.status().heartbeat.fresh, true)
    assert.ok(r.supervisor.status().heartbeat.count > 0)

    const pid = r.supervisor.pid
    const stopped = await r.supervisor.stop({ reason: 'test' })
    assert.equal(stopped.ok, true)
    assert.equal(r.supervisor.state, PROCESS_STATES.STOPPED)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.throws(() => process.kill(pid, 0), 'the process must be gone after a stop')
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a declared method that never answers times out on the declared budget', async () => {
  const area = scratch()
  const r = await rig(area, WELL_BEHAVED, {
    // This time the manifest declares both methods, so `hang` is a legitimate call that simply
    // never gets an answer.
    declaration: { provides: { capabilities: [{ name: 'demo', methods: ['ping', 'hang'] }] }, limits: { invokeTimeoutMs: 400, stopTimeoutMs: 3000 } }
  })
  try {
    assert.equal((await r.supervisor.start()).ok, true)
    const started = Date.now()
    const hung = await r.supervisor.invoke('demo', 'hang', [])
    assert.equal(hung.code, PROCESS_FAULT_CODES.INVOKE_TIMEOUT)
    // Bounded by the declared budget, not by the test's patience.
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`)
    assert.deepEqual(r.supervisor.declared(), [{ name: 'demo', methods: ['hang', 'ping'], confirmed: ['hang', 'ping'] }])
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a stale heartbeat degrades the process without failing it', async () => {
  const area = scratch()
  // Ready, but never beats: a process that is alive and unresponsive.
  const r = await rig(area, "process.stdout.write(JSON.stringify({ kind: 'ready', capabilities: [{ name: 'demo', methods: ['ping'] }] }) + '\\n'); setInterval(() => {}, 1000)\n", {
    declaration: { heartbeat: { intervalMs: 100, timeoutMs: 300, handshakeTimeoutMs: 5000 } }
  })
  try {
    assert.equal((await r.supervisor.start()).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const status = r.supervisor.status()
    // Degraded, not failed: a missed beat is not an exit, and killing a process that is merely
    // quiet would turn a slow machine into a restart loop.
    assert.equal(status.state, PROCESS_STATES.DEGRADED)
    assert.equal(status.running, true)
    assert.equal(status.heartbeat.fresh, false)
    assert.ok(r.supervisor.faults().some((fault) => fault.code === PROCESS_FAULT_CODES.HEARTBEAT_STALE))
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a crash loop ends in a terminal state instead of restarting forever', async () => {
  const area = scratch()
  const r = await rig(area, 'process.exit(7)\n', {
    declaration: { restart: { policy: 'always', maxRestarts: 2, windowMs: 60000, backoffMs: 40, backoffMaxMs: 60 } }
  })
  try {
    const first = await r.supervisor.start()
    assert.equal(first.ok, false, 'a process that dies before ready cannot report a successful start')

    // Wait for the bounded sequence to spend itself.
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && r.supervisor.state !== PROCESS_STATES.SAFE_MODE) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(r.supervisor.state, PROCESS_STATES.SAFE_MODE, `state was ${r.supervisor.state}`)
    const exits = r.supervisor.exits().length
    // One initial start plus exactly `maxRestarts` restarts: bounded, and bounded by the declared
    // number rather than by a timeout that happens to fire.
    assert.equal(exits, 3, `expected 3 exits, saw ${exits}`)

    // `policy: always` is the setting that would otherwise loop forever; the budget is what stops it.
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(r.supervisor.exits().length, exits, 'nothing may restart after the budget is spent')
    assert.equal(r.supervisor.isSafeMode, true)
    assert.ok(r.supervisor.faults().some((fault) => fault.code === PROCESS_FAULT_CODES.CRASH_LOOP))
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a clean exit under on-failure is not restarted', async () => {
  const area = scratch()
  const r = await rig(area, "setTimeout(() => process.exit(0), 120)\n")
  try {
    const first = await r.supervisor.start()
    assert.equal(first.ok, false, 'it exited before it was ready')
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(r.supervisor.exits().length, 1, 'a clean exit must not be retried')
    assert.notEqual(r.supervisor.state, PROCESS_STATES.SAFE_MODE)
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('the adapter reaches the manager as an ordinary plugin with a declared capability', async () => {
  const area = scratch()
  const dir = processPlugin(area, WELL_BEHAVED)
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createProcessPluginAdapter({ log: () => {} }))
  const manager = createPluginManager({ log: () => {} })
  try {
    const adapted = await framework.adapt({ dir })
    assert.equal(adapted.ok, true, adapted.reason)
    assert.equal(adapted.adapter.id, 'dshns.process')
    assert.equal(adapted.detection.type, 'dshns.process')

    const plugin = adapted.plugin
    const id = plugin.manifest.id
    assert.equal(id, 'process.demo')
    assert.equal(plugin.manifest.runtime.kind, 'managed-process')
    assert.equal(plugin.manifest.runtime.enforcement, 'protocol')
    assert.deepEqual(plugin.manifest.provides, ['demo'])
    assert.deepEqual(plugin.manifest.permissions.granted, ['fs.read', 'process.spawn'])

    manager.install(plugin)
    assert.equal(manager.entry(id).enabled, false, 'a background process must never auto-start')
    manager.enable(id)
    assert.equal((await manager.load(id)).ok, true)
    assert.equal((await manager.checkHealth(id)).status, 'healthy')

    // The capability is a normal one on HNS's side; what is behind it is a process.
    const impl = manager.registry.resolve('demo')
    assert.deepEqual(await impl.ping(['x']), { ok: true, result: { pong: [['x']] } })

    assert.equal((await manager.unload(id)).ok, true)
    assert.equal(manager.registry.has('demo'), false, 'unload must revoke the bridged capability')
  } finally {
    await manager.unloadAll()
    area.dispose()
  }
})

test('the adapter names no plugin business of its own', () => {
  // The requirement in one assertion: the adapter understands processes, not what any process is
  // for. If a name from somebody's business appears here, a branch for that business has appeared.
  const sources = [
    fs.readFileSync(path.join(__dirname, '..', '..', 'app/core/plugin-adapters/adapters/process.cjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', '..', 'app/core/plugin-adapters/process/supervisor.cjs'), 'utf8')
  ].join('\n')
  for (const word of ['ticket', 'relaunch', 'supervisor.mjs', 'dsh-restart', 'shutdown.exe', 'wallpaper', 'market']) {
    assert.equal(sources.includes(word), false, `the adapter must not know about "${word}"`)
  }
  // It does know the transport vocabulary, which is its own business.
  assert.match(sources, /stdio-jsonl/)
})

test('ids and permissions come from the declaration', () => {
  assert.equal(processPluginIdFor('restart-companion'), 'process.restart-companion')
  assert.equal(processPluginIdFor('@acme/model-server'), 'process.acme.model-server')
  assert.match(processPluginIdFor('@acme/thing'), /^[a-z0-9][a-z0-9._-]*$/)
  assert.equal(processPluginIdFor(''), null)

  const permissions = permissionsFor({ permissions: { declares: ['network', 'fs.write'] } })
  assert.deepEqual(permissions, ['fs.read', 'fs.write', 'network', 'process.spawn'])
})

test('a directory that is not a process plugin is declined rather than adapted', async () => {
  const area = scratch()
  const framework = createAdapterFramework({ log: () => {} })
  const adapter = createProcessPluginAdapter({ log: () => {} })
  framework.register(adapter)
  try {
    area.write('plain/package.json', JSON.stringify({ name: 'plain', version: '1.0.0' }), 'utf8')
    assert.equal(adapter.accepts({ dir: area.path('plain') }).ok, false)

    // A declaration with a shell string instead of an argv array is refused, not guessed at.
    area.write('shell/dshns-process.json', JSON.stringify({ api_version: PROCESS_API_VERSION, id: 'x', version: '1.0.0', command: 'node x.js' }), 'utf8')
    const refused = adapter.accepts({ dir: area.path('shell') })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /argv array/)
  } finally {
    area.dispose()
  }
})
