// Prospecting comments (schema v22): campaigns, pains, competitor teams and candidates, and the absolute SQL guards on
// replies: never under a post of a competitor's team, under a post about a competitor only when it criticizes it and
// its author is not affiliated; a reply needs no visual. Each guard is checked on a refused and a permitted case.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { knownOwners, scopeDb } from '../lib/scope.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const V21 = readFileSync(path.join(root, 'test', 'fixtures', 'db-v21.sql'), 'utf8')
const NOW = '2026-10-26T09:00:00Z'
const TEAM = /competitor's team or by an unknown author/
const CRITICAL = /only when it criticizes it and its author is not affiliated/

/**
 * The v21 fixture (owned account 1 of user-a, competitor 1 "RivalSoft" with aliases RivalSoft and @rivalsoft) migrated
 * to v22, plus: owned account 10 of user-a, owned account 20 of user-b, watched authors (11 a person, 12 a competitor
 * developer, 13 the official competitor account, 14 the handle "rivalsoft" only known as an alias) and their items.
 */
function fixture(file = ':memory:') {
  const db = new DatabaseSync(file)
  db.exec(V21)
  db.exec(`UPDATE accounts SET owner_user_id = 'user-a' WHERE id = 1`)
  const r = migrate(db)
  assert.deepEqual(r.applied, [22])
  db.exec(`
    INSERT INTO accounts(id, network, handle, relation, lang, owner_user_id) VALUES (10, 'x', 'acme_brand', 'owned', 'fr', 'user-a');
    INSERT INTO accounts(id, network, handle, relation, lang, owner_user_id) VALUES (20, 'x', 'other_dev', 'owned', 'en', 'user-b');
    INSERT INTO accounts(id, network, handle, relation) VALUES (11, 'x', 'tired_dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation) VALUES (12, 'x', 'Rival_Dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation, competitor_id) VALUES (13, 'x', 'rival_official', 'watched', 1);
    INSERT INTO accounts(id, network, handle, relation) VALUES (14, 'x', 'RivalSoft', 'watched');
    INSERT INTO items(id, network, external_id, author_id, text, first_seen_at) VALUES
      (101, 'x', '101', 11, 'I lose an hour a day searching my notes', '${NOW}'),
      (102, 'x', '102', 12, 'Shipping our new search today', '${NOW}'),
      (103, 'x', '103', 13, 'Release notes', '${NOW}'),
      (104, 'x', '104', 14, 'Hello', '${NOW}'),
      (105, 'x', '105', 11, 'Their search is slow and the support never answers', '${NOW}'),
      (106, 'x', '106', NULL, 'Author unknown', '${NOW}');
    INSERT INTO assessments(item_id, verdict, competitor_id, assessed_at) VALUES (105, 'keep', 1, '${NOW}');
    INSERT INTO competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (1, 'x', 'rival_dev', 'developer', 'bio', '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, created_at) VALUES (1, 1, 'user-a', 'Notes', '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, created_at) VALUES (2, 20, 'user-b', 'Other', '${NOW}');
  `)
  return db
}
let nextId = 1000
/** Inserts a post; returns its id. */
function post(db, { account = 1, kind = 'reply', reply = null, quote = null, body = 'Indexing the folder once fixed it for me.', status = 'draft', media = null } = {}) {
  const id = ++nextId
  db.prepare(`INSERT INTO posts(id, account_id, kind, lang, body, reply_to_item_id, quote_item_id, status, media, created_at)
    VALUES (?, ?, ?, 'en', ?, ?, ?, ?, ?, ?)`).run(id, account, kind, body, reply, quote, status, media, NOW)
  return id
}
const candidate = (db, { campaign = 1, item = 105, stance = 'critical', affiliation = 'none', status = 'qualified' } = {}) =>
  Number(db.prepare(`INSERT INTO comment_candidates(campaign_id, item_id, score, competitor_stance, author_affiliation, status, created_at)
    VALUES (?, ?, 4, ?, ?, ?, ?)`).run(campaign, item, stance, affiliation, status, NOW).lastInsertRowid)
const schedule = (db, id) => db.prepare(`UPDATE posts SET status = 'scheduled', validated_at = ?, validated_by = 'user-a', scheduled_for = ? WHERE id = ?`).run(NOW, NOW, id)

test('v22 from a v21 database with data: new tables, defaults, existing rows and posts untouched', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(V21)
  const posts = db.prepare('SELECT * FROM posts ORDER BY id').all()
  assert.deepEqual(migrate(db), { from: 21, to: 22, applied: [22] })
  for (const t of ['comment_campaigns', 'comment_pains', 'competitor_team', 'comment_candidates']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t)
  }
  assert.deepEqual(db.prepare('SELECT * FROM posts ORDER BY id').all(), posts)
  // a regular post of the fixture still goes through the old guards: a visual is required
  db.exec(`UPDATE accounts SET owner_user_id = 'user-a' WHERE id = 1`)
  assert.throws(() => schedule(db, 1), /a visual is required/)
  db.exec(`UPDATE posts SET media = '[{"type":"image","path":"media/1.png"}]' WHERE id = 1`)
  schedule(db, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('campaigns: a managed account of their owner, languages of the account by default, inactive by default', () => {
  const db = fixture()
  const c = db.prepare('SELECT * FROM comment_campaigns WHERE id = 1').get()
  assert.deepEqual([c.active, c.langs, c.same_author_days, c.network], [0, '["en"]', 30, 'x'])
  db.exec(`INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, langs, created_at) VALUES (3, 10, 'user-a', 'Explicit', '["fr","en"]', '${NOW}')`)
  assert.equal(db.prepare('SELECT langs FROM comment_campaigns WHERE id = 3').get().langs, '["fr","en"]')
  const add = (account, owner) => () => db.prepare(`INSERT INTO comment_campaigns(account_id, owner_user_id, name, created_at) VALUES (?, ?, 'x', ?)`).run(account, owner, NOW)
  assert.throws(add(11, 'user-a'), /managed account of its owner/)   // watched account
  assert.throws(add(20, 'user-a'), /managed account of its owner/)   // another user's account
  assert.throws(add(999, 'user-a'), /managed account of its owner/)
  assert.throws(() => db.exec(`UPDATE comment_campaigns SET account_id = 20 WHERE id = 1`), /managed account of its owner/)
  assert.throws(() => db.exec(`UPDATE comment_campaigns SET langs = 'en' WHERE id = 1`), /CHECK constraint/)
  add(10, 'user-a')()
  db.close()
})

test('pains: queries are a JSON array, an active pain needs its verified solution and source', () => {
  const db = fixture()
  const add = (fields) => () => db.prepare(`INSERT INTO comment_pains(campaign_id, pain, queries, solution, solution_source, active, created_at)
    VALUES (1, 'Lost in my notes', ?, ?, ?, ?, ?)`).run(fields.queries ?? '["notes search"]', fields.solution ?? null, fields.source ?? null, fields.active ?? 1, NOW)
  assert.throws(add({ solution: 'Index it' }), /CHECK constraint/)
  assert.throws(add({ solution: ' ', source: 'https://acme.example' }), /CHECK constraint/)
  assert.throws(add({ queries: 'notes search', solution: 'Index it', source: 'https://acme.example' }), /CHECK constraint/)
  add({ active: 0 })()   // a pain being written, not used yet
  add({ solution: 'Index it', source: 'https://acme.example' })()
  db.close()
})

test('competitor team: handles without @, unique per network whatever the case', () => {
  const db = fixture()
  const add = (handle) => () => db.prepare(`INSERT INTO competitor_team(competitor_id, network, handle, added_at) VALUES (1, 'x', ?, ?)`).run(handle, NOW)
  assert.throws(add('@someone'), /CHECK constraint/)
  assert.throws(add('RIVAL_DEV'), /UNIQUE constraint/)
  add('rival_ceo')()
  assert.equal(db.prepare(`SELECT role FROM competitor_team WHERE handle = 'Rival_CEO'`).get().role, 'other')
  db.close()
})

test('ABSOLUTE: never a reply under a post of a competitor\'s team (listed member, official account, alias, unknown author)', () => {
  const db = fixture()
  for (const item of [102, 103, 104, 106]) {
    assert.throws(() => post(db, { reply: item }), TEAM, `item ${item}`)
    // not even with a candidate that claims the opposite
    db.prepare(`INSERT OR IGNORE INTO comment_candidates(campaign_id, item_id, competitor_stance, author_affiliation, status, created_at) VALUES (1, ?, 'critical', 'none', 'qualified', ?)`).run(item, NOW)
    assert.throws(() => post(db, { reply: item }), TEAM, `item ${item} with a candidate`)
    if (item !== 106) assert.throws(() => post(db, { kind: 'quote', quote: item }), TEAM, `quote of item ${item}`)
  }
  // permitted: a person with no affiliation
  const ok = post(db, { reply: 101 })
  // an update cannot retarget it at a member
  assert.throws(() => db.exec(`UPDATE posts SET reply_to_item_id = 102 WHERE id = ${ok}`), TEAM)
  // an author added to a team after the draft: the reply can no longer be scheduled
  const late = post(db, { reply: 101 })
  db.exec(`INSERT INTO competitor_team(competitor_id, network, handle, role, added_at) VALUES (1, 'x', 'TIRED_DEV', 'employee', '${NOW}')`)
  assert.throws(() => schedule(db, ok), TEAM)
  // but it can still be rejected (or marked failed)
  db.exec(`UPDATE posts SET status = 'rejected' WHERE id = ${late}`)
  db.exec(`UPDATE posts SET status = 'failed' WHERE id = ${late}`)
  db.exec(`DELETE FROM competitor_team WHERE handle = 'tired_dev'`)
  schedule(db, ok)
  db.close()
})

test('ABSOLUTE: a reply about a competitor only under a critical post of an unaffiliated author, for that account', () => {
  const db = fixture()
  // no candidate
  assert.throws(() => post(db, { reply: 105 }), CRITICAL)
  // candidate not critical, or author affiliation not cleared
  const c = candidate(db, { stance: 'neutral' })
  assert.throws(() => post(db, { reply: 105 }), CRITICAL)
  db.exec(`UPDATE comment_candidates SET competitor_stance = 'praise' WHERE id = ${c}`)
  assert.throws(() => post(db, { reply: 105 }), CRITICAL)
  db.exec(`UPDATE comment_candidates SET competitor_stance = 'critical', author_affiliation = 'unknown' WHERE id = ${c}`)
  assert.throws(() => post(db, { reply: 105 }), CRITICAL)
  db.exec(`UPDATE comment_candidates SET author_affiliation = 'competitor' WHERE id = ${c}`)
  assert.throws(() => post(db, { reply: 105 }), CRITICAL)
  // critical and unaffiliated, but the candidate belongs to another account's campaign
  db.exec(`UPDATE comment_candidates SET author_affiliation = 'none' WHERE id = ${c}`)
  assert.throws(() => post(db, { account: 10, reply: 105 }), CRITICAL)
  // a kind other than a reply keeps the old refusal
  assert.throws(() => post(db, { kind: 'post', reply: 105 }), /competitor named or targeted|criticizes/)
  // permitted
  const ok = post(db, { reply: 105 })
  // the text still never names the competitor
  assert.throws(() => post(db, { reply: 105, body: 'Unlike RivalSoft, it is fast.' }), /competitor named or targeted/)
  assert.throws(() => db.exec(`UPDATE posts SET body = 'Try it instead of @rivalsoft' WHERE id = ${ok}`), /competitor named or targeted/)
  // turned into a post, it is refused again
  assert.throws(() => db.exec(`UPDATE posts SET kind = 'post' WHERE id = ${ok}`), CRITICAL)
  // the candidate is dismissed (or revised) after the draft: the reply can no longer be scheduled
  const late = post(db, { reply: 105 })
  db.exec(`UPDATE comment_candidates SET status = 'dismissed' WHERE id = ${c}`)
  assert.throws(() => schedule(db, ok), CRITICAL)
  // but it can still be rejected
  db.exec(`UPDATE posts SET status = 'rejected' WHERE id = ${late}`)
  db.exec(`UPDATE comment_candidates SET status = 'drafted', post_id = ${ok} WHERE id = ${c}`)
  schedule(db, ok)
  db.close()
})

test('a reply needs no visual; other posts still do', () => {
  const db = fixture()
  const reply = post(db, { reply: 101 })
  schedule(db, reply)
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(reply).status, 'scheduled')
  const plain = post(db, { kind: 'post' })
  assert.throws(() => schedule(db, plain), /a visual is required/)
  // a 'reply' without a target is a plain post: it still needs a visual
  const orphan = post(db, { kind: 'reply' })
  assert.throws(() => schedule(db, orphan), /a visual is required/)
  // and the validation guard still applies to replies
  const unvalidated = post(db, { reply: 101 })
  assert.throws(() => db.exec(`UPDATE posts SET status = 'scheduled' WHERE id = ${unvalidated}`), /validation required/)
  db.close()
})

test('scoping: a user only sees and changes the campaigns, pains and candidates of their own accounts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-comments-'))
  try {
    const file = path.join(dir, 'growth.db')
    const base = fixture(file)
    base.exec(`INSERT INTO comment_pains(id, campaign_id, pain, active, created_at) VALUES (1, 1, 'A pain', 0, '${NOW}'), (2, 2, 'B pain', 0, '${NOW}')`)
    candidate(base, { campaign: 1, item: 101, stance: 'none' })
    candidate(base, { campaign: 2, item: 101, stance: 'none' })
    assert.ok(knownOwners(base).includes('user-b'))
    base.close()

    const b = scopeDb(new DatabaseSync(file), 'user-b')
    try {
      assert.deepEqual(b.prepare('SELECT id FROM comment_campaigns').all().map((r) => r.id), [2])
      assert.deepEqual(b.prepare('SELECT id FROM comment_pains').all().map((r) => r.id), [2])
      assert.deepEqual(b.prepare('SELECT campaign_id FROM comment_candidates').all().map((r) => r.campaign_id), [2])
      assert.equal(b.prepare('SELECT COUNT(*) AS n FROM competitor_team').get().n, 1, 'competitor teams are shared')
      // writes on another user's rows answer like missing rows
      assert.throws(() => b.prepare(`INSERT INTO main.comment_campaigns(account_id, owner_user_id, name, created_at) VALUES (1, 'user-b', 'x', ?)`).run(NOW), /not found|managed account/)
      assert.throws(() => b.prepare(`INSERT INTO main.comment_campaigns(account_id, owner_user_id, name, created_at) VALUES (1, 'user-a', 'x', ?)`).run(NOW), /campaign not found/)
      assert.throws(() => b.exec(`UPDATE main.comment_campaigns SET active = 1 WHERE id = 1`), /campaign not found/)
      assert.throws(() => b.prepare(`INSERT INTO main.comment_pains(campaign_id, pain, active, created_at) VALUES (1, 'x', 0, ?)`).run(NOW), /campaign not found/)
      assert.throws(() => b.prepare(`INSERT INTO main.comment_candidates(campaign_id, item_id, created_at) VALUES (1, 102, ?)`).run(NOW), /candidate not found/)
      assert.throws(() => b.exec(`DELETE FROM main.comment_candidates WHERE campaign_id = 1`), /candidate not found/)
      // their own
      b.exec(`UPDATE main.comment_campaigns SET active = 1 WHERE id = 2`)
      b.prepare(`INSERT INTO main.comment_pains(campaign_id, pain, active, created_at) VALUES (2, 'Mine', 0, ?)`).run(NOW)
      b.prepare(`INSERT INTO main.comment_candidates(campaign_id, item_id, created_at) VALUES (2, 102, ?)`).run(NOW)
      const id = Number(b.prepare(`INSERT INTO main.comment_campaigns(account_id, owner_user_id, name, created_at) VALUES (20, 'user-b', 'Second', ?)`).run(NOW).lastInsertRowid)
      assert.equal(b.prepare('SELECT langs FROM comment_campaigns WHERE id = ?').get(id).langs, '["en"]')
    } finally { b.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
