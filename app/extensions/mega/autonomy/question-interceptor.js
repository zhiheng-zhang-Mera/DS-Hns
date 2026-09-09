'use strict'

/**
 * DS-Hns autonomy: question interceptor (Owner-Result.md Rev.2 §18–§19).
 *
 * When an episode ends (or stalls) with an apparent question to the operator —
 * “请选择 A/B”、“是否继续”、“是否修改…”、“你希望…” — the interceptor classifies it
 * BEFORE it is shown as a blocker. Only a genuine HB1–HB4 hard blocker may
 * surface; everything else is DECIDABLE and is auto-decided with a
 * deterministic policy and an explicit re-steer, so an autonomous run never
 * parks on a routine choice. Direction stalls escalate through the §19 ladder
 * (AUTO_DECIDE → STRONG_STEER → INDEPENDENT_DECISION → FRESH_EPISODE) instead
 * of asking the operator again.
 */

const MODES = Object.freeze(['ASSISTED', 'AUTONOMOUS', 'OWNER_RESULT'])

const HARD_BLOCKERS = Object.freeze([
  {
    kind: 'HB1_PERMISSIONS_OR_CREDENTIALS',
    label: '缺少不可自行取得的权限/凭据',
    signals: ['login', 'log in', 'sign in', 'signin', 'captcha', 'api key', 'api-key', 'credential', 'authentication', 'authorization', 'authorize', 'permission', '账号', '登录', '登陆', '验证码', '密钥', '凭据', '授权', '权限', '认证']
  },
  {
    kind: 'HB2_IRREVERSIBLE_EXTERNAL_ACTION',
    label: '不可逆外部行为（付款/生产数据删除/公开发布等）',
    signals: ['pay', 'payment', 'charge', 'purchase', 'refund', 'delete production', 'publish', 'release publicly', 'irreversible', '付款', '支付', '扣费', '购买', '删除生产', '发布', '对外发布', '不可逆', '退款']
  },
  {
    kind: 'HB3_GOAL_CONTRADICTION',
    label: '最终目标本身不可同时满足（且已证明无兼容解）',
    signals: ['contradict', 'contradiction', 'unsatisfiable', 'mutually exclusive', '无法同时满足', '相互矛盾', '自相矛盾', '目标冲突', '逻辑冲突', '不可兼得']
  },
  {
    kind: 'HB4_REQUIRED_EXTERNAL_RESOURCE_MISSING',
    label: '必需外部资源真实不存在',
    signals: ['resource does not exist', 'no such resource', 'nonexistent', 'not available anywhere', 'does not exist anywhere', '不存在该资源', '资源不存在', '外部资源不存在', '不存在', '依赖不存在', '没有可用资源']
  }
])

const CONTINUATION_PATTERNS = ['是否继续', '继续吗', '继续么', '要不要继续', 'please continue', 'should i continue', '是否重试', '重试吗', 'retry', 'should i retry', '继续执行', '是否再次', '再来一遍']
const RISKY_TOKENS = ['发布', '公开', '删除生产', '付款', '支付', '永久删除', 'publish', 'delete production', 'irreversible', '不可逆', '对外']
const SAFE_TOKENS = ['回滚', '保守', '最稳', '最安全', '安全', '无风险', '保留', '继续', '保持', 'rollback', 'keep', 'safe', 'revert', '最小改动']
const RECOMMENDED_TOKENS = ['推荐', '建议', '最优', 'recommend', 'best', '首选']

function normalize(value) {
  return String(value).toLocaleLowerCase()
}

function matchHardBlocker(text) {
  const normalized = normalize(text)
  for (const blocker of HARD_BLOCKERS) {
    for (const signal of blocker.signals) {
      if (normalized.includes(normalize(signal))) return { kind: blocker.kind, matched: signal }
    }
  }
  return null
}

/** Scores one candidate deterministically (risk-aware, no randomness). */
function scoreOption(option) {
  const normalized = normalize(option)
  let score = 0
  for (const token of RISKY_TOKENS) if (normalized.includes(normalize(token))) score -= 4
  for (const token of SAFE_TOKENS) if (normalized.includes(normalize(token))) score += 3
  for (const token of RECOMMENDED_TOKENS) if (normalized.includes(normalize(token))) score += 1
  return score
}

function pickBestOption(options) {
  let bestIndex = 0
  let bestScore = Number.NEGATIVE_INFINITY
  options.forEach((option, index) => {
    const score = scoreOption(option)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return { chosen: options[bestIndex], index: bestIndex, score: bestScore }
}

function isContinuation(text) {
  const normalized = normalize(text)
  return CONTINUATION_PATTERNS.some((pattern) => normalized.includes(normalize(pattern)))
}

/**
 * §18 classification: HB1–HB4 signal ⇒ HARD_BLOCKER; anything else DECIDABLE.
 */
function classify(text, options = {}) {
  const blocker = matchHardBlocker(text) || (options.kind ? hardBlockerForKind(options.kind) : null)
  if (blocker) return { classification: 'HARD_BLOCKER', blocker }
  return { classification: 'DECIDABLE', blocker: null }
}

function hardBlockerForKind(kind) {
  switch (kind) {
    case 'AUTHORIZATION': return { kind: 'HB1_PERMISSIONS_OR_CREDENTIALS', matched: kind }
    case 'EXTERNAL_ACTION': return { kind: 'HB2_IRREVERSIBLE_EXTERNAL_ACTION', matched: kind }
    case 'GOAL_CONFLICT': return { kind: 'HB3_GOAL_CONTRADICTION', matched: kind }
    case 'RESOURCE_MISSING': return { kind: 'HB4_REQUIRED_EXTERNAL_RESOURCE_MISSING', matched: kind }
    default: return null
  }
}

/**
 * Deterministic auto decision for a DECIDABLE question: continuation questions
 * auto-continue, safe explicit options get picked, risky-only candidates get a
 * strong steer toward the least risky one, and genuinely ambiguous questions
 * are routed to an independent planner with a steer — never to the operator.
 */
function decide(text, options = []) {
  if (isContinuation(text)) {
    return {
      chosen: 'continue (auto)',
      action: 'CONTINUE',
      steer: 'auto-continue: advance on the existing checkpoints and verify every milestone; do not ask again.',
      policy: 'owner-result:continue:v1'
    }
  }
  const candidates = (options || []).filter((option) => String(option).trim())
  if (candidates.length) {
    const picked = pickBestOption(candidates)
    if (picked.score >= 0) {
      return {
        chosen: picked.chosen,
        action: 'PICK_OPTION',
        steer: `auto-pick “${picked.chosen}”; verify the result afterwards and recover on failure.`,
        policy: 'owner-result:pick-option:v1'
      }
    }
    return {
      chosen: candidates[picked.index],
      action: 'STRONG_STEER',
      steer: `every candidate carries risk; take the least risky “${candidates[picked.index]}” and demand risk-mitigation evidence.`,
      policy: 'owner-result:steer-risky:v1'
    }
  }
  return {
    chosen: 'route to planner (auto)',
    action: 'ROUTE_TO_PLANNER',
    steer: 'non-HB question without clear candidates: route to an independent planner/reviewer and record the decision; never ask the operator.',
    policy: 'owner-result:route-planner:v1'
  }
}

/**
 * §18 interceptor entry. OWNER_RESULT auto-decides DECIDABLE questions and only
 * surfaces HARD_BLOCKERs; ASSISTED keeps the normal operator gate.
 */
function intercept(question, mode = 'OWNER_RESULT') {
  const text = String(question?.text ?? question ?? '')
  const options = Array.isArray(question?.options) ? question.options : []
  const { classification, blocker } = classify(text, question || {})
  if (classification === 'HARD_BLOCKER') return { classification, blocker, intercepted: false }
  if (mode === 'ASSISTED') return { classification, intercepted: false }
  const decision = decide(text, options)
  return { classification, blocker: null, intercepted: true, decision }
}

/** §19 direction-stall ladder. */
function directionStallAction(occurrence) {
  const stage = Math.max(1, Math.min(4, Math.floor(occurrence) + 1))
  const actions = {
    1: { action: 'AUTO_DECIDE', steer: 'auto-decide and continue; record choice and rationale in the decision ledger.' },
    2: { action: 'STRONG_STEER', steer: 'direction stalled again: inject a strong steer demanding one evidence-backed direction; no more options.' },
    3: { action: 'INDEPENDENT_DECISION', steer: 'direction stalled thrice: an independent planner/reviewer gives the decision and steers the executor.' },
    4: { action: 'FRESH_EPISODE', steer: 'direction keeps stalling: reopen as a fresh episode, keep the checkpoints, never ask the operator.' }
  }
  return { stage, ...actions[stage] }
}

module.exports = {
  MODES,
  HARD_BLOCKERS,
  classify,
  decide,
  intercept,
  directionStallAction,
  isContinuation,
  pickBestOption,
  scoreOption
}
