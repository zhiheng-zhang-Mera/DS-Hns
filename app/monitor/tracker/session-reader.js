'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('../utils/paths')

/**
 * TaskRuntimeTracker / SessionReader — scans dsh JSONL session logs under
 * <project root>\data\sessions and derives task state, real token
 * usage, model and failure codes.
 *
 * A dsh session log is an event envelope JSONL file. Each line is one JSON
 * object. Line 0 is the session header; remaining lines are events with
 * { type, seq, time, data }.
 */

const TERMINAL_REASON_OK = new Set(['success', 'ok', 'done', 'completed'])
const TERMINAL_REASON_INTERRUPTED = new Set(['interrupted', 'interrupt', 'canceled', 'cancelled', 'aborted', 'killed'])
const parsedCache = new Map()

function isLikelyTerminalTurn(data) {
  const reason = data?.reason
  if (!reason || typeof reason !== 'object') return false
  return reason.kind === 'success' || reason.kind === 'error' || reason.kind === 'interrupted'
}

function normalizeFailure(failure) {
  if (!failure) return null
  if (typeof failure === 'string') return { code: 'ERROR', message: failure }
  return {
    code: failure.code || 'ERROR',
    message: failure.message || String(failure.error || '')
  }
}

function collectUsage(data) {
  const usage = data?.usage
  if (!usage || typeof usage !== 'object') return null
  return {
    inputTokens: Number(usage.inputTokens || 0),
    outputTokens: Number(usage.outputTokens || 0),
    cacheReadTokens: Number(usage.cacheReadTokens || 0),
    cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
    reasoningTokens: Number(usage.reasoningTokens || 0)
  }
}

function walkSessionFiles(root = PATHS.SESSIONS) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(root, group.name)
    let entries = []
    try {
      entries = fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const sessionDir = path.join(groupDir, ent.name)
      const jsonl = path.join(sessionDir, 'session.jsonl')
      if (fs.existsSync(jsonl)) out.push({ group: group.name, dir: sessionDir, file: jsonl })
    }
  }
  return out
}

function parseSessionFile(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
  const lines = text.split(/\r?\n/).filter(Boolean)
  const session = { ok: true }
  let model = null
  let provider = null
  let lastSeq = -1
  let lastTime = null
  let lastTurnEnd = null
  let interruptedFlag = false
  let sawAssistantMessage = false
  let sawFinish = false
  let sawUserMessage = false
  let lastAssistantText = ''
  const usageEvents = []
  const errors = []

  for (const raw of lines) {
    let ev
    try {
      ev = JSON.parse(raw)
    } catch {
      continue
    }
    if (ev.type === 'session' && !session.id) {
      session.id = ev.id
      session.createdAt = ev.createdAt
      session.cwd = ev.cwd
      session.version = ev.version
      session.delegationDepth = ev.delegationDepth ?? 0
      continue
    }
    if (typeof ev.seq !== 'number' || typeof ev.time !== 'number') continue
    lastSeq = Math.max(lastSeq, ev.seq)
    lastTime = Math.max(lastTime ?? 0, ev.time)
    const data = ev.data || {}

    if (ev.type === 'user/message' && data.source?.kind === 'user') sawUserMessage = true
    if (ev.type === 'request/header') {
      provider = data.header?.config?.provider || provider
      model = data.header?.config?.model || model
    }
    if (ev.type === 'request/context') {
      provider = data.provider || provider
      model = data.model || model
    }
    if (ev.type === 'assistant/message') {
      sawAssistantMessage = true
      const content = data.message?.content
      if (Array.isArray(content)) {
        lastAssistantText = content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim() || lastAssistantText
      }
      const u = collectUsage(data)
      if (u) usageEvents.push({ time: ev.time, ...u })
      if (data.interrupted) interruptedFlag = true
    }
    if (ev.type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'finish') sawFinish = true
      if (chunk.reason?.kind === 'error') errors.push(normalizeFailure(chunk.reason.failure))
      const u = collectUsage({ usage: chunk.usage })
      if (u) usageEvents.push({ time: ev.time, ...u })
    }
    if (ev.type === 'assistant/attempt') {
      const u = collectUsage(data)
      if (u) usageEvents.push({ time: ev.time, ...u })
      if (data.interrupted) interruptedFlag = true
    }
    if (ev.type === 'turn/end' && isLikelyTerminalTurn(data)) lastTurnEnd = { seq: ev.seq, time: ev.time, data }
  }

  if (lastTurnEnd) {
    const reason = lastTurnEnd.data.reason
    const kind = reason.kind
    if (kind === 'success') session.status = 'COMPLETED'
    else if (kind === 'interrupted' || interruptedFlag) session.status = 'INTERRUPTED'
    else session.status = 'FAILED'
    session.endReason = kind
    const failure = normalizeFailure(reason.error || reason.failure)
    if (failure) {
      session.error = failure
      errors.push(failure)
    }
    session.endedAt = lastTurnEnd.time
  } else if (interruptedFlag) {
    session.status = 'INTERRUPTED'
  } else if (sawUserMessage) {
    session.status = 'RUNNING'
  } else {
    session.status = 'IDLE'
  }

  session.lastSeq = lastSeq
  session.lastEventAt = lastTime
  session.provider = provider
  session.model = model
  session.sawUserMessage = sawUserMessage
  session.sawFinish = sawFinish
  session.usageEvents = usageEvents
  session.errors = errors
  session.lastError = errors.length ? errors[errors.length - 1] : null
  session.assistantText = lastAssistantText || null
  return session
}

function statSession(file) {
  try {
    const st = fs.statSync(file)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** Returns summaries sorted newest-first; attaches real file state. */
function listSessions({ root = PATHS.SESSIONS, limit = 200 } = {}) {
  const files = walkSessionFiles(root)
  const summaries = []
  for (const f of files) {
    const stat = statSession(f.file)
    const cacheKey = stat ? `${f.file}|${stat.mtimeMs}|${stat.size}` : `${f.file}|missing`
    let parsed = parsedCache.get(cacheKey)
    if (!parsed) {
      parsed = parseSessionFile(f.file)
      if (parsed.ok) {
        // Bound the cache so very old sessions drop out.
        if (parsedCache.size > 500) parsedCache.clear()
        parsedCache.set(cacheKey, parsed)
      }
    }
    if (!parsed.ok) continue
    summaries.push({
      id: parsed.id,
      cwd: parsed.cwd,
      group: f.group,
      createdAt: parsed.createdAt,
      updatedAt: parsed.lastEventAt,
      fileMtimeMs: stat?.mtimeMs ?? null,
      status: parsed.status,
      model: parsed.model,
      provider: parsed.provider,
      lastSeq: parsed.lastSeq,
      error: parsed.lastError,
      usageEvents: parsed.usageEvents,
      assistantText: parsed.assistantText,
      usage: parsed.usageEvents.reduce(
        (acc, u) => {
          acc.inputTokens += u.inputTokens
          acc.outputTokens += u.outputTokens
          acc.cacheReadTokens += u.cacheReadTokens
          acc.cacheWriteTokens += u.cacheWriteTokens
          return acc
        },
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      )
    })
  }
  summaries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return limit ? summaries.slice(0, limit) : summaries
}

module.exports = { walkSessionFiles, parseSessionFile, listSessions, collectUsage }
