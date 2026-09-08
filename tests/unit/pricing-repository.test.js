'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const PricingRepository = require('../../app/extensions/mega/billing/pricing-repository')

test('pricing repository loads the official snapshot', () => {
  const repo = new PricingRepository()
  const desc = repo.describe()
  assert.equal(desc.source, 'official')
  assert.equal(desc.currency, 'CNY')
  assert.ok(repo.getModel('deepseek-v4-pro'))
})
