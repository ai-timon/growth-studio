// Automatic scheduling of a validated post that has no date, shared by the host half and the agent tools:
// - daily publication window (default 08:00–22:00, in the `publish_tz` time zone, default: the system's);
// - a new post goes AFTER the last post (scheduled or published) of the same account that day, with a random gap
//   between `publish_gap_min` and `publish_gap_max` minutes; never in a hole between two posts;
// - no post that day and inside the window: right away;
// - past the end of the window: the next day, same rule; the first post of a day goes at the start of the window
//   ± `publish_start_jitter_min` minutes (no fixed time, so that posts look like real ones);
// - `publish_max_per_day` (optional): past that number of posts in a day, the next day.
// The settings are the account's (cascade account → organization → global, see accounts.js).

/** Time zone of the machine the plugin runs on (the default of `publish_tz`), UTC if it cannot be read. */
export function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export const SCHEDULE_DEFAULTS = {
  publish_tz: systemTimeZone(), publish_window_start: '08:00', publish_window_end: '22:00',
  publish_gap_min: '30', publish_gap_max: '60', publish_start_jitter_min: '15',
}
const HORIZON_DAYS = 60

/** Offset (ms) of a time zone at a given instant, through Intl (no dependency). */
export function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).reduce((acc, p) => (p.type !== 'literal' ? { ...acc, [p.type]: Number(p.value) } : acc), {})
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime()
}
/** UTC instant of a local time (y, m, d, hh, mm) in a time zone. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm))
  return new Date(guess.getTime() - tzOffsetMs(guess, tz))
}
/** Local parts (in the time zone) of an instant. */
export function localParts(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).reduce((acc, x) => (x.type !== 'literal' ? { ...acc, [x.type]: Number(x.value) } : acc), {})
}
export function parseHm(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''))
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/** Scheduling settings read with `get(key)` (value of the database or default), checked. */
export function scheduleConfig(get) {
  const tz = get('publish_tz')
  const start = parseHm(get('publish_window_start')); const end = parseHm(get('publish_window_end'))
  const gapMin = Number(get('publish_gap_min')); const gapMax = Number(get('publish_gap_max')); const jitter = Number(get('publish_start_jitter_min'))
  if (!start || !end || start.h * 60 + start.m >= end.h * 60 + end.m) throw new Error('invalid publishing window (HH:MM, start before end)')
  if (!(gapMin > 0) || !(gapMax >= gapMin)) throw new Error('invalid gap between posts (minimum > 0, maximum >= minimum)')
  if (!(jitter >= 0)) throw new Error('invalid jitter of the first post')
  const maxRaw = String(get('publish_max_per_day') ?? '').trim()
  const maxPerDay = maxRaw === '' || maxRaw === '0' ? Infinity : Number(maxRaw)
  if (!(maxPerDay > 0)) throw new Error('invalid maximum number of posts per day')
  return { tz, start, end, gapMin, gapMax, jitter, maxPerDay }
}

/** Next publishing time (ISO UTC, without milliseconds) of a post without a date for `accountId`.
 *  `random` can be injected for tests. */
export function nextFreeSlot(db, accountId, get, { now = new Date(), random = Math.random } = {}) {
  const c = scheduleConfig(get)
  const between = (lo, hi) => lo + random() * (hi - lo)
  // A published post holds the time it really went out, not its old slot (case of #23, 2026-10-21).
  const taken = db.prepare(`SELECT CASE WHEN status = 'published' THEN COALESCE(published_at, scheduled_for) ELSE scheduled_for END AS t
    FROM posts WHERE account_id = ? AND status IN ('scheduled','published') AND COALESCE(published_at, scheduled_for) IS NOT NULL`).all(accountId)
    .map((r) => new Date(r.t).getTime()).filter(Number.isFinite)
  const t0 = now.getTime()
  const today = localParts(now, c.tz)
  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + d, 12))
    const ymd = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]
    const next = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] + 1, 12))
    const dayFrom = zonedToUtc(...ymd, 0, 0, c.tz).getTime()
    const dayTo = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, c.tz).getTime()
    const winStart = zonedToUtc(...ymd, c.start.h, c.start.m, c.tz).getTime()
    const winEnd = zonedToUtc(...ymd, c.end.h, c.end.m, c.tz).getTime()
    const inDay = taken.filter((t) => t >= dayFrom && t < dayTo)
    if (inDay.length >= c.maxPerDay) continue   // daily quota reached for this account
    const last = inDay.length ? Math.max(...inDay) : null
    let at
    if (last != null) at = Math.max(last + between(c.gapMin, c.gapMax) * 60_000, winStart, t0)
    else if (d === 0 && t0 >= winStart - c.jitter * 60_000 && t0 <= winEnd) at = t0   // nothing today, inside the window: right away
    else at = Math.max(winStart + between(-c.jitter, c.jitter) * 60_000, t0)
    if (at <= winEnd) return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return null
}
