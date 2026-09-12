'use strict'

/**
 * Computer Use Runtime: capability routing (plan §29).
 *
 * "Only behave like a human when behaving like a human is the only way."
 *
 * The router takes a requested action plus what the machine currently offers and
 * answers a narrower question than the planner: *through which channel should
 * this be carried out?*
 *
 *   api  →  shell  →  dom / accessibility  →  gui  →  vision + gui
 *
 * Every decision carries a reason and an ordered alternative list, so the
 * recovery ladder (plan §19) has something concrete to escalate to instead of
 * blindly retrying the same channel.
 */

const { ACTION_TYPES, ROUTE_CHANNELS } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { hasCapability } = require('./contract.cjs')

/** Action type → the channels that could possibly carry it, best first. */
const CHANNEL_PLANS = Object.freeze({
  [ACTION_TYPES.MOVE]: ['gui'],
  [ACTION_TYPES.CLICK]: ['dom', 'accessibility', 'gui', 'vision'],
  [ACTION_TYPES.DOUBLE_CLICK]: ['dom', 'accessibility', 'gui'],
  [ACTION_TYPES.RIGHT_CLICK]: ['dom', 'accessibility', 'gui'],
  [ACTION_TYPES.TYPE]: ['dom', 'accessibility', 'gui'],
  [ACTION_TYPES.KEY_PRESS]: ['gui'],
  [ACTION_TYPES.HOTKEY]: ['gui'],
  [ACTION_TYPES.SCROLL]: ['dom', 'gui'],
  [ACTION_TYPES.DRAG]: ['gui'],
  [ACTION_TYPES.FOCUS]: ['accessibility', 'dom', 'gui'],
  [ACTION_TYPES.SELECT]: ['dom', 'accessibility', 'gui'],
  [ACTION_TYPES.OPEN_APP]: ['shell', 'gui'],
  [ACTION_TYPES.CLOSE_WINDOW]: ['api', 'gui'],
  [ACTION_TYPES.SWITCH_WINDOW]: ['api', 'gui'],
  [ACTION_TYPES.BROWSER_NAVIGATE]: ['api'],
  [ACTION_TYPES.BROWSER_BACK]: ['api'],
  [ACTION_TYPES.BROWSER_FORWARD]: ['api'],
  [ACTION_TYPES.BROWSER_REFRESH]: ['api'],
  [ACTION_TYPES.DOM_CLICK]: ['dom', 'accessibility'],
  [ACTION_TYPES.DOM_TYPE]: ['dom', 'accessibility'],
  [ACTION_TYPES.DOM_SELECT]: ['dom', 'accessibility'],
  [ACTION_TYPES.ACCESSIBILITY_INVOKE]: ['accessibility', 'gui'],
  [ACTION_TYPES.ACCESSIBILITY_SET_VALUE]: ['accessibility', 'gui'],
  [ACTION_TYPES.SHELL_EXEC]: ['shell'],
  [ACTION_TYPES.FILE_READ]: ['file'],
  [ACTION_TYPES.FILE_WRITE]: ['file'],
  [ACTION_TYPES.FILE_COPY]: ['file'],
  [ACTION_TYPES.FILE_MOVE]: ['file'],
  [ACTION_TYPES.FILE_DELETE]: ['file'],
  [ACTION_TYPES.FILE_MKDIR]: ['file'],
  [ACTION_TYPES.FILE_EXISTS]: ['file'],
  [ACTION_TYPES.WAIT_EVENT]: ['api'],
  [ACTION_TYPES.WAIT_STATE]: ['api'],
  [ACTION_TYPES.SCREENSHOT_REGION]: ['vision'],
  [ACTION_TYPES.SCREENSHOT_WINDOW]: ['vision'],
  [ACTION_TYPES.SCREENSHOT_FULL]: ['vision']
})

/** The capability a channel consumes, used for the contract check. */
const CHANNEL_CAPABILITY = Object.freeze({
  api: 'browser',
  file: 'filesystem',
  shell: 'shell',
  dom: 'browser',
  accessibility: 'desktop',
  gui: 'desktop',
  vision: 'vision'
})

/** The controller that owns a channel. */
const CHANNEL_CONTROLLER = Object.freeze({
  api: 'browser',
  file: 'file',
  shell: 'shell',
  dom: 'browser',
  accessibility: 'desktop',
  gui: 'desktop',
  vision: 'vision'
})

function isAvailable(availability, key) {
  const entry = availability ? availability[key] : null
  if (!entry) return false
  return entry.available !== false
}

/**
 * @param {object} action normalized action
 * @param {object} context
 * @param {object} context.contract active execution contract
 * @param {object} context.world current world state
 * @param {object} context.availability `{ browser, desktop, accessibility, vision, shell }`
 * @param {boolean} [context.hasResolvedTarget] whether the target resolved into the page/ax tree
 * @returns {{ok:boolean, channel?:string, controller?:string, reason:string, alternatives:string[], error?:Error}}
 */
function routeAction(action, context = {}) {
  const { contract, world, availability } = context
  const plan = CHANNEL_PLANS[action.type]
  if (!plan) {
    return {
      ok: false,
      reason: `no routing plan for ${action.type}`,
      alternatives: [],
      error: new ComputerUseError(CODES.ACTION_UNSUPPORTED, `no routing plan for action type ${action.type}`, { action: action.type })
    }
  }

  const attempts = []
  for (const channel of plan) {
    const capability = CHANNEL_CAPABILITY[channel]
    const controller = CHANNEL_CONTROLLER[channel]
    const entry = { channel, capability, controller }

    if (contract && !hasCapability(contract, capability)) {
      attempts.push({ ...entry, ok: false, reason: `capability "${capability}" is not allowed by the contract` })
      continue
    }
    if (!channelAvailable(channel, availability, context)) {
      attempts.push({ ...entry, ok: false, reason: describeUnavailable(channel, availability, context) })
      continue
    }
    if (!channelSuitable(channel, action, context)) {
      attempts.push({ ...entry, ok: false, reason: unsuitabilityReason(channel, action, context) })
      continue
    }
    attempts.push({ ...entry, ok: true, reason: routingReason(channel, action) })
    return {
      ok: true,
      channel,
      controller,
      capability,
      reason: routingReason(channel, action),
      // The alternatives are what the recovery ladder escalates through, so the
      // order here is the order a second attempt will try them in.
      alternatives: attempts.filter((entry_) => !entry_.ok).map((entry_) => entry_.channel).concat(plan.slice(plan.indexOf(channel) + 1)),
      attempts
    }
  }

  return {
    ok: false,
    reason: `no available channel for ${action.type}`,
    alternatives: [],
    attempts,
    error: new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, `no available channel for ${action.type}`, { attempts })
  }
}

function channelAvailable(channel, availability, context) {
  switch (channel) {
    case 'dom':
      return isAvailable(availability, 'browser') && context.pageReady !== false
    case 'api':
      if (channel === 'api' && context.action && context.action.type === ACTION_TYPES.OPEN_APP) return isAvailable(availability, 'shell')
      return isAvailable(availability, 'browser') || (context.action && isBrowserAction(context.action) && isAvailable(availability, 'browser'))
    case 'accessibility':
      return isAvailable(availability, 'accessibility') || isAvailable(availability, 'desktop')
    case 'gui':
      return isAvailable(availability, 'desktop')
    case 'vision':
      return isAvailable(availability, 'vision') && isAvailable(availability, 'desktop')
    case 'shell':
      return isAvailable(availability, 'shell')
    case 'file':
      return isAvailable(availability, 'file')
    default:
      return false
  }
}

function isBrowserAction(action) {
  return action.type.startsWith('BROWSER_') || action.type.startsWith('DOM_')
}

function describeUnavailable(channel, availability, context) {
  switch (channel) {
    case 'api':
    case 'dom':
      return context.pageReady === false
        ? 'no browser page is attached to the runtime'
        : reasonOf(availability, 'browser', 'browser controller')
    case 'accessibility':
      return reasonOf(availability, 'accessibility', 'accessibility controller')
    case 'gui':
      return reasonOf(availability, 'desktop', 'desktop controller')
    case 'vision':
      return isAvailable(availability, 'desktop')
        ? reasonOf(availability, 'vision', 'vision controller')
        : reasonOf(availability, 'desktop', 'desktop controller')
    case 'shell':
      return reasonOf(availability, 'shell', 'shell controller')
    case 'file':
      return reasonOf(availability, 'file', 'file controller')
    default:
      return `channel ${channel} is unavailable`
  }
}

function reasonOf(availability, key, label) {
  const entry = availability ? availability[key] : null
  if (!entry) return `${label} was not provided by the host`
  return entry.reason ? `${label} unavailable: ${entry.reason}` : `${label} unavailable`
}

/**
 * Some channels are *available* but wrong for this particular action. A DOM
 * click needs a target that resolved inside a page; a GUI click needs a
 * coordinate or a window; a vision click needs the visual level to be allowed.
 */
function channelSuitable(channel, action, context) {
  const resolved = context.resolved || null
  switch (channel) {
    case 'dom':
      if (!resolved) return false
      return Boolean(resolved.ref) && (resolved.source === 'page' || resolved.kind === 'selector' || resolved.kind === 'semantic' || resolved.kind === 'bbox')
    case 'accessibility':
      if (action.type === ACTION_TYPES.SWITCH_WINDOW || action.type === ACTION_TYPES.CLOSE_WINDOW) return true
      if (!resolved) return false
      return Boolean(resolved.ref) && (resolved.source === 'ax' || resolved.kind === 'accessibility')
    case 'gui':
      if (action.type === ACTION_TYPES.OPEN_APP) return true
      if (resolved && resolved.point) return true
      return Boolean(action.target && action.target.point)
    case 'vision':
      return action.type.startsWith('SCREENSHOT_') || Boolean(context.allowVision)
    case 'api':
      return true
    case 'file':
      return true
    case 'shell':
      return true
    default:
      return false
  }
}

function unsuitabilityReason(channel, action, context) {
  if ((channel === 'dom' || channel === 'accessibility') && !context.resolved) return 'the target has not been resolved into a structured element yet'
  if (channel === 'gui' && !(context.resolved && context.resolved.point)) return 'no coordinate is known for this action'
  return `channel ${channel} cannot carry ${action.type} here`
}

function routingReason(channel, action) {
  switch (channel) {
    case 'api':
      return action.type.startsWith('BROWSER_') ? 'browser API is the cheapest channel for a navigation action' : `${action.type} is carried by a host API`
    case 'shell':
      return 'the shell is cheaper and more reliable than driving a GUI for this task (plan §28)'
    case 'file':
      return 'the filesystem API answers the question directly - no GUI, no shell parsing (plan §28/§29)'
    case 'dom':
      return 'the target resolved to a structured DOM element - no coordinates needed'
    case 'accessibility':
      return 'the target resolved to an accessibility node with the required pattern'
    case 'gui':
      return 'no structured channel applies - using verified coordinates with window and focus safety'
    case 'vision':
      return 'vision is required because structured state cannot address this target (plan §4.1)'
    default:
      return `channel ${channel}`
  }
}

/** Ordered list of channels this action may fall back to (plan §18/§19). */
function fallbackChannels(action) {
  const plan = CHANNEL_PLANS[action.type] || []
  return [...plan]
}

function channelRank(channel) {
  const index = ROUTE_CHANNELS.indexOf(channel)
  return index === -1 ? ROUTE_CHANNELS.length : index
}

module.exports = {
  CHANNEL_PLANS,
  CHANNEL_CAPABILITY,
  CHANNEL_CONTROLLER,
  routeAction,
  fallbackChannels,
  channelRank,
  isBrowserAction
}
