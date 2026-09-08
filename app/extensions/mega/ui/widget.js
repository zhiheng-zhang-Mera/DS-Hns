'use strict'
const $ = (id) => document.getElementById(id)

async function refresh() {
  try {
    const snap = await window.megaTools.snapshot()
    const counts = snap?.scheduler?.counts || {}
    $('running').textContent = String(counts.RUNNING || 0)
    $('pending').textContent = String((counts.PENDING || 0) + (counts.SUSPENDED || 0))
    const peak = snap?.scheduler?.peak
    const current = snap?.scheduler?.concurrency?.current
    const max = snap?.scheduler?.concurrency?.max
    const peakText = peak?.isPeak ? 'peak window' : 'off-peak'
    $('mode').textContent = current ? `${peakText} · concurrency ${current}${max ? `/${max}` : ''}` : peakText
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
