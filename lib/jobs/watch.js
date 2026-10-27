// Watch job (replaces the former watch script): without any model, polls the watched accounts that are due through
// the treg connector, stores their new original posts, and only wakes the agent when a "breaking" account published
// a real news item.
// - priorities breaking / daily / weekly (default intervals 15 min / 1 day / 1 week, or accounts.poll_interval_min),
//   accounts.active_hours ('07-23', in publish_tz);
// - the first poll of an account is a baseline (nothing in it is news);
// - daily budget (global setting daily_budget_usd, shared with `item add`), hard stop beyond it; the cost of each poll
//   goes to ingest_runs;
// - a news item waits until the thread is quiet (news_quiet_minutes), then ONE mission drafts for the managed
//   accounts whose "news" source is on; at most news_max_tasks_per_day missions a day; over the cap, or with no
//   target account, or when the mission cannot start, the items are set aside (skipped) with a note: no new attempt;
// - treg 401: polling stops, one alert until the next successful poll.
import { resolve } from '../accounts.js'
import { getGlobal, setGlobal, utc, utcDayStart, minutesIn } from './util.js'

export const DEFAULT_INTERVAL_MIN = { breaking: 15, daily: 1440, weekly: 10080 }
const NUM = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? n : d }

export function inHours(spec, now, tz) {
  if (!spec) return true
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(spec))
  if (!m) return true
  const [a, b] = [Number(m[1]), Number(m[2])]
  const h = Math.floor(minutesIn(now, tz) / 60)
  return a < b ? a <= h && h < b : h >= a || h < b
}

/** Managed accounts that get a draft for a news item (source "news" on, cascade account → organization → global). */
export const newsTargets = (db) => db.prepare(`SELECT id, handle, owner_user_id FROM accounts WHERE relation = 'owned' ORDER BY id`).all()
  .filter((a) => resolve(db, 'account', a.id, 'source_news').value === '1')

/** Posts of an account, normalised. `mode` search_originals = bots that reply all the time: original posts only. */
async function fetchPosts(treg, handle, maxCost, mode) {
  if (mode === 'search_originals') {
    const { json, costUsd } = await treg.call('treg.x.search.posts', { q: `from:${handle} -filter:replies` }, { maxCost })
    const posts = (((json || {}).output || {}).posts || [])
      .filter((x) => String(x.authorUsername || '').toLowerCase() === handle.toLowerCase())
      .map((x) => ({ id: x.id, url: x.url, text: x.text, lang: x.lang, createdUtc: x.createdUtc, isReply: false, conversationId: x.conversationId || x.id,
        media: x.media, likes: x.likeCount, views: x.viewCount, retweets: x.retweetCount, replies: x.replyCount, bookmarks: x.bookmarkCount }))
    return { posts, costUsd }
  }
  const { json, costUsd } = await treg.call('treg.x.user.posts', { username: handle }, { maxCost })
  return { posts: (((json || {}).output || {}).posts) || [], costUsd }
}

/**
 * One pass. `deps` = { db, treg, spawnNews({ handles, targets, queueIds }) -> mission id, notify, now: Date, force }.
 * Returns { state, message, polled: [...] }.
 */
export async function pollWatch({ db, treg, spawnNews, notify, now = new Date(), force = false }) {
  const tz = resolve(db, 'global', 0, 'publish_tz').value || 'UTC'
  const maxAgeH = NUM(getGlobal(db, 'news_max_age_hours'), 12)
  const budget = NUM(getGlobal(db, 'daily_budget_usd'), 0.25)
  const maxCost = getGlobal(db, 'treg_max_cost_per_call') || '0.002'
  // the posts the agent adds one by one (`item add`, source manual) share this budget
  let spent = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ingest_runs WHERE source IN ('watch', 'manual') AND started_at >= ?`).get(utcDayStart(now)).c
  const polled = []
  let stopped = null
  const accounts = db.prepare(`SELECT id, handle, watch_priority, poll_interval_min, active_hours, last_polled_at, poll_mode FROM accounts
    WHERE relation = 'watched' AND watch_priority IS NOT NULL ORDER BY id`).all()
  for (const acc of accounts) {
    if (!force) {
      if (!inHours(acc.active_hours, now, tz)) continue
      const pending = db.prepare(`SELECT 1 FROM news_queue WHERE account_id = ? AND status = 'new'`).get(acc.id)
      const every = acc.poll_interval_min || DEFAULT_INTERVAL_MIN[acc.watch_priority]
      if (acc.last_polled_at && !pending && (now.getTime() - new Date(acc.last_polled_at).getTime()) < every * 60_000) continue
    }
    if (spent >= budget) { stopped = `daily budget reached (${spent.toFixed(4)} / ${budget} $)`; break }
    let posts = []; let cost = 0; let status = 'ok'; let err = null; let auth = false
    try { ({ posts, costUsd: cost } = await fetchPosts(treg, acc.handle, maxCost, acc.poll_mode)) } catch (e) { status = 'error'; err = String(e.message).slice(0, 300); auth = Boolean(e.auth) || /\b401\b/.test(err) }
    spent += cost
    const baseline = !acc.last_polled_at
    const pageIds = new Set(posts.map((p) => String(p.id)))
    let fresh = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of posts) {
        if (String(p.text || '').startsWith('RT @')) continue
        const conv = String(p.conversationId || p.id)
        if (p.isReply) {
          // only the continuation of the account's own thread is kept; replies to others are ignored
          const ownRoot = pageIds.has(conv) || db.prepare(`SELECT 1 FROM items WHERE network = 'x' AND external_id = ? AND author_id = ?`).get(conv, acc.id)
          if (!ownRoot) continue
        }
        if (db.prepare(`SELECT 1 FROM items WHERE network = 'x' AND external_id = ?`).get(String(p.id))) continue
        const posted = p.createdUtc ? utc(new Date(Number(p.createdUtc) * 1000)) : null
        const kind = p.isReply ? 'thread' : 'post'
        const iid = Number(db.prepare(`INSERT INTO main.items(network, external_id, author_id, kind, url, text, lang, posted_at, first_seen_at, media, conversation_id)
          VALUES ('x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(p.id), acc.id, kind, p.url || null, p.text || null, p.lang || null, posted, utc(now), p.media ? JSON.stringify(p.media) : null, conv).lastInsertRowid)
        fresh++
        db.prepare(`INSERT INTO main.item_metrics(item_id, captured_at, likes, views, shares, replies, saves) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(iid, utc(now), p.likes ?? null, p.views ?? null, p.retweets ?? null, p.replies ?? null, p.bookmarks ?? null)
        db.prepare(`INSERT INTO main.captures(item_id, source, account_id, captured_at) VALUES (?, 'watch', NULL, ?)`).run(iid, utc(now))
        if (kind === 'post' && !baseline && acc.watch_priority === 'breaking' && posted && now.getTime() - new Date(posted).getTime() <= maxAgeH * 3_600_000) {
          db.prepare(`INSERT INTO main.news_queue(item_id, account_id, posted_at, detected_at) VALUES (?, ?, ?, ?)`).run(iid, acc.id, posted, utc(now))
        }
      }
      db.prepare(`UPDATE main.accounts SET last_polled_at = ? WHERE id = ?`).run(utc(now), acc.id)
      db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status, error) VALUES ('watch', ?, ?, 1, ?, ?, ?, ?)`)
        .run(acc.id, utc(now), fresh, cost, status, err)
      db.exec('COMMIT')
    } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
    polled.push(`@${acc.handle}: ${status}, ${fresh} new${baseline ? ' (baseline)' : ''}, ${cost.toFixed(4)} $${err ? ` — ${err}` : ''}`)
    if (status === 'ok' && getGlobal(db, 'treg_auth_alert_at')) setGlobal(db, 'treg_auth_alert_at', null)
    if (auth) {
      // refused key: no point polling the other accounts; one alert until the next successful poll
      stopped = 'treg refuses the key (401): polling stopped'
      if (!getGlobal(db, 'treg_auth_alert_at')) {
        notify.alert('X watch stopped: treg refuses the key (401)', 'No news is detected until the treg access is fixed (`treg login`, or the treg key in the plugin settings).', { urgent: true })
        setGlobal(db, 'treg_auth_alert_at', utc(now))
      }
      break
    }
  }
  const summary = (state, message) => ({ state, message: [message, stopped].filter(Boolean).join('; '), polled })

  const quiet = NUM(getGlobal(db, 'news_quiet_minutes'), 4)
  const ready = db.prepare(`SELECT n.id, a.handle FROM news_queue n JOIN accounts a ON a.id = n.account_id WHERE n.status = 'new' AND n.detected_at <= ? ORDER BY n.id`)
    .all(utc(new Date(now.getTime() - quiet * 60_000)))
  if (!ready.length) {
    const waiting = db.prepare(`SELECT COUNT(*) AS n FROM news_queue WHERE status = 'new'`).get().n
    return summary(stopped ? 'error' : 'ok', waiting ? `${waiting} news item(s) waiting for the thread to calm down (${quiet} min)` : `${polled.length} account(s) polled`)
  }
  const ids = ready.map((r) => r.id)
  const skip = (note) => db.prepare(`UPDATE main.news_queue SET status = 'skipped', note = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(note, ...ids)
  const cap = NUM(getGlobal(db, 'news_max_tasks_per_day'), 8)
  const made = db.prepare(`SELECT COUNT(DISTINCT mission_id) AS n FROM news_queue WHERE mission_id IS NOT NULL AND detected_at >= ?`).get(utcDayStart(now)).n
  if (made >= cap) { skip('daily cap of news missions reached'); return summary('ok', `cap of ${cap} news missions a day reached: ${ids.length} item(s) set aside`) }
  const targets = newsTargets(db)
  if (!targets.length) { skip('no managed account with the news source on'); return summary('ok', 'no managed account with the "news" source on: items set aside') }
  const handles = [...new Set(ready.map((r) => r.handle))].sort()
  let mission
  try {
    mission = await spawnNews({ handles, targets, queueIds: ids })
  } catch (e) {
    skip(`news mission not started: ${String(e.message).slice(0, 200)}`)
    notify.alert('News detected, but no draft was started', `${handles.map((h) => `@${h}`).join(', ')}: ${e.message}`, { urgent: true })
    return summary('error', `news mission not started: ${e.message}`)
  }
  db.prepare(`UPDATE main.news_queue SET status = 'queued', mission_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(mission ? String(mission) : null, ...ids)
  return summary('ok', `news from ${handles.map((h) => `@${h}`).join(', ')}: mission ${mission}`)
}
