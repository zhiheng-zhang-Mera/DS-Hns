'use strict'

/**
 * Engineering Runtime: the bounded plan.
 *
 * An engineering episode may not start editing code. It gets a *plan* first: a
 * short, ordered list of steps, each of which is small enough to finish in minutes
 * or to park in WAITING_PROCESS, and each of which names the evidence that would
 * settle it. The plan is what makes "what is the runtime doing next, and how will
 * it know it worked?" answerable without reading a transcript.
 *
 * Four invariants shape every decision in this module.
 *
 *  1. **A repair is proven before it is attempted.** A goal that asks to fix a
 *     failing test produces a `reproduce` step *first*, and nothing patches code
 *     until that step has shown the failure. Without it there is no regression
 *     evidence: a patch that "works" is indistinguishable from a patch applied to
 *     a suite that was never failing. This ordering is a correctness property, not
 *     a presentation choice.
 *  2. **The plan is bounded.** `budget.maxSteps` caps how many steps may exist, and
 *     every dropped or degraded step is written into `reasons` rather than
 *     silently disappearing. A plan the runtime cannot explain is a plan nobody
 *     can review.
 *  3. **The cursor only moves forward, one step at a time.** `advance` refuses any
 *     step that is not the current one, because a cursor that can jump is a cursor
 *     that can skip verification. Steps a caller has already marked complete are
 *     skipped over, never re-run.
 *  4. **The step vocabulary is closed.** A step kind outside `PLAN_KINDS` cannot
 *     exist, and an operation outside `discovery.OPERATIONS` cannot be attached to
 *     a step, so a plan can only ask the supervisor for work it knows how to do.
 *
 * Nothing here is remembered across episodes: a plan is built for one goal, in one
 * repository, and is discarded with the episode that owns it.
 */

const { OPERATIONS } = require('./discovery.cjs')

/** The complete step vocabulary. A step outside this list cannot exist. */
const PLAN_KINDS = Object.freeze({
  REPRODUCE: 'reproduce',
  INSPECT: 'inspect',
  PATCH: 'patch',
  FOCUSED_TEST: 'focused-test',
  AFFECTED_TEST: 'affected-test',
  FULL_VERIFY: 'full-verify',
  BUILD: 'build',
  LINT: 'lint',
  TYPECHECK: 'typecheck',
  INSTALL: 'install',
  RUN_SERVICE: 'run-service',
  WAIT_PROCESS: 'wait-process',
  INSPECT_FAILURE: 'inspect-failure',
  REPORT: 'report'
})

const PLAN_KIND_LIST = Object.freeze(Object.values(PLAN_KINDS))

/** The kinds that name a command the supervisor must run. */
const COMMAND_KINDS = Object.freeze([
  PLAN_KINDS.REPRODUCE,
  PLAN_KINDS.FOCUSED_TEST,
  PLAN_KINDS.AFFECTED_TEST,
  PLAN_KINDS.FULL_VERIFY,
  PLAN_KINDS.BUILD,
  PLAN_KINDS.LINT,
  PLAN_KINDS.TYPECHECK,
  PLAN_KINDS.INSTALL,
  PLAN_KINDS.RUN_SERVICE
])

/** Where each kind looks for its command, in preference order. */
const KIND_COMMANDS = Object.freeze({
  [PLAN_KINDS.REPRODUCE]: ['focusedTest', 'test'],
  [PLAN_KINDS.FOCUSED_TEST]: ['focusedTest', 'test'],
  [PLAN_KINDS.AFFECTED_TEST]: ['test', 'focusedTest'],
  [PLAN_KINDS.FULL_VERIFY]: ['test', 'focusedTest'],
  [PLAN_KINDS.BUILD]: ['build'],
  [PLAN_KINDS.LINT]: ['lint'],
  [PLAN_KINDS.TYPECHECK]: ['typecheck'],
  [PLAN_KINDS.INSTALL]: ['install'],
  [PLAN_KINDS.RUN_SERVICE]: ['run']
})

const DEFAULT_MAX_STEPS = 40
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_SERVICE_TIMEOUT_MS = 2 * 60_000

/** The verbs a goal may use, and the intent each one selects. */
const INTENT_KEYWORDS = Object.freeze([
  { intent: 'fix', pattern: /\b(fix|fixes|fixing|bug|bugs|broken|failing|failure|fails?|regression|debug|repair)\b/i },
  { intent: 'dependency', pattern: /\b(dependenc(?:y|ies)|upgrade|bump|update the? (?:package|version)|migrate (?:to )?v?\d)/i },
  { intent: 'refactor', pattern: /\b(refactor|clean ?up|restructure|extract|rename|tidy|de-?duplicate)\b/i },
  { intent: 'build', pattern: /\b(build|compile|bundle|ship|package the)\b/i }
])

/** The phrase that marks an explicit request to see the failure first. */
const REPRODUCE_PHRASE = /failing test|reproduce|repro\b/i

/** One-line descriptions per kind, so a step is readable without its data. */
const KIND_DESCRIPTIONS = Object.freeze({
  [PLAN_KINDS.REPRODUCE]: 'Show the failing test failing before anything is patched',
  [PLAN_KINDS.INSPECT]: 'Read the code and the failure evidence that the patch will touch',
  [PLAN_KINDS.PATCH]: 'Change the code that the evidence points at',
  [PLAN_KINDS.FOCUSED_TEST]: 'Re-run the single test that must now pass',
  [PLAN_KINDS.AFFECTED_TEST]: 'Run every test the change can reach',
  [PLAN_KINDS.FULL_VERIFY]: 'Run the repository acceptance command on the final tree',
  [PLAN_KINDS.BUILD]: 'Build the project',
  [PLAN_KINDS.LINT]: 'Lint the changed code',
  [PLAN_KINDS.TYPECHECK]: 'Typecheck the project',
  [PLAN_KINDS.INSTALL]: 'Install or refresh dependencies',
  [PLAN_KINDS.RUN_SERVICE]: 'Start the service the verification needs',
  [PLAN_KINDS.WAIT_PROCESS]: 'Wait for an owned process to finish',
  [PLAN_KINDS.INSPECT_FAILURE]: 'Read one real failure and classify it',
  [PLAN_KINDS.REPORT]: 'Report the outcome with the evidence that settles it'
})

/** What "done" means per kind, when the caller does not say. */
const KIND_EXPECTS = Object.freeze({
  /**
   * A reproduce step wants the failure: it is done when the command did *not*
   * exit zero, which is the opposite of every other test step.
   */
  [PLAN_KINDS.REPRODUCE]: {
    failurePresent: true,
    description: 'the command must fail, or there is no failure to fix'
  },
  [PLAN_KINDS.FOCUSED_TEST]: { exitCode: 0, testCount: { failed: 0 } },
  [PLAN_KINDS.AFFECTED_TEST]: { exitCode: 0, testCount: { failed: 0 } },
  [PLAN_KINDS.FULL_VERIFY]: { exitCode: 0, testCount: { failed: 0 } }
})

/** What each kind records when it finishes. */
const KIND_EVIDENCE = Object.freeze({
  [PLAN_KINDS.REPRODUCE]: ['failing-test-output', 'exit-code'],
  [PLAN_KINDS.INSPECT]: ['files-read', 'failure-class'],
  [PLAN_KINDS.PATCH]: ['mutation-log', 'changed-files'],
  [PLAN_KINDS.FOCUSED_TEST]: ['test-summary', 'exit-code', 'duration'],
  [PLAN_KINDS.AFFECTED_TEST]: ['test-summary', 'exit-code', 'duration'],
  [PLAN_KINDS.FULL_VERIFY]: ['test-summary', 'exit-code', 'duration', 'command'],
  [PLAN_KINDS.BUILD]: ['exit-code', 'output-tail'],
  [PLAN_KINDS.LINT]: ['exit-code', 'output-tail'],
  [PLAN_KINDS.TYPECHECK]: ['exit-code', 'output-tail'],
  [PLAN_KINDS.INSTALL]: ['exit-code', 'output-tail'],
  [PLAN_KINDS.RUN_SERVICE]: ['process-id', 'readiness'],
  [PLAN_KINDS.WAIT_PROCESS]: ['exit-code', 'output-tail'],
  [PLAN_KINDS.INSPECT_FAILURE]: ['failure-class', 'output-tail'],
  [PLAN_KINDS.REPORT]: ['summary', 'evidence']
})

/** The intent templates. Each entry is ordered: the order *is* the plan. */
const TEMPLATES = Object.freeze({
  fix: [
    { kind: PLAN_KINDS.REPRODUCE },
    { kind: PLAN_KINDS.INSPECT },
    { kind: PLAN_KINDS.PATCH },
    { kind: PLAN_KINDS.FOCUSED_TEST },
    { kind: PLAN_KINDS.AFFECTED_TEST },
    { kind: PLAN_KINDS.FULL_VERIFY }
  ],
  build: [
    { kind: PLAN_KINDS.INSPECT },
    { kind: PLAN_KINDS.LINT },
    { kind: PLAN_KINDS.TYPECHECK },
    { kind: PLAN_KINDS.BUILD },
    { kind: PLAN_KINDS.AFFECTED_TEST },
    { kind: PLAN_KINDS.FULL_VERIFY }
  ],
  refactor: [
    { kind: PLAN_KINDS.INSPECT },
    { kind: PLAN_KINDS.PATCH },
    { kind: PLAN_KINDS.AFFECTED_TEST },
    { kind: PLAN_KINDS.FULL_VERIFY }
  ],
  dependency: [
    { kind: PLAN_KINDS.INSTALL },
    { kind: PLAN_KINDS.BUILD },
    { kind: PLAN_KINDS.AFFECTED_TEST },
    { kind: PLAN_KINDS.FULL_VERIFY }
  ],
  generic: [
    { kind: PLAN_KINDS.INSPECT },
    { kind: PLAN_KINDS.PATCH },
    { kind: PLAN_KINDS.AFFECTED_TEST },
    { kind: PLAN_KINDS.FULL_VERIFY }
  ]
})

/**
 * Read the caller's intent out of the goal text.
 *
 * The goal is a sentence, not a schema, so the intent is inferred — and the
 * inference is what selects the template whose *order* protects the invariants
 * above. `inputs.steps` overrides this entirely: an explicit plan is the
 * contract's own plan and is never second-guessed.
 *
 * @param {string} goal
 * @returns {'fix'|'dependency'|'refactor'|'build'|'generic'}
 */
function classifyIntent(goal) {
  const text = String(goal || '')
  for (const entry of INTENT_KEYWORDS) {
    if (entry.pattern.test(text)) return entry.intent
  }
  return 'generic'
}

/** Pick the command for one kind out of the discovery command table. */
function commandForKind(kind, commands) {
  const table = commands && typeof commands === 'object' ? commands : {}
  const candidates = KIND_COMMANDS[kind] || []
  for (const operation of candidates) {
    if (table[operation]) return { operation, command: table[operation] }
  }
  return null
}

/**
 * Split a command string into its executable and its arguments.
 *
 * A discovered command is written the way a human writes it in a README, so the
 * quoted segments are respected rather than split on every space. When the string
 * has no quoting, the executable goes to `command` and the rest to `args`, which is
 * exactly what the supervisor's `start()` expects.
 *
 * @param {string} text
 * @returns {{command:string, args:string[]}}
 */
function splitCommand(text) {
  const source = String(text || '').trim()
  if (!source) return { command: '', args: [] }
  const tokens = []
  let current = ''
  let quote = null
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  if (!tokens.length) return { command: source, args: [] }
  return { command: tokens[0], args: tokens.slice(1) }
}

/** A stable identity for one step: where it came from and what it does. */
function stepIdFor(kind, source, sequence) {
  return `${source}:${kind}:${sequence}`
}

/**
 * Arguments the caller wrote as one string.
 *
 * The executable is dropped: a step's `command` is the executable, so
 * `args: '--test one.test.js'` means two arguments, not a second command.
 */
function argsFromText(value) {
  const parsed = splitCommand(String(value === undefined || value === null ? '' : value))
  return parsed.command ? [parsed.command, ...parsed.args] : []
}

/**
 * Where a step's arguments come from when the caller does not supply any.
 *
 * A step that names its own command still inherits the discovered arguments of
 * its operation — `{ kind: 'focused-test', command: 'node' }` becomes
 * `node --test <focus>` — because the discovery's arguments describe *what* the
 * operation runs, not which executable happens to be first.
 */
function inheritedArgs(explicitCommand, operation, split, command) {
  if (explicitCommand && operation && command && Array.isArray(command.args)) return command.args.map(String)
  return split.args
}

/**
 * A step may not outlive the episode it belongs to.
 *
 * The episode's deadline band decides when only the final verification is still
 * allowed, and a step that carries a thirty-minute default inside a sixty-second
 * episode would spend the whole budget in the `full` band and never reach it. The
 * step's bound is therefore clamped to the episode budget the contract declares.
 *
 * @param {number} timeoutMs
 * @param {number} [deadlineMs]
 * @returns {number}
 */
function capToDeadline(timeoutMs, deadlineMs) {
  const bound = Number(timeoutMs)
  if (!Number.isFinite(bound) || bound <= 0) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(deadlineMs) || Number(deadlineMs) <= 0) return bound
  return Math.min(bound, Number(deadlineMs))
}

/**
 * Validate a `expects` object.
 *
 * A step's "done" condition is data, and data the runtime cannot evaluate is
 * worthless, so an unusable condition is reported rather than assumed: the caller
 * is told to fall back to the exit code.
 *
 * @param {object} expects
 * @returns {{ok:boolean, expects:object|null, reason:string|null}}
 */
function validateExpects(expects) {
  if (expects === undefined || expects === null) return { ok: true, expects: null, reason: null }
  if (typeof expects !== 'object' || Array.isArray(expects)) {
    return { ok: false, expects: null, reason: 'expects must be an object' }
  }
  const normalized = {}
  if (expects.exitCode !== undefined && expects.exitCode !== null) {
    if (!Number.isInteger(expects.exitCode)) return { ok: false, expects: null, reason: 'expects.exitCode must be an integer' }
    normalized.exitCode = expects.exitCode
  }
  if (expects.failurePresent !== undefined && expects.failurePresent !== null) {
    if (typeof expects.failurePresent !== 'boolean') return { ok: false, expects: null, reason: 'expects.failurePresent must be a boolean' }
    normalized.failurePresent = expects.failurePresent
  }
  if (expects.testCount !== undefined && expects.testCount !== null) {
    const count = expects.testCount
    if (typeof count !== 'object' || Array.isArray(count)) return { ok: false, expects: null, reason: 'expects.testCount must be an object' }
    normalized.testCount = {}
    for (const key of ['failed', 'passed', 'tests']) {
      const value = count[key]
      if (value === undefined || value === null) continue
      if (!Number.isInteger(value)) return { ok: false, expects: null, reason: `expects.testCount.${key} must be an integer` }
      normalized.testCount[key] = value
    }
  }
  if (!Object.keys(normalized).length) return { ok: false, expects: null, reason: 'expects names no usable condition' }
  return { ok: true, expects: normalized, reason: null }
}

/**
 * Normalize one step into the single shape a plan carries.
 *
 * @param {object} input
 * @param {string} input.kind one of PLAN_KINDS
 * @param {object} [input.commands] the discovery command table
 * @param {string} [input.source] where the step came from (`template` or `contract`)
 * @param {number} [input.sequence]
 * @returns {{ok:boolean, step:object|null, reasons:string[]}}
 */
function normalizeStep(input = {}) {
  const reasons = []
  const kind = String(input.kind || '')
  if (!PLAN_KIND_LIST.includes(kind)) {
    return { ok: false, step: null, reasons: [`"${kind}" is not a step kind this runtime can execute`] }
  }
  const source = input.source ? String(input.source) : 'template'
  const sequence = Number.isInteger(input.sequence) ? input.sequence : 1
  const needsCommand = COMMAND_KINDS.includes(kind)
  const resolved = needsCommand ? commandForKind(kind, input.commands) : null
  const explicitCommand = typeof input.command === 'string' && input.command.trim() ? input.command : null
  const command = resolved ? resolved.command : null
  const operation = resolved ? resolved.operation : null

  // A command-bearing kind with neither a discovered command nor a command the
  // caller supplied cannot run. The runtime does not invent one: it refuses the
  // step and records why.
  if (needsCommand && !operation && !explicitCommand) {
    return { ok: false, step: null, reasons: [`the ${kind} step needs the ${(KIND_COMMANDS[kind] || []).join(' or ')} command, and discovery provided none`] }
  }

  const explicitOperation = input.operation === undefined || input.operation === null ? null : String(input.operation)
  if (explicitOperation !== null && !OPERATIONS.includes(explicitOperation)) {
    return { ok: false, step: null, reasons: [`"${explicitOperation}" is not an operation the supervisor can run`] }
  }

  const split = explicitCommand
    ? splitCommand(explicitCommand)
    : command
      ? { command: command.command, args: Array.isArray(command.args) ? command.args.map(String) : [] }
      : { command: '', args: [] }

  // The arguments come from the caller when the caller supplies any; otherwise a
  // command the caller named still inherits its operation's discovered arguments,
  // so a focus can be appended to them.
  let args = inheritedArgs(explicitCommand, operation, split, command)
  if (input.args !== undefined && input.args !== null) {
    args = Array.isArray(input.args) ? input.args.map(String) : argsFromText(input.args)
  } else if (input.focus) {
    args = [...args, String(input.focus)]
  }

  const expectsVerdict = validateExpects(input.expects === undefined ? KIND_EXPECTS[kind] || { exitCode: 0 } : input.expects)
  if (!expectsVerdict.ok) reasons.push(`${kind}: ${expectsVerdict.reason}; falling back to the exit code`)
  const expects = expectsVerdict.expects || { exitCode: 0 }

  const timeoutDefault = kind === PLAN_KINDS.RUN_SERVICE ? DEFAULT_SERVICE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  const fromCommand = command && Number.isFinite(command.timeoutMs) ? Number(command.timeoutMs) : null
  const timeoutMs = capToDeadline(Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : fromCommand || timeoutDefault, input.deadlineMs)

  const cwd = input.cwd ? String(input.cwd) : command && command.cwd ? String(command.cwd) : null
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map(String)
    : typeof input.evidence === 'string'
      ? [input.evidence]
      : (KIND_EVIDENCE[kind] || []).slice()

  return {
    ok: true,
    reasons,
    step: {
      id: input.id ? String(input.id) : stepIdFor(kind, source, sequence),
      kind,
      description: input.description ? String(input.description) : KIND_DESCRIPTIONS[kind] || kind,
      operation,
      command: split.command || (command ? command.command : null),
      args,
      cwd,
      expects,
      timeoutMs,
      evidence,
      optional: input.optional === true,
      source,
      /** Where the command came from, so an inferred command stays explainable. */
      commandEvidence: command && command.evidence ? String(command.evidence) : null,
      confidence: command && command.confidence ? String(command.confidence) : null
    }
  }
}

/**
 * Evaluate one `expects` object against a step outcome.
 *
 * @param {object} expects
 * @param {object} [input]
 * @param {number|null} [input.exitCode]
 * @param {boolean} [input.timedOut]
 * @param {boolean} [input.failurePresent] whether a failure was observed
 * @param {object|null} [input.testCount]
 * @returns {{ok:boolean, reason:string}}
 */
function expectsMet(expects, input = {}) {
  if (!expects || typeof expects !== 'object') return { ok: true, reason: 'the step declares no expectation' }
  if (Number.isInteger(expects.exitCode) && input.exitCode !== expects.exitCode) {
    return { ok: false, reason: `expected exit code ${expects.exitCode}, observed ${input.exitCode === null || input.exitCode === undefined ? 'none' : input.exitCode}` }
  }
  if (expects.failurePresent === true) {
    // The only step whose success is a failure: a reproduce step that exits zero
    // has shown nothing, because there was nothing failing to show.
    const observed = input.failurePresent === true || input.timedOut === true || (Number.isInteger(input.exitCode) && input.exitCode !== 0)
    if (!observed) return { ok: false, reason: 'expected the failure to reproduce, and the command exited 0' }
  }
  if (expects.failurePresent === false && (input.failurePresent === true || input.timedOut === true)) {
    return { ok: false, reason: 'expected no failure, and the step failed' }
  }
  const counts = expects.testCount
  if (counts && typeof counts === 'object') {
    const summary = input.testCount || null
    if (!summary) return { ok: false, reason: 'the step expects a test count, and the output carried no parseable summary' }
    for (const key of Object.keys(counts)) {
      if (summary[key] !== counts[key]) {
        return { ok: false, reason: `expected ${key}=${counts[key]}, observed ${summary[key] === null || summary[key] === undefined ? 'none' : summary[key]}` }
      }
    }
  }
  return { ok: true, reason: 'the step met its expectation' }
}

/**
 * Build the bounded plan one episode executes.
 *
 * @param {object} input
 * @param {string} input.goal the engineering goal, in the caller's words
 * @param {object} [input.discovery] the discovery record (`commands`, `root`, …)
 * @param {object} [input.contract] the execution contract (`maxSteps`, `commands`, …)
 * @param {object} [input.baseline] the pre-episode repository snapshot
 * @param {object} [input.inputs] `{ steps?, focus? }` — explicit steps always win
 * @param {Function} [input.now]
 * @param {string} [input.id]
 * @returns {{id:string, goal:string, createdAt:number, steps:object[], cursor:number, budget:object, reasons:string[], completed:object[], optionalFailures:object[], markedComplete:Function, isComplete:Function, advance:Function, nextStep:Function, optionalFailed:Function, stepById:Function, outcomeOf:Function, progress:Function, evidence:Function, expectsMet:Function, toJSON:Function}}
 */
function buildPlan(input = {}) {
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const goal = String(input.goal || '')
  const discovery = input.discovery || {}
  const commands = discovery.commands || {}
  const contract = input.contract && typeof input.contract === 'object' ? input.contract : {}
  const explicit = input.inputs && Array.isArray(input.inputs.steps) ? input.inputs.steps : null
  const contractMax = Number.isInteger(contract.maxSteps) && contract.maxSteps > 0 ? contract.maxSteps : null
  const requestedMax = Number.isInteger(input.maxSteps) && input.maxSteps > 0 ? input.maxSteps : contractMax || DEFAULT_MAX_STEPS
  const budget = { maxSteps: requestedMax }
  /** The episode's own deadline, so no step can outlive the episode. */
  const deadlineMs = Number.isFinite(contract.deadlineMs) && Number(contract.deadlineMs) > 0 ? Number(contract.deadlineMs) : null
  const reasons = []
  const steps = []

  if (!goal.trim() && !explicit) {
    reasons.push('the plan was given neither a goal nor explicit steps')
  }

  let intent
  if (explicit) {
    intent = 'contract'
  } else {
    // A goal that literally asks for the failing test to be shown selects the
    // repair template even when the surrounding wording is something else.
    intent = REPRODUCE_PHRASE.test(goal) ? 'fix' : classifyIntent(goal)
  }

  const source = explicit ? 'contract' : 'template'
  const template = explicit || TEMPLATES[intent] || TEMPLATES.generic
  const focus = input.inputs && input.inputs.focus ? String(input.inputs.focus) : null
  let skipped = 0

  for (const entry of template) {
    if (steps.length >= budget.maxSteps) {
      skipped += 1
      reasons.push(`the plan is bounded at ${budget.maxSteps} steps; ${skipped} further step(s) were dropped`)
      break
    }
    // The entry is copied before normalization: resolving a template step must
    // never write back into the frozen template the next plan is built from.
    const raw = { ...entry }
    const normalized = normalizeStep({
      ...raw,
      commands,
      source,
      sequence: steps.length + 1,
      deadlineMs,
      focus: focus && (raw.kind === PLAN_KINDS.REPRODUCE || raw.kind === PLAN_KINDS.FOCUSED_TEST) ? focus : raw.focus
    })
    if (!normalized.ok) {
      reasons.push(`${raw.kind || 'unnamed'}: ${normalized.reasons.join('; ')}`)
      continue
    }
    for (const reason of normalized.reasons) reasons.push(`${normalized.step.kind}: ${reason}`)
    steps.push(normalized.step)
  }

  if (!explicit) {
    if (steps.length === 0) {
      reasons.push(`no step of the ${intent} plan could be built from the discovered commands`)
    }
    if (intent === 'fix' && !steps.some((step) => step.kind === PLAN_KINDS.REPRODUCE)) {
      reasons.push('a repair without a reproduce step has no regression evidence: no test command was discovered to show the failure first')
    }
  } else if (intent === 'contract' && classifyIntent(goal) === 'fix' && !steps.some((step) => step.kind === PLAN_KINDS.REPRODUCE)) {
    // The contract's own plan always wins; the missing regression evidence is
    // recorded rather than corrected behind the caller's back.
    reasons.push('the explicit plan is a repair but names no reproduce step, so the failure will not be shown before the patch')
  }

  /**
   * The settled steps, most recent last, bounded at `maxSteps * 2`.
   *
   * The bound is what keeps a long repair loop from growing a transcript, and the
   * id set beside it is what keeps the *cursor* correct independently of the
   * bound: a step that has aged out of the array is still complete.
   */
  const completed = []
  const completedIds = new Set()
  const completionById = new Map()
  const optionalFailures = []
  const completionCap = budget.maxSteps * 2

  function boundedPush(list, entry) {
    list.push(entry)
    if (list.length > completionCap) list.splice(0, list.length - completionCap)
    return entry
  }

  function isComplete(stepId) {
    return completedIds.has(stepId)
  }

  function markedComplete(stepId) {
    const step = steps.find((candidate) => candidate.id === stepId)
    if (!step) return { ok: false, reason: `no step ${stepId}`, step: null }
    if (isComplete(stepId)) return { ok: true, reason: 'the step was already complete', step }
    completedIds.add(stepId)
    const record = { id: step.id, kind: step.kind, at: now(), resumed: true }
    completionById.set(stepId, record)
    boundedPush(completed, record)
    return { ok: true, reason: 'the step is marked complete', step }
  }

  /**
   * The step to execute now.
   *
   * Steps already marked complete — including the ones a resumed episode marked
   * before the crash — are skipped over rather than re-run. The cursor only ever
   * moves forward.
   */
  function nextStep() {
    while (plan.cursor < steps.length) {
      const candidate = steps[plan.cursor]
      const failedOptional = optionalFailures.some((entry) => entry.id === candidate.id)
      if (isComplete(candidate.id) || failedOptional) {
        plan.cursor += 1
        continue
      }
      return candidate
    }
    return null
  }

  /**
   * Settle the current step and move past it.
   *
   * Refusing a non-current step is the point: a cursor that can jump is a cursor
   * that can run a focused test and then declare the full suite verified.
   */
  function advance(stepId, outcome = {}) {
    const step = steps.find((candidate) => candidate.id === stepId)
    if (!step) return { ok: false, reason: `no step ${stepId}`, cursor: plan.cursor }
    if (isComplete(stepId)) return { ok: false, reason: `the step ${stepId} was already settled`, cursor: plan.cursor }
    const current = steps[plan.cursor]
    if (!current || current.id !== stepId) {
      return {
        ok: false,
        reason: `only the current step may be advanced: the cursor is at ${current ? current.id : 'the end of the plan'}`,
        cursor: plan.cursor,
        current: current ? current.id : null
      }
    }
    const engineOutcome = {
      ok: outcome.ok === true,
      at: now(),
      evidence: outcome.evidence === undefined ? null : outcome.evidence,
      failure: outcome.failure === undefined ? null : outcome.failure,
      durationMs: Number.isFinite(outcome.durationMs) ? Number(outcome.durationMs) : null
    }
    const record = {
      id: step.id,
      kind: step.kind,
      operation: step.operation,
      command: step.command,
      outcome: engineOutcome,
      at: engineOutcome.at,
      evidence: engineOutcome.evidence === null ? step.evidence : engineOutcome.evidence,
      failure: engineOutcome.failure
    }
    completedIds.add(stepId)
    completionById.set(stepId, record)
    boundedPush(completed, record)
    plan.cursor += 1
    return { ok: true, step, outcome: engineOutcome, cursor: plan.cursor, remaining: steps.length - plan.cursor }
  }

  /**
   * Record that an optional step failed, so the supervisor may continue past it.
   *
   * The cursor never moves backwards here: the failure is a fact about the plan,
   * not a reason to revisit a step that already ran.
   */
  function optionalFailed(stepId, reason = null) {
    const step = steps.find((candidate) => candidate.id === stepId)
    if (!step) return { ok: false, reason: `no step ${stepId}` }
    if (step.optional !== true) return { ok: false, reason: `the step ${stepId} is not optional, so its failure cannot be skipped` }
    if (optionalFailures.some((entry) => entry.id === stepId)) return { ok: false, reason: `the step ${stepId} already has a recorded failure` }
    const record = { id: stepId, kind: step.kind, reason: reason === null || reason === undefined ? 'the optional step failed' : String(reason), at: now() }
    optionalFailures.push(record)
    if (optionalFailures.length > completionCap) optionalFailures.splice(0, optionalFailures.length - completionCap)
    if (steps[plan.cursor] && steps[plan.cursor].id === stepId) plan.cursor += 1
    return { ok: true, step, failure: record, cursor: plan.cursor }
  }

  function stepById(stepId) {
    return steps.find((candidate) => candidate.id === stepId) || null
  }

  function verifiedStepIds() {
    return steps.filter((step) => {
      const saved = completionById.get(step.id)
      return Boolean(saved && saved.outcome && saved.outcome.ok === true)
    }).map((step) => step.id)
  }

  function skippedStepIds() {
    return optionalFailures.map((entry) => entry.id)
  }

  function restoreState(snapshot, cursor) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.steps) || !cursor || typeof cursor !== 'object') {
      return { ok: false, reason: 'a serialized plan and recovery cursor are required' }
    }
    steps.splice(0, steps.length, ...snapshot.steps.map((step) => JSON.parse(JSON.stringify(step))))
    plan.id = String(snapshot.id)
    plan.goal = String(snapshot.goal)
    plan.intent = String(snapshot.intent)
    plan.createdAt = snapshot.createdAt
    budget.maxSteps = snapshot.budget.maxSteps
    reasons.splice(0, reasons.length, ...snapshot.reasons)
    for (const stepId of cursor.verifiedStepIds) {
      const result = markedComplete(stepId)
      if (!result.ok) return result
      const saved = completionById.get(stepId)
      saved.outcome = { ok: true, resumed: true }
    }
    for (const stepId of cursor.skippedStepIds) {
      const step = steps.find((candidate) => candidate.id === stepId)
      if (!step || step.optional !== true) return { ok: false, reason: `only an optional step may be restored as skipped: ${stepId}` }
      optionalFailures.push({ id: stepId, kind: step.kind, reason: 'restored from a checkpointed optional skip', at: now() })
    }
    plan.cursor = cursor.nextStepIndex
    return { ok: true, plan }
  }

  /** The recorded completion of one step, or null. */
  function outcomeOf(stepId) {
    return completionById.get(stepId) || null
  }

  /** How far the plan has got, and what it has to show for it. */
  function progress() {
    const settled = completed.length
    return {
      steps: steps.length,
      settled: completedIds.size,
      cursor: plan.cursor,
      current: steps[plan.cursor] ? steps[plan.cursor].id : null,
      remaining: Math.max(0, steps.length - plan.cursor),
      optionalFailures: optionalFailures.length,
      budget: { ...budget },
      reasons: reasons.slice(),
      complete: plan.cursor >= steps.length && steps.length > 0
    }
  }

  /** Every piece of evidence the settled steps recorded. */
  function evidence() {
    return completed.filter((entry) => entry.evidence !== null && entry.evidence !== undefined).map((entry) => ({ id: entry.id, kind: entry.kind, at: entry.at, evidence: entry.evidence }))
  }

  const plan = {
    id: input.id ? String(input.id) : `plan:${steps.length}:${intent}`,
    goal,
    intent,
    createdAt: now(),
    steps,
    cursor: 0,
    budget,
    /** The episode budget the steps were clamped to, when the contract declared one. */
    deadlineMs,
    reasons,
    completed,
    optionalFailures,
    /** Mark a step complete without executing it (a resumed episode). */
    markedComplete,
    /** Is this step settled? */
    isComplete,
    advance,
    nextStep,
    optionalFailed,
    stepById,
    outcomeOf,
    verifiedStepIds,
    skippedStepIds,
    restoreState,
    progress,
    evidence,
    expectsMet,
    toJSON() {
      return {
        id: plan.id,
        goal: plan.goal,
        intent: plan.intent,
        createdAt: plan.createdAt,
        steps: plan.steps.map((step) => ({ ...step })),
        cursor: plan.cursor,
        budget: { ...plan.budget },
        reasons: reasons.slice(),
        progress: progress()
      }
    }
  }

  return plan
}

/**
 * The step at the plan's cursor, skipping anything already settled.
 *
 * Exported as a function as well as a method because the supervisor reads better
 * as `nextStep(plan)` than as `plan.nextStep()`, and both must ask the same
 * question of the same cursor.
 *
 * @param {object} plan
 * @returns {object|null}
 */
function nextStep(plan) {
  if (!plan || typeof plan.nextStep !== 'function') return null
  return plan.nextStep()
}

/** Rehydrate the exact saved plan without re-discovery or command normalization. */
function restorePlan(input = {}) {
  const snapshot = input.plan
  const cursor = input.cursor
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1 ||
    typeof snapshot.id !== 'string' || !snapshot.id || typeof snapshot.goal !== 'string' ||
    typeof snapshot.intent !== 'string' || !Number.isFinite(snapshot.createdAt) ||
    !Array.isArray(snapshot.steps) || snapshot.steps.length > 1000 ||
    !snapshot.budget || !Number.isInteger(snapshot.budget.maxSteps) || snapshot.budget.maxSteps < snapshot.steps.length ||
    !Array.isArray(snapshot.reasons) || snapshot.reasons.some((reason) => typeof reason !== 'string')) {
    return { ok: false, code: 'PLAN_INVALID', reason: 'the saved plan is not a supported complete plan descriptor' }
  }
  if (!cursor || typeof cursor !== 'object' || !Number.isInteger(cursor.nextStepIndex) ||
    cursor.nextStepIndex < 0 || cursor.nextStepIndex > snapshot.steps.length ||
    !Array.isArray(cursor.verifiedStepIds) || !Array.isArray(cursor.skippedStepIds)) {
    return { ok: false, code: 'CURSOR_INVALID', reason: 'the saved plan cursor is malformed' }
  }

  const ids = new Set()
  for (const step of snapshot.steps) {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !step.id || ids.has(step.id) ||
      !PLAN_KIND_LIST.includes(step.kind) ||
      (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== 'string')))) {
      return { ok: false, code: 'PLAN_STEP_INVALID', reason: 'a saved step is malformed or uses an unsupported kind' }
    }
    ids.add(step.id)
  }
  for (const field of ['verifiedStepIds', 'skippedStepIds']) {
    const values = cursor[field]
    if (values.some((id) => typeof id !== 'string' || !ids.has(id)) || new Set(values).size !== values.length) {
      return { ok: false, code: 'CURSOR_INVALID', reason: `${field} contains an unknown or duplicate step id` }
    }
  }
  const verified = new Set(cursor.verifiedStepIds)
  const skipped = new Set(cursor.skippedStepIds)
  if ([...verified].some((id) => skipped.has(id))) return { ok: false, code: 'CURSOR_INVALID', reason: 'a saved step cannot be both verified and skipped' }
  let safeNext = 0
  while (safeNext < snapshot.steps.length) {
    const id = snapshot.steps[safeNext].id
    if (!verified.has(id) && !skipped.has(id)) break
    safeNext += 1
  }
  if (cursor.nextStepIndex !== safeNext) return { ok: false, code: 'CURSOR_UNVERIFIED', reason: 'the saved cursor skips a step without verified evidence' }
  const last = cursor.lastVerifiedStepId
  const expectedLast = snapshot.steps.slice(0, safeNext).map((step) => step.id).reverse().find((id) => verified.has(id)) || null
  if (last !== expectedLast) {
    return { ok: false, code: 'CURSOR_INVALID', reason: 'lastVerifiedStepId does not name a verified step before the cursor' }
  }
  if (cursor.skippedStepIds.some((id) => snapshot.steps.find((step) => step.id === id).optional !== true)) {
    return { ok: false, code: 'CURSOR_INVALID', reason: 'only optional steps may be restored as skipped' }
  }

  const plan = buildPlan({ goal: '', inputs: { steps: [] }, maxSteps: snapshot.budget.maxSteps })
  return plan.restoreState(snapshot, cursor)
}

/**
 * Settle the plan's current step with its outcome.
 *
 * @param {object} plan
 * @param {string} stepId
 * @param {{ok:boolean, evidence?:*, failure?:*}} [outcome]
 * @returns {{ok:boolean, reason?:string, step?:object, cursor?:number}}
 */
function advance(plan, stepId, outcome = {}) {
  if (!plan || typeof plan.advance !== 'function') return { ok: false, reason: 'there is no plan to advance' }
  return plan.advance(stepId, outcome)
}

module.exports = {
  PLAN_KINDS,
  PLAN_KIND_LIST,
  COMMAND_KINDS,
  INTENT_KEYWORDS,
  TEMPLATES,
  KIND_EXPECTS,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  buildPlan,
  restorePlan,
  nextStep,
  advance,
  normalizeStep,
  validateExpects,
  expectsMet,
  classifyIntent,
  commandForKind,
  splitCommand,
  argsFromText,
  capToDeadline
}
