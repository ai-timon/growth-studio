// Prospecting comments job (lib/jobs/comments.js): search of the campaigns' queries through a simulated treg, the
// pre-filter without model, the affiliation check before any qualification, budgets, one qualification mission at a
// time, and the job's switch in the host. No test reaches a real endpoint: the fake treg fails on any tool it does
// not know.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { pollComments, normalizeProfile, PROFILE_TOOL, SEARCH_TOOL } from '../lib/jobs/comments.js'
import { commentsBrief } from '../lib/briefs.js'
import { apply, testing } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const NOW = new Date('2026-10-26T10:00:00Z')
const at = (iso) => new Date(iso)
const ago = (h, now = NOW) => Math.floor(now.getTime() / 1000 - h * 3600)

/** Demo database + owner, a competitor (RivalSoft, aliases RivalSoft / @rivalsoft, developer @rival_dev), a reference
 *  account, and campaign 1 of @acme_dev (en) with one pain and two queries. */
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA); migrate(db); db.exec(DEMO)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    UPDATE accounts SET owner_user_id = 'user-a' WHERE id = 1;
    UPDATE organizations SET owner_user_id = 'user-a';
    INSERT INTO competitors(id, slug, name) VALUES (1, 'rivalsoft', 'RivalSoft');
    INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalSoft'), (1, '@rivalsoft');
    INSERT INTO competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (1, 'x', 'rival_dev', 'developer', 'manual', '2026-10-01T00:00:00Z');
    INSERT INTO accounts(id, network, handle, relation, watch_role) VALUES (30, 'x', 'ref_person', 'watched', 'reference');
    INSERT INTO accounts(id, network, handle, relation) VALUES (31, 'x', 'met_before', 'watched');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, langs, max_author_followers, created_at)
      VALUES (1, 1, 'user-a', 'Notes', 1, '["en"]', 5000, '2026-10-01T00:00:00Z');
    INSERT INTO comment_pains(id, campaign_id, pain, queries, solution, solution_source, created_at)
      VALUES (1, 1, 'Cannot find anything in my notes', '["notes search slow", "lost my notes"]', 'Index the folder once', 'docs', '2026-10-01T00:00:00Z');
    INSERT INTO settings(key, value) VALUES ('comments_window_start', '00:00'), ('comments_window_end', '00:00');
  `)
  // @met_before already is a candidate of the account (5 days ago): within the 30 days of the campaign
  db.exec(`INSERT INTO items(id, network, external_id, author_id, text, posted_at, first_seen_at) VALUES (50, 'x', '50', 31, 'old', '2026-10-21T09:00:00Z', '2026-10-21T09:00:00Z');
    INSERT INTO comment_candidates(campaign_id, item_id, author_affiliation, status, created_at) VALUES (1, 50, 'none', 'qualified', '2026-10-21T09:00:00Z')`)
  return db
}

const xp = (id, handle, extra = {}) => ({ id, authorUsername: handle, authorName: handle, text: `post ${id} by ${handle}`, lang: 'en', createdUtc: ago(1), conversationId: id, isReply: false, likeCount: 2, viewCount: 30, ...extra })

/** treg simulated: `search[q]` = posts, `profiles[handle]` = profile data, Error or missing (throws). */
function fakeTreg({ search = {}, profiles = {}, searchCost = 0.00075, profileCost = 0.0002 } = {}) {
  const calls = []
  return {
    calls,
    async call(tool, data) {
      calls.push([tool, data.q || data.username])
      if (tool === SEARCH_TOOL) return { json: { output: { posts: search[data.q] || [] } }, costUsd: searchCost }
      if (tool === PROFILE_TOOL) {
        const p = profiles[data.username]
        if (!p || p instanceof Error) throw p || new Error('treg failed: not found')
        return { json: { output: { found: true, data: p } }, costUsd: profileCost }
      }
      throw new Error(`unexpected treg tool: ${tool}`)
    },
  }
}
const candidates = (db) => db.prepare(`SELECT i.external_id AS post, a.handle, c.status, c.author_affiliation AS aff, c.dismiss_reason AS why, c.pain_id
  FROM comment_candidates c JOIN items i ON i.id = c.item_id JOIN accounts a ON a.id = i.author_id WHERE c.item_id <> 50 ORDER BY i.external_id`).all().map((r) => ({ ...r }))

test('comments job: pre-filter without model, affiliation before qualification, then one qualification mission', async () => {
  const db = setup()
  try {
    const treg = fakeTreg({
      search: {
        'notes search slow': [
          xp('2001', 'tired_dev'),
          xp('2002', 'someone', { text: 'RT @tired_dev: post' }),
          xp('2003', 'late_one', { createdUtc: ago(72) }),
          xp('2004', 'french_one', { lang: 'fr' }),
          xp('2005', 'Rival_Dev'),
          xp('2006', 'bio_rival'),
          xp('2007', 'ghost'),
        ],
        'lost my notes': [
          xp('2001', 'tired_dev'),
          xp('2008', 'big_star'),
          xp('2009', 'acme_dev'),
          xp('2010', 'ref_person'),
          xp('2011', 'met_before'),
          xp('2012', 'no_date', { createdUtc: null }),
        ],
      },
      profiles: {
        tired_dev: { handle: 'tired_dev', displayName: 'Tired Dev', bio: 'Backend dev, coffee', followers: 320, following: 200, avatarUrl: 'https://pbs.example/a_normal.jpg' },
        bio_rival: { handle: 'bio_rival', displayName: 'Sam', bio: 'Engineer @RivalSoft, opinions mine', followers: 900 },
        big_star: { handle: 'big_star', displayName: 'Big Star', bio: 'Tech news', followers: 1_000_000 },
      },
    })
    const spawned = []
    const deps = { db, treg, notify: { alert() {} }, spawnQualify: async (o) => { spawned.push(o); return `q-${spawned.length}` } }
    const r = await pollComments({ ...deps, now: NOW })
    assert.equal(r.state, 'ok', r.message)

    assert.deepEqual(candidates(db), [
      { post: '2001', handle: 'tired_dev', status: 'new', aff: 'none', why: null, pain_id: 1 },
      { post: '2005', handle: 'Rival_Dev', status: 'dismissed', aff: 'competitor', why: 'author affiliated with a competitor: @Rival_Dev is in the team of RivalSoft (developer)', pain_id: 1 },
      { post: '2006', handle: 'bio_rival', status: 'dismissed', aff: 'competitor', why: 'author affiliated with a competitor: its bio names RivalSoft ("@rivalsoft")', pain_id: 1 },
      { post: '2007', handle: 'ghost', status: 'dismissed', aff: 'unknown', why: 'author affiliation unknown: profile unavailable', pain_id: 1 },
      { post: '2008', handle: 'big_star', status: 'dismissed', aff: 'none', why: 'author over the follower ceiling (1000000 > 5000)', pain_id: 1 },
    ])
    // the team member is set aside from its handle alone: no profile is paid for it
    assert.deepEqual(treg.calls.filter((c) => c[0] === PROFILE_TOOL).map((c) => c[1]).sort(), ['big_star', 'bio_rival', 'ghost', 'tired_dev'])
    assert.equal(treg.calls.filter((c) => c[0] === SEARCH_TOOL).length, 2)
    assert.ok(!treg.calls.some((c) => /^x\.x\./.test(c[0])), 'never an x.x.* endpoint to read')

    // the item, its author (watched, not polled), its bio, its capture and the cost of the pass
    const item = db.prepare(`SELECT i.*, a.relation, a.watch_priority, a.avatar_url FROM items i JOIN accounts a ON a.id = i.author_id WHERE i.external_id = '2001'`).get()
    assert.equal(item.url, 'https://x.com/tired_dev/status/2001')
    assert.deepEqual([item.relation, item.watch_priority, item.avatar_url], ['watched', null, 'https://pbs.example/a_200x200.jpg'])
    assert.equal(JSON.parse(item.extra).author.bio, 'Backend dev, coffee')
    const cap = db.prepare(`SELECT source, account_id, query, run_id FROM captures WHERE item_id = ?`).get(item.id)
    assert.deepEqual({ ...cap, run_id: typeof cap.run_id }, { source: 'search', account_id: 1, query: 'notes search slow', run_id: 'number' })
    const run = db.prepare(`SELECT * FROM ingest_runs WHERE source = 'search'`).get()
    assert.deepEqual([run.account_id, run.pages, run.items_new, run.status], [1, 2, 5, 'ok'])
    assert.equal(run.cost_usd, Math.round((2 * 0.00075 + 3 * 0.0002) * 1e6) / 1e6, 'two searches and three paid profiles (the failed one is not billed here)')
    assert.equal(db.prepare(`SELECT followers FROM account_metrics WHERE account_id = ?`).get(item.author_id).followers, 320)

    // one mission for the account, with only the candidates left to qualify
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].account.handle, 'acme_dev')
    assert.equal(spawned[0].account.owner_user_id, 'user-a')
    assert.equal(spawned[0].count, 1)
    assert.deepEqual(spawned[0].campaigns, ['Notes'])
    assert.match(r.message, /qualification of 1 candidate\(s\) of @acme_dev started \(q-1\)/)
    const brief = commentsBrief(spawned[0].account, spawned[0].count, 'Qualify strictly.')
    assert.match(brief, /comments candidates list --account acme_dev/)
    assert.match(brief, /comments qualify-commit/)
    assert.doesNotMatch(brief, /RivalSoft/)
  } finally { db.close() }
})

test('comments job: interval, window, budgets, cached profiles, expiry and the daily cap of missions', async () => {
  const db = setup()
  try {
    const search = { 'notes search slow': [xp('3001', 'big_star')], 'lost my notes': [] }
    const treg = fakeTreg({ search, profiles: { big_star: { handle: 'big_star', bio: 'Tech news', followers: 1_000_000 }, pal: { handle: 'pal', bio: 'dev', followers: 10 }, pal2: { handle: 'pal2', bio: 'dev', followers: 10 } } })
    const spawned = []
    const deps = { db, treg, notify: { alert() {} }, spawnQualify: async (o) => { spawned.push(o); return `q-${spawned.length}` } }

    db.exec(`UPDATE settings SET value = '09:00' WHERE key = 'comments_window_start'; UPDATE settings SET value = '09:30' WHERE key = 'comments_window_end'`)
    let r = await pollComments({ ...deps, now: NOW })
    assert.equal(r.state, 'outside')
    db.exec(`UPDATE settings SET value = '00:00' WHERE key IN ('comments_window_start', 'comments_window_end')`)
    db.exec(`INSERT INTO settings(key, value) VALUES ('comments_poll_interval_min', '0')`)
    assert.equal((await pollComments({ ...deps, now: NOW })).state, 'stopped')
    db.exec(`UPDATE settings SET value = '60' WHERE key = 'comments_poll_interval_min'`)

    r = await pollComments({ ...deps, now: NOW })
    assert.equal(treg.calls.length, 3, r.message)
    r = await pollComments({ ...deps, now: at('2026-10-26T10:30:00Z') })
    assert.equal(r.state, 'not-due')
    assert.equal(treg.calls.length, 3)

    // campaign active hours, in its account's time zone
    db.exec(`UPDATE comment_campaigns SET active_hours = '20-22'`)
    await pollComments({ ...deps, now: at('2026-10-26T11:30:00Z') })
    assert.equal(treg.calls.length, 3, 'outside the campaign hours')
    db.exec(`UPDATE comment_campaigns SET active_hours = NULL`)

    // the profile of an author seen less than a week ago is not paid again
    search['notes search slow'] = [xp('3002', 'big_star', { createdUtc: ago(1, at('2026-10-26T11:30:00Z')) })]
    await pollComments({ ...deps, now: at('2026-10-26T11:30:00Z') })
    assert.equal(treg.calls.filter((c) => c[0] === PROFILE_TOOL).length, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM comment_candidates WHERE dismiss_reason LIKE 'author over the follower ceiling%'`).get().n, 2)

    // the campaign's own budget: after one search, nothing else today
    db.exec(`UPDATE comment_campaigns SET search_budget_usd = 0.0035`)
    search['notes search slow'] = []
    let before = treg.calls.length
    r = await pollComments({ ...deps, now: at('2026-10-26T13:00:00Z') })
    assert.equal(treg.calls.length - before, 1, r.message)
    r = await pollComments({ ...deps, now: at('2026-10-26T15:00:00Z') })
    assert.match(r.message, /daily budget reached/)
    // the next day it searches again; the ceiling of all campaigns stops it too
    db.exec(`UPDATE comment_campaigns SET search_budget_usd = NULL; INSERT INTO settings(key, value) VALUES ('comments_daily_budget_usd', '0.0001')`)
    before = treg.calls.length
    r = await pollComments({ ...deps, now: at('2026-10-27T10:00:00Z') })
    assert.equal(treg.calls.length - before, 1)
    r = await pollComments({ ...deps, now: at('2026-10-27T12:00:00Z') })
    assert.equal(treg.calls.length - before, 1)
    assert.match(r.message, /daily budget of the comments search reached/)
    db.exec(`UPDATE settings SET value = '5' WHERE key = 'comments_daily_budget_usd'`)

    // one qualification at a time, a failed start does not count, at most N a day
    db.exec(`INSERT INTO settings(key, value) VALUES ('comments_max_missions_per_day', '2')`)
    const T = at('2026-10-28T10:00:00Z')
    search['notes search slow'] = [xp('3010', 'pal', { createdUtc: ago(1, T) })]
    const failing = { ...deps, spawnQualify: async () => { throw new Error('No agent configured') } }
    r = await pollComments({ ...failing, now: T })
    assert.equal(r.state, 'error')
    assert.match(r.message, /not started: No agent configured/)
    r = await pollComments({ ...deps, now: at('2026-10-28T10:10:00Z'), force: true })
    assert.match(r.message, /qualification already started/)
    assert.equal(spawned.length, 0)
    r = await pollComments({ ...deps, now: at('2026-10-28T10:31:00Z') })
    assert.equal(spawned.length, 1, r.message)
    // the batch got its verdicts: the next one starts at once
    db.exec(`UPDATE comment_candidates SET status = 'dismissed' WHERE status = 'new'`)
    search['notes search slow'] = [xp('3011', 'pal2', { createdUtc: ago(1, at('2026-10-28T11:40:00Z')) })]
    r = await pollComments({ ...deps, now: at('2026-10-28T11:40:00Z') })
    assert.equal(spawned.length, 2, r.message)
    db.exec(`UPDATE comment_candidates SET status = 'dismissed' WHERE status = 'new'`)
    search['notes search slow'] = [xp('3012', 'pal3', { createdUtc: ago(1, at('2026-10-28T12:50:00Z')) })]
    treg.calls.length = 0
    const profiles = fakeTreg({ search, profiles: { pal3: { handle: 'pal3', bio: 'dev', followers: 10 } } })
    r = await pollComments({ ...deps, treg: profiles, now: at('2026-10-28T12:50:00Z') })
    assert.equal(spawned.length, 2)
    assert.match(r.message, /cap of 2 qualification missions a day reached: 1 candidate\(s\) waiting/)

    // a candidate still waiting when its post is older than 48 h is set aside
    db.exec(`UPDATE comment_campaigns SET active = 0`)
    r = await pollComments({ ...deps, now: at('2026-10-31T12:00:00Z') })
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM comment_candidates WHERE status = 'new'`).get().n, 0)
    assert.equal(db.prepare(`SELECT dismiss_reason FROM comment_candidates WHERE item_id = (SELECT id FROM items WHERE external_id = '3012')`).get().dismiss_reason, 'expired before qualification')
    assert.equal(r.state, 'idle')
  } finally { db.close() }
})

test('comments job: treg 401 stops every campaign and alerts once until the next successful call', async () => {
  const db = setup()
  try {
    db.exec(`INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, created_at) VALUES (2, 1, 'user-a', 'Second', 1, '2026-10-01T00:00:00Z');
      INSERT INTO comment_pains(campaign_id, pain, queries, solution, solution_source, created_at) VALUES (2, 'p', '["q2"]', 's', 'src', '2026-10-01T00:00:00Z')`)
    let n = 0
    const alerts = []
    const refused = { call: async () => { n++; throw Object.assign(new Error('treg failed: 401'), { auth: true }) } }
    const deps = { db, notify: { alert: (t) => alerts.push(t) }, spawnQualify: async () => 'q' }
    let r = await pollComments({ ...deps, treg: refused, now: NOW })
    assert.equal(n, 1, 'no other query nor campaign is tried')
    assert.equal(r.state, 'error')
    assert.match(r.message, /401/)
    await pollComments({ ...deps, treg: refused, now: NOW, force: true })
    assert.equal(alerts.length, 1)
    await pollComments({ ...deps, treg: fakeTreg(), now: at('2026-10-26T12:00:00Z') })
    await pollComments({ ...deps, treg: refused, now: at('2026-10-26T14:00:00Z') })
    assert.equal(alerts.length, 2, 'alerts again after a successful call')
  } finally { db.close() }
})

test('comments job: profile answers of several shapes; not found is no profile', () => {
  assert.equal(normalizeProfile({ output: { found: false } }), null)
  assert.equal(normalizeProfile({ output: {} }), null)
  assert.deepEqual(normalizeProfile({ output: { data: { username: 'a', description: 'bio', followers_count: 3 } } }),
    { name: null, bio: 'bio', website: '', followers: 3, following: null, verified: false, avatar: null })
})

test('host: the comments job is off by default, shows in the status and runs on demand once switched on', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-comments-'))
  try {
    const settings = {}
    const routes = {}
    const add = (m) => (r, h) => { routes[`${m} ${r}`] = h }
    const execs = []
    const ctx = {
      permissions: ['settings', 'storage', 'host:exec', 'notify'],
      settings: { get: (k) => Object.assign(settings, { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db') })[k] },
      secrets: { get: async () => undefined },
      host: { exec: async (bin, args) => { execs.push([bin, ...args]); if (args[0] === '--version') return { code: 0, stdout: 'treg 1', stderr: '' }; return { code: 0, stdout: JSON.stringify({ output: { posts: [] }, _treg: { charged_micro: 750 } }), stderr: '' } } },
      fetch: async (u) => { throw new Error(`unexpected network call: ${u}`) },
      storage: { dir: path.join(dir, 'data'), kv: { get: async () => undefined, set: async () => {} } },
      notify: { report() {}, alert() {} }, log: { info() {}, warn() {}, error() {} },
      router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }), effect() {}, user: () => ({ id: 'u1', is_superadmin: true }), realtime: { publish() {} },
    }
    const call = async (key, { body, params = {} } = {}) => {
      let status = 200; let json
      const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
      await routes[key]({ body, params, query: {}, url: '/' }, res)
      return { status, json }
    }
    apply(ctx)
    const db = new DatabaseSync(path.join(dir, 'data', 'growth.db'))
    db.exec(DEMO)
    db.exec(`UPDATE accounts SET owner_user_id = 'u1' WHERE id = 1;
      INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, created_at) VALUES (1, 1, 'u1', 'Notes', 1, '2026-10-01T00:00:00Z');
      INSERT INTO comment_pains(campaign_id, pain, queries, solution, solution_source, created_at) VALUES (1, 'p', '["notes search slow"]', 's', 'src', '2026-10-01T00:00:00Z')`)
    db.close()
    await testing.runJob('comments')
    assert.equal(execs.length, 0, 'switched off: nothing searched')
    let r = await call('POST /admin/jobs/:job/run', { params: { job: 'comments' } })
    assert.equal(r.status, 409)
    let st = await call('GET /connectors')
    assert.deepEqual({ ...st.json.jobs.comments, last: null }, { label: 'search for prospecting comments', setting: 'commentsJob', enabled: false, running: false, last: null })
    settings.commentsJob = true
    r = await call('POST /admin/jobs/:job/run', { params: { job: 'comments' } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.forced, true)
    assert.equal(r.json.state, 'ok')
    assert.deepEqual(execs.filter((e) => e[1] === 'call').map((e) => e.slice(0, 3)), [['treg', 'call', 'treg.x.search.posts']], 'the GET /connectors probes aside')
    st = await call('GET /connectors')
    assert.equal(st.json.jobs.comments.enabled, true)
    assert.match(st.json.jobs.comments.last.message, /1 campaign\(s\) searched/)
    const check = new DatabaseSync(path.join(dir, 'data', 'growth.db'), { readOnly: true })
    assert.equal(check.prepare(`SELECT cost_usd FROM ingest_runs WHERE source = 'search'`).get().cost_usd, 0.00075)
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
