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
  /**
   * Which dashboard category is open — **at most one**, by id, or `null` when they are all shut.
   *
   * It lives here rather than in `state` because `state` is what the shell pushes: the open fold is the user's
   * doing and must survive a poll that redraws the panel, the same way the panel being open survives one.
   */
  let openCategory = null
  /**
   * Whether the first category has been opened yet.
   *
   * The default is applied **once**, not "whenever nothing is open": the second reading of that condition is how
   * a fold that the user just shut springs back open on the next redraw. `null` means "all shut", and all shut is
   * a state the user is allowed to choose.
   */
  let defaultedCategory = false

  /**
   * The tone vocabulary, in one place: the view model's names, the CSS variables' names.
   *
   * `busy` is not a severity — it is "something is happening right now" (a worker slot in use, a balance being
   * refreshed) — so it is a colour of its own rather than being folded into `ok`, which would read as "fine".
   */
  const TONE_CLASS = { ok: 'tone-ok', warn: 'tone-warn', bad: 'tone-bad', unknown: 'tone-unknown', busy: 'tone-busy' }

  function element(tag, className, text) {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function toneClass(tone) {
    return TONE_CLASS[tone] || 'muted'
  }

  /**
   * One dashboard row: the plan's two labels, the value, and the tone that makes a fault visible.
   *
   * The value's colour is the *tone's* colour when there is one and plain text otherwise — the rule the official
   * page and the panel already follow, applied to the live numbers so a failed queue and a healthy one cannot
   * look alike.
   */
  function drawField(entry) {
    const row = element('div', 'field')
    const label = element('div', 'label')
    label.appendChild(element('span', 'muted', entry.cn))
    label.appendChild(element('small', null, entry.en))
    row.appendChild(label)
    row.appendChild(element('div', `value ${toneClass(entry.tone)}`, entry.value))
    return row
  }

  /**
   * The dashboard: the price window and its countdown, the account, the queue and the parallelism — the four
   * cards the old expanded dock drew, now read out of the same view model the official page uses.
   *
   * It is drawn **instead of** the module roster, not instead of governance: the ball is a glance, and the
   * rosters are a page. So the dashboard comes first, and what governance has to say follows it.
   *
   * The categories are **folds, one open at a time** — the same rule and the same shape as the in-UI ball's
   * (`app/plugins/mega-core/lib/client.js`), because two balls that folded their information differently would be
   * two products. A shut category keeps its headline on the heading line, so folding hides the *detail* rather
   * than the numbers a glance is for.
   *
   * A snapshot without a dashboard block is a reason, not a wall of `—`: an empty dashboard and an unreachable
   * one are different pictures, and only one of them is the user's problem.
   */
  function drawDashboard(dashboard) {
    if (!dashboard) return null
    const wrap = element('div', 'dashboard')
    if (dashboard.ok === false) {
      wrap.appendChild(element('div', 'muted', dashboard.reason || '仪表盘不可用 · dashboard unavailable'))
      return wrap
    }
    const groups = [
      ...(dashboard.lines || []).map((entry) => ({ id: entry.id || `group:${entry.cn}`, cn: entry.cn, en: entry.en, rows: entry.rows || [] })),
      { id: 'execution', cn: '任务', en: 'Tasks', rows: dashboard.execution || [] },
      { id: 'parallelism', cn: '并行', en: 'Parallelism', rows: dashboard.parallelism || [] }
    ].filter((entry) => entry.rows.length)
    // The first category is open to begin with — once: a panel that opens on four shut headings shows nothing, and
    // the rule "clicking a heading opens it" has to be discoverable from the first frame. Applying it *every* time
    // nothing is open would instead make "all shut" impossible to reach.
    if (!defaultedCategory && groups.length) {
      defaultedCategory = true
      openCategory = groups[0].id
    }
    for (const group of groups) wrap.appendChild(drawFold(group))
    /**
     * The dashboard's own buttons — today `refresh-balance`, the read that makes the account newer.
     *
     * They are drawn only when the snapshot offers them (`control-center.cjs` withholds one while the balance is
     * already current), and they go through the same action channel every other button in this panel uses.
     */
    const actions = element('div', 'actions')
    for (const action of dashboard.actions || []) {
      const button = element('button', 'act', `${action.cn} · ${action.en}`)
      button.type = 'button'
      if (action.reason) button.title = `余额状态：${action.reason} · balance state: ${action.reason}`
      button.addEventListener('click', () => {
        if (api && typeof api.action === 'function') Promise.resolve(api.action(action.id, null)).catch(() => {})
      })
      actions.appendChild(button)
    }
    if (actions.children.length) wrap.appendChild(actions)
    return wrap
  }

  /** A shut category's headline: the row whose id names a state, else the first one, else nothing. */
  function headlineOf(group) {
    const row = (group.rows || []).find((entry) => String(entry.id || '').endsWith(':state')) || (group.rows || [])[0] || null
    if (!row || !row.value || row.value === '—') return null
    const value = String(row.value)
    return value.length > 18 ? `${value.slice(0, 17)}…` : value
  }

  /**
   * One fold: a heading that opens and shuts, and the rows under it when it is open.
   *
   * Opening one closes the other because `openCategory` holds a single id — the one-at-a-time rule is the shape of
   * the state, not a condition applied while drawing. The heading is a real `button` with `aria-expanded`, and the
   * click redraws the panel in place (the panel's size is then re-measured by the same path every other change
   * goes through).
   */
  function drawFold(group) {
    const isOpen = openCategory === group.id
    const summary = headlineOf(group)
    const heading = element('button', 'category')
    heading.type = 'button'
    heading.dataset.category = group.id
    heading.dataset.open = isOpen ? 'on' : 'off'
    heading.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    heading.title = isOpen ? `收起 ${group.cn} · collapse ${group.en}` : `展开 ${group.cn} · expand ${group.en}`
    heading.appendChild(element('span', 'caret', isOpen ? '▾' : '▸'))
    heading.appendChild(element('span', 'label', `${group.cn} · ${group.en}`))
    if (summary) heading.appendChild(element('span', 'value', summary))
    heading.addEventListener('click', () => {
      openCategory = isOpen ? null : group.id
      drawPanel()
      measure()
    })
    if (!isOpen) return heading
    const body = element('div', 'category-body')
    body.appendChild(heading)
    for (const row of group.rows) body.appendChild(drawField(row))
    return body
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

  /** The panel: the live dashboard first, then what governance has to say about itself. */
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

    const dashboard = drawDashboard(view.dashboard)
    if (dashboard) panelBody.appendChild(dashboard)

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

    /**
     * §4.4's fields, the modules and the bundled plugins belong to the official Settings page — this window has
     * nowhere to put a settings page, so it says where the rest lives rather than growing one of its own. The
     * governance facts that *do* belong on a ball (what is degraded, what wants attention, what can be done
     * about it) are the lines and the action buttons above.
     */
    panelBody.appendChild(element('div', 'note', '完整细节与恢复动作见 官方 Settings › Mega · details and recovery live in Settings › Mega'))
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
