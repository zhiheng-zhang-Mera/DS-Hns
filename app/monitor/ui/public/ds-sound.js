/* Shared ringtone client for the 调度中心 views (chat / monitor / settings).
 * One source of truth is the server (config\sound.json):
 *   - /api/sounds  (GET) -> { sounds:{enabled,volume,events}, files:[preset|user] }
 *   - /api/settings(POST {sound:{...}}) persists master/per-event/volume changes
 *   - /api/sounds  (POST {name,data}) uploads a user ringtone
 *
 * Playback:
 *   - under Electron the hidden audio host (window.dsDesktop.player) plays so
 *     bells ring no matter which view is visible; pages only show toasts.
 *   - in a plain browser the page plays the audio itself.
 */
window.DSSound = (function () {
  'use strict'

  var state = {
    sounds: { enabled: true, volume: 0.8, events: {} },
    files: []
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }

  async function refresh() {
    try {
      const data = await fetchJson('/api/sounds')
      if (data.sounds) state.sounds = data.sounds
      if (Array.isArray(data.files)) state.files = data.files
    } catch (err) {
      /* backend offline — keep last known state */
    }
    return state
  }

  function isElectron() {
    return Boolean(window.dsDesktop && window.dsDesktop.isElectron)
  }

  function masterEnabled() {
    return state.sounds.enabled !== false
  }

  function eventState(name) {
    const e = state.sounds.events && state.sounds.events[name]
    return e || null
  }

  function eventEnabled(name) {
    const e = eventState(name)
    return Boolean(e && masterEnabled() && e.enabled !== false)
  }

  function eventUrl(name) {
    const e = eventState(name)
    return e && e.url ? e.url : null
  }

  function fileUrl(name) {
    const f = (state.files || []).find(function (x) { return x.name === name })
    return f ? f.url : null
  }

  async function postSettings(soundPatch) {
    const data = await fetchJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound: soundPatch })
    })
    if (!data.ok) throw new Error(data.error || '保存失败')
    if (data.settings && data.settings.sound) state.sounds = data.settings.sound
    return data.settings
  }

  /** Quick on/off for header buttons; persists immediately on the server. */
  async function setServerEnabled(on) {
    return postSettings({ enabled: Boolean(on) })
  }

  /** Play one audio url. Returns true if playback was started. */
  function playUrl(url, volume) {
    if (!url) return false
    var vol = Number(volume)
    if (!Number.isFinite(vol)) vol = state.sounds.volume != null ? state.sounds.volume : 1
    vol = Math.min(1, Math.max(0, vol))
    if (isElectron() && window.dsDesktop.player && window.dsDesktop.player.play) {
      try {
        window.dsDesktop.player.play({ url: url, volume: vol })
        return true
      } catch (err) {
        return false
      }
    }
    try {
      var audio = new Audio(url)
      audio.volume = vol
      var p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
      return true
    } catch (err) {
      return false
    }
  }

  /** Play the ringtone mapped to an event (respects master + per-event switch). */
  function playEvent(name) {
    if (!eventEnabled(name)) return false
    return playUrl(eventUrl(name), state.sounds.volume)
  }

  return {
    refresh: refresh,
    isElectron: isElectron,
    masterEnabled: masterEnabled,
    eventState: eventState,
    eventEnabled: eventEnabled,
    eventUrl: eventUrl,
    fileUrl: fileUrl,
    playUrl: playUrl,
    playEvent: playEvent,
    postSettings: postSettings,
    setServerEnabled: setServerEnabled,
    getState: function () { return state }
  }
})()
