'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Surface ownership (`updateplan/startup2.md` §48, §55's "CSS ownership", §27's token boundary).
 *
 * Three boundaries this product draws between its own surfaces, each of them checkable rather than described:
 *
 *   1. **Every channel the dock can call is owned by exactly one module.** The preload is the dock's whole
 *      reachable surface; a channel it can invoke that no module declares is a channel the cleanup path and the
 *      feature gate do not know about — which is how a "removed" feature keeps working.
 *   2. **The appearance vocabulary crosses the boundary and nothing else does.** `--dsh-*` is the published,
 *      validated set (§27); it belongs to `appearance/tokens.cjs`, the layer that consumes the picture tokens,
 *      and nowhere else.
 *   3. **One stylesheet, one document.** The dock's stylesheet may not reach into the wallpaper layer's private
 *      ids, and the layer document may not style the dock's.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** Channel literals a file hands to `ipcRenderer`, and whether any of them is built dynamically. */
function preloadChannels() {
  const source = read('app/extensions/mega/ui/preload.cjs')
  const channels = [...source.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*'([^']+)'/g)].map((match) => match[1])
  // A channel assembled at runtime cannot be audited, so it is itself a finding.
  const dynamic = [...source.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*(?!')/g)]
  return { channels: [...new Set(channels)], dynamic: dynamic.length }
}

/** The channel names the extension declares for its own surface, plus the shell's four feature families. */
function declaredChannels() {
  const index = read('app/extensions/mega/index.cjs')
  const main = read('app/desktop-main.cjs')
  const declared = new Set()
  for (const match of index.matchAll(/'([a-z0-9-]+:[a-z0-9-]+)'/g)) declared.add(match[1])
  for (const match of main.matchAll(/'((?:computer-use|engineering|plugins|sub-worker):[a-z0-9-]+)'/g)) declared.add(match[1])
  return declared
}

test('every channel the dock can call is owned by a module that declares it', () => {
  const { channels, dynamic } = preloadChannels()
  const declared = declaredChannels()
  assert.ok(channels.length > 50, `the preload is expected to expose the dock's whole surface, found ${channels.length}`)
  const unowned = channels.filter((channel) => !declared.has(channel))
  assert.deepEqual(unowned, [], `these channels have no owner: ${unowned.join(', ')}`)
  assert.equal(dynamic, 0, 'a channel built at runtime cannot be audited by the cleanup path or the feature gate')
})

test('the appearance vocabulary crosses the boundary, and nothing else does', () => {
  /**
   * Who owns the vocabulary: the appearance boundary itself (its whole directory — the validator, the presets
   * that declare their numbers as tokens, the controller), the wallpaper layer that writes the picture's four
   * tokens into its own document, and that document, which consumes them. Nobody else.
   */
  const isOwner = (file) => file.startsWith('app/extensions/mega/appearance/')
    || file === 'app/extensions/mega/wallpaper.cjs'
    || file === 'app/extensions/mega/ui/wallpaper-window.html'
  const users = []
  for (const file of filesUnder('app')) {
    if (!/\.(cjs|js|html|css)$/.test(file)) continue
    if (isOwner(file)) continue
    if (/--dsh-/.test(read(file))) users.push(file)
  }
  assert.deepEqual(users, [], `only the appearance boundary may speak the token vocabulary: ${users.join(', ')}`)
  // The boundary itself is what defines the names, and the layer document consumes the four picture tokens.
  assert.match(read('app/extensions/mega/appearance/tokens.cjs'), /APPEARANCE_TOKENS = Object\.freeze\(\{/)
  assert.match(read('app/extensions/mega/ui/wallpaper-window.html'), /var\(--dsh-wallpaper-brightness/)
})

test('one stylesheet, one document', () => {
  const dockCss = read('app/extensions/mega/ui/dock.css')
  const layerDocument = read('app/extensions/mega/ui/wallpaper-window.html')
  // The dock has its own #wallpaper element, but the layer's scrim and its token names are not the dock's.
  assert.equal(/#wallpaper-scrim/.test(dockCss), false, 'the dock styles the layer document\'s own elements')
  assert.equal(/#wp-/.test(dockCss), false, 'the dock styles the layer document\'s private variables')
  // And the layer document stays a background: it does not know the dock exists.
  for (const selector of ['#rail', '#detail', '.panel']) {
    assert.equal(layerDocument.includes(selector), false, `the layer document styles the dock (${selector})`)
  }
})

/** Every file under a directory, relative to the repository root. */
function filesUnder(directory) {
  const found = []
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else found.push(next)
    }
  }
  walk(directory)
  return found
}
