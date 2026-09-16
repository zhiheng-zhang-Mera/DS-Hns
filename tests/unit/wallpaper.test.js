'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createWallpaper,
  kindOf,
  isAdvanced,
  WALLPAPER_DEFAULT,
  WALLPAPER_SURFACES,
  WALLPAPER_LIMITS,
  ADVANCED_EXTENSIONS,
  ADVANCED_REASON,
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
 *  * **what this layer draws is pictures**: a video or a web wallpaper is refused *by name* and with the
 *    reason, because it is the community wallpaper plugin's job now (`updateplan/pluginize.md` Phase 7) —
 *    the plugin is installed, so this product's own weaker copy of it is gone rather than switched off;
 *  * **the two backdrops are set separately**: what is behind the main screen and what is behind Mega
 *    are two settings, and the flat shape older callers use means "both".
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

test('a wallpaper is a picture, and nothing else', () => {
  assert.equal(kindOf('C:/pictures/wall.png'), 'image')
  assert.equal(kindOf('wall.JPEG'), 'image')
  assert.equal(kindOf('wall.webp'), 'image')
  // The plugin's kinds are not this layer's kinds, and they are named rather than merely refused: what a
  // user who picked a video needs to be told is where videos *are* drawn.
  for (const extension of ADVANCED_EXTENSIONS) {
    assert.equal(kindOf(`wall${extension}`), null, `${extension} is a wallpaper-plugin kind this layer claims to draw`)
    assert.equal(isAdvanced(`wall${extension}`), true)
  }
  assert.equal(isAdvanced('wall.png'), false)
  assert.match(ADVANCED_REASON, /dsh-plugin-wallpaper-engine/)
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
    // The file carries the master switch and one block per backdrop; the flat keys the test above
    // used are the historical shape and mean both.
    assert.deepEqual(Object.keys(stored).sort(), ['dock', 'enabled', 'main'])
    // `brightness`/`contrast`/`saturation` are the picture's filter, which §27 publishes as the
    // `--dsh-wallpaper-*` tokens; `1` is "as the file is".
    // No `muted`: nothing in this layer plays anything any more, so there is no playback to configure.
    assert.deepEqual(Object.keys(stored.main).sort(), ['blur', 'brightness', 'contrast', 'enabled', 'file', 'fit', 'opacity', 'saturation', 'scrim'])
    assert.equal(stored.main.brightness, 1)
    assert.equal(stored.main.fit, 'contain', 'a refused fit was written anyway')
    assert.equal(stored.dock.file, image, 'the flat shape did not reach both backdrops')
    assert.equal(stored.dock.fit, 'contain')

    // A second reader sees the same state.
    const reread = createWallpaper({ root: dir }).describe()
    assert.equal(reread.file, image)
    assert.equal(reread.opacity, WALLPAPER_LIMITS.opacity.max)

    // A video is refused *by name*, with the reason, and nothing is written — the picture that was there
    // stays there rather than the state file being half-updated by a patch that could not be honoured.
    const refused = createWallpaper({ root: dir }).set({ file: video })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /dsh-plugin-wallpaper-engine/)
    assert.equal(createWallpaper({ root: dir }).describe().file, image, 'a refused video moved the wallpaper')

    // A file that was renamed away is no background: nothing is drawn, and the panel is told why.
    fs.rmSync(image)
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

test('the two backdrops are set separately, and a flat patch still means both', () => {
  const { dir, image, video, dispose } = scratch()
  try {
    const wallpaper = createWallpaper({ root: dir, log: () => {} })
    const other = path.join(dir, 'other.png')
    fs.copyFileSync(image, other)

    // The main screen takes one picture, Mega keeps its own: neither write touches the other.
    const mainOnly = wallpaper.set({ main: { file: image, opacity: 20, fit: 'contain', scrim: 10 } })
    assert.equal(mainOnly.main.file, image)
    assert.equal(mainOnly.main.opacity, 20)
    assert.equal(mainOnly.dock.file, null, 'setting the main screen also set Mega')
    assert.equal(mainOnly.dock.drawable, false)
    assert.equal(mainOnly.shared, false, 'two surfaces with one picture between them are not "shared"')
    // The top level describes the main screen — what every older caller asks about.
    assert.equal(mainOnly.file, image)
    assert.equal(mainOnly.drawable, true)
    assert.equal(wallpaper.dockLayer().active, false, 'Mega drew a picture nobody gave it')
    assert.match(wallpaper.layerCss('main').image, /^url\("data:image\/png;base64,/)
    assert.equal(wallpaper.layerCss('dock'), 'none', 'the dock is a document; it is told by its own call')
    assert.equal(wallpaper.dockLayer().fit, 'cover', 'Mega inherited a fit it was not given')

    const dockOnly = wallpaper.set({ dock: { file: other, opacity: 80, fit: 'tile', scrim: 0 } })
    assert.equal(dockOnly.main.file, image, 'setting Mega moved the main screen')
    assert.equal(dockOnly.main.opacity, 20)
    assert.equal(dockOnly.dock.file, other)
    assert.equal(dockOnly.dock.opacity, 80)
    assert.equal(wallpaper.dockLayer().active, true)
    assert.equal(wallpaper.dockLayer().fit, 'tile')
    assert.equal(dockOnly.shared, false, 'two different pictures are not shared')

    // The same file on both surfaces is the case where the two copies are drawn as one image.
    const together = wallpaper.set({ dock: { file: image } })
    assert.equal(together.shared, true)
    assert.equal(together.main.file, together.dock.file)

    // Clearing one backdrop leaves the other alone.
    const clearedDock = wallpaper.set({ dock: { file: '' } })
    assert.equal(clearedDock.dock.file, null)
    assert.equal(clearedDock.main.file, image)
    assert.equal(wallpaper.dockLayer().active, false)

    // The flat shape (what every caller before the split used) is "both".
    const flat = wallpaper.set({ file: other })
    assert.equal(flat.main.kind, 'image')
    assert.equal(flat.dock.kind, 'image')
    assert.equal(flat.shared, true)
    assert.equal(flat.drawable, true)
    assert.equal(wallpaper.dockLayer().kind, 'image')
    assert.match(wallpaper.dockLayer().src, /^data:image\/png;base64,/, 'the dock was handed a path instead of an inline asset')

    // A video reaching *either* surface through the flat shape is refused the same way, and the two
    // backdrops are left exactly as they were.
    const refused = wallpaper.set({ file: video })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /dsh-plugin-wallpaper-engine/)
    assert.equal(wallpaper.describe().main.kind, 'image', 'a refused video reached the main screen')
    assert.equal(wallpaper.describe().dock.kind, 'image', 'a refused video reached Mega')

    // A file that is no longer a wallpaper is refused per surface, and nothing is written.
    assert.equal(wallpaper.set({ main: { file: path.join(dir, 'nope.png') } }).ok, false)
    assert.equal(wallpaper.set({ dock: { fit: 'stretch' } }).ok, false)
  } finally {
    dispose()
  }
})

test('the dock gets a source and the main screen gets a stylesheet, from their own pictures', () => {
  const { dir, image, video, dispose } = scratch()
  try {
    const wallpaper = createWallpaper({ root: dir, log: () => {} })
    wallpaper.set({ file: image, opacity: 90, blur: 6, scrim: 30, fit: 'cover' })

    // The dock draws an element, so it is told about an element.
    const dock = wallpaper.dockLayer()
    assert.equal(dock.active, true)
    assert.equal(dock.kind, 'image')
    assert.match(dock.src, /^data:image\/png;base64,/, 'the dock was handed a path instead of the same inline asset the official surfaces get')

    const layer = wallpaper.layerCss('main')
    assert.match(layer.image, /^url\("data:image\/png;base64,/)
    // The opacity is the user's, on every surface. A ceiling here would be this module deciding
    // how much of their own screen they may cover; the scrim is the readability dial.
    assert.equal(layer.opacity, 90, 'the window over the official page overrode the user\'s opacity')
    assert.equal(layer.scrim, 30)
    assert.equal(layer.blur, 6)

    // What the window is handed, and whether there is anything to draw at all: the second half is
    // what keeps an empty transparent window off the screen.
    const described = wallpaper.windowLayer()
    assert.equal(described.drawable, true)
    // `:root:root`, not `:root`: the document ships defaults for these variables, and insertCSS
    // loses to them at equal specificity — a layer handed a stylesheet that it cannot apply is a
    // layer that draws nothing.
    assert.match(described.css, /^:root:root \{/, 'the layer\'s stylesheet loses to the document\'s own defaults')
    assert.match(described.css, /--wp-opacity: 0\.9;/)
    assert.match(described.css, /--wp-size: cover;/)
    assert.match(described.css, /--wp-scrim: 0\.3;/)
    // The picture is a direct declaration. A custom property holding a multi-megabyte `data:` URL is
    // dropped by the CSS engine (measured: it arrives at 1.25 MB and never at 2 MB), so a photograph
    // set through one is a wallpaper that silently never appears.
    assert.match(described.css, /#wallpaper \{ background-image: url\("data:image\/png;base64,[^"]+"\) !important; \}/)
    assert.equal(/--wp-image/.test(described.css), false, 'the picture is a custom property again')

    // A video is not drawn on either surface, so it is refused before it can reach one — and the refusal
    // is what the panel shows, which is why it has to name the plugin rather than list extensions.
    const refused = wallpaper.set({ file: video })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /dsh-plugin-wallpaper-engine/)
    assert.match(wallpaper.layerCss('main').image, /^url\("data:image\/png;base64,/, 'a refused video changed the picture in force')
    assert.equal(wallpaper.windowLayer().drawable, true, 'a refused video took the window layer off the screen')
    assert.deepEqual(wallpaper.describe().surfaces, ['main', 'dock'])

    // Switching it off is a complete answer too, on every surface at once.
    wallpaper.set({ enabled: false })
    assert.equal(wallpaper.dockLayer().active, false)
    assert.equal(wallpaper.layerCss('main').image, 'none')
    assert.equal(wallpaper.windowLayer().drawable, false)
    assert.equal(wallpaper.dockLayer().active, false, 'the master switch did not reach Mega')

    assert.throws(() => wallpaper.layerCss('official_renderer'), /unknown wallpaper target/)
    assert.ok(MAX_ASSET_BYTES > 0)
    assert.deepEqual(WALLPAPER_SURFACES, ['main', 'dock'])
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
  const windowDocument = read('app/extensions/mega/ui/wallpaper-window.html')
  const windowModule = read('app/wallpaper-window.cjs')
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')

  // A background is not a hit target, and it is behind the content rather than in front of it.
  const rule = css.match(/body>#wallpaper\{([^}]*)\}/)
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
  // It belongs to the whole dock window, the rail included, so it is a child of the body.
  const head = html.slice(html.indexOf('<body'), html.indexOf('<aside id="rail"'))
  assert.match(head, /id="wallpaper"/, 'the wallpaper is inside the scrolling panel column instead of the window')
  // The dock shows one *part* of a picture that covers the whole window: its copy is placed
  // against the same window box, using the origin the shell reports for this view.
  assert.match(rule[1], /left:calc\(-1 \* var\(--hns-wallpaper-origin-x,0px\)\)/, 'the dock\'s copy of the picture is not aligned to the window')
  assert.match(rule[1], /width:calc\(100% \+ var\(--hns-wallpaper-origin-x,0px\)\)/)
  assert.match(layer, /--hns-wallpaper-origin-x/, 'the frame the shell reports never reaches the stylesheet')
  // ...but only while the two backdrops are the *same* picture. Aligning two different pictures to
  // one box would put a fragment of Mega's own photograph in the strip.
  assert.match(index, /wallpaper\(\)\.sharesPicture\(\) \? dockWallpaperFrame\(\) : null/, 'Mega\'s own picture would be aligned to the window box')
  // The scope selector is how the two backdrops are set separately; the markup and the panel agree.
  assert.match(html, /id="wallpaperScope"/)
  assert.match(html, /<option value="main">/)
  assert.match(html, /<option value="dock">/)
  const panel = read('app/extensions/mega/ui/appearance-panel.js')
  assert.match(panel, /function wallpaperPatch\(values\)/, 'the panel has no way to write one backdrop')
  assert.match(panel, /api\.pick\(\{ scope: wallpaperScope \}\)/, 'the file chooser is not told which backdrop it is for')

  // The layer over the official page is a WINDOW, and it takes no input: a view above that page is
  // a real hit target in this Electron build, which is what swallowed the official UI's clicks.
  assert.match(windowModule, /setIgnoreMouseEvents\(value, \{ forward: false \}\)/, 'the layer over the official page is not mouse-transparent')
  assert.match(windowModule, /focusable: false/, 'the layer over the official page could take the keyboard')
  assert.match(windowModule, /if \(!mouseTransparent\)/, 'the layer would be shown even when the build refused to make it input-transparent')
  assert.match(windowModule, /showInactive\(\)/, 'the layer activates a window when it appears')
  assert.match(windowModule, /--wp-notch-x/, 'the dock\'s rectangle is not cut out of the picture')
  assert.equal(/executeJavaScript|insertCSS\(/.test(windowDocument), false)
  assert.equal(/<script/.test(windowDocument), false, 'the wallpaper window document gained a script')
  assert.match(windowDocument, /script-src 'none'/, 'the wallpaper window document no longer forbids scripts')
  assert.match(windowDocument, /pointer-events: none/, 'the wallpaper window document can be a hit target')

  /**
   * The video pipeline is retired, and the retirement is asserted rather than assumed.
   *
   * §30's Phase 7 removes this product's duplicate of the plugin's features, and a duplicate that is
   * merely unused comes back the first time someone needs a video: the element, the playback state and
   * the `file:` source path are each a thing that would have to be kept right alongside the plugin's own.
   * So the assertion is that none of them is left anywhere between the backend and the document.
   */
  const backend = read('app/extensions/mega/wallpaper.cjs')
  assert.equal(/wallpaperVideo|<video/.test(html), false, 'the retired video element is still in the dock document')
  assert.equal(/wallpaperVideo|isVideo|\bmuted\b|\.play\(\)/.test(layer), false, 'the retired video pipeline is still in the layer script')
  assert.equal(/VIDEO_TARGETS|WALLPAPER_KINDS\.video|=== 'video'|'video'\]/.test(backend), false, 'the backend still speaks a video kind')
  // One source path for the dock and the official surfaces, and it is the inline asset. A `file:` URL is what
  // the removed video needed, and it is also the only shape in which a raw path could reach a document, so
  // nothing may build one any more.
  assert.match(backend, /src: inlined\.dataUrl,/, 'the dock is no longer handed the same inline asset the official surfaces get')
  assert.equal(/file:\/\/\$\{|'file:\/\/'|`file:\/\//.test(`${backend}\n${layer}`), false, 'the layer can still build a file: URL')
  assert.match(backend, /kindOf\(chosen\)/, 'the file kind is no longer asked before a path is accepted')

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
