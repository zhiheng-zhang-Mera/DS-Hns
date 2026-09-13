'use strict'

/**
 * DS-Hns plugins: the acceleration set.
 *
 * The accelerators (plan phases 5-13) were built as modules first, which is the right
 * order for a subsystem whose tests have to prove the fast path is not a wrong path.
 * This file is the other half: they become *plugins*, so the runtime reaches them
 * through the capability registry rather than by importing them, and so every one of
 * them can be switched off.
 *
 * That is not bookkeeping. The plan's acceptance standard A is a statement about what
 * happens when a feature is *absent* — "turn repo-map off and fallback search still
 * works", "turn the cache off and every command simply runs". A feature that can only
 * be reached by `require` cannot be turned off, so its absence behaviour is untestable,
 * and the fallback promised in the capability vocabulary is a claim nobody checks. The
 * vocabulary already names every capability below and the fallback each one owes; this
 * file is the provider side of that promise.
 *
 * The fault levels follow the plan's section 32 exactly, and they are the reason a
 * broken accelerator cannot take an episode down: a cache failure is SOFT, a repo map
 * or a scheduler failure is DEGRADED (use the fallback and keep going), and none of
 * them is FATAL.
 *
 * Two conventions are load-bearing:
 *
 *  * `healthCheck` is called with **no arguments**, so whatever a plugin needs to report
 *    is captured when it loads.
 *  * A plugin **composes** what it needs from the registry. The parallel executor does
 *    not import a resource manager; it requires the `resource-management` capability and
 *    takes whatever provides it. That is what makes switching either one out possible.
 */

const path = require('node:path')

const { PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS } = require('../../core/contracts/plugin.cjs')

const API = PLUGIN_API_VERSION

/** Compute the repository root from this file, so nothing depends on process.cwd(). */
const ROOT = path.resolve(__dirname, '..', '..', '..')

/** SQLite-less, file-less state: these plugins hold only what they build in memory. */
function healthy(detail) {
  return { status: HEALTH_STATUS.HEALTHY, detail: detail || {} }
}

/**
 * The repository map. Degraded rather than fatal: without it the runtime searches text,
 * which is slower and less precise but is not a reason to stop working.
 */
function repoMapPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.repo-map',
      name: 'Repository map',
      version: '1.0.0',
      description: 'Answers where a symbol is defined, who references it, what a file imports, what depends on it and which tests are relevant.',
      provides: ['repo-map'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createRepoMap } = require('./repo-map/index.cjs')
      const config = context.config || {}
      service = createRepoMap({ root: config.workspace || context.services.workspace || ROOT, limits: config.limits })
      context.provide('repo-map', service)
      context.log('repo map ready', { root: service.root })
    },
    async healthCheck() {
      if (!service) return { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'the map was never created' } }
      // Not-a-scan at load time: the map is built on first use, so health reports whether
      // it has been built rather than forcing a scan of the repository to answer.
      return healthy({ root: service.root, built: service.built, files: service.size })
    }
  }
}

/** The bounded context builder: stable prefix first, then only what changed. */
function dirtyContextPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.dirty-context',
      name: 'Dirty context',
      version: '1.0.0',
      description: 'Builds one model call\'s context from the stable prefix plus the task, the symbols, the diff and the current failure, inside a declared budget.',
      provides: ['dirty-context'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createDirtyContext } = require('./dirty-context/index.cjs')
      const config = context.config || {}
      service = createDirtyContext({ budget: config.budget })
      context.provide('dirty-context', service)
      context.log('dirty context ready')
    },
    async healthCheck() {
      return service ? healthy(service.summary()) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no context builder' } }
    }
  }
}

/**
 * The stable prefix cache.
 *
 * It is a thin layer over the dirty-context builder on purpose: the stable layer *is*
 * the cacheable prefix, and a second implementation of it would be a second thing to
 * keep in step. What this adds is the reuse decision and its accounting, which is what
 * the `context-cache` capability promises.
 */
function contextCachePlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.context-cache',
      name: 'Context cache',
      version: '1.0.0',
      description: 'Reuses one stable prompt prefix across calls and reports how often it was reused.',
      provides: ['context-cache'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createDirtyContext } = require('./dirty-context/index.cjs')
      const dirty = createDirtyContext()
      const counts = { builds: 0, reuses: 0 }
      let lastKey = null
      let lastPrefix = ''
      service = {
        /** Build the context, and say whether the prefix could be reused as-is. */
        stable(parts) {
          const built = dirty.build(parts)
          const reused = lastKey !== null && lastKey === built.cacheKey
          if (reused) counts.reuses += 1
          else {
            counts.builds += 1
            lastKey = built.cacheKey
            lastPrefix = built.cacheablePrefix
          }
          return { prefix: built.cacheablePrefix, cacheKey: built.cacheKey, reused, counts: { ...counts } }
        },
        prefix: () => lastPrefix,
        stats: () => ({ ...counts, reuseRatio: counts.builds + counts.reuses === 0 ? 0 : Number((counts.reuses / (counts.builds + counts.reuses)).toFixed(4)) })
      }
      context.provide('context-cache', service)
      context.log('context cache ready')
    },
    async healthCheck() {
      return service ? healthy(service.stats()) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no context cache' } }
    }
  }
}

/** The reasoning governor: match the level to the work, and come back down. */
function reasoningGovernorPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.reasoning-governor',
      name: 'Reasoning governor',
      version: '1.0.0',
      description: 'Decides the reasoning level per step from the work itself, escalating on repeated failure and de-escalating once it is solved.',
      provides: ['reasoning-governor'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createReasoningGovernor } = require('./reasoning-governor/index.cjs')
      const config = context.config || {}
      service = createReasoningGovernor({
        defaultLevel: config.defaultLevel,
        ceiling: config.ceiling || (context.services.reasoningCeiling || undefined),
        deescalateAfter: config.deescalateAfter
      })
      context.provide('reasoning-governor', service)
      context.log('reasoning governor ready', { level: service.level, ceiling: service.ceiling })
    },
    async healthCheck() {
      return service ? healthy(service.summary()) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no governor' } }
    }
  }
}

/** Tool batching: read-side calls in one round trip; writes never folded in. */
function toolBatcherPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.tool-batcher',
      name: 'Tool batcher',
      version: '1.0.0',
      description: 'Folds independent read-side calls into one round trip and refuses to fold a write into a batch.',
      provides: ['tool-batching'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const batcher = require('./tool-batcher/index.cjs')
      const config = context.config || {}
      service = {
        planBatch: (input) => batcher.planBatch({ ...input, limits: { ...(config.limits || {}), ...((input && input.limits) || {}) } }),
        executeBatch: (input) => batcher.executeBatch({ ...input, limits: { ...(config.limits || {}), ...((input && input.limits) || {}) } }),
        classifyOperation: batcher.classifyOperation,
        limits: batcher.DEFAULT_LIMITS
      }
      context.provide('tool-batching', service)
      context.log('tool batcher ready')
    },
    async healthCheck() {
      return service ? healthy({ maxCalls: service.limits.maxCalls }) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no batcher' } }
    }
  }
}

/** The command cache: a result is reused only when every input is identical. */
function commandCachePlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.command-cache',
      name: 'Command cache',
      version: '1.0.0',
      description: 'Reuses a test, lint, typecheck or build result only when the command, the relevant file hashes and the environment are unchanged; a failing run is never cached.',
      provides: ['command-cache'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createCommandCache } = require('./command-cache/index.cjs')
      const config = context.config || {}
      service = createCommandCache({ ttlMs: config.ttlMs, maxEntries: config.maxEntries })
      context.provide('command-cache', service)
      context.log('command cache ready')
    },
    async healthCheck() {
      return service ? healthy(service.stats()) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no command cache' } }
    }
  }
}

/**
 * The persistent tool runtime.
 *
 * It owns a lifecycle, not a process: a tool kind is usable once a *starter* has been
 * registered for it, and until then `acquire` refuses with a reason. That is deliberate
 * — a persistent session that invents its own command line would be a second, hidden
 * process supervisor beside the one the shell runtime already provides.
 */
function persistentToolsPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.persistent-tools',
      name: 'Persistent tools',
      version: '1.0.0',
      description: 'Keeps shell, LSP, browser and model-server sessions alive across steps, with a real liveness probe and a bounded reuse count.',
      provides: ['persistent-tools'],
      optional_capabilities: ['process-supervision'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createPersistentTools } = require('./persistent-tools/index.cjs')
      const starters = new Map()
      const owners = new Map()
      const runtime = createPersistentTools({
        policy: (context.config || {}).policy,
        start: async (kind, key) => {
          const starter = starters.get(kind)
          if (!starter) throw new Error(`no starter is registered for the "${kind}" tool`)
          const resource = await starter.start(kind, key)
          owners.set(resource, starter)
          return resource
        },
        stop: async (resource) => {
          const starter = owners.get(resource)
          owners.delete(resource)
          if (starter && typeof starter.stop === 'function') await starter.stop(resource)
        },
        check: async (resource) => {
          const starter = owners.get(resource)
          if (!starter || typeof starter.check !== 'function') return true
          return (await starter.check(resource)) !== false
        },
        log: (message) => context.log(message)
      })
      service = {
        ...runtime,
        /** How a tool kind is started is the consumer's business, not the runtime's. */
        register(kind, starter) {
          if (!starter || typeof starter.start !== 'function') return { ok: false, reason: 'a starter must provide start()' }
          starters.set(String(kind), starter)
          return { ok: true, kind: String(kind), registered: starters.size }
        },
        registered: () => [...starters.keys()],
        /**
         * The process supervisor, resolved *late* on purpose: it is an optional
         * collaborator and the manager's load order only follows required capabilities,
         * so a provider may load after this plugin. Freezing it here would make the
         * order of two unrelated manifests decide whether a starter can run.
         */
        supervisor: () => context.services.processSupervision || null
      }
      context.provide('persistent-tools', service)
      context.log('persistent tools ready', { starterKinds: starters.size })
    },
    async healthCheck() {
      if (!service) return { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no persistent tool runtime' } }
      const stats = service.stats()
      // Degraded, not healthy, when a kind is configured but nothing can start it: the
      // caller is about to get a refusal and should see it coming.
      return stats.refused > 0 ? { status: HEALTH_STATUS.DEGRADED, detail: stats } : healthy(stats)
    }
  }
}

/** Incremental validation: tier 1, 2 or 3, and only the full tier approves completion. */
function incrementalValidationPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.incremental-validation',
      name: 'Incremental validation',
      version: '1.0.0',
      description: 'Derives the validation tier a change warrants, and refuses completion approval that the full tier did not earn.',
      provides: ['validation', 'incremental-validation'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const validation = require('./incremental-validation/index.cjs')
      const config = context.config || {}
      service = {
        TIERS: validation.TIERS,
        requiredTier: validation.requiredTier,
        decideTier: (input) => validation.decideTier({ policy: config.policy, ...input }),
        canApproveCompletion: validation.canApproveCompletion,
        tracker: () => validation.createValidationTracker({ now: config.now })
      }
      context.provide('validation', service)
      context.provide('incremental-validation', service)
      context.log('incremental validation ready')
    },
    async healthCheck() {
      return service ? healthy({ tiers: Object.keys(service.TIERS).length }) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no validation policy' } }
    }
  }
}

/** Patch-first editing policy: refuse to rewrite a large file for a small change. */
function patchFirstPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.patch-first',
      name: 'Patch-first editing',
      version: '1.0.0',
      description: 'Chooses the cheapest strategy that fits an edit (AST edit, targeted patch, FIM) and refuses a whole-file rewrite that a small change does not justify.',
      provides: ['patch-first'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const policy = require('./patch-first/index.cjs')
      const config = context.config || {}
      service = {
        EDIT_STRATEGIES: policy.EDIT_STRATEGIES,
        STRATEGY_RANK: policy.STRATEGY_RANK,
        chooseStrategy: (input) => policy.chooseStrategy(input, config.policy),
        planEdit: (input) => policy.planEdit(input, config.policy),
        estimateTokens: policy.estimateTokens
      }
      context.provide('patch-first', service)
      context.log('patch-first editing ready')
    },
    async healthCheck() {
      return service ? healthy({ rank: service.STRATEGY_RANK.join(' > ') }) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no editing policy' } }
    }
  }
}

/**
 * Workspace isolation.
 *
 * It requires nothing, and it is honest about what it cannot do: when `git worktree` is
 * unavailable the service refuses with `kind: 'shared'`, which is the signal for the
 * parallel executor to serialize writes instead of sharing a tree.
 */
function workspaceIsolationPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.workspace-isolation',
      name: 'Workspace isolation',
      version: '1.0.0',
      description: 'Gives a worker its own verified git worktree, reclaims it visibly, and refuses rather than pretending isolation exists.',
      provides: ['workspace-isolation'],
      optional_capabilities: ['git-operation'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createWorkspaceIsolation } = require('./workspace-isolation/index.cjs')
      const config = context.config || {}
      service = createWorkspaceIsolation({
        root: config.workspace || context.services.workspace || ROOT,
        // Resolved per call: `git-operation` is optional, so it is not part of the load
        // order and may arrive after this plugin.
        git: (args, options) => {
          const git = context.services.gitOperation
          if (!git || typeof git.run !== 'function') return { ok: false, reason: 'no git runner is attached' }
          return git.run(args, options)
        },
        policy: config.policy,
        log: (message) => context.log(message)
      })
      context.provide('workspace-isolation', service)
      context.log('workspace isolation ready', { dir: service.dir })
    },
    async healthCheck() {
      if (!service) return { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no isolation runtime' } }
      const verdict = await service.available()
      // Unavailable isolation is DEGRADED and says so: parallel writes will be refused,
      // and the caller has to know that before it plans them.
      return verdict.ok ? healthy({ dir: service.dir, live: service.size }) : { status: HEALTH_STATUS.DEGRADED, detail: { reason: verdict.reason } }
    }
  }
}

/**
 * The parallel executor.
 *
 * This is the one plugin whose behaviour depends on *other plugins being present*, and
 * it declares that in the manifest rather than by importing: `resource-management` is
 * required, because a worker count is not something to guess, and `workspace-isolation`
 * is optional, because without it the executor still runs — it just serializes
 * overlapping writes, which is what the capability's fallback promises.
 */
function parallelExecutorPlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.parallel-executor',
      name: 'Parallel executor',
      version: '1.0.0',
      description: 'Runs one task\'s dependency dag in waves: readers and disjoint write sets together, overlapping writes serialized unless each writer has its own worktree.',
      provides: ['parallel-execution'],
      requires_capabilities: ['resource-management'],
      optional_capabilities: ['workspace-isolation'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createParallelExecutor } = require('./parallel-executor/index.cjs')
      const config = context.config || {}
      /**
       * The isolation provider, resolved per run rather than at load.
       *
       * `workspace-isolation` is an optional capability, so nothing orders it before this
       * plugin. Resolving it late means the executor's behaviour depends on whether
       * isolation *is available*, not on the order two manifests happened to be installed
       * in — and when it is absent the executor still runs, it just serializes writes.
       */
      const isolation = {
        available: async () => {
          const provider = context.services.workspaceIsolation
          if (!provider) return { ok: false, kind: 'shared', reason: 'no workspace-isolation provider is loaded' }
          return provider.available()
        },
        create: async (input) => {
          const provider = context.services.workspaceIsolation
          if (!provider) return { ok: false, kind: 'shared', reason: 'no workspace-isolation provider is loaded' }
          return provider.create(input)
        },
        reclaim: async (id, options) => {
          const provider = context.services.workspaceIsolation
          if (!provider) return { ok: false, reason: 'no workspace-isolation provider is loaded' }
          return provider.reclaim(id, options)
        }
      }
      service = createParallelExecutor({
        mode: config.mode,
        resources: context.services.resourceManagement || null,
        isolation,
        policy: config.policy,
        log: (message) => context.log(message)
      })
      context.provide('parallel-execution', service)
      context.log('parallel executor ready', { mode: service.mode, isolation: 'resolved per run' })
    },
    async healthCheck() {
      if (!service) return { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no executor' } }
      const allocation = service.workersFor()
      return allocation.workers > 0
        ? healthy({ mode: service.mode, workers: allocation.workers, bound: allocation.bound })
        : { status: HEALTH_STATUS.DEGRADED, detail: { reason: allocation.reason } }
    }
  }
}

/**
 * The high-performance module.
 *
 * One plugin for the plan's P2 list rather than four, because they share a fault story:
 * each is an optimisation over work that already happens, so each must refuse honestly
 * rather than approximate. It takes the resource manager as an *optional* collaborator —
 * without one the scaler falls back to its policy ceiling instead of guessing — and its
 * four options are switches in its own config block, so a deployment can turn one off.
 */
function highPerformancePlugin() {
  let service = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.high-performance',
      name: 'High performance',
      version: '1.0.0',
      description: 'Speculative decoding when the provider declares it, an advanced build cache, automatic worker scaling and fill-in-the-middle context.',
      provides: ['high-performance'],
      optional_capabilities: ['resource-management'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createHighPerformance } = require('./high-performance/index.cjs')
      const config = context.config || {}
      service = createHighPerformance({
        resources: context.services.resourceManagement || null,
        policy: {
          // Only the keys the config actually declares; `mergePolicy` ignores the rest, so a
          // value nobody set cannot erase a default.
          fimBudgetTokens: config.fimBudgetTokens,
          fimPrefixShare: config.fimPrefixShare,
          maxWorkers: config.maxWorkers,
          minWorkers: config.minWorkers,
          cacheMaxBytes: config.cacheMaxBytes,
          cacheMaxEntries: config.cacheMaxEntries,
          features: {
            speculativeDecoding: config.speculativeDecoding,
            buildCache: config.buildCache,
            autoScaling: config.autoScaling,
            advancedFim: config.advancedFim
          }
        },
        log: (message) => context.log(message)
      })
      context.provide('high-performance', service)
      const features = service.features()
      context.log('high performance ready', { options: Object.entries(features).filter(([, on]) => on === true).map(([name]) => name) })
    },
    async healthCheck() {
      if (!service) return { status: HEALTH_STATUS.DEGRADED, detail: { reason: 'no high-performance module' } }
      const summary = service.summary()
      // Never unhealthy: every option is optional by construction, and the module reports
      // what is on and what it has done rather than a verdict about the machine.
      return healthy(summary)
    }
  }
}

/** The acceleration set, in dependency order. */
function accelerationPlugins() {
  return [
    repoMapPlugin(),
    dirtyContextPlugin(),
    contextCachePlugin(),
    reasoningGovernorPlugin(),
    toolBatcherPlugin(),
    commandCachePlugin(),
    persistentToolsPlugin(),
    incrementalValidationPlugin(),
    patchFirstPlugin(),
    workspaceIsolationPlugin(),
    parallelExecutorPlugin(),
    highPerformancePlugin()
  ]
}

/** The capability names this set is responsible for, for the surface gate and the UI. */
const ACCELERATION_CAPABILITIES = Object.freeze([
  'repo-map',
  'dirty-context',
  'context-cache',
  'reasoning-governor',
  'tool-batching',
  'command-cache',
  'persistent-tools',
  'incremental-validation',
  'patch-first',
  'workspace-isolation',
  'parallel-execution',
  'high-performance'
])

module.exports = {
  accelerationPlugins,
  ACCELERATION_CAPABILITIES,
  repoMapPlugin,
  dirtyContextPlugin,
  contextCachePlugin,
  reasoningGovernorPlugin,
  toolBatcherPlugin,
  commandCachePlugin,
  persistentToolsPlugin,
  incrementalValidationPlugin,
  patchFirstPlugin,
  workspaceIsolationPlugin,
  parallelExecutorPlugin,
  highPerformancePlugin
}
