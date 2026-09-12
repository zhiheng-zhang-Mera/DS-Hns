'use strict'

/**
 * Computer Use Runtime: fault boundaries (plan §37, §38).
 *
 *   ComputerUseRuntime
 *    ├─ BrowserController   ├─ VisionController
 *    ├─ DesktopController   ├─ ShellController
 *    ├─ FileController      ├─ Stabilization / Verification / Recovery
 *
 * Each controller is built inside its own boundary. A controller that throws
 * while being constructed, or that fails later, degrades *itself*: it is
 * replaced by a stub that reports the real reason through `probe()`, and the
 * runtime keeps running with everything else. A missing vision controller must
 * never take down a shell task, and a browser crash must not stop the desktop
 * controller from working (acceptance test 9).
 */

const { CODES, ComputerUseError } = require('./errors.cjs')

function unavailableController(id, capability, reason, extra = {}) {
  const error = () => new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, reason, { controllerId: id, capability })
  return {
    id,
    capability,
    degraded: true,
    probe: () => ({ available: false, reason, detail: { degraded: true, ...extra } }),
    supports: () => false,
    snapshot: async () => {
      throw error()
    },
    locate: async () => null,
    perform: async () => {
      throw error()
    },
    facts: () => ({}),
    ...extra
  }
}

/**
 * Builds a controller behind its own boundary.
 * @param {string} id controller id used in logs and health reports
 * @param {string} capability capability it serves
 * @param {function} factory () => controller
 */
function isolateController(id, capability, factory) {
  let controller = null
  let failure = null
  try {
    controller = factory()
    if (!controller) failure = 'the controller factory returned nothing'
  } catch (error) {
    failure = error && error.message ? error.message : String(error)
  }
  if (failure) return unavailableController(id, capability, `${id} controller failed to initialise: ${failure}`, { initError: failure })

  const originalPerform = typeof controller.perform === 'function' ? controller.perform.bind(controller) : null
  const originalSnapshot = typeof controller.snapshot === 'function' ? controller.snapshot.bind(controller) : null
  const errors = []

  function note(error, phase) {
    errors.push({ at: Date.now(), phase, code: error && error.code ? error.code : null, message: error && error.message ? error.message : String(error) })
    if (errors.length > 20) errors.splice(0, errors.length - 20)
  }

  // The wrapper must not flatten the controller: a live getter such as `page`
  // (re-attached before each run) has to stay live, so property descriptors are
  // carried over instead of copied by value.
  const wrapped = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(controller))) {
    Object.defineProperty(wrapped, key, descriptor)
  }
  Object.defineProperty(wrapped, 'degraded', { value: false, enumerable: true, configurable: true, writable: true })
  Object.defineProperty(wrapped, 'faults', {
    value: () => errors.slice(),
    enumerable: true,
    configurable: true,
    writable: true
  })
  Object.defineProperty(wrapped, 'probe', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: () => {
      try {
        const verdict = typeof controller.probe === 'function' ? controller.probe() : { available: true }
        return verdict
      } catch (error) {
        note(error, 'probe')
        return { available: false, reason: error && error.message ? error.message : String(error) }
      }
    }
  })
  if (originalSnapshot) {
    Object.defineProperty(wrapped, 'snapshot', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (...args) => {
        try {
          return await originalSnapshot(...args)
        } catch (error) {
          note(error, 'snapshot')
          throw error
        }
      }
    })
  }
  if (originalPerform) {
    Object.defineProperty(wrapped, 'perform', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (...args) => {
        try {
          return await originalPerform(...args)
        } catch (error) {
          note(error, 'perform')
          throw error
        }
      }
    })
  }
  return wrapped
}

module.exports = { isolateController, unavailableController }
