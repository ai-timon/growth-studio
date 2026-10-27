// Prospecting comments in the studio: the Comments view (three tabs), the account's Comments settings tab (campaign,
// pains) and Settings › Competitors. A real host half on a fresh database (temporary folder) with the fictional demo
// seed plus fictional comment data; every state exported as fixtures, then captured (shot.sh), in English and French.
//   node tools/render-bench/comments-shots.mjs      -> tools/render-bench/out/comments-*.png
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const { apply } = await import('../../lib/index.js')
const bench = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(bench, '..', '..')
const fx = path.join(bench, 'fx'); mkdirSync(fx, { recursive: true })
const dir = mkdtempSync(path.join(tmpdir(), 'gs-comments-bench-'))
const routes = {}
const ctx = {
  permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'],
  router: () => new Proxy({}, { get: (_, m) => (p, fn) => { if (m !== 'use') routes[`${m.toUpperCase()} ${p}`] = fn } }),
  storage: { dir: path.join(dir, 'plugins-data'), kv: { get: async () => undefined, set: async () => {}, del: async () => {} } },
  settings: { get: (k) => ({ dataSource: 'plugin', agent: 'bench.writer' })[k] }, log: { info() {}, warn() {}, error() {} }, effect() {},
  user: () => ({ id: 'u1', name: 'Bench', is_superadmin: true }), realtime: { publish() {} }, notify: { report() {}, alert() {} },
  skills: { put: async () => {} }, missions: { spawn: async () => 'bench-mission' },
}
apply(ctx)
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const db = new DatabaseSync(path.join(dir, 'plugins-data', 'growth.db'))
db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
db.exec(`
  UPDATE organizations SET owner_user_id = 'u1'; UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned';
  INSERT INTO accounts(id, network, handle, display_name, relation) VALUES
    (10, 'x', 'tired_dev', 'Sam, backend dev', 'watched'), (11, 'x', 'notes_hoarder', 'Notes Hoarder', 'watched'),
    (12, 'x', 'rival_maker', 'Rival Maker', 'watched'), (13, 'x', 'ci_waiter', 'Waiting on CI', 'watched');
  INSERT INTO account_metrics(account_id, captured_at, followers) VALUES (10, '${ago(60)}', 840), (11, '${ago(60)}', 2310), (13, '${ago(60)}', 120);
  INSERT INTO competitors(id, slug, name, website) VALUES (1, 'rivalsoft', 'RivalSoft', 'https://rivalsoft.example');
  INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalSoft'), (1, 'Rival Notes');
  INSERT INTO competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (1, 'x', 'rival_official', 'official', 'website', '${ago(900)}'), (1, 'x', 'rival_cto', 'founder', 'bio', '${ago(800)}');
  INSERT INTO items(id, network, external_id, author_id, text, first_seen_at, posted_at, url) VALUES
    (100, 'x', '100', 10, 'I lose an hour a day searching my notes. Folders, tags, nothing works once you have 3000 files.', '${ago(50)}', '${ago(70)}', 'https://x.com/tired_dev/status/100'),
    (101, 'x', '101', 11, 'Is there a way to search all my markdown notes from the terminal without setting up a database?', '${ago(30)}', '${ago(40)}', 'https://x.com/notes_hoarder/status/101'),
    (102, 'x', '102', 13, 'My CI takes 20 minutes for a two-line change. Every single time.', '${ago(400)}', '${ago(420)}', NULL),
    (103, 'x', '103', 12, 'We just shipped a faster search, try it today', '${ago(300)}', '${ago(320)}', 'https://x.com/rival_maker/status/103'),
    (104, 'x', '104', 10, 'Lost my notes again', '${ago(600)}', '${ago(620)}', NULL);
  INSERT INTO captures(item_id, source, captured_at) VALUES (100, 'search', '${ago(50)}'), (101, 'search', '${ago(30)}'), (102, 'search', '${ago(400)}'), (103, 'search', '${ago(300)}'), (104, 'search', '${ago(600)}');
  INSERT INTO item_metrics(item_id, captured_at, likes, views, shares, replies) VALUES (100, '${ago(50)}', 31, 4200, 2, 9), (101, '${ago(30)}', 4, 610, 0, 2);
  INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, langs, max_replies_per_day, min_gap_min, search_budget_usd, active_hours, created_at)
    VALUES (1, 1, 'u1', 'Notes', 1, '["en"]', 5, 20, 0.3, '08-20', '${ago(2000)}');
  INSERT INTO comment_pains(id, campaign_id, pain, queries, examples_positive, examples_negative, solution, solution_source, created_at) VALUES
    (1, 1, 'I cannot find anything in my notes any more', '["cannot find my notes","notes search slow"]', '["I lose an hour a day searching my notes"]', '["Our notes app ships search today"]',
     'Index the notes folder once with the CLI, then search it from the terminal in under a second.', 'https://acme.example/docs/search', '${ago(2000)}');
  INSERT INTO comment_pains(id, campaign_id, pain, queries, active, created_at) VALUES (2, 1, 'CI too slow for small changes', '["ci takes forever"]', 0, '${ago(1500)}');
  INSERT INTO posts(id, account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at) VALUES
    (101, 1, 'reply', 'reply', 'en', 'Same here at 3000 files. What fixed it for me: one index of the whole folder, then search from the terminal. I work on Acme Tools, which does exactly that.', 100, 'pending_validation', '${ago(20)}'),
    (102, 1, 'reply', 'reply', 'en', 'Yes: a plain index of the folder is enough, no database. Acme Tools does it in one command (I work on it).', 101, 'pending_validation', '${ago(10)}');
  INSERT INTO posts(id, account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at, validated_at, validated_by, published_at, url) VALUES
    (103, 1, 'reply', 'reply', 'en', 'Caching the dependencies cut ours from 20 to 4 minutes.', 102, 'published', '${ago(390)}', '${ago(380)}', 'Bench', '${ago(370)}', 'https://x.com/acme_dev/status/9');
  INSERT INTO posts(id, account_id, kind, post_type, lang, body, reply_to_item_id, status, created_at, validation_note) VALUES
    (104, 1, 'reply', 'reply', 'en', 'Search everything at once.', 104, 'rejected', '${ago(590)}', 'Too short, no tip');
  INSERT INTO comment_candidates(id, campaign_id, item_id, pain_id, score, reason, author_affiliation, status, post_id, created_at) VALUES
    (1, 1, 100, 1, 5, 'Lives the pain right now and asks for a way out.', 'none', 'drafted', 101, '${ago(25)}'),
    (2, 1, 101, 1, 4, 'Asks for exactly what the solution does.', 'none', 'drafted', 102, '${ago(15)}'),
    (3, 1, 102, 2, 4, 'Complains about slow CI.', 'none', 'replied', 103, '${ago(395)}'),
    (4, 1, 104, 1, 3, 'Short complaint.', 'none', 'dismissed', 104, '${ago(595)}');
  INSERT INTO comment_candidates(id, campaign_id, item_id, author_affiliation, status, dismiss_reason, created_at) VALUES
    (5, 1, 103, 'unknown', 'dismissed', 'Says "we just shipped": may work on a competing product.', '${ago(299)}');
`)
db.close()

const call = async (key, { params = {}, query = {} } = {}) => {
  let status = 200, json
  const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
  await routes[key]({ body: {}, params, query, url: '/' }, res)
  if (status >= 400) throw new Error(`${key}: ${JSON.stringify(json)}`)
  return json
}
// the name index.html gives a request: the client's path (query slipped into a `_q/…` segment), then fx()
const fxName = (p) => {
  const q = p.indexOf('?')
  const api = q < 0 ? p : `_q/${encodeURIComponent(p.slice(q + 1))}/${p.slice(0, q)}`
  return path.join(fx, `${api.replace(/[^a-z0-9]/g, '_')}.json`)
}
const dump = (p, data) => writeFileSync(fxName(p), JSON.stringify(data))
const shot = (name, query, h = 1100) => console.log(execFileSync(path.join(bench, 'shot.sh'), [name, query, '1280', String(h)], { encoding: 'utf8' }).trim())
try {
  dump('overview', await call('GET /overview'))
  dump('status', await call('GET /status'))
  for (const tab of ['pending', 'sent', 'dismissed']) dump(`comments?tab=${tab}`, await call('GET /comments', { query: { tab } }))
  dump('orgs', await call('GET /orgs'))
  dump('scope/account/1/settings', await call('GET /scope/:scope/:id/settings', { params: { scope: 'account', id: '1' } }))
  dump('comments/campaigns?account=1', await call('GET /comments/campaigns', { query: { account: '1' } }))
  dump('competitors', await call('GET /competitors'))
  dump('i18n/fr', JSON.parse(readFileSync(path.join(root, 'lib', 'i18n', 'fr.json'), 'utf8')))
  shot('comments-pending', 'view=comments', 1000)
  shot('comments-pending-dark-fr', 'view=comments&theme=dark&lang=fr', 1000)
  // the other tabs: the view starts on "To validate", the fixture of the tab is served in its place
  for (const tab of ['sent', 'dismissed']) {
    writeFileSync(fxName('comments?tab=pending'), readFileSync(fxName(`comments?tab=${tab}`)))
    const data = JSON.parse(readFileSync(fxName('comments?tab=pending'), 'utf8'))
    console.log(`(${tab}: ${data.replies.length} replies, rendered under the first tab)`)
    shot(`comments-${tab}`, 'view=comments', 700)
  }
  shot('comments-settings', 'view=settings&scope=account&sid=1&tab=comments', 2600)
  shot('comments-settings-fr', 'view=settings&scope=account&sid=1&tab=comments&lang=fr', 2600)
  shot('comments-competitors', 'view=settings&scope=competitors', 1300)
  shot('comments-competitors-dark-fr', 'view=settings&scope=competitors&theme=dark&lang=fr', 1300)
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(0)
