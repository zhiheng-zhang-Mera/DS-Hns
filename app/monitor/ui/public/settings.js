(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
    return res.json()
  }

  function toast(text, kind) {
    const box = $('toastWrap')
    const div = document.createElement('div')
    div.className = 'toast' + (kind === 'error' ? ' error' : '')
    div.textContent = text
    box.appendChild(div)
    setTimeout(() => div.remove(), 4200)
  }

  function render(settings, schedulerConfig) {
    const modelSelect = $('setModel')
    modelSelect.innerHTML = ''
    for (const m of settings.models || []) {
      const opt = document.createElement('option')
      opt.value = m
      opt.textContent = m
      opt.selected = m === settings.defaultModel
      modelSelect.appendChild(opt)
    }
    $('setPermission').value = settings.permissionMode || 'workspace-write'
    $('setTelemetry').value = settings.telemetryMode || 'DISABLED'
    $('setSound').checked = Boolean(settings.soundEnabled)
    $('setMin').value = schedulerConfig?.minConcurrent ?? 1
    $('setMax').value = schedulerConfig?.maxConcurrent ?? 4
    $('setPeakPause').checked = Boolean(schedulerConfig?.interruptRunningAtPeak)
    $('apiKeyState').textContent = settings.apiKeyConfigured
      ? `已配置 ${settings.apiKeyMasked || ''}(留空保存 = 不修改)`
      : '未配置 Key'
    const paths = settings.paths || {}
    $('pathTable').innerHTML = Object.entries(paths).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')
  }

  async function load() {
    try {
      const data = await fetchJson('/api/settings')
      render(data.settings, data.schedulerConfig)
      const status = await fetchJson('/api/status')
      const badge = $('periodBadge')
      badge.textContent = status.billing?.status || '—'
      badge.className = 'badge ' + (status.billing?.status === 'PEAK' ? 'peak' : 'off')
    } catch {
      toast('设置读取失败', 'error')
    }
  }

  function bind() {
    $('settingsSave').addEventListener('click', async () => {
      const key = $('setApiKey').value.trim()
      const body = {
        apiKey: key || undefined,
        clearKey: $('setClearKey').checked,
        defaultModel: $('setModel').value,
        permissionMode: $('setPermission').value,
        telemetryMode: $('setTelemetry').value,
        soundEnabled: $('setSound').checked
      }
      if (!key && !$('setClearKey').checked) delete body.apiKey
      const resp = await postJson('/api/settings', body)
      if (!resp.ok) {
        toast('设置保存失败:' + (resp.error || ''), 'error')
        return
      }
      const q = await postJson('/api/queue/config', {
        minConcurrent: Number($('setMin').value) || 1,
        maxConcurrent: Number($('setMax').value) || 4,
        interruptRunningAtPeak: $('setPeakPause').checked
      })
      $('setApiKey').value = ''
      $('setClearKey').checked = false
      if (!q.ok) toast('并发设置保存失败', 'error')
      else {
        $('settingsMsg').textContent = '已保存:Key / 模型 / 权限 / 遥测 / 声音 / 并发 即时生效'
        render(resp.settings, q.config)
        toast('设置已保存')
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bind()
      load()
    })
  } else {
    bind()
    load()
  }
})()
