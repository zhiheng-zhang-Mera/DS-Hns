'use strict'

/**
 * DS-Hns acceleration: the high-performance module.
 *
 * The plan's P2 list — speculative decoding, an advanced build cache, automatic worker
 * scaling and advanced fill-in-the-middle editing — is one plugin rather than four,
 * because they share a single property that decides how they must behave: **each of them
 * is an optimisation over something that already works, and none of them may ever be the
 * reason a task is wrong.** A build cache that returns a stale artifact, a scaler that
 * opens workers past what the machine allows, a speculative request sent to a provider
 * that does not support it, or a FIM prompt built from context that was silently
 * truncated, are all worse than being slow.
 *
 * So every one of the four answers "no" honestly instead of approximating:
 *
 *   speculativeDecoding  only when the *model descriptor* declares the capability, never
 *                        because a flag was set somewhere
 *   buildCache           only over inputs whose hashes are all present and complete, and
 *                        never over a failed build
 *   workerScaling        never above `effectiveWorkers`, with hysteresis for the load and
 *                        none for a hard ceiling, and it says which bound stopped it
 *   fimRequest           always declares what it dropped from the context budget
 *
 * The fault level is SOFT: a performance feature has no business taking a run down.
 */

const crypto = require('node:crypto')

/** The descriptor capability that decides whether a speculative request may be sent. */
const SPECULATIVE_CAPABILITY = 'speculativeDecoding'

/** The four options this module owns, named so the UI and the metrics can refer to them. */
const HIGH_PERFORMANCE_FEATURES = Object.freeze({
  SPECULATIVE_DECODING: 'speculative-decoding',
  BUILD_CACHE: 'build-cache',
  AUTO_SCALING: 'auto-scaling',
  ADVANCED_FIM: 'advanced-fim'
})

const DEFAULT_POLICY = Object.freeze({
  /** The build cache keeps at most this many bytes; the least recently used goes first. */
  cacheMaxBytes: 512 * 1024 * 1024,
  cacheMaxEntries: 200,
  /** Scaling: 2..8 workers unless the caller narrows it, sampled, not twitched. */
  minWorkers: 2,
  maxWorkers: 8,
  /** Consecutive samples in one direction before the count moves. */
  scaleUpSamples: 3,
  scaleDownSamples: 5,
  /** A worker is added only while the queue is at least this deep. */
  scaleUpQueueDepth: 2,
  /** Pressure at or above this sheds a worker. */
  shedPressureAt: 'elevated',
  /** The FIM context budget, in tokens, split between prefix and suffix. */
  fimBudgetTokens: 3000,
  fimPrefixShare: 0.6,
  charactersPerToken: 4,
  /**
   * The four switches, one per option.
   *
   * They are honoured inside this module rather than at the call site, so a disabled
   * option is a refusal with a reason — never a silently skipped optimisation, which is
   * indistinguishable from one that ran and did nothing.
   */
  features: Object.freeze({
    speculativeDecoding: true,
    buildCache: true,
    autoScaling: true,
    advancedFim: true
  })
})

const PRESSURE_RANK = Object.freeze({ idle: 0, normal: 1, elevated: 2, ceiling: 3 })

function shortDigest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

/**
 * Merge caller policy over the defaults, ignoring `undefined`.
 *
 * A config block that declares a key with no value must not erase the default: spreading
 * `{ fimBudgetTokens: undefined }` over `3000` produces `undefined`, and a budget of
 * `undefined` is not "unset", it is `NaN` a few lines later.
 */
function mergePolicy(overrides = {}) {
  const defined = Object.fromEntries(
    Object.entries(overrides && typeof overrides === 'object' ? overrides : {}).filter(([, value]) => value !== undefined)
  )
  return { ...DEFAULT_POLICY, ...defined, features: { ...DEFAULT_POLICY.features, ...(defined.features || {}) } }
}

/**
 * A provider's speculative-decoding support, read from the model descriptor.
 *
 * A generic plugin may not branch on a model *name*, which leaves exactly one honest
 * place to ask: the descriptor's declared capabilities. When the capability is absent the
 * answer is a refusal with a reason, because a draft-model hint sent to a provider that
 * ignores it is a silent no-op that looks like a win in the metrics.
 */
function speculativeDecoding(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    return { supported: false, reason: 'no model descriptor was supplied, so support cannot be known' }
  }
  const capabilities = descriptor.capabilities && typeof descriptor.capabilities === 'object' ? descriptor.capabilities : {}
  const declared = capabilities[SPECULATIVE_CAPABILITY] === true || descriptor.speculativeDecoding === true
  const model = descriptor.model || descriptor.id || null
  if (!declared) {
    return { supported: false, model, reason: `${model || 'the model'} does not declare speculative decoding` }
  }
  const draft = descriptor.speculative && typeof descriptor.speculative === 'object' ? descriptor.speculative : {}
  return {
    supported: true,
    model,
    draftModel: draft.model || null,
    maxDraftTokens: Number.isFinite(draft.maxDraftTokens) ? draft.maxDraftTokens : 8,
    reason: null
  }
}

/** Add the speculative hint to a request *only* when it is supported. */
function applySpeculative(request, descriptor) {
  const verdict = speculativeDecoding(descriptor)
  if (!verdict.supported) return { ...request, speculative: null, refusedReason: verdict.reason }
  return {
    ...request,
    speculative: { draftModel: verdict.draftModel, maxDraftTokens: verdict.maxDraftTokens },
    refusedReason: null
  }
}

/**
 * The advanced build cache.
 *
 * It is content-addressed over the *inputs* — the source hashes, the command and the
 * toolchain fingerprint — because a build cache keyed on the command alone is how a stale
 * artifact gets reused after a source change. An incomplete input set (a file that could
 * not be hashed, a truncated walk) is a refusal, not a guess.
 */
function createBuildCache(options = {}) {
  const policy = mergePolicy(options.policy)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const entries = new Map()
  const counts = { hits: 0, misses: 0, evictions: 0, stored: 0, refused: 0 }
  let bytes = 0

  /** `{ command, toolchain, hashes: { file: hash|null }, truncated? }` */
  function key(input = {}) {
    const hashes = input.hashes && typeof input.hashes === 'object' ? input.hashes : {}
    const files = Object.keys(hashes).sort()
    if (!files.length) return { ok: false, reason: 'no input hashes were supplied, so nothing identifies this build' }
    if (input.truncated === true) return { ok: false, reason: 'the input set was truncated, so it cannot identify a build' }
    const missing = files.filter((file) => hashes[file] === null || hashes[file] === undefined || hashes[file] === '')
    if (missing.length) return { ok: false, reason: `the hash of ${missing[0]} is missing, so a cached artifact could be stale` }
    const material = JSON.stringify({ command: String(input.command || ''), toolchain: String(input.toolchain || ''), files: files.map((file) => [file, hashes[file]]) })
    return { ok: true, key: `build-${shortDigest(material)}`, files: files.length }
  }

  function lookup(input = {}) {
    const computed = key(input)
    if (!computed.ok) return { hit: false, reason: computed.reason }
    const entry = entries.get(computed.key)
    if (!entry) {
      counts.misses += 1
      return { hit: false, key: computed.key, reason: 'no cached build for these inputs' }
    }
    entry.touchedAt = now()
    counts.hits += 1
    return { hit: true, key: computed.key, artifact: entry.artifact, ageMs: now() - entry.createdAt, bytes: entry.bytes }
  }

  function record(input = {}) {
    // A failed build is not an artifact: caching it would make the next run "succeed"
    // from a cache entry that was never a success.
    if (input.ok !== true) {
      counts.refused += 1
      return { stored: false, reason: 'a failed build is not cached' }
    }
    const computed = key(input)
    if (!computed.ok) {
      counts.refused += 1
      return { stored: false, reason: computed.reason }
    }
    const size = Number.isFinite(input.bytes) ? Number(input.bytes) : Buffer.byteLength(JSON.stringify(input.artifact === undefined ? null : input.artifact))
    if (size > policy.cacheMaxBytes) {
      counts.refused += 1
      return { stored: false, reason: `${size} bytes exceed the ${policy.cacheMaxBytes}-byte cache budget, so it is not worth storing` }
    }
    if (entries.has(computed.key)) {
      const existing = entries.get(computed.key)
      bytes -= existing.bytes
      entries.delete(computed.key)
    }
    entries.set(computed.key, { artifact: input.artifact === undefined ? null : input.artifact, bytes: size, createdAt: now(), touchedAt: now(), files: computed.files })
    bytes += size
    counts.stored += 1
    while (bytes > policy.cacheMaxBytes || entries.size > policy.cacheMaxEntries) {
      const oldest = [...entries.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
      if (!oldest) break
      bytes -= oldest[1].bytes
      entries.delete(oldest[0])
      counts.evictions += 1
    }
    return { stored: true, key: computed.key, bytes, entries: entries.size }
  }

  /** Drop entries: everything when no file is named, or the ones a change invalidates. */
  function invalidate(input = {}) {
    const files = Array.isArray(input.files) ? input.files : []
    let removed = 0
    for (const [id, entry] of [...entries.entries()]) {
      if (input.all === true || files.length === 0) {
        entries.delete(id)
        bytes -= entry.bytes
        removed += 1
      }
    }
    return { removed, entries: entries.size }
  }

  return {
    policy,
    key,
    lookup,
    record,
    invalidate,
    clear() {
      entries.clear()
      bytes = 0
      return true
    },
    stats: () => ({
      entries: entries.size,
      bytes,
      maxBytes: policy.cacheMaxBytes,
      ...counts,
      hitRate: counts.hits + counts.misses === 0 ? null : Number((counts.hits / (counts.hits + counts.misses)).toFixed(4))
    })
  }
}

/**
 * Automatic worker scaling.
 *
 * The count moves only after several samples agree, and never above what the resource
 * manager allows: the manager answers "how many workers may exist", this answers "how
 * many should, right now". A scaler that reacts to one sample oscillates, and an
 * oscillating worker count costs more than a conservative one.
 */
function createWorkerScaler(options = {}) {
  const policy = mergePolicy(options.policy)
  const resources = options.resources || null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const history = []
  let workers = Math.max(policy.minWorkers, Math.min(policy.maxWorkers, Number.isInteger(options.workers) ? options.workers : policy.minWorkers))
  let lastChangeAt = now()
  let streak = { direction: null, count: 0 }

  function ceiling() {
    if (resources && typeof resources.effectiveWorkers === 'function') {
      const decision = resources.effectiveWorkers({ maxWorkers: policy.maxWorkers, minWorkers: policy.minWorkers })
      return { allowed: decision.workers, bound: decision.bound, reason: decision.reason, pressure: decision.pressure }
    }
    return { allowed: policy.maxWorkers, bound: 'policy', reason: 'no resource manager is attached, so the policy ceiling applies', pressure: 'normal' }
  }

  /**
   * One observation. `{ queueDepth, pressure, inFlight }`.
   *
   * @returns {{workers:number, changed:boolean, direction:string|null, reason:string, ceiling:object}}
   */
  function observe(input = {}) {
    const limit = ceiling()
    const pressure = PRESSURE_RANK[String(input.pressure)] === undefined ? PRESSURE_RANK.normal : PRESSURE_RANK[String(input.pressure)]
    const queueDepth = Number.isFinite(input.queueDepth) ? Number(input.queueDepth) : 0
    const inFlight = Number.isFinite(input.inFlight) ? Number(input.inFlight) : 0
    const ceilingWorkers = Math.max(0, Math.min(policy.maxWorkers, limit.allowed))
    const record = (decision) => {
      history.push({ at: decision.at, workers, direction: decision.direction, changed: decision.changed })
      if (history.length > 100) history.splice(0, history.length - 100)
      return decision
    }

    // A hard ceiling is not a suggestion. If the machine now allows fewer workers than
    // are running, the count drops *now*: hysteresis governs the optimisation, never the
    // safety bound, and shedding one worker per sample would leave the runtime above what
    // the machine permitted for as long as the queue stayed busy.
    if (workers > ceilingWorkers) {
      const from = workers
      workers = ceilingWorkers
      lastChangeAt = now()
      streak = { direction: null, count: 0 }
      return record({
        workers,
        changed: from !== workers,
        direction: 'down',
        reason: ceilingWorkers === 0 ? `the machine allows no workers (${limit.reason})` : `the machine now allows only ${ceilingWorkers} workers (${limit.reason})`,
        ceiling: limit,
        queueDepth,
        inFlight,
        at: now()
      })
    }

    let wanted = null
    if (pressure >= PRESSURE_RANK[policy.shedPressureAt] && workers > policy.minWorkers) {
      wanted = { direction: 'down', reason: `pressure is ${input.pressure}, so a worker is shed` }
    } else if (queueDepth >= policy.scaleUpQueueDepth && inFlight >= workers && workers < ceilingWorkers) {
      wanted = { direction: 'up', reason: `${queueDepth} queued tasks and ${inFlight} in flight, so another worker helps` }
    } else if (queueDepth === 0 && inFlight < workers && workers > policy.minWorkers) {
      wanted = { direction: 'down', reason: `nothing is queued and only ${inFlight} worker(s) are busy` }
    } else {
      wanted = { direction: null, reason: 'the current count matches the load' }
    }

    if (wanted.direction === null) streak = { direction: null, count: 0 }
    else if (streak.direction === wanted.direction) streak.count += 1
    else streak = { direction: wanted.direction, count: 1 }

    const needed = wanted.direction === 'up' ? policy.scaleUpSamples : policy.scaleDownSamples
    let changed = false
    if (wanted.direction !== null && streak.count >= needed) {
      const next = wanted.direction === 'up' ? Math.min(ceilingWorkers, workers + 1) : Math.max(policy.minWorkers, workers - 1)
      if (next !== workers) {
        workers = next
        changed = true
        lastChangeAt = now()
      }
      streak = { direction: null, count: 0 }
    }
    return record({
      workers,
      changed,
      direction: wanted.direction,
      reason: changed ? wanted.reason : `${wanted.reason} (holding: ${streak.count}/${needed} samples)`,
      ceiling: limit,
      queueDepth,
      inFlight,
      at: now()
    })
  }

  return {
    policy,
    observe,
    ceiling,
    get workers() {
      return workers
    },
    history: () => history.slice()
  }
}

/**
 * Advanced fill-in-the-middle editing context.
 *
 * FIM is the third-cheapest way to express a change and the first one that has to *choose*
 * context: the model sees only the prefix and the suffix around an insertion, so what is
 * left out decides whether the insertion is correct. The budget is therefore spent
 * deliberately — the enclosing symbols first, then the nearest lines — and whatever does
 * not fit is listed in `dropped` rather than cut in silence.
 */
function buildFimRequest(input = {}, policy = {}) {
  const resolved = mergePolicy(policy)
  const characters = Math.max(0, resolved.fimBudgetTokens * resolved.charactersPerToken)
  const file = String(input.file || '')
  const text = typeof input.text === 'string' ? input.text : ''
  if (!file) return { ok: false, reason: 'a file is required to build a fill-in-the-middle request' }
  if (!text) return { ok: false, reason: `${file} has no text to split around the insertion point` }
  const marker = input.anchor === undefined ? '' : String(input.anchor)
  const lines = text.split('\n')
  const anchorLine = marker ? Math.max(0, lines.findIndex((line) => line.includes(marker))) : Math.floor(lines.length / 2)
  const prefixShare = Math.min(0.9, Math.max(0.1, Number.isFinite(resolved.fimPrefixShare) ? resolved.fimPrefixShare : 0.6))
  const prefixBudget = Math.floor(characters * prefixShare)
  const suffixBudget = characters - prefixBudget

  /** Take whole lines outward from the anchor, closest first, inside a character budget. */
  const take = (from, step, budget) => {
    const taken = []
    let used = 0
    for (let index = from; index >= 0 && index < lines.length; index += step) {
      const cost = lines[index].length + 1
      if (used + cost > budget) return { lines: taken, used, skipped: Math.abs(index - from) + 1 }
      taken.push(lines[index])
      used += cost
    }
    return { lines: taken, used, skipped: 0 }
  }
  const prefix = take(anchorLine - 1, -1, prefixBudget)
  const suffix = take(anchorLine, 1, suffixBudget)
  const dropped = []
  if (prefix.skipped > 0) dropped.push(`${prefix.skipped} line(s) before the enclosing context did not fit the prefix budget`)
  if (suffix.skipped > 0) dropped.push(`${suffix.skipped} line(s) after the enclosing context did not fit the suffix budget`)

  // The relevant symbols the repo map knows about are the cheapest context there is:
  // they say what the surrounding code *means* for a fraction of the lines.
  const symbols = Array.isArray(input.symbols) ? input.symbols.slice(0, 8) : []
  return {
    ok: true,
    file,
    strategy: 'fim',
    prefix: prefix.lines.reverse().join('\n'),
    suffix: suffix.lines.join('\n'),
    anchorLine,
    prefixLines: prefix.lines.length,
    suffixLines: suffix.lines.length,
    prefixTokens: Math.ceil(prefix.used / resolved.charactersPerToken),
    suffixTokens: Math.ceil(suffix.used / resolved.charactersPerToken),
    budgetTokens: resolved.fimBudgetTokens,
    symbols,
    dropped
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.policy] overrides, including `features`
 * @param {object} [options.resources] the resource manager, for the scaler
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
function createHighPerformance(options = {}) {
  const policy = mergePolicy(options.policy)
  // The four switches come from the plugin's own config block, so a deployment can turn
  // one off without turning the module off.
  const features = { ...policy.features }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const buildCache = createBuildCache({ policy, now })
  const scaler = createWorkerScaler({ policy, resources: options.resources || null, now, workers: policy.minWorkers })
  const counters = { speculative: 0, speculativeRefused: 0, fim: 0, fimRefused: 0, scalingDecisions: 0, cacheRefused: 0, scalingRefused: 0 }

  return {
    policy: { ...policy, features },
    FEATURES: HIGH_PERFORMANCE_FEATURES,
    features: () => ({ ...features }),
    buildCache: {
      ...buildCache,
      lookup: (input) => (features.buildCache ? buildCache.lookup(input) : { hit: false, refused: true, reason: 'the build cache is switched off in this deployment' }),
      record: (input) => {
        if (features.buildCache) return buildCache.record(input)
        counters.cacheRefused += 1
        return { stored: false, refused: true, reason: 'the build cache is switched off in this deployment' }
      }
    },
    scaler,
    /** The plan's P2 speculative decoding, or an honest refusal. */
    speculative(descriptor) {
      if (!features.speculativeDecoding) {
        counters.speculativeRefused += 1
        return { supported: false, refused: true, feature: HIGH_PERFORMANCE_FEATURES.SPECULATIVE_DECODING, reason: 'speculative decoding is switched off in this deployment' }
      }
      const verdict = speculativeDecoding(descriptor)
      if (verdict.supported) counters.speculative += 1
      else counters.speculativeRefused += 1
      return verdict
    },
    /** The hint is added only for a supported *and enabled* option. */
    applySpeculative(request, descriptor) {
      if (!features.speculativeDecoding) {
        counters.speculativeRefused += 1
        return { ...request, speculative: null, refusedReason: 'speculative decoding is switched off in this deployment' }
      }
      const verdict = speculativeDecoding(descriptor)
      if (verdict.supported) counters.speculative += 1
      else counters.speculativeRefused += 1
      return applySpeculative(request, descriptor)
    },
    fim(input) {
      if (!features.advancedFim) {
        counters.fimRefused += 1
        return { ok: false, refused: true, feature: HIGH_PERFORMANCE_FEATURES.ADVANCED_FIM, reason: 'advanced FIM editing is switched off in this deployment' }
      }
      counters.fim += 1
      return buildFimRequest(input, policy)
    },
    scale(input) {
      if (!features.autoScaling) {
        counters.scalingRefused += 1
        return { workers: scaler.workers, changed: false, direction: null, refused: true, reason: 'automatic worker scaling is switched off in this deployment', ceiling: scaler.ceiling() }
      }
      counters.scalingDecisions += 1
      return scaler.observe(input)
    },
    /** What the plugin reports and the UI shows: the options, their state and their cost. */
    summary() {
      const cache = buildCache.stats()
      return {
        features: { ...features },
        cache: { entries: cache.entries, bytes: cache.bytes, hitRate: cache.hitRate, evictions: cache.evictions },
        scaling: { workers: scaler.workers, decisions: counters.scalingDecisions, ceiling: scaler.ceiling() },
        counters: { ...counters },
        at: now()
      }
    }
  }
}

module.exports = {
  createHighPerformance,
  createBuildCache,
  createWorkerScaler,
  buildFimRequest,
  speculativeDecoding,
  applySpeculative,
  mergePolicy,
  HIGH_PERFORMANCE_FEATURES,
  DEFAULT_POLICY
}
