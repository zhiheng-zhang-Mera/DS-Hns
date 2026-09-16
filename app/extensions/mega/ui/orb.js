'use strict'

/**
 * The system orb's renderer.
 *
 * It does three things and refuses to do a fourth. It **draws** what the shell sent (the ball's tone and
 * count, the panel's lines, numbers, fields and actions), it **measures** the panel so the shell can grow the
 * window to fit it, and it **says what the pointer is doing** (over something clickable, pressing, moving,
 * releasing) so the shell can make the window interactive exactly while the cursor is on it. The fourth thing
 * — deciding where the window goes, how big it is, or which side the panel opens on — belongs to
 * `app/extensions/mega/system-orb.cjs`, which owns the geometry rules and is tested there.
 *
 * Two details matter for the ball being usable rather than annoying:
 *
 *   * **A press that does not move is a click.** The drag is reported to the shell on every move, so the
 *     renderer has to remember whether anything actually moved before it decides to toggle the panel. Without
 *     that, every drag would also open the panel when it ended.
 *   * **Measuring is a request, not a decision.** The panel is measured with no height cap (`orb.css` sets no
 *     `max-height`), the number goes to the shell, and the *answer* comes back as the layout: the renderer
 *     applies the height the shell could actually give it. A panel that fits is a panel that does not scroll.
 */

;(function attachOrb(global) {
  const api = global.hnsOrb || null
  const doc = global.document
  const ball = doc ? doc.getElementById('ball') : null
  const glyph = doc ? doc.getElementById('ballGlyph') : null
  const panel = doc ? doc.getElementById('panel') : null
  const panelState = doc ? doc.getElementById('panelState') : null
  const panelBody = doc ? doc.getElementById('panelBody') : null
  const panelClose = doc ? doc.getElementById('panelClose') : null

  let state = { open: false, view: null, ball: { x: 0, y: 0 }, ballSize: 44, panel: null }
  let drag = null
  let measured = null
  let over = false

  /** The tone vocabulary, in one place: the view model's names, the CSS variables' names. */
  const TONE_CLASS = { ok: 'tone-ok', warn: 'tone-warn', bad: 'tone-bad', unknown: 'tone-unknown' }

  function element(tag, className, text) {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function toneClass(tone) {
    return TONE_CLASS[tone] || 'muted'
  }

  /** The ball's glyph: a dot, plus how many things want attention when any do. */
  function drawBall() {
    if (!ball) return
    const view = state.view
    const attention = Number(view?.status?.attention || 0)
    if (glyph) glyph.textContent = attention > 0 ? `● ${attention}` : '●'
    ball.dataset.tone = view?.status?.tone || 'unknown'
    const hover = view?.hover ? view.hover.join(' · ') : 'DS-Hns'
    ball.setAttribute('aria-label', hover)
    ball.title = view?.hover ? view.hover.join('\n') : 'DS-Hns'
    // Geometry is the shell's: the ball's offset inside the window, in px, from the layout it sent.
    ball.style.left = `${Math.round(Number(state.ball?.x) || 0)}px`
    ball.style.top = `${Math.round(Number(state.ball?.y) || 0)}px`
    ball.style.width = `${Math.round(Number(state.ballSize) || 44)}px`
    ball.style.height = `${Math.round(Number(state.ballSize) || 44)}px`
  }

  /** The panel: the same body the in-UI orb shows, drawn in this window's own document. */
  function drawPanel() {
    if (!panel || !panelBody) return
    panel.hidden = !state.open
    if (!state.open) {
      panelBody.replaceChildren()
      return
    }
    const view = state.view
    if (panelState) panelState.textContent = view ? `${view.status?.label || '—'}` : '—'
    panelBody.replaceChildren()

    if (!view) {
      panelBody.appendChild(element('div', 'muted', 'DS-Hns 没有应答 · no answer from DS-Hns'))
      return
    }

    // The §4.2 lines: faults first, then what is fine.
    for (const entry of view.lines || []) {
      const row = element('div', 'line')
      row.appendChild(element('span', `dot ${toneClass(entry.tone)}`, '•'))
      row.appendChild(element('span', `text ${entry.tone === 'ok' ? 'muted' : 'plain'}`, entry.text))
      panelBody.appendChild(row)
    }

    const numbers = element('div', 'numbers')
    for (const [label, value] of [
      ['活动 · active', `${view.status?.active ?? 0}/${view.status?.total ?? 0}`],
      ['待人工 · pending', String(view.status?.pending ?? 0)],
      ['阻塞与重试 · failing', String(view.status?.failing ?? 0)],
      ['更新于 · at', String(view.at || '—').slice(11, 19)]
    ]) {
      numbers.appendChild(element('span', 'muted', label))
      numbers.appendChild(element('b', null, value))
    }
    panelBody.appendChild(numbers)

    // Actions: the closed set the governance bridge accepts, and nothing invented here.
    const actions = element('div', 'actions')
    for (const action of view.actions || []) {
      const button = element('button', 'act', action)
      button.type = 'button'
      button.addEventListener('click', () => {
        if (api && typeof api.action === 'function') Promise.resolve(api.action(action, null)).catch(() => {})
      })
      actions.appendChild(button)
    }
    const refresh = element('button', 'act', '刷新 · Refresh')
    refresh.type = 'button'
    refresh.addEventListener('click', () => {
      if (api && typeof api.snapshot === 'function') Promise.resolve(api.snapshot()).then(apply).catch(() => {})
    })
    actions.appendChild(refresh)
    panelBody.appendChild(actions)

    // §4.4's fields: the full page in the panel too, because this window is the one that has no settings page.
    const fields = element('div', 'fields')
    for (const field of view.fields || []) {
      const row = element('div', 'field')
      const label = element('div', 'label')
      label.appendChild(element('span', 'muted', field.cn))
      label.appendChild(element('small', null, field.en))
      row.appendChild(label)
      row.appendChild(element('div', `value ${toneClass(field.tone)}`, field.value))
      fields.appendChild(row)
    }
    panelBody.appendChild(fields)

    const roster = element('div', 'roster')
    roster.appendChild(element('h4', null, '模块 · Modules'))
    for (const entry of view.modules || []) {
      const row = element('div', 'row')
      const mark = entry.state === 'HEALTHY' ? '✓' : entry.state === 'FAILED' ? '✖' : '⚠'
      row.appendChild(element('span', toneClass(entry.tone), `${mark} ${entry.id} — ${entry.state}${entry.retries ? ` · ${entry.retries} retry` : ''}`))
      for (const action of entry.actions || []) {
        const button = element('button', 'act', action)
        button.type = 'button'
        button.addEventListener('click', () => {
          if (api && typeof api.action === 'function') Promise.resolve(api.action(action, entry.id)).catch(() => {})
        })
        row.appendChild(button)
      }
      roster.appendChild(row)
    }
    roster.appendChild(element('h4', null, '社区插件 · Bundled plugins'))
    for (const entry of view.plugins || []) {
      const row = element('div', 'row')
      const mark = entry.state === 'installed' ? '✓' : '⚠'
      row.appendChild(element('span', toneClass(entry.tone), `${mark} ${entry.id} — ${entry.state}${entry.installedVersion ? ` @${entry.installedVersion}` : ''}`))
      for (const action of entry.actions || []) {
        const button = element('button', 'act', action)
        button.type = 'button'
        button.addEventListener('click', () => {
          if (api && typeof api.action === 'function') Promise.resolve(api.action(action, entry.id)).catch(() => {})
        })
        row.appendChild(button)
      }
      roster.appendChild(row)
    }
    panelBody.appendChild(roster)
    panelBody.appendChild(element('div', 'note', 'Mega 也在 官方 Settings › Mega · the full page is also in Settings › Mega'))
  }

  /** Where the panel goes and how tall it may be: the shell's answer, applied to this element. */
  function drawPanelGeometry() {
    if (!panel || !state.panel) return
    const offset = state.panel.offset || { x: 0, y: 0 }
    panel.style.left = `${Math.round(Number(offset.x) || 0)}px`
    panel.style.top = `${Math.round(Number(offset.y) || 0)}px`
    if (state.panel.width) panel.style.width = `${Math.round(state.panel.width)}px`
    if (state.panel.height) panel.style.maxHeight = `${Math.round(state.panel.height)}px`
    panel.dataset.side = state.panel.side || ''
    panel.dataset.across = state.panel.across || ''
  }

  /**
   * Measure the panel's natural size and ask the shell for that much room.
   *
   * `scrollHeight` rather than a bounding box, and that is the point: it is the *content's* height even while
   * the element is capped, so nothing has to be un-capped to be measured. The first version set the cap to
   * `none`, measured, and let the shell put it back — a forced relayout of a transparent, always-on-top window
   * twice per state push, which is one of the things that made clicking flicker.
   */
  function measure() {
    if (!panel || panel.hidden || !api || typeof api.measure !== 'function') return
    const width = Math.ceil(Number(panel.offsetWidth) || (typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect().width : 0))
    const height = Math.ceil(Number(panel.scrollHeight) || 0)
    if (!width || !height) return
    const size = { width, height }
    if (measured && measured.width === size.width && measured.height === size.height) return
    measured = size
    Promise.resolve(api.measure(size)).then(apply).catch(() => {})
  }

  /** A click anywhere that is not the panel closes it — the window is interactive while it is open. */
  function onDocumentPointerDown(event) {
    if (!state.open) return
    const target = event.target
    if (panel && typeof panel.contains === 'function' && panel.contains(target)) return
    if (ball && typeof ball.contains === 'function' && ball.contains(target)) return
    if (api && typeof api.open === 'function') Promise.resolve(api.open(false)).then(apply).catch(() => {})
  }

  /** Apply one state from the shell. Everything drawn here is a function of it. */
  function apply(next) {
    if (!next || typeof next !== 'object') return
    const openChanged = state.open !== (next.open === true)
    state = {
      open: next.open === true,
      view: next.view || state.view,
      ball: next.ball || state.ball,
      ballSize: next.ballSize || state.ballSize,
      panel: next.panel || null
    }
    if (openChanged) measured = null
    drawBall()
    drawPanel()
    drawPanelGeometry()
    // One measurement per open (and per new content), then the layout that comes back is the final word.
    if (state.open) measure()
  }

  /** Tell the shell whether the cursor is over something clickable. It is what makes the window usable. */
  function setOver(next) {
    if (next === over) return
    over = next
    if (api && typeof api.hover === 'function') Promise.resolve(api.hover(over)).catch(() => {})
  }

  function onPointerMove(event) {
    const overBall = Boolean(ball && typeof ball.contains === 'function' && ball.contains(event.target))
    const overPanel = Boolean(panel && !panel.hidden && typeof panel.contains === 'function' && panel.contains(event.target))
    setOver(overBall || overPanel)
    if (drag) {
      if (Math.abs(event.screenX - drag.startX) > 2 || Math.abs(event.screenY - drag.startY) > 2) drag.moved = true
      if (api && typeof api.drag === 'function') Promise.resolve(api.drag('move', { x: event.screenX, y: event.screenY })).catch(() => {})
    }
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return
    // No focus theft, the same line the in-UI orb has: the ball is not a place to leave the keyboard.
    if (typeof event.preventDefault === 'function') event.preventDefault()
    drag = { startX: event.screenX, startY: event.screenY, moved: false }
    if (ball) ball.dataset.dragging = 'on'
    if (api && typeof api.drag === 'function') Promise.resolve(api.drag('start', { x: event.screenX, y: event.screenY })).catch(() => {})
  }

  function onPointerUp() {
    if (ball) delete ball.dataset.dragging
    const pressed = drag
    drag = null
    if (!pressed) return
    if (api && typeof api.drag === 'function') Promise.resolve(api.drag('end', {})).catch(() => {})
    // A press that did not move is a click: that is what opens the panel.
    if (!pressed.moved && api && typeof api.open === 'function') {
      Promise.resolve(api.open(!state.open)).then(apply).catch(() => {})
    }
  }

  if (ball) {
    ball.addEventListener('pointerdown', onPointerDown)
    ball.addEventListener('pointerup', onPointerUp)
    ball.addEventListener('pointercancel', onPointerUp)
  }
  if (panelClose) {
    panelClose.addEventListener('click', () => {
      if (api && typeof api.open === 'function') Promise.resolve(api.open(false)).then(apply).catch(() => {})
    })
  }
  if (doc) {
    doc.addEventListener('pointermove', onPointerMove)
    doc.addEventListener('pointerdown', onDocumentPointerDown)
    doc.addEventListener('mouseleave', () => setOver(false))
  }

  global.hnsOrbView = { apply, state: () => ({ ...state }), measure }

  // The first paint asks rather than waits: the shell pushes state, but a window that missed the push (or was
  // reloaded by a crash) must still be able to draw itself.
  if (api && typeof api.snapshot === 'function') Promise.resolve(api.snapshot()).then(apply).catch(() => {})
  if (api && typeof api.onState === 'function') api.onState(apply)
})(window)
