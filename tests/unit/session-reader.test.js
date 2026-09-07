'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseSessionFile } = require('../../app/extensions/mega/tracker/session-reader')
const OUT = path.join(process.env.TEMP || os.tmpdir(), 'dsh-sess-test-' + process.pid)
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
const makeFile = (name, lines) => { const file = path.join(OUT, name); fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n'); return file }

test('successful session is COMPLETED', () => {
  const t0 = Date.UTC(2026, 8, 7, 1)
  const file = makeFile('ok.jsonl', [
    { type:'session', id:'sess-ok', createdAt:t0, cwd:'D:\\work' },
    { type:'user/message', seq:1, time:t0+10, data:{ source:{kind:'user'} } },
    { type:'request/header', seq:2, time:t0+20, data:{ header:{ config:{ provider:'deepseek-official', model:'deepseek-v4-flash' } } } },
    { type:'assistant/message', seq:3, time:t0+100, data:{ message:{content:[{type:'text',text:'ok'}]}, usage:{inputTokens:10,outputTokens:5} } },
    { type:'turn/end', seq:4, time:t0+200, data:{ reason:{kind:'success'} } }
  ])
  const s = parseSessionFile(file)
  assert.equal(s.status, 'COMPLETED')
  assert.equal(s.model, 'deepseek-v4-flash')
  assert.equal(s.assistantText, 'ok')
})
