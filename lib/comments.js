// Prospecting comments in the studio (schema v22): the replies the agent drafted for comment candidates, to validate,
// rewrite or discard; the campaigns of a managed account (pains, languages, limits); the competitors and their teams.
// Every function takes a connection scoped to the user of the request (lib/scope.js): another user's campaign,
// candidate or reply reads as missing. Competitors and their teams are shared by the installation.
// The SQL triggers stay the last barrier (no reply to a competitor's team, no competitor named, validation by the
// user); the checks here only refuse earlier and with a clearer message. Validating is the user's click only: no
// function here is reachable by the agent's tools.
import { getterFor } from './accounts.js'
import { ownerOf } from './scope.js'
import { zonedToUtc, localParts } from './schedule.js'

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const json = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback } catch { return fallback } }

/** A reply drafted for a comment candidate (`comments reply draft`): kind and post type `reply`. */
export const COMMENT_REPLY = "(p.kind = 'reply' AND p.post_type = 'reply')"
/** Statuses of a reply per tab of the Comments view. */
export const COMMENT_TABS = {
  pending: ['pending_validation'],
  sent: ['approved', 'scheduled', 'published', 'failed'],
  dismissed: ['rejected'],
}
// same rule as the agent's `comments reply draft`: a reply names the product, never a link to it
const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|ai|dev|app|co|net|org|fr|sh|so|xyz|gg|me|to|ly)\b/i

const metric = (col) => `(SELECT ${col} FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS ${col}`
const REPLY_SELECT = `SELECT p.id, p.account_id, p.body, p.status, p.validation_note, p.created_at, p.validated_at, p.validated_by,
    p.scheduled_for, p.published_at, p.url AS reply_url,
    a.handle AS account, a.network, a.lang AS account_lang,
    c.id AS candidate_id, c.campaign_id, c.score, c.reason, c.competitor_stance, c.author_affiliation, c.status AS candidate_status, c.dismiss_reason,
    k.name AS campaign, pn.id AS pain_id, pn.pain,
    it.id AS item_id, it.url AS item_url, it.text AS item_text, it.posted_at, it.lang AS item_lang,
    au.handle AS author, au.display_name AS author_name, au.avatar_url,
    (SELECT followers FROM account_metrics m WHERE m.account_id = it.author_id ORDER BY captured_at DESC LIMIT 1) AS followers,
    ${metric('likes')}, ${metric('views')}, ${metric('shares')}, ${metric('replies')},
    (SELECT MAX(r.created_at) FROM studio_requests r WHERE r.post_id = p.id AND r.kind = 'rewrite') AS rewrite_requested_at
  FROM comment_candidates c JOIN posts p ON p.id = c.post_id JOIN comment_campaigns k ON k.id = c.campaign_id
  JOIN accounts a ON a.id = p.account_id JOIN items it ON it.id = c.item_id LEFT JOIN accounts au ON au.id = it.author_id
  LEFT JOIN comment_pains pn ON pn.id = c.pain_id`

/** Replies of one tab (`pending` | `sent` | `dismissed`), optionally of one account. */
export function listReplies(db, { tab = 'pending', account = null, limit = 100 } = {}) {
  const statuses = COMMENT_TABS[tab]
  if (!statuses) throw new Error('unknown tab: pending | sent | dismissed')
  const order = tab === 'pending' ? 'p.created_at, p.id' : tab === 'sent' ? 'COALESCE(p.published_at, p.validated_at, p.created_at) DESC, p.id DESC' : 'p.created_at DESC, p.id DESC'
  return db.prepare(`${REPLY_SELECT} WHERE p.status IN (${statuses.map(() => '?').join(',')}) ${account ? 'AND p.account_id = ?' : ''} ORDER BY ${order} LIMIT ?`)
    .all(...statuses, ...(account ? [account] : []), Math.min(200, limit))
}

/** The comment tables exist (a database left at an older version by a failed update, read-only, has none). */
export const hasComments = (db) => Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'comment_candidates'").get())

/** Number of replies per tab. */
export function replyCounts(db, account = null) {
  const out = { pending: 0, sent: 0, dismissed: 0 }
  if (!hasComments(db)) return out
  const rows = db.prepare(`SELECT p.status, COUNT(*) AS n FROM comment_candidates c JOIN posts p ON p.id = c.post_id
    ${account ? 'WHERE p.account_id = ?' : ''} GROUP BY p.status`).all(...(account ? [account] : []))
  for (const r of rows) for (const [tab, st] of Object.entries(COMMENT_TABS)) if (st.includes(r.status)) out[tab] += r.n
  return out
}

/** Start of the current day (ISO) in a time zone. */
export function dayStart(tz, now = new Date()) {
  let zone = tz || 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }) } catch { zone = 'UTC' }
  const p = localParts(now, zone)
  return zonedToUtc(p.year, p.month, p.day, 0, 0, zone).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Today's replies of each account that has a campaign, against its ceiling: `sent` today (in the account's publishing
 * time zone), `queued` (validated, not sent yet), `cap` = the lowest replies-per-day of its active campaigns (null:
 * no ceiling set on the campaign).
 */
export function todayCounters(db, now = new Date()) {
  const accounts = db.prepare(`SELECT DISTINCT a.id, a.handle FROM comment_campaigns k JOIN accounts a ON a.id = k.account_id ORDER BY a.id`).all()
  return accounts.map((a) => {
    const since = dayStart(getterFor(db, a.id)('publish_tz'), now)
    const sent = db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE p.account_id = ? AND ${COMMENT_REPLY} AND p.status = 'published' AND p.published_at >= ?`).get(a.id, since).n
    const queued = db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE p.account_id = ? AND ${COMMENT_REPLY} AND p.status IN ('approved','scheduled')`).get(a.id).n
    const cap = db.prepare('SELECT MIN(max_replies_per_day) AS n FROM comment_campaigns WHERE account_id = ? AND active = 1').get(a.id).n
    const active = db.prepare('SELECT COUNT(*) AS n FROM comment_campaigns WHERE account_id = ? AND active = 1').get(a.id).n
    return { account_id: a.id, account: a.handle, sent, queued, cap: cap ?? null, active: active > 0, since }
  })
}

function replyRow(db, postId) {
  const p = db.prepare(`SELECT p.*, c.id AS candidate_id, c.status AS candidate_status, c.author_affiliation, c.competitor_stance FROM posts p
    LEFT JOIN comment_candidates c ON c.post_id = p.id WHERE p.id = ?`).get(postId)
  if (!p) throw new Error('post not found')
  if (!(p.kind === 'reply' && p.post_type === 'reply') || !p.candidate_id) throw new Error('this post is not a comment reply: validate it from the Posts view')
  return p
}
/** A reply's text: not empty, no URL. */
export function checkReplyText(body) {
  const t = String(body || '').trim()
  if (!t) throw new Error('the reply is empty')
  if (URL_IN_TEXT.test(t)) throw new Error('a reply holds no URL nor web address: mention the product by its name only')
  return t
}

/**
 * The user's click on Validate: the reply is approved and validated by `who` (never written by the agent). It is sent
 * by the publication task, not on a slot of the calendar. Refused when the author is affiliated or in doubt.
 */
export function approveReply(db, postId, who) {
  const p = replyRow(db, postId)
  if (p.status !== 'pending_validation') throw new Error(`status ${p.status}: nothing to validate`)
  if (p.candidate_status !== 'drafted') throw new Error(`its candidate is ${p.candidate_status}: this reply can no longer be validated`)
  if (p.author_affiliation !== 'none') throw new Error(`the author's affiliation is ${p.author_affiliation}: this post is never replied to, discard the reply`)
  checkReplyText(p.body)
  db.prepare(`UPDATE main.posts SET status = 'approved', validated_at = ?, validated_by = ?, scheduled_for = NULL WHERE id = ?`).run(nowIso(), who, postId)
}

/** Discard: the reply becomes rejected and its candidate dismissed, with the user's reason (required). */
export function dismissReply(db, postId, note) {
  const reason = String(note || '').trim()
  if (!reason) throw new Error('a reason is required to discard')
  const p = replyRow(db, postId)
  if (p.status === 'published') throw new Error('already sent')
  if (p.status === 'rejected') throw new Error('already discarded')
  db.prepare(`UPDATE main.posts SET status = 'rejected', validation_note = ?, scheduled_for = NULL WHERE id = ?`).run(reason.slice(0, 1000), postId)
  db.prepare(`UPDATE main.comment_candidates SET status = 'dismissed', dismiss_reason = ?, updated_at = ? WHERE id = ?`)
    .run(`Reply #${postId} discarded by the user: ${reason}`.slice(0, 1000), nowIso(), p.candidate_id)
  return p
}

// ---------- campaigns ----------
const intOrNull = (v, what) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what}: a whole number, 0 or more`)
  return n
}
const listOf = (v, what) => {
  if (v === null || v === undefined || v === '') return []
  const a = Array.isArray(v) ? v : String(v).split('\n')
  const out = a.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (out.some((x) => x.length > 2000)) throw new Error(`${what}: one line is too long`)
  return out
}
const textOrNull = (v) => { const t = String(v ?? '').trim(); return t || null }
const LANG = /^[a-z]{2,3}$/
const HOURS = /^([01]?\d|2[0-4])-([01]?\d|2[0-4])$/

/** Campaign fields of a request body, checked; only the fields present are returned. */
function campaignFields(b) {
  const f = {}
  if (b.name !== undefined) { const n = String(b.name || '').trim(); if (!n) throw new Error('a campaign needs a name'); f.name = n.slice(0, 120) }
  if (b.active !== undefined) f.active = b.active ? 1 : 0
  if (b.langs !== undefined) {
    const l = listOf(Array.isArray(b.langs) ? b.langs : String(b.langs || '').split(/[\s,]+/), 'languages').map((x) => x.toLowerCase())
    if (l.some((x) => !LANG.test(x))) throw new Error('languages: two-letter codes, e.g. en, fr')
    f.langs = l.length ? JSON.stringify([...new Set(l)]) : null
  }
  for (const [k, what] of [['max_replies_per_day', 'replies per day'], ['min_gap_min', 'minutes between two replies'], ['max_author_followers', 'followers ceiling']]) {
    if (b[k] !== undefined) f[k] = intOrNull(b[k], what)
  }
  if (b.same_author_days !== undefined) { const n = intOrNull(b.same_author_days, 'days before the same author'); f.same_author_days = n ?? 30 }
  if (b.search_budget_usd !== undefined) {
    if (b.search_budget_usd === null || b.search_budget_usd === '') f.search_budget_usd = null
    else { const n = Number(b.search_budget_usd); if (!Number.isFinite(n) || n < 0) throw new Error('search budget: an amount, 0 or more'); f.search_budget_usd = n }
  }
  if (b.active_hours !== undefined) {
    const h = String(b.active_hours || '').trim()
    if (h && !HOURS.test(h)) throw new Error('active hours: HH-HH, e.g. 08-20')
    f.active_hours = h ? h.split('-').map((x) => x.padStart(2, '0')).join('-') : null
  }
  if (b.notes !== undefined) f.notes = textOrNull(b.notes)
  return f
}

/** Campaigns of a managed account with their pains, and the account's language (default of `langs`). */
export function listCampaigns(db, accountId) {
  const a = db.prepare(`SELECT id, handle, lang, network FROM accounts WHERE id = ? AND relation = 'owned'`).get(accountId)
  if (!a) throw new Error('account not found')
  const camps = db.prepare('SELECT * FROM comment_campaigns WHERE account_id = ? ORDER BY id').all(a.id)
  const pains = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM comment_candidates c WHERE c.pain_id = p.id) AS candidates FROM comment_pains p
    WHERE p.campaign_id IN (SELECT id FROM comment_campaigns WHERE account_id = ?) ORDER BY p.id`).all(a.id)
  const shapePain = (p) => ({ ...p, queries: json(p.queries, []), examples_positive: json(p.examples_positive, []), examples_negative: json(p.examples_negative, []) })
  return {
    account: a,
    campaigns: camps.map((k) => ({ ...k, langs: json(k.langs, []), pains: pains.filter((p) => p.campaign_id === k.id).map(shapePain) })),
  }
}

export function createCampaign(db, b) {
  const a = db.prepare(`SELECT id, owner_user_id, network FROM accounts WHERE id = ? AND relation = 'owned'`).get(Number(b.account_id))
  if (!a) throw new Error('account not found')
  const f = campaignFields({ name: b.name || 'Comments', ...b })
  const owner = ownerOf(db) || a.owner_user_id
  if (!owner) throw new Error('the account has no owner yet')
  const cols = ['account_id', 'owner_user_id', 'network', 'created_at', ...Object.keys(f)]
  const vals = [a.id, owner, a.network, nowIso(), ...Object.values(f)]
  return Number(db.prepare(`INSERT INTO main.comment_campaigns(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid)
}

export function updateCampaign(db, id, b) {
  if (!db.prepare('SELECT 1 FROM comment_campaigns WHERE id = ?').get(id)) throw new Error('campaign not found')
  const f = campaignFields(b)
  if (!Object.keys(f).length) return
  db.prepare(`UPDATE main.comment_campaigns SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), nowIso(), id)
}

/** Pain fields of a request body, checked. An active pain needs its verified solution and where it was verified. */
function painFields(b, current = {}) {
  const f = {}
  if (b.pain !== undefined) { const t = String(b.pain || '').trim(); if (!t) throw new Error('describe the pain'); f.pain = t.slice(0, 2000) }
  if (b.queries !== undefined) f.queries = JSON.stringify(listOf(b.queries, 'searches'))
  if (b.examples_positive !== undefined) { const l = listOf(b.examples_positive, 'examples'); f.examples_positive = l.length ? JSON.stringify(l) : null }
  if (b.examples_negative !== undefined) { const l = listOf(b.examples_negative, 'counter-examples'); f.examples_negative = l.length ? JSON.stringify(l) : null }
  for (const k of ['solution', 'solution_source', 'evidence']) if (b[k] !== undefined) f[k] = textOrNull(b[k])
  if (b.active !== undefined) f.active = b.active ? 1 : 0
  const next = { ...current, ...f }
  if (next.active && (!String(next.solution || '').trim() || !String(next.solution_source || '').trim())) {
    throw new Error('an active pain needs its solution and the source where it was verified (or leave it inactive)')
  }
  return f
}

export function createPain(db, campaignId, b) {
  if (!db.prepare('SELECT 1 FROM comment_campaigns WHERE id = ?').get(campaignId)) throw new Error('campaign not found')
  if (b.pain === undefined) throw new Error('describe the pain')
  const f = painFields({ active: 1, ...b }, {})
  const cols = ['campaign_id', 'created_at', ...Object.keys(f)]
  return Number(db.prepare(`INSERT INTO main.comment_pains(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(campaignId, nowIso(), ...Object.values(f)).lastInsertRowid)
}

export function updatePain(db, id, b) {
  const cur = db.prepare('SELECT * FROM comment_pains WHERE id = ?').get(id)
  if (!cur) throw new Error('pain not found')
  const f = painFields(b, cur)
  if (!Object.keys(f).length) return
  db.prepare(`UPDATE main.comment_pains SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(f), id)
}

// ---------- competitors and their teams (shared by the installation) ----------
export const TEAM_ROLES = ['official', 'founder', 'employee', 'developer', 'contributor', 'other']
const HANDLE = /^[A-Za-z0-9_]{1,50}$/
const cleanHandle = (raw) => {
  const h = String(raw || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '')
  if (!HANDLE.test(h)) throw new Error('a handle without @: letters, digits and _')
  return h
}

/** Competitors with their aliases and team, and the authors of candidates dismissed for an affiliation (quick add). */
export function listCompetitors(db) {
  const comps = db.prepare('SELECT id, slug, name, website, category, active FROM competitors ORDER BY active DESC, name COLLATE NOCASE').all()
  const aliases = db.prepare('SELECT competitor_id, alias FROM competitor_aliases ORDER BY alias COLLATE NOCASE').all()
  const team = db.prepare('SELECT competitor_id, network, handle, role, source, added_at FROM competitor_team ORDER BY handle COLLATE NOCASE').all()
  const affiliated = db.prepare(`SELECT c.id AS candidate_id, c.author_affiliation, c.dismiss_reason, c.reason, c.updated_at,
      it.network, it.url AS item_url, it.text AS item_text, au.handle, au.display_name AS author_name, au.avatar_url, a.handle AS account
    FROM comment_candidates c JOIN comment_campaigns k ON k.id = c.campaign_id JOIN accounts a ON a.id = k.account_id
    JOIN items it ON it.id = c.item_id JOIN accounts au ON au.id = it.author_id
    WHERE c.status = 'dismissed' AND c.author_affiliation IN ('competitor', 'unknown') AND au.competitor_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM competitor_team t WHERE t.network = au.network AND t.handle = au.handle)
    ORDER BY COALESCE(c.updated_at, c.created_at) DESC LIMIT 100`).all()
  const seen = new Set()
  return {
    competitors: comps.map((c) => ({ ...c, aliases: aliases.filter((x) => x.competitor_id === c.id).map((x) => x.alias), team: team.filter((t) => t.competitor_id === c.id) })),
    // one line per author
    affiliated: affiliated.filter((r) => { const k = `${r.network}:${r.handle.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true }),
    roles: TEAM_ROLES,
  }
}

const competitorOf = (db, id) => {
  const c = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id)
  if (!c) throw new Error('competitor not found')
  return c
}

export function createCompetitor(db, { name, website }) {
  const n = String(name || '').trim()
  if (!n) throw new Error('a competitor needs a name')
  const base = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'competitor'
  let slug = base
  for (let i = 2; db.prepare('SELECT 1 FROM competitors WHERE slug = ?').get(slug); i++) slug = `${base.slice(0, 36)}-${i}`
  const id = Number(db.prepare('INSERT INTO main.competitors(slug, name, website) VALUES (?, ?, ?)').run(slug, n.slice(0, 120), textOrNull(website)).lastInsertRowid)
  // its name is recognized in a text from now on (a post never names it)
  db.prepare('INSERT OR IGNORE INTO main.competitor_aliases(competitor_id, alias) VALUES (?, ?)').run(id, n.slice(0, 120))
  return id
}

export function updateCompetitor(db, id, b) {
  competitorOf(db, id)
  if (b.name !== undefined) { const n = String(b.name || '').trim(); if (!n) throw new Error('a competitor needs a name'); db.prepare('UPDATE main.competitors SET name = ? WHERE id = ?').run(n.slice(0, 120), id) }
  if (b.website !== undefined) db.prepare('UPDATE main.competitors SET website = ? WHERE id = ?').run(textOrNull(b.website), id)
  if (b.active !== undefined) db.prepare('UPDATE main.competitors SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id)
}

export function addAlias(db, id, raw) {
  competitorOf(db, id)
  const alias = String(raw || '').trim()
  if (alias.length < 2) throw new Error('an alias has 2 characters or more')
  const hit = db.prepare('SELECT c.name, x.competitor_id FROM competitor_aliases x JOIN competitors c ON c.id = x.competitor_id WHERE x.alias = ?').get(alias)
  if (hit && hit.competitor_id !== id) throw new Error(`"${alias}" is already an alias of ${hit.name}`)
  db.prepare('INSERT OR IGNORE INTO main.competitor_aliases(competitor_id, alias) VALUES (?, ?)').run(id, alias.slice(0, 120))
}

export function removeAlias(db, id, raw) {
  competitorOf(db, id)
  db.prepare('DELETE FROM main.competitor_aliases WHERE competitor_id = ? AND alias = ?').run(id, String(raw || '').trim())
}

/** Adds a person (or official account) to a competitor's team: never replied to, never quoted from now on. */
export function addTeamMember(db, id, { handle, role = 'other', source = null, network = 'x' }) {
  competitorOf(db, id)
  const h = cleanHandle(handle)
  if (!TEAM_ROLES.includes(role)) throw new Error(`role: ${TEAM_ROLES.join(' | ')}`)
  if (!db.prepare('SELECT 1 FROM networks WHERE id = ?').get(network)) throw new Error('unknown network')
  const hit = db.prepare('SELECT t.competitor_id, c.name FROM competitor_team t JOIN competitors c ON c.id = t.competitor_id WHERE t.network = ? AND t.handle = ?').get(network, h)
  if (hit && hit.competitor_id !== id) throw new Error(`@${h} is already in the team of ${hit.name}`)
  if (hit) {
    db.prepare('UPDATE main.competitor_team SET role = ?, source = COALESCE(?, source) WHERE network = ? AND handle = ?').run(role, textOrNull(source), network, h)
    return h
  }
  db.prepare('INSERT INTO main.competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, network, h, role, textOrNull(source) || 'added in the studio', nowIso())
  return h
}

export function removeTeamMember(db, id, { handle, network = 'x' }) {
  competitorOf(db, id)
  const r = db.prepare('DELETE FROM main.competitor_team WHERE competitor_id = ? AND network = ? AND handle = ?').run(id, network, cleanHandle(handle))
  if (!Number(r.changes)) throw new Error('team member not found')
}
