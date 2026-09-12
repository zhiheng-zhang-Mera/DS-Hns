'use strict'

/**
 * Computer Use Runtime: the observation layer (plan §3).
 *
 * Perception priority is fixed by the plan — structured state, then system
 * events, then targeted vision, then (only if nothing else works) a full
 * screenshot. This module implements the first two and hands the third to the
 * vision controller when a step actually asks for it.
 *
 * Every source is read behind its own fault boundary: a dead browser controller
 * degrades the world state (and says so in `sources` + `notes`) instead of
 * failing the observation. That is what lets a desktop-only task keep running
 * while the browser side is broken (plan §37, acceptance test 9).
 */

const { createWorldState } = require('./world-state.cjs')

function createObserver(options = {}) {
  const clock = options.clock || { now: () => Date.now() }
  const browser = options.browser || null
  const desktop = options.desktop || null
  const file = options.file || null
  // An observation that cannot answer within this window is reported as
  // unavailable: the runtime keeps its own latency bounded (plan §37/§41).
  const sourceTimeoutMs = Number.isFinite(options.sourceTimeoutMs) ? options.sourceTimeoutMs : 8000
  const errors = []
  let previous = null
  let systemEvents = []

  async function observe(context = {}) {
    const taskId = context.taskId || null
    const timeoutMs = Number.isFinite(context.sourceTimeoutMs) ? context.sourceTimeoutMs : sourceTimeoutMs
    const browserResult = await guard('browser', async () => {
      if (!browser || !probeAvailable(browser)) return null
      return withSourceTimeout('browser', () => browser.snapshot(), timeoutMs)
    })
    const desktopResult = await guard('desktop', async () => {
      if (!desktop || !probeAvailable(desktop)) return null
      // The accessibility walk is opt-out: `context.ax === false` asks for the
      // cheap observation (windows and focus only). Plan §3.1 — use the
      // cheapest source that can answer the question being asked.
      return withSourceTimeout('desktop', () => desktop.snapshot({ ax: context.ax !== false }), timeoutMs)
    })
    const systemResult = await guard('system', async () => collectSystemEvents(browserResult, desktopResult))

    const world = createWorldState({
      taskId,
      capturedAt: clock.now(),
      browser: browserResult.ok && browserResult.value ? browserResult.value : unavailablePart(browserResult, 'browser'),
      desktop: desktopResult.ok && desktopResult.value ? desktopResult.value : unavailablePart(desktopResult, 'desktop'),
      system: systemResult.ok && systemResult.value ? systemResult.value : unavailablePart(systemResult, 'system'),
      lastAction: context.lastAction || null,
      uiStable: context.uiStable === undefined ? null : context.uiStable
    })

    if (!browserResult.ok) world.notes.push(`browser observation failed: ${browserResult.error}`)
    if (!desktopResult.ok) world.notes.push(`desktop observation failed: ${desktopResult.error}`)
    if (!systemResult.ok) world.notes.push(`system observation failed: ${systemResult.error}`)

    // Plan §3.2 system events, computed from consecutive observations: an active
    // window change and a focus change are events, not just state.
    if (previous) {
      if (previous.activeWindowHandle !== world.activeWindowHandle) {
        systemEvents.push({ type: 'window_changed', from: previous.activeWindow, to: world.activeWindow, at: clock.now() })
      }
      if (previous.focusedRef !== world.focusedRef) {
        systemEvents.push({ type: 'focus_changed', from: previous.focusedRef, to: world.focusedRef, at: clock.now() })
      }
      if (previous.url !== world.url) {
        systemEvents.push({ type: 'url_changed', from: previous.url, to: world.url, at: clock.now() })
      }
    }
    world.systemEvents = [...(world.systemEvents || []), ...systemEvents]
    previous = world
    return world
  }

  /**
   * Watches a path so a "did the file change?" question can be answered by an
   * event instead of a polled delay (plan §12).
   */
  function watchFile(target, onEvent) {
    if (!file || typeof file.watch !== 'function') return null
    return file.watch(target, (event) => {
      systemEvents.push(event)
      if (typeof onEvent === 'function') onEvent(event)
    })
  }

  function drainEvents() {
    const drained = systemEvents.slice()
    systemEvents = []
    return drained
  }

  function collectSystemEvents(browserResult, desktopResult) {
    const events = []
    if (file && typeof file.facts === 'function') {
      try {
        const facts = file.facts()
        if (typeof facts.events === 'function') events.push(...(facts.events() || []).slice(-20))
      } catch (error) {
        return { available: false, reason: String(error && error.message), events: [] }
      }
    }
    if (browserResult.ok && browserResult.value && Array.isArray(browserResult.value.events)) {
      events.push(...browserResult.value.events)
    }
    return { available: true, reason: null, events }
  }

  function unavailablePart(result, name) {
    return {
      available: false,
      reason: result && result.error ? result.error : `${name} observation is unavailable`,
      source: { available: false, reason: result && result.error ? result.error : null }
    }
  }

  async function guard(name, fn) {
    try {
      const value = await fn()
      if (value === null || value === undefined) {
        return { ok: false, error: `${name} controller is not available`, skipped: true }
      }
      return { ok: true, value }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      errors.push({ at: clock.now(), source: name, error: message, code: error && error.code ? error.code : null })
      if (errors.length > 50) errors.splice(0, errors.length - 50)
      return { ok: false, error: message, code: error && error.code ? error.code : null }
    }
  }

  function probeAvailable(controller) {
    try {
      const verdict = controller.probe()
      return !verdict || verdict.available !== false
    } catch {
      return false
    }
  }

  /**
   * Plan §37: a source that stops answering must not be able to hang the run.
   * Each source gets a bounded window; a source that exceeds it is reported as
   * unavailable (with the reason) instead of blocking the observation forever.
   */
  async function withSourceTimeout(name, fn, ms) {
    let timer = null
    try {
      return await Promise.race([
        Promise.resolve(fn()),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} observation timed out after ${ms}ms`)), ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    observe,
    watchFile,
    drainEvents,
    errors() {
      return errors.slice()
    },
    reset() {
      previous = null
      systemEvents = []
    },
    get previous() {
      return previous
    }
  }
}

module.exports = { createObserver }
