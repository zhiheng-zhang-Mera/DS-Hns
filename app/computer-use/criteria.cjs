'use strict'

/**
 * Computer Use Runtime: success criteria (plan §36, §54.12).
 *
 * "The script finished" is not completion. A run is complete when the criteria
 * the caller wrote down are *observably true* — a file exists, a URL changed, a
 * process exited 0, a page shows a status node. `criteria.cjs` owns that
 * judgement and nothing else: it reads facts from the controllers and returns a
 * per-criterion verdict, so the log can show exactly which promise held.
 */

const { CODES, ComputerUseError } = require('./errors.cjs')

const CRITERION_KINDS = Object.freeze([
  'file_exists',
  'file_missing',
  'file_contains',
  'file_modified',
  'process_exited',
  'process_running',
  'stdout_matches',
  'stderr_matches',
  'exit_code',
  'url_matches',
  'url_changed',
  'dom_exists',
  'dom_text',
  'dom_value',
  'ax_element',
  'window_exists',
  'foreground_window',
  'visual_change',
  'event',
  'all',
  'any',
  'custom'
])

const KIND_ALIASES = Object.freeze({
  file: 'file_exists',
  url: 'url_matches',
  dom: 'dom_exists',
  text: 'dom_text',
  window: 'window_exists',
  process: 'process_running'
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalizes a criterion list. A bare string is a `custom` criterion the host
 * may implement; an object must name a supported kind.
 */
function normalizeCriterion(input, index = 0) {
  if (typeof input === 'string') return { kind: 'custom', name: input, description: input }
  if (!isPlainObject(input)) {
    throw new ComputerUseError(CODES.CONTRACT_INVALID, `success criterion #${index} must be an object or string`, { criterion: input })
  }
  const rawKind = String(input.kind || input.type || '').toLowerCase()
  const kind = KIND_ALIASES[rawKind] || rawKind
  if (!CRITERION_KINDS.includes(kind)) {
    throw new ComputerUseError(CODES.CONTRACT_INVALID, `unsupported success criterion kind: ${rawKind || '(missing)'}`, {
      kind: rawKind || null,
      supported: CRITERION_KINDS
    })
  }
  const criterion = { kind, ...input, kindAlias: rawKind || kind }
  if (input.negate !== undefined) criterion.negate = Boolean(input.negate)
  if (input.description === undefined) criterion.description = describe(criterion)
  if (kind === 'all' || kind === 'any') {
    const list = Array.isArray(input.criteria) ? input.criteria : Array.isArray(input.of) ? input.of : []
    if (!list.length) {
      throw new ComputerUseError(CODES.CONTRACT_INVALID, `success criterion "${kind}" needs a non-empty criteria array`)
    }
    criterion.criteria = list.map((entry, position) => normalizeCriterion(entry, position))
  }
  return criterion
}

function normalizeCriteria(input) {
  if (input === undefined || input === null) return []
  const list = Array.isArray(input) ? input : [input]
  return list.map((entry, index) => normalizeCriterion(entry, index))
}

function describe(criterion) {
  switch (criterion.kind) {
    case 'file_exists': return `file exists: ${criterion.path || criterion.file}`
    case 'file_missing': return `file is gone: ${criterion.path || criterion.file}`
    case 'file_contains': return `file contains ${JSON.stringify(criterion.text ?? criterion.contains ?? '')}: ${criterion.path || criterion.file}`
    case 'file_modified': return `file modified after ${criterion.since || 'the run started'}: ${criterion.path || criterion.file}`
    case 'process_exited': return `process exited: ${criterion.process || criterion.name || '(any)'}`
    case 'process_running': return `process running: ${criterion.process || criterion.name}`
    case 'stdout_matches': return `stdout matches ${criterion.pattern || criterion.text}`
    case 'stderr_matches': return `stderr matches ${criterion.pattern || criterion.text}`
    case 'exit_code': return `last exit code is ${criterion.value ?? criterion.code}`
    case 'url_matches': return `url matches ${criterion.pattern || criterion.url}`
    case 'url_changed': return `url changed from ${criterion.from || '(previous)'}`
    case 'dom_exists': return `DOM has ${criterion.selector}`
    case 'dom_text': return `DOM text ${JSON.stringify(criterion.text || '')} in ${criterion.selector || 'body'}`
    case 'dom_value': return `${criterion.selector} has value ${JSON.stringify(criterion.value ?? '')}`
    case 'ax_element': return `accessibility element ${criterion.name || criterion.role || ''}`
    case 'window_exists': return `window exists: ${criterion.title || criterion.process || criterion.handle}`
    case 'foreground_window': return `foreground window is ${criterion.title || criterion.process}`
    case 'visual_change': return 'the screen region changed'
    case 'event': return `event observed: ${criterion.name || criterion.event}`
    case 'all': return `all of ${criterion.criteria.length} criteria`
    case 'any': return `any of ${criterion.criteria.length} criteria`
    default: return `custom check: ${criterion.name || '(unnamed)'}`
  }
}

/**
 * Evaluates every criterion against the facts the controllers reported.
 *
 * `facts` is a plain object of *already collected* observations plus optional
 * lookups the evaluator is allowed to perform (file existence on disk, the last
 * shell result, the live world state). A criterion whose facts are missing is
 * `unknown`, never `true` — a promise nobody checked cannot be a promise kept.
 */
async function evaluateCriterion(criterion, facts = {}) {
  try {
    const ok = await evaluateOne(criterion, facts)
    if (ok === null || ok === undefined) {
      return { criterion, verdict: 'unknown', ok: false, detail: 'no evidence available' }
    }
    const verdict = criterion.negate ? !ok : ok
    return { criterion, verdict: verdict ? 'satisfied' : 'unsatisfied', ok: verdict, detail: criterion.description }
  } catch (error) {
    return {
      criterion,
      verdict: 'unknown',
      ok: false,
      detail: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : CODES.CONTRACT_INVALID
    }
  }
}

async function evaluateOne(criterion, facts) {
  const path = criterion.path || criterion.file
  switch (criterion.kind) {
    case 'file_exists': {
      if (typeof facts.fileExists === 'function') return await facts.fileExists(path)
      return null
    }
    case 'file_missing': {
      if (typeof facts.fileExists === 'function') return !(await facts.fileExists(path))
      return null
    }
    case 'file_contains': {
      if (typeof facts.fileContains === 'function') return await facts.fileContains(path, criterion.text ?? criterion.contains ?? '')
      return null
    }
    case 'file_modified': {
      if (typeof facts.fileModifiedSince !== 'function') return null
      // Without an explicit `since`, "modified" means "changed during this run",
      // which is the only reference point the runtime has. The file controller
      // answers "cannot tell" for a missing reference, so the run start is
      // supplied here instead of being left undefined.
      const since = criterion.since !== undefined ? criterion.since : facts.startedAt
      if (since === undefined || since === null) return null
      return await facts.fileModifiedSince(path, since)
    }
    case 'process_exited': {
      if (criterion.pid !== undefined) {
        if (typeof facts.processExited === 'function') return await facts.processExited(criterion.pid)
        return null
      }
      const last = facts.lastShell
      if (!last) return null
      return last.exited === true && (criterion.code === undefined || last.exitCode === criterion.code)
    }
    case 'process_running': {
      if (typeof facts.processRunning === 'function') return await facts.processRunning(criterion.process || criterion.name)
      return null
    }
    case 'stdout_matches':
    case 'stderr_matches': {
      const last = facts.lastShell
      if (!last) return null
      const text = criterion.kind === 'stdout_matches' ? last.stdout : last.stderr
      if (typeof text !== 'string') return null
      const pattern = criterion.pattern !== undefined ? criterion.pattern : criterion.text
      if (pattern === undefined) return null
      return criterion.regex === false ? text.includes(String(pattern)) : new RegExp(String(pattern), 'i').test(text)
    }
    case 'exit_code': {
      const expected = criterion.value !== undefined ? criterion.value : criterion.code
      if (facts.lastShell && typeof facts.lastShell.exitCode === 'number') return facts.lastShell.exitCode === expected
      if (typeof facts.exitCode === 'function') return (await facts.exitCode()) === expected
      return null
    }
    case 'url_matches': {
      const url = facts.world ? facts.world.url : undefined
      if (typeof url !== 'string') return null
      const pattern = criterion.pattern !== undefined ? criterion.pattern : criterion.url
      return criterion.regex === false ? url.includes(String(pattern)) : new RegExp(String(pattern), 'i').test(url)
    }
    case 'url_changed': {
      const url = facts.world ? facts.world.url : undefined
      if (typeof url !== 'string') return null
      const from = criterion.from !== undefined ? criterion.from : facts.initialUrl
      if (from === undefined || from === null) return null
      return url !== from
    }
    case 'dom_exists': {
      if (typeof facts.domQuery !== 'function') return null
      const hits = await facts.domQuery(criterion.selector)
      return Array.isArray(hits) ? hits.length > 0 : Boolean(hits)
    }
    case 'dom_text': {
      if (typeof facts.domText !== 'function') return null
      const text = await facts.domText(criterion.selector || 'body')
      if (typeof text !== 'string') return null
      const expected = criterion.text !== undefined ? criterion.text : criterion.contains
      if (expected === undefined) return null
      return criterion.exact ? text.trim() === String(expected) : text.toLowerCase().includes(String(expected).toLowerCase())
    }
    case 'dom_value': {
      if (typeof facts.domValue !== 'function') return null
      const value = await facts.domValue(criterion.selector)
      if (value === null || value === undefined) return null
      return String(value) === String(criterion.value ?? '')
    }
    case 'ax_element': {
      if (typeof facts.axFind !== 'function') return null
      const hits = await facts.axFind(criterion)
      return Array.isArray(hits) ? hits.length > 0 : Boolean(hits)
    }
    case 'window_exists': {
      if (typeof facts.windowExists !== 'function') return null
      return await facts.windowExists(criterion)
    }
    case 'foreground_window': {
      if (typeof facts.foregroundWindow !== 'function') return null
      const foreground = await facts.foregroundWindow()
      if (!foreground) return false
      const title = String(foreground.title || '')
      const process = String(foreground.processName || foreground.process || '')
      if (criterion.title) return title.toLowerCase().includes(String(criterion.title).toLowerCase())
      if (criterion.process) return process.toLowerCase().includes(String(criterion.process).toLowerCase())
      return null
    }
    case 'visual_change': {
      if (typeof facts.visualChange === 'function') return await facts.visualChange(criterion)
      return null
    }
    case 'event': {
      const name = criterion.name || criterion.event
      if (!name) return null
      if (typeof facts.eventObserved === 'function') return await facts.eventObserved(name, criterion)
      const events = facts.events || []
      return events.some((event) => event && (event.type === name || event.name === name))
    }
    case 'all': {
      const results = await Promise.all(criterion.criteria.map((entry) => evaluateCriterion(entry, facts)))
      if (results.some((result) => result.verdict === 'unsatisfied')) return false
      if (results.some((result) => result.verdict === 'unknown')) return null
      return true
    }
    case 'any': {
      const results = await Promise.all(criterion.criteria.map((entry) => evaluateCriterion(entry, facts)))
      if (results.some((result) => result.verdict === 'satisfied')) return true
      if (results.some((result) => result.verdict === 'unknown')) return null
      return false
    }
    case 'custom': {
      if (typeof facts.custom === 'function') return await facts.custom(criterion)
      if (isPlainObject(criterion.check) && typeof facts[criterion.check.fn] === 'function') return await facts[criterion.check.fn](criterion)
      return null
    }
    default:
      return null
  }
}

/**
 * Plan §36: the run is complete only when every criterion is satisfied. A
 * criterion the runtime could not check keeps the run from claiming success —
 * `unknown` is reported as `blocked`, not as `completed`.
 */
async function evaluateCriteria(criteria, facts = {}) {
  const list = Array.isArray(criteria) ? criteria : normalizeCriteria(criteria)
  if (!list.length) return { satisfied: true, unknown: false, results: [], skipped: true }
  const results = []
  for (const criterion of list) results.push(await evaluateCriterion(criterion, facts))
  const satisfied = results.every((result) => result.verdict === 'satisfied')
  const unknown = results.some((result) => result.verdict === 'unknown')
  return {
    satisfied,
    unknown,
    results: results.map((result) => ({
      kind: result.criterion.kind,
      description: result.criterion.description,
      verdict: result.verdict,
      detail: result.detail
    }))
  }
}

module.exports = { CRITERION_KINDS, normalizeCriterion, normalizeCriteria, evaluateCriterion, evaluateCriteria, describe }
