// One-off import of an existing growth.db (project layout: state/growth.db + state/media) into the plugin storage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dataPaths, migrate } from '../lib/db.js'
import { importDatabase, rewriteMediaPath, tableCounts } from '../lib/import.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

/** A project-like source: state/growth.db with the structure of a project database (the shipped schema v20 without
 *  studio_requests, which such a database may lack) + demo data,
 *  left in WAL mode with uncheckpointed writes, and a state/media folder. Returns { dir, source, db } (db stays open). */
function projectSource(dir, { withStudioRequests = false } = {}) {
  const state = path.join(dir, 'project', 'state')
  mkdirSync(path.join(state, 'media'), { recursive: true })
  const source = path.join(state, 'growth.db')
  const db = new DatabaseSync(source)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
  db.exec('DROP TABLE studio_requests')
  db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
  if (withStudioRequests) {
    db.exec(`CREATE TABLE studio_requests (id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id), kind TEXT NOT NULL, brief TEXT NOT NULL,
      mission_id TEXT, status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL, account_id INTEGER)`)
    db.exec(`INSERT INTO studio_requests(post_id, kind, brief, mission_id, created_at) VALUES (1, 'image', 'code', 'm-1', '2026-01-06T09:40:00Z')`)
  }
  db.exec(`UPDATE posts SET media = '[{"type":"image","path":"state/media/1.png","alt":"demo"},{"type":"image","path":"state/media/gone.png","alt":"lost"}]' WHERE id = 1`)
  db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'rules', 'Written after the last checkpoint', '2026-01-07T00:00:00Z')`)
  writeFileSync(path.join(state, 'media', '1.png'), 'png-bytes')
  writeFileSync(path.join(state, 'media', 'orphan.png'), 'orphan')
  return { source, db }
}

test('rewriteMediaPath moves legacy paths under media/ and keeps the others', () => {
  assert.equal(rewriteMediaPath('state/media/12.png'), 'media/12.png')
  assert.equal(rewriteMediaPath('./state/media/12.png'), 'media/12.png')
  assert.equal(rewriteMediaPath('media/12.png'), 'media/12.png')
  assert.equal(rewriteMediaPath('elsewhere/12.png'), 'elsewhere/12.png')
})

test('import copies every row, rewrites media paths, copies media and leaves the source untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-import-'))
  try {
    const { source, db: live } = projectSource(dir, { withStudioRequests: true })
    const before = tableCounts(live)
    const hashes = [source, `${source}-wal`].map(sha)
    const storageDir = path.join(dir, 'plugins-data')
    const r = importDatabase({ source, storageDir })

    assert.equal(r.target, path.join(storageDir, 'growth.db'))
    assert.equal(r.backup, null)
    for (const [table, n] of Object.entries(before)) assert.deepEqual(r.counts[table], { source: n, target: n }, table)
    assert.equal(r.media.copied, 2)
    assert.equal(r.media.rewritten_posts, 1)
    assert.deepEqual(r.media.missing, [{ post_id: 1, path: 'media/gone.png' }])
    assert.deepEqual([source, `${source}-wal`].map(sha), hashes, 'the source must not change')

    const out = new DatabaseSync(r.target, { readOnly: true })
    assert.equal(Number(out.prepare('PRAGMA user_version').get().user_version), 22)
    assert.equal(JSON.parse(out.prepare('SELECT media FROM posts WHERE id = 1').get().media)[0].path, 'media/1.png')
    assert.equal(out.prepare("SELECT value FROM scoped_settings WHERE key = 'rules'").get().value, 'Written after the last checkpoint')
    assert.equal(out.prepare('SELECT mission_id FROM studio_requests').get().mission_id, 'm-1')
    out.close()
    assert.equal(readFileSync(path.join(storageDir, 'media', '1.png'), 'utf8'), 'png-bytes')
    assert.deepEqual(readdirSync(storageDir).filter((f) => f.includes('.import-')), [], 'no temporary file left')

    // the plugin now uses its own database, and the media path resolves inside its storage
    const p = dataPaths({ storageDir, legacyDbPath: source })
    assert.equal(p.source, 'plugin')
    assert.equal(p.fallback, false)

    // a second import keeps the previous plugin database as a backup
    const again = importDatabase({ source, storageDir })
    assert.ok(again.backup && existsSync(again.backup))
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a source without studio_requests gets the table, and a wrong version or a foreign file is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-import-'))
  try {
    const { source, db } = projectSource(dir)
    db.close()
    const storageDir = path.join(dir, 'plugins-data')
    const r = importDatabase({ source, storageDir })
    assert.equal(r.counts.studio_requests, undefined)
    const out = new DatabaseSync(r.target, { readOnly: true })
    assert.equal(out.prepare('SELECT COUNT(*) AS n FROM studio_requests').get().n, 0)
    out.close()

    const old = path.join(dir, 'old.db')
    const o = new DatabaseSync(old); o.exec('CREATE TABLE posts (id INTEGER); PRAGMA user_version = 19;'); o.close()
    assert.throws(() => importDatabase({ source: old, storageDir }), /unsupported schema version 19/)
    const foreign = path.join(dir, 'foreign.db')
    const f = new DatabaseSync(foreign); f.exec('CREATE TABLE t (id INTEGER); PRAGMA user_version = 20;'); f.close()
    assert.throws(() => importDatabase({ source: foreign, storageDir }), /not a Growth Studio database/)
    assert.throws(() => importDatabase({ source: 'relative.db', storageDir }), /absolute path/)
    assert.throws(() => importDatabase({ source: r.target, storageDir }), /already the plugin database/)
    assert.deepEqual(readdirSync(storageDir).filter((x) => x.includes('.import-')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migrations shipped after v20 are applied to the imported copy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-import-'))
  try {
    const { source, db } = projectSource(dir)
    db.close()
    const migrationsDir = path.join(dir, 'migrations')
    mkdirSync(migrationsDir)
    writeFileSync(path.join(migrationsDir, '021-demo.sql'), '-- phase: expand\nALTER TABLE posts ADD COLUMN demo TEXT;')
    const r = importDatabase({ source, storageDir: path.join(dir, 'plugins-data'), migrationsDir })
    assert.deepEqual(r.migrations, { from: 20, to: 21, applied: [21] })
    const out = new DatabaseSync(r.target, { readOnly: true })
    assert.ok(out.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'demo'))
    out.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('migrate on a fresh plugin database matches what an import produces', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  assert.ok(Object.keys(tableCounts(db)).includes('studio_requests'))
})
