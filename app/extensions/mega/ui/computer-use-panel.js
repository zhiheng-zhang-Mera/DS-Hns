'use strict'

/**
 * DS-Hns Computer Use panel (Update-Plan/computer-use.md).
 *
 * The dock is a *control surface*, never an executor: it edits an execution
 * contract (goal, plan steps, success criteria, limits, safety) and hands it to
 * the shell-owned runtime over `computer-use:*` IPC. Everything it shows —
 * controller health, the live state machine, the per-step log, whether a
 * screenshot was retained — comes from the runtime's own report, so the panel
 * cannot invent progress the executor did not observe.
 *
 * It is deliberately one file with no dependencies, matching the other panel
 * modules (skills, theme): a failure here can never stop the queue or hardware
 * modules from rendering.
 */
(function attachComputerUsePanel() {
  function $(id) {
    return document.getElementById(id)
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  const DEFAULT_PLAN = [
    {
      id: 'navigate',
      action: { type: 'BROWSER_NAVIGATE', url: 'https://github.com/zhiheng-zhang-Mera/DS-Hns' }
    }
  ]

  function attach() {
    const root = $('computerUsePanel')
    if (!root) return null
    const goal = $('cuGoal')
    const planText = $('cuPlan')
    const criteriaText = $('cuCriteria')
    const status = $('cuStatus')
    const message = $('cuMessage')
    const stateChip = $('cuState')
    const healthGrid = $('cuHealth')
    const stepsBox = $('cuSteps')
    const summary = $('cuSummary')
    const pageInfo = $('cuPage')
    const autonomy = $('cuAutonomy')
    const capabilityBoxes = Array.from(root.querySelectorAll('input[data-capability]'))
    const buttons = {
      run: $('cuRun'),
      step: $('cuStep'),
      cancel: $('cuCancel'),
      refresh: $('cuRefresh'),
      snapshot: $('cuScreenshot')
    }

    if (planText && !planText.value.trim()) planText.value = JSON.stringify(DEFAULT_PLAN, null, 2)

    function busy(flag) {
      for (const button of Object.values(buttons)) {
        if (button) button.disabled = Boolean(flag)
      }
      if (status) status.classList.toggle('busy', Boolean(flag))
    }

    function say(text, kind) {
      if (!message) return
      message.textContent = text || ''
      message.className = kind ? `theme-message ${kind}` : 'theme-message'
    }

    function parseJson(text, label) {
      const raw = String(text || '').trim()
      if (!raw) return undefined
      try {
        return JSON.parse(raw)
      } catch (error) {
        throw new Error(`${label} 不是合法 JSON：${error.message}`)
      }
    }

    /** Builds the contract from the form. Nothing is defaulted silently. */
    function buildContract() {
      const capabilities = capabilityBoxes.filter((box) => box.checked).map((box) => box.dataset.capability)
      const contract = {
        goal: String(goal?.value || '').trim(),
        allowed_capabilities: capabilities,
        source: 'mega-panel'
      }
      const plan = parseJson(planText?.value, 'plan')
      if (plan !== undefined) contract.plan = plan
      const criteria = parseJson(criteriaText?.value, 'success_criteria')
      if (criteria !== undefined) contract.success_criteria = criteria
      contract.autonomy_enabled = Boolean(autonomy?.checked)
      contract.limits = {
        max_steps: Number($('cuMaxSteps')?.value) || undefined,
        max_retries_per_action: Number($('cuMaxRetries')?.value) || undefined
      }
      contract.safety = {
        destructive_actions: $('cuDestructive')?.value || 'confirm'
      }
      return contract
    }

    function renderHealth(health) {
      if (!healthGrid) return
      healthGrid.textContent = ''
      for (const controller of health.controllers || []) {
        const card = el('div', 'cu-health-card')
        card.classList.toggle('degraded', !controller.available)
        card.appendChild(el('b', null, controller.controller))
        card.appendChild(el('span', null, controller.available ? 'ready' : `degraded: ${controller.reason || 'unknown'}`))
        healthGrid.appendChild(card)
      }
      if (stateChip) {
        stateChip.textContent = health.state || 'IDLE'
        stateChip.className = `status-chip ${health.running ? 'busy' : 'neutral'}`
      }
    }

    function renderSteps(entries) {
      if (!stepsBox) return
      stepsBox.textContent = ''
      const steps = (entries || []).filter((entry) => entry.kind === 'step')
      if (!steps.length) {
        stepsBox.appendChild(el('p', 'cu-empty', '尚无执行步骤。'))
        return
      }
      for (const step of steps) {
        const row = el('div', 'cu-step')
        const verdict = step.result === 'success' ? 'ok' : step.result === 'unknown' ? 'warn' : 'bad'
        row.classList.add(`cu-${verdict}`)
        row.appendChild(el('span', 'cu-step-no', `#${step.step}`))
        row.appendChild(el('span', 'cu-step-action', step.action || step.actionType || '—'))
        row.appendChild(el('span', 'cu-step-channel', step.channel || '—'))
        row.appendChild(el('span', 'cu-step-verify', step.verification || step.result || '—'))
        const timing = []
        if (Number.isFinite(step.stabilizationMs)) timing.push(`settle ${step.stabilizationMs}ms`)
        if (Number.isFinite(step.graceMs)) timing.push(`grace ${step.graceMs}ms`)
        if (Number.isFinite(step.waitMs) && step.waitMs > 0) timing.push(`wait ${step.waitMs}ms`)
        if (timing.length) row.appendChild(el('span', 'cu-step-timing', timing.join(' · ')))
        if (step.retryCount) row.appendChild(el('span', 'cu-step-retry', `retry×${step.retryCount}`))
        if (step.coordinateFallback) row.appendChild(el('span', 'cu-step-coord', 'coordinate'))
        stepsBox.appendChild(row)
      }
    }

    function renderSummary(report) {
      if (!summary) return
      summary.textContent = ''
      if (!report) {
        summary.appendChild(el('p', 'cu-empty', '尚未运行任务。'))
        return
      }
      const lines = [
        `状态：${report.status}`,
        `步骤：${report.steps ?? 0}`,
        report.criteria && report.criteria.results && report.criteria.results.length
          ? `完成条件：${report.criteria.satisfied ? '已满足' : report.criteria.unknown ? '无法判定' : '未满足'}`
          : '完成条件：未声明'
      ]
      for (const line of lines) summary.appendChild(el('p', null, line))
      for (const result of (report.criteria && report.criteria.results) || []) {
        const item = el('p', 'cu-criterion', `${result.verdict === 'satisfied' ? '✔' : result.verdict === 'unknown' ? '?' : '✘'} ${result.description}`)
        summary.appendChild(item)
      }
      if (report.error) summary.appendChild(el('p', 'cu-error', `${report.error.code}: ${report.error.message}`))
    }

    function renderPage(info) {
      if (!pageInfo) return
      pageInfo.textContent = info && info.attached
        ? `页面：${info.title || '(无标题)'} — ${info.url}（${info.controls} 个控件）`
        : `页面：未附着（${(info && info.reason) || '未知原因'}）`
    }

    async function refresh() {
      if (!window.megaComputerUse) {
        say('Computer Use bridge 不可用（preload 未加载）。', 'bad')
        return
      }
      try {
        const snapshot = await window.megaComputerUse.snapshot()
        if (snapshot && snapshot.ok === false) {
          say(snapshot.error, 'bad')
          return
        }
        renderHealth(snapshot.health || snapshot)
        renderSteps(snapshot.recentSteps)
        const page = await window.megaComputerUse.page()
        renderPage(page)
      } catch (error) {
        say(`读取 Computer Use 状态失败：${error.message}`, 'bad')
      }
    }

    async function runTask(singleStep) {
      let contract
      try {
        contract = buildContract()
      } catch (error) {
        say(error.message, 'bad')
        return
      }
      if (!contract.goal) {
        say('请先填写目标（goal）。', 'bad')
        return
      }
      busy(true)
      say(singleStep ? '执行单步…' : '执行中…')
      try {
        const report = singleStep
          ? await window.megaComputerUse.step(contract)
          : await window.megaComputerUse.run(contract)
        if (report && report.ok === false) {
          say(report.error, 'bad')
        } else {
          renderSummary(report)
          say(`完成：${report.status}（${report.steps} 步）`, report.status === 'completed' ? 'ok' : '')
        }
        await refresh()
      } catch (error) {
        say(`执行失败：${error.message}`, 'bad')
      } finally {
        busy(false)
      }
    }

    buttons.run?.addEventListener('click', () => runTask(false))
    buttons.step?.addEventListener('click', () => runTask(true))
    buttons.refresh?.addEventListener('click', () => refresh())
    buttons.cancel?.addEventListener('click', async () => {
      try {
        await window.megaComputerUse.cancel('cancelled from the panel')
        say('已请求取消。')
      } catch (error) {
        say(`取消失败：${error.message}`, 'bad')
      }
    })
    buttons.snapshot?.addEventListener('click', async () => {
      try {
        const shots = await window.megaComputerUse.screenshots()
        const last = (shots || []).slice(-1)[0]
        say(last
          ? `最近截图：level ${last.level} · ${last.bytes} bytes · ${last.retained ? `已保留 ${last.path}` : `未落盘（${last.decision}）`}`
          : '本次运行尚未截图（视觉只在需要时启用）。')
      } catch (error) {
        say(`读取截图记录失败：${error.message}`, 'bad')
      }
    })

    return { refresh, root }
  }

  window.megaComputerUsePanel = { attach }
})()
