'use strict'

/**
 * Native Character Layer (Update-Plan/Daily-UX.md 任务 15).
 *
 * The character is part of the Daily document - never a WebContents overlay
 * above another renderer. It can sit in five places, is always
 * `pointer-events: none`, is laid out inside the timeline area (or the sidebar)
 * so it can never cover the composer, and it can be hidden, moved and scaled.
 *
 * The theme decides the initial anchor/scale through the `hns.character.primary`
 * slot; a user choice, once made, wins and is remembered locally.
 */
;(function attachCharacter(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  const ANCHORS = ['corner', 'chat-edge', 'floating', 'sidebar', 'background']
  const ANCHOR_LABEL = { corner: '右下', 'chat-edge': '右侧', floating: '悬浮', sidebar: '侧栏', background: '背景' }
  const SCALES = ['small', 'medium', 'large']
  const SCALE_LABEL = { small: '小', medium: '中', large: '大' }
  const SIZE = { small: '160px', medium: '240px', large: '330px' }
  const HEIGHT = { small: '220px', medium: '320px', large: '430px' }
  const PREF_KEY = 'ds-hns.native.character'

  let prefs = readPrefs()
  let themeAnchor = null
  let themeScale = null

  function readPrefs() {
    try {
      const raw = global.localStorage ? global.localStorage.getItem(PREF_KEY) : null
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writePrefs(patch) {
    prefs = { ...prefs, ...patch }
    try {
      global.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs))
    } catch {
      // The layer still follows the change for this session.
    }
    return prefs
  }

  function current() {
    return {
      anchor: ANCHORS.includes(prefs.anchor) ? prefs.anchor : (themeAnchor || 'corner'),
      scale: SCALES.includes(prefs.scale) ? prefs.scale : (themeScale || 'medium'),
      visible: prefs.visible !== false
    }
  }

  function containerFor(anchor) {
    if (anchor === 'background') return byId('hnsNative')
    if (anchor === 'sidebar') return byId('sidebar')
    return byId('timelineWrap')
  }

  /** Place the layer: dataset drives the CSS anchor, vars drive its size. */
  function apply() {
    const state = current()
    const layer = byId('characterLayer')
    if (document.body) {
      document.body.dataset.character = state.visible ? 'on' : 'off'
      document.body.dataset.characterAnchor = state.anchor
    }
    if (!layer) return state
    const container = containerFor(state.anchor)
    if (container && layer.parentElement !== container && typeof container.appendChild === 'function') {
      container.appendChild(layer)
    }
    layer.style.setProperty('--hns-character-width', SIZE[state.scale] || SIZE.medium)
    layer.style.setProperty('--hns-character-height', HEIGHT[state.scale] || HEIGHT.medium)
    return state
  }

  /** The theme's own placement, used until the user chooses one. */
  function applyTheme(slot) {
    if (!slot || typeof slot !== 'object') return current()
    const anchor = String(slot.anchor || slot.layout || slot.position || '')
    const scale = String(slot.scale || '')
    themeAnchor = ANCHORS.includes(anchor) ? anchor : null
    themeScale = SCALES.includes(scale) ? scale : null
    if (prefs.anchor === undefined || prefs.scale === undefined) apply()
    return current()
  }

  function button(attribute, value, label, isActive) {
    return `<button type="button" class="quiet${isActive ? ' active' : ''}" ${attribute}="${esc(value)}">${esc(label)}</button>`
  }

  function renderControls() {
    const target = byId('characterControls')
    if (!target) return
    const state = current()
    target.innerHTML =
      `<div class="context-row"><b>显示</b><span>${button('data-character-toggle', '1', state.visible ? '隐藏' : '显示', false)}</span></div>` +
      `<div class="context-row"><b>位置</b><span class="character-options">${ANCHORS
        .map((anchor) => button('data-character-anchor', anchor, ANCHOR_LABEL[anchor], anchor === state.anchor))
        .join('')}</span></div>` +
      `<div class="context-row"><b>大小</b><span class="character-options">${SCALES
        .map((scale) => button('data-character-scale', scale, SCALE_LABEL[scale], scale === state.scale))
        .join('')}</span></div>`
  }

  function mount() {
    const target = byId('characterControls')
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener('click', (event) => {
      const node = event && event.target
      if (!node || typeof node.closest !== 'function') return
      const toggle = node.closest('[data-character-toggle]')
      if (toggle) {
        writePrefs({ visible: !current().visible })
        apply()
        renderControls()
        return
      }
      const anchor = node.closest('[data-character-anchor]')
      if (anchor) {
        writePrefs({ anchor: anchor.dataset.characterAnchor })
        apply()
        renderControls()
        return
      }
      const scale = node.closest('[data-character-scale]')
      if (scale) {
        writePrefs({ scale: scale.dataset.characterScale })
        apply()
        renderControls()
      }
    })
  }

  ui.character = { ANCHORS, SCALES, apply, applyTheme, renderControls, mount, current }
})(window)
