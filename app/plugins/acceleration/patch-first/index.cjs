'use strict'

/**
 * DS-Hns acceleration: patch-first editing (phase 13 of the acceleration plan).
 *
 * The plan fixes an editing priority (AST edit > targeted patch > FIM > whole-file
 * rewrite) because a whole-file rewrite is the most expensive and the most dangerous
 * way to make a small change. It burns output tokens proportional to the *file*
 * rather than to the *change*, it risks silently reverting every unrelated edit the
 * model did not happen to have in context, and it turns a three-line review into a
 * thousand-line one.
 *
 * The failure mode this module exists to prevent is the *silent* fallthrough: a model
 * asked to change three lines of a 1200-line file rewrites the whole file because
 * that was the easiest thing to emit, and nothing in the pipeline objects. So the
 * expensive strategy has to be earned:
 *
 *   * a structural change with a real AST operation takes the AST edit;
 *   * a small change takes a targeted patch, or FIM when patches are unavailable;
 *   * a whole-file rewrite is allowed only when the change is genuinely a large
 *     fraction of the file, when the file is too small for a rewrite to be waste, or
 *     when the change is not small enough for a cheaper strategy to exist at all;
 *   * and otherwise the answer is a *refusal* (`strategy: null`, `refused: true`)
 *     whose reason names the file size and the change size, so the caller has to
 *     choose the expensive path deliberately instead of drifting into it.
 *
 * This is the *policy*, not the editor: it decides which strategy a change is allowed
 * to use and never touches a file itself. It is also pure (no clock, no I/O), so a
 * decision can be replayed and reviewed after the fact.
 *
 * COST MODEL
 *
 * Estimates are line-based, because a line count is the only unit available before
 * the edit exists. An average source line is taken to be 48 characters
 * (`COST_MODEL.charactersPerLine`) and a token to be 4 characters
 * (`DEFAULT_POLICY.charactersPerToken`), so one line is about 12 tokens. A whole-file
 * rewrite is estimated to emit every line. A targeted patch emits each changed line
 * twice (once as a removal, once as an addition) plus six lines of hunk header and
 * context. FIM emits the changed lines once plus sixty lines of prefix/suffix
 * framing. An AST edit emits one small structured operation, taken as a flat 48
 * tokens. The constants are deliberately generous *to the cheap strategies*:
 * overestimating a patch can never make the policy pick a rewrite, while
 * underestimating one could.
 */

/** The editing strategies, cheapest and safest first. */
const EDIT_STRATEGIES = Object.freeze({
  AST_EDIT: 'ast-edit',
  TARGETED_PATCH: 'targeted-patch',
  FIM: 'fim',
  WHOLE_FILE: 'whole-file'
})

/** Priority order. `rank` is the 0-based index here, so 0 is the most preferred. */
const STRATEGY_RANK = Object.freeze([
  EDIT_STRATEGIES.AST_EDIT,
  EDIT_STRATEGIES.TARGETED_PATCH,
  EDIT_STRATEGIES.FIM,
  EDIT_STRATEGIES.WHOLE_FILE
])

/**
 * The default policy.
 *
 * `smallChangeLines` is the size below which a change is expected to be expressed
 * cheaply; `wholeFileRatio` is the fraction of a file above which rewriting it is no
 * longer waste. The three `*Supported` flags describe what the *runtime* can actually
 * do, not what the caller would like: a policy that claims patch support the toolchain
 * does not have would produce a plan that cannot be executed.
 */
const DEFAULT_POLICY = Object.freeze({
  smallChangeLines: 40,
  wholeFileRatio: 0.5,
  charactersPerToken: 4,
  fimSupported: false,
  patchSupported: true,
  astSupported: false
})

/** The line-to-token constants behind every estimate, with their justification. */
const COST_MODEL = Object.freeze({
  /** An average source line. One line is about 12 tokens at 4 characters per token. */
  charactersPerLine: 48,
  /** A unified diff carries each changed line twice: a removal and an addition. */
  patchLinesPerChangedLine: 2,
  /** A diff hunk header and the context lines around it. */
  patchContextLines: 6,
  /** FIM repeats each inserted line once, inside the framing text. */
  fimLinesPerChangedLine: 1,
  /** The prefix and suffix a fill-in-the-middle request must carry. */
  fimContextLines: 60,
  /** An AST operation is a node path plus arguments: a flat, bounded record. */
  astTokensPerOperation: 48
})

/** A non-negative whole line count; anything unusable is treated as zero lines. */
function countLines(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

/** A boolean capability flag: an explicit request wins, otherwise the policy's. */
function support(requested, fallback) {
  if (requested === undefined || requested === null) return fallback === true
  return requested === true
}

/** A usable characters-per-token divisor, never zero and never negative. */
function resolveDivisor(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_POLICY.charactersPerToken
}

/** A ratio as a reviewable percentage, e.g. 0.0025 -> "0.3%". */
function formatPercent(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`
}

/**
 * Estimate the tokens a piece of text costs.
 *
 * A non-string has no measurable text, so it costs nothing rather than throwing:
 * the estimate must never be negative and must never fail the caller that is only
 * trying to report a cost.
 *
 * @param {unknown} text
 * @param {number} [charactersPerToken]
 * @returns {number} a non-negative integer
 */
function estimateTokens(text, charactersPerToken = DEFAULT_POLICY.charactersPerToken) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(0, Math.ceil(text.length / resolveDivisor(charactersPerToken)))
}

/** The token cost of a number of source lines, under the cost model. */
function linesToTokens(lines, charactersPerToken) {
  const divisor = resolveDivisor(charactersPerToken)
  return Math.max(0, Math.ceil((countLines(lines) * COST_MODEL.charactersPerLine) / divisor))
}

/**
 * Decide which strategy a change is allowed to use.
 *
 * @param {object} [input]
 * @param {number} [input.changedLines]
 * @param {number} [input.fileLines]
 * @param {boolean} [input.structural] the change is a structural (AST-level) edit
 * @param {string} [input.astOperation] the AST operation that expresses it
 * @param {boolean} [input.patchSupported]
 * @param {boolean} [input.fimSupported]
 * @param {boolean} [input.astSupported]
 * @param {object} [policy] overrides for `DEFAULT_POLICY`
 * @returns {{strategy:string|null, rank:number|null, reason:string, refused:boolean}}
 */
function chooseStrategy(input = {}, policy = {}) {
  const resolved = { ...DEFAULT_POLICY, ...(policy || {}) }
  const changedLines = countLines(input.changedLines)
  const fileLines = countLines(input.fileLines)
  const ratio = changedLines / Math.max(fileLines, 1)
  const percent = formatPercent(ratio)
  const smallChange = changedLines <= countLines(resolved.smallChangeLines)
  const patchSupported = support(input.patchSupported, resolved.patchSupported)
  const fimSupported = support(input.fimSupported, resolved.fimSupported)
  const astSupported = support(input.astSupported, resolved.astSupported)
  const astOperation = input.astOperation === undefined || input.astOperation === null ? null : String(input.astOperation)

  const allowed = (strategy, reason) => ({ strategy, rank: STRATEGY_RANK.indexOf(strategy), reason, refused: false })

  // 1. A structural change: an AST operation is the cheapest and the most surgical
  //    way to express it, and it cannot disturb the rest of the file.
  if (input.structural === true && astOperation && astSupported) {
    return allowed(
      EDIT_STRATEGIES.AST_EDIT,
      `an AST edit is the cheapest option for a structural change: the "${astOperation}" operation edits one syntax tree node instead of rewriting ${fileLines} lines`
    )
  }

  // 2. A small change: a targeted patch is the preferred expression of it.
  if (smallChange && patchSupported) {
    return allowed(
      EDIT_STRATEGIES.TARGETED_PATCH,
      `a targeted patch is preferred for a change of ${changedLines} lines in a ${fileLines}-line file: only the changed lines are emitted`
    )
  }

  // 3. No patch support, but FIM is available: still far cheaper than the file.
  if (smallChange && fimSupported) {
    return allowed(
      EDIT_STRATEGIES.FIM,
      `fill-in-the-middle is preferred for a change of ${changedLines} lines: the prefix and suffix around the change are sent instead of the whole ${fileLines}-line file`
    )
  }

  // 4. A whole-file rewrite is allowed when the change is genuinely a large fraction
  //    of the file.
  if (ratio >= resolved.wholeFileRatio) {
    if (smallChange) {
      // The change covers most of a small file. That is not the failure mode this
      // policy exists for: there is no unrelated content to lose and nothing to save.
      return allowed(
        EDIT_STRATEGIES.WHOLE_FILE,
        `the change touches ${changedLines} of ${fileLines} lines (${percent}), which is a large fraction of the file; at ${fileLines} lines the file is not large, so a whole-file rewrite is allowed rather than refused`
      )
    }
    return allowed(
      EDIT_STRATEGIES.WHOLE_FILE,
      `the change touches ${changedLines} of ${fileLines} lines (${percent}), which is a large fraction of the file, so a whole-file rewrite is justified`
    )
  }

  // 5. A change too big to be small, in a file too big to rewrite for free, with no
  //    cheaper strategy: the rewrite is the only tool left, so it is allowed.
  if (!smallChange) {
    return allowed(
      EDIT_STRATEGIES.WHOLE_FILE,
      `no cheaper strategy is available and a change of ${changedLines} lines is not a small change, so a whole-file rewrite is allowed`
    )
  }

  // 6. The point of the module: a small change in a large file with nothing cheaper
  //    available is *refused*. It must never fall through to a whole-file rewrite.
  const missing = []
  if (!patchSupported) missing.push('a targeted patch is not supported')
  if (!fimSupported) missing.push('fill-in-the-middle is not supported')
  missing.push('an AST edit needs a structural operation')
  return {
    strategy: null,
    rank: null,
    refused: true,
    reason: `refusing to rewrite ${fileLines} lines to change ${changedLines}: the change is ${percent} of a large file and no cheaper strategy is available (${missing.join(', ')})`
  }
}

/** What a chosen strategy is expected to emit, in tokens. */
function estimateStrategyTokens(strategy, changedLines, fileLines, charactersPerToken) {
  if (strategy === EDIT_STRATEGIES.WHOLE_FILE) return linesToTokens(fileLines, charactersPerToken)
  if (strategy === EDIT_STRATEGIES.AST_EDIT) return COST_MODEL.astTokensPerOperation
  if (strategy === EDIT_STRATEGIES.TARGETED_PATCH) {
    return linesToTokens(changedLines * COST_MODEL.patchLinesPerChangedLine + COST_MODEL.patchContextLines, charactersPerToken)
  }
  if (strategy === EDIT_STRATEGIES.FIM) {
    return linesToTokens(changedLines * COST_MODEL.fimLinesPerChangedLine + COST_MODEL.fimContextLines, charactersPerToken)
  }
  return 0
}

/**
 * Plan one edit: the strategy, why, and what it costs against a whole-file rewrite.
 *
 * A refused plan still carries every estimate, because the number the refusal exists
 * to prevent (the cost of the rewrite) is exactly what the caller has to report.
 *
 * @param {object} [input] `chooseStrategy`'s input, plus `file`
 * @param {object} [policy]
 * @returns {object}
 */
function planEdit(input = {}, policy = {}) {
  const resolved = { ...DEFAULT_POLICY, ...(policy || {}) }
  const decision = chooseStrategy(input, policy)
  const changedLines = countLines(input.changedLines)
  const fileLines = countLines(input.fileLines)
  const wholeFileTokensEstimate = linesToTokens(fileLines, resolved.charactersPerToken)
  const outputTokensEstimate = decision.refused === true
    ? wholeFileTokensEstimate
    : estimateStrategyTokens(decision.strategy, changedLines, fileLines, resolved.charactersPerToken)
  // Savings are what the chosen strategy avoids *against the rewrite*, never a
  // negative number: a strategy that is not cheaper than the rewrite saves nothing.
  const savingsTokens = Math.max(0, wholeFileTokensEstimate - outputTokensEstimate)
  return {
    file: input.file === undefined || input.file === null ? null : String(input.file),
    strategy: decision.strategy,
    refused: decision.refused === true,
    reason: decision.reason,
    changedLines,
    fileLines,
    outputTokensEstimate,
    wholeFileTokensEstimate,
    savingsTokens,
    savingsRatio: wholeFileTokensEstimate > 0 ? Math.min(1, savingsTokens / wholeFileTokensEstimate) : 0
  }
}

module.exports = {
  EDIT_STRATEGIES,
  STRATEGY_RANK,
  DEFAULT_POLICY,
  COST_MODEL,
  chooseStrategy,
  planEdit,
  estimateTokens
}
