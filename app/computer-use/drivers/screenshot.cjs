'use strict'

/**
 * Computer Use Runtime: screenshot driver (vision fallback) - plan section 4.2.
 *
 * Pixels are the last resort for perception (plan section 3): the runtime reads
 * the DOM, the accessibility tree and the window list first, and only falls back
 * to an image when nothing structured describes what the user sees. That is
 * exactly why this driver has to be honest. A screenshot driver that returns a
 * black, stale or synthetic buffer is worse than one that reports itself
 * unavailable, because every later verification step would then be deciding on
 * fiction - so every failure here carries the real Windows, PowerShell or GDI
 * text that produced it.
 *
 * Two backends implement the same four methods, tried in order:
 *
 *  1. `koffi` FFI into user32/gdi32. koffi reaches this package as a
 *     *transitive* dependency, so it is loaded lazily, can be injected through
 *     options, and a missing or unusable koffi degrades to backend 2 instead of
 *     failing the module.
 *  2. `screenshot.ps1` next to this file, driven through powershell.exe with a
 *     JSON request file and a temp PNG the script writes for us.
 *
 * Coordinates are always integers in the same physical/virtual pixel space the
 * desktop driver reports, because GDI BitBlt, GetWindowRect and GetSystemMetrics
 * all agree on it inside one process.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { CODES, ComputerUseError } = require('../errors.cjs')
const { SCREENSHOT_DRIVER_METHODS, unavailable } = require('../ports.cjs')
const { encodePng, readPngHeader } = require('../../extensions/mega/theme/png.js')

/** BitBlt raster op: source copy, plus layered windows (SRCCOPY is 0x00CC0020). */
const SRCCOPY = 0x00cc0020
const CAPTUREBLT = 0x40000000
/** GetDIBits wants RGB triples in the DIB colour table. */
const DIB_RGB_COLORS = 0
/** PrintWindow flag that asks for the full window content, not just the frame. */
const PW_RENDERFULLCONTENT = 2

const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

const BACKEND_KOFFI = 'koffi'
const BACKEND_POWERSHELL = 'powershell'

const DEFAULT_TIMEOUT_MS = 15000
/** Extra room for powershell.exe startup on top of the script's own bound. */
const SHELL_GRACE_MS = 5000
const PROBE_PIXELS = 4
/**
 * A window can report an absurd rect (a broken or hostile one reports millions of
 * pixels on a side), and one RGBA buffer of that size would take the whole agent
 * down. 40 megapixels still covers an 8K desktop.
 */
const MAX_CAPTURE_PIXELS = 40000000
const TEXT_SNIPPET = 400

function screenshotFailure(message, details = {}) {
  return new ComputerUseError(CODES.SCREENSHOT_FAILED, message, details)
}

/**
 * A backend failure is one where asking the *other* backend could still succeed:
 * GDI refused, PowerShell is missing, the script returned garbage. The flag is
 * carried in the details so the log says which kind of failure it was.
 */
function backendFailure(message, details = {}) {
  return new ComputerUseError(CODES.SCREENSHOT_FAILED, message, { ...details, backendFailure: true })
}

function isBackendFailure(error) {
  return Boolean(error && error.details && error.details.backendFailure === true)
}

/**
 * Codes that answer "the request itself is impossible", not "this backend could
 * not do it": a dead window handle or an unusable rect would be refused by the
 * other backend in exactly the same words, so retrying would only replace a
 * precise code with a combined, vaguer failure.
 */
const REQUEST_CODES = new Set([CODES.TARGET_NOT_FOUND, CODES.TARGET_INVALID, CODES.CONTRACT_INVALID, CODES.ACTION_UNSUPPORTED])

function isRequestError(error) {
  return Boolean(error && typeof error.code === 'string' && REQUEST_CODES.has(error.code))
}

function errorText(error) {
  if (!error) return 'unknown error'
  return error.message ? String(error.message) : String(error)
}

function snippet(text, max = TEXT_SNIPPET) {
  const value = String(text === undefined || text === null ? '' : text).trim()
  return value.length > max ? `${value.slice(0, max)}...` : value
}

/** `800x600+100+50`, the compact form Windows tools print rects in. */
function formatRect(rect) {
  return `${rect.width}x${rect.height}+${rect.x}+${rect.y}`
}

function toInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isInteger(parsed) ? parsed : null
  }
  return null
}

/** Reads a rect out of untrusted input (a caller, a JSON response). Null if unusable. */
function coerceRect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const x = toInteger(value.x)
  const y = toInteger(value.y)
  const width = toInteger(value.width)
  const height = toInteger(value.height)
  if (x === null || y === null || width === null || height === null) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** The caller-facing rect parser: a bad rect is a request error, not a retry. */
function requireRect(input, label) {
  const rect = coerceRect(input)
  if (!rect) {
    throw screenshotFailure(`${label} needs a rect with integer x, y and positive width, height`, {
      received: input && typeof input === 'object' ? { ...input } : typeof input
    })
  }
  return rect
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function guardCaptureSize(rect, op) {
  const pixels = rect.width * rect.height
  if (pixels > MAX_CAPTURE_PIXELS) {
    throw screenshotFailure(`refusing to capture ${formatRect(rect)} (${pixels} pixels) for ${op}: the limit is ${MAX_CAPTURE_PIXELS} pixels`, {
      op,
      rect,
      pixels,
      limit: MAX_CAPTURE_PIXELS
    })
  }
}

/**
 * Builds the koffi binding table.
 *
 * Every declaration is a real user32/gdi32/kernel32 entry point; nothing is
 * invented and nothing is loaded at module scope, because koffi may simply not
 * be present on this machine.
 *
 * @param {object} koffi the loaded koffi module
 * @returns {object} callable bindings, all taking/returning plain numbers/Buffers
 */
function createNativeApi(koffi) {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  return {
    getSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
    getDC: user32.func('intptr_t GetDC(intptr_t hWnd)'),
    releaseDC: user32.func('int ReleaseDC(intptr_t hWnd, intptr_t hDC)'),
    isWindow: user32.func('bool IsWindow(intptr_t hWnd)'),
    isIconic: user32.func('bool IsIconic(intptr_t hWnd)'),
    getWindowRect: user32.func('bool GetWindowRect(intptr_t hWnd, _Out_ uint8_t *rect)'),
    printWindow: user32.func('bool PrintWindow(intptr_t hWnd, intptr_t hdcBlt, uint32_t nFlags)'),
    createCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t hdc)'),
    saveDC: gdi32.func('int SaveDC(intptr_t hdc)'),
    restoreDC: gdi32.func('bool RestoreDC(intptr_t hdc, int savedDC)'),
    createCompatibleBitmap: gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t hdc, int width, int height)'),
    selectObject: gdi32.func('intptr_t SelectObject(intptr_t hdc, intptr_t handle)'),
    bitBlt: gdi32.func('int BitBlt(intptr_t hdc, int x, int y, int cx, int cy, intptr_t hdcSrc, int srcX, int srcY, uint32_t rop)'),
    getDIBits: gdi32.func('int GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32_t usage)'),
    deleteObject: gdi32.func('int DeleteObject(intptr_t handle)'),
    deleteDC: gdi32.func('int DeleteDC(intptr_t hdc)'),
    getLastError: kernel32.func('uint32_t GetLastError()'),
    formatMessage: kernel32.func('uint32_t FormatMessageW(uint32_t flags, void *source, uint32_t messageId, uint32_t languageId, _Out_ uint8_t *buffer, uint32_t size, void *arguments)')
  }
}

/**
 * Turns the thread's last Win32 error into real text.
 *
 * koffi does not capture GetLastError for us, so it is read straight after the
 * failing call - still in the same thread, still the value that call left there.
 * FormatMessage is best effort: when it has nothing, the numeric code alone is
 * reported rather than a guessed description.
 */
function lastErrorText(api) {
  let code = 0
  try {
    code = api.getLastError()
  } catch {
    return 'win32 error unavailable (GetLastError failed)'
  }
  // A thread that never set an error still reports 0, and FormatMessage would
  // describe that as "the operation completed successfully" - noise, not a reason.
  if (code === 0) return 'no win32 error code was reported'
  try {
    const buffer = Buffer.alloc(2048)
    const fromSystem = 0x00001000
    const ignoreInserts = 0x00000200
    const length = api.formatMessage(fromSystem | ignoreInserts, null, code, 0, buffer, buffer.length / 2, null)
    if (length > 0) {
      const message = buffer.toString('utf16le', 0, length * 2).replace(/[\s\r\n]+$/, '')
      if (message) return `win32 error ${code}: ${message}`
    }
  } catch {
    // The numeric code is real; a missing description is not worth losing it over.
  }
  return `win32 error ${code}`
}

/**
 * Converts the BGRA pixels GetDIBits produced into RGBA, in place.
 *
 * The alpha channel is forced to 255 because GDI never fills it for a BI_RGB
 * DIB: leaving the zeros there would produce a fully transparent screenshot that
 * still decodes as a valid PNG.
 */
function bgraToRgba(pixels) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const blue = pixels[offset]
    pixels[offset] = pixels[offset + 2]
    pixels[offset + 2] = blue
    pixels[offset + 3] = 255
  }
  return pixels
}

/**
 * One GDI capture into a top-down 32bpp DIB.
 *
 * `draw` receives the memory DC (and the screen DC it was derived from) and is
 * responsible for the copy itself; everything else - the compatible DC, the
 * bitmap, the DIB header, the pixel buffer and every cleanup - lives here, so a
 * failing or throwing draw cannot leak a DC, a bitmap or a selection. That
 * matters: this driver runs inside a long-lived agent, where one leaked DC per
 * capture exhausts the process GDI quota within hours.
 *
 * @param {object} api koffi bindings
 * @param {number} width
 * @param {number} height
 * @param {(hdcMem: number, hdcScreen: number) => void} draw
 * @returns {Buffer} RGBA pixels, top row first
 */
function nativeGrab(api, width, height, draw) {
  const hdcScreen = api.getDC(0)
  if (!hdcScreen) {
    throw backendFailure(`GetDC(0) returned no screen device context (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'GetDC' })
  }
  let hdcMem = 0
  let bitmap = 0
  let previous = 0
  let saved = 0
  try {
    hdcMem = api.createCompatibleDC(hdcScreen)
    if (!hdcMem) {
      throw backendFailure(`CreateCompatibleDC refused to create a memory device context (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'CreateCompatibleDC' })
    }
    // SaveDC brackets everything the draw does to this DC, so the state it is
    // handed back in is the state it was found in - including the selection,
    // which SelectObject alone would not repair if the draw threw first.
    saved = api.saveDC(hdcMem)
    bitmap = api.createCompatibleBitmap(hdcScreen, width, height)
    if (!bitmap) {
      throw backendFailure(`CreateCompatibleBitmap refused a ${width}x${height} bitmap (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'CreateCompatibleBitmap', width, height })
    }
    previous = api.selectObject(hdcMem, bitmap)
    if (!previous) {
      throw backendFailure(`SelectObject could not select the ${width}x${height} bitmap into the memory DC (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'SelectObject' })
    }

    draw(hdcMem, hdcScreen)

    // MSDN: the bitmap must not be selected into the DC handed to GetDIBits.
    // RestoreDC drops the selection by putting the DC back to the saved state;
    // SelectObject remains the fallback when SaveDC was refused.
    if (saved && api.restoreDC(hdcMem, saved)) {
      saved = 0
      previous = 0
    } else if (previous) {
      api.selectObject(hdcMem, previous)
      previous = 0
    }

    const info = Buffer.alloc(40 + 16)
    info.writeUInt32LE(40, 0)
    info.writeInt32LE(width, 4)
    // A negative height asks for a top-down DIB, so no row flip is needed later.
    info.writeInt32LE(-height, 8)
    info.writeUInt16LE(1, 12)
    info.writeUInt16LE(32, 14)
    info.writeUInt32LE(0, 16)

    const pixels = Buffer.alloc(width * height * 4)
    const lines = api.getDIBits(hdcMem, bitmap, 0, height, pixels, info, DIB_RGB_COLORS)
    if (lines !== height) {
      throw backendFailure(`GetDIBits copied ${lines} of ${height} scanlines (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'GetDIBits', lines, height })
    }
    return bgraToRgba(pixels)
  } finally {
    // Deselect before deleting: deleting a bitmap that is still selected into a
    // live DC leaves the DC holding a dangling object.
    if (saved) api.restoreDC(hdcMem, saved)
    if (previous) api.selectObject(hdcMem, previous)
    if (bitmap) api.deleteObject(bitmap)
    if (hdcMem) api.deleteDC(hdcMem)
    api.releaseDC(0, hdcScreen)
  }
}

/** Encodes RGBA pixels as the driver's capture result. */
function nativeResult(rect, pixels) {
  return {
    png: encodePng({ width: rect.width, height: rect.height, data: pixels, channels: 4 }),
    width: rect.width,
    height: rect.height,
    rect: { ...rect }
  }
}

/** Screen (or window) copy into a DIB, for regions, monitors and the window fallback. */
function nativeRegionResult(api, rect) {
  const pixels = nativeGrab(api, rect.width, rect.height, (hdcMem, hdcScreen) => {
    if (!api.bitBlt(hdcMem, 0, 0, rect.width, rect.height, hdcScreen, rect.x, rect.y, SRCCOPY | CAPTUREBLT)) {
      throw backendFailure(`BitBlt could not copy ${formatRect(rect)} from the screen (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'BitBlt', rect })
    }
  })
  return nativeResult(rect, pixels)
}

/**
 * Window capture: PrintWindow first, screen copy second.
 *
 * PrintWindow asks the window to render itself, so it still works when the
 * window is occluded by another one - the case where a screen copy would return
 * an image of whatever is on top. When it refuses, a screen copy of the window
 * rect is the documented fallback for a *visible* window; for a minimized one it
 * would return unrelated pixels from wherever that rect now sits, so that case
 * fails with the real reason instead.
 */
function nativeWindowResult(api, hwnd, handleText, rect) {
  const minimized = Boolean(api.isIconic(hwnd))
  let printError = null
  try {
    const pixels = nativeGrab(api, rect.width, rect.height, (hdcMem) => {
      if (!api.printWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)) {
        throw backendFailure(`PrintWindow could not render window ${handleText} (${lastErrorText(api)})`, { backend: BACKEND_KOFFI, stage: 'PrintWindow', handle: handleText })
      }
    })
    return nativeResult(rect, pixels)
  } catch (error) {
    if (!isBackendFailure(error)) throw error
    printError = error
  }
  if (minimized) {
    throw backendFailure(`PrintWindow could not render minimized window ${handleText}, and a screen copy of a minimized window's rect would capture unrelated pixels (${printError.message})`, {
      backend: BACKEND_KOFFI,
      handle: handleText,
      minimized: true,
      rect
    })
  }
  return nativeRegionResult(api, rect)
}

/** The virtual screen rect from user32; throws when the desktop reports nonsense. */
function nativeScreenRect(api) {
  const rect = {
    x: api.getSystemMetrics(SM_XVIRTUALSCREEN),
    y: api.getSystemMetrics(SM_YVIRTUALSCREEN),
    width: api.getSystemMetrics(SM_CXVIRTUALSCREEN),
    height: api.getSystemMetrics(SM_CYVIRTUALSCREEN)
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw backendFailure(`GetSystemMetrics reported a ${rect.width}x${rect.height} virtual screen, so there is no desktop to capture`, { backend: BACKEND_KOFFI, virtualScreen: rect })
  }
  return rect
}

/** The centre of the primary monitor, which is the only rect that is always on-screen. */
function primaryProbeRect(api) {
  const width = api.getSystemMetrics(SM_CXSCREEN)
  const height = api.getSystemMetrics(SM_CYSCREEN)
  if (width <= 0 || height <= 0) {
    throw backendFailure(`GetSystemMetrics reported a ${width}x${height} primary monitor`, { backend: BACKEND_KOFFI })
  }
  return {
    x: Math.floor(width / 2) - Math.floor(PROBE_PIXELS / 2),
    y: Math.floor(height / 2) - Math.floor(PROBE_PIXELS / 2),
    width: PROBE_PIXELS,
    height: PROBE_PIXELS
  }
}

/**
 * Accepts a numeric handle, a decimal or 0x-hex string, or a WindowInfo-like
 * object and produces one normalized target.
 */
function normalizeWindowTarget(input) {
  let raw = input
  let bounds = null
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    raw = input.handle !== undefined ? input.handle : input.hwnd
    const candidate = input.bounds !== undefined ? input.bounds : input.rect
    if (candidate !== undefined && candidate !== null) {
      bounds = coerceRect(candidate)
      if (!bounds) {
        throw new ComputerUseError(CODES.TARGET_INVALID, 'the window bounds must be a rect with integer x, y and positive width, height', { bounds: candidate })
      }
    }
  }
  const handleText = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '')
  if (!handleText) {
    throw new ComputerUseError(CODES.TARGET_INVALID, 'captureWindow needs a window handle (a number, a decimal string or a WindowInfo-like object)', { received: typeof input })
  }
  let handle = null
  if (/^0[xX][0-9a-fA-F]+$/.test(handleText)) handle = Number.parseInt(handleText.slice(2), 16)
  else if (/^\d+$/.test(handleText)) handle = Number(handleText)
  if (handle === null || !Number.isSafeInteger(handle) || handle <= 0) {
    throw new ComputerUseError(CODES.TARGET_INVALID, `window handle '${snippet(handleText, 64)}' is not a usable decimal or 0x-prefixed hexadecimal handle`, { handle: handleText })
  }
  return { handle, handleText, bounds }
}

/**
 * Creates the screenshot driver, the vision fallback of the computer-use runtime.
 *
 * @param {object} [options]
 * @param {() => object} [options.loadKoffi] returns the koffi module; defaults to a
 *   lazy `require('koffi')`. Injected by tests to prove the PowerShell fallback.
 * @param {string} [options.powershell='powershell.exe'] PowerShell host to spawn
 * @param {number} [options.timeoutMs=15000] budget for one PowerShell capture
 * @param {string} [options.scriptPath] absolute path of screenshot.ps1; defaults
 *   to the copy sitting next to this file
 * @returns {{
 *   probe: () => {available: boolean, reason: string|null, detail: object},
 *   captureRegion: (rect: {x: number, y: number, width: number, height: number}) => object,
 *   captureWindow: (target: number|string|{handle: (number|string), bounds?: object}) => object,
 *   captureFull: () => object,
 *   backend: string
 * }}
 */
function createScreenshotDriver(options = {}) {
  // The whole driver is a Win32 surface: on any other platform every method
  // reports the typed unavailable error and probe() answers 'windows-only', so
  // a host can tell "this machine cannot" apart from "this capture failed".
  const isWindows = process.platform === 'win32'
  const powershell = typeof options.powershell === 'string' && options.powershell.trim() ? options.powershell.trim() : 'powershell.exe'
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Math.floor(Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS
  const scriptPath = typeof options.scriptPath === 'string' && options.scriptPath.trim()
    ? path.resolve(options.scriptPath.trim())
    : path.join(__dirname, 'screenshot.ps1')
  const loadKoffi = typeof options.loadKoffi === 'function' ? options.loadKoffi : () => require('koffi')

  /** Refuses the call on a machine that has no user32 to capture from. */
  function requireWindows() {
    if (!isWindows) {
      throw unavailable('screenshot', 'the screenshot driver is Windows only', { platform: process.platform })
    }
  }

  // The preferred backend moves to the front after a success and to the back
  // after a backend-level failure, so a machine where GDI is broken pays for the
  // failing attempt once instead of on every capture.
  const order = [BACKEND_KOFFI, BACKEND_POWERSHELL]
  let nativeState = null
  let cachedVirtualScreen = null

  function promote(backend) {
    const index = order.indexOf(backend)
    if (index > 0) {
      order.splice(index, 1)
      order.unshift(backend)
    }
  }

  function deprioritize(backend) {
    const index = order.indexOf(backend)
    if (index === -1 || index === order.length - 1) return
    order.splice(index, 1)
    order.push(backend)
  }

  /** Loads koffi + the Win32 bindings exactly once; every failure is remembered. */
  function nativeApi() {
    if (!nativeState) {
      if (process.platform !== 'win32') {
        nativeState = { error: `the koffi screenshot backend requires Windows (running on ${process.platform})` }
      } else {
        try {
          nativeState = { api: createNativeApi(loadKoffi()) }
        } catch (error) {
          nativeState = { error: `the koffi screenshot backend is unavailable: ${errorText(error)}` }
        }
      }
    }
    if (!nativeState.api) throw backendFailure(nativeState.error, { backend: BACKEND_KOFFI })
    return nativeState.api
  }

  function peekNativeApi() {
    try {
      return nativeApi()
    } catch {
      return null
    }
  }

  function windowRectFromNative(api, target) {
    const buffer = Buffer.alloc(16)
    if (!api.getWindowRect(target.handle, buffer)) {
      throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `GetWindowRect failed for window ${target.handleText} (${lastErrorText(api)})`, { handle: target.handleText })
    }
    const rect = {
      x: buffer.readInt32LE(0),
      y: buffer.readInt32LE(4),
      width: buffer.readInt32LE(8) - buffer.readInt32LE(0),
      height: buffer.readInt32LE(12) - buffer.readInt32LE(4)
    }
    if (rect.width <= 0 || rect.height <= 0) {
      throw screenshotFailure(`window ${target.handleText} reports an empty rect ${formatRect(rect)}`, { handle: target.handleText, rect })
    }
    return rect
  }

  /**
   * Runs one capture through screenshot.ps1.
   *
   * The handshake is deliberately file based: PowerShell writes the PNG to a
   * private temp directory, we read those bytes and that directory is removed in
   * a finally block, so neither the request nor the image can outlive the call.
   */
  function runPowerShellCapture(request) {
    if (process.platform !== 'win32') {
      throw backendFailure(`the PowerShell screenshot backend requires Windows (running on ${process.platform})`, { backend: BACKEND_POWERSHELL })
    }
    if (!fs.existsSync(scriptPath)) {
      throw backendFailure(`the PowerShell screenshot backend is missing: ${scriptPath} does not exist`, { backend: BACKEND_POWERSHELL, scriptPath })
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-screenshot-'))
    const pngPath = path.join(workDir, 'capture.png')
    const requestPath = path.join(workDir, 'request.json')
    try {
      fs.writeFileSync(requestPath, JSON.stringify({ ...request, path: pngPath, timeoutMs }), 'utf8')
      const result = spawnSync(powershell, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Request',
        requestPath,
        '-TimeoutMs',
        String(timeoutMs)
      ], {
        encoding: 'utf8',
        windowsHide: true,
        // The script enforces its own, smaller bound so a hung desktop produces a
        // real message instead of being killed here with only a timeout to report.
        timeout: timeoutMs + SHELL_GRACE_MS,
        maxBuffer: 8 * 1024 * 1024
      })
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      const stderr = typeof result.stderr === 'string' ? result.stderr : ''
      if (result.error) {
        throw backendFailure(`could not run ${powershell}: ${errorText(result.error)}`, { backend: BACKEND_POWERSHELL, stderr: snippet(stderr) })
      }
      // Diagnostics, Add-Type compiler noise and warnings are expected on stderr;
      // the verdict is the last non-empty stdout line.
      const line = stdout.split(/\r?\n/).filter((entry) => entry.trim() !== '').pop()
      if (!line) {
        throw backendFailure(`screenshot.ps1 wrote no JSON to stdout (exit code ${result.status}): ${snippet(stderr) || 'no stderr output'}`, { backend: BACKEND_POWERSHELL })
      }
      let payload = null
      try {
        payload = JSON.parse(line)
      } catch {
        throw backendFailure(`screenshot.ps1 wrote a stdout line that is not JSON: ${snippet(line)}`, { backend: BACKEND_POWERSHELL, stderr: snippet(stderr) })
      }
      if (!payload || payload.ok !== true) {
        const message = payload && payload.error ? String(payload.error) : `screenshot.ps1 reported failure without a reason: ${snippet(line)}`
        const code = payload && payload.code ? String(payload.code) : null
        if (code === CODES.TARGET_NOT_FOUND || code === CODES.TARGET_INVALID) {
          // Same verdict the native backend would reach: no point retrying it.
          throw new ComputerUseError(code, message, { backend: BACKEND_POWERSHELL, stderr: snippet(stderr) })
        }
        throw backendFailure(message, { backend: BACKEND_POWERSHELL, code, stderr: snippet(stderr) })
      }

      const info = payload.result && typeof payload.result === 'object' ? payload.result : {}
      const reportedPath = typeof info.path === 'string' && info.path.trim() ? info.path : pngPath
      const png = fs.readFileSync(reportedPath)
      const header = readPngHeader(png)
      if (!header) {
        throw backendFailure(`screenshot.ps1 wrote ${png.length} bytes to ${reportedPath} that are not a PNG`, { backend: BACKEND_POWERSHELL, path: reportedPath })
      }
      const rect = coerceRect(info.rect) || (request.rect ? { ...request.rect } : null)
      if (!rect) {
        throw backendFailure('screenshot.ps1 did not report which rect it captured', { backend: BACKEND_POWERSHELL })
      }
      if (header.width !== rect.width || header.height !== rect.height) {
        throw backendFailure(`screenshot.ps1 reported a ${formatRect(rect)} capture but wrote a ${header.width}x${header.height} PNG`, {
          backend: BACKEND_POWERSHELL,
          rect,
          png: { width: header.width, height: header.height }
        })
      }
      return { png, width: header.width, height: header.height, rect, virtualScreen: coerceRect(info.virtualScreen) }
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch {
        // A temp file we could not delete must never replace the real verdict.
      }
    }
  }

  /** The virtual screen rect, from user32 when possible and from the script otherwise. */
  function readVirtualScreen() {
    if (cachedVirtualScreen) return { ...cachedVirtualScreen }
    let nativeMessage = null
    try {
      cachedVirtualScreen = nativeScreenRect(nativeApi())
      return { ...cachedVirtualScreen }
    } catch (error) {
      nativeMessage = errorText(error)
    }
    try {
      // The probe op reports the same four GetSystemMetrics values, so the
      // fallback can clamp without a second, metrics-only op in the script.
      const probed = runPowerShellCapture({ op: 'probe' })
      if (!probed.virtualScreen) throw backendFailure('screenshot.ps1 did not report the virtual screen size', { backend: BACKEND_POWERSHELL })
      cachedVirtualScreen = probed.virtualScreen
      return { ...cachedVirtualScreen }
    } catch (error) {
      throw screenshotFailure(`cannot determine the virtual screen: koffi: ${nativeMessage} | powershell: ${errorText(error)}`, {
        koffi: nativeMessage,
        powershell: errorText(error)
      })
    }
  }

  function captureNative(op, rect, target) {
    const api = nativeApi()
    if (op === 'window') {
      const windowRect = rect || windowRectFromNative(api, target)
      return nativeWindowResult(api, target.handle, target.handleText, windowRect)
    }
    return nativeRegionResult(api, rect)
  }

  function capturePowerShell(op, rect, target) {
    const request = { op }
    if (rect) request.rect = rect
    if (target) request.handle = target.handleText
    return runPowerShellCapture(request)
  }

  function runCapture(op, rect, target) {
    if (rect) guardCaptureSize(rect, op)
    const failures = []
    for (const backend of [...order]) {
      try {
        const captured = backend === BACKEND_KOFFI ? captureNative(op, rect, target) : capturePowerShell(op, rect, target)
        promote(backend)
        return {
          png: captured.png,
          width: captured.width,
          height: captured.height,
          rect: captured.rect,
          backend,
          capturedAt: Date.now()
        }
      } catch (error) {
        // Anything that is not a verdict about the request itself may be a
        // backend that is broken or missing on this machine, so the other one
        // gets its turn before the capture is declared failed.
        if (isRequestError(error)) throw error
        deprioritize(backend)
        failures.push({ backend, message: errorText(error) })
      }
    }
    throw screenshotFailure(`the ${op} capture failed on every backend: ${failures.map((entry) => `${entry.backend}: ${entry.message}`).join(' | ')}`, {
      op,
      rect: rect || null,
      handle: target ? target.handleText : null,
      attempts: failures
    })
  }

  /**
   * Captures a screen region, clamped to the virtual screen.
   *
   * Clamping is not cosmetic: a caller that asks for a rect from a stale layout
   * can name coordinates that no longer exist, and silently returning a smaller
   * or offset image would make every later pixel comparison a lie. The returned
   * `rect` is the rect that was really captured.
   *
   * @param {{x: number, y: number, width: number, height: number}} region
   * @returns {{png: Buffer, width: number, height: number, rect: object, backend: string, capturedAt: number}}
   */
  function captureRegion(region = {}) {
    requireWindows()
    const requested = requireRect(region, 'captureRegion')
    const screen = readVirtualScreen()
    const clamped = intersectRect(requested, screen)
    if (!clamped) {
      throw screenshotFailure(`the requested region ${formatRect(requested)} does not intersect the virtual screen ${formatRect(screen)}`, {
        requested,
        virtualScreen: screen
      })
    }
    return runCapture('region', clamped, null)
  }

  /**
   * Captures a window through its own handle.
   *
   * @param {number|string|{handle: number|string, bounds?: object}} input a window
   *   handle (number, decimal or 0x-prefixed string) or a WindowInfo-like object.
   *   `bounds` is honoured as the capture rect when the caller already knows the
   *   visible frame; otherwise the window rect is read from user32.
   * @returns {{png: Buffer, width: number, height: number, rect: object, backend: string, capturedAt: number}}
   */
  function captureWindow(input) {
    requireWindows()
    const target = normalizeWindowTarget(input)
    let rect = target.bounds
    const api = peekNativeApi()
    if (api) {
      // A dead handle is a request error, not a backend one: the script would
      // answer exactly the same, so it must not be retried on the other backend.
      if (!api.isWindow(target.handle)) {
        throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `no window exists for handle ${target.handleText}`, { handle: target.handleText })
      }
      if (!rect) rect = windowRectFromNative(api, target)
    }
    return runCapture('window', rect, target)
  }

  /**
   * Captures every monitor at once (the whole virtual screen, negative origin
   * included).
   *
   * @returns {{png: Buffer, width: number, height: number, rect: object, backend: string, capturedAt: number}}
   */
  function captureFull() {
    requireWindows()
    return runCapture('monitor', readVirtualScreen(), null)
  }

  /**
   * Proves the driver can really capture on this machine by capturing a 4x4
   * region at the centre of the primary monitor - a corner of the virtual screen
   * would be off-screen on a multi-monitor layout with a negative origin.
   *
   * This never throws: an unavailable verdict carrying the real Windows error is
   * what the runtime routes around, and a session without an interactive desktop
   * (a service, a disconnected RDP session) is a legitimate reason for one.
   *
   * @returns {{available: boolean, reason: string|null, detail: {backend: string|null, width: number, height: number, bytes: number, virtualScreen: object|null}}}
   */
  function probe() {
    const detail = { backend: null, width: 0, height: 0, bytes: 0, virtualScreen: null }
    if (!isWindows) {
      return { available: false, reason: 'windows-only', detail: { ...detail, platform: process.platform } }
    }
    const failures = []
    try {
      try {
        const api = nativeApi()
        const screen = nativeScreenRect(api)
        const captured = nativeRegionResult(api, primaryProbeRect(api))
        promote(BACKEND_KOFFI)
        cachedVirtualScreen = screen
        return {
          available: true,
          reason: null,
          detail: { backend: BACKEND_KOFFI, width: captured.width, height: captured.height, bytes: captured.png.length, virtualScreen: screen }
        }
      } catch (error) {
        deprioritize(BACKEND_KOFFI)
        failures.push(`${BACKEND_KOFFI}: ${errorText(error)}`)
      }
      try {
        const captured = runPowerShellCapture({ op: 'probe' })
        promote(BACKEND_POWERSHELL)
        if (captured.virtualScreen) cachedVirtualScreen = captured.virtualScreen
        return {
          available: true,
          reason: null,
          detail: { backend: BACKEND_POWERSHELL, width: captured.width, height: captured.height, bytes: captured.png.length, virtualScreen: captured.virtualScreen }
        }
      } catch (error) {
        deprioritize(BACKEND_POWERSHELL)
        failures.push(`${BACKEND_POWERSHELL}: ${errorText(error)}`)
      }
      return { available: false, reason: `no screenshot backend could capture: ${failures.join(' | ')}`, detail: { ...detail } }
    } catch (error) {
      // A probe answers with a verdict, always.
      return { available: false, reason: `the screenshot probe itself failed: ${errorText(error)}`, detail: { ...detail } }
    }
  }

  const driver = { probe, captureRegion, captureWindow, captureFull }

  // Declared after the fact so the property is always the backend that would be
  // tried first right now, not the one that happened to load at construction.
  Object.defineProperty(driver, 'backend', {
    enumerable: true,
    get() {
      return peekNativeApi() ? order[0] : BACKEND_POWERSHELL
    }
  })

  // The runtime asserts the whole documented surface; failing here would be a
  // wiring bug, so the check is cheap and loud.
  const missing = SCREENSHOT_DRIVER_METHODS.filter((method) => typeof driver[method] !== 'function')
  if (missing.length) throw screenshotFailure(`the screenshot driver is missing required method(s): ${missing.join(', ')}`, { missing })

  return driver
}

module.exports = { createScreenshotDriver }
