// Prospecting comments job: without any model, searches X for the queries of the pains of every active comment
// campaign (treg.x.search.posts, never an x.x.* endpoint to read), keeps the posts that pass a pre-filter, checks the
// affiliation of their author, stores them as candidates, then starts ONE qualification mission at a time, for the
// candidates of one account.
// - interval per campaign (comments_poll_interval_min, 0 = stopped), installation window (comments_window_start /
//   _end in publish_tz) and the campaign's active hours (in its account's publish_tz);
// - budgets: the campaign's per day (search_budget_usd, else the cascade comments_search_budget_usd) and a ceiling for
//   all campaigns (comments_daily_budget_usd); searches and profiles go to ingest_runs (source 'search', one row per
//   campaign pass); the spend of each campaign is kept in its state key (settings `comments_campaign:<id>`);
// - pre-filter, no model: post younger than 48 h, not a retweet, in a language of the campaign, not a candidate of the
//   campaign yet, author not a managed account, not a reference account, not replied to (nor already a candidate) for
//   the same account within the campaign's same_author_days;
// - affiliation BEFORE any qualification: the author's handle against competitor_team, competitor accounts and
//   competitor_aliases, then their profile (treg.x.user.profile, cached PROFILE_TTL_DAYS: followers in
//   account_metrics, bio in the item's `extra.author`) against the aliases. A match = candidate dismissed with
//   author_affiliation 'competitor'; a profile that cannot be read = 'unknown', dismissed (never drafted); an author
//   over the follower ceiling is dismissed too. Kept candidates wait as 'new' with author_affiliation 'none';
// - qualification: one mission at a time (a new one once the previous batch left 'new', or after
//   QUALIFY_RESPAWN_MIN), at most comments_max_missions_per_day a day, comments_batch_size candidates of one account;
// - treg 401: everything stops, one alert until the next successful call (key shared with the watch).
import { getterFor, resolve } from '../accounts.js'
import { guessRole } from '../item-add.js'
import { inHours } from './watch.js'
import { ageMin, getGlobal, minutesIn, setGlobal, utc, utcDayStart } from './util.js'

export const SEARCH_TOOL = 'treg.x.search.posts'
export const PROFILE_TOOL = 'treg.x.user.profile'
export const MAX_POST_AGE_H = 48
export const PROFILE_TTL_DAYS = 7
export const QUALIFY_RESPAWN_MIN = 30
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const POST_ID = /^\d{1,25}$/
const NUM = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? n : d }
const parseJson = (s, d) => { try { const v = s ? JSON.parse(s) : d; return v ?? d } catch { return d } }
const dayOf = (now) => now.toISOString().slice(0, 10)
const hm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0) }

const campaignKey = (id) => `comments_campaign:${id}`
const QUALIFY_KEY = 'comments_qualify'

/** One post of a search answer, normalised (treg's own shape, or the provider's). */
export function normalizePost(x) {
  const handle = String(x.authorUsername || x.authorHandle || (x.author && (x.author.userName || x.author.username)) || '').replace(/^@/, '')
  const id = String(x.id || '')
  return {
    id, handle, name: x.authorName || (x.author && x.author.name) || null,
    text: x.text || '', lang: x.lang ? String(x.lang).toLowerCase() : null,
    createdUtc: Number(x.createdUtc) || (x.createdAt ? Math.floor(new Date(x.createdAt).getTime() / 1000) || null : null),
    isReply: Boolean(x.isReply), isRetweet: Boolean(x.isRetweet || x.retweeted || x.retweetedStatus) || String(x.text || '').startsWith('RT @'),
    conversationId: String(x.conversationId || id), media: Array.isArray(x.media) && x.media.length ? x.media : null,
    likes: x.likeCount ?? null, views: x.viewCount ?? null, retweets: x.retweetCount ?? null, replies: x.replyCount ?? null, bookmarks: x.bookmarkCount ?? null,
    url: HANDLE.test(handle) && POST_ID.test(id) ? `https://x.com/${handle}/status/${id}` : null,
  }
}
const postsOf = (json) => {
  const o = (json && json.output) || {}
  return o.posts || (o.data && (o.data.items || o.data.posts)) || o.items || []
}

/** A profile answer, normalised; null when the account was not found. */
export function normalizeProfile(json) {
  const o = (json && json.output) || {}
  if (o.found === false) return null
  const d = o.data || o.profile || o
  const followers = Number(d.followers ?? d.followersCount ?? d.followers_count)
  if (!d || (!d.handle && !d.username && !Number.isFinite(followers) && d.bio == null && d.description == null)) return null
  return {
    name: d.displayName || d.name || null, bio: String(d.bio ?? d.description ?? ''), website: String(d.website || d.url || ''),
    followers: Number.isFinite(followers) ? followers : null, following: Number.isFinite(Number(d.following)) ? Number(d.following) : null,
    verified: Boolean(d.verified), avatar: /^https:\/\//.test(String(d.avatarUrl || '')) ? String(d.avatarUrl).replace(/_normal(\.\w+)$/, '_200x200$1') : null,
  }
}

/** A competitor named in a text (alias contained in it), or null: { competitor_id, alias }. */
const aliasIn = (db, s) => (String(s || '').trim()
  ? db.prepare(`SELECT competitor_id, alias FROM competitor_aliases WHERE instr(lower(?), lower(alias)) > 0 ORDER BY length(alias) DESC LIMIT 1`).get(String(s))
  : null) || null

/** Affiliation known from the handle alone: competitor_team, a competitor's account, an alias equal to the handle. */
export function handleAffiliation(db, handle) {
  const t = db.prepare(`SELECT t.role, c.name FROM competitor_team t JOIN competitors c ON c.id = t.competitor_id WHERE t.network = 'x' AND t.handle = ?`).get(handle)
  if (t) return `@${handle} is in the team of ${t.name} (${t.role})`
  const a = db.prepare(`SELECT c.name FROM accounts a JOIN competitors c ON c.id = a.competitor_id WHERE a.network = 'x' AND lower(a.handle) = lower(?)`).get(handle)
  if (a) return `@${handle} is an account of ${a.name}`
  const x = db.prepare(`SELECT c.name FROM competitor_aliases x JOIN competitors c ON c.id = x.competitor_id WHERE x.alias = ? OR x.alias = '@' || ?`).get(handle, handle)
  if (x) return `@${handle} is a name of ${x.name}`
  return null
}

/** Affiliation found in the profile: an alias in the bio, the website or the display name. */
function profileAffiliation(db, profile) {
  for (const [what, s] of [['bio', profile.bio], ['website', profile.website], ['name', profile.name]]) {
    const m = aliasIn(db, s)
    if (m) {
      const c = db.prepare('SELECT name FROM competitors WHERE id = ?').get(m.competitor_id)
      return `its ${what} names ${c ? c.name : 'a competitor'} ("${m.alias}")`
    }
  }
  return null
}

/** Profile kept from a previous pass: followers in account_metrics and bio in an item of the author, both fresh. */
function cachedProfile(db, authorId, now) {
  if (!authorId) return null
  const since = utc(new Date(now.getTime() - PROFILE_TTL_DAYS * 86_400_000))
  const m = db.prepare('SELECT followers, following FROM account_metrics WHERE account_id = ? AND captured_at >= ? ORDER BY captured_at DESC LIMIT 1').get(authorId, since)
  if (!m) return null
  const r = db.prepare(`SELECT json_extract(extra, '$.author') AS a FROM items WHERE author_id = ? AND json_valid(extra)
    AND json_extract(extra, '$.author.fetched_at') >= ? ORDER BY json_extract(extra, '$.author.fetched_at') DESC LIMIT 1`).get(authorId, since)
  const a = r && parseJson(r.a, null)
  return a ? { ...a, followers: m.followers, following: m.following, cached: true } : null
}

/** The author was replied to by this account (or is already its candidate) within `days`. */
function contacted(db, accountId, authorId, days, now) {
  if (!authorId || !days) return false
  const since = utc(new Date(now.getTime() - days * 86_400_000))
  return Boolean(db.prepare(`SELECT 1 FROM posts p JOIN items i ON i.id = p.reply_to_item_id
      WHERE p.account_id = ? AND i.author_id = ? AND p.status NOT IN ('rejected','failed') AND COALESCE(p.published_at, p.created_at) >= ?
    UNION ALL SELECT 1 FROM comment_candidates c JOIN comment_campaigns k ON k.id = c.campaign_id JOIN items i ON i.id = c.item_id
      WHERE k.account_id = ? AND i.author_id = ? AND c.status IN ('new','qualified','drafted','replied') AND c.created_at >= ? LIMIT 1`)
    .get(accountId, authorId, since, accountId, authorId, since))
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
}

/** Stores the author (if new), the item (if new), its capture and the candidate. Returns the candidate id. */
function storeCandidate(db, { campaign, painId, post, author, profile, fetched, query, runId, verdict, now }) {
  const ts = utc(now)
  return tx(db, () => {
    let authorId = author && author.id
    if (!authorId) {
      authorId = Number(db.prepare(`INSERT INTO main.accounts(network, handle, display_name, avatar_url, relation, role) VALUES ('x', ?, ?, ?, 'watched', ?)`)
        .run(post.handle, (profile && profile.name) || post.name || null, (profile && profile.avatar) || null, guessRole((profile && profile.name) || post.name)).lastInsertRowid)
    }
    if (fetched && profile) {
      db.prepare('INSERT OR REPLACE INTO main.account_metrics(account_id, captured_at, followers, following) VALUES (?, ?, ?, ?)').run(authorId, ts, profile.followers, profile.following)
      if (profile.avatar) db.prepare(`UPDATE main.accounts SET avatar_url = COALESCE(avatar_url, ?) WHERE id = ?`).run(profile.avatar, authorId)
    }
    const snapshot = profile ? JSON.stringify({ bio: profile.bio, website: profile.website, name: profile.name, followers: profile.followers, verified: profile.verified, fetched_at: profile.fetched_at || ts }) : null
    let item = db.prepare(`SELECT id FROM main.items WHERE network = 'x' AND external_id = ?`).get(post.id)
    if (!item) {
      const extra = snapshot ? `{"author":${snapshot}}` : null
      item = { id: Number(db.prepare(`INSERT INTO main.items(network, external_id, author_id, kind, url, text, lang, posted_at, first_seen_at, media, conversation_id, extra)
        VALUES ('x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(post.id, authorId, post.isReply ? 'reply' : 'post', post.url, post.text || null, post.lang, utc(new Date(post.createdUtc * 1000)), ts,
        post.media ? JSON.stringify(post.media) : null, post.conversationId, extra).lastInsertRowid) }
      db.prepare(`INSERT INTO main.item_metrics(item_id, captured_at, likes, views, shares, replies, saves) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, ts, post.likes, post.views, post.retweets, post.replies, post.bookmarks)
    } else if (snapshot) {
      db.prepare(`UPDATE main.items SET extra = json_set(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, '$.author', json(?)) WHERE id = ?`).run(snapshot, item.id)
    }
    db.prepare(`INSERT OR IGNORE INTO main.captures(item_id, source, account_id, query, run_id, captured_at) VALUES (?, 'search', ?, ?, ?, ?)`)
      .run(item.id, campaign.account_id, query, runId, ts)
    return Number(db.prepare(`INSERT INTO main.comment_candidates(campaign_id, item_id, pain_id, author_affiliation, status, dismiss_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(campaign.id, item.id, painId, verdict.affiliation, verdict.dismiss ? 'dismissed' : 'new', verdict.dismiss || null, ts).lastInsertRowid)
  })
}

/**
 * One pass. `deps` = { db, treg, spawnQualify({ account, count, candidateIds, campaigns }) -> mission id, notify, now: Date, force }.
 * Returns { state, message, campaigns: [...] }.
 */
export async function pollComments({ db, treg, spawnQualify, notify, now = new Date(), force = false }) {
  const get = getterFor(db, null)
  const interval = NUM(get('comments_poll_interval_min'), 60)
  if (interval <= 0 && !force) return { state: 'stopped', message: 'comments search stopped (interval 0)' }
  const tz = get('publish_tz') || 'UTC'
  if (!force) {
    const cur = minutesIn(now, tz)
    const [a, b] = [hm(get('comments_window_start')), hm(get('comments_window_end'))]
    if (!(a < b ? a <= cur && cur < b : cur >= a || cur < b)) return { state: 'outside', message: 'outside the comments search window' }
  }
  const campaigns = db.prepare(`SELECT k.*, a.handle FROM comment_campaigns k JOIN accounts a ON a.id = k.account_id
    WHERE k.active = 1 AND k.network = 'x' AND a.relation = 'owned' ORDER BY k.id`).all()
  const today = dayOf(now)
  const globalBudget = NUM(get('comments_daily_budget_usd'), 0.5)
  const maxCost = getGlobal(db, 'treg_max_cost_per_call') || '0.002'
  let spentAll = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ingest_runs WHERE source = 'search' AND started_at >= ?`).get(utcDayStart(now)).c
  const minTs = now.getTime() / 1000 - MAX_POST_AGE_H * 3600
  const lines = []
  let stopped = null; let searched = 0

  for (const k of campaigns) {
    if (stopped) break
    const st = parseJson(getGlobal(db, campaignKey(k.id)), {})
    const spentBefore = st.day === today ? Number(st.spent) || 0 : 0
    if (!force) {
      if (!inHours(k.active_hours, now, resolve(db, 'account', k.account_id, 'publish_tz').value || tz)) continue
      if (st.last_at && ageMin(st.last_at, now) < interval) continue
    }
    const budget = k.search_budget_usd != null ? Number(k.search_budget_usd) : NUM(resolve(db, 'account', k.account_id, 'comments_search_budget_usd').value, 0.1)
    const maxFollowers = k.max_author_followers != null ? Number(k.max_author_followers) : NUM(resolve(db, 'account', k.account_id, 'comments_max_author_followers').value, null)
    const langs = parseJson(k.langs, []).map((l) => String(l).toLowerCase())
    const queries = []
    for (const p of db.prepare('SELECT id, queries FROM comment_pains WHERE campaign_id = ? AND active = 1 ORDER BY id').all(k.id)) {
      for (const q of parseJson(p.queries, [])) {
        const s = String(q || '').trim().slice(0, 500)
        if (s && !queries.some((x) => x.q === s)) queries.push({ q: s, painId: p.id })
      }
    }
    if (!queries.length) { lines.push(`${k.name} (@${k.handle}): no active pain with a query`); continue }
    let spent = spentBefore
    const enough = () => {
      if (spentAll >= globalBudget) { stopped = `daily budget of the comments search reached (${spentAll.toFixed(4)} / ${globalBudget} $)`; return false }
      return spent < budget
    }
    if (!enough()) { if (!stopped) lines.push(`${k.name} (@${k.handle}): daily budget reached (${spent.toFixed(4)} / ${budget} $)`); continue }
    searched++
    const runId = Number(db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status) VALUES ('search', ?, ?, 0, 0, 0, 'ok')`)
      .run(k.account_id, utc(now)).lastInsertRowid)
    const pay = (c) => { const n = Number(c) || 0; spent += n; spentAll += n }
    let pages = 0; let fresh = 0; let set = 0; const errors = []; let auth = false
    const seen = new Set()
    const call = async (tool, data) => {
      try {
        const r = await treg.call(tool, data, { maxCost }); pay(r.costUsd)
        if (getGlobal(db, 'treg_auth_alert_at')) setGlobal(db, 'treg_auth_alert_at', null)
        return r.json
      } catch (e) {
        if (e.auth || /\b401\b/.test(String(e.message))) auth = true
        throw e
      }
    }
    for (const { q, painId } of queries) {
      if (auth || !enough()) break
      let posts
      try { posts = postsOf(await call(SEARCH_TOOL, { q })); pages++ } catch (e) { errors.push(`"${q.slice(0, 40)}": ${String(e.message).slice(0, 200)}`); if (auth) break; continue }
      for (const raw of posts) {
        if (auth) break
        const post = normalizePost(raw || {})
        if (!POST_ID.test(post.id) || !HANDLE.test(post.handle) || seen.has(post.id)) continue
        seen.add(post.id)
        // pre-filter, no model
        if (post.isRetweet || !post.createdUtc || post.createdUtc < minTs) continue
        if (langs.length && !langs.includes(post.lang)) continue
        if (db.prepare(`SELECT 1 FROM comment_candidates c JOIN items i ON i.id = c.item_id WHERE c.campaign_id = ? AND i.network = 'x' AND i.external_id = ?`).get(k.id, post.id)) continue
        const author = db.prepare(`SELECT id, relation, watch_role FROM main.accounts WHERE network = 'x' AND lower(handle) = lower(?)`).get(post.handle) || null
        if (author && (author.relation === 'owned' || author.watch_role === 'reference')) continue
        if (contacted(db, k.account_id, author && author.id, k.same_author_days, now)) continue
        // affiliation before any qualification
        let verdict = null; let profile = null; let fetched = false
        const byHandle = handleAffiliation(db, post.handle)
        if (byHandle) verdict = { affiliation: 'competitor', dismiss: `author affiliated with a competitor: ${byHandle}` }
        else {
          profile = cachedProfile(db, author && author.id, now)
          if (!profile) {
            if (!enough()) break
            try { profile = normalizeProfile(await call(PROFILE_TOOL, { username: post.handle })); fetched = true } catch (e) {
              errors.push(`profile @${post.handle}: ${String(e.message).slice(0, 200)}`); if (auth) break
            }
          }
          const byProfile = profile && profileAffiliation(db, profile)
          if (!profile) verdict = { affiliation: 'unknown', dismiss: 'author affiliation unknown: profile unavailable' }
          else if (byProfile) verdict = { affiliation: 'competitor', dismiss: `author affiliated with a competitor: ${byProfile}` }
          else if (maxFollowers != null && profile.followers != null && profile.followers > maxFollowers) verdict = { affiliation: 'none', dismiss: `author over the follower ceiling (${profile.followers} > ${maxFollowers})` }
          else verdict = { affiliation: 'none', dismiss: null }
        }
        storeCandidate(db, { campaign: k, painId, post, author, profile, fetched, query: q, runId, verdict, now })
        if (verdict.dismiss) set++; else fresh++
      }
    }
    const status = errors.length && !pages ? 'error' : 'ok'
    db.prepare('UPDATE main.ingest_runs SET pages = ?, items_new = ?, cost_usd = ?, status = ?, error = ? WHERE id = ?')
      .run(pages, fresh + set, Math.round((spent - spentBefore) * 1e6) / 1e6, status, errors.length ? errors.join('; ').slice(0, 300) : null, runId)
    setGlobal(db, campaignKey(k.id), JSON.stringify({ day: today, spent: Math.round(spent * 1e6) / 1e6, last_at: utc(now) }))
    lines.push(`${k.name} (@${k.handle}): ${pages}/${queries.length} search(es), ${fresh} candidate(s), ${set} set aside, ${(spent - spentBefore).toFixed(4)} $${errors.length ? ` — ${errors.join('; ')}` : ''}`)
    if (auth) {
      stopped = 'treg refuses the key (401): comments search stopped'
      if (!getGlobal(db, 'treg_auth_alert_at')) {
        notify.alert('Comments search stopped: treg refuses the key (401)', 'No post is searched until the treg access is fixed (`treg login`, or the treg key in the plugin settings).', { urgent: true })
        setGlobal(db, 'treg_auth_alert_at', utc(now))
      }
    }
  }

  // a post older than the limit is no longer worth a reply: its candidate waiting for qualification is set aside
  db.prepare(`UPDATE main.comment_candidates SET status = 'dismissed', dismiss_reason = 'expired before qualification', updated_at = ?
    WHERE status = 'new' AND item_id IN (SELECT id FROM items WHERE posted_at < ?)`).run(utc(now), utc(new Date(minTs * 1000)))

  const summary = (state, message) => ({ state, message: [message, stopped].filter(Boolean).join('; '), campaigns: lines })
  const qualify = await startQualification({ db, spawnQualify, now, get })
  if (qualify.error || (stopped && /401/.test(stopped))) return summary('error', [`${searched} campaign(s) searched`, qualify.message].filter(Boolean).join('; '))
  if (searched || qualify.started || stopped) return summary('ok', [`${searched} campaign(s) searched`, qualify.message].filter(Boolean).join('; '))
  if (!campaigns.length) return summary('idle', ['no active comment campaign', qualify.message].filter(Boolean).join('; '))
  if (lines.length) return summary('idle', [lines.join('; '), qualify.message].filter(Boolean).join('; '))
  return summary('not-due', ['not due yet', qualify.message].filter(Boolean).join('; '))
}

/** Starts the qualification of the waiting candidates of one account, if none is running and the daily cap allows it. */
async function startQualification({ db, spawnQualify, now, get }) {
  const waiting = db.prepare(`SELECT c.id, k.account_id, k.name FROM comment_candidates c JOIN comment_campaigns k ON k.id = c.campaign_id
    WHERE c.status = 'new' AND c.author_affiliation = 'none' ORDER BY c.id`).all()
  if (!waiting.length) return { message: '' }
  const st = parseJson(getGlobal(db, QUALIFY_KEY), {})
  const ids = Array.isArray(st.ids) ? st.ids : []
  const left = ids.length ? db.prepare(`SELECT COUNT(*) AS n FROM comment_candidates WHERE status = 'new' AND id IN (${ids.map(() => '?').join(',')})`).get(...ids).n : 0
  // one at a time: the previous batch is still waiting for its verdicts
  if (st.at && left && ageMin(st.at, now) < QUALIFY_RESPAWN_MIN) return { message: `${waiting.length} candidate(s) waiting, qualification already started` }
  const today = dayOf(now)
  const made = st.day === today ? Number(st.count) || 0 : 0
  const cap = NUM(get('comments_max_missions_per_day'), 6)
  if (made >= cap) return { message: `cap of ${cap} qualification missions a day reached: ${waiting.length} candidate(s) waiting` }
  const accountId = waiting[0].account_id
  const mine = waiting.filter((w) => w.account_id === accountId).slice(0, Math.max(1, NUM(get('comments_batch_size'), 15)))
  const account = db.prepare('SELECT id, handle, network, owner_user_id FROM accounts WHERE id = ?').get(accountId)
  setGlobal(db, QUALIFY_KEY, JSON.stringify({ at: utc(now), ids: mine.map((w) => w.id), account_id: accountId, day: today, count: made + 1 }))
  try {
    const mission = await spawnQualify({ account, count: mine.length, candidateIds: mine.map((w) => w.id), campaigns: [...new Set(mine.map((w) => w.name))] })
    setGlobal(db, QUALIFY_KEY, JSON.stringify({ at: utc(now), ids: mine.map((w) => w.id), account_id: accountId, day: today, count: made + 1, mission: mission ? String(mission) : null }))
    return { started: true, message: `qualification of ${mine.length} candidate(s) of @${account.handle} started (${mission})` }
  } catch (e) {
    // a mission that did not start does not count in the daily cap; next try after the respawn delay
    setGlobal(db, QUALIFY_KEY, JSON.stringify({ at: utc(now), ids: mine.map((w) => w.id), account_id: accountId, day: today, count: made }))
    return { error: true, message: `qualification of @${account.handle} not started: ${e.message} (next try in ${QUALIFY_RESPAWN_MIN} min)` }
  }
}
