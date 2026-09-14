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

  /**
   * One line carrying both languages, for everything that is not a heading.
   *
   * The product is bilingual throughout, and this panel used to be the exception: its fact labels,
   * its buttons and its state words were English-only, so a reader who works in Chinese met a wall
   * of `Status` / `Requires` / `Capabilities` exactly where the module explains itself. Chinese
   * first, English second, one separator — the same rule the headings already follow, and the same
   * rule `hnsBilingual.label` gives the OS-level titles.
   *
   * The English is kept short where the line is a column rather than a sentence (see `STATE_TEXT`):
   * a translation that pushes a row wider is a translation that made the panel worse.
   */
  function bi(cn, en, separator = ' · ') {
    const bilingual = window.hnsBilingual
    if (bilingual && typeof bilingual.label === 'function') return bilingual.label(cn, en, separator)
    return en ? `${cn}${separator}${en}` : String(cn || '')
  }

  /**
   * The state words, in both languages and short enough for the column they are drawn in.
   *
   * The panel is a control surface, and these are what the user scans down: "off" and "broken" are
   * different answers, so the Chinese is the word a reader recognises and the English is the word
   * the host reports.
   */
  const STATE_TEXT = Object.freeze({
    healthy: { cn: '正常', en: 'ok' },
    loaded: { cn: '已载入', en: 'loaded' },
    enabled: { cn: '已启用', en: 'on' },
    disabled: { cn: '已停用', en: 'off' },
    unhealthy: { cn: '异常', en: 'bad' },
    'not-installed': { cn: '未安装', en: 'none' }
  })

  /**
   * The execution settings, keyed by the host's own field ids.
   *
   * The host labels these fields in English (`Max workers`, `Parallel writes`); the panel pairs
   * each with its Chinese name. An unknown key falls back to whatever the host called it, because
   * a field this panel has never heard of is still a field the user has to be able to read.
   */
  const EXECUTION_LABELS = Object.freeze({
    parallelTaskExecution: { cn: '并行任务', en: 'Parallel task execution' },
    mode: { cn: '并行模式', en: 'Mode' },
    maxWorkers: { cn: '最大 Worker 数', en: 'Max workers' },
    parallelRead: { cn: '并行读取', en: 'Parallel read' },
    parallelTests: { cn: '并行测试', en: 'Parallel tests' },
    parallelModelCalls: { cn: '并行模型调用', en: 'Parallel model calls' },
    parallelWrites: { cn: '并行写入', en: 'Parallel writes' },
    workspaceIsolation: { cn: '工作区隔离', en: 'Workspace isolation' },
    cpuLimit: { cn: 'CPU 上限', en: 'CPU limit' },
    ramLimit: { cn: '内存上限', en: 'RAM limit' },
    gpuLimit: { cn: 'GPU 上限', en: 'GPU limit' },
    speculativeDecoding: { cn: '推测解码', en: 'Speculative decoding' },
    buildCache: { cn: '构建缓存', en: 'Build cache' },
    autoScaling: { cn: '自动扩缩容', en: 'Automatic worker scaling' },
    advancedFim: { cn: 'FIM 编辑', en: 'Advanced FIM editing' }
  })

  /** A field's two names: the panel's own Chinese, and whatever the host called it. */
  function executionLabel(key, fallback) {
    const entry = EXECUTION_LABELS[String(key)]
    if (!entry) return { cn: String(fallback || key || ''), en: String(fallback || key || '') }
    return { cn: entry.cn, en: String(fallback || entry.en) }
  }

  /**
   * Where a value came from. The host reports a layer name (`env`, `file`, `default`); the panel
   * says it in both languages, because "which layer is this from" is the whole point of the line.
   */
  const SOURCE_TEXT = Object.freeze({
    env: { cn: '来自环境变量', en: 'env' },
    file: { cn: '来自配置文件', en: 'file' },
    default: { cn: '默认值', en: 'default' },
    user: { cn: '用户设置', en: 'user' },
    plugin: { cn: '插件声明', en: 'plugin' }
  })

  function sourceText(source) {
    const entry = SOURCE_TEXT[String(source)]
    return entry ? bi(entry.cn, entry.en) : String(source || '')
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
        say(bi('插件桥不可用（preload 未加载）。', 'the plugin bridge is unavailable (preload not loaded)'), 'bad')
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
      const state = (key, fallbackEn) => {
        const entry = STATE_TEXT[key]
        return entry ? bi(entry.cn, entry.en) : fallbackEn
      }
      // An adopted plugin is labelled as one before anything else is said about it: its guarantees
      // are reduced, and the panel is where that has to be visible.
      if (plugin.compatibility === 'compat') {
        const compat = plugin.compat || {}
        const status = compat.status || 'compat'
        const kind = status === 'running' ? 'ok' : status === 'failed' ? 'bad' : 'neutral'
        return { label: bi('兼容模式', `compat ${status}`), kind }
      }
      if (!plugin.installed) return { label: state('not-installed', 'not installed'), kind: 'bad' }
      if (!plugin.enabled) return { label: state('disabled', 'disabled'), kind: 'muted' }
      if (!plugin.loaded) return { label: state('enabled', 'enabled'), kind: 'neutral' }
      if (plugin.healthy === false) return { label: state('unhealthy', 'unhealthy'), kind: 'bad' }
      if (plugin.healthy === true) return { label: state('healthy', 'healthy'), kind: 'ok' }
      return { label: state('loaded', 'loaded'), kind: 'neutral' }
    }

    function renderLock(lock) {
      if (!lockBox) return
      lockBox.textContent = ''
      if (!lock) return
      const state = lock.state || null
      const line = el('p', 'plug-line')
      line.appendChild(el('strong', null, bi('锁文件', 'Lockfile')))
      line.appendChild(el('span', 'plug-dim', ` ${lock.file || ''}`))
      lockBox.appendChild(line)
      if (!state) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', bi('尚未校验。', 'not verified yet')))
      } else if (state.ok && state.locked === false) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', state.reason || bi('没有锁文件，以当前安装集合为准。', 'no lockfile; the installed set stands')))
      } else if (state.ok) {
        lockBox.appendChild(el('p', 'plug-line plug-dim', bi(`已锁定 ${state.plugins} 个插件，与当前安装集合一致。`, `${state.plugins} plugin(s) locked, matching the installed set`)))
      } else {
        lockBox.appendChild(el('p', 'plug-line bad', state.reason || bi('锁文件与安装集合不一致。', 'the lockfile and the installed set disagree')))
        for (const [kind, entries] of [['changed', state.changed], ['removed', state.removed], ['added', state.added]]) {
          const kindCn = { changed: '已变更', removed: '已移除', added: '已新增' }[kind] || kind
          for (const entry of Array.isArray(entries) ? entries : []) {
            lockBox.appendChild(el('p', 'plug-line plug-dim', `${bi(kindCn, kind)}: ${entry.id}${entry.expected !== undefined ? ` (${entry.expected}${entry.found !== undefined ? ` -> ${entry.found}` : ''})` : ''}`))
          }
        }
      }
    }

    function renderGroups(listed) {
      if (!groupsBox) return
      groupsBox.textContent = ''
      const groups = Array.isArray(listed.groups) ? listed.groups : []
      if (!groups.length) {
        groupsBox.appendChild(el('p', 'plug-empty', listed.ok === false
          ? (listed.error || bi('插件运行时不可用', 'the plugin runtime is unavailable'))
          : bi('还没有加载任何插件。', 'no plugin is loaded yet')))
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
        const names = executionLabel(key, field.label)
        const label = el('span', 'plug-setting-label', bi(names.cn, names.en))
        label.title = bi(names.cn, names.en)
        row.appendChild(label)
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
        // The layer a value came from is a sentence, not a column: it gets its own line under the
        // setting rather than squeezing the setting's name into an ellipsis.
        row.appendChild(el('span', 'plug-dim plug-setting-source', `${sourceText(field.source)}${field.valid === false ? ` · ${bi('无效', 'invalid')}` : ''}`))
        rows.appendChild(row)
      }
      executionBox.appendChild(rows)
      const actions = el('div', 'cu-actions')
      const save = el('button', null, bi('应用', 'Apply'))
      save.type = 'button'
      save.addEventListener('click', () => applySettings())
      actions.appendChild(save)
      const policy = block.modePolicy
      if (policy) {
        actions.appendChild(el('span', 'plug-dim', bi(
          `${policy.label}：读取${policy.readsParallel ? '并行' : '串行'} · 写入${policy.overlappingWrites} · 隔离${policy.isolationRequired ? '必需' : '可选'}`,
          `${policy.label}: reads ${policy.readsParallel ? 'parallel' : 'serial'} · writes ${policy.overlappingWrites} · isolation ${policy.isolationRequired ? 'required' : 'optional'}`
        )))
      }
      executionBox.appendChild(actions)
      const decision = block.workerDecision
      if (decision) {
        executionBox.appendChild(el('p', 'plug-line plug-dim', bi(
          `Worker 数 ${decision.workers}（上限 ${decision.bound} — ${decision.reason}）`,
          `workers ${decision.workers} (bound ${decision.bound} — ${decision.reason})`
        )))
      }
    }

    function renderDetail(detail) {
      if (!detailBox) return
      detailBox.textContent = ''
      if (!detail) {
        detailBox.appendChild(el('p', 'plug-empty', bi('选择上方任意插件查看版本、状态、健康、能力、依赖、配置与延迟。', 'select a plugin above to see its version, state, health, capabilities, dependencies, config and latency')))
        return
      }
      if (detail.ok === false) {
        detailBox.appendChild(el('p', 'plug-line bad', detail.error || bi('无法读取该插件', 'the plugin could not be read')))
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
      /** Set when the plugin is adopted and still needs an install or a build. */
      let compatSetupButton = null
      const add = (label, value, kind) => {
        const line = el('p', `plug-line ${kind || ''}`)
        line.appendChild(el('span', 'plug-fact-label', `${label}: `))
        line.appendChild(el('span', null, value === undefined || value === null || value === '' ? '—' : String(value)))
        facts.appendChild(line)
      }
      const state = stateOf({ installed: detail.installed, enabled: detail.enabled, loaded: detail.loaded, healthy: detail.healthy, compatibility: detail.compatibility, compat: detail.compat })
      add(bi('状态', 'Status'), `${state.label} (installed=${detail.installed} enabled=${detail.enabled} loaded=${detail.loaded})`)
      // An adopted plugin says what it is and what it does not get, in the place where its state is
      // read — and, when it needs one, offers the step it needs.
      if (detail.compatibility === 'compat') {
        const compat = detail.compat || {}
        add(bi('兼容', 'Compatibility'), `compat · ${compat.kind || 'package'} · ${compat.api || 'unknown'} · ${compat.format || 'unknown'}`, 'plug-compat')
        add(bi('兼容状态', 'Compat state'), `${compat.status || '—'}${compat.reason ? ` — ${compat.reason}` : ''}`, compat.status === 'failed' ? 'bad' : 'plug-compat')
        if (Array.isArray(compat.missing) && compat.missing.length) add(bi('缺少依赖包', 'Needs packages'), compat.missing.join(', '), 'plug-compat')
        if (compat.build) add(bi('构建方式', 'Builds with'), compat.buildCommand ? `${compat.build} → ${compat.buildCommand}` : compat.build)
        for (const line of (detail.guarantees && detail.guarantees.cn) || []) {
          facts.appendChild(el('p', 'plug-line plug-compat', `${bi('兼容模式不保证', 'not guaranteed')}: ${line}`))
        }
        if (['needs-dependencies', 'needs-build'].includes(compat.status)) {
          const setup = el('button', 'quiet', bi('安装依赖 / 构建', 'Install & build'))
          setup.type = 'button'
          setup.addEventListener('click', () => runCompatSetup(detail.id))
          compatSetupButton = setup
        }
      }
      add(bi('健康', 'Health'), detail.health ? `${detail.health.status}${detail.health.reason ? ` — ${detail.health.reason}` : ''}` : bi('未探测', 'not probed'), detail.healthy === false ? 'bad' : '')
      add(bi('延迟', 'Latency'), detail.latencyMs === null || detail.latencyMs === undefined ? '—' : `${detail.latencyMs}ms`)
      add(bi('重启次数', 'Restarts'), detail.restartCount)
      add(bi('提供能力', 'Capabilities'), (detail.capabilities || []).join(', '))
      add(bi('必需依赖', 'Requires'), (detail.requires || []).join(', ') || '—')
      add(bi('可选依赖', 'Optional'), (detail.optional || []).join(', ') || '—')
      const missing = detail.dependencies && Array.isArray(detail.dependencies.missing) ? detail.dependencies.missing : []
      add(bi('缺失', 'Missing'), missing.join(', ') || '—', missing.length ? 'bad' : '')
      add(bi('事件订阅', 'Subscriptions'), detail.subscriptions)
      detailBox.appendChild(facts)

      const configLine = el('p', 'plug-line plug-dim', bi(`配置：${detail.configFile || ''}`, `Config: ${detail.configFile || ''}`))
      detailBox.appendChild(configLine)
      const resolved = detail.config || {}
      for (const [key, value] of Object.entries(resolved)) {
        detailBox.appendChild(el('p', 'plug-line plug-dim', `${key} = ${JSON.stringify(value)} (${sourceText((detail.sources || {})[key] || 'unknown')})`))
      }
      for (const fault of Array.isArray(detail.faults) ? detail.faults : []) {
        detailBox.appendChild(el('p', 'plug-line bad', `${fault.phase || 'fault'}: ${fault.reason || ''}`))
      }
      if (detail.error) detailBox.appendChild(el('p', 'plug-line bad', detail.error))

      const actions = el('div', 'cu-actions')
      const toggle = el('button', 'quiet', detail.enabled ? bi('停用', 'Disable') : bi('启用', 'Enable'))
      toggle.type = 'button'
      toggle.addEventListener('click', () => togglePlugin(detail.id, !detail.enabled))
      actions.appendChild(toggle)
      const restart = el('button', 'quiet', bi('重启', 'Restart'))
      restart.type = 'button'
      restart.addEventListener('click', () => reloadPlugin(detail.id))
      actions.appendChild(restart)
      const probe = el('button', 'quiet', bi('体检', 'Health'))
      probe.type = 'button'
      probe.addEventListener('click', () => probeHealth(detail.id))
      actions.appendChild(probe)
      const lock = el('button', 'quiet', bi('写入锁', 'Write lock'))
      lock.type = 'button'
      lock.addEventListener('click', () => writeLock())
      actions.appendChild(lock)
      // The step an adopted plugin still needs sits with the other actions, because it is one.
      if (compatSetupButton) actions.appendChild(compatSetupButton)
      detailBox.appendChild(actions)
    }

    /**
     * Ask the shell to install and build what an adopted plugin needs.
     *
     * The panel describes nothing and runs nothing: the commands are shown by the main process in a
     * confirmation dialog, so what the user agrees to is exactly what runs.
     */
    async function runCompatSetup(id) {
      say(`${id}: ${bi('正在准备依赖与构建命令…', 'preparing the commands…')}`)
      try {
        const result = await window.megaPlugins?.applyCompatSetup?.({ id })
        if (!result) say(`${id}: ${bi('无法准备命令', 'could not prepare the commands')}`, 'bad')
        else if (result.canceled === true || result.code === 'COMPAT_DECLINED') say(`${id}: ${bi('已取消，未执行任何命令', 'canceled — nothing was run')}`, 'warn')
        else if (result.ok === true && result.refreshed && (result.refreshed.mounted || []).length) say(`${id}: ${bi('完成并已即时挂载', 'done — mounted live')}`, 'ok')
        else if (result.ok === true) say(`${id}: ${bi('命令已执行', 'commands finished')}`, 'ok')
        else say(`${id}: ${result.error || result.reason || bi('命令失败', 'the commands failed')}`, 'bad')
      } catch (error) {
        say(`${id}: ${bi(`命令失败: ${error.message}`, `the commands failed: ${error.message}`)}`, 'bad')
      }
      await refresh()
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
      say(bi('正在应用设置…', 'applying the settings…'))
      try {
        const result = await api.configure(patch)
        if (!result || result.ok === false) {
          say((result && result.error) || bi('设置未能应用', 'the settings could not be applied'), 'bad')
          return
        }
        const changed = Object.entries(result.changed || {}).map(([key, value]) => `${key}=${value}`).join(', ')
        say(bi(
          `已应用：${changed || '无变化'}；插件已按新配置重建。`,
          `applied ${changed || 'nothing'}; the plugin world was rebuilt`
        ), 'ok')
        await refresh()
      } catch (error) {
        say(bi(`应用失败：${error.message}`, `could not apply the settings: ${error.message}`), 'bad')
      }
    }

    async function select(id) {
      selected = id
      const api = bridge()
      if (!api) return
      try {
        renderDetail(await api.describe({ id }))
      } catch (error) {
        say(bi(`读取插件失败：${error.message}`, `could not read the plugin: ${error.message}`), 'bad')
      }
    }

    async function togglePlugin(id, enabled) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.enable({ id, enabled })
        if (!result || result.ok === false) {
          say((result && result.error) || bi('操作失败', 'the action failed'), 'bad')
          return
        }
        say(bi(
          `${id} 已${enabled ? '启用' : '停用'}；依赖它的插件会退到 fallback。`,
          `${id} is now ${enabled ? 'enabled' : 'disabled'}; plugins that require it fall back`
        ), 'ok')
        await refresh()
        await select(id)
      } catch (error) {
        say(bi(`操作失败：${error.message}`, `the action failed: ${error.message}`), 'bad')
      }
    }

    async function reloadPlugin(id) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.reload({ id })
        say(result && result.ok
          ? bi(`${id} 已重启（第 ${result.restartCount} 次）。`, `${id} restarted (${result.restartCount})`)
          : bi(`${id} 重启失败：${(result && result.reason) || ''}`, `${id} could not restart: ${(result && result.reason) || ''}`),
        result && result.ok ? 'ok' : 'bad')
        await refresh()
        await select(id)
      } catch (error) {
        say(bi(`重启失败：${error.message}`, `could not restart: ${error.message}`), 'bad')
      }
    }

    async function probeHealth(id) {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.health(id ? { id } : {})
        const health = result && result.health
        const status = health && health.status ? health.status : 'unknown'
        say(bi(`体检结果：${status}${health && health.reason ? ` — ${health.reason}` : ''}`, `health: ${status}${health && health.reason ? ` — ${health.reason}` : ''}`), status === 'healthy' ? 'ok' : 'bad')
        await refresh()
      } catch (error) {
        say(bi(`体检失败：${error.message}`, `the health probe failed: ${error.message}`), 'bad')
      }
    }

    async function writeLock() {
      const api = bridge()
      if (!api) return
      try {
        const result = await api.lock({ write: true })
        say(result && result.ok
          ? bi(`已写入 ${result.file}（${result.plugins} 个插件）。`, `wrote ${result.file} (${result.plugins} plugins)`)
          : bi(`写入失败：${(result && result.error) || (result && result.reason) || ''}`, `could not write the lockfile: ${(result && result.error) || (result && result.reason) || ''}`),
        result && result.ok ? 'ok' : 'bad')
        await refresh()
      } catch (error) {
        say(bi(`写入失败：${error.message}`, `could not write the lockfile: ${error.message}`), 'bad')
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
        chip(`${bi(`${state.loaded} 已载入`, `${state.loaded} loaded`)}${state.unhealthy ? ` · ${bi(`${state.unhealthy} 异常`, `${state.unhealthy} unhealthy`)}` : ''}${state.disabled ? ` · ${bi(`${state.disabled} 已停用`, `${state.disabled} off`)}` : ''}`, state.unhealthy ? 'bad' : 'ok')
        if (selected) await select(selected)
        else renderDetail(null)
      } catch (error) {
        say(bi(`读取插件列表失败：${error.message}`, `could not read the plugin list: ${error.message}`), 'bad')
      }
    }

    // The world is rebuilt in place when the store enables, disables or removes an installed
    // plugin, so the panel follows the runtime instead of waiting for the next time it opens.
    window.megaPlugins?.onChanged?.((payload) => {
      const mounted = ((payload && payload.mounted) || []).join('、')
      const removed = ((payload && payload.removed) || []).join('、')
      if (mounted) say(bi(`已即时挂载：${mounted}（无需重启）`, `mounted live: ${mounted} (no restart needed)`), 'ok')
      if (removed) say(bi(`已停用或卸载：${removed}`, `no longer running: ${removed}`), 'ok')
      refresh()
    })
    // The refresh button re-reads the world *and* asks the shell to re-read the installed set
    // from disk, so a plugin copied into `data/plugins/store` by hand is picked up too. The
    // rescan is what makes the button mean "look again", not "redraw what you have".
    if (buttons.refresh) {
      buttons.refresh.addEventListener('click', async () => {
        const result = await window.megaPlugins?.refresh?.()
        if (result && result.ok === false) say(bi(`重新扫描失败: ${result.error || ''}`, `rescan failed: ${result.error || ''}`), 'bad')
        else if (result && result.rebuilt) say(bi('已重新扫描并重建插件世界', 'rescanned and rebuilt the plugin world'), 'ok')
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
