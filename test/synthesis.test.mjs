// Weekly synthesis job: weekly slot in the publishing time zone, one mission per user with pending feedback,
// forced run, nothing started without feedback.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { lastSlot, pendingByOwner, pollSynthesis } from '../lib/jobs/synthesis.js'
import { synthesisBrief } from '../lib/briefs.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8')
const DEMO = readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8')
const at = (iso) => new Date(iso)

function demoDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA); migrate(db); db.exec(DEMO)
  db.exec(`UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned'`)
  db.exec(`INSERT OR REPLACE INTO settings(key, value) VALUES ('publish_tz', 'Europe/Paris')`)
  db.exec('UPDATE rule_proposals SET evidence = NULL; DELETE FROM learnings')   // only the feedback each test writes
  return db
}
const feedback = (db, rows) => {
  for (const r of rows) {
    db.prepare(`INSERT INTO learnings(created_at, text, source, ignored, synthesized_at, account_id, owner_user_id) VALUES ('2026-01-01T00:00:00Z', 'x', ?, ?, ?, ?, ?)`)
      .run(r.source || 'reject', r.ignored || 0, r.done || null, r.account ?? null, r.owner ?? null)
  }
}

test('lastSlot: Sunday 19:00 local time, this week once passed, else the week before', () => {
  // 2026-10-24 is a Saturday; Paris is UTC+2 until 2026-10-25 03:00
  assert.equal(lastSlot(at('2026-10-24T21:00:00Z'), 'Europe/Paris', 0, 19).toISOString(), '2026-10-18T17:00:00.000Z')
  // Sunday 2026-10-25 after the change to UTC+1: 19:00 local = 18:00 UTC
  assert.equal(lastSlot(at('2026-10-25T17:59:00Z'), 'Europe/Paris', 0, 19).toISOString(), '2026-10-18T17:00:00.000Z')
  assert.equal(lastSlot(at('2026-10-25T18:00:00Z'), 'Europe/Paris', 0, 19).toISOString(), '2026-10-25T18:00:00.000Z')
})

test('pendingByOwner: only feedback not synthesized, not ignored, from reject / rewrite / edit, per owner', () => {
  const db = demoDb()
  try {
    feedback(db, [{ account: 1 }, { source: 'edit', account: 1 }, { account: 1, ignored: 1 }, { account: 1, done: '2026-01-02T00:00:00Z' },
      { source: 'manual', account: 1 }, { owner: 'u2' }])
    assert.deepEqual(pendingByOwner(db).map((r) => ({ ...r })), [{ owner: 'u1', n: 2 }, { owner: 'u2', n: 1 }])
  } finally { db.close() }
})

test('pollSynthesis: first switch-on waits for the next slot, then one mission per user, once per week', async () => {
  const db = demoDb()
  try {
    feedback(db, [{ account: 1 }, { owner: 'u2' }])
    const spawned = []
    const spawnSynthesis = async (owner, n) => { spawned.push([owner, n]); return `m-${owner}` }
    // switched on on a Saturday: last Sunday's slot is long gone, nothing runs
    let r = await pollSynthesis({ db, spawnSynthesis, now: at('2026-10-24T21:00:00Z') })
    assert.equal(r.state, 'not-due'); assert.equal(spawned.length, 0)
    r = await pollSynthesis({ db, spawnSynthesis, now: at('2026-10-25T17:00:00Z') })
    assert.equal(r.state, 'not-due')
    r = await pollSynthesis({ db, spawnSynthesis, now: at('2026-10-25T18:01:00Z') })
    assert.equal(r.state, 'ok')
    assert.deepEqual(spawned, [['u1', 1], ['u2', 1]])
    r = await pollSynthesis({ db, spawnSynthesis, now: at('2026-10-25T19:00:00Z') })
    assert.equal(r.state, 'not-due', 'the same slot never runs twice')
    assert.equal(spawned.length, 2)
  } finally { db.close() }
})

test('pollSynthesis: forced run starts at once; without feedback no mission; a refused spawn is reported', async () => {
  const db = demoDb()
  try {
    const spawned = []
    let r = await pollSynthesis({ db, spawnSynthesis: async (o) => { spawned.push(o); return 'm' }, now: at('2026-10-24T21:00:00Z'), force: true })
    assert.equal(r.state, 'ok'); assert.match(r.message, /no feedback/); assert.equal(spawned.length, 0)
    feedback(db, [{ account: 1 }])
    r = await pollSynthesis({ db, spawnSynthesis: async () => { throw new Error('agent not set') }, now: at('2026-10-24T21:05:00Z'), force: true })
    assert.equal(r.state, 'error'); assert.match(r.message, /agent not set/)
  } finally { db.close() }
})

test('synthesisBrief: tools skill, no rule installed by the agent, non-interactive', () => {
  const b = synthesisBrief(3)
  assert.match(b, /3 feedback item/)
  assert.match(b, /feedback pending/)
  assert.match(b, /feedback propose/)
  assert.match(b, /Install NO rule yourself/)
  assert.match(b, /no publication/)
})
