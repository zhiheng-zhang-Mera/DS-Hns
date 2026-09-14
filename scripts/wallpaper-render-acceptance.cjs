'use strict'

/**
 * Wallpaper acceptance: does the picture actually reach the screen, in the right shape?
 *
 * The other half of the pair (`scripts/wallpaper-hit-test.cjs` covers input). This one wires the real
 * modules — `app/extensions/mega/wallpaper.cjs` builds the stylesheet, `app/wallpaper-window.cjs`
 * puts it on screen — the way the shell does, and then reads back *what the layer's document
 * computed* and *what the layer's pixels are*. Two defects that no unit test could see were found
 * by exactly these two readings:
 *
 *   1. **the picture never appeared.** `insertCSS` places its sheet before the document's own, so at
 *      equal specificity the document's `:root { --wp-image: none }` default won and the layer drew
 *      nothing, while every module involved reported success. The stylesheets are written `:root:root`
 *      because of this measurement.
 *   2. **the cut was inverted.** The clip polygon's vertices were traced in the wrong order, so the
 *      layer drew *everything except the interface* — a rectangle over the dock and a hole over the
 *      page. The alpha map below is what makes that kind of mistake visible.
 *
 * Usage (from the repo root, with the product's Electron):
 *   app\node_modules\electron\dist\electron.exe scripts\wallpaper-render-acceptance.cjs [--pixels]
 *
 * It opens one window, draws a real wallpaper (the shipped icon, then a photograph-sized one) over it
 * with a simulated dock strip cut out, and exits 0 (PASS) or 1 (FAIL).
 *
 * `--pixels` adds a coarse alpha map of the layer. It is not the default because capturing a window
 * that another application covers can block inside the compositor — the call never returns and no
 * timeout can interrupt it — so that half of the check is run with the product closed. Everything it
 * would show (the picture applied, the cut's shape) is read from the document's computed styles by
 * default, which is where the two defects this script exists for were visible.
 *
 * It keeps its state in a scratch directory: this script must never be the reason the user's own
 * wallpaper changes (`data/state/wallpaper.json` belongs to the person using the product).
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const { createWallpaper } = require(path.join(ROOT, 'app', 'extensions', 'mega', 'wallpaper.cjs'))
const { createWallpaperWindow } = require(path.join(ROOT, 'app', 'wallpaper-window.cjs'))

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<html><body style="margin:0;background:#0b1220;color:#8fd;font:24px sans-serif;padding:24px">the official page under the wallpaper</body></html>'
)}`

const WALLPAPER = path.join(ROOT, 'assets', 'icon', 'ds-harness-256.png')
/** The dock's strip in this simulation: 320px wide, below the 76px band the dock yields. */
const NOTCH = { width: 320, y: 76 }
/** The pixel map is opt-in: see the note at the top of this file. */
const WANT_PIXELS = process.argv.includes('--pixels')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve with `null` rather than waiting forever: a capture can stall on an occluded window. */
function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => null)])
}

/**
 * A PNG of incompressible noise, written without a library: it exists to be *big*, because the size
 * is what the second half of this script is about.
 */
function writeNoisePng(file, width, height) {
  const zlib = require('node:zlib')
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let seed = 20260914
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width * 3; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      raw[row + 1 + x] = seed & 0xff
    }
  }
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

app.whenReady().then(async () => {
  const checks = []
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok: Boolean(ok), detail: String(detail) })
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`)
  }

  const main = new BrowserWindow({ x: 200, y: 160, width: 900, height: 600, show: true })
  await main.loadURL(PAGE)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-wallpaper-render-'))
  const wallpaper = createWallpaper({ root: scratch, log: (message) => process.stdout.write(`  [wallpaper] ${message}\n`) })
  const state = wallpaper.set({ file: WALLPAPER, enabled: true, opacity: 100, scrim: 0, blur: 0, fit: 'cover' })
  check('the wallpaper module accepts a real image', state.ok !== false && state.drawable === true, JSON.stringify({ kind: state.kind, name: state.name, reason: state.reason || null }))

  const layer = createWallpaperWindow({
    getParentWindow: () => main,
    getContentBounds: () => main.getContentBounds(),
    log: (message) => process.stdout.write(`  [layer] ${message}\n`),
    electron: { BrowserWindow }
  })
  const layerPayload = wallpaper.windowLayer()
  check('the layer is handed a drawable stylesheet', layerPayload.drawable === true && /^:root:root \{/.test(layerPayload.css), `${layerPayload.css.length} bytes`)
  layer.paint(layerPayload.css, { drawable: layerPayload.drawable })
  const box = main.getContentBounds()
  layer.layout({ bounds: box, notch: { x: box.width - NOTCH.width, y: NOTCH.y } })
  await sleep(1000)
  await layer.settle()
  await sleep(400)

  check('the layer is on screen, mouse-transparent and never focusable', layer.describe().visible === true && layer.describe().input === 'passthrough' && layer.describe().focusable === false, JSON.stringify(layer.describe().input))

  // What the document computed. A stylesheet that arrives and loses the cascade looks exactly like a
  // stylesheet that never arrived — unless someone reads this.
  const computed = await layer.window().webContents.executeJavaScript(`(() => {
    const picture = getComputedStyle(document.getElementById('wallpaper'))
    return { image: picture.backgroundImage.slice(0, 24), opacity: picture.opacity, size: picture.backgroundSize, clip: picture.clipPath }
  })()`, true)
  check('the picture reached the document (the stylesheet won the cascade)', /^url\("data:image\/png/.test(computed.image) && computed.opacity === '1', JSON.stringify(computed))
  // The traced region, in order: the whole top edge, down the right edge to the cut, left to the
  // dock's x, down to the bottom, back along the bottom. The complement of this order is the defect
  // the alpha map caught — a layer that covers the dock and leaves the interface alone.
  const cutX = box.width - NOTCH.width
  check(
    'the cut is the dock\'s rectangle and nothing else',
    new RegExp(`polygon\\(0px 0px, 100% 0px, 100% ${NOTCH.y}px, ${cutX}px ${NOTCH.y}px, ${cutX}px 100%, 0px 100%\\)`).test(computed.clip),
    computed.clip
  )

  // What the pixels are. `#` opaque, `.` fully transparent.
  if (WANT_PIXELS) {
    // Best effort against occlusion, and still bounded: a blocked compositor cannot be interrupted.
    main.setAlwaysOnTop(true, 'screen-saver')
    const shot = await withTimeout(layer.window().webContents.capturePage(), 8000)
    main.setAlwaysOnTop(false)
    if (!shot) {
      process.stdout.write('SKIP the pixel map: the layer could not be captured\n')
    } else {
      const size = shot.getSize()
      const bitmap = shot.toBitmap()
      const scale = size.width / box.width
      const alphaAt = (x, y) => bitmap[(Math.round(y * scale) * size.width + Math.round(x * scale)) * 4 + 3]
      const rows = []
      for (let y = 0; y < box.height; y += Math.round(box.height / 22)) {
        let line = ''
        for (let x = 0; x < box.width; x += Math.round(box.width / 56)) line += alphaAt(x, y) > 200 ? '#' : '.'
        rows.push(`${String(y).padStart(4)} ${line}`)
      }
      process.stdout.write(`layer alpha map (${box.width}x${box.height}, dock's strip cut at x=${box.width - NOTCH.width}, y=${NOTCH.y}):\n${rows.join('\n')}\n`)

      const stripX = box.width - 20
      const inStrip = (y) => alphaAt(stripX, y) === 0
      const drawn = (x, y) => alphaAt(x, y) > 200
      check(
        'the picture backs the whole interface, including the band above the dock',
        drawn(20, 20) && drawn(box.width - 20, 20) && drawn(box.width - 20, NOTCH.y - 4),
        `top-left ${alphaAt(20, 20)}, top-right ${alphaAt(box.width - 20, 20)}`
      )
      check(
        'the dock\'s own rectangle is left empty, so the dock is neither hidden nor painted twice',
        inStrip(NOTCH.y + 8) && inStrip(box.height - 20) && drawn(20, box.height - 20) && drawn(box.width - NOTCH.width - 20, box.height - 20),
        `strip ${alphaAt(stripX, box.height - 20)}, left of it ${alphaAt(box.width - NOTCH.width - 20, box.height - 20)}`
      )
    }
  }

  // --- a photograph-sized picture ------------------------------------------------------------
  //
  // Everything above used a 15 KB icon, and a 15 KB icon cannot fail the way a 2.7 MB photograph did:
  // the picture used to travel as a CSS custom property, and the engine *drops* a custom property value
  // of a couple of megabytes (measured: 1.25 MB arrives, 2 MB comes back empty). The layer then drew
  // nothing while every module reported success — and only the dock, which sets the image on the
  // element directly, kept working. So the second half of this script switches to a real photograph
  // size and asks what the document computed.
  const big = path.join(scratch, 'photograph.png')
  writeNoisePng(big, 1200, 800)
  const bigKb = Math.round(fs.statSync(big).size / 1024)
  const switched = wallpaper.set({ file: big, enabled: true, opacity: 100, scrim: 0, fit: 'cover' })
  const switchedPayload = wallpaper.windowLayer()
  layer.paint(switchedPayload.css, { drawable: switchedPayload.drawable })
  await sleep(1000)
  await layer.settle()
  const bigComputed = await layer.window().webContents.executeJavaScript(`(() => {
    const image = getComputedStyle(document.getElementById('wallpaper')).backgroundImage
    return { length: image.length, inline: document.getElementById('wallpaper').style.backgroundImage.length }
  })()`, true)
  check(`a ${bigKb} KB picture switches the layer to the new file`, switched.ok !== false && /#wallpaper \{ background-image: url\("data:image\/png;base64,/.test(switchedPayload.css), `stylesheet ${Math.round(switchedPayload.css.length / 1024)} KB`)
  check(
    'a photograph-sized picture actually reaches the document',
    bigComputed.length > 1024 * 1024,
    `computed background-image is ${bigComputed.length} chars (a custom property would have been dropped and read back as "none")`
  )

  layer.destroy()
  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`RESULT ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length - failed.length}/${checks.length} checks\n`)
  process.stdout.write(`state kept in ${scratch} (the user's own wallpaper file was not touched)\n`)
  setTimeout(() => app.exit(failed.length ? 1 : 0), 200)
})
