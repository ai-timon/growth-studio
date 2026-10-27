// Host half of Growth Studio: reads and WRITES its database (lib/db.js: shipped schema, migrations, choice of the file;
// node:sqlite, Node >= 22.13),
// exposes the API under /api/plugins/growth-studio/, schedules validated posts on the account's slots
// and publishes at the planned time (media through GetXAPI, post through the treg CLI); a validated prospecting reply
// goes out as soon as its campaign's limits allow it (lib/replies.js).
// The guards stay those of the database (triggers: validation, media, competitors, owned account).
// Multi-user: every request runs for the signed-in Timon user and only sees and changes that user's data; the filter
// is lib/scope.js, applied to every connection opened during the request (withDb), never route by route.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { SCHEDULE_DEFAULTS, parseHm, nextFreeSlot as computeNextSlot } from './schedule.js'
import {
  accountRow, agentSetting, createAccount, createOrganization, deleteAccount, deleteOrganization, getterFor, importVoice, resolve,
  saveScoped, saveVoice, scopeView, tree, updateAccount, updateOrganization, SETTING_KEYS, USER_KEYS,
} from './accounts.js'
import { SETUP_SKILL_ID, installSetupSkill, installToolsSkill, nodeCommand, toolCommand } from './agent-channel.js'
import { UsageError, inlineInput, isReadOnly, parseArgv, runTool } from './agent-tools.js'
import { ItemUsageError, addItem } from './item-add.js'
import { dueReplies, isTargetedReply, sendReply } from './replies.js'
import { IMAGE_ENGINES, NO_GUIDE, ownerLine, askBrief, commentsBrief, requireInstruction, itemDraftBrief, newsBrief, postBrief, ruleMemoryBrief, synthesisBrief, triageBrief } from './briefs.js'
import { createConnectors } from './connectors/index.js'
import { pollBookmarks } from './jobs/bookmarks.js'
import { pollWatch } from './jobs/watch.js'
import { pollSynthesis } from './jobs/synthesis.js'
import { pollComments } from './jobs/comments.js'
import { drain, ensureSpool, spoolDir } from './spool.js'
import { applyKvSteps, dataPaths, openDatabase, resolveMedia } from './db.js'
import { importDatabase } from './import.js'
import {
  COMMENT_REPLY, addAlias, addTeamMember, approveReply, checkReplyText, createCampaign, createCompetitor, createPain, dismissReply, listCampaigns,
  listCompetitors, listReplies, removeAlias, removeTeamMember, replyCounts, todayCounters, updateCampaign, updateCompetitor, updatePain,
} from './comments.js'
import { adoptStrays, assertVisible, checkOwnerId, claimDatabase, knownOwners, namedResources, scopeDb, strayCounts } from './scope.js'
import { BACKUPS_KEEP_DEFAULT, upgradeDatabase, writeRefusal } from './upgrade.js'
import { AGENT_NAME_RE, AGENT_PROMPT, AGENT_ROLE, WRITING_KEYS, applyStarter, connectorGuide, nodeOk, policySnippet, setupData } from './setup.js'
import { IDEA_STATUSES, accountsToRefill, draftBrief, listIdeas, originalConfig, pendingSuggest, postTypes, suggestBrief, typeMix, typesBlock } from './original.js'

export const name = 'growth-studio'
export const inject = ['settings', 'notify', 'storage']

const DEFAULTS = { ...SCHEDULE_DEFAULTS }
const TICK_MS = 30_000
const REFILL_MS = 10 * 60_000   // check of the stock of original ideas
const SPOOL_MS = 300            // agent tool requests (lib/spool.js)
const JOB_MS = 60_000           // background jobs (bookmarks, watch): each checks itself whether it is due
const HTML_MAX_BYTES = 2 * 1024 * 1024
const FEED_SOURCES = ['bookmark', 'brand', 'watch']
/** Who is acting in this request, as written in `validated_by` / `assessed_by`: the Timon user, never a fixed name.
 *  Without a signed-in user nothing is validated (the SQL guards need a name). */
function actorOf(ctx) {
  let u = null
  try { u = ctx.user() } catch { u = null }
  const who = u && String(u.name || u.email || u.id || '').trim()
  if (!who) throw new Error('no signed-in Timon user: the studio cannot record who validated')
  return who
}

// ---------- utilities ----------
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const toIso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z')
const hasMedia = (m) => Boolean(m && m !== '' && m !== '[]')
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback } catch { return fallback } }

/** Where the data lives (database, media folder), from the `dataSource` / `legacyDbPath` settings: see lib/db.js. */
const pathsOf = (ctx) => dataPaths({
  storageDir: ctx.storage.dir,
  dataSource: String(ctx.settings.get('dataSource') || 'plugin'),
  legacyDbPath: String(ctx.settings.get('legacyDbPath') || ''),
})
/** The database file: the single place that picks it (through pathsOf). */
const dbPathOf = (ctx) => pathsOf(ctx).db
const PLUGIN_VERSION = (() => { try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '') } catch { return '' } })()
// Set when the database could not be prepared at startup (missing file, too old): every access reports it.
let dbError = null
// State of the data after the startup update (lib/upgrade.js):
//   ok        — normal;
//   read-only — a migration (or the backup before it) failed: the database is back at its version, reads work,
//               nothing is written, no job runs (publication, missions, agent writes);
//   newer     — the database was written by a newer plugin: same restrictions, until that version is reinstalled;
//   error     — the database cannot be used at all (dbError).
let dbState = { mode: 'ok' }
// kv keys renamed by a migration (applyKvSteps): startup reads of the kv store wait for it
let kvReady = Promise.resolve()
/** Why nothing may be written or started right now, or null. */
const writeBlock = () => (dbState.mode === 'read-only' || dbState.mode === 'newer' ? dbState.message : null)
function assertWritable() { const why = writeBlock(); if (why) throw new Error(why) }
const newerMessage = (version, known, writer) =>
  `database v${version}, plugin knows v${known}: ${writer ? `install Growth Studio v${writer} or newer` : 'install a newer version of Growth Studio'}. Until then the studio is read-only: nothing is written and nothing is published, watched or sent to the agent.`
// kv record of the plugin version that brought the database to each schema version, readable by any older version
// (it lives outside the database) so that it can name the version to reinstall.
const WRITERS_KEY = 'schemaWriters'
async function recordWriter(ctx, version) {
  if (!PLUGIN_VERSION) return
  const writers = (await ctx.storage.kv.get(WRITERS_KEY)) || {}
  if (writers[version]) return
  await ctx.storage.kv.set(WRITERS_KEY, { ...writers, [version]: PLUGIN_VERSION })
}
/** Test seam only: the migrations folder used at startup (default: the shipped one). */
export const testing = { migrationsDir: null }
const migrationsDir = () => testing.migrationsDir || undefined
const backupsKeep = (ctx) => { const n = Number(ctx.settings.get('backupsToKeep')); return Number.isInteger(n) && n >= 1 ? n : BACKUPS_KEEP_DEFAULT }
/**
 * Creates the plugin database from the shipped schema if needed and applies pending migrations, with a backup first
 * and checks after each step (lib/upgrade.js). Sets dbState; never leaves a half-migrated database.
 */
function prepareDb(ctx) {
  const p = pathsOf(ctx)
  dbError = null
  dbState = { mode: 'ok' }
  try {
    if (p.source === 'legacy' && !existsSync(p.db)) throw new Error(`legacy database not found: ${p.db} (setting legacyDbPath)`)
    if (p.fallback) ctx.log.warn(`studio: no plugin database yet, using the project database ${p.db} until an import`)
    if (p.source === 'plugin') mkdirSync(p.mediaDir, { recursive: true })
    mkdirSync(ctx.storage.dir, { recursive: true })   // backups before a migration go there, whichever database is served
    const r = upgradeDatabase(p.db, { backupDir: ctx.storage.dir, keep: backupsKeep(ctx), allowCreate: p.source === 'plugin', paths: p, migrationsDir: migrationsDir() })
    if (r.state === 'newer') {
      dbState = { mode: 'newer', version: r.from, known: r.known, message: newerMessage(r.from, r.known, null) }
      ctx.log.error(`studio: ${dbState.message}`)
      Promise.resolve().then(() => ctx.storage.kv.get(WRITERS_KEY)).then((w) => {
        if (dbState.mode === 'newer' && w && w[r.from]) dbState = { ...dbState, message: newerMessage(r.from, r.known, w[r.from]) }
      }).catch(() => {})
    } else if (r.state === 'failed') {
      dbState = {
        mode: 'read-only', version: r.from, known: r.known, backup: r.backup, error: r.error,
        message: `Database update failed: ${r.error}. Growth Studio is read-only: nothing is written and nothing is published, watched or sent to the agent.${r.backup ? ` A copy taken before the update is at ${r.backup}.` : ''} Install a fixed version of the plugin, or report this message.`,
      }
      ctx.log.error(`studio: ${dbState.message}`)
    } else {
      if (r.applied.length) ctx.log.info(`studio: database ${p.db} at version ${r.to} (applied: ${r.applied.join(', ')}${r.backup ? `; backup ${r.backup}` : ''})`)
      for (const f of r.pruned) ctx.log.info(`studio: old backup removed ${f}`)
      Promise.resolve().then(() => recordWriter(ctx, r.to)).catch((e) => ctx.log.warn(`studio: schema version not recorded (${e.message})`))
      kvReady = Promise.resolve().then(() => applyKvSteps(ctx.storage.kv, r.to, migrationsDir())).catch((e) => ctx.log.warn(`studio: stored keys not migrated (${e.message})`))
    }
  } catch (e) {
    dbError = `database not ready: ${e.message}`
    dbState = { mode: 'error', message: dbError }
    ctx.log.error(`studio: ${dbError}`)
  }
  return p
}
/** What the UI shows about the data: never touches the database. */
export const dataStatus = () => ({ ...dbState, writable: dbState.mode === 'ok' })
// The Timon user a request (or an agent command) runs for: { owner, admin }. Every connection opened while it is set
// is scoped to that user (lib/scope.js). Background jobs run outside it and see the whole database.
const viewer = new AsyncLocalStorage()
const ownerNow = () => { const v = viewer.getStore(); return v ? v.owner : null }
function openDb(ctx, readOnly = false) {
  if (dbError) throw new Error(dbError)
  if (!readOnly) assertWritable()
  const file = dbPathOf(ctx)
  if (!existsSync(file)) throw new Error(`database not found: ${file}`)   // never create an empty one by accident
  const db = openDatabase(file, { readOnly })
  const v = viewer.getStore()
  if (v) { try { scopeDb(db, v.owner, { readOnly, admin: v.admin }) } catch (e) { db.close(); throw e } }
  return db
}
function withDb(ctx, fn, readOnly = false) {
  const db = openDb(ctx, readOnly)
  try { return fn(db) } finally { try { db.close() } catch { /* already closed */ } }
}
/** The whole database, whoever the request is for: adoption of rows without owner, list of the owners. */
const withSystemDb = (ctx, fn, readOnly = false) => viewer.exit(() => withDb(ctx, fn, readOnly))
/** Effective value of a setting at the global level (the user's, see accounts.js), default of the code otherwise. */
const setting = (db, key) => resolve(db, 'global', 0, key).value || DEFAULTS[key]
export const AGENT_MISSING = 'No agent configured for Growth Studio: choose one in the Set up of the studio (Settings › Set up), or in Settings › Plugins › Growth Studio (field "Agent").'
/** The plugin-wide agent (plugin setting `agent`): the default of every mission, empty until the user picks one. */
function agentOf(ctx) {
  const a = String(ctx.settings.get('agent') || '').trim()
  if (!a) throw new Error(AGENT_MISSING)
  return a
}

// ---------- queries ----------
const POST_SELECT = `
  SELECT p.id, p.idea_id, p.account_id, p.kind, p.post_type, p.lang, p.body, p.media, p.image_prompt, p.image_prompt_code, p.no_media, p.quote_item_id, p.reply_to_item_id,
         p.status, p.supersedes_post_id, p.validation_note, p.created_at, p.validated_at, p.validated_by,
         p.scheduled_for, p.published_at, p.external_id, p.url,
         a.handle AS account, a.network, a.display_name AS account_name, a.avatar_url AS account_avatar,
         i.title AS idea_title, i.concept AS idea_concept, i.pillar AS idea_pillar, i.origin AS idea_origin,
         (SELECT au.handle FROM post_items pi JOIN items it ON it.id = pi.item_id LEFT JOIN accounts au ON au.id = it.author_id
            WHERE pi.post_id = p.id ORDER BY it.posted_at LIMIT 1) AS source_author,
         (SELECT it.url FROM post_items pi JOIN items it ON it.id = pi.item_id WHERE pi.post_id = p.id ORDER BY it.posted_at LIMIT 1) AS source_url,
         (SELECT COUNT(*) FROM posts v WHERE v.supersedes_post_id = p.id) AS superseded_count,
         (SELECT MAX(r.created_at) FROM studio_requests r WHERE r.post_id = p.id AND r.kind = 'image') AS image_requested_at
  FROM posts p
  JOIN accounts a ON a.id = p.account_id
  LEFT JOIN ideas i ON i.id = p.idea_id`

function shapePost(row) {
  if (!row) return null
  const media = parseJson(row.media, [])
  return {
    ...row,
    media,
    has_media: media.length > 0,
    can_publish: media.length > 0 || (row.kind === 'quote' && row.quote_item_id != null) || Boolean(row.no_media),
    has_url: /https?:\/\/|\bt\.co\b|\bx\.com\b|\bgithub\.com\b/i.test(row.body || ''),
    // a quote goes out through GetXAPI (real quote, 0.002 $); otherwise the official API through treg (0.20 $ with a URL).
    // `reason` is a key the interface translates: 'quote' | 'link' | null.
    cost: row.kind === 'quote' && row.quote_item_id != null ? { usd: 0.002, reason: 'quote' }
      : /https?:\/\/|\bt\.co\b|\bx\.com\b|\bgithub\.com\b/i.test(row.body || '') ? { usd: 0.2, reason: 'link' } : { usd: 0.015, reason: null },
  }
}

// replies to comment candidates have their own view (Comments): the Posts queue leaves them out
function listPosts(db, { statuses, limit = 200 }) {
  const where = `WHERE NOT ${COMMENT_REPLY}${statuses && statuses.length ? ` AND p.status IN (${statuses.map(() => '?').join(',')})` : ''}`
  const rows = db.prepare(`${POST_SELECT} ${where} ORDER BY COALESCE(p.scheduled_for, p.published_at, p.created_at) DESC LIMIT ?`).all(...(statuses || []), limit)
  return rows.map(shapePost)
}

function itemsOf(db, postId) {
  const rows = db.prepare(`
    SELECT it.id, it.kind, it.url, it.text, it.lang, it.posted_at, it.media, it.conversation_id, it.quoted_item_id, pi.relation,
           au.handle AS author, au.display_name AS author_name, au.avatar_url,
           (SELECT likes FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS likes,
           (SELECT views FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS views,
           (SELECT saves FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS saves
    FROM post_items pi JOIN items it ON it.id = pi.item_id LEFT JOIN accounts au ON au.id = it.author_id
    WHERE pi.post_id = ? ORDER BY it.posted_at`).all(postId)
  return rows.map((r) => ({ ...r, media: parseJson(r.media, []) }))
}

const PENDING_MAX_MIN = 45   // beyond that, a request without result is considered lost (failed mission?)
/** Last write date of the first media (ISO), to know whether a requested visual has arrived. */
function mediaMtime(paths, media) {
  const m = media && media[0]
  if (!paths || !m || !m.path) return null
  const f = resolveMedia(paths, m.path)
  if (!f || !existsSync(f)) return null
  try { return toIso(statSync(f).mtimeMs) } catch { return null }
}
/** State of the requests in progress on a post: visual (arrived when the file is newer than the request) and
 *  rewrite (arrived when a new version exists). `stale`: nothing received after PENDING_MAX_MIN minutes. */
function pendingOf(db, post, mtime) {
  const last = (kind) => db.prepare(`SELECT id, created_at, mission_id FROM studio_requests WHERE post_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).get(post.id, kind)
  const shape = (r) => { const age = (Date.now() - new Date(r.created_at).getTime()) / 60_000; return { since: r.created_at, mission_id: r.mission_id, minutes: Math.max(0, Math.floor(age)), stale: age > PENDING_MAX_MIN } }
  const img = last('image'); const rw = last('rewrite')
  return {
    image: img && !(mtime && mtime >= img.created_at) ? shape(img) : null,
    rewrite: rw && !db.prepare('SELECT 1 FROM posts WHERE supersedes_post_id = ? AND created_at >= ?').get(post.id, rw.created_at) ? shape(rw) : null,
  }
}

function postDetail(db, id, paths = null) {
  const post = shapePost(db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(id))
  if (!post) return null
  post.media_mtime = mediaMtime(paths, post.media)
  post.pending = pendingOf(db, post, post.media_mtime)
  post.image_engine = resolve(db, 'account', post.account_id, 'image_engine').value
  post.types = postTypes(db, post.account_id).map(({ key, label }) => ({ key, label }))
  const sources = itemsOf(db, id)
  if (post.quote_item_id && !sources.some((s) => s.id === post.quote_item_id)) {
    const q = db.prepare(`SELECT it.id, it.kind, it.url, it.text, it.posted_at, it.media, au.handle AS author, au.display_name AS author_name, au.avatar_url FROM items it LEFT JOIN accounts au ON au.id = it.author_id WHERE it.id = ?`).get(post.quote_item_id)
    if (q) sources.unshift({ ...q, media: parseJson(q.media, []), relation: 'quotes' })
  }
  // versions: the chain of drafts this one replaces, and those that replace it
  const versions = []
  let cur = post.supersedes_post_id
  while (cur && versions.length < 10) {
    const v = db.prepare('SELECT id, status, created_at, body, validation_note, supersedes_post_id FROM posts WHERE id = ?').get(cur)
    if (!v) break
    versions.push(v); cur = v.supersedes_post_id
  }
  const successors = db.prepare('SELECT id, status, created_at FROM posts WHERE supersedes_post_id = ?').all(id)
  const metrics = db.prepare('SELECT * FROM post_metrics WHERE post_id = ? ORDER BY captured_at DESC LIMIT 1').get(id) || null
  const news = db.prepare('SELECT id, status, detected_at, posted_at FROM news_queue WHERE post_id = ?').get(id) || null
  const missions = db.prepare("SELECT id, kind, created_at, mission_id, status FROM studio_requests WHERE post_id = ? ORDER BY id DESC LIMIT 5").all(id)
  return { post, sources, versions, successors, metrics, news, missions }
}

// ---------- learning (the user's feedback, schema v14; read back by the weekly synthesis) ----------
const CATEGORIES = ['fond', 'ton', 'longueur', 'fait', 'timing', 'visuel', 'autre']
const catOf = (c) => (CATEGORIES.includes(c) ? c : null)
/** Qualified feedback of the user (rejection, rewrite asked). `ignored`: a test or a misclick, nothing to learn. */
function recordFeedback(db, { postId, source, text, category, ignored }) {
  const acc = postId ? db.prepare('SELECT account_id FROM posts WHERE id = ?').get(postId) : null
  db.prepare('INSERT INTO main.learnings(created_at, post_id, text, source, category, ignored, account_id, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), postId, text, source, catOf(category), ignored ? 1 : 0, acc ? acc.account_id : null, ownerNow())
}
/** Direct edit of the text by the user: one row per post, the agent's text is kept, the user's follows their edits. */
function recordEdit(db, postId, after) {
  const p = db.prepare('SELECT body, account_id FROM posts WHERE id = ?').get(postId)
  if (!p || typeof after !== 'string' || after.trim() === String(p.body || '').trim()) return
  const row = db.prepare(`SELECT id, before_text FROM learnings WHERE source = 'edit' AND post_id = ?`).get(postId)
  if (row) {
    if (after.trim() === String(row.before_text || '').trim()) db.prepare('DELETE FROM main.learnings WHERE id = ?').run(row.id)   // back to the agent's text
    else db.prepare('UPDATE main.learnings SET after_text = ?, created_at = ?, synthesized_at = NULL WHERE id = ?').run(after, nowIso(), row.id)
  } else {
    db.prepare(`INSERT INTO main.learnings(created_at, post_id, text, source, before_text, after_text, account_id) VALUES (?, ?, 'Direct edit of the text by the user', 'edit', ?, ?, ?)`)
      .run(nowIso(), postId, p.body, after, p.account_id)
  }
}
const LEARNING_SELECT = `SELECT l.id, l.created_at, l.post_id, l.source, l.category, l.ignored, l.text, l.before_text, l.after_text, l.synthesized_at,
  l.account_id, a.handle AS account, p.body AS post_body, p.kind AS post_kind FROM learnings l LEFT JOIN posts p ON p.id = l.post_id LEFT JOIN accounts a ON a.id = l.account_id`

// ---------- scheduling (rule in schedule.js) ----------
// Scheduling settings of the account (cascade account → organization → global, accounts.js).
const nextFreeSlot = (db, accountId) => computeNextSlot(db, accountId, getterFor(db, accountId))
function windowOf(db, accountId = null) {
  const get = getterFor(db, accountId)
  return { start: parseHm(get('publish_window_start')), end: parseHm(get('publish_window_end')), gapMin: Number(get('publish_gap_min')), gapMax: Number(get('publish_gap_max')), tz: get('publish_tz') }
}

// ---------- publication ----------
// Providers sit behind the connectors (lib/connectors/): treg publishes ordinary posts, GetXAPI uploads media and
// publishes quotes. Each one is checked before anything is sent, so a missing connector costs nothing.
const connectorsByCtx = new WeakMap()
const connectorsOf = (ctx) => {
  if (!connectorsByCtx.has(ctx)) connectorsByCtx.set(ctx, createConnectors(ctx))
  return connectorsByCtx.get(ctx)
}

/** Publishes ONE post: checks its state in the database, uploads the media, posts through treg, records. Throws otherwise. */
async function publishPost(ctx, postId, { trigger }) {
  assertWritable()   // never publish what could not be recorded afterwards
  const paths = pathsOf(ctx)
  const db = openDb(ctx)
  let p, conn
  try {
    p = db.prepare(`SELECT p.*, a.handle, a.network FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?`).get(postId)
    if (!p) throw new Error('post not found')
    // Publishing connection OWN to the account (never inherited): without it, refuse rather than post elsewhere.
    conn = {
      target: resolve(db, 'account', p.account_id, 'x_publish_target').value,
      authMethod: resolve(db, 'account', p.account_id, 'x_publish_auth_method').value,
      tokenSecret: resolve(db, 'account', p.account_id, 'getxapi_token_secret').value,
    }
    if (!['approved', 'scheduled'].includes(p.status)) throw new Error(`status ${p.status}: only a validated post (approved/scheduled) is published`)
    if (!p.validated_by || !p.validated_at) throw new Error('post not validated by a user')
    if (p.network && p.network !== 'x') throw new Error(`network ${p.network}: publishing is not supported yet`)
  } finally { db.close() }
  if (isTargetedReply(p)) return publishReply(ctx, postId, { trigger })

  const media = parseJson(p.media, [])
  let quoteUrl = null
  if (p.kind === 'quote' && p.quote_item_id) {
    const q = withDb(ctx, (d) => d.prepare('SELECT i.external_id, a.handle FROM items i LEFT JOIN accounts a ON a.id = i.author_id WHERE i.id = ?').get(p.quote_item_id), true)
    if (!q) throw new Error('quoted post not found in the database')
    quoteUrl = `https://x.com/${q.handle || 'i/web'}/status/${q.external_id}`
  }
  if (!quoteUrl && !conn.target) throw new Error(`@${p.handle} is not connected for publishing (Settings › ${p.handle} › Publishing: treg tool)`)
  if (media.length > 4 || (!media.length && !quoteUrl && !p.no_media)) throw new Error('no media (1 to 4 images; a quote or a post marked "Publish without a visual" can do without)')
  const files = media.map((m) => {
    const f = resolveMedia(paths, m.path)
    if (!f || !existsSync(f)) throw new Error(`media file not found: ${m.path || '(no path)'}`)
    return f
  })
  const { treg, getxapi } = connectorsOf(ctx)
  // every connector this post needs is checked first: nothing is uploaded for a post that cannot go out
  if (files.length || quoteUrl) {
    const g = await getxapi.check({ tokenSecret: conn.tokenSecret })
    if (!g.ok) throw new Error(g.hint)
  }
  if (!quoteUrl) {
    const t = await treg.check()
    if (!t.ok) throw new Error(t.hint)
  }
  const mediaIds = []
  for (const f of files) mediaIds.push(await getxapi.uploadMedia(f, conn.tokenSecret))
  let tid
  if (quoteUrl) {
    // Quote: a real quote through GetXAPI, 0.002 $, with no URL in the text.
    // The official API refuses quote_tweet_id on a third party and bills 0.20 $ for a URL pasted in the text.
    tid = await getxapi.createQuote({ text: p.body, quoteUrl, mediaIds, tokenSecret: conn.tokenSecret })
  } else {
    const payload = { text: p.body }
    if (mediaIds.length) payload.media = { media_ids: mediaIds }
    let json
    try { ({ json } = await treg.call(conn.target, payload, { authMethod: conn.authMethod || null })) } catch (e) { throw new Error(`publication refused by treg/X: ${e.message}`) }
    tid = json && json.data && json.data.id
    if (!tid) throw new Error(`unreadable X answer: ${JSON.stringify(json).slice(0, 300)}`)
  }
  const url = `https://x.com/${p.handle}/status/${tid}`
  const at = nowIso()
  withDb(ctx, (d) => {
    d.prepare(`UPDATE main.posts SET status = 'published', published_at = ?, external_id = ?, url = ? WHERE id = ?`).run(at, String(tid), url, postId)
    d.prepare(`UPDATE main.news_queue SET status = 'published' WHERE post_id = ? AND status IN ('drafted','validated')`).run(postId)
    d.prepare(`UPDATE main.ideas SET status = 'done' WHERE id = (SELECT idea_id FROM posts WHERE id = ?) AND status <> 'dropped'`).run(postId)
  })
  ctx.notify.report(`Post #${postId} published on @${p.handle}`, `${url} (${trigger})`)
  return { url, external_id: String(tid), published_at: at }
}

/** Sends ONE validated reply (lib/replies.js). A limit reached throws without changing the post (it stays validated);
 *  a refusal or a failure has already marked it `failed` and throws. */
async function publishReply(ctx, postId, { trigger }) {
  assertWritable()
  const db = openDb(ctx)
  let r
  try {
    db.exec('PRAGMA foreign_keys = ON')
    r = await sendReply({ db, treg: connectorsOf(ctx).treg, postId })
  } finally { try { db.close() } catch { /* already closed */ } }
  if (r.state === 'wait') throw Object.assign(new Error(`reply not sent yet: ${r.reason}${r.until ? ` (next attempt from ${r.until})` : ''}`), { replyWait: true })
  if (r.state !== 'sent') throw Object.assign(new Error(r.reason), { replyFailed: true })
  const handle = withDb(ctx, (d) => d.prepare('SELECT a.handle FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?').get(postId), true)
  ctx.notify.report(`Reply #${postId} sent${handle ? ` from @${handle.handle}` : ''}`, `${r.url} (${trigger})`)
  return { url: r.url, external_id: r.external_id, published_at: r.published_at }
}

// ---------- plugin ----------
export function apply(ctx) {
  const raw = ctx.router()
  // The interface proxy (/api/ui/plugins/…) does not pass the query string on: the client slips it into a
  // `_q/<encoded query>/<route>` segment that is put back in place before the routes (feed filters, pagination…).
  raw.use((req, _res, next) => {
    const m = /^\/_q\/([^/]+)(\/.*)$/.exec(req.url)
    if (m) { const qs = decodeURIComponent(m[1]); req.url = `${m[2]}?${qs}`; req.query = Object.fromEntries(new URLSearchParams(qs)) }
    next()
  })
  const inFlight = new Set()

  const fail = (res, error, status = 400) => res.status(status).json({ error: error instanceof Error ? error.message : String(error) })
  /** Tells the open tabs of the users concerned to reload: the request's user by default, else `owners`. */
  const changed = (payload, owners = null) => {
    for (const o of new Set((owners || [ownerNow()]).filter(Boolean))) {
      try { ctx.realtime.publish('changed', payload, { ownerUserId: o }) } catch (e) { ctx.log.warn(`realtime: ${e.message}`) }
    }
  }
  const allOwners = () => { try { return withSystemDb(ctx, (db) => knownOwners(db), true) } catch { return [] } }
  // a missing record of the studio answers 404, and so does a record of another user (lib/scope.js); any other error
  // (a connector, the database itself) answers 400
  const NOT_FOUND = /^(post|quoted post|media file|media|file|account|account of the idea|target account|idea|feedback|proposal|item|organization|request|setting|campaign|pain|candidate|competitor|team member) not found\b/
  const run = (fn) => async (req, res) => { try { await fn(req, res) } catch (e) { fail(res, e, NOT_FOUND.test(String(e.message)) ? 404 : 400) } }

  // Every route runs for the signed-in user (no user: 401, except the routes below). Before the route, the resources
  // it names (`:id`, `?account=`, `account_id` / `organization_id` of the body) are looked up for that user: another
  // user's resource answers 404, exactly like a missing one. One place for every route.
  const PUBLIC = new Set(['/i18n/:locale', '/status'])
  const forUser = (route, handler) => async (req, res, next) => {
    let u = null
    try { u = ctx.user() } catch { u = null }
    if (!u || u.id == null || String(u.id) === '') return PUBLIC.has(route) ? handler(req, res, next) : fail(res, 'no signed-in Timon user', 401)
    let me
    try { me = { owner: checkOwnerId(u.id), admin: Boolean(u.is_superadmin), request: true } } catch (e) { return fail(res, e, 401) }
    return viewer.run(me, async () => {
      try {
        claimIfFirst(me)
        const named = namedResources(route, req)
        if (named.length && !dbError) withDb(ctx, (db) => assertVisible(db, named), true)
      } catch (e) { return fail(res, e, NOT_FOUND.test(String(e.message)) ? 404 : 400) }
      return handler(req, res, next)
    })
  }
  const router = Object.fromEntries(['get', 'post', 'put', 'patch'].map((m) => [m, (route, handler) => raw[m](route, forUser(route, handler))]))

  // Rows written before multi-user (or by a tool outside the plugin) have no owner. They go to the user the previous
  // version recorded (kv `ownerUserId`, read once then removed), else to the first administrator who opens the studio
  // while the database has no owner at all; afterwards, as long as the installation has a single user, new rows
  // without owner are given to that user (lib/scope.js).
  let claimChecked = false
  function claim(owner, why) {
    if (dbError || writeBlock()) return false
    return withSystemDb(ctx, (db) => {
      if (knownOwners(db).length || !Object.keys(strayCounts(db)).length) return true
      const r = claimDatabase(db, owner, USER_KEYS)
      ctx.log.info(`studio: existing data given to user ${owner} (${why}): ${r.rows} row(s), ${r.settings} setting(s)`)
      return true
    })
  }
  function claimIfFirst(me) {
    if (claimChecked || !me.admin) return
    claimChecked = true
    try { claim(me.owner, 'first administrator') } catch (e) { claimChecked = false; ctx.log.warn(`studio: existing data not claimed (${e.message})`) }
  }
  const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new Error('invalid id'); return n }

  prepareDb(ctx)
  kvReady.then(() => ctx.storage.kv.get('ownerUserId')).then(async (v) => {
    if (v === undefined || v === null) return
    if (v && !claim(checkOwnerId(v), 'recorded by the previous version')) return   // database not writable: next start
    await ctx.storage.kv.del('ownerUserId')
  }).catch((e) => ctx.log.warn(`studio: existing data not claimed (${e.message})`))
  // Agent channel: the tools skill names the CLI and the spool folder (lib/agent-channel.js, lib/spool.js); every
  // mission of the studio receives it. Without `skills:write` (older manifest) no mission is started.
  const spoolOf = () => spoolDir(ctx.storage.dir)
  // The command the agent runs the CLI with: this runtime, or the plugin setting `agentNode` (an agent that cannot run
  // the runtime of Timon, e.g. the desktop app). The skills are rewritten when it changes, at the next mission.
  const agentNode = () => String(ctx.settings.get('agentNode') || '').trim()
  const nodeCmd = () => nodeCommand(undefined, undefined, agentNode())
  let skillsFor = null
  const skills = () => {
    const key = agentNode()
    if (!skillsFor || skillsFor.key !== key) {
      const opts = key ? { node: nodeCmd() } : {}
      const spool = () => ensureSpool(spoolOf())
      skillsFor = {
        key,
        tools: installToolsSkill(ctx, spool, opts).catch((e) => { ctx.log.warn(`studio: agent tools skill not installed: ${e.message}`); return null }),
        setup: installSetupSkill(ctx, spool, opts).catch((e) => { ctx.log.warn(`studio: setup skill not installed: ${e.message}`); return null }),
      }
    }
    return skillsFor
  }
  skills()

  // --- agent of the missions: the plugin setting `agent` by default, or the one a user chose for an organization, an
  // account or all their accounts (setting `agent`, cascade account → organization → user). A user may only choose an
  // agent their Timon account sees (ctx.agents.list() in their request): the choice is recorded as a grant for that
  // user (kv), and a mission for a user only starts on the plugin's agent or on an agent granted to that user. A job
  // cannot list the user's agents, so the grant is what it checks.
  const GRANTS_KEY = 'agentGrants'   // { [owner]: { [lowercase name]: { agent, at } } }
  const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
  const inRequest = () => Boolean(viewer.getStore() && viewer.getStore().request)
  /** The Timon agents the signed-in user sees. Throws a clear message when Timon does not let the studio list them. */
  async function visibleAgents() {
    if (!ctx.agents || typeof ctx.agents.list !== 'function' || !(can('agents:manage') || can('agents:read'))) {
      throw new Error('Growth Studio cannot list your Timon agents on this installation (permission agents:read): only the plugin\'s agent can be used')
    }
    try { return await ctx.agents.list() } catch (e) { throw new Error(`your Timon agents could not be listed (${e.message}): only the plugin's agent can be used`) }
  }
  /** The agent named `name` as the signed-in user sees it (canonical name), or a refusal. */
  async function assertVisibleAgent(name) {
    const hit = (await visibleAgents()).find((a) => sameName(a.name, name))
    if (!hit) throw new Error(`agent "${name}" is not one of your Timon agents: choose an agent of your account`)
    return hit.name
  }
  async function grantAgent(owner, name) {
    const all = (await ctx.storage.kv.get(GRANTS_KEY)) || {}
    const mine = { ...(all[owner] || {}), [String(name).toLowerCase()]: { agent: name, at: nowIso() } }
    await ctx.storage.kv.set(GRANTS_KEY, { ...all, [owner]: mine })
  }
  async function isGranted(owner, name) {
    const all = (await kvGet(GRANTS_KEY)) || {}
    return Boolean(all[owner] && all[owner][String(name).toLowerCase()])
  }
  /**
   * Agent of a mission for `owner`, about one account (`accountId`) or about the user's work in general. The plugin's
   * agent needs no grant; any other agent must have been chosen by that user in the studio (and, in their request,
   * still be one of their agents). Throws a clear refusal otherwise: the mission does not start.
   */
  async function agentFor({ accountId = null, owner }) {
    const set = withDb(ctx, (db) => agentSetting(db, { accountId, owner }).value, true)
    const name = String(set || '').trim()
    const fallback = String(ctx.settings.get('agent') || '').trim()
    if (!name || sameName(name, fallback)) return agentOf(ctx)
    const why = `the agent "${name}" chosen in the studio settings is not allowed for this user`
    if (!(await isGranted(owner, name))) throw new Error(`${why}: choose it again in Settings (Agent tab) from your own Timon account, or empty the setting to use the plugin's agent`)
    if (inRequest()) { try { return await assertVisibleAgent(name) } catch (e) { throw new Error(`${why} (${e.message})`) } }
    return name
  }
  /** Starts a mission of the studio, with the tools skill (and the setup skill for the conversational Set up), for one
   *  user (`owner`, default: the request's): the mission's tools only see that user's data. Its agent: `agent` when
   *  given, else the one resolved for the account (`accountId`) or the user (agentFor). */
  async function spawnMission({ mission, title, owner = ownerNow(), setup = false, accountId = null, agent = null }) {
    assertWritable()
    if (!owner) throw new Error('no Timon user for this mission: the account has no owner yet')
    if (!agent) agent = await agentFor({ accountId, owner })
    const s = skills()
    const skill = await s.tools
    if (!skill) throw new Error('Growth Studio cannot give its tools to the agent: the plugin needs the skills:write permission (reinstall it and accept its permissions).')
    const extra = [skill]
    if (setup) { const sk = await s.setup; if (!sk) throw new Error('Growth Studio cannot give its setup skill to the agent (skills:write permission).'); extra.push(sk) }
    return ctx.missions.spawn({ agent, mission: `${mission}\n\n${ownerLine(checkOwnerId(owner))}`, title, extraSkills: extra })
  }
  const connectors = connectorsOf(ctx)
  /** Visual engines and whether each can be used here: available true | false | null (unknown, still offered). */
  async function engineStates() {
    const out = {}
    for (const [k, e] of Object.entries(IMAGE_ENGINES)) {
      const c = connectors[e.connector]
      let st = { ok: null, hint: '' }
      try { st = c ? await c.check() : st } catch (err) { st = { ok: null, hint: err.message } }
      // the coded graphic is always possible: without a browser on the host, the agent renders the page itself
      out[k] = e.connector === 'chrome'
        ? { label: e.label, available: true, hostRender: st.ok === true, hint: st.ok ? '' : st.hint }
        : { label: e.label, available: st.ok, hint: st.ok ? '' : st.hint }
    }
    return out
  }

  // --- translations of the interface: English ships inside client.js (the only file the daemon serves to the
  // browser), every other language is a lib/i18n/<locale>.json read here. Unknown locale: an empty set (English).
  router.get('/i18n/:locale', run(async (req, res) => {
    const loc = String(req.params.locale || '')
    const file = /^[a-z]{2}$/.test(loc) ? new URL(`./i18n/${loc}.json`, import.meta.url) : null
    res.setHeader('cache-control', 'no-store')
    res.json(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  }))

  // --- overview
  router.get('/overview', run(async (_req, res) => {
    const data = withDb(ctx, (db) => {
      const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM posts p WHERE NOT ${COMMENT_REPLY} GROUP BY status`).all().map((r) => [r.status, r.n]))
      const commentsPending = replyCounts(db).pending
      const next = db.prepare(`${POST_SELECT} WHERE p.status = 'scheduled' ORDER BY p.scheduled_for LIMIT 1`).get()
      const toConfirm = db.prepare("SELECT COUNT(*) AS n FROM assessments WHERE verdict = 'to_confirm'").get().n
      const news = db.prepare("SELECT COUNT(*) AS n FROM news_queue WHERE status IN ('new','queued')").get().n
      const needImage = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'approved' AND (media IS NULL OR media IN ('', '[]')) AND NOT (kind = 'quote' AND quote_item_id IS NOT NULL) AND NOT (kind = 'reply' AND reply_to_item_id IS NOT NULL) AND no_media = 0").get().n
      const today = new Date().toISOString().slice(0, 10)
      const cost = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ingest_runs WHERE started_at >= ?').get(`${today}T00:00:00Z`).c
      const accounts = db.prepare(`SELECT a.id, a.network, a.handle, a.display_name, a.lang, a.organization_id, o.name AS organization
        FROM accounts a LEFT JOIN organizations o ON o.id = a.organization_id WHERE a.relation = 'owned' ORDER BY o.id, a.id`).all()
        .map((a) => ({ ...a, types: postTypes(db, a.id).map(({ key, label }) => ({ key, label })) }))
      const settings = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, setting(db, k)]))
      const rulesPending = db.prepare("SELECT COUNT(*) AS n FROM rule_proposals WHERE status = 'proposed'").get().n
      const ideasOpen = db.prepare("SELECT COUNT(*) AS n FROM ideas WHERE kind = 'reflection' AND status = 'idea'").get().n
      return { counts, next: shapePost(next), toConfirm, news, needImage, costToday: cost, accounts, settings, rulesPending, ideasOpen, commentsPending, budget: setting(db, 'daily_budget_usd') }
    }, true)
    const agent = String(ctx.settings.get('agent') || '').trim()
    // a blank studio (no agent, or no managed account yet) opens on the Set up
    res.json({ ...data, agent: { name: agent || null, issue: agent ? null : AGENT_MISSING }, setupNeeded: !agent || data.accounts.length === 0, data: dataStatus(), updatedAt: nowIso() })
  }))

  // --- posts
  router.get('/posts', run(async (req, res) => {
    const statuses = String(req.query.status || '').split(',').map((s) => s.trim()).filter(Boolean)
    const limit = Math.min(500, Number(req.query.limit) || 200)
    res.json({ posts: withDb(ctx, (db) => listPosts(db, { statuses, limit }), true) })
  }))
  router.get('/posts/:id', run(async (req, res) => {
    const d = withDb(ctx, (db) => postDetail(db, id(req), pathsOf(ctx)), true)
    if (!d) return fail(res, 'post not found', 404)
    const engines = await engineStates()
    // the account's default engine falls back to the other one when it is clearly unavailable
    if (engines[d.post.image_engine] && engines[d.post.image_engine].available === false) d.post.image_engine = Object.keys(engines).find((k) => engines[k].available !== false) || d.post.image_engine
    res.json({ ...d, engines })
  }))
  router.get('/media/:id', run(async (req, res) => {
    const paths = pathsOf(ctx)
    const row = withDb(ctx, (db) => db.prepare('SELECT media FROM posts WHERE id = ?').get(id(req)), true)
    const media = parseJson(row && row.media, [])
    const idx = Math.max(0, Number(req.query.i) || 0)
    const m = media[idx]
    if (!m || !m.path) return fail(res, 'media not found', 404)
    const f = resolveMedia(paths, m.path)
    if (!f || !existsSync(f)) return fail(res, 'file not found', 404)
    const ext = path.extname(f).toLowerCase()
    res.setHeader('content-type', ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream')
    res.setHeader('cache-control', 'no-store')
    res.end(readFileSync(f))
  }))
  // The interface proxy (/api/ui/plugins/…) only relays GET, POST and PUT: partial updates go through
  // PUT (PATCH stays accepted for direct calls to the daemon's API).
  const update = (route, handler) => { router.put(route, handler); router.patch(route, handler) }
  update('/posts/:id', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    withDb(ctx, (db) => {
      if (typeof b.body === 'string') { recordEdit(db, pid, b.body); db.prepare('UPDATE main.posts SET body = ? WHERE id = ?').run(b.body, pid) }
      if (typeof b.image_prompt === 'string') db.prepare('UPDATE main.posts SET image_prompt = ? WHERE id = ?').run(b.image_prompt, pid)
      if (typeof b.image_prompt_code === 'string') db.prepare('UPDATE main.posts SET image_prompt_code = ? WHERE id = ?').run(b.image_prompt_code, pid)
      if (typeof b.validation_note === 'string') db.prepare('UPDATE main.posts SET validation_note = ? WHERE id = ?').run(b.validation_note, pid)
      if (b.post_type !== undefined) {
        const p = db.prepare('SELECT account_id FROM posts WHERE id = ?').get(pid)
        if (b.post_type && p && !postTypes(db, p.account_id).some((t) => t.key === b.post_type)) throw new Error('unknown post type for this account')
        db.prepare('UPDATE main.posts SET post_type = ? WHERE id = ?').run(b.post_type || null, pid)
      }
    })
    changed({ post: pid })
    res.json(withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true))
  }))

  // Validate: approved + validated by the current user; `schedule` = 'auto' (next free slot, if media), 'none', or an ISO date.
  router.post('/posts/:id/approve', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    const who = actorOf(ctx)
    const out = withDb(ctx, (db) => {
      if (typeof b.body === 'string') { recordEdit(db, pid, b.body); db.prepare('UPDATE main.posts SET body = ? WHERE id = ?').run(b.body, pid) }
      const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid)
      if (!p) throw new Error('post not found')
      if (['published', 'rejected'].includes(p.status)) throw new Error(`status ${p.status}: nothing to validate`)
      if (b.no_media === true) { db.prepare('UPDATE main.posts SET no_media = 1 WHERE id = ?').run(pid); p.no_media = 1 }   // "Validate without a visual": the user's choice
      db.prepare(`UPDATE main.posts SET status = 'approved', validated_at = ?, validated_by = ?, validation_note = COALESCE(?, validation_note), scheduled_for = NULL WHERE id = ?`)
        .run(nowIso(), who, b.note || null, pid)
      db.prepare(`UPDATE main.news_queue SET status = 'validated' WHERE post_id = ? AND status = 'drafted'`).run(pid)
      const mode = b.schedule === undefined ? 'auto' : b.schedule
      // `reason` in English for API callers, `reason_code` for the interface to translate
      let scheduled = null, reason = null, reasonCode = null
      const canPublish = hasMedia(p.media) || (p.kind === 'quote' && p.quote_item_id) || p.no_media
      // a reply aimed at a post has no editorial slot: it goes out as soon as its campaign's limits allow it
      if (isTargetedReply(p)) return { scheduled, reason, reason_code: reasonCode }
      if (mode !== 'none') {
        if (!canPublish) { reason = 'missing image: it will be scheduled as soon as the visual is ready'; reasonCode = 'no_image' }
        else {
          const at = mode === 'auto' ? nextFreeSlot(db, p.account_id) : toIso(mode)
          if (!at) { reason = 'no publishing time found'; reasonCode = 'no_slot' }
          else { db.prepare(`UPDATE main.posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?`).run(at, pid); scheduled = at }
        }
      }
      return { scheduled, reason, reason_code: reasonCode }
    })
    changed({ post: pid })
    res.json({ ...out, ...withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true) })
  }))
  // Quote: `item_id` = a source post of the draft (quoted, the image becomes optional),
  // `null` = back to a plain post. A validated post without a slot is scheduled as soon as it can be published.
  router.post('/posts/:id/quote', run(async (req, res) => {
    const pid = id(req); const raw = (req.body || {}).item_id
    const itemId = raw == null ? null : Number(raw)
    const out = withDb(ctx, (db) => {
      const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid)
      if (!p) throw new Error('post not found')
      if (p.status === 'published') throw new Error('already published')
      let scheduled = null
      if (itemId == null) {
        db.prepare(`UPDATE main.posts SET kind = 'post', quote_item_id = NULL WHERE id = ?`).run(pid)
        if (p.status === 'scheduled' && !hasMedia(p.media) && !p.no_media) db.prepare(`UPDATE main.posts SET status = 'approved', scheduled_for = NULL WHERE id = ?`).run(pid)
        return { scheduled }
      }
      const it = db.prepare(`SELECT i.id, i.external_id, a.watch_role FROM items i LEFT JOIN accounts a ON a.id = i.author_id
        WHERE i.id = ? AND (i.id IN (SELECT item_id FROM post_items WHERE post_id = ?) OR i.id IN (SELECT item_id FROM news_queue WHERE post_id = ?))`).get(itemId, pid, pid)
      if (!it) throw new Error('only a source post of this draft can be quoted')
      if (!it.external_id) throw new Error('source post without an X id: it cannot be quoted')
      if (it.watch_role === 'reference') throw new Error('reference account: never quoted')
      db.prepare(`UPDATE main.posts SET kind = 'quote', quote_item_id = ? WHERE id = ?`).run(itemId, pid)
      if (p.status === 'approved' && !p.scheduled_for) {
        const at = nextFreeSlot(db, p.account_id)
        if (at) { db.prepare(`UPDATE main.posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?`).run(at, pid); scheduled = at }
      }
      return { scheduled }
    })
    changed({ post: pid })
    res.json({ ...out, ...withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true) })
  }))
  // Publish without a visual (the user's choice, an exception to the image rule): a validated post without a slot is then
  // scheduled; unchecked, a scheduled post without an image goes back to "validated without a slot".
  router.post('/posts/:id/no-media', run(async (req, res) => {
    const pid = id(req); const on = Boolean((req.body || {}).on)
    const out = withDb(ctx, (db) => {
      const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid)
      if (!p) throw new Error('post not found')
      if (p.status === 'published') throw new Error('already published')
      let scheduled = null
      if (!on && p.status === 'scheduled' && !hasMedia(p.media) && !(p.kind === 'quote' && p.quote_item_id)) db.prepare(`UPDATE main.posts SET status = 'approved', scheduled_for = NULL WHERE id = ?`).run(pid)
      db.prepare('UPDATE main.posts SET no_media = ? WHERE id = ?').run(on ? 1 : 0, pid)
      if (on && p.status === 'approved' && !p.scheduled_for) {
        const at = nextFreeSlot(db, p.account_id)
        if (at) { db.prepare(`UPDATE main.posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?`).run(at, pid); scheduled = at }
      }
      return { scheduled }
    })
    changed({ post: pid })
    res.json({ ...out, ...withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true) })
  }))
  router.post('/posts/:id/reject', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}; const note = String(b.note || '').trim()
    if (!note) throw new Error('a reason is required to reject')
    withDb(ctx, (db) => {
      const p = db.prepare('SELECT status, idea_id FROM posts WHERE id = ?').get(pid)
      if (!p) throw new Error('post not found')
      if (p.status === 'published') throw new Error('already published')
      db.prepare(`UPDATE main.posts SET status = 'rejected', validation_note = ?, scheduled_for = NULL WHERE id = ?`).run(note, pid)
      recordFeedback(db, { postId: pid, source: 'reject', text: `Rejet : ${note}`, category: b.category, ignored: b.ignored })
      // original idea without another live version: rejecting the draft drops the idea (reason read before the next suggestions).
      // A rewrite moves the old post to rejected through SQL on the agent's side, not through this route: the idea then stays open.
      // A rejection marked "ignored" (test, misclick) does not drop the idea.
      if (p.idea_id && !b.ignored) db.prepare(`UPDATE main.ideas SET status = 'dropped', decision_note = ?, decided_at = ? WHERE id = ? AND kind = 'reflection' AND status <> 'done'
        AND NOT EXISTS (SELECT 1 FROM posts WHERE idea_id = ? AND status NOT IN ('rejected','failed'))`).run(`Draft #${pid} rejected: ${note}`.slice(0, 1000), nowIso(), p.idea_id, p.idea_id)
    })
    changed({ post: pid })
    res.json(withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true))
  }))
  router.post('/posts/:id/schedule', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    const out = withDb(ctx, (db) => {
      const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid)
      if (!p) throw new Error('post not found')
      if (!['approved', 'scheduled'].includes(p.status)) throw new Error('validate the post before scheduling it')
      const at = b.at ? toIso(b.at) : nextFreeSlot(db, p.account_id)
      if (!at) throw new Error('no publishing time found')
      if (new Date(at).getTime() < Date.now() - 60_000) throw new Error('date in the past')
      db.prepare(`UPDATE main.posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?`).run(at, pid)
      return { scheduled: at }
    })
    changed({ post: pid })
    res.json({ ...out, ...withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true) })
  }))
  router.post('/posts/:id/unschedule', run(async (req, res) => {
    const pid = id(req)
    withDb(ctx, (db) => db.prepare(`UPDATE main.posts SET status = 'approved', scheduled_for = NULL WHERE id = ? AND status = 'scheduled'`).run(pid))
    changed({ post: pid })
    res.json(withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true))
  }))
  router.post('/posts/:id/reopen', run(async (req, res) => {   // rejected / failed -> to validate again
    const pid = id(req)
    withDb(ctx, (db) => db.prepare(`UPDATE main.posts SET status = 'pending_validation', validated_at = NULL, validated_by = NULL, scheduled_for = NULL WHERE id = ? AND status IN ('rejected','failed','approved','scheduled')`).run(pid))
    changed({ post: pid })
    res.json(withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true))
  }))
  router.post('/posts/:id/publish', run(async (req, res) => {
    const pid = id(req)
    if (inFlight.has(pid)) throw new Error('publishing already in progress')
    inFlight.add(pid)
    try {
      const out = await publishPost(ctx, pid, { trigger: 'manual publishing from the studio' })
      changed({ post: pid })
      res.json({ ...out, ...withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true) })
    } catch (e) {
      if (!e.replyWait && !e.replyFailed) withDb(ctx, (db) => db.prepare(`UPDATE main.posts SET validation_note = ? WHERE id = ?`).run(`Publishing failed (${nowIso()}): ${e.message}`, pid))
      changed({ post: pid })
      throw e
    } finally { inFlight.delete(pid) }
  }))

  // Ask the studio's agent for something: a direct mission, without Kanban.
  router.post('/posts/:id/ask', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    const kind = ['rewrite', 'image', 'custom'].includes(b.kind) ? b.kind : 'custom'
    const engine = IMAGE_ENGINES[b.engine] ? b.engine : null
    // the editorial part of each brief comes from the account's settings (cascade), the mechanics from briefs.js
    const setting = (accountId, key) => withDb(ctx, (db) => resolve(db, 'account', accountId, key).value, true)
    const imageBrief = (eng, postId, accountId) => {
      const guide = setting(accountId, eng === 'code' ? 'image_prompt_guide_code' : 'image_prompt_guide_gpt')
      const instruction = requireInstruction(setting(accountId, IMAGE_ENGINES[eng].setting), `The ${IMAGE_ENGINES[eng].label.toLowerCase()} instruction`)
      return IMAGE_ENGINES[eng].brief(postId, guide || NO_GUIDE, instruction)
    }
    const note = String(b.text || '').trim()
    const d = withDb(ctx, (db) => postDetail(db, pid, pathsOf(ctx)), true)
    if (!d) throw new Error('post not found')
    if (kind === 'image') {
      const engines = await engineStates()
      const asked = engine || d.post.image_engine || 'gpt-image'
      if (engines[asked] && engines[asked].available === false) {
        if (engine) throw new Error(engines[asked].hint)   // chosen explicitly: refuse rather than swap engines
        d.post.image_engine = Object.keys(engines).find((k) => engines[k].available !== false) || asked
      }
    }
    if (kind === 'rewrite' && note) withDb(ctx, (db) => recordFeedback(db, { postId: pid, source: 'rewrite', text: `Rewrite requested: ${note}`, category: b.category, ignored: b.ignored }))
    const brief = postBrief(kind, { id: pid, account: d.post.account, status: d.post.status }, {
      note,
      imageBrief: kind === 'image' ? imageBrief(engine || d.post.image_engine || 'gpt-image', pid, d.post.account_id) : '',
      instruction: kind === 'image' ? '' : setting(d.post.account_id, kind === 'rewrite' ? 'rewrite_prompt' : 'ask_prompt'),
    })
    const title = `Studio · ${kind === 'rewrite' ? 'rewrite' : kind === 'image' ? 'visual' : 'request'} #${pid}`
    const missionId = await spawnMission({ mission: brief, title, accountId: d.post.account_id })
    withDb(ctx, (db) => db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, mission_id, created_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)').run(pid, kind, kind === 'image' ? `${engine || d.post.image_engine}${note ? ` : ${note}` : ''}` : note, String(missionId), nowIso(), ownerNow()))
    changed({ post: pid })
    res.json({ mission_id: missionId })
  }))
  router.post('/ask', run(async (req, res) => {   // free request, outside a post (e.g. "propose 3 ideas")
    const text = String((req.body || {}).text || '').trim()
    if (!text) throw new Error('empty text')
    const acc = (req.body || {}).account_id ? withDb(ctx, (db) => accountRow(db, (req.body || {}).account_id), true) : null
    if ((req.body || {}).account_id && !acc) throw new Error('account not found')
    const instruction = withDb(ctx, (db) => (acc ? resolve(db, 'account', acc.id, 'ask_prompt') : resolve(db, 'global', 0, 'ask_prompt')).value, true)
    const missionId = await spawnMission({ mission: askBrief(text, acc, instruction), title: 'Studio · demande', accountId: acc ? acc.id : null })
    withDb(ctx, (db) => { db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, mission_id, created_at, account_id, owner_user_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)').run('custom', text, String(missionId), nowIso(), acc ? acc.id : null, ownerNow()) })
    res.json({ mission_id: missionId })
  }))

  // --- original post ideas (reflections): mechanics here and in original.js, instructions in the settings
  router.get('/ideas', run(async (req, res) => {
    const acc = Number(req.query.account) || null
    const statuses = String(req.query.status || '').split(',').filter((s) => IDEA_STATUSES.includes(s))
    res.json(withDb(ctx, (db) => {
      const cfg = acc ? originalConfig(db, acc) : null
      const types = acc ? postTypes(db, acc) : []
      return {
        ideas: listIdeas(db, { accountId: acc, statuses }),
        types: types.map(({ key, label, goal, share }) => ({ key, label, goal, share })),
        mix: acc ? typeMix(db, acc, types) : null,
        pending: acc ? pendingSuggest(db, acc) : null,
        config: cfg ? { enabled: cfg.enabled, autoDraft: cfg.autoDraft, batch: cfg.batch, stockMin: cfg.stockMin, ready: Boolean(cfg.suggestPrompt && cfg.writePrompt) } : null,
      }
    }, true))
  }))
  async function spawnSuggest(acc, cfg, { count, direction, auto }) {
    const owner = ownerNow() || acc.owner_user_id
    const { types, mix } = withDb(ctx, (db) => { const t = postTypes(db, acc.id); return { types: t, mix: typeMix(db, acc.id, t) } }, true)
    const reqId = withDb(ctx, (db) => Number(db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, created_at, account_id, owner_user_id) VALUES (NULL, ?, ?, ?, ?, ?)')
      .run('suggest', `${auto ? 'auto' : 'manual'}: ${count} idea(s)${direction ? ` — ${direction}` : ''}`, nowIso(), acc.id, owner || null).lastInsertRowid))
    try {
      const missionId = await spawnMission({ mission: suggestBrief(acc, cfg, { count, direction, requestId: reqId, types, mix }), title: `Studio · ${count} original ideas @${acc.handle}`, owner, accountId: acc.id })
      withDb(ctx, (db) => db.prepare('UPDATE main.studio_requests SET mission_id = ? WHERE id = ?').run(String(missionId), reqId))
      return missionId
    } catch (e) {
      withDb(ctx, (db) => db.prepare(`UPDATE main.studio_requests SET status = 'failed' WHERE id = ?`).run(reqId))
      throw e
    }
  }
  router.post('/ideas/suggest', run(async (req, res) => {
    const b = req.body || {}
    const { acc, cfg } = withDb(ctx, (db) => { const a = accountRow(db, b.account_id); return { acc: a, cfg: a ? originalConfig(db, a.id) : null } }, true)
    if (!acc) throw new Error('account not found')
    if (!cfg.suggestPrompt) throw new Error('empty suggestion instruction: fill it in Settings › Original ideas')
    const count = Math.min(Math.max(Number(b.count) || cfg.batch, 1), 12)
    const direction = String(b.text || '').trim().slice(0, 600)
    const missionId = await spawnSuggest(acc, cfg, { count, direction, auto: false })
    changed({ ideas: true })
    res.json({ mission_id: missionId })
  }))
  // Write: the user keeps the idea, with an optional instruction, then a mission writes the post.
  router.post('/ideas/:id/draft', run(async (req, res) => {
    const iid = id(req); const note = String((req.body || {}).text || '').trim().slice(0, 2000)
    const wantType = (req.body || {}).post_type
    const { idea, acc, cfg, types } = withDb(ctx, (db) => {
      const i = db.prepare(`SELECT * FROM ideas WHERE id = ? AND kind = 'reflection'`).get(iid)
      if (!i) throw new Error('idea not found')
      if (i.status === 'done') throw new Error('idea already published')
      const a = accountRow(db, i.account_id)
      if (!a) throw new Error('account of the idea not found')
      const c = originalConfig(db, a.id)
      if (!c.writePrompt) throw new Error('empty writing instruction: fill it in Settings › Original ideas')
      const t = postTypes(db, a.id)
      const type = wantType === undefined ? i.post_type : wantType || null
      if (type && !t.some((x) => x.key === type)) throw new Error('unknown post type for this account')
      db.prepare(`UPDATE main.ideas SET status = 'approved', decision_note = ?, decided_at = ?, post_type = ? WHERE id = ?`).run(note || null, nowIso(), type, iid)
      return { idea: { ...i, decision_note: note, post_type: type }, acc: a, cfg: c, types: t }
    })
    const missionId = await spawnMission({ mission: draftBrief(acc, cfg, idea, types), title: `Studio · post of idea #${iid} @${acc.handle}`, accountId: acc.id })
    withDb(ctx, (db) => db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, mission_id, created_at, account_id, owner_user_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)').run('idea-draft', `idea #${iid} ${note}`.trim(), String(missionId), nowIso(), acc.id, ownerNow()))
    changed({ ideas: true })
    res.json({ mission_id: missionId })
  }))
  // Drop: the reason (optional) becomes a qualified feedback, read before the next suggestions.
  router.post('/ideas/:id/drop', run(async (req, res) => {
    const iid = id(req); const b = req.body || {}; const note = String(b.note || '').trim().slice(0, 1000)
    withDb(ctx, (db) => {
      const i = db.prepare(`SELECT id, title, status, account_id FROM ideas WHERE id = ? AND kind = 'reflection'`).get(iid)
      if (!i) throw new Error('idea not found')
      if (i.status === 'done') throw new Error('idea already published')
      db.prepare(`UPDATE main.ideas SET status = 'dropped', decision_note = ?, decided_at = ? WHERE id = ?`).run(note || null, nowIso(), iid)
      if (note) db.prepare('INSERT INTO main.learnings(created_at, idea_id, text, source, category, ignored, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(nowIso(), iid, `Rejected: original idea "${i.title}" dropped — ${note}`, 'reject', catOf(b.category), b.ignored ? 1 : 0, i.account_id)
    })
    changed({ ideas: true })
    res.json({ ok: true })
  }))
  router.post('/ideas/:id/restore', run(async (req, res) => {   // put a dropped idea back to waiting
    const iid = id(req)
    withDb(ctx, (db) => db.prepare(`UPDATE main.ideas SET status = 'idea', decided_at = NULL WHERE id = ? AND kind = 'reflection' AND status = 'dropped'`).run(iid))
    changed({ ideas: true })
    res.json({ ok: true })
  }))

  // --- learning: the user's feedback and the rules proposed by the weekly synthesis
  router.get('/learnings', run(async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 60)
    // ?account=<id>: feedback of this account and rules aimed at it (or at all accounts)
    const acc = Number(req.query.account) || null
    res.json(withDb(ctx, (db) => ({
      learnings: db.prepare(`${LEARNING_SELECT} WHERE l.source IN ('reject','rewrite','edit') ${acc ? 'AND l.account_id = ?' : ''} ORDER BY l.created_at DESC LIMIT ?`).all(...(acc ? [acc] : []), limit),
      rules: db.prepare(`SELECT r.*, a.handle AS account FROM rule_proposals r LEFT JOIN accounts a ON a.id = r.account_id ${acc ? 'WHERE r.account_id = ? OR r.account_id IS NULL' : ''}
        ORDER BY CASE r.status WHEN 'proposed' THEN 0 ELSE 1 END, COALESCE(r.decided_at, r.created_at) DESC LIMIT 50`).all(...(acc ? [acc] : []))
        .map((r) => ({ ...r, evidence: parseJson(r.evidence, []) })),
      categories: CATEGORIES,
    }), true))
  }))
  router.post('/learnings/:id', run(async (req, res) => {
    const lid = id(req); const b = req.body || {}
    withDb(ctx, (db) => {
      if (!db.prepare('SELECT id FROM learnings WHERE id = ?').get(lid)) throw new Error('feedback not found')
      if (b.ignored !== undefined) db.prepare('UPDATE main.learnings SET ignored = ? WHERE id = ?').run(b.ignored ? 1 : 0, lid)
      if (b.category !== undefined) db.prepare('UPDATE main.learnings SET category = ? WHERE id = ?').run(catOf(b.category), lid)
    })
    changed({ learnings: true })
    res.json(withDb(ctx, (db) => db.prepare(`${LEARNING_SELECT} WHERE l.id = ?`).get(lid), true))
  }))
  // Accepting a rule writes it into the studio's rules (the account's, or the global ones for all accounts), which every
  // writing mission reads through `account-context`. Recording a rule for all accounts in the agent's Timon memory too
  // is an option (setting `rulesToMemory`, off by default): a mission does it.
  router.post('/rules/:id/accept', run(async (req, res) => {
    const rid = id(req); const note = String((req.body || {}).note || '').trim()
    const r = withDb(ctx, (db) => db.prepare(`SELECT * FROM rule_proposals WHERE id = ?`).get(rid), true)
    if (!r) throw new Error('proposal not found')
    if (r.status !== 'proposed') throw new Error('already decided')
    const text = note ? `${r.text} (${note})` : r.text
    withDb(ctx, (db) => {
      const scope = r.account_id ? 'account' : 'global'; const sid = r.account_id || 0
      const cur = scope === 'account'
        ? db.prepare(`SELECT value FROM scoped_settings WHERE scope = 'account' AND scope_id = ? AND key = 'rules'`).get(sid)
        : db.prepare(`SELECT value FROM settings WHERE key = 'rules'`).get()
      db.exec('BEGIN')
      try {
        saveScoped(db, scope, sid, { rules: [cur ? cur.value : '', text].filter(Boolean).join('\n') })
        db.prepare(`UPDATE main.rule_proposals SET status = 'accepted', decided_at = ?, decision_note = ?, text = ? WHERE id = ?`).run(nowIso(), note || null, text, rid)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    })
    let missionId = null
    if (!r.account_id && [true, 'true', 1, '1'].includes(ctx.settings.get('rulesToMemory'))) {
      try {
        missionId = await spawnMission({ mission: ruleMemoryBrief(rid, text), title: `Studio · rule #${rid}` })
        withDb(ctx, (db) => db.prepare('UPDATE main.rule_proposals SET mission_id = ? WHERE id = ?').run(String(missionId), rid))
      } catch (e) { ctx.log.warn(`studio: rule #${rid} saved, memory mission not started (${e.message})`) }
    }
    changed({ learnings: true, settings: true })
    res.json({ ok: true, mission_id: missionId })
  }))
  router.post('/rules/:id/refuse', run(async (req, res) => {
    const rid = id(req); const note = String((req.body || {}).note || '').trim()
    withDb(ctx, (db) => {
      const r = db.prepare('SELECT status FROM rule_proposals WHERE id = ?').get(rid)
      if (!r) throw new Error('proposal not found')
      if (r.status !== 'proposed') throw new Error('already decided')
      db.prepare(`UPDATE main.rule_proposals SET status = 'refused', decided_at = ?, decision_note = ? WHERE id = ?`).run(nowIso(), note || null, rid)
    })
    changed({ learnings: true })
    res.json({ ok: true })
  }))

  // --- calendar
  // --- prospecting comments: replies to validate (the user's click), campaigns of an account, competitors' teams
  router.get('/comments', run(async (req, res) => {
    const tab = String(req.query.tab || 'pending')
    const acc = Number(req.query.account) || null
    res.json(withDb(ctx, (db) => ({ tab, replies: listReplies(db, { tab, account: acc }), counts: replyCounts(db, acc), today: todayCounters(db) }), true))
  }))
  // Validate: the reply is approved and validated by the signed-in user; the publication task sends it (no slot)
  router.post('/comments/:id/approve', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    const who = actorOf(ctx)
    withDb(ctx, (db) => {
      db.exec('BEGIN')
      try {
        if (typeof b.body === 'string') {
          const body = checkReplyText(b.body)
          const cur = db.prepare('SELECT body FROM posts WHERE id = ?').get(pid)
          if (cur && cur.body !== body) { recordEdit(db, pid, body); db.prepare('UPDATE main.posts SET body = ? WHERE id = ?').run(body, pid) }
        }
        approveReply(db, pid, who)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    })
    changed({ post: pid, comments: true })
    res.json({ ok: true })
  }))
  // Discard: reason required, recorded as feedback on the reply (read by the agent like any rejection)
  router.post('/comments/:id/dismiss', run(async (req, res) => {
    const pid = id(req); const b = req.body || {}
    withDb(ctx, (db) => {
      db.exec('BEGIN')
      try {
        dismissReply(db, pid, b.note)
        recordFeedback(db, { postId: pid, source: 'reject', text: `Comment rejected: ${String(b.note).trim()}`, category: b.category, ignored: b.ignored })
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    })
    changed({ post: pid, comments: true })
    res.json({ ok: true })
  }))
  router.get('/comments/campaigns', run(async (req, res) => {
    const acc = Number(req.query.account)
    if (!Number.isInteger(acc) || acc <= 0) throw new Error('account required')
    res.json(withDb(ctx, (db) => listCampaigns(db, acc), true))
  }))
  router.post('/comments/campaigns', run(async (req, res) => {
    const cid = withDb(ctx, (db) => createCampaign(db, req.body || {}))
    changed({ comments: true }); res.json({ id: cid })
  }))
  update('/comments/campaigns/:id', run(async (req, res) => {
    withDb(ctx, (db) => updateCampaign(db, id(req), req.body || {}))
    changed({ comments: true }); res.json({ ok: true })
  }))
  router.post('/comments/campaigns/:id/pains', run(async (req, res) => {
    const pid = withDb(ctx, (db) => createPain(db, id(req), req.body || {}))
    changed({ comments: true }); res.json({ id: pid })
  }))
  update('/comments/pains/:id', run(async (req, res) => {
    withDb(ctx, (db) => updatePain(db, id(req), req.body || {}))
    changed({ comments: true }); res.json({ ok: true })
  }))
  // competitors and their teams are shared by the installation: every user of the studio sees and completes them
  router.get('/competitors', run(async (_req, res) => { res.json(withDb(ctx, (db) => listCompetitors(db), true)) }))
  router.post('/competitors', run(async (req, res) => {
    const cid = withDb(ctx, (db) => createCompetitor(db, req.body || {}))
    changed({ competitors: true }, allOwners()); res.json({ id: cid })
  }))
  update('/competitors/:id', run(async (req, res) => {
    withDb(ctx, (db) => updateCompetitor(db, id(req), req.body || {}))
    changed({ competitors: true }, allOwners()); res.json({ ok: true })
  }))
  router.post('/competitors/:id/aliases', run(async (req, res) => {
    withDb(ctx, (db) => addAlias(db, id(req), (req.body || {}).alias))
    changed({ competitors: true }, allOwners()); res.json({ ok: true })
  }))
  router.post('/competitors/:id/aliases/remove', run(async (req, res) => {
    withDb(ctx, (db) => removeAlias(db, id(req), (req.body || {}).alias))
    changed({ competitors: true }, allOwners()); res.json({ ok: true })
  }))
  router.post('/competitors/:id/team', run(async (req, res) => {
    const handle = withDb(ctx, (db) => addTeamMember(db, id(req), req.body || {}))
    changed({ competitors: true }, allOwners()); res.json({ handle })
  }))
  router.post('/competitors/:id/team/remove', run(async (req, res) => {
    withDb(ctx, (db) => removeTeamMember(db, id(req), req.body || {}))
    changed({ competitors: true }, allOwners()); res.json({ ok: true })
  }))

  router.get('/calendar', run(async (req, res) => {
    const from = req.query.from ? toIso(req.query.from) : toIso(Date.now() - 7 * 86_400_000)
    const to = req.query.to ? toIso(req.query.to) : toIso(Date.now() + 30 * 86_400_000)
    const acc = Number(req.query.account) || null   // filter on one account (publishing window of this account)
    const data = withDb(ctx, (db) => {
      const win = windowOf(db, acc)
      return {
        posts: db.prepare(`${POST_SELECT} WHERE ((p.status = 'scheduled' AND p.scheduled_for BETWEEN ? AND ?) OR (p.status = 'published' AND p.published_at BETWEEN ? AND ?) OR (p.status = 'failed' AND p.scheduled_for BETWEEN ? AND ?)) ${acc ? 'AND p.account_id = ?' : ''} ORDER BY COALESCE(p.scheduled_for, p.published_at)`)
          .all(from, to, from, to, from, to, ...(acc ? [acc] : [])).map(shapePost),
        window: win, tz: win.tz,
        waiting: listPosts(db, { statuses: ['approved'] }).filter((p) => !acc || p.account_id === acc),
      }
    }, true)
    res.json(data)
  }))

  // --- triage (bookmarks to confirm, news)
  router.get('/triage', run(async (_req, res) => {
    const data = withDb(ctx, (db) => ({
      toConfirm: db.prepare(`
        SELECT it.id, it.network, it.external_id, it.url, it.text, it.posted_at, it.media, au.handle AS author, au.display_name AS author_name,
               s.pillar, s.angle, s.score, s.already_known, s.assessed_at,
               (SELECT views FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS views,
               (SELECT likes FROM item_metrics m WHERE m.item_id = it.id ORDER BY captured_at DESC LIMIT 1) AS likes
        FROM assessments s JOIN items it ON it.id = s.item_id LEFT JOIN accounts au ON au.id = it.author_id
        WHERE s.verdict = 'to_confirm' ORDER BY s.assessed_at DESC`).all().map((r) => ({ ...r, media: parseJson(r.media, []) })),
      news: db.prepare(`
        SELECT n.id, n.status, n.detected_at, n.posted_at, n.post_id, n.note, a.handle, substr(it.text, 1, 300) AS text, it.url
        FROM news_queue n JOIN accounts a ON a.id = n.account_id JOIN items it ON it.id = n.item_id ORDER BY n.id DESC LIMIT 30`).all(),
      recentKeep: db.prepare(`
        SELECT it.id, it.url, substr(it.text, 1, 200) AS text, au.handle AS author, s.pillar, s.score, s.angle, s.assessed_at
        FROM assessments s JOIN items it ON it.id = s.item_id LEFT JOIN accounts au ON au.id = it.author_id
        WHERE s.verdict = 'keep' AND NOT EXISTS (SELECT 1 FROM idea_items ii WHERE ii.item_id = it.id) ORDER BY s.assessed_at DESC LIMIT 20`).all(),
    }), true)
    res.json(data)
  }))
  // Feed: bookmarks, brands (official followed accounts, accounts.role = 'brand', v20) and watchlist (followed people),
  // one card per post (the rest of a thread is hidden), cursor pagination. Sort `sort=arrived` (default: last
  // capture, an old bookmark fetched just now comes first) or `sort=posted` (publishing date of the post).
  router.get('/feed', run(async (req, res) => {
    const want = new Set(String(req.query.sources || 'bookmark,brand,watch').split(',').filter((s) => FEED_SOURCES.includes(s)))
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 100)
    const col = req.query.sort === 'posted' ? 'posted_at' : 'arrived_at'
    // cursor "date|id"; depending on the proxy it may still arrive encoded (%3A, %7C): decode it until it reads
    let cursor = String(req.query.before || '')
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(cursor); i++) { try { cursor = decodeURIComponent(cursor) } catch { break } }
    const [beforeAt, beforeId] = cursor.split('|')
    const data = withDb(ctx, (db) => {
      const base = `
        SELECT it.id, it.network, it.url, it.text, it.posted_at, it.media, it.kind,
               COALESCE((SELECT MAX(c.captured_at) FROM captures c WHERE c.item_id = it.id), it.first_seen_at, it.posted_at) AS arrived_at,
               au.handle AS author, au.display_name AS author_name, au.avatar_url, au.watch_role, au.competitor_id,
               EXISTS (SELECT 1 FROM captures c WHERE c.item_id = it.id AND c.source = 'bookmark') AS is_bookmark,
               EXISTS (SELECT 1 FROM captures c WHERE c.item_id = it.id AND c.source IN ('watch','manual')
                 AND COALESCE(au.role, CASE WHEN au.watch_priority = 'breaking' THEN 'brand' END) = 'brand') AS is_brand,
               EXISTS (SELECT 1 FROM captures c WHERE c.item_id = it.id AND c.source IN ('watch','manual')
                 AND COALESCE(au.role, CASE WHEN au.watch_priority = 'breaking' THEN 'brand' END, '') <> 'brand') AS is_watch
        FROM items it LEFT JOIN accounts au ON au.id = it.author_id
        WHERE it.kind <> 'thread' AND it.posted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ignored_items g WHERE g.network = it.network AND g.external_id = it.external_id)`
      const filt = [...want].map((s) => `is_${s} = 1`).join(' OR ') || '0'
      const counts = db.prepare(`SELECT SUM(is_bookmark) AS bookmark, SUM(is_brand) AS brand, SUM(is_watch) AS watch FROM (${base})`).get()
      const rows = db.prepare(`SELECT * FROM (${base}) WHERE (${filt}) ${beforeAt ? `AND (${col} < ? OR (${col} = ? AND id < ?))` : ''}
        ORDER BY ${col} DESC, id DESC LIMIT ?`).all(...(beforeAt ? [beforeAt, beforeAt, Number(beforeId) || 0] : []), limit + 1)
      const page = rows.slice(0, limit)
      const detail = (sql, ids) => (ids.length ? db.prepare(sql.replace('?L', ids.map(() => '?').join(','))).all(...ids) : [])
      const ids = page.map((r) => r.id)
      const asm = Object.fromEntries(detail(`SELECT item_id, verdict, pillar, score, angle FROM assessments WHERE item_id IN (?L)`, ids).map((a) => [a.item_id, a]))
      const met = Object.fromEntries(detail(`SELECT m.item_id, m.views, m.likes, m.saves FROM item_metrics m WHERE m.item_id IN (?L)
        AND m.captured_at = (SELECT MAX(captured_at) FROM item_metrics m2 WHERE m2.item_id = m.item_id)`, ids).map((m) => [m.item_id, m]))
      const posts = {}
      const marks = ids.map(() => '?').join(',')
      const linked = ids.length ? db.prepare(`SELECT pi.item_id, p.id, p.status FROM post_items pi JOIN posts p ON p.id = pi.post_id WHERE pi.item_id IN (${marks}) AND p.status <> 'rejected'
        UNION SELECT p.quote_item_id, p.id, p.status FROM posts p WHERE p.quote_item_id IN (${marks}) AND p.status <> 'rejected'
        UNION SELECT n.item_id, p.id, p.status FROM news_queue n JOIN posts p ON p.id = n.post_id WHERE n.item_id IN (${marks}) AND p.status <> 'rejected'`).all(...ids, ...ids, ...ids) : []
      for (const r of linked) (posts[r.item_id] = posts[r.item_id] || []).push({ id: r.id, status: r.status })
      const news = Object.fromEntries(detail(`SELECT item_id, status, note FROM news_queue WHERE item_id IN (?L)`, ids).map((x) => [x.item_id, x]))
      const items = page.map((r) => ({
        ...r, media: parseJson(r.media, []), sources: FEED_SOURCES.filter((s) => r[`is_${s}`]),
        assessment: asm[r.id] || null, metrics: met[r.id] || null, posts: (posts[r.id] || []).sort((a, b) => b.id - a.id), news: news[r.id] || null,
      }))
      const last = page[page.length - 1]
      return { items, counts, next: rows.length > limit && last ? `${last[col]}|${last.id}` : null }
    }, true)
    res.json(data)
  }))
  router.post('/items/:id/verdict', run(async (req, res) => {
    const iid = id(req); const b = req.body || {}
    const who = b.verdict === 'keep' ? actorOf(ctx) : null
    withDb(ctx, (db) => {
      const it = db.prepare('SELECT network, external_id FROM items WHERE id = ?').get(iid)
      if (!it) throw new Error('item not found')
      if (b.verdict === 'keep') {
        // a watched post does not always have an assessment: create it (upsert)
        db.prepare(`INSERT INTO main.assessments(item_id, verdict, pillar, angle, assessed_by, assessed_at) VALUES (?, 'keep', ?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET verdict = 'keep', pillar = COALESCE(excluded.pillar, pillar), angle = COALESCE(excluded.angle, angle), assessed_by = excluded.assessed_by, assessed_at = excluded.assessed_at`)
          .run(iid, b.pillar || null, b.angle || null, who, nowIso())
      } else if (b.verdict === 'ignore') {
        // same rule as the bookmarks triage: only the id is kept
        db.prepare('INSERT OR IGNORE INTO ignored_items(network, external_id, ignored_at) VALUES (?, ?, ?)').run(it.network, it.external_id, nowIso())
        db.prepare('DELETE FROM main.assessments WHERE item_id = ?').run(iid)
      } else throw new Error('unknown verdict')
    })
    changed({ item: iid })
    res.json({ ok: true })
  }))
  router.post('/items/:id/draft', run(async (req, res) => {   // ask for a draft from a kept item
    const iid = id(req); const note = String((req.body || {}).text || '').trim()
    const target = Number((req.body || {}).account_id)
    if (!Number.isInteger(target) || target <= 0) throw new Error('account_id required: the managed account the draft is for')
    const acc = withDb(ctx, (db) => accountRow(db, target), true)
    if (!acc) throw new Error('target account not found')
    const types = withDb(ctx, (db) => postTypes(db, acc.id), true)
    const wantType = String((req.body || {}).post_type || '')
    if (wantType && !types.some((t) => t.key === wantType)) throw new Error('unknown post type for this account')
    const typeLine = wantType ? `Post type imposed by the user: ${wantType} (--type ${wantType}). Instruction of the type, to follow:\n${typesBlock(types, wantType)}\n`
      : types.length ? 'Pick the most fitting post type among the account\'s (listed by account-context) and pass it with --type. ' : ''
    const it = withDb(ctx, (db) => db.prepare('SELECT it.id, it.url, au.handle FROM items it LEFT JOIN accounts au ON au.id = it.author_id WHERE it.id = ?').get(iid), true)
    if (!it) throw new Error('item not found')
    const missionId = await spawnMission({ mission: itemDraftBrief(acc, it, { note, typeLine, typed: types.length > 0 }), title: `Studio · brouillon @${acc.handle} item #${iid}`, accountId: acc.id })
    withDb(ctx, (db) => { db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, mission_id, created_at, account_id, owner_user_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)').run('draft', `item #${iid} ${note}`, String(missionId), nowIso(), acc.id, ownerNow()) })
    res.json({ mission_id: missionId })
  }))

  // --- settings: global (table settings) then organizations and accounts (cascade, accounts.js)
  const scopeOf = (req) => {
    const scope = String(req.params.scope)
    if (!['global', 'organization', 'account'].includes(scope)) throw new Error('unknown level')
    const sid = scope === 'global' ? 0 : id(req)
    return { scope, sid }
  }
  const assertScope = (db, scope, sid) => {
    if (scope === 'organization' && !db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(sid)) throw new Error('organization not found')
    if (scope === 'account' && !accountRow(db, sid)) throw new Error('account not found')
  }
  router.get('/settings', run(async (_req, res) => {   // global scheduling settings (old format, read by the studio)
    res.json(withDb(ctx, (db) => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, resolve(db, 'global', 0, k).value])), true))
  }))
  router.get('/orgs', run(async (_req, res) => {
    res.json(withDb(ctx, (db) => ({ ...tree(db), keys: SETTING_KEYS }), true))
  }))
  router.post('/orgs', run(async (req, res) => {
    const oid = withDb(ctx, (db) => createOrganization(db, req.body || {}))
    changed({ settings: true }); res.json({ id: oid })
  }))
  update('/orgs/:id', run(async (req, res) => {
    withDb(ctx, (db) => updateOrganization(db, id(req), req.body || {}))
    changed({ settings: true }); res.json({ ok: true })
  }))
  router.post('/orgs/:id/delete', run(async (req, res) => {
    withDb(ctx, (db) => deleteOrganization(db, id(req)))
    changed({ settings: true }); res.json({ ok: true })
  }))
  router.post('/accounts', run(async (req, res) => {
    const aid = withDb(ctx, (db) => createAccount(db, req.body || {}))
    changed({ settings: true }); res.json({ id: aid })
  }))
  update('/accounts/:id', run(async (req, res) => {
    withDb(ctx, (db) => updateAccount(db, id(req), req.body || {}))
    changed({ settings: true }); res.json({ ok: true })
  }))
  router.post('/accounts/:id/delete', run(async (req, res) => {
    withDb(ctx, (db) => deleteAccount(db, id(req)))
    changed({ settings: true }); res.json({ ok: true })
  }))
  /** Settings of a level, plus where its agent comes from when nothing is set at this level: the level above, or the
   *  plugin setting `agent` (from 'plugin'). */
  const viewOf = (db, scope, sid) => {
    const v = scopeView(db, scope, sid)
    const plugin = { value: String(ctx.settings.get('agent') || '').trim(), from: 'plugin' }
    const up = v.inherited && v.inherited.agent && v.inherited.agent.value ? v.inherited.agent : plugin
    return { ...v, agent: { own: v.own.agent || '', inherited: up, effective: v.own.agent ? { value: v.own.agent, from: scope } : up } }
  }
  router.get('/scope/:scope/:id/settings', run(async (req, res) => {
    const { scope, sid } = scopeOf(req)
    res.json(withDb(ctx, (db) => { assertScope(db, scope, sid); return viewOf(db, scope, sid) }, true))
  }))
  // The Timon agents the signed-in user may choose for the studio's missions, and the plugin's agent (the default).
  router.get('/agents', run(async (_req, res) => {
    const fallback = String(ctx.settings.get('agent') || '').trim() || null
    try {
      const agents = (await visibleAgents()).map((a) => ({ name: a.name, backend: a.backend, model: a.model || null, role: a.role || null }))
      res.json({ agents, plugin: fallback, error: null })
    } catch (e) { res.json({ agents: [], plugin: fallback, error: e.message }) }
  }))
  // Body: { changes: { key: value | '' }, voice?: text, force?: bool }. '' removes the override (inherited value).
  // An agent (key `agent`) must be one the user's Timon account sees, or the plugin's: it is then granted to that user.
  router.post('/scope/:scope/:id/settings', run(async (req, res) => {
    const { scope, sid } = scopeOf(req); const b = req.body || {}
    const changes = { ...(b.changes || {}) }
    const wanted = typeof changes.agent === 'string' ? changes.agent.trim() : ''
    if (wanted && !sameName(wanted, String(ctx.settings.get('agent') || '').trim())) { changes.agent = await assertVisibleAgent(wanted); await grantAgent(ownerNow(), changes.agent) }
    const out = withDb(ctx, (db) => {
      assertScope(db, scope, sid)
      db.exec('BEGIN')
      try {
        saveScoped(db, scope, sid, changes)
        const v = typeof b.voice === 'string' ? saveVoice(db, scope, sid, b.voice, { force: Boolean(b.force) }) : null
        db.exec('COMMIT')
        return { voice: v }
      } catch (e) { db.exec('ROLLBACK'); throw e }
    })
    changed({ settings: true })
    res.json({ ...out, ...withDb(ctx, (db) => viewOf(db, scope, sid), true) })
  }))
  router.post('/scope/:scope/:id/voice/import', run(async (req, res) => {
    const { scope, sid } = scopeOf(req)
    withDb(ctx, (db) => { assertScope(db, scope, sid); importVoice(db, scope, sid) })
    changed({ settings: true })
    res.json(withDb(ctx, (db) => viewOf(db, scope, sid), true))
  }))
  router.get('/next-slot', run(async (req, res) => {
    const accountId = Number(req.query.account)
    if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('account required: /next-slot?account=<id of a managed account>')
    res.json({ at: withDb(ctx, (db) => {
      if (!accountRow(db, accountId)) throw new Error('account not found')
      return nextFreeSlot(db, accountId)
    }, true) })
  }))

  // --- first launch: the Set up (screen of the studio, or a conversation with the agent: lib/setup.js)
  const CHECK_KEY = 'agentCheck'            // last ping of the agent: { agent, nodeCmd, node, at, owner }
  const CHECK_REQ_KEY = 'agentCheckRequest' // last check mission: { agent, nodeCmd, missionId, at }
  const CHECK_WAIT_MS = 15 * 60_000
  const IMPORT_KEY = 'lastImport'          // { at, source }: the import step of the Set up is done
  const kvGet = async (k) => { try { return await ctx.storage.kv.get(k) } catch { return undefined } }
  async function recordAgentCheck({ owner, node }) {
    const rec = { agent: String(ctx.settings.get('agent') || '').trim(), nodeCmd: agentNode(), node: node || null, ok: nodeOk(node), at: nowIso(), owner }
    try { await ctx.storage.kv.set(CHECK_KEY, rec) } catch (e) { ctx.log.warn(`studio: agent check not recorded (${e.message})`) }
    changed({ setup: true }, [owner])
  }
  /** State of the agent check for the agent and Node command set now: ok | pending | failed | none. */
  async function agentCheckState() {
    const agent = String(ctx.settings.get('agent') || '').trim()
    const [done, asked] = [await kvGet(CHECK_KEY), await kvGet(CHECK_REQ_KEY)]
    const same = (r) => r && r.agent === agent && (r.nodeCmd || '') === agentNode()
    const base = { nodeCommand: nodeCmd(), agentNode: agentNode() }
    if (same(done) && (!same(asked) || done.at >= asked.at)) return { ...base, state: done.ok ? 'ok' : 'old', node: done.node, at: done.at }
    if (same(asked)) {
      const late = Date.now() - Date.parse(asked.at) > CHECK_WAIT_MS
      return { ...base, state: late ? 'failed' : 'pending', missionId: asked.missionId, at: asked.at }
    }
    return { ...base, state: 'none' }
  }
  /** Each connector with its state and the exact lines the user adds (pluginPolicy, secrets). */
  async function connectorGuides() {
    const accountSecrets = (() => {
      try {
        return withDb(ctx, (db) => db.prepare(`SELECT id FROM accounts WHERE relation = 'owned' AND network = 'x'`).all()
          .map((a) => resolve(db, 'account', a.id, 'getxapi_token_secret').value).filter(Boolean), true)
      } catch { return [] }
    })()
    const list = await connectors.status()
    return list.map((c) => ({ ...c, guide: connectorGuide(c, { settings: (k) => ctx.settings.get(k), accountSecrets }) }))
  }
  /** Host facts added to `setup status` for the agent: the agent, the connectors and their lines. */
  async function setupExtra() {
    try {
      const guides = await connectorGuides()
      return {
        agent: String(ctx.settings.get('agent') || '').trim() || 'not set',
        connectors: guides.map((g) => ({ label: g.label, ok: g.ok, hint: g.hint })),
        policy: policySnippet(guides.map((g) => g.guide)),
        secrets: guides.flatMap((g) => g.guide.secrets),
      }
    } catch (e) { return { agent: String(ctx.settings.get('agent') || '').trim() || 'not set', connectors: [], policy: '', secrets: [], error: e.message } }
  }
  const can = (p) => Array.isArray(ctx.permissions) && ctx.permissions.includes(p)
  router.get('/setup', run(async (_req, res) => {
    const u = ctx.user()
    const data = withDb(ctx, (db) => setupData(db), true)
    const agent = String(ctx.settings.get('agent') || '').trim()
    let agents = null; let agentsError = null
    if ((can('agents:manage') || can('agents:read')) && ctx.agents) {
      try { agents = (await ctx.agents.list()).map((a) => ({ name: a.name, backend: a.backend, model: a.model, role: a.role, mine: Boolean(a.mine) })) } catch (e) { agentsError = e.message }
    }
    let backends = null; let defaultBackend = null
    if (can('backends:read') && ctx.backends) {
      try {
        const cat = await ctx.backends.list()
        defaultBackend = cat.defaultBackend || null
        backends = (cat.backends || []).map((b) => ({ id: b.id, label: b.label || b.id, signedIn: b.signedIn, defaultModel: b.defaultModel || null, models: (b.models || []).map((m) => m.slug || m.id).filter(Boolean) }))
      } catch { backends = null }
    }
    const guides = await connectorGuides()
    const p = pathsOf(ctx)
    const check = await agentCheckState()
    const known = agents ? agents.find((a) => a.name.toLowerCase() === agent.toLowerCase()) || null : null
    const steps = [
      { key: 'agent', required: true, done: Boolean(agent) && check.state === 'ok' },
      { key: 'accounts', required: true, done: data.accounts > 0 },
      { key: 'writing', required: false, done: Boolean(data.writing && data.writing.filled.voice) },
      { key: 'connectors', required: false, done: guides.every((g) => g.ok !== false) },
      { key: 'import', required: false, done: Boolean(await kvGet(IMPORT_KEY)) },
      { key: 'test', required: false, done: data.test.posts > 0 },
    ]
    res.json({
      needed: !agent || data.accounts === 0,
      admin: Boolean(u && u.is_superadmin),
      agent: { name: agent || null, exists: agents ? Boolean(known) : null, info: known, check },
      agents, agentsError, canCreateAgent: can('agents:manage'), role: AGENT_ROLE, backends, defaultBackend,
      ...data,
      writingKeys: WRITING_KEYS,
      connectors: guides,
      policy: policySnippet(guides.map((g) => g.guide)),
      data: { source: p.source, fallback: p.fallback, writable: dataStatus().writable },
      steps,
    })
  }))
  // Body: { name, backend?, model? }. Creates the studio's agent with a neutral prompt; the browser then sets the plugin
  // setting `agent`. Without agents:manage (manifest or the account's right) the screen explains how to create one.
  router.post('/setup/agent', run(async (req, res) => {
    const b = req.body || {}
    const name = String(b.name || '').trim()
    if (!AGENT_NAME_RE.test(name)) throw new Error('agent name: letters, digits, dot, dash or underscore, starting with a letter or digit')
    if (!can('agents:manage') || !ctx.agents || typeof ctx.agents.create !== 'function') { const e = new Error('Growth Studio may not create agents on this installation: create one on the Agents page of Timon, then choose it here.'); throw e }
    const input = { name, systemPrompt: AGENT_PROMPT, role: AGENT_ROLE }
    if (b.backend) input.backend = String(b.backend)
    if (b.model) input.model = String(b.model)
    try {
      const a = await ctx.agents.create(input)
      res.json({ agent: { name: a.name, backend: a.backend, model: a.model } })
    } catch (e) {
      const why = e && e.code === 'conflict' ? 'an agent already has this name: choose it in the list, or pick another name'
        : e && (e.code === 'forbidden' || /permission/i.test(String(e.name))) ? `your Timon account may not create this agent (${e.message}): create it on the Agents page of Timon, then choose it here`
          : e.message
      fail(res, why, e && e.code === 'forbidden' ? 403 : 400)
    }
  }))
  // Starts a short mission on the chosen agent that runs the tools' `ping`: proves that the agent can run the studio's
  // tools (Node 22.5 or newer, the spool folder reachable from its sandbox). The ping lands in recordAgentCheck.
  router.post('/setup/agent/check', run(async (_req, res) => {
    const agent = agentOf(ctx)
    const ping = toolCommand({ node: nodeCmd(), spool: ensureSpool(spoolOf()), owner: checkOwnerId(ownerNow()) }, 'ping')
    const mission = [
      'Growth Studio checks that you can run its tools. Run exactly this command, once:',
      '', '```', ping, '```', '',
      'Then run `node --version` (it may fail: that is information, not an error).',
      'Report the exact output and exit code of both commands, and nothing else. Do not try to fix anything.',
    ].join('\n')
    const missionId = String(await spawnMission({ mission, title: 'Studio · agent check', agent }))
    await ctx.storage.kv.set(CHECK_REQ_KEY, { agent, nodeCmd: agentNode(), missionId, at: nowIso() })
    changed({ setup: true })
    res.json({ mission_id: missionId })
  }))
  // Body: { account_id, keys? }: the generic starter content of the writing step, only where nothing is set yet.
  router.post('/setup/starter', run(async (req, res) => {
    const b = req.body || {}
    const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.filter((k) => WRITING_KEYS.includes(k)) : WRITING_KEYS
    const written = withDb(ctx, (db) => { if (!accountRow(db, Number(b.account_id))) throw new Error('account not found'); return applyStarter(db, Number(b.account_id), keys) })
    changed({ settings: true })
    res.json({ written })
  }))
  // The Set up as a conversation: a mission with the tools and setup skills. `focus` = the step to start from.
  router.post('/setup/converse', run(async (req, res) => {
    const focus = ['accounts', 'writing', 'connectors', 'test'].includes((req.body || {}).focus) ? req.body.focus : null
    const mission = [
      `Follow the ${SETUP_SKILL_ID} skill to set up Growth Studio with the user, in a conversation.`,
      focus ? `The user starts from the step "${focus}"; check the earlier steps with setup status, without redoing them.` : 'Start with setup status and go through the steps that are not done.',
    ].join('\n')
    const missionId = String(await spawnMission({ mission, title: 'Studio · set up with the agent', setup: true, agent: agentOf(ctx) }))
    res.json({ mission_id: missionId })
  }))
  // Body: { account_id }: one short test draft for that account. It stays pending_validation; nothing is published.
  router.post('/setup/test', run(async (req, res) => {
    const acc = withDb(ctx, (db) => accountRow(db, Number((req.body || {}).account_id)), true)
    if (!acc) throw new Error('account not found')
    const draft = toolCommand({ node: nodeCmd(), spool: ensureSpool(spoolOf()), owner: checkOwnerId(ownerNow()) }, `post draft --account ${acc.id} --file <post.txt> --title "Set up test"`)
    const mission = [
      `Growth Studio was just set up. Write ONE short test draft for @${acc.handle} (${acc.network}), in its language (${acc.lang || 'the account\'s language'}).`,
      'Read the account\'s writing context first (account-context) and follow its voice. The subject: this account now drafts its posts with Growth Studio and validates each one before it goes out.',
      'No visual, no image brief. Save it with the tools skill:',
      '', '```', draft, '```', '',
      'It stays pending_validation: the user reviews it in the Posts tab. Never validate, schedule or publish it.',
    ].join('\n')
    const missionId = String(await spawnMission({ mission, title: `Studio · test draft @${acc.handle}`, accountId: acc.id }))
    withDb(ctx, (db) => { db.prepare('INSERT INTO main.studio_requests(post_id, kind, brief, mission_id, created_at, account_id, owner_user_id) VALUES (NULL, ?, ?, ?, ?, ?, ?)').run('custom', 'Set up test draft', missionId, nowIso(), acc.id, ownerNow()) })
    res.json({ mission_id: missionId })
  }))

  // --- data administration: where the data lives, one-off import of an existing growth.db (superadmin only)
  let importing = false
  const assertAdmin = () => {
    const u = ctx.user()
    if (!u || !u.is_superadmin) { const e = new Error('reserved to an administrator'); e.status = 403; throw e }
  }
  // State of the data (read-only after a failed update, newer database…): answers even when the database cannot be read.
  router.get('/status', run(async (_req, res) => { res.json(dataStatus()) }))
  // Optional connectors and background jobs: state only, never a secret value.
  router.get('/connectors', run(async (_req, res) => {
    res.json({ connectors: await connectors.status(), jobs: jobsView() })
  }))
  router.get('/admin/data', run(async (_req, res) => {
    assertAdmin()
    const p = pathsOf(ctx)
    const version = dbError ? null : withDb(ctx, (db) => Number(db.prepare('PRAGMA user_version').get().user_version), true)
    res.json({ source: p.source, fallback: p.fallback, db: p.db, mediaDir: p.mediaDir, version, error: dbError, state: dataStatus() })
  }))
  // "Run now" of a background job (administrator): one forced pass, whatever its interval, window or weekly slot.
  // The job's switch must be on: a job left to another tool never runs from here either.
  router.post('/admin/jobs/:job/run', async (req, res) => {
    try { assertAdmin() } catch (e) { return fail(res, e, 403) }
    const k = String(req.params.job || '')
    if (!Object.hasOwn(JOBS, k)) return fail(res, `unknown job "${k}" (${Object.keys(JOBS).join(', ')})`, 404)
    if (!jobOn(k)) return fail(res, `the ${JOBS[k].label} is switched off (plugin setting ${JOBS[k].setting})`, 409)
    if (jobState[k].busy) return fail(res, `the ${JOBS[k].label} is already running`, 409)
    try {
      const last = await runJob(k, { force: true })
      if (!last) return fail(res, 'the job cannot run now (import, database error or read-only studio): see GET /status', 409)
      res.json({ job: k, ...last })
    } catch (e) { fail(res, e, 500) }
  })
  // Body: { path: absolute path of the growth.db to import, media_dir?: folder of its media (default: `media` next to it) }.
  // Always imports into the plugin's own storage; while `dataSource` is `legacy`, the studio keeps using the project file.
  router.post('/admin/import', async (req, res) => {
    try { assertAdmin() } catch (e) { return fail(res, e, 403) }
    if (importing) return fail(res, 'an import is already running', 409)
    importing = true
    try {
      const b = req.body || {}
      const report = importDatabase({ source: b.path, mediaDir: b.media_dir || null, storageDir: ctx.storage.dir })
      const p = prepareDb(ctx)
      ctx.log.info(`studio: imported ${report.source} into ${report.target}`)
      claimChecked = true
      try { await ctx.storage.kv.set(IMPORT_KEY, { at: nowIso(), source: report.source }) } catch { /* only the Set up reads it */ }
      try { claim(ownerNow(), 'import') } catch (e) { ctx.log.warn(`studio: imported data not claimed (${e.message})`) }
      changed({ imported: true })
      res.json({ ...report, active: { source: p.source, db: p.db } })
    } catch (e) {
      fail(res, e, 400)
    } finally { importing = false }
  })

  // --- publishing at the planned time
  async function tick() {
    if (importing || dbError || writeBlock()) return
    let due = []
    try {
      due = withDb(ctx, (db) => db.prepare(`SELECT p.id, a.owner_user_id AS owner FROM posts p JOIN accounts a ON a.id = p.account_id
        WHERE p.status = 'scheduled' AND p.scheduled_for IS NOT NULL AND p.scheduled_for <= ?
          AND NOT (p.kind = 'reply' AND p.reply_to_item_id IS NOT NULL) ORDER BY p.scheduled_for LIMIT 3`).all(nowIso()), true)
    } catch (e) { ctx.log.warn(`studio: database unreadable (${e.message})`); return }
    for (const { id: pid, owner } of due) {
      if (inFlight.has(pid)) continue
      inFlight.add(pid)
      try {
        await publishPost(ctx, pid, { trigger: 'scheduled publishing' })
      } catch (e) {
        ctx.log.error(`studio: publishing #${pid} failed: ${e.message}`)
        try {
          withDb(ctx, (db) => db.prepare(`UPDATE main.posts SET status = 'failed', validation_note = ? WHERE id = ?`).run(`Publishing failed (${nowIso()}): ${e.message}`, pid))
        } catch (e2) { ctx.log.error(`studio: cannot mark #${pid} as failed: ${e2.message}`) }
        ctx.notify.alert(`Post #${pid}: publishing failed`, e.message, { urgent: true })
      } finally { inFlight.delete(pid); changed({ post: pid }, [owner]) }
    }
    await sendReplies()
  }
  // Validated prospecting replies: no editorial slot, each one goes out as soon as its campaign's limits allow it
  // (lib/replies.js); a reply that has to wait stays validated, silently, and is looked at again at the next tick.
  async function sendReplies() {
    if (importing || dbError || writeBlock()) return
    let due = []
    try { due = withDb(ctx, (db) => dueReplies(db, new Date()), true) } catch (e) { ctx.log.warn(`studio: database unreadable (${e.message})`); return }
    for (const { id: pid, owner } of due) {
      if (inFlight.has(pid)) continue
      inFlight.add(pid)
      let touched = false
      try {
        await publishReply(ctx, pid, { trigger: 'validated reply' })
        touched = true
      } catch (e) {
        if (e.replyWait) continue
        ctx.log.error(`studio: reply #${pid} not sent: ${e.message}`)
        if (!e.replyFailed) {
          try {
            withDb(ctx, (db) => db.prepare(`UPDATE main.posts SET status = 'failed', validation_note = ? WHERE id = ? AND status IN ('approved','scheduled')`).run(`Reply not sent (${nowIso()}): ${e.message}`, pid))
          } catch (e2) { ctx.log.error(`studio: cannot mark reply #${pid} as failed: ${e2.message}`) }
        }
        ctx.notify.alert(`Reply #${pid}: not sent`, e.message, { urgent: true })
        touched = true   // failed: the studio shows it
      } finally {
        inFlight.delete(pid)
        if (touched) changed({ post: pid }, [owner])
      }
    }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { tick().catch((e) => ctx.log.error(`studio tick: ${e.message}`)) }, TICK_MS)
    return () => clearInterval(timer)
  })
  // Writes made outside the plugin (scripts or tools that open the database file itself): the studio is not told
  // about them (the agent's commands, which go through the plugin, already send `changed`). A light fingerprint of
  // each user's data, read every 10 s, fires the same `changed` signal to that user, so that the tab counters and the
  // lists update by themselves. The same pass gives the rows written without an owner to the installation's single
  // user (lib/scope.js), so that such a tool keeps working after the switch to multi-user.
  const lastPrint = new Map()
  const fingerprint = () => withDb(ctx, (db) => db.prepare(`SELECT
      (SELECT group_concat(status || ':' || n) FROM (SELECT status, COUNT(*) AS n FROM posts GROUP BY status ORDER BY status)) AS posts,
      (SELECT COALESCE(MAX(id), 0) FROM posts) AS last_post,
      (SELECT group_concat(status || ':' || n) FROM (SELECT status, COUNT(*) AS n FROM ideas GROUP BY status ORDER BY status)) AS ideas,
      (SELECT COUNT(*) FROM assessments WHERE verdict = 'to_confirm') AS to_confirm,
      (SELECT COUNT(*) FROM rule_proposals WHERE status = 'proposed') AS rules,
      (SELECT COUNT(*) FROM news_queue WHERE status IN ('new','queued')) AS news`).get(), true)
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (importing || dbError) return
      let owners = []
      try {
        owners = withSystemDb(ctx, (db) => knownOwners(db), true)
        if (owners.length === 1 && !writeBlock() && Object.keys(withSystemDb(ctx, (db) => strayCounts(db), true)).length) {
          const n = withSystemDb(ctx, (db) => adoptStrays(db, owners[0]))
          if (n) ctx.log.info(`studio: ${n} row(s) written without an owner given to user ${owners[0]}`)
        }
      } catch (e) { ctx.log.warn(`studio: owners unreadable (${e.message})`); return }
      for (const o of owners) {
        try {
          const print = JSON.stringify(viewer.run({ owner: o, admin: false }, fingerprint))
          if (lastPrint.has(o) && print !== lastPrint.get(o)) changed({ external: true }, [o])
          lastPrint.set(o, print)
        } catch (e) { ctx.log.warn(`studio: database fingerprint unreadable (${e.message})`) }
      }
    }, 10_000)
    return () => clearInterval(timer)
  })
  // Agent tools: requests the CLI drops in the spool folder, run here with the studio's own database access.
  const handleTool = async ({ argv, files, knows = null, owner = null, node = null }) => {
    if (importing) return { code: 1, out: '', err: 'Growth Studio is importing a database: try again in a minute.' }
    // the user the command acts for (`--owner`, given by the mission): it only sees and changes that user's data
    if (!owner) return { code: 2, out: '', err: '--owner <user id> is required: use the value your mission gives ("Growth Studio user of this mission")' }
    let me
    try { me = checkOwnerId(owner) } catch (e) { return { code: 2, out: '', err: e.message } }
    // `ping` and `setup` serve a user who owns nothing yet (first launch)
    const firstRun = argv[0] === 'ping' || argv[0] === 'setup'
    if (!dbError && !firstRun && !allOwners().includes(me)) return { code: 1, out: '', err: `unknown Growth Studio user "${me}": use the value your mission gives` }
    if (argv[0] === 'ping') {
      await recordAgentCheck({ owner: me, node })
      return { code: 0, out: `Growth Studio reached: the agent runs its tools with Node ${node || 'unknown'}.`, err: '' }
    }
    const extra = argv[0] === 'setup' && argv[1] === 'status' ? await setupExtra() : null
    return viewer.run({ owner: me, admin: false }, () => runCommand({ argv, files, knows, extra }))
  }
  async function runCommand({ argv, files, knows, extra = null }) {
    const readOnly = isReadOnly(argv)
    if (!readOnly) {
      const refusal = writeBlock() || (dbError ? null : writeRefusal(dbPathOf(ctx), { cliKnows: knows, migrationsDir: migrationsDir() }))
      if (refusal) return { code: 1, out: '', err: refusal }
    }
    if (argv[0] === 'render-html') return renderHtml(argv, files)
    if (argv[0] === 'item' && argv[1] === 'add') return itemAdd(argv)
    try {
      const out = withDb(ctx, (db) => runTool(db, argv, { paths: pathsOf(ctx), input: inlineInput(files), extra }), readOnly)
      if (!readOnly) changed({ external: true })
      return { code: 0, out, err: '' }
    } catch (e) {
      return { code: e instanceof UsageError ? 2 : 1, out: '', err: e instanceof Error ? e.message : String(e) }
    }
  }
  /** `item add <url>`: the treg connector reads the X post, then it is stored (lib/item-add.js). */
  async function itemAdd(argv) {
    try {
      const { pos, opts } = parseArgv(argv)
      const out = await addItem({ withDb: (fn, readOnly = false) => withDb(ctx, fn, readOnly), treg: connectors.treg || null, url: pos[2], role: opts.role ?? null })
      changed({ external: true })
      return { code: 0, out, err: '' }
    } catch (e) {
      return { code: e instanceof UsageError || e instanceof ItemUsageError ? 2 : 1, out: '', err: e instanceof Error ? e.message : String(e) }
    }
  }
  /** `render-html <post> <page.html>`: the headless browser connector renders the agent's page, then attach-media. */
  async function renderHtml(argv, files) {
    const [, rawPost, file] = argv.filter((a, i) => !(String(a).startsWith('--') || String(argv[i - 1] || '').startsWith('--')))
    const altAt = argv.indexOf('--alt')
    const alt = altAt >= 0 ? argv[altAt + 1] : null
    if (!rawPost || !file) return { code: 2, out: '', err: 'usage: render-html <post_id> <page.html> [--alt "…"]' }
    let html
    try { html = inlineInput(files).bytes(file) } catch (e) { return { code: 1, out: '', err: e.message } }
    if (html.length > HTML_MAX_BYTES) return { code: 1, out: '', err: `page too large (${html.length} bytes, ${HTML_MAX_BYTES} at most)` }
    const st = await connectors.chrome.check()
    if (!st.ok) return { code: 1, out: '', err: `No headless browser is available to Growth Studio (${st.hint}). Render the page yourself to a 1200×675 PNG, then attach-media ${rawPost} <file.png> --engine code.` }
    let png
    try { png = await connectors.chrome.render(html.toString('utf8'), { workDir: ctx.storage.dir }) } catch (e) {
      return { code: 1, out: '', err: `rendering failed (${e.message}). Render the page yourself to a 1200×675 PNG, then attach-media ${rawPost} <file.png> --engine code.` }
    }
    try {
      const args = ['attach-media', String(rawPost), 'rendered.png', '--engine', 'code', ...(alt ? ['--alt', alt] : [])]
      const out = withDb(ctx, (db) => runTool(db, args, { paths: pathsOf(ctx), input: { bytes: () => png } }))
      changed({ external: true })
      return { code: 0, out: `rendered with the studio's headless browser; ${out}`, err: '' }
    } catch (e) {
      return { code: e instanceof UsageError ? 2 : 1, out: '', err: e instanceof Error ? e.message : String(e) }
    }
  }
  ctx.effect(() => {
    let dir = null
    try { dir = ensureSpool(spoolOf()) } catch (e) { ctx.log.error(`studio: agent tools unavailable (${e.message})`); return () => {} }
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      drain(dir, handleTool).catch((e) => ctx.log.warn(`studio: agent tools (${e.message})`)).finally(() => { busy = false })
    }, SPOOL_MS)
    return () => clearInterval(timer)
  })
  // Refill of the original ideas: under the account's threshold, a suggestion mission (one a day at most).
  async function refill() {
    if (dbError || writeBlock()) return
    let due = []
    try { due = withDb(ctx, (db) => accountsToRefill(db), true) } catch (e) { ctx.log.warn(`studio: original ideas unreadable (${e.message})`); return }
    for (const { account, cfg, count } of due) {
      try { await spawnSuggest(account, cfg, { count, direction: '', auto: true }); changed({ ideas: true }, [account.owner_user_id]) } catch (e) { ctx.log.warn(`studio: suggestions @${account.handle} not started (${e.message})`) }
    }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { refill().catch((e) => ctx.log.error(`studio refill: ${e.message}`)) }, REFILL_MS)
    return () => clearInterval(timer)
  })
  // News of the watch: one mission per user and per agent. Each one only drafts for (and only sees) the accounts of
  // its user, and the accounts of organizations with different agents get one mission each. An agent refused for its
  // accounts does not stop the others' missions.
  async function spawnNews(db, { handles, targets }) {
    const groups = new Map()
    const refused = []
    for (const t of targets) {
      if (!t.owner_user_id) continue
      let agent
      try { agent = await agentFor({ accountId: t.id, owner: t.owner_user_id }) } catch (e) { refused.push(`@${t.handle}: ${e.message}`); continue }
      const k = `${t.owner_user_id}\n${agent.toLowerCase()}`
      if (!groups.has(k)) groups.set(k, { owner: t.owner_user_id, agent, mine: [] })
      groups.get(k).mine.push(t)
    }
    if (!groups.size) throw new Error(refused.length ? refused.join('; ') : 'the accounts with the news source on have no owner yet')
    for (const r of refused) ctx.log.warn(`studio: news not drafted for ${r}`)
    const ids = []
    for (const { owner, agent, mine } of groups.values()) {
      ids.push(await spawnMission({ mission: newsBrief({ handles, targets: mine, prompt: resolve(db, 'global', owner, 'news_prompt').value }), title: `Studio · news ${handles.map((h) => `@${h}`).join(' ')}`, owner, agent }))
    }
    return ids.join(',')
  }
  // Background jobs (bookmarks fetch, watch of followed accounts, weekly synthesis of the feedback, search for
  // prospecting comments). Each one has its switch (plugin settings bookmarksJob / watchJob / synthesisJob /
  // commentsJob), off by default while another tool may still do
  // the same work: never two fetches.
  // The switch is read at every tick; a job never runs twice at once, nor while the data cannot be written.
  const JOBS = {
    bookmarks: { setting: 'bookmarksJob', label: 'X bookmarks fetch', run: (db, now, force) => pollBookmarks({
      db, paths: pathsOf(ctx), getxapi: connectors.getxapi, notify: ctx.notify, now, force,
      spawnTriage: async (owner, count) => {
        const prompt = resolve(db, 'account', owner.id, 'triage_prompt').value
        if (!String(prompt || '').trim()) throw new Error(`no bookmark triage criteria for @${owner.handle} (Settings › @${owner.handle} › Sources)`)
        return spawnMission({ mission: triageBrief(owner, count, prompt), title: `Studio · bookmark triage @${owner.handle}`, owner: owner.owner_user_id, accountId: owner.id })
      },
    }) },
    watch: { setting: 'watchJob', label: 'watch of followed accounts', run: (db, now, force) => pollWatch({
      db, treg: connectors.treg, notify: ctx.notify, now, force,
      spawnNews: (o) => spawnNews(db, o),
    }) },
    synthesis: { setting: 'synthesisJob', label: 'weekly synthesis of the feedback', run: (db, now, force) => pollSynthesis({
      db, now, force,
      spawnSynthesis: (owner, count) => spawnMission({ mission: synthesisBrief(count), title: 'Studio · weekly synthesis of the feedback', owner }),
    }) },
    comments: { setting: 'commentsJob', label: 'search for prospecting comments', run: (db, now, force) => pollComments({
      db, treg: connectors.treg, notify: ctx.notify, now, force,
      // one batch of one account: the mission works for (and only sees) the account's owner
      spawnQualify: ({ account, count }) => spawnMission({ mission: commentsBrief(account, count, resolve(db, 'account', account.id, 'comments_prompt').value), title: `Studio · comment candidates @${account.handle}`, owner: account.owner_user_id, accountId: account.id }),
    }) },
  }
  const jobState = Object.fromEntries(Object.keys(JOBS).map((k) => [k, { busy: false, last: null }]))
  const jobOn = (k) => { const v = ctx.settings.get(JOBS[k].setting); return v === true || v === 'true' || v === 1 || v === '1' }
  function jobsView() {
    return Object.fromEntries(Object.entries(JOBS).map(([k, j]) => [k, { label: j.label, setting: j.setting, enabled: jobOn(k), running: jobState[k].busy, last: jobState[k].last }]))
  }
  /** One pass of job `k`. `force` (an administrator's "run now"): ignores its interval, window and weekly slot, never its switch. */
  async function runJob(k, { force = false } = {}) {
    const st = jobState[k]
    if (st.busy || !jobOn(k) || importing || dbError || writeBlock()) return null
    st.busy = true
    const now = new Date()
    let db = null
    try {
      db = openDb(ctx)
      db.exec('PRAGMA foreign_keys = ON')
      const r = await JOBS[k].run(db, now, force)
      st.last = { at: now.toISOString(), ...(force ? { forced: true } : {}), ...r }
      if (!['not-due', 'outside', 'stopped'].includes(r.state)) { ctx.log.info(`studio ${k}: ${r.message}`); changed({ external: true }, allOwners()) }
    } catch (e) {
      st.last = { at: now.toISOString(), state: 'error', message: e.message }
      ctx.log.error(`studio ${k}: ${e.message}`)
    } finally {
      if (db) { try { db.close() } catch { /* already closed */ } }
      st.busy = false
    }
    return st.last
  }
  ctx.effect(() => {
    const timer = setInterval(() => { for (const k of Object.keys(JOBS)) runJob(k).catch((e) => ctx.log.error(`studio ${k}: ${e.message}`)) }, JOB_MS)
    return () => clearInterval(timer)
  })
  testing.runJob = runJob
  testing.tick = tick
  testing.handleTool = handleTool
  testing.spawnNews = spawnNews
}
