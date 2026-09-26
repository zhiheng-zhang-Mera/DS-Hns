'use strict'

/**
 * Engineering Runtime: checkpoints, and the gate that decides whether a killed
 * episode may resume.
 *
 * An episode may be killed at any moment — by a deadline, a crash, a reboot or a
 * cancelled parent. What survives is not the runtime's memory but what it wrote
 * down, so two things have to be true:
 *
 *  1. **A checkpoint is either whole or absent.** Checkpoints are JSON files
 *     written to a temporary path and then renamed, because a half-written file
 *     that `latest()` happily parses is worse than no checkpoint at all. Reading
 *     is equally defensive: a missing directory, a missing episode, a truncated
 *     file or corrupt JSON is `null`, and one corrupt file never hides the good
 *     ones behind it.
 *  2. **Resuming is a *re-check*, not a leap of faith.** `verifyResume` inspects
 *     the world as it is now — the workspace, the repository fingerprint, the
 *     git head, every unsettled mutation and every owned process — and reports
 *     whether the plan still means anything, must be rebuilt, or cannot be
 *     carried out here at all. It mutates nothing: it is a read-only gate, and
 *     the caller decides what to do with its verdict.
 *
 * The module also owns output bounding. A shell command can emit megabytes, and
 * carrying that into a context is how a long episode dies of its own log. Shell
 * output is reduced to head + tail + the region around the first error match, and
 * a test suite's output to the five things worth keeping from it — the failure
 * summary, the failed case names, the stack traces, the last lines and the paths
 * of any artifacts it produced. The original size is always reported so the
 * caller can say exactly how much it did not see.
 */

const fs = require('node:fs')
const path = require('node:path')
const repository = require('./repository.cjs')

/** The checkpoint format's version: a reader that does not know it must refuse. */
const CHECKPOINT_VERSION = 2

/** How many checkpoints one episode keeps. */
const DEFAULT_MAX_FILES = 5

/** The output bound: 32 KiB is enough for a real traceback and far short of a log. */
const DEFAULT_MAX_BYTES = 32768

/** The error lines worth pulling out of the middle of a long log. */
const DEFAULT_ERROR_PATTERN = /error|Error|FAIL|failed|Exception|ERR!/

/**
 * The shapes a *test* failure takes, on top of the shell-level error lines.
 *
 * A failing suite often prints no `Error` at all on the failing case's line: TAP
 * says `not ok …` and the spec reporters use a cross. Summarizing a suite with the
 * shell pattern alone would cut the failing case out of the middle and then report
 * that nothing failed.
 */
const TEST_ERROR_PATTERN = /error|Error|FAIL|failed|Exception|ERR!|not ok|✖|✕|×|●/

/** Output extensions and directory hints that make a path an artifact. */
const ARTIFACT_EXTENSIONS = /\.(?:log|xml|json|html|htm|txt|png|jpe?g|webm|zip|tap|sarif|lcov|snapshot|out)$/i
const ARTIFACT_HINTS = /(?:^|[\\/])(?:coverage|test-results|test-output|playwright-report|reports?|artifacts?|screenshots?|traces?|junit)(?:[\\/]|$)/i

/** Cases a runner printed as failing, one pattern per runner dialect. */
const FAILED_CASE_PATTERNS = Object.freeze([
  /^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/,
  /^\s*[✖✕×]\s+(.+?)\s*$/,
  /^\s*--- FAIL:\s*(\S+)/,
  /^\s*FAILED\s+(\S+)/,
  /^\s*FAIL\s+(\S+)\s*$/,
  /^\s*●\s+(.+?)\s*$/
])

/** A positive finite number option, or the fallback. */
function positive(value, fallback) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback
}

/** An integer option that may legitimately be zero, or the fallback. */
function nonNegative(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/** The bytes of a value. */
function byteLength(value) {
  if (value === undefined || value === null) return 0
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

/** The first `bytes` bytes of a string, decoded back to text. */
function sliceFromStart(text, bytes) {
  if (bytes <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  return buffer.subarray(0, bytes).toString('utf8')
}

/** The last `bytes` bytes of a string, decoded back to text. */
function sliceFromEnd(text, bytes) {
  if (bytes <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  return buffer.subarray(buffer.length - bytes).toString('utf8')
}

/** A regex without sticky/global state, so `exec` is repeatable. */
function stateless(pattern) {
  if (pattern === null || pattern === undefined) return null
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  return new RegExp(String(pattern))
}

/** Bound a text block to `maxBytes`, keeping its head and saying what was cut. */
function boundText(text, maxBytes) {
  const source = String(text || '')
  const total = byteLength(source)
  if (total <= maxBytes) return source
  const kept = sliceFromStart(source, Math.max(0, maxBytes - 32))
  return `${kept}\n[... ${total - byteLength(kept)} more bytes]`
}

/** Remove the ANSI colour that makes captured output unreadable to a matcher. */
function stripAnsi(line) {
  return String(line).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * Find the region around the first line that matches `errorPattern`.
 *
 * Reading line by line and keeping only a short window means a five-megabyte log
 * never becomes a five-megabyte array: the scan is bounded by `maxScanLines` and
 * the result by `maxBytes`.
 *
 * @returns {{line:number, match:string, index:number, text:string}|null}
 */
function findErrorRegion(source, pattern, options = {}) {
  const matcher = stateless(pattern)
  if (!matcher) return null
  const before = nonNegative(options.beforeLines, 2)
  const after = nonNegative(options.afterLines, 6)
  const maxBytes = positive(options.maxBytes, 8192)
  const maxScanLines = positive(options.maxScanLines, 50000)
  const window = []
  let index = 0
  let lineNumber = 0
  while (index <= source.length && lineNumber < maxScanLines) {
    const next = source.indexOf('\n', index)
    const end = next === -1 ? source.length : next
    const line = source.slice(index, end)
    lineNumber += 1
    if (matcher.test(line)) {
      const following = []
      let cursor = next === -1 ? source.length : next + 1
      while (following.length < after && cursor <= source.length) {
        const breakAt = source.indexOf('\n', cursor)
        const lineEnd = breakAt === -1 ? source.length : breakAt
        following.push(source.slice(cursor, lineEnd))
        if (breakAt === -1) break
        cursor = breakAt + 1
      }
      return {
        line: lineNumber,
        match: line.trim().slice(0, 200),
        index,
        text: boundText([...window, line, ...following].join('\n'), maxBytes)
      }
    }
    window.push(line)
    if (window.length > before) window.shift()
    if (next === -1) break
    index = next + 1
  }
  return null
}

/**
 * Bound a command's output to head + the error region + tail.
 *
 * The whole log is never returned: what comes back is the beginning (which says
 * what was being run), the region around the first error (which says what went
 * wrong) and the end (which says how it ended). `originalBytes` is always the size
 * of the input, so the caller can report the bytes it dropped.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {RegExp|string|null} [options.errorPattern] `null` disables the region
 * @param {number} [options.headBytes]
 * @param {number} [options.tailBytes]
 * @returns {{text:string, bytes:number, originalBytes:number, truncated:boolean, head:string, tail:string, errorRegion:string|null}}
 */
function truncateOutput(text, options = {}) {
  const source = text === undefined || text === null ? '' : String(text)
  const originalBytes = byteLength(source)
  const maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES)
  const pattern = options.errorPattern === undefined ? DEFAULT_ERROR_PATTERN : options.errorPattern
  const region = findErrorRegion(source, pattern, {
    beforeLines: options.beforeLines,
    afterLines: options.afterLines,
    maxBytes: options.regionBytes
  })
  if (originalBytes <= maxBytes) {
    return {
      text: source,
      bytes: originalBytes,
      originalBytes,
      truncated: false,
      head: source,
      tail: '',
      errorRegion: region ? region.text : null
    }
  }
  // Below this the markers alone would fill the budget, and a caller asking for a
  // hundred bytes wants a prefix, not a mangled excerpt.
  if (maxBytes < 256) {
    const head = sliceFromStart(source, maxBytes)
    return { text: head, bytes: byteLength(head), originalBytes, truncated: true, head, tail: '', errorRegion: region ? region.text : null }
  }
  const regionBudget = region ? Math.min(positive(options.regionBytes, Math.floor(maxBytes * 0.25)), byteLength(region.text)) : 0
  const regionText = region ? boundText(region.text, regionBudget) : null
  const regionBytes = regionText ? byteLength(regionText) : 0
  const markers = 200
  const available = Math.max(256, maxBytes - regionBytes - markers)
  let headBytes = nonNegative(options.headBytes, Math.round(available * 0.6))
  let tailBytes = nonNegative(options.tailBytes, Math.max(0, available - headBytes))
  let head = sliceFromStart(source, headBytes)
  let tail = sliceFromEnd(source, tailBytes)
  const includeRegion = Boolean(regionText) && region.index > byteLength(head)
  const omitted = Math.max(0, originalBytes - byteLength(head) - byteLength(tail) - (includeRegion ? regionBytes : 0))
  const assemble = () => {
    const parts = [head]
    if (includeRegion) parts.push(`\n[... ${omitted} bytes omitted ...]\n`, regionText)
    parts.push(`\n[... ${omitted} bytes omitted ...]\n`, tail)
    return parts.join('')
  }
  let assembled = assemble()
  // The markers are counted in bytes too: shrink the tail until the assembled
  // text really is inside the ceiling instead of nearly inside it.
  for (let attempt = 0; attempt < 4 && byteLength(assembled) > maxBytes && tailBytes > 0; attempt += 1) {
    tailBytes = Math.max(0, tailBytes - (byteLength(assembled) - maxBytes))
    tail = sliceFromEnd(source, tailBytes)
    assembled = assemble()
  }
  if (byteLength(assembled) > maxBytes) assembled = sliceFromStart(assembled, maxBytes)
  return {
    text: assembled,
    bytes: byteLength(assembled),
    originalBytes,
    truncated: true,
    head,
    tail,
    errorRegion: regionText
  }
}

/** The failure counts a runner printed, when it printed any. */
function extractCounts(text) {
  const counts = { total: null, passed: null, failed: null, skipped: null }
  const suite = /Tests?:\s*(?:(\d+)\s+failed[,\s]*)?(?:(\d+)\s+passed[,\s]*)?(\d+)\s+total/i.exec(text)
  if (suite) {
    counts.failed = suite[1] === undefined ? null : Number(suite[1])
    counts.passed = suite[2] === undefined ? null : Number(suite[2])
    counts.total = suite[3] === undefined ? null : Number(suite[3])
  }
  const tap = { tests: null, pass: null, fail: null }
  for (const match of text.matchAll(/^#\s*(tests|pass|fail)\s+(\d+)\s*$/gim)) {
    tap[match[1].toLowerCase()] = Number(match[2])
  }
  if (tap.tests !== null) {
    counts.total = counts.total === null ? tap.tests : counts.total
    counts.passed = counts.passed === null ? tap.pass : counts.passed
    counts.failed = counts.failed === null ? tap.fail : counts.failed
  }
  const pytest = /(\d+)\s+failed,\s*(\d+)\s+passed/.exec(text)
  if (pytest) {
    counts.failed = counts.failed === null ? Number(pytest[1]) : counts.failed
    counts.passed = counts.passed === null ? Number(pytest[2]) : counts.passed
  }
  const genericFailed = /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)\b/i.exec(text)
  if (counts.failed === null && genericFailed) counts.failed = Number(genericFailed[1])
  const genericPassed = /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)\b/i.exec(text)
  if (counts.passed === null && genericPassed) counts.passed = Number(genericPassed[1])
  if (counts.total === null && counts.failed !== null && counts.passed !== null) counts.total = counts.failed + counts.passed
  return counts
}

/** The names of the cases a runner reported as failing, deduped and bounded. */
function extractFailedCases(text, options = {}) {
  const max = positive(options.maxCases, 50)
  const found = []
  const seen = new Set()
  for (const rawLine of text.split('\n')) {
    const line = stripAnsi(rawLine)
    for (const pattern of FAILED_CASE_PATTERNS) {
      const match = pattern.exec(line)
      if (!match) continue
      const name = match[1]
        .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '')
        .replace(/\s+-\s+.*$/, '')
        .trim()
      if (!name || seen.has(name)) break
      seen.add(name)
      found.push(name.slice(0, 200))
      break
    }
    if (found.length >= max) break
  }
  return found
}

/**
 * The stack traces in the output.
 *
 * A trace is a run of frame lines (`at fn (file:line:col)` for JavaScript,
 * `File "x.py", line n` for Python), kept with the error line that introduced it
 * and clipped to a sane size. Traces are the evidence a repair step reasons from,
 * so they are kept as whole blocks rather than as single lines.
 */
function extractStackTraces(text, options = {}) {
  const maxTraces = positive(options.maxTraces, 10)
  const maxBytes = positive(options.maxBytes, 1500)
  const lines = text.split('\n')
  const traces = []
  const finish = (block) => boundText(block.join('\n'), maxBytes)
  let block = null
  let expectSource = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripAnsi(lines[index])
    const isFrame = /^\s+at\s+\S/.test(line) || /^\s*File ".*", line \d+/.test(line)
    if (isFrame) {
      if (!block) {
        block = []
        for (let back = index - 1; back >= 0 && back >= index - 3; back -= 1) {
          const header = stripAnsi(lines[back]).trim()
          if (!header) continue
          if (/error|exception|fail/i.test(header)) block.push(header)
          break
        }
      }
      block.push(line.replace(/\s+$/, ''))
      expectSource = /^\s*File "/.test(line)
      continue
    }
    if (expectSource && block) {
      block.push(line.replace(/\s+$/, ''))
      expectSource = false
      continue
    }
    if (block) {
      traces.push(finish(block))
      block = null
      if (traces.length >= maxTraces) break
    }
  }
  if (block && traces.length < maxTraces) traces.push(finish(block))
  return traces
}

/** The last `count` non-empty lines of the bounded output. */
function tailLines(text, count) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .map((line) => stripAnsi(line).slice(0, 300))
}

/** Paths to artifacts the run produced: reports, coverage, traces, screenshots. */
function extractArtifactPaths(text, options = {}) {
  const max = positive(options.maxPaths, 20)
  const found = []
  const seen = new Set()
  const pattern = /(?:[A-Za-z]:)?(?:[\w.-]+[\\/])*[\w.-]+\.(?:log|xml|json|html|htm|txt|png|jpe?g|webm|zip|tap|sarif|lcov|snapshot|out)\b/gi
  for (const match of text.matchAll(pattern)) {
    const value = match[0].trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (value.length < 3 || value.length > 200) continue
    if (!ARTIFACT_EXTENSIONS.test(value) && !ARTIFACT_HINTS.test(value)) continue
    if (seen.has(value)) continue
    seen.add(value)
    found.push(value)
    if (found.length >= max) break
  }
  return found
}

/**
 * Summarize a test suite's output.
 *
 * This is the same bounding as `truncateOutput` plus the five things a repair
 * step actually needs from a suite: what the runner said in summary, which cases
 * failed, the traces, the last lines, and where the artifacts landed. The
 * counts are read from the *whole* output (a summary line is often printed last,
 * after the truncation point) while the details come from the bounded text.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {RegExp|string} [options.errorPattern]
 * @returns {{summary:string, failedCases:string[], stackTraces:string[], lastLines:string[], artifactPaths:string[], truncated:boolean}}
 */
function summarizeTestOutput(text, options = {}) {
  const source = text === undefined || text === null ? '' : String(text)
  const pattern = options.errorPattern === undefined ? TEST_ERROR_PATTERN : options.errorPattern
  const bounded = truncateOutput(source, { maxBytes: positive(options.maxBytes, DEFAULT_MAX_BYTES), errorPattern: pattern })
  const failedCases = extractFailedCases(bounded.text, options)
  const stackTraces = extractStackTraces(bounded.text, options)
  const artifactPaths = extractArtifactPaths(bounded.text, options)
  const lastLines = tailLines(bounded.text, positive(options.lastLines, 20))
  const counts = extractCounts(source)
  const parts = []
  if (counts.failed !== null && counts.total !== null) {
    parts.push(`${counts.failed} failed of ${counts.total}${counts.passed === null ? '' : ` (${counts.passed} passed)`}`)
  } else if (counts.failed !== null) {
    parts.push(`${counts.failed} failed`)
  } else if (failedCases.length) {
    parts.push(`${failedCases.length} failed case(s) detected`)
  } else {
    parts.push('no failure summary was found')
  }
  if (failedCases.length) parts.push(failedCases.slice(0, 3).join('; '))
  if (bounded.truncated) parts.push(`output truncated from ${bounded.originalBytes} bytes`)
  return {
    summary: parts.join(' - ').slice(0, 400),
    failedCases,
    stackTraces,
    lastLines,
    artifactPaths,
    truncated: bounded.truncated
  }
}

/** A filename-safe episode segment: no dots, so the name stays parseable. */
function segment(episodeId) {
  const value = String(episodeId === undefined || episodeId === null ? 'episode' : episodeId)
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return safe || 'episode'
}

/**
 * The timestamp half of a file name.
 *
 * Epoch milliseconds, zero padded, because lexicographic order has to be
 * chronological and because Windows forbids `:` in a file name — an ISO stamp
 * would have to be mangled, and a mangled stamp is harder to trust than a number.
 */
function stampName(at) {
  const value = Number.isFinite(at) ? Math.round(at) : Date.now()
  return String(value).padStart(16, '0')
}

/** The checkpoint name, newest last when sorted as text. */
function fileName(episodeId, at, sequence) {
  return `${segment(episodeId)}.${stampName(at)}-${String(sequence).padStart(6, '0')}.json`
}

/** The parsed metadata of one checkpoint file name, or null when it is foreign. */
function parseName(name) {
  const match = /^(.+)\.(\d{16})-(\d{6})\.json$/.exec(name)
  if (!match) return null
  return { episode: match[1], at: Number(match[2]), sequence: Number(match[3]) }
}

/** Read one checkpoint file, or null when it is missing, unreadable or corrupt. */
function readCheckpoint(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A valid per-episode recovery sequence, or null for legacy/incomplete state. */
function recoverySequence(checkpoint) {
  const value = checkpoint && checkpoint.recovery && checkpoint.recovery.cursor
    ? checkpoint.recovery.cursor.checkpointSeq
    : null
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** A size in bytes, or 0 when it cannot be read. */
function fileBytes(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** The canonical form of an existing path, so two spellings compare equal. */
function canonicalPath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(String(target))
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.dir] the checkpoint directory
 * @param {string} [options.root] the repository root the default directory hangs off
 * @param {Function} [options.now]
 * @param {number} [options.maxFiles] how many checkpoints one episode keeps
 */
function createCheckpointStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const root = options.root ? path.resolve(String(options.root)) : path.resolve(__dirname, '..', '..')
  const dir = options.dir ? path.resolve(String(options.dir)) : path.join(root, 'runtime', 'engineering', 'checkpoints')
  const maxFiles = positive(options.maxFiles, DEFAULT_MAX_FILES)
  let sequence = 0

  /** Every checkpoint file, oldest first. A missing directory is an empty list. */
  function files(episodeId = null) {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const wanted = episodeId === undefined || episodeId === null ? null : segment(episodeId)
    const found = []
    for (const name of names) {
      // A write that was killed leaves `<name>.json.tmp-…` behind; it is never a
      // checkpoint, and it is never read as one.
      if (name.includes('.tmp')) continue
      const parsed = parseName(name)
      if (!parsed) continue
      if (wanted !== null && parsed.episode !== wanted) continue
      found.push({ file: name, path: path.join(dir, name), episode: parsed.episode, at: parsed.at, sequence: parsed.sequence, bytes: fileBytes(path.join(dir, name)) })
    }
    found.sort((a, b) => a.at - b.at || a.sequence - b.sequence || a.file.localeCompare(b.file))
    return found
  }

  /** Highest valid recovery sequence, independent of wall-clock timestamps. */
  function latestRecoverySequence(episodeId) {
    let highest = 0
    for (const entry of files(episodeId)) {
      const current = recoverySequence(readCheckpoint(entry.path))
      if (current !== null) highest = Math.max(highest, current)
    }
    return highest
  }

  /** Delete the oldest checkpoints until the episode keeps at most `maxFiles`. */
  function prune(episodeId = null) {
    const removed = []
    const known = files(episodeId)
    const episodes = episodeId === undefined || episodeId === null
      ? [...new Set(known.map((entry) => entry.episode))]
      : [segment(episodeId)]
    for (const episode of episodes) {
      const forEpisode = known.filter((entry) => entry.episode === episode)
      while (forEpisode.length > maxFiles) {
        const oldest = forEpisode.shift()
        try {
          fs.unlinkSync(oldest.path)
          removed.push(oldest.file)
        } catch {
          /* a file that is already gone is already pruned */
        }
      }
    }
    return { removed: removed.length, files: removed }
  }

  /**
   * Write one checkpoint.
   *
   * The write goes to a temporary file and is renamed into place, so a process
   * killed mid-write leaves either the old list or the new checkpoint — never a
   * truncated JSON document that a later resume would try to trust.
   *
   * @returns {{ok:boolean, path:string|null, bytes:number, reason:string|null}}
   */
  function save(input = {}) {
    const episodeId = input.episodeId === undefined || input.episodeId === null ? 'episode' : String(input.episodeId)
    const at = now()
    const recovery = input.recovery && typeof input.recovery === 'object' && !Array.isArray(input.recovery)
      ? {
          ...input.recovery,
          episodeId,
          cursor: {
            ...(input.recovery.cursor && typeof input.recovery.cursor === 'object' && !Array.isArray(input.recovery.cursor)
              ? input.recovery.cursor
              : {}),
            checkpointSeq: latestRecoverySequence(episodeId) + 1
          }
        }
      : null
    const record = {
      version: CHECKPOINT_VERSION,
      episodeId,
      at,
      goal: input.goal === undefined ? null : input.goal,
      workspace: input.workspace === undefined ? null : input.workspace,
      fingerprint: input.fingerprint === undefined ? null : input.fingerprint,
      plan: input.plan === undefined ? null : input.plan,
      cursor: input.cursor === undefined ? null : input.cursor,
      verifiedMutations: Array.isArray(input.verifiedMutations) ? input.verifiedMutations : [],
      ownedProcesses: Array.isArray(input.ownedProcesses) ? input.ownedProcesses : [],
      lastFailure: input.lastFailure === undefined ? null : input.lastFailure,
      progress: input.progress === undefined ? null : input.progress,
      phase: input.phase === undefined ? null : input.phase,
      recovery
    }
    let target = null
    let temp = null
    try {
      fs.mkdirSync(dir, { recursive: true })
      // A second writer in the same millisecond must not overwrite this one.
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        sequence += 1
        const candidate = path.join(dir, fileName(episodeId, at, sequence))
        if (!fs.existsSync(candidate)) {
          target = candidate
          break
        }
      }
      if (!target) return { ok: false, path: null, bytes: 0, reason: 'no free checkpoint name was available' }
      const payload = JSON.stringify(record)
      temp = `${target}.tmp-${process.pid}`
      fs.writeFileSync(temp, payload, 'utf8')
      fs.renameSync(temp, target)
      prune(episodeId)
      return { ok: true, path: target, bytes: byteLength(payload), reason: null }
    } catch (error) {
      if (temp) {
        try {
          fs.unlinkSync(temp)
        } catch {
          /* the temp file is already gone */
        }
      }
      return { ok: false, path: null, bytes: 0, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * The newest checkpoint that can actually be read.
   *
   * Corrupt files are skipped rather than fatal: the newest *readable* checkpoint
   * is still the best evidence the episode has, and refusing to look behind one
   * bad file would throw away every good write before it.
   */
  function latest(episodeId) {
    const known = files(episodeId)
    let newestRecovery = null
    let newestRecoverySequence = 0
    for (let index = known.length - 1; index >= 0; index -= 1) {
      const parsed = readCheckpoint(known[index].path)
      if (!parsed) continue
      const currentSequence = recoverySequence(parsed)
      if (currentSequence !== null && currentSequence > newestRecoverySequence) {
        newestRecovery = parsed
        newestRecoverySequence = currentSequence
      }
    }
    if (newestRecovery) return newestRecovery

    // Legacy checkpoints do not have a recovery sequence, so preserve their
    // historical timestamp ordering for diagnosis and existing callers.
    for (let index = known.length - 1; index >= 0; index -= 1) {
      const parsed = readCheckpoint(known[index].path)
      if (parsed) return parsed
    }
    return null
  }

  /** A filesystem view of the episode's checkpoints: bounded, newest first. */
  function list(episodeId) {
    return files(episodeId)
      .slice(-maxFiles)
      .reverse()
      .map((entry) => ({ file: entry.file, path: entry.path, at: entry.at, bytes: entry.bytes, episode: entry.episode }))
  }

  /** Discard an episode's checkpoints, including any half-written temporary file. */
  function remove(episodeId) {
    const removed = []
    const known = files(episodeId)
    const names = new Set(known.map((entry) => entry.file))
    try {
      const prefix = `${segment(episodeId)}.`
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix) && name.includes('.tmp')) names.add(name)
      }
    } catch {
      /* a missing directory has nothing to remove */
    }
    for (const name of names) {
      try {
        fs.unlinkSync(path.join(dir, name))
        removed.push(name)
      } catch {
        /* already gone */
      }
    }
    return { removed: removed.length, files: removed }
  }

  return {
    dir,
    root,
    maxFiles,
    save,
    latest,
    list,
    prune,
    remove
  }
}

/** Is this saved mutation still waiting for its effect to be confirmed? */
function isUnsettled(entry) {
  if (!entry || typeof entry !== 'object') return false
  const result = entry.result === undefined || entry.result === null ? null : String(entry.result)
  if (result === 'pending') return true
  if (result === 'applied' || result === 'already_complete' || result === 'refused' || result === 'failed') return false
  return entry.verified !== true
}

/** The identifiers an owned process may be found under. */
function processIds(entry) {
  const ids = []
  for (const value of [entry.id, entry.pid, entry.processId, entry.handle]) {
    if (value === undefined || value === null) continue
    ids.push(String(value))
  }
  return ids
}

/** Does the saved entry describe a process that is still expected to be running? */
function expectedAlive(entry) {
  if (!entry || typeof entry !== 'object') return false
  const status = entry.status === undefined || entry.status === null ? null : String(entry.status).toLowerCase()
  if (status === null) return true
  return ['running', 'started', 'spawned', 'owned', 'active', 'waiting', 'pending', 'unknown'].includes(status)
}

/** The ids a live process registry reports, or null when it cannot be enumerated. */
function liveIds(source) {
  if (!source) return null
  if (Array.isArray(source) || source instanceof Set) {
    const ids = new Set()
    for (const entry of source) {
      if (entry !== null && typeof entry === 'object') {
        for (const id of processIds(entry)) ids.add(id)
      } else if (entry !== undefined && entry !== null) {
        ids.add(String(entry))
      }
    }
    return ids
  }
  if (typeof source !== 'object') return null
  for (const method of ['list', 'all', 'owned', 'entries', 'processes']) {
    if (typeof source[method] !== 'function') continue
    try {
      return liveIds(source[method]())
    } catch {
      return null
    }
  }
  return null
}

/** A registry that can only answer "is this id there?" instead of listing. */
function membershipLookup(source) {
  if (!source || typeof source !== 'object') return null
  for (const method of ['has', 'get']) {
    if (typeof source[method] === 'function') return { method, source }
  }
  return null
}

/**
 * Is one expected owned process still there?
 *
 * "Cannot tell" counts as alive: a resume verdict must never be upgraded to a
 * restart because the runtime lacked a way to look.
 */
function processAlive(entry, source) {
  if (typeof source === 'function') return source(entry) !== false
  const ids = processIds(entry)
  if (!ids.length) return true
  const lookup = membershipLookup(source)
  if (lookup) {
    for (const id of ids) {
      try {
        if (lookup.source[lookup.method](id)) return true
        if (/^\d+$/.test(id) && lookup.source[lookup.method](Number(id))) return true
      } catch {
        return true
      }
    }
    return false
  }
  const observed = liveIds(source)
  if (observed === null) return true
  for (const id of ids) {
    if (observed.has(id)) return true
    if (/^\d+$/.test(id) && observed.has(Number(id))) return true
  }
  return false
}

/**
 * Re-check a checkpoint against the world as it is now, and say what to do.
 *
 * The verdicts are ordered by how much the world has moved:
 *
 *   `refuse`  the workspace itself is gone or is not the one the checkpoint was
 *             taken in — nothing may continue here.
 *   `restart` the plan no longer means anything: HEAD moved, or a manifest, a
 *             lockfile or the test configuration drifted, or a pending mutation
 *             no longer matches what is on disk.
 *   `resume`  everything else — including a working tree that changed, which is
 *             exactly what the episode's own mutations were supposed to do.
 *
 * It is a read-only gate: it re-reads files, re-runs the fingerprint comparison
 * and re-checks the mutations, and it never writes, reverts or repairs anything.
 *
 * @param {object} input
 * @param {object} input.checkpoint the object `store.latest` returned
 * @param {string} [input.workspace] the workspace this run is in
 * @param {object} [input.fingerprint] a freshly computed `repository.fingerprint`
 * @param {object} [input.gitState] a freshly computed `repository.gitState`
 * @param {object} [input.mutationLog] anything with a `resume(entry)`
 * @param {Function} [input.resumeMutation] injected instead of `mutationLog.resume`
 * @param {Array|Set|object|Function} [input.processes] the live process registry
 * @param {Function} [input.processExists] injected per-entry predicate
 * @returns {{ok:boolean, action:string, reasons:string[], staleMutation:object|null, missingProcesses:object[], mutations:object[], drift:object|null, workspace:object}}
 */
function verifyResume(input = {}) {
  const checkpoint = input.checkpoint
  if (!checkpoint || typeof checkpoint !== 'object') {
    return {
      ok: false,
      action: 'restart',
      reasons: ['there is no readable checkpoint to resume from'],
      staleMutation: null,
      missingProcesses: [],
      mutations: [],
      drift: null,
      workspace: null
    }
  }
  const refuseReasons = []
  const restartReasons = []
  const reasons = []
  const resumeMutation = typeof input.resumeMutation === 'function'
    ? input.resumeMutation
    : (input.mutationLog && typeof input.mutationLog.resume === 'function' ? (entry) => input.mutationLog.resume(entry) : null)

  // 1. The workspace: it must exist, be a directory, and be the same canonical
  // path the checkpoint was taken in. A different path is a different repository.
  const expected = checkpoint.workspace ? path.resolve(String(checkpoint.workspace)) : null
  const requested = input.workspace ? path.resolve(String(input.workspace)) : expected
  const verified = requested
    ? repository.verifyWorkspace(requested)
    : { ok: false, path: null, reason: 'no workspace was given' }
  if (!verified.ok) {
    refuseReasons.push(`the workspace is not usable: ${verified.reason}`)
  } else if (expected && canonicalPath(expected) !== verified.path) {
    refuseReasons.push(`the workspace moved: the checkpoint names ${expected}, this run is in ${verified.path}`)
  }

  // 2. The fingerprint: `repository.diffFingerprint` names exactly what drifted.
  let drift = null
  if (checkpoint.fingerprint && input.fingerprint) {
    drift = repository.diffFingerprint(checkpoint.fingerprint, input.fingerprint)
    for (const reason of drift.reasons) {
      if (/HEAD moved|branch changed|manifest|lockfile|test configuration/.test(reason)) restartReasons.push(`the repository drifted: ${reason}`)
      else reasons.push(`the working tree changed: ${reason}`)
    }
  } else if (checkpoint.fingerprint) {
    reasons.push('the repository fingerprint was not re-checked')
  }

  // 3. The git head, when only a git state was supplied.
  const expectedHead = checkpoint.fingerprint && checkpoint.fingerprint.head
    ? checkpoint.fingerprint.head
    : (checkpoint.gitHead || null)
  if (input.gitState && expectedHead && input.gitState.head && input.gitState.head !== expectedHead) {
    if (!restartReasons.some((reason) => reason.includes('HEAD moved'))) {
      restartReasons.push(`HEAD moved: ${expectedHead} -> ${input.gitState.head}`)
    }
  }

  // 4. Every mutation whose result was never settled is re-checked against disk.
  const saved = Array.isArray(checkpoint.verifiedMutations) ? checkpoint.verifiedMutations : []
  const unsettled = saved.filter((entry) => isUnsettled(entry))
  const mutations = []
  let staleMutation = null
  if (unsettled.length) {
    if (!resumeMutation) {
      restartReasons.push(`${unsettled.length} pending mutation(s) cannot be re-checked because no mutation verifier was supplied`)
    } else {
      for (const entry of unsettled) {
        let outcome
        try {
          outcome = resumeMutation(entry)
        } catch (error) {
          outcome = { verdict: 'failed', verified: false, reason: String(error && error.message ? error.message : error) }
        }
        const verdict = outcome && outcome.verdict ? String(outcome.verdict) : 'retry'
        const record = {
          id: entry.id === undefined ? null : entry.id,
          path: entry.path === undefined ? null : entry.path,
          verdict,
          reason: outcome && outcome.reason ? String(outcome.reason) : null
        }
        mutations.push(record)
        if (verdict === 'failed' && !staleMutation) {
          staleMutation = { id: record.id, path: record.path, reason: record.reason, before: entry.before === undefined ? null : entry.before }
        }
      }
      if (staleMutation) {
        restartReasons.push(`a pending mutation no longer matches the file on disk: ${staleMutation.path} (${staleMutation.reason})`)
      } else {
        const complete = mutations.filter((entry) => entry.verdict === 'already_complete' || entry.verdict === 'applied').length
        const waiting = mutations.filter((entry) => entry.verdict === 'retry').length
        if (complete) reasons.push(`${complete} pending mutation(s) were already on disk and are treated as complete`)
        if (waiting) reasons.push(`${waiting} pending mutation(s) still need to be applied`)
      }
    }
  }

  // 5. Every owned process the checkpoint expected is re-checked for existence.
  const owned = Array.isArray(checkpoint.ownedProcesses) ? checkpoint.ownedProcesses : []
  const missingProcesses = []
  if (owned.length && input.processes === undefined && input.processExists === undefined) {
    reasons.push('the owned processes were not re-checked (no process registry was supplied)')
  } else {
    for (const entry of owned) {
      if (!expectedAlive(entry)) continue
      if (!processAlive(entry, input.processExists || input.processes)) {
        missingProcesses.push({
          id: entry.id === undefined ? null : entry.id,
          pid: entry.pid === undefined ? null : entry.pid,
          command: entry.command === undefined ? null : entry.command,
          status: entry.status === undefined ? null : entry.status
        })
      }
    }
    if (missingProcesses.length) reasons.push(`${missingProcesses.length} owned process(es) from the checkpoint are no longer running`)
  }

  const action = refuseReasons.length ? 'refuse' : (restartReasons.length ? 'restart' : 'resume')
  return {
    ok: action === 'resume',
    action,
    reasons: refuseReasons.length ? refuseReasons : (restartReasons.length ? restartReasons : reasons),
    staleMutation,
    missingProcesses,
    mutations,
    drift,
    workspace: { expected, path: verified.path, ok: verified.ok, reason: verified.reason || null }
  }
}

module.exports = {
  createCheckpointStore,
  verifyResume,
  truncateOutput,
  summarizeTestOutput,
  findErrorRegion,
  extractFailedCases,
  extractStackTraces,
  extractArtifactPaths,
  CHECKPOINT_VERSION,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_BYTES,
  DEFAULT_ERROR_PATTERN,
  TEST_ERROR_PATTERN
}
