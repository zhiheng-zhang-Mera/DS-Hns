'use strict'

/**
 * Context Panel (Update-Plan/daily-refactorr.md 任务 1; tabs from 任务 10).
 *
 * This stage delivers the panel itself: a 300-460px, foldable column that belongs
 * to Daily instead of to Mega. Its tabs are the ones the plan names. The tabs whose
 * data lands in the next stage (Files / Changes / Git / Terminal) show an explicit
 * empty state naming that stage, because 任务 26 requires every module to have an
 * honest empty state instead of a blank box.
 *
 * Two of the six tabs are live today: Tasks (the tool/task activity that used to
 * be the dock's job) and Context (the effective configuration of this renderer).
 */
;(function attachContextPanel(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId } = ui.dom

  const TABS = ['files', 'changes', 'git', 'tasks', 'terminal', 'context']
  const TAB_LABEL = { files: 'Files', changes: 'Changes', git: 'Git', tasks: 'Tasks', terminal: 'Terminal', context: 'Context' }
  const PLANNED = {
    files: '工作区文件树、打开与预览（Daily 重构 §7 任务 11）',
    changes: '改动列表与 diff 摘要（Daily 重构 §7 任务 12）',
    git: '分支、状态、最近提交与改动文件（Daily 重构 §7 任务 13）',
    terminal: '只读 / 基础终端（Daily 重构 §7 任务 15）'
  }

  let active = 'tasks'
  /** Which tab the body markup currently holds, so a poll never rebuilds it. */
  let renderedTab = null
  let latestState = {}
  let handlers = {}

  function tabs() {
    if (typeof document.querySelectorAll !== 'function') return []
    try {
      return [...document.querySelectorAll('[data-context-tab]')]
    } catch {
      return []
    }
  }

  function setActive(tab) {
    const next = TABS.includes(tab) ? tab : 'tasks'
    if (next === active) return active
    active = next
    renderedTab = null
    if (handlers.onChange) handlers.onChange(active)
    return active
  }

  function activeTab() {
    return active
  }

  function emptyState(title, note) {
    return `<div class="context-empty"><b>${esc(title)}</b><p>${esc(note)}</p>` +
      `<button type="button" class="quiet" data-context-refresh="1">刷新</button></div>`
  }

  function contextRows(state) {
    const diagnostics = state.diagnostics || {}
    const conversation = state.conversation || {}
    const rows = [
      ['模式', `${state.mode} (${state.modeState || '—'})`],
      ['会话', state.session ? `${state.session.title} · ${state.session.id}` : '未选择'],
      ['后端', `${(state.backend && state.backend.state) || 'unknown'}${state.backend && state.backend.version ? ` · ${state.backend.version}` : ''}`],
      ['工作区', (state.settings && state.settings.workspace) || '—'],
      ['模型', (state.settings && state.settings.model) || '—'],
      ['权限', (state.settings && state.settings.permissionMode) || '—'],
      ['对话事件', `${conversation.events == null ? 0 : conversation.events} 条 · 未识别 ${conversation.unclassified == null ? 0 : conversation.unclassified} 条`],
      ['主题', state.themeId || (document.body && document.body.dataset.themeId) || '—'],
      ['HNS Model', diagnostics.adapter && diagnostics.adapter.model ? `v${diagnostics.adapter.model}` : '—'],
      ['Adapter 契约', diagnostics.adapter && diagnostics.adapter.contract ? `v${diagnostics.adapter.contract}` : '—'],
      ['兼容性', (diagnostics.compatibility && diagnostics.compatibility.nativeFrontend) || '未探测'],
      ['降级', state.degraded ? state.degraded.reason : '无']
    ]
    return rows.map(([label, value]) => `<div class="context-row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')
  }

  /** Rebuild the body only when the tab actually changed. */
  function ensureBody(state) {
    const body = byId('contextBody')
    if (!body) return null
    if (renderedTab === active) return body
    renderedTab = active
    if (active === 'tasks') body.innerHTML = '<div id="toolActivity" class="tool-activity"></div>'
    else if (active === 'context') body.innerHTML = `<div class="context-rows">${contextRows(state)}</div>`
    else body.innerHTML = emptyState(TAB_LABEL[active], PLANNED[active] || '尚未实现')
    return body
  }

  function render(state) {
    latestState = state || latestState
    for (const button of tabs()) {
      const isActive = button.dataset.contextTab === active
      if (button.classList) button.classList.toggle('active', isActive)
      if (typeof button.setAttribute === 'function') button.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
    const hint = byId('contextHint')
    if (hint) hint.textContent = TAB_LABEL[active]
    const body = ensureBody(latestState)
    if (!body) return
    if (active === 'tasks' && ui.toolActivity) {
      ui.toolActivity.render(latestState)
    } else if (active === 'context') {
      const rows = typeof body.querySelector === 'function' ? body.querySelector('.context-rows') : null
      if (rows) rows.innerHTML = contextRows(latestState)
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
    const body = byId('contextBody')
    if (body && typeof body.addEventListener === 'function') {
      body.addEventListener('click', (event) => {
        const target = event && event.target
        if (target && typeof target.closest === 'function' && target.closest('[data-context-refresh]')) {
          if (handlers.onRefresh) handlers.onRefresh()
        }
      })
    }
  }

  ui.contextPanel = { TABS, TAB_LABEL, render, mount, setActive, activeTab, PLANNED }
})(window)
