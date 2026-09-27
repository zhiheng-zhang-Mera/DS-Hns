'use strict'

/**
 * DS-Hns: the **closed action vocabulary** a management surface may ask of a plugin service or of the
 * product itself.
 *
 * There used to be two lists — the view model's (`app/plugins/mega-core/lib/view.js`, which drew the
 * buttons) and the governance bridge's (`BRIDGE_ACTIONS`, which accepted them) — and they had drifted:
 * the page offered `diagnostics`, `restart-plugin`, `manual-restart` and `reset-budget`, and the bridge
 * refused all four. A button that only ever prints a refusal is worse than a button that is not drawn,
 * because a user reads it as a fault in the product.
 *
 * So the list lives here, once, as data. Three consequences:
 *
 *   * the bridge accepts exactly what this module names (plus the legacy module actions it always
 *     accepted, which are listed here too so they cannot drift either);
 *   * the Control Center publishes it in the snapshot under `serviceActions`, so the page draws the
 *     buttons the host will actually honour rather than its own opinion of them;
 *   * `dangerous` is data rather than a `" (confirm)"` suffix in a label: the confirmation is enforced
 *     where the action is executed, and the UI can render a real confirmation step for it.
 *
 * `scope` says what the action is *about*: `service` actions name a plugin id, `product` actions are
 * about the runtime as a whole (they act on every module that needs them), and `advanced` actions
 * write one policy key. A surface that sends a `service` action without an id is refused — that is the
 * shape the dead buttons had.
 */

/** Where an action points. */
const ACTION_SCOPES = Object.freeze({
  SERVICE: 'service',
  PRODUCT: 'product',
  ADVANCED: 'advanced'
})

/**
 * The vocabulary. `id` is what a caller sends; `dangerous` requires `confirm: true` at execution.
 */
const SERVICE_ACTIONS = Object.freeze([
  { id: 'check', scope: ACTION_SCOPES.SERVICE, cn: '刷新健康', en: 'Refresh health', dangerous: false },
  { id: 'diagnostics', scope: ACTION_SCOPES.SERVICE, cn: '查看诊断', en: 'View diagnostics', dangerous: false },
  { id: 'enable', scope: ACTION_SCOPES.SERVICE, cn: '启用', en: 'Enable', dangerous: false },
  { id: 'disable', scope: ACTION_SCOPES.SERVICE, cn: '停用', en: 'Disable', dangerous: false },
  { id: 'restart-plugin', scope: ACTION_SCOPES.SERVICE, cn: '重启插件', en: 'Restart plugin', dangerous: true },
  { id: 'manual-restart', scope: ACTION_SCOPES.SERVICE, cn: '手动重启应用', en: 'Manual app restart', dangerous: true },
  { id: 'reset-budget', scope: ACTION_SCOPES.SERVICE, cn: '重置重启预算', en: 'Reset restart budget', dangerous: true },
  { id: 'set-advanced', scope: ACTION_SCOPES.ADVANCED, cn: '写入高级设置', en: 'Write advanced setting', dangerous: true }
])

/**
 * Product-level actions: about the runtime, not one plugin.
 *
 * They are the recovery actions the page's header has always offered, and they name no id on purpose —
 * "retry" means "retry everything that is degraded". `legacy` records that these are the bridge's
 * original three, kept so a plugin written against the older contract keeps working.
 */
const PRODUCT_ACTIONS = Object.freeze([
  { id: 'check', scope: ACTION_SCOPES.PRODUCT, cn: '刷新', en: 'Refresh', dangerous: false, legacy: true },
  { id: 'retry', scope: ACTION_SCOPES.PRODUCT, cn: '重试', en: 'Retry', dangerous: false, legacy: true },
  { id: 'reset-fallback', scope: ACTION_SCOPES.PRODUCT, cn: '恢复回退', en: 'Reset fallback', dangerous: false, legacy: true },
  { id: 'refresh-balance', scope: ACTION_SCOPES.PRODUCT, cn: '刷新余额', en: 'Refresh balance', dangerous: false, legacy: false }
])

/**
 * Module actions the bridge has always accepted for a *protection module* (not a plugin service).
 * They stay in the accepted set, and they require an id like every other module action.
 */
const MODULE_ACTIONS = Object.freeze(['repair', 'disable', 'enable'])

/** Every action id a caller may send, with its definition. */
const ALL_ACTIONS = Object.freeze([...SERVICE_ACTIONS, ...PRODUCT_ACTIONS])

const ACTION_IDS = Object.freeze(ALL_ACTIONS.map((action) => action.id))

/**
 * What the governance bridge accepts on `POST /action`.
 *
 * The union of the vocabulary above and the module actions, because one endpoint serves both a plugin
 * service and a protection module. Order is stable so an error message reads the same way twice.
 */
const ACCEPTED_ACTIONS = Object.freeze([...new Set([...ACTION_IDS, ...MODULE_ACTIONS])])

/** The ones that must carry `confirm: true` to run at all. */
const DANGEROUS_ACTIONS = Object.freeze(ALL_ACTIONS.filter((action) => action.dangerous).map((action) => action.id))

/** The actions that are about the runtime and therefore name no id. */
const IDLESS_ACTIONS = Object.freeze(PRODUCT_ACTIONS.map((action) => action.id).concat(['set-advanced']))

function actionFor(id) {
  const wanted = String(id || '')
  return ALL_ACTIONS.find((action) => action.id === wanted) || null
}

function isDangerous(id) {
  return DANGEROUS_ACTIONS.includes(String(id))
}

function requiresId(id) {
  return !IDLESS_ACTIONS.includes(String(id))
}

function isAccepted(id) {
  return ACCEPTED_ACTIONS.includes(String(id))
}

module.exports = {
  ACTION_SCOPES,
  SERVICE_ACTIONS,
  PRODUCT_ACTIONS,
  MODULE_ACTIONS,
  ALL_ACTIONS,
  ACCEPTED_ACTIONS,
  DANGEROUS_ACTIONS,
  IDLESS_ACTIONS,
  actionFor,
  isDangerous,
  requiresId,
  isAccepted
}
