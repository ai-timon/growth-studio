// Updating the plugin without losing data: backup before migrating, checks after each migration, read-only state on
// failure, refusal of a newer database, expand/contract rule, fixtures of every shipped version, CLI guard, steps
// for settings, kv and media.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS_DIR, NewerDatabaseError, SCHEMA_VERSION, applyKvSteps, checkMigration, knownVersion, listMigrations, migrate,
} from '../lib/db.js'
import { listBackups, markerOf, pruneBackups, upgradeDatabase, writeRefusal } from '../lib/upgrade.js'
import { tableCounts } from '../lib/import.js'
import { apply, testing } from '../lib/index.js'
import { spoolDir } from '../lib/spool.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(root, 'test', 'fixtures')
const CLI = path.join(root, 'bin', 'studio.mjs')
const tmp = () => mkdtempSync(path.join(tmpdir(), 'gs-up-'))
const version = (file) => { const d = new DatabaseSync(file, { readOnly: true }); try { return Number(d.prepare('PRAGMA user_version').get().user_version) } finally { d.close() } }
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const hasColumn = (file, table, col) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col) !== undefined } finally { d.close() } }

/** A database file built from a frozen fixture (default: v20). */
function fixtureDb(dir, v = 20, name = 'growth.db') {
  const file = path.join(dir, name)
  const db = new DatabaseSync(file)
  db.exec(readFileSync(path.join(FIXTURES, `db-v${v}.sql`), 'utf8'))
  db.close()
  return file
}
/** A migrations folder holding the given files. */
function migrationsDir(dir, files) {
  const m = path.join(dir, `migrations-${Math.random().toString(36).slice(2)}`)
  mkdirSync(m)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(m, name), text)
  return m
}

// ---------- expand / contract rule ----------
test('the expand/contract rule: a declared phase, no DROP TABLE / DROP COLUMN / RENAME in an expand migration', () => {
  assert.throws(() => checkMigration('ALTER TABLE posts ADD COLUMN x TEXT;'), /declare its phase/)
  assert.equal(checkMigration('-- phase: expand\nALTER TABLE posts ADD COLUMN x TEXT;'), 'expand')
  assert.throws(() => checkMigration('-- phase: expand\nDROP TABLE learnings;'), /DROP TABLE is not allowed in an expand migration/)
  assert.throws(() => checkMigration('-- phase: expand\nalter table posts drop column body;'), /DROP COLUMN/)
  assert.throws(() => checkMigration('-- phase: expand\nALTER TABLE posts RENAME COLUMN body TO text;'), /RENAME/)
  assert.throws(() => checkMigration('-- phase: expand\nALTER TABLE posts RENAME TO posts_old;'), /RENAME/)
  // words in comments and strings do not count; views, triggers and indexes may be recreated
  assert.equal(checkMigration("-- phase: expand\n-- we never DROP TABLE here\nUPDATE settings SET value = 'DROP TABLE x' WHERE key = 'k';"), 'expand')
  // an apostrophe in a comment opens no string (it would hide the DROP), and `--` in a string is no comment
  assert.throws(() => checkMigration("-- phase: expand\n-- don't\nDROP TABLE learnings;\nUPDATE settings SET value = 'x';"), /DROP TABLE/)
  assert.equal(checkMigration("-- phase: expand\nUPDATE settings SET value = 'a -- b' WHERE key = 'k'; -- it's fine\nALTER TABLE posts ADD COLUMN y TEXT;"), 'expand')
  assert.equal(checkMigration('-- phase: expand\nDROP TRIGGER IF EXISTS t; DROP VIEW IF EXISTS v; DROP INDEX IF EXISTS i;'), 'expand')
  // a later contract migration may remove what an expand one replaced
  assert.equal(checkMigration('-- phase: contract\nALTER TABLE posts DROP COLUMN demo_old;', { settings: { remove: ['old'] } }), 'contract')
  assert.throws(() => checkMigration('-- phase: expand\nSELECT 1;', { settings: { remove: ['old'] } }), /never removes/)
  assert.throws(() => checkMigration('-- phase: expand\nSELECT 1;', { kv: { remove: ['old'] } }), /never removes/)
  assert.throws(() => checkMigration('-- phase: contract\nPRAGMA user_version = 30;'), /user_version/)
})

test('every shipped migration follows the rule, and the plugin refuses one that does not', () => {
  for (const m of listMigrations(MIGRATIONS_DIR)) {
    const steps = m.steps ? JSON.parse(readFileSync(m.steps, 'utf8')) : null
    assert.doesNotThrow(() => checkMigration(readFileSync(m.file, 'utf8'), steps, path.basename(m.file)))
  }
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const before = sha(file)
    const m = migrationsDir(dir, { '021-drop.sql': '-- phase: expand\nDROP TABLE learnings;' })
    const db = new DatabaseSync(file)
    assert.throws(() => migrate(db, { migrationsDir: m }), /DROP TABLE is not allowed/)
    db.close()
    assert.equal(version(file), 20)
    assert.equal(sha(file), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- fixtures of every shipped version ----------
/** Rows kept to compare before/after: for each table, the first and last rows by rowid (or every row). */
function sample(db) {
  const out = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all()
    out[name] = rows.length > 2 ? [rows[0], rows[rows.length - 1]] : rows
  }
  return out
}
/** Throws when a row of `before` is missing after the update (count per table, chosen rows, old columns only). */
function assertNoLoss(before, after) {
  for (const [table, n] of Object.entries(before.counts)) {
    assert.equal(after.counts[table], n, `table ${table}: ${n} rows before, ${after.counts[table] ?? 'none'} after`)
  }
  for (const [table, rows] of Object.entries(before.rows)) {
    const now = after.rows[table] || []
    rows.forEach((row, i) => {
      for (const [col, v] of Object.entries(row)) assert.deepEqual(now[i] && now[i][col], v, `${table} row ${i} column ${col}`)
    })
  }
}
const snapshot = (file) => { const d = new DatabaseSync(file, { readOnly: true }); try { return { counts: tableCounts(d), rows: sample(d) } } finally { d.close() } }

test('a fixture is frozen for every shipped schema version', () => {
  const versions = [SCHEMA_VERSION, ...listMigrations(MIGRATIONS_DIR).map((m) => m.version)]
  for (const v of versions) assert.ok(existsSync(path.join(FIXTURES, `db-v${v}.sql`)), `test/fixtures/db-v${v}.sql is missing: freeze a sample database of v${v} (db/migrations/README.md)`)
})

test('every fixture migrates to the current version without losing a row', () => {
  const fixtures = readdirSync(FIXTURES).map((f) => /^db-v(\d+)\.sql$/.exec(f)).filter(Boolean).map((m) => Number(m[1]))
  assert.ok(fixtures.includes(20))
  for (const v of fixtures) {
    const dir = tmp()
    try {
      const file = fixtureDb(dir, v)
      const before = snapshot(file)
      for (const [table, n] of Object.entries(before.counts)) assert.ok(n > 0, `fixture v${v}: table ${table} is empty, the count check would prove nothing`)
      const r = upgradeDatabase(file, { backupDir: dir })
      assert.equal(r.state, 'ok', r.error)
      assert.equal(version(file), knownVersion())
      assertNoLoss(before, snapshot(file))
      const d = new DatabaseSync(file, { readOnly: true })
      assert.deepEqual(d.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]), ['ok'])
      assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), [])
      d.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('the no-loss check bites: a migration that deletes rows is caught', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const before = snapshot(file)
    const m = migrationsDir(dir, {
      '021-add.sql': '-- phase: expand\nALTER TABLE posts ADD COLUMN summary TEXT;\nUPDATE posts SET summary = substr(body, 1, 20);',
      '022-loses.sql': '-- phase: expand\nDELETE FROM learnings;',
    })
    assert.equal(upgradeDatabase(file, { backupDir: dir, migrationsDir: m }).state, 'ok')
    assert.ok(hasColumn(file, 'posts', 'summary'))
    assert.throws(() => assertNoLoss(before, snapshot(file)), /table learnings: 1 rows before, 0 after/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- the three cases ----------
test('successful migration: backup of the previous version first, checks pass, no backup when nothing is pending', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const m = migrationsDir(dir, {
      '021-summary.sql': '-- phase: expand\nALTER TABLE posts ADD COLUMN summary TEXT;\nUPDATE posts SET summary = substr(body, 1, 20);',
      '022-tags.sql': '-- phase: expand\nCREATE TABLE post_tags (post_id INTEGER NOT NULL REFERENCES posts(id), tag TEXT NOT NULL);\nINSERT INTO post_tags SELECT id, \'demo\' FROM posts;',
    })
    const before = snapshot(file)
    const r = upgradeDatabase(file, { backupDir: dir, migrationsDir: m })
    assert.equal(r.state, 'ok')
    assert.deepEqual([r.from, r.to, r.applied], [20, 22, [21, 22]])
    assert.match(path.basename(r.backup), /^growth\.db\.bak-v20-\d{8}T\d{6}Z$/)
    assert.equal(version(r.backup), 20)
    assert.equal(snapshot(r.backup).counts.posts, before.counts.posts)
    assert.equal(version(file), 22)
    assertNoLoss(before, snapshot(file))
    assert.ok(!existsSync(markerOf(file)))
    // nothing pending: nothing written, no new backup
    const again = upgradeDatabase(file, { backupDir: dir, migrationsDir: m })
    assert.deepEqual([again.state, again.applied, again.backup], ['ok', [], null])
    assert.equal(listBackups(dir).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('backups: the last N are kept, the import backups are left alone', () => {
  const dir = tmp()
  try {
    const importBackup = path.join(dir, 'growth.db.bak-20260101T000000Z')
    writeFileSync(importBackup, 'import backup')
    for (const v of [20, 21, 22, 23]) writeFileSync(path.join(dir, `growth.db.bak-v${v}-2026010${v - 19}T000000Z`), '')
    const gone = pruneBackups(dir, 2)
    assert.deepEqual(gone.map((f) => path.basename(f)), ['growth.db.bak-v20-20260101T000000Z', 'growth.db.bak-v21-20260102T000000Z'])
    assert.deepEqual(listBackups(dir).map((b) => b.version), [22, 23])
    assert.ok(existsSync(importBackup))

    // through the update itself
    const file = fixtureDb(dir)
    let files = {}
    for (const v of [21, 22, 23]) {
      files = { ...files, [`0${v}-step.sql`]: `-- phase: expand\nCREATE TABLE demo_${v} (id INTEGER);` }
      assert.equal(upgradeDatabase(file, { backupDir: dir, keep: 2, migrationsDir: migrationsDir(dir, files) }).state, 'ok')
    }
    assert.equal(listBackups(dir).length, 2)
    assert.deepEqual(listBackups(dir).map((b) => b.version), [21, 22])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('failed migration: the whole update is rolled back, the backup is there, nothing half migrated', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const before = snapshot(file)
    // 022 breaks a foreign key: the check after it fails (foreign keys are off while migrating, so only the check sees it)
    const m = migrationsDir(dir, {
      '021-ok.sql': '-- phase: expand\nALTER TABLE posts ADD COLUMN summary TEXT;',
      '022-orphan.sql': "-- phase: expand\nINSERT INTO post_items(post_id, item_id) VALUES (999, 1);",
    })
    const r = upgradeDatabase(file, { backupDir: dir, migrationsDir: m })
    assert.equal(r.state, 'failed')
    assert.match(r.error, /migration 022-orphan\.sql failed: foreign key check failed \(1 rows, e\.g\. post_items rowid \d+\); the database stays at version 20/)
    assert.equal(version(file), 20)
    assert.ok(!hasColumn(file, 'posts', 'summary'), '021 must be rolled back with 022')
    assertNoLoss(before, snapshot(file))
    assert.ok(existsSync(r.backup) && version(r.backup) === 20)
    assert.ok(!existsSync(markerOf(file)))

    // an SQL error is handled the same way
    const sqlErr = upgradeDatabase(file, { backupDir: dir, migrationsDir: migrationsDir(dir, { '021-bad.sql': '-- phase: expand\nALTER TABLE no_such_table ADD COLUMN x TEXT;' }) })
    assert.equal(sqlErr.state, 'failed')
    assert.match(sqlErr.error, /021-bad\.sql failed: no such table: no_such_table/)
    assert.equal(version(file), 20)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an old foreign key violation does not block an update; a failed backup stops it before any change', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const d = new DatabaseSync(file)
    d.exec('PRAGMA foreign_keys = OFF'); d.exec('INSERT INTO post_items(post_id, item_id) VALUES (998, 1)'); d.close()
    const m = migrationsDir(dir, { '021-ok.sql': '-- phase: expand\nALTER TABLE posts ADD COLUMN summary TEXT;' })
    const blocked = upgradeDatabase(file, { backupDir: path.join(dir, 'no', 'such', 'folder'), migrationsDir: m })
    assert.equal(blocked.state, 'failed')
    assert.match(blocked.error, /backup before migrating failed .*nothing was migrated/)
    assert.equal(version(file), 20)
    assert.equal(upgradeDatabase(file, { backupDir: dir, migrationsDir: m }).state, 'ok')
    assert.equal(version(file), 21)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('database newer than the code: refused before anything is written, never migrated down', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const d = new DatabaseSync(file); d.exec('PRAGMA journal_mode = DELETE'); d.exec('PRAGMA user_version = 24'); d.close()
    const before = sha(file)
    const r = upgradeDatabase(file, { backupDir: dir })
    assert.deepEqual([r.state, r.from, r.known], ['newer', 24, 23])
    assert.equal(r.error, 'database v24, plugin knows v23')
    assert.equal(sha(file), before)
    assert.deepEqual(readdirSync(dir).sort(), ['growth.db'], 'no backup, no -wal, no marker')
    const db = new DatabaseSync(file, { readOnly: true })
    assert.throws(() => migrate(db), (e) => e instanceof NewerDatabaseError && e.version === 24 && e.known === 23)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- steps: settings, kv, media ----------
test('steps: settings keys copied in expand and removed in contract, media paths rewritten and files copied', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const mediaDir = path.join(dir, 'media')
    mkdirSync(mediaDir)
    writeFileSync(path.join(mediaDir, '2.png'), 'png')
    const d = new DatabaseSync(file)
    d.exec(`UPDATE posts SET media = '[{"type":"image","path":"media/2.png","alt":"demo"}]' WHERE id = 2`)
    d.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'publish_window_start', '10:00', '2026-01-05T09:00:00Z')`)
    d.close()
    const m = migrationsDir(dir, {
      '021-rename.sql': '-- phase: expand\nSELECT 1;',
      '021-rename.steps.json': JSON.stringify({ settings: { copy: { publish_window_start: 'window_start' } }, media: { rewrite: [{ from: 'media/', to: 'media/posts/' }] } }),
    })
    const r = upgradeDatabase(file, { backupDir: dir, migrationsDir: m, paths: { base: dir, mediaDir } })
    assert.equal(r.state, 'ok', r.error)
    let db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'window_start'").get().value, '09:00')
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'publish_window_start'").get().value, '09:00', 'expand keeps the old key')
    assert.equal(db.prepare("SELECT value FROM scoped_settings WHERE key = 'window_start' AND scope_id = 1 AND scope = 'account'").get().value, '10:00')
    assert.equal(JSON.parse(db.prepare('SELECT media FROM posts WHERE id = 2').get().media)[0].path, 'media/posts/2.png')
    db.close()
    assert.ok(existsSync(path.join(mediaDir, 'posts', '2.png')))
    assert.ok(existsSync(path.join(mediaDir, '2.png')), 'the old file stays')

    writeFileSync(path.join(m, '022-drop-old.sql'), '-- phase: contract\nSELECT 1;')
    writeFileSync(path.join(m, '022-drop-old.steps.json'), JSON.stringify({ settings: { remove: ['publish_window_start'] } }))
    assert.equal(upgradeDatabase(file, { backupDir: dir, migrationsDir: m }).state, 'ok')
    db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'publish_window_start'").get().n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scoped_settings WHERE key = 'publish_window_start'").get().n, 0)
    db.close()

    // a rewrite that leaves the media folder rolls the update back
    const evil = upgradeDatabase(fixtureDb(dir, 20, 'other.db'), {
      backupDir: dir, paths: { base: dir, mediaDir },
      migrationsDir: migrationsDir(dir, { '021-evil.sql': '-- phase: expand\nUPDATE posts SET media = \'[{"path":"media/x.png"}]\' WHERE id = 1;', '021-evil.steps.json': JSON.stringify({ media: { rewrite: [{ from: 'media/', to: '../' }] } }) }),
    })
    assert.equal(evil.state, 'failed')
    assert.match(evil.error, /leaves the media folder/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('steps: kv keys copied after the commit, idempotent, removed by a contract migration', async () => {
  const dir = tmp()
  try {
    const store = new Map([['ownerUser', 'u1'], ['kept', 1]])
    const kv = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v) }, del: async (k) => { store.delete(k) } }
    const m = migrationsDir(dir, {
      '021-kv.sql': '-- phase: expand\nSELECT 1;', '021-kv.steps.json': JSON.stringify({ kv: { copy: { ownerUser: 'ownerUserId' } } }),
      '022-kv.sql': '-- phase: contract\nSELECT 1;', '022-kv.steps.json': JSON.stringify({ kv: { remove: ['ownerUser'] } }),
    })
    assert.equal(await applyKvSteps(kv, 21, m), 1)
    assert.deepEqual([store.get('ownerUserId'), store.get('ownerUser')], ['u1', 'u1'])
    assert.equal(await applyKvSteps(kv, 21, m), 0, 'idempotent')
    store.set('ownerUserId', 'u2')
    assert.equal(await applyKvSteps(kv, 22, m), 1)
    assert.deepEqual([store.get('ownerUserId'), store.has('ownerUser'), store.get('kept')], ['u2', false, 1])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- the agent CLI ----------
test('the agent CLI refuses to write to a newer database or during a migration, and still reads', () => {
  const dir = tmp()
  try {
    const file = fixtureDb(dir)
    const cli = (...args) => spawnSync(process.execPath, [CLI, '--db', file, ...args], { encoding: 'utf8' })
    writeFileSync(path.join(dir, 'post.txt'), 'A demo draft.')
    const draft = ['post', 'draft', '--account', 'acme_dev', '--file', path.join(dir, 'post.txt'), '--type', 'valeur', '--image-prompt', 'a desk', '--image-prompt-code', 'a chart']

    writeFileSync(markerOf(file), JSON.stringify({ from: 20, to: 21, at: '2026-10-24T10:00:00.000Z' }))
    let r = cli(...draft)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Growth Studio is migrating its database \(since 2026-10-24T10:00:00.000Z\): nothing was written/)
    rmSync(markerOf(file))

    const d = new DatabaseSync(file); d.exec('PRAGMA user_version = 24'); d.close()
    const posts = snapshot(file).counts.posts
    r = cli(...draft)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /database v24, these tools know v23: nothing was written/)
    assert.equal(snapshot(file).counts.posts, posts)
    r = cli('accounts')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /acme_dev/)

    assert.equal(writeRefusal(file, { cliKnows: 24, migrationsDir: migrationsDir(dir, { '024-x.sql': '-- phase: expand\nSELECT 1;' }) }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- the host half ----------
function fakeCtx(storageDir, { kvData = {}, effects = null } = {}) {
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const kv = new Map(Object.entries(kvData))
  const logs = []
  const spawned = []
  const ctx = {
    permissions: ['settings', 'storage'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(storageDir, 'none', 'growth.db'), agent: 'demo-agent' })[k] },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect(fn) { if (effects) effects.push(fn()) },
    user: () => ({ id: 'u1', is_superadmin: true }),
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
    missions: { spawn: async (o) => { spawned.push(o); return { id: 'm1' } } },
  }
  const call = async (key, { body, params = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query: {}, url: '/' }, res)
    return { status, json }
  }
  return { ctx, call, logs, kv, spawned }
}
const flush = () => new Promise((r) => setTimeout(r, 20))

test('host: a database newer than the plugin is left untouched and the studio turns read-only', async () => {
  const dir = tmp()
  try {
    const storageDir = path.join(dir, 'data')
    mkdirSync(storageDir)
    const file = fixtureDb(storageDir, 21)
    const d = new DatabaseSync(file); d.exec(`UPDATE organizations SET owner_user_id = 'u1'; UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned'`)
    d.exec('PRAGMA journal_mode = DELETE'); d.exec('PRAGMA user_version = 24'); d.close()
    const before = sha(file)
    const effects = []
    const { ctx, call, logs } = fakeCtx(storageDir, { kvData: { schemaWriters: { 20: '0.1.0', 24: '0.4.0' } }, effects })
    apply(ctx)
    await flush()
    try {
      // an agent's write through the spool (what missions use) is refused by the host; its reads are served
      const viaSpool = (...args) => new Promise((resolve) => {
        const p = spawn(process.execPath, [CLI, '--spool', spoolDir(storageDir), '--owner', 'u1', ...args])
        let out = '', err = ''
        p.stdout.on('data', (c) => { out += c }); p.stderr.on('data', (c) => { err += c })
        p.on('close', (code) => resolve({ code, out, err }))
      })
      writeFileSync(path.join(dir, 'post.txt'), 'A demo draft.')
      const w = await viaSpool('post', 'draft', '--account', 'acme_dev', '--file', path.join(dir, 'post.txt'), '--type', 'valeur', '--image-prompt', 'a', '--image-prompt-code', 'b')
      assert.equal(w.code, 1)
      assert.match(w.err, /database v24, plugin knows v23: install Growth Studio v0\.4\.0 or newer/)
      const r = await viaSpool('accounts')
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /acme_dev/)
    } finally { for (const stop of effects) if (typeof stop === 'function') stop() }
    const s = await call('GET /status')
    assert.equal(s.json.mode, 'newer')
    assert.equal(s.json.writable, false)
    assert.match(s.json.message, /^database v24, plugin knows v23: install Growth Studio v0\.4\.0 or newer\. Until then the studio is read-only/)
    assert.ok(logs.some((l) => /database v24, plugin knows v23/.test(l)))
    // reads work, writes and side effects are refused
    assert.equal((await call('GET /overview')).status, 200)
    const approve = await call('POST /posts/:id/approve', { params: { id: '1' }, body: {} })
    assert.equal(approve.status, 400)
    assert.match(approve.json.error, /database v24, plugin knows v23/)
    const publish = await call('POST /posts/:id/publish', { params: { id: '2' }, body: {} })
    assert.equal(publish.status, 400)
    const ask = await call('POST /ask', { body: { text: 'hello' } })
    assert.equal(ask.status, 400)
    assert.equal(sha(file), before)
    assert.deepEqual(readdirSync(storageDir).filter((f) => f.startsWith('growth.db')).sort(), ['growth.db'])
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(spoolDir(path.join(dir, 'data')), { recursive: true, force: true }); testing.migrationsDir = null }
})

test('host: a failed migration leaves the database at its version and the studio read-only with the backup path', async () => {
  const dir = tmp()
  try {
    const storageDir = path.join(dir, 'data')
    mkdirSync(storageDir)
    const file = fixtureDb(storageDir)
    testing.migrationsDir = migrationsDir(dir, { '021-orphan.sql': '-- phase: expand\nINSERT INTO post_items(post_id, item_id) VALUES (999, 1);' })
    const { ctx, call, spawned } = fakeCtx(storageDir)
    apply(ctx)
    const s = (await call('GET /status')).json
    assert.equal(s.mode, 'read-only')
    assert.match(s.message, /^Database update failed: migration 021-orphan\.sql failed: foreign key check failed .*Growth Studio is read-only.*A copy taken before the update is at .*growth\.db\.bak-v20-/)
    assert.ok(existsSync(s.backup))
    assert.equal(version(file), 20)
    assert.equal((await call('GET /overview')).json.data.mode, 'read-only')
    const approve = await call('POST /posts/:id/approve', { params: { id: '1' }, body: {} })
    assert.match(approve.json.error, /Database update failed/)
    assert.equal(spawned.length, 0)

    // a fixed version of the plugin migrates on its next start
    testing.migrationsDir = migrationsDir(dir, { '021-fixed.sql': '-- phase: expand\nALTER TABLE posts ADD COLUMN summary TEXT;' })
    const next = fakeCtx(storageDir)
    apply(next.ctx)
    await flush()
    assert.deepEqual((await next.call('GET /status')).json, { mode: 'ok', writable: true })
    assert.equal(version(file), 21)
    assert.deepEqual(next.kv.get('schemaWriters'), { 21: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version })
    assert.ok(next.logs.some((l) => /at version 21 \(applied: 21; backup .*growth\.db\.bak-v20-/.test(l)))
  } finally { rmSync(dir, { recursive: true, force: true }); testing.migrationsDir = null }
})
