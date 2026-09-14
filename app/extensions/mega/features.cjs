'use strict'

/**
 * The Mega feature registry.
 *
 * The dock is a collection of features — balance, peak/valley pricing, themes, skills, the
 * queue, Computer Use, the engineering runtime, the updater — and until now each of them
 * existed only as markup plus a handful of IPC channels. That is fine for rendering and
 * hopeless for *managing*: nothing could enumerate the set, nothing could say what a feature
 * was for, and nothing could switch one off.
 *
 * This file is the set as data, and it is what makes "manage all the plugins" mean
 * something on the HNS side of the product, the way the capability registry does on the
 * platform side:
 *
 *   * every feature has an id, a bilingual name, a group and a description;
 *   * a feature declares the dock panels it owns and the IPC channels it answers;
 *   * `enabled` is durable state, not a UI hint — a disabled feature's channels refuse, its
 *     panels and marked elements are hidden, and its periodic work does not run.
 *
 * A feature is not a platform plugin: plugins are mounted through the capability registry
 * and can be loaded from anywhere, while these are the product's own surfaces. They share
 * one manager because a user does not care which side of that line a switch is on.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The feature groups, in the order the manager draws them. */
const FEATURE_GROUPS = Object.freeze(['Coding', 'Autonomy', 'Execution', 'Observability', 'Interface'])

/**
 * The registry.
 *
 * `panels` are dock sections the feature owns; `elements` are individual controls inside a
 * shared panel (the peak/valley switches live in the queue and the settings sheet), which is
 * why a feature may contribute to a panel it does not own. `channels` are what the feature
 * answers: a disabled feature's channels refuse with a reason, so "off" is not merely
 * invisible.
 */
const MEGA_FEATURES = Object.freeze([
  {
    id: 'mega.control-center',
    cn: '控制中心',
    en: 'Control Center',
    group: 'Interface',
    purpose: { cn: '查看并管理增强层的执行、资源、扩展与保护状态', en: 'See and manage the enhancement layer: execution, resources, extensions, protection' },
    panels: ['controlPanel'],
    elements: [],
    channels: ['mega:control-*']
  },
  {
    id: 'mega.engineering',
    cn: '工程运行时',
    en: 'Engineering runtime',
    group: 'Autonomy',
    purpose: { cn: '接收仓库与目标，自主完成工程任务', en: 'Run a bounded engineering episode against a repository' },
    panels: ['engineeringPanel'],
    elements: [],
    channels: ['engineering:*']
  },
  {
    id: 'mega.sub-worker',
    cn: '子任务工作器',
    en: 'Sub-worker',
    group: 'Autonomy',
    purpose: { cn: '把任务交给独立子进程执行并回传结果', en: 'Delegate tasks to an isolated worker process' },
    panels: ['subWorkerPanel'],
    elements: [],
    channels: ['sub-worker:*']
  },
  {
    id: 'mega.queue',
    cn: '手动队列',
    en: 'Manual queue',
    group: 'Autonomy',
    purpose: { cn: '排定需要按顺序执行的任务', en: 'Schedule the tasks that run in order' },
    panels: ['queuePanel'],
    elements: [],
    channels: ['mega:add-task', 'mega:remove-tasks', 'mega:reorder-task', 'mega:cancel-task', 'mega:clear-pending', 'mega:update-scheduler']
  },
  {
    id: 'mega.peak-pricing',
    cn: '峰谷价格监控',
    en: 'Peak / valley pricing',
    group: 'Observability',
    purpose: { cn: '按 DeepSeek 峰谷时段决定任务何时执行', en: 'Decide when a task may run from the peak/off-peak window' },
    panels: [],
    // `railPeak` is gone: the rail is composed from registered items now (`mega/mega-items.cjs`), and
    // a peak/valley window is a billing fact that belongs in the expanded summary, not on the rail.
    elements: ['allowPeak', 'defaultAllowPeak', 'interruptRunningAtPeak'],
    channels: []
  },
  {
    id: 'mega.balance',
    cn: '账户余额',
    en: 'Account balance',
    group: 'Observability',
    purpose: { cn: '查询 DeepSeek 账户余额与用量', en: 'Read the DeepSeek account balance and usage' },
    panels: ['balancePanel'],
    elements: [],
    channels: ['mega:balance']
  },
  {
    id: 'mega.computer-use',
    cn: '计算机操作',
    en: 'Computer Use',
    group: 'Execution',
    purpose: { cn: '在 GUI 上观测并执行动作', en: 'Observe and act on a GUI when a task needs it' },
    panels: ['computerUsePanel'],
    elements: [],
    channels: ['computer-use:*']
  },
  {
    id: 'mega.hardware',
    cn: '硬件自适应并行',
    en: 'Adaptive hardware parallelism',
    group: 'Execution',
    purpose: { cn: '按 CPU / RAM 实时余量决定并发槽', en: 'Derive concurrency from live CPU and RAM headroom' },
    panels: ['hardwarePanel'],
    elements: [],
    channels: ['mega:refresh-hardware']
  },
  {
    id: 'mega.theme',
    cn: '官方界面主题',
    en: 'Official-surface themes',
    group: 'Interface',
    purpose: { cn: '把主题包应用到官方界面外框与覆盖层；Dock 永远是磨砂玻璃，不受主题影响', en: 'Apply theme packages to the official shell and overlay; the dock is frosted glass and takes no theme' },
    // No panel: the theme engine's only control surface was the Appearance panel, and that is the
    // frosted-glass controls now, which are chrome rather than a feature — a switch that could be
    // switched off is a switch the user cannot use to put it back.
    panels: [],
    elements: [],
    channels: ['mega:theme-*']
  },
  {
    id: 'mega.skills',
    cn: '技能管理',
    en: 'Skills',
    group: 'Interface',
    purpose: { cn: '安装与管理技能包', en: 'Install and manage skill packages' },
    panels: ['skillsPanel'],
    elements: [],
    channels: ['mega:skills-*']
  },
  {
    id: 'mega.plugins',
    cn: '插件管理',
    en: 'Plugin manager',
    group: 'Interface',
    purpose: { cn: '管理平台插件与功能插件', en: 'Manage the platform plugins and the feature plugins' },
    panels: ['pluginsPanel'],
    elements: [],
    channels: ['plugins:*']
  },
  {
    id: 'mega.update',
    cn: '拓展状态',
    en: 'Extension status',
    group: 'Interface',
    purpose: { cn: '对齐官方 Harness 版本并升级', en: 'Align with the official Harness release and upgrade' },
    panels: ['updatePanel'],
    elements: [],
    channels: ['mega:update-check', 'mega:update-apply']
  }
])

/** A stable id lookup, built once. */
const FEATURE_BY_ID = new Map(MEGA_FEATURES.map((feature) => [feature.id, feature]))

function isKnownFeature(id) {
  return FEATURE_BY_ID.has(String(id))
}

function featureFor(id) {
  return FEATURE_BY_ID.get(String(id)) || null
}

/**
 * Which feature answers a channel.
 *
 * `engineering:run` matches the `engineering:*` declaration, and an exact channel matches
 * itself, so the gate can ask "may this channel run?" without a second table.
 */
function featureForChannel(channel) {
  const name = String(channel || '')
  if (!name) return null
  for (const feature of MEGA_FEATURES) {
    for (const declared of feature.channels) {
      if (declared.endsWith('*') ? name.startsWith(declared.slice(0, -1)) : declared === name) return feature
    }
  }
  return null
}

/**
 * The durable enable/disable state.
 *
 * The file stores **explicit decisions**, not a list of disabled features: a feature shipped
 * off by default has to be turnable *on*, so "absent means the default" only works if both
 * values can be written down. Unknown ids are refused rather than stored — a state file that
 * accumulates ids nobody knows is a state file whose decisions cannot be trusted.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {object} [options.defaults] `{ [id]: boolean }` — the shipped default per feature
 * @param {Function} [options.log]
 */
function createFeatureState(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : null
  const log = typeof options.log === 'function' ? options.log : () => {}
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {}
  /** id -> explicit boolean decision. */
  const decisions = new Map()
  let lastIssue = null
  let loaded = false

  function read() {
    if (loaded) return
    loaded = true
    if (!file) return
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') lastIssue = `feature state unreadable: ${error?.message || error}`
      return
    }
    const stored = raw && typeof raw.features === 'object' && raw.features !== null ? raw.features : {}
    for (const [id, value] of Object.entries(stored)) {
      if (!isKnownFeature(id)) {
        lastIssue = `unknown feature "${id}" in the state file was ignored`
        continue
      }
      decisions.set(id, value === true)
    }
  }

  function persist() {
    if (!file) return { ok: true, persisted: false, reason: 'no state file is configured' }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const features = {}
      for (const id of [...decisions.keys()].sort()) features[id] = decisions.get(id)
      fs.writeFileSync(file, `${JSON.stringify({ version: 1, features }, null, 2)}\n`, 'utf8')
      return { ok: true, persisted: true }
    } catch (error) {
      lastIssue = `feature state could not be written: ${error?.message || error}`
      log(lastIssue)
      return { ok: false, persisted: false, reason: lastIssue }
    }
  }

  function isEnabled(id) {
    read()
    const key = String(id || '')
    if (!isKnownFeature(key)) return false
    if (decisions.has(key)) return decisions.get(key) === true
    return defaults[key] !== false
  }

  function setEnabled(id, enabled) {
    read()
    const key = String(id || '')
    if (!isKnownFeature(key)) return { ok: false, reason: `no feature ${key}`, code: 'FEATURE_NOT_FOUND' }
    const wanted = enabled !== false
    decisions.set(key, wanted)
    const written = persist()
    return { ok: written.ok !== false, id: key, enabled: wanted, persisted: written.persisted === true, reason: written.reason || null }
  }

  return {
    file,
    isEnabled,
    setEnabled,
    /** The whole set with its state, for the manager UI. */
    describe() {
      read()
      return MEGA_FEATURES.map((feature) => ({
        id: feature.id,
        cn: feature.cn,
        en: feature.en,
        group: feature.group,
        purpose: feature.purpose,
        panels: feature.panels.slice(),
        elements: feature.elements.slice(),
        channels: feature.channels.slice(),
        enabled: isEnabled(feature.id),
        kind: 'feature'
      }))
    },
    /** The compact map the dock applies to its markup. */
    enabledMap() {
      const map = {}
      for (const feature of MEGA_FEATURES) map[feature.id] = isEnabled(feature.id)
      return map
    },
    issues: () => (lastIssue ? [lastIssue] : [])
  }
}

module.exports = {
  MEGA_FEATURES,
  FEATURE_GROUPS,
  isKnownFeature,
  featureFor,
  featureForChannel,
  createFeatureState
}
