'use strict'

/**
 * Skill catalog: what the dock can offer before anything is installed.
 *
 * Two sources, deliberately separate:
 *
 *   curated   a small, reviewed list shipped with DS-Hns that always works and
 *             always resolves to a real installable GitHub location. A search box
 *             that can return nothing is worse than useless, so the offline
 *             baseline is a first-class feature rather than a fallback.
 *   live      an optional GitHub Code Search for `filename:SKILL.md`. It needs a
 *             token for any real volume (unauthenticated code search is heavily
 *             rate limited and often refused), so it is strictly additive: a
 *             failure is reported as "offline" and the curated results stand.
 *
 * A catalog entry is never trusted: installation re-reads the real
 * `SKILL.md` from the resolved location, so an entry that has moved or changed
 * fails loudly at install time instead of installing something else.
 */
const format = require('./skill-format')

const GITHUB_API = 'https://api.github.com'
const DEFAULT_SEARCH_LIMIT = 20

/**
 * Curated sources. Each entry points at a repository (or a subtree of one) and
 * describes the collection; the installer expands it into individual skills.
 *
 * `name`/`summary`/`tags` are for search only — the installed skill's own
 * frontmatter is always authoritative.
 */
const CURATED_COLLECTIONS = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic Agent Skills',
    owner: 'anthropics',
    repo: 'skills',
    subpath: 'skills',
    summary: 'Anthropic 官方 Agent Skills 合集：文档处理（docx/pdf/pptx/xlsx）、美术与设计、技能编写规范。',
    tags: ['official', 'documents', 'design', 'writing', 'collection'],
    locale: 'en'
  },
  {
    id: 'anthropic-skills-public',
    name: 'Anthropic Skills (repository root)',
    owner: 'anthropics',
    repo: 'skills',
    subpath: null,
    summary: '同一仓库的根目录视图，用于仓库结构调整后仍能安装。',
    tags: ['official', 'fallback', 'collection'],
    locale: 'en',
    alternate: true
  }
]

/** Bundled starter skills: written locally, installable with no network at all. */
const BUNDLED_SKILLS = [
  {
    id: 'bundled-commit-message',
    name: 'commit-message',
    summary: '按仓库既有风格撰写提交信息：先读近期 log，再总结改动，输出可直接使用的一段提交说明。',
    tags: ['git', 'workflow', 'offline'],
    category: '工程',
    body: [
      'Read the repository\'s recent commit history before writing anything, so the new message matches the',
      'project\'s existing voice and structure.',
      '',
      '1. `git log --oneline -20` to learn the conventions in use (prefixes, tense, language).',
      '2. `git status` and `git diff --stat` to see what actually changed.',
      '3. Summarise the change in one subject line under 72 characters, then add a body only when the "why" is',
      '   not obvious from the subject.',
      '',
      'Never invent a change that is not in the diff. Never mention files that were not touched.'
    ].join('\n')
  },
  {
    id: 'bundled-code-review',
    name: 'code-review',
    summary: '对一段改动做结构化代码评审：正确性、边界条件、错误处理、可读性，按严重度排序并给出可执行建议。',
    tags: ['review', 'quality', 'offline'],
    category: '工程',
    body: [
      'Review the change, not the author. Report findings ordered by severity and make every finding actionable.',
      '',
      '- **Correctness** — does it do what it claims? Are there off-by-one, null, empty-collection or encoding',
      '  cases? Does it handle concurrent access where that is possible?',
      '- **Failure paths** — what happens on error, timeout, partial write or malformed input? Is anything',
      '  swallowed silently?',
      '- **Readability** — could a new maintainer follow it? Are names accurate? Is the comment explaining the',
      '  "why" rather than restating the code?',
      '- **Tests** — is the new behaviour covered, including the case the fix was written for?',
      '',
      'State explicitly when you found nothing in a category; do not pad the review.'
    ].join('\n')
  },
  {
    id: 'bundled-release-notes',
    name: 'release-notes',
    summary: '把一段提交区间整理成面向用户的发布说明，按「新增 / 变更 / 修复」分组，弱化内部重构。',
    tags: ['release', 'writing', 'offline'],
    category: '工程',
    body: [
      'Turn a commit range into release notes a user can act on.',
      '',
      '1. Collect the commits for the range: `git log --oneline <from>..<to>`.',
      '2. Drop or merge internal-only changes (refactors, dependency bumps, CI) unless they change behaviour.',
      '3. Group the rest under **Added**, **Changed** and **Fixed**, in that order.',
      '4. Describe each item by its effect on the user, not by its implementation. Name the flag, command or',
      '   screen the user will see.',
      '5. Call out breaking changes first and separately, with the migration step.',
      '',
      'If the range contains nothing user-visible, say so plainly instead of inflating it.'
    ].join('\n')
  },
  {
    id: 'bundled-repo-tour',
    name: 'repo-tour',
    summary: '快速摸清一个陌生仓库：入口、构建、测试、目录职责与关键约定，产出一份可执行的上手清单。',
    tags: ['onboarding', 'navigation', 'offline'],
    category: '工程',
    body: [
      'Orient yourself in an unfamiliar repository before changing anything.',
      '',
      '1. Find the entry points: package manifest, build scripts, test command, and the top-level entry file.',
      '2. Read the README and any contribution guide; note the conventions they state.',
      '3. Map the directory tree to responsibilities — one line per top-level directory.',
      '4. Identify the test command and run it once to see the baseline state.',
      '5. Note what you could not determine, and what would have to be true for it to matter.',
      '',
      'Produce the result as a short checklist a new contributor can execute top to bottom.'
    ].join('\n')
  },
  {
    id: 'bundled-incident-triage',
    name: 'incident-triage',
    summary: '线上问题分级与取证顺序：先止损、再定位、最后复现，明确每一步的证据来源与结论边界。',
    tags: ['incident', 'operations', 'offline'],
    category: '运维',
    body: [
      'Triage an incident in one order only: stop the bleeding, then find the cause, then reproduce it.',
      '',
      '1. **Contain** — what is the smallest action that stops user-visible harm? Take it first, record it.',
      '2. **Evidence** — which logs, metrics or traces are authoritative for this system? Read those before',
      '   forming a hypothesis.',
      '3. **Hypothesis** — state it as a falsifiable sentence, then name the observation that would refute it.',
      '4. **Timeline** — build it from timestamps, not from memory. Mark the deploy or config change nearest the',
      '   first symptom.',
      '5. **Reproduce** — only after the system is stable. A fix without a reproduction is a guess.',
      '',
      'Separate what you know from what you assume, explicitly, in the final write-up.'
    ].join('\n')
  }
]

function createCatalog({ fetchJson = null, searchLimit = DEFAULT_SEARCH_LIMIT, log = () => {} } = {}) {
  const curated = CURATED_COLLECTIONS.map((entry) => ({ ...entry, origin: 'curated', installable: true }))
  const bundled = BUNDLED_SKILLS.map((entry) => ({ ...entry, origin: 'bundled', installable: true, install: { kind: 'bundled', id: entry.id } }))

  /** Every entry the UI can show, with no network access. */
  function offlineEntries() {
    return [...bundled, ...curated]
  }

  function score(entry, terms) {
    if (!terms.length) return 1
    const haystack = [entry.name, entry.summary, entry.repo, entry.owner, ...(entry.tags || []), entry.category]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    let total = 0
    for (const term of terms) {
      if (!haystack.includes(term)) return 0
      // A name/tag hit is worth more than a summary hit.
      if (String(entry.name).toLowerCase().includes(term)) total += 3
      else if ((entry.tags || []).some((tag) => tag.toLowerCase().includes(term))) total += 2
      else total += 1
    }
    return total
  }

  /**
   * Search the catalog.
   *
   * @param {object} options
   * @param {string} [options.query]
   * @param {boolean} [options.includeLive]  also ask GitHub Code Search
   * @param {string[]} [options.tags]        restrict to entries carrying all tags
   */
  async function search({ query = '', includeLive = false, tags = [] } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
    const required = (tags || []).map((tag) => String(tag).toLowerCase())
    const filter = (entry) => required.every((tag) => (entry.tags || []).map((item) => item.toLowerCase()).includes(tag))

    const local = offlineEntries()
      .filter(filter)
      .map((entry) => ({ entry, rank: score(entry, terms) }))
      .filter((item) => item.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.entry.name.localeCompare(b.entry.name))
      .map((item) => item.entry)

    const result = {
      ok: true,
      query: String(query || ''),
      offline: { entries: local, total: local.length },
      live: null,
      liveStatus: includeLive ? 'skipped' : 'not-requested',
      notices: []
    }

    if (!includeLive) return result

    if (typeof fetchJson !== 'function') {
      result.liveStatus = 'unavailable'
      result.notices.push('未配置 GitHub 访问，仅显示内置与精选来源')
      return result
    }

    try {
      const entries = await liveSearch({ query: String(query || ''), limit: searchLimit })
      result.live = entries
      result.liveStatus = 'ok'
    } catch (error) {
      // A live search failure is informational: the curated list still answers.
      result.liveStatus = 'failed'
      result.notices.push(`GitHub 搜索不可用：${String(error?.message || error)}`)
      log(`skill catalog live search failed: ${error?.message || error}`)
    }
    return result
  }

  /** GitHub Code Search for `filename:SKILL.md`, one entry per repository hit. */
  async function liveSearch({ query = '', limit = DEFAULT_SEARCH_LIMIT } = {}) {
    const terms = query.trim() ? `${query.trim()} filename:SKILL.md` : 'filename:SKILL.md'
    const params = new URLSearchParams({ q: terms, per_page: String(Math.min(50, Math.max(1, limit))) })
    const payload = await fetchJson(`${GITHUB_API}/search/code?${params.toString()}`)
    const items = Array.isArray(payload?.items) ? payload.items : []
    const seen = new Set()
    const entries = []
    for (const item of items) {
      const repository = item?.repository || {}
      const owner = repository.owner?.login
      const repo = repository.name
      if (!owner || !repo) continue
      const key = `${owner}/${repo}`
      if (seen.has(key)) continue
      seen.add(key)
      const filePath = String(item.path || '')
      const subpath = filePath.replace(/\/?SKILL\.md$/i, '') || null
      entries.push({
        id: `live-${owner}-${repo}`,
        name: repo,
        owner,
        repo,
        subpath,
        summary: repository.description || `GitHub 上的 SKILL.md：${owner}/${repo}`,
        tags: ['github', 'search'],
        origin: 'live',
        installable: true,
        stars: Number(repository.stargazers_count) || 0,
        updatedAt: repository.updated_at || null,
        url: repository.html_url || `https://github.com/${owner}/${repo}`
      })
    }
    return entries
  }

  /** Look up one curated/bundled entry by id. */
  function get(id) {
    return offlineEntries().find((entry) => entry.id === id) || null
  }

  /** Tags present in the offline catalog, for filter chips. */
  function tags() {
    const counts = new Map()
    for (const entry of offlineEntries()) {
      for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  return {
    search,
    liveSearch,
    get,
    tags,
    offlineEntries,
    CURATED_COLLECTIONS,
    BUNDLED_SKILLS
  }
}

/** Render a bundled catalog entry as a `SKILL.md` document. */
function renderBundledSkill(entry) {
  if (!entry || !format.isSkillName(entry.name)) return null
  return format.renderSkillDocument({
    name: entry.name,
    description: entry.summary,
    whenToUse: `当任务涉及${entry.category || '该领域'}时需要`,
    metadata: { source: 'DS-Hns 内置技能库', category: entry.category || 'general', tags: (entry.tags || []).join(', ') },
    body: entry.body
  })
}

module.exports = {
  GITHUB_API,
  DEFAULT_SEARCH_LIMIT,
  CURATED_COLLECTIONS,
  BUNDLED_SKILLS,
  createCatalog,
  renderBundledSkill
}
