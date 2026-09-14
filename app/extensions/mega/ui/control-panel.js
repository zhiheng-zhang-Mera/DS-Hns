'use strict'

/**
 * The MEGA Control Center panel (`updateplan/startup2.md` §45-§47).
 *
 * The expanded dock is where the enhancement layer is managed: what is running, what it costs, what is
 * degraded, and what can be done about it. This module renders the sections the shell builds and wires the
 * actions — retry, check, repair, disable/enable, and "let the fallback stand" — and nothing else: it holds
 * no state of its own, so the panel cannot disagree with the layer it is showing.
 *
 * Two properties the plan asks for, in the shape of the code:
 *
 *   * **the actions live here, not scattered through Core settings** (§47). A degraded module's row offers
 *     exactly the actions its state allows, and every one of them is a channel the shell answers;
 *   * **a failure to render is a line of text, not a broken dock.** A section with no data, a module with no
 *     fallback and an action the shell refuses all end up as a message in the panel.
 */
;(function attachControlPanel() {
  let last = null
  let message = null

  function $(id) {
    return document.getElementById(id)
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"]/g, (character) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]
    ))
  }

  function api() {
    return window.megaTools && window.megaTools.control ? window.megaTools.control : null
  }

  function toneClass(tone) {
    return tone ? ` tone-${esc(tone)}` : ''
  }

  /** One row: the two labels the plan writes side by side, and its value. */
  function rowHtml(row) {
    return `<div class="cc-row">
      <span class="cc-label">${esc(row.cn)}<small>${esc(row.en)}</small></span>
      <b class="cc-value${toneClass(row.tone)}">${esc(row.value)}</b>
    </div>`
  }

  /** A protection module: what it is, and the actions its state allows (§46, §47). */
  function moduleHtml(module) {
    const actions = (module.actions || []).map((action) => (
      `<button type="button" data-control-action="${esc(action)}" data-control-id="${esc(module.id)}">${esc(action)}</button>`
    )).join('')
    const detail = [
      module.version ? `v${esc(module.version)}` : null,
      module.startMs === null || module.startMs === undefined ? null : `${esc(module.startMs)}ms`,
      module.retries ? `retries ${esc(module.retries)}` : null,
      module.fallback && module.fallback !== 'idle' ? `fallback ${esc(module.fallback)}` : null,
      module.lastError ? esc(module.lastError) : null
    ].filter(Boolean).join(' · ')
    return `<div class="cc-module" data-module="${esc(module.id)}">
      <div class="cc-module-head">
        <span class="cc-label">${esc(module.id)}</span>
        <b class="cc-value${toneClass(module.tone)}">${esc(module.state)}</b>
      </div>
      ${detail ? `<p class="cc-detail">${detail}</p>` : ''}
      ${actions ? `<div class="cc-actions">${actions}</div>` : ''}
    </div>`
  }

  function pluginHtml(plugin) {
    const actions = (plugin.actions || []).map((action) => (
      `<button type="button" data-control-action="${esc(action)}" data-control-id="${esc(plugin.id)}">${esc(action)}</button>`
    )).join('')
    const detail = [
      plugin.expected ? `bundled ${esc(plugin.expected)}` : null,
      plugin.installedVersion ? `installed ${esc(plugin.installedVersion)}` : null,
      plugin.reason ? esc(plugin.reason) : null
    ].filter(Boolean).join(' · ')
    return `<div class="cc-module" data-plugin="${esc(plugin.id)}">
      <div class="cc-module-head">
        <span class="cc-label">${esc(plugin.id)}</span>
        <b class="cc-value${toneClass(plugin.tone)}">${esc(plugin.state)}</b>
      </div>
      ${detail ? `<p class="cc-detail">${detail}</p>` : ''}
      ${actions ? `<div class="cc-actions">${actions}</div>` : ''}
    </div>`
  }

  function render(next) {
    if (next) last = next
    const sections = $('controlSections')
    const moduleList = $('controlModules')
    const pluginList = $('controlPlugins')
    if (sections) {
      sections.innerHTML = (last?.sections || []).map((section) => `<div class="cc-section" data-section="${esc(section.id)}">
        <h3>${esc(section.cn)}<small>${esc(section.en)}</small></h3>
        ${(section.rows || []).map(rowHtml).join('')}
      </div>`).join('')
    }
    if (moduleList) {
      moduleList.innerHTML = (last?.modules || []).map(moduleHtml).join('')
        || '<p class="cc-empty">没有注册受保护模块 · no protected modules registered</p>'
    }
    if (pluginList) {
      pluginList.innerHTML = (last?.plugins || []).map(pluginHtml).join('')
        || '<p class="cc-empty">没有随本体提供的插件 · no bundled plugins</p>'
    }
    const summary = $('controlSummary')
    if (summary) {
      const degraded = last?.degraded ?? 0
      const failed = last?.failed ?? 0
      summary.textContent = degraded || failed
        ? `${degraded} 降级 · ${failed} 失败 · degraded / failed`
        : '全部健康 · everything healthy'
      summary.className = `status-chip ${failed ? 'bad' : degraded ? 'warn' : 'ok'}`
    }
    const note = $('controlMessage')
    if (note && message) note.textContent = message
    return last
  }

  async function refresh() {
    const bridge = api()
    if (!bridge || typeof bridge.describe !== 'function') return render({ sections: [], modules: [], plugins: [] })
    try {
      const described = await bridge.describe()
      return described && described.ok !== false ? render(described) : render(null)
    } catch (error) {
      message = `控制中心暂时不可用 · the Control Center is unavailable (${error?.message || error})`
      return render(null)
    }
  }

  /** One delegated listener: a rendered button's own data says what it does. */
  function bindActions() {
    const panel = $('controlPanel')
    if (!panel || typeof panel.addEventListener !== 'function') return false
    panel.addEventListener('click', (event) => {
      const target = event.target
      if (!target || typeof target.getAttribute !== 'function') return
      const action = target.getAttribute('data-control-action')
      const id = target.getAttribute('data-control-id')
      if (!action || !id) return
      const bridge = api()
      if (!bridge || typeof bridge.action !== 'function') {
        message = '这个界面没有连接到 shell · this panel is not connected to the shell'
        render(null)
        return
      }
      message = `${action} ${id} …`
      render(null)
      Promise.resolve(bridge.action({ action, id })).then((result) => {
        message = result && result.ok === false
          ? `${action} ${id}: ${result.reason || '被拒绝 · refused'}`
          : `${action} ${id}: 完成 · done`
        return refresh()
      }).catch((error) => {
        message = `${action} ${id}: ${error?.message || error}`
        return refresh()
      })
    })
    return true
  }

  function attach() {
    const panel = $('controlPanel')
    if (!panel) return null
    bindActions()
    refresh()
    return { render, refresh, state: () => last }
  }

  window.megaControlPanel = { attach, render, refresh }
})()
