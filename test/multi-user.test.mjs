// Multi-user (lib/scope.js): two simulated Timon users on the same studio never see nor change each other's data.
// Another user's resource answers 404 like a missing one; the filter is applied to every connection of a request, of
// an agent command (`--owner`) and at the SQL level for writes; live signals go to the user concerned only.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply, testing } from '../lib/index.js'
import { migrate } from '../lib/db.js'
import { resolve } from '../lib/accounts.js'
import { adoptStrays, knownOwners, scopeDb } from '../lib/scope.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const U1 = { id: 'user-1', name: 'Ada', is_superadmin: true }
const U2 = { id: 'user-2', name: 'Grace', is_superadmin: false }

/** A started studio whose demo data belongs to user-1; `as(user)` switches the signed-in user. */
function studio(dir, { kv = new Map(), seed = true } = {}) {
  const storageDir = path.join(dir, 'plugins-data')
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const published = []
  const spawned = []
  let user = U1
  const ctx = {
    permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: 'acme.writer' })[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => user,
    realtime: { publish: (topic, payload, opts) => { published.push({ topic, payload, owner: opts.ownerUserId }) } },
    notify: { report() {}, alert() {} },
    skills: { put: async () => {} },
    missions: { spawn: async (o) => { spawned.push(o); return `m${spawned.length}` } },
  }
  apply(ctx)
  const file = path.join(storageDir, 'growth.db')
  if (seed) {
    const db = new DatabaseSync(file)
    db.exec(DEMO)
    db.exec(`UPDATE organizations SET owner_user_id = 'user-1'; UPDATE accounts SET owner_user_id = 'user-1' WHERE relation = 'owned'`)
    db.close()
  }
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  const sql = (fn) => { const d = new DatabaseSync(file); try { return fn(d) } finally { d.close() } }
  return { call, sql, file, published, spawned, kv, ctx, as: (u) => { user = u } }
}

test('two users: each one only sees their own organizations, accounts, posts and bookmarks; the other\'s answer 404', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    s.as(U2)
    const org = await s.call('POST /orgs', { body: { name: 'Acme' } })   // same name as user-1's organization
    assert.equal(org.status, 200, JSON.stringify(org.json))
    const foreignOrg = await s.call('POST /accounts', { body: { network: 'x', handle: 'grace_dev', organization_id: 1 } })
    assert.deepEqual([foreignOrg.status, foreignOrg.json.error], [404, 'organization not found'])
    const acc = await s.call('POST /accounts', { body: { network: 'x', handle: 'grace_dev', organization_id: org.json.id, lang: 'en' } })
    assert.equal(acc.status, 200, JSON.stringify(acc.json))
    s.sql((d) => d.exec(`INSERT INTO posts(id, account_id, kind, lang, body, status, created_at) VALUES (10, ${acc.json.id}, 'post', 'en', 'Grace draft', 'pending_validation', '2026-01-07T00:00:00Z')`))

    // lists
    const tree2 = (await s.call('GET /orgs')).json
    assert.deepEqual(tree2.organizations.map((o) => o.name), ['Acme'])
    assert.deepEqual(tree2.organizations[0].accounts.map((a) => a.handle), ['grace_dev'])
    assert.notEqual(s.sql((d) => d.prepare('SELECT slug FROM organizations WHERE id = ?').get(org.json.id).slug), 'acme', 'the slug of user-1 is neither reused nor revealed')
    assert.deepEqual(tree2.watched.map((a) => a.handle).sort(), ['example_lab', 'jane_builder'], 'watched accounts are shared')
    const ov2 = (await s.call('GET /overview')).json
    assert.deepEqual(ov2.accounts.map((a) => a.handle), ['grace_dev'])
    assert.deepEqual(ov2.counts, { pending_validation: 1 })
    assert.equal(ov2.toConfirm, 0, 'the bookmark user-1 has to confirm is not user-2\'s')
    assert.deepEqual((await s.call('GET /posts')).json.posts.map((p) => p.id), [10])
    const feed2 = (await s.call('GET /feed', { query: {} })).json
    assert.deepEqual(feed2.items.map((i) => i.id), [1], 'the watched post is shared, user-1\'s bookmark is not')
    assert.deepEqual(feed2.items[0].posts, [], 'user-1\'s draft built on the shared post is not shown')

    // another user's resources: exactly like missing ones
    const notFound = [
      ['GET /posts/:id', { params: { id: '1' } }, 'post not found'],
      ['PUT /posts/:id', { params: { id: '1' }, body: { body: 'hijacked' } }, 'post not found'],
      ['POST /posts/:id/approve', { params: { id: '1' }, body: {} }, 'post not found'],
      ['POST /posts/:id/reject', { params: { id: '1' }, body: { note: 'no' } }, 'post not found'],
      ['POST /posts/:id/publish', { params: { id: '2' } }, 'post not found'],
      ['GET /media/:id', { params: { id: '1' } }, 'media not found'],
      ['POST /ideas/:id/drop', { params: { id: '1' }, body: {} }, 'idea not found'],
      ['POST /items/:id/verdict', { params: { id: '2' }, body: { verdict: 'ignore' } }, 'item not found'],
      ['GET /scope/:scope/:id/settings', { params: { scope: 'account', id: '1' } }, 'account not found'],
      ['POST /scope/:scope/:id/settings', { params: { scope: 'organization', id: '1' }, body: { changes: { goals: 'x' } } }, 'organization not found'],
      ['PUT /accounts/:id', { params: { id: '1' }, body: { display_name: 'x' } }, 'account not found'],
      ['POST /accounts/:id/delete', { params: { id: '1' } }, 'account not found'],
      ['POST /orgs/:id/delete', { params: { id: '1' } }, 'organization not found'],
      ['GET /calendar', { query: { account: '1' } }, 'account not found'],
      ['GET /next-slot', { query: { account: '1' } }, 'account not found'],
      ['GET /learnings', { query: { account: '1' } }, 'account not found'],
      ['POST /ask', { body: { text: 'hello', account_id: 1 } }, 'account not found'],
      ['POST /ideas/suggest', { body: { account_id: 1 } }, 'account not found'],
      ['POST /items/:id/draft', { params: { id: '1' }, body: { account_id: 1 } }, 'account not found'],
    ]
    for (const [route, opts, error] of notFound) {
      const r = await s.call(route, opts)
      assert.deepEqual([r.status, r.json.error], [404, error], route)
    }
    assert.equal(s.sql((d) => d.prepare('SELECT body FROM posts WHERE id = 1').get().body).startsWith('Found a tool'), true, 'nothing of user-1 changed')
    assert.equal(s.sql((d) => d.prepare('SELECT status FROM posts WHERE id = 1').get().status), 'pending_validation')
    assert.equal(s.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM ignored_items').get().n), 0)
    assert.equal(s.spawned.length, 0)

    // user-1 still sees everything of theirs, and nothing of user-2
    s.as(U1)
    assert.deepEqual((await s.call('GET /posts')).json.posts.map((p) => p.id).sort(), [1, 2])
    assert.equal((await s.call('GET /posts/:id', { params: { id: '10' } })).status, 404)
    assert.deepEqual((await s.call('GET /orgs')).json.organizations.map((o) => o.id), [1])
    assert.equal((await s.call('GET /triage')).json.toConfirm.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('two users: settings of the global level are each user\'s own; the installation settings are an administrator\'s', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    s.as(U2)
    const saved = await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { rules: 'Grace rule.' } } })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.effective.rules.value, 'Grace rule.')
    const budget = await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { daily_budget_usd: '9' } } })
    assert.equal(budget.status, 400)
    assert.match(budget.json.error, /reserved to an administrator/)

    s.as(U1)
    const mine = (await s.call('GET /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' } })).json
    assert.doesNotMatch(mine.effective.rules.value, /Grace rule/)
    assert.equal((await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { daily_budget_usd: '0.5' } } })).status, 200)
    assert.equal(s.sql((d) => d.prepare(`SELECT value FROM settings WHERE key = 'daily_budget_usd'`).get().value), '0.5')
    assert.equal((await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { rules: 'Ada rule.' } } })).status, 200)
    assert.match((await s.call('GET /scope/:scope/:id/settings', { params: { scope: 'account', id: '1' } })).json.effective.rules.value, /Ada rule\./)
    // the account's cascade ends on its owner's level, whoever reads it: a background job (no user) reads the same
    const job = s.sql((d) => resolve(d, 'account', 1, 'rules').value)
    assert.match(job, /Ada rule\./)
    assert.doesNotMatch(job, /Grace rule/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('two users: live signals go to the user whose data changed, and missions name their user', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    s.as(U1)
    assert.equal((await s.call('POST /posts/:id/reject', { params: { id: '1' }, body: { note: 'not now' } })).status, 200)
    assert.deepEqual(s.published.map((p) => p.owner), ['user-1'])
    assert.equal((await s.call('POST /ask', { body: { text: 'propose ideas', account_id: 1 } })).status, 200)
    assert.match(s.spawned[0].mission, /Growth Studio user of this mission: `user-1`\. Pass `--owner user-1`/)
    s.as(U2)
    await s.call('GET /overview')
    assert.deepEqual(s.published.map((p) => p.owner), ['user-1'], 'reading sends nothing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agent commands act for the user given with --owner, and only that user', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    s.as(U2)
    const org = await s.call('POST /orgs', { body: { name: 'Grace Co' } })
    await s.call('POST /accounts', { body: { network: 'x', handle: 'grace_dev', organization_id: org.json.id, lang: 'en' } })
    const tool = (owner, ...argv) => testing.handleTool({ argv, files: {}, owner })

    assert.match((await tool('user-1', 'accounts')).out, /@acme_dev/)
    const list2 = await tool('user-2', 'accounts')
    assert.match(list2.out, /@grace_dev/)
    assert.doesNotMatch(list2.out, /acme_dev/)
    assert.equal((await tool('user-1', 'post', 'show', '1')).code, 0)
    const foreign = await tool('user-2', 'post', 'show', '1')
    assert.deepEqual([foreign.code, foreign.err], [1, 'post #1 not found'])
    const write = await tool('user-2', 'post', 'set-brief', '1', '--image-prompt', 'hijacked')
    assert.deepEqual([write.code, write.err], [1, 'post #1 not found'])
    assert.equal((await tool('user-2', 'account-context', 'acme_dev')).code, 1)
    assert.equal((await tool('user-2', 'item', 'show', '2')).code, 1, 'user-1\'s bookmark')
    assert.equal((await tool('user-2', 'item', 'show', '1')).code, 0, 'a watched post is shared')
    assert.equal((await tool(null, 'accounts')).code, 2, 'no user: usage error')
    assert.match((await tool('user-9', 'accounts')).err, /unknown Growth Studio user "user-9"/)
    assert.equal(s.sql((d) => d.prepare('SELECT image_prompt FROM posts WHERE id = 1').get().image_prompt), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('at the SQL level, a scoped connection cannot change another user\'s rows, even with a direct statement', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.exec(DEMO)
  db.exec(`UPDATE organizations SET owner_user_id = 'user-1'; UPDATE accounts SET owner_user_id = 'user-1' WHERE relation = 'owned'`)
  scopeDb(db, 'user-2')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM main.posts').get().n, 2, 'the main table is still there')
  assert.throws(() => db.prepare(`UPDATE main.posts SET body = 'x' WHERE id = 1`).run(), /post not found/)
  assert.throws(() => db.prepare('DELETE FROM main.learnings').run(), /feedback not found/)
  assert.throws(() => db.prepare(`INSERT INTO main.posts(account_id, lang, body, created_at, status) VALUES (1, 'en', 'x', 'x', 'pending_validation')`).run(), /post not found/)
  assert.throws(() => db.prepare(`INSERT INTO main.scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'rules', 'x', 'x')`).run(), /not found/)
  assert.throws(() => db.prepare(`UPDATE main.settings SET value = 'x'`).run(), /reserved to an administrator/)
  assert.throws(() => db.prepare(`UPDATE posts SET body = 'x'`).run(), /cannot modify posts because it is a view/, 'an unqualified write fails loudly')
  db.close()
})

test('existing data goes to the user the previous version recorded, then rows written without owner follow', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    // a database written before multi-user: nobody owns anything
    const storageDir = path.join(dir, 'plugins-data')
    mkdirSync(storageDir)
    const db = new DatabaseSync(path.join(storageDir, 'growth.db'))
    migrate(db); db.exec(DEMO); db.close()
    const kv = new Map([['ownerUserId', 'user-1']])
    const s = studio(dir, { kv, seed: false })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(kv.has('ownerUserId'), false, 'the old key is removed once used')
    assert.deepEqual(s.sql((d) => knownOwners(d)), ['user-1'])
    assert.equal(s.sql((d) => d.prepare(`SELECT value FROM user_settings WHERE owner_user_id = 'user-1' AND key = 'rules'`).get().value), 'Never name a competitor in a post.')
    s.as(U2)
    assert.deepEqual((await s.call('GET /overview')).json.accounts, [], 'user-2 is not given anything')
    // a row written by a tool outside the plugin (no owner) goes to the single user of the installation
    s.sql((d) => d.exec(`INSERT INTO ideas(title, concept, created_at) VALUES ('From a script', 'x', 'x')`))
    assert.equal(s.sql((d) => adoptStrays(d, 'user-1')), 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('watched accounts are shared: any user adds and changes them, never another user\'s managed account', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    s.as(U2)
    const org = await s.call('POST /orgs', { body: { name: 'Grace Co' } })
    await s.call('POST /accounts', { body: { network: 'x', handle: 'grace_dev', organization_id: org.json.id, lang: 'en' } })
    const tool = (owner, ...argv) => testing.handleTool({ argv, files: {}, owner })

    const add = await tool('user-2', 'watch', 'add', 'shared_lab', '--role', 'brand', '--priority', 'daily')
    assert.equal(add.code, 0, add.err)
    assert.equal(s.sql((d) => d.prepare(`SELECT owner_user_id FROM accounts WHERE handle = 'shared_lab'`).get().owner_user_id), null)
    assert.match((await tool('user-1', 'watch', 'list')).out, /@shared_lab/, 'seen by the other user')
    assert.equal((await tool('user-1', 'watch', 'set', 'shared_lab', '--priority', 'breaking')).code, 0)
    const taken = await tool('user-2', 'watch', 'add', 'acme_dev', '--role', 'brand', '--priority', 'daily')
    assert.deepEqual([taken.code, /already in the studio/.test(taken.err)], [1, true], 'user-1\'s managed account, invisible to user-2, is still taken')
    assert.equal((await tool('user-2', 'watch', 'remove', 'acme_dev')).code, 1)
    assert.equal(s.sql((d) => d.prepare(`SELECT relation, watch_priority FROM accounts WHERE handle = 'acme_dev'`).get().relation), 'owned')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('item add through the host: a known post answers on a user\'s connection, a new one without treg is a clear refusal', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-users-'))
  try {
    const s = studio(dir)
    const tool = (owner, ...argv) => testing.handleTool({ argv, files: {}, owner })
    const known = await tool('user-1', 'item', 'add', 'https://x.com/example_lab/status/1000000000000000001')
    assert.equal(known.code, 0, known.err)
    assert.match(known.out, /already in the database \(nothing fetched\): item #1 /)
    const fresh = await tool('user-1', 'item', 'add', 'https://x.com/someone/status/42')
    assert.deepEqual([fresh.code, /treg connector is unavailable/.test(fresh.err)], [1, true], fresh.err)
    const bad = await tool('user-1', 'item', 'add', 'https://example.com/x')
    assert.equal(bad.code, 2)
    assert.equal(s.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM items WHERE external_id = '42'`).get().n), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
