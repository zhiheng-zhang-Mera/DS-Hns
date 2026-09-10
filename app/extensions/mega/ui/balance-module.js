'use strict'

/**
 * Balance module open detection — shared by the Mega dock and the full tools
 * window so both entrances use one implementation (MEGA-04).
 *
 * Responsibilities (renderer side only — the refresh implementation itself
 * lives in the main process and is shared by every trigger):
 *
 *   - fire exactly one automatic refresh each time the user really opens the
 *     Balance module;
 *   - never refresh because of DOM re-renders, resizes, repaints, focus
 *     flicker or state sync (only visibility transitions count);
 *   - coalesce duplicate triggers while a refresh is in flight;
 *   - close → reopen refreshes again.
 *
 * The controller is dependency-free and DOM-light so it can be unit tested
 * without a browser: pass `observe` to drive visibility explicitly.
 */

function createController({
  panel = null,
  isOpen = () => true,
  refresh,
  onBusy = null,
  onError = null,
  observe = null,
  trigger = 'module-open'
} = {}) {
  if (typeof refresh !== 'function') throw new Error('balance module controller requires a refresh function')
  const state = {
    visible: false,
    intersecting: panel ? false : true,
    inFlight: false,
    refreshes: 0,
    coalesced: 0,
    lastTrigger: null
  }
  let detach = () => {}

  function moduleOpen() {
    const open = typeof isOpen === 'function' ? Boolean(isOpen()) : true
    return Boolean(open && state.intersecting)
  }

  async function run(triggerName, options) {
    // A second trigger while refreshing (fast clicking, duplicate open events)
    // must not start a parallel refresh.
    if (state.inFlight) {
      state.coalesced += 1
      return null
    }
    state.inFlight = true
    state.refreshes += 1
    state.lastTrigger = triggerName
    if (typeof onBusy === 'function') onBusy(true)
    try {
      return await refresh(triggerName, options)
    } catch (error) {
      if (typeof onError === 'function') onError(error)
      return null
    } finally {
      state.inFlight = false
      if (typeof onBusy === 'function') onBusy(false)
    }
  }

  function syncVisibility() {
    const next = moduleOpen()
    if (next === state.visible) return false
    state.visible = next
    if (next) void run(trigger)
    return true
  }

  function setIntersecting(value) {
    const next = Boolean(value)
    if (next === state.intersecting) return false
    state.intersecting = next
    return syncVisibility()
  }

  if (panel && typeof observe === 'function') {
    const cleanup = observe(panel, (isIntersecting) => { setIntersecting(isIntersecting) })
    if (typeof cleanup === 'function') detach = cleanup
  }
  syncVisibility()

  return {
    state,
    isVisible: () => state.visible,
    /** Re-evaluate visibility (for example after the dock expands/collapses). */
    sync: syncVisibility,
    setIntersecting,
    /** Manual/retry entry point: shares the same refresh implementation. */
    trigger: (triggerName = 'manual', options = {}) => run(triggerName, options),
    detach: () => detach()
  }
}

function defaultObserve(panel, handler) {
  if (!panel || typeof IntersectionObserver !== 'function') {
    handler(true)
    return () => {}
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) handler(Boolean(entry.isIntersecting))
  }, { threshold: 0.1 })
  observer.observe(panel)
  return () => observer.disconnect()
}

/**
 * Browser helper: finds the panel and wires the intersection observer.
 *
 * `openOnIntersect: false` is for hosts where the panel lives far below the fold
 * of a scrollable column (the Mega dock): there, "the module was opened" means
 * the host itself became visible, not that the panel is currently scrolled into
 * view. The visible/invisible transition still guards against request storms.
 */
function attachBalanceModule(options = {}) {
  const panel = options.openOnIntersect === false
    ? null
    : (options.panel || (typeof document !== 'undefined'
      ? document.querySelector(options.panelSelector || '.balance-panel')
      : null))
  return createController({ ...options, panel, observe: options.observe || defaultObserve })
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createController, attachBalanceModule, defaultObserve }
}
if (typeof window !== 'undefined') {
  window.megaBalanceModule = { createController, attachBalanceModule, defaultObserve }
}
