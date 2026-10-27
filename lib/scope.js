// Multi-user: the single place that decides what a Timon user sees and may change in the studio's database.
// Every connection opened for a user (a request of the interface, a command of the agent CLI run with `--owner`) is
// scoped here, never route by route:
// - TEMP views named like the tables shadow them (SQLite resolves an unqualified name in the temp schema first),
//   each one keeping only the rows of the user: every read is filtered as it is written;
// - on a writable connection, TEMP triggers on the main tables also refuse to insert, change or delete a row of
//   another user, with the same "<thing> not found" message as a missing row (the API answers 404, never 403).
// Consequence for the code: a write names the table with its schema (`UPDATE main.posts …`, `INSERT INTO main.ideas
// …`); an unqualified write on a scoped connection fails loudly ("cannot modify posts because it is a view").
// The triggers and views of the main schema keep reading the main tables: the SQL guard rails are unchanged.
// What belongs to a user: their organizations and managed accounts, and everything reached through them (posts,
// ideas, feedback, rules, requests to the agent, settings of the account or organization, bookmarks fetched for
// their accounts), plus the rows that carry `owner_user_id` themselves (ideas, feedback, rules and requests without
// an account; user-level settings). Shared by the installation: watched accounts, the posts they publish and their
// triage, the news queue (a draft linked to it is only shown to its owner), competitors, ignored ids, the
// installation settings. Connections opened without a user (background jobs, the operator's CLI) see everything.

const OWNERS = new WeakMap()
/** User a connection was scoped to, or null (unscoped: background jobs, operator). */
export const ownerOf = (db) => OWNERS.get(db) ?? null

/** A Timon user id as the studio stores it: short, printable, no quote. */
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/
export function checkOwnerId(raw) {
  const s = String(raw ?? '').trim()
  if (!OWNER_ID.test(s)) throw new Error(`invalid Growth Studio user id: "${s.slice(0, 40)}"`)
  return s
}

const ME = '(SELECT id FROM temp.scope_viewer)'
const MY_ACCOUNTS = `SELECT id FROM main.accounts WHERE relation = 'owned' AND owner_user_id = ${ME}`
const VISIBLE_ACCOUNTS = `SELECT id FROM main.accounts WHERE relation = 'watched' OR owner_user_id = ${ME}`
const MY_ORGS = `SELECT id FROM main.organizations WHERE owner_user_id = ${ME}`
const MY_POSTS = `SELECT id FROM main.posts WHERE account_id IN (${MY_ACCOUNTS})`
/** Rows that hang on an account of the user, or carry the user themselves when they have no account. */
const OWN = (r) => `(${r}account_id IN (${MY_ACCOUNTS}) OR (${r}account_id IS NULL AND ${r}owner_user_id = ${ME}))`
const MY_IDEAS = `SELECT id FROM main.ideas x WHERE ${OWN('x.')}`
/** An item is shared unless it only came in as a bookmark of someone else's account. */
const ITEM_VISIBLE = (idExpr) => `(NOT EXISTS (SELECT 1 FROM main.captures c WHERE c.item_id = ${idExpr})
  OR EXISTS (SELECT 1 FROM main.captures c WHERE c.item_id = ${idExpr} AND (c.source <> 'bookmark' OR c.account_id IN (${MY_ACCOUNTS}))))`
const VISIBLE_ITEMS = `SELECT id FROM main.items i WHERE ${ITEM_VISIBLE('i.id')}`
const MY_CAMPAIGNS = `SELECT id FROM main.comment_campaigns WHERE owner_user_id = ${ME} AND account_id IN (${MY_ACCOUNTS})`

/**
 * Per table: `read` = condition on the row (alias `t.`) for the shadow view; `write` = condition on NEW / OLD for the
 * guard triggers (`R.` placeholder); `what` = the word of the "not found" message. `insert` overrides `write` for
 * inserts. A table without `write` can be written freely (shared data).
 */
const TABLES = {
  organizations: { what: 'organization', read: `t.owner_user_id = ${ME}`, write: `R.owner_user_id = ${ME}` },
  accounts: {
    what: 'account',
    read: `t.relation = 'watched' OR t.owner_user_id = ${ME}`,
    write: `((R.relation = 'watched' AND R.owner_user_id IS NULL) OR (R.relation = 'owned' AND R.owner_user_id = ${ME}
      AND (R.organization_id IS NULL OR R.organization_id IN (${MY_ORGS}))))`,
  },
  account_metrics: { what: 'account', read: `t.account_id IN (${VISIBLE_ACCOUNTS})`, write: `R.account_id IN (${VISIBLE_ACCOUNTS})` },
  items: { what: 'item', read: ITEM_VISIBLE('t.id'), write: ITEM_VISIBLE('R.id'), insert: null },
  item_metrics: { what: 'item', read: `t.item_id IN (${VISIBLE_ITEMS})`, write: `R.item_id IN (${VISIBLE_ITEMS})` },
  captures: {
    what: 'account',
    read: `t.source <> 'bookmark' OR t.account_id IN (${MY_ACCOUNTS})`,
    write: `((R.source <> 'bookmark' AND (R.account_id IS NULL OR R.account_id IN (${VISIBLE_ACCOUNTS}))) OR R.account_id IN (${MY_ACCOUNTS}))`,
  },
  assessments: { what: 'item', read: `t.item_id IN (${VISIBLE_ITEMS})`, write: `R.item_id IN (${VISIBLE_ITEMS})` },
  ideas: { what: 'idea', read: OWN('t.'), write: OWN('R.') },
  idea_items: { what: 'idea', read: `t.idea_id IN (${MY_IDEAS})`, write: `R.idea_id IN (${MY_IDEAS}) AND R.item_id IN (${VISIBLE_ITEMS})` },
  posts: { what: 'post', read: `t.account_id IN (${MY_ACCOUNTS})`, write: `R.account_id IN (${MY_ACCOUNTS})` },
  post_items: { what: 'post', read: `t.post_id IN (${MY_POSTS})`, write: `R.post_id IN (${MY_POSTS}) AND R.item_id IN (${VISIBLE_ITEMS})` },
  post_metrics: { what: 'post', read: `t.post_id IN (${MY_POSTS})`, write: `R.post_id IN (${MY_POSTS})` },
  scoped_settings: {
    what: 'account',
    read: `(t.scope = 'organization' AND t.scope_id IN (${MY_ORGS})) OR (t.scope = 'account' AND t.scope_id IN (${MY_ACCOUNTS}))`,
    write: `((R.scope = 'organization' AND R.scope_id IN (${MY_ORGS})) OR (R.scope = 'account' AND R.scope_id IN (${MY_ACCOUNTS})))`,
  },
  user_settings: { what: 'setting', read: `t.owner_user_id = ${ME}`, write: `R.owner_user_id = ${ME}` },
  news_queue: {
    what: 'post',
    // shared queue; the draft of another user is not shown (post_id masked below)
    read: '1',
    write: `(R.post_id IS NULL OR R.post_id IN (${MY_POSTS}))`,
    mask: { post_id: `CASE WHEN t.post_id IN (${MY_POSTS}) THEN t.post_id END` },
  },
  ingest_runs: { what: 'account', read: `t.account_id IS NULL OR t.account_id IN (${VISIBLE_ACCOUNTS})`, write: `(R.account_id IS NULL OR R.account_id IN (${VISIBLE_ACCOUNTS}))` },
  learnings: { what: 'feedback', read: OWN('t.'), write: OWN('R.') },
  rule_proposals: { what: 'proposal', read: OWN('t.'), write: OWN('R.') },
  studio_requests: {
    what: 'request',
    read: `t.post_id IN (${MY_POSTS}) OR t.account_id IN (${MY_ACCOUNTS}) OR (t.post_id IS NULL AND t.account_id IS NULL AND t.owner_user_id = ${ME})`,
    write: `(R.post_id IN (${MY_POSTS}) OR R.account_id IN (${MY_ACCOUNTS}) OR (R.post_id IS NULL AND R.account_id IS NULL AND R.owner_user_id = ${ME}))`,
  },
  // prospecting comments (v22): a campaign hangs on a managed account of its owner; competitor_team stays shared
  comment_campaigns: { what: 'campaign', read: `t.owner_user_id = ${ME} AND t.account_id IN (${MY_ACCOUNTS})`, write: `R.owner_user_id = ${ME} AND R.account_id IN (${MY_ACCOUNTS})` },
  comment_pains: { what: 'campaign', read: `t.campaign_id IN (${MY_CAMPAIGNS})`, write: `R.campaign_id IN (${MY_CAMPAIGNS})` },
  comment_candidates: {
    what: 'candidate',
    read: `t.campaign_id IN (${MY_CAMPAIGNS})`,
    write: `R.campaign_id IN (${MY_CAMPAIGNS}) AND R.item_id IN (${VISIBLE_ITEMS}) AND (R.post_id IS NULL OR R.post_id IN (${MY_POSTS}))`,
  },
}

const columnsOf = (db, table) => db.prepare(`PRAGMA main.table_info(${table})`).all().map((c) => c.name)

/**
 * Scopes an open connection to one user (see the header). `admin`: the user may change the installation settings
 * (table `settings`), otherwise those writes are refused. Returns the same connection.
 */
export function scopeDb(db, owner, { readOnly = false, admin = false } = {}) {
  const me = checkOwnerId(owner)
  // a database still at a version without owners (its update failed, the studio is read-only): an administrator
  // reads it whole, any other user is refused rather than shown someone else's data
  if (!hasColumn(db, 'accounts', 'owner_user_id')) {
    if (admin) return db
    throw new Error('the Growth Studio database could not be updated for several users: only an administrator can read it until it is')
  }
  const sql = ['CREATE TEMP TABLE scope_viewer(id TEXT NOT NULL)']
  for (const [table, t] of Object.entries(TABLES)) {
    const cols = columnsOf(db, table)
    if (!cols.length) continue   // table absent from this schema version
    const list = cols.map((c) => (t.mask && t.mask[c] ? `${t.mask[c]} AS ${c}` : `t.${c}`)).join(', ')
    sql.push(`CREATE TEMP VIEW ${table} AS SELECT ${list} FROM main.${table} t WHERE ${t.read}`)
    if (readOnly) continue
    const fail = `SELECT RAISE(ABORT, '${t.what} not found')`
    // NULL (a row without owner) counts as "not the user's"
    const no = (expr, row) => `NOT COALESCE((${expr.replaceAll('R.', `${row}.`)}), 0)`
    const ins = t.insert === undefined ? t.write : t.insert
    if (ins) sql.push(`CREATE TEMP TRIGGER scope_${table}_ins BEFORE INSERT ON main.${table} WHEN ${no(ins, 'NEW')} BEGIN ${fail}; END`)
    sql.push(`CREATE TEMP TRIGGER scope_${table}_upd BEFORE UPDATE ON main.${table} WHEN ${no(t.write, 'OLD')} OR ${no(t.write, 'NEW')} BEGIN ${fail}; END`)
    sql.push(`CREATE TEMP TRIGGER scope_${table}_del BEFORE DELETE ON main.${table} WHEN ${no(t.write, 'OLD')} BEGIN ${fail}; END`)
  }
  if (!readOnly && !admin) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      sql.push(`CREATE TEMP TRIGGER scope_settings_${op.toLowerCase()} BEFORE ${op} ON main.settings BEGIN SELECT RAISE(ABORT, 'installation settings are reserved to an administrator'); END`)
    }
  }
  db.exec(sql.join(';\n'))
  db.prepare('INSERT INTO temp.scope_viewer(id) VALUES (?)').run(me)
  OWNERS.set(db, me)
  return db
}

// ---------- which resource a request names (central guard of the API) ----------
/**
 * Resources named in a request: the `:id` of the route, `?account=`, and `account_id` / `organization_id` in the
 * body. The API checks each one through a scoped read connection before running the route: another user's resource
 * answers exactly like a missing one (404).
 * `route` is the route pattern ('/posts/:id/approve'), `req` the request.
 */
const ROUTE_RESOURCES = [
  [/^\/posts\/:id\b/, 'posts', 'post'],
  [/^\/media\/:id\b/, 'posts', 'media'],
  [/^\/ideas\/:id\b/, 'ideas', 'idea'],
  [/^\/learnings\/:id\b/, 'learnings', 'feedback'],
  [/^\/rules\/:id\b/, 'rule_proposals', 'proposal'],
  [/^\/items\/:id\b/, 'items', 'item'],
  [/^\/orgs\/:id\b/, 'organizations', 'organization'],
  [/^\/accounts\/:id\b/, 'owned', 'account'],
  [/^\/comments\/:id\b/, 'posts', 'post'],
  [/^\/comments\/campaigns\/:id\b/, 'comment_campaigns', 'campaign'],
  [/^\/comments\/pains\/:id\b/, 'comment_pains', 'pain'],
]
export function namedResources(route, req) {
  const out = []
  const add = (table, what, raw) => {
    if (raw === undefined || raw === null || raw === '') return
    out.push({ table, what, id: Number(raw) })
  }
  for (const [re, table, what] of ROUTE_RESOURCES) if (re.test(route)) add(table, what, req.params && req.params.id)
  if (/^\/scope\/:scope\/:id\b/.test(route) && req.params) {
    if (req.params.scope === 'organization') add('organizations', 'organization', req.params.id)
    if (req.params.scope === 'account') add('owned', 'account', req.params.id)
  }
  const q = req.query || {}
  if (q.account !== undefined && q.account !== '') add('owned', 'account', q.account)
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  if (b.account_id !== undefined && b.account_id !== null && b.account_id !== '') add('owned', 'account', b.account_id)
  if (b.organization_id !== undefined && b.organization_id !== null && b.organization_id !== '') add('organizations', 'organization', b.organization_id)
  return out
}
/** Throws "<what> not found" when a named resource is not visible on this (scoped, read-only) connection. */
export function assertVisible(db, resources) {
  for (const r of resources) {
    // a malformed id is left to the route, which answers "invalid id"
    if (!Number.isInteger(r.id) || r.id <= 0) continue
    const found = r.table === 'owned'
      ? db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND relation = 'owned'`).get(r.id)
      : db.prepare(`SELECT 1 FROM ${r.table} WHERE id = ?`).get(r.id)
    if (!found) throw new Error(`${r.what} not found`)
  }
}

// ---------- owners of the installation, adoption of rows written without one ----------
const OWNED_TABLES = ['organizations', 'accounts', 'ideas', 'learnings', 'rule_proposals', 'studio_requests', 'user_settings', 'comment_campaigns']
const hasColumn = (db, table, col) => columnsOf(db, table).includes(col)

/** Users that own something in the database, sorted. */
export function knownOwners(db) {
  if (!hasColumn(db, 'accounts', 'owner_user_id')) return []
  // a table of a later version may be absent (database left at an older version by a failed update)
  const parts = OWNED_TABLES.filter((t) => columnsOf(db, t).length).map((t) => `SELECT owner_user_id AS o FROM main.${t} WHERE owner_user_id IS NOT NULL`)
  return db.prepare(`SELECT DISTINCT o FROM (${parts.join(' UNION ')}) ORDER BY o`).all().map((r) => r.o)
}

/** Rows that belong to nobody yet, per table (written before multi-user, or by a tool outside the plugin). */
export function strayCounts(db) {
  if (!hasColumn(db, 'accounts', 'owner_user_id')) return {}
  const q = {
    organizations: 'SELECT COUNT(*) AS n FROM main.organizations WHERE owner_user_id IS NULL',
    accounts: `SELECT COUNT(*) AS n FROM main.accounts WHERE relation = 'owned' AND owner_user_id IS NULL`,
    ideas: 'SELECT COUNT(*) AS n FROM main.ideas WHERE account_id IS NULL AND owner_user_id IS NULL',
    learnings: 'SELECT COUNT(*) AS n FROM main.learnings WHERE account_id IS NULL AND owner_user_id IS NULL',
    rule_proposals: 'SELECT COUNT(*) AS n FROM main.rule_proposals WHERE account_id IS NULL AND owner_user_id IS NULL',
    studio_requests: 'SELECT COUNT(*) AS n FROM main.studio_requests WHERE post_id IS NULL AND account_id IS NULL AND owner_user_id IS NULL',
  }
  return Object.fromEntries(Object.entries(q).map(([t, s]) => [t, db.prepare(s).get().n]).filter(([, n]) => n > 0))
}

/** Gives every row without an owner to `owner` (unscoped, writable connection). Returns the number of rows. */
export function adoptStrays(db, owner) {
  const me = checkOwnerId(owner)
  let n = 0
  const run = (s) => { n += Number(db.prepare(s).run(me).changes) }
  run('UPDATE main.organizations SET owner_user_id = ? WHERE owner_user_id IS NULL')
  run(`UPDATE main.accounts SET owner_user_id = ? WHERE relation = 'owned' AND owner_user_id IS NULL`)
  run('UPDATE main.ideas SET owner_user_id = ? WHERE account_id IS NULL AND owner_user_id IS NULL')
  run('UPDATE main.learnings SET owner_user_id = ? WHERE account_id IS NULL AND owner_user_id IS NULL')
  run('UPDATE main.rule_proposals SET owner_user_id = ? WHERE account_id IS NULL AND owner_user_id IS NULL')
  run('UPDATE main.studio_requests SET owner_user_id = ? WHERE post_id IS NULL AND account_id IS NULL AND owner_user_id IS NULL')
  return n
}

/**
 * First owner of a database written before multi-user: takes every row without an owner, and copies the
 * user-level settings (`userKeys`) of the installation table into their own settings. Done once, by the caller,
 * when the database has no owner yet. Returns { rows, settings }.
 */
export function claimDatabase(db, owner, userKeys, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  const me = checkOwnerId(owner)
  db.exec('BEGIN')
  try {
    const rows = adoptStrays(db, me)
    const marks = userKeys.map(() => '?').join(',')
    const settings = userKeys.length ? Number(db.prepare(`INSERT OR IGNORE INTO main.user_settings(owner_user_id, key, value, updated_at)
      SELECT ?, key, value, ? FROM settings WHERE key IN (${marks})`).run(me, now, ...userKeys).changes) : 0
    db.exec('COMMIT')
    return { rows, settings }
  } catch (e) { try { db.exec('ROLLBACK') } catch { /* already rolled back */ } throw e }
}
