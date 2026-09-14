'use strict'

/**
 * The MEGA Control Center's data (`updateplan/startup2.md` §45-§47).
 *
 * The expanded dock is where the enhancement layer is managed: what is running, what it costs, what is
 * degraded, and what can be done about it. This module turns the *same snapshot the rest of the dock reads*
 * plus the two reports that belong to the enhancement layer — the protection layer's and the bundled plugin
 * set's — into sections of rows and a list of actionable modules.
 *
 * It is pure on purpose: the shell hands it data, it answers with data, and the dock renders it. Three
 * consequences the plan cares about:
 *
 *   * **one source of truth.** The numbers here come from the snapshot the panels next to it are drawn from,
 *     so a queue count cannot disagree with the queue panel.
 *   * **the actions come from the state** (§47). A healthy module offers a health re-read; a degraded one
 *     offers retry and "let the fallback stand"; a bundled plugin that is not installed offers repair —
 *     which the bundled manager itself refuses while the pin is untested. A UI that offered every action
 *     for every state would be a UI that promises things the layer will not do.
 *   * **zero is quiet here too** (§36): a fault count of zero is reported as `0` in the diagnostics list but
 *     never as a tone, because the tone is what draws the eye.
 */

/** A row: the two labels the plan writes side by side, a value, and the tone that makes it visible. */
function row(cn, en, value, tone = null) {
  return { cn, en, value: value === undefined || value === null ? '—' : String(value), tone }
}

function moduleTone(state) {
  if (state === 'HEALTHY') return 'ok'
  if (state === 'DISABLED') return null
  if (state === 'FAILED') return 'bad'
  return 'warn'
}

function pluginTone(state) {
  if (state === 'installed') return 'ok'
  if (state === 'incompatible' || state === 'failed') return 'bad'
  return null
}

/** Which actions a protection module's state allows (§47). */
function moduleActions(state) {
  if (state === 'DISABLED') return ['retry']
  return ['check', 'retry', 'reset-fallback']
}

/** Which actions a bundled plugin's state allows. */
function pluginActions(state) {
  if (state === 'user-disabled') return ['enable']
  if (state === 'installed' || state === 'ahead-of-pin') return ['disable', 'repair']
  return ['repair']
}

/**
 * @param {object} input
 * @param {object} input.snapshot     the dock's own snapshot
 * @param {object} [input.protection] `protection.describe()`
 * @param {object} [input.bundled]    `bundled().describe()`
 * @param {object} [input.boot]       `startup.summary()`
 * @param {object} [input.cache]      `startupCache().describe()` — a warm-start hint, never an owner (§52)
 */
function buildControlCenter({ snapshot = {}, protection = null, bundled = null, boot = null, cache = null } = {}) {
  const scheduler = snapshot.scheduler || {}
  const active = scheduler.activeQueue || {}
  const counts = scheduler.counts || {}
  const concurrency = scheduler.concurrency || {}
  const system = scheduler.system || {}
  const sub = snapshot.subWorker || {}
  const degraded = (protection?.degraded || []).length
  const failed = (protection?.failed || []).length
  const failing = Number(counts.BLOCKED || 0) + Number(counts.RETRYING || 0) + Number(counts.FAILED || 0)

  const sections = [
    {
      id: 'execution',
      cn: '执行',
      en: 'Execution',
      rows: [
        row('运行中的 worker', 'Running workers', active.workerSlotsInUse ?? 0, 'busy'),
        row('排队任务', 'Queued tasks', active.queued ?? 0),
        row('阻塞', 'Blocked', counts.BLOCKED || 0, counts.BLOCKED ? 'warn' : null),
        row('重试中', 'Retrying', counts.RETRYING || 0, counts.RETRYING ? 'warn' : null),
        row('失败', 'Failed', counts.FAILED || 0, counts.FAILED ? 'bad' : null)
      ]
    },
    {
      id: 'automation',
      cn: '自动化',
      en: 'Automation',
      rows: [
        row('子工作器', 'Sub-worker', sub.available === false ? 'UNAVAILABLE' : String(sub.state || 'OFF').toUpperCase(), sub.enabled ? 'ok' : null),
        row('自动委派', 'Auto delegation', sub.config?.autoDelegate ? 'ON' : 'OFF', sub.config?.autoDelegate ? 'ok' : null),
        row('队列自动重试', 'Queue auto-retry', counts.RETRYING ? 'active' : 'idle')
      ]
    },
    {
      id: 'resources',
      cn: '资源',
      en: 'Resources',
      rows: [
        row('并发 / 上限', 'Concurrency / cap', `${concurrency.current ?? '—'} / ${concurrency.hardwareCap ?? '—'}`),
        row('电费时段', 'Price window', scheduler.peak?.peak ? 'PEAK' : 'VALLEY', scheduler.peak?.peak ? 'warn' : null),
        row('CPU', 'CPU', system.cpu?.usagePercent === undefined ? '—' : `${Math.round(system.cpu.usagePercent)}%`),
        row('内存', 'RAM', system.memory?.usedGb === undefined ? '—' : `${Number(system.memory.usedGb).toFixed(1)} GB`)
      ]
    },
    {
      id: 'extensions',
      cn: '扩展',
      en: 'Extensions',
      rows: [
        ...(bundled?.plugins || []).map((plugin) => row(plugin.id, plugin.id, String(plugin.state || '').toUpperCase(), pluginTone(plugin.state))),
        row('已启用功能', 'Features on', Object.values(snapshot.features || {}).filter(Boolean).length)
      ]
    },
    {
      id: 'protection',
      cn: '保护层',
      en: 'Protection',
      rows: [
        ...(protection?.modules || []).map((module) => row(module.id, module.id, module.state, moduleTone(module.state))),
        row('降级模块', 'Degraded modules', degraded, degraded ? 'warn' : null),
        row('失败模块', 'Failed modules', failed, failed ? 'bad' : null),
        row('最近回退', 'Last fallback', (protection?.events || []).filter((event) => event.event === 'fallback').slice(-1)[0]?.module || '—')
      ]
    },
    {
      id: 'diagnostics',
      cn: '诊断',
      en: 'Diagnostics',
      rows: [
        row('启动阶段', 'Boot phases', boot ? (boot.phases || []).length : '—'),
        row('启动状态', 'Boot state', boot?.state || '—', boot?.interactive ? 'ok' : null),
        row('本产品开销', 'Own overhead', boot?.ownOverhead === null || boot?.ownOverhead === undefined ? '—' : `${boot.ownOverhead}ms`),
        row('超预算阶段', 'Over budget', (boot?.overBudget || []).join(', ') || 'none', (boot?.overBudget || []).length ? 'warn' : 'ok'),
        // §52: the cache is a hint about the *previous* run, and it says so — a cold start is not a fault.
        row('上次启动缓存', 'Startup cache', cache?.at ? (cache.warm ? 'warm' : 'stale') : 'cold', cache?.warm ? 'ok' : null),
        row('上次工作区', 'Last workspace', cache?.entries?.workspace || '—')
      ]
    }
  ]

  const modules = (protection?.modules || []).map((module) => ({
    id: module.id,
    state: module.state,
    version: module.version,
    startMs: module.startMs,
    retries: module.retries,
    lastError: module.lastError,
    fallback: module.fallback,
    tone: moduleTone(module.state),
    actions: moduleActions(module.state)
  }))

  const plugins = (bundled?.plugins || []).map((plugin) => ({
    id: plugin.id,
    state: plugin.state,
    installed: plugin.present === true,
    expected: plugin.expected,
    installedVersion: plugin.installedVersion,
    reason: plugin.reason,
    tone: pluginTone(plugin.state),
    actions: pluginActions(plugin.state)
  }))

  return { ok: true, sections, modules, plugins, degraded, failed, failing }
}

module.exports = { buildControlCenter, moduleActions, pluginActions, moduleTone, pluginTone }
