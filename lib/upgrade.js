// Updating the plugin without losing data: what happens to the database when the plugin starts.
// - Nothing to migrate: nothing is written, no backup.
// - Migrations pending: a marker file says "migration in progress" (the agent CLI refuses to write meanwhile), the
//   database is copied (VACUUM INTO growth.db.bak-v<from>-<date> in the plugin storage, the last N kept), then the
//   migrations run in one checked transaction (lib/db.js, migrate). A failure leaves the database at its version and
//   the studio read-only, with the backup's path.
// - Database newer than this code (an older plugin reinstalled): nothing is written, no job runs, the UI says which
//   version to install. There is no downward migration.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, MIGRATIONS_DIR, NewerDatabaseError, SCHEMA_FILE, knownVersion, migrate, openDatabase, pendingMigrations, readVersion } from './db.js'

export const BACKUPS_KEEP_DEFAULT = 5
const BACKUP_RE = new RegExp(`^${DB_FILE.replace(/\./g, '\\.')}\\.bak-v(\\d+)-(\\d{8}T\\d{6}Z)(?:-(\\d+))?$`)

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`

/** The "migration in progress" marker of a database file. */
export const markerOf = (file) => `${file}.migrating`
/** Contents of the marker ({ from, to, pid, at }), or null when no migration is running. */
export function readMarker(file) {
  const m = markerOf(file)
  if (!existsSync(m)) return null
  try { return JSON.parse(readFileSync(m, 'utf8')) } catch { return { at: null } }
}

/** Migration backups of a folder, oldest first: [{ name, file, version }]. Import backups (bak-<date>) are not ours. */
export function listBackups(dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_RE.exec(name) }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m[2] + (a.m[3] || '').padStart(4, '0')).localeCompare(b.m[2] + (b.m[3] || '').padStart(4, '0')))
    .map((x) => ({ name: x.name, file: path.join(dir, x.name), version: Number(x.m[1]) }))
}

/** Keeps the `keep` most recent migration backups of `dir`; returns the removed files. */
export function pruneBackups(dir, keep = BACKUPS_KEEP_DEFAULT) {
  const n = Math.max(1, Math.floor(Number(keep)) || BACKUPS_KEEP_DEFAULT)
  const list = listBackups(dir)
  const gone = list.slice(0, Math.max(0, list.length - n)).map((b) => b.file)
  for (const f of gone) rmSync(f, { force: true })
  return gone
}

/** Copies the database (WAL included) to `<dir>/growth.db.bak-v<version>-<date>`; returns the backup's path. */
export function backupDatabase(file, dir, version) {
  let target = path.join(dir, `${DB_FILE}.bak-v${version}-${stamp()}`)
  for (let i = 1; existsSync(target); i++) target = path.join(dir, `${DB_FILE}.bak-v${version}-${stamp()}-${i}`)
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`VACUUM INTO ${sqlString(target)}`)
  } catch (e) {
    rmSync(target, { force: true })
    throw e
  } finally { db.close() }
  return target
}

/**
 * Brings the database file to this code's version, safely (see the header). Never throws for a newer database or a
 * failed migration: it returns the state the studio must take.
 * Returns { state: 'ok' | 'newer' | 'failed', from, to, known, applied, backup, error, pruned }.
 */
export function upgradeDatabase(file, {
  backupDir, keep = BACKUPS_KEEP_DEFAULT, allowCreate = true,
  migrationsDir = MIGRATIONS_DIR, schemaFile = SCHEMA_FILE, paths = null,
} = {}) {
  const known = knownVersion(migrationsDir)
  // only the plugin migrates, and only here: a marker left by a crash (its transaction was rolled back) is stale
  rmSync(markerOf(file), { force: true })
  const base = { known, applied: [], backup: null, error: null, pruned: [] }
  const run = () => {
    const db = openDatabase(file)
    try { return migrate(db, { migrationsDir, schemaFile, allowCreate, paths }) } finally { db.close() }
  }
  if (!existsSync(file)) {
    if (!allowCreate) throw new Error(`database not found: ${file}`)
    const r = run()
    return { ...base, state: 'ok', from: r.from, to: r.to, applied: r.applied }
  }
  const { version, tables } = readVersion(file)
  if (version > known) return { ...base, state: 'newer', from: version, to: version, error: new NewerDatabaseError(version, known).message }
  const pending = version === 0 && tables === 0 ? [] : pendingMigrations(version, migrationsDir)
  if (!pending.length) {
    const r = run()   // a fresh database receives the schema; an up-to-date one is left alone
    return { ...base, state: 'ok', from: r.from, to: r.to, applied: r.applied }
  }
  const to = pending[pending.length - 1].version
  writeFileSync(markerOf(file), JSON.stringify({ from: version, to, pid: process.pid, at: new Date().toISOString() }))
  try {
    let backup
    try {
      backup = backupDatabase(file, backupDir || path.dirname(file), version)
    } catch (e) {
      return { ...base, state: 'failed', from: version, to: version, error: `backup before migrating failed (${e.message}): nothing was migrated` }
    }
    const pruned = pruneBackups(backupDir || path.dirname(file), keep)
    try {
      const r = run()
      return { ...base, state: 'ok', from: r.from, to: r.to, applied: r.applied, backup, pruned }
    } catch (e) {
      return { ...base, state: 'failed', from: version, to: version, backup, pruned, error: e.message }
    }
  } finally { rmSync(markerOf(file), { force: true }) }
}

/**
 * Why the agent tools may not write to this database right now, or null. Used by the CLI on a database file
 * (`--db`) and by the plugin before running a tool that writes.
 */
export function writeRefusal(file, { migrationsDir = MIGRATIONS_DIR, cliKnows = null } = {}) {
  const marker = readMarker(file)
  if (marker) return `Growth Studio is migrating its database${marker.at ? ` (since ${marker.at})` : ''}: nothing was written, try again in a minute.`
  if (!existsSync(file)) return null
  const { version } = readVersion(file)
  const known = Math.min(knownVersion(migrationsDir), cliKnows ?? Infinity)
  if (version > known) return `database v${version}, these tools know v${known}: nothing was written. Update Growth Studio, then run the command again.`
  return null
}
