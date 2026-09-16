'use strict'

/**
 * MegaItemRegistry (`updateplan/startup2.md` §41, §44) — the collapsed rail as data.
 *
 * The rail used to be five hard-coded boxes in the dock's markup that the dock's script filled by id.
 * That shape is why the rail drifted into a second status bar: every new number had to be given a box,
 * nobody could remove one without editing three files, and the dock had to know what "RUN" meant.
 *
 * Now a module *registers* an item and the rail renders whatever is registered:
 *
 *   registerMegaItem({ id, priority, current })
 *
 * `current(snapshot)` answers what the item says right now, or `null` for "this item has nothing to
 * say" — which is where the plan's two rules live (§36, §43):
 *
 *   * **zero is not news.** An item whose value is zero returns `null` and does not appear. A queue
 *     that is empty, a retry count that is zero and an error count that is zero are the normal state,
 *     and a normal state does not get permanent attention.
 *   * **the rail has a budget.** Collapsed shows at most `budget` items (§44); everything else is
 *     counted in `overflow` and left to the expanded Control Center, so the rail cannot grow without
 *     limit. Items are ordered by `priority` (lower first), which is the module's own claim about how
 *     much it deserves a place.
 *
 * The registry is pure: it holds definitions, asks them for their current answer, orders, budgets, and
 * returns data the dock renders generically. It never touches the DOM and never knows a byte of what an
 * item means — that belongs to whoever registered it.
 */

/** §44: the collapsed rail shows at most this many items. */
const MEGA_ITEM_BUDGET = 5

function normalizeItem(id, answer) {
  if (!answer || typeof answer !== 'object') return null
  const label = answer.label === undefined ? '' : String(answer.label)
  const value = answer.value === undefined || answer.value === null ? '' : String(answer.value)
  if (!label) return null
  // Zero-noise is the caller's decision (returning `null`), but an item that says "0" while claiming to
  // be news is a caller mistake worth making visible rather than printing: §36 says a zero is not news.
  const zero = value === '0' || value === '' || /^(0|OFF|—|-)$/.test(value)
  return {
    id,
    label,
    value,
    tone: answer.tone ? String(answer.tone) : null,
    detail: answer.detail ? String(answer.detail) : null,
    action: answer.action ? String(answer.action) : null,
    /** True when the caller insisted on showing a zero: useful for tests, never for the rail. */
    zero,
    quiet: answer.quiet === true || zero
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.budget] how many items the collapsed rail may show (§44)
 */
function createMegaItems({ budget = MEGA_ITEM_BUDGET } = {}) {
  const definitions = new Map()
  const size = Number.isInteger(budget) && budget > 0 ? budget : MEGA_ITEM_BUDGET

  /**
   * Register one item. Registering the same id twice is refused rather than silently replaced: two
   * modules claiming "queue" would be a bug the rail could only show as a duplicate.
   */
  function register(definition = {}) {
    const id = String(definition.id || '')
    if (!id) return { ok: false, reason: 'a Mega item needs an id' }
    if (typeof definition.current !== 'function') return { ok: false, reason: `${id} has no current() to answer with` }
    if (definitions.has(id)) return { ok: false, reason: `${id} is already registered` }
    definitions.set(id, {
      id,
      priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 100,
      current: definition.current,
      // `hint` and not `title`: this is a diagnostic label for the Control Center, and the word
      // `title` belongs to OS window titles, which must always be bilingual (`bilingualTitle`).
      hint: definition.hint ? String(definition.hint) : id,
      section: definition.section ? String(definition.section) : 'execution'
    })
    return { ok: true, id }
  }

  /** What the rail shows right now, ordered and budgeted. Never throws. */
  function render(snapshot = null) {
    const answers = []
    for (const definition of definitions.values()) {
      let answer = null
      try {
        answer = definition.current(snapshot)
      } catch {
        // A module that throws while being asked for a number is not allowed to take the rail with it.
        answer = null
      }
      const item = normalizeItem(definition.id, answer)
      if (!item) continue
      if (item.quiet) continue
      answers.push({ ...item, priority: definition.priority, hint: definition.hint, section: definition.section })
    }
    answers.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    const items = answers.slice(0, size).map(({ priority, hint, section, quiet, zero, ...item }) => item)
    return {
      budget: size,
      items,
      overflow: Math.max(0, answers.length - size),
      /** Everything that is registered but not on the rail, by id — the Control Center's list (§45). */
      held: answers.slice(size).map((item) => item.id),
      registered: [...definitions.keys()]
    }
  }

  return {
    MEGA_ITEM_BUDGET,
    register,
    render,
    budget: () => size,
    ids: () => [...definitions.keys()],
    clear: () => definitions.clear()
  }
}

module.exports = { createMegaItems, MEGA_ITEM_BUDGET }
