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
  const panelHead = doc ? doc.getElementById('panelHead') : null
  const panelTitle = doc ? doc.getElementById('panelTitle') : null
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
   * doing and must survive a poll that redraws the panel, the same way the panel being open survives one. `null`
   * is where it starts: the panel's first state is every category shut, each showing its headline.
   */
  let openCategory = null
  /**
   * Whether the window is showing the new-task form instead of the dashboard.
   *
   * It lives here for the same reason `openCategory` does: it is the user's doing, and being *in* the form while a
   * 15-second poll redraws the panel must not throw away half-typed text. `taskDraft` carries the text.
   */
  let mode = 'dashboard'
  const taskDraft = { prompt: '', startAt: '', allowPeak: false }
  /** What DS-Hns answered about the timing surface, and what it last said when it could not answer. */
  let timing = null
  let timingError = null
  let timingRequested = false
  let taskBusy = false
  let taskNotice = null

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
   * The categories are **folds, all shut to begin with and one open at a time** — the same rule and the same shape
   * as the in-UI ball's (`app/plugins/mega-core/lib/client.js`), because two balls that folded their information
   * differently would be two products. A shut category keeps its headline on the heading line, so folding hides
   * the *detail* rather than the numbers a glance is for; the open one is drawn as a card of its own
   * (`drawFold`), tinted and rounded so the eye lands on it without reading a caret.
   *
   * A snapshot without a dashboard block is a reason, not a wall of `—`: an empty dashboard and an unreachable
   * one are different pictures, and only one of them is the user's problem.
   */
  function drawDashboard(dashboard) {
    if (!dashboard) return null
    const wrap = element('div', 'dashboard')
    wrap.dataset.dashboard = openCategory ? 'open' : 'shut'
    if (dashboard.ok === false) {
      wrap.appendChild(element('div', 'muted', dashboard.reason || '仪表盘不可用 · dashboard unavailable'))
      return wrap
    }
    const groups = [
      ...(dashboard.lines || []).map((entry) => ({ id: entry.id || `group:${entry.cn}`, cn: entry.cn, en: entry.en, rows: entry.rows || [] })),
      { id: 'execution', cn: '任务', en: 'Tasks', rows: dashboard.execution || [] },
      { id: 'parallelism', cn: '并行', en: 'Parallelism', rows: dashboard.parallelism || [] }
    ].filter((entry) => entry.rows.length)
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
   *
   * The open category is drawn as a **card of its own** (`category-body`, styled in `orb.css`): a tinted, rounded
   * surface the headings around it are plainly not part of, so which category you are looking at is a matter of
   * seeing rather than of reading the caret.
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
    const card = element('div', 'category-body')
    card.dataset.card = group.id
    card.appendChild(heading)
    for (const row of group.rows) card.appendChild(drawField(row))
    return card
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
    drawPanelHead()
    if (!state.open) {
      panelBody.replaceChildren()
      return
    }
    const view = state.view
    // The form is the user's doing, so it is what the window shows even when the shell's poll redraws the panel
    // underneath it: being thrown back to the dashboard mid-sentence would lose the text being typed.
    if (mode === 'task') {
      panelBody.replaceChildren(drawTaskForm())
      return
    }
    if (panelState) panelState.textContent = view ? `${view.status?.label || '—'}` : '—'
    panelBody.replaceChildren()

    if (!view) {
      panelBody.appendChild(drawTaskEntry())
      panelBody.appendChild(element('div', 'muted', 'DS-Hns 没有应答 · no answer from DS-Hns'))
      return
    }

    /**
     * The new-task entry is **first in the panel**, before the dashboard.
     *
     * It used to sit at the bottom with the other buttons, below four categories and the governance lines — which
     * is to say below the fold of a panel that is itself a fold. It is the one control here that *starts* something
     * rather than reporting something, so it is the one control that has to be visible without scrolling.
     */
    panelBody.appendChild(drawTaskEntry())

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

  /**
   * The new-task entry: the one control in this panel that starts something instead of reporting something.
   *
   * It is drawn first (`drawPanel`) because everything else here is a reading, and a reading you have to scroll to
   * find is a reading you do not have. Clicking it switches this window to the form (`drawTaskForm`) — the ball is
   * the surface that is on screen over every application, so starting a task from wherever the user is happens
   * here, in this window.
   */
  function drawTaskEntry() {
    const entry = element('button', 'act primary wide', '＋ 新建定时任务 · New task')
    entry.type = 'button'
    entry.dataset.orbAction = 'new-task'
    entry.addEventListener('click', () => openTaskForm())
    return entry
  }

  /** The title and the way back, which differ between the dashboard and the form. */
  function drawPanelHead() {
    if (panelTitle) panelTitle.textContent = mode === 'task' ? '新建定时任务 · New task' : 'Mega'
    if (panelState && mode === 'task') panelState.textContent = '到点自动发出 · sends when due'
  }

  /**
   * Read the timing surface, once per opening of the form.
   *
   * `timingRequested` rather than a fetch per redraw: the panel is redrawn every 15 seconds by the shell's poll,
   * and a form that re-read the capability list — and reset its default time — on every poll would be a form the
   * user cannot finish filling in.
   */
  function loadTiming() {
    if (timingRequested) return
    timingRequested = true
    timingError = null
    if (!api || typeof api.timing !== 'function') {
      timingError = 'this window has no timing channel'
      drawPanel()
      measure()
      return
    }
    Promise.resolve(api.timing())
      .then((answer) => {
        if (!answer || answer.ok === false) {
          timing = null
          timingError = (answer && answer.reason) || 'the timing surface did not answer'
        } else {
          timing = answer
          timingError = null
          if (!taskDraft.startAt) taskDraft.startAt = localFromInstant(answer.defaults && answer.defaults.startAt)
          if (answer.defaults && answer.defaults.allowPeak === true) taskDraft.allowPeak = true
        }
        drawPanel()
        measure()
      })
      .catch((error) => {
        timing = null
        timingError = String((error && error.message) || error)
        drawPanel()
        measure()
      })
  }

  function openTaskForm() {
    mode = 'task'
    taskNotice = null
    taskDraft.prompt = ''
    taskDraft.startAt = ''
    loadTiming()
    drawPanel()
    measure()
  }

  function closeTaskForm() {
    mode = 'dashboard'
    taskNotice = null
    drawPanel()
    measure()
  }

  /** `2026-09-15T14:30` (a local wall clock) → the instant it names. */
  function instantFromLocal(value) {
    const text = String(value || '').trim()
    if (!text) return null
    const at = new Date(text)
    return Number.isFinite(at.getTime()) ? at : null
  }

  /** An instant back in the shape a `datetime-local` field wants, in the user's own zone. */
  function localFromInstant(iso) {
    const at = new Date(String(iso || ''))
    if (!Number.isFinite(at.getTime())) return ''
    const pad = (value) => String(value).padStart(2, '0')
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
  }

  /** `172` → `2m 52s`, the same shape the dashboard's countdown uses. */
  function offsetText(milliseconds) {
    const whole = Math.max(0, Math.round(milliseconds / 1000))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    if (hours) return `${hours}h ${minutes}m`
    if (minutes) return `${minutes}m ${whole % 60}s`
    return `${whole}s`
  }

  /** One labelled row of the form: the plan's two labels, and the control. */
  function formField(cn, en, control, hint) {
    const row = element('div', 'field')
    const label = element('div', 'label')
    label.appendChild(element('span', 'muted', cn))
    label.appendChild(element('small', null, en))
    row.appendChild(label)
    const value = element('div', 'value')
    value.appendChild(control)
    if (hint) value.appendChild(element('div', 'hint', hint))
    row.appendChild(value)
    return row
  }

  /**
   * The new-task form, drawn inside this window (`mode === 'task'`).
   *
   * It is the same conversation-first shape the official dialog has — the prompt box, then the schedule under it —
   * because it makes the same thing: a task that is a normal conversation with a time on it. What it does *not*
   * have is the dialog's room, so it is one column and the schedule is a compact block rather than a row of fields.
   *
   * The keyboard grammar is the one that matters and is the same as the dialog's: **Enter sends, Shift+Enter is a
   * newline, and Enter during an IME composition commits a candidate** rather than sending an unfinished sentence.
   */
  function drawTaskForm() {
    const wrap = element('div', 'task-form')
    wrap.dataset.mode = 'task'
    if (!panelBody) return wrap

    const promptLabel = element('div', 'form-label')
    promptLabel.appendChild(element('span', null, '要执行的内容 · What to run'))
    wrap.appendChild(promptLabel)

    const prompt = element('textarea', 'prompt')
    prompt.dataset.orbField = 'prompt'
    prompt.rows = 4
    prompt.placeholder = '和平时对话一样输入 · type it as you would in a chat'
    prompt.value = taskDraft.prompt
    prompt.addEventListener('input', () => { taskDraft.prompt = prompt.value })
    prompt.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      // The composition guard: pressing Enter to pick a Chinese candidate must not send the half-typed sentence.
      if (event.isComposing) return
      event.preventDefault()
      submitTask()
    })
    wrap.appendChild(prompt)

    const hint = element('div', 'note')
    hint.textContent = 'Enter 发送 · Enter sends　·　Shift+Enter 换行 · newline'
    wrap.appendChild(hint)

    const schedule = element('div', 'schedule')
    schedule.dataset.orbSection = 'schedule'
    const scheduleHead = element('div', 'form-label')
    scheduleHead.appendChild(element('span', null, '定时设置 · Schedule'))
    if (timing && timing.schedule && timing.schedule.timeZone) {
      scheduleHead.appendChild(element('small', null, `时区 ${timing.schedule.timeZone}`))
    }
    schedule.appendChild(scheduleHead)

    const timeInput = element('input', null)
    timeInput.type = 'datetime-local'
    timeInput.dataset.orbField = 'startAt'
    timeInput.value = taskDraft.startAt
    timeInput.addEventListener('input', () => { taskDraft.startAt = timeInput.value })
    schedule.appendChild(formField('发送时间', 'Send at', timeInput))

    const presets = element('div', 'presets')
    for (const [label, minutes] of [['3 分钟', 3], ['30 分钟', 30], ['1 小时', 60], ['明天 9:00', null]]) {
      const button = element('button', 'act', label)
      button.type = 'button'
      button.addEventListener('click', () => {
        const at = new Date()
        if (minutes === null) {
          at.setDate(at.getDate() + 1)
          at.setHours(9, 0, 0, 0)
        } else {
          at.setMinutes(at.getMinutes() + minutes)
        }
        taskDraft.startAt = localFromInstant(at.toISOString())
        drawPanel()
        measure()
      })
      presets.appendChild(button)
    }
    schedule.appendChild(presets)

    const peak = element('input', null)
    peak.type = 'checkbox'
    peak.dataset.orbField = 'allowPeak'
    peak.checked = taskDraft.allowPeak === true
    peak.addEventListener('change', () => { taskDraft.allowPeak = peak.checked === true })
    schedule.appendChild(formField('允许峰值', 'Allow peak hours', peak,
      timing && timing.schedule && Array.isArray(timing.schedule.peakPeriods) && timing.schedule.peakPeriods.length
        ? `峰价 ${timing.schedule.peakPeriods.map((window) => `${window.start}-${window.end}`).join(', ')}；不允许时到点若在峰价会挂起`
        : null))
    wrap.appendChild(schedule)

    // What will happen, in one sentence — the thing the user is agreeing to.
    const summary = element('div', 'summary')
    const instant = instantFromLocal(taskDraft.startAt)
    if (instant === null) {
      summary.textContent = '还没有选择时间 · no time chosen yet'
      summary.className = 'summary muted'
    } else if (instant.getTime() <= Date.now()) {
      summary.textContent = `⚠ 这个时间已经过去 · that time is in the past（${taskDraft.startAt.replace('T', ' ')}）`
      summary.className = 'summary warn'
    } else {
      summary.textContent = `将在 ${taskDraft.startAt.replace('T', ' ')} 作为官方新会话发出 · sends as a new official conversation in ${offsetText(instant.getTime() - Date.now())}`
      summary.className = 'summary'
    }
    wrap.appendChild(summary)

    if (timingError) {
      const problem = element('div', 'summary warn')
      problem.textContent = `读不到调度能力：${timingError}`
      wrap.appendChild(problem)
    }
    if (taskNotice) {
      const notice = element('div', taskNotice.ok ? 'summary ok' : 'summary bad')
      notice.textContent = taskNotice.text
      wrap.appendChild(notice)
    }

    const buttons = element('div', 'actions')
    const back = element('button', 'act', '返回 · Back')
    back.type = 'button'
    back.addEventListener('click', () => closeTaskForm())
    buttons.appendChild(back)
    const create = element('button', 'act primary', taskBusy ? '创建中… · Creating…' : '创建定时任务 · Schedule')
    create.type = 'button'
    create.dataset.orbAction = 'create-task'
    if (!taskDraft.prompt.trim() || instant === null || taskBusy) create.disabled = true
    create.addEventListener('click', () => submitTask())
    buttons.appendChild(create)
    wrap.appendChild(buttons)
    return wrap
  }

  /** Ask DS-Hns for the task, and say what it answered — its own words when it refuses. */
  function submitTask() {
    if (taskBusy) return
    const prompt = String(taskDraft.prompt || '').trim()
    const instant = instantFromLocal(taskDraft.startAt)
    if (!prompt || !instant) return
    if (!api || typeof api.createTask !== 'function') {
      taskNotice = { ok: false, text: '✖ 这个窗口没有创建任务的通道 · this window has no task channel' }
      drawPanel()
      measure()
      return
    }
    taskBusy = true
    taskNotice = null
    drawPanel()
    measure()
    Promise.resolve(api.createTask({ prompt, startAt: instant.toISOString(), allowPeak: taskDraft.allowPeak === true, deliveryMode: 'official-session' }))
      .then((answer) => {
        if (!answer || answer.ok === false) {
          taskNotice = { ok: false, text: `✖ ${(answer && answer.reason) || 'the task was refused'}` }
          return
        }
        const task = answer.task || {}
        taskDraft.prompt = ''
        taskNotice = {
          ok: true,
          text: `✓ 已加入队列 #${String(task.id || '').slice(0, 18)} · queued as ${task.status || 'PENDING'}`
        }
      })
      .catch((error) => {
        taskNotice = { ok: false, text: `✖ ${String((error && error.message) || error)}` }
      })
      .then(() => {
        taskBusy = false
        drawPanel()
        measure()
      })
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
   * **It measures the head plus the body, not the panel.** The panel is a flex column whose body scrolls, so
   * `panel.scrollHeight` is not the content's height — it is the height the panel *currently has*, which is exactly
   * the number the shell told it to use. Asking for that number back is a closed loop: the window is resized to
   * what already fits, the overflow stays inside the body, and the panel looks cropped — the "only half of it is
   * shown" symptom. `panelBody.scrollHeight` is the content's own height (it is the scrolling element, so its
   * `scrollHeight` is unaffected by its own height), and the head is a fixed row that `flex: none` keeps out of the
   * body's way.
   *
   * `scrollHeight` rather than a bounding box either way: it is the *content's* height even while the element is
   * capped, so nothing has to be un-capped to be measured. The first version set the cap to `none`, measured, and
   * let the shell put it back — a forced relayout of a transparent, always-on-top window twice per state push,
   * which is one of the things that made clicking flicker.
   */
  function measure() {
    if (!panel || panel.hidden || !api || typeof api.measure !== 'function') return
    const width = Math.ceil(Number(panel.offsetWidth) || (typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect().width : 0))
    const head = panelHead ? Math.ceil(Number(panelHead.offsetHeight) || 0) : 0
    const body = panelBody ? Math.ceil(Number(panelBody.scrollHeight) || 0) : 0
    const height = Math.ceil((head + body) || Number(panel.scrollHeight) || 0)
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
