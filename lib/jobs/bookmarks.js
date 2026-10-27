// Bookmarks job (replaces the former bookmarks polling script): without any model, fetches the first page of X bookmarks of
// each managed X account whose "bookmarks" source is on and whose x.com cookie secret is set, keeps the ones not yet
// in the database (items, ignored_items) in the staging file, and starts ONE triage mission at a time when some are
// waiting. Global settings: bookmarks_poll_interval_min (0 = stopped), bookmarks_window_start / _end (in publish_tz).
// GetXAPI 401: one alert until the next successful fetch, no new attempt before the next interval.
// State keys are the script's (ingest_runs source 'bookmark', settings bookmarks_triage_spawned_at and
// getxapi_auth_alert_at, staging.json next to the media folder), so the switch from the script resumes where it stopped.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { getterFor, resolve } from '../accounts.js'
import { stagingFile } from '../agent-tools.js'
import { ageMin, getGlobal, minutesIn, setGlobal, utc } from './util.js'

export const BOOKMARK_PAGE_COST = 0.001
export const TRIAGE_RESPAWN_MIN = 30   // a triage still running is not started again before this delay

const xDate = (s) => { const d = new Date(String(s || '')); return Number.isNaN(d.getTime()) ? null : utc(d) }

/** Managed X accounts whose bookmarks are fetched. */
export function bookmarkOwners(db) {
  return db.prepare(`SELECT id, handle, owner_user_id FROM accounts WHERE relation = 'owned' AND network = 'x' ORDER BY id`).all()
    .filter((a) => resolve(db, 'account', a.id, 'source_bookmarks').value === '1')
    .map((a) => ({ ...a, tokenSecret: resolve(db, 'account', a.id, 'getxapi_token_secret').value }))
    .filter((a) => a.tokenSecret)
}

export function readStaging(paths) {
  const f = stagingFile(paths)
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')) || {} } catch { return {} }
}
function writeStaging(paths, staged) {
  const f = stagingFile(paths)
  writeFileSync(`${f}.tmp`, JSON.stringify(staged))
  renameSync(`${f}.tmp`, f)
}

/** One bookmark as the staging file keeps it (same shape as the former polling script, plus the owner account). */
export function stageEntry(t, ownerId) {
  const a = t.author || {}
  return {
    id: String(t.id), url: t.url || null, text: t.text || null, lang: t.lang || null,
    kind: ({ tweet: 'post' })[t.type] || t.type || 'post', posted_at: xDate(t.createdAt),
    likes: t.likeCount ?? null, views: t.viewCount ?? null, replies: t.replyCount ?? null, shares: t.retweetCount ?? null, saves: t.bookmarkCount ?? null,
    quoted: (t.quoted_tweet || {}).id || null, media: t.media || null,
    author: { handle: a.userName || null, external_id: a.id || null, name: a.name || null, followers: a.followers ?? null, following: a.following ?? null },
    owner_account_id: ownerId,
  }
}

/**
 * One pass. `deps` = { db, paths, getxapi, spawnTriage(owner, count) -> mission id, notify, now: Date, force }.
 * Returns a short summary (what happened), for the job status and the log.
 */
export async function pollBookmarks({ db, paths, getxapi, spawnTriage, notify, now = new Date(), force = false }) {
  const get = getterFor(db, null)
  const interval = Number(get('bookmarks_poll_interval_min')) || 0
  if (interval <= 0 && !force) return { state: 'stopped', message: 'bookmarks fetch stopped (interval 0)' }
  const tz = get('publish_tz')
  if (!force) {
    const cur = minutesIn(now, tz)
    const [a, b] = [get('bookmarks_window_start'), get('bookmarks_window_end')].map((s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0) })
    if (!(a < b ? a <= cur && cur < b : cur >= a || cur < b)) return { state: 'outside', message: 'outside the fetch window' }
  }
  const owners = bookmarkOwners(db)
  if (!owners.length) return { state: 'idle', message: 'no managed X account with the bookmarks source on and an x.com cookie secret' }
  const known = new Set([
    ...db.prepare(`SELECT external_id FROM items WHERE network = 'x'`).all().map((r) => String(r.external_id)),
    ...db.prepare(`SELECT external_id FROM ignored_items WHERE network = 'x'`).all().map((r) => String(r.external_id)),
  ])
  const staged = readStaging(paths)
  let fetched = 0; let fresh = 0; let authFailed = false; const errors = []
  for (const owner of owners) {
    const last = db.prepare(`SELECT MAX(started_at) AS t FROM ingest_runs WHERE source = 'bookmark' AND account_id = ?`).get(owner.id).t
    if (!force && last && ageMin(last, now) < interval) continue
    try {
      const data = await getxapi.bookmarks(owner.tokenSecret)
      let n = 0
      for (const t of (data && data.bookmarks) || []) {
        const tid = String(t.id)
        if (known.has(tid) || staged[tid]) continue
        staged[tid] = stageEntry(t, owner.id); n++
      }
      writeStaging(paths, staged)
      db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd) VALUES ('bookmark', ?, ?, 1, ?, ?)`).run(owner.id, utc(now), n, BOOKMARK_PAGE_COST)
      fetched++; fresh += n
    } catch (e) {
      db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status, error) VALUES ('bookmark', ?, ?, 0, 0, 0, 'error', ?)`).run(owner.id, utc(now), String(e.message).slice(0, 300))
      errors.push(`@${owner.handle}: ${e.message}`)
      if (e.auth) { authFailed = true; break }   // the key is shared: no point trying the other accounts
    }
  }
  if (authFailed) {
    if (!getGlobal(db, 'getxapi_auth_alert_at')) {   // one alert until the next successful fetch
      notify.alert('Bookmarks fetch stopped: GetXAPI refuses the access (401)',
        'The x.com cookie or the GetXAPI key is no longer valid: no bookmark is fetched until it is fixed.', { urgent: true })
      setGlobal(db, 'getxapi_auth_alert_at', utc(now))
    }
    return { state: 'error', message: errors.join('; ') }
  }
  if (fetched && getGlobal(db, 'getxapi_auth_alert_at')) setGlobal(db, 'getxapi_auth_alert_at', null)
  if (!fetched && !errors.length) return { state: 'not-due', message: 'not due yet' }
  const waiting = Object.values(staged)
  if (!waiting.length) { setGlobal(db, 'bookmarks_triage_spawned_at', null); return { state: 'ok', message: `${fresh} new, nothing to triage${errors.length ? `; ${errors.join('; ')}` : ''}` } }
  const spawned = getGlobal(db, 'bookmarks_triage_spawned_at')
  // one triage at a time (it rewrites the staging file): new ones wait for its end or for the respawn delay
  if (spawned && ageMin(spawned, now) < TRIAGE_RESPAWN_MIN) return { state: 'ok', message: `${fresh} new, ${waiting.length} waiting, triage already started` }
  // the owner of the oldest waiting bookmark (entries from the script have no owner: first account fetched)
  const ownerId = waiting.map((t) => t.owner_account_id).find(Boolean) || owners[0].id
  const owner = owners.find((o) => o.id === ownerId) || owners[0]
  const count = waiting.filter((t) => (t.owner_account_id || owners[0].id) === owner.id).length
  setGlobal(db, 'bookmarks_triage_spawned_at', utc(now))
  try {
    const mission = await spawnTriage(owner, count)
    return { state: 'ok', message: `${fresh} new, ${waiting.length} waiting, triage started for @${owner.handle} (${mission})` }
  } catch (e) {
    return { state: 'error', message: `${fresh} new, ${waiting.length} waiting, triage not started: ${e.message} (next try in ${TRIAGE_RESPAWN_MIN} min)` }
  }
}
