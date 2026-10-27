// Optional connectors (treg, GetXAPI, GPT Image, headless Chrome) and the background jobs (bookmarks fetch, watch of
// followed accounts). Every provider is simulated: a fake context throws on any
// network call or host command a test did not script, so no test can reach a paid endpoint.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { createConnectors } from '../lib/connectors/index.js'
import { sealHtml } from '../lib/connectors/chrome.js'
import { pollBookmarks } from '../lib/jobs/bookmarks.js'
import { pollWatch } from '../lib/jobs/watch.js'
import { runTool } from '../lib/agent-tools.js'
import { apply, testing } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80)])

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(text), text: async () => text, headers: { get: (k) => headers[k.toLowerCase()] ?? null } }
}

/** A context whose fetch / host.exec only answer what the test scripted; anything else fails the test. */
function strictCtx({ settings = {}, secrets = {}, permissions = ['settings', 'storage', 'secrets:read', 'http:outbound', 'host:exec'], exec = null, fetch = null, backends = null, storageDir = null } = {}) {
  const calls = { exec: [], fetch: [], secrets: [] }
  const ctx = {
    permissions,
    settings: { get: (k) => settings[k] },
    secrets: { get: async (n) => { calls.secrets.push(n); return secrets[n] } },
    host: { exec: async (bin, args = []) => { calls.exec.push([bin, ...args]); if (!exec) throw new Error(`unexpected host command: ${bin}`); return exec(bin, args) } },
    fetch: async (url, init = {}) => { calls.fetch.push({ url, init }); if (!fetch) throw new Error(`unexpected network call: ${url}`); return fetch(url, init) },
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {} } },
    notify: { report() {}, alert() {} },
    log: { info() {}, warn() {}, error() {} },
  }
  if (backends) ctx.backends = { list: backends }
  return { ctx, calls }
}

function demoDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA); migrate(db); db.exec(DEMO)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
const at = (iso) => new Date(iso)

// ---------- connectors ----------
test('treg (cli): a missing binary and a binary the operator did not allow give two different messages', async () => {
  const missing = strictCtx({ exec: async () => ({ code: 1, stdout: '', stderr: 'spawn treg ENOENT' }) })
  const a = await createConnectors(missing.ctx).treg.check()
  assert.equal(a.ok, false)
  assert.deepEqual(a.missing, ['binary:treg'])
  assert.match(a.hint, /not found/)

  const refused = strictCtx({ exec: async () => { throw new Error("plugin `growth-studio` refused (host:exec): not allowed") } })
  const b = await createConnectors(refused.ctx).treg.check()
  assert.equal(b.ok, false)
  assert.match(b.hint, /pluginPolicy\.exec\.allow/)

  const ok = strictCtx({ exec: async () => ({ code: 0, stdout: 'treg 1.2.3\n', stderr: '' }) })
  const c = createConnectors(ok.ctx).treg
  assert.equal((await c.check()).ok, true)
  await c.check()
  assert.equal(ok.calls.exec.length, 1, 'the presence probe is cached')
  assert.deepEqual(ok.calls.exec[0], ['treg', '--version'])

  const noPerm = strictCtx({ permissions: ['settings'] })
  assert.equal((await createConnectors(noPerm.ctx).treg.check()).ok, false)
  assert.equal(noPerm.calls.exec.length, 0)
})

test('treg (http): same request as the CLI with the key read from the settings, cost taken from the answer', async () => {
  const { ctx, calls } = strictCtx({
    settings: { tregMode: 'http', tregTokenSecret: 'MY_TREG' },
    secrets: { MY_TREG: 'tk' },
    fetch: async () => response(200, { output: { posts: [] }, _treg: { charged_micro: 450 } }),
  })
  const treg = createConnectors(ctx).treg
  assert.equal((await treg.check()).ok, true)
  assert.equal(calls.fetch.length, 0, 'a check never calls the network')
  const r = await treg.call('treg.x.user.posts', { username: 'a' }, { maxCost: '0.002' })
  assert.equal(r.costUsd, 0.00045)
  assert.equal(calls.fetch[0].url, 'https://treg.to/call/treg.x.user.posts')
  assert.equal(calls.fetch[0].init.headers['x-treg-token'], 'tk')
  assert.equal(calls.fetch[0].init.headers['x-treg-route-max-cost'], '0.002')

  const refused = strictCtx({ settings: { tregMode: 'http', tregToken: 'typed' }, fetch: async () => response(401, 'no') })
  await assert.rejects(createConnectors(refused.ctx).treg.call('treg.x.user.posts', {}), (e) => e.auth === true)
  assert.equal(refused.calls.fetch[0].init.headers['x-treg-token'], 'typed', 'a typed key wins')
  assert.equal(refused.calls.secrets.length, 0)
})

test('GetXAPI: the key comes from a typed setting or from the vault secret NAMED by a setting, never a fixed name', async () => {
  const named = strictCtx({ settings: { getxapiKeySecret: 'ACME_GETX' }, secrets: { ACME_GETX: 'k1', COOKIE: 'c' } })
  const g = createConnectors(named.ctx).getxapi
  assert.equal((await g.check({ tokenSecret: 'COOKIE' })).ok, true)
  assert.ok(named.calls.secrets.includes('ACME_GETX'))
  assert.ok(!named.calls.secrets.includes('GETXAPI_KEY'))

  const typed = strictCtx({ settings: { getxapiKey: 'typed', getxapiKeySecret: 'ACME_GETX' }, secrets: { COOKIE: 'c' },
    fetch: async (_u, init) => { assert.equal(init.headers.authorization, 'Bearer typed'); return response(200, { bookmarks: [], has_more: false }) } })
  await createConnectors(typed.ctx).getxapi.bookmarks('COOKIE')
  assert.ok(!typed.calls.secrets.includes('ACME_GETX'), 'the typed key wins over the vault')

  const absent = strictCtx({ secrets: {} })
  const st = await createConnectors(absent.ctx).getxapi.check()
  assert.equal(st.ok, false)
  assert.match(st.hint, /GETXAPI_KEY/, 'default secret name, still a setting')
  assert.equal(absent.calls.fetch.length, 0)
})

test('GPT Image: shown when Codex is connected, hidden when clearly absent, shown with a note when unknown', async () => {
  const yes = strictCtx({ permissions: ['backends:read'], backends: async () => ({ backends: [{ id: 'codex', label: 'Codex', signedIn: true }] }) })
  assert.equal((await createConnectors(yes.ctx).gptImage.check()).ok, true)
  const no = strictCtx({ permissions: ['backends:read'], backends: async () => ({ backends: [{ id: 'claude', label: 'Claude' }] }) })
  const n = await createConnectors(no.ctx).gptImage.check()
  assert.equal(n.ok, false)
  assert.match(n.hint, /need Codex/)
  const out = strictCtx({ permissions: ['backends:read'], backends: async () => ({ backends: [{ id: 'codex', signedIn: false }] }) })
  assert.equal((await createConnectors(out.ctx).gptImage.check()).ok, false)
  const unknown = strictCtx({ permissions: ['settings'] })
  assert.equal((await createConnectors(unknown.ctx).gptImage.check()).ok, null)
  const broken = strictCtx({ permissions: ['backends:read'], backends: async () => { throw new Error('boom') } })
  assert.equal((await createConnectors(broken.ctx).gptImage.check()).ok, null)
})

test('Chrome: first allowed browser renders a sealed page to PNG in a private folder; none allowed = clear hint', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-chrome-'))
  try {
    let page = null
    const { ctx, calls } = strictCtx({
      storageDir: dir,
      exec: async (bin, args) => {
        if (bin === 'google-chrome') throw new Error('refused (host:exec)')
        if (args[0] === '--version') return { code: 0, stdout: 'Chromium 140', stderr: '' }
        const shot = args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length)
        page = readFileSync(new URL(args[args.length - 1]), 'utf8')
        writeFileSync(shot, PNG)
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const chrome = createConnectors(ctx).chrome
    const st = await chrome.check()
    assert.equal(st.ok, true)
    assert.equal(st.bin, 'google-chrome-stable')
    const png = await chrome.render('<html><head><title>x</title></head><body>hi</body></html>', { workDir: dir })
    assert.ok(png.equals(PNG))
    assert.match(page, /Content-Security-Policy/)
    assert.ok(calls.exec.some((c) => c.includes('--window-size=1200,675')))
    assert.deepEqual(readdirSync(dir), [], 'the render folder is removed')

    const none = strictCtx({ exec: async () => { throw new Error('refused') } })
    const n = await createConnectors(none.ctx).chrome.check()
    assert.equal(n.ok, false)
    assert.match(n.hint, /pluginPolicy\.exec\.allow/)
    assert.match(sealHtml('<p>x</p>'), /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- bookmarks job ----------
function bookmarkSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-bm-'))
  const paths = { base: dir, mediaDir: path.join(dir, 'media') }
  const db = demoDb()
  db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES
    ('account', 1, 'source_bookmarks', '1', 'x'), ('account', 1, 'getxapi_token_secret', 'COOKIE', 'x')`)
  db.exec(`INSERT INTO ignored_items(network, external_id, ignored_at) VALUES ('x', '900', 'x')`)
  return { dir, paths, db }
}
const tweet = (id, extra = {}) => ({ id, type: 'tweet', text: `post ${id}`, createdAt: 'Tue Jan 06 10:00:00 +0000 2026', viewCount: 10, author: { userName: 'someone', id: '7', followers: 50 }, ...extra })

test('bookmarks job: stopped at 0, outside its window, then first page only, deduplicated, one triage at a time', async () => {
  const { dir, paths, db } = bookmarkSetup()
  try {
    let pages = [{ bookmarks: [tweet('1000000000000000001'), tweet('900'), tweet('901')], has_more: true }]
    const fetched = []
    const getxapi = { bookmarks: async (secret) => { fetched.push(secret); return pages.shift() || { bookmarks: [] } } }
    const spawned = []
    const deps = { db, paths, getxapi, notify: { alert() {} }, spawnTriage: async (owner, count) => { spawned.push([owner.handle, count]); return `m${spawned.length}` } }

    db.exec(`INSERT INTO settings(key, value) VALUES ('bookmarks_poll_interval_min', '0')`)
    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T12:00:00Z') })).state, 'stopped')
    db.exec(`UPDATE settings SET value = '15' WHERE key = 'bookmarks_poll_interval_min'`)
    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T03:00:00Z') })).state, 'outside', 'demo window 08:00-23:00 in UTC')
    assert.equal(fetched.length, 0)

    const r = await pollBookmarks({ ...deps, now: at('2026-01-06T12:00:00Z') })
    assert.equal(r.state, 'ok', r.message)
    assert.deepEqual(fetched, ['COOKIE'], 'first page only, with the account cookie')
    const staged = JSON.parse(readFileSync(path.join(dir, 'staging.json'), 'utf8'))
    assert.deepEqual(Object.keys(staged), ['901'], 'known item and ignored id are left out')
    assert.equal(staged['901'].owner_account_id, 1)
    assert.deepEqual(spawned, [['acme_dev', 1]])
    const run = db.prepare(`SELECT * FROM ingest_runs WHERE source = 'bookmark'`).all()
    assert.equal(run.length, 1); assert.equal(run[0].cost_usd, 0.001); assert.equal(run[0].items_new, 1)

    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T12:10:00Z') })).state, 'not-due')
    pages = [{ bookmarks: [tweet('902')] }]
    const again = await pollBookmarks({ ...deps, now: at('2026-01-06T12:16:00Z') })
    assert.match(again.message, /triage already started/)
    assert.equal(spawned.length, 1, 'never two triages at once')
    pages = [{ bookmarks: [] }]
    await pollBookmarks({ ...deps, now: at('2026-01-06T12:35:00Z') })
    assert.equal(spawned.length, 2, 'started again after the respawn delay while bookmarks still wait')

    // the triage stores the verdicts with the owner the fetch recorded
    writeFileSync(path.join(dir, 'v.json'), JSON.stringify({ 901: { verdict: 'ignore' }, 902: { verdict: 'keep', pillar: 'other', score: 3 } }))
    assert.match(runTool(db, ['triage', 'list'], { paths }), /902 · @someone/)
    assert.match(runTool(db, ['triage-commit', path.join(dir, 'v.json')], { paths }), /1 kept, 1 ignored/)
    assert.equal(db.prepare(`SELECT c.account_id FROM captures c JOIN items i ON i.id = c.item_id WHERE i.external_id = '902'`).get().account_id, 1)
    pages = [{ bookmarks: [] }]
    await pollBookmarks({ ...deps, now: at('2026-01-06T12:51:00Z') })
    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'bookmarks_triage_spawned_at'`).get(), undefined, 'empty staging: the triage marker is cleared')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('bookmarks job: GetXAPI 401 alerts once until the next successful fetch, then alerts again', async () => {
  const { dir, paths, db } = bookmarkSetup()
  try {
    const alerts = []
    let fail = true
    const err = Object.assign(new Error('GetXAPI refused the access (HTTP 401)'), { auth: true })
    const deps = { db, paths, notify: { alert: (t) => alerts.push(t) }, spawnTriage: async () => 'm', getxapi: { bookmarks: async () => { if (fail) throw err; return { bookmarks: [] } } } }
    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T12:00:00Z') })).state, 'error')
    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T12:16:00Z') })).state, 'error')
    assert.equal(alerts.length, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ingest_runs WHERE source = 'bookmark' AND status = 'error'`).get().n, 2)
    assert.equal((await pollBookmarks({ ...deps, now: at('2026-01-06T12:20:00Z') })).state, 'not-due', 'no new attempt before the interval')
    fail = false
    await pollBookmarks({ ...deps, now: at('2026-01-06T12:32:00Z') })
    fail = true
    await pollBookmarks({ ...deps, now: at('2026-01-06T12:48:00Z') })
    assert.equal(alerts.length, 2)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ---------- watch job ----------
function watchSetup() {
  const db = demoDb()
  db.exec(`INSERT INTO accounts(id, network, handle, relation, role, watch_role, watch_priority) VALUES (4, 'x', 'big_lab', 'watched', 'brand', 'source', 'breaking')`)
  db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'source_news', '1', 'x')`)
  return db
}
const xpost = (id, at, extra = {}) => ({ id, text: `news ${id}`, createdUtc: Math.floor(new Date(at).getTime() / 1000), conversationId: id, isReply: false, likes: 1, ...extra })

test('watch job: baseline first, news only for breaking accounts after the thread calms down, RT and replies to others dropped', async () => {
  const db = watchSetup()
  try {
    const pages = { big_lab: [[xpost('500', '2026-01-06T07:50:00Z')]], example_lab: [[xpost('600', '2026-01-06T07:00:00Z')]], jane_builder: [[]] }
    const called = []
    const treg = { call: async (tool, data) => { called.push([tool, data.username]); const p = (pages[data.username] || []).shift() || []; return { json: { output: { posts: p } }, costUsd: 0.00045 } } }
    const spawned = []
    const deps = { db, treg, notify: { alert() {} }, spawnNews: async (o) => { spawned.push(o); return `news-${spawned.length}` } }

    let r = await pollWatch({ ...deps, now: at('2026-01-06T08:00:00Z') })
    assert.equal(called.length, 3, r.message)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM news_queue').get().n, 0, 'first poll = baseline')
    assert.ok(r.polled.every((l) => /baseline/.test(l)))

    pages.big_lab.push([xpost('501', '2026-01-06T08:10:00Z'), xpost('502', '2026-01-06T08:11:00Z', { text: 'RT @x: hi' }),
      xpost('503', '2026-01-06T08:12:00Z', { isReply: true, conversationId: '999' }), xpost('504', '2026-01-06T08:12:00Z', { isReply: true, conversationId: '501' })])
    r = await pollWatch({ ...deps, now: at('2026-01-06T08:16:00Z') })
    assert.deepEqual(called.slice(3), [['treg.x.user.posts', 'big_lab']], 'only the breaking account is due')
    assert.deepEqual(db.prepare(`SELECT external_id, kind FROM items WHERE author_id = 4 ORDER BY external_id`).all().map((x) => `${x.external_id}:${x.kind}`), ['500:post', '501:post', '504:thread'])
    assert.equal(db.prepare(`SELECT status FROM news_queue`).get().status, 'new')
    assert.equal(spawned.length, 0, 'waits for the thread to calm down')
    assert.match(r.message, /waiting for the thread/)

    r = await pollWatch({ ...deps, now: at('2026-01-06T08:21:00Z') })
    assert.equal(called[called.length - 1][1], 'big_lab', 'an account with pending news is polled again')
    assert.equal(spawned.length, 1)
    assert.deepEqual(spawned[0].handles, ['big_lab'])
    assert.deepEqual(spawned[0].targets.map((t) => t.handle), ['acme_dev'])
    assert.deepEqual({ ...db.prepare('SELECT status, mission_id FROM news_queue').get() }, { status: 'queued', mission_id: 'news-1' })
    assert.ok(db.prepare(`SELECT SUM(cost_usd) AS c FROM ingest_runs WHERE source = 'watch'`).get().c > 0)

    // the news agent drafts through the tools: the queue line becomes drafted
    const qid = db.prepare('SELECT id FROM news_queue').get().id
    assert.match(runTool(db, ['news', 'show', String(qid)]), /Rest of the thread \(1 post/)
    writeFileSync(path.join(tmpdir(), `gs-news-${process.pid}.txt`), 'What changes, in one line.')
    runTool(db, ['post', 'draft', '--account', 'acme_dev', '--news', String(qid), '--file', path.join(tmpdir(), `gs-news-${process.pid}.txt`)])
    assert.equal(db.prepare('SELECT status FROM news_queue WHERE id = ?').get(qid).status, 'drafted')
    rmSync(path.join(tmpdir(), `gs-news-${process.pid}.txt`), { force: true })
  } finally { db.close() }
})

test('watch job: budget stop, daily cap, no target, failed start and treg 401 set items aside without new attempts', async () => {
  const db = watchSetup()
  try {
    db.exec(`UPDATE accounts SET last_polled_at = '2026-01-06T07:00:00Z' WHERE relation = 'watched'`)
    db.exec(`INSERT INTO settings(key, value) VALUES ('daily_budget_usd', '0.0005')`)
    const queue = { big_lab: [] }
    let n = 0
    const treg = { call: async (_t, data) => { n++; return { json: { output: { posts: (queue[data.username] || []).splice(0) } }, costUsd: 0.0004 } } }
    const alerts = []
    const spawned = []
    const deps = { db, treg, notify: { alert: (t) => alerts.push(t) }, spawnNews: async (o) => { spawned.push(o); return 'm' } }
    let r = await pollWatch({ ...deps, now: at('2026-01-06T08:00:00Z'), force: true })
    assert.equal(n, 2, 'stops once the budget is spent')
    assert.match(r.message, /daily budget reached/)

    db.exec(`UPDATE settings SET value = '5' WHERE key = 'daily_budget_usd'`)
    db.exec(`INSERT INTO settings(key, value) VALUES ('news_max_tasks_per_day', '0')`)
    queue.big_lab.push(xpost('701', '2026-01-06T08:05:00Z'))
    await pollWatch({ ...deps, now: at('2026-01-06T08:10:00Z') })
    await pollWatch({ ...deps, now: at('2026-01-06T08:15:00Z') })
    assert.deepEqual({ ...db.prepare(`SELECT status, note FROM news_queue`).get() }, { status: 'skipped', note: 'daily cap of news missions reached' })
    assert.equal(spawned.length, 0)

    db.exec(`UPDATE settings SET value = '8' WHERE key = 'news_max_tasks_per_day'`)
    db.exec(`DELETE FROM scoped_settings WHERE key = 'source_news'`)
    queue.big_lab.push(xpost('702', '2026-01-06T08:20:00Z'))
    await pollWatch({ ...deps, now: at('2026-01-06T08:30:00Z') })
    await pollWatch({ ...deps, now: at('2026-01-06T08:40:00Z') })
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM news_queue WHERE status = 'skipped' AND note LIKE 'no managed account%'`).get().n, 1)

    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'source_news', '1', 'x')`)
    const failing = { ...deps, spawnNews: async () => { throw new Error('No agent configured') } }
    queue.big_lab.push(xpost('703', '2026-01-06T08:50:00Z'))
    await pollWatch({ ...failing, now: at('2026-01-06T08:56:00Z') })
    await pollWatch({ ...failing, now: at('2026-01-06T09:01:00Z') })
    await pollWatch({ ...failing, now: at('2026-01-06T09:10:00Z') })
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM news_queue WHERE note LIKE 'news mission not started%'`).get().n, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM news_queue WHERE status = 'new'`).get().n, 0, 'nothing stays to be retried')
    assert.equal(alerts.length, 1)
    assert.equal(spawned.length, 0)

    const refused = { ...deps, treg: { call: async () => { n++; throw Object.assign(new Error('treg failed: 401'), { auth: true }) } } }
    const before = n
    r = await pollWatch({ ...refused, now: at('2026-01-06T10:00:00Z'), force: true })
    assert.equal(n - before, 1, 'a refused key stops the polling')
    assert.match(r.message, /401/)
    await pollWatch({ ...refused, now: at('2026-01-06T10:20:00Z'), force: true })
    assert.equal(alerts.filter((a) => /401/.test(a)).length, 1, 'one alert until the next successful poll')
  } finally { db.close() }
})

// ---------- host half: switches, status, publication through the connectors ----------
function hostCtx(dir, { settings = {}, secrets = {}, exec = null, fetch = null } = {}) {
  const routes = {}
  const add = (m) => (r, h) => { routes[`${m} ${r}`] = h }
  const base = strictCtx({ settings: Object.assign(settings, { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db') }), secrets, exec, fetch, storageDir: path.join(dir, 'data'),
    permissions: ['settings', 'storage', 'secrets:read', 'http:outbound', 'host:exec', 'notify'] })
  Object.assign(base.ctx, { router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }), effect() {}, user: () => ({ id: 'u1' }), realtime: { publish() {} } })
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200; let json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  return { ...base, call }
}

test('host: jobs are off by default and their switch is read at every run; status shows no secret value', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-jobs-'))
  try {
    const settings = {}
    const h = hostCtx(dir, { settings, secrets: { GETXAPI_KEY: 'secret-value', COOKIE: 'cookie-value' }, fetch: async () => response(200, { bookmarks: [tweet('901')] }) })
    apply(h.ctx)
    const db = new DatabaseSync(path.join(dir, 'data', 'growth.db'))
    db.exec(DEMO)
    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'source_bookmarks', '1', 'x'), ('account', 1, 'getxapi_token_secret', 'COOKIE', 'x')`)
    db.exec(`INSERT INTO settings(key, value) VALUES ('bookmarks_window_start', '00:00'), ('bookmarks_window_end', '00:00')`)   // all day: the job runs on the real clock
    db.close()
    await testing.runJob('bookmarks')
    await testing.runJob('watch')
    assert.equal(h.calls.fetch.length, 0, 'switched off: nothing fetched')
    settings.bookmarksJob = true
    await testing.runJob('bookmarks')
    assert.equal(h.calls.fetch.length, 1)
    assert.equal(h.calls.fetch[0].url, 'https://api.getxapi.com/twitter/user/bookmarks')
    const st = await h.call('GET /connectors')
    assert.equal(st.status, 200)
    const text = JSON.stringify(st.json)
    assert.ok(!text.includes('secret-value') && !text.includes('cookie-value'))
    assert.deepEqual(st.json.connectors.map((c) => c.id), ['treg', 'getxapi', 'gpt-image', 'chrome'])
    assert.equal(st.json.jobs.bookmarks.enabled, true)
    assert.equal(st.json.jobs.watch.enabled, false)
    assert.match(st.json.jobs.bookmarks.last.message, /triage not started: no bookmark triage criteria/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('host: "run now" of a job is reserved to an administrator, needs its switch, and ignores the window', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-run-'))
  try {
    const settings = {}
    const h = hostCtx(dir, { settings, secrets: { GETXAPI_KEY: 'k', COOKIE: 'c' }, fetch: async () => response(200, { bookmarks: [] }) })
    apply(h.ctx)
    const db = new DatabaseSync(path.join(dir, 'data', 'growth.db'))
    db.exec(DEMO)
    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'source_bookmarks', '1', 'x'), ('account', 1, 'getxapi_token_secret', 'COOKIE', 'x')`)
    db.exec(`INSERT OR REPLACE INTO settings(key, value) VALUES ('bookmarks_window_start', '00:00'), ('bookmarks_window_end', '00:01')`)   // closed nearly all day
    db.close()
    let r = await h.call('POST /admin/jobs/:job/run', { params: { job: 'bookmarks' } })
    assert.equal(r.status, 403, 'not an administrator')
    h.ctx.user = () => ({ id: 'u1', is_superadmin: true })
    r = await h.call('POST /admin/jobs/:job/run', { params: { job: 'nope' } })
    assert.equal(r.status, 404)
    r = await h.call('POST /admin/jobs/:job/run', { params: { job: 'bookmarks' } })
    assert.equal(r.status, 409, 'switched off')
    assert.equal(h.calls.fetch.length, 0)
    settings.bookmarksJob = true
    r = await h.call('POST /admin/jobs/:job/run', { params: { job: 'bookmarks' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.forced, true)
    assert.equal(r.json.state, 'ok')
    assert.equal(h.calls.fetch.length, 1, 'fetched outside the window')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('host: a validated post goes out through GetXAPI (media) and treg (post); a missing treg stops it before any upload', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-pub-'))
  try {
    let tregPresent = true
    const h = hostCtx(dir, {
      settings: { getxapiKeySecret: 'ACME_GETX' },
      secrets: { ACME_GETX: 'k', COOKIE: 'c' },
      exec: async (bin, args) => {
        assert.equal(bin, 'treg')
        if (args[0] === '--version') return tregPresent ? { code: 0, stdout: 'treg 1', stderr: '' } : { code: 1, stdout: '', stderr: 'ENOENT' }
        return { code: 0, stdout: 'note\n{"data":{"id":"777"}}', stderr: '' }
      },
      fetch: async (url, init) => { assert.equal(url, 'https://api.getxapi.com/twitter/media/upload'); assert.equal(init.headers.authorization, 'Bearer k'); return response(200, { data: { media_id: 'm1' } }) },
    })
    apply(h.ctx)
    const media = path.join(dir, 'data', 'media')
    writeFileSync(path.join(media, '3.png'), PNG)
    writeFileSync(path.join(media, '4.png'), PNG)
    const db = new DatabaseSync(path.join(dir, 'data', 'growth.db'))
    db.exec(DEMO)
    db.exec(`UPDATE organizations SET owner_user_id = 'u1'; UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned'`)
    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'x_publish_target', 'x.x.post.create', 'x'), ('account', 1, 'getxapi_token_secret', 'COOKIE', 'x')`)
    for (const id of [3, 4]) {
      db.exec(`INSERT INTO posts(id, account_id, kind, lang, body, media, status, created_at, validated_at, validated_by)
        VALUES (${id}, 1, 'post', 'en', 'Hello ${id}', '[{"type":"image","path":"media/${id}.png"}]', 'approved', 'x', 'x', 'tester')`)
    }
    db.close()
    const ok = await h.call('POST /posts/:id/publish', { params: { id: '3' } })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.equal(ok.json.url, 'https://x.com/acme_dev/status/777')
    const post = h.calls.exec.find((c) => c[1] === 'call')
    assert.deepEqual(JSON.parse(post[post.indexOf('--data') + 1]), { text: 'Hello 3', media: { media_ids: ['m1'] } })

    tregPresent = false
    const h2 = hostCtx(dir, { settings: { getxapiKeySecret: 'ACME_GETX' }, secrets: { ACME_GETX: 'k', COOKIE: 'c' },
      exec: async () => ({ code: 1, stdout: '', stderr: 'ENOENT' }), fetch: async () => { throw new Error('must not upload') } })
    apply(h2.ctx)
    const ko = await h2.call('POST /posts/:id/publish', { params: { id: '4' } })
    assert.equal(ko.status, 400)
    assert.match(ko.json.error, /treg/)
    assert.equal(h2.calls.fetch.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agent tools: render-html is the studio\'s job, news skip needs a reason', async () => {
  const db = watchSetup()
  try {
    assert.throws(() => runTool(db, ['render-html', '1', 'page.html']), /needs Growth Studio itself/)
    db.exec(`INSERT INTO news_queue(id, item_id, account_id, detected_at) VALUES (1, 1, 2, '2026-01-06T08:00:00Z')`)
    assert.match(runTool(db, ['news', 'list']), /news #1 · @example_lab/)
    assert.throws(() => runTool(db, ['news', 'skip', '1']), /usage/)
    assert.match(runTool(db, ['news', 'skip', '1', '--note', 'no substance']), /set aside/)
    assert.throws(() => runTool(db, ['news', 'skip', '1', '--note', 'again']), /skipped/)
  } finally { db.close() }
})

