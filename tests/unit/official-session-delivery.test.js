'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { OfficialSessionClient } = require('../../app/extensions/mega/deepseek/official-session-client')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

function reply(res, requestBody, value) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    type: 'server-response',
    rpcId: requestBody.rpcId,
    result: { ok: true, value }
  }))
}

test('official session client uses the shipped DSH Remote HTTP envelope', async () => {
  const received = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      const body = JSON.parse(text)
      received.push({ path: req.url, cookie: req.headers.cookie, body })
      if (body.method === 'session/create') return reply(res, body, { sessionId: 'session-mega-1' })
      if (body.method === 'session/prompt') return reply(res, body, { accepted: true })
      if (body.method === 'session/list') {
        return reply(res, body, { items: [{ sessionId: 'session-mega-1', running: false, blank: false }] })
      }
      res.writeHead(404)
      res.end('not found')
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const client = new OfficialSessionClient({
      originProvider: () => origin,
      cookieProvider: async () => 'dsh-auth-test=secret'
    })

    const dispatched = await client.dispatchNewSession({ prompt: 'scheduled task', cwd: 'C:\\work' })
    assert.deepEqual(dispatched, { sessionId: 'session-mega-1', accepted: true })
    const sessions = await client.listSessions()
    assert.equal(sessions[0]?.sessionId, 'session-mega-1')

    assert.deepEqual(received.map((entry) => entry.path), [
      '/api/session/create',
      '/api/session/prompt',
      '/api/session/list'
    ])
    assert.ok(received.every((entry) => entry.cookie === 'dsh-auth-test=secret'))
    assert.ok(received.every((entry) => entry.body.type === 'client-request'))
    assert.equal(received[0].body.payload.args.request.cwd, 'C:\\work')
    assert.equal(received[1].body.payload.args.request.sessionId, 'session-mega-1')
    assert.equal(received[1].body.payload.args.request.mode, 'queue')
    assert.deepEqual(received[1].body.payload.args.request.content, [{ type: 'text', text: 'scheduled task' }])
    assert.deepEqual(received[2].body.payload.args, { _request: {} })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Mega scheduler defaults scheduled work to official sessions and keeps headless explicit', () => {
  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /OfficialSessionClient/)
  assert.match(scheduler, /requestedDeliveryMode = 'official-session'/)
  assert.match(scheduler, /deliveryMode === 'headless'/)
  assert.match(scheduler, /async launchOfficial\(t\)/)
  assert.match(scheduler, /DISPATCHING/)
  assert.match(scheduler, /officialSessionId/)
  assert.match(scheduler, /syncOfficialRuns/)
  assert.match(scheduler, /session did not appear in session\/list/)
})

test('the Mega dock exposes the delivery target instead of silently using headless', () => {
  const dock = read('app/extensions/mega/ui/dock.html')
  const dockJs = read('app/extensions/mega/ui/dock.js')
  assert.match(dock, /id="deliveryMode"/)
  assert.match(dock, /value="official-session"/)
  assert.match(dock, /value="headless"/)
  assert.match(dockJs, /deliveryMode: \$\('deliveryMode'\)\.value/)
  // The retired Full Mega Tools page must not come back as a second delivery UI.
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'index.html')), false)
})
