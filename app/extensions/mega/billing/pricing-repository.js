'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('../utils/paths')

/**
 * PricingRepository — source priority:
 *   1. official snapshot under data/pricing (kept from platform docs)
 *   2. cached copy under data/pricing/*.local.json when present
 *   3. fallback config/pricing.json
 * All failures degrade to the next layer and never affect the harness.
 */

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

class PricingRepository {
  constructor() {
    this.official = load(path.join(PATHS.PRICING, 'official-pricing.json'), null)
    this.cache = load(path.join(PATHS.PRICING, 'pricing.local.json'), null)
    this.fallback = load(path.join(PATHS.CONFIG, 'pricing.json'), null)
    this.source = 'fallback'
    this.data = this.fallback
    if (this.official) {
      this.data = this.official
      this.source = 'official'
    } else if (this.cache) {
      this.data = this.cache
      this.source = 'cache'
    }
  }

  getSchedule() {
    return this.data?.schedule ?? this.fallback?.schedule ?? null
  }

  getModels() {
    return this.data?.models ?? this.fallback?.models ?? []
  }

  getModel(id) {
    return this.getModels().find((m) => m.id === id) ?? null
  }

  describe() {
    return {
      source: this.source,
      sourceUrl: this.data?.sourceUrl ?? null,
      retrievedAt: this.data?.retrievedAt ?? null,
      currency: this.data?.currency ?? 'CNY'
    }
  }
}

module.exports = PricingRepository
