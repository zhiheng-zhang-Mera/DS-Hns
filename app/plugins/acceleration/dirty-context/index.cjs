'use strict'

/**
 * DS-Hns acceleration: dirty context.
 *
 * The expensive mistake in a long task is re-sending the whole repository and the
 * whole history on every model call. What a call actually needs is small and
 * specific:
 *
 *   stable context      system, plugin contract, project rules — the cacheable prefix
 *   current task        what this step is for
 *   relevant symbols    what the repo map found for the files in play
 *   dirty diff          what has changed since the baseline
 *   current failure     the error being worked on
 *
 * Two properties matter. First, the layout is *stable-first*: the cacheable prefix
 * is emitted before anything dynamic, so a prompt cache can be reused across calls
 * and one changed line does not invalidate the whole prefix. Second, the size is
 * bounded: every layer declares a budget, the whole call is capped, and what was
 * dropped is reported rather than silently omitted — a context that quietly loses
 * the failure is worse than one that says it ran out of room.
 */

/** The context layers, in the order they are emitted. */
const LAYERS = Object.freeze({
  STABLE: 'stable',
  TASK: 'task',
  SYMBOLS: 'symbols',
  DIFF: 'diff',
  FAILURE: 'failure'
})

/** Which layers are cacheable: everything before the first dynamic one. */
const CACHEABLE_LAYERS = Object.freeze([LAYERS.STABLE])

const DEFAULT_BUDGET = Object.freeze({
  stable: 8_000,
  task: 2_000,
  symbols: 6_000,
  diff: 12_000,
  failure: 6_000,
  total: 32_000
})

/**
 * @param {object} [options]
 * @param {object} [options.budget] per-layer character budgets
 * @param {Function} [options.now]
 * @param {number} [options.ringSize]
 */
function createDirtyContext(options = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) ? options.ringSize : 100
  const built = []

  /**
   * Build one call's context.
   *
   * @param {object} input
   * @param {object|string} [input.stable] the stable prefix (project rules, contract)
   * @param {object} [input.task] `{ goal, step, kind }`
   * @param {object[]} [input.symbols] from the repo map
   * @param {string} [input.diff] the dirty diff
   * @param {object} [input.failure] `{ class, message, output }`
   * @returns {{layers:object[], text:string, bytes:number, dropped:string[], cacheablePrefix:string, cacheKey:string}}
   */
  function build(input = {}) {
    const layers = []
    const dropped = []
    const push = (name, value, limit) => {
      const text = normalize(value)
      if (!text) return
      if (text.length <= limit) {
        layers.push({ name, text, chars: text.length, truncated: false })
        return
      }
      // A layer that does not fit is *cut and declared*, never silently dropped:
      // the caller has to be able to see that it ran out of room.
      layers.push({ name, text: text.slice(0, limit), chars: limit, truncated: true })
      dropped.push(`${name}: ${text.length - limit} characters`)
    }

    push(LAYERS.STABLE, input.stable, budget.stable)
    push(LAYERS.TASK, formatTask(input.task), budget.task)
    push(LAYERS.SYMBOLS, formatSymbols(input.symbols), budget.symbols)
    push(LAYERS.DIFF, input.diff, budget.diff)
    push(LAYERS.FAILURE, formatFailure(input.failure), budget.failure)

    let text = layers.map((layer) => layer.text).join('\n\n')
    if (text.length > budget.total) {
      const overflow = text.length - budget.total
      text = text.slice(0, budget.total)
      dropped.push(`total: ${overflow} characters`)
    }
    const cacheablePrefix = layers.filter((layer) => CACHEABLE_LAYERS.includes(layer.name)).map((layer) => layer.text).join('\n\n')
    const result = {
      at: now(),
      layers,
      text,
      bytes: Buffer.byteLength(text),
      dropped,
      /** The prefix a prompt cache may reuse: it must not contain dynamic layers. */
      cacheablePrefix,
      cacheKey: cacheKeyOf(cacheablePrefix)
    }
    built.push({ at: result.at, bytes: result.bytes, layers: layers.map((layer) => layer.name), dropped: dropped.length })
    if (built.length > ringSize) built.splice(0, built.length - ringSize)
    return result
  }

  /** A stable key for the cacheable prefix. */
  function cacheKeyOf(prefix) {
    let hash = 0
    const source = String(prefix || '')
    for (let index = 0; index < source.length; index += 1) {
      hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0
    }
    return `ctx${Math.abs(hash).toString(36)}`
  }

  function normalize(value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) return value.map((entry) => normalize(entry)).filter(Boolean).join('\n')
    if (typeof value === 'object') return JSON.stringify(value, null, 1)
    return String(value)
  }

  function formatTask(task) {
    if (!task) return ''
    const lines = []
    if (task.goal) lines.push(`Goal: ${task.goal}`)
    if (task.kind) lines.push(`Step: ${task.kind}`)
    if (task.step) lines.push(`Step detail: ${typeof task.step === 'string' ? task.step : JSON.stringify(task.step)}`)
    return lines.join('\n')
  }

  function formatSymbols(symbols) {
    if (!Array.isArray(symbols) || !symbols.length) return ''
    const lines = ['Relevant symbols:']
    for (const symbol of symbols.slice(0, 40)) {
      if (!symbol) continue
      if (typeof symbol === 'string') {
        lines.push(`- ${symbol}`)
        continue
      }
      const location = symbol.file ? `${symbol.file}${symbol.line ? `:${symbol.line}` : ''}` : '(unknown)'
      lines.push(`- ${symbol.name || symbol.symbol || '?'} — ${symbol.kind || 'symbol'} at ${location}`)
    }
    return lines.join('\n')
  }

  function formatFailure(failure) {
    if (!failure) return ''
    const lines = []
    if (failure.class) lines.push(`Failure class: ${failure.class}`)
    if (failure.message) lines.push(`Failure: ${failure.message}`)
    if (failure.output) lines.push('Output:', String(failure.output).slice(0, budget.failure))
    return lines.join('\n')
  }

  return {
    LAYERS,
    CACHEABLE_LAYERS,
    DEFAULT_BUDGET,
    budget,
    build,
    /**
     * Where a change has to be made for the context to stop being reusable: a
     * change to a dynamic layer only invalidates that layer.
     */
    invalidates(dirtyLayers = []) {
      const names = (Array.isArray(dirtyLayers) ? dirtyLayers : []).map(String)
      return {
        cacheablePrefix: names.some((name) => CACHEABLE_LAYERS.includes(name)),
        layers: names
      }
    },
    history() {
      return built.slice()
    },
    summary() {
      const total = built.reduce((sum, entry) => sum + entry.bytes, 0)
      return {
        calls: built.length,
        averageBytes: built.length ? Math.round(total / built.length) : 0,
        lastDropped: built.length ? built[built.length - 1].dropped : 0
      }
    }
  }
}

module.exports = { createDirtyContext, LAYERS, CACHEABLE_LAYERS, DEFAULT_BUDGET }
