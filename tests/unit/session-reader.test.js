'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseSessionFile } = require('../../app/monitor/tracker/session-reader')

// Fixtures are regenerated per run — keep them out of the repo (cache\temp
// when launched through test-all.ps1, which sets TEMP under the project root).
const OUT = path.join(process.env.TEMP || os.tmpdir(), 'dsh-sess-test-' + process.pid)
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

function makeFile(name, lines) {
  const file = path.join(OUT, name)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}

test('successful session is COMPLETED with real usage', () => {
  const t0 = Date.UTC(2026, 8, 7, 1, 0, 0)
  const file = makeFile('session-ok.jsonl', [
    { type: 'session', version: 0, id: 'sess-ok', createdAt: t0, cwd: 'D:\\work', delegationDepth: 0 },
    { type: 'permission/preset', seq: 0, time: t0, data: {} },
    { type: 'user/message', seq: 1, time: t0 + 10, data: { content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'request/header', seq: 2, time: t0 + 20, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'turn/start', seq: 3, time: t0 + 30, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 4,
      time: t0 + 5000,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'smoke answer' }] },
        stream: [],
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 80 }
      }
    },
    { type: 'turn/end', seq: 5, time: t0 + 6000, data: { turn: 1, reason: { kind: 'success' } } }
  ])
  const s = parseSessionFile(file)
  assert.equal(s.ok, true)
  assert.equal(s.id, 'sess-ok')
  assert.equal(s.status, 'COMPLETED')
  assert.equal(s.assistantText, 'smoke answer')
  assert.equal(s.model, 'deepseek-v4-flash')
  assert.equal(s.usageEvents.length, 1)
  assert.deepEqual(s.usageEvents[0], {
    time: t0 + 5000,
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  })
})

test('failed session surfaces the failure code', () => {
  const t0 = Date.UTC(2026, 8, 7, 1, 0, 0)
  const file = makeFile('session-fail.jsonl', [
    { type: 'session', version: 0, id: 'sess-fail', createdAt: t0, cwd: 'D:\\work', delegationDepth: 0 },
    { type: 'user/message', seq: 1, time: t0 + 1, data: { source: { kind: 'user' } } },
    {
      type: 'assistant/chunk',
      seq: 2,
      time: t0 + 100,
      data: {
        chunk: {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'bad key', code: 'MISSING_CREDENTIAL' } }
        }
      }
    },
    {
      type: 'turn/end',
      seq: 3,
      time: t0 + 200,
      data: { reason: { kind: 'error', error: { message: 'bad key', code: 'MISSING_CREDENTIAL' } } }
    }
  ])
  const s = parseSessionFile(file)
  assert.equal(s.status, 'FAILED')
  assert.equal(s.error.code, 'MISSING_CREDENTIAL')
  assert.equal(s.usageEvents.length, 0)
})

test('open running session stays RUNNING', () => {
  const t0 = Date.now() - 30_000
  const file = makeFile('session-running.jsonl', [
    { type: 'session', version: 0, id: 'sess-run', createdAt: t0, cwd: 'D:\\work', delegationDepth: 0 },
    { type: 'user/message', seq: 1, time: t0 + 1, data: { source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: t0 + 2, data: { turn: 1 } }
  ])
  const s = parseSessionFile(file)
  assert.equal(s.status, 'RUNNING')
})
