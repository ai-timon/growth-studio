// One-off import of an existing growth.db (a project folder's state/growth.db, schema version 20 or later) into the plugin's storage.
// The whole file is copied (VACUUM INTO, which also captures a WAL that was not checkpointed yet) rather than
// re-inserted table by table: ids, triggers, settings at every level, feedback, rule proposals… nothing is lost.
// Nothing replaces the plugin's database until every check passed; the source is only ever opened read-only.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { DB_FILE, MEDIA_DIR, MIGRATIONS_DIR, SCHEMA_VERSION, knownVersion, migrate } from './db.js'

const LEGACY_MEDIA_PREFIX = 'state/media/'

const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** Row count of every table of an open database: { table: n }. */
export function tableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM ${quoteId(name)}`).get().n]))
}

/** Rewrites a legacy media path (`state/media/x.png`) to the plugin layout (`media/x.png`); other paths are kept. */
export function rewriteMediaPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
  return s.startsWith(LEGACY_MEDIA_PREFIX) ? `${MEDIA_DIR}/${s.slice(LEGACY_MEDIA_PREFIX.length)}` : p
}

function removeDbFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) rmSync(f, { force: true })
}

/**
 * Imports `source` (a growth.db at schema version 20) into `storageDir`.
 * - media files are copied from `mediaDir` (default: the `media` folder next to the source, i.e. `state/media`) to
 *   `<storageDir>/media`, and `posts.media[].path` is rewritten from `state/media/…` to `media/…`;
 * - the plugin's migrations (> 20) are applied to the copy, which must pass `integrity_check` and
 *   `foreign_key_check` and hold exactly as many rows as the source, table by table;
 * - an existing plugin database is kept as `growth.db.bak-<timestamp>`.
 * Returns a report: { source, target, backup, counts: { table: { source, target } }, media: {...}, migrations }.
 */
export function importDatabase({ source, storageDir, mediaDir = null, migrationsDir, schemaFile } = {}) {
  if (!source || !path.isAbsolute(String(source))) throw new Error('give the absolute path of the growth.db to import')
  if (!storageDir) throw new Error('plugin storage folder unavailable')
  const src = path.resolve(String(source))
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`file not found: ${src}`)
  const target = path.join(storageDir, DB_FILE)
  if (src === path.resolve(target)) throw new Error('this file is already the plugin database')
  mkdirSync(storageDir, { recursive: true })

  // 1. Read the source (read-only) and copy it whole into a temporary file of the storage folder.
  const tmp = path.join(storageDir, `${DB_FILE}.import-${process.pid}-${Date.now()}`)
  let sourceCounts
  const s = new DatabaseSync(src, { readOnly: true })
  try {
    s.exec('PRAGMA busy_timeout = 5000')
    const version = Number(s.prepare('PRAGMA user_version').get().user_version)
    // version 20, or a later one this plugin knows (a project database the plugin already served and migrated)
    const known = knownVersion(migrationsDir || MIGRATIONS_DIR)
    if (version < SCHEMA_VERSION || version > known) throw new Error(`unsupported schema version ${version}: this import expects a database of version ${SCHEMA_VERSION} to ${known}`)
    for (const t of ['posts', 'accounts', 'settings', 'scoped_settings']) {
      if (!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) throw new Error(`not a Growth Studio database (table ${t} missing)`)
    }
    sourceCounts = tableCounts(s)
    s.exec(`VACUUM INTO ${sqlString(tmp)}`)
  } catch (e) {
    removeDbFiles(tmp)
    throw e
  } finally { s.close() }

  try {
    // 2. Bring the copy to the plugin's schema, check it, compare the counts.
    const db = new DatabaseSync(tmp)
    let report
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const migrations = migrate(db, { migrationsDir, schemaFile, allowCreate: false })
      const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0])
      if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`integrity check failed: ${integrity.slice(0, 5).join('; ')}`)
      const fk = db.prepare('PRAGMA foreign_key_check').all()
      if (fk.length) throw new Error(`foreign key check failed (${fk.length} rows, e.g. table ${fk[0].table} rowid ${fk[0].rowid})`)
      const targetCounts = tableCounts(db)
      const counts = {}
      const mismatches = []
      for (const [table, n] of Object.entries(sourceCounts)) {
        counts[table] = { source: n, target: targetCounts[table] ?? null }
        if (targetCounts[table] !== n) mismatches.push(`${table}: ${n} → ${targetCounts[table] ?? 'missing'}`)
      }
      if (mismatches.length) throw new Error(`row counts differ after import: ${mismatches.join(', ')}`)

      // 3. Media: copy the files, rewrite the paths stored in posts.media.
      const media = copyMedia(db, { from: mediaDir || path.join(path.dirname(src), MEDIA_DIR), to: path.join(storageDir, MEDIA_DIR) })
      db.exec('PRAGMA journal_mode = DELETE')
      report = { migrations, counts, media }
    } finally { db.close() }

    // 4. Swap: keep the previous plugin database, then move the copy in place.
    let backup = null
    if (existsSync(target)) {
      const old = new DatabaseSync(target)
      try { old.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { old.close() }
      backup = `${target}.bak-${stamp()}`
      renameSync(target, backup)
      rmSync(`${target}-wal`, { force: true }); rmSync(`${target}-shm`, { force: true })
    }
    renameSync(tmp, target)
    return { source: src, target, backup, ...report }
  } catch (e) {
    removeDbFiles(tmp)
    throw e
  }
}

/** Copies the media files referenced by posts.media (and every other file of the folder) and rewrites the paths. */
function copyMedia(db, { from, to }) {
  mkdirSync(to, { recursive: true })
  let copied = 0
  if (existsSync(from)) {
    for (const name of readdirSync(from)) {
      const f = path.join(from, name)
      if (!statSync(f).isFile()) continue
      copyFileSync(f, path.join(to, name))
      copied++
    }
  }
  const missing = []
  let rewritten = 0
  const update = db.prepare('UPDATE posts SET media = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const row of db.prepare("SELECT id, media FROM posts WHERE media IS NOT NULL AND media NOT IN ('', '[]')").all()) {
      let list
      try { list = JSON.parse(row.media) } catch { continue }
      if (!Array.isArray(list)) continue
      let changed = false
      for (const m of list) {
        if (!m || !m.path) continue
        const next = rewriteMediaPath(m.path)
        if (next !== m.path) { m.path = next; changed = true }
        if (!existsSync(path.join(path.dirname(to), String(m.path)))) missing.push({ post_id: row.id, path: m.path })
      }
      if (changed) { update.run(JSON.stringify(list), row.id); rewritten++ }
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { from, to, copied, rewritten_posts: rewritten, missing }
}
