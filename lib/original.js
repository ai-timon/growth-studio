// Original post ideas (reflections, observations, analyses: neither news nor share), schema v16.
// v19: each idea carries a pain already identified and a solution already verified, with their source; no question
// to the user any more. With direct drafting (`original_auto_draft`), the same mission writes the posts right away.
// This module only holds the MECHANICS (reading ideas, technical frame of the missions, exchange format with the
// agent tools, refill). All the editorial substance (subjects, suggestion and writing instructions) comes from the
// account's settings (cascade account → organization → global, Settings › Original ideas); an empty instruction
// blocks the mission rather than inventing one.
import { localParts, parseHm, systemTimeZone } from './schedule.js'
import { parsePostTypes, resolve } from './accounts.js'
import { TOOLS_SKILL_ID } from './agent-channel.js'

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
export const IDEA_STATUSES = ['idea', 'approved', 'in_progress', 'done', 'dropped']

/** Effective "original ideas" settings of an account. */
export function originalConfig(db, accountId) {
  const v = (k) => resolve(db, 'account', accountId, k).value
  const int = (k, d) => { const n = Number(v(k)); return Number.isInteger(n) && n >= 0 ? n : d }
  return {
    enabled: v('source_original') === '1',
    autoDraft: v('original_auto_draft') === '1',
    themes: String(v('original_themes') || '').trim(),
    suggestPrompt: String(v('original_suggest_prompt') || '').trim(),
    writePrompt: String(v('original_write_prompt') || '').trim(),
    changelog: String(v('product_changelog') || '').trim(),
    batch: Math.min(Math.max(int('original_batch_size', 5), 1), 12),
    stockMin: int('original_stock_min', 0),
    window: { start: parseHm(v('publish_window_start')), end: parseHm(v('publish_window_end')), tz: v('publish_tz') },
  }
}

// ---------- post types (defined in the settings, `post_types`) ----------
export function postTypes(db, accountId) {
  return parsePostTypes(resolve(db, 'account', accountId, 'post_types').value)
}
const MIX_DAYS = 30
/** Mix of an account over 30 days (typed posts, not rejected) against the target shares; `next` = the type most behind. */
export function typeMix(db, accountId, types = postTypes(db, accountId)) {
  const since = new Date(Date.now() - MIX_DAYS * 86_400_000).toISOString()
  // a rewrite replaces the old version (moved to rejected): each post is counted once
  const rows = db.prepare(`SELECT post_type, COUNT(*) AS n FROM posts WHERE account_id = ? AND status <> 'rejected' AND created_at >= ? GROUP BY post_type`).all(accountId, since)
  const counts = Object.fromEntries(rows.filter((r) => r.post_type && types.some((t) => t.key === r.post_type)).map((r) => [r.post_type, r.n]))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const sumShare = types.reduce((a, t) => a + t.share, 0) || 1
  const mix = types.map((t) => {
    const target = Math.round((t.share / sumShare) * 100)
    const actual = total ? Math.round(((counts[t.key] || 0) / total) * 100) : 0
    return { key: t.key, label: t.label, target, actual, count: counts[t.key] || 0, gap: target - actual }
  })
  const next = mix.filter((m) => m.target > 0).sort((a, b) => b.gap - a.gap)[0] || null
  return { days: MIX_DAYS, total, mix, next: next ? next.key : null, since }
}
/** Instructions of the post types for a mission (all types, or one). */
export function typesBlock(types, only = null) {
  const list = only ? types.filter((t) => t.key === only) : types
  return list.map((t) => `• ${t.key}: ${t.label}${t.goal ? ` (goal: ${t.goal})` : ''}\n  Instruction: ${t.prompt}`).join('\n')
}

export function listIdeas(db, { accountId = null, statuses = null } = {}) {
  const where = ["i.kind = 'reflection'"]; const args = []
  if (accountId) { where.push('i.account_id = ?'); args.push(accountId) }
  if (statuses && statuses.length) { where.push(`i.status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses) }
  const rows = db.prepare(`SELECT i.id, i.title, i.concept, i.angle, i.why_follow, i.ask_rom, i.post_type, i.status, i.decision_note, i.decided_at, i.created_at,
      i.pain, i.solution, i.solution_kind, i.evidence, i.account_id, a.handle AS account, a.network, a.lang
    FROM ideas i LEFT JOIN accounts a ON a.id = i.account_id WHERE ${where.join(' AND ')}
    ORDER BY CASE i.status WHEN 'idea' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'approved' THEN 1 ELSE 2 END, COALESCE(i.decided_at, i.created_at) DESC LIMIT 200`).all(...args)
  const posts = rows.length ? db.prepare(`SELECT id, idea_id, status FROM posts WHERE idea_id IN (${rows.map(() => '?').join(',')}) ORDER BY id DESC`).all(...rows.map((r) => r.id)) : []
  const sources = rows.length ? db.prepare(`SELECT ii.idea_id, it.id, it.url, ac.handle FROM idea_items ii JOIN items it ON it.id = ii.item_id
      LEFT JOIN accounts ac ON ac.id = it.author_id WHERE ii.idea_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.id)) : []
  return rows.map((r) => ({ ...r,
    posts: posts.filter((p) => p.idea_id === r.id).map(({ id, status }) => ({ id, status })),
    sources: sources.filter((x) => x.idea_id === r.id).map(({ id, url, handle }) => ({ id, url, handle })) }))
}

/** Stock of an account: ideas waiting in the current format (the old ones with a question do not count) and, with
 *  direct drafting, drafts of original ideas waiting for the user. */
export function ideaStock(db, accountId) {
  const waiting = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE kind = 'reflection' AND account_id = ? AND status = 'idea'
    AND NOT (ask_rom IS NOT NULL AND pain IS NULL)`).get(accountId).n
  const drafts = db.prepare(`SELECT COUNT(DISTINCT p.idea_id) AS n FROM posts p JOIN ideas i ON i.id = p.idea_id
    WHERE i.kind = 'reflection' AND p.account_id = ? AND p.status = 'pending_validation'`).get(accountId).n
  return { waiting, drafts }
}

/** Suggestion request in progress for this account (mission started less than `hours` hours ago, not closed yet). */
export function pendingSuggest(db, accountId, hours = 6) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()
  return db.prepare(`SELECT id, mission_id, created_at FROM studio_requests WHERE kind = 'suggest' AND account_id = ? AND status = 'sent' AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(accountId, since) || null
}

const block = (label, text) => `${label} (a studio setting, an instruction from the user to follow):\n---\n${text}\n---`
const contextLine = (acc) => `Use the ${TOOLS_SKILL_ID} skill for every read and write. Before writing, run its \`account-context ${acc.handle}\` command (objectives, voice, rules and recent feedback for this account) and follow it to the letter.`
const closing = 'Non-interactive mission: no card, no question to the user, no publication.'
const changelogLine = (cfg) => cfg.changelog
  ? `A "product" solution is only a feature listed in the product changelog (${cfg.changelog}) or in the product's public documentation.`
  : 'No product changelog is configured: do not present any product feature as a solution (only "tool" or "method").'

/** Mission: propose `count` ideas for an account. Throws when the suggestion instruction is empty. */
export function suggestBrief(acc, cfg, { count, direction, requestId, types = [], mix = null }) {
  if (!cfg.suggestPrompt) throw new Error('empty suggestion instruction: fill it in Settings › Original ideas')
  if (cfg.autoDraft && !cfg.writePrompt) throw new Error('empty writing instruction: fill it in Settings › Original ideas')
  const file = `growth-studio-ideas-${requestId}.json`
  const mixLine = mix && mix.total ? `Mix over the last ${mix.days} days (actual / target): ${mix.mix.map((m) => `${m.key} ${m.actual} % / ${m.target} %`).join(', ')}. ` : ''
  return [
    `Growth Studio request: propose ${count} ORIGINAL post ideas for @${acc.handle} (${acc.network}, language ${acc.lang || 'of the account'}, account_id ${acc.id})` +
      (cfg.autoDraft ? ', then write the post of each one right away (direct drafting: the user only validates the drafts).' : '.'),
    contextLine(acc),
    `Then run \`ideas list --account ${acc.id}\`: ideas waiting, kept, dropped by the user (their reason is an instruction) and recent posts. Propose none of these subjects again.`,
    `Each idea relies on a pain ALREADY identified and a solution ALREADY verified, with their source: ask the user nothing, they must have nothing to write. ${changelogLine(cfg)}`,
    block('Suggestion instruction', cfg.suggestPrompt),
    cfg.themes ? block('Subjects', cfg.themes) : null,
    direction ? `Direction asked by the user for this time: "${direction}".` : null,
    types.length ? `${block('Post types', typesBlock(types))}\n${mixLine}Each idea targets ONE type (field "post_type"); spread the ${count} ideas according to the target shares, catching up first on the type most behind${mix && mix.next ? ` (${mix.next})` : ''}, and think the idea for its type (a "value" idea is not a "reach" idea rewritten).` : null,
    `Exchange format: write ${file} in your working folder, a JSON array of ${count} objects {"title": short title (140 characters at most), "pain": the pain in the reader's words, "solution": the concrete way out (what, how, the verified detail), "solution_kind": "product" | "tool" | "method", "evidence": where the pain and the solution come from (changelog version, documentation page, item, post or feedback of the user), "item_ids": ids of the items that fed it ([] if none), "concept": what the post will say in 2 or 3 sentences, "angle": the position defended (optional), "why_follow": why follow the account (optional)${types.length ? ', "post_type": the key of the targeted type' : ''}}, written in the account's language. ` +
      `Save them with \`ideas add --account ${acc.id} --file ${file} --request ${requestId}\` (refused if a competitor is named, a title already exists or an item is forbidden: fix it and run it again).` +
      (cfg.autoDraft ? '' : ' Do not write any post at this stage.'),
    cfg.autoDraft ? block('Writing instruction', cfg.writePrompt) : null,
    cfg.autoDraft ? 'Direct drafting: for each saved idea, write the post following the writing instruction and the instruction of its type in a text file, then `ideas post <id> --file <that file> --image-prompt "…" --image-prompt-code "…"` (both visual briefs, following the guides of account-context; a visual of our own, never a third party\'s image). The drafts stay in pending_validation: the user sees them in the Posts tab of the studio.' : null,
    `${closing} Finish with a short Timon notification (report): "${cfg.autoDraft ? `${count} original idea drafts ready` : `${count} original ideas proposed`} for @${acc.handle}".`,
  ].filter(Boolean).join('\n\n')
}

/** Mission: write the post of an idea the user kept. Throws when the writing instruction is empty. */
export function draftBrief(acc, cfg, idea, types = []) {
  const type = types.find((t) => t.key === idea.post_type)
  if (!cfg.writePrompt) throw new Error('empty writing instruction: fill it in Settings › Original ideas')
  return [
    `Request of the user from Growth Studio: write the post of original idea #${idea.id} ("${idea.title}") for @${acc.handle} (${acc.network}, account_id ${acc.id}).`,
    contextLine(acc),
    `Run \`ideas show ${idea.id}\`: the idea (pain, solution, sources) and the user's instruction, if any, which comes first.`,
    block('Writing instruction', cfg.writePrompt),
    type ? block(`Post type: ${type.label}`, typesBlock(types, type.key)) : null,
    `Write the text in a file of your working folder, then \`ideas post ${idea.id} --file <that file> --image-prompt "…" --image-prompt-code "…"\` ` +
      '(both visual briefs, following the guides of account-context; a visual of our own, never a third party\'s image). The draft stays in pending_validation: the user sees it in the Posts tab of the studio.',
    `${closing} Finish with a short Timon notification (report): "Draft ready: idea #${idea.id} for @${acc.handle}".`,
  ].filter(Boolean).join('\n\n')
}

/** Accounts to refill now: enabled, threshold > 0, inside their time window, under the threshold, no request in progress. */
export function accountsToRefill(db, now = new Date()) {
  const accounts = db.prepare(`SELECT id, handle, network, lang, owner_user_id FROM accounts WHERE relation = 'owned' ORDER BY id`).all()
  const out = []
  for (const a of accounts) {
    const cfg = originalConfig(db, a.id)
    if (!cfg.enabled || !cfg.stockMin || !cfg.suggestPrompt) continue
    const { start, end, tz } = cfg.window
    if (start && end) {
      const p = localParts(now, tz || systemTimeZone()); const cur = p.hour * 60 + p.minute
      if (cur < start.h * 60 + start.m || cur >= end.h * 60 + end.m) continue
    }
    if (cfg.autoDraft && !cfg.writePrompt) continue
    const stock = ideaStock(db, a.id)
    const open = stock.waiting + (cfg.autoDraft ? stock.drafts : 0)
    if (open >= cfg.stockMin) continue
    if (pendingSuggest(db, a.id, 12)) continue
    // at most one automatic refill per account and per day
    const today = db.prepare(`SELECT 1 FROM studio_requests WHERE kind = 'suggest' AND account_id = ? AND brief LIKE 'auto%' AND created_at >= ?`).get(a.id, new Date(now.getTime() - 20 * 3_600_000).toISOString())
    if (today) continue
    // direct drafting: just enough to get back to the threshold (each idea becomes a draft to validate)
    out.push({ account: a, cfg, count: cfg.autoDraft ? cfg.stockMin - open : Math.max(cfg.batch, cfg.stockMin - open) })
  }
  return out
}

export { nowIso }
