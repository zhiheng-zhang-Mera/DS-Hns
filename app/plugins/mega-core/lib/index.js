/**
 * dsh-plugin-mega-core — host half (`updateplan/pluginize.md` Phase 1).
 *
 * A Cordis plugin, loaded as an out-of-tree bundle row (see `cordis.patch.yml`), that gives the official
 * DeepSeek Harness UI the one thing it cannot see by itself: **whether DS-Hns' governance layer is alive** —
 * plugin registry, protection state, pending human dependency, versions, capabilities, and the actions that
 * are allowed when something is not healthy.
 *
 * It does not hold that state. DS-Hns does, behind its own loopback bridge (`app/core/governance-bridge.cjs`,
 * discovered through `$DSH_HOME/state/governance-bridge.json`), and this host half is a same-origin mirror of
 * it for the browser half:
 *
 *   GET  /mega-core/health      → whether DS-Hns' governance bridge is reachable (no secret needed)
 *   GET  /mega-core/governance  → the snapshot the Control Center shows
 *   GET  /mega-core/view        → the same snapshot, composed into what the orb and the page draw
 *   POST /mega-core/action      → one of the named actions (check, retry, reset-fallback, repair, disable, enable)
 *   GET  /mega-core/orb         → where the orb was left; POST stores where a drag ended
 *
 * Three rules the shape of this file is built around:
 *
 *   1. **The truth stays in DS-Hns.** Every answer is fetched from the bridge with its per-run token; a plugin
 *      that cached governance would keep showing a healthy module after the layer had degraded. When the bridge
 *      is not reachable the answer says so — `available: false` with the reason — instead of guessing.
 *   2. **`webServer` is a hard dependency, declared through `inject`.** Fetching it with `ctx.get()` at mount
 *      time is racy: rows mount concurrently and the HTTP server may not exist yet, so the routes would be
 *      skipped silently and the SPA fallback would answer every request (the community wallpaper engine hit
 *      exactly this and documents it in its host half).
 *   3. **Every route unwinds on unload.** Each `register()` returns a disposer and they are all returned from
 *      `apply`, so a reload never leaves a half-registered surface behind.
 */

import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildMegaView } from './view.js'

/** The routes this plugin owns. */
const BASE = '/mega-core'

/** This package's own version, read from the manifest rather than typed twice. */
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PLUGIN_VERSION = PACKAGE.version || null

/** `$DSH_HOME/state` — where DS-Hns writes its discovery file and where this plugin keeps its own. */
function stateDir(env = process.env) {
  const home = env.DSH_HOME || path.join(env.HOME || env.USERPROFILE || process.cwd(), '.dsh')
  return path.join(home, 'state')
}

/** The discovery file DS-Hns writes (`$DSH_HOME/state/governance-bridge.json`). */
function discoveryFile(env = process.env) {
  return path.join(stateDir(env), 'governance-bridge.json')
}

/**
 * Where DS-Hns' governance bridge is listening right now, or why that cannot be answered.
 *
 * Read per request rather than once at mount: DS-Hns may start its bridge after this plugin (the product
 * defers the bridge to the end of its own start), and a plugin that had latched "unavailable" would stay
 * unavailable for the life of the process.
 */
export function readDiscovery(env = process.env) {
  const file = discoveryFile(env)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.port || !parsed.token) {
      return { available: false, reason: `${file} does not describe a bridge`, file }
    }
    if (parsed.host && parsed.host !== '127.0.0.1' && parsed.host !== '::1') {
      // A bridge that claims to listen elsewhere is not one this plugin will talk to.
      return { available: false, reason: `the bridge claims host ${parsed.host}, which is not loopback`, file }
    }
    return { available: true, host: parsed.host || '127.0.0.1', port: Number(parsed.port), token: String(parsed.token), pid: parsed.pid || null, schema: Number(parsed.version) || null, file }
  } catch (error) {
    return { available: false, reason: error?.code === 'ENOENT' ? 'DS-Hns is not running (no governance bridge file)' : String(error?.message || error), file }
  }
}

/** One authenticated call to the bridge. Always answers; never throws at a route handler. */
async function callBridge(route, { method = 'GET', body = null, discovery = readDiscovery(), fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  if (!discovery.available) return { ok: false, available: false, reason: discovery.reason }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://${discovery.host}:${discovery.port}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!parsed) return { ok: false, available: false, reason: `the governance bridge answered ${response.status} without JSON` }
    return { ...parsed, available: true, status: response.status }
  } catch (error) {
    return { ok: false, available: false, reason: `the governance bridge could not be reached: ${error?.message || error}` }
  } finally {
    clearTimeout(timer)
  }
}

/** The JSON answer helper, so every route has the same shape and the same headers. */
function answer(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/**
 * The orb's own position, kept where a position can survive the thing that resets the page.
 *
 * `localStorage` looks like the obvious home for this and is the wrong one: the official UI is served from a
 * `--port 0` loopback URL, so its origin — and with it every `localStorage` entry — changes on every restart
 * of DS-Hns Desktop (the community wallpaper engine documents the same trap). A file under `$DSH_HOME/state`
 * is origin-independent, which is exactly the property "the orb comes back where I put it" needs.
 *
 * The store is deliberately tiny and forgiving: an unreadable file is "no position yet" (the orb falls back
 * to its default corner), and a position that is not two finite numbers is refused rather than stored.
 */
const ORB_FILE_VERSION = 1

function orbFile(env = process.env) {
  return path.join(stateDir(env), 'mega-core-orb.json')
}

/** One stored position, normalised — or null when there is nothing usable in it. */
export function normalizeOrbPosition(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  // An edge is `left`/`right` (the orb follows that edge when the window is resized) or absent (free).
  const edge = raw.edge === 'left' || raw.edge === 'right' ? raw.edge : null
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), edge }
}

/** Read the stored position; never throws, because "no position" is a valid answer. */
export function readOrbPosition(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(orbFile(env), 'utf8'))
    return normalizeOrbPosition(parsed?.position)
  } catch {
    return null
  }
}

/** Store one position. Answers from `normalizeOrbPosition`, so a caller cannot write something unusable. */
export function writeOrbPosition(position, env = process.env) {
  const normalized = normalizeOrbPosition(position)
  if (!normalized) return { ok: false, reason: 'the orb position needs a finite x and y' }
  try {
    const file = orbFile(env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: ORB_FILE_VERSION, position: normalized }, null, 2)}\n`, 'utf8')
    return { ok: true, position: normalized, file }
  } catch (error) {
    return { ok: false, reason: `the orb position could not be written: ${error?.message || error}` }
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`the request body is not JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx the Cordis context; `ctx.webServer` must be present (see `inject`).
 * @returns {Function} the disposer that unwinds every route.
 */
export function apply(ctx, { fetchImpl = fetch, env = process.env } = {}) {
  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    // Defensive: `inject` guarantees it, but a plugin must never assume a service exists.
    return () => {}
  }
  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/health`,
    handler: async (_req, res) => {
      const discovery = readDiscovery(env)
      answer(res, 200, {
        ok: true,
        service: 'dsh-plugin-mega-core',
        plugin: { id: name, version: PLUGIN_VERSION },
        governance: discovery.available
          ? { available: true, host: discovery.host, port: discovery.port, pid: discovery.pid, schema: discovery.schema }
          : { available: false, reason: discovery.reason }
      })
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/governance`,
    handler: async (_req, res) => {
      const result = await callBridge('/governance', { discovery: readDiscovery(env), fetchImpl })
      answer(res, result.ok === false && result.available === false ? 503 : 200, result)
    }
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/action`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return answer(res, 405, { ok: false, reason: 'governance actions are POSTed' })
      let body = null
      try {
        body = await readBody(req)
      } catch (error) {
        return answer(res, 400, { ok: false, reason: String(error?.message || error) })
      }
      const result = await callBridge('/action', { method: 'POST', body: { action: body.action, id: body.id }, discovery: readDiscovery(env), fetchImpl })
      // The bridge's own status decides: 409 for a refused action, 503 for an unreachable bridge, 200 otherwise.
      const status = result.available === false ? 503 : (result.status || (result.ok === false ? 409 : 200))
      answer(res, status, result)
    }
  }))

  /**
   * Everything the two surfaces draw, in one answer.
   *
   * It is a *composed* route rather than something the browser half assembles from `/health` and
   * `/governance`, because composing is where the rules live: which tone a state has, what §4.4 calls each
   * field, and what "unavailable" means. Keeping those in `view.js` means they are covered by Node tests
   * instead of by looking at an orb, and it means the orb and the settings page cannot disagree.
   *
   * `200` even when DS-Hns is not running: the client is asking "what should I draw", and "a grey orb that
   * says why" is a complete answer to that question. Only a genuinely unexpected failure is a 500.
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/view`,
    handler: async (_req, res) => {
      const discovery = readDiscovery(env)
      const governance = discovery.available ? await callBridge('/governance', { discovery, fetchImpl }) : null
      const view = buildMegaView({
        plugin: { id: name, version: PLUGIN_VERSION },
        bridge: discovery.available
          ? { available: true, host: discovery.host, port: discovery.port, pid: discovery.pid, schema: discovery.schema }
          : { available: false, reason: discovery.reason },
        // "Not reachable" and "reachable but refusing" are both "no snapshot" to the view; the reason differs.
        governance: governance && governance.ok !== false ? governance : null
      })
      answer(res, 200, view)
    }
  }))

  /**
   * Where the orb is.
   *
   * GET is what the orb asks on first paint; POST is where a drag ends. Both answer the *stored* position
   * (`null` when nothing has been stored yet, which the client reads as "use your default corner"), so the
   * client never has to keep a second copy of the rule.
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/orb`,
    handler: async (req, res) => {
      if (req.method === 'GET') return answer(res, 200, { ok: true, position: readOrbPosition(env) })
      if (req.method !== 'POST') return answer(res, 405, { ok: false, reason: 'the orb position is read with GET and written with POST' })
      let body = null
      try {
        body = await readBody(req)
      } catch (error) {
        return answer(res, 400, { ok: false, reason: String(error?.message || error) })
      }
      const stored = writeOrbPosition(body?.position, env)
      answer(res, stored.ok === false ? 400 : 200, stored)
    }
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {}
    }
  }
}

export const name = 'dsh-plugin-mega-core'

/**
 * Hard dependency on the webserver: see the note at the top of this file. It also means the loader waits for
 * the HTTP server before running this plugin, so the routes are registered on a server that exists.
 */
export const inject = ['webServer']
