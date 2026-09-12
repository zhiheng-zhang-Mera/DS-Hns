'use strict'

/**
 * Utility Drawer (Update-Plan/Daily-UX.md 任务 8 / 任务 9 / 任务 10).
 *
 * The old Context Panel was a permanent third column that squeezed the chat. The
 * drawer replaces it:
 *
 *   closed   default; the conversation keeps the whole width
 *   open     overlays the conversation from the right edge
 *   pinned   participates in the layout (the user asked for it to stay)
 *
 * It carries the plan's tab set. Tasks and Context are live; Files, Changes, Git
 * and Terminal belong to a later stage and say so instead of showing nothing, and
 * the Context tab is also where the secondary status moved out of the top bar
 * lives (permission mode, task counts, backend state, contracts).
 */
;(function attachUtilityDrawer(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  const TABS = ['files', 'changes', 'git', 'tasks', 'terminal', 'context']
  const TAB_LABEL = { files: 'Files', changes: 'Changes', git: 'Git', tasks: 'Tasks', terminal: 'Terminal', context: 'Context' }
  const PLANNED = {
    files: '工作区文件树、打开与预览（下一阶段）',
    changes: '改动列表与 diff 摘要（下一阶段）',
    git: '分支、状态、最近提交与改动文件（下一阶段）',
    terminal: '只读 / 基础终端（下一阶段）'
  }
  const STATES = ['closed', 'open', 'pinned']
  const STATE_KEY = 'ds-hns.native.utility'

  let drawerState = readState()
  let active = 'tasks'
  let renderedTab = null
  let latestState = {}
  let handlers = {}

  function readState() {
    try {
      const raw = global.localStorage ? global.localStorage.getItem(STATE_KEY) : null
      return STATES.includes(raw) ? raw : 'closed'
    } catch {
      return 'closed'
    }
  }

  function writeState(next) {
    drawerState = next
    try {
      global.localStorage?.setItem(STATE_KEY, next)
    } catch {
      // Persistence is a convenience; the drawer still works for this session.
    }
    return drawerState
  }

  function tabs() {
    if (typeof document.querySelectorAll !== 'function') return []
    try {
      return [...document.querySelectorAll('[data-context-tab]')]
    } catch {
      return []
    }
  }

  /** Running/queued counts for the drawer's Task line. */
  function taskSummary(tasks) {
    const active_states = ['RUNNING', 'DISPATCHING', 'PENDING', 'SUSPENDED', 'QUEUED']
    const open = (Array.isArray(tasks) ? tasks : []).filter((task) => active_states.includes(String(task && task.status).toUpperCase()))
    const running = open.filter((task) => String(task.status).toUpperCase() === 'RUNNING').length
    return { active: open.length, running, queued: open.length - running }
  }

  function setActive(tab) {
    const next = TABS.includes(tab) ? tab : 'tasks'
    if (next === active) return active
    active = next
    renderedTab = null
    return active
  }

  function setState(next) {
    if (!STATES.includes(next)) return drawerState
    writeState(next)
    applyShell()
    return drawerState
  }

  function state() {
    return drawerState
  }

  function open() {
    return setState(drawerState === 'pinned' ? 'pinned' : 'open')
  }

  function close() {
    return setState('closed')
  }

  function toggle() {
    return drawerState === 'closed' ? open() : close()
  }

  function pin(on) {
    const next = on === undefined ? drawerState !== 'pinned' : Boolean(on)
    if (next) return setState('pinned')
    return setState(drawerState === 'pinned' ? 'open' : drawerState)
  }

  /** The drawer state lives on <body> so CSS owns the layout consequence. */
  function applyShell() {
    if (document.body) document.body.dataset.utility = drawerState
    const pinButton = byId('pinUtility')
    if (pinButton && typeof pinButton.setAttribute === 'function') {
      pinButton.setAttribute('aria-pressed', drawerState === 'pinned' ? 'true' : 'false')
      pinButton.title = drawerState === 'pinned' ? '取消固定（改为浮层）' : '固定（参与布局）'
    }
    const handle = byId('utilityHandle')
    if (handle) handle.title = drawerState === 'closed' ? '打开工具抽屉（Files / Git / Tasks / Context）' : '关闭工具抽屉'
  }

  function emptyState(title, note) {
    return `<div class="context-empty"><b>${esc(title)}</b><p>${esc(note)}</p>` +
      `<button type="button" class="quiet" data-context-refresh="1">刷新</button></div>`
  }

  /** Secondary status: what the top bar deliberately no longer shows. */
  function contextRows(state) {
    const diagnostics = state.diagnostics || {}
    const conversation = state.conversation || {}
    const summary = taskSummary(state.tasks)
    const rows = [
      ['权限模式', (state.settings && state.settings.permissionMode) || '—'],
      ['任务', `${summary.running} 运行 · ${summary.queued} 等待`],
      ['后端', `${(state.backend && state.backend.state) || 'unknown'}${state.backend && state.backend.version ? ` · ${state.backend.version}` : ''}`],
      ['模式', `${state.mode} (${state.modeState || '—'})`],
      ['会话', state.session ? `${state.session.title} · ${state.session.id}` : '未选择'],
      ['工作区', (state.settings && state.settings.workspace) || '—'],
      ['模型', (state.settings && state.settings.model) || '—'],
      ['对话事件', `${conversation.events == null ? 0 : conversation.events} 条 · 未识别 ${conversation.unclassified == null ? 0 : conversation.unclassified} 条`],
      ['主题', document.body && document.body.dataset.themeId ? document.body.dataset.themeId : '—'],
      ['HNS Model', diagnostics.adapter && diagnostics.adapter.model ? `v${diagnostics.adapter.model}` : '—'],
      ['Adapter 契约', diagnostics.adapter && diagnostics.adapter.contract ? `v${diagnostics.adapter.contract}` : '—'],
      ['兼容性', (diagnostics.compatibility && diagnostics.compatibility.nativeFrontend) || '未探测'],
      ['降级', state.degraded ? state.degraded.reason : '无']
    ]
    return rows.map(([label, value]) => `<div class="context-row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')
  }

  function ensureBody(state) {
    const body = byId('contextBody')
    if (!body) return null
    if (renderedTab === active) return body
    renderedTab = active
    if (active === 'tasks') body.innerHTML = '<div id="toolActivity" class="tool-activity"></div>'
    else if (active === 'context') {
      body.innerHTML = `<div class="context-rows">${contextRows(state)}</div>` +
        '<h3 class="drawer-subhead">角色</h3><div id="characterControls" class="context-rows"></div>'
    } else body.innerHTML = emptyState(TAB_LABEL[active], PLANNED[active] || '尚未实现')
    return body
  }

  function render(state) {
    latestState = state || latestState
    applyShell()
    for (const button of tabs()) {
      const isActive = button.dataset.contextTab === active
      if (button.classList) button.classList.toggle('active', isActive)
      if (typeof button.setAttribute === 'function') button.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
    const hint = byId('contextHint')
    if (hint) hint.textContent = `${TAB_LABEL[active]} · ${drawerState}`
    const body = ensureBody(latestState)
    if (!body) return
    if (active === 'tasks' && ui.toolActivity) {
      ui.toolActivity.render(latestState)
    } else if (active === 'context') {
      const rows = typeof body.querySelector === 'function' ? body.querySelector('.context-rows') : null
      if (rows) rows.innerHTML = contextRows(latestState)
      if (ui.character) ui.character.renderControls()
    }
  }

  function mount(incoming = {}) {
    handlers = incoming
    for (const button of tabs()) {
      if (typeof button.addEventListener !== 'function') continue
      button.addEventListener('click', () => {
        setActive(button.dataset.contextTab)
        render(latestState)
      })
    }
    const wire = (id, event, run) => {
      const element = byId(id)
      if (element && typeof element.addEventListener === 'function') element.addEventListener(event, run)
    }
    wire('utilityHandle', 'click', () => {
      toggle()
      render(latestState)
    })
    wire('closeUtility', 'click', () => {
      close()
      render(latestState)
    })
    wire('pinUtility', 'click', () => {
      pin()
      render(latestState)
    })
    const body = byId('contextBody')
    if (body && typeof body.addEventListener === 'function') {
      body.addEventListener('click', (event) => {
        const target = event && event.target
        if (target && typeof target.closest === 'function' && target.closest('[data-context-refresh]')) {
          if (handlers.onRefresh) handlers.onRefresh()
        }
      })
    }
    applyShell()
  }

  ui.utility = {
    TABS,
    TAB_LABEL,
    PLANNED,
    STATES,
    render,
    mount,
    state,
    open,
    close,
    toggle,
    pin,
    setActive,
    activeTab: () => active
  }
})(window)
