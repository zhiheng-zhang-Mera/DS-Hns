'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Bilingual titles.
 *
 * The product's rule is "Chinese large, English small, the same colour, both rendered" —
 * a fixed arrangement rather than a language switch. That makes it checkable in the
 * shipped files: every heading carries both spans, the stylesheet gives them different
 * sizes and one colour, and every OS-level title carries both languages in one string
 * (a window manager owns the font there, so the two-size part cannot apply).
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** Load the browser helper with a minimal DOM, so its behaviour is tested, not assumed. */
function loadBilingual() {
  const source = read('app/extensions/mega/ui/bilingual.js')
  const document = {
    createElement(tag) {
      return {
        tag,
        className: '',
        textContent: '',
        children: [],
        classList: { add() {} },
        appendChild(child) {
          this.children.push(child)
          return child
        }
      }
    }
  }
  const window = {}
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document)
  return { api: window.hnsBilingual, document }
}

test('the helper renders both languages, Chinese first', () => {
  const { api, document } = loadBilingual()
  assert.equal(api.label('插件管理', 'Plugins'), '插件管理 · Plugins')
  assert.equal(api.label('插件管理', ''), '插件管理')
  assert.equal(api.label('', 'Plugins'), 'Plugins')
  assert.equal(api.label(null, undefined), '')

  const heading = api.title('插件管理', 'Plugins')
  assert.equal(heading.tag, 'h2')
  assert.match(heading.className, /bi-title/)
  assert.equal(heading.children.length, 2)
  assert.equal(heading.children[0].className, 'bi-cn')
  assert.equal(heading.children[0].textContent, '插件管理')
  assert.equal(heading.children[1].className, 'bi-en')
  assert.equal(heading.children[1].textContent, 'Plugins')

  // `fill` upgrades an existing heading without inventing a second element.
  const existing = document.createElement('h2')
  api.fill(existing, '执行设置', 'Execution')
  assert.equal(existing.children.length, 2)
  assert.equal(existing.children[1].textContent, 'Execution')

  // The plugin groups come from stable English ids, and the dictionary has both names.
  for (const name of ['Execution', 'Autonomy', 'Coding', 'Performance', 'Observability', 'Other']) {
    const entry = api.group(name)
    assert.ok(entry.cn.length > 0, `${name} has no Chinese name`)
    assert.ok(entry.en.length > 0, `${name} has no English name`)
  }
  assert.equal(api.group('Execution').cn, '执行')
  assert.deepEqual(api.group('Nonsense'), { cn: 'Nonsense', en: 'Nonsense' }, 'an unknown group still renders something')
})

test('the stylesheet gives the two lines different sizes and one colour', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const pick = (selector) => {
    const match = css.match(new RegExp(`\\${selector}\\{([^}]*)\\}`))
    assert.ok(match, `${selector} has no rule`)
    return match[1]
  }
  const cn = pick('.bi-title .bi-cn')
  const en = pick('.bi-title .bi-en')
  const sizeOf = (block) => Number((block.match(/font-size:(\d+(?:\.\d+)?)px/) || [])[1])
  const colourOf = (block) => (block.match(/color:([^;]+)/) || [])[1]
  assert.ok(sizeOf(cn) > sizeOf(en), `Chinese must be the larger line (${sizeOf(cn)} vs ${sizeOf(en)})`)
  assert.equal(colourOf(cn), colourOf(en), 'both lines must share one colour')
  assert.match(colourOf(cn), /var\(--hns-color-label-primary\)/)
  // The wrapper stacks the two lines rather than running them together.
  assert.match(pick('.bi-title'), /flex-direction:column/)
})

test('every dock heading carries both languages', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const headings = [...html.matchAll(/<h2([^>]*)>([\s\S]*?)<\/h2>/g)]
  assert.ok(headings.length >= 12, `expected the dock's panels (${headings.length} headings)`)
  for (const [, attributes, body] of headings) {
    if (/Interface Mode/.test(body)) continue
    assert.match(attributes, /class="[^"]*bi-title/, `a heading is not bilingual: ${body.slice(0, 60)}`)
    const cn = body.match(/<span class="bi-cn">([^<]*)<\/span>/)
    const en = body.match(/<span class="bi-en">([^<]*)<\/span>/)
    assert.ok(cn && cn[1].trim().length > 0, `a heading has no Chinese line: ${body.slice(0, 60)}`)
    assert.ok(en && en[1].trim().length > 0, `a heading has no English line: ${body.slice(0, 60)}`)
  }
  // The component is loaded before the panels that use it.
  const bilingualAt = html.indexOf('bilingual.js')
  assert.ok(bilingualAt > 0, 'the dock does not load the bilingual component')
  assert.ok(bilingualAt < html.indexOf('plugin-panel.js'), 'the component must load before the panels')
})

test('every OS-level title carries both languages', () => {
  const shell = read('app/desktop-main.cjs')
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(shell, /function bilingualTitle\(/)
  assert.match(mega, /function bilingualTitle\(/)
  // A window or dialog title is a plain string: no bare literal may remain, because a
  // single-language title is exactly what the product rule forbids.
  for (const [name, source] of [['desktop-main.cjs', shell], ['mega/index.cjs', mega]]) {
    const literals = [...source.matchAll(/title:\s*'([^']*)'/g)].map((match) => match[1])
    assert.deepEqual(literals, [], `${name} still has single-language titles: ${literals.join(', ')}`)
  }
  assert.match(shell, /title: bilingualTitle\('DS-Harness 工作台', 'DS-Harness Workbench'\)/)
  assert.match(shell, /bilingualTitle\('选择 Sub-worker 目标仓库', 'Choose the sub-worker target repository'\)/)
  assert.match(shell, /bilingualTitle\('Computer Use 需要确认', 'Computer Use needs confirmation'\)/)
  assert.match(shell, /bilingualTitle\('DS-Harness 启动失败', 'DS-Harness failed to start'\)/)
  assert.match(mega, /bilingualTitle\('Mega 控制台', 'Mega Dock'\)/)
  assert.match(mega, /bilingualTitle\('选择技能目录或 SKILL\.md', 'Choose a skill directory or SKILL\.md'\)/)
})

test('the plugin panel builds its headings through the shared component', () => {
  const panel = read('app/extensions/mega/ui/plugin-panel.js')
  assert.match(panel, /window\.hnsBilingual/)
  assert.match(panel, /bilingualTag\('h3', '执行设置', 'Execution'\)/)
  assert.match(panel, /bilingualGroup\(/)
  // The panel must not style its own titles: sizes and colour belong to the stylesheet.
  assert.equal(/font-size|\bcolor\s*:/.test(panel), false, 'the panel must not define its own typography')
})

test('the syntax gate covers the new UI files', () => {
  const check = read('scripts/check-syntax.cjs')
  assert.ok(check.includes("'extensions/mega/ui'"), 'check-syntax.cjs does not cover the mega UI directory')
})
