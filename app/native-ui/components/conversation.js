'use strict'

/**
 * Conversation Timeline (Update-Plan/Dual-UI.md 任务 7: Conversation Timeline /
 * User Message / Assistant Message / Errors / Loading State).
 *
 * One row per HNS Message. The pending echo of a prompt this frontend just sent
 * is rendered locally until the durable message arrives from the journal, which
 * is what keeps "send" feeling immediate without inventing a second source of
 * truth: the echo is dropped the moment the snapshot carries a user message with
 * the same text and a later timestamp.
 */
;(function attachConversation(global) {
  const ui = global.hnsUI = global.hnsUI || {}
  const { esc, byId, formatText, timeAgo } = ui.dom

  function renderMessage(message, { pending = false } = {}) {
    const role = String(message.role || 'system')
    const label = role === 'user' ? 'You' : role === 'assistant' ? 'Harness' : role
    const status = String(message.status || 'complete')
    const tools = Array.isArray(message.toolCalls) ? message.toolCalls : []
    const toolMarkup = tools.length
      ? `<div class="msg-tools">${tools
          .map((call) => `<span class="tool-chip" title="${esc(JSON.stringify(call.input ?? null))}">${esc(call.name)}</span>`)
          .join('')}</div>`
      : ''
    return `<article class="msg msg-${esc(role)}${pending ? ' pending' : ''}" data-status="${esc(status)}">` +
      `<header><b>${esc(label)}</b><time>${pending ? 'sending…' : esc(timeAgo(message.timestamp))}</time></header>` +
      `<div class="msg-body">${formatText(message.content)}</div>${toolMarkup}` +
      `</article>`
  }

  function render(state) {
    const timeline = byId('timeline')
    if (!timeline) return
    const messages = Array.isArray(state.messages) ? state.messages : []
    const pending = state.pendingEcho
    const rows = messages.map((message) => renderMessage(message))
    if (pending) rows.push(renderMessage({ role: 'user', content: pending.prompt, status: 'pending', timestamp: pending.at }, { pending: true }))
    if (!rows.length) {
      const reason = state.conversation?.reason
      timeline.innerHTML = `<div class="empty-conversation">` +
        `<h2>${state.activeSessionId ? 'This session has no messages yet' : 'No session selected'}</h2>` +
        `<p>${esc(reason || (state.activeSessionId ? 'Send a message to begin.' : 'Create or pick a session in the sidebar.'))}</p>` +
        `</div>`
    } else {
      timeline.innerHTML = rows.join('')
    }
    // Running state: the composer's own indicator, plus the timeline footer.
    const running = Boolean(state.composer?.running)
    const footer = byId('runningState')
    if (footer) {
      footer.hidden = !running
      footer.textContent = running ? 'Harness is working…' : ''
    }
    // Keep the newest message in view unless the user scrolled up to read.
    try {
      const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 160
      if (nearBottom) timeline.scrollTop = timeline.scrollHeight
    } catch {
      // Layout is not measurable in a unit-test stub; scrolling is cosmetic.
    }
  }

  ui.conversation = { render, renderMessage }
})(window)
