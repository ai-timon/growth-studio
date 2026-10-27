// Sending of the validated prospecting replies (schema v22), called by the publishing tick of the host half (every
// 30 s) and by the "Publish" button of a reply. A reply has no editorial slot: the subject is time-sensitive, so it
// goes out as soon as the user validated it and the limits of its campaign allow it.
// Right before sending, everything is checked again on the database as it is now:
// - the post: a validated reply (validated_by written by the user's click), aimed at a known post, without URL and
//   without a competitor's name;
// - the affiliation of the targeted author: not a member of a competitor's team (competitor_team, official account,
//   handle or stored bio matching a competitor alias), not of unknown author; a post about a competitor only with a
//   critical candidate and an unaffiliated author. Any doubt refuses: the reply is marked failed, never sent;
// - the limits of the campaign (NULL = settings cascade account → organization → user): replies per day (local day of
//   the account's publish_tz), minutes since the account's last reply, days before replying to the same author
//   again, campaign switched on. A limit reached leaves the reply `approved`: it goes at the next allowed moment.
// One attempt only: a failure marks the post `failed` (the caller sends an urgent alert), nothing is retried.
// Success: the post is `published` with the id of the X post, its candidate `replied`, the cost in ingest_runs.
import { URL_IN_TEXT, authorBio } from './agent-tools.js'
import { resolve } from './accounts.js'
import { localParts, zonedToUtc } from './schedule.js'

/** Cost of one reply through the official API when treg does not report it (treg descriptor). */
export const REPLY_COST_USD = 0.015
const MAX_PER_TICK = 5
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const num = (v, fallback) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback }

/** Validated replies whose time has come (no slot, or a slot in the past): [{ id, owner }]. */
export function dueReplies(db, now = new Date()) {
  return db.prepare(`SELECT p.id, a.owner_user_id AS owner FROM posts p JOIN accounts a ON a.id = p.account_id
    WHERE p.kind = 'reply' AND p.reply_to_item_id IS NOT NULL AND p.status IN ('approved','scheduled')
      AND p.validated_by IS NOT NULL AND p.validated_at IS NOT NULL AND (p.scheduled_for IS NULL OR p.scheduled_for <= ?)
    ORDER BY p.validated_at, p.id LIMIT ?`).all(iso(now.getTime()), MAX_PER_TICK)
}

/** A reply aimed at a post goes through this module, never through the ordinary publishing. */
export const isTargetedReply = (p) => Boolean(p && p.kind === 'reply' && p.reply_to_item_id != null)

/** Start (UTC ms) of the local day of `now` in time zone `tz`. */
function dayStart(now, tz) {
  const d = localParts(now, tz)
  return zonedToUtc(d.year, d.month, d.day, 0, 0, tz).getTime()
}
function nextDayStart(now, tz) {
  const d = localParts(now, tz)
  const n = new Date(Date.UTC(d.year, d.month - 1, d.day + 1, 12))
  return zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz).getTime()
}

/**
 * Decides, on the database as it is now, what to do with reply `postId`:
 * { state: 'send', post, target, candidate } | { state: 'wait', reason, until } | { state: 'refuse', reason }.
 */
export function replyGate(db, postId, now = new Date()) {
  const refuse = (reason) => ({ state: 'refuse', reason })
  const p = db.prepare(`SELECT p.*, a.handle, a.network, a.relation FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?`).get(postId)
  if (!p) return refuse('post not found')
  if (!isTargetedReply(p)) return refuse('not a reply aimed at a post')
  if (!['approved', 'scheduled'].includes(p.status)) return refuse(`status ${p.status}: only a validated reply is sent`)
  if (!p.validated_by || !p.validated_at) return refuse('reply not validated by a user')
  if (p.relation !== 'owned') return refuse('a reply is only sent from a managed account')
  if (p.network && p.network !== 'x') return refuse(`network ${p.network}: replies are not supported yet`)
  const body = String(p.body || '')
  if (!body.trim()) return refuse('empty reply')
  if (URL_IN_TEXT.test(body)) return refuse('a reply holds no URL nor web address')
  if (db.prepare(`SELECT 1 FROM competitor_aliases WHERE instr(lower(?), lower(alias)) > 0`).get(body)) return refuse('the reply names a competitor')

  // the targeted post and its author
  const t = db.prepare(`SELECT i.id, i.external_id, i.network, i.extra, i.author_id, au.handle AS author, au.relation AS author_relation, au.competitor_id AS author_competitor
    FROM items i LEFT JOIN accounts au ON au.id = i.author_id WHERE i.id = ?`).get(p.reply_to_item_id)
  if (!t) return refuse('targeted post not found')
  if (!t.external_id) return refuse('targeted post without an X id')
  if (t.network && t.network !== 'x') return refuse(`targeted post on ${t.network}: replies are not supported yet`)
  if (t.author_id == null || !t.author) return refuse('targeted post of unknown author: never replied to')
  if (t.author_relation === 'owned') return refuse('targeted post written by a managed account')
  // ABSOLUTE: never a reply to a member of a competitor's team (same view as the SQL guard), nor to an author whose
  // stored bio names a competitor
  if (t.author_competitor != null || db.prepare('SELECT 1 FROM v_competitor_team_items WHERE item_id = ?').get(t.id)) {
    return refuse(`@${t.author} belongs to a competitor's team: never replied to`)
  }
  if (db.prepare(`SELECT 1 FROM competitor_team WHERE network = 'x' AND handle = ?`).get(String(t.author).replace(/^@/, ''))) {
    return refuse(`@${t.author} belongs to a competitor's team: never replied to`)
  }
  const bio = authorBio(t)
  if (bio && db.prepare(`SELECT 1 FROM competitor_aliases WHERE instr(lower(?), lower(alias)) > 0`).get(bio)) {
    return refuse(`the profile of @${t.author} names a competitor: affiliation in doubt, never replied to`)
  }

  // the candidate of the campaign this reply answers (a reply drafted outside a campaign has none)
  const c = db.prepare(`SELECT c.*, k.account_id AS campaign_account, k.active AS campaign_active, k.name AS campaign_name,
      k.max_replies_per_day, k.min_gap_min, k.same_author_days
    FROM comment_candidates c JOIN comment_campaigns k ON k.id = c.campaign_id WHERE c.post_id = ?`).get(p.id)
  const aboutCompetitor = Boolean(db.prepare('SELECT 1 FROM v_competitor_items WHERE item_id = ?').get(t.id))
  if (c) {
    if (c.campaign_account !== p.account_id) return refuse('the candidate belongs to a campaign of another account')
    if (c.item_id !== t.id) return refuse('the reply is not aimed at the post of its candidate')
    if (c.status === 'dismissed') return refuse(`candidate #${c.id} was dismissed`)
    if (c.status === 'replied') return refuse(`candidate #${c.id} was already replied to`)
    if (c.author_affiliation !== 'none') return refuse(`author affiliation of candidate #${c.id} is ${c.author_affiliation}: never replied to`)
    if (aboutCompetitor && c.competitor_stance !== 'critical') return refuse('post about a competitor that does not criticize it: never replied to')
  } else if (aboutCompetitor) {
    return refuse('post about a competitor without a critical candidate with an unaffiliated author: never replied to')
  }
  if (db.prepare(`SELECT 1 FROM posts WHERE account_id = ? AND reply_to_item_id = ? AND status = 'published' AND id <> ?`).get(p.account_id, t.id, p.id)) {
    return refuse(`@${p.handle} already replied to this post`)
  }

  // limits of the campaign (a reply without a campaign only keeps the gap of the account)
  const get = (k) => resolve(db, 'account', p.account_id, k).value
  const tz = get('publish_tz') || 'UTC'
  const t0 = now.getTime()
  const wait = (reason, until) => ({ state: 'wait', reason, until: until == null ? null : iso(until) })
  if (c && !c.campaign_active) return wait(`campaign "${c.campaign_name}" is switched off`, null)
  if (c) {
    const max = num(c.max_replies_per_day, num(get('comments_max_replies_per_day'), 10))
    const sent = db.prepare(`SELECT COUNT(*) AS n FROM posts p JOIN comment_candidates c ON c.post_id = p.id
      WHERE c.campaign_id = ? AND p.status = 'published' AND p.published_at >= ?`).get(c.campaign_id, iso(dayStart(now, tz))).n
    if (sent >= max) return wait(`daily limit of the campaign reached (${sent}/${max})`, nextDayStart(now, tz))
  }
  const gap = num(c ? c.min_gap_min : null, num(get('comments_min_gap_min'), 15))
  const last = db.prepare(`SELECT MAX(published_at) AS t FROM posts WHERE account_id = ? AND kind = 'reply' AND reply_to_item_id IS NOT NULL AND status = 'published'`).get(p.account_id).t
  if (last && gap > 0) {
    const until = new Date(last).getTime() + gap * 60_000
    if (until > t0) return wait(`${gap} min between two replies of @${p.handle}`, until)
  }
  if (c && c.same_author_days > 0) {
    const prev = db.prepare(`SELECT MAX(p.published_at) AS t FROM posts p JOIN items i ON i.id = p.reply_to_item_id
      WHERE p.account_id = ? AND p.kind = 'reply' AND p.status = 'published' AND i.author_id = ? AND p.id <> ?`).get(p.account_id, t.author_id, p.id).t
    if (prev) {
      const until = new Date(prev).getTime() + c.same_author_days * 86_400_000
      if (until > t0) return wait(`@${p.handle} already replied to @${t.author} less than ${c.same_author_days} days ago`, until)
    }
  }
  return { state: 'send', post: p, target: t, candidate: c || null }
}

/**
 * Checks reply `postId` again and sends it once through the account's treg tool (`in_reply_to`).
 * `db` is a writable connection (unscoped for the tick, the user's for the button: writes name `main.`).
 * Returns { state: 'sent', url, external_id, published_at, cost_usd } | { state: 'wait', reason, until }
 * | { state: 'failed', reason } (the post is then `failed`; the caller alerts the user). Never retries.
 */
export async function sendReply({ db, treg, postId, now = () => new Date() }) {
  const at0 = now()
  const g = replyGate(db, postId, at0)
  if (g.state === 'wait') return g
  // `cost` is set once treg was called: that attempt is recorded in ingest_runs
  const fail = (reason, cost = null) => {
    db.prepare(`UPDATE main.posts SET status = 'failed', validation_note = ? WHERE id = ? AND status IN ('approved','scheduled')`).run(`Reply not sent (${iso(now().getTime())}): ${reason}`, postId)
    if (cost != null) db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status, error) VALUES ('reply', ?, ?, 0, 0, ?, 'error', ?)`)
      .run(g.post.account_id, iso(at0.getTime()), cost, String(reason).slice(0, 500))
    return { state: 'failed', reason }
  }
  if (g.state === 'refuse') return fail(g.reason)
  const { post: p, target: t, candidate: c } = g
  const target = resolve(db, 'account', p.account_id, 'x_publish_target').value
  const authMethod = resolve(db, 'account', p.account_id, 'x_publish_auth_method').value
  if (!target) return fail(`@${p.handle} is not connected for publishing (Settings › ${p.handle} › Publishing: treg tool)`)
  let check
  try { check = await treg.check() } catch (e) { check = { ok: false, hint: e.message } }
  if (!check.ok) return fail(check.hint || 'treg is not available')

  let out
  try {
    out = await treg.call(target, { text: p.body, reply: { in_reply_to_tweet_id: String(t.external_id) } }, { authMethod: authMethod || null })
  } catch (e) { return fail(`reply refused by treg/X: ${e.message}`, 0) }
  const json = out && out.json
  const cost = out && Number(out.costUsd) > 0 ? Number(out.costUsd) : REPLY_COST_USD
  const tid = json && json.data && json.data.id
  if (!tid) return fail(`unreadable X answer: ${JSON.stringify(json).slice(0, 300)}`, cost)

  const url = `https://x.com/${p.handle}/status/${tid}`
  const at = iso(now().getTime())
  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE main.posts SET status = 'published', published_at = ?, external_id = ?, url = ? WHERE id = ?`).run(at, String(tid), url, p.id)
    if (c) db.prepare(`UPDATE main.comment_candidates SET status = 'replied', updated_at = ? WHERE id = ?`).run(at, c.id)
    db.prepare(`INSERT INTO main.ingest_runs(source, account_id, started_at, pages, items_new, cost_usd, status) VALUES ('reply', ?, ?, 0, 0, ?, 'ok')`).run(p.account_id, at, cost)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    // sent but not recorded as published: marked failed with its X id so that it is never sent again
    const reason = `reply sent (${url}) but not recorded: ${e.message}`
    db.prepare(`UPDATE main.posts SET status = 'failed', external_id = ?, url = ?, validation_note = ? WHERE id = ?`).run(String(tid), url, reason, p.id)
    return { state: 'failed', reason, url, external_id: String(tid) }
  }
  return { state: 'sent', url, external_id: String(tid), published_at: at, cost_usd: cost, candidate_id: c ? c.id : null }
}
