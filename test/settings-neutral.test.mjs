// Volet 5: editorial content in settings, neutral defaults (acting user, no fallback account, time zone, voice sync).
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { apply } from '../lib/index.js'
import { MISSION_DEFAULTS, SETTING_KEYS, importVoice, saveScoped, saveVoice, voiceStatus } from '../lib/accounts.js'
import { SCHEDULE_DEFAULTS, systemTimeZone } from '../lib/schedule.js'
import { requireInstruction } from '../lib/briefs.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = () => readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
const demo = () => readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')

/** A started studio on a fresh plugin database with the demo data, missions captured. */
function studio(dir, { user = { id: 'u1', name: 'Ada Lovelace', is_superadmin: true } } = {}) {
  const storageDir = path.join(dir, 'plugins-data')
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const spawned = []
  const settings = { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: 'acme.writer' }
  const ctx = {
    permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {} } },
    settings: { get: (k) => settings[k] },
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
  db.exec(demo())
  db.exec(`UPDATE organizations SET owner_user_id = 'u1'; UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned'`)
  db.close()
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  const sql = (fn) => { const d = new DatabaseSync(file); try { return fn(d) } finally { d.close() } }
  return { call, spawned, sql, setUser: (u) => { user = u } }
}

test('validating records the signed-in Timon user, and nothing is validated without one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-neutral-'))
  try {
    const s = studio(dir)
    s.setUser(undefined)
    const refused = await s.call('POST /posts/:id/approve', { params: { id: '1' }, body: { schedule: 'none' } })
    assert.equal(refused.status, 401)
    assert.match(refused.json.error, /no signed-in Timon user/)
    assert.equal(s.sql((d) => d.prepare('SELECT status FROM posts WHERE id = 1').get().status), 'pending_validation')

    s.setUser({ id: 'u1', email: 'ada@example.com', is_superadmin: false })
    const ok = await s.call('POST /posts/:id/approve', { params: { id: '1' }, body: { schedule: 'none' } })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.equal(s.sql((d) => d.prepare('SELECT validated_by FROM posts WHERE id = 1').get().validated_by), 'ada@example.com')

    s.setUser({ id: 'u1', name: 'Ada Lovelace' })
    assert.equal((await s.call('POST /items/:id/verdict', { params: { id: '2' }, body: { verdict: 'keep' } })).status, 200)
    assert.equal(s.sql((d) => d.prepare('SELECT assessed_by FROM assessments WHERE item_id = 2').get().assessed_by), 'Ada Lovelace')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('no fallback account: /next-slot and a draft from an item need an explicit managed account', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-neutral-'))
  try {
    const s = studio(dir)
    assert.equal((await s.call('GET /next-slot', { query: {} })).status, 400)
    assert.equal((await s.call('GET /next-slot', { query: { account: '99' } })).status, 404)
    assert.equal((await s.call('GET /next-slot', { query: { account: '2' } })).status, 404, 'a watched account is not a managed one')
    const ok = await s.call('GET /next-slot', { query: { account: '1' } })
    assert.equal(ok.status, 200)
    assert.match(ok.json.at, /^\d{4}-\d\d-\d\dT/)
    const draft = await s.call('POST /items/:id/draft', { params: { id: '1' }, body: {} })
    assert.equal(draft.status, 400)
    assert.match(draft.json.error, /account_id required/)
    assert.equal(s.spawned.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mission instructions come from the settings cascade (default, organization, account)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-neutral-'))
  try {
    const s = studio(dir)
    const brief = async (route, opts) => { const r = await s.call(route, opts); assert.equal(r.status, 200, JSON.stringify(r.json)); return s.spawned[s.spawned.length - 1].mission }
    const rewrite = () => brief('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'rewrite', text: 'shorter' } })
    assert.ok((await rewrite()).includes(MISSION_DEFAULTS.rewrite_prompt))
    s.sql((d) => saveScoped(d, 'organization', 1, { rewrite_prompt: 'ORG REWRITE RULE' }))
    assert.ok((await rewrite()).includes('ORG REWRITE RULE'))
    s.sql((d) => saveScoped(d, 'account', 1, { rewrite_prompt: 'ACCOUNT REWRITE RULE' }))
    const r = await rewrite()
    assert.ok(r.includes('ACCOUNT REWRITE RULE') && !r.includes('ORG REWRITE RULE') && r.includes('"shorter"'))

    s.sql((d) => saveScoped(d, 'account', 1, { image_instruction_gpt: 'SQUARE PHOTO', image_instruction_code: 'MONOCHROME CHART' }))
    const gpt = await brief('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'image', engine: 'gpt-image' } })
    assert.ok(gpt.includes('SQUARE PHOTO') && gpt.includes('attach-media 1') && !gpt.includes('16:9'))
    const code = await brief('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'image', engine: 'code' } })
    assert.ok(code.includes('MONOCHROME CHART') && code.includes('render-html 1'))

    assert.ok((await brief('POST /ask', { body: { text: 'hello' } })).includes(MISSION_DEFAULTS.ask_prompt))
    s.sql((d) => saveScoped(d, 'account', 1, { ask_prompt: 'ACCOUNT ASK RULE' }))
    assert.ok((await brief('POST /ask', { body: { text: 'hello', account_id: 1 } })).includes('ACCOUNT ASK RULE'))
    assert.ok((await brief('POST /posts/:id/ask', { params: { id: '1' }, body: { kind: 'custom', text: 'check' } })).includes('ACCOUNT ASK RULE'))
    assert.equal((await s.call('POST /ask', { body: { text: 'hello', account_id: 99 } })).status, 404)

    assert.throws(() => requireInstruction('  ', 'The rewrite instruction'), /The rewrite instruction is empty: fill it in Settings › Writing/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('defaults are neutral: no person, path, locale or zone; the time zone defaults to the system one', () => {
  for (const [k, m] of Object.entries(SETTING_KEYS)) {
    // publish_tz: its default is computed from the machine (checked below), not written in the code
    const text = `${m.label} ${k === 'publish_tz' ? '' : m.default ?? ''}`
    assert.doesNotMatch(text, /\/home\/|\/Users\/|brain|Obsidian|Europe\/|fr-FR|Claude|Codex/, k)
  }
  assert.equal(SCHEDULE_DEFAULTS.publish_tz, systemTimeZone())
  assert.equal(SETTING_KEYS.publish_tz.default, systemTimeZone())
  assert.equal(SETTING_KEYS.voice_sync.default, '0')
  assert.equal(SETTING_KEYS.voice_sync_dir.default, '')
  assert.equal(SETTING_KEYS.brain_vault, undefined)
})

test('voice guide sync is off by default: nothing outside the database is read or written until it is turned on', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-neutral-'))
  try {
    const notes = path.join(dir, 'notes'); mkdirSync(notes)
    const db = new DatabaseSync(':memory:')
    db.exec(schema()); migrate(db); db.exec(demo())
    saveScoped(db, 'account', 1, { voice_note: 'voice.md' })
    writeFileSync(path.join(notes, 'voice.md'), 'from the note')

    assert.deepEqual(voiceStatus(db, 'account', 1), { note: 'voice.md', sync: false, exists: false, noteChanged: false, dbChanged: false, synced: false })
    assert.deepEqual(saveVoice(db, 'account', 1, 'kept in the studio'), { wrote: false })
    assert.equal(readFileSync(path.join(notes, 'voice.md'), 'utf8'), 'from the note', 'the note is untouched')
    assert.throws(() => importVoice(db, 'account', 1), /voice guide sync is off/)

    saveScoped(db, 'global', 0, { voice_sync: '1' })
    assert.equal(voiceStatus(db, 'account', 1).sync, false, 'on without a folder is still off')
    assert.throws(() => saveScoped(db, 'global', 0, { voice_sync_dir: 'relative/notes' }), /absolute path/)
    saveScoped(db, 'global', 0, { voice_sync_dir: notes })
    const st = voiceStatus(db, 'account', 1)
    assert.equal(st.sync, true); assert.equal(st.exists, true); assert.equal(st.noteChanged, true)
    assert.equal(importVoice(db, 'account', 1), 'from the note')
    assert.deepEqual(saveVoice(db, 'account', 1, 'written back'), { wrote: true })
    assert.equal(readFileSync(path.join(notes, 'voice.md'), 'utf8'), 'written back')
    assert.equal(voiceStatus(db, 'account', 1).synced, true)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
