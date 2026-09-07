(function () {
  'use strict'

  // Called by the Electron main process via preload (window.dsDesktop.player).
  var audio = null

  function play(payload) {
    if (!payload || !payload.url) return
    try {
      if (!audio) audio = new Audio()
      audio.src = payload.url
      var vol = Number(payload.volume)
      audio.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1
      audio.currentTime = 0
      var p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {
      /* audio failure must never break the shell */
    }
  }

  if (window.dsDesktop && window.dsDesktop.isElectron && window.dsDesktop.player && window.dsDesktop.player.onPlayRequest) {
    window.dsDesktop.player.onPlayRequest(play)
  }
})()
