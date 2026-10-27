// Small helpers shared by the background jobs (bookmarks, watch).
import { tzOffsetMs } from '../schedule.js'

/** ISO timestamp without milliseconds, as everywhere in the database. */
export const utc = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const ageMin = (ts, now) => (now.getTime() - new Date(ts).getTime()) / 60_000
/** Minutes since local midnight in `tz`. */
export function minutesIn(now, tz) {
  const local = new Date(now.getTime() + tzOffsetMs(now, tz || 'UTC'))
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}
/** Start of the current UTC day (budgets and daily caps count from there, as the scripts did). */
export const utcDayStart = (now) => `${now.toISOString().slice(0, 10)}T00:00:00Z`

/** Internal state keys live in the global `settings` table (not described in accounts.js). */
export function getGlobal(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return r && r.value !== '' ? String(r.value) : null
}
export function setGlobal(db, key, value) {
  if (value == null) db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  else db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(key, String(value))
}
