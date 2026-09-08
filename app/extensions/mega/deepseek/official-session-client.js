'use strict'
const http = require('node:http')
const https = require('node:https')
const { randomUUID } = require('node:crypto')

/**
 * Minimal authenticated client for the official dsh Web Remote API.
 *
 * It deliberately talks to the same Host that owns the official renderer,
 * instead of injecting code into that renderer. The wire format mirrors the
 * official Connection/Typert Remote transport:
 *   POST /api/<namespace>/<method>
 *   { type:'client-request', rpcId, method, payload:{ args } }
 */
class OfficialSessionClient {
  constructor({ originProvider, cookieProvider, timeoutMs = 15_000, log = () => {} } = {}) {
    if (typeof originProvider !== 'function') throw new Error('originProvider is required')
    if (typeof cookieProvider !== 'function') throw new Error('cookieProvider is required')
    this.originProvider = originProvider
    this.cookieProvider = cookieProvider
    this.timeoutMs = timeoutMs
    this.log = log
  }

  async call(endpoint, args) {
    const origin = this.originProvider()
    if (!origin) throw new Error('official Harness origin is unavailable')
    const base = new URL(origin)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error(`unsupported Harness protocol: ${base.protocol}`)
    }
    const cookie = await this.cookieProvider(base.origin)
    if (!cookie) throw new Error('official Harness authentication cookie is unavailable')

    const rpcId = `mega-${randomUUID()}`
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args }
    })
    const target = new URL(`/api/${endpoint}`, base.origin)
    const transport = target.protocol === 'https:' ? https : http

    const response = await new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          cookie
        },
        timeout: this.timeoutMs
      }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode || 0, text }))
      })
      request.once('timeout', () => request.destroy(new Error(`${endpoint} timed out after ${this.timeoutMs}ms`)))
      request.once('error', reject)
      request.end(body)
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${endpoint} transport failed: HTTP ${response.status}: ${response.text.slice(0, 500)}`)
    }

    let parsed
    try { parsed = JSON.parse(response.text) } catch {
      throw new Error(`${endpoint} returned invalid JSON`)
    }
    if (!parsed || parsed.type !== 'server-response' || parsed.rpcId !== rpcId || !parsed.result) {
      throw new Error(`${endpoint} returned an invalid RPC envelope`)
    }
    if (parsed.result.ok !== true) {
      const error = parsed.result.error || {}
      throw new Error(`${endpoint} failed: ${error.code || 'unknown'}: ${error.message || 'unknown error'}`)
    }
    return parsed.result.value
  }

  createSession({ cwd, workspaceId, agentPreset } = {}) {
    const request = {}
    if (cwd) request.cwd = String(cwd)
    if (workspaceId) request.workspaceId = String(workspaceId)
    if (agentPreset) request.agentPreset = String(agentPreset)
    return this.call('session/create', { request })
  }

  promptSession({ sessionId, prompt, mode = 'queue' }) {
    const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId: String(sessionId),
        mode: mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: String(prompt) }],
        ...(clientTimeZone ? { clientTimeZone } : {})
      }
    })
  }

  async dispatchNewSession({ prompt, cwd, agentPreset } = {}) {
    const created = await this.createSession({ cwd, agentPreset })
    if (!created?.sessionId) throw new Error('session/create returned no sessionId')
    await this.promptSession({ sessionId: created.sessionId, prompt, mode: 'queue' })
    this.log(`official session accepted Mega task: ${created.sessionId}`)
    return { sessionId: created.sessionId, accepted: true }
  }

  async listSessions() {
    const value = await this.call('session/list', { _request: {} })
    return Array.isArray(value?.items) ? value.items : []
  }

  cancelSession(sessionId) {
    return this.call('session/cancel', { request: { sessionId: String(sessionId) } })
  }
}

module.exports = { OfficialSessionClient }
