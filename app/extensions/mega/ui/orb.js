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
  /**
   * The queued task the form is changing, or `null` when it is making a new one.
   *
   * It lives here for the same reason `mode` does: it is the user's doing, and a poll that redraws the panel while
   * the form is open must not forget which task is being edited.
   */
  let editingTask = null
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
      // The queue is a fold of its own, and it is kept even when it is empty: its rows are **tasks**, and its heading
      // carries the two numbers that move when anything is scheduled — so a shut panel still answers "is anything
      // waiting for me", which is the half of the report that was missing ("悬浮球信息页挂起任务数量没有改变").
      { id: 'queue', cn: '队列', en: 'Queue', rows: [], queue: dashboard.queue || null },
      { id: 'parallelism', cn: '并行', en: 'Parallelism', rows: dashboard.parallelism || [] }
    ].filter((entry) => entry.rows.length || entry.id === 'queue')
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

  /** A shut category's headline: the queue's counts, the row whose id names a state, else the first one, else nothing. */
  function headlineOf(group) {
    const row = (group.rows || []).find((entry) => String(entry.id || '').endsWith(':state')) || (group.rows || [])[0] || null
    const value = group.queue?.headline || row?.value
    if (!value || value === '—') return null
    return String(value).length > 18 ? `${String(value).slice(0, 17)}…` : String(value)
  }

  /**
   * One queued task, as a row with the two things a person can do about it.
   *
   * The panel used to draw the queue as a number, and a number cannot be corrected or moved — which is what
   * "也不能编辑，也不能调顺序" was. The two buttons are the same operations the official plugin's ball offers
   * (`scheduler.reorderTask` and `scheduler.editTask`, reached here over this window's own IPC), so both balls let
   * the user do the same things to the same queue.
   */
  function drawQueueTask(task, index, count) {
    const row = element('div', 'queue-task')
    row.dataset.task = task.id
    const head = element('div', 'queue-head')
    head.appendChild(element('span', 'muted', `#${task.rank || index + 1}`))
    const stateCn = task.status === 'SUSPENDED' ? '已挂起' : '等待中'
    const reasonCn = task.reason === 'waiting-schedule' ? '等到点' : task.reason === 'peak-window' ? '等谷价' : (task.reason || '')
    head.appendChild(element('span', `state ${task.status === 'SUSPENDED' ? 'tone-busy' : 'muted'}`, reasonCn ? `${stateCn} · ${reasonCn}` : stateCn))
    head.appendChild(element('span', 'muted at', task.startAtIso ? clockOf(task.startAtIso) : '—'))
    row.appendChild(head)
    row.appendChild(element('div', 'prompt', task.prompt || '—'))
    const actions = element('div', 'queue-actions')
    const move = (label, title, direction, disabled) => {
      const button = element('button', 'act small', label)
      button.type = 'button'
      button.title = title
      if (disabled) button.disabled = true
      button.addEventListener('click', () => moveTask(task.id, direction))
      return button
    }
    actions.appendChild(move('↑ 上移', '在这条前面 · move up in the queue', 'up', index === 0))
    actions.appendChild(move('↓ 下移', '排到后面 · move down in the queue', 'down', index === count - 1))
    const edit = element('button', 'act small', '✎ 编辑 · Edit')
    edit.type = 'button'
    edit.title = '改这条任务的内容或时间 · edit this task'
    edit.dataset.orbAction = 'edit-task'
    edit.addEventListener('click', () => openTaskForm(task))
    actions.appendChild(edit)
    row.appendChild(actions)
    return row
  }

  /** `2026-09-15T09:41:00.000Z` → `09:41`, the wall clock a person reads. */
  function clockOf(iso) {
    const at = new Date(String(iso || ''))
    if (!Number.isFinite(at.getTime())) return '—'
    const pad = (value) => String(value).padStart(2, '0')
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  }

  /** The queue's body: its tasks, or the reason there are none — "empty" and "unreadable" are different pictures. */
  function drawQueue(queue) {
    const wrap = element('div', 'queue')
    if (!queue || queue.ok === false) {
      wrap.appendChild(element('div', 'muted', queue?.reason || '队列不可读 · the queue cannot be read'))
      return wrap
    }
    if (!(queue.tasks || []).length) {
      wrap.appendChild(element('div', 'muted', '队列是空的 · the queue is empty'))
      return wrap
    }
    queue.tasks.forEach((task, index) => wrap.appendChild(drawQueueTask(task, index, queue.tasks.length)))
    return wrap
  }

  /** Move a queued task, then redraw from the answer — the order shown is the order the layer recorded. */
  function moveTask(taskId, move) {
    if (!api || typeof api.moveTask !== 'function') {
      taskNotice = { ok: false, text: '✖ 这个窗口没有调序的通道 · this window has no queue channel' }
      drawPanel()
      measure()
      return
    }
    Promise.resolve(api.moveTask({ taskId, move }))
      .then((answer) => {
        if (!answer || answer.ok === false) {
          taskNotice = { ok: false, text: `✖ ${(answer && answer.reason) || 'the move was refused'}` }
          drawPanel()
          measure()
        }
      })
      .catch((error) => {
        taskNotice = { ok: false, text: `✖ ${String((error && error.message) || error)}` }
        drawPanel()
        measure()
      })
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
    if (group.id === 'queue') card.appendChild(drawQueue(group.queue))
    else for (const row of group.rows) card.appendChild(drawField(row))
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
      // ...and a redraw must not take the cursor out of the field the user is typing in (see `focusInsidePanel`).
      const caret = focusInsidePanel()
      panelBody.replaceChildren(drawTaskForm())
      restoreFocus(caret)
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
    if (panelTitle) panelTitle.textContent = mode !== 'task' ? 'Mega' : (editingTask ? '编辑队列任务 · Edit task' : '新建定时任务 · New task')
    if (panelState && mode === 'task') panelState.textContent = editingTask ? '改完保存 · save to update' : '到点自动发出 · sends when due'
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

  function openTaskForm(task = null) {
    mode = 'task'
    // The form serves both jobs: "make one" (no task) and "change that one" (a queued task from the panel's queue
    // fold). One form, because a task edited here and a task created here have to mean the same thing.
    editingTask = task && task.id ? task : null
    taskNotice = null
    taskDraft.prompt = editingTask ? String(editingTask.prompt || '') : ''
    taskDraft.startAt = editingTask && editingTask.startAtIso ? localFromInstant(editingTask.startAtIso) : ''
    taskDraft.allowPeak = editingTask ? editingTask.allowPeak === true : false
    loadTiming()
    drawPanel()
    measure()
    // The cursor is where the user is about to type. Asking for it again after the timing answer lands is what
    // `drawPanel`'s `restoreFocus` does, so the read arriving late cannot push the user out of the box.
    focusPrompt()
  }

  function closeTaskForm() {
    mode = 'dashboard'
    editingTask = null
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
    wrap.dataset.orbEditing = editingTask ? editingTask.id : ''
    if (!panelBody) return wrap

    // Editing says what it is editing: a form holding the task's own words and nothing else would be a form the user
    // has to guess about.
    if (editingTask) {
      const banner = element('div', 'form-label')
      banner.appendChild(element('span', null, `✎ 编辑队列 #${editingTask.rank || ''}`))
      banner.appendChild(element('small', null, 'editing a queued task'))
      wrap.appendChild(banner)
    }

    const promptLabel = element('div', 'form-label')
    promptLabel.appendChild(element('span', null, '要执行的内容 · What to run'))
    wrap.appendChild(promptLabel)

    const prompt = element('textarea', 'prompt')
    prompt.dataset.orbField = 'prompt'
    prompt.rows = 4
    prompt.placeholder = '和平时对话一样输入 · type it as you would in a chat'
    prompt.value = taskDraft.prompt
    prompt.addEventListener('input', () => {
      taskDraft.prompt = prompt.value
      // The button's own state follows the text (see `syncFormState`), but the box is **not** rebuilt: that would
      // interrupt an IME composition mid-word.
      syncFormState()
    })
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
    timeInput.addEventListener('input', () => {
      taskDraft.startAt = timeInput.value
      // In place, not by a redraw: rebuilding the form while the native picker is open would close it.
      syncFormState()
    })
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
        // The field is the one place the value is *shown*, so it is written as well as the draft — no rebuild.
        timeInput.value = taskDraft.startAt
        syncFormState()
      })
      presets.appendChild(button)
    }
    schedule.appendChild(presets)

    const peak = element('input', null)
    peak.type = 'checkbox'
    peak.dataset.orbField = 'allowPeak'
    peak.checked = taskDraft.allowPeak === true
    peak.addEventListener('change', () => {
      taskDraft.allowPeak = peak.checked === true
      syncFormState()
    })
    schedule.appendChild(formField('允许峰值', 'Allow peak hours', peak,
      timing && timing.schedule && Array.isArray(timing.schedule.peakPeriods) && timing.schedule.peakPeriods.length
        ? `峰价 ${timing.schedule.peakPeriods.map((window) => `${window.start}-${window.end}`).join(', ')}；不允许时到点若在峰价会挂起`
        : null))
    wrap.appendChild(schedule)

    // What will happen, in one sentence — the thing the user is agreeing to.
    const summary = element('div', 'summary')
    summary.dataset.orbPart = 'summary'
    const described = summaryState()
    summary.textContent = described.text
    summary.className = described.className
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
    const create = element('button', 'act primary', taskBusy
      ? (editingTask ? '更新中… · Updating…' : '创建中… · Creating…')
      : (editingTask ? '保存修改 · Save' : '创建定时任务 · Schedule'))
    create.type = 'button'
    create.dataset.orbAction = 'create-task'
    create.dataset.orbPart = 'create'
    const armed = formArmed()
    if (!armed.ok) {
      create.disabled = true
      create.title = armed.reason
    }
    create.addEventListener('click', () => submitTask())
    buttons.appendChild(create)
    wrap.appendChild(buttons)
    return wrap
  }

  /**
   * The sentence under the schedule: exactly when this will be sent, and whether that is even possible.
   *
   * One function rather than a block inside `drawTaskForm`, because the same sentence has to be re-written while the
   * user fills the form in (`syncFormState`) — and two copies of it would be two chances for the panel to say
   * something the button does not believe.
   */
  function summaryState() {
    const instant = instantFromLocal(taskDraft.startAt)
    if (instant === null) return { text: '还没有选择时间 · no time chosen yet', className: 'summary muted' }
    if (instant.getTime() <= Date.now()) {
      return { text: `⚠ 这个时间已经过去 · that time is in the past（${taskDraft.startAt.replace('T', ' ')}）`, className: 'summary warn' }
    }
    return {
      text: `将在 ${taskDraft.startAt.replace('T', ' ')} 作为官方新会话发出 · sends as a new official conversation in ${offsetText(instant.getTime() - Date.now())}`,
      className: 'summary'
    }
  }

  /**
   * Whether the form is ready to send, and — when it is not — why.
   *
   * The one rule both the button and Enter consult. "A time that has not already gone" is not decoration: the
   * scheduler refuses a *new* task whose instant is in the past (`SchedulerService.addTask`), because a past instant
   * is `ready` in the gate and the task would run at once instead of waiting — the "定时任务挂起失败" report. And a
   * `datetime-local` field truncates to the minute, so picking "this minute" is already behind us.
   */
  function formArmed() {
    const instant = instantFromLocal(taskDraft.startAt)
    const prompt = String(taskDraft.prompt || '').trim()
    if (taskBusy) return { ok: false, reason: '创建中 · creating', prompt, instant }
    if (!prompt) return { ok: false, reason: '要执行的内容还没有写 · nothing to run yet', prompt, instant }
    if (instant === null) return { ok: false, reason: '还没有选择时间 · no time chosen yet', prompt, instant }
    if (instant.getTime() <= Date.now()) return { ok: false, reason: '这个时间已经过去 · that time is in the past', prompt, instant }
    return { ok: true, reason: null, prompt, instant }
  }

  /**
   * Keep the sentence and the button honest **while** the user fills the form in.
   *
   * The form used to update only when something redrew the panel — a preset click, or the shell's 15-second poll —
   * so typing a prompt left the Create button greyed out for up to fifteen seconds, and editing the time left the
   * summary describing the old one. Rewriting two nodes is cheap and, unlike a redraw, it cannot close an open
   * native date picker or interrupt an IME composition in the prompt box.
   */
  function syncFormState() {
    if (!panelBody || typeof panelBody.querySelector !== 'function') return
    const described = summaryState()
    const summary = panelBody.querySelector('[data-orb-part="summary"]')
    if (summary) {
      summary.textContent = described.text
      summary.className = described.className
    }
    const create = panelBody.querySelector('[data-orb-part="create"]')
    if (create) {
      const armed = formArmed()
      create.disabled = !armed.ok
      create.title = armed.ok ? '' : armed.reason
    }
  }

  /** Ask DS-Hns for the task, and say what it answered — its own words when it refuses. */
  function submitTask() {
    if (taskBusy) return
    const armed = formArmed()
    if (!armed.ok) {
      // Enter in the prompt box reaches this without the button ever being armed. An empty form stays quiet (there
      // is nothing to say yet); a time that has gone is said out loud, because the user believes they filled it in.
      if (armed.prompt && armed.instant !== null && armed.instant.getTime() <= Date.now()) {
        taskNotice = { ok: false, text: '✖ 这个时间已经过去，定时任务要一个未来的时间 · that time is in the past' }
        drawPanel()
        measure()
      }
      return
    }
    const channel = editingTask ? 'editTask' : 'createTask'
    if (!api || typeof api[channel] !== 'function') {
      taskNotice = {
        ok: false,
        text: editingTask
          ? '✖ 这个窗口没有改任务的通道 · this window has no edit channel'
          : '✖ 这个窗口没有创建任务的通道 · this window has no task channel'
      }
      drawPanel()
      measure()
      return
    }
    taskBusy = true
    taskNotice = null
    drawPanel()
    measure()
    // One request either way: the difference is the route and whether the id travels — "edit" that went somewhere
    // else would be a second place where a task is described.
    Promise.resolve(api[channel](editingTask
      ? { taskId: editingTask.id, prompt: armed.prompt, startAt: armed.instant.toISOString(), allowPeak: taskDraft.allowPeak === true }
      : { prompt: armed.prompt, startAt: armed.instant.toISOString(), allowPeak: taskDraft.allowPeak === true, deliveryMode: 'official-session' }))
      .then((answer) => {
        if (!answer || answer.ok === false) {
          taskNotice = { ok: false, text: `✖ ${(answer && answer.reason) || 'the task was refused'}` }
          return
        }
        const task = answer.task || {}
        // A made task clears the box, so a second Enter cannot silently schedule the same prompt again. An edited
        // one keeps what it now says: the form is showing a task that exists.
        if (!editingTask) taskDraft.prompt = ''
        taskNotice = {
          ok: true,
          text: editingTask
            ? `✓ 已更新 #${String(task.id || editingTask.id).slice(0, 18)} · updated, status ${task.status || 'SUSPENDED'}`
            : `✓ 已加入队列 #${String(task.id || '').slice(0, 18)} · queued as ${task.status || 'PENDING'}`
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

  /**
   * A click anywhere that is not the panel closes it — the window is interactive while it is open.
   *
   * **Except while the new-task form is open.** A form holds half-typed text, and a click somewhere else on the
   * screen is not a decision to throw that away; the form's own ways out are `← 返回`, the ball, and `×`, all of them
   * deliberate. This is half of the user's report ("任意点击直接关闭弹窗") fixed at its source: the click that
   * focuses a field must not be able to dismiss the surface that holds it. (The other half is the window itself: a
   * `focusable: false` window cannot be typed into at all — see `syncFocusable` in `system-orb.cjs`.)
   */
  function onDocumentPointerDown(event) {
    if (!state.open) return
    if (mode === 'task') return
    const target = event.target
    if (panel && typeof panel.contains === 'function' && panel.contains(target)) return
    if (ball && typeof ball.contains === 'function' && ball.contains(target)) return
    if (api && typeof api.open === 'function') Promise.resolve(api.open(false)).then(apply).catch(() => {})
  }

  /**
   * Whether the keyboard is inside the panel right now — i.e. the user is typing in it.
   *
   * It is asked *before* the panel is emptied (`drawPanel`), because a redraw that takes the cursor out of the field
   * being typed in is a redraw that interrupts the user: the panel is redrawn by a 15-second poll, so this is not a
   * rare path.
   */
  function focusInsidePanel() {
    if (!doc || !panel || typeof panel.contains !== 'function') return null
    const active = doc.activeElement
    if (!active || active === doc.body || !panel.contains(active)) return null
    const caret = typeof active.selectionStart === 'number'
      ? { start: active.selectionStart, end: active.selectionEnd, field: active.dataset ? active.dataset.orbField : null }
      : { start: null, end: null, field: active.dataset ? active.dataset.orbField : null }
    return caret
  }

  /** Put the cursor back in the composer — in the field it was in, at the offset it was at. */
  function restoreFocus(caret) {
    if (!caret || !caret.field || !panelBody || typeof panelBody.querySelector !== 'function') return
    const field = panelBody.querySelector(`[data-orb-field="${caret.field}"]`)
    if (!field || typeof field.focus !== 'function') return
    field.focus()
    if (caret.start !== null && typeof field.setSelectionRange === 'function') {
      try {
        field.setSelectionRange(caret.start, caret.end)
      } catch { /* a field that does not support a selection still keeps the focus */ }
    }
  }

  /**
   * Open the form with the cursor already in the composer.
   *
   * The ball never takes focus on its own (a press on it must not pull the keyboard out of whatever the user is
   * typing in behind it) — but a form the user *asked for* is the opposite case: it exists to be typed into, which is
   * why the shell makes the window focusable for as long as the panel is open.
   */
  function focusPrompt() {
    restoreFocus({ field: 'prompt', start: null, end: null })
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
