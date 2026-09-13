'use strict'

/**
 * DS-Hns Engineering panel.
 *
 * The dock is a *control surface*, never an executor: it names a repository and a
 * goal, asks the shell-side runtime where an episode has got to, and reads the
 * episode's own report. Nothing here decides a command, a path or a git policy —
 * the runtime discovers the project, verifies the workspace and applies its own
 * contract, and the panel cannot invent progress the supervisor did not observe.
 *
 * Two consequences of that design show up in the code:
 *
 *  * starting an episode is a *fire-and-poll*, not an await — a 24-hour episode
 *    cannot be awaited by a renderer — so the panel polls `engineering:status`
 *    while an episode is running and stops the moment it settles;
 *  * "describe" is a separate action on purpose: the user should be able to see
 *    which project and which commands the runtime would use *before* it is allowed
 *    to touch the repository.
 *
 * It is deliberately one file with no dependencies, matching the other panels: a
 * failure here can never stop the queue or hardware modules from rendering.
 */
;(function attachEngineeringPanel() {
  function $(id) {
    return document.getElementById(id)
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  /** The default repository the shell was started in, when the bridge knows it. */
  const DEFAULT_GOAL = '修复仓库中失败的测试，直到完整验证通过'
  const POLL_MS = 1500

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }

  function attach() {
    const root = $('engineeringPanel')
    if (!root) return null
    const workspaceInput = $('engWorkspace')
    const goalInput = $('engGoal')
    const deadlineInput = $('engDeadline')
    const contractInput = $('engContract')
    const statusChip = $('engState')
    const message = $('engMessage')
    const summaryBox = $('engSummary')
    const phasesBox = $('engPhases')
    const discoveryBox = $('engDiscovery')
    const reportBox = $('engReport')
    const buttons = {
      describe: $('engDescribe'),
      run: $('engRun'),
      cancel: $('engCancel'),
      refresh: $('engRefresh')
    }

    let timer = null
    let describing = false

    function say(text, kind) {
      if (!message) return
      message.textContent = text || ''
      message.className = kind ? `theme-message ${kind}` : 'theme-message'
    }

    function busy(flag) {
      for (const [name, button] of Object.entries(buttons)) {
        if (!button) continue
        if (name === 'cancel') button.disabled = !flag
        else button.disabled = Boolean(flag)
      }
      if (statusChip) statusChip.classList.toggle('busy', Boolean(flag))
    }

    function chip(phase, running) {
      if (!statusChip) return
      const text = phase || (running ? 'RUNNING' : 'IDLE')
      statusChip.textContent = text
      statusChip.className = `status-chip ${running ? 'busy' : 'neutral'}`
    }

    function contract() {
      const raw = contractInput ? String(contractInput.value || '').trim() : ''
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        throw new Error(`contract 不是合法 JSON：${error.message}`)
      }
    }

    function request() {
      const workspace = workspaceInput ? String(workspaceInput.value || '').trim() : ''
      const goal = goalInput ? String(goalInput.value || '').trim() : ''
      const minutes = Number(deadlineInput ? deadlineInput.value : 1440)
      return {
        workspace,
        goal,
        deadlineMs: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined,
        contract: contract()
      }
    }

    function renderDiscovery(info) {
      if (!discoveryBox) return
      discoveryBox.textContent = ''
      if (!info) return
      if (info.ok === false) {
        discoveryBox.appendChild(el('p', 'eng-empty', info.error || '无法识别该目录'))
        return
      }
      const head = el('p', 'eng-line')
      head.appendChild(el('strong', null, `项目：${info.project.id}（${info.project.language}）`))
      head.appendChild(el('span', 'eng-dim', ` — ${info.project.evidence}`))
      discoveryBox.appendChild(head)
      const git = info.git || {}
      discoveryBox.appendChild(el('p', 'eng-line eng-dim', git.available
        ? `git：${git.branch || '(detached)'} @ ${String(git.head || '').slice(0, 8)}${git.clean === false ? '（有未提交改动，会被保护）' : '（干净）'}`
        : `git：不可用（${git.reason || 'unknown'}）`))
      const commands = info.commands || {}
      const names = Object.keys(commands)
      if (names.length) {
        const list = el('div', 'eng-commands')
        for (const name of names) {
          const entry = commands[name]
          const line = el('div', 'eng-command')
          line.appendChild(el('span', 'eng-command-name', name))
          line.appendChild(el('code', 'eng-command-text', `${entry.command}${entry.acceptsFocus ? ' <focus>' : ''}`))
          line.appendChild(el('span', `eng-confidence ${entry.confidence === 'inferred' ? 'weak' : ''}`, entry.confidence))
          list.appendChild(line)
        }
        discoveryBox.appendChild(list)
      } else {
        discoveryBox.appendChild(el('p', 'eng-empty', '该目录没有声明任何可用命令；episode 只能是只读检查。'))
      }
      if (Array.isArray(info.instructions) && info.instructions.length) {
        discoveryBox.appendChild(el('p', 'eng-line eng-dim', `工程指令：${info.instructions.join('、')}`))
      }
      if (Array.isArray(info.ci) && info.ci.length) {
        discoveryBox.appendChild(el('p', 'eng-line eng-dim', `CI：${info.ci.join('、')}`))
      }
    }

    function renderState(status) {
      if (!status) return
      if (status.ok === false) {
        say(status.error, 'bad')
        busy(false)
        return
      }
      chip(status.phase, status.running)
      if (summaryBox) {
        summaryBox.textContent = ''
        const summary = status.summary
        if (summary) {
          if (summary.goal) summaryBox.appendChild(el('p', 'eng-line', `目标：${summary.goal}`))
          if (summary.phase) summaryBox.appendChild(el('p', 'eng-line eng-dim', `阶段：${summary.phase}`))
          const completed = Array.isArray(summary.completed) ? summary.completed : []
          if (completed.length) summaryBox.appendChild(el('p', 'eng-line eng-dim', `已完成：${completed.length} 步`))
          const remaining = Array.isArray(summary.remaining) ? summary.remaining : []
          if (remaining.length) summaryBox.appendChild(el('p', 'eng-line eng-dim', `剩余：${remaining.length} 步`))
          const files = Array.isArray(summary.filesChanged) ? summary.filesChanged : []
          if (files.length) summaryBox.appendChild(el('p', 'eng-line eng-dim', `已改动文件：${files.join('、')}`))
          if (summary.truncated) summaryBox.appendChild(el('p', 'eng-line eng-dim', '（摘要已截断）'))
        }
        const state = status.state
        if (state) {
          summaryBox.appendChild(el('p', 'eng-line eng-dim',
            `运行 ${formatDuration(Date.now() - (status.startedAt || Date.now()))} · 修复轮次 ${state.repairRounds} · stall ${state.stallLevel} · 自有进程 ${state.ownedProcesses}`))
          if (state.deadline) {
            summaryBox.appendChild(el('p', 'eng-line eng-dim',
              `剩余预算 ${formatDuration(state.deadline.remainingMs)}（band: ${state.deadline.band}）`))
          }
        }
      }
      if (phasesBox && Array.isArray(status.phases) && !phasesBox.childElementCount) {
        const reached = new Set((status.report && status.report.phases) || [])
        for (const phase of status.phases) {
          phasesBox.appendChild(el('span', `eng-phase ${reached.has(phase) ? 'reached' : ''}`, phase))
        }
      }
    }

    function renderReport(report) {
      if (!reportBox) return
      reportBox.textContent = ''
      if (!report) {
        reportBox.appendChild(el('p', 'eng-empty', '还没有执行记录。'))
        return
      }
      const verdict = el('p', 'eng-line')
      verdict.appendChild(el('strong', null, `结果：${report.result}`))
      if (report.durationMs !== undefined) verdict.appendChild(el('span', 'eng-dim', ` · ${formatDuration(report.durationMs)}`))
      reportBox.appendChild(verdict)
      const validation = report.validation
      if (validation && validation.reasons && validation.reasons.length) {
        for (const reason of validation.reasons) reportBox.appendChild(el('p', 'eng-line bad', `未通过：${reason}`))
      }
      const files = Array.isArray(report.filesChanged) ? report.filesChanged : []
      reportBox.appendChild(el('p', 'eng-line eng-dim', files.length ? `改动：${files.join('、')}` : '未改动任何文件'))
      const commands = Array.isArray(report.commands) ? report.commands : []
      for (const entry of commands.slice(-8)) {
        reportBox.appendChild(el('p', 'eng-line eng-dim',
          `${entry.exitCode === 0 ? '✓' : '✗'} ${entry.command} (exit ${entry.exitCode}${entry.timedOut ? ', timeout' : ''})`))
      }
      const failures = Array.isArray(report.failures) ? report.failures : []
      for (const failure of failures.slice(-5)) {
        reportBox.appendChild(el('p', 'eng-line bad', `失败：${failure.class} — ${failure.reason || ''}`))
      }
      if (report.error) reportBox.appendChild(el('p', 'eng-line bad', report.error))
      if (report.repository) {
        reportBox.appendChild(el('p', 'eng-line eng-dim',
          `仓库：${report.repository.branch || '(detached)'} @ ${String(report.repository.head || '').slice(0, 8)}`))
      }
    }

    async function describe() {
      const bridge = window.megaEngineering
      if (!bridge) {
        say('Engineering bridge 不可用（preload 未加载）。', 'bad')
        return
      }
      if (describing) return
      describing = true
      say('识别仓库中…')
      try {
        const info = await bridge.describe({ workspace: request().workspace })
        renderDiscovery(info)
        say(info.ok === false ? info.error : '已识别该仓库将使用的命令。', info.ok === false ? 'bad' : 'ok')
      } catch (error) {
        say(`识别失败：${error.message}`, 'bad')
      } finally {
        describing = false
      }
    }

    async function refresh() {
      const bridge = window.megaEngineering
      if (!bridge) {
        say('Engineering bridge 不可用（preload 未加载）。', 'bad')
        return
      }
      try {
        const status = await bridge.status()
        renderState(status)
        renderReport(status && status.report)
        const running = Boolean(status && status.running)
        if (running) schedule()
        else busy(false)
      } catch (error) {
        say(`读取状态失败：${error.message}`, 'bad')
      }
    }

    /** Poll while an episode runs: a renderer cannot await a 24-hour episode. */
    function schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        timer = null
        await refresh()
      }, POLL_MS)
    }

    async function start() {
      const bridge = window.megaEngineering
      if (!bridge) {
        say('Engineering bridge 不可用（preload 未加载）。', 'bad')
        return
      }
      let payload
      try {
        payload = request()
      } catch (error) {
        say(error.message, 'bad')
        return
      }
      if (!payload.workspace) {
        say('请先填写仓库路径。', 'bad')
        return
      }
      if (!payload.goal) {
        say('请先填写目标（goal）。', 'bad')
        return
      }
      busy(true)
      say('已提交 episode…')
      try {
        const accepted = await bridge.run(payload)
        if (!accepted || accepted.ok === false) {
          say((accepted && accepted.error) || 'episode 未能启动', 'bad')
          busy(false)
          return
        }
        say(`episode ${accepted.episode} 已启动，正在执行。`)
        await refresh()
        schedule()
      } catch (error) {
        say(`启动失败：${error.message}`, 'bad')
        busy(false)
      }
    }

    async function cancel() {
      const bridge = window.megaEngineering
      if (!bridge) return
      try {
        const result = await bridge.cancel({ reason: 'cancelled from the panel' })
        say(result && result.cancelled ? '已请求取消；episode 会在下一个步骤边界停下。' : '当前没有正在执行的 episode。')
      } catch (error) {
        say(`取消失败：${error.message}`, 'bad')
      }
    }

    if (buttons.describe) buttons.describe.addEventListener('click', () => describe())
    if (buttons.run) buttons.run.addEventListener('click', () => start())
    if (buttons.cancel) buttons.cancel.addEventListener('click', () => cancel())
    if (buttons.refresh) buttons.refresh.addEventListener('click', () => refresh())
    if (goalInput && !goalInput.value.trim()) goalInput.value = DEFAULT_GOAL
    if (deadlineInput && !deadlineInput.value) deadlineInput.value = '1440'
    busy(false)
    return { refresh, describe, start, cancel, stop: () => timer && clearTimeout(timer) }
  }

  window.megaEngineeringPanel = { attach }
})()
