'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const visualArtifact = require('../../app/extensions/mega/theme/visual-artifact')
const png = require('../../app/extensions/mega/theme/png')

/**
 * Visual observation closure.
 *
 * A theme may be designed from structure alone, but the product must never claim
 * a visual observation it did not make. These tests pin both halves: a real
 * capture is accepted and persisted, and every way of *not* getting one is
 * recorded with a reason and flagged `degraded`.
 *
 * The snapshot service resolves its workspace from DSH_ROOT at require time, so
 * it is exercised in a child process against a temporary root.
 */

const APP_DIR = path.resolve(__dirname, '..', '..', 'app')

/** A PNG large enough to pass the density floor, built with the repo encoder. */
function realPng(width = 560, height = 900) {
  const canvas = png.createCanvas(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      png.blendPixel(canvas, x, y, [(x * 7 + y * 13) % 255, (x * 31 + y * 17) % 255, (x * 3 + y * 29) % 255, 255])
    }
  }
  return png.canvasToPng(canvas)
}

/**
 * Run a snippet inside a child process rooted at a temporary DSH_ROOT.
 * `mode` decides what the (fake) dock capture returns.
 */
function runSandbox(body, { env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-visual-'))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data', 'state'), { recursive: true })
  const wrapped = `
'use strict'
const APP = ${JSON.stringify(APP_DIR)}
const requireApp = (id) => require(require('node:path').join(APP, id))
module.exports = (async () => { ${body} })()
`
  const result = spawnSync(process.execPath, ['-e', wrapped], {
    cwd: APP_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_ROOT: root, DSH_HOME: path.join(root, 'data'), ...env }
  })
  const marker = '__HNS_TEST_RESULT__'
  const line = (result.stdout || '').split(/\r?\n/).find((entry) => entry.startsWith(marker))
  let value = null
  if (line) {
    try {
      value = JSON.parse(line.slice(marker.length))
    } catch {
      value = null
    }
  }
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
  return { ok: result.status === 0 && Boolean(line) && value !== null, value, stdout: result.stdout, stderr: result.stderr, status: result.status }
}

/**
 * Shared child-process prelude: builds a snapshot service whose capture behaves
 * like the given `mode`.
 */
const PRELUDE = `
const inspector = requireApp('extensions/mega/theme/inspector.js')
const pngModule = requireApp('extensions/mega/theme/png.js')
const MODE = ${JSON.stringify('__MODE__')}
function realPng(width, height) {
  const canvas = pngModule.createCanvas(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pngModule.blendPixel(canvas, x, y, [(x * 7 + y * 13) % 255, (x * 31 + y * 17) % 255, (x * 3 + y * 29) % 255, 255])
    }
  }
  return pngModule.canvasToPng(canvas)
}
async function capture(pages) {
  if (MODE === 'real') {
    const out = {}
    for (const page of pages) out[page] = realPng(560, 900)
    return out
  }
  if (MODE === 'junk') {
    const out = {}
    for (const page of pages) out[page] = Buffer.from('this is not a screenshot')
    return out
  }
  if (MODE === 'tiny') {
    const out = {}
    for (const page of pages) out[page] = pngModule.canvasToPng(pngModule.createCanvas(8, 8))
    return out
  }
  if (MODE === 'throw') throw new Error('simulated renderer crash during capture')
  return {}
}
const service = inspector.createSnapshotService({
  capture,
  log: () => {},
  visualExpected: () => (MODE === 'no-visual-mode'
    ? { expected: false, reason: 'visual capture disabled for this run' }
    : { expected: MODE !== 'renderer-unavailable', reason: null })
})
`

function observe(mode) {
  const body = `
  ${PRELUDE.replace('__MODE__', mode)}
  const result = await service.observe()
  const artifacts = service.artifacts()
  console.log('__HNS_TEST_RESULT__' + JSON.stringify({
    visual: result.package.visual,
    degraded: result.package.degraded,
    reason: result.package.visual_reason,
    expected: result.package.visual_expected,
    problems: result.package.capture_problems,
    pages: result.package.page_names,
    files: result.files,
    slotMapKeys: Object.keys(result.package.slot_map).length,
    visibleComponents: result.package.visible_components.length,
    artifacts: { ok: artifacts.ok, mapExists: artifacts.mapExists, files: artifacts.files.map((f) => ({ name: f.name, exists: f.exists, ok: f.verdict.ok, bytes: f.verdict.bytes, width: f.verdict.width, height: f.verdict.height })) }
  }))
  return null
  `
  return runSandbox(body)
}

test('a real capture is accepted, persisted and reported as a visual observation', async () => {
  const result = observe('real')
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.value.visual, true)
  assert.equal(result.value.degraded, false)
  assert.equal(result.value.expected, true)
  assert.equal(result.value.problems.length, 0)
  // Every dock page asked for produced a verified file on disk.
  assert.ok(result.value.files.includes('ui-map.json'))
  assert.equal(result.value.artifacts.ok, true)
  assert.ok(result.value.artifacts.files.length > 0)
  for (const file of result.value.artifacts.files) {
    assert.equal(file.exists, true, file.name)
    assert.equal(file.ok, true, `${file.name}: ${JSON.stringify(file)}`)
    assert.equal(file.width, 560)
    assert.equal(file.height, 900)
    assert.ok(file.bytes > 0)
  }
})

test('an empty capture while the dock is available is recorded as degraded', async () => {
  const result = observe('empty')
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.value.visual, false)
  assert.equal(result.value.degraded, true, 'a missing picture when one was possible is an anomaly')
  assert.equal(result.value.expected, true)
  assert.match(result.value.reason, /no image/)
  assert.equal(result.value.artifacts.ok, false)
})

test('a buffer that is not a usable image never counts as a visual observation', async () => {
  const junk = observe('junk')
  assert.equal(junk.ok, true, junk.stderr)
  assert.equal(junk.value.visual, false)
  assert.equal(junk.value.degraded, true)
  assert.ok(junk.value.problems.some((entry) => /not a PNG|malformed/.test(entry)), JSON.stringify(junk.value.problems))

  const tiny = observe('tiny')
  assert.equal(tiny.ok, true, tiny.stderr)
  assert.equal(tiny.value.visual, false)
  assert.equal(tiny.value.degraded, true)
  assert.ok(tiny.value.problems.some((entry) => /too narrow|too short/.test(entry)), JSON.stringify(tiny.value.problems))
})

test('a capture that throws degrades instead of failing the observation', async () => {
  const result = observe('throw')
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.value.visual, false)
  assert.equal(result.value.degraded, true)
  assert.ok(result.value.problems.some((entry) => /simulated renderer crash/.test(entry)), JSON.stringify(result.value.problems))
})

test('an unavailable renderer is a known degradation, not an anomaly', async () => {
  const result = observe('renderer-unavailable')
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.value.visual, false)
  assert.equal(result.value.expected, false)
  assert.equal(result.value.degraded, false, 'a headless run is an allowed degradation')
  assert.ok(result.value.files.includes('ui-map.json'), 'the structure-only package is still written down')
})

test('an explicit no-visual mode records its own reason', async () => {
  const result = observe('no-visual-mode')
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.value.visual, false)
  assert.equal(result.value.expected, false)
  assert.equal(result.value.degraded, false)
  assert.match(result.value.reason, /disabled/)
})

test('capture verdicts reject empty, malformed and unusable images', () => {
  assert.equal(visualArtifact.inspectCapture(null).ok, false)
  assert.equal(visualArtifact.inspectCapture(Buffer.alloc(0)).ok, false)
  assert.equal(visualArtifact.inspectCapture(Buffer.from('not an image')).ok, false)
  assert.equal(visualArtifact.inspectCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47])).ok, false, 'a truncated header is not an image')
  // A 0x0 capture is what a broken renderer returns: it must never pass.
  const zero = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(visualArtifact.inspectCapture(zero).ok, false)
  assert.equal(visualArtifact.inspectCapture(png.canvasToPng(png.createCanvas(8, 8))).ok, false, 'an 8x8 image is not a UI')

  const real = visualArtifact.inspectCapture(realPng())
  assert.equal(real.ok, true)
  assert.equal(real.width, 560)
  assert.equal(real.height, 900)
  assert.ok(real.bytes > 0)
  assert.equal(real.density > 0, true)

  // The acceptance floor is an additional guard, only for a file read from disk.
  assert.equal(visualArtifact.inspectCapture(realPng(), { acceptance: true }).ok, false, 'a few KB is below the 5 KB acceptance floor')
  assert.equal(visualArtifact.inspectCapture(Buffer.concat([realPng(), Buffer.alloc(6000)]), { acceptance: true }).ok, true)
})
