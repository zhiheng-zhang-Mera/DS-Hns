'use strict'

/**
 * Wallpaper acceptance: does the layer over the official page take a click?
 *
 * The user-visible defect this exists for: with a wallpaper set, the official UI became unclickable.
 * The layer was a `WebContentsView` stacked above the official page, and this Electron build gives a
 * view **no input API at all** — `setIgnoreMouseEvents` exists on `BrowserWindow`/`BaseWindow` and on
 * nothing else (`View` has 9 methods; check for yourself, this script prints the list). So the layer
 * was a real hit target wherever it covered, and it covered everything.
 *
 * The fix is a shape change, not a flag: the wallpaper is a frameless, transparent, never-focused
 * *window* created with `setIgnoreMouseEvents(true)`, and the dock's own rectangle is cut out of it.
 * This script measures that with the operating system's own hit test rather than with an injected
 * event:
 *
 *   1. **control** — with no layer, a point over the page resolves to the page (root = main window);
 *   2. **the layer up and mouse-transparent** — the same point *still* resolves to the page, because
 *      `WindowFromPoint` skips windows that are transparent to the mouse;
 *   3. **negative control** — the same layer with mouse transparency turned off resolves to *the
 *      layer*, which is the shape the defect had and which makes step 2 a measurement instead of a
 *      coincidence.
 *
 * What this cannot do is send a click. Synthetic button input is filtered out in some sessions
 * (`SendInput` reports success and no `mousedown` reaches any renderer), and the CDP dispatch the
 * acceptance run uses is worse than useless here: it injects the event straight into a renderer and
 * never asks the window layer who the hit target is, which is precisely why this defect survived a
 * green acceptance run.
 *
 * Usage (from the repo root, with the product's Electron):
 *   app\node_modules\electron\dist\electron.exe scripts\wallpaper-hit-test.cjs
 *
 * It opens a small window with a second window over it for a few seconds. Exit code 0 is PASS, 1 is
 * FAIL, 2 is INCONCLUSIVE (the harness could not establish the control).
 */
const { app, BrowserWindow, screen } = require('electron')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<html><body style="background:#123a5f;color:#fff;font:20px sans-serif"><h1>the official page</h1></body></html>'
)}`
const LAYER = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<html><body style="background:rgba(255,0,0,0.35)"></body></html>'
)}`

const handleOf = (window_) => {
  const buffer = window_.getNativeWindowHandle()
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
}

const hex = (value) => `0x${value.toString(16).toUpperCase()}`

/** The OS hit test at one physical point, via the shell's own DPI-aware helper. */
function hitTest(x, y) {
  const tool = path.join(__dirname, 'hit-test-window.ps1')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tool, '-X', String(Math.round(x)), '-Y', String(Math.round(y))],
    { encoding: 'utf8' }
  )
  const text = String(result.stdout || result.stderr || '').trim()
  if (result.error) return { text: `hit test unavailable: ${result.error.message}`, root: null }
  const root = /root=(0x[0-9A-F]+)/i.exec(text)
  return { text: text.replace(/\r?\n/g, ' | '), root: root ? BigInt(root[1]) : null }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const main = new BrowserWindow({ x: 120, y: 120, width: 520, height: 360, show: false, title: 'DS-Harness wallpaper hit test' })
  await main.loadURL(PAGE)
  /**
   * Topmost for the length of the measurement, and that is not a convenience: the hit test asks the
   * operating system which window is on top *at that point*, so any other application's window over
   * it — including a running DS-Hns with a wallpaper of its own — would be what the answer describes.
   * The window is small and on screen for a few seconds; without this the run is not a measurement.
   */
  main.setAlwaysOnTop(true, 'screen-saver')
  main.show()
  await sleep(800)

  // The middle of the content box is inside both the page and the layer, which is the case that used
  // to swallow clicks.
  const box = main.getContentBounds()
  const point = screen.dipToScreenPoint({
    x: box.x + Math.round(box.width / 2),
    y: box.y + Math.round(box.height / 2)
  })
  const mainHandle = handleOf(main)

  const control = hitTest(point.x, point.y)

  const layer = new BrowserWindow({
    parent: main,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    width: box.width,
    height: box.height
  })
  layer.setIgnoreMouseEvents(true, { forward: false })
  await layer.loadURL(LAYER)
  layer.setBounds(box)
  layer.showInactive()
  // The layer is a child of the main window; asking for topmost again is what keeps a covering
  // window from being the thing both measurements describe.
  layer.setAlwaysOnTop(true, 'screen-saver')
  await sleep(800)

  const layerHandle = handleOf(layer)
  const covered = hitTest(point.x, point.y)

  // The negative control: the same window, the same point, with mouse transparency off. If this one
  // does not come back as the layer, the harness is not measuring what it claims to.
  layer.setIgnoreMouseEvents(false)
  await sleep(500)
  const opaque = hitTest(point.x, point.y)
  layer.setIgnoreMouseEvents(true, { forward: false })
  await sleep(500)
  const restored = hitTest(point.x, point.y)

  const controlOk = control.root === mainHandle
  const coveredOk = covered.root === mainHandle && covered.root !== layerHandle
  const restoredOk = restored.root === mainHandle
  const sensitiveOk = opaque.root === layerHandle
  const pass = controlOk && coveredOk && restoredOk && sensitiveOk
  const inconclusive = !controlOk || !sensitiveOk

  process.stdout.write(`page window ${hex(mainHandle)} · layer window ${hex(layerHandle)} · layer visible ${layer.isVisible()}\n`)
  process.stdout.write(`point ${point.x},${point.y} (physical)\n`)
  process.stdout.write(`  control, nothing over the page:   ${control.text}\n`)
  process.stdout.write(`  the layer up, mouse-transparent:  ${covered.text}\n`)
  process.stdout.write(`  the same layer, transparency off: ${opaque.text}\n`)
  process.stdout.write(`  the layer up again:               ${restored.text}\n`)
  process.stdout.write(`RESULT ${pass ? 'PASS' : inconclusive ? 'INCONCLUSIVE' : 'FAIL'}\n`)
  process.stdout.write(`  the hit test finds the page when nothing is over it: ${controlOk}\n`)
  process.stdout.write(`  the hit test still finds the page under the layer:   ${coveredOk}${restoredOk ? '' : ' (the restored state disagreed)'}\n`)
  process.stdout.write(`  the same layer without transparency IS the target:   ${sensitiveOk}\n`)

  setTimeout(() => app.exit(pass ? 0 : inconclusive ? 2 : 1), 200)
})
