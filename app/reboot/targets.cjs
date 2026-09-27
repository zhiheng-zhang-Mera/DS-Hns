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
      suspend: async (options = {}) => {
        if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
        const reason = options.reason || (options.plan && options.plan.id
          ? `scheduled restart ${options.plan.id}`
          : 'a restart is waiting for a parkable phase')
        const cancelled = engineeringHost.cancel({ reason, preserveForResume: true })
        if (cancelled && cancelled.ok === false) return { ok: false, reason: cancelled.error || 'the episode refused to stop' }
        const report = await engineeringHost.settled()
        return {
          ok: true,
          checkpoint: (cancelled && cancelled.checkpoint) || (report && report.checkpoint) || null,
          detail: report && report.result === 'CANCELLED'
            ? 'the same episode stopped at a safe boundary and retained an ACTIVE recovery checkpoint'
            : 'the episode reached a terminal or parkable checkpoint'
        }
      },
      resume: async (intent) => {
        if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
        if (typeof engineeringHost.resume !== 'function') {
          return { ok: false, reason: 'the engineering runtime cannot resume a recorded episode' }
        }
        const episodeId = intent && intent.targetState && intent.targetState.episode
        const resumed = await engineeringHost.resume({ episodeId, trigger: 'planned_restart' })
        if (resumed && resumed.ok === false) return { ok: false, reason: resumed.error || resumed.reason || 'the episode could not be resumed', code: resumed.code }
        const checkpointSeq = resumed && (resumed.acceptedCheckpointSeq || resumed.checkpointSeq)
        return {
          ok: Boolean(resumed && resumed.ok !== false),
          episode: (resumed && resumed.episode) || episodeId || null,
          from: resumed && resumed.resumed && Number.isSafeInteger(checkpointSeq) ? `checkpoint:${checkpointSeq}` : null,
          detail: resumed && resumed.resumed
            ? `the same episode resumed from checkpoint ${checkpointSeq}`
            : 'the episode was already terminal or no longer needed resuming'
        }
      }
    }
  }
}

module.exports = { createRebootTargets }
