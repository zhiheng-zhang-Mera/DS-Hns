'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Theme asset resolution at paint time.
 *
 * The bug this covers reached the product: a theme applied completely and still
 * showed only different colours, because its imagery was declared as a
 * package-relative `assets/...` reference (unresolvable from the renderer's own
 * document) or as a `var(--hns-asset-*)` reference (a custom-property reference in
 * a slot property that a renderer treats as a URL). Every token landed; every
 * image was dropped.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const resolver = require('../../app/extensions/mega/theme/assets/resolver')
const preview = require('../../app/extensions/mega/theme/preview')
const recovery = require('../../app/extensions/mega/theme/recovery')
const contract = require('../../app/extensions/mega/theme/contract')
const registry = require('../../app/extensions/mega/theme/registry')

/** A 1x1 transparent PNG, so the fixtures carry a real image. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function tempPackage({ manifest = {}, tokens = {}, components = {}, persona = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-theme-assets-'))
  fs.mkdirSync(path.join(dir, 'assets', 'persona'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'assets', 'decorations'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'assets', 'persona', 'avatar.png'), PNG_1X1)
  fs.writeFileSync(path.join(dir, 'assets', 'persona', 'banner.png'), PNG_1X1)
  fs.writeFileSync(path.join(dir, 'assets', 'decorations', 'corners.png'), PNG_1X1)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'hns.test.assets',
    name: 'Assets',
    source: 'user',
    theme_api_version: contract.THEME_API_VERSION,
    supported_apps: ['hns'],
    ...manifest
  }))
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(tokens))
  fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify(components))
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(persona))
  return dir
}

test('a package-relative asset reference is inlined as a data URI', () => {
  const dir = tempPackage()
  const result = resolver.resolveThemeAssets({
    id: 't',
    dir,
    tokens: {},
    components: { slots: { 'hns.persona.decoration': { asset: 'assets/decorations/corners.png', opacity: 0.2 } } }
  })
  assert.match(result.slots['hns.persona.decoration'].asset, /^data:image\/png;base64,/)
  assert.equal(result.slots['hns.persona.decoration'].opacity, 0.2, 'other properties are untouched')
  assert.equal(result.unresolved.length, 0)
  assert.equal(result.resolved[0].from, 'file')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an asset-variable reference resolves to the compiled token value', () => {
  const dataUri = `data:image/png;base64,${PNG_1X1.toString('base64')}`
  const result = resolver.resolveThemeAssets({
    id: 't',
    dir: null,
    tokens: { 'asset.wallpaper': dataUri },
    components: { slots: { 'hns.window.background': { background: 'var(--hns-asset-wallpaper)', overlay: 'var(--hns-asset-overlay)' } } }
  })
  assert.equal(result.slots['hns.window.background'].background, dataUri)
  assert.equal(result.slots['hns.window.background'].overlay, 'none', 'an unfilled variable falls back to none, not to a broken reference')
})

test('a missing asset file falls back to the role token, then to none', () => {
  const dir = tempPackage({ tokens: { 'asset.decoration': `data:image/png;base64,${PNG_1X1.toString('base64')}` } })
  const withToken = resolver.resolveThemeAssets({
    id: 't',
    dir,
    tokens: { 'asset.decoration': `data:image/png;base64,${PNG_1X1.toString('base64')}` },
    components: { slots: { 'hns.persona.decoration': { asset: 'assets/decorations/gone.png' } } }
  })
  assert.match(withToken.slots['hns.persona.decoration'].asset, /^data:image\/png/)
  assert.equal(withToken.resolved[0].from, 'token-fallback')

  const withoutToken = resolver.resolveThemeAssets({
    id: 't',
    dir,
    tokens: {},
    components: { slots: { 'hns.persona.decoration': { asset: 'assets/decorations/gone.png' } } }
  })
  assert.equal(withoutToken.slots['hns.persona.decoration'].asset, 'none')
  assert.equal(withoutToken.unresolved.length, 1)
  assert.equal(withoutToken.unresolved[0].reason, 'asset_unreadable')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an asset reference can never escape its own package', () => {
  const dir = tempPackage()
  const outside = path.join(path.dirname(dir), 'outside.png')
  fs.writeFileSync(outside, PNG_1X1)
  const result = resolver.resolveThemeAssets({
    id: 't',
    dir,
    tokens: {},
    components: { slots: { 'hns.persona.decoration': { asset: 'assets/../../outside.png' } } }
  })
  assert.equal(result.slots['hns.persona.decoration'].asset, 'none', 'a traversal reference is refused')
  fs.rmSync(outside, { force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('inline data URIs, colours and keywords are passed through untouched', () => {
  const result = resolver.resolveThemeAssets({
    id: 't',
    dir: null,
    tokens: {},
    components: {
      slots: {
        'common.button.primary': { background: '#4d93f8', label: 'rgb(1,2,3)' },
        'hns.window.background': { background: 'data:image/png;base64,AAAA' },
        'hns.worker.card': { background: 'linear-gradient(180deg, #111, #222)', border: '1px solid #333' }
      }
    }
  })
  assert.equal(result.slots['common.button.primary'].background, '#4d93f8')
  assert.equal(result.slots['hns.window.background'].background, 'data:image/png;base64,AAAA')
  assert.match(result.slots['hns.worker.card'].background, /^linear-gradient/)
  assert.equal(result.slots['hns.worker.card'].border, '1px solid #333')
})

test('a persona avatar declared as a relative path resolves as well', () => {
  const dir = tempPackage()
  const result = resolver.resolveThemeAssets({
    id: 't',
    dir,
    tokens: {},
    components: { slots: {} },
    persona: { enabled: true, avatar: 'assets/persona/avatar.png', banner: 'assets/persona/banner.png' }
  })
  assert.match(result.persona.avatar, /^data:image\/png;base64,/)
  assert.match(result.persona.banner, /^data:image\/png;base64,/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('asset tokens reach CSS as url(), so background-image actually works', () => {
  const css = preview.toCssVariables({
    tokens: {
      'asset.wallpaper': 'data:image/png;base64,AAAA',
      'asset.decoration': 'none',
      'color.bg.base': '#0b0e14'
    }
  })
  assert.match(css, /--hns-asset-wallpaper: url\("data:image\/png;base64,AAAA"\);/)
  assert.match(css, /--hns-asset-decoration: none;/)
  assert.match(css, /--hns-color-bg-base: #0b0e14;/, 'non-asset tokens are emitted verbatim')
})

test('the renderer payload carries resolved slots and an honest asset report', () => {
  const dir = tempPackage({ tokens: { 'asset.persona_avatar': `data:image/png;base64,${PNG_1X1.toString('base64')}` } })
  const payload = preview.toRendererPayload({
    id: 'hns.test.assets',
    dir,
    manifest: { name: 'Assets' },
    tokens: { 'asset.persona_avatar': `data:image/png;base64,${PNG_1X1.toString('base64')}` },
    components: {
      slots: {
        'hns.persona.decoration': { asset: 'assets/decorations/corners.png', opacity: 0.2 },
        'hns.persona.banner': { asset: 'assets/persona/banner.png', opacity: 0.2 },
        'hns.operator.avatar': { asset: 'assets/persona/avatar.png', size: '32px' }
      }
    },
    persona: { enabled: true, prominence: 0.2 }
  })
  assert.match(payload.slots['hns.persona.decoration'].asset, /^data:image\/png/)
  assert.match(payload.slots['hns.persona.banner'].asset, /^data:image\/png/)
  assert.match(payload.slots['hns.operator.avatar'].asset, /^data:image\/png/)
  assert.equal(payload.persona.decorationOpacity, 0.2)
  assert.equal(payload.persona.bannerOpacity, 0.2)
  assert.match(payload.persona.avatarAsset, /^data:image\/png/, 'the persona block carries the resolved avatar')
  assert.ok(payload.assets.resolved.length >= 3, 'the resolver reports what it resolved')
  assert.deepEqual(payload.assets.unresolved, [])
  // The report is diagnostics for the renderer: plain data, and no absolute path
  // that would leak the user's filesystem layout.
  assert.equal(/:[\\/]/.test(JSON.stringify(payload.assets.resolved.map((entry) => entry.source))), false)
  assert.equal(typeof payload.assets.resolved[0].slot, 'string')
  assert.equal(typeof payload.assets.resolved[0].from, 'string')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the shipped built-in themes resolve their real imagery', () => {
  // The regression that reached the product: the built-in packages declare their
  // wallpaper through a token variable and their persona/decoration as relative
  // paths, and nothing resolved either one at paint time.
  // The registry owns the directory -> id mapping (a directory name is not the
  // theme id), so the packages are loaded exactly the way the product loads them.
  for (const id of ['hns.demo.minimal', 'hns.demo.anime-persona', 'hns.demo.cyber-hud']) {
    const entry = registry.builtinSpecs().find((theme) => theme.id === id)
    assert.ok(entry, `${id} is a built-in theme`)
    const loaded = recovery.loadPackage(entry.dir, entry.id)
    assert.equal(loaded.ok, true, `${id} loads`)
    const payload = preview.toRendererPayload(loaded.theme)
    const background = payload.slots['hns.window.background'] || {}
    const decoration = payload.slots['hns.persona.decoration'] || {}
    assert.match(String(background.background), /^data:image\/png/, `${id}: the wallpaper is an inline image`)
    assert.match(String(background.overlay ?? ''), /(data:image|none|url\()/, `${id}: the overlay is usable`)
    if (decoration.asset) {
      assert.match(String(decoration.asset), /^(data:image|none)/, `${id}: the decoration is an inline image`)
    }
    // And the token block the renderer installs carries the same image as a url().
    assert.match(payload.css, /--hns-asset-wallpaper: url\("data:image\/png/)
  }
})
