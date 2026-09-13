'use strict'

/**
 * DS-Hns plugin panel (sections 45 and 46 of the acceleration plan).
 *
 * The dock is a *control surface*, never an executor and never an installer. It reads
 * the plugin set, the capability vocabulary and the execution settings, and it asks the
 * shell to enable, disable, restart or reconfigure a plugin **by id**. It never receives
 * a plugin object, never names a capability to provide and never touches a file — so a
 * settings panel cannot become a way to run code the user did not ship.
 *
 * Two things follow from that, and they show up in the code:
 *
 *  * the panel renders what the host *reports* — the four states (installed / enabled /
 *    loaded / healthy) are four separate facts and are drawn as such, because "off" and
 *    "broken" are different answers and a single checkbox would blur them;
 *  * every action is fire-and-refresh: the host rebuilds its world when a setting
 *    changes, so the panel re-reads the execution block afterwards rather than assuming
 *    the new value took effect.
 *
 * It is deliberately one file with no dependencies, matching the other panels: a failure
 * here can never stop the queue, theme or hardware modules from rendering.
 */
;(function attachPluginPanel() {
  function $(id) {
    return document.getElementById(id)
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  /**
   * A bilingual heading, through the shared component.
   *
   * The panel does not style its own titles: the two sizes and the one colour come from
   * `.bi-title`, so a panel cannot drift into its own typography. The fallback keeps this
   * file usable in a harness that loads only the panel.
   */
  function bilingualTag(tag, cn, en) {
    const bilingual = window.hnsBilingual
    if (bilingual && typeof bilingual.title === 'function') return bilingual.title(cn, en, { tag })
    return el(tag, 'bi-title', `${cn} · ${en}`)
  }

  /** The group's two names, from its stable English id. */
  function bilingualGroup(name) {
    const bilingual = window.hnsBilingual
    if (bilingual && typeof bilingual.group === 'function') return bilingual.group(name)
    return { cn: String(name || ''), en: String(name || '') }
  }

  const STATE_CLASS = {
    healthy: 'ok',
    loaded: 'neutral',
    enabled: 'neutral',
    disabled: 'muted',
    unhealthy: 'bad',
    error: 'bad',
    'not-installed': 'bad'
  }

  function attach() {
    const root = $('pluginsPanel')
    if (!root) return null
    const groupsBox = $('plugGroups')
    const executionBox = $('plugExecution')
    const detailBox = $('plugDetail')
    const lockBox = $('plugLock')
    const stateChip = $('plugState')
    const message = $('plugMessage')
    const buttons = { refresh: $('plugRefresh'), health: $('plugHealth') }

    let selected = null
    let settings = {}

    function say(text, kind) {
      if (!message) return
      message.textContent = text || ''
      message.className = kind ? `theme-message ${kind}` : 'theme-message'
    }

    function bridge() {
      const api = window.megaPlugins
      if (!api) {
        say('Plugin bridge 不可用（preload 未加载）。', 'bad')
        return null
      }
      return api
    }

    function chip(text, kind) {
      if (!stateChip) return
      stateChip.textContent = text
      stateChip.className = `status-chip ${kind || 'neutral'}`
    }

    /** The four states, drawn separately because they are four separate facts. */
    function stateOf(plugin) {
      if (!plugin.installed) return { label: 'not installed', kind: 'bad' }
      if (!plugin.enabled) return { label: 'disabled', kind: 'muted' }
      if (!plugin.loaded) return { label: 'enabled', kind: 'neutral' }
      if (plugin.healthy === false) return { label: 'unhealthy', kind: 'bad' }
      if (plugin.healthy === true) return { label: 'healthy', kind: 'ok' }
      return { label: 'loaded', kind: 'neutral' }
    }

    function renderLock(lock) {
      if (!lockBox) return
      lockBox.textContent = ''
      if (!lock) return
      const state = lock.state || null
      const line = el('p', 'plug-line')
      line.appendChild(el('strong', null, 'Lockfile'))
      line.appendChild(el('span', 'plug-dim', ` ${lock.file || ''}`))
      lockBox.appendChild(line)
      if (!state) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', '尚未校验。'))
      } else if (state.ok && state.locked === false) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', state.reason || '没有锁文件，以当前安装集合为准。'))
      } else if (state.ok) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', `已锁定 ${state.plugins} 个插件，与当前安装集合一致。`))
      } else {
        lockBox.appendChild(el('p', 'plug-line bad', state.reason || '锁文件与安装集合不一致。'))
        for (const [kind, entries] of [['changed', state.changed], ['removed', state.removed], ['added', state.added]]) {
          for (const entry of Array.isArray(entries) ? entries : []) {
            lockBox.appendChild(el('p', 'plug-line plug-dim', `${kind}: ${entry.id}${entry.expected !== undefined ? ` (${entry.expected}${entry.found !== undefined ? ` -> ${entry.found}` : ''})` : ''}`))
          }
        }
      }
    }

    function renderGroups(listed) {
      if (!groupsBox) return
      groupsBox.textContent = ''
      const groups = Array.isArray(listed.groups) ? listed.groups : []
      if (!groups.length) {
        groupsBox.appendChild(el('p', 'plug-empty', listed.ok === false ? (listed.error || '插件运行时不可用') : '还没有加载任何插件。'))
        return
      }
      for (const group of groups) {
        const section = el('div', 'plug-group')
        const names = bilingualGroup(group.name)
        section.appendChild(bilingualTag('h3', names.cn, names.en))
        for (const plugin of group.plugins) {
          const state = stateOf(plugin)
          const row = el('button', `plug-row ${selected === plugin.id ? 'active' : ''}`)
          row.type = 'button'
          row.dataset.pluginId = plugin.id
          row.appendChild(el('span', `plug-mark ${state.kind}`, plugin.enabled ? '✓' : '—'))
          row.appendChild(el('span', 'plug-name', plugin.name || plugin.id))
          row.appendChild(el('span', 'plug-fault', plugin.faultLevel || ''))
          row.appendChild(el('span', `plug-state ${state.kind}`, state.label))
          row.addEventListener('click', () => select(plugin.id))
          section.appendChild(row)
        }
        groupsBox.appendChild(section)
      }
    }

    /** Section 45: the execution block, with the layer every value came from. */
    function renderExecution(block) {
      if (!executionBox) return
      executionBox.textContent = ''
      if (!block || block.ok === false) return
      executionBox.appendChild(bilingualTag('h3', '执行设置', 'Execution'))
      const rows = el('div', 'plug-settings')
      for (const [key, field] of Object.entries(block.fields || {})) {
        settings[key] = field.value
        const row = el('label', 'plug-setting')
        row.appendChild(el('span', 'plug-setting-label', field.label || key))
        let input
        if (Array.isArray(field.enumValues) || ['mode', 'parallelWrites', 'workspaceIsolation'].includes(key)) {
          input = el('select', 'plug-input')
          const options = key === 'mode' ? block.modes : key === 'parallelWrites' ? ['auto', 'never', 'isolated'] : ['auto', 'off']
          for (const value of options || []) {
            const option = el('option', null, value)
            option.value = value
            if (String(field.value) === String(value)) option.selected = true
            input.appendChild(option)
          }
        } else if (typeof field.value === 'boolean') {
          input = el('input', 'plug-input')
          input.type = 'checkbox'
          input.checked = field.value === true
        } else {
          input = el('input', 'plug-input')
          input.type = 'number'
          input.min = String(field.min || 1)
          input.max = String(field.max || 100)
          input.value = String(field.value)
        }
        input.dataset.settingKey = key
        row.appendChild(input)
        row.appendChild(el('span', 'plug-dim', `${field.source}${field.valid === false ? ' (invalid)' : ''}`))
        rows.appendChild(row)
      }
      executionBox.appendChild(rows)
      const actions = el('div', 'cu-actions')
      const save = el('button', null, '应用')
      save.type = 'button'
      save.addEventListener('click', () => applySettings())
      actions.appendChild(save)
      const policy = block.modePolicy
      if (policy) {
        actions.appendChild(el('span', 'plug-dim', `${policy.label}: reads ${policy.readsParallel ? 'on' : 'off'} · writes ${policy.overlappingWrites} · isolation ${policy.isolationRequired ? 'required' : 'optional'}`))
      }
      executionBox.appendChild(actions)
      const decision = block.workerDecision
      if (decision) {
        executionBox.appendChild(el('p', 'plug-line plug-dim', `workers: ${decision.workers} (bound: ${decision.bound} — ${decision.reason})`))
      }
    }

    function renderDetail(detail) {
      if (!detailBox) return
      detailBox.textContent = ''
      if (!detail) {
        detailBox.appendChild(el('p', 'plug-empty', '选择左侧任意插件查看版本、状态、健康、能力、依赖、配置与延迟。'))
        return
      }
      if (detail.ok === false) {
        detailBox.appendChild(el('p', 'plug-line bad', detail.error || '无法读取该插件'))
        return
      }
      const head = el('div', 'plug-detail-head')
      // The plugin's own name comes from its manifest in English; the group's two names
      // come from the shared dictionary, so the heading carries both languages.
      const groupNames = bilingualGroup(detail.group)
      head.appendChild(bilingualTag('h3', detail.name || detail.id, `${groupNames.en} · ${detail.id}`))
      head.appendChild(el('span', 'plug-dim', `${detail.version || ''} · ${detail.apiVersion || ''} · ${detail.faultLevel || ''}`))
      detailBox.appendChild(head)

      const facts = el('div', 'plug-facts')
      const add = (label, value, kind) => {
        const line = el('p', `plug-line ${kind || ''}`)
        line.appendChild(el('span', 'plug-fact-label', `${label}: `))
        line.appendChild(el('span', null, value === undefined || value === null || value === '' ? '—' : String(value)))
        facts.appendChild(line)
      }
      const state = stateOf({ installed: detail.installed, enabled: detail.enabled, loaded: detail.loaded, healthy: detail.healthy })
      add('Status', `${state.label} (installed=${detail.installed} enabled=${detail.enabled} loaded=${detail.loaded})`)
      add('Health', detail.health ? `${detail.health.status}${detail.health.reason ? ` — ${detail.health.reason}` : ''}` : 'not probed', detail.healthy === false ? 'bad' : '')
      add('Latency', detail.latencyMs === null || detail.latencyMs === undefined ? '—' : `${detail.latencyMs}ms`)
      add('Restarts', detail.restartCount)
      add('Capabilities', (detail.capabilities || []).join(', '))
      add('Requires', (detail.requires || []).join(', ') || '—')
      add('Optional', (detail.optional || []).join(', ') || '—')
      const missing = detail.dependencies && Array.isArray(detail.dependencies.missing) ? detail.dependencies.missing : []
      add('Missing', missing.join(', ') || '—', missing.length ? 'bad' : '')
      add('Subscriptions', detail.subscriptions)
      detailBox.appendChild(facts)

      const configLine = el('p', 'plug-line plug-dim', `Config: ${detail.configFile || ''}`)
      detailBox.appendChild(configLine)
      const resolved = detail.config || {}
      for (const [key, value] of Object.entries(resolved)) {
        detailBox.appendChild(el('p', 'plug-line plug-dim', `${key} = ${JSON.stringify(value)} (${(detail.sources || {})[key] || 'unknown'})`))
      }
      for (const fault of Array.isArray(detail.faults) ? detail.faults : []) {
        detailBox.appendChild(el('p', 'plug-line bad', `${fault.phase || 'fault'}: ${fault.reason || ''}`))
      }
      if (detail.error) detailBox.appendChild(el('p', 'plug-line bad', detail.error))

      const actions = el('div', 'cu-actions')
      const toggle = el('button', 'quiet', detail.enabled ? 'Disable' : 'Enable')
      toggle.type = 'button'
      toggle.addEventListener('click', () => togglePlugin(detail.id, !detail.enabled))
      actions.appendChild(toggle)
      const restart = el('button', 'quiet', 'Restart')
      restart.type = 'button'
      restart.addEventListener('click', () => reloadPlugin(detail.id))
      actions.appendChild(restart)
      const probe = el('button', 'quiet', 'Health')
      probe.type = 'button'
      probe.addEventListener('click', () => probeHealth(detail.id))
      actions.appendChild(probe)
      const lock = el('button', 'quiet', 'Write lock')
      lock.type = 'button'
      lock.addEventListener('click', () => writeLock())
      actions.appendChild(lock)
      detailBox.appendChild(actions)
    }

    function collectSettings() {
      const patch = {}
      for (const input of root.querySelectorAll('[data-setting-key]')) {
        const key = input.dataset.settingKey
        if (input.type === 'checkbox') patch[key] = input.checked === true
        else if (input.type === 'number') patch[key] = Number(input.value)
        else patch[key] = input.value
      }
      return patch
    }

    async function applySettings() {
      const api = bridge()
      if (!api) return
      const patch = collectSettings()
      say('正在应用设置…')
      try {
        const result = await api.configure(patch)
        if (!result || result.ok === false) {
          say((result && result.error) || '设置未能应用', 'bad')
          return
        }
        say(`已应用：${Object.entries(result.changed || {}).map(([key, value]) => `${key}=${value}`).join(', ') || '无变化'}；插件已按新配置重建。`, 'ok')
        await refresh()
      } catch (error) {
        say(`应用失败：${error.message}`, 'bad')
      }
    }

    async function select(id) {
      selected = id
      const api = bridge()
      if (!api) return
      try {
        renderDetail(await api.describe({ id }))
      } catch (error) {
        say(`读取插件失败：${error.message}`, 'bad')
      }
    }

    async function togglePlugin(id, enabled) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.enable({ id, enabled })
        if (!result || result.ok === false) {
          say((result && result.error) || '操作失败', 'bad')
          return
        }
        say(`${id} 已${enabled ? '启用' : '停用'}；依赖它的插件会退到 fallback。`, 'ok')
        await refresh()
        await select(id)
      } catch (error) {
        say(`操作失败：${error.message}`, 'bad')
      }
    }

    async function reloadPlugin(id) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.reload({ id })
        say(result && result.ok ? `${id} 已重启（第 ${result.restartCount} 次）。` : `${id} 重启失败：${(result && result.reason) || ''}`, result && result.ok ? 'ok' : 'bad')
        await refresh()
        await select(id)
      } catch (error) {
        say(`重启失败：${error.message}`, 'bad')
      }
    }

    async function probeHealth(id) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.health(id ? { id } : {})
        const health = result && result.health
        const status = health && health.status ? health.status : 'unknown'
        say(`体检结果：${status}${health && health.reason ? ` — ${health.reason}` : ''}`, status === 'healthy' ? 'ok' : 'bad')
        await refresh()
      } catch (error) {
        say(`体检失败：${error.message}`, 'bad')
      }
    }

    async function writeLock() {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.lock({ write: true })
        say(result && result.ok ? `已写入 ${result.file}（${result.plugins} 个插件）。` : `写入失败：${(result && result.error) || (result && result.reason) || ''}`, result && result.ok ? 'ok' : 'bad')
        await refresh()
      } catch (error) {
        say(`写入失败：${error.message}`, 'bad')
      }
    }

    async function refresh() {
      const api = bridge()
      if (!api) return
      try {
        const status = await api.status()
        if (status && status.ok === false && status.built !== true) {
          chip(status.code === 'PLUGIN_RUNTIME_DISABLED' ? 'DISABLED' : 'UNAVAILABLE', 'bad')
          say(status.error || '', 'bad')
          renderGroups({ ok: false, error: status.error, groups: [] })
          return
        }
        const listed = await api.list()
        renderGroups(listed)
        const block = await api.execution()
        renderExecution(block)
        renderLock(await api.lock({}))
        const state = listed.plugins.reduce((totals, plugin) => {
          totals.loaded += plugin.loaded ? 1 : 0
          totals.unhealthy += plugin.healthy === false ? 1 : 0
          totals.disabled += plugin.installed && !plugin.enabled ? 1 : 0
          return totals
        }, { loaded: 0, unhealthy: 0, disabled: 0 })
        chip(`${state.loaded} loaded${state.unhealthy ? ` · ${state.unhealthy} unhealthy` : ''}${state.disabled ? ` · ${state.disabled} off` : ''}`, state.unhealthy ? 'bad' : 'ok')
        if (selected) await select(selected)
        else renderDetail(null)
      } catch (error) {
        say(`读取插件列表失败：${error.message}`, 'bad')
      }
    }

    // The world is rebuilt in place when the store enables, disables or removes an installed
    // plugin, so the panel follows the runtime instead of waiting for the next time it opens.
    window.megaPlugins?.onChanged?.((payload) => {
      const mounted = ((payload && payload.mounted) || []).join('、')
      const removed = ((payload && payload.removed) || []).join('、')
      if (mounted) say(`已即时挂载：${mounted}（无需重启）/ mounted live — no restart needed`, 'ok')
      if (removed) say(`已停用或卸载：${removed} / no longer running`, 'ok')
      refresh()
    })
    // The refresh button re-reads the world *and* asks the shell to re-read the installed set
    // from disk, so a plugin copied into `data/plugins/store` by hand is picked up too. The
    // rescan is what makes the button mean "look again", not "redraw what you have".
    if (buttons.refresh) {
      buttons.refresh.addEventListener('click', async () => {
        const result = await window.megaPlugins?.refresh?.()
        if (result && result.ok === false) say(`重新扫描失败 / rescan failed: ${result.error || ''}`, 'bad')
        else if (result && result.rebuilt) say(`已重新扫描并重建插件世界 / rescanned and rebuilt the plugin world`, 'ok')
        refresh()
      })
    }
    if (buttons.health) buttons.health.addEventListener('click', () => probeHealth(null))
    renderDetail(null)
    const handle = { refresh, select, applySettings, stop: () => {} }
    // The store tab lives in another module and must be able to move this list when it
    // enables or removes a plugin, so the attached instance is reachable by name.
    live = handle
    return handle
  }

  /** The attached panel, if any: what `window.megaPluginPanel.refresh()` forwards to. */
  let live = null

  window.megaPluginPanel = { attach, refresh: () => (live ? live.refresh() : null) }
})()
