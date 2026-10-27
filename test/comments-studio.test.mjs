// Studio side of the prospecting comments (lib/comments.js and its routes): the replies to validate, the user's click
// (Validate writes validated_by, Discard needs a reason and teaches the agent), the campaigns of an account with their
// pains, the competitors and their teams. Another user's reply or campaign answers 404; a reply never reaches the
// Posts queue; adding someone to a competitor's team stops a reply to them, even one already drafted.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { dayStart } from '../lib/comments.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const U1 = { id: 'user-1', name: 'Ada', is_superadmin: true }
const U2 = { id: 'user-2', name: 'Grace', is_superadmin: false }
const NOW = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Demo data of user-1 (managed account 1 @acme_dev) plus: watched authors 10 @tired_dev (840 followers) and
 * 11 @rival_dev, competitor 1 "RivalSoft", campaign 1 of account 1 with pain 1, candidates 1-3 and their replies
 * 101 (pending), 102 (pending, author @rival_dev, not listed yet), 103 (published today); user-2 owns account 20 and
 * its campaign 2, candidate 4 and reply 104.
 */
function studio(dir) {
  const storageDir = path.join(dir, 'plugins-data')
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  let user = U1
  const spawned = []
  const ctx = {
    permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {}, del: async () => {} } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: 'acme.writer' })[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => user,
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
    skills: { put: async () => {} },
    missions: { spawn: async (o) => { spawned.push(o); return `m${spawned.length}` } },
  }
  apply(ctx)
  const file = path.join(storageDir, 'growth.db')
  const db = new DatabaseSync(file)
  db.exec(DEMO)
  db.exec(`
    UPDATE organizations SET owner_user_id = 'user-1'; UPDATE accounts SET owner_user_id = 'user-1' WHERE relation = 'owned';
    INSERT INTO accounts(id, network, handle, relation, lang, owner_user_id) VALUES (20, 'x', 'other_dev', 'owned', 'en', 'user-2');
    INSERT INTO accounts(id, network, handle, display_name, relation, avatar_url) VALUES (10, 'x', 'tired_dev', 'Tired Dev', 'watched', 'https://example.test/a.png');
    INSERT INTO accounts(id, network, handle, relation) VALUES (11, 'x', 'rival_dev', 'watched');
    INSERT INTO account_metrics(account_id, captured_at, followers) VALUES (10, '${NOW}', 840);
    INSERT INTO competitors(id, slug, name) VALUES (1, 'rivalsoft', 'RivalSoft');
    INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalSoft');
    INSERT INTO items(id, network, external_id, author_id, text, first_seen_at, posted_at, url) VALUES
      (100, 'x', '100', 10, 'I lose an hour a day searching my notes', '${NOW}', '${NOW}', 'https://x.com/tired_dev/status/100'),
      (101, 'x', '101', 11, 'Searching notes is slow for me too', '${NOW}', '${NOW}', NULL),
      (102, 'x', '102', 10, 'Still lost in my notes', '${NOW}', '${NOW}', NULL),
      (103, 'x', '103', 10, 'Notes everywhere', '${NOW}', '${NOW}', NULL);
    INSERT INTO captures(item_id, source, captured_at) VALUES (100, 'search', '${NOW}'), (101, 'search', '${NOW}'), (102, 'search', '${NOW}'), (103, 'search', '${NOW}');
    INSERT INTO item_metrics(item_id, captured_at, likes, views, shares, replies) VALUES (100, '${NOW}', 12, 3400, 1, 4);
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, max_replies_per_day, created_at) VALUES (1, 1, 'user-1', 'Notes', 1, 5, '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, created_at) VALUES (2, 20, 'user-2', 'Other', '${NOW}');
    INSERT INTO comment_pains(id, campaign_id, pain, queries, solution, solution_source, created_at) VALUES
      (1, 1, 'Lost in my notes', '["notes search slow"]', 'Index the folder once', 'https://acme.example/docs', '${NOW}'),
      (2, 2, 'Other pain', '[]', 'Other way', 'docs', '${NOW}');
    INSERT INTO posts(id, account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at) VALUES
      (101, 1, 'reply', 'reply', 'en', 'Same here. One index of the folder fixed it; I work on Acme Tools.', 100, 'pending_validation', '${NOW}'),
      (102, 1, 'reply', 'reply', 'en', 'An index helps. I work on Acme Tools.', 101, 'pending_validation', '${NOW}'),
      (104, 20, 'reply', 'reply', 'en', 'Other reply.', 103, 'pending_validation', '${NOW}');
    INSERT INTO posts(id, account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at, validated_at, validated_by, published_at) VALUES
      (103, 1, 'reply', 'reply', 'en', 'Index it once.', 102, 'published', '${NOW}', '${NOW}', 'Ada', '${NOW}');
    INSERT INTO comment_candidates(id, campaign_id, item_id, pain_id, score, reason, author_affiliation, status, post_id, created_at) VALUES
      (1, 1, 100, 1, 4, 'Lives the pain', 'none', 'drafted', 101, '${NOW}'),
      (2, 1, 101, 1, 4, 'Lives the pain', 'none', 'drafted', 102, '${NOW}'),
      (3, 1, 102, 1, 3, 'Lives the pain', 'none', 'replied', 103, '${NOW}'),
      (4, 2, 103, 2, 4, 'Other', 'none', 'drafted', 104, '${NOW}');
  `)
  db.close()
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  const sql = (fn) => { const d = new DatabaseSync(file); try { return fn(d) } finally { d.close() } }
  return { call, sql, spawned, as: (u) => { user = u } }
}
const withStudio = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-comments-'))
  try { await fn(studio(dir)) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('the Comments view lists each user\'s replies per tab with the post they answer; replies stay out of the Posts queue', () => withStudio(async (s) => {
  const r = await s.call('GET /comments', { query: { tab: 'pending' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.replies.map((x) => x.id), [101, 102])
  const first = r.json.replies[0]
  assert.equal(first.author, 'tired_dev')
  assert.equal(first.followers, 840)
  assert.equal(first.views, 3400)
  assert.equal(first.pain, 'Lost in my notes')
  assert.equal(first.score, 4)
  assert.equal(first.item_url, 'https://x.com/tired_dev/status/100')
  assert.deepEqual(r.json.counts, { pending: 2, sent: 1, dismissed: 0 })
  assert.deepEqual(r.json.today.map((t) => [t.account, t.sent, t.cap]), [['acme_dev', 1, 5]])
  assert.deepEqual((await s.call('GET /comments', { query: { tab: 'sent' } })).json.replies.map((x) => x.id), [103])
  assert.equal((await s.call('GET /comments', { query: { tab: 'nope' } })).status, 400)

  const queue = (await s.call('GET /posts', { query: {} })).json.posts
  assert.ok(!queue.some((p) => p.kind === 'reply'), 'no reply in the Posts queue')
  const ov = (await s.call('GET /overview')).json
  assert.equal(ov.commentsPending, 2)
  assert.equal(ov.counts.published || 0, (queue.filter((p) => p.status === 'published')).length)

  s.as(U2)
  const other = (await s.call('GET /comments', { query: { tab: 'pending' } })).json
  assert.deepEqual(other.replies.map((x) => x.id), [104])
  assert.equal((await s.call('POST /comments/:id/approve', { params: { id: '101' } })).status, 404, 'another user\'s reply is not found')
  assert.equal((await s.call('GET /comments/campaigns', { query: { account: '1' } })).status, 404)
}))

test('Validate writes validated_by with the signed-in user; an edited text is kept, a URL is refused', () => withStudio(async (s) => {
  let r = await s.call('POST /comments/:id/approve', { params: { id: '101' }, body: { body: 'See https://acme.example for it' } })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /no URL/)
  assert.equal(s.sql((d) => d.prepare('SELECT status FROM posts WHERE id = 101').get().status), 'pending_validation', 'nothing changed')
  r = await s.call('POST /comments/:id/approve', { params: { id: '101' }, body: { body: 'Same here: one index of the folder fixed it. I work on Acme Tools.' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const p = s.sql((d) => d.prepare('SELECT status, validated_by, scheduled_for, body FROM posts WHERE id = 101').get())
  assert.deepEqual({ ...p }, { status: 'approved', validated_by: 'Ada', scheduled_for: null, body: 'Same here: one index of the folder fixed it. I work on Acme Tools.' })
  assert.equal(s.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM learnings WHERE post_id = 101 AND source = 'edit'`).get().n), 1, 'the edit teaches the agent')
  assert.equal((await s.call('POST /comments/:id/approve', { params: { id: '101' } })).status, 400, 'validated once')
  assert.equal((await s.call('POST /comments/:id/approve', { params: { id: '1' } })).status, 400, 'an ordinary post is validated from the Posts view')
  s.as(undefined)
  assert.equal((await s.call('POST /comments/:id/approve', { params: { id: '102' } })).status, 401)
}))

test('Discard needs a reason, dismisses the candidate and records the feedback on the reply', () => withStudio(async (s) => {
  assert.equal((await s.call('POST /comments/:id/dismiss', { params: { id: '101' }, body: { note: ' ' } })).status, 400)
  const r = await s.call('POST /comments/:id/dismiss', { params: { id: '101' }, body: { note: 'Too salesy' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  s.sql((d) => {
    assert.equal(d.prepare('SELECT status FROM posts WHERE id = 101').get().status, 'rejected')
    const c = d.prepare('SELECT status, dismiss_reason FROM comment_candidates WHERE id = 1').get()
    assert.equal(c.status, 'dismissed')
    assert.match(c.dismiss_reason, /Too salesy/)
    const l = d.prepare(`SELECT text, source, account_id, owner_user_id FROM learnings WHERE post_id = 101`).get()
    assert.deepEqual({ ...l }, { text: 'Comment rejected: Too salesy', source: 'reject', account_id: 1, owner_user_id: 'user-1' })
  })
  assert.deepEqual((await s.call('GET /comments', { query: { tab: 'dismissed' } })).json.replies.map((x) => x.id), [101])
  const learn = (await s.call('GET /learnings', { query: {} })).json.learnings.find((l) => l.post_id === 101)
  assert.equal(learn.post_kind, 'reply')
  assert.equal((await s.call('POST /comments/:id/dismiss', { params: { id: '103' }, body: { note: 'late' } })).status, 400, 'a sent reply stays sent')
}))

test('Rewrite starts a direct mission on the reply, like for a post', () => withStudio(async (s) => {
  const r = await s.call('POST /posts/:id/ask', { params: { id: '101' }, body: { kind: 'rewrite', text: 'shorter' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(s.spawned[0].mission, /post revise 101/)
  assert.ok((await s.call('GET /comments', { query: { tab: 'pending' } })).json.replies.find((x) => x.id === 101).rewrite_requested_at)
}))

test('adding the author to a competitor\'s team stops a drafted reply to them; candidates dismissed for affiliation are offered', () => withStudio(async (s) => {
  s.sql((d) => d.exec(`INSERT INTO accounts(id, network, handle, relation) VALUES (12, 'x', 'maybe_rival', 'watched');
    INSERT INTO items(id, network, external_id, author_id, text, first_seen_at) VALUES (104, 'x', '104', 12, 'We ship faster search', '${NOW}');
    INSERT INTO captures(item_id, source, captured_at) VALUES (104, 'search', '${NOW}');
    INSERT INTO comment_candidates(id, campaign_id, item_id, author_affiliation, status, dismiss_reason, created_at) VALUES (5, 1, 104, 'unknown', 'dismissed', 'bio says founder', '${NOW}')`))
  let c = (await s.call('GET /competitors')).json
  assert.deepEqual(c.competitors.map((x) => [x.name, x.aliases]), [['RivalSoft', ['RivalSoft']]])
  assert.deepEqual(c.affiliated.map((x) => x.handle), ['maybe_rival'])
  assert.ok(c.roles.includes('founder'))

  let r = await s.call('POST /competitors/:id/team', { params: { id: '1' }, body: { handle: '@rival_dev', role: 'developer' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  r = await s.call('POST /comments/:id/approve', { params: { id: '102' } })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /competitor's team/)
  assert.equal(s.sql((d) => d.prepare('SELECT status FROM posts WHERE id = 102').get().status), 'pending_validation')
  assert.equal((await s.call('POST /comments/:id/dismiss', { params: { id: '102' }, body: { note: 'Works at RivalSoft' } })).status, 200, 'discarding stays possible')

  r = await s.call('POST /competitors/:id/team', { params: { id: '1' }, body: { handle: 'maybe_rival', role: 'founder', source: 'candidate #5' } })
  assert.equal(r.status, 200)
  c = (await s.call('GET /competitors')).json
  assert.deepEqual(c.affiliated, [])
  assert.deepEqual(c.competitors[0].team.map((t) => [t.handle, t.role]), [['maybe_rival', 'founder'], ['rival_dev', 'developer']])
  assert.equal((await s.call('POST /competitors/:id/team', { params: { id: '1' }, body: { handle: 'not a handle' } })).status, 400)
  const n = (await s.call('POST /competitors', { body: { name: 'Other Corp', website: 'https://other.example' } })).json.id
  assert.equal((await s.call('POST /competitors/:id/team', { params: { id: String(n) }, body: { handle: 'rival_dev' } })).json.error, '@rival_dev is already in the team of RivalSoft')
  assert.equal((await s.call('POST /competitors/:id/team/remove', { params: { id: '1' }, body: { handle: 'maybe_rival' } })).status, 200)
  assert.equal((await s.call('POST /competitors/:id/aliases', { params: { id: String(n) }, body: { alias: 'rivalsoft' } })).status, 400, 'an alias belongs to one competitor')
  assert.equal((await s.call('POST /competitors/:id/team', { params: { id: '99' }, body: { handle: 'x1' } })).status, 404)
}))

test('campaigns of an account: create, edit limits and languages, pains with their verified solution', () => withStudio(async (s) => {
  let r = await s.call('POST /comments/campaigns', { body: { account_id: 1, name: 'Second' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const cid = r.json.id
  let v = (await s.call('GET /comments/campaigns', { query: { account: '1' } })).json
  const k = v.campaigns.find((x) => x.id === cid)
  assert.deepEqual([k.active, k.langs, k.same_author_days], [0, ['en'], 30], 'off by default, the account\'s language')
  r = await s.call('PUT /comments/campaigns/:id', { params: { id: String(cid) }, body: { active: true, langs: 'en, FR', max_replies_per_day: '4', min_gap_min: '', search_budget_usd: '0.5', active_hours: '8-20' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  for (const bad of [{ langs: 'english' }, { max_replies_per_day: -1 }, { active_hours: '8h' }, { name: '' }]) {
    assert.equal((await s.call('PUT /comments/campaigns/:id', { params: { id: String(cid) }, body: bad })).status, 400, JSON.stringify(bad))
  }
  r = await s.call('POST /comments/campaigns/:id/pains', { params: { id: String(cid) }, body: { pain: 'Slow builds', queries: 'build slow\nci takes forever', examples_positive: ['My build takes 20 minutes'] } })
  assert.equal(r.status, 400, 'an active pain needs its solution')
  assert.match(r.json.error, /solution/)
  r = await s.call('POST /comments/campaigns/:id/pains', { params: { id: String(cid) }, body: { pain: 'Slow builds', queries: 'build slow\nci takes forever', active: false } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const pid = r.json.id
  r = await s.call('PUT /comments/pains/:id', { params: { id: String(pid) }, body: { active: true } })
  assert.equal(r.status, 400)
  r = await s.call('PUT /comments/pains/:id', { params: { id: String(pid) }, body: { active: true, solution: 'Cache the deps', solution_source: 'https://acme.example/ci' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  v = (await s.call('GET /comments/campaigns', { query: { account: '1' } })).json
  const k2 = v.campaigns.find((x) => x.id === cid)
  assert.deepEqual([k2.active, k2.langs, k2.max_replies_per_day, k2.min_gap_min, k2.search_budget_usd, k2.active_hours], [1, ['en', 'fr'], 4, null, 0.5, '08-20'])
  assert.deepEqual(k2.pains[0].queries, ['build slow', 'ci takes forever'])
  assert.equal(k2.pains[0].active, 1)

  s.as(U2)
  assert.equal((await s.call('PUT /comments/campaigns/:id', { params: { id: String(cid) }, body: { active: false } })).status, 404)
  assert.equal((await s.call('PUT /comments/pains/:id', { params: { id: String(pid) }, body: { pain: 'x' } })).status, 404)
  assert.equal((await s.call('POST /comments/campaigns', { body: { account_id: 1 } })).status, 404)
}))

test('the day of the counter starts at midnight in the account\'s time zone', () => {
  assert.equal(dayStart('UTC', new Date('2026-10-26T15:30:00Z')), '2026-10-26T00:00:00Z')
  assert.equal(dayStart('Europe/Paris', new Date('2026-10-26T15:30:00Z')), '2026-10-25T23:00:00Z')
  assert.equal(dayStart('Not/AZone', new Date('2026-10-26T15:30:00Z')), '2026-10-26T00:00:00Z')
})
