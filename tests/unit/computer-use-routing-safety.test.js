'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { routeAction, fallbackChannels, channelRank, CHANNEL_PLANS, CHANNEL_CAPABILITY } = require('../../app/computer-use/routing.cjs')
const { createSafetyGuard, matchesWindow } = require('../../app/computer-use/safety.cjs')
const { createContract } = require('../../app/computer-use/contract.cjs')
const { normalizeAction } = require('../../app/computer-use/action.cjs')
const { createWorldState } = require('../../app/computer-use/world-state.cjs')
const { createShellController, DENIED_PATTERNS } = require('../../app/computer-use/controllers/shell.cjs')
const { createFileController } = require('../../app/computer-use/controllers/file.cjs')
const { createVisionController, matchTemplate, findColorRegion, normalizeColor } = require('../../app/computer-use/controllers/vision.cjs')
const { CODES } = require('../../app/computer-use/errors.cjs')
const png = require('../../app/extensions/mega/theme/png.js')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Phase 8 — capability routing and safety (plan §29, §30, §31, §32, §33, §34),
 * plus the controllers that talk to real resources (plan §26, §27, §28, §48).
 */

const ALL = ['browser', 'desktop', 'shell', 'filesystem', 'vision']
const availability = (overrides = {}) => ({
  browser: { available: true, reason: null },
  desktop: { available: true, reason: null },
  accessibility: { available: true, reason: null },
  vision: { available: true, reason: null },
  shell: { available: true, reason: null },
  file: { available: true, reason: null },
  ...overrides
})

test('the router prefers the cheapest channel that can carry the action (plan §29)', () => {
  const contract = createContract({ goal: 'route', allowed_capabilities: ALL })
  const shell = routeAction(normalizeAction({ type: 'SHELL_EXEC', command: 'node' }), { contract, world: null, availability: availability() })
  assert.equal(shell.channel, 'shell')
  assert.match(shell.reason, /cheaper and more reliable/)

  const file = routeAction(normalizeAction({ type: 'FILE_WRITE', path: 'a.txt', content: 'x' }), { contract, world: null, availability: availability() })
  assert.equal(file.channel, 'file')

  const dom = routeAction(normalizeAction({ type: 'DOM_CLICK', target: '#save' }), {
    contract,
    world: null,
    availability: availability(),
    resolved: { ref: 'e1', point: { x: 1, y: 1 }, source: 'page', kind: 'selector' }
  })
  assert.equal(dom.channel, 'dom')

  const gui = routeAction(normalizeAction({ type: 'CLICK', target: { point: { x: 10, y: 20 } } }), {
    contract,
    world: null,
    availability: availability(),
    resolved: { point: { x: 10, y: 20 }, source: 'target' }
  })
  assert.equal(gui.channel, 'gui')
  assert.match(gui.reason, /no structured channel applies/)
})

test('a contract that withholds a capability removes that channel and its alternatives', () => {
  const contract = createContract({ goal: 'browser only', allowed_capabilities: ['browser'] })
  const action = normalizeAction({ type: 'DOM_CLICK', target: '#save' })
  const routed = routeAction(action, {
    contract,
    world: null,
    availability: availability(),
    resolved: { ref: 'e1', point: { x: 1, y: 1 }, source: 'page', kind: 'selector' }
  })
  assert.equal(routed.channel, 'dom')

  // With the DOM unusable, an accessibility invoke would be the structured
  // option — and the contract forbids the desktop capability, so the router
  // reports the refusal instead of silently reaching for the mouse.
  const blocked = routeAction(normalizeAction({ type: 'CLICK', target: { point: { x: 1, y: 1 } } }), {
    contract,
    world: null,
    availability: availability(),
    resolved: { ref: 'e9', point: { x: 1, y: 1 }, source: 'ax', kind: 'accessibility' }
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, CODES.CONTROLLER_UNAVAILABLE)
  assert.ok(blocked.attempts.some((attempt) => attempt.channel === 'accessibility' && /not allowed/.test(attempt.reason)))
  assert.ok(blocked.attempts.some((attempt) => attempt.channel === 'gui' && /not allowed/.test(attempt.reason)))
})

test('an unavailable controller degrades the route instead of failing the action', () => {
  const contract = createContract({ goal: 'degrade', allowed_capabilities: ALL })
  const action = normalizeAction({ type: 'DOM_CLICK', target: '#save' })
  const routed = routeAction(action, {
    contract,
    world: null,
    availability: availability({ browser: { available: false, reason: 'the page was closed' } }),
    resolved: { ref: 'e1', point: { x: 5, y: 6 }, source: 'ax', kind: 'accessibility' }
  })
  assert.equal(routed.ok, true)
  assert.equal(routed.channel, 'accessibility')
  assert.ok(routed.attempts.some((attempt) => attempt.channel === 'dom' && /page was closed/.test(attempt.reason)))
})

test('every action type has a routing plan and a channel capability', () => {
  for (const [type, plan] of Object.entries(CHANNEL_PLANS)) {
    assert.ok(plan.length > 0, `${type} has no channel plan`)
    for (const channel of plan) assert.ok(CHANNEL_CAPABILITY[channel], `${channel} has no capability`)
  }
  assert.ok(channelRank('api') < channelRank('vision'), 'the ladder ranks cheap channels first')
  assert.deepEqual(fallbackChannels(normalizeAction({ type: 'DOM_CLICK', target: '#a' })), ['dom', 'accessibility'])
})

test('window safety refuses a coordinate click when another window is in front (plan §33)', () => {
  const contract = createContract({ goal: 'click safely' })
  const safety = createSafetyGuard({ contract })
  const world = createWorldState({
    desktop: {
      windows: [
        { handle: '9', title: 'Something Else', processId: 42, bounds: { x: 0, y: 0, width: 100, height: 100 }, foreground: true, visible: true },
        { handle: '1', title: 'Target App', processId: 7, bounds: { x: 0, y: 0, width: 100, height: 100 }, foreground: false, visible: true }
      ]
    }
  })
  const decision = safety.checkWindow(normalizeAction({ type: 'CLICK', target: { point: { x: 5, y: 5 }, window: { title: 'Target App' } } }), world)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, CODES.WINDOW_MISMATCH)
  assert.throws(() => safety.assertWindowAllowed(normalizeAction({ type: 'CLICK', target: { point: { x: 5, y: 5 }, window: { title: 'Target App' } } }), world),
    (error) => error.code === CODES.WINDOW_MISMATCH)

  // The same window in front is allowed.
  const foregroundWorld = createWorldState({
    desktop: {
      windows: [
        { handle: '1', title: 'Target App', processId: 7, bounds: { x: 0, y: 0, width: 100, height: 100 }, foreground: true, visible: true }
      ]
    }
  })
  assert.equal(safety.checkWindow(normalizeAction({ type: 'CLICK', target: { point: { x: 5, y: 5 }, window: { title: 'Target App' } } }), foregroundWorld).allowed, true)
  assert.equal(matchesWindow({ handle: '1', title: 'Editor - doc.txt', processId: 7 }, { title: 'editor' }), true)
  assert.equal(matchesWindow({ handle: '1', title: 'Editor', processId: 7 }, { handle: '2' }), false)
})

test('focus safety refuses to type into an unknown target (plan §31)', () => {
  const contract = createContract({ goal: 'type safely' })
  const safety = createSafetyGuard({ contract })
  const unfocused = createWorldState({ browser: { url: 'about:blank', focusedRef: null, controls: [{ ref: 'e1', role: 'textbox', name: 'username', selector: '#username' }] } })
  const decision = safety.checkFocus(normalizeAction({ type: 'TYPE', target: '#username', text: 'x' }), unfocused)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, CODES.FOCUS_MISMATCH)

  const focused = createWorldState({ browser: { url: 'about:blank', focusedRef: 'e1', controls: [{ ref: 'e1', role: 'textbox', name: 'username', selector: '#username' }] } })
  assert.equal(safety.checkFocus(normalizeAction({ type: 'TYPE', target: '#username', text: 'x' }), focused).allowed, true)
  // A verified receipt from the FOCUS action is accepted as evidence too.
  assert.equal(safety.checkFocus(normalizeAction({ type: 'TYPE', target: '#username', text: 'x' }), unfocused, { verifiedFocusRef: 'e1' }).allowed, true)
  // Non-typing actions are not focus checked.
  assert.equal(safety.checkFocus(normalizeAction({ type: 'BROWSER_REFRESH' }), unfocused).checked, false)
})

test('the destructive gate has three outcomes and never assumes consent (plan §34)', async () => {
  const forbidden = createContract({ goal: 'x', safety: { destructive_actions: 'forbidden' } })
  const forbiddenGuard = createSafetyGuard({ contract: forbidden })
  const decision = forbiddenGuard.evaluateDestructive(normalizeAction({ type: 'FILE_DELETE', path: 'x.txt' }), { contract: forbidden })
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, CODES.DESTRUCTIVE_FORBIDDEN)

  const confirmContract = createContract({ goal: 'x' })
  const withoutCallback = createSafetyGuard({ contract: confirmContract })
  await assert.rejects(
    () => withoutCallback.assertActionAllowed(normalizeAction({ type: 'FILE_DELETE', path: 'x.txt' }), { contract: confirmContract }),
    (error) => error.code === CODES.DESTRUCTIVE_NEEDS_CONFIRMATION
  )

  let asked = null
  const withCallback = createSafetyGuard({ contract: confirmContract, confirm: async (request) => {
    asked = request
    return true
  } })
  const allowed = await withCallback.assertActionAllowed(normalizeAction({ type: 'FILE_DELETE', path: 'x.txt' }), { contract: confirmContract })
  assert.equal(allowed.allowed, true)
  assert.deepEqual(asked.kinds, ['DELETE'])
  assert.equal(asked.goal, 'x')

  const refused = createSafetyGuard({ contract: confirmContract, confirm: async () => false })
  await assert.rejects(
    () => refused.assertActionAllowed(normalizeAction({ type: 'FILE_DELETE', path: 'x.txt' }), { contract: confirmContract }),
    (error) => error.code === CODES.SAFETY_REFUSED
  )

  const harmless = createSafetyGuard({ contract: confirmContract })
  assert.equal((await harmless.assertActionAllowed(normalizeAction({ type: 'BROWSER_REFRESH' }), { contract: confirmContract })).allowed, true)
})

test('secrets are redacted from actions and from error details (plan §32)', () => {
  const safety = createSafetyGuard({})
  const redacted = safety.redactAction(normalizeAction({ type: 'DOM_TYPE', target: '#password', text: 'hunter2', sensitive: true }))
  assert.equal(JSON.stringify(redacted).includes('hunter2'), false)
  assert.match(safety.redactText('password=hunter2'), /password=\[redacted\]/)
  assert.match(safety.redactText('Authorization: Bearer abc.def.ghi'), /Bearer \[redacted\]/)
})

test('the shell controller really runs commands and refuses dangerous ones (plan §28/§34)', async () => {
  const shell = createShellController({})
  const contract = createContract({ goal: 'run', allowed_capabilities: ['shell'] })
  assert.equal(shell.probe().available, true)

  const ok = await shell.perform(normalizeAction({ type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("hello")'] }), { contract })
  assert.equal(ok.ok, true)
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.stdout, 'hello')

  const failing = await shell.perform(normalizeAction({ type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.exit(3)'], expected_effect: { any: [{ exit_code: 0 }] } }), { contract })
  assert.equal(failing.exitCode, 3)
  assert.equal(failing.ok, false, 'a non-zero exit that contradicts the expectation is a failure')

  await assert.rejects(
    () => shell.perform(normalizeAction({ type: 'SHELL_EXEC', command: 'format C:' }), { contract }),
    (error) => error.code === CODES.SAFETY_REFUSED
  )
  await assert.rejects(
    () => shell.perform(normalizeAction({ type: 'SHELL_EXEC', command: 'node -e 1' }), {
      contract: createContract({ goal: 'allow list', allowed_capabilities: ['shell'], safety: { allowed_commands: ['git status'] } })
    }),
    (error) => error.code === CODES.SAFETY_REFUSED
  )
  // Secrets in output never reach the caller unredacted.
  const secretive = await shell.perform(normalizeAction({ type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("token=abcdef123456")'] }), { contract })
  assert.match(secretive.stdout, /token=\[redacted\]/)
  assert.ok(DENIED_PATTERNS.length >= 3)
})

test('the file controller works on the real filesystem and confines a workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-hns-cu-file-'))
  const inside = path.join(root, 'inside.txt')
  const outside = path.join(os.tmpdir(), `ds-hns-cu-outside-${process.pid}.txt`)
  const files = createFileController({ workspace: root })
  const contract = createContract({ goal: 'files', allowed_capabilities: ['filesystem'] })
  try {
    const written = await files.perform(normalizeAction({ type: 'FILE_WRITE', path: inside, content: 'hello' }), { contract })
    assert.equal(written.ok, true)
    assert.equal(fs.readFileSync(inside, 'utf8'), 'hello')

    const read = await files.perform(normalizeAction({ type: 'FILE_READ', path: inside }), { contract })
    assert.equal(read.content, 'hello')

    const exists = await files.perform(normalizeAction({ type: 'FILE_EXISTS', path: inside }), { contract })
    assert.equal(exists.exists, true)

    const copied = await files.perform(normalizeAction({ type: 'FILE_COPY', path: inside, to: path.join(root, 'copy.txt') }), { contract })
    assert.equal(copied.ok, true)
    assert.equal(fs.existsSync(path.join(root, 'copy.txt')), true)

    // Outside the workspace: refused, and nothing is written.
    await assert.rejects(
      () => files.perform(normalizeAction({ type: 'FILE_WRITE', path: outside, content: 'nope' }), { contract }),
      (error) => error.code === CODES.SAFETY_REFUSED
    )
    assert.equal(fs.existsSync(outside), false)

    const facts = files.facts()
    assert.equal(await facts.fileExists(inside), true)
    assert.equal(await facts.fileContains(inside, 'hell'), true)
    assert.equal(await facts.fileModifiedSince(inside, Date.now() - 60_000), true)

    // A deletion inside the workspace is allowed (the destructive gate is the
    // executor's job), and the file really is gone.
    await files.perform(normalizeAction({ type: 'FILE_DELETE', path: inside }), { contract })
    assert.equal(fs.existsSync(inside), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
  }
})

test('the vision controller matches a template and finds a painted region (plan §48)', () => {
  // A synthetic framebuffer: a red square on a blue background.
  const width = 64
  const height = 48
  const canvas = png.createCanvas(width, height)
  png.fill(canvas, { r: 20, g: 30, b: 200 })
  for (let y = 20; y < 30; y += 1) {
    for (let x = 30; x < 40; x += 1) png.blendPixel(canvas, x, y, { r: 255, g: 136, b: 0 })
  }
  const pngBuffer = png.canvasToPng(canvas)
  const decoded = png.decodePng(pngBuffer)

  const region = findColorRegion({ width, height, data: decoded.data }, normalizeColor('#ff8800'), { tolerance: 8, minWidth: 5, minHeight: 5 })
  assert.ok(region, 'the painted region must be found')
  assert.equal(region.rect.x, 30)
  assert.equal(region.rect.y, 20)
  assert.equal(region.rect.width, 10)
  assert.equal(region.rect.height, 10)

  // Template matching on the same image: the template is the drawn square.
  const template = png.createCanvas(10, 10)
  png.fill(template, { r: 255, g: 136, b: 0 })
  const templatePng = png.canvasToPng(template)
  const templateDecoded = png.decodePng(templatePng)
  const match = matchTemplate({ width, height, data: decoded.data }, { width: 10, height: 10, data: templateDecoded.data }, { threshold: 0.95 })
  assert.ok(match, 'the template must be found')
  assert.equal(match.rect.x, 30)
  assert.equal(match.rect.y, 20)
  assert.ok(match.score >= 0.95)

  assert.throws(() => normalizeColor('not-a-colour'), (error) => error.code === CODES.ACTION_INVALID)
})

test('the vision controller refuses a full-screen capture the contract forbids (plan §22)', async () => {
  const captured = []
  const driver = {
    probe: () => ({ available: true, reason: null, backend: 'double' }),
    captureRegion: async (region) => {
      captured.push({ kind: 'region', region })
      return { png: png.canvasToPng(png.createCanvas(4, 4)), width: 4, height: 4, rect: region, backend: 'double' }
    },
    captureWindow: async (handle) => {
      captured.push({ kind: 'window', handle })
      return { png: png.canvasToPng(png.createCanvas(4, 4)), width: 4, height: 4, rect: { x: 0, y: 0, width: 4, height: 4 }, backend: 'double' }
    },
    captureFull: async () => {
      captured.push({ kind: 'full' })
      return { png: png.canvasToPng(png.createCanvas(4, 4)), width: 4, height: 4, rect: { x: 0, y: 0, width: 4, height: 4 }, backend: 'double' }
    }
  }
  const vision = createVisionController({ driver })
  assert.equal(vision.probe().available, true)
  const region = await vision.capture(1, { region: { x: 5, y: 5, width: 10, height: 10 }, reason: 'test' })
  assert.equal(region.level, 1)
  assert.equal(captured[0].kind, 'region')

  // A region request without a region degrades to the window level.
  const windowLevel = await vision.capture(1, { windowHandle: 'w1' })
  assert.equal(windowLevel.level, 2)

  await assert.rejects(() => vision.capture(3, { allowFullScreen: false }), (error) => error.code === CODES.VISION_UNAVAILABLE)
  const full = await vision.capture(3, { allowFullScreen: true })
  assert.equal(full.level, 3)

  assert.equal(vision.nextLevel(0, { allowFullScreenFallback: true }), 1)
  assert.equal(vision.nextLevel(2, { allowFullScreenFallback: false }), 2, 'the ceiling honours the contract')
})

test('a capture that cannot be decoded is reported, not silently ignored', () => {
  const vision = createVisionController({ driver: { probe: () => ({ available: true }), captureRegion: async () => ({ png: Buffer.from('not a png'), width: 1, height: 1 }) } })
  assert.throws(() => vision.decode({ png: Buffer.from('not a png') }), (error) => error.code === CODES.SCREENSHOT_FAILED)
})
