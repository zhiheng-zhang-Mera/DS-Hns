'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { parseYaml, parseScalar, readResourceFile, stripComment, splitFlow } = require('../../app/sub-worker/yaml.cjs')

/**
 * Dependency-free YAML subset reader and `readResourceFile` (plan §27, §45).
 *
 * The project ships no runtime dependency, so this reader has to cover exactly
 * the documented `hns-resource.yaml` shapes — and it must reject everything else
 * loudly (through `errors`) instead of guessing a value.
 */

const CREATED_ROOTS = []

test.after(() => {
  for (const root of CREATED_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-multi-yaml-${name}-`))
  CREATED_ROOTS.push(root)
  return root
}

/** Write a scratch file and return its path. */
function scratchFile(name, fileName, text) {
  const root = scratch(name)
  const file = path.join(root, fileName)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

/** Parse, proving first that an input can never throw. */
function parse(text) {
  assert.doesNotThrow(() => parseYaml(text), 'parseYaml must report instead of throwing')
  return parseYaml(text)
}

/** The exact document plan §27 tells the installer to generate. */
const DOCUMENTED_27 = [
  '# hns-resource.yaml — generated defaults',
  'workers:',
  '  min: 1',
  '  soft_max: auto',
  '  hard_max: auto',
  '',
  'resources:',
  '  reserve_ram_percent: 20',
  '  reserve_cpu_percent: 20',
  '',
  'thermal:',
  '  enabled: true',
  '',
  'adaptive_scaling:',
  '  enabled: true',
  '',
  'speculative_execution:',
  '  enabled: true',
  ''
].join('\n')

/** The flat default layout of plan §45. */
const DOCUMENTED_45 = [
  'worker:',
  '  min: 1',
  '  soft_max: auto',
  '  hard_max: auto',
  '',
  'resource:',
  '  cpu_reserve_percent: 20',
  '  ram_reserve_percent: 20',
  '  gpu_reserve_percent: 20',
  '',
  'scaling:',
  '  scale_up_step: 1',
  '  scale_down_step: 1',
  '  scale_up_delay_seconds: 30',
  '  scale_down_delay_seconds: 60',
  '',
  'runtime:',
  '  heartbeat_seconds: 5',
  '  worker_timeout_seconds: 1800',
  '',
  'safety:',
  '  enable_safe_mode: true',
  '  keep_supervisor_alive: true',
  ''
].join('\n')

test('the documented §27 hns-resource.yaml parses into the expected nested object', () => {
  const result = parse(DOCUMENTED_27)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.value, {
    workers: { min: 1, soft_max: 'auto', hard_max: 'auto' },
    resources: { reserve_ram_percent: 20, reserve_cpu_percent: 20 },
    thermal: { enabled: true },
    adaptive_scaling: { enabled: true },
    speculative_execution: { enabled: true }
  })
  // Nesting really is nesting: the snake_case keys stay where they were written.
  assert.equal(result.value.workers.soft_max, 'auto')
  assert.equal(result.value.resources.reserve_ram_percent, 20)
})

test('the documented §45 flat default document parses too', () => {
  const result = parse(DOCUMENTED_45)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value.worker, { min: 1, soft_max: 'auto', hard_max: 'auto' })
  assert.deepEqual(result.value.resource, { cpu_reserve_percent: 20, ram_reserve_percent: 20, gpu_reserve_percent: 20 })
  assert.deepEqual(result.value.scaling, {
    scale_up_step: 1,
    scale_down_step: 1,
    scale_up_delay_seconds: 30,
    scale_down_delay_seconds: 60
  })
  assert.deepEqual(result.value.runtime, { heartbeat_seconds: 5, worker_timeout_seconds: 1800 })
  assert.deepEqual(result.value.safety, { enable_safe_mode: true, keep_supervisor_alive: true })
})

test('an empty or comment-only document is valid and empty', () => {
  for (const text of ['', '   \n\n', '# nothing but a comment\n', '# a\n# b\n']) {
    const result = parse(text)
    assert.equal(result.ok, true, `${JSON.stringify(text)} must parse`)
    assert.deepEqual(result.value, {})
    assert.deepEqual(result.errors, [])
  }
  assert.deepEqual(parse(null).value, {}, 'a null source is an empty document, not a crash')
})

test('`auto` stays the string "auto" and is never guessed into a number', () => {
  assert.equal(parseScalar('auto'), 'auto')
  assert.equal(typeof parseScalar('auto'), 'string')
  const result = parse('workers:\n  soft_max: auto\n  hard_max: auto\n')
  assert.equal(result.value.workers.soft_max, 'auto')
  assert.equal(result.value.workers.hard_max, 'auto')
  // Any other bare word is also left as a string for the caller to interpret.
  assert.equal(parseScalar('whenever'), 'whenever')
})

test('quoted strings survive ":" and "#" characters', () => {
  const result = parse([
    'note: "a # b"',
    'url: "http://localhost:3080/api"',
    'both: "a: b # c"',
    'single: \'x # y\'',
    'escaped: \'it\'\'s here\'',
    'plain: value#nothash',
    // A tag-like sequence inside quotes is data, not a tag.
    'tagged: "!!str 3"',
    ''
  ].join('\n'))
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value, {
    note: 'a # b',
    url: 'http://localhost:3080/api',
    both: 'a: b # c',
    single: 'x # y',
    escaped: "it's here",
    // A `#` only starts a comment when whitespace precedes it.
    plain: 'value#nothash',
    tagged: '!!str 3'
  })
})

test('comments are stripped only outside quotes and only after whitespace', () => {
  assert.equal(stripComment('key: value # trailing').trim(), 'key: value')
  assert.equal(stripComment('# whole line'), '')
  assert.equal(stripComment('key: "a # b"'), 'key: "a # b"')
  assert.equal(stripComment("key: 'a # b'"), "key: 'a # b'")
  assert.equal(stripComment('key: value#nothash'), 'key: value#nothash')

  const result = parse([
    'workers:',
    '  min: 1 # the documented minimum',
    '  soft_max: auto   # let the profiler decide',
    '',
    'resources:',
    '  reserve_ram_percent: 20 # percent of total RAM',
    ''
  ].join('\n'))
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value.workers, { min: 1, soft_max: 'auto' })
  assert.equal(result.value.resources.reserve_ram_percent, 20)
})

test('numbers, booleans and null are typed, not left as strings', () => {
  const result = parse([
    'int: 42',
    'negative: -7',
    'zero: 0',
    'plus: +2',
    'float: 1.5',
    'leading_dot: .5',
    'exponent: 1e3',
    'yes_value: true',
    'no_value: false',
    'on_value: on',
    'off_value: off',
    'nullish: null',
    'tilde: ~',
    ''
  ].join('\n'))
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value, {
    int: 42,
    negative: -7,
    zero: 0,
    plus: 2,
    float: 1.5,
    leading_dot: 0.5,
    exponent: 1000,
    yes_value: true,
    no_value: false,
    on_value: true,
    off_value: false,
    nullish: null,
    tilde: null
  })
  for (const key of ['yes_value', 'no_value', 'on_value', 'off_value']) {
    assert.equal(typeof result.value[key], 'boolean', `${key} must be a boolean`)
  }
})

test('inline flow arrays parse element by element', () => {
  const result = parse([
    'roles: [code, test, build]',
    'mixed: [code, 3, true, 1.5, "a, b"]',
    'empty: []',
    'nested: [[1, 2], [3]]',
    ''
  ].join('\n'))
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value.roles, ['code', 'test', 'build'])
  // Every element keeps its own type, and a quoted comma is not a separator.
  assert.deepEqual(result.value.mixed, ['code', 3, true, 1.5, 'a, b'])
  assert.deepEqual(result.value.empty, [])
  assert.deepEqual(result.value.nested, [[1, 2], [3]])
  assert.deepEqual(splitFlow('a, "b, c", d'), ['a', '"b, c"', 'd'])
})

test('indented block sequences belong to the key that introduced them', () => {
  const result = parse([
    'roles:',
    '  - code',
    '  - 2',
    '  - true',
    '  -',
    'next: 1',
    ''
  ].join('\n'))
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.deepEqual(result.value.roles, ['code', 2, true, null])
  assert.equal(result.value.next, 1)
})

test('a key with nothing after it becomes the container its indented body needs', () => {
  const map = parse('section:\n  key: value\n')
  assert.equal(map.ok, true, map.errors.join('; '))
  assert.deepEqual(map.value.section, { key: 'value' })

  const list = parse('section:\n  - one\n  - two\n')
  assert.equal(list.ok, true, list.errors.join('; '))
  assert.deepEqual(list.value.section, ['one', 'two'])
})

test('every unsupported construct is reported in errors and never thrown', () => {
  const cases = [
    ['a document marker', '---\nkey: 1\n', /multi-document streams are not supported/],
    ['a document end marker', 'key: 1\n...\n', /document end markers are not supported/],
    ['an anchor', 'defaults: &base\n  key: 1\n', /anchors and aliases are not supported/],
    ['an alias', 'copy: *base\n', /anchors and aliases are not supported/],
    ['a literal block scalar', 'script: |\n  echo hi\n', /block scalars are not supported/],
    ['a folded block scalar', 'script: >-\n  echo hi\n', /block scalars are not supported/],
    ['an explicit tag', 'value: !custom 3\n', /explicit tags are not supported/],
    // Item 1: the standard secondary tag handle is rejected too, not swallowed
    // as a string (the `![A-Za-z!]` rule).
    ['a secondary-handle string tag', 'value: !!str 3\n', /explicit tags are not supported/],
    ['a secondary-handle type tag', 'value: !!int 3\n', /explicit tags are not supported/],
    ['a secondary-handle boolean tag', 'value: !!bool true\n', /explicit tags are not supported/],
    ['tab indentation', '\tkey: value\n', /tab indentation is not supported/],
    ['a sequence entry with no list key', '- orphan entry\n', /sequence entry without a list key/],
    ['a line with no colon', 'justtext\n', /expected "key: value"/],
    ['a line that starts with a colon', ':value\n', /expected "key: value"/],
    ['a nested mapping inside a list', 'list:\n  - a\n  nested: 1\n', /nested mapping inside a list is not supported/]
  ]
  for (const [label, text, pattern] of cases) {
    const result = parse(text)
    assert.equal(result.ok, false, `${label} must be rejected`)
    assert.ok(result.errors.length > 0, `${label} must carry a reason`)
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label} must explain itself, got ${JSON.stringify(result.errors)}`
    )
    assert.equal(typeof result.value, 'object', `${label} must still return a value object`)
    // A rejected document is still readable enough to debug: no partial throw.
    assert.equal(result.errors.every((error) => /^line \d+: /.test(error)), true, `every error names its line: ${JSON.stringify(result.errors)}`)
  }
})

test('a rejected document never silently invents the unsupported value', () => {
  const anchored = parse('defaults: &base\n  key: 1\n')
  assert.equal(anchored.ok, false)
  assert.equal(anchored.value.defaults, '&base', 'the anchor text is kept verbatim so nothing is guessed')

  const blockScalar = parse('script: |\n  echo hi\n')
  assert.equal(blockScalar.ok, false)
  assert.equal(blockScalar.value.script, '|')

  // Item 1: a `!!` tag is rejected, and the raw text is kept so the user can see
  // what was refused instead of being handed a guessed value.
  for (const text of ['value: !!str 3\n', 'value: !!int 3\n', 'value: !!bool true\n']) {
    const tagged = parse(text)
    assert.equal(tagged.ok, false, `${JSON.stringify(text)} must be rejected`)
    assert.deepEqual(tagged.errors, ['line 1: explicit tags are not supported'])
    assert.equal(tagged.value.value, text.slice('value: '.length).trim())
  }
})

test('a valid document is never rejected', () => {
  for (const text of [DOCUMENTED_27, DOCUMENTED_45]) {
    const result = parse(text)
    assert.equal(result.ok, true, result.errors.join('; '))
    assert.deepEqual(result.errors, [])
  }
})

test('readResourceFile reports a missing file instead of throwing', () => {
  const root = scratch('missing')
  const file = path.join(root, 'config', 'hns-resource.yaml')
  const result = readResourceFile(fs, file)
  assert.equal(result.ok, false)
  assert.equal(result.missing, true)
  assert.equal(result.value, null)
  assert.ok(result.errors.length > 0)
  assert.match(result.errors.join(' '), /ENOENT|no such file/i)
})

test('readResourceFile parses a JSON document when the text starts with "{"', () => {
  const file = scratchFile('json', 'hns-resource.json', JSON.stringify({
    workers: { min: 1, soft_max: 'auto', hard_max: 4 },
    resources: { reserve_ram_percent: 25 },
    thermal: { enabled: true }
  }))
  const result = readResourceFile(fs, file)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.format, 'json')
  assert.equal(result.value.workers.hard_max, 4)
  assert.equal(result.value.resources.reserve_ram_percent, 25)
  assert.equal(result.value.thermal.enabled, true)
  // A BOM-free JSON document indented over several lines is still JSON.
  const pretty = scratchFile('json-pretty', 'pretty.json', `{\n  "workers": { "min": 2 }\n}\n`)
  assert.equal(readResourceFile(fs, pretty).value.workers.min, 2)
})

test('readResourceFile rejects invalid JSON loudly', () => {
  const file = scratchFile('bad-json', 'hns-resource.json', '{"workers": }')
  const result = readResourceFile(fs, file)
  assert.equal(result.ok, false)
  assert.equal(result.value, null)
  assert.equal(result.format, 'json')
  assert.equal(result.missing, undefined)
  assert.match(result.errors[0], /invalid JSON/)
})

test('readResourceFile reads YAML with the parsed errors attached', () => {
  const good = scratchFile('yaml-good', 'hns-resource.yaml', DOCUMENTED_27)
  const parsedGood = readResourceFile(fs, good)
  assert.equal(parsedGood.ok, true, parsedGood.errors.join('; '))
  assert.equal(parsedGood.format, 'yaml')
  assert.equal(parsedGood.value.workers.min, 1)

  const bad = scratchFile('yaml-bad', 'hns-resource.yaml', 'workers:\n  soft_max: &anchor\n')
  const parsedBad = readResourceFile(fs, bad)
  assert.equal(parsedBad.ok, false)
  assert.equal(parsedBad.format, 'yaml')
  assert.match(parsedBad.errors.join('; '), /anchors and aliases are not supported/)

  const empty = scratchFile('yaml-empty', 'hns-resource.yaml', '')
  const parsedEmpty = readResourceFile(fs, empty)
  assert.equal(parsedEmpty.ok, true)
  assert.deepEqual(parsedEmpty.value, {})
})
