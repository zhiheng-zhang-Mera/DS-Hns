'use strict'

/**
 * DS-Hns plugins: the mounted feature set.
 *
 * Each of these wraps a subsystem that already exists and already works. The
 * migration rule from the plan is explicit — **move, do not optimise** — so a
 * plugin here adds a manifest, a lifecycle and a capability, and changes nothing
 * about the behaviour behind it. The old module keeps its tests; the plugin is the
 * new way the rest of the runtime reaches it.
 *
 * Why wrap rather than move the files: the risk of a large file move is that
 * behaviour changes silently, and the plan forbids doing a migration and an
 * optimisation in one step. A wrapper is provably behaviour-preserving — it calls
 * the same code — and it is what makes the subsystem *removable*, which is the
 * property the acceptance standard actually tests ("turn computer-use off and
 * shell coding still works").
 *
 * A plugin's `healthCheck` is called by the supervisor with **no arguments**, so
 * anything it needs is captured when the plugin loads rather than taken from the
 * call. That is why several plugins below hold a reference to what they provided.
 */

const path = require('node:path')

const { PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS } = require('../../core/contracts/plugin.cjs')
const { healthSchedulerPlugin } = require('../health-scheduler/index.cjs')
const { restartSupervisorPlugin } = require('../restart-supervisor/index.cjs')

const API = PLUGIN_API_VERSION

/** Compute the repository root from this file, so nothing depends on process.cwd(). */
const ROOT = path.resolve(__dirname, '..', '..', '..')

/**
 * The shell runtime: command execution, process supervision and the workspace
 * boundary, all of which already live in the Computer Use runtime and are reused
 * rather than copied.
 */
function shellRuntimePlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.shell-runtime',
      name: 'Shell runtime',
      version: '1.0.0',
      description: 'Runs and supervises commands, and owns the workspace boundary for every filesystem and shell operation.',
      provides: ['shell-runtime', 'process-supervision', 'filesystem'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createProcessSupervisor } = require('../../engineering/process.cjs')
      const { createWorkspaceGuard } = require('../../computer-use/workspace.cjs')
      const supervisor = createProcessSupervisor({ now: Date.now })
      const workspace = createWorkspaceGuard({ workspace: ROOT })
      context.provide('shell-runtime', { supervisor, workspace })
      context.provide('process-supervision', supervisor)
      context.provide('filesystem', workspace)
      context.log('shell runtime ready', { workspace: workspace.root, owned: supervisor.ownedCount() })
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY, detail: { root: ROOT } }
    }
  }
}

/**
 * Git operations: inspect and stage within policy. The destructive verbs are not
 * implemented in the controller at all, so a plugin cannot widen them.
 */
function gitOperatorPlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.git-operator',
      name: 'Git operator',
      version: '1.0.0',
      description: 'Reads repository state and stages explicit paths; reset --hard, clean -fd and force push are not implemented.',
      provides: ['git-operation'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createGitController } = require('../../engineering/git.cjs')
      const config = context.config || {}
      const git = createGitController({
        root: config.workspace || ROOT,
        policy: {
          allowCommit: config.allowCommit === true,
          allowPush: config.allowPush === true,
          allowMerge: config.allowMerge === true
        }
      })
      context.provide('git-operation', git)
      context.log('git operator ready', { policy: git.policy })
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/**
 * The long-term worker: the engineering runtime's episode supervisor, which
 * orchestrates and does not re-implement its collaborators.
 */
function longTermWorkerPlugin() {
  let worker = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.long-term-worker',
      name: 'Long-term worker',
      version: '1.0.0',
      description: 'Orchestrates one engineering episode for up to 24 hours; it composes checkpoint, recovery, validation and the acceptance gate rather than implementing them.',
      provides: ['long-term-worker'],
      requires_capabilities: ['shell-runtime', 'filesystem', 'checkpoint', 'failure-recovery'],
      optional_capabilities: ['computer-use', 'git-operation', 'telemetry'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createEngineeringSupervisor } = require('../../engineering/supervisor.cjs')
      const checks = context.require('checkpoint')
      const recovery = context.require('failure-recovery')
      worker = {
        /**
         * Start one episode. The worker composes: it takes the checkpoint store and
         * the recovery policy from the plugins that provide them, so replacing
         * either does not touch this file.
         */
        start(input = {}) {
          return createEngineeringSupervisor({
            workspace: input.workspace || ROOT,
            goal: input.goal,
            contract: input.contract || {},
            deadlineMs: input.deadlineMs,
            checkpointRoot: checks && checks.root ? checks.root : input.checkpointRoot,
            log: (event) => context.emit('worker.event', { event })
          })
        },
        composed: () => ({
          checkpoint: Boolean(checks),
          recovery: Boolean(recovery),
          optional: ['computer-use', 'git-operation', 'telemetry'].filter((capability) => context.has(capability))
        })
      }
      context.provide('long-term-worker', worker)
      context.log('long-term worker ready', { composed: worker.composed() })
    },
    async unload() {
      worker = null
    },
    async healthCheck() {
      return worker
        ? { status: HEALTH_STATUS.HEALTHY, detail: worker.composed() }
        : { status: HEALTH_STATUS.UNKNOWN, reason: 'the worker has not been loaded' }
    }
  }
}

/** Checkpoint: save and verify resumable state. */
function checkpointPlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.checkpoint',
      name: 'Checkpoint',
      version: '1.0.0',
      description: 'Writes atomic checkpoints and verifies a resume against the world rather than against memory.',
      provides: ['checkpoint'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createCheckpointStore, verifyResume, truncateOutput } = require('../../engineering/checkpoint.cjs')
      const root = path.join(ROOT, 'runtime', 'engineering', 'checkpoints')
      const store = createCheckpointStore({ root })
      context.provide('checkpoint', { ...store, root, verifyResume, truncateOutput })
      context.log('checkpoint ready', { root })
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** Failure recovery: classify a failure, then answer with a deterministic policy. */
function failureRecoveryPlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.failure-recovery',
      name: 'Failure recovery',
      version: '1.0.0',
      description: 'Classifies a failure and answers with a bounded policy instead of asking a model what to do; only an unknown failure needs analysis.',
      provides: ['failure-recovery'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { classify, createRepairTracker, CLASS_POLICY, FAILURE_CLASSES } = require('../../engineering/failure.cjs')
      context.provide('failure-recovery', { classify, createRepairTracker, CLASS_POLICY, FAILURE_CLASSES })
      context.log('failure recovery ready', { classes: Object.keys(FAILURE_CLASSES).length })
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** The acceptance gate: decide whether a result may be reported complete. */
function acceptanceGatePlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.acceptance-gate',
      name: 'Acceptance gate',
      version: '1.0.0',
      description: 'Refuses completion without fresh evidence: criteria, tests, build, unresolved failures, workspace and leaks.',
      provides: ['acceptance-gate'],
      fault_level: FAULT_LEVELS.FATAL
    },
    async load(context) {
      const { createResultValidator, collectLeaks, workspaceStillValid } = require('../../engineering/result.cjs')
      context.provide('acceptance-gate', { createResultValidator, collectLeaks, workspaceStillValid })
      context.log('acceptance gate ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** Telemetry: subscribes to the bus and records the metrics a claim needs. */
function telemetryPlugin() {
  const counters = new Map()
  const totals = new Map()
  const seen = []
  return {
    manifest: {
      api_version: API,
      id: 'dshns.telemetry',
      name: 'Telemetry',
      version: '1.0.0',
      description: 'Subscribes to the event bus and accumulates the metrics every performance claim is measured against.',
      provides: ['telemetry'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const durationOf = (payload) => {
        if (!payload || typeof payload !== 'object') return null
        for (const key of ['durationMs', 'ms', 'elapsedMs']) {
          if (Number.isFinite(payload[key])) return Number(payload[key])
        }
        return null
      }
      context.onAny((payload, event) => {
        counters.set(event.type, (counters.get(event.type) || 0) + 1)
        const duration = durationOf(payload)
        if (duration !== null) totals.set(event.type, (totals.get(event.type) || 0) + duration)
        seen.push({ type: event.type, at: event.at, source: event.source })
        if (seen.length > 500) seen.splice(0, seen.length - 500)
      })
      context.provide('telemetry', {
        counts: () => Object.fromEntries(counters),
        events: (count) => (Number.isInteger(count) ? seen.slice(-count) : seen.slice()),
        /**
         * The plan's performance table (sections 42-44), from the bus plus whatever the
         * caller reports it cannot see from events alone.
         *
         * A metric with no data is `null` *and* carries its reason in `unavailable`. That
         * is the whole discipline of this table: a missing number that reads as zero, or
         * as perfect efficiency, is how a performance claim gets made without evidence.
         */
        metrics: (input = {}) => {
          const count = (type) => counters.get(type) || 0
          const total = (type) => (totals.has(type) ? totals.get(type) : null)
          const accepted = Number.isFinite(input.acceptedPatches) && input.acceptedPatches > 0 ? input.acceptedPatches : null
          const tasks = Number.isFinite(input.tasks) ? input.tasks : count('task.created') || count('task.started') || 0
          const wallTimeMs = Number.isFinite(input.wallTimeMs) ? input.wallTimeMs : null
          const modelCalls = count('model.response')
          const toolCalls = count('tool.completed')
          const cacheHits = Number.isFinite(input.cacheHits) ? input.cacheHits : count('cache.hit')
          const cacheMisses = Number.isFinite(input.cacheMisses) ? input.cacheMisses : count('cache.miss')
          const cacheTotal = cacheHits + cacheMisses
          const retries = Number.isFinite(input.retries) ? input.retries : count('task.retried')
          const mutations = Number.isFinite(input.mutations) ? input.mutations : count('workspace.changed')
          const rollbacks = Number.isFinite(input.rollbacks) ? input.rollbacks : count('task.rolled-back')
          const parallel = input.parallel || null
          const unavailable = {}
          const ratio = (numerator, denominator) => (denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null)

          const metrics = {
            /** The headline measure: a single task's real completion speed. */
            time_to_accepted_patch_ms: accepted && wallTimeMs !== null ? Math.round(wallTimeMs / accepted) : null,
            llm_calls_per_accepted_patch: accepted ? Number((modelCalls / accepted).toFixed(2)) : null,
            tool_calls_per_task: tasks > 0 ? Number((toolCalls / tasks).toFixed(2)) : null,
            model_time_ms: total('model.response'),
            tool_time_ms: total('tool.completed'),
            test_time_ms: total('validation.completed'),
            idle_time_ms: Number.isFinite(input.idleTimeMs) ? input.idleTimeMs : null,
            cache_hit_rate: cacheTotal > 0 ? ratio(cacheHits, cacheTotal) : null,
            retry_rate: ratio(retries, mutations),
            rollback_rate: ratio(rollbacks, mutations),
            /** Section 44: serial estimate over actual wall time, plus the utilization that
             *  makes sure the speedup is not one busy worker beside seven idle ones. */
            parallel_efficiency:
              parallel && Number.isFinite(parallel.serialMs) && Number.isFinite(parallel.wallMs) && parallel.wallMs > 0
                ? Number((parallel.serialMs / parallel.wallMs).toFixed(4))
                : null,
            worker_utilization:
              parallel && Number.isFinite(parallel.workers) && parallel.workers > 0 && Number.isFinite(parallel.maxParallelism)
                ? ratio(parallel.maxParallelism, parallel.workers)
                : null,
            model_calls: modelCalls,
            accepted_patches: accepted
          }

          if (metrics.time_to_accepted_patch_ms === null) {
            unavailable.time_to_accepted_patch_ms = accepted ? 'the wall time was not reported' : 'no accepted patch has been counted yet'
          }
          if (metrics.llm_calls_per_accepted_patch === null) unavailable.llm_calls_per_accepted_patch = 'no accepted patch has been counted yet'
          if (metrics.tool_calls_per_task === null) unavailable.tool_calls_per_task = 'no task has been started yet'
          for (const [name, type] of [['model_time_ms', 'model.response'], ['tool_time_ms', 'tool.completed'], ['test_time_ms', 'validation.completed']]) {
            if (metrics[name] === null) unavailable[name] = `no ${type} event carried a duration`
          }
          if (metrics.idle_time_ms === null) unavailable.idle_time_ms = 'the scheduler did not report its idle time'
          if (metrics.cache_hit_rate === null) unavailable.cache_hit_rate = 'no cache hit or miss has been recorded'
          if (metrics.retry_rate === null) unavailable.retry_rate = 'no mutation has been recorded yet'
          if (metrics.rollback_rate === null) unavailable.rollback_rate = 'no mutation has been recorded yet'
          if (metrics.parallel_efficiency === null) unavailable.parallel_efficiency = 'no parallel run reported both its serial estimate and its wall time'
          if (metrics.worker_utilization === null) unavailable.worker_utilization = 'no parallel run reported its worker count and its peak parallelism'

          return { ...metrics, unavailable }
        }
      })
      context.log('telemetry ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY, detail: { eventTypes: counters.size } }
    }
  }
}

/** The watchdog: notices a task that has stopped making progress. */
function watchdogPlugin() {
  const watched = new Map()
  return {
    manifest: {
      api_version: API,
      id: 'dshns.watchdog',
      name: 'Watchdog',
      version: '1.0.0',
      description: 'Tracks the last meaningful progress of a task and reports a stall instead of letting it hang silently.',
      provides: ['watchdog'],
      requires_capabilities: ['failure-recovery'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createStallDetector } = require('../../computer-use/stall.cjs')
      context.provide('watchdog', {
        watch(id, options = {}) {
          const detector = createStallDetector({ now: Date.now, consecutiveActions: options.consecutiveActions, maxRecoveries: options.maxRecoveries })
          watched.set(String(id), detector)
          return detector
        },
        get: (id) => watched.get(String(id)) || null,
        release: (id) => watched.delete(String(id)),
        status: () => [...watched.entries()].map(([id, detector]) => ({ id, recoveries: detector.recoveries, exhausted: detector.exhausted }))
      })
      context.log('watchdog ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY, detail: { watched: watched.size } }
    }
  }
}

/** Session keeper: keeps a session alive across a transport loss. */
function sessionKeeperPlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.session-keeper',
      name: 'Session keeper',
      version: '1.0.0',
      description: 'Provides bounded reconnection for a channel that loses its transport, and re-observes before continuing.',
      provides: ['session-keeper'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createReconnectPolicy, createChannelRecovery, isTransportFailure } = require('../../computer-use/reconnect.cjs')
      context.provide('session-keeper', {
        create: (input) => createReconnectPolicy({ now: Date.now, sleep: input && input.sleep }),
        createRecovery: (input) => createChannelRecovery({ policy: input.policy, controllers: input.controllers || {}, now: Date.now, sleep: input.sleep }),
        isTransportFailure
      })
      context.log('session keeper ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** Computer Use: the GUI capability, wrapped so it can be switched off cleanly. */
function computerUsePlugin() {
  // Captured for the health check, which the supervisor calls without arguments.
  let attached = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.computer-use',
      name: 'Computer Use',
      version: '1.0.0',
      description: 'Observes and acts on the GUI when no structured channel can carry the work. Removing it leaves shell and filesystem coding untouched.',
      provides: ['computer-use'],
      optional_capabilities: ['session-keeper'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      // The runtime is created by the host, not here: it needs the Electron page
      // port, which only the shell can supply. The plugin's job is to make the
      // capability resolvable and to report honestly when no host has attached.
      const services = context.services || {}
      if (services.computerUse) {
        attached = services.computerUse
        context.provide('computer-use', attached)
        context.log('computer use attached to a host runtime')
        return
      }
      attached = {
        attached: false,
        reason: 'no host runtime was attached, so GUI work is unavailable in this process'
      }
      context.provide('computer-use', attached)
      context.log('computer use is mounted but no host runtime is attached')
    },
    async healthCheck() {
      if (!attached || attached.attached === false) {
        // A mounted-but-unattached GUI channel is *degraded*, not unhealthy: the
        // rest of the runtime works, which is exactly what the acceptance standard
        // for switching computer-use off checks.
        return { status: HEALTH_STATUS.DEGRADED, reason: attached ? attached.reason : 'not attached' }
      }
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** UI stability: transient settling, provided by the computer-use stabiliser. */
function uiStabilityPlugin() {
  return {
    manifest: {
      api_version: API,
      id: 'dshns.ui-stability',
      name: 'UI stability',
      version: '1.0.0',
      description: 'Decides when the UI is settled enough to act, from this step\'s own signals; it learns nothing about any application.',
      provides: ['ui-stability'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createStabilizer } = require('../../computer-use/stabilization.cjs')
      context.provide('ui-stability', {
        create: (input) => createStabilizer({ clock: input && input.clock }),
        createStabilizer
      })
      context.log('ui stability ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY }
    }
  }
}

/** Task supervisor: owns the lifecycle of one task. */
function taskSupervisorPlugin() {
  const tasks = new Map()
  return {
    manifest: {
      api_version: API,
      id: 'dshns.task-supervisor',
      name: 'Task supervisor',
      version: '1.0.0',
      description: 'Owns the lifecycle of one task: created, started, accepted or failed, with the phase machine behind it.',
      provides: ['task-supervision'],
      requires_capabilities: ['acceptance-gate'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createEpisodeStateMachine, EPISODE_PHASES } = require('../../engineering/episode.cjs')
      context.provide('task-supervision', {
        create(input = {}) {
          const machine = createEpisodeStateMachine({ now: Date.now })
          const record = { id: input.id || `task-${Date.now()}`, goal: input.goal || null, machine, at: Date.now() }
          tasks.set(record.id, record)
          context.emit('task.created', { task: record.id, goal: record.goal })
          return {
            id: record.id,
            transition: (phase, detail) => {
              const moved = machine.transition(phase, detail)
              if (moved.ok) {
                if (phase === EPISODE_PHASES.COMPLETED) context.emit('task.accepted', { task: record.id })
                if (phase === EPISODE_PHASES.FAILED) context.emit('task.failed', { task: record.id, reason: detail && detail.reason })
              }
              return moved
            },
            get phase() {
              return machine.phase
            },
            get terminal() {
              return machine.terminal
            }
          }
        },
        get: (id) => tasks.get(String(id)) || null,
        list: () => [...tasks.values()].map((record) => ({ id: record.id, goal: record.goal, phase: record.machine.phase, terminal: record.machine.terminal })),
        release: (id) => tasks.delete(String(id))
      })
      context.log('task supervisor ready')
    },
    async healthCheck() {
      return { status: HEALTH_STATUS.HEALTHY, detail: { tasks: tasks.size } }
    }
  }
}

/** Resource manager: the derived worker count, as a capability. */
function resourceManagerPlugin() {
  // Captured for the health check, which the supervisor calls without arguments.
  let activeManager = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.resource-manager',
      name: 'Resource manager',
      version: '1.0.0',
      description: 'Measures CPU, memory, GPU and in-flight load and derives how many workers the machine may run.',
      provides: ['resource-management'],
      fault_level: FAULT_LEVELS.SOFT
    },
    async load(context) {
      const { createResourceManager } = require('../../core/resource-manager/index.cjs')
      activeManager = createResourceManager({ limits: context.config || {} })
      context.provide('resource-management', activeManager)
      const summary = activeManager.summary()
      context.log('resource manager ready', { pressure: summary.pressure, workers: summary.workers, bound: summary.bound })
    },
    async healthCheck() {
      const summary = activeManager ? activeManager.summary() : null
      if (!summary) return { status: HEALTH_STATUS.UNKNOWN }
      return summary.pressure === 'ceiling'
        ? { status: HEALTH_STATUS.DEGRADED, reason: summary.reason }
        : { status: HEALTH_STATUS.HEALTHY, detail: summary }
    }
  }
}

/** Model runtime: the active profile's descriptor, as a capability. */
function modelRuntimePlugin() {
  // Captured for the health check, which the supervisor calls without arguments.
  let activeModelAccess = null
  return {
    manifest: {
      api_version: API,
      id: 'dshns.model-runtime',
      name: 'Model runtime',
      version: '1.0.0',
      description: 'Resolves the active model profile once per run and exposes the descriptor and its policy; no plugin ever sees a model name.',
      provides: ['model-access'],
      fault_level: FAULT_LEVELS.DEGRADED
    },
    async load(context) {
      const { createModelRegistry } = require('../../core/contracts/model.cjs')
      const { loadProfiles, registerProfiles, DEFAULT_PROFILE } = require('../../core/contracts/profile.cjs')
      const { createDeepSeekProvider } = require('../providers/deepseek/index.cjs')
      const registry = createModelRegistry({ defaultProfile: DEFAULT_PROFILE })
      const provider = createDeepSeekProvider()
      registry.registerProvider({ id: provider.id, name: provider.name, describe: (input) => provider.describe(input) })
      const loaded = loadProfiles({ dir: path.join(ROOT, 'profiles'), providers: registry.providers() })
      registerProfiles(registry, loaded.profiles)
      for (const error of loaded.errors) context.log('profile rejected', error)
      const services = context.services || {}
      const active = services.profile || (context.config && context.config.profile) || DEFAULT_PROFILE
      if (registry.profiles().some((profile) => profile.id === active)) registry.setActiveProfile(active)
      const resolved = registry.resolve()
      activeModelAccess = {
        registry,
        resolve: (id) => registry.resolve(id),
        active: () => registry.resolve(),
        descriptor: () => resolved.model,
        policy: () => resolved.policy,
        profiles: () => registry.profiles()
      }
      context.provide('model-access', activeModelAccess)
      context.log('model runtime ready', { profile: registry.activeProfile, model: resolved.ok ? resolved.model.model : null })
    },
    async healthCheck() {
      const resolved = activeModelAccess ? activeModelAccess.active() : null
      if (!resolved || resolved.ok !== true) {
        return { status: HEALTH_STATUS.UNHEALTHY, reason: resolved ? resolved.reason : 'no model is resolvable' }
      }
      return { status: HEALTH_STATUS.HEALTHY, detail: { model: resolved.model.model, profile: resolved.profile.id } }
    }
  }
}

/**
 * Every mounted plugin, in the order the plan lists them.
 *
 * `options.host` is the shell's continuity layer, and it is passed to the **restart supervisor only**:
 * that plugin asks what is running, parks it before a restart and continues it afterwards, and the
 * answer has to be Core's rather than a plugin's. Every other mounted plugin gets exactly what it got
 * before, because a hook handed to a plugin that does not need it is a hook that will eventually be
 * used for something else.
 */
function mountedPlugins(options = {}) {
  const host = options && typeof options.host === 'object' ? options.host : null
  const nodeExe = options && typeof options.nodeExe === 'string' ? options.nodeExe : undefined
  const stateDir = options && typeof options.stateDir === 'string' ? options.stateDir : undefined
  return [
    shellRuntimePlugin(),
    gitOperatorPlugin(),
    taskSupervisorPlugin(),
    telemetryPlugin(),
    watchdogPlugin(),
    failureRecoveryPlugin(),
    checkpointPlugin(),
    acceptanceGatePlugin(),
    sessionKeeperPlugin(),
    resourceManagerPlugin(),
    modelRuntimePlugin(),
    computerUsePlugin(),
    uiStabilityPlugin(),
    longTermWorkerPlugin(),
    // The first plugin written *for* this platform under the adapter framework. It is mounted
    // exactly like the ones above, which is the point: a native plugin is adapted by
    // `NativeHnsAdapter` rather than installed through a second, privileged path. It ships
    // disabled -- sampling the machine is a decision a user makes.
    healthSchedulerPlugin(),
    // The **one** restart authority. It is mounted here, not privileged: it provides
    // `restart-control`, which is what the monitor above asks when it wants a restart, and the
    // out-of-process companion is started through the shell hooks `desktop-main.cjs` passes in.
    // Unlike the monitor it ships *enabled*, because without it no restart can be requested at all
    // -- and its budget, not a disabled plugin, is what keeps that from being dangerous.
    restartSupervisorPlugin({ host, nodeExe, stateDir })
  ]
}

module.exports = {
  mountedPlugins,
  shellRuntimePlugin,
  gitOperatorPlugin,
  taskSupervisorPlugin,
  telemetryPlugin,
  watchdogPlugin,
  failureRecoveryPlugin,
  healthSchedulerPlugin,
  restartSupervisorPlugin,
  checkpointPlugin,
  acceptanceGatePlugin,
  sessionKeeperPlugin,
  resourceManagerPlugin,
  modelRuntimePlugin,
  computerUsePlugin,
  uiStabilityPlugin,
  longTermWorkerPlugin,
  healthSchedulerPlugin
}
