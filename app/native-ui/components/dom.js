'use strict'

/**
 * Shared DOM helpers for the native frontend components.
 *
 * The renderer builds its own markup from HNS model data only. There is no
 * `querySelector` against anything the official renderer produced (that
 * renderer is a different WebContents and is never referenced at all), and no
 * theme content is ever evaluated as code: message text is escaped, and theme
 * values only ever reach CSS custom properties.
 */
;(function attachDom(global) {
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ENTITIES[character])
  }

  function byId(id) {
    return global.document ? global.document.getElementById(id) : null
  }

  /** Escape, then render fenced code blocks and preserve line breaks. */
  function formatText(value) {
    const text = String(value ?? '')
    if (!text) return ''
    const parts = text.split(/```/)
    return parts
      .map((part, index) => {
        if (index % 2 === 1) {
          const body = part.replace(/^[a-zA-Z0-9-]*\n/, '')
          return `<pre class="code">${esc(body)}</pre>`
        }
        return `<span class="text">${esc(part).replace(/\n/g, '<br>')}</span>`
      })
      .join('')
  }

  function timeAgo(value) {
    const ms = Number(value)
    if (!Number.isFinite(ms)) return ''
    const delta = Date.now() - ms
    if (delta < 0) return 'now'
    const seconds = Math.round(delta / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return new Date(ms).toLocaleDateString()
  }

  function clear(node) {
    if (node) node.innerHTML = ''
  }

  /** Delegated click: one listener per container, never one per row. */
  function delegate(node, handler) {
    if (!node) return () => {}
    const listener = (event) => {
      try {
        handler(event)
      } catch (error) {
        console.error('[hns-native] delegated handler failed', error)
      }
    }
    node.addEventListener('click', listener)
    return () => node.removeEventListener('click', listener)
  }

  global.hnsUI = global.hnsUI || {}
  global.hnsUI.dom = { esc, byId, formatText, timeAgo, clear, delegate }
})(window)
