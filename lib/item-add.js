// `item add <url>`: stores ONE X post the agent wants to quote or use, read by the host through the treg connector
// (anyapi.twitter.tweet). Run by the host only (spool mode): the CLI has no connector.
// - the post already in the database (same external_id): its id comes back, nothing is paid;
// - its author is created if missing (watched, not polled: no watch_priority), role `--role`, else guessed from its
//   display name (a domain or "official", "labs"… = brand), else personal;
// - guardrails of the triage: a competitor (author or text) sets competitor_id, a reference author is kept but the
//   item never feeds an idea or a post (the SQL triggers stay the last barrier);
// - the cost goes to ingest_runs (source 'manual') and counts in the daily budget of the watch.
import { getGlobal, utc, utcDayStart } from './jobs/util.js'

export const ITEM_TOOL = 'anyapi.twitter.tweet'
export const ITEM_COST_USD = 0.00075   // price of one call, used when treg does not report the charge
const HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'])
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const ROLES = ['brand', 'personal']
/** Sources whose spend counts in the daily budget of the watch (shared by the watch job and `item add`). */
export const BUDGET_SOURCES = ['watch', 'manual']
const NUM = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? n : d }

export class ItemUsageError extends Error {}

/** `https://x.com/<handle>/status/<id>` (twitter.com, www., mobile., any suffix or query) → { handle, id, url }. */
export function parseStatusUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) throw new ItemUsageError('usage: item add <url of an X post> [--role brand|personal]')
  let u
  try { u = new URL(s) } catch { throw new ItemUsageError(`not a URL: "${s.slice(0, 80)}" (an X post URL is expected, https://x.com/<handle>/status/<id>)`) }
  if (!['https:', 'http:'].includes(u.protocol) || !HOSTS.has(u.hostname.toLowerCase())) throw new ItemUsageError(`not an X post URL: ${u.hostname} (x.com or twitter.com expected)`)
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts[0] === 'i') throw new ItemUsageError('this URL does not name the author: give the post URL with its handle, https://x.com/<handle>/status/<id>')
  if (parts.length < 3 || !['status', 'statuses'].includes(parts[1]) || !/^\d{1,25}$/.test(parts[2]) || !HANDLE.test(parts[0])) {
    throw new ItemUsageError(`not an X post URL: ${s.slice(0, 120)} (https://x.com/<handle>/status/<id> expected)`)
  }
  return { handle: parts[0], id: parts[2], url: `https://x.com/${parts[0]}/status/${parts[2]}` }
}

/** Role of a new author without `--role`: the official account of a company or product looks like one by its name. */
export function guessRole(name) {
  const n = String(name || '')
  return /\.(com|io|ai|dev|org|net|fr|co|app|sh)\b/i.test(n) || /\b(official|officiel|team|labs?|inc|hq|news|media)\b/i.test(n) ? 'brand' : 'personal'
}
const competitorIn = (db, s) => (db.prepare('SELECT competitor_id FROM competitor_aliases WHERE instr(lower(?), lower(alias)) > 0 LIMIT 1').get(String(s || '')) || {}).competitor_id || null

/** What the agent is told about an item: its id and whether it can feed a post. */
function describe(db, iid, lead) {
  const it = db.prepare(`SELECT it.id, it.url, au.handle, au.watch_role, au.competitor_id AS author_competitor, s.competitor_id
    FROM items it LEFT JOIN accounts au ON au.id = it.author_id LEFT JOIN assessments s ON s.item_id = it.id WHERE it.id = ?`).get(iid)
  const out = [`${lead}: item #${it.id} (@${it.handle || '?'}, ${it.url || 'no URL'}).`]
  if (it.watch_role === 'reference') out.push('WARNING: its author is a reference account: this item can feed neither an idea nor a post (never quote it).')
  if (it.author_competitor || it.competitor_id) out.push('WARNING: it is about a competitor: internal watch only, it can feed neither an idea nor a post.')
  if (out.length === 1) out.push(`Quote it with post draft … --quote ${it.id} (or post revise <post_id> … --quote ${it.id}).`)
  return out.join('\n')
}

/** Spend of the watch budget today, the budget and the treg route ceiling. */
export function budgetState(db, now) {
  const budget = NUM(getGlobal(db, 'daily_budget_usd'), 0.25)
  const spent = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ingest_runs WHERE source IN (${BUDGET_SOURCES.map(() => '?').join(',')}) AND started_at >= ?`)
    .get(...BUDGET_SOURCES, utcDayStart(now)).c
  return { budget, spent, maxCost: getGlobal(db, 'treg_max_cost_per_call') || '0.002' }
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
}

/** Stores the post read from treg (`data` = anyapi output.data). Returns the item id. */
export function storeItem(db, ref, data, { role = null, cost = 0, now = new Date() } = {}) {
  const ts = utc(now)
  return tx(db, () => {
    // the author: by its numeric id first (the handle of a URL may be outdated), then by handle; on the main table so
    // that an account another user manages is found too (never duplicated)
    const authorId = data.authorId ? String(data.authorId) : null
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(String(data.authorHandle || '')) ? String(data.authorHandle) : ref.handle
    const name = data.authorName ? String(data.authorName).trim().slice(0, 120) : null
    let a = (authorId && db.prepare(`SELECT id, competitor_id FROM main.accounts WHERE network = 'x' AND external_id = ?`).get(authorId))
      || db.prepare(`SELECT id, competitor_id FROM main.accounts WHERE network = 'x' AND lower(handle) = lower(?)`).get(handle)
    if (!a) {
      const comp = competitorIn(db, `${handle} ${name || ''}`)
      const avatar = /^https:\/\//.test(String(data.authorImage || '')) ? String(data.authorImage) : null
      const id = Number(db.prepare(`INSERT INTO main.accounts(network, handle, external_id, display_name, avatar_url, relation, role, competitor_id) VALUES ('x', ?, ?, ?, ?, 'watched', ?, ?)`)
        .run(handle, authorId, name, avatar, role || guessRole(name), comp).lastInsertRowid)
      a = { id, competitor_id: comp }
    }
    const posted = data.createdUtc ? utc(new Date(Number(data.createdUtc) * 1000)) : null
    const media = Array.isArray(data.media) && data.media.length ? JSON.stringify(data.media) : null
    const url = `https://x.com/${handle}/status/${ref.id}`
    const iid = Number(db.prepare(`INSERT INTO main.items(network, external_id, author_id, kind, url, text, lang, posted_at, first_seen_at, media, conversation_id)
      VALUES ('x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ref.id, a.id, data.inReplyToId ? 'reply' : 'post', url, data.text || null, data.lang || null, posted, ts, media,
      data.conversationId ? String(data.conversationId) : ref.id).lastInsertRowid)
    db.prepare(`INSERT INTO main.item_metrics(item_id, captured_at, likes, views, shares, replies, saves) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(iid, ts, data.likes ?? null, data.views ?? null, data.retweets ?? null, data.replies ?? null, data.bookmarks ?? null)
    const run = Number(db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status) VALUES ('manual', ?, ?, 1, 1, ?, 'ok')`)
      .run(a.id, ts, cost).lastInsertRowid)
    db.prepare(`INSERT INTO main.captures(item_id, source, account_id, query, run_id, captured_at) VALUES (?, 'manual', NULL, ?, ?, ?)`).run(iid, ref.url, run, ts)
    // a competitor's text (its author is already flagged on the account): internal watch only, as in the triage
    const comp = a.competitor_id ? null : competitorIn(db, data.text)
    if (comp) {
      db.prepare(`INSERT INTO main.assessments(item_id, verdict, pillar, angle, score, competitor_id, assessed_by, assessed_at) VALUES (?, 'keep', 'competitor', ?, NULL, ?, 'agent', ?)`)
        .run(iid, 'competitor: internal watch only, no post idea', comp, ts)
    }
    return iid
  })
}

/**
 * `item add <url> [--role brand|personal]`. `withDb(fn, readOnly)` opens the studio's database for the user of the
 * command; `treg` is the connector (null = none). Returns the text for the agent; throws ItemUsageError or Error.
 */
export async function addItem({ withDb, treg, url, role = null, now = new Date() }) {
  const ref = parseStatusUrl(url)
  if (role != null && !ROLES.includes(String(role))) throw new ItemUsageError(`--role: ${ROLES.join(' | ')} expected (got "${String(role).slice(0, 20)}")`)
  const known = withDb((db) => {
    const r = db.prepare(`SELECT id FROM main.items WHERE network = 'x' AND external_id = ?`).get(ref.id)
    return r ? describe(db, r.id, 'already in the database (nothing fetched)') : null
  }, true)
  if (known) return known
  if (!treg) throw new Error('Growth Studio has no treg connector: it cannot read an X post (install the treg CLI and run `treg login`, or set tregMode to http in Settings › Plugins › Growth Studio).')
  const st = await treg.check()
  if (!st.ok) throw new Error(`The treg connector is unavailable, the post cannot be read: ${st.hint}`)
  const b = withDb((db) => budgetState(db, now), true)
  if (b.spent >= b.budget) throw new Error(`daily watch budget reached (${b.spent.toFixed(4)} / ${b.budget} $): try again tomorrow, or ask the user to raise "Daily watch budget" in the settings`)
  let json; let costUsd = 0
  try {
    ({ json, costUsd } = await treg.call(ITEM_TOOL, { url: ref.url }, { maxCost: b.maxCost }))
  } catch (e) {
    withDb((db) => db.prepare(`INSERT INTO main.ingest_runs(source, started_at, pages, items_new, cost_usd, status, error) VALUES ('manual', ?, 0, 0, 0, 'error', ?)`)
      .run(utc(now), String(e.message).slice(0, 300)))
    throw new Error(`the post could not be read through treg: ${e.message}${e.auth ? ' (treg refuses the key: `treg login`, or the treg key in the plugin settings)' : ''}`)
  }
  const out = (json && json.output) || {}
  const data = out.data || null
  // what treg charged: its own report, else the provider's (top-level costUsd of the answer), else the list price
  const cost = costUsd || NUM(json && json.costUsd, 0) || NUM(out.costUsd, 0) || ITEM_COST_USD
  if (!out.found || !data || String(data.id || ref.id) !== ref.id) {
    withDb((db) => db.prepare(`INSERT INTO main.ingest_runs(source, started_at, pages, items_new, cost_usd, status, error) VALUES ('manual', ?, 1, 0, ?, 'error', ?)`)
      .run(utc(now), cost, `post not found: ${ref.url}`))
    throw new Error(`post not found on X (deleted, private or wrong URL): ${ref.url}`)
  }
  return withDb((db) => {
    const iid = storeItem(db, ref, data, { role, cost, now })
    return describe(db, iid, `post stored (${cost.toFixed(5)} $)`)
  })
}
