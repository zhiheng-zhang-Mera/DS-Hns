'use strict'

/**
 * Skills panel — managing what the agent can be told to do.
 *
 * The interaction model is the one people already know from a skill/extension
 * store: search, install, and remove, with removal available both one at a time and
 * in bulk.
 *
 * What this panel deliberately does NOT do:
 *   - it never reads or writes the skill directory itself; every mutation goes
 *     through the main-process service, so the validation rules live in one place;
 *   - it never trusts a search result — installing re-reads the real `SKILL.md`
 *     from the resolved location;
 *   - it never interpolates server data into markup without escaping.
 *
 * Theme adaptation: the panel joins the shared `theme-bridge` exactly like the
 * Appearance panel does, so a theme restyles it and theme validation can measure
 * it. It reads its own styling from CSS custom properties only.
 */
;(function attachSkillsPanel(global) {
  const $ = (id) => document.getElementById(id)

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]))
  }

  function api() {
    return global.megaTools && global.megaTools.skills ? global.megaTools.skills : null
  }

  /** Slot ids this panel renders. The bridge writes their styles for us. */
  const SKILL_SLOTS = [
    'hns.skill.card',
    'hns.skill.header',
    'hns.skill.badge',
    'hns.skill.tag',
    'hns.skill.search',
    'hns.skill.danger',
    'common.button.primary',
    'common.button.secondary',
    'common.panel.background'
  ]

  /** Slots and protected regions this panel owns, for theme validation. */
  const SKILL_SLOT_SELECTORS = {
    'hns.skill.card': '#skillsList',
    'hns.skill.header': '#skillsPanel .panel-head',
    'hns.skill.badge': '#skillsStatus',
    'hns.skill.tag': '#skillsTags',
    'hns.skill.search': '#skillQuery',
    'hns.skill.danger': '#skillDeleteSelected'
  }
  const SKILL_REGION_SELECTORS = {
    'skills-search': '#skillQuery',
    'skills-list': '#skillsList'
  }

  const state = {
    tab: 'browse',
    query: '',
    tags: [],
    live: false,
    snapshot: null,
    results: null,
    searching: false,
    busy: false,
    selected: new Set(),
    /** Install progress, keyed by entry id or source string. */
    installing: new Map(),
    message: null,
    error: null,
    detail: null
  }

  const inflight = new Set()

  function track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((error) => setError(error))
      .finally(() => inflight.delete(tracked))
    inflight.add(tracked)
    return tracked
  }

  async function settled() {
    for (let guard = 0; guard < 25 && inflight.size; guard += 1) await Promise.all([...inflight])
  }

  function setMessage(text, kind = '') {
    state.message = text ? { text: String(text), kind } : null
    renderMessage()
  }

  function setError(error) {
    state.error = error ? String(error.message || error) : null
    renderMessage()
  }

  function renderMessage() {
    const node = $('skillsMessage')
    if (!node) return
    if (state.error) {
      node.textContent = state.error
      node.className = 'theme-message error'
      return
    }
    node.textContent = state.message ? state.message.text : ''
    node.className = `theme-message ${state.message ? state.message.kind : ''}`.trim()
  }

  function setBusy(busy) {
    state.busy = Boolean(busy)
    for (const id of ['skillsRefresh', 'skillsPickDir', 'skillInstallSource', 'skillDeleteSelected']) {
      const node = $(id)
      if (node && id !== 'skillDeleteSelected') node.disabled = state.busy
    }
    // `skillDeleteSelected` is owned by the selection state, never by the busy flag,
    // so a batch delete cannot re-enable itself mid-flight.
    renderToolbar()
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function loadSnapshot({ quiet = true } = {}) {
    const bridge = api()
    if (!bridge) return null
    try {
      const result = await bridge.snapshot()
      if (result && result.ok) {
        state.snapshot = result
        if (!quiet) setError(null)
        // A selection can outlive its skills; drop anything that is gone.
        const names = new Set((result.skills || []).map((skill) => skill.name))
        for (const name of [...state.selected]) if (!names.has(name)) state.selected.delete(name)
      } else if (result && !result.ok) {
        setMessage(`读取技能目录失败：${result.reason || '未知原因'}`, 'error')
      }
      return result
    } catch (error) {
      setError(error)
      return null
    }
  }

  async function runSearch({ live = state.live } = {}) {
    const bridge = api()
    if (!bridge) return null
    state.searching = true
    renderStatus()
    try {
      const result = await bridge.search({ query: state.query, tags: state.tags, includeLive: live })
      if (result && result.ok) {
        state.results = result
        const notices = result.notices || []
        if (notices.length) setMessage(notices.join('；'), 'warn')
        else if (!quietSearch()) setMessage(null)
      } else {
        setMessage('搜索失败', 'error')
      }
      return result
    } catch (error) {
      setError(error)
      return null
    } finally {
      state.searching = false
      render()
    }
  }

  function quietSearch() {
    return state.query.trim() !== '' || state.live
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function installedMap() {
    const map = new Map()
    for (const skill of state.snapshot?.skills || []) map.set(skill.name, skill)
    return map
  }

  function originLabel(origin) {
    if (origin === 'github') return 'GitHub'
    if (origin === 'bundled') return '内置'
    if (origin === 'collection') return '合集'
    return '本地'
  }

  function renderStatus() {
    const node = $('skillsStatus')
    if (!node) return
    const counts = state.snapshot?.counts
    if (!counts) {
      node.textContent = '读取中…'
      node.className = 'status-chip neutral'
      return
    }
    const invalid = counts.invalid ? ` · ${counts.invalid} 个无效` : ''
    node.textContent = `${counts.valid} 个技能${invalid}`
    node.className = `status-chip ${counts.invalid ? 'warn' : 'ok'}`
  }

  function renderTags() {
    const node = $('skillsTags')
    if (!node) return
    const tags = state.tagsSource || []
    if (!tags.length) {
      node.innerHTML = ''
      return
    }
    node.innerHTML = tags.slice(0, 12).map(({ tag, count }) => {
      const active = state.tags.includes(tag) ? ' active' : ''
      return `<button type="button" class="skill-tag${active}" data-skill-tag="${esc(tag)}">${esc(tag)}<i>${esc(count)}</i></button>`
    }).join('')
  }

  function skillCardInstalled(skill) {
    const selected = state.selected.has(skill.name)
    const invalid = skill.valid === false
    const badges = [
      `<span class="skill-origin">${esc(originLabel(skill.origin))}</span>`,
      skill.modelInvocable === false ? '<span class="skill-surface off">模型不可用</span>' : '<span class="skill-surface">模型可用</span>',
      skill.userInvocable === false ? '<span class="skill-surface off">命令不可用</span>' : ''
    ].filter(Boolean).join('')
    return `<article class="skill-card${selected ? ' selected' : ''}${invalid ? ' invalid' : ''}" data-skill-card="${esc(skill.name)}">
      <label class="skill-pick"><input type="checkbox" data-skill-select="${esc(skill.name)}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(skill.name)}"></label>
      <div class="skill-main">
        <div class="skill-title-row">
          <b class="skill-name">${esc(skill.name)}</b>
          ${skill.collection ? `<span class="skill-collection">${esc(skill.collection)}</span>` : ''}
        </div>
        <p class="skill-desc">${esc(skill.description || skill.reason || '（缺少描述）')}</p>
        <div class="skill-badges">${badges}</div>
      </div>
      <div class="skill-actions">
        <button type="button" class="skill-icon" data-skill-detail="${esc(skill.name)}" title="查看内容">i</button>
        ${skill.collection ? `<button type="button" class="skill-icon danger" data-skill-collection="${esc(skill.collection)}" title="删除整个合集 ${esc(skill.collection)}">⧉</button>` : ''}
        <button type="button" class="skill-icon danger" data-skill-delete="${esc(skill.name)}" title="删除该技能">🗑</button>
      </div>
    </article>`
  }

  function skillCardAvailable(entry) {
    const installing = state.installing.get(entry.id)
    const installed = state.snapshot?.skills?.some((skill) => skill.name === entry.name || skill.name.endsWith(`-${entry.name}`))
    const label = installing ? '安装中…' : installed ? '已安装' : '安装'
    const origin = entry.origin === 'bundled' ? '内置' : entry.origin === 'live' ? 'GitHub 搜索' : '精选'
    const stars = entry.stars ? `<span class="skill-stars">★ ${esc(entry.stars)}</span>` : ''
    return `<article class="skill-card available" data-skill-entry="${esc(entry.id)}">
      <div class="skill-main">
        <div class="skill-title-row">
          <b class="skill-name">${esc(entry.name)}</b>
          <span class="skill-origin">${esc(origin)}</span>
          ${stars}
        </div>
        <p class="skill-desc">${esc(entry.summary || '')}</p>
        <div class="skill-badges">${(entry.tags || []).slice(0, 5).map((tag) => `<span class="skill-tag-static">${esc(tag)}</span>`).join('')}</div>
        ${entry.owner ? `<div class="skill-source-line">${esc(entry.owner)}/${esc(entry.repo)}${entry.subpath ? ` · ${esc(entry.subpath)}` : ''}</div>` : ''}
      </div>
      <div class="skill-actions">
        <button type="button" class="skill-install" data-skill-install="${esc(entry.id)}" ${installing ? 'disabled' : ''}>${esc(label)}</button>
      </div>
    </article>`
  }

  function renderList() {
    const node = $('skillsList')
    if (!node) return

    if (state.tab === 'installed') {
      const skills = state.snapshot?.skills || []
      if (!skills.length) {
        node.innerHTML = '<div class="muted">还没有安装任何技能。切换到「发现」搜索，或粘贴 GitHub 链接安装。</div>'
        return
      }
      node.innerHTML = skills.map(skillCardInstalled).join('')
      return
    }

    if (state.searching && !state.results) {
      node.innerHTML = '<div class="muted">搜索中…</div>'
      return
    }

    const offline = state.results?.offline?.entries || []
    const live = state.results?.live || []
    const sections = []
    if (live.length) {
      sections.push(`<div class="skills-section-title">GitHub 搜索结果 <i>${live.length}</i></div>`)
      sections.push(live.map(skillCardAvailable).join(''))
    }
    if (offline.length) {
      sections.push(`<div class="skills-section-title">${state.query.trim() ? '匹配来源' : '精选与内置'} <i>${offline.length}</i></div>`)
      sections.push(offline.map(skillCardAvailable).join(''))
    }
    if (!sections.length) {
      node.innerHTML = `<div class="muted">没有匹配的技能。可以直接粘贴 GitHub 链接安装，例如 <code>anthropics/skills</code>。</div>`
      return
    }
    node.innerHTML = sections.join('')
  }

  function renderToolbar() {
    const selectAll = $('skillSelectAll')
    const deleteButton = $('skillDeleteSelected')
    const counter = $('skillSelectedCount')
    const installed = state.tab === 'installed'
    const total = (state.snapshot?.skills || []).length
    const selected = state.selected.size

    if (selectAll) {
      selectAll.disabled = !installed || total === 0
      selectAll.checked = installed && total > 0 && selected === total
      selectAll.indeterminate = selected > 0 && selected < total
    }
    if (deleteButton) deleteButton.disabled = !installed || selected === 0 || state.busy
    if (counter) counter.textContent = installed ? `已选 ${selected} / ${total}` : ''
  }

  function renderTabs() {
    const browse = $('skillsTabBrowse')
    const installed = $('skillsTabInstalled')
    if (browse) browse.classList.toggle('active', state.tab === 'browse')
    if (installed) installed.classList.toggle('active', state.tab === 'installed')
    const count = $('skillsCount')
    if (count) {
      const total = (state.snapshot?.skills || []).length
      count.textContent = state.tab === 'installed' ? `${total} 个已安装` : ''
    }
  }

  function renderDetail() {
    const box = $('skillDetail')
    if (!box) return
    box.hidden = !state.detail
    if (!state.detail) return
    const name = $('skillDetailName')
    const meta = $('skillDetailMeta')
    const body = $('skillDetailBody')
    if (name) name.textContent = state.detail.name
    if (meta) {
      const kind = state.detail.kind === 'flat' ? '单文件' : '目录包'
      const origin = originLabel(state.detail.meta?.origin)
      meta.textContent = `${kind} · ${origin}${state.detail.meta?.sourceUrl ? ` · ${state.detail.meta.sourceUrl}` : ''}`
    }
    if (body) body.textContent = state.detail.body || '（无正文）'
  }

  function render() {
    renderStatus()
    renderTabs()
    renderList()
    renderToolbar()
    renderTags()
    renderDetail()
    renderMessage()
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function installEntry(id) {
    const bridge = api()
    if (!bridge) return
    state.installing.set(id, true)
    renderList()
    try {
      const result = await bridge.installCatalog({ id })
      reportInstall(result, id)
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    } finally {
      state.installing.delete(id)
      renderList()
    }
  }

  async function installFromSource(rawSource) {
    const bridge = api()
    if (!bridge) return
    const source = String(rawSource || '').trim()
    if (!source) {
      setMessage('请先粘贴 GitHub 链接或 owner/repo', 'warn')
      return
    }
    state.installing.set(source, true)
    renderList()
    setMessage('正在下载并校验…', '')
    try {
      const result = await bridge.installSource({ source })
      reportInstall(result, source)
      if (result && result.ok) $('skillSource').value = ''
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    } finally {
      state.installing.delete(source)
      renderList()
    }
  }

  /**
   * One install outcome is reported the same way whichever path produced it: what
   * was installed, what was skipped and why, and any name collision that was
   * resolved. A silent rename is the kind of surprise this makes visible.
   */
  function reportInstall(result, label) {
    if (!result) {
      setMessage('安装没有返回结果', 'error')
      return
    }
    if (!result.ok) {
      setMessage(`安装失败：${result.reason || '未知原因'}`, 'error')
      return
    }
    const installed = result.installed || []
    const skipped = result.skipped || []
    const renamed = installed.filter((item) => item.requestedName && item.requestedName !== item.name)
    const parts = [`已安装 ${installed.length} 个技能：${installed.map((item) => item.name).join('、')}`]
    if (renamed.length) parts.push(`其中 ${renamed.length} 个因重名重命名为 ${renamed.map((item) => item.name).join('、')}`)
    if (skipped.length) parts.push(`${skipped.length} 个被跳过（${skipped.map((item) => `${item.name}: ${item.reason}`).join('；')}）`)
    setMessage(parts.join('；'), skipped.length ? 'warn' : 'ok')
    if (installed.length) {
      // Show the skills that were just added, which is what the user wants to see.
      state.tab = 'installed'
    }
    void label
  }

  async function pickAndInstallLocal() {
    const bridge = api()
    if (!bridge) return
    try {
      const picked = await bridge.pickLocal()
      if (!picked || picked.canceled) return
      const result = picked.result || picked
      reportInstall(result, picked.path || 'local')
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    }
  }

  async function deleteOne(name) {
    const bridge = api()
    if (!bridge) return
    if (typeof global.confirm === 'function' && !global.confirm(`删除技能「${name}」？删除后 Harness 会立即不再加载它。`)) return
    try {
      const result = await bridge.remove(name)
      if (!result || !result.ok) {
        setMessage(`删除失败：${result?.reason || '未知原因'}`, 'error')
      } else {
        state.selected.delete(name)
        setMessage(`已删除技能：${name}`, 'ok')
      }
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    }
  }

  async function deleteSelected() {
    const bridge = api()
    if (!bridge) return
    const names = [...state.selected]
    if (!names.length) return
    if (typeof global.confirm === 'function' && !global.confirm(`删除选中的 ${names.length} 个技能？`)) return
    setBusy(true)
    try {
      const result = await bridge.removeMany(names)
      const deleted = result?.deleted || []
      const failed = result?.failed || []
      if (failed.length) {
        setMessage(`已删除 ${deleted.length} 个，${failed.length} 个失败（${failed.map((item) => `${item.name}: ${item.reason}`).join('；')}）`, 'warn')
      } else {
        setMessage(`已删除 ${deleted.length} 个技能`, 'ok')
      }
      state.selected.clear()
      const selectAll = $('skillSelectAll')
      if (selectAll) selectAll.checked = false
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function deleteCollection(collectionId) {
    const bridge = api()
    if (!bridge) return
    if (typeof global.confirm === 'function' && !global.confirm(`删除合集「${collectionId}」中的全部技能？`)) return
    setBusy(true)
    try {
      const result = await bridge.removeCollection(collectionId)
      setMessage(
        result && result.ok
          ? `已删除合集 ${collectionId} 的 ${(result.deleted || []).length} 个技能`
          : `合集删除失败：${result?.reason || '未知原因'}`,
        result && result.ok ? 'ok' : 'error'
      )
      await loadSnapshot()
      render()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function showDetail(name) {
    const bridge = api()
    if (!bridge) return
    try {
      const result = await bridge.detail(name)
      if (!result || !result.ok) {
        setMessage(`读取技能失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      state.detail = result
      renderDetail()
    } catch (error) {
      setError(error)
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function bindControls() {
    const refresh = $('skillsRefresh')
    if (refresh) {
      refresh.onclick = () => track((async () => {
        setBusy(true)
        await loadSnapshot({ quiet: false })
        await runSearch()
        setBusy(false)
        setMessage('已重新读取技能目录', 'ok')
      })())
    }

    const pick = $('skillsPickDir')
    if (pick) pick.onclick = () => track(pickAndInstallLocal())

    const installButton = $('skillInstallSource')
    if (installButton) installButton.onclick = () => track(installFromSource($('skillSource').value))

    const source = $('skillSource')
    if (source) {
      source.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          track(installFromSource(source.value))
        }
      }
    }

    const query = $('skillQuery')
    if (query) {
      let timer = null
      query.oninput = () => {
        state.query = query.value
        if (timer) clearTimeout(timer)
        // Debounced: a quick search box should not issue a request per keystroke.
        timer = setTimeout(() => track(runSearch()), 220)
      }
    }

    const live = $('skillLiveSearch')
    if (live) {
      live.onchange = () => {
        state.live = Boolean(live.checked)
        if (state.live) track(runSearch({ live: true }))
        else track(runSearch({ live: false }))
      }
    }

    const browse = $('skillsTabBrowse')
    if (browse) browse.onclick = () => { state.tab = 'browse'; render() }
    const installed = $('skillsTabInstalled')
    if (installed) installed.onclick = () => { state.tab = 'installed'; render() }

    const selectAll = $('skillSelectAll')
    if (selectAll) {
      selectAll.onchange = (event) => {
        // Capture the user's intent before rendering: `render()` writes `checked`
        // back from the selection state, and reading the element afterwards would
        // read that derived value instead of the click.
        const wanted = event && typeof event.target?.checked === 'boolean'
          ? event.target.checked
          : selectAll.checked
        state.selected.clear()
        if (wanted) {
          for (const skill of state.snapshot?.skills || []) state.selected.add(skill.name)
        }
        render()
      }
    }

    const deleteButton = $('skillDeleteSelected')
    if (deleteButton) deleteButton.onclick = () => track(deleteSelected())

    const tags = $('skillsTags')
    if (tags) {
      tags.addEventListener('click', (event) => {
        const tag = event.target?.dataset?.skillTag
        if (!tag) return
        const index = state.tags.indexOf(tag)
        if (index === -1) state.tags.push(tag)
        else state.tags.splice(index, 1)
        track(runSearch())
      })
    }

    const list = $('skillsList')
    if (list) {
      list.addEventListener('click', (event) => {
        const button = event.target?.closest?.('button')
        if (button) {
          const installId = button.dataset.skillInstall
          const remove = button.dataset.skillDelete
          const detail = button.dataset.skillDetail
          const collection = button.dataset.skillCollection
          if (installId) track(installEntry(installId))
          else if (remove) track(deleteOne(remove))
          else if (detail) track(showDetail(detail))
          else if (collection) track(deleteCollection(collection))
          return
        }
        const select = event.target?.dataset?.skillSelect
        if (select) {
          if (event.target.checked) state.selected.add(select)
          else state.selected.delete(select)
          render()
        }
      })
    }

    const detailClose = $('skillDetailClose')
    if (detailClose) {
      detailClose.onclick = () => {
        state.detail = null
        renderDetail()
      }
    }
  }

  function attach() {
    const panel = $('skillsPanel')
    if (!panel) return null
    bindControls()

    const bridge = global.megaThemeBridge
    if (bridge && typeof bridge.registerModule === 'function') {
      bridge.registerModule({
        id: 'skills',
        slots: SKILL_SLOTS,
        slotSelectors: SKILL_SLOT_SELECTORS,
        regionSelectors: SKILL_REGION_SELECTORS,
        onPaint: () => {},
        onChanged: () => {}
      })
    }

    if (!api()) {
      panel.dataset.unavailable = '1'
      setMessage('技能管理不可用：主进程未加载技能服务', 'error')
      return null
    }

    track((async () => {
      await loadSnapshot()
      // The tag list comes from the catalog, which is static, so one fetch is enough.
      try {
        const tags = await api().tags()
        if (tags && tags.ok) state.tagsSource = tags.tags || []
      } catch {
        state.tagsSource = []
      }
      await runSearch({ live: false })
    })())

    return {
      render,
      refresh: () => loadSnapshot().then(render),
      settled,
      state
    }
  }

  global.megaSkillsPanel = { attach, state, slots: SKILL_SLOTS }
})(window)
