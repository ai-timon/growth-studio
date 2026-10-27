// One agent per organization: the setting `agent` (cascade account → organization → user → plugin setting `agent`)
// picks the agent of every mission about an account. A user may only choose, and only start missions on, an agent
// their Timon account sees (or the plugin's agent); nothing set anywhere keeps the plugin's agent.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply, testing } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const U1 = { id: 'user-1', name: 'Ada', is_superadmin: true }
const U2 = { id: 'user-2', name: 'Grace', is_superadmin: false }

/** A started studio (plugin agent `acme.writer`) whose demo data belongs to user-1; `visible[user id]` = the agents
 *  that user's Timon account sees. */
function studio(dir, { visible = {}, permissions = ['settings', 'storage', 'missions:spawn', 'skills:write', 'agents:manage'] } = {}) {
  const storageDir = path.join(dir, 'plugins-data')
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const spawned = []
  const kv = new Map()
  let user = U1
  const ctx = {
    permissions,
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: 'acme.writer' })[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => user,
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
    skills: { put: async () => {} },
    agents: { list: async () => (visible[user.id] || []).map((name) => ({ name, backend: 'codex', model: null, role: 'research', mine: false })) },
    missions: { spawn: async (o) => { spawned.push(o); return `m${spawned.length}` } },
  }
  apply(ctx)
  const file = path.join(storageDir, 'growth.db')
  const seed = new DatabaseSync(file)
  seed.exec(DEMO)
  seed.exec(`UPDATE organizations SET owner_user_id = 'user-1'; UPDATE accounts SET owner_user_id = 'user-1' WHERE relation = 'owned'`)
  seed.close()
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  const sql = (fn) => { const d = new DatabaseSync(file); try { return fn(d) } finally { d.close() } }
  return { call, sql, spawned, kv, as: (u) => { user = u } }
}
const save = (s, scope, id, changes) => s.call('POST /scope/:scope/:id/settings', { params: { scope, id: String(id) }, body: { changes } })
const ask = (s) => s.call('POST /ask', { body: { text: 'Draft something', account_id: 1 } })

test('nothing set: every mission keeps the plugin\'s agent (no regression)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-agent-'))
  try {
    const s = studio(dir)
    assert.equal((await ask(s)).status, 200)
    assert.equal((await s.call('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'rewrite', text: 'shorter' } })).status, 200)
    assert.equal((await s.call('POST /ask', { body: { text: 'no account' } })).status, 200)
    assert.deepEqual(s.spawned.map((m) => m.agent), ['acme.writer', 'acme.writer', 'acme.writer'])
    const view = (await s.call('GET /scope/:scope/:id/settings', { params: { scope: 'organization', id: '1' } })).json
    assert.deepEqual(view.agent, { own: '', inherited: { value: 'acme.writer', from: 'plugin' }, effective: { value: 'acme.writer', from: 'plugin' } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cascade: account → organization → user → plugin setting, each level shown with where the agent comes from', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-agent-'))
  try {
    const s = studio(dir, { visible: { 'user-1': ['acme.writer', 'ada.growth', 'Acme.Brand', 'dev.voice'] } })
    const agents = (await s.call('GET /agents')).json
    assert.deepEqual([agents.plugin, agents.agents.map((a) => a.name), agents.error], ['acme.writer', ['acme.writer', 'ada.growth', 'Acme.Brand', 'dev.voice'], null])

    assert.equal((await save(s, 'global', 0, { agent: 'ada.growth' })).status, 200)
    await ask(s)
    const org = await save(s, 'organization', 1, { agent: 'acme.brand' })   // case-insensitive, stored as Timon names it
    assert.equal(org.status, 200, JSON.stringify(org.json))
    assert.deepEqual(org.json.agent, { own: 'Acme.Brand', inherited: { value: 'ada.growth', from: 'global' }, effective: { value: 'Acme.Brand', from: 'organization' } })
    await ask(s)
    await save(s, 'account', 1, { agent: 'dev.voice' })
    await ask(s)
    await save(s, 'account', 1, { agent: '' })   // back to the organization's
    await ask(s)
    await s.call('POST /ask', { body: { text: 'no account' } })   // the user's own level
    assert.deepEqual(s.spawned.map((m) => m.agent), ['ada.growth', 'Acme.Brand', 'dev.voice', 'Acme.Brand', 'ada.growth'])

    // the account's agent drives every mission about its posts and ideas
    await save(s, 'account', 1, { agent: 'dev.voice' })
    await s.call('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'rewrite', text: 'shorter' } })
    await s.call('POST /items/:id/draft', { params: { id: '1' }, body: { account_id: 1 } })
    assert.deepEqual(s.spawned.slice(-2).map((m) => m.agent), ['dev.voice', 'dev.voice'])
    // the Set up missions stay on the plugin's agent (the one its check is about)
    await s.call('POST /setup/converse', { body: {} })
    assert.equal(s.spawned.at(-1).agent, 'acme.writer')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an agent the user does not see is refused when chosen, and a mission never starts on an agent not granted to its user', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-agent-'))
  try {
    const s = studio(dir, { visible: { 'user-1': ['ada.growth'], 'user-2': ['grace.private'] } })
    const r = await save(s, 'organization', 1, { agent: 'grace.private' })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /agent "grace\.private" is not one of your Timon agents/)
    assert.equal(s.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM scoped_settings WHERE key = 'agent'`).get().n), 0, 'nothing saved')

    // written behind the studio's back (not chosen by the user): refused, nothing spawned
    s.sql((d) => d.prepare(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('organization', 1, 'agent', 'grace.private', '2026-10-26T00:00:00Z')`).run())
    const refused = await ask(s)
    assert.equal(refused.status, 400)
    assert.match(refused.json.error, /the agent "grace\.private" chosen in the studio settings is not allowed for this user/)
    assert.equal(s.spawned.length, 0)

    // another user's grant does not count: user-2 chose grace.private for their own work, user-1 still cannot use it
    s.as(U2)
    assert.equal((await save(s, 'global', 0, { agent: 'grace.private' })).status, 200)
    s.as(U1)
    assert.equal((await ask(s)).status, 400)
    assert.equal(s.spawned.length, 0)

    // granted, then no longer one of the user's agents: refused in their request
    assert.equal((await save(s, 'organization', 1, { agent: 'ada.growth' })).status, 200)
    assert.equal((await ask(s)).status, 200)
    assert.equal(s.spawned.at(-1).agent, 'ada.growth')
    const before = s.spawned.length
    s.sql((d) => d.prepare(`UPDATE scoped_settings SET value = 'ada.gone' WHERE key = 'agent'`).run())
    assert.equal((await ask(s)).status, 400)
    assert.equal(s.spawned.length, before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without agents:read the studio cannot list the user\'s agents: only the plugin\'s agent can be chosen', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-agent-'))
  try {
    const s = studio(dir, { visible: { 'user-1': ['ada.growth'] }, permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'] })
    const list = (await s.call('GET /agents')).json
    assert.deepEqual(list.agents, [])
    assert.match(list.error, /cannot list your Timon agents/)
    assert.equal((await save(s, 'organization', 1, { agent: 'ada.growth' })).status, 400)
    assert.equal((await save(s, 'organization', 1, { agent: 'acme.writer' })).status, 200, 'the plugin\'s agent needs no listing')
    await ask(s)
    assert.equal(s.spawned.at(-1).agent, 'acme.writer')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('news serving accounts of organizations with different agents: one mission per agent, a refused agent does not stop the others', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-agent-'))
  try {
    const s = studio(dir, { visible: { 'user-1': ['ada.growth'] } })
    const org2 = (await s.call('POST /orgs', { body: { name: 'Beta Labs' } })).json.id
    const acc2 = (await s.call('POST /accounts', { body: { network: 'x', handle: 'beta_hq', organization_id: org2, lang: 'en' } })).json.id
    const org3 = (await s.call('POST /orgs', { body: { name: 'Gamma' } })).json.id
    const acc3 = (await s.call('POST /accounts', { body: { network: 'x', handle: 'gamma_hq', organization_id: org3, lang: 'en' } })).json.id
    assert.equal((await save(s, 'organization', org2, { agent: 'ada.growth' })).status, 200)
    s.sql((d) => d.prepare(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('organization', ?, 'agent', 'not.granted', '2026-10-26T00:00:00Z')`).run(org3))
    const targets = s.sql((d) => d.prepare(`SELECT id, handle, owner_user_id FROM accounts WHERE relation = 'owned' ORDER BY id`).all()).map((t) => ({ ...t }))
    assert.deepEqual(targets.map((t) => t.id), [1, acc2, acc3])

    // a background job: no request, the grant is what is checked
    const db = new DatabaseSync(s.sql((d) => d.prepare('PRAGMA database_list').get().file))
    try {
      const ids = await testing.spawnNews(db, { handles: ['example_lab'], targets })
      assert.equal(ids, 'm1,m2')
    } finally { db.close() }
    assert.deepEqual(s.spawned.map((m) => m.agent), ['acme.writer', 'ada.growth'])
    assert.match(s.spawned[0].mission, /@acme_dev/)
    assert.doesNotMatch(s.spawned[0].mission, /@beta_hq|@gamma_hq/)
    assert.match(s.spawned[1].mission, /@beta_hq/)
    assert.doesNotMatch(s.spawned[1].mission, /@acme_dev|@gamma_hq/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
