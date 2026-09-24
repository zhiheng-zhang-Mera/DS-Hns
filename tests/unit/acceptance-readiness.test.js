'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

test('Electron acceptance waits for both attached renderer documents before reading styles', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  assert.match(source, /async function waitForDocumentReady/)
  assert.match(source, /document\.documentElement && document\.body/)
  assert.match(source, /await waitForDocumentReady\(dock\.page/)
  assert.match(source, /await waitForDocumentReady\(official\.page/)
})
