'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The official surfaces as the desktop shell builds them (Update-Plan 任务 2 / 任务 3 / 任务 18).
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *
 *   - the official shell and overlay must be REAL views, stacked around the
 *     official renderer, following its bounds;
 *   - the official renderer must stay untouched, and neither new view may take a
 *     click, a key or a scroll away from it.
 *
 * The Electron `View`/`WebContentsView` classes are stubbed here exactly as far as
 * the module uses them, which is what lets these be unit tests: the module's own
 * behaviour (stacking order, bounds, the protected-surface refusal, failure
 * isolation) is asserted directly, and the shell's wiring of it is asserted from
 * source so a regression cannot hide behind a stub.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const modulePath = path.join(ROOT, 'app', 'official-surface-views.cjs')
const { createOfficialSurfaceViews, SURFACE, PAINTABLE } = require(modulePath)

/** A minimal WebContentsView stand-in that records everything it is asked to do. */
function makeFakeViewClass(records) {
  return class FakeWebContentsView {
    constructor(options) {
      this.webPreferences = options?.webPreferences || {}
      this.childrenAdded = []
      this.bounds = null
      this.ignoreMouse = null
      this.css = []
      this.loaded = null
      this.inserted = 0
      this.removed = 0
      this.executed = 0
      this.calls = []
      const own = this
      this.webContents = {
        isDestroyed: () => false,
        getURL: () => 'file:///fake',
        on: (event) => { own.calls.push(`on:${event}`) },
        loadFile: async (file) => { own.loaded = file; return undefined },
        insertCSS: async (css) => { own.inserted += 1; own.css.push(css); return `key-${own.inserted}` },
        removeInsertedCSS: async () => { own.removed += 1 },
        setFocusable: (value) => { own.focusable = value },
        executeJavaScript: async () => { own.executed += 1; return null },
        close: () => {}
      }
    }

    setBounds(bounds) { this.bounds = bounds; this.calls.push('setBounds') }
    getBounds() { return this.bounds }
    setBackgroundColor() { this.calls.push('setBackgroundColor') }
    setIgnoreMouseEvents(value, options) { this.ignoreMouse = { value, options }; this.calls.push('setIgnoreMouseEvents') }
  }
}

function makeHarness() {
  const records = {
    shell: null,
    official: null,
    overlay: null,
    added: []
  }
  const Fake = makeFakeViewClass(records)
  const official = new Fake()
  official.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  records.official = official
  const window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view) => {
        records.added.push(view)
        // Keyed by the surface the view declares, not by call order, so a test
        // that only creates one of them still finds it.
        if (view.surface === SURFACE.OFFICIAL_SHELL) records.shell = view
        else if (view.surface === SURFACE.OFFICIAL_OVERLAY) records.overlay = view
      },
      removeChildView: () => {}
    },
    getContentSize: () => [1488, 920]
  }
  const views = createOfficialSurfaceViews({
    getWindow: () => window,
    getOfficialView: () => official,
    getWindowSize: () => [1488, 920],
    getDockWidth: () => 560,
    log: () => {},
    electron: { WebContentsView: Fake }
  })
  return { views, records, official }
}

const SHELL_PAYLOAD = {
  id: 'hns.test',
  tokens: {
    'official.shell.padding': '6px',
    'official.shell.radius': '12px',
    'official.vignette.opacity': '0.1',
    'official.scanline.opacity': '0.02',
    'official.texture.opacity': '0.14',
    'official.character.opacity': '0.85',
    'asset.official_skin': 'data:image/png;base64,AAAA'
  },
  slots: {
    'official.shell.background': { background: '#101724' },
    'official.shell.frame': { border: '1px solid #33405a', radius: '12px', shadow: '0 8px 22px rgba(0,0,0,.5)', padding: '6px' },
    'official.shell.border': { border: '1px solid #33405a' },
    'official.overlay.global_tint': { color: '#0b0d12', opacity: 0.1 },
    'official.overlay.gradient': { opacity: 0.08, angle: 160, stops: [{ at: 0, color: '#0b0d12' }, { at: 1, color: '#1b2130' }] },
    'official.overlay.texture': { asset: 'data:image/png;base64,BBBB', opacity: 0.14 },
    'official.overlay.skin': { asset: 'data:image/png;base64,CCCC', opacity: 0.5 },
    'official.overlay.vignette': { opacity: 0.1 },
    'official.overlay.scanline': { opacity: 0.02, spacing: 4, width: 1 },
    'official.overlay.frame_glow': { opacity: 0.3, width: 4, color: '#4d93f8' },
    'official.overlay.corner_decoration': { asset: 'data:image/png;base64,DDDD', opacity: 0.4, anchor: 'bottom-right' },
    'official.overlay.character_primary': { asset: 'data:image/png;base64,EEEE', opacity: 0.85, anchor: 'bottom-right', crop: 'contain' }
  },
  effectLevel: 0
}

test('the module declares exactly the two paintable surfaces and never the renderer', () => {
  assert.deepEqual([...PAINTABLE], ['official_shell', 'official_overlay'])
  assert.equal(PAINTABLE.includes(SURFACE.OFFICIAL_RENDERER), false)
})

test('painting the protected renderer is refused by the runtime, not just by convention', () => {
  const { views } = makeHarness()
  views.createShell()
  views.createOverlay()
  const refused = views.paintSurface('official_renderer', SHELL_PAYLOAD)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'surface_protected')
  assert.match(refused.message, /not paintable/)
  // The full paint path only ever touches the two paintable surfaces.
  const result = views.paintTheme(SHELL_PAYLOAD)
  assert.deepEqual(Object.keys(result.surfaces).sort(), ['official_overlay', 'official_shell'])
})

test('the shell is added before the official view and the overlay after it', () => {
  const { views, records } = makeHarness()
  views.createShell()
  views.createOverlay()
  assert.equal(records.added.length, 2)
  // The shell is added first (so the official view paints over its centre) and the
  // overlay last (so it stacks on top). That ordering is the entire technique.
  assert.equal(records.added[0], records.shell)
  assert.equal(records.added[1], records.overlay)
  assert.notEqual(records.shell, records.overlay)
})

test('the overlay is visual-only: mouse-transparent and never focusable', () => {
  const { views, records } = makeHarness()
  views.createOverlay()
  assert.equal(records.overlay.ignoreMouse.value, true)
  assert.deepEqual(records.overlay.ignoreMouse.options, { forward: false })
  assert.equal(records.overlay.webPreferences.focusable, false)
  assert.equal(records.overlay.focusable, false)
  assert.deepEqual(views.describe().surfaces.find((entry) => entry.id === 'official_overlay').input, {
    pointer: 'passthrough',
    keyboard: 'passthrough',
    focus: 'none',
    scroll: 'passthrough'
  })
})

test('the overlay follows the official view bounds exactly; the shell spans the window', () => {
  const { views, records, official } = makeHarness()
  views.createShell()
  views.createOverlay()
  views.applyLayout()
  assert.deepEqual(records.overlay.bounds, { x: 0, y: 0, width: 900, height: 700 })
  assert.deepEqual(records.shell.bounds, { x: 0, y: 0, width: 1488, height: 920 })

  // Resize: the overlay must track the official view, not stay where it was.
  official.setBounds({ x: 0, y: 0, width: 640, height: 480 })
  views.applyLayout()
  assert.deepEqual(records.overlay.bounds, { x: 0, y: 0, width: 640, height: 480 }, 'the overlay re-laid out after a resize')
  assert.deepEqual(records.shell.bounds, { x: 0, y: 0, width: 1488, height: 920 })
})

test('a theme payload reaches both surfaces as CSS variables, and the overlay can be turned off', async () => {
  const { views, records } = makeHarness()
  views.createShell()
  views.createOverlay()
  const result = views.paintTheme(SHELL_PAYLOAD)
  assert.equal(result.ok, true, JSON.stringify(result.surfaces))
  await views.settle()
  assert.ok(records.shell.css.length >= 1, 'the shell received a stylesheet')
  assert.ok(records.overlay.css.length >= 1, 'the overlay received a stylesheet')
  assert.match(records.shell.css.join('\n'), /--shell-padding: 6px/)
  assert.match(records.overlay.css.join('\n'), /--ov-tint-opacity: 0\.1/)
  assert.match(records.overlay.css.join('\n'), /--ov-character-opacity: 0\.85/)
  // The character's asset really arrived as an inline image.
  assert.match(records.overlay.css.join('\n'), /url\("data:image\/png;base64,EEEE"\)/)
  // Each repaint replaces the previous rule rather than accumulating them.
  const beforeInserted = records.overlay.inserted
  views.paintTheme(SHELL_PAYLOAD)
  await views.settle()
  assert.ok(records.overlay.removed >= 1, 'the previous rule was removed')
  assert.ok(records.overlay.inserted > beforeInserted)

  // A theme with every overlay component off hides the overlay rather than leaving
  // an empty layer on screen.
  const dark = {
    ...SHELL_PAYLOAD,
    slots: Object.fromEntries(Object.entries(SHELL_PAYLOAD.slots).map(([id, payload]) => [
      id,
      /^official\.overlay\./.test(id) ? { ...payload, opacity: 0, enabled: false, asset: 'none' } : payload
    ]))
  }
  views.paintTheme(dark)
  await views.settle()
  assert.match(records.overlay.css.join('\n'), /body > \.layer \{ display: none !important; \}/)
})

test('the character placement from the layout engine is applied as a box', async () => {
  const { views, records } = makeHarness()
  views.createOverlay()
  views.paintTheme(SHELL_PAYLOAD)
  await views.settle()
  const before = records.overlay.inserted
  views.applyOverlayPlacement({
    mode: 'corner',
    anchor: 'bottom-right',
    placements: {
      character_primary: { box: { x: 640, y: 200, width: 220, height: 330 }, anchor: 'bottom-right' },
      corner_decoration: { box: { x: 700, y: 560, width: 120, height: 120 } }
    }
  })
  await views.settle()
  assert.ok(records.overlay.inserted > before, 'the placement produced a rule')
  await views.settle()
  const placementCss = records.overlay.css[records.overlay.css.length - 1]
  assert.match(placementCss, /#character \{ position: absolute; width: 220px; height: 330px;/)
  assert.match(placementCss, /right: 8px; bottom: 8px/)
  assert.match(placementCss, /#decoration \{ position: absolute; width: 120px; height: 120px;/)
})

test('resetting restores the default frame and leaves no overlay component enabled', async () => {
  const { views, records } = makeHarness()
  views.createShell()
  views.createOverlay()
  views.paintTheme(SHELL_PAYLOAD)
  const result = views.reset()
  assert.equal(result.ok, true)
  await views.settle()
  const overlayCss = records.overlay.css.join('\n')
  assert.match(overlayCss, /--ov-character-opacity: 0/)
  assert.match(overlayCss, /--ov-tint-opacity: 0/)
  assert.match(records.shell.css.join('\n'), /--shell-padding: 6px/)
})

test('a surface failure disables that surface and nothing else', async () => {
  const { views, records } = makeHarness()
  views.createShell()
  views.createOverlay()
  // The overlay's renderer dies: the shell must keep painting, and the description
  // must record the degradation rather than pretending the overlay is fine. The
  // failure surfaces when the queued write settles, which is what `settle()` is for.
  records.overlay.webContents.insertCSS = () => { throw new Error('renderer gone') }
  const result = views.paintTheme(SHELL_PAYLOAD)
  assert.equal(result.surfaces.official_shell.ok, true, 'the shell still painted')
  await views.settle()
  const described = views.describe()
  assert.ok(described.degradation.some((entry) => entry.surface === 'official_overlay'), JSON.stringify(described.degradation))
  assert.equal(Boolean(records.shell.css.length), true, 'the shell received its stylesheet')
  // The protected surface record is explicit about what was never done to it.
  assert.deepEqual(described.protected, {
    id: 'official_renderer',
    writable: false,
    painted: false,
    injection_apis_used: []
  })
})

test('disabling the surfaces makes every paint a reported no-op', () => {
  const { views } = makeHarness()
  views.createShell()
  views.createOverlay()
  views.setEnabled(false)
  const result = views.paintTheme(SHELL_PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'surfaces_disabled')
  assert.deepEqual(result.surfaces, {})
  assert.equal(views.isEnabled(), false)
})

test('the module has no code path that can execute script in, or style, the official renderer', () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  // `officialView` may only appear as the *getter* the manager was handed, and only
  // to read its bounds.
  const officialViewMentions = source.split('officialView').length - 1
  assert.equal(officialViewMentions <= 3, true, `officialView is referenced ${officialViewMentions} times; expected only the bounds getter`)
  const getterBody = source.slice(source.indexOf('function officialBounds()'), source.indexOf('function surfaceBounds'))
  assert.match(getterBody, /getBounds/)
  assert.equal(/webContents|executeJavaScript|insertCSS|loadURL/.test(getterBody), false, 'reading bounds reads nothing else')
  // Script execution is never attempted anywhere in the module.
  assert.equal(source.includes('executeJavaScript'), false)
  // Styling goes through one helper, and that helper can only be handed one of the
  // module's own two views: there is no third view for it to be pointed at.
  const applyCss = source.slice(source.indexOf('function applyCss'), source.indexOf('function shellCss'))
  assert.match(applyCss, /contents\.insertCSS\(css\)/, 'the only insertCSS call takes the helper parameter')
  assert.match(applyCss, /removeInsertedCSS/, 'the previous rule is removed rather than accumulated')
  assert.equal(/officialView/.test(applyCss), false)
  assert.match(source, /const view = surfaceId === SURFACE\.OFFICIAL_SHELL \? shellView : overlayView/)
})

test('the shell wires the surfaces around the official view and hands over an adapter, not a webContents', () => {
  // Read with LF endings: the assertions below are about the code, and a
  // checkout that rewrote line endings used to turn them into line-ending
  // assertions (invisible on Linux, red on a Windows runner).
  const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8').replace(/\r\n/g, '\n')
  // The official view is created first (centre), then the surfaces...
  assert.match(main, /await createOfficialHarnessView\(readyUrl\)/)
  assert.match(main, /await createOfficialSurfaces\(\)/)
  // ...and, since Update-Plan/Dual-UI.md 任务 1, the shell is the only surface
  // created by default: the overlay is DEPRECATED and explicitly opt-in, because
  // Work Mode must stay untouched official UI.
  assert.match(main, /official_shell view attached \(visual-only, input passthrough\)/)
  assert.match(main, /const OFFICIAL_OVERLAY_ENABLED = process\.env\.DSH_OFFICIAL_OVERLAY === '1'/)
  assert.match(main, /if \(OFFICIAL_OVERLAY_ENABLED\) \{\n\s*officialSurfaces\.createOverlay\(\)/)
  const surfacesFactory = main.slice(main.indexOf('async function createOfficialSurfaces('), main.indexOf('async function createIntegratedMegaDock'))
  const overlayCalls = surfacesFactory.match(/officialSurfaces\.createOverlay\(\)/g) || []
  assert.equal(overlayCalls.length, 1, 'the overlay is created in exactly one place, inside the opt-in guard')
  // ...and the extension receives an adapter whose only operation is a paint.
  assert.match(main, /function createOfficialSurfaceAdapter\(\)/)
  assert.match(main, /officialSurfaceAdapter,/)
  const adapter = main.slice(main.indexOf('function createOfficialSurfaceAdapter'), main.indexOf('function notifyDockReady'))
  assert.match(adapter, /paint: \(payload, placement = null\) =>/)
  assert.match(adapter, /reset: \(\) =>/)
  assert.match(adapter, /officialBounds: \(\) =>/)
  // The adapter never exposes the official webContents or an injection API.
  for (const forbidden of ['executeJavaScript', 'insertCSS', 'officialView.webContents']) {
    assert.equal(adapter.includes(forbidden), false, `the surface adapter must not expose ${forbidden}`)
  }
  // The shell still creates the official window with no preload at all.
  const createWindowBody = main.slice(main.indexOf('function createWindow()'), main.indexOf('async function startExtensions'))
  assert.equal(/preload\s*:/.test(createWindowBody), false)
})

test('the shell creates the native renderer once and switches by visibility only (任务 15 / 任务 17)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  const create = main.slice(main.indexOf('async function createNativeFrontendView'), main.indexOf('function createNativeThemeAdapter'))
  // Exactly one construction, guarded by the "already exists" early return.
  const constructions = create.match(/new WebContentsView\(/g) || []
  assert.equal(constructions.length, 1, 'the native view is constructed in exactly one place')
  assert.match(create, /if \(nativeView\) \{\n\s*layoutIntegratedViews\(\)\n\s*return true/)
  assert.match(create, /preload: path\.join\(__dirname, 'native-ui', 'preload\.cjs'\)/)
  assert.match(create, /loadFile\(path\.join\(__dirname, 'native-ui', 'index\.html'\)\)/)

  // Switching is bounds/visibility only: no renderer is created or destroyed.
  const apply = main.slice(main.indexOf('function applyFrontendVisibility'), main.indexOf('function createFrontendModes'))
  assert.match(apply, /setViewVisibility\(nativeView, daily\)/)
  assert.match(apply, /setViewVisibility\(officialView, !daily\)/)
  assert.equal(/new WebContentsView|destroy\(|close\(\)/.test(apply), false, 'a switch never touches renderer lifetime')

  // The deprecated overlay is not created on the default startup path.
  assert.match(main, /officialSurfaceAdapter,/)
  assert.match(main, /nativeThemeTarget: createNativeThemeAdapter\(\)/)
  assert.match(main, /nativeMode: createNativeModeAdapter\(\)/)
  assert.match(main, /nativeFrontend: frontendModes/)
})

test('the two surface documents carry no script, and are input-transparent', () => {
  for (const file of ['hns-shell.html', 'official-overlay.html']) {
    const raw = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', file), 'utf8')
    // Comments explain what the document *avoids*, so they are stripped before the
    // markup is inspected: a rule that matched its own documentation would be a
    // false positive, and one that only matched documentation would be useless.
    const markup = raw.replace(/<!--[\s\S]*?-->/g, '')
    assert.equal(/<script/i.test(markup), false, `${file} contains no script element`)
    assert.equal(/\son[a-z]+\s*=/i.test(markup), false, `${file} contains no inline event handler`)
    assert.match(raw, /script-src 'none'/, `${file} declares a policy that forbids script`)
    assert.match(markup, /pointer-events:\s*none/, `${file} never owns a hit target`)
    assert.match(markup, /data-surface="(official_shell|official_overlay)"/, `${file} declares its surface`)
    assert.match(markup, /data-permission="(full|visual-only)"/, `${file} declares its permission`)
    // No form control and no focusable attribute: nothing can steal focus.
    assert.equal(/<(input|button|textarea|select|a)\b/i.test(markup), false, `${file} has no interactive element`)
    assert.equal(/tabindex|autofocus/i.test(markup), false, `${file} has no focusable attribute`)
  }
  const overlay = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'official-overlay.html'), 'utf8')
  // Every layer the plan can enable has a home in the document.
  for (const id of ['tint', 'gradient', 'texture', 'skin', 'vignette', 'scanline', 'frame-glow', 'decoration', 'character']) {
    assert.ok(overlay.includes(`id="${id}"`), `the overlay document has a ${id} layer`)
  }
  const shell = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'hns-shell.html'), 'utf8')
  for (const id of ['frame', 'frame-asset', 'band', 'separator', 'glow', 'window-hole']) {
    assert.ok(shell.includes(`id="${id}"`), `the shell document has a ${id} layer`)
  }
})

test('every document a surface view loads resolves to a real file on disk', () => {
  // A stub that records `loadFile(path)` cannot tell a correct path from a
  // broken one. This resolves each `path.join(__dirname, ...)` the module builds
  // against the app directory and asserts the file exists - the check that
  // catches "the surface silently degraded with ERR_FILE_NOT_FOUND".
  const appDir = path.join(ROOT, 'app')
  const source = fs.readFileSync(modulePath, 'utf8')
  const targets = []
  for (const match of source.matchAll(/path\.join\(__dirname,([^)]*)\)/g)) {
    const parts = [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1])
    if (!parts.length) continue
    targets.push(path.join(appDir, ...parts))
  }
  assert.ok(targets.length >= 2, `expected the shell and overlay documents, found ${targets.length}`)
  for (const target of targets) {
    assert.equal(fs.existsSync(target), true, `surface document missing on disk: ${target}`)
    assert.equal(path.relative(appDir, target).startsWith('..'), false, `surface document must live under app/: ${target}`)
  }
})
