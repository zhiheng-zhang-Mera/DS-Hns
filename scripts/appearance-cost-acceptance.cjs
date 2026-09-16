'use strict'

/**
 * Appearance cost acceptance (`updateplan/startup2.md` §55-§56).
 *
 * §56 asks for measurements of the appearance in the states a user can put it in: no wallpaper, a static
 * wallpaper, video, scene, the market open, MEGA expanded. Two of those belong to the community plugin and
 * cannot be produced without it — this script says so instead of inventing a number for them.
 *
 * What it measures honestly is the cost of *our* two layers, in this machine's own numbers:
 *
 *   * a bare window (the baseline) and the same window with the wallpaper layer drawing a photograph;
 *   * per-process CPU and memory from Electron's own metrics (`app.getAppMetrics()`);
 *   * the picture's payload, which is the part of the cost that is ours to choose.
 *
 * It uses the real modules (`wallpaper.cjs`, `wallpaper-window.cjs`) and a scratch state file, so it never
 * touches the user's own wallpaper. Run it with the product closed:
 *
 *   app\node_modules\electron\dist\electron.exe scripts\appearance-cost-acceptance.cjs [--json]
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const { createWallpaper } = require(path.join(ROOT, 'app', 'extensions', 'mega', 'wallpaper.cjs'))
const { createWallpaperWindow } = require(path.join(ROOT, 'app', 'wallpaper-window.cjs'))
const { estimateAppearanceCost } = require(path.join(ROOT, 'app', 'extensions', 'mega', 'appearance', 'cost.cjs'))

/** A photograph-sized noise PNG: the payload §56's "static wallpaper" case is about. */
function writeNoisePng(file, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let seed = 424242
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The CPU and memory this application's processes are using right now. */
function sampleMetrics() {
  const metrics = app.getAppMetrics()
  return {
    processes: metrics.length,
    cpuPercent: Math.round(metrics.reduce((total, entry) => total + Number(entry.cpu?.percentCPUUsage || 0), 0) * 10) / 10,
    memoryMb: Math.round(metrics.reduce((total, entry) => total + Number(entry.memory?.workingSetSize || 0), 0) / 1024)
  }
}

app.whenReady().then(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-appearance-cost-'))
  const wallpaper = createWallpaper({ root: scratch, log: () => {} })
  const picture = path.join(scratch, 'photograph.png')
  writeNoisePng(picture, 1200, 800)
  const pictureKb = Math.round(fs.statSync(picture).size / 1024)

  const main = new BrowserWindow({ x: 120, y: 120, width: 900, height: 600, show: true })
  await main.loadURL('data:text/html,<body style="background:#0b1220;color:#8fd;font:20px sans-serif">the official page</body>')
  const layer = createWallpaperWindow({
    getParentWindow: () => main,
    getContentBounds: () => main.getContentBounds(),
    log: () => {}
  })

  const rows = []
  const sample = async (label, note = null) => {
    await sleep(1200)
    const metrics = sampleMetrics()
    const payload = wallpaper.windowLayer()
    const cost = estimateAppearanceCost({
      glass: { blur: 12, opacity: 82 },
      windowBytes: payload.bytes,
      dockBytes: 0,
      layers: payload.drawable ? 1 : 0
    })
    rows.push({ case: label, note, ...metrics, pictureKb: Math.round(cost.wallpaper.bytes / 1024), warnings: cost.warnings.map((warning) => warning.id) })
    process.stdout.write(`${label.padEnd(22)} cpu=${String(metrics.cpuPercent).padStart(5)}%  ram=${String(metrics.memoryMb).padStart(5)}MB  processes=${metrics.processes}  picture=${Math.round(cost.wallpaper.bytes / 1024)}KB${note ? `  (${note})` : ''}\n`)
  }

  // The cases §56 names that this harness can produce. The rest are named with the reason they are missing
  // rather than filled with a plausible number.
  await sample('no wallpaper')
  wallpaper.set({ file: picture, enabled: true, opacity: 60, scrim: 18, fit: 'cover' })
  const payload = wallpaper.windowLayer()
  layer.paint(payload.css, { drawable: payload.drawable })
  layer.layout({ bounds: main.getContentBounds(), notch: { x: main.getContentBounds().width - 320, y: 76 } })
  await sample('static wallpaper', `${pictureKb} KB picture`)
  for (const [label, reason] of [
    ['1080p video', 'the community plugin renders video (§24): the built-in layer carries pictures'],
    ['4K video', 'the community plugin renders video (§24)'],
    ['scene wallpaper', 'the community plugin renders scenes (§24)'],
    ['market open', 'the market is a community plugin; its cost is not this layer\'s'],
    ['MEGA expanded', 'measured by the running product, not by this harness']
  ]) {
    rows.push({ case: label, note: reason, skipped: true })
    process.stdout.write(`${label.padEnd(22)} skipped: ${reason}\n`)
  }

  layer.destroy()
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: true, at: new Date().toISOString(), pictureKb, rows }, null, 2)}\n`)
  } else {
    process.stdout.write(`RESULT measured ${rows.filter((row) => !row.skipped).length} case(s), skipped ${rows.filter((row) => row.skipped).length} with a reason\n`)
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  setTimeout(() => app.exit(0), 200)
})
