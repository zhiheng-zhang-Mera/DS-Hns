'use strict'

/**
 * DS-Hns Core: the capability vocabulary.
 *
 * Plugins depend on capabilities, never on each other's ids, and that only works
 * if the capability *names* are a closed, documented set. A plugin that invents
 * `"validation2"` has re-introduced the coupling it was trying to avoid, because
 * nothing else can know to provide it.
 *
 * Each entry says what the capability means, who is likely to provide it, and what
 * the runtime should do when nobody does:
 *
 *   `required`  a consumer may declare it in `requires_capabilities`
 *   `fallback`  what happens when the capability is absent — the honest answer for
 *               most acceleration features is "run without it", which is why the
 *               fallback is part of the vocabulary rather than a surprise
 */

/** The closed capability vocabulary. */
const CAPABILITIES = Object.freeze({
  // Execution
  'computer-use': { description: 'observe and act on a GUI', providers: ['dshns.computer-use'], fallback: 'GUI-only work is unavailable; shell and filesystem paths still work' },
  'ui-stability': { description: 'decide when a UI is settled enough to act', providers: ['dshns.ui-stability'], fallback: 'the runtime falls back to its own bounded settling' },
  'shell-runtime': { description: 'run and supervise shell commands', providers: ['dshns.shell-runtime'], fallback: 'no command can run; the episode blocks' },
  'process-supervision': { description: 'own long-running processes', providers: ['dshns.shell-runtime'], fallback: 'a long-running command cannot be supervised' },
  'filesystem': { description: 'read and mutate files inside the workspace', providers: ['dshns.shell-runtime'], fallback: 'no file can be read or written' },
  'git-operation': { description: 'inspect and stage repository state within policy', providers: ['dshns.git-operator'], fallback: 'git awareness is unavailable; the run continues without it' },

  // Autonomy
  'task-supervision': { description: 'own the lifecycle of one task', providers: ['dshns.task-supervisor'], fallback: 'no task can be started' },
  'long-term-worker': { description: 'orchestrate a long unattended episode', providers: ['dshns.long-term-worker'], fallback: 'only single-shot tasks run' },
  'failure-recovery': { description: 'classify a failure and decide what to do', providers: ['dshns.failure-recovery'], fallback: 'a failure stops the task' },
  'checkpoint': { description: 'save and verify resumable state', providers: ['dshns.checkpoint'], fallback: 'a crash means starting over' },
  'watchdog': { description: 'notice a task that has stopped making progress', providers: ['dshns.watchdog'], fallback: 'a stuck task is only noticed by its own timeout' },
  'acceptance-gate': { description: 'decide whether a result may be reported complete', providers: ['dshns.acceptance-gate'], fallback: 'completion cannot be claimed' },
  'session-keeper': { description: 'keep a session alive across reconnects', providers: ['dshns.session-keeper'], fallback: 'a transport loss ends the session' },

  // Coding
  'repo-map': { description: 'find symbols, references and relevant tests', providers: ['dshns.repo-map'], fallback: 'the runtime falls back to text search over the workspace' },
  'dirty-context': { description: 'build a bounded context for one model call', providers: ['dshns.dirty-context'], fallback: 'the caller sends whatever context it already had' },
  'context-cache': { description: 'reuse a stable prompt prefix', providers: ['dshns.context-cache'], fallback: 'every call sends its own prefix' },
  'validation': { description: 'run the project\'s own verification', providers: ['dshns.incremental-validation'], fallback: 'only the runtime\'s own checks run' },
  'incremental-validation': { description: 'validate at the tier the change warrants', providers: ['dshns.incremental-validation'], fallback: 'every validation runs the full suite' },

  // Performance
  'reasoning-governor': { description: 'choose a reasoning level for one step', providers: ['dshns.reasoning-governor'], fallback: 'the profile\'s default level is used for every step' },
  'tool-batching': { description: 'run several read-side tools in one step', providers: ['dshns.tool-batcher'], fallback: 'tools are called one at a time' },
  'parallel-execution': { description: 'run independent task nodes concurrently', providers: ['dshns.parallel-executor'], fallback: 'the task runs serially' },
  'command-cache': { description: 'reuse the result of an unchanged command', providers: ['dshns.command-cache'], fallback: 'every command runs' },
  'persistent-tools': { description: 'keep shell, LSP and browser processes alive', providers: ['dshns.persistent-tools'], fallback: 'each tool starts and stops per step' },
  'patch-first': { description: 'express an edit with the cheapest strategy that fits', providers: ['dshns.patch-first'], fallback: 'the caller expresses the edit however it likes, including a whole-file rewrite' },
  'high-performance': { description: 'speculative decoding, an advanced build cache, automatic worker scaling and FIM context', providers: ['dshns.high-performance'], fallback: 'every optimisation is off and the runtime does the work the straightforward way' },

  // Infrastructure
  'telemetry': { description: 'record the metrics a performance claim needs', providers: ['dshns.telemetry'], fallback: 'no performance claim can be made from this run' },
  'workspace-isolation': { description: 'give a worker its own copy of the workspace', providers: ['dshns.workspace-isolation'], fallback: 'parallel writes are refused' },
  'resource-management': { description: 'derive how much the machine may run', providers: ['dshns.resource-manager'], fallback: 'the runtime runs one thing at a time' },
  'model-access': { description: 'call a model through the active profile', providers: ['dshns.model-runtime'], fallback: 'no model call can be made' },

  /**
   * Long-term hosting.
   *
   * A process that is meant to run for days needs to know how the machine and the runtime are
   * doing, and needs somewhere to say so. These five are that vocabulary. They are split the way
   * the *decisions* are rather than the way the data arrives: reading the machine, reading the
   * runtime, turning both into a judgement, deciding when work may be deferred, and asking for a
   * restart. A single `health` capability would have collapsed four different fallbacks into one.
   *
   * The separation that matters most is the last one. `restart-control` is deliberately *not* part
   * of the health vocabulary: a health monitor may request a restart, but the authority to perform
   * one is held elsewhere, and a monitor that could execute its own request would be a monitor
   * whose bug is an outage. See `docs/health-scheduler.md`.
   */
  'hardware-health': { description: 'read the machine: CPU load, memory pressure, thermals, disk', providers: ['dshns.health-scheduler'], fallback: 'the affected dimension is reported unknown and its weight is redistributed; unknown is never scored as healthy' },
  'runtime-health': { description: 'read the runtime: uptime, worker state, event-loop delay, task outcomes', providers: ['dshns.health-scheduler'], fallback: 'the runtime dimensions are reported unknown rather than assumed good' },
  'health-pressure': { description: 'turn the readings into one pressure score and an action decision', providers: ['dshns.health-scheduler'], fallback: 'no pressure is scored and no mitigation is decided; the runtime keeps running, unmonitored' },
  'maintenance-scheduling': { description: 'decide whether a maintenance window allows work to be deferred or a restart held', providers: ['dshns.health-scheduler'], fallback: 'maintenance is never scheduled and work is never deferred for it' },
  'restart-control': { description: 'request that the application be stopped and brought back, executed by whoever holds the restart authority', providers: ['dshns.process'], fallback: 'no restart can be requested; monitoring and mitigation continue and the capability is reported unavailable' }
})

/**
 * Is this a known capability?
 *
 * An unknown capability is *allowed* to be provided — a project may legitimately
 * add its own — but it cannot be *required*, because nothing can be checked
 * against it. The manager records the difference.
 */
function isKnownCapability(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, String(name))
}

/** What happens without this capability, for the report and the UI. */
function fallbackFor(name) {
  const entry = CAPABILITIES[String(name)]
  return entry ? entry.fallback : 'nothing is known about this capability, so no fallback can be promised'
}

/** Which plugin is expected to provide it, for diagnostics. */
function expectedProviders(name) {
  const entry = CAPABILITIES[String(name)]
  return entry ? entry.providers.slice() : []
}

/** The whole vocabulary, for the plugin UI. */
function describe() {
  return Object.entries(CAPABILITIES).map(([name, entry]) => ({ capability: name, ...entry }))
}

module.exports = { CAPABILITIES, isKnownCapability, fallbackFor, expectedProviders, describe }
