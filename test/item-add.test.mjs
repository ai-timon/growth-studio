// `item add <url>` (lib/item-add.js): an X post read through a simulated treg connector is stored with its author,
// metrics, capture and cost; a known post costs nothing; the guardrails of the triage apply (competitor, reference).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { inlineInput, runTool } from '../lib/agent-tools.js'
import { ItemUsageError, addItem, guessRole, parseStatusUrl, storeItem } from '../lib/item-add.js'
import { scopeDb } from '../lib/scope.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = new Date('2026-01-07T10:00:00Z')

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-item-'))
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
  migrate(db)
  db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
  db.exec(`INSERT INTO competitors(id, slug, name) VALUES (1, 'rival', 'Rival')`)
  db.exec(`INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalApp')`)
  db.exec(`INSERT INTO accounts(id, network, handle, external_id, relation, watch_role) VALUES (9, 'x', 'ref_account', '900', 'watched', 'reference')`)
  const files = {}
  const put = (name, content) => { files[name] = Buffer.from(content).toString('base64'); return name }
  const paths = { base: dir, mediaDir: path.join(dir, 'media') }
  const run = (...argv) => runTool(db, argv, { paths, input: inlineInput(files) })
  const withDb = (fn) => fn(db)
  return { db, put, run, withDb, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
/** A treg connector that answers `answer(data)` and records its calls. */
function fakeTreg(answer = {}, { ok = true, fail = null, cost = 0.00075, top = undefined } = {}) {
  const calls = []
  return {
    calls,
    check: async () => (ok ? { ok: true, hint: '' } : { ok: false, hint: 'treg: `treg` was not found on this machine' }),
    call: async (tool, data, opts) => {
      calls.push({ tool, data, opts })
      if (fail) throw fail
      return { json: { output: { found: true, data: { id: '2113599736511152535', authorId: '777', createdUtc: 1767780000, text: 'A useful tool for agents.', likes: 12, views: 3400, retweets: 3, replies: 2, bookmarks: 5, media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }], ...answer } }, costUsd: top }, costUsd: cost }
    },
  }
}
const URL1 = 'https://x.com/Some_Media/status/2113599736511152535'

test('item add: stores the post, its new author (watched, not polled), metrics, a manual capture and the cost', async () => {
  const t = setup()
  try {
    const treg = fakeTreg()
    const out = await addItem({ withDb: t.withDb, treg, url: `${URL1}?s=20`, now: NOW })
    assert.equal(treg.calls.length, 1)
    assert.deepEqual([treg.calls[0].tool, treg.calls[0].data], ['anyapi.twitter.tweet', { url: URL1 }])
    const it = t.db.prepare(`SELECT * FROM items WHERE external_id = '2113599736511152535'`).get()
    assert.match(out, new RegExp(`post stored \\(0\\.00075 \\$\\): item #${it.id} \\(@Some_Media`))
    assert.match(out, new RegExp(`--quote ${it.id}`))
    assert.deepEqual([it.network, it.kind, it.url, it.text, it.posted_at, it.first_seen_at], ['x', 'post', URL1, 'A useful tool for agents.', '2026-01-07T10:00:00Z', '2026-01-07T10:00:00Z'])
    assert.deepEqual(JSON.parse(it.media), [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }])
    const a = t.db.prepare('SELECT * FROM accounts WHERE id = ?').get(it.author_id)
    assert.deepEqual([a.handle, a.external_id, a.relation, a.role, a.watch_priority, a.watch_role, a.owner_user_id, a.competitor_id], ['Some_Media', '777', 'watched', 'personal', null, null, null, null])
    assert.deepEqual({ ...t.db.prepare('SELECT likes, views, shares, replies, saves FROM item_metrics WHERE item_id = ?').get(it.id) }, { likes: 12, views: 3400, shares: 3, replies: 2, saves: 5 })
    const cap = t.db.prepare('SELECT * FROM captures WHERE item_id = ?').get(it.id)
    assert.deepEqual([cap.source, cap.account_id, cap.query], ['manual', null, URL1])
    const run = t.db.prepare('SELECT * FROM ingest_runs WHERE id = ?').get(cap.run_id)
    assert.deepEqual([run.source, run.account_id, run.items_new, run.cost_usd, run.status], ['manual', a.id, 1, 0.00075, 'ok'])

    // a quote draft, then a revision that quotes it: no visual required to schedule a quote
    assert.match(t.run('post', 'draft', '--account', 'acme_dev', '--file', t.put('p.txt', 'Worth a look.'), '--quote', String(it.id)), /quotes item/)
    const rev = t.run('post', 'revise', '1', '--file', t.put('r.txt', 'Found this, tried it, it works.'), '--quote', String(it.id))
    const v = t.db.prepare('SELECT * FROM posts WHERE supersedes_post_id = 1').get()
    assert.match(rev, new RegExp(`post #${v.id} created \\(pending_validation, quotes item #${it.id}\\)`))
    assert.deepEqual([v.kind, v.quote_item_id, v.status, v.idea_id], ['quote', it.id, 'pending_validation', 1])
    assert.deepEqual(t.db.prepare('SELECT item_id, relation FROM post_items WHERE post_id = ? ORDER BY item_id').all(v.id).map((r) => ({ ...r })),
      [{ item_id: 1, relation: 'inspired_by' }, { item_id: it.id, relation: 'quotes' }])
    assert.equal(t.db.prepare('SELECT relation FROM idea_items WHERE idea_id = 1 AND item_id = ?').get(it.id).relation, 'quotes')
    t.db.prepare(`UPDATE posts SET status = 'approved', validated_at = '2026-01-07T11:00:00Z', validated_by = 'user-1' WHERE id = ?`).run(v.id)
    t.db.prepare(`UPDATE posts SET status = 'scheduled', scheduled_for = '2026-01-08T09:00:00Z' WHERE id = ?`).run(v.id)

    // --role brand for the official account of a product
    await addItem({ withDb: t.withDb, treg: fakeTreg({ id: '55', authorId: '888' }), url: 'https://twitter.com/SomeLab/status/55', role: 'brand', now: NOW })
    assert.equal(t.db.prepare(`SELECT role FROM accounts WHERE handle = 'SomeLab'`).get().role, 'brand')
    await assert.rejects(addItem({ withDb: t.withDb, treg: fakeTreg(), url: URL1.replace('2113599736511152535', '56'), role: 'bot', now: NOW }), ItemUsageError)
  } finally { t.done() }
})

test('item add: a post already in the database gives its id back without any paid call (even without treg)', async () => {
  const t = setup()
  try {
    const treg = fakeTreg()
    await addItem({ withDb: t.withDb, treg, url: URL1, now: NOW })
    const again = await addItem({ withDb: t.withDb, treg, url: 'https://mobile.twitter.com/some_media/status/2113599736511152535/photo/1', now: NOW })
    assert.equal(treg.calls.length, 1, 'no second call')
    assert.match(again, /already in the database \(nothing fetched\): item #\d+/)
    assert.match(await addItem({ withDb: t.withDb, treg: null, url: 'https://x.com/example_lab/status/1000000000000000001', now: NOW }), /item #1 \(@example_lab/)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE external_id = '2113599736511152535'`).get().n, 1)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ingest_runs WHERE source = 'manual'`).get().n, 1)
  } finally { t.done() }
})

test('item add: a competitor (author alias or text) sets competitor_id; such an item can never be quoted', async () => {
  const t = setup()
  try {
    const byRival = await addItem({ withDb: t.withDb, treg: fakeTreg({ id: '61', authorId: '610' }), url: 'https://x.com/RivalAppHQ/status/61', now: NOW })
    assert.match(byRival, /WARNING: it is about a competitor/)
    assert.equal(t.db.prepare(`SELECT competitor_id FROM accounts WHERE handle = 'RivalAppHQ'`).get().competitor_id, 1)
    const aboutRival = await addItem({ withDb: t.withDb, treg: fakeTreg({ id: '62', authorId: '620', text: 'We moved off RivalApp last week.' }), url: 'https://x.com/neutral_dev/status/62', now: NOW })
    assert.match(aboutRival, /WARNING: it is about a competitor/)
    const iid = t.db.prepare(`SELECT id FROM items WHERE external_id = '62'`).get().id
    assert.deepEqual({ ...t.db.prepare('SELECT pillar, competitor_id, score FROM assessments WHERE item_id = ?').get(iid) }, { pillar: 'competitor', competitor_id: 1, score: null })
    assert.equal(t.db.prepare(`SELECT competitor_id FROM accounts WHERE handle = 'neutral_dev'`).get().competitor_id, null)
    assert.throws(() => t.run('post', 'draft', '--account', 'acme_dev', '--file', t.put('p.txt', 'Look.'), '--quote', String(iid)), /about a competitor/)
    assert.throws(() => t.run('post', 'revise', '1', '--file', t.put('r.txt', 'Look.'), '--quote', String(iid)), /about a competitor/)
    // the SQL triggers stay the last barrier
    assert.throws(() => t.db.prepare(`UPDATE posts SET kind = 'quote', quote_item_id = ? WHERE id = 1`).run(iid), /competitor/)
  } finally { t.done() }
})

test('item add: a reference account\'s post is stored with a warning and never feeds a post', async () => {
  const t = setup()
  try {
    const out = await addItem({ withDb: t.withDb, treg: fakeTreg({ id: '71', authorId: '900' }), url: 'https://x.com/Ref_Account/status/71', now: NOW })
    assert.match(out, /WARNING: its author is a reference account: this item can feed neither an idea nor a post/)
    const it = t.db.prepare(`SELECT id, author_id FROM items WHERE external_id = '71'`).get()
    assert.equal(it.author_id, 9, 'the known author (same numeric id), not a new account')
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE lower(handle) = 'ref_account'`).get().n, 1)
    assert.throws(() => t.run('post', 'revise', '1', '--file', t.put('r.txt', 'Look.'), '--quote', String(it.id)), /reference account/)
    assert.throws(() => t.db.prepare(`INSERT INTO post_items(post_id, item_id, relation) VALUES (1, ?, 'quotes')`).run(it.id), /reference account/)
  } finally { t.done() }
})

test('item add: invalid URLs are refused before any call; no treg, budget reached, treg failure and missing post are clear errors', async () => {
  const t = setup()
  try {
    const treg = fakeTreg()
    for (const bad of ['', 'not a url', 'https://example.com/a/status/1', 'https://x.com/someone', 'https://x.com/someone/status/abc', 'https://x.com/i/web/status/123', 'ftp://x.com/a/status/1', 'https://x.com/bad-handle!/status/1']) {
      await assert.rejects(addItem({ withDb: t.withDb, treg, url: bad, now: NOW }), ItemUsageError, bad)
    }
    assert.equal(treg.calls.length, 0)
    assert.deepEqual(parseStatusUrl('https://www.twitter.com/a_b/statuses/12?s=1'), { handle: 'a_b', id: '12', url: 'https://x.com/a_b/status/12' })

    await assert.rejects(addItem({ withDb: t.withDb, treg: null, url: URL1, now: NOW }), /no treg connector/)
    await assert.rejects(addItem({ withDb: t.withDb, treg: fakeTreg({}, { ok: false }), url: URL1, now: NOW }), /treg connector is unavailable.*not found/)

    // the daily budget of the watch is shared: a watch spend that reaches it blocks the call
    t.db.exec(`INSERT INTO settings(key, value) VALUES ('daily_budget_usd', '0.01')`)
    t.db.exec(`INSERT INTO ingest_runs(source, started_at, cost_usd) VALUES ('watch', '2026-01-07T08:00:00Z', 0.01)`)
    const capped = fakeTreg()
    await assert.rejects(addItem({ withDb: t.withDb, treg: capped, url: URL1, now: NOW }), /daily watch budget reached/)
    assert.equal(capped.calls.length, 0)
    t.db.exec(`UPDATE settings SET value = '1' WHERE key = 'daily_budget_usd'`)

    const err = Object.assign(new Error('treg refused the key (HTTP 401)'), { auth: true })
    await assert.rejects(addItem({ withDb: t.withDb, treg: fakeTreg({}, { fail: err }), url: URL1, now: NOW }), /could not be read through treg.*treg login/)
    await assert.rejects(addItem({ withDb: t.withDb, treg: fakeTreg({ id: '999' }), url: URL1, now: NOW }), /post not found on X/)
    assert.deepEqual(t.db.prepare(`SELECT status, cost_usd FROM ingest_runs WHERE source = 'manual' ORDER BY id`).all().map((r) => [r.status, r.cost_usd]), [['error', 0], ['error', 0.00075]])
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE external_id = '2113599736511152535'`).get().n, 0)

    // the CLI used directly has no connector
    assert.throws(() => t.run('item', 'add', URL1), /needs Growth Studio itself/)
  } finally { t.done() }
})

test('item add: the real answer of treg gives the author\'s handle, name, picture, language, thread and the charged cost', async () => {
  const t = setup()
  try {
    // treg reports its charge at the top of the answer (the connector finds none of its own)
    const treg = fakeTreg({ id: '2113599736511152535', authorHandle: 'Developpez', authorName: 'Developpez.com', authorId: '55410398',
      authorImage: 'https://pbs.twimg.com/profile_images/1/a_normal.jpeg', lang: 'fr', conversationId: '2113599736511152535', inReplyToId: null, media: [] }, { cost: 0, top: 0.00022 })
    const out = await addItem({ withDb: t.withDb, treg, url: 'https://x.com/developpez/status/2113599736511152535', now: NOW })
    assert.match(out, /post stored \(0\.00022 \$\): item #\d+ \(@Developpez, https:\/\/x\.com\/Developpez\/status\/2113599736511152535\)/)
    const a = t.db.prepare(`SELECT * FROM accounts WHERE external_id = '55410398'`).get()
    assert.deepEqual([a.handle, a.display_name, a.avatar_url, a.role], ['Developpez', 'Developpez.com', 'https://pbs.twimg.com/profile_images/1/a_normal.jpeg', 'brand'])
    const it = t.db.prepare(`SELECT * FROM items WHERE external_id = '2113599736511152535'`).get()
    assert.deepEqual([it.lang, it.conversation_id, it.kind, it.media], ['fr', '2113599736511152535', 'post', null])
    assert.equal(t.db.prepare(`SELECT cost_usd FROM ingest_runs WHERE source = 'manual'`).get().cost_usd, 0.00022)
    assert.deepEqual(['Developpez.com', 'Some Labs', 'Jane Doe', null].map(guessRole), ['brand', 'brand', 'personal', 'personal'])
  } finally { t.done() }
})

test('item add: the post is stored on a connection scoped to one user (shared tables written through main)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-item-scope-'))
  const file = path.join(dir, 'growth.db')
  try {
    const init = new DatabaseSync(file)
    init.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
    migrate(init)
    init.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
    init.exec(`UPDATE organizations SET owner_user_id = 'user-1'; UPDATE accounts SET owner_user_id = 'user-1' WHERE relation = 'owned'`)
    init.exec(`INSERT INTO competitors(id, slug, name) VALUES (1, 'rival', 'Rival'); INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalApp')`)
    init.close()
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      scopeDb(db, 'user-2')
      const ref = parseStatusUrl('https://x.com/new_author/status/81')
      const iid = storeItem(db, ref, { id: '81', authorId: '810', text: 'Leaving RivalApp.', likes: 1 }, { cost: 0.0002, now: NOW })
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM main.captures WHERE item_id = ? AND source = \'manual\'').get(iid).n, 1)
      assert.equal(db.prepare('SELECT competitor_id FROM main.assessments WHERE item_id = ?').get(iid).competitor_id, 1)
    } finally { db.close() }
    const check = new DatabaseSync(file)
    try {
      assert.deepEqual({ ...check.prepare(`SELECT relation, owner_user_id, role FROM accounts WHERE handle = 'new_author'`).get() }, { relation: 'watched', owner_user_id: null, role: 'personal' })
      assert.equal(check.prepare(`SELECT cost_usd FROM ingest_runs WHERE source = 'manual'`).get().cost_usd, 0.0002)
    } finally { check.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
