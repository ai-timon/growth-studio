// Sending of the validated prospecting replies (lib/replies.js), with a simulated treg connector: a validated reply
// goes out right away in reply to its post, its affiliation and the campaign's limits are checked again just before,
// a limit leaves it validated for later, a failure marks it failed without any new attempt.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { REPLY_COST_USD, dueReplies, replyGate, sendReply } from '../lib/replies.js'
import { apply, testing } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const V21 = readFileSync(path.join(root, 'test', 'fixtures', 'db-v21.sql'), 'utf8')
const NOW = '2026-10-26T09:00:00Z'
const now = () => new Date(NOW)

/**
 * v21 fixture migrated to v22: owned account 1 @acme_dev of user-a (publishing tool x.x.post.create, UTC), competitor 1
 * "RivalSoft", watched authors 11 (a person), 12 (a listed competitor developer), 14 (another person); active campaign
 * 1 of account 1; candidates 1 (item 101 of @tired_dev), 2 (item 103, critical of the competitor), 3 (item 108 of
 * @calm_dev), all drafted with an unaffiliated author.
 */
function seed(db) {
  db.exec(V21)
  db.exec(`UPDATE accounts SET owner_user_id = 'user-a' WHERE id = 1`)
  migrate(db)
  db.exec(`
    INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES
      ('account', 1, 'x_publish_target', 'x.x.post.create', '${NOW}'), ('account', 1, 'publish_tz', 'UTC', '${NOW}');
    INSERT INTO accounts(id, network, handle, display_name, relation) VALUES (11, 'x', 'tired_dev', 'Tired Dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation) VALUES (12, 'x', 'rival_dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation) VALUES (14, 'x', 'calm_dev', 'watched');
    INSERT INTO items(id, network, external_id, author_id, text, first_seen_at, extra) VALUES
      (101, 'x', '9101', 11, 'I lose an hour a day searching my notes', '${NOW}', '{"author_bio":"Backend dev, coffee"}'),
      (103, 'x', '9103', 11, 'Their search is slow and the support never answers', '${NOW}', NULL),
      (108, 'x', '9108', 14, 'Notes everywhere, nothing found', '${NOW}', NULL),
      (109, 'x', '9109', 11, 'Still lost in my notes', '${NOW}', NULL);
    INSERT INTO assessments(item_id, verdict, competitor_id, assessed_at) VALUES (103, 'keep', 1, '${NOW}');
    INSERT INTO competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (1, 'x', 'rival_dev', 'developer', 'bio', '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, created_at) VALUES (1, 1, 'user-a', 'Notes', 1, '${NOW}');
    INSERT INTO comment_pains(id, campaign_id, pain, solution, solution_source, created_at) VALUES (1, 1, 'Lost in my notes', 'Index the folder once', 'docs', '${NOW}');
    INSERT INTO comment_candidates(id, campaign_id, item_id, pain_id, score, status, competitor_stance, author_affiliation, created_at) VALUES
      (1, 1, 101, 1, 4, 'qualified', 'none', 'none', '${NOW}'),
      (2, 1, 103, 1, 4, 'qualified', 'critical', 'none', '${NOW}'),
      (3, 1, 108, 1, 4, 'qualified', 'none', 'none', '${NOW}'),
      (4, 1, 109, 1, 4, 'qualified', 'none', 'none', '${NOW}');
  `)
  db.exec('PRAGMA foreign_keys = ON')
}
/** A reply drafted for candidate `cid`, validated by the user (or not). */
function reply(db, cid, { body = 'Index the folder once, it helped me. I work on Acme, it does that for you.', validated = true, status = 'approved' } = {}) {
  const c = db.prepare('SELECT * FROM comment_candidates WHERE id = ?').get(cid)
  const id = Number(db.prepare(`INSERT INTO posts(account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at) VALUES (1, 'reply', 'reply', 'en', ?, ?, 'pending_validation', ?)`)
    .run(body, c.item_id, NOW).lastInsertRowid)
  db.prepare(`UPDATE comment_candidates SET status = 'drafted', post_id = ? WHERE id = ?`).run(id, cid)
  if (validated) db.prepare(`UPDATE posts SET status = ?, validated_at = ?, validated_by = 'Owner' WHERE id = ?`).run(status, NOW, id)
  return id
}
function setup() {
  const db = new DatabaseSync(':memory:')
  seed(db)
  return db
}
/** Simulated treg: records its calls, answers a new X post id. */
function fakeTreg({ fail = null, ok = true, costUsd = 0.016 } = {}) {
  const calls = []
  let n = 500
  return {
    calls,
    check: async () => (ok ? { ok: true } : { ok: false, hint: 'treg: not installed' }),
    call: async (tool, data, opts) => {
      calls.push({ tool, data, opts })
      if (fail) throw new Error(fail)
      return { json: { data: { id: String(++n), text: data.text } }, costUsd }
    },
  }
}
const post = (db, id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
const cand = (db, id) => db.prepare('SELECT * FROM comment_candidates WHERE id = ?').get(id)
const runs = (db) => db.prepare(`SELECT * FROM ingest_runs WHERE source = 'reply' ORDER BY id`).all()
/** A reply already sent by account 1 to item `itemId`, at `at`. */
function sent(db, itemId, at, cid = null) {
  const id = Number(db.prepare(`INSERT INTO posts(account_id, kind, lang, body, reply_to_item_id, status, validated_at, validated_by, published_at, external_id, created_at)
    VALUES (1, 'reply', 'en', 'An earlier reply', ?, 'published', ?, 'Owner', ?, 'x1', ?)`).run(itemId, at, at, at).lastInsertRowid)
  if (cid) db.prepare(`UPDATE comment_candidates SET status = 'replied', post_id = ? WHERE id = ?`).run(id, cid)
  return id
}

test('a validated reply goes out at once, in reply to its post, with its cost; its candidate is replied', async () => {
  const db = setup()
  try {
    const draft = reply(db, 1, { validated: false })
    assert.deepEqual(dueReplies(db, now()), [], 'nothing leaves without the user\'s validation')
    db.prepare(`UPDATE posts SET status = 'approved', validated_at = ?, validated_by = 'Owner' WHERE id = ?`).run(NOW, draft)
    assert.deepEqual(dueReplies(db, now()).map((r) => [r.id, r.owner]), [[draft, 'user-a']])

    const treg = fakeTreg()
    const r = await sendReply({ db, treg, postId: draft, now })
    assert.equal(r.state, 'sent', JSON.stringify(r))
    assert.equal(treg.calls.length, 1)
    assert.equal(treg.calls[0].tool, 'x.x.post.create')
    assert.deepEqual(treg.calls[0].data, { text: post(db, draft).body, reply: { in_reply_to_tweet_id: '9101' } })
    const p = post(db, draft)
    assert.deepEqual([p.status, p.external_id, p.url, p.published_at], ['published', '501', 'https://x.com/acme_dev/status/501', NOW])
    assert.deepEqual([cand(db, 1).status, cand(db, 1).post_id], ['replied', draft])
    assert.deepEqual(runs(db).map((x) => [x.account_id, x.cost_usd, x.status]), [[1, 0.016, 'ok']])
    assert.deepEqual(dueReplies(db, now()), [], 'sent once')
  } finally { db.close() }
})

test('without a cost from treg, the official price of a post is recorded', async () => {
  const db = setup()
  try {
    const id = reply(db, 1)
    assert.equal((await sendReply({ db, treg: fakeTreg({ costUsd: 0 }), postId: id, now })).state, 'sent')
    assert.equal(runs(db)[0].cost_usd, REPLY_COST_USD)
  } finally { db.close() }
})

test('a reply to a post about a competitor goes out only while its candidate criticizes it', async () => {
  const db = setup()
  try {
    const id = reply(db, 2)
    assert.equal(replyGate(db, id, now()).state, 'send')
    // the candidate is revised to neutral after the validation: the SQL guard refuses the status, the gate refuses first
    db.prepare(`UPDATE comment_candidates SET competitor_stance = 'neutral' WHERE id = 2`).run()
    const treg = fakeTreg()
    const r = await sendReply({ db, treg, postId: id, now })
    assert.equal(r.state, 'failed')
    assert.match(r.reason, /does not criticize|never replied/)
    assert.equal(treg.calls.length, 0)
    assert.equal(post(db, id).status, 'failed')
  } finally { db.close() }
})

test('affiliation checked again just before sending: competitor team, official account, alias, bio, doubt', async () => {
  const cases = [
    ['listed in the competitor team after the validation', (db) => db.exec(`INSERT INTO competitor_team(competitor_id, network, handle, role, added_at) VALUES (1, 'x', 'tired_dev', 'employee', '${NOW}')`), /competitor's team/],
    ['marked as the competitor\'s official account', (db) => db.exec(`UPDATE accounts SET competitor_id = 1 WHERE id = 11`), /competitor's team/],
    ['handle equal to a competitor alias', (db) => db.exec(`INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'tired_dev')`), /competitor's team/],
    ['bio naming a competitor', (db) => db.exec(`UPDATE items SET extra = '{"author_bio":"Engineer at RivalSoft"}' WHERE id = 101`), /profile .* names a competitor/],
    ['affiliation revised to unknown', (db) => db.exec(`UPDATE comment_candidates SET author_affiliation = 'unknown' WHERE id = 1`), /affiliation .* unknown/],
    ['candidate dismissed', (db) => db.exec(`UPDATE comment_candidates SET status = 'dismissed' WHERE id = 1`), /dismissed/],
  ]
  for (const [what, change, reason] of cases) {
    const db = setup()
    try {
      const id = reply(db, 1)
      change(db)
      const treg = fakeTreg()
      const r = await sendReply({ db, treg, postId: id, now })
      assert.equal(r.state, 'failed', what)
      assert.match(r.reason, reason, what)
      assert.equal(treg.calls.length, 0, `${what}: nothing sent`)
      assert.equal(post(db, id).status, 'failed', what)
      assert.match(post(db, id).validation_note, /Reply not sent/, what)
      assert.equal(cand(db, 1).status === 'replied', false, what)
    } finally { db.close() }
  }
})

test('a reply holding a URL is never sent', async () => {
  const db = setup()
  try {
    const id = reply(db, 1, { body: 'Have a look at acme.dev, it helps.' })
    const treg = fakeTreg()
    const r = await sendReply({ db, treg, postId: id, now })
    assert.deepEqual([r.state, treg.calls.length, post(db, id).status], ['failed', 0, 'failed'])
    assert.match(r.reason, /URL/)
  } finally { db.close() }
})

test('campaign limits: a reply waits, still validated, and goes at the next allowed moment', async () => {
  // daily limit (campaign value), in the account's time zone
  let db = setup()
  try {
    db.exec(`UPDATE comment_campaigns SET max_replies_per_day = 1, min_gap_min = 0 WHERE id = 1`)
    sent(db, 108, '2026-10-26T07:00:00Z', 3)
    const id = reply(db, 1)
    const treg = fakeTreg()
    const r = await sendReply({ db, treg, postId: id, now })
    assert.deepEqual([r.state, r.until], ['wait', '2026-10-27T00:00:00Z'])
    assert.match(r.reason, /daily limit .*1\/1/)
    assert.deepEqual([post(db, id).status, treg.calls.length], ['approved', 0])
    assert.equal((await sendReply({ db, treg, postId: id, now: () => new Date('2026-10-27T00:00:30Z') })).state, 'sent', 'the next day')
  } finally { db.close() }

  // gap between two replies of the account: the settings cascade when the campaign leaves it empty
  db = setup()
  try {
    sent(db, 108, '2026-10-26T08:50:00Z', 3)
    const id = reply(db, 1)
    let r = replyGate(db, id, now())
    assert.deepEqual([r.state, r.until], ['wait', '2026-10-26T09:05:00Z'], 'default: 15 min')
    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'comments_min_gap_min', '5', '${NOW}')`)
    assert.equal(replyGate(db, id, now()).state, 'send', 'account setting: 5 min')
    db.exec(`UPDATE comment_campaigns SET min_gap_min = 30 WHERE id = 1`)
    r = replyGate(db, id, now())
    assert.deepEqual([r.state, r.until], ['wait', '2026-10-26T09:20:00Z'], 'the campaign value wins')
  } finally { db.close() }

  // same author: no second reply before N days
  db = setup()
  try {
    db.exec(`UPDATE comment_campaigns SET min_gap_min = 0 WHERE id = 1`)
    sent(db, 101, '2026-10-20T09:00:00Z', 1)
    const id = reply(db, 4)
    const r = replyGate(db, id, now())
    assert.deepEqual([r.state, r.until], ['wait', '2026-11-19T09:00:00Z'])
    assert.match(r.reason, /@tired_dev less than 30 days/)
    db.exec(`UPDATE comment_campaigns SET same_author_days = 3 WHERE id = 1`)
    assert.equal(replyGate(db, id, now()).state, 'send')
  } finally { db.close() }

  // campaign switched off: waits
  db = setup()
  try {
    const id = reply(db, 1)
    db.exec(`UPDATE comment_campaigns SET active = 0 WHERE id = 1`)
    assert.equal(replyGate(db, id, now()).state, 'wait')
  } finally { db.close() }
})

test('a failure marks the reply failed with its cost, and it is never tried again', async () => {
  let db = setup()
  try {
    const id = reply(db, 1)
    const treg = fakeTreg({ fail: 'treg failed: 403 duplicate content' })
    const r = await sendReply({ db, treg, postId: id, now })
    assert.equal(r.state, 'failed')
    assert.match(r.reason, /refused by treg\/X: treg failed: 403/)
    assert.equal(post(db, id).status, 'failed')
    assert.equal(cand(db, 1).status, 'drafted')
    assert.deepEqual(runs(db).map((x) => x.status), ['error'])
    assert.deepEqual(dueReplies(db, now()), [], 'no new attempt')
  } finally { db.close() }

  db = setup()
  try {
    const id = reply(db, 1)
    const treg = fakeTreg({ ok: false })
    const r = await sendReply({ db, treg, postId: id, now })
    assert.deepEqual([r.state, treg.calls.length, post(db, id).status], ['failed', 0, 'failed'])
    db.exec(`DELETE FROM scoped_settings WHERE key = 'x_publish_target'`)
    const id2 = reply(db, 3)
    assert.match((await sendReply({ db, treg: fakeTreg(), postId: id2, now })).reason, /not connected for publishing/)
  } finally { db.close() }
})

// ---------- host half: the publishing tick sends the validated replies ----------
function hostCtx(storageDir, exec) {
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const reports = []; const alerts = []; const execs = []
  const ctx = {
    permissions: ['settings', 'storage', 'host:exec'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }),
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {} } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(storageDir, 'none.db') })[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => ({ id: 'user-a', name: 'Owner' }),
    realtime: { publish() {} },
    notify: { report: (t, b) => reports.push([t, b]), alert: (t, b, o) => alerts.push([t, b, o]) },
    host: { exec: async (bin, args) => { execs.push([bin, ...args]); return exec(bin, args) } },
  }
  const call = async (key, { body, params = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query: {}, url: '/' }, res)
    return { status, json }
  }
  return { ctx, call, reports, alerts, execs }
}

test('host: validating a reply sets no slot, the tick sends it through treg, a failure sends an urgent alert', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-replies-'))
  try {
    const storageDir = path.join(dir, 'data')
    let answer = () => ({ code: 0, stdout: JSON.stringify({ data: { id: '777' }, _treg: { charged_micro: 15000 } }), stderr: '' })
    const h = hostCtx(storageDir, (bin, args) => (args[0] === '--version' ? { code: 0, stdout: 'treg 1.0.0', stderr: '' } : answer(args)))
    mkdirSync(storageDir, { recursive: true })
    const db = new DatabaseSync(path.join(storageDir, 'growth.db'))
    seed(db)
    const id = reply(db, 1, { validated: false })
    db.close()
    apply(h.ctx)

    const ok = await h.call('POST /posts/:id/approve', { params: { id: String(id) }, body: {} })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.deepEqual([ok.json.scheduled, ok.json.reason, ok.json.post.status], [null, null, 'approved'], 'no editorial slot, no "missing image"')

    await testing.tick()
    const sendCall = h.execs.find((e) => e[1] === 'call')
    assert.ok(sendCall, 'treg called')
    assert.equal(sendCall[2], 'x.x.post.create')
    assert.deepEqual(JSON.parse(sendCall[sendCall.indexOf('--data') + 1]).reply, { in_reply_to_tweet_id: '9101' })
    let d = new DatabaseSync(path.join(storageDir, 'growth.db'))
    assert.deepEqual({ ...d.prepare('SELECT status, external_id FROM posts WHERE id = ?').get(id) }, { status: 'published', external_id: '777' })
    assert.equal(d.prepare(`SELECT cost_usd FROM ingest_runs WHERE source = 'reply'`).get().cost_usd, 0.015)
    assert.equal(d.prepare('SELECT status FROM comment_candidates WHERE id = 1').get().status, 'replied')
    assert.equal(h.reports.length, 1)
    // a second reply fails at X: failed, urgent alert, no new attempt at the next tick
    d.exec(`UPDATE comment_campaigns SET min_gap_min = 0 WHERE id = 1`)
    const id2 = reply(d, 3)
    d.close()
    answer = () => ({ code: 1, stdout: '', stderr: 'X refused: duplicate' })
    await testing.tick()
    await testing.tick()
    d = new DatabaseSync(path.join(storageDir, 'growth.db'))
    assert.equal(d.prepare('SELECT status FROM posts WHERE id = ?').get(id2).status, 'failed')
    d.close()
    assert.equal(h.alerts.length, 1)
    assert.match(h.alerts[0][0], /Reply #\d+: not sent/)
    assert.deepEqual(h.alerts[0][2], { urgent: true })
    assert.equal(h.execs.filter((e) => e[1] === 'call').length, 2, 'one attempt per reply')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
