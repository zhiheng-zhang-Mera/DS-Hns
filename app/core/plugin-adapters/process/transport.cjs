'use strict'

/**
 * DS-Hns Core: how the host and a managed process talk.
 *
 * A transport moves *frames* — decoded JSON objects — in both directions and does nothing else. It
 * does not interpret them, does not know what a capability is and does not decide anything. That
 * narrowness is what lets the supervisor above it stay business-free.
 *
 * Two transports are implemented, and they are the whole vocabulary:
 *
 *   * **`stdio-jsonl`** — the child's own stdin and stdout. Needs nothing from the plugin beyond
 *     the ability to read a line and write a line, which is why it is the default: a Node script,
 *     a Python script and a compiled binary can all speak it.
 *   * **`localhost-jsonl`** — a loopback TCP socket, for a plugin that owns its standard streams
 *     for its own reasons (a Python server whose stdout is a log firehose, a binary that writes
 *     non-text to stdout).
 *
 * ## The two rules that make this a *controlled* protocol
 *
 * **Frames are text.** Both transports are newline-delimited JSON, so there is no way to put an
 * object, a handle, a function or a socket into one. "Do not hand the plugin an HNS object" is not
 * a rule anybody has to remember here; there is no encoding that could carry one.
 *
 * **A line that is not a frame is not silently nothing.** On `stdio-jsonl`, stdout is the protocol
 * and *only* the protocol: an unparseable line on stdout is a malformed frame, counted and
 * reported. stderr is the log channel and is never parsed as protocol, so a plugin that prints a
 * stack trace cannot accidentally be understood as a message. That split is deliberately the
 * opposite of the usual "prefix the magic ones" convention, because a plugin that forgets the
 * prefix should get a complaint rather than a race.
 */

const net = require('node:net')
const crypto = require('node:crypto')

const { PROCESS_TRANSPORTS, PROCESS_FAULT_CODES, processFault, encodeFrame, decodeFrame } = require('./contract.cjs')

/** Split a growing buffer into complete lines, keeping the tail. */
function createLineSplitter() {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const lines = []
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
      // A stream that never sends a newline must not grow without bound: the tail is capped at the
      // frame limit, and anything past it can only be a malformed frame anyway.
      return lines
    },
    get pending() {
      return buffer
    },
    reset() {
      buffer = ''
    }
  }
}

/** A default sink, so every optional callback has one shape. */
function noop() {}

/** The shared behaviour both transports implement, so the supervisor above sees one shape. */
function createFrameChannel(options = {}) {
  const handlers = { frame: [], fault: [] }
  const stats = { in: 0, out: 0, malformed: 0, unknown: 0, tooLarge: 0, dropped: 0 }

  function onFrame(handler) {
    handlers.frame.push(handler)
    return () => {
      const index = handlers.frame.indexOf(handler)
      if (index >= 0) handlers.frame.splice(index, 1)
    }
  }

  function onFault(handler) {
    handlers.fault.push(handler)
    return () => {
      const index = handlers.fault.indexOf(handler)
      if (index >= 0) handlers.fault.splice(index, 1)
    }
  }

  /** Deliver one decoded frame to every consumer. A consumer that throws is not the channel's problem. */
  function emitFrame(frame) {
    for (const handler of [...handlers.frame]) {
      try {
        handler(frame)
      } catch {
        /* a consumer that throws must not stop the channel */
      }
    }
  }

  function emitFault(fault) {
    if (fault.code === PROCESS_FAULT_CODES.MALFORMED_FRAME) stats.malformed += 1
    else if (fault.code === PROCESS_FAULT_CODES.UNKNOWN_FRAME) stats.unknown += 1
    else if (fault.code === PROCESS_FAULT_CODES.FRAME_TOO_LARGE) stats.tooLarge += 1
    for (const handler of [...handlers.fault]) {
      try {
        handler(fault)
      } catch {
        /* same */
      }
    }
  }

  /**
   * Decode one line and route it to exactly one of the two channels.
   *
   * Either it is a frame the vocabulary defines, or it is a coded fault. There is no third outcome
   * and no quiet drop: a plugin that sent something the host did not understand must be told, or it
   * will believe it was understood.
   */
  function ingest(line) {
    const decoded = decodeFrame(line, options.maxFrameBytes)
    if (decoded.ok !== true) {
      if (decoded.code === PROCESS_FAULT_CODES.MALFORMED_FRAME && !String(line).trim()) stats.dropped += 1
      emitFault(decoded)
      return
    }
    stats.in += 1
    emitFrame(decoded.frame)
  }

  function close() {
    handlers.frame.length = 0
    handlers.fault.length = 0
  }

  return { stats, onFrame, onFault, emitFrame, emitFault, ingest, close }
}

/**
 * Frames over the child's stdin and stdout.
 *
 * stdout is protocol, stderr is log. Neither is ever the other.
 */
function createStdioTransport(options = {}) {
  const maxFrameBytes = options.maxFrameBytes
  const log = typeof options.log === 'function' ? options.log : noop
  const channel = createFrameChannel({ maxFrameBytes })
  const splitter = createLineSplitter()
  let child = null
  let closed = false

  function attach(handle) {
    child = handle
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) channel.ingest(line)
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) emitLog(line)
        }
      })
    }
  }

  /** stderr is log-only; it is routed as a log frame so one consumer handles both sources. */
  function emitLog(line) {
    channel.emitFrame({ kind: 'log', stream: 'stderr', line })
  }

  return {
    kind: PROCESS_TRANSPORTS.STDIO.id,
    channel,
    onFrame: channel.onFrame,
    onFault: channel.onFault,
    /** Nothing to prepare: the channel is the child's own standard streams. */
    async prepare() {
      return {}
    },
    attach,
    send(frame) {
      if (closed) return processFault(PROCESS_FAULT_CODES.DISPOSED, 'the transport is closed')
      if (!child || !child.stdin || child.stdin.destroyed) {
        return processFault(PROCESS_FAULT_CODES.NOT_RUNNING, 'the process is not accepting frames')
      }
      const encoded = encodeFrame(frame, maxFrameBytes)
      if (encoded.ok !== true) return encoded
      try {
        child.stdin.write(encoded.line)
        channel.stats.out += 1
        return { ok: true, bytes: encoded.bytes }
      } catch (error) {
        return processFault(PROCESS_FAULT_CODES.NOT_RUNNING, `the frame could not be written: ${error && error.message ? error.message : error}`)
      }
    },
    close() {
      closed = true
      splitter.reset()
      channel.close()
      try {
        if (child && child.stdin && !child.stdin.destroyed) child.stdin.end()
      } catch {
        /* the process is already gone */
      }
    },
    describe() {
      return { kind: PROCESS_TRANSPORTS.STDIO.id, protocol: 'jsonl', channel: 'child stdio', stats: { ...channel.stats } }
    }
  }
}

/**
 * Frames over a loopback TCP socket.
 *
 * The child is told the port and a per-start token in its environment. It must present the token in
 * its first frame; the host drops the connection otherwise. That is what stops a *different* local
 * process from connecting to the port and being treated as the plugin — the port is discoverable,
 * the token is not.
 *
 * The listener is bound to `127.0.0.1` and a non-loopback peer is refused, so the socket is not
 * reachable from the network even if the machine's firewall would have allowed it.
 */
function createLocalhostTransport(options = {}) {
  const maxFrameBytes = options.maxFrameBytes
  const log = typeof options.log === 'function' ? options.log : noop
  const channel = createFrameChannel({ maxFrameBytes })
  const token = options.token || crypto.randomBytes(24).toString('hex')
  const state = { server: null, socket: null, port: null, handshaken: false, closed: false }

  function accept(socket) {
    const remote = socket.remoteAddress || ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback) {
      // Not reachable in practice — the listener is bound to loopback — but a refusal here is what
      // makes "the peer is local" a checked fact rather than an assumption about the bind address.
      log({ kind: 'process-transport-peer-refused', remote })
      socket.destroy()
      return
    }
    if (state.socket) {
      log({ kind: 'process-transport-second-connection' })
      socket.destroy()
      return
    }
    state.socket = socket
    const splitter = createLineSplitter()
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        if (!state.handshaken) {
          // The first line must be the token, alone. It is not a frame, so it is not decoded.
          if (String(line).trim() !== token) {
            channel.emitFault(processFault(PROCESS_FAULT_CODES.BAD_TOKEN, 'the first line on the socket was not this start\'s token'))
            socket.destroy()
            state.socket = null
            return
          }
          state.handshaken = true
          continue
        }
        channel.ingest(line)
      }
    })
    socket.on('error', (error) => {
      log({ kind: 'process-transport-socket-error', reason: String(error && error.message ? error.message : error) })
    })
    socket.on('close', () => {
      if (state.socket === socket) state.socket = null
    })
  }

  return {
    kind: PROCESS_TRANSPORTS.LOCALHOST.id,
    token,
    channel,
    onFrame: channel.onFrame,
    onFault: channel.onFault,
    /** Bind the listener and hand the child the port and the token through its environment. */
    async prepare() {
      state.server = net.createServer(accept)
      await new Promise((resolve, reject) => {
        state.server.once('error', reject)
        state.server.listen(0, '127.0.0.1', () => {
          state.port = state.server.address().port
          resolve()
        })
      })
      return { DSHNS_PROCESS_PORT: String(state.port), DSHNS_PROCESS_TOKEN: token }
    },
    attach() {
      // Nothing to attach: the child connects to us.
    },
    send(frame) {
      if (state.closed) return processFault(PROCESS_FAULT_CODES.DISPOSED, 'the transport is closed')
      if (!state.socket || !state.handshaken) {
        return processFault(PROCESS_FAULT_CODES.NOT_RUNNING, 'the plugin has not connected to the socket yet')
      }
      const encoded = encodeFrame(frame, maxFrameBytes)
      if (encoded.ok !== true) return encoded
      try {
        state.socket.write(encoded.line)
        channel.stats.out += 1
        return { ok: true, bytes: encoded.bytes }
      } catch (error) {
        return processFault(PROCESS_FAULT_CODES.NOT_RUNNING, `the frame could not be written: ${error && error.message ? error.message : error}`)
      }
    },
    close() {
      state.closed = true
      channel.close()
      try {
        if (state.socket) state.socket.destroy()
      } catch {
        /* already gone */
      }
      try {
        if (state.server) state.server.close()
      } catch {
        /* already closed */
      }
      state.socket = null
      state.server = null
    },
    describe() {
      return {
        kind: PROCESS_TRANSPORTS.LOCALHOST.id,
        protocol: 'jsonl',
        channel: `127.0.0.1:${state.port}`,
        handshaken: state.handshaken,
        stats: { ...channel.stats }
      }
    },
    get port() {
      return state.port
    }
  }
}

/**
 * Build the transport a manifest asked for.
 *
 * An unknown kind is refused here as well as at validation, because a manifest can also arrive from
 * a caller that skipped validation and one check is not a guarantee.
 */
function createTransport(manifest, options = {}) {
  const kind = manifest && manifest.transport ? manifest.transport.kind : PROCESS_TRANSPORTS.STDIO.id
  const shared = { maxFrameBytes: manifest.limits.maxFrameBytes, log: options.log }
  if (kind === PROCESS_TRANSPORTS.STDIO.id) return { ok: true, transport: createStdioTransport(shared) }
  if (kind === PROCESS_TRANSPORTS.LOCALHOST.id) return { ok: true, transport: createLocalhostTransport(shared) }
  return processFault(PROCESS_FAULT_CODES.UNSUPPORTED_TRANSPORT, `"${kind}" is not a transport this host implements`, {
    available: Object.keys(PROCESS_TRANSPORTS).map((key) => PROCESS_TRANSPORTS[key].id)
  })
}

module.exports = {
  createTransport,
  createStdioTransport,
  createLocalhostTransport,
  createLineSplitter,
  createFrameChannel
}
