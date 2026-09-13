'use strict'

/**
 * DS-Hns plugin manager float.
 *
 * One place manages every plugin the product has, and that is the whole point of this file.
 * The two kinds live on opposite sides of an architectural line — *platform plugins* are
 * mounted through the capability registry and can come from anywhere, while *feature
 * plugins* are the dock's own surfaces (balance, peak/valley pricing, themes, skills, the
 * queue, Computer Use, the engineering runtime, the updater) — but a user does not care which
 * side of that line a switch is on, so they share one list and one toggle.
 *
 * It is an overlay inside the dock window: no second `BrowserWindow`, no new running window,
 * nothing to bring to the front. The dock's own button and the tray's menu item both reveal
 * it, and both go through the same IPC.
 *
 * The float is deliberately **not** feature-gated. Switching a feature off is how a user
 * fixes one, so the management surface has to survive every switch it offers — which is also
 * why `window.megaPlugins` and `window.megaTools.features` are the two bridges the preload
 * never gates.
 */
;(function attachFeatureManager() {
  function $(id) {
    return document.getElementById(id)
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function attach() {
    const root = $('pluginManager')
    if (!root) return null
    const body = $('pmBody')
    const message = $('pmMessage')
    const storeBar = $('pmStoreBar')
    const tabs = { features: $('pmTabFeatures'), plugins: $('pmTabPlugins'), store: $('pmTabStore') }
    let active = 'features'
    let featureData = { features: [], groups: [] }
    let pluginData = { groups: [] }
    let storeData = { results: [], described: null, query: '', preference: null }

    function say(text, kind) {
      if (!message) return
      message.textContent = text || ''
      message.className = kind ? `theme-message ${kind}` : 'theme-message'
    }

    function open() {
      root.hidden = false
      refresh()
    }

    function close() {
      root.hidden = true
    }

    function setTab(name) {
      active = name
      for (const [key, button] of Object.entries(tabs)) {
        if (button) button.classList.toggle('active', key === active)
      }
      if (storeBar) storeBar.hidden = active !== 'store'
      render()
    }

    /**
     * One search result.
     *
     * The badge is the honest part: a repository is only *installable* once its manifest has
     * been fetched and accepted by the platform's validator, and a store that showed every
     * result as an installable plugin would be lying about most of them.
     */
    function storeRow(result) {
      const row = el('div', 'pm-row')
      const left = el('div')
      left.appendChild(el('div', 'pm-name', result.id || '(unknown)'))
      if (result.description) left.appendChild(el('div', 'pm-purpose', result.description))
      const facts = [`★ ${result.stars}`, result.updatedAt ? result.updatedAt.slice(0, 10) : null].filter(Boolean).join(' · ')
      left.appendChild(el('div', 'pm-meta', facts))
      if (result.manifestReason || result.reason) {
        left.appendChild(el('div', 'pm-meta', result.manifestReason || result.reason))
      }
      row.appendChild(left)
      const actions = el('div', 'pm-actions')
      if (result.installable === null || result.installable === undefined) {
        // Checking is free and changes nothing; staging is the step that writes code to disk.
        actions.appendChild(actionButton('校验 · Check', '', () => inspect(result)))
      } else if (result.installable) {
        actions.appendChild(el('span', 'pm-badge ok', '可安装 · installable'))
      } else if (result.compat && result.compat.possible) {
        // Not a native plugin, but adoptable: saying "not installable" here would be wrong, and
        // saying "installable" without the qualification would be worse.
        actions.appendChild(el('span', 'pm-badge warn', `兼容模式 · compat (${result.compat.kind})`))
      } else {
        actions.appendChild(el('span', 'pm-badge bad', '不可用 · not installable'))
      }
      // Two-stage install: stage here, enable in the installed list below. Both buttons are
      // offered, and the queue is the third way in — add several and install them one by one.
      actions.appendChild(actionButton('暂存 · Stage', '', () => stageResult(result)))
      actions.appendChild(actionButton('加入队列 · Queue', '', () => addToQueue(result)))
      row.appendChild(actions)
      return row
    }

    /**
     * The installed half of the store.
     *
     * Three lists, in the order the user needs them: the queue they are installing right now,
     * what is staged or enabled, and the history that makes a reinstall one button.
     */
    function renderInstalled() {
      const installed = storeData.installed || { plugins: [], history: [], queue: [] }
      const queue = Array.isArray(installed.queue) ? installed.queue : []

      // The queue: the one-by-one install flow, like a phone's app list.
      if (queue.length) {
        const bar = el('div', 'pm-queue')
        bar.appendChild(el('span', 'pm-meta', `${queue.length} 个待安装 / queued`))
        const run = el('button', 'pm-toggle', '逐个安装 · Install one by one')
        run.type = 'button'
        run.addEventListener('click', () => runQueue())
        bar.appendChild(run)
        const clear = el('button', 'pm-toggle danger', '清空 · Clear')
        clear.type = 'button'
        clear.addEventListener('click', () => clearQueue())
        bar.appendChild(clear)
        body.appendChild(bar)
        for (const item of queue) {
          const line = el('div', `pm-row${item.status === 'failed' ? ' off' : ''}`)
          const left = el('div')
          left.appendChild(el('div', 'pm-name', item.repo))
          left.appendChild(el('div', 'pm-meta', `${item.status}${item.reason ? ` · ${item.reason}` : ''}${item.version ? ` · v${item.version}` : ''}`))
          line.appendChild(left)
          line.appendChild(el('span', `pm-badge ${item.status === 'staged' ? 'ok' : item.status === 'failed' ? 'bad' : ''}`, item.status))
          body.appendChild(line)
        }
      }

      const plugins = Array.isArray(installed.plugins) ? installed.plugins : []
      if (plugins.length) {
        body.appendChild(el('div', 'pm-group-title', '已安装 · Installed'))
        // The distinction the store must not blur: a plugin that is installed but switched off
        // is still on disk and one click from running again, while a plugin that was removed is
        // gone and can only come back through the history below.
        body.appendChild(el('p', 'pm-meta', '“已安装、未启用”仍然在磁盘上，启用即用；“已卸载”已从磁盘移除，只能从历史安装重装。· installed-but-off is still on disk; uninstalled has to be reinstalled from the history.'))
        for (const plugin of plugins) {
          const row = el('div', `pm-row${plugin.state === 'enabled' ? '' : ' off'}`)
          const left = el('div')
          left.appendChild(el('div', 'pm-name', `${plugin.name || plugin.id} v${plugin.version}`))
          const stateLabel = plugin.state === 'enabled'
            ? '已启用 · installed + running'
            : plugin.state === 'missing'
              ? '文件缺失 · files missing'
              : '已安装、未启用 · installed, not running'
          // An adopted plugin carries what it is and what it still needs, on the row: compatibility
          // is a reduced guarantee, and a reduced guarantee that is not shown is not a guarantee.
          const compatLabel = plugin.compatibility === 'compat'
            ? ` · 兼容模式 · compat${plugin.compatState && plugin.compatState !== 'ready' && plugin.compatState !== 'staged' ? ` (${plugin.compatState})` : ''}`
            : ''
          left.appendChild(el('div', 'pm-meta', `${plugin.source || plugin.repo} · ${stateLabel}${compatLabel}`))
          if (plugin.compatibility === 'compat' && plugin.compatReason) {
            left.appendChild(el('div', 'pm-meta', plugin.compatReason))
          }
          row.appendChild(left)
          const actions = el('div', 'pm-actions')
          if (plugin.state === 'enabled') {
            actions.appendChild(actionButton('停用 · Disable', 'danger', () => act('disable', plugin.id)))
          } else if (plugin.state === 'staged') {
            actions.appendChild(actionButton('启用 · Enable', '', () => act('enable', plugin.id)))
          } else {
            actions.appendChild(actionButton('重新安装 · Reinstall', '', () => act('reinstall', plugin.id)))
          }
          // The one action a reduced guarantee implies: it needs a package manager or a build, and
          // the shell will describe the commands and ask before running them.
          if (plugin.compatibility === 'compat' && plugin.state === 'enabled'
            && ['needs-dependencies', 'needs-build'].includes(plugin.compatState)) {
            actions.appendChild(actionButton('安装依赖 / 构建 · Install & build', '', () => compatSetup(plugin.id)))
          }
          actions.appendChild(actionButton('移除 · Remove', 'danger', () => act('remove', plugin.id)))
          row.appendChild(actions)
          body.appendChild(row)
        }
      }

      const history = (Array.isArray(installed.history) ? installed.history : []).filter((item) => item.action === 'stage' && item.ok !== false)
      if (history.length) {
        body.appendChild(el('div', 'pm-group-title', '历史安装 · Install history'))
        const present = new Set(plugins.map((plugin) => plugin.id))
        const seen = new Set()
        for (const item of history) {
          if (!item.id || seen.has(item.id)) continue
          seen.add(item.id)
          const stateLabel = present.has(item.id) ? '已安装 · installed' : '已卸载 · uninstalled'
          const row = el('div', 'pm-row off')
          const left = el('div')
          left.appendChild(el('div', 'pm-name', `${item.id}${item.version ? ` v${item.version}` : ''}`))
          left.appendChild(el('div', 'pm-meta', `${item.repo} · ${stateLabel} · ${new Date(item.at || 0).toLocaleString()}`))
          row.appendChild(left)
          row.appendChild(actionButton('重新安装 · Reinstall', '', () => act('reinstall', item.id)))
          body.appendChild(row)
        }
      }
    }

    function renderStore() {
      if (storeData.described) {
        body.appendChild(el('p', 'pm-meta', `${storeData.described.note}${storeData.described.authenticated ? '' : ' (no GITHUB_TOKEN: the rate limit is low)'}`))
      }
      body.appendChild(compatRow())
      if (storeData.error) body.appendChild(el('p', 'pm-line bad', storeData.error))
      renderInstalled()
      if (!storeData.results.length) {
        if (!storeData.error) body.appendChild(el('p', 'pm-empty', storeData.query ? `没有匹配 “${storeData.query}” 的插件 / no plugin matches that search` : '搜索插件主题，或直接输入 owner/name 或仓库链接 / search the plugin topic, or name a repository'))
        return
      }
      body.appendChild(el('div', 'pm-group-title', `${storeData.total || storeData.results.length} repositories · topic ${storeData.topic || '—'}`))
      for (const result of storeData.results) body.appendChild(storeRow(result))
    }

    /** One small button, so the store's rows and the queue read the same way. */
    function actionButton(label, kind, onClick) {
      const button = el('button', `pm-toggle${kind ? ` ${kind}` : ''}`, label)
      button.type = 'button'
      button.addEventListener('click', onClick)
      return button
    }

    /**
     * The compatibility-mode switch.
     *
     * It is a property of the store rather than of one row, because it is a decision about what the
     * user is willing to install — and the text says what the mode costs, at the place where it is
     * turned on, instead of leaving the caveat to a log line nobody reads.
     */
    function compatRow() {
      const row = el('label', 'pm-compat')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = !storeData.preference || storeData.preference.compat !== false
      box.addEventListener('change', () => setCompat(box.checked))
      row.appendChild(box)
      const text = el('div')
      text.appendChild(el('b', '', '兼容模式 · Compatibility mode'))
      text.appendChild(el('span', 'pm-meta', '没有原生清单的仓库按 package.json 推导清单，并在隔离进程中尽力加载；平台的能力与健康保证不适用于它们。· repositories without a native manifest are adopted from package.json and loaded in an isolated process; the platform\'s capability and health guarantees do not apply to them.'))
      row.appendChild(text)
      return row
    }

    async function setCompat(enabled) {
      try {
        const result = await window.megaTools?.store?.setCompat?.(enabled === true)
        if (!result || result.ok === false) {
          say(`${(result && result.reason) || '兼容模式切换失败 / could not change compatibility mode'}`, 'bad')
          return
        }
        storeData = { ...storeData, preference: { compat: result.compat } }
        say(`兼容模式已${result.compat ? '开启' : '关闭'} / compatibility mode ${result.compat ? 'on' : 'off'}`, 'ok')
      } catch (error) {
        say(`兼容模式切换失败 / could not change compatibility mode: ${error.message}`, 'bad')
      }
      render()
    }

    /**
     * Install and build what an adopted plugin needs.
     *
     * The button only asks: the shell shows the commands in a dialog and runs them if the user
     * agrees, so a renderer cannot install anything by pressing twice.
     */
    async function compatSetup(id) {
      say(`${id} 需要额外步骤，正在准备命令… / preparing the commands ${id} needs…`)
      try {
        const result = await window.megaPlugins?.applyCompatSetup?.({ id })
        if (!result) {
          say(`无法准备命令 / could not prepare the commands for ${id}`, 'bad')
        } else if (result.canceled === true || result.code === 'COMPAT_DECLINED') {
          say(`${id}: 已取消，未执行任何命令 / canceled — nothing was run`, 'warn')
        } else if (result.ok === true && result.refreshed && result.refreshed.mounted && result.refreshed.mounted.length) {
          say(`${id} 依赖/构建完成并已即时挂载 / done — mounted live`, 'ok')
        } else if (result.ok === true) {
          say(`${id}: 命令已执行 / commands finished`, 'ok')
        } else {
          say(`${id}: ${result.error || result.reason || '命令失败 / the commands failed'}`, 'bad')
        }
      } catch (error) {
        say(`${id}: 命令失败 / the commands failed: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      try {
        await window.megaPluginPanel?.refresh?.()
      } catch {}
      render()
    }

    /** A bilingual row for one feature, with its switch. */
    function featureRow(feature) {
      const row = el('div', `pm-row${feature.enabled ? '' : ' off'}`)
      const left = el('div')
      left.appendChild(el('div', 'pm-name', `${feature.cn} · ${feature.en}`))
      left.appendChild(el('div', 'pm-purpose', `${feature.purpose.cn} / ${feature.purpose.en}`))
      const surfaces = [
        feature.panels.length ? `panels: ${feature.panels.join(', ')}` : null,
        feature.elements.length ? `controls: ${feature.elements.length}` : null,
        feature.channels.length ? `channels: ${feature.channels.join(', ')}` : null
      ].filter(Boolean).join(' · ')
      left.appendChild(el('div', 'pm-meta', `${feature.group}${surfaces ? ` · ${surfaces}` : ''}`))
      row.appendChild(left)
      const toggle = el('button', `pm-toggle${feature.enabled ? '' : ' danger'}`, feature.enabled ? '停用 · Disable' : '启用 · Enable')
      toggle.type = 'button'
      toggle.addEventListener('click', () => setFeature(feature.id, !feature.enabled))
      row.appendChild(toggle)
      return row
    }

    /** A bilingual row for one platform plugin, with its switch. */
    function pluginRow(plugin) {
      const row = el('div', `pm-row${plugin.enabled ? '' : ' off'}`)
      const left = el('div')
      const group = window.hnsBilingual?.group?.(plugin.group) || { cn: plugin.group, en: plugin.group }
      left.appendChild(el('div', 'pm-name', `${group.cn} · ${plugin.name || plugin.id}`))
      const state = plugin.installed === false ? 'not installed'
        : !plugin.enabled ? 'disabled'
          : !plugin.loaded ? 'enabled'
            : plugin.healthy === false ? 'unhealthy' : 'healthy'
      left.appendChild(el('div', 'pm-meta', `${plugin.id} · v${plugin.version} · ${state}${plugin.error ? ` · ${plugin.error}` : ''}`))
      row.appendChild(left)
      const toggle = el('button', `pm-toggle${plugin.enabled ? '' : ' danger'}`, plugin.enabled ? '停用 · Disable' : '启用 · Enable')
      toggle.type = 'button'
      toggle.addEventListener('click', () => setPlugin(plugin.id, !plugin.enabled))
      row.appendChild(toggle)
      return row
    }

    function render() {
      if (!body) return
      body.textContent = ''
      if (active === 'store') {
        renderStore()
        return
      }
      if (active === 'features') {
        const groups = new Map()
        for (const feature of featureData.features) {
          if (!groups.has(feature.group)) groups.set(feature.group, [])
          groups.get(feature.group).push(feature)
        }
        if (!featureData.features.length) {
          body.appendChild(el('p', 'pm-empty', '功能插件注册表不可用 / the feature registry is unavailable'))
          return
        }
        for (const [group, features] of groups) {
          body.appendChild(el('div', 'pm-group-title', group))
          for (const feature of features) body.appendChild(featureRow(feature))
        }
        return
      }
      const groups = Array.isArray(pluginData.groups) ? pluginData.groups : []
      if (!groups.length) {
        body.appendChild(el('p', 'pm-empty', pluginData.error || '插件运行时不可用 / the plugin runtime is unavailable'))
        return
      }
      for (const group of groups) {
        body.appendChild(el('div', 'pm-group-title', `${group.name}`))
        for (const plugin of group.plugins) body.appendChild(pluginRow(plugin))
      }
    }

    async function refresh() {
      try {
        const features = await window.megaTools?.features?.snapshot?.()
        if (features && features.ok !== false) featureData = features
        else say((features && features.reason) || '无法读取功能插件 / the feature registry is unavailable', 'bad')
      } catch (error) {
        say(`无法读取功能插件 / feature registry failed: ${error.message}`, 'bad')
      }
      try {
        const listed = await window.megaPlugins?.list?.()
        if (listed && listed.ok !== false) pluginData = listed
        else pluginData = { groups: [], error: (listed && listed.error) || 'the plugin runtime is unavailable' }
      } catch (error) {
        pluginData = { groups: [], error: String(error.message || error) }
      }
      render()
      return { features: featureData, plugins: pluginData }
    }

    /** Search the store, and describe the channel the first time it is asked. */
    async function search(query) {
      const text = String(query === undefined ? (($('pmStoreQuery') || {}).value || '') : query).trim()
      storeData = { ...storeData, query: text, error: null }
      try {
        if (!storeData.described) {
          const described = await window.megaTools?.store?.describe?.()
          storeData.described = described && described.ok !== false ? described : null
        }
        await refreshInstalled()
        const result = await window.megaTools?.store?.search?.({ query: text })
        if (!result || result.ok === false) {
          storeData = { ...storeData, results: [], error: (result && result.reason) || '搜索失败 / the search failed' }
        } else {
          storeData = { ...storeData, results: result.results || [], total: result.total, topic: result.topic, error: null }
        }
      } catch (error) {
        storeData = { ...storeData, results: [], error: `搜索失败 / search failed: ${error.message}` }
      }
      render()
      return storeData
    }

    /** Ask whether one result is actually a plugin, and show the verdict on the row. */
    async function inspect(result) {
      try {
        // The package path travels with the check: a monorepo package's manifest is not the
        // repository's, so checking the wrong target would produce the wrong verdict.
        const answer = await window.megaTools?.store?.inspect?.({
          id: result.id,
          branch: result.branch,
          path: result.sourcePath,
          manifestUrl: result.manifestUrl
        })
        const index = storeData.results.findIndex((entry) => entry.id === result.id && (entry.sourcePath || null) === (result.sourcePath || null))
        if (index !== -1) {
          storeData.results[index] = {
            ...storeData.results[index],
            installable: Boolean(answer && answer.installable),
            compat: (answer && answer.compat) || null,
            manifestReason: (answer && (answer.reason || (answer.installable ? `manifest ${answer.manifest.id} v${answer.manifest.version}` : null))) || 'no answer'
          }
        }
        if (answer && answer.installable) say(`${result.id} 是一个可安装插件 / installable`, 'ok')
        else if (answer && answer.compat && answer.compat.possible) say(`${result.id}: 可用兼容模式安装（${answer.compat.kind}）/ adoptable in compatibility mode: ${answer.reason}`, 'warn')
        else say(`${result.id}: ${(answer && answer.reason) || '不可用 / not installable'}`, 'bad')
      } catch (error) {
        say(`校验失败 / check failed: ${error.message}`, 'bad')
      }
      render()
      return storeData
    }

    /** Read the installed side of the store: staged, enabled, history and the queue. */
    async function refreshInstalled() {
      try {
        const answer = await window.megaTools?.store?.installed?.()
        if (answer && answer.ok !== false) {
          storeData = {
            ...storeData,
            preference: answer.preference || storeData.preference,
            installed: { plugins: answer.plugins || [], history: answer.history || [], queue: answer.queue || [], describe: answer.describe || null }
          }
        }
      } catch (error) {
        say(`无法读取已安装插件 / could not read the installed plugins: ${error.message}`, 'bad')
      }
      return storeData.installed
    }

    /** Stage one search result: code on disk and verified, nothing running yet. */
    async function stageResult(result) {
      try {
        // `source` carries the package path when there is one; the store decides whether to adopt
        // the package, using the preference the switch above sets.
        const staged = await window.megaTools?.store?.stage?.({
          source: result.source || result.repo || result.id,
          repo: result.id,
          branch: result.branch
        })
        if (!staged || staged.ok === false) {
          say(`${result.id}: ${(staged && (staged.reason || staged.message)) || '暂存失败 / staging failed'}`, 'bad')
        } else if (staged.compatibility === 'compat') {
          say(`${result.id} 已以兼容模式暂存 v${staged.entry.version}（${staged.compatState || 'ready'}）；启用后 Host 才会加载它 / staged in compatibility mode — enabling is the step that lets the host run it`, 'warn')
        } else {
          say(`${result.id} 已暂存 v${staged.entry.version}；启用后 Host 才会加载它 / staged — enabling is the step that lets the host run it`, 'ok')
        }
      } catch (error) {
        say(`暂存失败 / staging failed: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      render()
      return storeData.installed
    }

    /** Add a candidate to the one-by-one install queue; nothing is cloned yet. */
    async function addToQueue(result) {
      try {
        const answer = await window.megaTools?.store?.queue?.({ action: 'add', source: result.source || result.repo || result.id, repo: result.id, branch: result.branch })
        if (!answer || answer.ok === false) {
          say(`${result.id}: ${(answer && answer.reason) || '加入队列失败 / could not queue it'}`, 'bad')
        } else {
          say(`${result.id} 已加入安装队列（${answer.queue.length}）/ queued`, 'ok')
        }
      } catch (error) {
        say(`加入队列失败 / queueing failed: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      render()
    }

    /** Install the queue sequentially, like a phone's app list. */
    async function runQueue() {
      say('逐个安装中… / installing one by one…')
      try {
        const run = await window.megaTools?.store?.queue?.({ action: 'run' })
        if (!run || run.ok === false) {
          const failed = ((run && run.results) || []).filter((item) => item.status === 'failed')
          say(failed.length ? `${failed.length} 个安装失败：${failed.map((item) => item.repo).join('、')}` : '安装失败 / the install run failed', 'bad')
        } else {
          say(`${run.staged} 个已暂存；启用仍需手动 / staged — enabling stays manual`, 'ok')
        }
      } catch (error) {
        say(`安装失败 / the install run failed: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      render()
    }

    async function clearQueue() {
      try {
        await window.megaTools?.store?.queue?.({ action: 'clear' })
      } catch (error) {
        say(`清空失败 / could not clear the queue: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      render()
    }

    /** Enable, disable, remove or reinstall one installed plugin. */
    async function act(kind, id) {
      try {
        const answer = await window.megaTools?.store?.[kind]?.({ id })
        if (!answer || answer.ok === false) {
          say(`${id}: ${(answer && (answer.reason || answer.message)) || `${kind} 失败 / failed`}`, 'bad')
        } else if (kind === 'enable') {
          // An adopted plugin can be enabled *and* still need a step: saying "running" for it would
          // be the one claim compatibility mode must never make carelessly.
          if (answer.compatibility === 'compat' && answer.state && answer.state !== 'ready') {
            say(`${id} 已启用，但还需要一步（${answer.state}）：${answer.reason || ''} — 用「安装依赖 / 构建」/ enabled, and it still needs a step`, 'warn')
          } else if (answer.compatibility === 'compat') {
            say(`${id} 已以兼容模式启用并即时挂载（隔离进程）/ enabled in compatibility mode — activated in its own process`, 'ok')
          } else {
            say(`${id} 已启用并即时挂载，无需重启 / enabled and mounted live — no restart needed`, 'ok')
          }
        } else if (kind === 'disable') {
          say(`${id} 已停用；仍在磁盘上，可随时重新启用 / disabled — still installed, one click from running again`, 'ok')
        } else if (kind === 'remove') {
          say(`${id} 已卸载；可从历史安装重装 / uninstalled — reinstall it from the history above`, 'ok')
        } else {
          say(`${id}: ${kind} 完成 / done`, 'ok')
        }
      } catch (error) {
        say(`${kind} 失败 / failed: ${error.message}`, 'bad')
      }
      await refreshInstalled()
      // The platform tab lists the same world, so a store action that mounted or unmounted a
      // plugin must move both views: two tabs disagreeing about what is running is exactly the
      // confusion this feature exists to remove.
      try {
        await window.megaPluginPanel?.refresh?.()
      } catch {}
      render()
    }

    async function setFeature(id, enabled) {
      try {
        const result = await window.megaTools?.features?.set?.(id, enabled)
        if (!result || result.ok === false) {
          say((result && result.reason) || `无法切换 ${id}`, 'bad')
          return
        }
        say(`${id} ${enabled ? '已启用 / enabled' : '已停用 / disabled'}`, 'ok')
        await refresh()
      } catch (error) {
        say(`切换失败 / toggle failed: ${error.message}`, 'bad')
      }
    }

    async function setPlugin(id, enabled) {
      try {
        const result = await window.megaPlugins?.enable?.({ id, enabled })
        if (!result || result.ok === false) {
          say((result && result.error) || `无法切换 ${id}`, 'bad')
          return
        }
        say(`${id} ${enabled ? '已启用 / enabled' : '已停用 / disabled'}`, 'ok')
        await refresh()
      } catch (error) {
        say(`切换失败 / toggle failed: ${error.message}`, 'bad')
      }
    }

    if (tabs.features) tabs.features.addEventListener('click', () => setTab('features'))
    if (tabs.plugins) tabs.plugins.addEventListener('click', () => setTab('plugins'))
    if (tabs.store) tabs.store.addEventListener('click', () => setTab('store'))
    if ($('pmStoreSearch')) $('pmStoreSearch').addEventListener('click', () => search())
    if ($('pmStoreQuery')) {
      const input = $('pmStoreQuery')
      input.addEventListener('keydown', (event) => {
        if (event && event.key === 'Enter') search()
      })
    }
    if ($('pmClose')) $('pmClose').addEventListener('click', () => close())
    if ($('pmBackdrop')) $('pmBackdrop').addEventListener('click', () => close())
    // The dock's own button. The tray's menu item arrives as an event instead, because the
    // shell has no other way to ask the dock to open something.
    if ($('plugManage')) $('plugManage').addEventListener('click', () => open())
    window.megaTools?.onOpenPluginManager?.(() => open())
    // The tray can also ask for the store directly, and for its install flow to be shown.
    window.megaTools?.onOpenStore?.((payload) => {
      open()
      setTab('store')
      if (payload && payload.showQueue !== false) {
        refreshInstalled().then(render)
      }
    })
    // Switching a plugin off in the platform tab changes the feature list's world too
    // (a plugin's panel can be a feature), so both lists refresh from one place.
    window.megaTools?.features?.onChanged?.(() => {
      if (!root.hidden) refresh()
    })
    return { open, close, refresh, setTab, setFeature, setPlugin, search, inspect, stageResult, addToQueue, runQueue, clearQueue, act, refreshInstalled, setCompat, compatSetup, isOpen: () => !root.hidden }
  }

  window.megaFeatureManager = { attach }
})()
