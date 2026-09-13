'use strict'

/**
 * DS-Hns bilingual titles.
 *
 * Every surface in this product is bilingual, and the rule is fixed: **Chinese large,
 * English small, the same colour, both rendered** — not a language switch, and not one
 * language hidden behind a tooltip. Two sizes of one colour read as one title with a
 * translation under it; one of them greyed out reads as an afterthought, and a single
 * string with a slash reads as neither.
 *
 * Two callers need two different things, which is why this file has two functions:
 *
 *  * HTML surfaces get `title(cn, en)`, which returns a real element with the two spans —
 *    the sizes and the colour come from `.bi-title` in the stylesheet, so a panel cannot
 *    invent its own typography;
 *  * OS-level window and dialog titles cannot be styled at all, so they get `label(cn, en)`
 *    — one string carrying both languages.
 *
 * The Chinese is always the first argument because it is the larger line: a title that
 * reads correctly when only its first line is skimmed is the point of the arrangement.
 */
;(function attachBilingual() {
  /** Group names come from the plugin host as stable English ids; the UI renders both. */
  const GROUPS = Object.freeze({
    Execution: { cn: '执行', en: 'Execution' },
    Autonomy: { cn: '自主运行', en: 'Autonomy' },
    Coding: { cn: '编码', en: 'Coding' },
    Performance: { cn: '性能', en: 'Performance' },
    Observability: { cn: '可观测性', en: 'Observability' },
    Other: { cn: '其他', en: 'Other' }
  })

  /**
   * One string carrying both languages, for OS window and dialog titles.
   *
   * @param {string} cn the Chinese title
   * @param {string} en the English title
   */
  function label(cn, en, separator = ' · ') {
    const left = String(cn === undefined || cn === null ? '' : cn).trim()
    const right = String(en === undefined || en === null ? '' : en).trim()
    if (!left) return right
    if (!right) return left
    return `${left}${separator}${right}`
  }

  /**
   * A rendered bilingual title element.
   *
   * @param {string} cn
   * @param {string} en
   * @param {object} [options] `{ tag, className }`
   */
  function title(cn, en, options = {}) {
    const node = document.createElement(options.tag || 'h2')
    node.className = `bi-title${options.className ? ` ${options.className}` : ''}`
    const primary = document.createElement('span')
    primary.className = 'bi-cn'
    primary.textContent = String(cn === undefined || cn === null ? '' : cn)
    const secondary = document.createElement('span')
    secondary.className = 'bi-en'
    secondary.textContent = String(en === undefined || en === null ? '' : en)
    node.appendChild(primary)
    node.appendChild(secondary)
    return node
  }

  /** Fill in an existing empty element, for markup that already has the heading. */
  function fill(node, cn, en) {
    if (!node) return null
    node.textContent = ''
    node.classList.add('bi-title')
    const primary = document.createElement('span')
    primary.className = 'bi-cn'
    primary.textContent = String(cn === undefined || cn === null ? '' : cn)
    const secondary = document.createElement('span')
    secondary.className = 'bi-en'
    secondary.textContent = String(en === undefined || en === null ? '' : en)
    node.appendChild(primary)
    node.appendChild(secondary)
    return node
  }

  /** A plugin group's two names, from its stable English id. */
  function group(name) {
    const entry = GROUPS[String(name)]
    return entry || { cn: String(name || ''), en: String(name || '') }
  }

  window.hnsBilingual = { label, title, fill, group, GROUPS }
})()
