// Learned rules (lib/rules.js): automatic acceptance by `feedback propose`, revocation, never proposed again, per-user setting.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply, testing } from '../lib/index.js'

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


const rulesOf = (s, owner = 'user-1') => s.sql((d) => (d.prepare(`SELECT value FROM user_settings WHERE owner_user_id = ? AND key = 'rules'`).get(owner) || { value: '' }).value)
const accountRules = (s) => s.sql((d) => (d.prepare(`SELECT value FROM scoped_settings WHERE scope = 'account' AND scope_id = 1 AND key = 'rules'`).get() || { value: '' }).value)
const row = (s, id) => s.sql((d) => d.prepare('SELECT * FROM rule_proposals WHERE id = ?').get(id))
/** One unsynthesized feedback for a user, so that `feedback propose` has evidence. */
function feedbackFor(s, owner, account = null) {
  return s.sql((d) => Number(d.prepare(`INSERT INTO learnings(created_at, text, source, account_id, owner_user_id) VALUES ('2026-01-01T00:00:00Z', 'x', 'reject', ?, ?)`).run(account, owner).lastInsertRowid))
}
const propose = (owner, text, evidence, ...more) => testing.handleTool({ argv: ['feedback', 'propose', '--text', text, '--evidence', String(evidence), ...more], files: {}, owner })

test('propose with automatic acceptance on (default): applied at once, to the right scope; off: waits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-rules-'))
  try {
    const s = studio(dir)
    const e1 = feedbackFor(s, 'user-1', 1); const e2 = feedbackFor(s, 'user-1'); const e3 = feedbackFor(s, 'user-1')
    s.sql((d) => d.exec(`INSERT INTO user_settings(owner_user_id, key, value, updated_at) VALUES ('user-1', 'rules', 'Hand written rule.', 'x')`))

    const g = await propose('user-1', 'Open with the result.', e2)
    assert.equal(g.code, 0, g.err)
    assert.match(g.out, /^rule #1 applied automatically \(the user can revoke it in Settings › Learning\)/)
    assert.equal(rulesOf(s), 'Hand written rule.\nOpen with the result.')
    const r1 = row(s, 1)
    assert.deepEqual([r1.status, r1.decision_note, !!r1.decided_at], ['accepted', 'auto', true])

    const a = await propose('user-1', 'Keep it short.', e1, '--account', '1')
    assert.match(a.out, /rule #2 applied automatically/)
    assert.equal(accountRules(s), 'Keep it short.')
    assert.equal(rulesOf(s), 'Hand written rule.\nOpen with the result.', 'an account rule leaves the user rules alone')

    // off for this user: the proposal waits, nothing is written
    await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { rules_auto_accept: '0' } } })
    const w = await propose('user-1', 'Another rule.', e3)
    assert.match(w.out, /^proposal #3 saved/)
    assert.equal(row(s, 3).status, 'proposed')
    assert.equal(rulesOf(s), 'Hand written rule.\nOpen with the result.')
    // a proposal made before the update stays waiting, and accepting it by hand still works
    const acc = await s.call('POST /rules/:id/accept', { params: { id: '3' }, body: {} })
    assert.equal(acc.status, 200)
    assert.equal(row(s, 3).decision_note, null)
    assert.match(rulesOf(s), /Another rule\.$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('revoke: exact line removed, other lines kept, revoked, never twice, never a non-accepted rule', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-rules-'))
  try {
    const s = studio(dir)
    const e = [feedbackFor(s, 'user-1'), feedbackFor(s, 'user-1'), feedbackFor(s, 'user-1')]
    s.sql((d) => d.exec(`INSERT INTO user_settings(owner_user_id, key, value, updated_at) VALUES ('user-1', 'rules', 'Hand written rule.\nShort.', 'x')`))
    await propose('user-1', 'Short', e[0]); await propose('user-1', 'Rule B.', e[1])
    assert.equal(rulesOf(s), 'Hand written rule.\nShort.\nShort\nRule B.')

    const rv = await s.call('POST /rules/:id/revoke', { params: { id: '1' }, body: { note: 'too strict' } })
    assert.deepEqual([rv.status, rv.json.ok, rv.json.line_found], [200, true, true])
    assert.equal(rulesOf(s), 'Hand written rule.\nShort.\nRule B.', 'only the exact line of the rule, not the similar hand-written one')
    const r1 = row(s, 1)
    assert.deepEqual([r1.status, r1.decision_note], ['revoked', 'too strict'])
    const twice = await s.call('POST /rules/:id/revoke', { params: { id: '1' }, body: {} })
    assert.equal(twice.status >= 400, true)

    // a rule still proposed cannot be revoked
    s.sql((d) => d.exec(`INSERT INTO rule_proposals(id, created_at, text, owner_user_id) VALUES (9, '2026-01-01T00:00:00Z', 'Waiting.', 'user-1')`))
    assert.equal((await s.call('POST /rules/:id/revoke', { params: { id: '9' }, body: {} })).status >= 400, true)
    assert.equal(row(s, 9).status, 'proposed')

    // line edited by hand since: still revoked, and said so
    s.sql((d) => d.exec(`UPDATE user_settings SET value = 'Rule B, reworded.' WHERE key = 'rules' AND owner_user_id = 'user-1'`))
    const gone = await s.call('POST /rules/:id/revoke', { params: { id: '2' }, body: {} })
    assert.equal(gone.json.line_found, false)
    assert.match(gone.json.warning, /edited by hand/)
    assert.equal(row(s, 2).status, 'revoked')
    assert.equal(rulesOf(s), 'Rule B, reworded.')

    // never proposed again: listed with the refused ones, absent from the shared rules of the feedback context
    const pending = await testing.handleTool({ argv: ['feedback', 'pending'], files: {}, owner: 'user-1' })
    assert.match(pending.out, /never propose a refused or revoked rule again[\s\S]*\[revoked\] Rule B\./)
    const ctx = await testing.handleTool({ argv: ['feedback', 'context'], files: {}, owner: 'user-1' })
    assert.doesNotMatch(ctx.out, /Accepted rules[\s\S]*Rule B\./)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('multi-user: the setting of one user does not touch the proposals of another; a foreign rule is a 404', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-rules-'))
  try {
    const s = studio(dir)
    const e1 = feedbackFor(s, 'user-1'); const e2 = feedbackFor(s, 'user-2')
    s.as(U2)
    await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'global', id: '0' }, body: { changes: { rules_auto_accept: '0' } } })
    s.as(U1)
    const p1 = await propose('user-1', 'Rule of Ada.', e1)
    assert.match(p1.out, /applied automatically/, 'the other user turning it off changes nothing for user-1')
    const p2 = await propose('user-2', 'Rule of Grace.', e2)
    assert.match(p2.out, /^proposal #2 saved/)
    assert.equal(rulesOf(s, 'user-2'), '')
    assert.equal(rulesOf(s, 'user-1'), 'Rule of Ada.')

    s.as(U2)
    const foreign = await s.call('POST /rules/:id/revoke', { params: { id: '1' }, body: {} })
    assert.equal(foreign.status, 404)
    assert.equal(row(s, 1).status, 'accepted')
    assert.equal(rulesOf(s, 'user-1'), 'Rule of Ada.')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
