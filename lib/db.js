// Growth Studio database: shipped schema, versioned migrations, and the choice of the database file.
// The schema (db/schema.sql) is the consolidated version 20; every later change ships as
// db/migrations/NNN-<name>.sql (NNN >= 021), applied once, in order, checked, in one transaction (migrations/README.md).
// Backups, the "migration in progress" marker and the startup decision live in lib/upgrade.js.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 20
export const SCHEMA_FILE = fileURLToPath(new URL('../db/schema.sql', import.meta.url))
export const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url))
export const DB_FILE = 'growth.db'
export const MEDIA_DIR = 'media'
export const DATA_SOURCES = ['plugin', 'legacy']

/**
 * Database of the project folder this plugin was developed in (`<project>/state/growth.db`, the plugin sitting in
 * `<project>/plugin/growth-studio`), found relative to this package. A packaged install has no such file.
 * Transition only (until the switch to the plugin's own storage); see dataPaths().
 */
export const LEGACY_DEFAULT_DB = fileURLToPath(new URL('../../../state/growth.db', import.meta.url))

/**
 * Migrations shipped in `dir`, sorted: [{ version, file, steps }]. Files must be named NNN-<name>.sql; an optional
 * NNN-<name>.steps.json next to it holds the non-SQL steps of that version (see applySteps and migrations/README.md).
 */
export function listMigrations(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
  return names
    .map((file) => ({ file, m: /^(\d{3,})-([\w.-]+)\.sql$/.exec(file) }))
    .filter((x) => x.m)
    .map((x) => {
      const steps = `${x.m[1]}-${x.m[2]}.steps.json`
      return { version: Number(x.m[1]), file: path.join(dir, x.file), steps: names.includes(steps) ? path.join(dir, steps) : null }
    })
    .sort((a, b) => a.version - b.version)
}

/** Highest schema version this code knows: the shipped schema or the last shipped migration. */
export function knownVersion(dir = MIGRATIONS_DIR) {
  const list = listMigrations(dir)
  return list.length ? Math.max(SCHEMA_VERSION, list[list.length - 1].version) : SCHEMA_VERSION
}

// ---------- expand / contract ----------
// A migration declares its phase on a line `-- phase: expand` or `-- phase: contract`. An `expand` migration only
// adds (tables, columns, copies of data, renamed copies of settings); whatever it replaces stays in place until a
// `contract` migration of a later version removes it. So an older plugin, or a rollback to the backup, never meets a
// database where something it reads has disappeared.
export const PHASES = ['expand', 'contract']
const FORBIDDEN_IN_EXPAND = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
  [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
  [/\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, 'ALTER TABLE … RENAME'],
]

/** SQL without its comments and string literals (so a word in a comment or a message never counts). */
export function stripSql(sql) {
  // one left-to-right pass: an apostrophe inside a comment does not open a string, `--` inside a string is no comment
  return String(sql).replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "'" ? "''" : ' '))
}

/** The phase a migration declares, or null. */
export const migrationPhase = (sql) => (/^\s*--\s*phase:\s*(\w+)\s*$/im.exec(String(sql)) || [])[1]?.toLowerCase() || null

/**
 * Checks a migration against the expand/contract rule; throws with the reason. `steps` is its parsed .steps.json.
 * - the phase is declared and known;
 * - an `expand` migration drops no table or column and renames nothing (DROP VIEW / TRIGGER / INDEX stay allowed:
 *   they hold no data and are needed to recreate those objects), and its steps only copy, never remove;
 * - a migration never sets user_version itself.
 */
export function checkMigration(sql, steps = null, name = 'migration') {
  const phase = migrationPhase(sql)
  if (!PHASES.includes(phase)) throw new Error(`${name}: declare its phase on a line "-- phase: expand" or "-- phase: contract"`)
  const code = stripSql(sql)
  if (/\bPRAGMA\s+user_version\b/i.test(code)) throw new Error(`${name}: must not set user_version (the plugin does)`)
  if (phase === 'expand') {
    for (const [re, what] of FORBIDDEN_IN_EXPAND) {
      if (re.test(code)) throw new Error(`${name}: ${what} is not allowed in an expand migration; add and copy now, remove in a later contract migration`)
    }
    for (const k of ['settings', 'kv']) {
      if (steps && steps[k] && Array.isArray(steps[k].remove) && steps[k].remove.length) throw new Error(`${name}: an expand migration copies ${k} keys, it never removes them`)
    }
  }
  return phase
}

const readSteps = (m) => {
  if (!m.steps) return null
  try { return JSON.parse(readFileSync(m.steps, 'utf8')) } catch (e) { throw new Error(`${path.basename(m.steps)} is not valid JSON: ${e.message}`) }
}

// ---------- checks ----------
/** `PRAGMA integrity_check` lines other than "ok". */
export function integrityProblems(db) {
  const rows = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]))
  return rows.length === 1 && rows[0] === 'ok' ? [] : rows
}
const fkKey = (r) => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`
/** Foreign key violations, as keys "table|rowid|parent|fkid". */
export const fkViolations = (db) => db.prepare('PRAGMA foreign_key_check').all().map(fkKey)

// ---------- non-SQL steps of a migration (inside its transaction) ----------
/**
 * Applies the database part of a .steps.json, inside the migration's transaction:
 * - `settings.copy {old: new}`: copies a settings key (global `settings` and every `scoped_settings` row) to its new
 *   name, unless the new one already exists; `settings.remove [old]` (contract only) deletes the old key;
 * - `media.rewrite [{from, to}]`: rewrites the prefix of the paths stored in posts.media and copies the files to
 *   their new place (the old files stay; a contract migration may stop using them, never this one). Paths are
 *   confined to the media folder (`paths` = { base, mediaDir }, required when there is something to rewrite).
 * `kv` steps live outside the database: the host applies them after the commit (applyKvSteps).
 * Returns { settings, media: { rewritten, copied, missing } }.
 */
export function applySteps(db, steps, { paths = null } = {}) {
  const out = { settings: 0, media: { rewritten: 0, copied: 0, missing: [] } }
  if (!steps) return out
  const s = steps.settings || {}
  for (const [from, to] of Object.entries(s.copy || {})) {
    out.settings += Number(db.prepare('INSERT OR IGNORE INTO settings(key, value) SELECT ?, value FROM settings WHERE key = ?').run(to, from).changes)
    out.settings += Number(db.prepare(`INSERT OR IGNORE INTO scoped_settings(scope, scope_id, key, value, updated_at)
      SELECT scope, scope_id, ?, value, updated_at FROM scoped_settings WHERE key = ?`).run(to, from).changes)
  }
  for (const key of s.remove || []) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    db.prepare('DELETE FROM scoped_settings WHERE key = ?').run(key)
  }
  const rules = (steps.media && steps.media.rewrite) || []
  if (rules.length) {
    if (!paths || !paths.base || !paths.mediaDir) throw new Error('media steps need the data folder')
    const update = db.prepare('UPDATE posts SET media = ? WHERE id = ?')
    for (const row of db.prepare("SELECT id, media FROM posts WHERE media IS NOT NULL AND media NOT IN ('', '[]')").all()) {
      let list
      try { list = JSON.parse(row.media) } catch { continue }
      if (!Array.isArray(list)) continue
      let changed = false
      for (const m of list) {
        if (!m || typeof m.path !== 'string') continue
        const rule = rules.find((r) => m.path.startsWith(r.from))
        if (!rule) continue
        const next = rule.to + m.path.slice(rule.from.length)
        const src = resolveMedia(paths, m.path)
        const dst = resolveMedia(paths, next)
        if (!dst) throw new Error(`media rewrite leaves the media folder: ${next}`)
        if (src && existsSync(src)) {
          if (!existsSync(dst)) { mkdirSync(path.dirname(dst), { recursive: true }); copyFileSync(src, dst); out.media.copied++ }
        } else out.media.missing.push({ post_id: row.id, path: m.path })
        m.path = next
        changed = true
      }
      if (changed) { update.run(JSON.stringify(list), row.id); out.media.rewritten++ }
    }
  }
  return out
}

/**
 * Applies the `kv` steps of every migration up to `version`, in order, to the plugin's key-value store (async API of
 * ctx.storage.kv). Idempotent, so it runs at every start: `copy {old: new}` only fills a new key that is absent,
 * `remove [old]` (contract) deletes. Returns the number of keys written or removed.
 */
export async function applyKvSteps(kv, version, dir = MIGRATIONS_DIR) {
  let n = 0
  if (!kv) return n
  for (const m of listMigrations(dir)) {
    if (m.version > version) break
    const k = (readSteps(m) || {}).kv
    if (!k) continue
    for (const [from, to] of Object.entries(k.copy || {})) {
      const old = await kv.get(from)
      if (old !== undefined && (await kv.get(to)) === undefined) { await kv.set(to, old); n++ }
    }
    for (const key of k.remove || []) { if ((await kv.get(key)) !== undefined) { await kv.del(key); n++ } }
  }
  return n
}

// A project database at version 20 may predate this table, which older studios created on the fly.
const STUDIO_REQUESTS = `CREATE TABLE IF NOT EXISTS studio_requests (
  id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id), kind TEXT NOT NULL, brief TEXT NOT NULL,
  mission_id TEXT, status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL,
  account_id INTEGER)`
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

const userTables = (db) => db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { fn(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
}

/** A database written by a newer plugin: this code must not touch it. */
export class NewerDatabaseError extends Error {
  constructor(version, known) {
    super(`database v${version}, plugin knows v${known}`)
    this.code = 'newer'; this.version = version; this.known = known
  }
}
/** A migration that failed (SQL error or failed check): the database is back at `from`, untouched. */
export class MigrationError extends Error {
  constructor(message, { from, file }) { super(message); this.code = 'migration'; this.from = from; this.file = file }
}

/** Reads the version of a database file without writing anything (read-only connection). */
export function readVersion(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return { version: Number(db.prepare('PRAGMA user_version').get().user_version), tables: userTables(db) }
  } finally { db.close() }
}

/** Migrations `migrate` would apply to a database at `version`. */
export const pendingMigrations = (version, dir = MIGRATIONS_DIR) => listMigrations(dir).filter((m) => m.version > version)

/**
 * Brings an open database to the latest version. An empty database receives the shipped schema; a database at
 * version >= 20 receives the migrations above its version. A database newer than this code is refused before
 * anything is written (NewerDatabaseError): there is no downward migration.
 * The pending migrations run in ONE transaction, foreign keys off (so a table rebuild works), each followed by
 * `integrity_check` and `foreign_key_check` (only violations that did not exist before count). Any failure rolls
 * the whole update back: the database stays at `from`, never half migrated (MigrationError).
 * `allowCreate: false` refuses to create the schema (legacy file); `paths` serves the media steps.
 * Returns { from, to, applied: [versions] }.
 */
/** Reference rows a new database starts with: the networks an account can be on (a blank studio needs them to create
 *  its first account). An existing database keeps its own. */
export const REFERENCE_DATA = `INSERT OR IGNORE INTO networks(id, name) VALUES
  ('x', 'X'), ('linkedin', 'LinkedIn'), ('reddit', 'Reddit'), ('youtube', 'YouTube'), ('hn', 'Hacker News');`
export function migrate(db, { schemaFile = SCHEMA_FILE, migrationsDir = MIGRATIONS_DIR, allowCreate = true, paths = null } = {}) {
  const from = Number(db.prepare('PRAGMA user_version').get().user_version)
  const known = knownVersion(migrationsDir)
  if (from > known) throw new NewerDatabaseError(from, known)
  const applied = []
  let version = from
  if (version === 0 && userTables(db) === 0) {
    if (!allowCreate) throw new Error('database is empty and creating the schema is not allowed here')
    inTransaction(db, () => { db.exec(readFileSync(schemaFile, 'utf8')); db.exec(REFERENCE_DATA) })
    version = Number(db.prepare('PRAGMA user_version').get().user_version)
    applied.push(version)
  } else if (version < SCHEMA_VERSION) {
    throw new Error(`database schema version ${version} is too old (expected ${SCHEMA_VERSION} or later)`)
  } else if (!hasTable(db, 'studio_requests')) {
    inTransaction(db, () => db.exec(STUDIO_REQUESTS))
  }
  const pending = pendingMigrations(version, migrationsDir).map((m) => {
    const sql = readFileSync(m.file, 'utf8')
    const steps = readSteps(m)
    checkMigration(sql, steps, path.basename(m.file))
    return { ...m, sql, steps }
  })
  if (pending.length) {
    const start = version
    const broken = integrityProblems(db)
    if (broken.length) throw new MigrationError(`database damaged before migrating (${broken.slice(0, 3).join('; ')}): nothing was changed`, { from: start, file: null })
    const before = new Set(fkViolations(db))
    db.exec('PRAGMA foreign_keys = OFF')
    let current = null
    try {
      inTransaction(db, () => {
        for (const m of pending) {
          current = path.basename(m.file)
          db.exec(m.sql)
          applySteps(db, m.steps, { paths })
          const problems = integrityProblems(db)
          if (problems.length) throw new Error(`integrity check failed: ${problems.slice(0, 3).join('; ')}`)
          const fresh = fkViolations(db).filter((k) => !before.has(k))
          if (fresh.length) throw new Error(`foreign key check failed (${fresh.length} rows, e.g. ${fresh[0].split('|').slice(0, 2).join(' rowid ')})`)
          db.exec(`PRAGMA user_version = ${m.version}`)
        }
      })
    } catch (e) {
      throw new MigrationError(`migration ${current} failed: ${e.message}; the database stays at version ${start}`, { from: start, file: current })
    } finally { db.exec('PRAGMA foreign_keys = ON') }
    for (const m of pending) applied.push(m.version)
    version = pending[pending.length - 1].version
  }
  db.exec('PRAGMA foreign_keys = ON')
  return { from, to: version, applied }
}

/** Opens a database with the studio's connection settings (WAL, busy timeout). */
export function openDatabase(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  if (!readOnly) db.exec('PRAGMA journal_mode = WAL')
  return db
}

/**
 * Where the data lives. The single place that picks the database file.
 * - `plugin` (default): `<storage.dir>/growth.db`, media in `<storage.dir>/media`, media paths stored as `media/<file>`.
 * - `legacy` (transition): a project folder's `state/growth.db` (`legacyDbPath`, or the file found next to
 *   this package), media in `state/media`, paths stored relative to the project folder (`state/media/<file>`).
 * Safety net while the transition lasts: in `plugin` mode, as long as the plugin has no database of its own and the
 * legacy file exists, the legacy file is used (`fallback: true`), so an install that ran on the project's database
 * keeps its data until an import creates the plugin's database.
 * Returns { source, db, base, mediaDir, fallback } — `base` resolves the relative paths stored in posts.media.
 */
export function dataPaths({ storageDir, dataSource = 'plugin', legacyDbPath = '' } = {}) {
  const mode = DATA_SOURCES.includes(dataSource) ? dataSource : 'plugin'
  const legacyFile = legacyDbPath ? path.resolve(String(legacyDbPath)) : LEGACY_DEFAULT_DB
  const legacy = (fallback) => {
    const stateDir = path.dirname(legacyFile)
    return { source: 'legacy', db: legacyFile, base: path.dirname(stateDir), mediaDir: path.join(stateDir, MEDIA_DIR), fallback }
  }
  if (mode === 'legacy') return legacy(false)
  if (!storageDir) throw new Error('plugin storage folder unavailable')
  const own = path.join(storageDir, DB_FILE)
  if (!existsSync(own) && existsSync(legacyFile)) return legacy(true)
  return { source: 'plugin', db: own, base: storageDir, mediaDir: path.join(storageDir, MEDIA_DIR), fallback: false }
}

/**
 * Resolves a media path stored in posts.media against the data folder and confines it to the media folder.
 * Returns the absolute file path, or null when the path escapes the media folder.
 */
export function resolveMedia(paths, rel) {
  if (!rel) return null
  const f = path.resolve(paths.base, String(rel))
  return f.startsWith(paths.mediaDir + path.sep) ? f : null
}
