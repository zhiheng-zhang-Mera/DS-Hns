'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.join(__dirname, '..', '..')
const DRIVERS = path.join(REPO, 'app', 'computer-use', 'drivers')

const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')
const ports = require('../../app/computer-use/ports.cjs')
const win32 = require('../../app/computer-use/drivers/win32.cjs')
const uia = require('../../app/computer-use/drivers/uia.cjs')
const screenshot = require('../../app/computer-use/drivers/screenshot.cjs')
const { decodePng } = require('../../app/extensions/mega/theme/png.js')

/**
 * Computer Use Runtime: the real Windows drivers (plan §27, §3.2, §4.2).
 *
 * These tests touch a live desktop, so every one of them is written to be
 * honest about what the machine can do: when a backend is genuinely missing the
 * test is SKIPPED with the reason the driver itself reported, never asserted
 * green. Nothing here presses a real key, moves the real pointer or types real
 * text - the input paths are exercised through an injected low-level sender so
 * that running the unit tests cannot disturb the desktop they run on.
 */

const IS_WINDOWS = process.platform === 'win32'

/** Probes a driver and skips the test with the driver's own reason when unusable. */
function probeOrSkip(t, driver, label) {
  const probe = ports.normalizeProbe(driver.probe())
  if (!probe.available) {
    t.skip(`${label} is not available here: ${probe.reason}`)
    return null
  }
  return probe
}

function assertRect(rect, label) {
  assert.ok(rect && typeof rect === 'object', `${label} must be an object`)
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isInteger(rect[key]), `${label}.${key} must be an integer, got ${JSON.stringify(rect[key])}`)
  }
}

/**
 * A low-level backend that records instead of typing. The hotkey contract is
 * about the ORDER of the events, and the only way to assert an order without
 * disturbing the machine is to capture it before it reaches SendInput.
 */
function createRecordingBackend(overrides = {}) {
  const events = []
  const record = (name, result) => (...args) => {
    events.push({ method: name, args })
    return typeof result === 'function' ? result(...args) : result
  }
  return {
    events,
    name: 'recording',
    clipboard: 'recording',
    listWindows: record('listWindows', []),
    foregroundWindow: record('foregroundWindow', null),
    focusWindow: record('focusWindow', { focused: true }),
    closeWindow: record('closeWindow', { posted: true }),
    moveWindow: record('moveWindow', { moved: true, bounds: { x: 0, y: 0, width: 10, height: 10 } }),
    cursorPosition: record('cursorPosition', { x: 5, y: 6 }),
    moveMouse: record('moveMouse', { x: 5, y: 6 }),
    click: record('click', { x: 5, y: 6, button: 'left', clicks: 1 }),
    drag: record('drag', { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }),
    scroll: record('scroll', { delta: 1 }),
    sendKeySequence: (sequence) => {
      events.push({ method: 'sendKeySequence', args: [sequence] })
      return { sent: sequence.length }
    },
    typeText: record('typeText', { typed: 1 }),
    clipboardRead: record('clipboardRead', { text: '' }),
    clipboardWrite: record('clipboardWrite', { written: 1 }),
    screenMetrics: record('screenMetrics', { virtualScreen: { x: 0, y: 0, width: 100, height: 100 } }),
    probe: record('probe', { metrics: { width: 100, height: 100 }, interactive: true, windows: 0 }),
    ...overrides
  }
}

function lastKeyEvents(backend) {
  const call = [...backend.events].reverse().find((entry) => entry.method === 'sendKeySequence')
  assert.ok(call, 'the driver must send the sequence through the low-level sender')
  return call.args[0]
}

test('every driver implements its whole port contract', () => {
  const cases = [
    ['desktop', win32.createWin32Driver()],
    ['accessibility', uia.createUiaDriver()],
    ['screenshot', screenshot.createScreenshotDriver()]
  ]
  for (const [port, driver] of cases) {
    const { ok, missing } = ports.inspectPort(port, driver)
    assert.equal(ok, true, `${port} driver is missing: ${missing.join(', ')}`)
  }
})

test('win32 probe reports a well-formed verdict', () => {
  const driver = win32.createWin32Driver()
  const raw = driver.probe()
  assert.equal(typeof raw, 'object')
  assert.equal(typeof raw.available, 'boolean')
  assert.ok(raw.reason === null || typeof raw.reason === 'string')
  assert.equal(typeof raw.detail, 'object')

  const probe = ports.normalizeProbe(raw)
  if (!IS_WINDOWS) {
    assert.equal(probe.available, false)
    assert.equal(probe.reason, 'windows-only')
    return
  }
  assert.ok(['koffi', 'powershell', 'unavailable'].includes(raw.detail.backend), `unexpected backend ${raw.detail.backend}`)
  if (probe.available) {
    // A real self-test, not a guess: the backend answered with screen metrics.
    assert.ok(raw.detail.metrics.width > 0, 'an available desktop backend reports a positive screen width')
    assert.ok(raw.detail.metrics.height > 0)
    assert.equal(typeof raw.detail.interactive, 'boolean')
  } else {
    assert.ok(probe.reason && probe.reason.length > 0, 'an unavailable backend must say why')
  }
})

test('uia probe reports a well-formed verdict', () => {
  const driver = uia.createUiaDriver()
  const raw = driver.probe()
  assert.equal(typeof raw.available, 'boolean')
  assert.ok(raw.reason === null || typeof raw.reason === 'string')
  assert.equal(typeof raw.detail, 'object')
  const probe = ports.normalizeProbe(raw)
  if (!IS_WINDOWS) {
    assert.equal(probe.available, false)
    assert.equal(probe.reason, 'windows-only')
  } else if (!probe.available) {
    assert.ok(probe.reason && probe.reason.length > 0, 'an unavailable accessibility driver must say why')
  }
})

test('screenshot probe reports a well-formed verdict', () => {
  const driver = screenshot.createScreenshotDriver()
  const raw = driver.probe()
  assert.equal(typeof raw.available, 'boolean')
  assert.ok(raw.reason === null || typeof raw.reason === 'string')
  assert.equal(typeof raw.detail, 'object')
  const probe = ports.normalizeProbe(raw)
  if (!IS_WINDOWS) {
    assert.equal(probe.available, false)
    assert.equal(probe.reason, 'windows-only')
  } else if (!probe.available) {
    assert.ok(probe.reason && probe.reason.length > 0, 'an unavailable screenshot driver must say why (no interactive desktop is a real reason)')
  }
})

test('listWindows returns well-formed, serializable window records', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the win32 desktop driver is Windows only')
    return
  }
  const driver = win32.createWin32Driver()
  const probe = probeOrSkip(t, driver, 'the desktop driver')
  if (!probe) return

  const windows = driver.listWindows()
  assert.ok(Array.isArray(windows), 'listWindows must return an array')
  assert.deepEqual(JSON.parse(JSON.stringify(windows)), windows, 'window records must be plain serializable objects')

  for (const window of windows) {
    assert.match(window.handle, /^\d+$/, `handle must be a decimal string, got ${JSON.stringify(window.handle)}`)
    assert.equal(typeof window.title, 'string')
    assert.ok(window.title.trim().length > 0, 'a listed window must have a title')
    assert.equal(typeof window.className, 'string')
    assert.ok(Number.isInteger(window.processId) && window.processId > 0, 'a listed window must belong to a process')
    assertRect(window.bounds, 'window.bounds')
    assert.equal(window.visible, true, 'a listed window must be visible')
    assert.equal(typeof window.minimized, 'boolean')
    assert.equal(typeof window.foreground, 'boolean')
    assert.ok(window.ownerHandle === null || /^\d+$/.test(window.ownerHandle))
    // The shell's own plumbing is what makes a window list useless.
    assert.ok(!['Progman', 'WorkerW', 'Shell_TrayWnd'].includes(window.className), `${window.className} must be filtered out`)
  }
})

test('the foreground window resolves or the session is reported as non-interactive', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the win32 desktop driver is Windows only')
    return
  }
  const driver = win32.createWin32Driver()
  const probe = probeOrSkip(t, driver, 'the desktop driver')
  if (!probe) return

  const foreground = driver.foregroundWindow()
  if (foreground === null) {
    // A session-0 service or a locked workstation really has no foreground
    // window; claiming one would be a fabrication.
    assert.equal(probe.detail.interactive, false, 'a null foreground window requires detail.interactive to be false')
    return
  }
  assert.match(foreground.handle, /^\d+$/)
  assert.equal(foreground.foreground, true)
  assertRect(foreground.bounds, 'foreground.bounds')
})

test('screenMetrics reports integer physical pixels for the virtual screen', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the win32 desktop driver is Windows only')
    return
  }
  const driver = win32.createWin32Driver()
  const probe = probeOrSkip(t, driver, 'the desktop driver')
  if (!probe) return

  const metrics = driver.screenMetrics()
  assertRect(metrics.virtualScreen, 'virtualScreen')
  assert.ok(metrics.virtualScreen.width > 0, 'the virtual screen has a width')
  assert.ok(metrics.virtualScreen.height > 0, 'the virtual screen has a height')
  assertRect(metrics.primary, 'primary')
  assert.ok(Array.isArray(metrics.monitors))
  assert.ok(metrics.monitors.length >= 1, 'there is always at least one monitor')
  for (const monitor of metrics.monitors) {
    assertRect(monitor.bounds, 'monitor.bounds')
    assert.equal(typeof monitor.primary, 'boolean')
  }
  assert.equal(metrics.monitors.filter((monitor) => monitor.primary).length, 1, 'exactly one monitor is primary')
})

test('resolveVirtualKey maps the documented key names', () => {
  const expected = {
    enter: 0x0d,
    tab: 0x09,
    esc: 0x1b,
    escape: 0x1b,
    space: 0x20,
    backspace: 0x08,
    delete: 0x2e,
    insert: 0x2d,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    ctrl: 0x11,
    alt: 0x12,
    shift: 0x10,
    win: 0x5b,
    capslock: 0x14
  }
  for (const [name, code] of Object.entries(expected)) {
    assert.equal(win32.resolveVirtualKey(name), code, `${name} must map to 0x${code.toString(16)}`)
  }
  for (let index = 1; index <= 12; index += 1) {
    assert.equal(win32.resolveVirtualKey(`f${index}`), 0x6f + index, `f${index}`)
  }
  assert.equal(win32.resolveVirtualKey('a'), 0x41, 'letters map to their upper-case virtual key')
  assert.equal(win32.resolveVirtualKey('Z'), 0x5a, 'the mapping is case insensitive')
  assert.equal(win32.resolveVirtualKey('7'), 0x37, 'digits are their own virtual key')
  assert.equal(win32.resolveVirtualKey(' F5 '), 0x74, 'surrounding whitespace is ignored')

  for (const malformed of ['', '   ', null, undefined, 12.5, {}]) {
    assert.throws(
      () => win32.resolveVirtualKey(malformed),
      (error) => error instanceof ComputerUseError && error.code === CODES.ACTION_INVALID,
      `${JSON.stringify(malformed) ?? String(malformed)} is not a key name at all, so it is ACTION_INVALID`
    )
  }
  for (const unknown of ['nonexistent-key', 'f13', 'numpad', 'ctrl+alt']) {
    assert.throws(
      () => win32.resolveVirtualKey(unknown),
      (error) => error instanceof ComputerUseError && error.code === CODES.ACTION_UNSUPPORTED,
      `${unknown} names nothing the desktop knows, so it is ACTION_UNSUPPORTED`
    )
  }
})

test('hotkey presses modifiers down, taps the payload, releases in reverse', () => {
  const backend = createRecordingBackend()
  const driver = win32.createWin32Driver({ lowLevel: backend })

  const receipt = driver.hotkey(['ctrl', 's'])
  assert.deepEqual(
    lastKeyEvents(backend).map((event) => `${event.action}:${event.name}`),
    ['down:ctrl', 'tap:s', 'up:ctrl']
  )
  assert.equal(receipt.ok, true)
  assert.deepEqual(receipt.keys, ['ctrl', 's'])

  backend.events.length = 0
  driver.hotkey(['ctrl', 'shift', 's'])
  assert.deepEqual(
    lastKeyEvents(backend).map((event) => `${event.action}:${event.name}`),
    ['down:ctrl', 'down:shift', 'tap:s', 'up:shift', 'up:ctrl'],
    'modifiers are released in reverse order of the press'
  )
  // The virtual keys travel with the events, so the backend never re-derives them.
  assert.deepEqual(
    lastKeyEvents(backend).map((event) => event.vk),
    [0x11, 0x10, 0x53, 0x10, 0x11]
  )

  backend.events.length = 0
  driver.hotkey(['alt', 'f4'])
  assert.deepEqual(
    lastKeyEvents(backend).map((event) => `${event.action}:${event.name}`),
    ['down:alt', 'tap:f4', 'up:alt']
  )

  // A lone key is a tap, not a chord that is never released.
  backend.events.length = 0
  driver.keyPress('enter')
  assert.deepEqual(
    lastKeyEvents(backend).map((event) => `${event.action}:${event.name}`),
    ['tap:enter']
  )

  backend.events.length = 0
  driver.keyPress('shift', { action: 'down' })
  assert.deepEqual(lastKeyEvents(backend).map((event) => event.action), ['down'])
  driver.keyPress('shift', { action: 'up' })
  assert.deepEqual(lastKeyEvents(backend).map((event) => event.action), ['up'])
})

test('pointer methods accept both call shapes without inventing coordinates', () => {
  const backend = createRecordingBackend()
  const driver = win32.createWin32Driver({ lowLevel: backend })
  const recorded = (method) => backend.events.filter((entry) => entry.method === method).map((entry) => entry.args[0])

  driver.drag({ fromX: 1, fromY: 2, toX: 30, toY: 40 })
  assert.deepEqual(recorded('drag')[0], { fromX: 1, fromY: 2, toX: 30, toY: 40, button: 'left', durationMs: 300 })

  driver.drag({ x: 1, y: 2 }, { x: 30, y: 40 }, { durationMs: 160 })
  assert.deepEqual(recorded('drag')[1], { fromX: 1, fromY: 2, toX: 30, toY: 40, button: 'left', durationMs: 160 })

  assert.throws(() => driver.drag(1, 2), (error) => error.code === CODES.ACTION_INVALID)

  driver.scroll(3)
  assert.deepEqual(recorded('scroll')[0], { delta: 3, horizontal: false })
  driver.scroll({ delta: -2, x: 10, y: 20, horizontal: true })
  assert.deepEqual(recorded('scroll')[1], { delta: -2, horizontal: true, x: 10, y: 20 })

  // A click without coordinates is the one case where the cursor position is
  // read first, so the receipt still names a concrete point.
  driver.click({})
  assert.deepEqual(
    { x: recorded('click')[0].x, y: recorded('click')[0].y },
    backend.cursorPosition()
  )
})

test('window operations reject nonsense instead of guessing', () => {
  const backend = createRecordingBackend()
  const driver = win32.createWin32Driver({ lowLevel: backend })

  assert.throws(() => driver.focusWindow('not-a-handle'), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => driver.focusWindow(0), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => driver.hotkey([]), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => driver.typeText(42), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => driver.scroll(0), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => driver.moveWindow('0x10', { width: Number.NaN }), (error) => error.code === CODES.ACTION_INVALID)

  // Handles are accepted in every form a caller may hold them in...
  driver.focusWindow(0x2a)
  driver.focusWindow('0x2a')
  driver.focusWindow('42')
  driver.focusWindow({ handle: '42' })
  const handles = backend.events.filter((entry) => entry.method === 'focusWindow').map((entry) => entry.args[0])
  assert.deepEqual(handles, [42, 42, 42, 42])

  // ...and a fractional coordinate is a physical-pixel rounding, not an error.
  driver.moveWindow('42', { x: 1.5, y: 2.4, width: 100, height: 50 })
  const moved = backend.events.filter((entry) => entry.method === 'moveWindow').pop().args[1]
  assert.deepEqual(moved, { x: 2, y: 2, width: 100, height: 50 })
})

test('the driver degrades to the PowerShell backend when koffi is absent', () => {
  const missing = () => {
    throw new Error('simulated missing koffi')
  }
  const loaded = win32.__internal.loadKoffi({ loadKoffi: missing })
  assert.equal(loaded.koffi, null, 'a missing koffi must not throw out of the loader')
  assert.match(loaded.error, /simulated missing koffi/)

  const driver = win32.createWin32Driver({ loadKoffi: missing })
  const raw = driver.probe()
  assert.equal(typeof raw.available, 'boolean', 'probe must still answer without koffi')
  if (IS_WINDOWS) {
    assert.notEqual(raw.detail.backend, 'koffi', 'koffi cannot be the backend when it refused to load')
  }

  const pinned = win32.createWin32Driver({ loadKoffi: missing, forceBackend: 'koffi' })
  const verdict = ports.normalizeProbe(pinned.probe())
  assert.equal(verdict.available, false)
  assert.match(verdict.reason, /simulated missing koffi/)
  assert.throws(
    () => pinned.listWindows(),
    (error) => error instanceof ComputerUseError && error.code === CODES.CONTROLLER_UNAVAILABLE,
    'a driver with no backend must throw the typed unavailable error'
  )
})

test('requiring win32.cjs never loads koffi', () => {
  // The real guard: koffi is a transitive dependency, so a module-load require
  // would take the whole runtime down on a machine where it was pruned.
  const modulePath = path.join(DRIVERS, 'win32.cjs')
  const script = [
    "const Module = require('node:module')",
    'const original = Module._load',
    'Module._load = function (request) {',
    "  if (request === 'koffi') throw new Error('koffi is not installed')",
    '  return original.apply(this, arguments)',
    '}',
    `const win32 = require(${JSON.stringify(modulePath)})`,
    'const driver = win32.createWin32Driver()',
    "process.stdout.write(JSON.stringify({ backend: driver.backend, probe: driver.probe().detail.backend }))"
  ].join('\n')
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, `requiring win32.cjs without koffi failed: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  assert.notEqual(parsed.backend, 'koffi')
  assert.notEqual(parsed.probe, 'koffi')
  assert.ok(['powershell', 'unavailable'].includes(parsed.backend), `unexpected backend ${parsed.backend}`)
})

test('captureRegion returns a decodable PNG whose size matches the region', (t) => {
  if (!IS_WINDOWS) {
    t.skip('screenshot capture is Windows only')
    return
  }
  const driver = screenshot.createScreenshotDriver()
  const probe = probeOrSkip(t, driver, 'the screenshot driver')
  if (!probe) return

  const shot = driver.captureRegion({ x: 100, y: 100, width: 64, height: 48 })
  assert.ok(Buffer.isBuffer(shot.png), 'captureRegion must return a Buffer')
  assert.ok(shot.png.length > 0)
  assert.ok(Number.isInteger(shot.width) && shot.width > 0)
  assert.ok(Number.isInteger(shot.height) && shot.height > 0)
  assertRect(shot.rect, 'shot.rect')
  assert.equal(shot.rect.width, shot.width)
  assert.equal(shot.rect.height, shot.height)
  assert.equal(typeof shot.backend, 'string')
  assert.equal(typeof shot.capturedAt, 'number')

  // Decoding with the independent decoder is what proves it is a real image.
  const decoded = decodePng(shot.png)
  assert.equal(decoded.width, shot.width, 'the PNG width must match the reported width')
  assert.equal(decoded.height, shot.height, 'the PNG height must match the reported height')
  assert.equal(decoded.data.length, shot.width * shot.height * 4)
})

test('captureFull returns the whole virtual screen', (t) => {
  if (!IS_WINDOWS) {
    t.skip('screenshot capture is Windows only')
    return
  }
  const driver = screenshot.createScreenshotDriver()
  const probe = probeOrSkip(t, driver, 'the screenshot driver')
  if (!probe) return

  const shot = driver.captureFull()
  const decoded = decodePng(shot.png)
  assert.equal(decoded.width, shot.width)
  assert.equal(decoded.height, shot.height)
  assert.ok(shot.width >= 640, `a full capture of a real desktop is not a thumbnail (got ${shot.width})`)
})

test('a region outside the virtual screen is clamped or refused, never fatal', (t) => {
  if (!IS_WINDOWS) {
    t.skip('screenshot capture is Windows only')
    return
  }
  const driver = screenshot.createScreenshotDriver()
  const probe = probeOrSkip(t, driver, 'the screenshot driver')
  if (!probe) return
  const virtual = probe.detail.virtualScreen
  if (!virtual || !Number.isInteger(virtual.x)) {
    t.skip('the screenshot driver did not report a virtual screen to clamp against')
    return
  }

  function attempt(rect) {
    try {
      return { shot: driver.captureRegion(rect) }
    } catch (error) {
      return { error }
    }
  }

  // Completely off the desktop: either a real refusal or a real clamped image.
  const outside = attempt({ x: virtual.x + virtual.width + 10000, y: virtual.y + virtual.height + 10000, width: 32, height: 32 })
  if (outside.error) {
    assert.ok(outside.error instanceof ComputerUseError, 'a refusal must be a typed error')
    assert.equal(outside.error.code, CODES.SCREENSHOT_FAILED)
  } else {
    assert.ok(outside.shot.width > 0 && outside.shot.height > 0, 'a returned capture must have real pixels')
    decodePng(outside.shot.png)
  }

  // Partially off the right edge: whatever comes back must be inside the screen.
  const overlap = 8
  const partial = attempt({ x: virtual.x + virtual.width - overlap, y: virtual.y, width: 200, height: 40 })
  if (partial.error) {
    assert.equal(partial.error.code, CODES.SCREENSHOT_FAILED)
  } else {
    assert.ok(partial.shot.width <= overlap, `a clamped capture cannot exceed the visible part (got ${partial.shot.width})`)
    assert.ok(partial.shot.rect.x >= virtual.x)
    assert.ok(partial.shot.rect.x + partial.shot.rect.width <= virtual.x + virtual.width)
    decodePng(partial.shot.png)
  }

  // A zero-sized request is a caller bug, not a crash.
  const degenerate = attempt({ x: 0, y: 0, width: 0, height: 0 })
  assert.ok(degenerate.error instanceof ComputerUseError, 'a zero-sized region must be refused with a typed error')
})

test('captureWindow refuses a dead handle with TARGET_NOT_FOUND', (t) => {
  if (!IS_WINDOWS) {
    t.skip('screenshot capture is Windows only')
    return
  }
  const driver = screenshot.createScreenshotDriver()
  const probe = probeOrSkip(t, driver, 'the screenshot driver')
  if (!probe) return
  assert.throws(
    () => driver.captureWindow('4294967294'),
    (error) => error instanceof ComputerUseError && error.code === CODES.TARGET_NOT_FOUND,
    'a handle that names no window must be refused, not captured'
  )
})

test('uia root describes the desktop root', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the accessibility driver is Windows only')
    return
  }
  const driver = uia.createUiaDriver()
  const probe = probeOrSkip(t, driver, 'the accessibility driver')
  if (!probe) return

  const root = driver.root()
  assert.equal(root.role, 'desktop')
  assert.equal(typeof root.ref, 'string')
  assert.ok(root.ref.length > 0, 'the root needs a re-resolvable ref')
  assert.equal(typeof root.name, 'string')
  assert.ok(Array.isArray(root.patterns), 'AxNode.patterns must be an array')
  assert.equal(typeof root.enabled, 'boolean')
  assert.equal(typeof root.focusable, 'boolean')
  assert.equal(typeof root.focused, 'boolean')
  assert.equal(typeof root.offscreen, 'boolean')
  assert.ok(Number.isInteger(root.childrenCount) && root.childrenCount >= 0)
  assertRect(root.bounds, 'root.bounds')
  assert.equal(typeof root.processId, 'number')
  assert.equal(typeof root.windowHandle, 'string')
})

test('uia find walks real windows, not just the desktop children', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the accessibility driver is Windows only')
    return
  }
  const driver = uia.createUiaDriver()
  const probe = probeOrSkip(t, driver, 'the accessibility driver')
  if (!probe) return

  const desktop = win32.createWin32Driver()
  const desktopProbe = ports.normalizeProbe(desktop.probe())
  if (!desktopProbe.available) {
    t.skip(`no window list to search through: ${desktopProbe.reason}`)
    return
  }
  const windows = desktop.listWindows()
  if (windows.length === 0) {
    t.skip('this desktop has no top-level window to look up through UI Automation')
    return
  }

  const target = windows[0]
  const nodes = driver.find({ name: target.title, exact: true }, { limit: 5 })
  assert.ok(Array.isArray(nodes), 'find must return an array')
  assert.ok(nodes.length >= 1, `UI Automation must find the window titled ${JSON.stringify(target.title)}`)
  for (const node of nodes) {
    assert.equal(node.name, target.title)
    assert.equal(typeof node.ref, 'string')
    assert.ok(Array.isArray(node.patterns))
    assertRect(node.bounds, 'node.bounds')
  }
})

test('uia refuses an unresolvable ref as stale instead of inventing a node', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the accessibility driver is Windows only')
    return
  }
  const driver = uia.createUiaDriver()
  const probe = probeOrSkip(t, driver, 'the accessibility driver')
  if (!probe) return

  assert.throws(
    () => driver.value('w:1/99.99'),
    (error) => error instanceof ComputerUseError && error.code === CODES.TARGET_STALE,
    'a path that no longer resolves must be reported as stale, never answered with a made-up value'
  )
})

test('uia children of the desktop root are AxNodes', (t) => {
  if (!IS_WINDOWS) {
    t.skip('the accessibility driver is Windows only')
    return
  }
  const driver = uia.createUiaDriver()
  const probe = probeOrSkip(t, driver, 'the accessibility driver')
  if (!probe) return

  const root = driver.root()
  const children = driver.children(root.ref, { depth: 1 })
  assert.ok(Array.isArray(children))
  for (const node of children.slice(0, 10)) {
    assert.equal(typeof node.ref, 'string')
    assert.equal(typeof node.role, 'string')
    assert.ok(Array.isArray(node.patterns))
    assertRect(node.bounds, 'child.bounds')
  }
})

test('non-Windows machines get the typed unavailable error, not a crash', () => {
  // process.platform is a configurable property, so the non-Windows branch is
  // reachable here even though this machine is Windows: a child process that
  // lies about its platform is a real check of the guard, unlike a skipped test
  // that only claims the guard exists.
  const drivers = path.join(REPO, 'app', 'computer-use', 'drivers')
  const script = [
    "Object.defineProperty(process, 'platform', { value: 'linux' })",
    `const win32 = require(${JSON.stringify(path.join(drivers, 'win32.cjs'))})`,
    `const uia = require(${JSON.stringify(path.join(drivers, 'uia.cjs'))})`,
    `const screenshot = require(${JSON.stringify(path.join(drivers, 'screenshot.cjs'))})`,
    'const results = []',
    'for (const [name, driver, method] of [',
    "  ['desktop', win32.createWin32Driver(), 'listWindows'],",
    "  ['accessibility', uia.createUiaDriver(), 'root'],",
    "  ['screenshot', screenshot.createScreenshotDriver(), 'captureFull']",
    ']) {',
    '  const probe = driver.probe()',
    '  let code = null',
    '  let message = null',
    '  try { driver[method]() } catch (error) { code = error.code; message = error.message }',
    '  results.push({ name, available: probe.available, reason: probe.reason, code, message })',
    '}',
    'process.stdout.write(JSON.stringify(results))'
  ].join('\n')
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(result.status, 0, `the non-Windows check failed to run: ${result.stderr}`)
  const results = JSON.parse(result.stdout)
  assert.equal(results.length, 3)
  for (const entry of results) {
    assert.equal(entry.available, false, `${entry.name} cannot be available off Windows`)
    assert.equal(entry.reason, 'windows-only', `${entry.name} must say windows-only`)
    assert.equal(entry.code, CODES.CONTROLLER_UNAVAILABLE, `${entry.name} must throw the typed unavailable error`)
    assert.match(entry.message, /Windows only|Windows-only/i)
  }
})
