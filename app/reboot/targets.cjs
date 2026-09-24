'use strict'

/**
 * DS-Hns: the **task targets** a restart has to park and resume.
 *
 * A scheduled machine restart and a supervisor-initiated application restart are different operations
 * with the same problem: whatever is running has to be brought to a boundary, remembered, and picked up
 * again afterwards. The thing that knows how to do that is not the scheduler, and it is not the
 * restart executor — it is a small adapter per *target* (the sub-worker, the engineering runtime, and
 * whatever is added later) that answers three questions:
 *
 *   * `status()` — is it running, and what is it doing?
 *   * `suspend()` — park it at its own boundary, and say whether that is done or in flight;
 *   * `resume(intent)` — continue it, from where it actually was.
 *
 * Keeping them here rather than inline in the shell is what makes one source of truth possible: the
 * reboot coordinator (machine restarts) and the restart supervisor's continuity layer (application
 * restarts) drive the *same* adapters, so a target that learns to park better is better for both — and
 * a target cannot be parked by one path and unknown to the other.
 *
 * @param {object} input
 * @param {object} [input.workerManager] the shell-owned sub-worker manager
 * @param {object} [input.engineeringHost] the engineering runtime host
 * @param {Function} [input.log]
 */
function createRebootTargets(input = {}) {
  const workerManager = input.workerManager || null
  const engineeringHost = input.engineeringHost || null

  /** Why the park is being asked for: a plan id, or the reason a supervisor restart gave. */
  function parkReason(input_ = {}) {
    if (input_ && input_.reason) return String(input_.reason)
    if (input_ && input_.plan && input_.plan.id) return `scheduled restart ${input_.plan.id}`
    return 'a restart is waiting for a safe boundary'
  }

  return {
    subWorker: {
      id: 'sub-worker',
      /** What a restart needs to know about this target, and nothing else. */
      status: () => {
        if (!workerManager) return null
        const state = workerManager.state || {}
        return { target: 'sub-worker', running: Boolean(workerManager.isRunning), state: state.state || null, stage: state.stage || null, taskId: state.task_id || null }
      },
      suspend: async (options = {}) => {
        if (!workerManager) return { ok: false, reason: 'the sub-worker is not available in this build' }
        const result = workerManager.pause(parkReason(options))
        if (!result || result.ok === false) return result || { ok: false, reason: 'the worker refused to pause' }
        const delivered = Array.isArray(result.workers) ? result.workers.length : 0
        return {
          ok: true,
          // A running worker answers `pause` and suspends at its own next checkpoint: that is a request
          // in flight, and the caller waits for it rather than restarting over it.
          pending: result.state === 'PAUSING' || delivered > 0,
          state: result.state || null,
          checkpoint: result.checkpoint || null,
          detail: delivered || result.state === 'PAUSING'
            ? 'the worker was asked to stop at its next checkpoint'
            : 'the worker is suspended'
        }
      },
      resume: async (intent) => {
        if (!workerManager) return { ok: false, reason: 'the sub-worker is not available in this build' }
        const result = typeof workerManager.resumeLastTask === 'function'
          ? await workerManager.resumeLastTask()
          : workerManager.resume('continuing after a restart')
        const taskId = (result && (result.taskId || result.task_id)) || (intent && intent.targetState && intent.targetState.taskId) || null
        return {
          ok: Boolean(result && result.ok !== false),
          taskId,
          // The worker's own `resumeLastTask` continues the task it had, from its own checkpoint: that
          // is the semantic half, and it is the worker's claim to make rather than this adapter's.
          from: (result && (result.from || result.checkpoint)) || (taskId ? `task:${taskId}` : null),
          detail: (result && (result.reason || result.detail)) || 'the sub-worker was resumed'
        }
      }
    },
    engineering: {
      id: 'engineering',
      parkPolicy: 'boundary-first',
      status: () => {
        if (!engineeringHost) return null
        const state = engineeringHost.status()
        if (!state || state.ok === false) return null
        return { target: 'engineering', running: state.running === true, phase: state.phase || null, episode: state.episode || null, request: state.request || null }
      },
      suspend: async () => {
        if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
        const cancelled = engineeringHost.cancel({ reason: 'a restart is waiting for a parkable phase' })
        if (cancelled && cancelled.ok === false) return { ok: false, reason: cancelled.error || 'the episode refused to stop' }
        return { ok: true, checkpoint: (cancelled && cancelled.checkpoint) || null, detail: 'the episode stopped at a step boundary and checkpointed' }
      },
      resume: async (intent) => {
        const request = intent && intent.targetState && intent.targetState.request
        if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
        if (!request || !request.workspace || !request.goal) {
          return { ok: false, reason: 'the episode was not recorded with a repository and a goal, so it cannot be resumed automatically' }
        }
        const started = engineeringHost.run({ workspace: request.workspace, goal: request.goal, reason: 'continuing after a restart' })
        if (started && started.ok === false) return { ok: false, reason: started.error || 'the episode could not be restarted' }
        return { ok: true, episode: (started && started.episode) || null, from: `checkpoint:${request.workspace}`, detail: 'the episode resumed from its last checkpoint' }
      }
    }
  }
}

module.exports = { createRebootTargets }
