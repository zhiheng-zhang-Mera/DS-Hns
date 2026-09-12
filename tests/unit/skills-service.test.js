'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

/**
 * Skills: format, tar reader, source resolution and the install service.
 *
 * Two properties matter more than the happy path and are tested throughout:
 *   1. HNS accepts exactly what the harness accepts. A skill the dock reports as
 *      installed must be one `@deepseek-ai/dsh-skill-filesystem` will actually load,
 *      because a skill is live agent configuration.
 *   2. Nothing escapes the skill root, and nothing is installed before it has been
 *      validated — including from a hostile archive.
 */
const format = require('../../app/extensions/mega/skills/skill-format')
const tarModule = require('../../app/extensions/mega/skills/tar')
const source = require('../../app/extensions/mega/skills/skill-source')
const catalogModule = require('../../app/extensions/mega/skills/skill-catalog')
const { createSkillService, isInside } = require('../../app/extensions/mega/skills/skill-service')

function skillDoc(name, description, extra = '') {
  return ['---', `name: ${name}`, `description: ${description}`, extra, '---', '', `# ${name}`, 'Body.'].filter((line) => line !== '').join('\n')
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-skills-test-'))
  return {
    dir,
    root: path.join(dir, 'skills'),
    incoming: path.join(dir, 'incoming'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

function serviceFor(box, options = {}) {
  return createSkillService({ root: box.root, log: () => {}, ...options })
}

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test('the skill name grammar matches the harness', () => {
  for (const valid of ['a', 'code-review', 'x1-y2', 'repo-tour']) assert.equal(format.isSkillName(valid), true, valid)
  for (const invalid of ['', 'Code-Review', '-lead', 'trail-', 'a--b', 'under_score', 'a b', '中文', null, 12]) {
    assert.equal(format.isSkillName(invalid), false, String(invalid))
  }
})

test('frontmatter parsing reads the same subset the harness requires', () => {
  const parsed = format.parseSkillText(skillDoc('demo-skill', 'A demo', 'whenToUse: 当需要演示时\nmetadata:\n  category: test'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.skill.name, 'demo-skill')
  assert.equal(parsed.skill.description, 'A demo')
  assert.equal(parsed.skill.whenToUse, '当需要演示时')
  assert.deepEqual(parsed.skill.metadata, { category: 'test' })
  // Absent invocation keys mean both surfaces are permitted, like the harness.
  assert.equal(parsed.skill.modelInvocable, true)
  assert.equal(parsed.skill.userInvocable, true)
})

test('a missing or malformed frontmatter is rejected with a reason, never guessed', () => {
  assert.equal(format.parseSkillText('no frontmatter').ok, false)
  assert.match(format.parseSkillText('no frontmatter').reason, /frontmatter/)
  assert.match(format.parseSkillText('---\ndescription: only\n---\nbody').reason, /requires "name"/)
  assert.match(format.parseSkillText('---\nname: only\n---\nbody').reason, /requires "description"/)
  assert.match(format.parseSkillText('---\nname: BadName\ndescription: x\n---\n').reason, /kebab-case/)
})

test('invocation booleans accept every spelling the harness accepts, and reject the rest', () => {
  for (const truthy of ['true', 'True', 'yes', 'on', '1']) {
    const parsed = format.parseSkillText(skillDoc('inv-skill', 'x', `disable-model-invocation: ${truthy}`))
    assert.equal(parsed.ok, true, truthy)
    assert.equal(parsed.skill.modelInvocable, false, truthy)
  }
  for (const falsy of ['false', 'no', 'off', '0']) {
    const parsed = format.parseSkillText(skillDoc('inv-skill', 'x', `user-invocable: ${falsy}`))
    assert.equal(parsed.ok, true, falsy)
    assert.equal(parsed.skill.userInvocable, false, falsy)
  }
  // An unsupported spelling drops the whole skill rather than silently permitting a surface.
  const rejected = format.parseSkillText(skillDoc('inv-skill', 'x', 'disable-model-invocation: maybe'))
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /must be a boolean/)
})

test('rendering a skill document round-trips through the parser', () => {
  const original = {
    name: 'round-trip',
    description: '描述 with : colon and "quote"',
    whenToUse: 'when needed',
    metadata: { category: 'testing' },
    modelInvocable: false,
    userInvocable: true,
    body: '# Heading\n\nLine one.'
  }
  const parsed = format.parseSkillText(format.renderSkillDocument(original))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.skill, original)
})

test('the frontmatter parser tolerates comments, quoting and nested metadata', () => {
  const data = format.parseSimpleYaml([
    '# a comment',
    'name: demo',
    'description: "quoted: value # not a comment"',
    'plain: value # trailing comment',
    'metadata:',
    '  owner: someone',
    '  nested: 2'
  ].join('\n'))
  assert.equal(data.name, 'demo')
  assert.equal(data.description, 'quoted: value # not a comment')
  assert.equal(data.plain, 'value')
  assert.equal(data.metadata.owner, 'someone')
  assert.equal(data.metadata.nested, '2')
})

test('scanning a root discovers exactly what the harness discovers', () => {
  const box = scratch()
  try {
    fs.mkdirSync(path.join(box.root, 'bundle-skill'), { recursive: true })
    fs.writeFileSync(path.join(box.root, 'bundle-skill', 'SKILL.md'), skillDoc('bundle-skill', 'A bundle'), 'utf8')
    fs.writeFileSync(path.join(box.root, 'flat-skill.md'), skillDoc('flat-skill', 'A flat skill'), 'utf8')
    fs.writeFileSync(path.join(box.root, 'README.md'), 'not a skill', 'utf8')
    fs.mkdirSync(path.join(box.root, '.system'), { recursive: true })
    fs.writeFileSync(path.join(box.root, '.system', 'SKILL.md'), skillDoc('system-skill', 'hidden'), 'utf8')
    fs.mkdirSync(path.join(box.root, 'not-a-skill'), { recursive: true })
    fs.writeFileSync(path.join(box.root, 'not-a-skill', 'readme.txt'), 'nothing', 'utf8')
    fs.mkdirSync(path.join(box.root, 'nested', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(box.root, 'nested', 'deeper', 'SKILL.md'), skillDoc('deep', 'nested is not discovered'), 'utf8')

    const found = format.scanSkillRoot(box.root).map((entry) => entry.name)
    assert.deepEqual(found, ['bundle-skill', 'flat-skill'])
    assert.ok(!found.includes('.system'), 'the harness skips the .system child')
    assert.ok(!found.includes('README'), 'a root README is not a skill')
    assert.ok(!found.includes('deep'), 'nested SKILL.md files are deliberately not discovered')
  } finally {
    box.cleanup()
  }
})

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function tarHeader(name, size, type) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  block.write('00000000000\0', 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let index = 0; index < 512; index += 1) sum += block[index]
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function tarPad(buffer) {
  const remainder = buffer.length % 512
  return remainder ? Buffer.concat([buffer, Buffer.alloc(512 - remainder)]) : buffer
}

function buildTar(entries) {
  const blocks = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry.path, entry.data ? entry.data.length : 0, entry.type || '0'))
    if (entry.data) blocks.push(tarPad(entry.data))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

test('the tar reader extracts regular files and directories', () => {
  const box = scratch()
  try {
    const document = Buffer.from(skillDoc('archived-skill', 'From an archive'), 'utf8')
    const archive = buildTar([
      { path: 'repo-main/', type: '5' },
      { path: 'repo-main/skills/', type: '5' },
      { path: 'repo-main/skills/archived-skill/SKILL.md', data: document }
    ])
    const result = tarModule.extractTar({ buffer: archive, destDir: box.incoming, stripComponents: 1 })
    assert.deepEqual(result.written, ['skills/archived-skill/SKILL.md'])
    assert.equal(fs.readFileSync(path.join(box.incoming, 'skills', 'archived-skill', 'SKILL.md'), 'utf8'), document.toString('utf8'))
  } finally {
    box.cleanup()
  }
})

test('the tar reader refuses path traversal and absolute paths', () => {
  const box = scratch()
  try {
    const evil = Buffer.from('pwned', 'utf8')
    const archive = buildTar([
      { path: '../escaped.txt', data: evil },
      { path: '/absolute.txt', data: evil },
      { path: 'repo/../../escaped2.txt', data: evil },
      { path: 'C:/windows.txt', data: evil },
      { path: 'repo/legit.txt', data: evil }
    ])
    const result = tarModule.extractTar({ buffer: archive, destDir: box.incoming })
    assert.deepEqual(result.written, ['repo/legit.txt'], 'only the legitimate entry is written')
    assert.ok(!fs.existsSync(path.join(box.dir, 'escaped.txt')))
    assert.ok(!fs.existsSync(path.join(box.dir, 'escaped2.txt')))
    assert.ok(!fs.existsSync(path.join(box.incoming, 'absolute.txt')))
    assert.ok(!fs.existsSync(path.join(box.dir, 'windows.txt')))
  } finally {
    box.cleanup()
  }
})

test('symlinks, hardlinks and devices are skipped, never materialized', () => {
  const box = scratch()
  try {
    const archive = buildTar([
      { path: 'repo/link', type: '2' },
      { path: 'repo/hard', type: '1' },
      { path: 'repo/dev', type: '3' },
      { path: 'repo/file.txt', data: Buffer.from('ok') }
    ])
    const result = tarModule.extractTar({ buffer: archive, destDir: box.incoming })
    assert.deepEqual(result.written, ['repo/file.txt'])
    assert.equal(result.skipped.length, 3)
    assert.ok(result.skipped.every((item) => /unsupported entry type|escapes/.test(item.reason)))
  } finally {
    box.cleanup()
  }
})

test('the tar reader stops a zip-bomb sized archive at the byte cap', () => {
  const box = scratch()
  try {
    const big = Buffer.alloc(2048, 0x61)
    const archive = buildTar([
      { path: 'a.bin', data: big },
      { path: 'b.bin', data: big },
      { path: 'c.bin', data: big }
    ])
    assert.throws(
      () => tarModule.extractTar({ buffer: archive, destDir: box.incoming, maxBytes: 3000 }),
      /exceeds/
    )
  } finally {
    box.cleanup()
  }
})

test('gzip is detected and decompressed transparently', () => {
  const box = scratch()
  try {
    const document = Buffer.from(skillDoc('gzipped-skill', 'Gzipped'), 'utf8')
    const archive = zlib.gzipSync(buildTar([{ path: 'repo/SKILL.md', data: document }]))
    const result = tarModule.extractTar({ buffer: archive, destDir: box.incoming })
    assert.deepEqual(result.written, ['repo/SKILL.md'])
    assert.equal(fs.readFileSync(path.join(box.incoming, 'repo', 'SKILL.md'), 'utf8'), document.toString('utf8'))
  } finally {
    box.cleanup()
  }
})

// ---------------------------------------------------------------------------
// source resolution
// ---------------------------------------------------------------------------

test('every supported GitHub reference form resolves to the right target', () => {
  const cases = [
    ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo', branch: null, subpath: null }],
    ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
    ['owner/repo', { owner: 'owner', repo: 'repo', branch: null, subpath: null }],
    ['owner/repo@main', { owner: 'owner', repo: 'repo', branch: 'main', subpath: null }],
    ['owner/repo@main/skills/docx', { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'skills/docx' }],
    ['git@github.com:owner/repo.git', { owner: 'owner', repo: 'repo', branch: null }],
    ['https://github.com/owner/repo/tree/main/skills', { owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo/blob/main/skills/x/SKILL.md', { owner: 'owner', repo: 'repo' }]
  ]
  for (const [input, expected] of cases) {
    const parsed = source.parseGithubReference(input)
    assert.equal(parsed.ok, true, input)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(parsed.ref[key], value, `${input} -> ${key}`)
    }
  }
})

test('a /tree/ URL keeps every plausible ref split, longest first', () => {
  const parsed = source.parseGithubReference('https://github.com/owner/repo/tree/feature/x/skills/docx')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ref.refCandidates, [
    { branch: 'feature/x/skills/docx', subpath: null },
    { branch: 'feature/x/skills', subpath: 'docx' },
    { branch: 'feature/x', subpath: 'skills/docx' },
    { branch: 'feature', subpath: 'x/skills/docx' }
  ])
})

test('non-GitHub http(s) URLs and junk are told apart', () => {
  assert.equal(source.parseGithubReference('https://example.com/skill.md').ref.kind, 'url')
  assert.equal(source.parseGithubReference('https://raw.githubusercontent.com/o/r/main/SKILL.md').ref.kind, 'rawFile')
  assert.equal(source.parseGithubReference('not a url').ok, false)
  assert.equal(source.parseGithubReference('ftp://example.com/x').ok, false)
  assert.equal(source.parseGithubReference('https://github.com/owner/repo/issues').ok, false)
})

test('archive URLs follow the codeload convention with a branch fallback', () => {
  const urls = source.archiveUrls({ owner: 'o', repo: 'r', branch: null })
  assert.ok(urls.includes('https://codeload.github.com/o/r/tar.gz/refs/heads/main'))
  assert.ok(urls.includes('https://codeload.github.com/o/r/tar.gz/refs/heads/master'))
  const tagged = source.archiveUrls({ owner: 'o', repo: 'r', branch: 'v1.2.0' })
  assert.ok(tagged[0].includes('refs/heads/v1.2.0'), 'the named ref is tried first')
  assert.ok(tagged.some((url) => url.endsWith('/v1.2.0')), 'a tag form is also tried')
})

test('local sources resolve for a bundle, a collection, a flat file and a single skill file', () => {
  const box = scratch()
  try {
    fs.mkdirSync(path.join(box.incoming, 'bundle'), { recursive: true })
    fs.writeFileSync(path.join(box.incoming, 'bundle', 'SKILL.md'), skillDoc('single-bundle', 'x'), 'utf8')

    fs.mkdirSync(path.join(box.incoming, 'collection', 'one'), { recursive: true })
    fs.mkdirSync(path.join(box.incoming, 'collection', 'two'), { recursive: true })
    fs.writeFileSync(path.join(box.incoming, 'collection', 'one', 'SKILL.md'), skillDoc('one-skill', 'x'), 'utf8')
    fs.writeFileSync(path.join(box.incoming, 'collection', 'two', 'SKILL.md'), skillDoc('two-skill', 'x'), 'utf8')

    fs.mkdirSync(path.join(box.incoming, 'flats'), { recursive: true })
    fs.writeFileSync(path.join(box.incoming, 'flats', 'flat-a.md'), skillDoc('flat-a', 'x'), 'utf8')

    const bundle = source.inspectLocalPath(path.join(box.incoming, 'bundle'))
    assert.equal(bundle.ok, true)
    assert.equal(bundle.candidates.length, 1)

    const collection = source.inspectLocalPath(path.join(box.incoming, 'collection'))
    assert.equal(collection.ok, true)
    assert.deepEqual(collection.candidates.map((item) => item.name).sort(), ['one-skill', 'two-skill'])

    const flats = source.inspectLocalPath(path.join(box.incoming, 'flats'))
    assert.equal(flats.ok, true)
    assert.deepEqual(flats.candidates.map((item) => item.name), ['flat-a'])

    const file = source.inspectLocalPath(path.join(box.incoming, 'flats', 'flat-a.md'))
    assert.equal(file.ok, true)
    assert.equal(file.candidates[0].name, 'flat-a')

    // A directory whose only Markdown is nested is not a skill collection.
    const empty = path.join(box.incoming, 'empty')
    fs.mkdirSync(path.join(empty, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(empty, 'nested', 'note.md'), skillDoc('buried', 'x'), 'utf8')
    const noSkill = source.inspectLocalPath(empty)
    assert.equal(noSkill.ok, false)
    assert.match(noSkill.reason, /no skill found/)

    // A path that looks like a skill but fails validation must say why.
    const bad = path.join(box.incoming, 'bad')
    fs.mkdirSync(bad, { recursive: true })
    fs.writeFileSync(path.join(bad, 'SKILL.md'), 'no frontmatter here', 'utf8')
    const rejected = source.inspectLocalPath(bad)
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason, /未通过校验/, 'the specific reason is surfaced, not "no skill found"')
    assert.match(rejected.reason, /frontmatter/)

    assert.equal(source.inspectLocalPath(path.join(box.dir, 'missing')).ok, false)
  } finally {
    box.cleanup()
  }
})

test('a repository collection is located inside an extracted archive', () => {
  const box = scratch()
  try {
    const document = (name) => Buffer.from(skillDoc(name, `${name} description`), 'utf8')
    const archive = buildTar([
      { path: 'repo-main/', type: '5' },
      { path: 'repo-main/skills/alpha/SKILL.md', data: document('alpha') },
      { path: 'repo-main/skills/beta/SKILL.md', data: document('beta') },
      { path: 'repo-main/README.md', data: Buffer.from('# readme') }
    ])
    // Extracted the way the installer does it: the archive's own wrapper component
    // is stripped, so the repository root is the top-level entry.
    const prepared = path.join(box.incoming, 'repo-main')
    tarModule.extractTar({ buffer: archive, destDir: prepared, stripComponents: 1 })
    const located = source.locateSkills(prepared)
    assert.deepEqual(located.candidates.map((item) => item.name), ['alpha', 'beta'])

    // The same tree with its wrapper directory still present also resolves, because
    // the collection pass looks one level deeper than the root.
    tarModule.extractTar({ buffer: archive, destDir: box.incoming })
    const wrapped = source.locateSkills(box.incoming)
    assert.deepEqual(wrapped.candidates.map((item) => item.name).sort(), ['alpha', 'beta'])
  } finally {
    box.cleanup()
  }
})

test('a repository that is itself a skill resolves as one candidate', () => {
  const box = scratch()
  try {
    const document = Buffer.from(skillDoc('repo-skill', 'A repository that is a skill'), 'utf8')
    const archive = buildTar([{ path: 'repo-main/SKILL.md', data: document }])
    const prepared = path.join(box.incoming, 'repo-main')
    tarModule.extractTar({ buffer: archive, destDir: prepared, stripComponents: 1 })
    const located = source.locateSkills(prepared)
    assert.equal(located.candidates.length, 1)
    assert.equal(located.candidates[0].name, 'repo-main')
  } finally {
    box.cleanup()
  }
})

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

test('the offline catalog always answers, with or without GitHub access', async () => {
  const catalog = catalogModule.createCatalog({})
  const result = await catalog.search({ query: '' })
  assert.equal(result.ok, true)
  assert.ok(result.offline.entries.length > 0, 'bundled and curated entries are always available')
  assert.equal(result.liveStatus, 'not-requested')
})

test('catalog search matches name, tags and summary, and ranks name hits first', async () => {
  const catalog = catalogModule.createCatalog({})
  const byTag = await catalog.search({ query: 'git' })
  assert.ok(byTag.offline.entries.some((entry) => entry.name === 'commit-message'))
  const bySummary = await catalog.search({ query: '线上问题' })
  assert.ok(bySummary.offline.entries.length > 0)
  const none = await catalog.search({ query: 'zzzz-no-such-skill' })
  assert.equal(none.offline.entries.length, 0)
})

test('a live search failure is reported and never removes the offline results', async () => {
  const catalog = catalogModule.createCatalog({
    fetchJson: async () => {
      throw new Error('rate limited')
    }
  })
  const result = await catalog.search({ query: '', includeLive: true })
  assert.equal(result.liveStatus, 'failed')
  assert.ok(result.notices.some((notice) => /rate limited/.test(notice)))
  assert.ok(result.offline.entries.length > 0, 'the curated list still answers')
})

test('a live search result becomes an installable entry', async () => {
  const catalog = catalogModule.createCatalog({
    fetchJson: async () => ({
      items: [
        {
          path: 'skills/docx/SKILL.md',
          repository: { name: 'skills', html_url: 'https://github.com/anthropics/skills', stargazers_count: 42, owner: { login: 'anthropics' } }
        },
        // A second hit from the same repository must not produce a duplicate row.
        { path: 'skills/pdf/SKILL.md', repository: { name: 'skills', owner: { login: 'anthropics' } } }
      ]
    })
  })
  const result = await catalog.search({ query: 'docx', includeLive: true })
  assert.equal(result.liveStatus, 'ok')
  assert.equal(result.live.length, 1, 'one entry per repository')
  assert.equal(result.live[0].owner, 'anthropics')
  assert.equal(result.live[0].subpath, 'skills/docx')
})

test('bundled catalog entries render into valid skill documents', () => {
  for (const entry of catalogModule.BUNDLED_SKILLS) {
    const document = catalogModule.renderBundledSkill(entry)
    assert.ok(document, entry.id)
    const parsed = format.parseSkillText(document)
    assert.equal(parsed.ok, true, `${entry.id}: ${parsed.reason || ''}`)
    assert.equal(parsed.skill.name, entry.name)
    assert.ok(parsed.skill.body.length > 40, `${entry.id} has real instructions`)
  }
})

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

test('installing a local bundle stages, validates and copies it with its resources', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    const bundle = path.join(box.incoming, 'bundle')
    fs.mkdirSync(path.join(bundle, 'reference'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), skillDoc('staged-skill', 'A staged skill'), 'utf8')
    fs.writeFileSync(path.join(bundle, 'reference', 'notes.md'), 'supporting notes', 'utf8')

    const result = service.installLocal(bundle)
    assert.equal(result.ok, true, result.reason)
    assert.deepEqual(result.installed.map((item) => item.name), ['staged-skill'])
    assert.equal(fs.existsSync(path.join(box.root, 'staged-skill', 'SKILL.md')), true)
    assert.equal(fs.readFileSync(path.join(box.root, 'staged-skill', 'reference', 'notes.md'), 'utf8'), 'supporting notes')
    assert.equal(service.list().counts.valid, 1)
  } finally {
    box.cleanup()
  }
})

test('an invalid skill is refused and leaves nothing behind', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    const broken = path.join(box.incoming, 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'SKILL.md'), 'no frontmatter at all', 'utf8')

    const result = service.installLocal(broken)
    assert.equal(result.ok, false)
    assert.match(result.reason, /未通过校验|frontmatter/, 'the reason names the actual problem')
    // Nothing was created: a rejected source must not even materialize the root.
    const leftovers = fs.existsSync(box.root) ? fs.readdirSync(box.root) : []
    assert.deepEqual(leftovers, [], 'nothing is installed')
  } finally {
    box.cleanup()
  }
})

test('a name conflict renames, overwrites or skips according to the policy', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    const bundle = path.join(box.incoming, 'bundle')
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), skillDoc('conflict-skill', 'v1'), 'utf8')

    const first = service.installLocal(bundle)
    assert.deepEqual(first.installed.map((item) => item.name), ['conflict-skill'])

    const renamed = service.installLocal(bundle)
    assert.deepEqual(renamed.installed.map((item) => item.name), ['conflict-skill-2'], 'the default keeps both')

    const skipped = service.installLocal(bundle, { conflict: 'skip' })
    assert.equal(skipped.ok, false)
    assert.equal(skipped.skipped[0].reason, 'exists')

    fs.writeFileSync(path.join(bundle, 'SKILL.md'), skillDoc('conflict-skill', 'v2 replaced'), 'utf8')
    const overwritten = service.installLocal(bundle, { conflict: 'overwrite' })
    assert.deepEqual(overwritten.installed.map((item) => item.name), ['conflict-skill'])
    assert.equal(service.detail('conflict-skill').description, 'v2 replaced', 'the previous copy is replaced')
    assert.equal(service.list().skills.length, 2, 'the renamed copy is untouched')
  } finally {
    box.cleanup()
  }
})

test('a collection installs every skill it contains and records the grouping', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    const collection = path.join(box.incoming, 'collection')
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.mkdirSync(path.join(collection, name), { recursive: true })
      fs.writeFileSync(path.join(collection, name, 'SKILL.md'), skillDoc(name, `${name} skill`), 'utf8')
    }
    const result = service.installLocal(collection, { collection: 'my-collection' })
    assert.equal(result.ok, true)
    assert.equal(result.installed.length, 3)
    const snapshot = service.list()
    const group = snapshot.collections.find((entry) => entry.id === 'my-collection')
    assert.ok(group, 'the collection is recorded')
    assert.equal(group.count, 3)
  } finally {
    box.cleanup()
  }
})

test('deletion removes exactly one skill and is confined to the skill root', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    for (const name of ['keep-me', 'drop-me']) {
      fs.mkdirSync(path.join(box.root, name), { recursive: true })
      fs.writeFileSync(path.join(box.root, name, 'SKILL.md'), skillDoc(name, 'x'), 'utf8')
    }
    assert.equal(service.deleteSkill('drop-me').ok, true)
    assert.equal(fs.existsSync(path.join(box.root, 'drop-me')), false)
    assert.equal(fs.existsSync(path.join(box.root, 'keep-me')), true)

    for (const invalid of ['../keep-me', 'keep-me/..', 'nope', '', null]) {
      const result = service.deleteSkill(invalid)
      assert.equal(result.ok, false, String(invalid))
      assert.ok(['not_found', 'invalid_name'].includes(result.reason), String(invalid))
    }
    assert.equal(fs.existsSync(path.join(box.root, 'keep-me')), true, 'no traversal deleted the sibling')
  } finally {
    box.cleanup()
  }
})

test('a batch delete reports every item and never aborts on the first failure', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    for (const name of ['one', 'two', 'three']) {
      fs.mkdirSync(path.join(box.root, name), { recursive: true })
      fs.writeFileSync(path.join(box.root, name, 'SKILL.md'), skillDoc(name, 'x'), 'utf8')
    }
    const result = service.deleteSkills(['one', 'ghost', 'three', 'ghost'])
    assert.equal(result.ok, false)
    assert.deepEqual(result.deleted.sort(), ['one', 'three'])
    assert.deepEqual(result.failed.map((item) => item.name), ['ghost'], 'duplicates are reported once')
    assert.equal(service.list().skills.map((item) => item.name).join(','), 'two')
  } finally {
    box.cleanup()
  }
})

test('deleting a collection removes only its own members', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    for (const [name, collection] of [['a1', 'group-x'], ['a2', 'group-x'], ['b1', 'group-y'], ['solo', null]]) {
      fs.mkdirSync(path.join(box.root, name), { recursive: true })
      fs.writeFileSync(path.join(box.root, name, 'SKILL.md'), skillDoc(name, 'x'), 'utf8')
      if (collection) {
        fs.mkdirSync(path.join(box.root, '.hns-meta'), { recursive: true })
        fs.writeFileSync(path.join(box.root, '.hns-meta', `${name}.json`), JSON.stringify({ name, collection }), 'utf8')
      }
    }
    const result = service.deleteCollection('group-x')
    assert.equal(result.ok, true)
    assert.deepEqual(result.deleted.sort(), ['a1', 'a2'])
    assert.deepEqual(service.list().skills.map((item) => item.name).sort(), ['b1', 'solo'])
    assert.equal(service.deleteCollection('nope').reason, 'collection_not_found')
  } finally {
    box.cleanup()
  }
})

test('a flat skill installs as a single file and is deleted as one', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    const file = path.join(box.incoming, 'flat-skill.md')
    fs.mkdirSync(box.incoming, { recursive: true })
    fs.writeFileSync(file, skillDoc('flat-skill', 'A flat skill'), 'utf8')

    const result = service.installLocal(file)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.installed[0].kind, 'flat')
    assert.equal(fs.existsSync(path.join(box.root, 'flat-skill.md')), true)
    assert.equal(service.deleteSkill('flat-skill').ok, true)
    assert.equal(fs.existsSync(path.join(box.root, 'flat-skill.md')), false)
  } finally {
    box.cleanup()
  }
})

test('invocation surfaces can be toggled without reinstalling', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    fs.mkdirSync(path.join(box.root, 'toggle-skill'), { recursive: true })
    fs.writeFileSync(path.join(box.root, 'toggle-skill', 'SKILL.md'), skillDoc('toggle-skill', 'x'), 'utf8')

    const result = service.setInvocation('toggle-skill', { modelInvocable: false })
    assert.equal(result.ok, true)
    const detail = service.detail('toggle-skill')
    assert.equal(detail.modelInvocable, false)
    assert.equal(detail.userInvocable, true)
    // The body survives the rewrite.
    assert.match(detail.body, /toggle-skill/)
  } finally {
    box.cleanup()
  }
})

test('a bundled skill installs with no network access at all', () => {
  const box = scratch()
  try {
    const service = serviceFor(box, { fetchBuffer: async () => { throw new Error('network must not be used') } })
    const result = service.installBundled('bundled-commit-message')
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.installed[0].name, 'commit-message')
    assert.equal(service.list().skills[0].origin, 'bundled')
  } finally {
    box.cleanup()
  }
})

test('installing from a GitHub reference downloads, locates and namespaces the collection', async () => {
  const box = scratch()
  try {
    const documents = ['alpha', 'beta'].map((name) => Buffer.from(skillDoc(name, `${name} description`), 'utf8'))
    const archive = zlib.gzipSync(buildTar([
      { path: 'repo-main/', type: '5' },
      { path: 'repo-main/skills/alpha/SKILL.md', data: documents[0] },
      { path: 'repo-main/skills/beta/SKILL.md', data: documents[1] }
    ]))
    const requested = []
    const service = serviceFor(box, {
      fetchBuffer: async (url) => {
        requested.push(url)
        return archive
      }
    })

    const result = await service.installRemote('https://github.com/owner/repo/tree/main/skills', { prefix: 'demo' })
    assert.equal(result.ok, true, result.reason)
    assert.equal(requested.length, 1)
    assert.match(requested[0], /^https:\/\/codeload\.github\.com\/owner\/repo\/tar\.gz\//)
    // Two skills from one repository are namespaced so a `review` in one repo cannot
    // collide with a `review` in another.
    assert.deepEqual(result.installed.map((item) => item.name).sort(), ['demo-alpha', 'demo-beta'])
    assert.deepEqual(result.installed.map((item) => item.upstreamName).sort(), ['alpha', 'beta'])
    assert.deepEqual(service.list().collections.map((entry) => entry.id), ['demo'])
  } finally {
    box.cleanup()
  }
})

test('a download failure is reported without touching the skill root', async () => {
  const box = scratch()
  try {
    const service = serviceFor(box, {
      fetchBuffer: async () => {
        throw new Error('HTTP 404 for archive')
      }
    })
    const result = await service.installRemote('https://github.com/owner/repo')
    assert.equal(result.ok, false)
    assert.match(result.reason, /404|未能/)
    assert.equal(fs.existsSync(box.root) && fs.readdirSync(box.root).length > 0, false)
  } finally {
    box.cleanup()
  }
})

test('a repository with no skill anywhere reports that clearly', async () => {
  const box = scratch()
  try {
    const archive = zlib.gzipSync(buildTar([
      { path: 'repo-main/', type: '5' },
      { path: 'repo-main/README.md', data: Buffer.from('# just a readme') }
    ]))
    const service = serviceFor(box, { fetchBuffer: async () => archive })
    const result = await service.installRemote('https://github.com/owner/repo')
    assert.equal(result.ok, false)
    assert.match(result.reason, /no-skill-found|未能/)
  } finally {
    box.cleanup()
  }
})

test('a raw skill document URL installs as a single skill', async () => {
  const box = scratch()
  try {
    const service = serviceFor(box, {
      fetchBuffer: async () => Buffer.from(skillDoc('downloaded-skill', 'Downloaded directly'), 'utf8')
    })
    const result = await service.installRemote('https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md')
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.installed[0].name, 'downloaded-skill')
  } finally {
    box.cleanup()
  }
})

test('the service snapshot reports what the dock needs and hides its own metadata', () => {
  const box = scratch()
  try {
    const service = serviceFor(box)
    fs.mkdirSync(path.join(box.root, 'visible-skill'), { recursive: true })
    fs.writeFileSync(path.join(box.root, 'visible-skill', 'SKILL.md'), skillDoc('visible-skill', 'x'), 'utf8')

    const snapshot = service.snapshot()
    assert.equal(snapshot.root, box.root)
    assert.equal(snapshot.counts.total, 1)
    assert.deepEqual(snapshot.skills.map((item) => item.name), ['visible-skill'])
    assert.ok(!snapshot.skills.some((item) => item.name.startsWith('.')), 'the metadata directory is never a skill')
    assert.equal(snapshot.catalog.bundled > 0, true)
  } finally {
    box.cleanup()
  }
})

test('isInside refuses a sibling whose path merely shares a prefix', () => {
  assert.equal(isInside('C:/a/skills', 'C:/a/skills/x'), true)
  assert.equal(isInside('C:/a/skills', 'C:/a/skills'), true)
  assert.equal(isInside('C:/a/skills', 'C:/a/skills-other/x'), false)
  assert.equal(isInside('C:/a/skills', 'C:/a'), false)
})
