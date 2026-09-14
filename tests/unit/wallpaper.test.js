'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createWallpaper,
  kindOf,
  WALLPAPER_DEFAULT,
  WALLPAPER_LIMITS,
  OFFICIAL_OPACITY_CEILING,
  MAX_ASSET_BYTES
} = require('../../app/extensions/mega/wallpaper.cjs')

/**
 * The wallpaper layer.
 *
 * It exists because a Wallpaper Engine background cannot be had the way that plugin has it: that
 * one is a *client* plugin which rewrites the official web GUI, and this product never scripts or
 * styles the official renderer. What is left is every surface DS-Hns owns — and these are the
 * properties that make that a background rather than a liability:
 *
 *  * **a missing file is no background**, not a broken view: the layer is told to draw nothing
 *    everywhere, and the path stays on disk so it can be fixed;
 *  * **the official UI keeps the last word**: a wallpaper over it is capped and carries a scrim;
 *  * **only what a surface can carry is sent to it**: a video goes to the dock, because the two
 *    official documents are script-free with an `img-src data:` policy and could not play one.
 */

/** A scratch state file and one real image on disk, since the module reads bytes. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-wallpaper-'))
  const image = path.join(dir, 'wall.png')
  // A one-pixel PNG, as bytes: the module's job is to inline them, not to decode them.
  const PNG_1PX = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082'
  fs.writeFileSync(image, Buffer.from(PNG_1PX, 'hex'))
  const video = path.join(dir, 'wall.mp4')
  fs.writeFileSync(video, Buffer.from('00000018667479706d70343200000000', 'hex'))
  return {
    dir,
    image,
    video,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('a wallpaper is an image or a video, and nothing else', () => {
  assert.equal(kindOf('C:/pictures/wall.png'), 'image')
  assert.equal(kindOf('wall.JPEG'), 'image')
  assert.equal(kindOf('wall.webp'), 'image')
  assert.equal(kindOf('wall.mp4'), 'video')
  assert.equal(kindOf('wall.webm'), 'video')
  assert.equal(kindOf('wall.exe'), null)
  assert.equal(kindOf(''), null)
  assert.equal(kindOf(null), null)
})

test('the wallpaper persists, clamps what it cannot honour, and drops what it cannot draw', () => {
  const { dir, image, video, dispose } = scratch()
  try {
    const file = path.join(dir, 'data', 'state', 'wallpaper.json')
    const wallpaper = createWallpaper({ root: dir, log: () => {} })
    const initial = wallpaper.describe()
    assert.equal(initial.ok, true)
    assert.equal(initial.enabled, WALLPAPER_DEFAULT.enabled)
    assert.equal(initial.file, null)
    assert.equal(initial.drawable, false, 'a wallpaper nobody chose is being drawn')
    assert.deepEqual(initial.limits.opacity, { ...WALLPAPER_LIMITS.opacity })

    // Setting one is validated against the disk, not against the string.
    assert.equal(wallpaper.set({ file: path.join(dir, 'nope.png') }).ok, false, 'a file that does not exist was accepted')
    assert.equal(wallpaper.set({ file: path.join(dir, 'notes.txt') }).ok, false)
    const chosen = wallpaper.set({ file: image, opacity: 40, fit: 'contain', scrim: 20 })
    assert.equal(chosen.ok, true, chosen.reason)
    assert.equal(chosen.kind, 'image')
    assert.equal(chosen.name, 'wall.png')
    assert.equal(chosen.drawable, true)
    assert.equal(chosen.present, true)

    // Out-of-range numbers are clamped, an unknown fit is refused, and neither is stored.
    const clamped = wallpaper.set({ opacity: 9999, blur: -5, scrim: 40 })
    assert.equal(clamped.opacity, WALLPAPER_LIMITS.opacity.max)
    assert.equal(clamped.blur, WALLPAPER_LIMITS.blur.min)
    assert.equal(wallpaper.set({ fit: 'stretch' }).ok, false, 'a fit the stylesheet cannot honour was accepted')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(stored).sort(), ['blur', 'enabled', 'file', 'fit', 'muted', 'opacity', 'scrim'])
    assert.equal(stored.fit, 'contain', 'a refused fit was written anyway')

    // A second reader sees the same state, and a video is a video.
    const reread = createWallpaper({ root: dir }).describe()
    assert.equal(reread.file, image)
    assert.equal(reread.opacity, WALLPAPER_LIMITS.opacity.max)
    assert.equal(createWallpaper({ root: dir }).set({ file: video }).kind, 'video')

    // A file that was renamed away is no background: nothing is drawn, and the panel is told why.
    fs.rmSync(video)
    const gone = createWallpaper({ root: dir }).describe()
    assert.equal(gone.present, false)
    assert.equal(gone.drawable, false)
    assert.match(gone.reason || '', /not on disk/)
    assert.equal(createWallpaper({ root: dir }).dockLayer().active, false, 'a wallpaper that is gone is still being drawn')

    // Clearing is a real answer, and an empty string is how it is said.
    const cleared = createWallpaper({ root: dir }).set({ file: '' })
    assert.equal(cleared.file, null)
    assert.equal(cleared.kind, null)
    assert.equal(cleared.drawable, false)
  } finally {
    dispose()
  }
})

test('the dock gets a source, and the official surfaces get a capped stylesheet', () => {
  const { dir, image, video, dispose } = scratch()
  try {
    const wallpaper = createWallpaper({ root: dir, log: () => {} })
    wallpaper.set({ file: image, opacity: 90, blur: 6, scrim: 30, fit: 'cover' })

    // The dock draws an element, so it is told about an element.
    const dock = wallpaper.dockLayer()
    assert.equal(dock.active, true)
    assert.equal(dock.kind, 'image')
    assert.match(dock.src, /^data:image\/png;base64,/, 'the dock was handed a path instead of the same inline asset the official surfaces get')
    assert.equal(dock.muted, true)

    for (const target of ['overlay', 'shell']) {
      const layer = wallpaper.layerCss(target)
      assert.match(layer.image, /^url\("data:image\/png;base64,/)
      // The opacity is the user's, on every surface. A ceiling here would be this module deciding
      // how much of their own screen they may cover; the scrim is the readability dial.
      assert.equal(layer.opacity, 90, `${target} overrode the user's opacity`)
      assert.equal(layer.scrim, 30)
      assert.equal(layer.blur, 6)
    }

    // A video is a real element with real attributes, and the two official documents are
    // script-free with an `img-src data:` policy: there is no shape of CSS that plays one.
    wallpaper.set({ file: video })
    assert.equal(wallpaper.dockLayer().kind, 'video')
    assert.match(wallpaper.dockLayer().src, /^file:\/\//, 'a video was inlined as a data URL')
    for (const target of ['overlay', 'shell']) {
      const layer = wallpaper.layerCss(target)
      assert.equal(layer.image, 'none', `${target} was told to draw a video it cannot play`)
      assert.equal(layer.opacity, 0)
    }
    assert.match(wallpaper.describe().note || '', /dock only/)

    // Switching it off is a complete answer too, on every surface at once.
    wallpaper.set({ enabled: false })
    assert.equal(wallpaper.dockLayer().active, false)
    assert.equal(wallpaper.layerCss('overlay').image, 'none')
    assert.equal(wallpaper.layerCss('dock'), 'none', 'the dock is a document; it is told by its own call')

    assert.throws(() => wallpaper.layerCss('official_renderer'), /unknown wallpaper target/)
    assert.ok(MAX_ASSET_BYTES > 0)
  } finally {
    dispose()
  }
})

/**
 * The safety rules, as the shipped files state them.
 *
 * "Do not crash the official UI" is four separate promises, and each of them is one line in a file
 * that a later change could quietly take away.
 */
test('the layer cannot intercept the UI, script it, or outlive its file', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8')
  const css = read('app/extensions/mega/ui/dock.css')
  const html = read('app/extensions/mega/ui/dock.html')
  const layer = read('app/extensions/mega/ui/wallpaper-layer.js')
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')

  // A background is not a hit target, and it is behind the content rather than in front of it.
  const rule = css.match(/body>#wallpaper,\s*body>#wallpaperVideo\{([^}]*)\}/)
  assert.ok(rule, 'the wallpaper layer has no rule')
  assert.match(rule[1], /pointer-events:none/, 'the wallpaper would swallow clicks')
  // Fixed against the window, not absolute inside the scrolling `#detail`: an absolute layer there
  // sits at the top of the content and scrolls away with it, which is a band of picture at the top
  // of the dock rather than a background.
  assert.match(rule[1], /position:fixed/, 'the wallpaper scrolls with the panels instead of staying put')
  assert.match(rule[1], /z-index:0/)
  // Two ids on purpose: `#detail>div{position:relative;z-index:1}` matches this element as well and
  // outranks a bare `#wallpaper`, which is exactly how the layer ended up back in the normal flow.
  assert.match(css, /#rail,#detail\{position:relative;z-index:1\}/, 'the dock content is not pinned above the wallpaper')
  assert.match(html, /<div id="wallpaper" aria-hidden="true"><\/div>/, 'the wallpaper element is missing')
  assert.match(html, /<video id="wallpaperVideo" aria-hidden="true" muted loop playsinline/, 'the video element is missing its safety attributes')
  // It belongs to the whole dock window, the rail included, so it is a child of the body.
  const head = html.slice(html.indexOf('<body'), html.indexOf('<aside id="rail"'))
  assert.match(head, /id="wallpaper"/, 'the wallpaper is inside the scrolling panel column instead of the window')

  // A video nobody can see does not need frames.
  assert.match(layer, /if \(typeof video\.pause === 'function'\) video\.pause\(\)/, 'a video left the layer without being paused')
  assert.match(layer, /visibilitychange/, 'the layer never stops a hidden video')
  assert.match(layer, /video\.removeAttribute\('src'\)/, 'a replaced video keeps its old source')

  // The shell owns the file, and the renderer never gets a path it could act on.
  assert.match(index, /ipcMain\.handle\('mega:wallpaper-pick'[\s\S]{0,400}dialog\.showOpenDialog/)
  assert.match(preload, /wallpaper: \{[\s\S]{0,200}describe: \(\) => ipcRenderer\.invoke\('mega:wallpaper'\)/)
  assert.match(preload, /onChanged: \(callback\) => ipcRenderer\.on\('mega:wallpaper-changed'/)
  assert.match(index, /dockTarget\.send\('mega:wallpaper-changed'/, 'the dock is never told the wallpaper changed')
  assert.match(index, /'mega:wallpaper', 'mega:wallpaper-set', 'mega:wallpaper-pick', 'mega:wallpaper-layer'/, 'the wallpaper channels are not declared for cleanup')

  // And the two official documents are still exactly what they were: no script, no network.
  for (const document of ['official-overlay.html', 'hns-shell.html']) {
    const source = read(`app/extensions/mega/ui/${document}`)
    assert.equal(/<script/.test(source), false, `${document} gained a script`)
    assert.match(source, /script-src 'none'/, `${document} no longer forbids scripts`)
  }
  // The official renderer is not reachable from any of this: the two modules may *describe* the
  // surfaces they feed, but neither may call an injection API or hold a reference to that view.
  for (const source of [layer, read('app/extensions/mega/wallpaper.cjs')]) {
    assert.equal(/executeJavaScript\s*\(|insertCSS\s*\(|officialView\s*[.[]/.test(source), false, 'the wallpaper reached for the official renderer')
  }
})
