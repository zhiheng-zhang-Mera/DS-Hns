(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // Ringtone form state. volume is kept as an integer percentage for the UI.
  const soundState = { enabled: true, volume: 80, events: {}, files: [] }
  const EVENT_ORDER = ['COMPLETED', 'FAILED', 'INTERRUPTED']

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

  /* ---------------- main settings ---------------- */

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
    $('setMin').value = schedulerConfig?.minConcurrent ?? 1
    $('setMax').value = schedulerConfig?.maxConcurrent ?? 4
    $('setPeakPause').checked = Boolean(schedulerConfig?.interruptRunningAtPeak)
    $('apiKeyState').textContent = settings.apiKeyConfigured
      ? `已配置 ${settings.apiKeyMasked || ''}(留空保存 = 不修改)`
      : '未配置 Key'
    const paths = settings.paths || {}
    $('pathTable').innerHTML = Object.entries(paths).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')
  }

  /* ---------------- ringtone panel ---------------- */

  function syncVolumeLabel() {
    $('volLabel').textContent = soundState.volume + '%'
    $('setVolume').value = soundState.volume
  }

  function renderSoundPanel() {
    const box = $('soundEvents')
    box.innerHTML = ''
    const files = soundState.files || []

    const optsForKind = (kind, label) => {
      const group = files.filter((f) => f.kind === kind)
      if (!group.length) return ''
      return (
        `<optgroup label="${label}">` +
        group.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') +
        '</optgroup>'
      )
    }

    for (const name of EVENT_ORDER) {
      const spec = soundState.events[name] || { enabled: true, file: null, label: name }
      const row = document.createElement('div')
      row.className = 'sound-event-row'
      const selectId = 'evFile-' + name
      const fileId = 'evFileInput-' + name
      const currentExists = spec.file && files.some((f) => f.name === spec.file)
      row.innerHTML =
        `<span class="ev-name" title="${esc(name)}">${esc(spec.label || name)}</span>` +
        `<label class="check-line ev-check"><input type="checkbox" data-ev="${esc(name)}" ${spec.enabled ? 'checked' : ''} /> 响铃</label>` +
        `<select id="${selectId}" data-ev-file="${esc(name)}">` +
        optsForKind('preset', '内置预设') +
        optsForKind('user', '我的上传(自定义)') +
        (currentExists ? '' : `<option value="${esc(spec.file || '')}">${spec.file ? esc(spec.file) + ' (当前,文件缺失?)' : '未选择'}</option>`) +
        '</select>' +
        `<button type="button" class="btn mini-btn" data-preview="${esc(name)}">▶ 试听</button>` +
        `<button type="button" class="btn mini-btn" data-upload="${esc(name)}">上传本地音频…</button>` +
        `<input id="${fileId}" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" hidden />`
      box.appendChild(row)
      const select = row.querySelector(`#${selectId}`)
      if (currentExists) select.value = spec.file
      row.querySelector(`[data-ev="${name}"]`).addEventListener('change', (ev) => {
        if (!soundState.events[name]) soundState.events[name] = { enabled: true, file: null, label: spec.label || name }
        soundState.events[name].enabled = ev.target.checked
      })
      select.addEventListener('change', (ev) => {
        if (!soundState.events[name]) soundState.events[name] = { enabled: true, file: null, label: spec.label || name }
        soundState.events[name].file = ev.target.value
      })
      const fileInput = row.querySelector(`#${fileId}`)
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onerror = () => toast('读取文件失败', 'error')
        reader.onload = async () => {
          try {
            const resp = await postJson('/api/sounds', {
              name: file.name,
              data: String(reader.result).split(',')[1] || ''
            })
            if (!resp.ok || !resp.file) throw new Error(resp.error || '上传失败')
            const rec = resp.file
            if (!soundState.files.some((f) => f.name === rec.name)) soundState.files.push(rec)
            if (!soundState.events[name]) soundState.events[name] = { enabled: true, file: null, label: spec.label || name }
            soundState.events[name].file = rec.name
            toast(`已上传 ${rec.name}(未保存的映射点击“保存设置”生效)`)
            renderSoundPanel()
          } catch (err) {
            toast('上传失败:' + (err.message || err), 'error')
          }
        }
        reader.readAsDataURL(file)
      })
    }
  }

  function playPreview(name) {
    const select = document.getElementById('evFile-' + name)
    if (!select) return
    const file = select.value
    if (!file) {
      toast('请先为“' + name + '”选择一个铃声文件', 'error')
      return
    }
    const url = DSSound.fileUrl(file)
    if (!url) {
      toast('文件不可播放:' + file, 'error')
      return
    }
    DSSound.playUrl(url, soundState.volume / 100)
  }

  function uploadFor(name) {
    const input = document.getElementById('evFileInput-' + name)
    if (input) input.click()
  }

  function collectSoundPatch() {
    const events = {}
    for (const name of EVENT_ORDER) {
      const spec = soundState.events[name] || {}
      events[name] = {
        enabled: spec.enabled !== false,
        file: spec.file || null
      }
    }
    return {
      enabled: $('setSound').checked,
      volume: Number(soundState.volume) / 100,
      events
    }
  }

  function bindSoundPanel() {
    $('setSound').checked = soundState.enabled
    syncVolumeLabel()
    $('setVolume').addEventListener('input', (ev) => {
      soundState.volume = Number(ev.target.value) || 0
      syncVolumeLabel()
    })
    const box = $('soundEvents')
    box.addEventListener('click', (ev) => {
      const preview = ev.target.closest('[data-preview]')
      if (preview) {
        playPreview(preview.dataset.preview)
        return
      }
      const upload = ev.target.closest('[data-upload]')
      if (upload) uploadFor(upload.dataset.upload)
    })
    renderSoundPanel()
  }

  /* ---------------- load & save ---------------- */

  /* ---------------- 项目工作区 ---------------- */

  async function loadWorkspace() {
    try {
      const r = await fetchJson('/api/workspace')
      const el = $('wsRoot')
      if (el && r.root) el.value = r.root
    } catch (err) {
      /* server offline */
    }
  }

  function bindWorkspace() {
    const root = $('wsRoot')
    const pick = $('wsPick')
    const openBtn = $('wsOpen')
    const save = $('wsSave')
    if (!root || !save) return
    if (window.dsDesktop && window.dsDesktop.workspace) {
      if (pick) {
        pick.addEventListener('click', async () => {
          try {
            const dir = await window.dsDesktop.workspace.pickDir()
            if (dir) root.value = dir
          } catch (err) {
            toast('选择目录失败', 'error')
          }
        })
      }
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          if (root.value.trim()) window.dsDesktop.workspace.openDir(root.value.trim())
          else toast('请先输入或选择工作区目录', 'error')
        })
      }
    } else {
      if (pick) {
        pick.title = '仅桌面版支持系统目录选择;可手动输入完整路径'
        pick.disabled = true
      }
      if (openBtn) {
        openBtn.title = '仅桌面版支持直接打开目录'
        openBtn.disabled = true
      }
    }
    save.addEventListener('click', async () => {
      const dir = root.value.trim()
      if (!dir) {
        toast('请输入工作区目录', 'error')
        return
      }
      const msg = $('wsMsg')
      try {
        const resp = await postJson('/api/workspace', { root: dir })
        if (!resp.ok) throw new Error(resp.error || '设置失败')
        if (msg) msg.textContent = '已应用:新任务将在 ' + resp.root + '\\active\\<任务ID> 下执行'
        toast('工作区已更新')
      } catch (err) {
        if (msg) msg.textContent = ''
        toast('设置失败:' + (err.message || err), 'error')
      }
    })
  }

  async function load() {
    try {
      const data = await fetchJson('/api/settings')
      render(data.settings, data.schedulerConfig)
      const soundData = await fetchJson('/api/sounds')
      const s = soundData.sounds || {}
      soundState.enabled = s.enabled !== false
      soundState.volume = Math.round(((Number(s.volume) || 0.8) * 100))
      soundState.events = {}
      for (const name of EVENT_ORDER) {
        const e = (s.events || {})[name] || {}
        soundState.events[name] = { enabled: e.enabled !== false, file: e.file || null, label: e.label || name }
      }
      soundState.files = Array.isArray(soundData.files) ? soundData.files : []
      bindSoundPanel()

      const status = await fetchJson('/api/status')
      const badge = $('periodBadge')
      badge.textContent = status.billing?.status || '—'
      badge.className = 'badge ' + (status.billing?.status === 'PEAK' ? 'peak' : 'off')
    } catch (err) {
      toast('设置读取失败:' + (err.message || err), 'error')
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
        sound: collectSoundPatch()
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
        $('settingsMsg').textContent = '已保存:Key / 模型 / 权限 / 遥测 / 并发 / 铃声(开关+音量+每事件) 即时生效'
        const refreshed = resp.settings || {}
        const sr = refreshed.sound || {}
        soundState.enabled = sr.enabled !== false
        soundState.volume = Math.round(((Number(sr.volume) || 0.8) * 100))
        render(resp.settings, q.config)
        bindSoundPanel()
        toast('设置已保存')
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bind()
      load()
      loadWorkspace()
      bindWorkspace()
    })
  } else {
    bind()
    load()
    loadWorkspace()
    bindWorkspace()
  }
})()
