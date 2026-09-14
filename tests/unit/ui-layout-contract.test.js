'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The dock's layout contracts.
 *
 * Three of them are about what the user asked for in as many words, and each is checkable in
 * the shipped files: the skills module's view switch is its first control and is legible, a
 * module's title and collapse button stay on screen while that module is in view, and the dock
 * gets out of the way when the user turns to the official UI.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('the four counters are one row inside one card, and that card does not fold', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const css = read('app/extensions/mega/ui/dock.css')

  // The overview is a panel like every module below it, and the counters live inside it.
  const panel = html.match(/<section class="panel summary-panel" id="summaryPanel"([^>]*)>([\s\S]*?)<\/section>\s*<\/section>/)
  assert.ok(panel, 'the counters are not inside a module card')
  assert.match(panel[2], /<section id="summary" class="summary-grid">/, 'the counters are outside the card')
  assert.match(panel[2], /class="bi-title"/, 'the module has no bilingual heading')
  // It is the dock's first line, so it is not one of the modules that folds.
  assert.match(panel[1], /data-no-collapse/, 'the overview can be folded away')
  assert.match(read('app/extensions/mega/ui/dock.js'), /dataset\.noCollapse !== undefined\) continue/, 'the collapse setup ignores the opt-out')

  // One row, four columns: the counters are read together or not at all.
  const grid = css.match(/\.summary-grid\{([^}]*)\}/)
  assert.ok(grid, '.summary-grid has no rule')
  assert.match(grid[1], /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, 'the counters are not one row of four')

  // And it stays one row at *every* dock width. This is the assertion the defect needed: the
  // narrow-width fallback used to re-declare `.summary-grid` as 2x2, and the dock is 560px wide by
  // default, so the fallback was what the user actually saw — a 2x2 grid in a one-row module. A
  // later media query that names it again is the same bug coming back.
  const mediaQueries = css.match(/@media[^{]*\{[^@]*?\}\}/g) || []
  assert.ok(mediaQueries.length > 0, 'the stylesheet has no media queries to check')
  for (const query of mediaQueries) {
    assert.equal(/\.summary-grid/.test(query), false, `a media query rewrites the overview row: ${query.slice(0, 80)}`)
  }
  // The cards are sized for the narrowest dock instead: 4 x 92px plus gutters fits inside the card
  // at 440px, so the row never has to wrap.
  const card = css.match(/\.summary-card\{([^}]*)\}/)
  assert.match(card[1], /padding:8px 6px/, 'the counters are not sized for four in a row')
  assert.match(grid[1], /gap:6px/, 'the counters are not sized for four in a row')
  assert.equal(/margin-bottom/.test(grid[1]), false, 'the grid spaces itself; the card already does')
})

test('the skills view switch is the module\'s first control', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const panel = html.slice(html.indexOf('id="skillsPanel"'), html.indexOf('id="queuePanel"'))
  const tabs = panel.indexOf('id="skillsTabBrowse"')
  const install = panel.indexOf('id="skillSource"')
  const search = panel.indexOf('id="skillQuery"')
  const list = panel.indexOf('id="skillsList"')
  assert.ok(tabs > 0 && install > 0 && search > 0 && list > 0)
  // 发现 / 已安装 decides what everything below it means, so it comes first.
  assert.ok(tabs < install, 'the view switch must come before the install bar')
  assert.ok(tabs < search, 'the view switch must come before the search box')
  assert.ok(search < list)
  // Both languages, and the English one is a smaller line rather than a second button.
  assert.match(panel, /id="skillsTabBrowse"[^>]*>发现 <small>Discover<\/small>/)
  assert.match(panel, /id="skillsTabInstalled"[^>]*>已安装 <small>Installed<\/small>/)
})

test('every element of the skills module is sized to be recognised', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const rule = (selector) => {
    const match = css.match(new RegExp(`\\${selector}\\{([^}]*)\\}`))
    assert.ok(match, `${selector} has no rule`)
    return match[1]
  }
  const tab = rule('.skills-tab')
  const size = Number((tab.match(/font-size:(\d+(?:\.\d+)?)px/) || [])[1])
  const padding = Number((tab.match(/padding:(\d+)px/) || [])[1])
  // Larger than the panel's body text and taller than the shared `.quiet` button, with a real
  // border: a control that decides what the module shows is not a discreet one.
  assert.ok(size >= 13, `the tab label is too small (${size}px)`)
  assert.ok(padding >= 8, `the tab's hit area is too short (${padding}px)`)
  assert.match(tab, /border:1\.5px solid/)
  assert.match(tab, /font-weight:600/)
  assert.match(rule('.skills-tab small'), /font-size:10px/)
  // The active side cannot be mistaken for the inactive one.
  const active = rule('.skills-tab.active')
  assert.match(active, /border-color:var\(--hns-color-accent-primary\)/)
  assert.match(active, /background:var\(--hns-color-bg-layer1\)/)
  assert.notEqual(active, tab)
  // The module's own action buttons are a step larger than the dock's shared quiet button.
  assert.match(rule('.skills-installbar button'), /padding:9px 18px/)
  assert.match(rule('.skills-installbar button'), /border:1px solid var\(--hns-color-accent-primary\)/)
  assert.match(rule('.skills-panel .balance-actions button'), /border:1px solid/)
})

test('a module header floats while its module is in view', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const head = css.match(/\.panel-head\{([^}]*)\}/)
  assert.ok(head, '.panel-head has no rule')
  assert.match(head[1], /position:sticky/, 'the header must stick instead of scrolling away')
  assert.match(head[1], /top:/)
  // Sticky is bounded by the containing block, so a module scrolled past entirely takes its
  // header with it — which is what the product asked for, and why there is no `bottom` pin.
  assert.match(head[1], /background:var\(--hns-color-bg-layer1\)/, 'content would show through a transparent header')
  assert.match(head[1], /z-index:\d+/)
  // The scrollport is the dock body, so the sticky element has a scrolling ancestor.
  assert.match(css, /#detail\{[^}]*overflow:auto/)
})

test('using the official UI collapses the dock without stealing the caret', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /function watchOfficialUseToCollapseDock\(\)/, 'the collapse watch is missing')
  // It is armed where the dock is attached, and only after the window is up.
  assert.match(shell, /watchOfficialUseToCollapseDock\(\)/)
  assert.match(shell, /officialFocusArmedAt = Date\.now\(\) \+ 1200/)
  // The signals: focus arriving on the official page, and the first key typed into it.
  assert.match(shell, /contents\.on\('focus', \(\) => \{/)
  assert.match(shell, /contents\.on\('before-input-event'/)
  assert.match(shell, /input\.type !== 'keyDown'/)
  // A modifier or a shortcut is not an intent to type.
  assert.match(shell, /input\.control \|\| input\.meta \|\| input\.alt/)
  // Collapsing must not take the focus back: the click already put the caret where the user
  // wanted it, and stealing it would undo the very thing they asked for.
  assert.match(shell, /setDockExpanded\?\.\(false, \{ persist: true, focus: false \}\)/)
  // No script is injected into the official renderer to observe clicks.
  assert.equal(/executeJavaScript|insertCSS/.test(shell), false, 'the official renderer must not be scripted')
})
