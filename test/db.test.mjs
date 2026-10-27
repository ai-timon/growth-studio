// Plugin database: shipped schema, versioned migrations, choice of the database file, demo seed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS_DIR, SCHEMA_FILE, dataPaths, listMigrations, migrate, resolveMedia } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDb = path.join(root, 'db')
const tmp = () => mkdtempSync(path.join(tmpdir(), 'gs-db-'))
const version = (db) => Number(db.prepare('PRAGMA user_version').get().user_version)

test('an empty database receives the shipped schema at version 20 then the shipped migrations, once', () => {
  const db = new DatabaseSync(':memory:')
  const r = migrate(db)
  assert.deepEqual(r, { from: 0, to: 22, applied: [20, 21, 22] })
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'studio_requests'").get())
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'user_settings'").get())
  assert.deepEqual(migrate(db), { from: 22, to: 22, applied: [] })
  db.close()
})

test('migrations above the version are applied in order, each atomically', () => {
  const dir = tmp()
  try {
    const migrations = path.join(dir, 'migrations')
    mkdirSync(migrations)
    writeFileSync(path.join(migrations, '021-first.sql'), '-- phase: expand\nALTER TABLE posts ADD COLUMN demo_a TEXT;')
    writeFileSync(path.join(migrations, '022-second.sql'), '-- phase: expand\nCREATE TABLE demo_b (id INTEGER PRIMARY KEY);')
    writeFileSync(path.join(migrations, 'notes.txt'), 'ignored')
    assert.deepEqual(listMigrations(migrations).map((m) => m.version), [21, 22])
    const db = new DatabaseSync(':memory:')
    assert.deepEqual(migrate(db, { migrationsDir: migrations }).applied, [20, 21, 22])
    assert.equal(version(db), 22)
    assert.deepEqual(migrate(db, { migrationsDir: migrations }).applied, [])

    // a failing migration leaves the database at the previous version, without its partial changes
    writeFileSync(path.join(migrations, '023-broken.sql'), '-- phase: expand\nCREATE TABLE demo_c (id INTEGER); SELECT * FROM no_such_table;')
    assert.throws(() => migrate(db, { migrationsDir: migrations }), /023-broken\.sql failed.*stays at version 22/)
    assert.equal(version(db), 22)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'demo_c'").get(), undefined)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an old or foreign database is refused, an empty legacy file is never filled', () => {
  const old = new DatabaseSync(':memory:')
  old.exec('CREATE TABLE posts (id INTEGER); PRAGMA user_version = 19;')
  assert.throws(() => migrate(old), /version 19 is too old/)
  assert.throws(() => migrate(new DatabaseSync(':memory:'), { allowCreate: false }), /not allowed/)
})

test('the package starts at version 20 and ships its migrations from 021', () => {
  assert.deepEqual(listMigrations(MIGRATIONS_DIR).map((m) => m.version), [21, 22])
  assert.match(readFileSync(SCHEMA_FILE, 'utf8'), /PRAGMA user_version = 20;\s*$/)
})

test('dataPaths picks the plugin storage, the legacy file, or falls back while the plugin has no database', () => {
  const dir = tmp()
  try {
    const storageDir = path.join(dir, 'plugins-data')
    const legacyDbPath = path.join(dir, 'project', 'state', 'growth.db')
    const plugin = dataPaths({ storageDir, legacyDbPath })
    assert.deepEqual(plugin, { source: 'plugin', db: path.join(storageDir, 'growth.db'), base: storageDir, mediaDir: path.join(storageDir, 'media'), fallback: false })

    const legacy = dataPaths({ storageDir, dataSource: 'legacy', legacyDbPath })
    assert.deepEqual(legacy, { source: 'legacy', db: legacyDbPath, base: path.join(dir, 'project'), mediaDir: path.join(dir, 'project', 'state', 'media'), fallback: false })

    // the legacy file exists and the plugin has no database yet: keep using the legacy file
    mkdirSync(path.dirname(legacyDbPath), { recursive: true })
    writeFileSync(legacyDbPath, '')
    assert.equal(dataPaths({ storageDir, legacyDbPath }).fallback, true)
    assert.equal(dataPaths({ storageDir, legacyDbPath }).db, legacyDbPath)
    // once the plugin has its own database (after an import), it wins
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(path.join(storageDir, 'growth.db'), '')
    assert.equal(dataPaths({ storageDir, legacyDbPath }).source, 'plugin')
    assert.equal(dataPaths({ storageDir, dataSource: 'nonsense', legacyDbPath }).source, 'plugin')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('media paths are confined to the media folder of the data source', () => {
  const plugin = { base: '/data/gs', mediaDir: '/data/gs/media' }
  assert.equal(resolveMedia(plugin, 'media/12.png'), '/data/gs/media/12.png')
  assert.equal(resolveMedia(plugin, 'media-evil/12.png'), null)
  assert.equal(resolveMedia(plugin, 'media/../growth.db'), null)
  assert.equal(resolveMedia(plugin, '/etc/passwd'), null)
  assert.equal(resolveMedia(plugin, ''), null)
  const legacy = { base: '/p', mediaDir: '/p/state/media' }
  assert.equal(resolveMedia(legacy, 'state/media/3.png'), '/p/state/media/3.png')
  assert.equal(resolveMedia(legacy, 'media/3.png'), null)
})

test('the demo seed loads on the shipped schema and holds no real data', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.exec(readFileSync(path.join(pluginDb, 'demo-seed.sql'), 'utf8'))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE relation = 'owned'").get().n, 1)
  assert.equal(db.prepare("SELECT status FROM posts WHERE id = 2").get().status, 'published')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  const files = readdirSync(pluginDb, { recursive: true }).map(String).filter((f) => /\.(sql|md)$/.test(f))
  assert.ok(files.length >= 3)
  for (const f of files) {
    const text = readFileSync(path.join(pluginDb, f), 'utf8')
    assert.doesNotMatch(text, /\/home\/|\/Users\//, f)
  }
  assert.ok(!readdirSync(pluginDb).includes('seed.sql'), 'the private seed must never be shipped')
})
