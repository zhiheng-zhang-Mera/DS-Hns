'use strict'

/**
 * The Runtime <-> Desktop protocol.
 *
 * Wire shape, versioning and framing only. No sockets, no Electron, no state.
 *
 * The protocol exists because the UI must stop owning the Runtime. Once the two
 * are separate processes, every interaction between them is a message, and a
 * message that is not versioned is a message that will be misread by the other
 * side after an upgrade. So the version travels in the handshake and in every
 * frame, and the framer is newline-delimited JSON: one object per line, which is
 * trivial to log, trivial to test without sockets, and cannot be desynchronized
 * by a payload that happens to contain a newline (the encoder escapes it).
 *
 * Two ends, one vocabulary:
 *
 *   client -> host    hello, status, snapshot, subscribe, command, cancel, health, shutdown, ping
 *   host   -> client  welcome, status, snapshot, event, result, error, health, bye, pong
 */

const { PROTOCOL_VERSION } = require('./instance.cjs')

/** Frames a client may send. */
const CLIENT_METHODS = Object.freeze([
  'hello',
  'status',
  'snapshot',
  'subscribe',
  'command',
  'cancel',
  'health',
  'shutdown',
  'ping'
])

/** Frames a host may send. */
const HOST_METHODS = Object.freeze([
  'welcome',
  'status',
  'snapshot',
  'event',
  'result',
  'error',
  'health',
  'bye',
  'pong'
])

/** Commands the host understands. Anything else is answered with an error frame. */
const COMMANDS = Object.freeze([
  /** Start the managed Harness if it is not already running. Idempotent. */
  'harness.start',
  /** Stop the managed Harness, leaving the Runtime Host itself alive. */
  'harness.stop',
  /**
   * The Harness' authenticated access URL.
   *
   * A page URL carries the launch token, which is why it is a *command* rather
   * than something broadcast in every status answer: it is handed only to a
   * client that asks, over the same-user IPC channel the Runtime already trusts.
   * A status frame, a log line and a snapshot always carry it redacted.
   */
  'harness.url',
  /** Start the Sub-worker executor (inert until a task arrives). */
  'worker.start',
  'worker.stop',
  /** Read the Sub-worker manager's own description. */
  'worker.describe',
  /** Ask the Engineering host for its status; creates it on first use. */
  'engineering.status',
  /** Ask the Plugin host for its status; creates it on first use. */
  'plugins.status',
  /** The Computer Use core's own health, including whether the page capability is present. */
  'computerUse.status',
  /** Declare the Electron-side page capability present/absent (the Computer Use boundary). */
  'computerUse.capability',
  /** Recompute and return the host capability profile. */
  'host.capability',
  /** Graceful Runtime shutdown: drain, checkpoint, terminate owned children. */
  'runtime.shutdown'
])

/**
 * Encode one frame.
 *
 * The trailing newline is the frame delimiter, and JSON.stringify escapes any
 * newline inside a string, so a frame can never be split by its own payload.
 */
function encode(frame) {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Decode a stream chunk into whole frames.
 *
 * Partial frames are the normal case on a socket, so the buffer is a parameter
 * rather than module state: the caller keeps the remainder and hands it back.
 * A malformed line yields an `error` frame but does not desynchronize the stream,
 * because the delimiter was already found.
 *
 * @returns {{frames: object[], rest: string}}
 */
function decode(chunk, rest = '') {
  const text = `${rest}${chunk}`
  const lines = text.split('\n')
  const remainder = lines.pop() ?? ''
  const frames = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      frames.push(value && typeof value === 'object' ? value : { method: 'error', params: { message: 'frame was not an object' } })
    } catch {
      frames.push({ method: 'error', params: { message: 'frame was not valid JSON', raw: trimmed.slice(0, 200) } })
    }
  }
  return { frames, remainder }
}

/** A request frame. `id` is the client's correlation id; replies carry it back. */
function request(method, params = {}, id = nextId()) {
  return { v: PROTOCOL_VERSION, id, method, params }
}

/** A reply that names the request it answers. */
function reply(method, id, params = {}) {
  return { v: PROTOCOL_VERSION, id, method, params }
}

/** A host-initiated event, addressed to every subscriber of a topic. */
function event(topic, payload = {}) {
  return { v: PROTOCOL_VERSION, method: 'event', params: { topic, payload } }
}

function failure(id, message, code = 'runtime-error', detail = null) {
  return { v: PROTOCOL_VERSION, id, method: 'error', params: { code, message: String(message), detail } }
}

let counter = 0
/** Monotonic per-process correlation ids; uniqueness within a connection is enough. */
function nextId() {
  counter += 1
  return `${process.pid}-${counter}`
}

/**
 * Is a frame acceptable to this end?
 *
 * The version check is deliberately strict-but-forgiving: a frame with no `v` is
 * accepted (an older peer), a frame with a *different* `v` is rejected by name.
 * That is the difference between "we cannot parse this" and "you are the wrong
 * build", which is the first question a support log has to answer.
 */
function accept(frame, methods) {
  if (!frame || typeof frame !== 'object') return { ok: false, reason: 'not an object' }
  const version = frame.v === undefined ? PROTOCOL_VERSION : String(frame.v)
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, reason: `protocol mismatch: host speaks ${PROTOCOL_VERSION}, frame says ${version}` }
  }
  const method = String(frame.method || '')
  if (!methods.includes(method)) return { ok: false, reason: `unsupported method: ${method || '(missing)'}` }
  return { ok: true, method, id: frame.id, params: frame.params && typeof frame.params === 'object' ? frame.params : {} }
}

module.exports = {
  PROTOCOL_VERSION,
  CLIENT_METHODS,
  HOST_METHODS,
  COMMANDS,
  encode,
  decode,
  request,
  reply,
  event,
  failure,
  accept,
  nextId
}
