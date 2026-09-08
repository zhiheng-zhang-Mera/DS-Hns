'use strict'
const $ = (id) => document.getElementById(id)

async function refresh() {
  try {
    const snap = await window.megaTools.snapshot()
    const counts = snap?.scheduler?.counts || {}
    $('running').textContent = String(counts.RUNNING || 0)
    $('pending').textContent = String((counts.PENDING || 0) + (counts.SUSPENDED || 0))
    const peak = Boolean(snap?.scheduler?.peak?.peak)
    const current = snap?.scheduler?.concurrency?.current
    const hardwareCap = snap?.scheduler?.concurrency?.hardwareCap
    const peakText = peak ? 'peak window' : 'off-peak'
    $('mode').textContent = current
      ? `${peakText} · auto ${current}${hardwareCap ? `/${hardwareCap}` : ''}`
      : peakText
  } catch {
    $('mode').textContent = 'Mega status unavailable'
  }
}

$('widget').addEventListener('click', () => window.megaTools.openTools())
$('close').addEventListener('click', (event) => {
  event.stopPropagation()
  window.megaTools.hideWidget()
})
window.megaTools.onChanged(refresh)
refresh()
setInterval(refresh, 5000)
