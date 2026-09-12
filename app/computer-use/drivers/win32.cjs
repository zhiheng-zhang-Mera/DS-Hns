'use strict'

/**
 * Computer Use Runtime: the Windows desktop driver (plan §27).
 *
 * WHAT THIS IS
 * A real implementation of DESKTOP_DRIVER_METHODS on top of user32/kernel32:
 * window enumeration and manipulation, focus, absolute-pointer input, Unicode
 * typing, hotkeys, the clipboard and screen metrics. Nothing here is simulated
 * and nothing is cached from a previous machine state: every call reads or
 * writes the live desktop.
 *
 * WHY THERE ARE TWO BACKENDS
 * The primary backend is koffi FFI, which is fast (in-process, no per-call
 * process spawn) and marshals the INPUT structs exactly as SendInput wants
 * them. koffi is NOT a declared dependency of this repository - it is present
 * transitively and could legitimately disappear after a prune, a dedupe or a
 * failed native build - so it is loaded lazily inside try/catch and a
 * PowerShell 5.1 fallback (win32-input.ps1, P/Invoke through Add-Type) takes
 * over when it is missing. The fallback is slower, not weaker: both backends
 * implement the same low-level surface and the same filtering rules.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * `typeText` never goes through the clipboard. A clipboard round trip is
 * observable by every other process, destroys whatever the user had copied and
 * breaks on non-text clipboards; KEYEVENTF_UNICODE types the real code units
 * instead. Clipboard access exists as its own explicit pair of methods.
 *
 * All coordinates in and out are integers in PHYSICAL pixels; SendInput's
 * normalised 0..65535 space is an internal detail of the pointer path. Window
 * handles leave this module as decimal strings, because a handle is an opaque
 * identity, not a number to do arithmetic on.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { unavailable } = require('../ports.cjs')

const SCRIPT_PATH = path.join(__dirname, 'win32-input.ps1')
const IS_WINDOWS = process.platform === 'win32'

/** SendInput batches are chunked: one giant call is harder to reason about than several bounded ones. */
const INPUT_CHUNK = 64

/** A window title longer than this is not a title, it is a misbehaving application. */
const MAX_TITLE_LENGTH = 1024

const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const GW_OWNER = 4

const WM_CLOSE = 0x0010
const SW_RESTORE = 9
const SWP_NOSIZE = 0x0001
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010

const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const SM_CMONITORS = 80

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002
const GMEM_ZEROINIT = 0x0040
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

const MOUSEEVENTF = {
  MOVE: 0x0001,
  LEFT_DOWN: 0x0002,
  LEFT_UP: 0x0004,
  RIGHT_DOWN: 0x0008,
  RIGHT_UP: 0x0010,
  MIDDLE_DOWN: 0x0020,
  MIDDLE_UP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
  ABSOLUTE: 0x8000,
  VIRTUAL_DESK: 0x4000
}

const KEYEVENTF = {
  EXTENDED: 0x0001,
  KEYUP: 0x0002,
  UNICODE: 0x0004
}

const WHEEL_DELTA = 120

/**
 * Shell and XAML host window classes that are "visible" and often titled but
 * are not windows a user thinks of as windows. Listing them makes every
 * controller see phantom targets, so they are filtered by class - and Explorer's
 * real windows (CabinetWClass, ExploreWClass) are deliberately NOT in this set.
 *
 * 'ApplicationFrameWindow' is deliberately absent: it is the real top-level
 * window of a UWP application, and the untitled XAML leftovers that must be
 * skipped are already excluded by the "a window needs a title" rule below.
 */
const SHELL_WINDOW_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'Windows.UI.Composition.DesktopWindowContentBridge',
  'ForegroundStaging',
  'MultitaskingViewFrame',
  'XamlExplorerHostIslandWindow',
  'SysShadow',
  'TaskListThumbnailWnd',
  'NarratorHelperWindow',
  'DV2ControlHost'
])

/** Virtual-key codes for the named keys. OEM punctuation follows the US layout, as VK codes always do. */
const NAMED_VIRTUAL_KEYS = Object.freeze({
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  menu: 0x12,
  pause: 0x13,
  capslock: 0x14,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  printscreen: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  lwin: 0x5b,
  rwin: 0x5c,
  apps: 0x5d,
  numlock: 0x90,
  scrolllock: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde
})

/** Keys that a hotkey holds down instead of tapping. */
const MODIFIER_KEYS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'lwin', 'rwin'])

/** Keys that SendInput must mark as extended or the numpad twin arrives instead. */
const EXTENDED_KEYS = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x90])

const BUTTON_FLAGS = Object.freeze({
  left: { down: MOUSEEVENTF.LEFT_DOWN, up: MOUSEEVENTF.LEFT_UP },
  right: { down: MOUSEEVENTF.RIGHT_DOWN, up: MOUSEEVENTF.RIGHT_UP },
  middle: { down: MOUSEEVENTF.MIDDLE_DOWN, up: MOUSEEVENTF.MIDDLE_UP }
})

/**
 * Maps a portable key name to a Windows virtual-key code.
 *
 * The names are the ones a task author writes ('enter', 'pageup', 'f1'…); the
 * single-character form covers letters, digits and the US-layout punctuation
 * keys. Unicode text does NOT go through this mapping - `typeText` uses
 * KEYEVENTF_UNICODE - so a non-US layout only affects hotkeys, which is
 * exactly where the operating system itself defines keys by virtual code.
 *
 * @param {string} name
 * @returns {number} virtual-key code
 * @throws {ComputerUseError} ACTION_UNSUPPORTED for a name that maps to nothing
 */
function resolveVirtualKey(name) {
  if (typeof name === 'number' && Number.isInteger(name)) return name
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ComputerUseError(CODES.ACTION_INVALID, `key name must be a non-empty string, got ${JSON.stringify(name)}`)
  }
  const key = name.trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(NAMED_VIRTUAL_KEYS, key)) return NAMED_VIRTUAL_KEYS[key]
  if (key.length === 1) {
    const code = key.charCodeAt(0)
    if (code >= 97 && code <= 122) return code - 32
    if (code >= 48 && code <= 57) return code
    if (code === 32) return 0x20
  }
  const functionKey = /^f([1-9]|1[0-2])$/.exec(key)
  if (functionKey) return 0x6f + Number(functionKey[1])
  const numpadKey = /^numpad([0-9])$/.exec(key)
  if (numpadKey) return 0x60 + Number(numpadKey[1])
  throw new ComputerUseError(CODES.ACTION_UNSUPPORTED, `unsupported key name: ${name}`, { key: name })
}

/** True when the key holds down for a chord instead of being tapped. */
function isModifierKey(name) {
  return typeof name === 'string' && MODIFIER_KEYS.has(name.trim().toLowerCase())
}

/**
 * Builds the exact event sequence of a hotkey: modifiers down in the order they
 * were named, the payload tapped, modifiers released in reverse.
 *
 * The order is not cosmetic. Releasing in the order given (or releasing the
 * payload last) leaves the modifier logically held for the next keystroke on
 * some IMEs and on remote-desktop input paths, and a controller that then types
 * text produces a stream of shortcuts instead of text.
 *
 * @param {Array<string|number>} keys
 * @returns {Array<{action: 'down'|'up'|'tap', name: string, vk: number}>}
 */
function composeHotkey(keys) {
  const names = normalizeKeyList(keys)
  const events = []
  const held = []
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    const vk = resolveVirtualKey(name)
    if (isModifierKey(name) && index < names.length - 1) {
      events.push({ action: 'down', name, vk })
      held.push({ name, vk })
    } else {
      events.push({ action: 'tap', name, vk })
    }
  }
  for (let index = held.length - 1; index >= 0; index -= 1) {
    events.push({ action: 'up', name: held[index].name, vk: held[index].vk })
  }
  return events
}

/** Accepts a single key name or an array of names. */
function normalizeKeyList(keys) {
  const list = Array.isArray(keys) ? keys : [keys]
  if (list.length === 0) {
    throw new ComputerUseError(CODES.ACTION_INVALID, 'a key sequence needs at least one key')
  }
  return list.map((item) => {
    if (typeof item === 'number' && Number.isInteger(item)) return item
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ComputerUseError(CODES.ACTION_INVALID, `invalid key entry: ${JSON.stringify(item)}`)
    }
    return item.trim()
  })
}

/** A synchronous bounded sleep: the FFI path cannot await between SendInput batches. */
function sleepSync(ms) {
  if (!(ms > 0)) return
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, Math.min(ms, 5000))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rounds to a physical pixel and refuses values that are not finite numbers. */
function toInt(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new ComputerUseError(CODES.ACTION_INVALID, `${label} must be a finite number, got ${JSON.stringify(value)}`)
  }
  return Math.round(number)
}

function toPositiveInt(value, label) {
  const number = toInt(value, label)
  if (number <= 0) {
    throw new ComputerUseError(CODES.ACTION_INVALID, `${label} must be positive, got ${number}`)
  }
  return number
}

/** Window handles are opaque identities; they leave this module as decimal strings. */
function formatHandle(handle) {
  if (handle === null || handle === undefined) return null
  const value = typeof handle === 'bigint' ? Number(handle) : Number(handle)
  if (!Number.isFinite(value) || value <= 0) return null
  return String(Math.trunc(value))
}

/**
 * Accepts every shape a caller may hand over (a decimal string, a hex string, a
 * number, or a WindowInfo object) and returns the numeric handle.
 *
 * @param {number|string|{handle?: number|string}} value
 * @returns {number}
 */
function normalizeHandle(value) {
  let raw = value
  if (raw && typeof raw === 'object') raw = raw.handle !== undefined ? raw.handle : raw.hwnd
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  throw new ComputerUseError(CODES.ACTION_INVALID, `not a window handle: ${JSON.stringify(value)}`)
}

/** True when a window belongs in the user-facing list. Exported for tests through __internal. */
function shouldListWindow(info, options = {}) {
  if (!info || info.handle === null) return false
  if (!options.includeInvisible && !info.visible) return false
  const title = typeof info.title === 'string' ? info.title.trim() : ''
  // An untitled window is a helper: this is also what removes the empty
  // ApplicationFrameWindow shells that Windows keeps around for closed UWP apps.
  if (!options.includeUntitled && title === '') return false
  if (!options.includeToolWindows && (info.extendedStyle & WS_EX_TOOLWINDOW) !== 0) return false
  if (info.cloaked && !options.includeCloaked) return false
  if (SHELL_WINDOW_CLASSES.has(info.className)) return Boolean(options.includeShellWindows)
  return true
}

/** Drops the diagnostic fields that are not part of the WindowInfo contract. */
function toWindowInfo(raw) {
  return {
    handle: raw.handle,
    title: raw.title,
    className: raw.className,
    processId: raw.processId,
    processName: raw.processName === undefined ? null : raw.processName,
    bounds: raw.bounds,
    visible: Boolean(raw.visible),
    minimized: Boolean(raw.minimized),
    foreground: Boolean(raw.foreground),
    ownerHandle: raw.ownerHandle === undefined ? null : raw.ownerHandle
  }
}

/**
 * Loads koffi lazily. It is a transitive dependency, so a missing or broken
 * native module must degrade to the PowerShell backend instead of exploding at
 * require time.
 *
 * @param {object} [options]
 * @param {Function} [options.loadKoffi] injection point for tests
 * @returns {{ koffi: object|null, error: string|null, version: string|null }}
 */
function loadKoffi(options = {}) {
  const loader = typeof options.loadKoffi === 'function' ? options.loadKoffi : () => require('koffi')
  try {
    const koffi = loader()
    if (!koffi || typeof koffi.load !== 'function') {
      return { koffi: null, error: 'the koffi module did not expose load()', version: null }
    }
    return { koffi, error: null, version: typeof koffi.version === 'string' ? koffi.version : null }
  } catch (error) {
    return { koffi: null, error: error && error.message ? error.message : String(error), version: null }
  }
}

/**
 * The koffi backend: every desktop primitive expressed as a direct FFI call.
 *
 * @param {object} koffi the loaded koffi module
 * @returns {object} the low-level backend
 */
function createKoffiBackend(koffi) {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // dwmapi only answers "is this window cloaked"; losing it costs precision in
  // the window list, not the ability to run, so it is bound best-effort.
  let dwmGetWindowAttribute = null
  try {
    const dwmapi = koffi.load('dwmapi.dll')
    dwmGetWindowAttribute = dwmapi.func('int DwmGetWindowAttribute(uintptr_t hwnd, uint32 attribute, _Out_ int *value, uint32 size)')
  } catch {
    dwmGetWindowAttribute = null
  }

  const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)')
  const MonitorEnumProc = koffi.proto('bool MonitorEnumProc(uintptr_t hMonitor, uintptr_t hdc, void *clip, intptr_t data)')

  // Types must exist before any prototype mentions them: koffi resolves the
  // names inside a signature string at bind time, not at first call.
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
  const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' })
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  })
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
  const INPUTUNION = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION })
  const INPUT_SIZE = koffi.sizeof(INPUT)

  const api = {
    EnumWindows: user32.func('bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)'),
    GetWindowTextW: user32.func('int GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
    GetClassNameW: user32.func('int GetClassNameW(uintptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
    IsWindowVisible: user32.func('bool IsWindowVisible(uintptr_t hWnd)'),
    IsWindow: user32.func('bool IsWindow(uintptr_t hWnd)'),
    IsIconic: user32.func('bool IsIconic(uintptr_t hWnd)'),
    GetWindowRect: user32.func('bool GetWindowRect(uintptr_t hWnd, _Out_ RECT *lpRect)'),
    GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(uintptr_t hWnd)'),
    ShowWindow: user32.func('bool ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    SetWindowPos: user32.func('bool SetWindowPos(uintptr_t hWnd, uintptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
    PostMessageW: user32.func('bool PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wParam, uintptr_t lParam)'),
    GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)'),
    GetWindow: user32.func('uintptr_t GetWindow(uintptr_t hWnd, uint32 cmd)'),
    GetWindowLongPtrW: user32.func('intptr_t GetWindowLongPtrW(uintptr_t hWnd, int index)'),
    GetSystemMetrics: user32.func('int GetSystemMetrics(int index)'),
    GetCursorPos: user32.func('bool GetCursorPos(_Out_ POINT *point)'),
    SetCursorPos: user32.func('bool SetCursorPos(int x, int y)'),
    SendInput: user32.func('uint32 SendInput(uint32 count, INPUT *inputs, int size)'),
    MapVirtualKeyW: user32.func('uint32 MapVirtualKeyW(uint32 code, uint32 mapType)'),
    EnumDisplayMonitors: user32.func('bool EnumDisplayMonitors(uintptr_t hdc, void *clip, MonitorEnumProc *callback, intptr_t data)'),
    GetMonitorInfoW: user32.func('bool GetMonitorInfoW(uintptr_t monitor, _Inout_ MONITORINFO *info)'),
    OpenClipboard: user32.func('bool OpenClipboard(uintptr_t owner)'),
    CloseClipboard: user32.func('bool CloseClipboard()'),
    EmptyClipboard: user32.func('bool EmptyClipboard()'),
    GetClipboardData: user32.func('uintptr_t GetClipboardData(uint32 format)'),
    SetClipboardData: user32.func('uintptr_t SetClipboardData(uint32 format, uintptr_t memory)'),
    OpenProcess: kernel32.func('uintptr_t OpenProcess(uint32 access, bool inherit, uint32 processId)'),
    CloseHandle: kernel32.func('bool CloseHandle(uintptr_t handle)'),
    QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(uintptr_t process, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32 *size)'),
    GlobalAlloc: kernel32.func('uintptr_t GlobalAlloc(uint32 flags, size_t bytes)'),
    GlobalFree: kernel32.func('uintptr_t GlobalFree(uintptr_t memory)'),
    GlobalLock: kernel32.func('void *GlobalLock(uintptr_t memory)'),
    GlobalUnlock: kernel32.func('bool GlobalUnlock(uintptr_t memory)')
  }

  // Reused scratch buffers: allocating per window would make enumeration the
  // dominant cost of every observation loop.
  const textBuffer = koffi.alloc('uint16_t', MAX_TITLE_LENGTH)
  const classBuffer = koffi.alloc('uint16_t', 256)
  const pathBuffer = koffi.alloc('uint16_t', 1024)

  function readWindowText(handle) {
    const length = api.GetWindowTextW(handle, textBuffer, MAX_TITLE_LENGTH)
    if (length <= 0) return ''
    return koffi.decode.string16(textBuffer, length)
  }

  function readClassName(handle) {
    const length = api.GetClassNameW(handle, classBuffer, 256)
    if (length <= 0) return ''
    return koffi.decode.string16(classBuffer, length)
  }

  function readProcessId(handle) {
    const out = [0]
    api.GetWindowThreadProcessId(handle, out)
    return out[0] >>> 0
  }

  function readProcessName(processId) {
    const process = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId)
    if (!process) return null
    try {
      const size = [1024]
      if (!api.QueryFullProcessImageNameW(process, 0, pathBuffer, size)) return null
      return koffi.decode.string16(pathBuffer, size[0])
    } catch {
      return null
    } finally {
      api.CloseHandle(process)
    }
  }

  function readBounds(handle) {
    const rect = {}
    if (!api.GetWindowRect(handle, rect)) return { x: 0, y: 0, width: 0, height: 0 }
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
  }

  function isCloaked(handle) {
    if (!dwmGetWindowAttribute) return false
    try {
      const out = {}
      const DWMWA_CLOAKED = 14
      if (dwmGetWindowAttribute(handle, DWMWA_CLOAKED, out, 4) !== 0) return false
      return out[0] !== 0
    } catch {
      return false
    }
  }

  function readScreenMetrics() {
    const virtualScreen = {
      x: api.GetSystemMetrics(SM_XVIRTUALSCREEN),
      y: api.GetSystemMetrics(SM_YVIRTUALSCREEN),
      width: api.GetSystemMetrics(SM_CXVIRTUALSCREEN),
      height: api.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    }
    const monitors = []
    const callback = koffi.register((monitor) => {
      // A throwing callback would unwind through C frames; nothing here may throw.
      const info = { cbSize: koffi.sizeof(MONITORINFO) }
      if (api.GetMonitorInfoW(monitor, info)) {
        monitors.push({
          handle: formatHandle(monitor),
          bounds: {
            x: info.rcMonitor.left,
            y: info.rcMonitor.top,
            width: info.rcMonitor.right - info.rcMonitor.left,
            height: info.rcMonitor.bottom - info.rcMonitor.top
          },
          workArea: {
            x: info.rcWork.left,
            y: info.rcWork.top,
            width: info.rcWork.right - info.rcWork.left,
            height: info.rcWork.bottom - info.rcWork.top
          },
          primary: (info.dwFlags & 1) !== 0
        })
      }
      return true
    }, koffi.pointer(MonitorEnumProc))
    try {
      api.EnumDisplayMonitors(0, null, callback, 0)
    } finally {
      koffi.unregister(callback)
    }
    const cursor = {}
    const hasCursor = api.GetCursorPos(cursor)
    return {
      virtualScreen,
      primary: { x: 0, y: 0, width: api.GetSystemMetrics(SM_CXSCREEN), height: api.GetSystemMetrics(SM_CYSCREEN) },
      monitors,
      cursor: hasCursor ? { x: cursor.x, y: cursor.y } : null,
      metrics: {
        screenWidth: api.GetSystemMetrics(SM_CXSCREEN),
        screenHeight: api.GetSystemMetrics(SM_CYSCREEN),
        monitorCount: api.GetSystemMetrics(SM_CMONITORS)
      }
    }
  }

  /**
   * Absolute pointer coordinates are a fraction of the virtual desktop, not
   * pixels. The 65535/(size-1) form is the documented mapping; on a desktop
   * whose monitors do not tile the virtual rectangle (a scaled primary next to
   * a larger second monitor, for instance) the round trip Windows performs can
   * land one pixel away, which no formula fixes because the coordinate space is
   * genuinely sparse. Clicking is unaffected: a target is never one pixel wide.
   */
  function toAbsolute(x, y) {
    const virtualScreen = readScreenMetrics().virtualScreen
    const width = Math.max(1, virtualScreen.width - 1)
    const height = Math.max(1, virtualScreen.height - 1)
    const nx = Math.round(((x - virtualScreen.x) * 65535) / width)
    const ny = Math.round(((y - virtualScreen.y) * 65535) / height)
    return { nx: Math.min(65535, Math.max(0, nx)), ny: Math.min(65535, Math.max(0, ny)) }
  }

  const moveFlags = MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUAL_DESK

  /** Marshals INPUT structs into one buffer and hands them to SendInput in bounded batches. */
  function sendInputs(entries) {
    let sent = 0
    for (let offset = 0; offset < entries.length; offset += INPUT_CHUNK) {
      const chunk = entries.slice(offset, offset + INPUT_CHUNK)
      const buffer = Buffer.alloc(INPUT_SIZE * chunk.length)
      chunk.forEach((entry, index) => koffi.encode(buffer, index * INPUT_SIZE, INPUT, entry))
      const accepted = api.SendInput(chunk.length, buffer, INPUT_SIZE)
      if (accepted !== chunk.length) {
        throw new ComputerUseError(
          CODES.CONTROLLER_FAILED,
          `SendInput accepted ${accepted} of ${chunk.length} events; an elevated window (UIPI) or a locked workstation rejects injected input`,
          { accepted, requested: chunk.length }
        )
      }
      sent += accepted
    }
    return sent
  }

  function mouseEntry(dx, dy, mouseData, flags) {
    return { type: 0, u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  function keyEntry(vk, keyUp) {
    let flags = keyUp ? KEYEVENTF.KEYUP : 0
    if (EXTENDED_KEYS.has(vk)) flags |= KEYEVENTF.EXTENDED
    const scan = api.MapVirtualKeyW(vk, 0)
    return { type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  function unicodeEntry(codeUnit, keyUp) {
    const flags = KEYEVENTF.UNICODE | (keyUp ? KEYEVENTF.KEYUP : 0)
    return { type: 1, u: { ki: { wVk: 0, wScan: codeUnit, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  function withClipboard(action) {
    // The clipboard is a machine-wide lock: another process can hold it for a
    // few milliseconds, so a bounded retry is the honest fix, not an error.
    let opened = false
    for (let attempt = 0; attempt < 5 && !opened; attempt += 1) {
      opened = Boolean(api.OpenClipboard(0))
      if (!opened) sleepSync(20)
    }
    if (!opened) {
      throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'OpenClipboard failed: another process is holding the clipboard')
    }
    try {
      return action()
    } finally {
      api.CloseClipboard()
    }
  }

  return {
    name: 'koffi',
    koffiVersion: typeof koffi.version === 'string' ? koffi.version : null,
    clipboard: 'koffi',

    listWindows(options = {}) {
      const handles = []
      const callback = koffi.register((handle) => {
        // Collecting raw handles only: a property read here would run inside a
        // native callback frame, where a throw is not recoverable.
        handles.push(Number(handle))
        return true
      }, koffi.pointer(EnumWindowsProc))
      try {
        api.EnumWindows(callback, 0)
      } finally {
        koffi.unregister(callback)
      }
      const foreground = Number(api.GetForegroundWindow())
      const windows = []
      for (const handle of handles) {
        if (!api.IsWindow(handle)) continue
        const raw = {
          handle: formatHandle(handle),
          title: readWindowText(handle),
          className: readClassName(handle),
          processId: readProcessId(handle),
          bounds: readBounds(handle),
          visible: Boolean(api.IsWindowVisible(handle)),
          minimized: Boolean(api.IsIconic(handle)),
          foreground: handle === foreground,
          ownerHandle: formatHandle(Number(api.GetWindow(handle, GW_OWNER))) || '0',
          extendedStyle: Number(api.GetWindowLongPtrW(handle, GWL_EXSTYLE)),
          cloaked: isCloaked(handle)
        }
        raw.processName = readProcessName(raw.processId)
        if (!shouldListWindow(raw, options)) continue
        windows.push(toWindowInfo(raw))
      }
      return windows
    },

    foregroundWindow() {
      const handle = Number(api.GetForegroundWindow())
      if (!handle || !api.IsWindow(handle)) return null
      return toWindowInfo({
        handle: formatHandle(handle),
        title: readWindowText(handle),
        className: readClassName(handle),
        processId: readProcessId(handle),
        processName: readProcessName(readProcessId(handle)),
        bounds: readBounds(handle),
        visible: Boolean(api.IsWindowVisible(handle)),
        minimized: Boolean(api.IsIconic(handle)),
        foreground: true,
        ownerHandle: formatHandle(Number(api.GetWindow(handle, GW_OWNER))) || '0'
      })
    },

    focusWindow(handle, { restore = true } = {}) {
      if (!api.IsWindow(handle)) {
        throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle: formatHandle(handle) })
      }
      if (restore && api.IsIconic(handle)) api.ShowWindow(handle, SW_RESTORE)
      const requested = Boolean(api.SetForegroundWindow(handle))
      sleepSync(60)
      const foreground = Number(api.GetForegroundWindow())
      return {
        requested,
        focused: foreground === handle,
        foreground: formatHandle(foreground),
        // Windows refuses SetForegroundWindow when another process owns the
        // foreground lock; reporting that truthfully is more useful than a
        // retry loop that eventually lies.
        note: foreground === handle ? null : 'the foreground lock is held by another window; the request was issued but not granted'
      }
    },

    closeWindow(handle) {
      if (!api.IsWindow(handle)) {
        throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle: formatHandle(handle) })
      }
      const posted = Boolean(api.PostMessageW(handle, WM_CLOSE, 0, 0))
      return { posted, handle: formatHandle(handle) }
    },

    moveWindow(handle, bounds) {
      if (!api.IsWindow(handle)) {
        throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle: formatHandle(handle) })
      }
      const current = readBounds(handle)
      const x = bounds.x === undefined ? current.x : toInt(bounds.x, 'x')
      const y = bounds.y === undefined ? current.y : toInt(bounds.y, 'y')
      let width = bounds.width === undefined ? current.width : toInt(bounds.width, 'width')
      let height = bounds.height === undefined ? current.height : toInt(bounds.height, 'height')
      let flags = SWP_NOZORDER | SWP_NOACTIVATE
      if (width <= 0 || height <= 0) {
        width = current.width
        height = current.height
        flags |= SWP_NOSIZE
      }
      const moved = Boolean(api.SetWindowPos(handle, 0, x, y, width, height, flags))
      return { moved, bounds: readBounds(handle) }
    },

    cursorPosition() {
      const point = {}
      if (!api.GetCursorPos(point)) {
        throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'GetCursorPos failed: there is no interactive desktop')
      }
      return { x: point.x, y: point.y }
    },

    moveMouse(x, y) {
      const target = toAbsolute(x, y)
      const accepted = sendInputs([mouseEntry(target.nx, target.ny, 0, moveFlags)])
      return { x: toInt(x, 'x'), y: toInt(y, 'y'), accepted }
    },

    click({ x, y, button = 'left', clicks = 1 }) {
      const flags = BUTTON_FLAGS[button]
      if (!flags) {
        throw new ComputerUseError(CODES.ACTION_INVALID, `unsupported mouse button: ${button}`, { button })
      }
      const count = Math.max(1, toInt(clicks, 'clicks'))
      const target = toAbsolute(x, y)
      const entries = [mouseEntry(target.nx, target.ny, 0, moveFlags)]
      for (let index = 0; index < count; index += 1) {
        entries.push(mouseEntry(target.nx, target.ny, 0, moveFlags | flags.down))
        entries.push(mouseEntry(target.nx, target.ny, 0, moveFlags | flags.up))
      }
      sendInputs(entries)
      return { x: toInt(x, 'x'), y: toInt(y, 'y'), button, clicks: count }
    },

    drag({ fromX, fromY, toX, toY, button = 'left', durationMs = 300 }) {
      const flags = BUTTON_FLAGS[button]
      if (!flags) {
        throw new ComputerUseError(CODES.ACTION_INVALID, `unsupported mouse button: ${button}`, { button })
      }
      const start = toAbsolute(fromX, fromY)
      const end = toAbsolute(toX, toY)
      const entries = [
        mouseEntry(start.nx, start.ny, 0, moveFlags),
        mouseEntry(start.nx, start.ny, 0, moveFlags | flags.down)
      ]
      // Applications sample the pointer path, so the move is interpolated; a
      // teleporting drag is not a drag and gets ignored by drop targets.
      const steps = Math.max(1, Math.round(Math.max(1, toInt(durationMs, 'durationMs')) / 16))
      for (let index = 1; index <= steps; index += 1) {
        const nx = Math.round(start.nx + ((end.nx - start.nx) * index) / steps)
        const ny = Math.round(start.ny + ((end.ny - start.ny) * index) / steps)
        entries.push(mouseEntry(nx, ny, 0, moveFlags))
      }
      entries.push(mouseEntry(end.nx, end.ny, 0, moveFlags | flags.up))
      sendInputs(entries)
      return { from: { x: toInt(fromX, 'fromX'), y: toInt(fromY, 'fromY') }, to: { x: toInt(toX, 'toX'), y: toInt(toY, 'toY') }, button, steps }
    },

    scroll({ x, y, delta, horizontal = false }) {
      const amount = toInt(delta, 'delta')
      if (amount === 0) {
        throw new ComputerUseError(CODES.ACTION_INVALID, 'scroll needs a non-zero delta')
      }
      const entries = []
      if (x !== undefined && y !== undefined) {
        const target = toAbsolute(toInt(x, 'x'), toInt(y, 'y'))
        entries.push(mouseEntry(target.nx, target.ny, 0, moveFlags))
      }
      const flag = horizontal ? MOUSEEVENTF.HWHEEL : MOUSEEVENTF.WHEEL
      entries.push(mouseEntry(0, 0, amount * WHEEL_DELTA, flag))
      sendInputs(entries)
      return { x: x === undefined ? null : toInt(x, 'x'), y: y === undefined ? null : toInt(y, 'y'), delta: amount, horizontal: Boolean(horizontal) }
    },

    sendKeySequence(events) {
      const entries = []
      for (const event of events) {
        const vk = event.vk === undefined ? resolveVirtualKey(event.name) : event.vk
        if (event.action === 'down') entries.push(keyEntry(vk, false))
        else if (event.action === 'up') entries.push(keyEntry(vk, true))
        else {
          entries.push(keyEntry(vk, false))
          entries.push(keyEntry(vk, true))
        }
      }
      const sent = sendInputs(entries)
      return { sent, events: events.map((event) => ({ action: event.action, name: event.name, vk: event.vk })) }
    },

    typeText(text) {
      const entries = []
      let typed = 0
      // Iterating UTF-16 code units is what KEYEVENTF_UNICODE expects: a
      // surrogate pair is two events and the application reassembles it.
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index)
        if (code === 13) continue // the CR of a CRLF pair; Enter is sent for the LF
        if (code === 10 || code === 9) {
          const vk = code === 9 ? 0x09 : 0x0d
          entries.push(keyEntry(vk, false))
          entries.push(keyEntry(vk, true))
        } else {
          entries.push(unicodeEntry(code, false))
          entries.push(unicodeEntry(code, true))
        }
        typed += 1
      }
      sendInputs(entries)
      return { typed, characters: typed }
    },

    clipboardRead() {
      return withClipboard(() => {
        const memory = Number(api.GetClipboardData(CF_UNICODETEXT))
        if (!memory) return { text: '', format: 'CF_UNICODETEXT' }
        const pointer = api.GlobalLock(memory)
        if (!pointer) return { text: '', format: 'CF_UNICODETEXT' }
        try {
          return { text: koffi.decode.string16(pointer), format: 'CF_UNICODETEXT' }
        } finally {
          api.GlobalUnlock(memory)
        }
      })
    },

    clipboardWrite(text) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new ComputerUseError(CODES.ACTION_INVALID, 'clipboardWrite needs a non-empty string')
      }
      const bytes = (text.length + 1) * 2
      const memory = Number(api.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes))
      if (!memory) {
        throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'GlobalAlloc failed for the clipboard buffer')
      }
      let handedOver = false
      try {
        const pointer = api.GlobalLock(memory)
        if (!pointer) {
          throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'GlobalLock failed for the clipboard buffer')
        }
        try {
          // Writing through a view of the locked block is the only form that
          // reliably lands in the shared memory; a raw encode() into a bare
          // address silently does nothing on this koffi build.
          Buffer.from(koffi.view(pointer, bytes)).write(text, 0, 'utf16le')
        } finally {
          api.GlobalUnlock(memory)
        }
        withClipboard(() => {
          if (!api.EmptyClipboard()) {
            throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'EmptyClipboard failed')
          }
          if (!Number(api.SetClipboardData(CF_UNICODETEXT, memory))) {
            throw new ComputerUseError(CODES.CONTROLLER_FAILED, 'SetClipboardData failed')
          }
          handedOver = true
        })
      } finally {
        // After a successful SetClipboardData the clipboard owns the block.
        if (!handedOver) api.GlobalFree(memory)
      }
      return { written: text.length }
    },

    screenMetrics() {
      return readScreenMetrics()
    },

    probe() {
      const width = api.GetSystemMetrics(SM_CXSCREEN)
      const height = api.GetSystemMetrics(SM_CYSCREEN)
      const foreground = Number(api.GetForegroundWindow())
      return {
        metrics: { width, height },
        interactive: foreground !== 0,
        foreground: formatHandle(foreground),
        windows: this.listWindows().length,
        virtualScreen: readScreenMetrics().virtualScreen,
        inputSize: INPUT_SIZE
      }
    }
  }
}

/**
 * The PowerShell backend: same surface, one child process per operation.
 *
 * @param {object} [options]
 * @returns {object} the low-level backend
 */
function createPowershellBackend(options = {}) {
  const powershell = options.powershell || 'powershell.exe'
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 20000
  const scriptPath = options.scriptPath || SCRIPT_PATH
  let sequence = 0

  function invoke(request) {
    if (!fs.existsSync(scriptPath)) {
      throw new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, `the PowerShell fallback script is missing: ${scriptPath}`, {
        scriptPath
      })
    }
    const requestFile = path.join(os.tmpdir(), `dsh-win32-${process.pid}-${sequence++}.json`)
    fs.writeFileSync(requestFile, JSON.stringify(request), 'utf8')
    let result
    try {
      result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Request', requestFile], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024
      })
    } finally {
      try {
        fs.rmSync(requestFile, { force: true })
      } catch {
        // A leftover temp file is harmless; failing the operation over it is not.
      }
    }
    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT'
      throw new ComputerUseError(
        timedOut ? CODES.CONTROLLER_TIMEOUT : CODES.CONTROLLER_UNAVAILABLE,
        timedOut
          ? `the PowerShell backend did not answer within ${timeoutMs} ms (${request.op})`
          : `cannot run ${powershell}: ${result.error.message}`,
        { op: request.op, code: result.error.code || null }
      )
    }
    const parsed = parseLastJsonLine(result.stdout)
    if (!parsed) {
      const stderr = (result.stderr || '').trim().split('\n').slice(-3).join(' | ')
      throw new ComputerUseError(
        CODES.CONTROLLER_FAILED,
        `the PowerShell backend produced no JSON response for ${request.op} (exit ${result.status})${stderr ? `: ${stderr}` : ''}`,
        { op: request.op, status: result.status, stderr: stderr || null }
      )
    }
    if (!parsed.ok) {
      const code = CODES[parsed.code] ? parsed.code : CODES.CONTROLLER_FAILED
      throw new ComputerUseError(code, parsed.error || `the PowerShell backend failed ${request.op}`, { op: request.op })
    }
    return parsed.result
  }

  return {
    name: 'powershell',
    clipboard: 'powershell',
    scriptPath,
    invoke,

    listWindows(options = {}) {
      const result = invoke({
        op: 'listWindows',
        includeUntitled: Boolean(options.includeUntitled),
        includeToolWindows: Boolean(options.includeToolWindows),
        includeInvisible: Boolean(options.includeInvisible)
      })
      // The script already applied its own filters; re-applying the JS rules on
      // synthesized style fields would filter a second time on wrong data, so
      // only the shape is normalized here.
      return result.windows || []
    },

    foregroundWindow() {
      return invoke({ op: 'foregroundWindow' }).window || null
    },

    focusWindow(handle, { restore = true } = {}) {
      return invoke({ op: 'focusWindow', handle, restore })
    },

    closeWindow(handle) {
      return invoke({ op: 'closeWindow', handle })
    },

    moveWindow(handle, bounds) {
      return invoke({ op: 'moveWindow', handle, ...bounds })
    },

    cursorPosition() {
      return invoke({ op: 'cursorPosition' })
    },

    moveMouse(x, y) {
      return invoke({ op: 'moveMouse', x, y })
    },

    click({ x, y, button = 'left', clicks = 1 }) {
      return invoke({ op: 'click', x, y, button, clicks })
    },

    drag({ fromX, fromY, toX, toY, button = 'left', durationMs = 300 }) {
      return invoke({ op: 'drag', fromX, fromY, toX, toY, button, durationMs })
    },

    scroll({ x, y, delta, horizontal = false }) {
      return invoke({ op: 'scroll', x, y, delta, horizontal })
    },

    sendKeySequence(events) {
      // Ordering lives in the driver so both backends execute the same
      // sequence; handing PowerShell the modifier names would duplicate the
      // composition rule in two languages.
      const sequencePayload = events.map((event) => ({ action: event.action, key: event.name, vk: event.vk }))
      return invoke({ op: 'keyPress', sequence: sequencePayload })
    },

    typeText(text) {
      return invoke({ op: 'typeText', text })
    },

    clipboardRead() {
      return invoke({ op: 'clipboardRead' })
    },

    clipboardWrite(text) {
      return invoke({ op: 'clipboardWrite', text })
    },

    screenMetrics() {
      return invoke({ op: 'screenMetrics' })
    },

    probe() {
      const result = invoke({ op: 'probe' })
      return {
        metrics: result.metrics || { width: 0, height: 0 },
        interactive: Boolean(result.interactive),
        foreground: result.foreground || null,
        windows: Number(result.windows) || 0,
        virtualScreen: result.virtualScreen || null,
        powershell: result.powershell || null
      }
    }
  }
}

/**
 * Picks the best available backend. Returns a verdict object instead of
 * throwing, because "no backend" is a normal, reportable machine state.
 */
function selectBackend(options = {}) {
  const attempts = []
  if (options.lowLevel && typeof options.lowLevel === 'object') {
    return { lowLevel: options.lowLevel, name: options.lowLevel.name || 'injected', attempts, error: null, koffiVersion: null }
  }
  if (options.forceBackend !== 'powershell') {
    const loaded = loadKoffi(options)
    if (loaded.koffi) {
      try {
        const backend = createKoffiBackend(loaded.koffi)
        return { lowLevel: backend, name: 'koffi', attempts, error: null, koffiVersion: loaded.version }
      } catch (error) {
        attempts.push({ backend: 'koffi', error: error && error.message ? error.message : String(error) })
      }
    } else {
      attempts.push({ backend: 'koffi', error: loaded.error })
    }
  }
  if (options.forceBackend === 'koffi') {
    return { lowLevel: null, name: 'unavailable', attempts, error: attempts.length ? attempts[0].error : 'koffi was not loaded', koffiVersion: null }
  }
  try {
    const backend = createPowershellBackend(options)
    return { lowLevel: backend, name: 'powershell', attempts, error: null, koffiVersion: null }
  } catch (error) {
    attempts.push({ backend: 'powershell', error: error && error.message ? error.message : String(error) })
    return { lowLevel: null, name: 'unavailable', attempts, error: attempts[attempts.length - 1].error, koffiVersion: null }
  }
}

/** The last JSON object a PowerShell host printed; anything before it is noise on stdout. */
function parseLastJsonLine(stdout) {
  if (typeof stdout !== 'string') return null
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // keep scanning: a warning line can look like the start of a payload
    }
  }
  return null
}

/**
 * Creates the Windows desktop driver.
 *
 * The backend is chosen on first use, not in the constructor, so building a
 * driver is always cheap and never throws; a machine with neither koffi nor
 * PowerShell reports that through `probe()` and every method throws the typed
 * unavailable error.
 *
 * @param {object} [options]
 * @param {object} [options.lowLevel] injected backend (tests)
 * @param {Function} [options.loadKoffi] injected koffi loader (tests)
 * @param {string} [options.powershell] PowerShell executable
 * @param {number} [options.timeoutMs] per-invocation timeout for the fallback
 * @param {'koffi'|'powershell'} [options.forceBackend] pin the backend (tests)
 * @returns {object} a DESKTOP_DRIVER_METHODS port plus `backend` and `probe()`
 */
function createWin32Driver(options = {}) {
  let selected = null

  function backend() {
    if (!selected) selected = selectBackend(options)
    return selected
  }

  function requireBackend() {
    if (!IS_WINDOWS) {
      throw unavailable('desktop', 'the win32 desktop driver is Windows only', { platform: process.platform })
    }
    const current = backend()
    if (!current.lowLevel) {
      throw unavailable('desktop', `no usable Windows input backend: ${current.error || 'unknown reason'}`, {
        attempts: current.attempts
      })
    }
    return current.lowLevel
  }

  const driver = {
    /** @type {string} the selected backend, resolved lazily */
    get backend() {
      if (!IS_WINDOWS) return 'unavailable'
      const current = backend()
      return current.lowLevel ? current.name : 'unavailable'
    },

    /**
     * A real self-test: load the backend, read the screen metrics and check for
     * an interactive window station. A session-0 service has a working backend
     * but no foreground window, which is reported as available with
     * `detail.interactive === false` rather than as a failure.
     *
     * @returns {{available: boolean, reason: string|null, detail: object}}
     */
    probe() {
      if (!IS_WINDOWS) {
        return { available: false, reason: 'windows-only', detail: { platform: process.platform } }
      }
      const current = backend()
      if (!current.lowLevel) {
        return {
          available: false,
          reason: current.error || 'no usable Windows input backend',
          detail: { backend: 'unavailable', attempts: current.attempts, scriptPath: SCRIPT_PATH }
        }
      }
      try {
        const result = current.lowLevel.probe()
        const metrics = result.metrics || { width: 0, height: 0 }
        return {
          available: true,
          reason: metrics.width > 0 && metrics.height > 0 ? null : 'the desktop reports a zero-sized screen',
          detail: {
            backend: current.name,
            platform: process.platform,
            node: process.version,
            koffi: current.koffiVersion,
            koffiError: current.attempts.length ? current.attempts[0].error : null,
            windows: result.windows,
            metrics,
            virtualScreen: result.virtualScreen || null,
            interactive: Boolean(result.interactive),
            foreground: result.foreground || null,
            inputSize: result.inputSize === undefined ? null : result.inputSize,
            powershell: result.powershell || null,
            clipboard: current.lowLevel.clipboard || current.name,
            scriptPath: current.lowLevel.scriptPath || null
          }
        }
      } catch (error) {
        return {
          available: false,
          reason: error && error.message ? error.message : String(error),
          detail: { backend: current.name, attempts: current.attempts }
        }
      }
    },

    /** @returns {Array<object>} visible, titled, non-tool top-level windows */
    listWindows(listOptions = {}) {
      return requireBackend().listWindows(listOptions)
    },

    /** @returns {object|null} the foreground window, or null when the session has none */
    foregroundWindow() {
      return requireBackend().foregroundWindow()
    },

    /** @returns {object} whether the window actually became foreground */
    focusWindow(handle, focusOptions = {}) {
      return requireBackend().focusWindow(normalizeHandle(handle), focusOptions)
    },

    /** @returns {object} whether WM_CLOSE was posted (the application may still refuse to close) */
    closeWindow(handle) {
      return requireBackend().closeWindow(normalizeHandle(handle))
    },

    /** @returns {object} the window's bounds after the move */
    moveWindow(handle, bounds = {}) {
      const rect = {
        x: bounds.x === undefined ? undefined : toInt(bounds.x, 'x'),
        y: bounds.y === undefined ? undefined : toInt(bounds.y, 'y'),
        width: bounds.width === undefined ? undefined : toInt(bounds.width, 'width'),
        height: bounds.height === undefined ? undefined : toInt(bounds.height, 'height')
      }
      return requireBackend().moveWindow(normalizeHandle(handle), rect)
    },

    /**
     * Starts a detached process and optionally waits for its first window.
     *
     * `shell: false` is deliberate: a task target is a real executable path, and
     * routing it through cmd.exe would make arguments injectable. The window is
     * matched on the spawned pid exactly - applications that hand their window
     * to a separate broker process cannot be matched this way, and the result
     * says so instead of guessing.
     *
     * @param {string} target executable path
     * @param {{args?: string[], cwd?: string, waitForWindowMs?: number}} [launchOptions]
     * @returns {Promise<{ok: boolean, processId: number, window: object|null, waitedMs: number, reason: string|null}>}
     */
    async openApplication(target, launchOptions = {}) {
      requireBackend()
      if (typeof target !== 'string' || target.trim() === '') {
        throw new ComputerUseError(CODES.ACTION_INVALID, 'openApplication needs a target executable')
      }
      const args = Array.isArray(launchOptions.args) ? launchOptions.args.map((item) => String(item)) : []
      const cwd = typeof launchOptions.cwd === 'string' && launchOptions.cwd !== '' ? launchOptions.cwd : undefined
      const waitForWindowMs = Math.max(0, toInt(launchOptions.waitForWindowMs || 0, 'waitForWindowMs'))
      // The baseline includes untitled, tool and invisible windows: the point is
      // to notice a HANDLE that did not exist before, and a window that is still
      // being created is often untitled and invisible for its first frames.
      const pollOptions = { includeUntitled: true, includeToolWindows: true, includeInvisible: true }
      const known = waitForWindowMs > 0 ? new Set(driver.listWindows(pollOptions).map((window) => window.handle)) : null

      const child = spawn(target, args, {
        cwd,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: false
      })
      const started = await new Promise((resolve, reject) => {
        child.once('error', (error) => reject(new ComputerUseError(CODES.TARGET_NOT_FOUND, `cannot start ${target}: ${error.message}`, { target, code: error.code || null })))
        child.once('spawn', () => resolve(true))
      })
      if (!started) throw new ComputerUseError(CODES.CONTROLLER_FAILED, `cannot start ${target}`)
      child.unref()

      const result = { ok: true, processId: child.pid, window: null, waitedMs: 0, reason: null }
      if (waitForWindowMs <= 0) return result
      const deadline = Date.now() + waitForWindowMs
      while (Date.now() < deadline) {
        const match = driver.listWindows(pollOptions).find(
          (window) => window.processId === child.pid && window.visible && !known.has(window.handle)
        )
        if (match) {
          result.window = match
          result.waitedMs = waitForWindowMs - (deadline - Date.now())
          return result
        }
        await sleep(100)
      }
      result.waitedMs = waitForWindowMs
      result.reason = `no new top-level window owned by pid ${child.pid} appeared within ${waitForWindowMs} ms`
      return result
    },

    /** @returns {{x: number, y: number}} the pointer position in physical pixels */
    cursorPosition() {
      return requireBackend().cursorPosition()
    },

    /** @returns {{x: number, y: number}} the requested position */
    moveMouse(x, y) {
      const position = typeof x === 'object' && x !== null ? x : { x, y }
      return requireBackend().moveMouse(toInt(position.x, 'x'), toInt(position.y, 'y'))
    },

    /** @returns {object} the click receipt; coordinates are always explicit */
    click(x, y, clickOptions = {}) {
      const lowLevel = requireBackend()
      const args = typeof x === 'object' && x !== null ? x : { x, y, ...clickOptions }
      let position = { x: args.x, y: args.y }
      if (position.x === undefined || position.y === undefined) position = lowLevel.cursorPosition()
      return lowLevel.click({
        x: toInt(position.x, 'x'),
        y: toInt(position.y, 'y'),
        button: args.button || 'left',
        clicks: args.clicks === undefined ? 1 : args.clicks
      })
    },

    /**
     * Drags the pointer from one point to another with the button held.
     *
     * @param {{fromX: number, fromY: number, toX: number, toY: number, button?: string, durationMs?: number}|{x: number, y: number}} from
     * @param {{x: number, y: number}} [to] a second point when the first form was not used
     * @param {object} [dragOptions]
     * @returns {object} the drag receipt
     */
    drag(from, to, dragOptions = {}) {
      let args
      if (from && typeof from === 'object' && (from.fromX !== undefined || from.toX !== undefined)) {
        args = { ...from }
      } else if (from && typeof from === 'object' && to && typeof to === 'object') {
        args = { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, ...dragOptions }
      } else {
        throw new ComputerUseError(
          CODES.ACTION_INVALID,
          'drag needs {fromX, fromY, toX, toY} or two points {x, y}'
        )
      }
      if (args.fromX === undefined || args.toX === undefined) {
        throw new ComputerUseError(CODES.ACTION_INVALID, 'drag needs fromX/fromY and toX/toY')
      }
      return requireBackend().drag({
        fromX: toInt(args.fromX, 'fromX'),
        fromY: toInt(args.fromY, 'fromY'),
        toX: toInt(args.toX, 'toX'),
        toY: toInt(args.toY, 'toY'),
        button: args.button || 'left',
        durationMs: args.durationMs === undefined ? 300 : args.durationMs
      })
    },

    /**
     * Scrolls the wheel. A positive delta scrolls up, or left when horizontal.
     *
     * @param {number|{delta: number, x?: number, y?: number, horizontal?: boolean}} delta
     * @param {{x?: number, y?: number, horizontal?: boolean}} [scrollOptions]
     * @returns {object} the scroll receipt
     */
    scroll(delta, scrollOptions = {}) {
      const args = typeof delta === 'object' && delta !== null ? delta : { delta, ...scrollOptions }
      // Validated here rather than in each backend: a zero-delta scroll is a
      // caller bug on every backend, and reporting it before the process spawn
      // keeps the two backends' behaviour identical.
      const amount = toInt(args.delta, 'delta')
      if (amount === 0) {
        throw new ComputerUseError(CODES.ACTION_INVALID, 'scroll needs a non-zero delta')
      }
      const payload = { delta: amount, horizontal: Boolean(args.horizontal) }
      if (args.x !== undefined && args.y !== undefined) {
        payload.x = toInt(args.x, 'x')
        payload.y = toInt(args.y, 'y')
      }
      return requireBackend().scroll(payload)
    },

    /** @returns {object} the composed sequence that was actually sent */
    keyPress(key, keyOptions = {}) {
      const lowLevel = requireBackend()
      if (Array.isArray(key)) return driver.hotkey(key)
      const action = keyOptions.action || 'press'
      if (action !== 'press' && action !== 'down' && action !== 'up') {
        throw new ComputerUseError(CODES.ACTION_INVALID, `keyPress action must be press, down or up (got ${action})`)
      }
      const name = normalizeKeyList(key)[0]
      const vk = resolveVirtualKey(name)
      const events = action === 'press'
        ? [{ action: 'tap', name, vk }]
        : [{ action, name, vk }]
      const receipt = lowLevel.sendKeySequence(events)
      return { ok: true, key: name, vk, action, ...receipt }
    },

    /**
     * Presses modifiers down, taps the payload, releases modifiers in reverse.
     *
     * @param {Array<string|number>} keys
     * @returns {object} the receipt, including the exact event order used
     */
    hotkey(keys) {
      const lowLevel = requireBackend()
      const events = composeHotkey(keys)
      const receipt = lowLevel.sendKeySequence(events)
      // `keys` is what the caller asked for; `events` is what was actually
      // pressed, including the automatic releases.
      return { ok: true, keys: events.filter((event) => event.action !== 'up').map((event) => event.name), events, ...receipt }
    },

    /**
     * Types real Unicode text through KEYEVENTF_UNICODE. The clipboard is never
     * involved: it would clobber the user's clipboard and be observable.
     *
     * @param {string} text
     * @returns {object} how many UTF-16 code units were typed
     */
    typeText(text) {
      const lowLevel = requireBackend()
      if (typeof text !== 'string') {
        throw new ComputerUseError(CODES.ACTION_INVALID, `typeText needs a string, got ${typeof text}`)
      }
      if (text.length === 0) return { typed: 0, characters: 0 }
      const receipt = lowLevel.typeText(text)
      return { typed: receipt.typed, characters: receipt.typed, utf16CodeUnits: text.length }
    },

    /** @returns {{text: string}} the clipboard text (empty when the clipboard holds no text) */
    clipboardRead() {
      return requireBackend().clipboardRead()
    },

    /** @returns {{written: number}} how many UTF-16 code units were placed on the clipboard */
    clipboardWrite(text) {
      return requireBackend().clipboardWrite(text)
    },

    /** @returns {object} the virtual screen, the primary monitor, every monitor and the cursor */
    screenMetrics() {
      return requireBackend().screenMetrics()
    }
  }

  return driver
}

module.exports = {
  createWin32Driver,
  resolveVirtualKey,
  // Exported for the unit tests and for hosts that want to describe the
  // fallback; not part of the DESKTOP_DRIVER_METHODS contract.
  __internal: {
    IS_WINDOWS,
    SCRIPT_PATH,
    NAMED_VIRTUAL_KEYS,
    MODIFIER_KEYS,
    SHELL_WINDOW_CLASSES,
    composeHotkey,
    shouldListWindow,
    normalizeHandle,
    parseLastJsonLine,
    loadKoffi,
    createKoffiBackend,
    createPowershellBackend,
    selectBackend
  }
}
