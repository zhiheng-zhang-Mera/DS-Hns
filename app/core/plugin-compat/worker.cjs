'use strict'

/**
 * The isolated activation process for a compatibility-mode plugin.
 *
 * A compat plugin is somebody else's code written for a different host, so it is given its own
 * process: `require`-ing it in the shell would let an import-time exception, a `process.exit` or
 * an infinite loop reach the application itself. The worker loads the entry, builds a small
 * Cordis-shaped context around it, calls it, and reports what happened on one line of stdout.
 *
 * The report is the whole protocol, and it is data:
 *
 *   `{ ok: true, api, provided, logs, disposers, ms }`   activated; the process stays alive
 *   `{ ok: false, code, reason, missing?, stack?, ms }`  did not
 *
 * Three of the failure codes are *actionable*, which is the point of separating them: a missing
 * package is answered by an install, a missing entry by a build, and an unsupported exports shape
 * by nothing at all. Nothing is installed or built here — the worker never writes anything.
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPORT_PREFIX = '@@DSHNS-COMPAT@@'

/** The payload is base64 in argv so no argument parsing can be confused by plugin names. */
function readPayload() {
  const raw = process.argv[2]
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function report(payload) {
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(payload)}\n`)
}

/**
 * The bare specifiers an import failure is about.
 *
 * Both spellings of the same failure are covered — `Cannot find module 'x'` from the CommonJS
 * resolver and `Cannot find package 'x' imported from …` from the ESM one — because a compat
 * plugin can be either. Relative specifiers are left out: those are the plugin's own missing
 * files, which an install cannot fix.
 */
function missingFrom(error) {
  const messages = [error && error.message, error && error.cause && error.cause.message]
    .filter(Boolean)
    .map(String)
  const names = new Set()
  for (const message of messages) {
    for (const pattern of [/Cannot find package '([^']+)'/g, /Cannot find module '([^']+)'/g, /Failed to resolve module specifier "([^"]+)"/g, /Cannot find dependency '([^']+)'/g]) {
      for (const match of message.matchAll(pattern)) {
        const name = match[1]
        if (!name || name.startsWith('.') || path.isAbsolute(name)) continue
        names.add(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
      }
    }
  }
  return [...names]
}

/**
 * A minimal Cordis-shaped context.
 *
 * Enough for `apply(ctx, config)` to run: logging, `provide`/`require`, `effect` for disposers,
 * and an event pair. It is deliberately not a Cordis implementation — a compat plugin gets the
 * shape it needs to activate and nothing more, and what it does with it is reported rather than
 * promised.
 */
function createShimContext(input) {
  const provided = []
  const logs = []
  const disposers = []
  const listeners = new Map()
  const log = (...args) => {
    if (logs.length < 200) logs.push(args.map((value) => (typeof value === 'string' ? value : safeJson(value))).join(' '))
  }
  const context = {
    id: input.id,
    name: input.name,
    config: input.config && typeof input.config === 'object' ? input.config : {},
    root: input.dir,
    baseDir: input.dir,
    log,
    provide(name, value) {
      provided.push({ name: String(name), kind: value === null ? 'null' : typeof value })
      return () => {}
    },
    require: () => null,
    has: () => false,
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : null
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on(type, handler) {
      const key = String(type)
      const list = listeners.get(key) || []
      list.push(handler)
      listeners.set(key, list)
      return () => {}
    },
    emit(type, payload) {
      for (const handler of listeners.get(String(type)) || []) {
        try {
          handler(payload)
        } catch (error) {
          log(`listener for ${type} threw: ${error && error.message ? error.message : error}`)
        }
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  context.logger = { info: log, warn: log, error: log, debug: log, success: log, name: input.id }
  return { context, snapshot: () => ({ provided, logs: logs.slice(-50), disposers: disposers.length }) }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function main() {
  const payload = readPayload()
  if (!payload || !payload.dir || !payload.entry) {
    report({ ok: false, code: 'COMPAT_BAD_PAYLOAD', reason: 'the activation payload could not be read' })
    return
  }
  const started = Date.now()
  const entry = path.resolve(payload.dir, payload.entry)

  let namespace = null
  try {
    namespace = await import(pathToFileURL(entry).href)
  } catch (error) {
    const missing = missingFrom(error)
    report({
      ok: false,
      code: missing.length ? 'COMPAT_MISSING_DEPENDENCIES' : 'COMPAT_IMPORT_FAILED',
      reason: missing.length
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed`
        : String((error && error.message) || error),
      missing,
      ms: Date.now() - started
    })
    return
  }

  const shim = createShimContext(payload)
  const candidates = [
    ['apply', namespace.apply],
    ['default.apply', namespace.default && namespace.default.apply],
    ['default', typeof namespace.default === 'function' ? namespace.default : null],
    ['load', namespace.load]
  ].filter(([, fn]) => typeof fn === 'function')
  if (!candidates.length) {
    report({
      ok: false,
      code: 'COMPAT_UNSUPPORTED_API',
      reason: 'the module exports neither apply(ctx) nor load(context)',
      exports: Object.keys(namespace).slice(0, 20),
      ms: Date.now() - started
    })
    return
  }

  // Which export to call: the one the API detection asked for, with the other as the fallback,
  // because an adopted plugin is exactly the case where the guess can be wrong.
  const preferred = payload.api === 'cordis' ? ['apply', 'default.apply', 'default', 'load'] : ['load', 'apply', 'default.apply', 'default']
  const chosen = preferred.map((name) => candidates.find(([candidate]) => candidate === name)).find(Boolean) || candidates[0]

  try {
    const outcome = chosen[1](shim.context, payload.config || {})
    if (outcome && typeof outcome.then === 'function') await outcome
  } catch (error) {
    report({
      ok: false,
      code: 'COMPAT_ACTIVATION_FAILED',
      reason: String((error && error.message) || error),
      stack: String((error && error.stack) || '').slice(0, 2000),
      ...shim.snapshot(),
      ms: Date.now() - started
    })
    return
  }

  report({ ok: true, api: chosen[0], ...shim.snapshot(), ms: Date.now() - started })
  // No explicit exit: a plugin that registered a server, a watcher or a timer needs this process
  // to keep existing, and one that registered nothing ends on its own — which the host reports as
  // "activated and exited" rather than as a crash or as "running".
}

main().catch((error) => {
  report({ ok: false, code: 'COMPAT_WORKER_FAILED', reason: String((error && error.message) || error) })
})
