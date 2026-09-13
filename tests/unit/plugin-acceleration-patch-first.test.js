'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  EDIT_STRATEGIES,
  STRATEGY_RANK,
  DEFAULT_POLICY,
  COST_MODEL,
  chooseStrategy,
  planEdit,
  estimateTokens
} = require('../../app/plugins/acceleration/patch-first/index.cjs')

/**
 * Patch-first editing (Update-Plan/accleration.md phase 13).
 *
 * The priority (AST edit > targeted patch > FIM > whole-file rewrite) is only worth
 * anything if the expensive path is *refused* rather than merely discouraged. So the
 * tests are mostly about the refusal: a three-line change in a 1200-line file must not
 * be allowed to become a rewrite just because the cheaper strategies happen to be
 * unavailable, while a genuinely large change and a change to a small file must still
 * be allowed through. The failure mode is the quiet fallthrough, not the slow path.
 */

test('a three-line change in a 1200-line file takes a targeted patch, not a rewrite', () => {
  const chosen = chooseStrategy({ file: 'src/huge.cjs', changedLines: 3, fileLines: 1200 })
  assert.equal(chosen.strategy, EDIT_STRATEGIES.TARGETED_PATCH)
  assert.equal(chosen.refused, false)
  assert.equal(chosen.rank, 1, 'a targeted patch is the second-ranked strategy')
  assert.match(chosen.reason, /a targeted patch is preferred for a change of 3 lines/)
  assert.match(chosen.reason, /1200-line file/)

  const plan = planEdit({ file: 'src/huge.cjs', changedLines: 3, fileLines: 1200 })
  assert.equal(plan.strategy, EDIT_STRATEGIES.TARGETED_PATCH)
  assert.equal(plan.file, 'src/huge.cjs')
  assert.equal(plan.wholeFileTokensEstimate, 14_400, '1200 lines is about 14400 tokens')
  assert.ok(
    plan.outputTokensEstimate < plan.wholeFileTokensEstimate / 50,
    `the patch estimate must be a small fraction of the rewrite (${plan.outputTokensEstimate} vs ${plan.wholeFileTokensEstimate})`
  )
  assert.ok(plan.savingsRatio > 0.9, `the saving must be overwhelming (${plan.savingsRatio})`)
})

test('a structural change with an AST operation takes the highest-priority strategy', () => {
  const chosen = chooseStrategy({
    file: 'src/huge.cjs',
    changedLines: 3,
    fileLines: 1200,
    structural: true,
    astOperation: 'rename-symbol',
    astSupported: true
  })
  assert.equal(chosen.strategy, EDIT_STRATEGIES.AST_EDIT)
  assert.equal(chosen.refused, false)
  assert.equal(chosen.rank, 0)
  assert.equal(chosen.rank, STRATEGY_RANK.indexOf(EDIT_STRATEGIES.AST_EDIT))
  assert.match(chosen.reason, /cheapest option for a structural change/)
  assert.match(chosen.reason, /rename-symbol/)

  // Without AST support the same structural change falls back to the next-cheapest
  // strategy rather than being refused: a cheaper option still exists.
  const fallback = chooseStrategy({
    changedLines: 3,
    fileLines: 1200,
    structural: true,
    astOperation: 'rename-symbol',
    astSupported: false
  })
  assert.equal(fallback.strategy, EDIT_STRATEGIES.TARGETED_PATCH)
  assert.equal(fallback.refused, false)
})

test('a small change in a large file with no cheaper strategy is refused, naming both sizes', () => {
  const chosen = chooseStrategy({ changedLines: 3, fileLines: 1200, patchSupported: false, fimSupported: false })
  assert.equal(chosen.strategy, null, 'it must never fall through to a whole-file rewrite')
  assert.equal(chosen.refused, true)
  assert.equal(chosen.rank, null)
  assert.match(chosen.reason, /refusing to rewrite 1200 lines to change 3/)
  assert.match(chosen.reason, /1200/)
  assert.match(chosen.reason, /change 3\b/)
  assert.match(chosen.reason, /no cheaper strategy is available/)
  assert.match(chosen.reason, /a targeted patch is not supported/)
  assert.match(chosen.reason, /fill-in-the-middle is not supported/)

  // The estimate the refusal exists to prevent is still reported.
  const plan = planEdit({ changedLines: 3, fileLines: 1200, patchSupported: false, fimSupported: false })
  assert.equal(plan.strategy, null)
  assert.equal(plan.refused, true)
  assert.equal(plan.wholeFileTokensEstimate, 14_400)
  assert.equal(plan.outputTokensEstimate, 14_400)
  assert.equal(plan.savingsTokens, 0)
  assert.equal(plan.savingsRatio, 0)
})

test('with patches unavailable, FIM is chosen over a whole-file rewrite', () => {
  const chosen = chooseStrategy({ changedLines: 3, fileLines: 1200, patchSupported: false, fimSupported: true })
  assert.equal(chosen.strategy, EDIT_STRATEGIES.FIM)
  assert.equal(chosen.refused, false)
  assert.equal(chosen.rank, 2)
  assert.match(chosen.reason, /fill-in-the-middle is preferred for a change of 3 lines/)
  assert.match(chosen.reason, /prefix and suffix/)

  const plan = planEdit({ changedLines: 3, fileLines: 1200, patchSupported: false, fimSupported: true })
  assert.ok(
    plan.outputTokensEstimate < plan.wholeFileTokensEstimate,
    `FIM must still be cheaper than the rewrite (${plan.outputTokensEstimate} vs ${plan.wholeFileTokensEstimate})`
  )
  assert.ok(plan.savingsTokens > 0)
})

test('a change to most of a file is allowed to be a whole-file rewrite', () => {
  const chosen = chooseStrategy({ changedLines: 400, fileLines: 500, patchSupported: true })
  assert.equal(chosen.strategy, EDIT_STRATEGIES.WHOLE_FILE)
  assert.equal(chosen.refused, false)
  assert.equal(chosen.rank, STRATEGY_RANK.length - 1)
  assert.match(chosen.reason, /large fraction of the file/)
  assert.match(chosen.reason, /400 of 500 lines/)
  assert.match(chosen.reason, /80%/)

  const plan = planEdit({ changedLines: 400, fileLines: 500 })
  assert.equal(plan.strategy, EDIT_STRATEGIES.WHOLE_FILE)
  assert.equal(plan.outputTokensEstimate, plan.wholeFileTokensEstimate)
  assert.equal(plan.savingsTokens, 0, 'a rewrite saves nothing, and that is not negative')
  assert.equal(plan.savingsRatio, 0)
})

test('a change to most of a small file is allowed rather than refused', () => {
  const chosen = chooseStrategy({ changedLines: 10, fileLines: 12, patchSupported: false, fimSupported: false })
  assert.equal(chosen.strategy, EDIT_STRATEGIES.WHOLE_FILE)
  assert.equal(chosen.refused, false, 'the refusal is for large files; a 12-line file is not one')
  assert.match(chosen.reason, /large fraction of the file/)
  assert.match(chosen.reason, /10 of 12 lines/)
  assert.match(chosen.reason, /the file is not large, so a whole-file rewrite is allowed rather than refused/)

  // The refusal it is being contrasted with, on the same change size.
  const refused = chooseStrategy({ changedLines: 10, fileLines: 10_000, patchSupported: false, fimSupported: false })
  assert.equal(refused.strategy, null)
  assert.equal(refused.refused, true)
  assert.match(refused.reason, /refusing to rewrite 10000 lines to change 10/)
})

test('planEdit reports the saving, and estimateTokens is total and never negative', () => {
  const plan = planEdit({ file: 'src/huge.cjs', changedLines: 3, fileLines: 1200 })
  assert.ok(plan.savingsTokens > 0, `savings must be positive (${plan.savingsTokens})`)
  assert.ok(plan.savingsRatio > 0 && plan.savingsRatio < 1, `savingsRatio must be in (0, 1) (${plan.savingsRatio})`)
  assert.equal(plan.outputTokensEstimate + plan.savingsTokens, plan.wholeFileTokensEstimate)

  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('x'.repeat(400)), 100)
  assert.equal(estimateTokens('x'.repeat(400), 2), 200)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(12_345), 0)
  assert.equal(estimateTokens({ length: 100 }), 0)
  assert.equal(estimateTokens([]), 0)
  assert.equal(estimateTokens(true), 0)
  // A nonsense divisor must not produce a negative, an infinite or a NaN estimate.
  assert.equal(estimateTokens('abcd', 0), 1)
  assert.equal(estimateTokens('abcd', -4), 1)
  assert.equal(estimateTokens('abcd', Number.NaN), 1)
})

test('every strategy a caller can receive is ranked, and whole-file is always last', () => {
  assert.deepEqual(Object.values(EDIT_STRATEGIES), ['ast-edit', 'targeted-patch', 'fim', 'whole-file'])
  assert.deepEqual([...STRATEGY_RANK], ['ast-edit', 'targeted-patch', 'fim', 'whole-file'])
  assert.equal(STRATEGY_RANK[STRATEGY_RANK.length - 1], EDIT_STRATEGIES.WHOLE_FILE, 'the rewrite is the last resort')
  assert.equal(new Set(STRATEGY_RANK).size, STRATEGY_RANK.length, 'no duplicate ranks')
  assert.equal(Object.isFrozen(EDIT_STRATEGIES), true)
  assert.equal(Object.isFrozen(STRATEGY_RANK), true)
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true)
  assert.equal(Object.isFrozen(COST_MODEL), true)
  assert.deepEqual(DEFAULT_POLICY, {
    smallChangeLines: 40,
    wholeFileRatio: 0.5,
    charactersPerToken: 4,
    fimSupported: false,
    patchSupported: true,
    astSupported: false
  })

  const seen = new Set()
  for (const patchSupported of [true, false]) {
    for (const fimSupported of [true, false]) {
      for (const astSupported of [true, false]) {
        for (const structural of [true, false]) {
          for (const [changedLines, fileLines] of [[0, 0], [3, 1200], [10, 12], [400, 500], [100, 10_000]]) {
            const chosen = chooseStrategy({
              changedLines,
              fileLines,
              structural,
              astOperation: structural ? 'rename-symbol' : null,
              patchSupported,
              fimSupported,
              astSupported
            })
            const label = `patch=${patchSupported} fim=${fimSupported} ast=${astSupported} structural=${structural} ${changedLines}/${fileLines}`
            assert.equal(typeof chosen.reason, 'string', label)
            assert.ok(chosen.reason.length > 0, label)
            if (chosen.strategy === null) {
              assert.equal(chosen.refused, true, label)
              assert.equal(chosen.rank, null, label)
              continue
            }
            assert.equal(chosen.refused, false, label)
            assert.ok(STRATEGY_RANK.includes(chosen.strategy), `${chosen.strategy} is not ranked (${label})`)
            assert.equal(chosen.rank, STRATEGY_RANK.indexOf(chosen.strategy), label)
            assert.ok(chosen.rank >= 0 && chosen.rank < STRATEGY_RANK.length, label)
            seen.add(chosen.strategy)
          }
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...STRATEGY_RANK].sort(), 'every strategy must be reachable by some caller')
})
