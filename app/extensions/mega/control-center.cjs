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

/**
 * A row: the two labels the plan writes side by side, a value, and the tone that makes it visible.
 *
 * `extra` carries the fields a *dashboard* row needs and a Control Center row does not — its id, and (for the
 * countdown) the instant the price window changes, so the view model can subtract against its own clock
 * instead of carrying a number of seconds that was already stale when it was written.
 */
function row(cn, en, value, tone = null, extra = null) {
  return { cn, en, value: value === undefined || value === null ? '—' : String(value), tone, ...(extra || {}) }
}

/** A row of the view model's dashboard: the same two labels, a value, a tone — and an id, so a surface can find it. */
function field(id, cn, en, value, tone = null) {
  return { id, cn, en, value: value === undefined || value === null || value === '' ? '—' : String(value), tone }
}

/** A titled group of rows. Same shape as the Control Center's own sections, one level down. */
function group(id, cn, en, rows) {
  return { id, cn, en, rows }
}

/** `172` → `2m 52s`; anything that is not a finite count of seconds answers `—` rather than inventing a zero. */
function durationText(seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total)) return '—'
  const whole = Math.max(0, Math.floor(total))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${rest}s`
  return `${rest}s`
}

/** `8231` → `8.2 GB`. A megabyte is the smallest unit that is still readable here. */
function bytesText(kilobytes) {
  const value = Number(kilobytes)
  if (!Number.isFinite(value)) return '—'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} GB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} MB`
  return `${Math.round(value)} KB`
}

/**
 * A clock time in the **billing** zone, which is not necessarily this machine's.
 *
 * The price windows are wall-clock times in the schedule's own zone (`billing/peak-engine.js`: Asia/Shanghai),
 * so the next change has to be printed there — a user in another zone reading a local time would see a figure
 * that matches nothing on the price page, and a task suspended "until 06:00" would look wrong.
 */
const zoneClockFormat = new Map()
function clockInZone(iso, timeZone) {
  const at = new Date(String(iso || ''))
  if (Number.isNaN(at.getTime())) return null
  try {
    let format = zoneClockFormat.get(timeZone)
    if (!format) {
      format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      zoneClockFormat.set(timeZone, format)
    }
    return format.format(at)
  } catch {
    // A zone the runtime does not know is the engine's own fallback too, and UTC is better than no time.
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`
  }
}

/** A currency code as the symbol people read, falling back to the code itself rather than to a guess at ¥. */
function currencySymbol(code) {
  const key = String(code || '').toUpperCase()
  if (key === 'CNY' || key === 'RMB') return '¥'
  if (key === 'USD') return '$'
  return key || ''
}

/** The balance headline: `¥ 12.34`, and `—` when there has never been a successful read (never `¥ 0.00`). */
function balanceAmount(balance) {
  const rows = Array.isArray(balance?.balances) ? balance.balances : []
  const primary = rows[0]
  if (!primary || primary.total === undefined || primary.total === null || !Number.isFinite(Number(primary.total))) return null
  return `${currencySymbol(primary.currency)} ${Number(primary.total).toFixed(2)}`
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
 * @param {object} [input.appearance] `appearanceCost()` — what the appearance costs (§55-§57)
 * @param {object} [input.bridge]     `governanceBridge().describe()` — the channel the Mega plugin talks to
 * @param {object} [input.balance]    `balanceService.describe()` — the account the runs are billed to (MEGA-04)
 * @param {object} [input.pricing]    `PricingRepository.describe()` — which price list the cost is billed against
 */
function buildControlCenter({ snapshot = {}, protection = null, bundled = null, boot = null, cache = null, appearance = null, bridge = null, balance = null, pricing = null, services = null, advanced = null } = {}) {
  const scheduler = snapshot.scheduler || {}
  const active = scheduler.activeQueue || {}
  const counts = scheduler.counts || {}
  const concurrency = scheduler.concurrency || {}
  const system = scheduler.system || {}
  const sub = snapshot.subWorker || {}
  const degraded = (protection?.degraded || []).length
  const failed = (protection?.failed || []).length
  const failing = Number(counts.BLOCKED || 0) + Number(counts.RETRYING || 0) + Number(counts.FAILED || 0)
  /**
   * The tasks that have not run yet — the half of the queue a person can still change.
   *
   * `snapshot.tasks` is the scheduler's own active queue (`listTasks`, which is also what the dock's queue panel
   * draws), so a count and the list under it cannot disagree. The two statuses are `lifecycle.js`'s
   * `QUEUED_STATUSES`: PENDING has not been decided yet, SUSPENDED is waiting for its instant (or for the valley
   * price), and both are reorderable and editable — which is exactly why they are published as tasks with ids
   * rather than only as a number.
   */
  const queuedTasks = Array.isArray(snapshot.tasks)
    ? snapshot.tasks.filter((t) => t.status === 'PENDING' || t.status === 'SUSPENDED')
    : []
  const suspendedCount = Number(active.suspended || 0)
  const queuedCount = Number(active.queued || 0)
  const pendingCount = Math.max(0, queuedCount - suspendedCount)

  const sections = [
    {
      /**
       * The two built-in services, as their own section.
       *
       * They are the components whose failure the product is supposed to survive, so they are the two
       * a person most needs to see — and every line is the *service record's* own field, not a
       * re-derivation: the plugin manager's four states, the plugin's own health answer, and the
       * heartbeat the restart supervisor writes. A service that is declared but not enabled reads
       * `disabled`, which is a different thing from `missing` and from `faulted`.
       */
      id: 'services',
      cn: '内置服务',
      en: 'Built-in services',
      rows: Array.isArray(services) && services.length
        ? services.flatMap((service) => {
          const tone = service.ok !== true ? 'bad'
            : service.health && service.health.status === 'degraded' ? 'warn'
              : service.health && service.health.status === 'unknown' ? 'warn'
                : service.enabled !== true ? null
                  : service.healthy === false ? 'warn' : 'ok'
          const state = service.ok !== true ? 'NOT IN THE RUNTIME'
            : service.enabled !== true ? 'DISABLED'
              : service.loaded !== true ? 'ENABLED'
                : `${String(service.health && service.health.status || 'LOADED').toUpperCase()}`
          const rows = [
            row(service.name || service.id, service.name || service.id, state, tone),
            row(`${service.name || service.id} · 版本`, `${service.name || service.id} · version`, service.version || '—'),
            row(`${service.name || service.id} · 心跳`, `${service.name || service.id} · heartbeat`, service.heartbeat ? `${service.heartbeat.verdict || service.heartbeat}` : '—', service.heartbeat && (service.heartbeat.verdict === 'hung' || service.heartbeat.verdict === 'gone') ? 'bad' : null),
            row(`${service.name || service.id} · 能力`, `${service.name || service.id} · capabilities`, (service.capabilities && service.capabilities.provides || []).join(', ') || '—')
          ]
          if (service.lastError) {
            rows.push(row(`${service.name || service.id} · 最后错误`, `${service.name || service.id} · last error`, service.lastError.reason, 'bad'))
          }
          return rows
        })
        : [row('内置服务', 'Built-in services', 'report unavailable', 'warn')]
    },    {
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
        row('内存', 'RAM', system.memory?.usedGb === undefined ? '—' : `${Number(system.memory.usedGb).toFixed(1)} GB`),
        // §55-§57: the appearance's own cost, and any warning about it — measured, never clamped.
        row('玻璃模糊', 'Glass blur', appearance ? `${appearance.glass.blur}px` : '—', appearance && appearance.glass.blur > 14 ? 'warn' : null),
        row('图片负载', 'Picture payload', appearance ? `${appearance.wallpaper.kilobytes} KB` : '—', appearance && appearance.wallpaper.kilobytes > 4096 ? 'warn' : null),
        row('性能警示', 'Cost warnings', appearance ? (appearance.warnings || []).map((warning) => warning.id).join(', ') || 'none' : '—', appearance && (appearance.warnings || []).length ? 'warn' : appearance ? 'ok' : null)
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
        row('上次工作区', 'Last workspace', cache?.entries?.workspace || '—'),
        // Phase 1 of `pluginize.md`: Mega becomes a Harness plugin, and this is the channel it talks through.
        row('治理桥 / Mega 插件通道', 'Governance bridge', bridge?.ok ? `${bridge.host}:${bridge.port} · ${bridge.requests} req` : 'not listening', bridge?.ok ? 'ok' : 'warn')
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
    /**
     * The adoption state, in the three claims the manifest keeps apart: which channel it belongs to, whether
     * that channel was exercised for real, and whether it has been run inside this product. The panel shows
     * them because "declared", "installable" and "usable" are three different things to be looking at.
     */
    channel: plugin.channel || null,
    channelVerified: plugin.channelVerified === true,
    tested: plugin.tested === true,
    tone: pluginTone(plugin.state),
    actions: pluginActions(plugin.state)
  }))

  /**
   * The dashboard: the same live numbers the old expanded dock showed — the price window and its countdown,
   * the account balance, the scheduler's queue, and the parallelism it is allowed — moved here so the view
   * model can carry them to a surface that has no dock.
   *
   * It is assembled from the **same snapshot** the sections above are drawn from, plus the two reports that
   * were only ever read by the dock's own renderer (the billing service's answer and the price list the cost
   * is billed against). Nothing here is computed a second way, and a fact that is missing is reported as
   * missing rather than as zero: an account whose balance has never been read shows `—`, not `¥ 0.00`.
   *
   * The countdown is the one fact here that goes stale between reads — it ticks whether or not anyone asks —
   * so the snapshot carries the **instant** the window changes (`nextChangeIso`) rather than only a number of
   * seconds, and the view model subtracts against its own clock. A surface that drew the stored seconds would
   * show a countdown frozen at the moment of the snapshot.
   */
  const peak = scheduler.peak || {}
  const nextChange = peak.nextChange || null
  const nextIsValley = nextChange?.statusAfter === 'OFF-PEAK'
  const tariff = nextIsValley ? 'OFF-PEAK' : nextChange?.statusAfter || null
  const tariffCn = tariff === 'OFF-PEAK' ? '谷价' : tariff === 'PEAK' ? '峰价' : null
  const tariffEn = tariff === 'OFF-PEAK' ? 'Off-peak' : tariff === 'PEAK' ? 'Peak' : null
  const tariffSchedule = pricing?.schedule || null
  const tariffRates = Array.isArray(tariffSchedule?.peakPeriods)
    ? tariffSchedule.peakPeriods.map((window) => `${window.start}-${window.end}`).join(', ')
    : null
  const balanceRows = Array.isArray(balance?.balances) ? balance.balances : []
  const balancePrimary = balanceRows[0] || null
  const balanceTotal = balanceAmount(balance)
  const balanceState = balance?.refreshing ? 'refreshing'
    : balance?.ok ? 'ok'
      : balance?.hasData ? 'stale'
        : (balance?.error?.code === 'MISSING_CREDENTIAL' || balance?.error?.code === 'UNCONFIGURED') ? 'unconfigured'
          : (balance?.failedProviders || []).length ? 'failed' : 'unread'
  const balanceTone = balanceState === 'ok' ? 'ok' : balanceState === 'refreshing' ? 'busy' : (balanceState === 'unread' || balanceState === 'unconfigured') ? null : 'warn'
  const balanceNote = balanceState === 'ok' ? (balance?.stale ? '显示上次成功余额 · last good read' : '正常 · ok')
    : balanceState === 'refreshing' ? '刷新中 · refreshing'
      : balanceState === 'stale' ? '上次成功值 · stale'
        // A machine with no key is *not configured*, not broken: a warning tone on every boot of a machine that
        // never had a DeepSeek key would be a permanent alarm about a setting nobody was asked for.
        : balanceState === 'unconfigured' ? '未配置密钥 · no API key'
          : balanceState === 'failed' ? `读取失败 · ${balance?.error?.message || 'read failed'}`
            : '未刷新 · not read yet'

  const dashboard = {
    ok: true,
    lines: [
      group('price', '价格', 'Price', [
        // Being in the peak window is not a fault, it is the window (§41): the tone is the drawer of the eye,
        // and the Control Center's own resources section draws the same fact the same way.
        row('电费时段', 'Price window', peak.peak ? 'PEAK' : 'OFF-PEAK', peak.peak ? 'warn' : null, { id: 'price:window' }),
        row('峰价时段表', 'Peak windows', tariffRates ? `${tariffRates} · ${tariffSchedule.timeZone || '—'}` : (pricing ? '—' : 'unavailable'), pricing ? null : 'warn', { id: 'price:windows' }),
        row('价格来源', 'Price source', pricing ? `${pricing.source}${pricing.retrievedAt ? ` · ${pricing.retrievedAt}` : ''}` : '—', pricing ? null : 'warn', { id: 'price:source' }),
        // The countdown the old dock's timer card showed, relabelled for what it actually is: the time until the
        // price *changes*, which is "until off-peak" only while the peak window is on — the engine's
        // `nextChange` is the next transition in either direction, and calling that "until off-peak" during
        // off-peak would tell the user to wait for what they already have. The value here is the figure at
        // snapshot time; the view model re-derives it from `nextChangeIso` against its own clock, so a panel
        // opened later counts down from *its* now rather than from the moment the snapshot was taken. The
        // instant is what the view can use, so it is always published when the engine names one.
        row('距价格切换', 'Until price change', nextIsValley ? durationText(nextChange.secondsLeft) : nextChange ? '已是谷价 · off-peak now' : '—', nextIsValley ? 'ok' : null, {
          id: 'price:until-off-peak',
          nextChangeIso: nextChange?.iso || null
        }),
        row('下一次变化', 'Next change', nextChange?.iso ? `${clockInZone(nextChange.iso, tariffSchedule?.timeZone || 'Asia/Shanghai')} → ${tariffCn} ${tariffEn}` : '—', null, { id: 'price:next-change' })
      ]),
      group('balance', '账户', 'Account', [
        row('总余额', 'Total balance', balanceTotal, balanceTotal ? balanceTone : null, { id: 'balance:total' }),
        row('充值余额', 'Topped up', balancePrimary ? `${currencySymbol(balancePrimary.currency)} ${Number(balancePrimary.toppedUp || 0).toFixed(2)}` : '—', null, { id: 'balance:topped-up' }),
        row('赠送余额', 'Granted', balancePrimary ? `${currencySymbol(balancePrimary.currency)} ${Number(balancePrimary.granted || 0).toFixed(2)}` : '—', null, { id: 'balance:granted' }),
        row('读取状态', 'Balance read', balanceNote, balanceTone, { id: 'balance:state' }),
        row('上次成功', 'Last good read', balance?.lastUpdatedAt ? new Date(balance.lastUpdatedAt).toISOString() : '—', null, { id: 'balance:updated-at' })
      ]),
      group('sub-worker', '子工作器', 'Sub-worker', [
        row('子工作器', 'Sub-worker', sub.available === false ? 'UNAVAILABLE' : String(sub.state || 'OFF').toUpperCase(), sub.enabled ? 'ok' : null, { id: 'sub-worker:state' }),
        row('自动委派', 'Auto delegation', sub.config?.autoDelegate ? 'ON' : 'OFF', sub.config?.autoDelegate ? 'ok' : null, { id: 'sub-worker:auto-delegate' })
      ])
    ],
    execution: [
      /**
       * The queue's own state line, **first**, and it is first for the same reason the ball's entry point is: the
       * four categories fold, and a shut fold keeps only its heading and one value. "Running workers" was that
       * value, which meant a task that had just been suspended changed a number the user had to open the fold (and
       * scroll past three rows) to see — reported as "挂起任务数量没有改变". `:state` is the id the two balls look
       * for when they pick a shut fold's headline, so the number that moves is the number on the heading.
       */
      row('队列状态', 'Queue state', `已挂起 ${suspendedCount} · 等待 ${pendingCount}`, suspendedCount ? 'busy' : null, { id: 'execution:state' }),
      row('运行中的 worker', 'Running workers', active.workerSlotsInUse ?? 0, Number(active.workerSlotsInUse) ? 'busy' : null, { id: 'execution:running' }),
      row('排队任务', 'Queued tasks', active.queued ?? 0, null, { id: 'execution:queued' }),
      row('已挂起', 'Suspended', active.suspended ?? 0, null, { id: 'execution:suspended' }),
      row('阻塞', 'Blocked', counts.BLOCKED || 0, counts.BLOCKED ? 'warn' : null, { id: 'execution:blocked' }),
      row('重试中', 'Retrying', counts.RETRYING || 0, counts.RETRYING ? 'warn' : null, { id: 'execution:retrying' }),
      row('失败', 'Failed', counts.FAILED || 0, counts.FAILED ? 'bad' : null, { id: 'execution:failed' }),
      row('队列任务总数', 'Tasks in queue', active.total ?? 0, null, { id: 'execution:total' })
    ],
    parallelism: [
      row('当前并行', 'Concurrency now', concurrency.current ?? '—', null, { id: 'parallelism:current' }),
      row('硬件上限', 'Hardware cap', concurrency.hardwareCap ?? '—', null, { id: 'parallelism:hardware-cap' }),
      row('CPU 负载', 'CPU load', system.cpu?.usagePercent === undefined ? '—' : `${Math.round(system.cpu.usagePercent)}%`, null, { id: 'parallelism:cpu' }),
      row('空闲内存', 'Free RAM', system.memory?.freeGb === undefined ? '—' : `${Number(system.memory.freeGb).toFixed(1)} GB`, null, { id: 'parallelism:free-ram' })
    ]
  }
  // The three groups and the two bare lists as one flat list, in the order a dashboard reads: what it costs,
  // what is queued, what is left to spend, what may run at once. (`dashboardRow` is the Control Center's name
  // for one of these; the view model copies it as it stands.)
  dashboard.fields = [
    ...dashboard.lines.flatMap((entry) => entry.rows),
    ...dashboard.execution,
    ...dashboard.parallelism
  ]
  /**
   * What the dashboard's refresh button does, and when it is offered.
   *
   * The account is the one number on this dashboard that a *read* makes newer (everything else is recomputed by
   * every snapshot), so it is the one thing a refresh button can honestly promise. It is offered whenever a
   * read could change the answer — not read yet, stale, failed, unconfigured, or already refreshing (where the
   * button is what re-reads once the read in flight is done) — and **withheld** while the balance is fine,
   * because a button that re-reads a balance that is already current is a button that spends the rate limit to
   * change nothing.
   */
  dashboard.actions = balanceState === 'ok'
    ? []
    : [{ id: 'refresh-balance', cn: '刷新余额', en: 'Refresh balance', reason: balanceState }]

  /**
   * The queue itself: the tasks that have not run yet, as tasks.
   *
   * A count is not enough to act on. "已挂起 1" tells the user a task is waiting; it does not let them change what
   * it says, fix a time they mistyped, or move it in front of another one — which is what "不能编辑，也不能调顺序"
   * was. So the same list the dock's queue panel draws is published here with the fields a surface needs to *offer*
   * those operations: the id to address it by, the instant (as an ISO instant, never as a number of seconds that
   * was already stale when it was written), the decision the gate made, and its rank in the queue.
   *
   * What is **not** here is a promise about what may be done to a task: that is the scheduler's answer, and a
   * surface that guessed it would offer buttons the layer refuses. The two operations are the scheduler's own
   * (`editTask`, `reorderTask`), and both refuse a RUNNING task by name.
   */
  dashboard.queue = {
    ok: true,
    reason: null,
    counts: {
      pending: pendingCount,
      suspended: suspendedCount,
      running: Number(active.running || 0),
      total: Number(active.total || 0)
    },
    headline: `已挂起 ${suspendedCount} · 等待 ${pendingCount}`,
    tasks: queuedTasks.map((t) => ({
      id: String(t.id),
      prompt: String(t.promptPreview || t.prompt || ''),
      status: String(t.status || ''),
      reason: t.reason || null,
      startAtIso: Number.isFinite(t.startAtMs) ? new Date(t.startAtMs).toISOString() : null,
      allowPeak: t.allowPeak === true,
      deliveryMode: t.deliveryMode || null,
      rank: Number(t.queueRank) || null
    }))
  }

  return { ok: true, sections, dashboard, modules, plugins, services: Array.isArray(services) ? services : [], advanced: advanced || null, degraded, failed, failing }
}

module.exports = { buildControlCenter, moduleActions, pluginActions, moduleTone, pluginTone }
