'use strict'

/**
 * Sub-worker reporter (plan §8, §12, §13, §14, §26).
 *
 * The reporter turns the raw event stream into everything a human or a
 * Controller is allowed to see:
 *   - an auditable execution summary (never hidden reasoning),
 *   - the changed-file list,
 *   - a terminal transcript of commands,
 *   - aggregated test results,
 *   - git status,
 *   - per-task and runtime log files.
 */

const fs = require('node:fs')
const path = require('node:path')
const { createResult, emptyTests, RESULT_CODES, isPlainObject, sanitizeTaskId } = require('./protocol.cjs')
const { redactSecrets, truncate } = require('./event-bus.cjs')
const { paths: storePaths } = require('./state.cjs')

const MAX_TERMINAL_LINES = 400
const MAX_SUMMARY_LINES = 80

/** Append one redacted line to a log file, never throwing. */
function appendLogFile(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${redactSecrets(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Shared runtime logger. `logs/sub-worker.log` is the worker-side complement of
 * `logs/desktop-runtime.log` and stays independent of it (plan §26).
 */
function createRuntimeLogger(root) {
  const target = storePaths(root).runtimeLog
  return function log(message) {
    return appendLogFile(target, `${new Date().toISOString()} ${String(message)}`)
  }
}

function createTaskLogger(root, taskId) {
  // One sanitizer for every identifier that becomes a file name.
  const safe = sanitizeTaskId(taskId) || 'task'
  const target = path.join(storePaths(root).taskLogsDir, `${safe}.log`)
  return {
    file: target,
    log(message) {
      return appendLogFile(target, `${new Date().toISOString()} ${String(message)}`)
    }
  }
}

/** Parse a test-runner transcript into passed/failed/skipped counts. */
function parseTestOutput(output) {
  const text = String(output == null ? '' : output)
  const result = { ...emptyTests(), parser: null, total: null }

  // node:test / TAP summary
  const nodePass = text.match(/^#\s*pass\s+(\d+)/im)
  const nodeFail = text.match(/^#\s*fail\s+(\d+)/im)
  if (nodePass || nodeFail) {
    result.passed = nodePass ? Number(nodePass[1]) : 0
    result.failed = nodeFail ? Number(nodeFail[1]) : 0
    result.parser = 'node-test'
  }
  const tapSkip = text.match(/^#\s*skipped\s+(\d+)/im) || text.match(/^#\s*todo\s+(\d+)/im)
  if (tapSkip) result.skipped = Number(tapSkip[1])

  // jest / vitest style: "Tests: 3 failed, 40 passed, 43 total"
  if (!result.parser) {
    const jest = text.match(/Tests:\s*([^\n]*)/i)
    if (jest) {
      const line = jest[1]
      const passed = line.match(/(\d+)\s*passed/i)
      const failed = line.match(/(\d+)\s*failed/i)
      const skipped = line.match(/(\d+)\s*(?:skipped|todo)/i)
      const total = line.match(/(\d+)\s*total/i)
      if (passed || failed || total) {
        result.passed = passed ? Number(passed[1]) : 0
        result.failed = failed ? Number(failed[1]) : 0
        result.skipped = skipped ? Number(skipped[1]) : 0
        result.total = total ? Number(total[1]) : result.passed + result.failed + result.skipped
        result.parser = 'jest-style'
      }
    }
  }

  // mocha style: "41 passing", "2 failing", "1 pending"
  if (!result.parser) {
    const passing = text.match(/(\d+)\s+passing/i)
    const failing = text.match(/(\d+)\s+failing/i)
    const pending = text.match(/(\d+)\s+pending/i)
    if (passing || failing || pending) {
      result.passed = passing ? Number(passing[1]) : 0
      result.failed = failing ? Number(failing[1]) : 0
      result.skipped = pending ? Number(pending[1]) : 0
      result.total = result.passed + result.failed + result.skipped
      result.parser = 'mocha-style'
    }
  }

  if (result.total == null && result.parser) result.total = result.passed + result.failed + result.skipped
  return result
}

/**
 * Fold an exit code into parsed counts when the transcript carried no summary.
 * The fallback is explicit in `parser` so a Controller can tell an exact count
 * from an inferred one.
 */
function resolveTestResult(parsed, exitCode) {
  const counts = { ...emptyTests(), ...(isPlainObject(parsed) ? parsed : {}) }
  if (counts.parser) {
    delete counts.total
    return counts
  }
  const ok = Number(exitCode) === 0
  return {
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    skipped: 0,
    parser: 'exit-code',
    inferred: true
  }
}

const SUMMARY_RULES = [
  ['inspection_started', '✓', 'Inspecting the workspace', (e) => e.summary || `Inspecting ${e.path || 'the workspace'}`],
  ['file_read', '✓', null, (e) => `Read ${e.path}`],
  ['file_write', '✓', null, (e) => `${e.op === 'create' ? 'Created' : 'Updated'} ${e.path}`],
  ['file_delete', '✓', null, (e) => `Deleted ${e.path}`],
  ['command_started', '→', null, (e) => `Running ${e.command}`],
  ['command_finished', null, null, (e) => `${Number(e.exitCode) === 0 ? '✓' : '✗'} ${e.command} exited ${e.exitCode}${e.timedOut ? ' (timed out)' : ''}`],
  ['test_started', '→', null, (e) => `Running tests: ${e.command}`],
  ['test_result', null, null, (e) => {
    if (e.inferred) return `${Number(e.failed) === 0 ? '✓' : '✗'} Test command exited ${e.exitCode} (runner summary unavailable)`
    return `${Number(e.failed) === 0 ? '✓' : '✗'} ${e.passed} passed / ${e.failed} failed${e.skipped ? ` / ${e.skipped} skipped` : ''}`
  }],
  ['git_status', '·', null, (e) => `Git status: ${e.branch || 'unknown branch'}${e.dirty ? ' (dirty)' : ' (clean)'}`],
  ['diff_generated', '·', null, (e) => `Diff generated${e.files != null ? ` for ${e.files} file(s)` : ''}`],
  ['warning', '!', null, (e) => e.summary || e.detail || 'warning'],
  ['error', '✗', null, (e) => e.summary || e.detail || 'error'],
  ['blocked', '⛔', null, (e) => `Blocked: ${e.reason || e.summary || 'needs a Controller decision'}`],
  ['note_applied', '✎', null, (e) => `Note applied: ${e.summary || e.note}`],
  ['task_completed', '✓', null, (e) => e.summary || 'Task completed'],
  ['task_failed', '✗', null, (e) => e.summary || 'Task failed'],
  ['stage_changed', null, null, null]
]

function iconFor(event) {
  const rule = SUMMARY_RULES.find(([type]) => type === event.type)
  if (!rule) return '·'
  return rule[1] || (Number(event.failed) === 0 ? '✓' : '✗')
}

function textFor(event) {
  const rule = SUMMARY_RULES.find(([type]) => type === event.type)
  if (!rule) return null
  const build = rule[3]
  if (!build) return null
  const text = build(event)
  return text ? String(text) : null
}

/**
 * One reporter instance per task. It is fed every event exactly once.
 */
class Reporter {
  constructor({ root, taskId = null, now = () => Date.now() } = {}) {
    this.root = root
    this.taskId = taskId
    this.now = now
    this.summary = []
    this.changedFiles = new Map()
    this.terminal = []
    this.tests = { ...emptyTests() }
    this.testRuns = []
    this.warnings = []
    this.errors = []
    this.stages = []
    this.git = { dirty: false, commit: null, branch: null }
    this.acceptance = []
    this.taskLogger = taskId ? createTaskLogger(root, taskId) : null
    this.runtimeLog = createRuntimeLogger(root)
    this.commands = []
  }

  setTask(taskId) {
    this.taskId = taskId
    this.taskLogger = taskId ? createTaskLogger(this.root, taskId) : null
    return this
  }

  reset(taskId = null) {
    this.summary = []
    this.changedFiles.clear()
    this.terminal = []
    this.tests = { ...emptyTests() }
    this.testRuns = []
    this.warnings = []
    this.errors = []
    this.stages = []
    this.git = { dirty: false, commit: null, branch: null }
    this.acceptance = []
    this.commands = []
    if (taskId !== null) this.setTask(taskId)
    return this
  }

  /** Consume one event; also mirrors it into the per-task log file. */
  record(event) {
    if (!isPlainObject(event)) return null
    const line = textFor(event)
    if (line && event.type !== 'command_output') {
      this.summary.push({ icon: iconFor(event), text: line, type: event.type, at: event.timestamp })
      if (this.summary.length > MAX_SUMMARY_LINES) this.summary.splice(0, this.summary.length - MAX_SUMMARY_LINES)
    }

    switch (event.type) {
      case 'file_write':
        if (event.path) this.changedFiles.set(String(event.path), String(event.op === 'create' ? 'A' : 'M'))
        break
      case 'file_delete':
        if (event.path) this.changedFiles.set(String(event.path), 'D')
        break
      case 'command_started':
        this.terminal.push({ kind: 'command', text: `> ${event.command}` })
        this.commands.push({ command: event.command, startedAt: event.timestamp, exitCode: null })
        break
      case 'command_output': {
        const text = String(event.text == null ? '' : event.text)
        for (const raw of text.split(/\r?\n/)) {
          if (raw.trim() === '') continue
          this.terminal.push({ kind: 'output', text: truncate(redactSecrets(raw), 500) })
        }
        break
      }
      case 'command_finished': {
        this.terminal.push({
          kind: 'exit',
          text: `${event.command} -> exit ${event.exitCode}${event.timedOut ? ' (timeout)' : ''}`
        })
        const last = this.commands[this.commands.length - 1]
        if (last && last.exitCode === null) {
          last.exitCode = event.exitCode
          last.finishedAt = event.timestamp
          last.timedOut = Boolean(event.timedOut)
        }
        break
      }
      case 'test_result':
        this.tests = {
          passed: Number(event.passed) || 0,
          failed: Number(event.failed) || 0,
          skipped: Number(event.skipped) || 0
        }
        if (event.parser) this.tests.parser = event.parser
        if (event.inferred) this.tests.inferred = true
        this.testRuns.push({
          command: event.command || null,
          passed: this.tests.passed,
          failed: this.tests.failed,
          skipped: this.tests.skipped,
          parser: event.parser || null,
          at: event.timestamp
        })
        break
      case 'git_status':
        this.git = {
          dirty: Boolean(event.dirty),
          commit: event.commit == null ? null : event.commit,
          branch: event.branch == null ? null : event.branch
        }
        break
      case 'warning':
        if (event.summary || event.detail) this.warnings.push(String(event.summary || event.detail))
        break
      case 'error':
        if (event.summary || event.detail) this.errors.push(String(event.summary || event.detail))
        break
      case 'stage_changed':
        if (event.stage) this.stages.push({ stage: event.stage, at: event.timestamp })
        break
      case 'blocked':
        this.errors.push(String(event.reason || event.summary || 'blocked'))
        break
      default:
        break
    }
    if (this.terminal.length > MAX_TERMINAL_LINES) {
      this.terminal.splice(0, this.terminal.length - MAX_TERMINAL_LINES)
    }

    if (this.taskLogger) {
      const parts = [event.type]
      if (event.summary) parts.push(String(event.summary))
      if (event.path) parts.push(`path=${event.path}`)
      if (event.command) parts.push(`cmd=${event.command}`)
      if (event.exitCode !== undefined && event.exitCode !== null) parts.push(`exit=${event.exitCode}`)
      if (event.detail) parts.push(truncate(String(event.detail), 400))
      this.taskLogger.log(`[${event.type}] ${parts.slice(1).join(' | ') || '(no detail)'}`)
    }
    return event
  }

  /** Execution Summary for the Live View: facts only, never model scratchpad. */
  summaryLines(limit = 40) {
    const value = Number(limit)
    const lines = Number.isFinite(value) && value > 0 ? this.summary.slice(-Math.floor(value)) : [...this.summary]
    return lines.map((line) => ({ ...line }))
  }

  changedFileList() {
    return [...this.changedFiles.entries()].map(([file, status]) => ({ path: file, status }))
  }

  terminalTail(limit = 60) {
    const value = Number(limit)
    const lines = Number.isFinite(value) && value > 0 ? this.terminal.slice(-Math.floor(value)) : [...this.terminal]
    return lines.map((line) => ({ ...line }))
  }

  recordAcceptance(entries) {
    this.acceptance = Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
    return this.acceptance
  }

  buildResult(taskId, overrides = {}) {
    return createResult(taskId || this.taskId, {
      // `changed_files` stays a plain path list exactly as the plan's Result
      // Object example shows; the per-file status rides alongside it.
      changed_files: [...this.changedFiles.keys()],
      changed_file_details: this.changedFileList(),
      tests: this.tests,
      git: this.git,
      warnings: this.warnings,
      acceptance: this.acceptance,
      stage_log: this.stages,
      code: RESULT_CODES.OK,
      ...overrides
    })
  }

  /** Live View payload (plan §12). */
  describe() {
    return {
      task_id: this.taskId,
      summary: this.summaryLines(),
      changed_files: this.changedFileList(),
      terminal: this.terminalTail(),
      tests: { ...this.tests },
      test_runs: this.testRuns.slice(-10),
      commands: this.commands.slice(-20),
      warnings: this.warnings.slice(-20),
      errors: this.errors.slice(-20),
      git: { ...this.git },
      acceptance: this.acceptance.map((entry) => ({ ...entry })),
      log_file: this.taskLogger?.file || null
    }
  }
}

module.exports = {
  MAX_TERMINAL_LINES,
  MAX_SUMMARY_LINES,
  appendLogFile,
  createRuntimeLogger,
  createTaskLogger,
  parseTestOutput,
  resolveTestResult,
  Reporter
}
