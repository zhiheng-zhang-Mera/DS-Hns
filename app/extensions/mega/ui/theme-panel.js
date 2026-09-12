'use strict'

/**
 * Appearance panel — the HNS theme system's only user-facing surface.
 *
 * Design rules this file implements (engineering spec §1.1 / §13 / §23.1):
 *   - the user types natural language and nothing else;
 *   - no slot, token, manifest, capability or registry concept is ever shown;
 *   - the theme list shows locks for protected themes and nothing else internal;
 *   - a generated theme is only ever *previewed* first, with exactly two
 *     decisions available: "Looks Good" (approve -> install) and "Modify";
 *   - deleting a theme is one action.
 *
 * The panel talks to the engine exclusively through `window.megaTools.theme`,
 * which is a data-only bridge (see ui/preload.cjs).
 */
;(function attachThemePanel(global) {
  const $ = (id) => document.getElementById(id)

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function themeApi() {
    return global.megaTools && global.megaTools.theme ? global.megaTools.theme : null
  }

  /** Per-dock state. Deliberately small: the engine owns all theme truth. */
  const state = {
    status: null,
    capability: null,
    surfaces: null,
    draft: null,
    busy: false,
    message: null,
    error: null,
    detail: null,
    quickPrompts: []
  }

  /**
   * In-flight panel work, as a queue.
   *
   * A single "latest promise" is not enough: an action triggered while earlier
   * work is still running would silently replace it, and a caller awaiting a
   * settled panel could observe a half-applied state. Every tracked promise is
   * kept until it settles.
   */
  const inflight = new Set()

  function track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((error) => {
        setError(error)
      })
      .finally(() => {
        inflight.delete(tracked)
      })
    inflight.add(tracked)
    return tracked
  }

  /** Resolve once every piece of tracked panel work has settled. */
  async function settled() {
    // New work may be queued while awaiting (a chained action), so drain to empty.
    for (let guard = 0; guard < 25 && inflight.size; guard += 1) {
      await Promise.all([...inflight])
    }
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
    const node = $('themeMessage')
    if (!node) return
    if (state.error) {
      node.textContent = state.error
      node.className = 'theme-message error'
      return
    }
    if (state.message) {
      node.textContent = state.message.text
      node.className = `theme-message ${state.message.kind || ''}`.trim()
      return
    }
    node.textContent = ''
    node.className = 'theme-message'
  }

  function setBusy(busy) {
    state.busy = Boolean(busy)
    for (const id of ['themeCreate', 'themeApply', 'themeApprove', 'themeModify', 'themeDiscard', 'themeImport']) {
      const node = $(id)
      if (node) node.disabled = state.busy
    }
    const node = $('themeBusy')
    if (node) node.hidden = !state.busy
  }

  // -------------------------------------------------------------------------
  // Painting and geometry: delegated to the shared theme bridge.
  //
  // The bridge is the one integration point every dock UI module uses, so a new
  // panel (Skills) adapts to the active theme and becomes visible to theme
  // validation without this file changing. See ui/theme-bridge.js.
  // -------------------------------------------------------------------------

  /** Slot ids this panel renders; the bridge writes their styles for us. */
  const APPEARANCE_SLOTS = [
    'hns.window.shell',
    'hns.process.panel',
    'hns.worker.card',
    'hns.process.queue',
    'hns.status.badge',
    'common.button.primary',
    'common.button.secondary',
    'common.input.default',
    'common.dialog.default',
    'common.notification.default',
    'common.navigation.sidebar',
    'common.navigation.topbar',
    'common.panel.background',
    'hns.worker.header',
    'hns.operator.widget',
    'hns.persona.banner',
    'hns.persona.decoration',
    'hns.tray.icon'
  ]

  /** Panel-owned elements that theme validation must be able to see. */
  const APPEARANCE_SLOT_SELECTORS = {
    'hns.window.shell': '#detail',
    'hns.worker.card': '#summary',
    'hns.process.panel': '#queue',
    'hns.process.queue': '#queue',
    'hns.worker.header': '.dock-header',
    'hns.hardware.cpu': '#hardware',
    'hns.hardware.gpu': '#hardware',
    'hns.hardware.memory': '#hardware',
    'hns.hardware.power': '#hardware',
    'hns.log.panel': '#queue',
    'hns.status.badge': '#summary',
    'common.button.primary': '#taskForm button[type="submit"]',
    'common.button.secondary': '#clearPending',
    'common.input.default': '#prompt',
    'common.dialog.default': '#settingsOverlay',
    'common.notification.default': '#themeMessage',
    'common.navigation.sidebar': '#rail',
    'common.navigation.topbar': '.dock-header',
    'common.panel.background': '#detail',
    'hns.tray.icon': '#rail'
  }

  const APPEARANCE_REGION_SELECTORS = {
    'queue-create': '#taskForm',
    'queue-list': '#queue',
    'worker-summary': '#summary',
    'hardware-grid': '#hardware',
    'status-strip': '#summary',
    'settings-form': '#settingsOverlay'
  }

  /** The bridge handle for this panel; assigned during attach(). */
  let bridge = null

  function bridgeApi() {
    return global.megaThemeBridge || null
  }

  /** Apply a payload; kept as a thin delegate so callers stay unchanged. */
  function paint(payload) {
    const shared = bridgeApi()
    if (!shared) return false
    const applied = shared.paint(payload)
    updateActiveMarker(payload)
    return applied
  }

  /** The one Appearance-specific reaction to a payload: the active-theme marker. */
  function updateActiveMarker(payload) {
    const marker = $('themeActiveMarker')
    if (!marker || !payload) return
    marker.textContent = payload.preview
      ? `${esc(payload.name)} · 预览中`
      : esc(payload.name || payload.id || '')
  }

  function reportRegions() {
    const shared = bridgeApi()
    if (!shared) return null
    return shared.reportRegions()
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderThemes() {
    const node = $('themeList')
    if (!node) return
    const themes = state.status?.themes || []
    if (!themes.length) {
      node.innerHTML = '<div class="muted">主题列表不可用</div>'
      return
    }
    node.innerHTML = themes.map((theme) => {
      const lock = theme.protected ? '<span class="theme-lock" title="受保护的系统主题，不可删除">🔒</span>' : ''
      const active = theme.active ? ' active' : ''
      const broken = theme.broken ? ' broken' : ''
      const tags = []
      if (theme.source === 'generated') tags.push('生成')
      if (theme.source === 'duplicated') tags.push('副本')
      if (theme.source === 'imported') tags.push('导入')
      if (theme.source === 'builtin-demo') tags.push('Demo')
      if (theme.broken) tags.push('损坏')
      return `<div class="theme-item${active}${broken}" data-theme="${esc(theme.id)}">
        <button class="theme-apply" data-apply="${esc(theme.id)}" title="应用该主题">
          <span class="theme-name">${esc(theme.name)}${lock}</span>
          <span class="theme-meta">${esc(tags.join(' · ') || (theme.source === 'system' ? '系统' : theme.source))}${
            theme.persona?.enabled ? ` · 角色 ${esc(theme.persona.character || '')}` : ''
          }</span>
        </button>
        <div class="theme-actions">
          <button class="theme-icon" data-detail="${esc(theme.id)}" title="主题详情">i</button>
          <button class="theme-icon" data-duplicate="${esc(theme.id)}" title="创建副本">⧉</button>
          ${theme.source === 'builtin-demo' ? `<button class="theme-icon" data-restore="${esc(theme.id)}" title="恢复出厂">↺</button>` : ''}
          <button class="theme-icon danger" data-delete="${esc(theme.id)}" ${theme.protected || theme.source === 'system' ? 'disabled' : ''} title="${
            theme.protected || theme.source === 'system' ? '受保护，不可删除' : '删除主题'
          }">🗑</button>
        </div>
      </div>`
    }).join('')
  }

  function renderActive() {
    const status = state.status
    const node = $('themeActive')
    if (!node) return
    if (!status) {
      node.textContent = '—'
      return
    }
    const effect = status.effect || {}
    const degraded = status.degraded ? ` · 已降级(${esc(effect.label || '')})` : ''
    const previewing = status.previewing ? ' · 预览中' : ''
    node.textContent = `${status.activeName || status.active || '—'}${degraded}${previewing}`
  }

  function validationSummary(validation) {
    if (!validation) return ''
    const rows = (validation.checks || []).map((check) => {
      const kind = check.ok ? 'ok' : check.severity === 'warning' ? 'warn' : 'fail'
      const mark = check.ok ? '✓' : check.severity === 'warning' ? '!' : '✗'
      return `<li class="${kind}"><b>${mark}</b><span>${esc(check.label)}</span><em>${esc(check.detail || '')}</em></li>`
    }).join('')
    const header = validation.ok
      ? `<div class="preview-verdict ok">校验通过 · ${validation.passed}/${validation.total}</div>`
      : `<div class="preview-verdict fail">校验未通过 · ${validation.passed}/${validation.total}</div>`
    const warningCount = (validation.warnings || []).length
    const warnings = warningCount
      ? `<div class="preview-warnings">${warningCount} 项未能现场测量（不影响安装）</div>`
      : ''
    return `${header}${warnings}<ul class="preview-checks">${rows}</ul>`
  }

  function renderPreview() {
    const box = $('themePreview')
    if (!box) return
    const draft = state.draft
    box.hidden = !draft
    if (!draft) return
    const node = $('themePreviewBody')
    if (!node) return
    try {
      renderPreviewBody(node, draft)
    } catch (error) {
      // A rendering failure must not break the panel; the draft stays usable and
      // the user still gets the two decisions that matter.
      node.textContent = `${draft.name || draft.themeId || 'preview'} — 预览渲染降级`
      state.previewError = String(error && error.message || error)
      if (typeof global.__hnsThemeDebug === 'function') global.__hnsThemeDebug({ stage: 'preview-error', message: state.previewError })
      setError(error)
    }
  }

  function renderPreviewBody(node, draft) {
    const adjustments = (draft.contrastAdjustments || []).length
      ? `<div class="preview-note">为保证可读性，已自动调整 ${draft.contrastAdjustments.length} 处颜色。</div>`
      : ''
    const history = (draft.history || []).length
      ? `<div class="preview-history">修改记录：${draft.history.map((entry) => esc(entry.prompt)).join(' ｜ ')}</div>`
      : ''
    node.innerHTML = `
      <div class="preview-head">
        <div>
          <div class="preview-name">${esc(draft.name || draft.themeId || '新主题')}</div>
          <div class="preview-intent">${esc(draft.designSummary || '')}</div>
        </div>
        <div class="preview-badge">${esc(draft.engine || 'local')}</div>
      </div>
      ${validationSummary(draft.validation)}
      ${renderSurfaceSummary(draft.plans)}
      ${adjustments}
      ${history}`
    const approve = $('themeApprove')
    if (approve) approve.disabled = !(draft.validation && draft.validation.ok) || state.busy
  }

  /**
   * Per-surface preview summary (任务 13).
   *
   * The user sees four lines — HNS, official shell, official overlay, composite —
   * and nothing about slots, tokens or plans. A disabled overlay says so, because
   * a silently missing overlay is exactly what the safety validator exists to
   * prevent.
   */
  function renderSurfaceSummary(plans) {
    if (!plans || !Array.isArray(plans.surfaces)) return ''
    const rows = plans.surfaces.map((surface) => {
      const label = surface.surface === 'hns_native' ? 'HNS 界面'
        : surface.surface === 'official_shell' ? '官方外壳'
          : surface.surface === 'official_overlay' ? '官方覆盖层'
            : '官方渲染器'
      const state = surface.surface === 'official_renderer'
        ? '受保护 · 永不修改'
        : (surface.writes ? '已应用' : '保持默认')
      const mark = surface.surface === 'official_renderer' ? '·' : (surface.writes ? '✓' : '○')
      return `<li class="${surface.surface === 'official_renderer' ? 'warn' : (surface.writes ? 'ok' : '')}"><b>${mark}</b><span>${esc(label)}</span><em>${esc(state)}</em></li>`
    })
    if (plans.overlay) {
      const overlayLabel = plans.overlay.enabled
        ? `覆盖层开启 · 不透明度上限 ${esc(String(plans.overlay.safety?.checks?.find((check) => check.id === 'overlay_opacity')?.limit ?? 0.22))} · 人物占屏 ${esc((100 * (plans.overlay.characterCoverage || 0)).toFixed(1))}%`
        : `覆盖层已关闭${plans.overlay.reason ? `（${esc(plans.overlay.reason)}）` : ''}`
      rows.push(`<li class="${plans.overlay.enabled ? 'ok' : 'warn'}"><b>${plans.overlay.enabled ? '✓' : '!'}</b><span>官方覆盖层</span><em>${overlayLabel}</em></li>`)
    }
    if (plans.assets) {
      rows.push(`<li class="ok"><b>✓</b><span>视觉资产</span><em>${esc(String(plans.assets.count))} 项 · 人物 ${plans.assets.character?.enabled ? '已生成' : '未启用'}</em></li>`)
    }
    return `<ul class="preview-checks preview-surfaces">${rows.join('')}</ul>`
  }

  function renderDetail() {
    const box = $('themeDetail')
    if (!box) return
    const detail = state.detail
    box.hidden = !detail
    if (!detail) return
    const node = $('themeDetailBody')
    if (!node) return
    const manifest = detail.manifest || {}
    const persona = detail.persona || {}
    node.innerHTML = `
      <div class="detail-grid">
        <div><span>ID</span><b>${esc(manifest.id || '')}</b></div>
        <div><span>来源</span><b>${esc(manifest.source || '')}</b></div>
        <div><span>版本</span><b>${esc(manifest.version || '')}</b></div>
        <div><span>Theme API</span><b>${esc(manifest.theme_api_version || '')}</b></div>
        <div><span>受保护</span><b>${manifest.protected ? '是（不可删除）' : '否'}</b></div>
        <div><span>可编辑</span><b>${manifest.editable === false ? '否' : '是'}</b></div>
        <div><span>槽位</span><b>${esc(detail.slotCount ?? 0)}</b></div>
        <div><span>Token</span><b>${esc(Object.keys(detail.tokens || {}).length)}</b></div>
        <div><span>动效</span><b>${esc((detail.animation?.type || 'none') + ' @ ' + (detail.animation?.intensity ?? 0))}</b></div>
        <div><span>角色</span><b>${persona.enabled ? esc(`${persona.character || ''} @ ${persona.prominence}`) : '关闭'}</b></div>
        <div><span>派生自</span><b>${esc(manifest.derived_from || '—')}</b></div>
        <div><span>官方配色</span><b>${esc(manifest.official_palette || '—')}</b></div>
      </div>
      ${manifest.generated_prompt ? `<div class="detail-prompt">生成提示词：${esc(manifest.generated_prompt)}</div>` : ''}
      ${(manifest.revision_history || []).length ? `<div class="detail-history">修改历史 ${manifest.revision_history.length} 次</div>` : ''}`
  }

  function renderCapability() {
    const node = $('themeCapability')
    if (!node) return
    const capability = state.capability
    if (!capability) {
      node.textContent = ''
      return
    }
    const slots = Object.keys(capability.slots || {}).length
    const writable = Object.values(capability.slots || {}).filter((slot) => slot.permission !== 'STRUCTURAL').length
    const surfaces = Array.isArray(capability.themeable_surfaces) ? capability.themeable_surfaces : []
    const overlay = surfaces.find((surface) => surface.id === 'official_overlay')
    const shell = surfaces.find((surface) => surface.id === 'official_shell')
    const official = surfaces.find((surface) => surface.id === 'official_renderer')
    node.innerHTML = `<span>Theme API ${esc(capability.theme_api_version)}</span>
      <span>可主题化槽位 ${writable}/${slots}</span>
      <span>状态 ${esc((capability.states || []).length)} 种</span>
      <span>官方外壳 ${shell?.writable ? '可换肤' : '默认'}</span>
      <span>官方覆盖层 ${overlay?.writable ? '可显示' : '关闭'}</span>
      <span>官方渲染器 ${official?.protected ? '受保护' : '未知'}</span>`
  }

  function render() {
    renderActive()
    renderThemes()
    renderPreview()
    renderDetail()
    renderCapability()
    renderMessage()
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function loadStatus() {
    const api = themeApi()
    if (!api) return null
    const result = await api.snapshot()
    if (result && result.ok) {
      state.status = result.status
      state.quickPrompts = result.status?.quickPrompts || []
      renderQuickPrompts()
    }
    return result
  }

  async function loadCapability() {
    const api = themeApi()
    if (!api) return null
    const result = await api.capabilities()
    if (result && result.ok) {
      state.capability = result.capability
      renderCapability()
    }
    // The live surface state is separate from the manifest: the manifest says what
    // *may* be painted, this says what actually is.
    if (typeof api.surfaces === 'function') {
      try {
        const surfaces = await api.surfaces()
        if (surfaces && surfaces.ok) state.surfaces = surfaces
      } catch {
        state.surfaces = null
      }
    }
    return result
  }

  function renderQuickPrompts() {
    const node = $('themeQuick')
    if (!node) return
    node.innerHTML = state.quickPrompts
      .map((prompt) => `<button type="button" class="theme-quick" data-quick="${esc(prompt)}">${esc(prompt)}</button>`)
      .join('')
  }

  function setDraftFrom(result) {
    state.draft = {
      draftId: result.draftId,
      themeId: result.themeId,
      name: result.name,
      designSummary: result.designSummary,
      validation: result.validation,
      intent: result.intent,
      engine: result.engine,
      revision: result.revision || 0,
      contrastAdjustments: result.contrastAdjustments || [],
      // 任务 13: the per-surface preview and the plan summary the panel renders.
      plans: result.plans || null,
      preview: result.preview || null,
      scope: result.scope || null,
      preserved: result.preserved || [],
      history: result.history || state.draft?.history || []
    }
  }

  async function applyTheme(id) {
    const api = themeApi()
    if (!api) return
    setBusy(true)
    try {
      setError(null)
      const result = await api.apply(id)
      if (!result?.ok) {
        if (result?.recovered) {
          setMessage(`主题不可用，已自动回退 Dark：${result.reason || ''}`, 'warn')
        } else {
          setMessage(`应用失败：${result?.reason || '未知原因'}`, 'error')
        }
      } else {
        setMessage(`已应用：${result.status?.name || id}`, 'ok')
      }
      await loadStatus()
      render()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function createFromPrompt(prompt) {
    const api = themeApi()
    if (!api) return
    const text = String(prompt || '').trim()
    if (!text) {
      setMessage('请先描述你想要的效果', 'warn')
      return
    }
    setBusy(true)
    try {
      setError(null)
      const result = await api.create({ prompt: text })
      if (!result?.ok) {
        setMessage(`生成失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      setDraftFrom(result)
      state.detail = null
      await loadStatus()
      setMessage('预览已应用到右侧 Dock —— 请直接查看效果', 'ok')
      reportRegions()
    } catch (error) {
      setError(error)
    } finally {
      // The busy flag is cleared *before* the final render: `setBusy` owns the
      // action buttons' disabled state, and rendering first would let it overwrite
      // the preview's own "Looks Good is only available when validation passes".
      setBusy(false)
      render()
    }
  }

  async function reviseCurrent(prompt) {
    const api = themeApi()
    if (!api || !state.draft) return
    const text = String(prompt || '').trim()
    if (!text) {
      setMessage('请描述需要修改的地方', 'warn')
      return
    }
    setBusy(true)
    try {
      setError(null)
      const result = await api.revise({ draftId: state.draft.draftId, prompt: text })
      if (!result?.ok) {
        setMessage(`修改失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      const previous = state.draft
      setDraftFrom(result)
      state.draft.history = (previous.history || []).concat([{ prompt: text, changed: result.changed || [] }])
      await loadStatus()
      setMessage(
        result.changed && result.changed.length
          ? `已按你的意见调整：${result.changed.join('、')}`
          : '已重新生成预览，未识别到需要变更的维度',
        result.changed && result.changed.length ? 'ok' : 'warn'
      )
      reportRegions()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
      render()
    }
  }

  async function approveCurrent() {
    const api = themeApi()
    if (!api || !state.draft) return
    // Guard the action itself, not just the button: installation may only happen
    // for a preview that passed validation (engineering spec §10.1).
    if (!state.draft.validation || !state.draft.validation.ok) {
      setMessage('预览未通过校验，无法安装', 'warn')
      return
    }
    setBusy(true)
    try {
      setError(null)
      const result = await api.approve({ draftId: state.draft.draftId })
      if (!result?.ok) {
        setMessage(`安装失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      state.draft = null
      await loadStatus()
      render()
      setMessage(`已安装并启用：${result.name || result.id}`, 'ok')
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function discardCurrent() {
    const api = themeApi()
    if (!api || !state.draft) return
    setBusy(true)
    try {
      setError(null)
      await api.discard({ draftId: state.draft.draftId })
      state.draft = null
      await loadStatus()
      render()
      setMessage('已放弃本次预览，未安装任何内容', '')
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function deleteTheme(id) {
    const api = themeApi()
    if (!api) return
    const record = (state.status?.themes || []).find((theme) => theme.id === id)
    if (record && (record.protected || record.source === 'system')) {
      setMessage('Dark 和 Light 是受保护的系统主题，无法删除', 'warn')
      return
    }
    if (typeof global.confirm === 'function' && !global.confirm(`删除主题「${record?.name || id}」？该操作只影响这个主题本身。`)) return
    setBusy(true)
    try {
      setError(null)
      const result = await api.remove(id)
      if (!result?.ok) {
        setMessage(`删除失败：${result?.message || result?.reason || '未知原因'}`, 'error')
      } else {
        setMessage(
          result.switchedTo ? `已删除，当前主题已切换到 Dark` : `已删除：${record?.name || id}`,
          'ok'
        )
      }
      await loadStatus()
      render()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function duplicateTheme(id) {
    const api = themeApi()
    if (!api) return
    setBusy(true)
    try {
      setError(null)
      const result = await api.duplicate(id, null)
      if (!result?.ok) {
        setMessage(`创建副本失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      await loadStatus()
      render()
      setMessage(`已创建自包含副本：${result.id}`, 'ok')
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function restoreTheme(id) {
    const api = themeApi()
    if (!api) return
    setBusy(true)
    try {
      setError(null)
      const result = await api.restore(id)
      if (!result?.ok) {
        setMessage(`恢复失败：${result?.message || result?.reason || '未知原因'}`, 'error')
        return
      }
      await loadStatus()
      render()
      setMessage('已恢复出厂内置 Demo 主题', 'ok')
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function importTheme() {
    const api = themeApi()
    if (!api) return
    setBusy(true)
    try {
      setError(null)
      const result = await api.importPackage()
      if (!result?.ok) {
        if (result?.reason !== 'cancelled') setMessage(`导入失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      await loadStatus()
      render()
      setMessage(`已导入自包含主题包：${result.id}`, 'ok')
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  async function showDetail(id) {
    const api = themeApi()
    if (!api) return
    try {
      setError(null)
      const result = await api.detail(id)
      if (!result?.ok) {
        setMessage(`读取详情失败：${result?.reason || '未知原因'}`, 'error')
        return
      }
      state.detail = result
      renderDetail()
      reportRegions()
    } catch (error) {
      setError(error)
    }
  }

  async function observeNow() {
    const api = themeApi()
    if (!api) return null
    try {
      reportRegions()
      const result = await api.observe(null)
      return result
    } catch (error) {
      setError(error)
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function bindControls() {
    const createButton = $('themeCreate')
    if (createButton) createButton.onclick = () => track(createFromPrompt($('themePrompt').value))
    const prompt = $('themePrompt')
    if (prompt) {
      prompt.onkeydown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          track(createFromPrompt(prompt.value))
        }
      }
    }

    const modifyButton = $('themeModify')
    if (modifyButton) {
      modifyButton.onclick = () => {
        const box = $('themeModifyBox')
        if (!box) return
        box.hidden = !box.hidden
        const input = $('themeModifyPrompt')
        if (input && !box.hidden && typeof input.focus === 'function') input.focus()
      }
    }

    const modifySend = $('themeModifySend')
    if (modifySend) modifySend.onclick = () => track(reviseCurrent($('themeModifyPrompt').value))

    const approveButton = $('themeApprove')
    if (approveButton) approveButton.onclick = () => track(approveCurrent())

    const discardButton = $('themeDiscard')
    if (discardButton) discardButton.onclick = () => track(discardCurrent())

    const importButton = $('themeImport')
    if (importButton) importButton.onclick = () => track(importTheme())

    const observeButton = $('themeObserve')
    if (observeButton) {
      observeButton.onclick = async () => {
        setBusy(true)
        const result = await observeNow()
        setBusy(false)
        if (result && result.ok) {
          const visual = result.snapshot && result.snapshot.visual
          setMessage(visual
            ? `已观察 ${result.snapshot.page_names.length} 个页面并采集界面快照`
            : '已采集界面结构（视觉快照不可用，不影响生成）', 'ok')
        }
      }
    }

    const list = $('themeList')
    if (list) {
      list.addEventListener('click', (event) => {
        const target = event.target?.closest?.('button')
        if (!target) return
        const apply = target.dataset.apply
        const detail = target.dataset.detail
        const duplicate = target.dataset.duplicate
        const remove = target.dataset.delete
        const restore = target.dataset.restore
        if (apply) track(applyTheme(apply))
        else if (detail) track(showDetail(detail))
        else if (duplicate) track(duplicateTheme(duplicate))
        else if (remove) track(deleteTheme(remove))
        else if (restore) track(restoreTheme(restore))
      })
    }

    const quick = $('themeQuick')
    if (quick) {
      quick.addEventListener('click', (event) => {
        const prompt = event.target?.dataset?.quick
        if (!prompt) return
        const input = $('themePrompt')
        if (input) input.value = prompt
        track(createFromPrompt(prompt))
      })
    }

    // Geometry reporting: on layout changes only, so the observation stays fresh
    // without polling.
    if (typeof global.ResizeObserver === 'function') {
      try {
        const observer = new global.ResizeObserver(() => reportRegions())
        const detail = $('detail')
        if (detail) observer.observe(detail)
      } catch {
        // ResizeObserver support is best-effort.
      }
    }
    if (typeof global.addEventListener === 'function') global.addEventListener('resize', reportRegions)
  }

  function attach() {
    const panel = $('appearancePanel')
    if (!panel) return null
    bindControls()

    const shared = bridgeApi()
    if (shared && typeof shared.registerModule === 'function') {
      // Joining the bridge is what makes this panel both a theme consumer and a
      // theme *target*: the bridge paints us and reports our geometry to the
      // engine, and it does the same for the Skills panel.
      bridge = shared.registerModule({
        id: 'appearance',
        slots: APPEARANCE_SLOTS,
        slotSelectors: APPEARANCE_SLOT_SELECTORS,
        regionSelectors: APPEARANCE_REGION_SELECTORS,
        onPaint: (payload) => {
          // The dock chrome is restyled entirely through the slot CSS variables the
          // bridge writes; the marker is this panel's only own reaction.
          updateActiveMarker(payload)
        },
        onChanged: () => {
          loadStatus().then(render).catch(() => {})
        }
      })
    }

    const api = themeApi()
    if (!api) {
      panel.dataset.unavailable = '1'
      setMessage('主题系统不可用：主进程未加载主题引擎', 'error')
      return null
    }

    // First paint: ask the engine for the active theme and apply it before the
    // dock reports geometry, so the observer sees the themed layout. When the
    // bridge is present it owns the subscription, and this is only the initial
    // fetch.
    track(
      Promise.resolve()
        .then(() => (bridge ? bridge.refresh() : api.paint().then((result) => {
          if (result && result.ok && result.payload) paint(result.payload)
          return result
        })))
        .catch(() => {})
        .then(() => Promise.all([loadStatus(), loadCapability()]))
        .then(() => {
          render()
          reportRegions()
        })
    )

    return {
      paint,
      reportRegions,
      render,
      refresh: () => loadStatus().then(render),
      /** Resolves once the panel's current work (first paint, create, approve…) is done. */
      settled
    }
  }

  global.megaThemePanel = { attach, paint, reportRegions, state }
})(window)
