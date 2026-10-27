// Agent tools (lib/agent-tools.js) on a database built from the shipped schema and the demo seed: the guardrails of
// the former project scripts are kept, and no tool ever validates a post.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { UsageError, inlineInput, runTool } from '../lib/agent-tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)])

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-tools-'))
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
  migrate(db)
  db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
  db.exec(`INSERT INTO competitors(id, slug, name) VALUES (1, 'rival', 'Rival')`)
  db.exec(`INSERT INTO competitor_aliases(competitor_id, alias) VALUES (1, 'RivalApp')`)
  db.exec(`INSERT INTO accounts(id, network, handle, relation, watch_role) VALUES (9, 'x', 'ref_account', 'watched', 'reference')`)
  db.exec(`INSERT INTO items(id, network, external_id, author_id, text, first_seen_at) VALUES (9, 'x', '9', 9, 'reference text', '2026-01-06T00:00:00Z')`)
  db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'post_types', '[{"key":"valeur","label":"Value","share":60,"prompt":"Useful."},{"key":"reach","label":"Reach","share":40,"prompt":"Wide."}]', 'x')`)
  const files = {}
  const put = (name, content) => { files[name] = Buffer.from(content).toString('base64'); return name }
  const paths = { base: dir, mediaDir: path.join(dir, 'media') }
  const run = (...argv) => runTool(db, argv, { paths, input: inlineInput(files) })
  return { dir, db, put, run, paths, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const idea = (o = {}) => ({ title: 'Review before main', pain: 'Agents break main', solution: 'A review step', solution_kind: 'method', evidence: 'feedback #1', concept: 'Review every change.', post_type: 'valeur', item_ids: [], ...o })

test('account context, accounts and the product changelog setting', () => {
  const t = setup()
  try {
    assert.match(t.run('accounts'), /#1 @acme_dev/)
    t.db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'source_changelog', '1', 'x')`)
    assert.match(t.run('account-context', 'acme_dev'), /Product changelog: not configured/)
    t.db.exec(`INSERT INTO settings(key, value) VALUES ('product_changelog', 'https://example.test/CHANGES.md')`)
    const out = t.run('account-context', '1')
    assert.match(out, /Product changelog \(URL or file to read.*https:\/\/example\.test\/CHANGES\.md/)
    assert.match(out, /- valeur: Value \(target share 60 %\)/)
    assert.throws(() => t.run('account-context', 'nobody'), /unknown managed account/)
  } finally { t.done() }
})

test('ideas: competitor, duplicate title, forbidden item and question to the user are refused', () => {
  const t = setup()
  try {
    const f = (list) => t.put(`ideas-${Math.random()}.json`, JSON.stringify(list))
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ concept: 'Better than RivalApp' })])), /competitor \("RivalApp"\)/)
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ item_ids: [9] })])), /reference account/)
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ ask_rom: 'what do you think?' })])), /no question to the user/)
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ post_type: 'nope' })])), /post_type/)
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ solution_kind: 'magic' })])), /product \| tool \| method/)
    assert.match(t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ item_ids: [1] })])), /1 idea\(s\) saved for @acme_dev: #2/)
    assert.throws(() => t.run('ideas', 'add', '--account', 'acme_dev', '--file', f([idea({ title: 'review BEFORE main' })])), /title already proposed/)
    assert.equal(t.db.prepare('SELECT solution_kind FROM ideas WHERE id = 2').get().solution_kind, 'methode')
    assert.match(t.run('ideas', 'list', '--account', 'acme_dev'), /#2 \[valeur\] Review before main/)
    assert.match(t.run('ideas', 'show', '2'), /Solution \(method\): A review step/)
    // an idea still waiting is drafted only with direct drafting
    const txt = t.put('p.txt', 'Every change goes through review.')
    assert.throws(() => t.run('ideas', 'post', '2', '--file', txt), /not kept it/)
    t.db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'original_auto_draft', '1', 'x')`)
    assert.match(t.run('ideas', 'post', '2', '--file', txt, '--image-prompt', 'a desk'), /draft #3 created/)
    const p = t.db.prepare('SELECT status, validated_by, post_type, image_prompt FROM posts WHERE id = 3').get()
    assert.deepEqual({ ...p }, { status: 'pending_validation', validated_by: null, post_type: 'valeur', image_prompt: 'a desk' })
  } finally { t.done() }
})

test('posts: draft, revise, brief; a competitor in the text is refused; never validated by a tool', () => {
  const t = setup()
  try {
    assert.throws(() => t.run('post', 'draft', '--account', '1', '--file', t.put('a.txt', 'Try RivalApp'), '--item', '1'), /competitor/)
    assert.throws(() => t.run('post', 'draft', '--account', '1', '--file', t.put('b.txt', 'x'), '--item', '9'), /reference account/)
    assert.match(t.run('post', 'draft', '--account', '1', '--file', t.put('c.txt', 'Notes index in one command.'), '--item', '1', '--quote', '2', '--type', 'reach'), /draft #3 created .*quotes item #2/)
    const p3 = t.db.prepare('SELECT kind, quote_item_id, status, idea_id FROM posts WHERE id = 3').get()
    assert.deepEqual([p3.kind, p3.quote_item_id, p3.status], ['quote', 2, 'pending_validation'])
    assert.equal(t.db.prepare('SELECT origin FROM ideas WHERE id = ?').get(p3.idea_id).origin, 'bookmark')
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM post_items WHERE post_id = 3').get().n, 2)
    assert.match(t.run('post', 'revise', '1', '--file', t.put('d.txt', 'Shorter.'), '--note', 'cut'), /post #4 created .*replaces post #1/)
    assert.deepEqual({ ...t.db.prepare('SELECT status, validation_note FROM posts WHERE id = 1').get() }, { status: 'rejected', validation_note: 'Replaced by version #4: cut' })
    const p4 = t.db.prepare('SELECT supersedes_post_id, idea_id, post_type, image_prompt_code FROM posts WHERE id = 4').get()
    assert.equal(p4.supersedes_post_id, 1); assert.equal(p4.post_type, 'valeur'); assert.match(p4.image_prompt_code, /terminal window/)
    assert.throws(() => t.run('post', 'revise', '2', '--file', t.put('e.txt', 'x')), /published/)
    assert.match(t.run('post', 'set-brief', '4', '--image-prompt', 'a bright desk'), /saved/)
    assert.match(t.run('post', 'show', '4'), /Image brief \(realistic image\): a bright desk/)
    assert.match(t.run('item', 'show', '9'), /FORBIDDEN SOURCE: reference account/)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE validated_by IS NOT NULL AND id > 2').get().n, 0)
    assert.throws(() => t.run('post', 'nope'), UsageError)
  } finally { t.done() }
})

test('attach-media checks the PNG and stores it in the media folder; schedule-next only takes a validated post', () => {
  const t = setup()
  try {
    assert.throws(() => t.run('attach-media', '1', t.put('x.png', 'not a png at all, just some text padding padding padding padding padding')), /not a PNG/)
    t.put('ok.png', PNG)
    assert.match(t.run('attach-media', '1', 'ok.png', '--engine', 'image'), /visual attached to post #1 \(media\/1\.png\)/)
    assert.ok(existsSync(path.join(t.paths.mediaDir, '1.png')))
    assert.equal(JSON.parse(t.db.prepare('SELECT media FROM posts WHERE id = 1').get().media)[0].path, 'media/1.png')
    assert.throws(() => t.run('schedule-next', '1'), /only a post the user validated/)
    t.db.exec(`UPDATE posts SET status = 'approved', validated_at = '2026-01-06T10:00:00Z', validated_by = 'owner' WHERE id = 1`)
    assert.match(t.run('schedule-next', '1', '--dry-run'), /\[dry-run\] post #1 scheduled for/)
    assert.equal(t.db.prepare('SELECT status FROM posts WHERE id = 1').get().status, 'approved')
    assert.match(t.run('schedule-next', '1'), /post #1 scheduled for/)
    assert.equal(t.db.prepare('SELECT status FROM posts WHERE id = 1').get().status, 'scheduled')
  } finally { t.done() }
})

test('feedback: context, pending, propose (evidence checked), done', () => {
  const t = setup()
  try {
    assert.match(t.run('feedback', 'context', '--account', '1', '--days', '100000'), /Too long, keep one detail/)
    assert.match(t.run('feedback', 'pending'), /1 feedback item\(s\) not synthesized/)
    assert.throws(() => t.run('feedback', 'propose', '--text', 'Keep it short', '--evidence', '99'), /unknown feedback id/)
    assert.match(t.run('feedback', 'propose', '--text', 'Keep it short', '--evidence', '1', '--account', '1'), /rule #1 applied automatically \(the user can revoke it in Settings › Learning\)/)
    assert.match(t.run('feedback', 'pending'), /0 feedback item\(s\)[\s\S]*\[accepted\] Keep it short/)
    assert.match(t.run('feedback', 'done', '1'), /0 feedback item\(s\) marked/)
    assert.throws(() => t.run('feedback', 'propose', '--text', 'x', '--evidence', '1', '--account', '99'), /unknown managed account/)
  } finally { t.done() }
})

test('triage-commit stores kept items, keeps only the id of ignored ones and flags competitors', () => {
  const t = setup()
  try {
    const staged = {
      111: { author: { handle: 'new_dev', external_id: 'u1', name: 'New Dev', followers: 10, following: 5 }, kind: 'post', url: 'https://x.com/new_dev/status/111', text: 'A neat CLI', lang: 'en', posted_at: '2026-01-07T00:00:00Z', media: [], likes: 1, views: 10, shares: 0, replies: 0, saves: 1 },
      222: { author: { handle: 'spam', external_id: 'u2', name: 'Spam' }, kind: 'post', text: 'politics', media: [] },
      333: { author: { handle: 'fan', external_id: 'u3', name: 'Fan' }, kind: 'post', text: 'I love RivalApp', media: [] },
    }
    writeFileSync(path.join(t.dir, 'staging.json'), JSON.stringify(staged))
    const v = t.put('v.json', JSON.stringify({ 111: { verdict: 'keep', pillar: 'open_source', score: 4, angle: 'save it' }, 222: { verdict: 'ignore' }, 333: { verdict: 'keep', pillar: 'other', score: 3 } }))
    assert.match(t.run('triage-commit', v), /2 kept, 1 ignored \(id only\), 0 still waiting/)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ignored_items WHERE external_id = '222'`).get().n, 1)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE external_id = '222'`).get().n, 0)
    const comp = t.db.prepare(`SELECT s.pillar, s.score, s.competitor_id FROM assessments s JOIN items i ON i.id = s.item_id WHERE i.external_id = '333'`).get()
    assert.deepEqual({ ...comp }, { pillar: 'competitor', score: null, competitor_id: 1 })
    assert.deepEqual(JSON.parse(readFileSync(path.join(t.dir, 'staging.json'), 'utf8')), {})
    assert.throws(() => t.run('triage-commit', t.put('bad.json', JSON.stringify({ 1: { verdict: 'maybe' } }))), /keep \| to_confirm \| ignore/)
  } finally { t.done() }
})

test('watch: add, list, set and remove watched accounts without any direct database write', () => {
  const t = setup()
  try {
    const out = t.run('watch', 'add', '@New_Lab', '--role', 'brand', '--priority', 'breaking', '--interval', '30', '--hours', '7-24', '--lang', 'en', '--name', 'New Lab')
    assert.match(out, /watched account added: #\d+ @New_Lab \(x, en\) · role brand · watch_role source · priority breaking · every 30 min · hours 07-24 · last polled never/)
    const row = t.db.prepare(`SELECT * FROM accounts WHERE handle = 'New_Lab'`).get()
    assert.deepEqual([row.network, row.relation, row.owner_user_id, row.competitor_id, row.last_polled_at, row.display_name], ['x', 'watched', null, null, null, 'New Lab'])
    assert.match(t.run('watch', 'list'), /#\d+ @New_Lab .*priority breaking/)
    assert.doesNotMatch(t.run('watch', 'list'), /ref_account/, 'a watched account without priority is not polled')
    assert.match(t.run('watch', 'list', '--all'), /@ref_account .*priority stopped/)

    // duplicates: managed (whatever the case), already watched (polled or not)
    assert.throws(() => t.run('watch', 'add', 'ACME_DEV', '--role', 'brand', '--priority', 'daily'), /already in the studio as a managed account/)
    assert.throws(() => t.run('watch', 'add', 'new_lab', '--role', 'brand', '--priority', 'daily'), /already watched: change it with watch set/)
    assert.throws(() => t.run('watch', 'add', 'ref_account', '--role', 'brand', '--priority', 'daily'), /already watched \(not polled\)/)

    // required and checked options
    assert.throws(() => t.run('watch', 'add', 'other', '--priority', 'daily'), (e) => e instanceof UsageError && /--role brand\|personal is required/.test(e.message))
    assert.throws(() => t.run('watch', 'add', 'other', '--role', 'brand', '--priority', 'hourly'), (e) => e instanceof UsageError && /--priority: breaking \| daily \| weekly/.test(e.message))
    assert.throws(() => t.run('watch', 'add', 'other', '--role', 'automated', '--priority', 'daily'), UsageError)
    assert.throws(() => t.run('watch', 'add', 'other', '--role', 'brand', '--priority', 'daily', '--hours', '7h-23h'), /--hours: HH-HH/)
    assert.throws(() => t.run('watch', 'add', 'other', '--role', 'brand', '--priority', 'daily', '--interval', '0'), /positive integer/)
    assert.throws(() => t.run('watch', 'add', 'bad handle!', '--role', 'brand', '--priority', 'daily'), /invalid handle/)
    assert.throws(() => t.run('watch', 'add', 'other', '--role', 'brand', '--priority', 'daily', '--network', 'myspace'), /unknown network/)
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE handle = 'other'`).get().n, 0)

    // an account that matches a competitor alias gets its competitor id, as in the triage
    assert.match(t.run('watch', 'add', 'RivalAppHQ', '--role', 'brand', '--priority', 'weekly', '--watch-role', 'reference'), /matches a competitor/)
    assert.deepEqual({ ...t.db.prepare(`SELECT competitor_id, watch_role FROM accounts WHERE handle = 'RivalAppHQ'`).get() }, { competitor_id: 1, watch_role: 'reference' })

    // set: same options, `none` clears; only a watched account
    assert.match(t.run('watch', 'set', 'new_lab', '--priority', 'daily', '--interval', 'none', '--hours', 'none'), /priority daily · every 1440 min \(default\) · hours all day/)
    assert.match(t.run('watch', 'set', 'ref_account', '--priority', 'weekly', '--role', 'personal'), /@ref_account .*role personal · watch_role reference · priority weekly/)
    assert.throws(() => t.run('watch', 'set', 'acme_dev', '--priority', 'daily'), /watched account not found/)
    assert.throws(() => t.run('watch', 'set', 'new_lab'), UsageError)

    // remove: the polling stops, the account and its items stay
    assert.match(t.run('watch', 'remove', 'ref_account'), /no longer polled; the account and its items are kept/)
    assert.equal(t.db.prepare(`SELECT watch_priority FROM accounts WHERE id = 9`).get().watch_priority, null)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM items WHERE author_id = 9').get().n, 1)
    assert.match(t.run('watch', 'remove', 'ref_account'), /not polled already/)
    assert.throws(() => t.run('watch', 'remove', 'acme_dev'), /watched account not found/)
  } finally { t.done() }
})
