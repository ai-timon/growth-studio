// Organizations, managed accounts and cascading settings (schema v15), shared by the host half and the agent tools.
// Resolution of a setting for an account: account → organization → user (table `user_settings`, the "global" level of
// the Settings screen, own to each Timon user) → default below. Keys that only exist at the global level (watch budget,
// fetch window, voice sync) are the installation's: table `settings`, the same for every user, changed by an
// administrator. Without a user (connection of a background job on an account without owner, operator's CLI), the
// "global" level is the installation table, as before multi-user.
// - `merge: 'append'`: the levels add up (common rules + rules of the account) instead of replacing each other;
// - `levels: ['account']`: setting own to the account (publishing connection, secret), never inherited.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SCHEDULE_DEFAULTS, scheduleConfig } from './schedule.js'
import { ownerOf } from './scope.js'

/**
 * Generic defaults of the mission instructions: editorial content, overridable at every level (global, organization,
 * account). They hold no person, project or model provider; an empty value at every level falls back to them.
 */
export const MISSION_DEFAULTS = {
  image_instruction_gpt: 'A realistic or illustrated image. Generate ONE 16:9 image (1200×675 or larger, same ratio); any text in it is in the account\'s language, without typos.',
  image_instruction_code: 'A graphic drawn in code, for a diagram, a data chart or a polished text card: careful typography and layout, no third party\'s visual.',
  rewrite_prompt: 'Rewrite this draft in the account\'s voice, taking the user\'s remark into account.',
  ask_prompt: 'Do what the request asks. Any post you write is a draft that waits for the user\'s validation.',
  comments_prompt: [
    'Qualify a post only when its author lives one of the campaign\'s pains in the first person, right now, and is looking for a way out or complaining about it.',
    'Dismiss it when the pain is already solved in the thread, when it is a joke, an advertisement, news or a general opinion, or when it matches no pain of the campaign.',
    'When the post mentions a competitor, qualify it only if it CRITICIZES that competitor; neutral or praising: dismiss.',
    'Any hint that the author belongs to a competitor\'s team dismisses the post without exception: their bio, "we shipped", "our team", "I work on", an official or product account. In doubt, dismiss.',
    'The reply helps first: one concrete tip that is useful even without the product. Then one short, transparent line about the product, saying you work on it.',
    'Write it in the account\'s voice and language, short and human, as one person answering another. No URL, no hashtag, never the name of a competitor, no pressure to buy.',
  ].join('\n'),
}

const ALL = ['global', 'organization', 'account']
export const SETTING_KEYS = {
  // the agent the missions of an account run on (one per promoted company); empty everywhere = the plugin setting `agent`
  agent: { group: 'agent', label: 'Agent: the Timon agent that runs the missions of these accounts (empty = inherited, then the plugin setting "Agent")', type: 'agent', levels: ALL },
  // goals
  goals: { group: 'goals', label: 'Goals of the account', type: 'text', levels: ALL },
  target_followers_30d: { group: 'goals', label: 'Target followers at 30 days', type: 'int', levels: ['account'] },
  target_followers_90d: { group: 'goals', label: 'Target followers at 90 days', type: 'int', levels: ['account'] },
  // writing
  voice: { group: 'writing', label: 'Voice guide', type: 'text', levels: ['organization', 'account'] },
  voice_note: { group: 'writing', label: 'Synced note: path of the voice guide inside the notes folder (.md), used when voice guide sync is on', type: 'path', levels: ['organization', 'account'] },
  image_engine: { group: 'writing', label: 'Image engine offered by default', type: 'enum', options: ['gpt-image', 'code'], levels: ALL, default: 'gpt-image' },
  image_prompt_guide_gpt: { group: 'writing', label: 'How to write the brief of a realistic image', type: 'text', levels: ALL },
  image_prompt_guide_code: { group: 'writing', label: 'How to write the brief of a chart or diagram drawn in code', type: 'text', levels: ALL },
  // mission instructions (editorial content sent to the agent as is; the studio only adds the mechanics)
  image_instruction_gpt: { group: 'writing', label: 'Realistic image engine: what the image must be (sent to the agent with every image request)', type: 'text', prompt: true, levels: ALL, default: MISSION_DEFAULTS.image_instruction_gpt },
  image_instruction_code: { group: 'writing', label: 'Chart or diagram engine: what the graphic must be (sent to the agent with every coded-graphic request)', type: 'text', prompt: true, levels: ALL, default: MISSION_DEFAULTS.image_instruction_code },
  rewrite_prompt: { group: 'writing', label: 'Rewrite instruction (sent to the agent with every rewrite request, before the remark)', type: 'text', prompt: true, levels: ALL, default: MISSION_DEFAULTS.rewrite_prompt },
  ask_prompt: { group: 'writing', label: 'Free request instruction (sent to the agent before every free request)', type: 'text', prompt: true, levels: ALL, default: MISSION_DEFAULTS.ask_prompt },
  default_length: { group: 'writing', label: 'Default length', type: 'enum', options: ['short', 'medium', 'long'], levels: ALL, default: 'short' },
  // rules (they add up)
  rules: { group: 'rules', label: 'Rules (one per line)', type: 'text', merge: 'append', levels: ALL },
  // sources of the drafts
  source_bookmarks: { group: 'sources', label: 'X bookmarks of the owner', type: 'bool', levels: ALL, default: '0' },
  source_watch: { group: 'sources', label: 'Watch of the followed accounts', type: 'bool', levels: ALL, default: '0' },
  source_news: { group: 'sources', label: 'News of the primary sources (automatic draft)', type: 'bool', levels: ALL, default: '0' },
  source_github_stars: { group: 'sources', label: 'GitHub repositories starred by the owner', type: 'bool', levels: ALL, default: '0' },
  source_changelog: { group: 'sources', label: 'Product changelog (build in public)', type: 'bool', levels: ALL, default: '0' },
  product_changelog: { group: 'sources', label: 'Product changelog: URL or absolute path of the file (empty = none)', type: 'location', levels: ALL, default: '' },
  source_accounts: { group: 'sources', label: 'Followed accounts kept (empty = all)', type: 'list', levels: ALL },
  sources_notes: { group: 'sources', label: 'Collection method (free instructions)', type: 'text', levels: ALL },
  triage_prompt: { group: 'sources', label: 'Bookmark triage criteria (what to keep, confirm or ignore, how to score): required for the studio to start a triage', type: 'text', levels: ALL },
  news_prompt: { group: 'sources', label: 'Extra instruction for news drafts (optional)', type: 'text', levels: ALL },
  // prospecting comments: what a post worth a reply is and how the reply is written (campaigns hold pains and solutions)
  comments_prompt: { group: 'comments', label: 'Comments instruction: which found posts deserve a reply and how to write it (sent to the agent with every qualification of comment candidates)', type: 'text', prompt: true, levels: ALL, default: MISSION_DEFAULTS.comments_prompt },
  // sending of the validated replies: limits a campaign leaves empty (lib/replies.js)
  comments_max_replies_per_day: { group: 'comments', label: 'Replies sent per day by a comment campaign (maximum)', type: 'int', levels: ALL, default: '10' },
  comments_min_gap_min: { group: 'comments', label: 'Minutes between two replies of the account (minimum)', type: 'int', levels: ALL, default: '15' },
  // post types (value, reach, pain → solution…): JSON list, the instruction of each type is editorial
  post_types: { group: 'types', label: 'Post types', type: 'json', levels: ALL },
  // original post ideas (reflections): the mechanics are in the plugin, the editorial instructions here
  source_original: { group: 'original', label: 'Suggest original post ideas for this account', type: 'bool', levels: ALL, default: '0' },
  original_themes: { group: 'original', label: 'Subjects of the reflections (one per line)', type: 'text', levels: ALL },
  original_suggest_prompt: { group: 'original', label: 'Suggestion instruction (what a good idea is, what to avoid)', type: 'text', levels: ALL },
  original_write_prompt: { group: 'original', label: 'Instruction to write a post from a chosen idea', type: 'text', levels: ALL },
  original_batch_size: { group: 'original', label: 'Ideas suggested per request', type: 'int', levels: ALL, default: '5' },
  original_auto_draft: { group: 'original', label: 'Draft the suggested ideas right away (no validation of the idea: the draft arrives in the Posts tab)', type: 'bool', levels: ALL, default: '0' },
  original_stock_min: { group: 'original', label: 'Refill automatically under N waiting ideas (direct drafting: N drafts to validate; 0 = on request only)', type: 'int', levels: ALL, default: '0' },
  // prospecting comments: limits a campaign leaves empty
  comments_search_budget_usd: { group: 'comments', label: 'Daily search budget of a comment campaign ($)', type: 'num', levels: ALL, default: '0.1' },
  comments_max_author_followers: { group: 'comments', label: 'Skip the authors with more followers than this (empty = no ceiling)', type: 'int', levels: ALL, default: '' },
  // scheduling
  publish_window_start: { group: 'schedule', label: 'Start of the publishing window (HH:MM)', type: 'hm', levels: ALL },
  publish_window_end: { group: 'schedule', label: 'End of the publishing window (HH:MM)', type: 'hm', levels: ALL },
  publish_gap_min: { group: 'schedule', label: 'Minimum gap between two posts of the account (min)', type: 'int', levels: ALL },
  publish_gap_max: { group: 'schedule', label: 'Maximum gap (min)', type: 'int', levels: ALL },
  publish_start_jitter_min: { group: 'schedule', label: 'Jitter of the first post of the day (± min)', type: 'int', levels: ALL },
  publish_max_per_day: { group: 'schedule', label: 'Maximum posts per day (empty = no limit)', type: 'int', levels: ALL, default: '' },
  publish_tz: { group: 'schedule', label: 'Time zone', type: 'tz', levels: ALL },
  // publishing (account only)
  x_publish_target: { group: 'publish', label: 'treg publishing tool (e.g. x.x.post.create)', type: 'ident', levels: ['account'] },
  x_publish_auth_method: { group: 'publish', label: 'treg authorization method (optional)', type: 'ident', levels: ['account'] },
  getxapi_token_secret: { group: 'publish', label: 'Timon secret holding the x.com cookie (media upload, quotes)', type: 'secret', levels: ['account'] },
  // global only
  daily_budget_usd: { group: 'global', label: 'Daily watch budget ($)', type: 'num', levels: ['global'], default: '0.25' },
  news_max_tasks_per_day: { group: 'global', label: 'Maximum news missions per day', type: 'int', levels: ['global'], default: '8' },
  news_quiet_minutes: { group: 'global', label: 'Wait after a news item (thread settled, min)', type: 'int', levels: ['global'], default: '4' },
  news_max_age_hours: { group: 'global', label: 'Maximum age of a news item (h)', type: 'int', levels: ['global'], default: '12' },
  bookmarks_poll_interval_min: { group: 'global', label: 'X bookmarks fetch: every N minutes (0 = off)', type: 'int', levels: ['global'], default: '15' },
  bookmarks_window_start: { group: 'global', label: 'Bookmarks fetch: start of the window (HH:MM)', type: 'hm', levels: ['global'], default: '08:00' },
  bookmarks_window_end: { group: 'global', label: 'Bookmarks fetch: end of the window (HH:MM)', type: 'hm', levels: ['global'], default: '23:00' },
  comments_poll_interval_min: { group: 'global', label: 'Prospecting comments search: every N minutes per campaign (0 = off)', type: 'int', levels: ['global'], default: '60' },
  comments_window_start: { group: 'global', label: 'Prospecting comments search: start of the window (HH:MM)', type: 'hm', levels: ['global'], default: '08:00' },
  comments_window_end: { group: 'global', label: 'Prospecting comments search: end of the window (HH:MM)', type: 'hm', levels: ['global'], default: '22:00' },
  comments_daily_budget_usd: { group: 'global', label: 'Prospecting comments search: daily budget of all the campaigns ($)', type: 'num', levels: ['global'], default: '0.5' },
  comments_max_missions_per_day: { group: 'global', label: 'Maximum comment qualification missions per day', type: 'int', levels: ['global'], default: '6' },
  comments_batch_size: { group: 'global', label: 'Comment candidates per qualification mission', type: 'int', levels: ['global'], default: '15' },
  voice_sync: { group: 'global', label: 'Sync voice guides with a notes folder (each organization or account names its note)', type: 'bool', levels: ['global'], default: '0' },
  voice_sync_dir: { group: 'global', label: 'Notes folder for voice guide sync (absolute path; empty = no sync)', type: 'dir', levels: ['global'], default: '' },
}
for (const [k, v] of Object.entries(SCHEDULE_DEFAULTS)) if (SETTING_KEYS[k]) SETTING_KEYS[k].default = v
/** Keys of the installation (only settable at the global level): one value for every user, table `settings`. */
export const INSTALLATION_KEYS = Object.keys(SETTING_KEYS).filter((k) => { const l = SETTING_KEYS[k].levels || ALL; return l.length === 1 && l[0] === 'global' })
/** Keys a user sets at the global level for all their accounts: table `user_settings`. */
export const USER_KEYS = Object.keys(SETTING_KEYS).filter((k) => (SETTING_KEYS[k].levels || ALL).includes('global') && !INSTALLATION_KEYS.includes(k))
const isInstallation = (k) => INSTALLATION_KEYS.includes(k)
const HIDDEN = new Set(['voice_note_hash'])   // hash of the note at the last exchange (voice guide sync)
const SCHEDULE_KEYS = Object.keys(SETTING_KEYS).filter((k) => SETTING_KEYS[k].group === 'schedule')

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
export const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

// ---------- reading ----------
/** User whose "global" level is read: an explicit id, else the user the connection is scoped to, else none. */
const userOf = (db, id) => (typeof id === 'string' && id ? id : ownerOf(db))
/** Value of a key at the global level: the installation's for an installation key or without a user, else the user's. */
export function globalValue(db, key, owner = ownerOf(db)) {
  const r = owner && !isInstallation(key)
    ? db.prepare('SELECT value FROM user_settings WHERE owner_user_id = ? AND key = ?').get(owner, key)
    : db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return r ? String(r.value) : null
}
/** Own values of a level. For `global`, `id` may name the user (string); 0 = the connection's user. */
export function scopedValues(db, scope, id) {
  if (scope === 'global') { const o = userOf(db, id); return Object.fromEntries(Object.keys(SETTING_KEYS).map((k) => [k, globalValue(db, k, o)]).filter(([, v]) => v != null)) }
  return Object.fromEntries(db.prepare('SELECT key, value FROM scoped_settings WHERE scope = ? AND scope_id = ?').all(scope, id).map((r) => [r.key, String(r.value)]))
}
export function accountRow(db, idOrHandle) {
  const n = Number(idOrHandle)
  const a = Number.isInteger(n) && n > 0
    ? db.prepare(`SELECT * FROM accounts WHERE id = ? AND relation = 'owned'`).get(n)
    : db.prepare(`SELECT * FROM accounts WHERE relation = 'owned' AND lower(handle) = lower(?)`).get(String(idOrHandle || '').replace(/^@/, ''))
  return a || null
}
/** Chain of the levels of a scope, from the most precise to the most general: [{scope, id, values}]. The global level
 *  is the one of the account's (or organization's) owner, so a background job reads the same values as its user. */
function chain(db, scope, id) {
  const out = []
  let owner = scope === 'global' ? userOf(db, id) : null
  if (scope === 'account') {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)
    out.push({ scope: 'account', id, values: scopedValues(db, 'account', id) })
    if (a && a.organization_id) out.push({ scope: 'organization', id: a.organization_id, values: scopedValues(db, 'organization', a.organization_id) })
    owner = (a && a.owner_user_id) || ownerOf(db)
  } else if (scope === 'organization') {
    const o = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id)
    out.push({ scope: 'organization', id, values: scopedValues(db, 'organization', id) })
    owner = (o && o.owner_user_id) || ownerOf(db)
  }
  out.push({ scope: 'global', id: 0, values: scopedValues(db, 'global', owner || 0) })
  return out
}
/** Effective value of a key and its origin: { value, from } (from = 'account' | 'organization' | 'global' | 'default'). */
export function resolve(db, scope, id, key, overrides = null) {
  const meta = SETTING_KEYS[key] || {}
  const levels = chain(db, scope, id)
  if (overrides) levels[0] = { ...levels[0], values: { ...levels[0].values, ...overrides } }
  const usable = levels.filter((l) => (meta.levels || ALL).includes(l.scope))
  if (meta.merge === 'append') {
    const parts = usable.slice().reverse().map((l) => (l.values[key] || '').trim()).filter(Boolean)
    return { value: parts.join('\n'), from: parts.length ? 'merged' : 'default' }
  }
  for (const l of usable) { const v = l.values[key]; if (v != null && v !== '') return { value: v, from: l.scope } }
  return { value: meta.default != null ? meta.default : '', from: 'default' }
}
export function effective(db, scope, id, overrides = null) {
  return Object.fromEntries(Object.keys(SETTING_KEYS).map((k) => [k, resolve(db, scope, id, k, overrides)]))
}
/** Agent set in the studio for the missions of an account (cascade account → organization → user) or, without an
 *  account, of a user: { value, from }. An empty value means the plugin setting `agent` applies. */
export function agentSetting(db, { accountId = null, owner = null } = {}) {
  return accountId ? resolve(db, 'account', accountId, 'agent') : resolve(db, 'global', owner || 0, 'agent')
}
/** `get(key)` reader for schedule.js: effective settings of an account (global when accountId is missing). */
export function getterFor(db, accountId) {
  return (k) => (accountId ? resolve(db, 'account', accountId, k) : resolve(db, 'global', 0, k)).value
}

// ---------- post types ----------
const TYPE_KEY = /^[a-z][a-z0-9_]{1,30}$/
/** List of the post types of a JSON setting: [{key, label, goal, share, prompt}]. `strict` throws instead of
 *  ignoring an invalid entry (saving from the studio). */
export function parsePostTypes(raw, { strict = false } = {}) {
  let arr
  try { arr = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw } catch { if (strict) throw new Error('Post types: invalid JSON'); return [] }
  if (!Array.isArray(arr)) { if (strict) throw new Error('Post types: a list is expected'); return [] }
  const out = []; const seen = new Set()
  for (const [i, t] of arr.entries()) {
    const key = String((t && t.key) || '').trim(); const label = String((t && t.label) || '').trim(); const prompt = String((t && t.prompt) || '').trim()
    const share = Number(t && t.share)
    const bad = !TYPE_KEY.test(key) ? 'lowercase id (letters, digits, _)' : seen.has(key) ? 'duplicate id' : !label ? 'empty label'
      : !prompt ? 'empty instruction' : !(Number.isInteger(share) && share >= 0 && share <= 100) ? 'share between 0 and 100' : prompt.length > 4000 ? 'instruction too long' : null
    if (bad) { if (strict) throw new Error(`Post type ${i + 1}${label ? ` (${label})` : ''}: ${bad}`); continue }
    seen.add(key); out.push({ key, label, goal: String(t.goal || '').trim(), share, prompt })
  }
  if (strict && arr.length > 12) throw new Error('12 post types at most')
  return out
}

// ---------- writing ----------
const HM = /^\d{1,2}:\d{2}$/
const IDENT = /^[A-Za-z0-9_.:-]{1,80}$/
const SECRET = /^[A-Z][A-Z0-9_]{2,63}$/
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
function check(key, raw) {
  const m = SETTING_KEYS[key]; const v = String(raw).trim()
  if (v === '') return ''
  switch (m.type) {
    case 'bool': if (!['0', '1'].includes(v)) throw new Error(`${m.label}: 0 or 1`); break
    case 'int': if (!/^\d{1,6}$/.test(v)) throw new Error(`${m.label}: a whole number is expected`); break
    case 'num': if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${m.label}: a number is expected`); break
    case 'hm': if (!HM.test(v)) throw new Error(`${m.label}: HH:MM format`); break
    case 'tz': try { new Intl.DateTimeFormat('en-US', { timeZone: v }) } catch { throw new Error('unknown time zone') } break
    case 'enum': if (!m.options.includes(v)) throw new Error(`${m.label}: ${m.options.join(' / ')}`); break
    case 'ident': if (!IDENT.test(v)) throw new Error(`${m.label}: letters, digits, . _ : - only`); break
    case 'agent': if (!AGENT.test(v)) throw new Error(`${m.label}: name of a Timon agent (letters, digits, . _ -)`); break
    case 'secret': if (!SECRET.test(v)) throw new Error(`${m.label}: secret name in UPPERCASE (e.g. X_AUTH_TOKEN_TIMON)`); break
    case 'json': { const arr = parsePostTypes(v, { strict: true }); return JSON.stringify(arr) }
    case 'list': { const arr = JSON.parse(v); if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) throw new Error(`${m.label}: a list is expected`); return JSON.stringify(arr) }
    case 'location': if (v.length > 2000 || /[\r\n]/.test(v) || !(/^https?:\/\//i.test(v) || path.isAbsolute(v))) throw new Error(`${m.label}: an http(s) URL or an absolute path`); break
    case 'dir': if (v.length > 2000 || /[\r\n]/.test(v) || !path.isAbsolute(v)) throw new Error(`${m.label}: an absolute path`); break
    case 'path': if (!/\.md$/.test(v) || v.includes('..') || path.isAbsolute(v)) throw new Error(`${m.label}: path relative to the notes folder, ending with .md`); break
    default: if (v.length > 20000) throw new Error(`${m.label}: text too long`)
  }
  return v
}
/** Saves settings of a scope (`''` = remove the override, the value is inherited again). Throws when a key is
 *  unknown or not allowed at this level, or when the resulting scheduling is inconsistent. */
export function saveScoped(db, scope, id, changes) {
  const clean = {}
  for (const [k, raw] of Object.entries(changes || {})) {
    if (HIDDEN.has(k) || k === 'voice') continue   // the voice goes through saveVoice (voice guide sync)
    const m = SETTING_KEYS[k]
    if (!m) throw new Error(`unknown setting: ${k}`)
    if (!(m.levels || ALL).includes(scope)) throw new Error(`"${m.label}" cannot be set at this level`)
    if (raw == null) continue
    clean[k] = check(k, raw)
  }
  if (Object.keys(clean).some((k) => SCHEDULE_KEYS.includes(k))) {
    const merged = Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, resolve(db, scope, id, k, clean).value]))
    scheduleConfig((k) => merged[k])
  }
  for (const [k, v] of Object.entries(clean)) writeRaw(db, scope, id, k, v)
  if (clean.voice_note !== undefined && scope !== 'global') writeRaw(db, scope, id, 'voice_note_hash', '')   // new note: the sync has to be done again
  return clean
}
function writeRaw(db, scope, id, k, v) {
  const owner = scope === 'global' && !isInstallation(k) ? userOf(db, id) : null
  if (owner) {
    if (v === '') db.prepare('DELETE FROM main.user_settings WHERE owner_user_id = ? AND key = ?').run(owner, k)
    else db.prepare(`INSERT INTO main.user_settings(owner_user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(owner, k, v, nowIso())
  } else if (scope === 'global') {
    if (v === '') db.prepare('DELETE FROM settings WHERE key = ?').run(k)
    else db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
  } else if (v === '') db.prepare('DELETE FROM main.scoped_settings WHERE scope = ? AND scope_id = ? AND key = ?').run(scope, id, k)
  else db.prepare(`INSERT INTO main.scoped_settings(scope, scope_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope, scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(scope, id, k, v, nowIso())
}

// ---------- voice guide: database (editable source) <-> note in a notes folder (optional sync, without loss) ----------
// Off by default (setting `voice_sync`, global) and with no folder (`voice_sync_dir`): the voice guide then lives in
// the database only and nothing outside the plugin's storage is read or written.
/** The notes folder when voice guide sync is on and a folder is set, otherwise null. */
export function voiceSyncDir(db) {
  if (resolve(db, 'global', 0, 'voice_sync').value !== '1') return null
  const dir = String(resolve(db, 'global', 0, 'voice_sync_dir').value || '').trim()
  return dir || null
}
const SYNC_OFF = 'voice guide sync is off: turn it on and set the notes folder in Settings › General'
/** Absolute path of the note, checked inside the notes folder after resolving symbolic links. */
export function notePath(db, rel) {
  if (!rel) return null
  const dir = voiceSyncDir(db)
  if (!dir) throw new Error(SYNC_OFF)
  if (!existsSync(dir)) throw new Error(`notes folder not found: ${dir}`)
  const root = realpathSync(dir)
  const abs = path.resolve(root, rel)
  const real = existsSync(abs) ? realpathSync(abs) : path.join(realpathSync(path.dirname(abs)), path.basename(abs))
  if (!real.startsWith(root + path.sep)) throw new Error('the note must be inside the notes folder')
  return real
}
/** Sync state: is sync on, does the note exist, has it changed in the folder since the last exchange, has the database? */
export function voiceStatus(db, scope, id) {
  const own = scopedValues(db, scope, id)
  const rel = own.voice_note || ''
  const st = { note: rel, sync: Boolean(voiceSyncDir(db)), exists: false, noteChanged: false, dbChanged: false, synced: false }
  if (!rel || !st.sync) return st
  try {
    const f = notePath(db, rel)
    st.exists = existsSync(f)
    if (st.exists) {
      const fileHash = hash(readFileSync(f, 'utf8'))
      const last = own.voice_note_hash || null
      st.noteChanged = last != null ? fileHash !== last : (own.voice || '') !== readFileSync(f, 'utf8')
      st.dbChanged = last != null && hash(own.voice || '') !== last
      st.synced = !st.noteChanged && !st.dbChanged && last != null
    }
  } catch (e) { st.error = e.message }
  return st
}
/** Imports the linked note into the database (the note wins). */
export function importVoice(db, scope, id) {
  const own = scopedValues(db, scope, id)
  if (!voiceSyncDir(db)) throw new Error(SYNC_OFF)
  if (!own.voice_note) throw new Error('no note linked')
  const f = notePath(db, own.voice_note)
  if (!existsSync(f)) throw new Error(`note not found: ${own.voice_note}`)
  const txt = readFileSync(f, 'utf8')
  writeRaw(db, scope, id, 'voice', txt); writeRaw(db, scope, id, 'voice_note_hash', hash(txt))
  return txt
}
/** Saves the voice in the database and, when sync is on, copies it into the linked note. Refuses to overwrite a note
 *  changed in the folder since the last exchange (import it first), unless `force`. */
export function saveVoice(db, scope, id, text, { force = false } = {}) {
  if (!['organization', 'account'].includes(scope)) throw new Error('the voice is set on an organization or an account')
  const v = String(text || '')
  if (v.length > 50000) throw new Error('voice guide too long')
  const own = scopedValues(db, scope, id)
  let wrote = false
  if (own.voice_note && voiceSyncDir(db)) {
    const f = notePath(db, own.voice_note)
    if (existsSync(f) && !force) {
      const cur = hash(readFileSync(f, 'utf8'))
      if (own.voice_note_hash ? cur !== own.voice_note_hash : readFileSync(f, 'utf8') !== (own.voice || ''))
        throw new Error('the note changed since the last sync: import it first (or force the overwrite)')
    }
    if (v.trim()) { writeFileSync(f, v); wrote = true }
  }
  writeRaw(db, scope, id, 'voice', v.trim() ? v : '')
  if (wrote) writeRaw(db, scope, id, 'voice_note_hash', hash(v))
  return { wrote }
}

// ---------- organizations and accounts ----------
export function tree(db) {
  const orgs = db.prepare('SELECT id, slug, name, notes FROM organizations ORDER BY id').all()
  const accounts = db.prepare(`SELECT a.id, a.network, a.handle, a.display_name, a.lang, a.role, a.is_automated, a.requires_validation,
      a.organization_id, a.avatar_url, (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id) AS posts
    FROM accounts a WHERE a.relation = 'owned' ORDER BY a.id`).all()
    .map((a) => ({ ...a, connected: Boolean(resolve(db, 'account', a.id, 'x_publish_target').value) || a.network !== 'x' }))
  return {
    organizations: orgs.map((o) => ({ ...o, accounts: accounts.filter((a) => a.organization_id === o.id) })),
    unassigned: accounts.filter((a) => !a.organization_id),
    networks: db.prepare('SELECT id, name FROM networks ORDER BY rowid').all(),
    watched: db.prepare(`SELECT id, network, handle, display_name, watch_priority, watch_role FROM accounts
      WHERE relation = 'watched' AND competitor_id IS NULL AND COALESCE(watch_role, '') <> 'reference' ORDER BY watch_priority IS NULL, handle COLLATE NOCASE`).all(),
  }
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/
export function createOrganization(db, { name, slug, notes }) {
  const n = String(name || '').trim()
  if (!n) throw new Error('a name is required')
  const s = String(slug || n).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!SLUG.test(s)) throw new Error('invalid id')
  const owner = ownerOf(db)
  // slugs are unique in the installation: another user's slug is not revealed, the new one gets a suffix
  const mine = (x) => db.prepare('SELECT owner_user_id FROM main.organizations WHERE slug = ?').get(x)
  const hit = mine(s)
  if (hit && (!owner || hit.owner_user_id === owner)) throw new Error(`the organization "${s}" already exists`)
  let slugOk = s
  for (let i = 2; mine(slugOk); i++) slugOk = `${s.slice(0, 36)}-${i}`
  return Number(db.prepare('INSERT INTO main.organizations(slug, name, notes, created_at, owner_user_id) VALUES (?, ?, ?, ?, ?)').run(slugOk, n, notes || null, nowIso(), owner).lastInsertRowid)
}
export function updateOrganization(db, id, { name, notes }) {
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(id)) throw new Error('organization not found')
  if (name !== undefined) { const n = String(name).trim(); if (!n) throw new Error('a name is required'); db.prepare('UPDATE main.organizations SET name = ? WHERE id = ?').run(n, id) }
  if (notes !== undefined) db.prepare('UPDATE main.organizations SET notes = ? WHERE id = ?').run(String(notes).trim() || null, id)
}
export function deleteOrganization(db, id) {
  if (db.prepare('SELECT 1 FROM accounts WHERE organization_id = ?').get(id)) throw new Error('the organization still has accounts: move them first')
  db.prepare(`DELETE FROM main.scoped_settings WHERE scope = 'organization' AND scope_id = ?`).run(id)
  db.prepare('DELETE FROM main.organizations WHERE id = ?').run(id)
}
const HANDLE = /^[A-Za-z0-9_.-]{1,60}$/
const ROLES = ['personal', 'brand', 'automated']
export function createAccount(db, b) {
  const network = String(b.network || '')
  if (!db.prepare('SELECT 1 FROM networks WHERE id = ?').get(network)) throw new Error('unknown network')
  const handle = String(b.handle || '').trim().replace(/^@/, '')
  if (!HANDLE.test(handle)) throw new Error('invalid account handle')
  const org = Number(b.organization_id)
  if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(org)) throw new Error('organization not found')
  const ex = db.prepare('SELECT relation FROM accounts WHERE network = ? AND lower(handle) = lower(?)').get(network, handle)
  if (ex) throw new Error(ex.relation === 'owned' ? 'this account is already managed' : 'this account is watched: remove it from the watch before making it a managed account')
  const role = ROLES.includes(b.role) ? b.role : 'brand'
  const lang = /^[a-z]{2}$/.test(String(b.lang || '')) ? b.lang : null
  return Number(db.prepare(`INSERT INTO main.accounts(network, handle, display_name, relation, role, lang, is_automated, organization_id, owner_user_id)
    VALUES (?, ?, ?, 'owned', ?, ?, ?, ?, ?)`).run(network, handle, String(b.display_name || '').trim() || null, role, lang, role === 'automated' || b.is_automated ? 1 : 0, org, ownerOf(db)).lastInsertRowid)
}
export function updateAccount(db, id, b) {
  const a = db.prepare(`SELECT * FROM accounts WHERE id = ? AND relation = 'owned'`).get(id)
  if (!a) throw new Error('account not found')
  if (b.display_name !== undefined) db.prepare('UPDATE main.accounts SET display_name = ? WHERE id = ?').run(String(b.display_name).trim() || null, id)
  if (b.lang !== undefined) { if (b.lang && !/^[a-z]{2}$/.test(b.lang)) throw new Error('language: two-letter code (en, fr…)'); db.prepare('UPDATE main.accounts SET lang = ? WHERE id = ?').run(b.lang || null, id) }
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw new Error('unknown role'); db.prepare('UPDATE main.accounts SET role = ? WHERE id = ?').run(b.role, id) }
  if (b.is_automated !== undefined) db.prepare('UPDATE main.accounts SET is_automated = ? WHERE id = ?').run(b.is_automated ? 1 : 0, id)
  if (b.notes !== undefined) db.prepare('UPDATE main.accounts SET notes = ? WHERE id = ?').run(String(b.notes).trim() || null, id)
  if (b.organization_id !== undefined) {
    if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(Number(b.organization_id))) throw new Error('organization not found')
    db.prepare('UPDATE main.accounts SET organization_id = ? WHERE id = ?').run(Number(b.organization_id), id)
  }
  if (b.handle !== undefined && String(b.handle).replace(/^@/, '') !== a.handle) {
    const h = String(b.handle).trim().replace(/^@/, '')
    if (!HANDLE.test(h)) throw new Error('invalid account handle')
    if (db.prepare('SELECT 1 FROM posts WHERE account_id = ? AND status = ?').get(id, 'published')) throw new Error('account already published: its handle no longer changes')
    db.prepare('UPDATE main.accounts SET handle = ? WHERE id = ?').run(h, id)
  }
}
export function deleteAccount(db, id) {
  if (!db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND relation = 'owned'`).get(id)) throw new Error('account not found')
  if (db.prepare('SELECT 1 FROM posts WHERE account_id = ?').get(id)) throw new Error('this account has posts: it cannot be deleted')
  db.prepare(`DELETE FROM main.scoped_settings WHERE scope = 'account' AND scope_id = ?`).run(id)
  // feedback and rules of the account stay with its user
  const owner = db.prepare('SELECT owner_user_id FROM accounts WHERE id = ?').get(id).owner_user_id
  db.prepare('UPDATE main.learnings SET account_id = NULL, owner_user_id = ? WHERE account_id = ?').run(owner, id)
  db.prepare('UPDATE main.rule_proposals SET account_id = NULL, owner_user_id = ? WHERE account_id = ?').run(owner, id)
  db.prepare('DELETE FROM main.accounts WHERE id = ?').run(id)
}

/** Complete settings of a scope for the Settings screen: own overrides, effective values and origin. */
export function scopeView(db, scope, id) {
  const own = scopedValues(db, scope, id)
  const eff = effective(db, scope, id)
  const parentEff = scope === 'global' ? null : (() => {
    // value the key would have without the override of this level (to show it as "inherited")
    const noOwn = Object.fromEntries(Object.keys(own).map((k) => [k, '']))
    return effective(db, scope, id, noOwn)
  })()
  return {
    scope, id, own: Object.fromEntries(Object.entries(own).filter(([k]) => !HIDDEN.has(k))),
    effective: eff, inherited: parentEff,
    voice: scope === 'global' ? null : voiceStatus(db, scope, id),
  }
}
