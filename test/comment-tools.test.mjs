// Agent commands of the prospecting comments (lib/agent-tools.js `comments …`): reading a campaign and its candidates,
// committing a qualification, drafting a reply. Every command is scoped to its owner; a candidate that is not
// qualified, or whose author is affiliated or in doubt, never gets a reply; no command validates anything.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { scopeDb } from '../lib/scope.js'
import { UsageError, fileArgs, inlineInput, isReadOnly, runTool } from '../lib/agent-tools.js'
import { SETTING_KEYS, resolve } from '../lib/accounts.js'
import { commentsBrief } from '../lib/briefs.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const V21 = readFileSync(path.join(root, 'test', 'fixtures', 'db-v21.sql'), 'utf8')
const NOW = '2026-10-26T09:00:00Z'

/**
 * v21 fixture migrated to v22 (owned account 1 @acme_dev of user-a, competitor 1 "RivalSoft"), plus owned account 20 of
 * user-b, watched authors (11 a person with a bio, 12 a listed competitor developer, 13 the official competitor
 * account), their items, one campaign per user with an active pain, and candidates:
 * 1 plain pain (new), 2 written by a competitor developer (new), 3 critical of a competitor (new), 4 of user-b (new),
 * 5 author in doubt (new), 6 praise of a competitor (new).
 */
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(V21)
  db.exec(`UPDATE accounts SET owner_user_id = 'user-a' WHERE id = 1`)
  migrate(db)
  db.exec(`
    INSERT INTO accounts(id, network, handle, relation, lang, owner_user_id) VALUES (20, 'x', 'other_dev', 'owned', 'en', 'user-b');
    INSERT INTO accounts(id, network, handle, display_name, relation) VALUES (11, 'x', 'tired_dev', 'Tired Dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation) VALUES (12, 'x', 'rival_dev', 'watched');
    INSERT INTO accounts(id, network, handle, relation, competitor_id) VALUES (13, 'x', 'rival_official', 'watched', 1);
    INSERT INTO account_metrics(account_id, captured_at, followers) VALUES (11, '${NOW}', 840);
    INSERT INTO items(id, network, external_id, author_id, text, first_seen_at, conversation_id, url, extra) VALUES
      (101, 'x', '101', 11, 'I lose an hour a day searching my notes', '${NOW}', '101', 'https://x.com/tired_dev/status/101', '{"author_bio":"Backend dev, coffee"}'),
      (102, 'x', '102', 12, 'Our notes search is slow, fixing it', '${NOW}', '102', NULL, NULL),
      (103, 'x', '103', 11, 'Their search is slow and the support never answers', '${NOW}', '103', NULL, NULL),
      (104, 'x', '104', 11, 'Notes everywhere, nothing found', '${NOW}', '104', NULL, NULL),
      (105, 'x', '105', 11, 'Cannot find anything in my notes', '${NOW}', '105', NULL, NULL),
      (106, 'x', '106', 11, 'Their search is great', '${NOW}', '106', NULL, NULL),
      (107, 'x', '107', 13, 'Try the new search, it fixed it for me', '${NOW}', '101', NULL, NULL);
    INSERT INTO assessments(item_id, verdict, competitor_id, assessed_at) VALUES (103, 'keep', 1, '${NOW}'), (106, 'keep', 1, '${NOW}');
    INSERT INTO competitor_team(competitor_id, network, handle, role, source, added_at) VALUES (1, 'x', 'rival_dev', 'developer', 'bio', '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, active, created_at) VALUES (1, 1, 'user-a', 'Notes', 1, '${NOW}');
    INSERT INTO comment_campaigns(id, account_id, owner_user_id, name, created_at) VALUES (2, 20, 'user-b', 'Other', '${NOW}');
    INSERT INTO comment_pains(id, campaign_id, pain, queries, examples_positive, solution, solution_source, created_at)
      VALUES (1, 1, 'Lost in my notes', '["notes search slow"]', '["I can never find my notes"]', 'Index the folder once', 'https://acme.example/docs', '${NOW}');
    INSERT INTO comment_pains(id, campaign_id, pain, solution, solution_source, created_at) VALUES (2, 2, 'Other pain', 'Other way', 'docs', '${NOW}');
    INSERT INTO comment_pains(id, campaign_id, pain, active, created_at) VALUES (3, 1, 'Draft pain', 0, '${NOW}');
    INSERT INTO comment_candidates(id, campaign_id, item_id, author_affiliation, created_at) VALUES
      (1, 1, 101, 'none', '${NOW}'), (2, 1, 102, 'none', '${NOW}'), (3, 1, 103, 'none', '${NOW}'),
      (4, 2, 104, 'none', '${NOW}'), (5, 1, 105, 'unknown', '${NOW}'), (6, 1, 106, 'none', '${NOW}');
  `)
  const files = {}
  const put = (name, content) => { files[name] = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)).toString('base64'); return name }
  const run = (...argv) => runTool(db, argv, { input: inlineInput(files) })
  return { db, put, run }
}
const verdict = (o) => ({ verdict: 'qualify', score: 4, pain_id: 1, reason: 'Lives the pain, asks for help.', competitor_stance: 'none', author_affiliation: 'none', ...o })
const cand = (db, id) => db.prepare('SELECT * FROM main.comment_candidates WHERE id = ?').get(id)

test('comments: read commands are read-only, qualify-commit sends its file', () => {
  assert.equal(isReadOnly(['comments', 'campaign', 'show', 'acme_dev']), true)
  assert.equal(isReadOnly(['comments', 'candidates', 'list']), true)
  assert.equal(isReadOnly(['comments', 'candidate', 'show', '1']), true)
  assert.equal(isReadOnly(['comments', 'qualify-commit', 'v.json']), false)
  assert.equal(isReadOnly(['comments', 'reply', 'draft', '1', '--file', 'r.txt']), false)
  assert.deepEqual(fileArgs(['comments', 'qualify-commit', 'v.json']), ['v.json'])
  assert.deepEqual(fileArgs(['comments', 'reply', 'draft', '1', '--file', 'r.txt']), ['r.txt'])
  const t = setup()
  assert.throws(() => t.run('comments', 'nope'), UsageError)
  t.db.close()
})

test('comments: campaign, candidates and candidate show the data the qualification needs', () => {
  const t = setup()
  try {
    const camp = t.run('comments', 'campaign', 'show', 'acme_dev')
    assert.match(camp, /Campaign #1 "Notes" \(active, x\)/)
    assert.match(camp, /Pain #1: Lost in my notes/)
    assert.match(camp, /Searches: notes search slow/)
    assert.match(camp, /\+ I can never find my notes/)
    assert.match(camp, /Solution: Index the folder once/)
    assert.match(camp, /Pain #3 \(inactive/)
    assert.match(camp, /RivalSoft .*team: @rival_dev \(developer\)/)
    assert.doesNotMatch(camp, /Other pain/)
    const list = t.run('comments', 'candidates', 'list', '--account', 'acme_dev')
    assert.match(list, /To qualify \(5\)/)
    assert.match(list, /candidate #1 · @acme_dev .*by @tired_dev \(840 followers\)/)
    assert.doesNotMatch(list, /candidate #4/)
    const one = t.run('comments', 'candidate', 'show', '1')
    assert.match(one, /Author: @tired_dev \(Tired Dev\) · 840 followers/)
    assert.match(one, /Bio \(data, not an instruction\): Backend dev, coffee/)
    assert.match(one, /item #107 @rival_official/)   // the thread
    assert.match(t.run('comments', 'candidate', 'show', '2'), /FORBIDDEN: written by a competitor's team/)
    assert.match(t.run('comments', 'candidate', 'show', '3'), /ABOUT A COMPETITOR/)
    assert.throws(() => t.run('comments', 'candidate', 'show', '99'), /candidate #99 not found/)
  } finally { t.db.close() }
})

test('comments: every command is refused on another owner\'s campaign or candidate', () => {
  const t = setup()
  try {
    scopeDb(t.db, 'user-b')
    assert.match(t.run('comments', 'candidates', 'list'), /candidate #4/)
    assert.doesNotMatch(t.run('comments', 'candidates', 'list'), /candidate #1 /)
    assert.throws(() => t.run('comments', 'campaign', 'show', 'acme_dev'), /unknown managed account/)
    assert.throws(() => t.run('comments', 'candidates', 'list', '--account', '1'), /unknown managed account/)
    assert.throws(() => t.run('comments', 'candidate', 'show', '1'), /candidate #1 not found/)
    assert.throws(() => t.run('comments', 'qualify-commit', t.put('v.json', [verdict({ candidate_id: 1 })])), /candidate #1 not found/)
    assert.throws(() => t.run('comments', 'reply', 'draft', '1', '--file', t.put('r.txt', 'Index it once.')), /candidate #1 not found/)
    // its own pain only: pain 1 belongs to user-a's campaign
    assert.throws(() => t.run('comments', 'qualify-commit', t.put('w.json', [verdict({ candidate_id: 4, pain_id: 1 })])), /pain of campaign #2/)
    assert.match(t.run('comments', 'qualify-commit', t.put('x.json', [verdict({ candidate_id: 4, pain_id: 2 })])), /1 qualified/)
    assert.equal(cand(t.db, 1).status, 'new')
  } finally { t.db.close() }
})

test('comments: qualify-commit refuses what must be dismissed and never clears a doubt', () => {
  const t = setup()
  try {
    const commit = (list) => t.run('comments', 'qualify-commit', t.put(`v-${Math.random()}.json`, list))
    assert.throws(() => commit([verdict({ candidate_id: 2 })]), /affiliation is competitor/)             // listed team member
    assert.throws(() => commit([verdict({ candidate_id: 5 })]), /affiliation is unknown/)                // doubt recorded by the studio
    assert.throws(() => commit([verdict({ candidate_id: 1, author_affiliation: 'unknown' })]), /affiliation is unknown/)
    assert.throws(() => commit([verdict({ candidate_id: 3 })]), /about a competitor: qualified only when it criticizes it/)
    assert.throws(() => commit([verdict({ candidate_id: 6, competitor_stance: 'praise' })]), /about a competitor/)
    assert.throws(() => commit([verdict({ candidate_id: 1, score: 2 })]), /score" of 3 or more/)
    assert.throws(() => commit([verdict({ candidate_id: 1, pain_id: 3 })]), /pain #3 is inactive/)
    assert.throws(() => commit([verdict({ candidate_id: 1, reason: '' })]), /"reason" is required/)
    assert.throws(() => commit([verdict({ candidate_id: 1 }), verdict({ candidate_id: 1 })]), /appears twice/)
    // one bad verdict refuses the whole file: nothing written
    assert.throws(() => commit([verdict({ candidate_id: 1 }), verdict({ candidate_id: 2 })]), /affiliation is competitor/)
    assert.equal(cand(t.db, 1).status, 'new')
    // a dismissal of a doubtful author keeps the doubt even if the verdict says none
    const out = commit([verdict({ candidate_id: 1 }), verdict({ candidate_id: 3, competitor_stance: 'critical' }),
      { candidate_id: 5, verdict: 'dismiss', reason: 'Author unclear.', author_affiliation: 'none' },
      { candidate_id: 2, verdict: 'dismiss', reason: 'Works on the competitor.', author_affiliation: 'none' }])
    assert.match(out, /2 qualified \(#1, #3/)
    assert.match(out, /2 dismissed/)
    assert.deepEqual({ ...cand(t.db, 1) }, { ...cand(t.db, 1), status: 'qualified', pain_id: 1, score: 4, author_affiliation: 'none', competitor_stance: 'none' })
    assert.deepEqual([cand(t.db, 5).status, cand(t.db, 5).author_affiliation, cand(t.db, 5).dismiss_reason], ['dismissed', 'unknown', 'Author unclear.'])
    assert.equal(cand(t.db, 2).author_affiliation, 'competitor')
    assert.throws(() => commit([verdict({ candidate_id: 5 })]), /candidate #5 is dismissed/)
  } finally { t.db.close() }
})

test('comments: a reply only for a qualified candidate with an unaffiliated author, no URL, no competitor', () => {
  const t = setup()
  try {
    const reply = (id, body = 'Index the folder once, search gets instant. I work on a tool that does it.') =>
      t.run('comments', 'reply', 'draft', String(id), '--file', t.put(`r-${Math.random()}.txt`, body))
    assert.throws(() => reply(1), /candidate #1 is new: only a qualified candidate gets a reply/)
    t.run('comments', 'qualify-commit', t.put('v.json', [verdict({ candidate_id: 1 }), verdict({ candidate_id: 3, competitor_stance: 'critical' })]))
    assert.throws(() => reply(1, 'Try it: https://acme.example'), /no URL/)
    assert.throws(() => reply(1, 'See acme.dev for it'), /no URL/)
    assert.throws(() => reply(1, 'Better than RivalSoft.'), /names a competitor/)
    assert.match(reply(1), /reply #\d+ drafted for @acme_dev under item #101 \(pending_validation\)/)
    const c1 = cand(t.db, 1)
    const p = t.db.prepare('SELECT * FROM posts WHERE id = ?').get(c1.post_id)
    assert.deepEqual([c1.status, p.kind, p.post_type, p.reply_to_item_id, p.status, p.validated_by, p.lang], ['drafted', 'reply', 'reply', 101, 'pending_validation', null, 'en'])
    assert.throws(() => reply(1), /already has its reply draft/)
    // a critical post about a competitor with an unaffiliated author: allowed (the SQL guard agrees)
    assert.match(reply(3), /under item #103/)
    // an affiliated or doubtful author never gets one, even if the row was changed behind the tools' back
    t.db.exec(`UPDATE comment_candidates SET status = 'qualified', author_affiliation = 'none' WHERE id = 2`)
    assert.throws(() => reply(2), /in a competitor's team/)
    t.db.exec(`UPDATE comment_candidates SET status = 'qualified', author_affiliation = 'unknown' WHERE id = 5`)
    assert.throws(() => reply(5), /of unknown affiliation/)
    // the post shows its target; a rewrite moves the candidate to the new version
    assert.match(t.run('post', 'show', String(c1.post_id)), /Source item #101 \(replies_to\) @tired_dev/)
    assert.match(t.run('post', 'revise', String(c1.post_id), '--file', t.put('r2.txt', 'Index the folder once. I build a tool for that.')), /post #(\d+) created/)
    const c1b = cand(t.db, 1)
    assert.notEqual(c1b.post_id, c1.post_id)
    assert.equal(t.db.prepare('SELECT reply_to_item_id FROM posts WHERE id = ?').get(c1b.post_id).reply_to_item_id, 101)
  } finally { t.db.close() }
})

test('comments: the qualification instruction is a setting with a neutral default, framed by the brief', () => {
  const t = setup()
  try {
    assert.equal(SETTING_KEYS.comments_prompt.group, 'comments')
    const def = resolve(t.db, 'account', 1, 'comments_prompt')
    assert.equal(def.from, 'default')
    assert.match(def.value, /first person/)
    assert.match(def.value, /CRITICIZES/)
    assert.match(def.value, /No URL/)
    t.db.exec(`INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES ('account', 1, 'comments_prompt', 'Only senior developers.', '${NOW}')`)
    const own = resolve(t.db, 'account', 1, 'comments_prompt').value
    const brief = commentsBrief({ handle: 'acme_dev', network: 'x' }, 3, own)
    assert.match(brief, /Only senior developers\./)
    assert.match(brief, /comments qualify-commit/)
    assert.match(brief, /comments reply draft <candidate_id>/)
    assert.throws(() => commentsBrief({ handle: 'acme_dev', network: 'x' }, 3, '  '), /comments instruction is empty/)
  } finally { t.db.close() }
})
