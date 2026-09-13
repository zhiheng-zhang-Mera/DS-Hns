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
    const tabs = { features: $('pmTabFeatures'), plugins: $('pmTabPlugins') }
    let active = 'features'
    let featureData = { features: [], groups: [] }
    let pluginData = { groups: [] }

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
    if ($('pmClose')) $('pmClose').addEventListener('click', () => close())
    if ($('pmBackdrop')) $('pmBackdrop').addEventListener('click', () => close())
    // The dock's own button. The tray's menu item arrives as an event instead, because the
    // shell has no other way to ask the dock to open something.
    if ($('plugManage')) $('plugManage').addEventListener('click', () => open())
    window.megaTools?.onOpenPluginManager?.(() => open())
    // Switching a plugin off in the platform tab changes the feature list's world too
    // (a plugin's panel can be a feature), so both lists refresh from one place.
    window.megaTools?.features?.onChanged?.(() => {
      if (!root.hidden) refresh()
    })
    return { open, close, refresh, setTab, setFeature, setPlugin, isOpen: () => !root.hidden }
  }

  window.megaFeatureManager = { attach }
})()
