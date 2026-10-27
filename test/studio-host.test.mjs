// Host half of the studio with a fake plugin context: database prepared at startup, data source, import route.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fakeCtx({ storageDir, settings = {}, user = { id: 'u1', is_superadmin: true } }) {
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const router = { use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }
  const logs = []
  const ctx = {
    permissions: ['settings', 'storage'],
    router: () => router,
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {} } },
    settings: { get: (k) => settings[k] },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect() {},
    user: () => user,
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
  }
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  return { ctx, call, logs, setUser: (u) => { user = u } }
}

test('a fresh install creates its database in the plugin storage and serves it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-host-'))
  try {
    const storageDir = path.join(dir, 'plugins-data')
    const { ctx, call } = fakeCtx({ storageDir, settings: { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db') } })
    apply(ctx)
    assert.ok(existsSync(path.join(storageDir, 'growth.db')))
    assert.ok(existsSync(path.join(storageDir, 'media')))
    const o = await call('GET /overview')
    assert.equal(o.status, 200)
    assert.deepEqual(o.json.accounts, [])
    const d = await call('GET /admin/data')
    assert.equal(d.json.source, 'plugin')
    assert.equal(d.json.version, 23)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without a plugin database, an existing project database keeps being used until the import', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-host-'))
  try {
    const state = path.join(dir, 'project', 'state')
    mkdirSync(path.join(state, 'media'), { recursive: true })
    const legacyDbPath = path.join(state, 'growth.db')
    const src = new DatabaseSync(legacyDbPath)
    src.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
    src.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
    src.exec(`UPDATE posts SET media = '[{"type":"image","path":"state/media/1.png"}]' WHERE id = 1`)
    src.close()
    writeFileSync(path.join(state, 'media', '1.png'), 'png')

    const storageDir = path.join(dir, 'plugins-data')
    const h = fakeCtx({ storageDir, settings: { dataSource: 'plugin', legacyDbPath } })
    apply(h.ctx)
    assert.equal(existsSync(path.join(storageDir, 'growth.db')), false, 'no empty plugin database is created over the fallback')
    let d = await h.call('GET /admin/data')
    assert.deepEqual([d.json.source, d.json.fallback], ['legacy', true])
    const ov = await h.call('GET /overview')
    assert.equal(ov.status, 200, JSON.stringify(ov.json))
    assert.equal(ov.json.accounts.length, 1)
    assert.equal((await h.call('GET /posts/:id', { params: { id: '1' } })).json.post.media[0].path, 'state/media/1.png')

    h.setUser({ id: 'u2', is_superadmin: false })
    assert.equal((await h.call('POST /admin/import', { body: { path: legacyDbPath } })).status, 403)
    h.setUser(undefined)
    assert.equal((await h.call('POST /admin/import', { body: { path: legacyDbPath } })).status, 401, 'no signed-in user')
    h.setUser({ id: 'u1', is_superadmin: true })
    const r = await h.call('POST /admin/import', { body: { path: legacyDbPath } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.counts.posts.target, 2)
    assert.equal(r.json.active.source, 'plugin')

    d = await h.call('GET /admin/data')
    assert.deepEqual([d.json.source, d.json.fallback], ['plugin', false])
    const post = (await h.call('GET /posts/:id', { params: { id: '1' } })).json.post
    assert.equal(post.media[0].path, 'media/1.png')
    assert.ok(post.media_mtime, 'the imported media file resolves inside the plugin storage')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy mode with a missing file reports the error instead of creating a database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-host-'))
  try {
    const legacyDbPath = path.join(dir, 'missing', 'state', 'growth.db')
    const h = fakeCtx({ storageDir: path.join(dir, 'plugins-data'), settings: { dataSource: 'legacy', legacyDbPath } })
    apply(h.ctx)
    assert.equal(existsSync(legacyDbPath), false)
    const o = await h.call('GET /overview')
    assert.equal(o.status, 400)
    assert.match(o.json.error, /legacy database not found/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missions run on the configured agent with the tools skill; briefs name no project, person or provider', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-host-'))
  try {
    const storageDir = path.join(dir, 'plugins-data')
    const settings = { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: '' }
    const h = fakeCtx({ storageDir, settings })
    const spawned = []; const skills = {}
    h.ctx.permissions = ['settings', 'storage', 'missions:spawn', 'skills:write']
    h.ctx.skills = { put: async (id, content) => { skills[id] = content } }
    h.ctx.missions = { spawn: async (o) => { spawned.push(o); return `m${spawned.length}` } }
    apply(h.ctx)
    const db = new DatabaseSync(path.join(storageDir, 'growth.db'))
    db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
    db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES
      ('account', 1, 'original_suggest_prompt', 'Suggest well.', 'x'), ('account', 1, 'original_write_prompt', 'Write well.', 'x')`)
    db.exec(`INSERT INTO ideas(id, title, concept, status, created_at, kind, account_id) VALUES (5, 'An idea', 'Concept', 'idea', '2026-01-06T00:00:00Z', 'reflection', 1)`)
    db.exec(`INSERT INTO rule_proposals(id, created_at, text, evidence) VALUES (1, '2026-01-06T00:00:00Z', 'Keep posts short.', '[1]'), (2, '2026-01-06T00:00:00Z', 'Account rule.', '[1]')`)
    db.exec(`UPDATE rule_proposals SET account_id = 1 WHERE id = 2`)
    db.close()

    const o = await h.call('GET /overview')
    assert.match(o.json.agent.issue, /No agent configured/)
    const refused = await h.call('POST /ask', { body: { text: 'hello' } })
    assert.equal(refused.status, 400)
    assert.match(refused.json.error, /No agent configured/)
    assert.equal(spawned.length, 0)

    settings.agent = 'acme.writer'
    settings.rulesToMemory = true
    const calls = [
      ['POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'rewrite', text: 'shorter' } }],
      ['POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'image', engine: 'gpt-image' } }],
      ['POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'image', engine: 'code' } }],
      ['POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'custom', text: 'check it' } }],
      ['POST /ask', { body: { text: 'propose 3 ideas', account_id: 1 } }],
      ['POST /ask', { body: { text: 'propose 3 ideas' } }],
      ['POST /items/:id/draft', { params: { id: '1' }, body: { account_id: 1 } }],
      ['POST /ideas/suggest', { body: { account_id: 1, count: 2 } }],
      ['POST /ideas/:id/draft', { params: { id: '5' }, body: {} }],
      ['POST /rules/:id/accept', { params: { id: '1' }, body: {} }],
      ['POST /rules/:id/accept', { params: { id: '2' }, body: {} }],
    ]
    for (const [k, opts] of calls) { const r = await h.call(k, opts); assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.json)}`) }
    assert.equal(spawned.length, 10, 'an account rule starts no mission')
    for (const s of spawned) {
      assert.equal(s.agent, 'acme.writer')
      assert.deepEqual(s.extraSkills, ['growth-studio-tools'])
      assert.doesNotMatch(s.mission, /AGENTS\.md|scripts\/|brain|CHANGELOG\.md|Claude|Codex|python|\/tmp\//, s.title)
    }
    assert.ok(skills['growth-studio-tools'], 'the tools skill is written at startup')
    const check = new DatabaseSync(path.join(storageDir, 'growth.db'), { readOnly: true })
    // a rule for all accounts goes to the rules of the user who accepted it, not to the installation
    assert.match(check.prepare(`SELECT value FROM user_settings WHERE owner_user_id = 'u1' AND key = 'rules'`).get().value, /Keep posts short\./)
    assert.doesNotMatch(check.prepare(`SELECT value FROM settings WHERE key = 'rules'`).get().value, /Keep posts short/, 'the installation value is left as it was')
    assert.match(check.prepare(`SELECT value FROM scoped_settings WHERE scope = 'account' AND scope_id = 1 AND key = 'rules'`).get().value, /Account rule\./)
    assert.equal(check.prepare(`SELECT COUNT(*) AS n FROM rule_proposals WHERE status = 'accepted'`).get().n, 2)
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
