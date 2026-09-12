'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Encoding integrity.
 *
 * This repository is UTF-8 and its comments and UI strings are partly Chinese. A
 * tool round-trip through a non-UTF-8 codepage silently turns those characters
 * into U+FFFD ("�") while leaving the file syntactically valid, so the damage
 * only shows up as a syntax error for the unlucky file that ends up with a broken
 * string literal. This guard makes the corruption visible immediately, in every
 * source and script file.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'temp', 'cache', 'data', 'logs', 'workspace', 'runtime', 'dist'])
const CHECKED = /\.(js|cjs|mjs|ps1|md|json|html|css)$/
// Built from a code point on purpose: spelling the character itself here would
// make this file its own first accusation. The file is also skipped in the walk
// for the same reason - this comment explains the guard, it should not trip it.
const REPLACEMENT = new RegExp(String.fromCharCode(0xfffd), 'g')
const SELF = __filename

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const target = path.join(dir, entry.name)
    if (target === SELF) continue
    if (entry.isDirectory()) walk(target, found)
    else if (CHECKED.test(entry.name)) found.push(target)
  }
  return found
}

test('no source file contains a UTF-8 replacement character', () => {
  const files = walk(ROOT)
  assert.ok(files.length > 100, `expected to scan the repository, only found ${files.length} files`)
  const damaged = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const matches = text.match(REPLACEMENT)
    if (matches) damaged.push(`${path.relative(ROOT, file)} (${matches.length})`)
  }
  assert.deepEqual(damaged, [], `a lossy encode/decode round-trip damaged these files: ${damaged.join(', ')}`)
})
