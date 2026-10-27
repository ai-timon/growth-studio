// Weekly synthesis job (replaces an external weekly routine): once a week, for each user who has feedback not
// synthesized yet (rejections, rewrite requests, direct edits), ONE mission reads it with `feedback pending` and
// proposes rules (`feedback propose`) that the user accepts or refuses in Settings › Learning. No rule is installed
// by the job or the mission. Global settings: synthesis_weekday (0 = Sunday … 6, default 0), synthesis_hour (0-23,
// default 19), in publish_tz. State key: synthesis_last_at (the slot of the last pass).
import { resolve } from '../accounts.js'
import { tzOffsetMs } from '../schedule.js'
import { getGlobal, setGlobal, utc } from './util.js'

const NUM = (v, d, min, max) => { const n = Number(v); return v !== null && v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : d }

/** Last weekly slot (weekday at hour:00, local time in `tz`) at or before `now`, as a Date. */
export function lastSlot(now, tz, weekday, hour) {
  const off = tzOffsetMs(now, tz || 'UTC')
  const local = new Date(now.getTime() + off)   // wall clock read with getUTC*
  const back = (local.getUTCDay() - weekday + 7) % 7
  const slot = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back, hour))
  if (slot.getTime() > local.getTime()) slot.setUTCDate(slot.getUTCDate() - 7)
  return new Date(slot.getTime() - tzOffsetMs(slot, tz || 'UTC'))
}

/** Feedback not synthesized yet, per user (the owner of the account, or of the row when it has no account). */
export function pendingByOwner(db) {
  return db.prepare(`SELECT COALESCE(a.owner_user_id, l.owner_user_id) AS owner, COUNT(*) AS n
    FROM learnings l LEFT JOIN accounts a ON a.id = l.account_id
    WHERE l.ignored = 0 AND l.source IN ('reject','rewrite','edit') AND l.synthesized_at IS NULL
      AND COALESCE(a.owner_user_id, l.owner_user_id) IS NOT NULL
    GROUP BY 1 ORDER BY 1`).all()
}

/**
 * One pass. `deps` = { db, spawnSynthesis(owner, count) -> mission id, now: Date, force }.
 * Due once per weekly slot; `force` runs it at once (the slot is still recorded, so the same week does not run twice).
 */
export async function pollSynthesis({ db, spawnSynthesis, now = new Date(), force = false }) {
  const tz = resolve(db, 'global', 0, 'publish_tz').value || 'UTC'
  const slot = lastSlot(now, tz, NUM(getGlobal(db, 'synthesis_weekday'), 0, 0, 6), NUM(getGlobal(db, 'synthesis_hour'), 19, 0, 23))
  const last = getGlobal(db, 'synthesis_last_at')
  if (!force && last && new Date(last).getTime() >= slot.getTime()) return { state: 'not-due', message: 'not due yet' }
  // a first switch-on does not run at once for a slot that passed days ago: it waits for the next one
  if (!force && !last && now.getTime() - slot.getTime() > 12 * 3_600_000) { setGlobal(db, 'synthesis_last_at', utc(slot)); return { state: 'not-due', message: 'waiting for the next weekly slot' } }
  setGlobal(db, 'synthesis_last_at', utc(force ? now : slot))
  const owners = pendingByOwner(db)
  if (!owners.length) return { state: 'ok', message: 'no feedback to synthesize' }
  const done = []; const errors = []
  for (const { owner, n } of owners) {
    try { done.push(`${n} feedback item(s): mission ${await spawnSynthesis(owner, n)}`) } catch (e) { errors.push(`${owner}: ${e.message}`) }
  }
  return { state: errors.length ? 'error' : 'ok', message: [...done, ...errors.map((e) => `not started (${e})`)].join('; ') }
}
