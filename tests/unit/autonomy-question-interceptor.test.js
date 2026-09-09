'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { classify, decide, intercept, directionStallAction, isContinuation, scoreOption } = require('../../app/extensions/mega/autonomy/question-interceptor')

test('hard-blocker classification: HB1 credentials / HB2 irreversible / HB3 conflict / HB4 missing resource', () => {
  assert.equal(classify('please log in to continue').classification, 'HARD_BLOCKER')
  assert.equal(classify('please log in to continue').blocker.kind, 'HB1_PERMISSIONS_OR_CREDENTIALS')
  assert.equal(classify('是否确认付款 $99？').blocker.kind, 'HB2_IRREVERSIBLE_EXTERNAL_ACTION')
  assert.equal(classify('目标相互矛盾，无法同时满足').blocker.kind, 'HB3_GOAL_CONTRADICTION')
  assert.equal(classify('the required benchmark does not exist anywhere').blocker.kind, 'HB4_REQUIRED_EXTERNAL_RESOURCE_MISSING')
})

test('routine continuation and A/B questions stay DECIDABLE', () => {
  assert.equal(classify('是否继续执行？').classification, 'DECIDABLE')
  assert.equal(classify('请选择 A 还是 B').classification, 'DECIDABLE')
  assert.equal(isContinuation('should I retry now?'), true)
})

test('OWNER_RESULT interceptor auto-decides DECIDABLE questions and surfaces only hard blockers', () => {
  const continuation = intercept({ text: '是否继续？' }, 'OWNER_RESULT')
  assert.equal(continuation.intercepted, true)
  assert.equal(continuation.decision.action, 'CONTINUE')

  const blocker = intercept({ text: '需要验证码才能继续', options: ['稍后', '重发'] }, 'OWNER_RESULT')
  assert.equal(blocker.intercepted, false)
  assert.equal(blocker.classification, 'HARD_BLOCKER')

  const assisted = intercept({ text: '请选择 A/B' }, 'ASSISTED')
  assert.equal(assisted.intercepted, false)
})

test('auto decisions pick the safe option deterministically and never ask', () => {
  const options = ['方案A：立即切换新架构', '方案B：回滚到上一稳定版再验证']
  const picked = decide('请选择处理方式', options)
  assert.equal(picked.action, 'PICK_OPTION')
  assert.equal(picked.chosen, options[1])

  const risky = decide('如何处理？', ['直接发布', '永久删除备份'])
  assert.equal(risky.action, 'STRONG_STEER')

  const routed = decide('接下来怎么做比较好？')
  assert.equal(routed.action, 'ROUTE_TO_PLANNER')

  assert.ok(scoreOption('回滚到稳定版') > scoreOption('删除生产数据'))
})

test('direction-stall ladder escalates through four stages, never asking the operator', () => {
  assert.equal(directionStallAction(0).action, 'AUTO_DECIDE')
  assert.equal(directionStallAction(1).action, 'STRONG_STEER')
  assert.equal(directionStallAction(2).action, 'INDEPENDENT_DECISION')
  assert.equal(directionStallAction(3).action, 'FRESH_EPISODE')
  assert.equal(directionStallAction(9).action, 'FRESH_EPISODE')
})
