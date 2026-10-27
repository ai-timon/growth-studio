// Agent channel: the skill the plugin installs points at the shipped CLI and the spool folder; the CLI hands every
// command to the host through that folder (lib/spool.js), which runs it on the plugin database.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../lib/db.js'
import { TOOLS_SKILL_ID, TOOLS_SKILL_VERSION, cliPath, installToolsSkill, nodeCommand, skillContent } from '../lib/agent-channel.js'
import { UsageError, inlineInput, isReadOnly, runTool } from '../lib/agent-tools.js'
import { drain, ensureSpool, spoolDir } from '../lib/spool.js'
import { scopeDb } from '../lib/scope.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FORBIDDEN = /allowed_tools|scripts\/|AGENTS\.md|state\/|brain|CHANGELOG\.md|Claude|Codex/

function fixtureDb(dir) {
  const file = path.join(dir, 'growth.db')
  const db = new DatabaseSync(file)
  db.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
  migrate(db)
  db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
  db.exec(`UPDATE organizations SET owner_user_id = 'u1'; UPDATE accounts SET owner_user_id = 'u1' WHERE relation = 'owned'`)
  db.close()
  return file
}
const runCli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [cliPath(), ...args], { encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
})

test('the skill names the shipped CLI and the spool folder by absolute path, nothing project-specific', () => {
  const text = skillContent({ node: 'node', spool: '/tmp/growth-studio-spool-abc' })
  assert.ok(text.includes(`node "${cliPath()}" --spool "/tmp/growth-studio-spool-abc" --owner <owner> account-context`))
  assert.match(text, /replace `<owner>`/)
  for (const c of ['ideas add', 'post draft', 'post revise', 'attach-media', 'schedule-next', 'feedback propose', 'triage-commit', 'item show']) assert.ok(text.includes(c), c)
  assert.doesNotMatch(text.split(cliPath()).join('<cli>'), FORBIDDEN)
  assert.throws(() => skillContent({ spool: 'relative/spool' }), /absolute/)
  assert.equal(nodeCommand('/opt/app/timon', true), 'ELECTRON_RUN_AS_NODE=1 "/opt/app/timon"')
  assert.equal(nodeCommand('/usr/bin/node', false), '"/usr/bin/node"')
})

test('the skill is installed only when the manifest grants skills:write', async () => {
  const puts = []
  const ctx = (permissions) => ({ permissions, skills: { put: async (id, content) => { puts.push({ id, content }) } } })
  let touched = false
  assert.equal(await installToolsSkill(ctx(['storage']), () => { touched = true; return '/x/spool' }), null)
  assert.equal(touched, false)
  assert.equal(await installToolsSkill(ctx(['skills:write']), () => '/x/spool'), TOOLS_SKILL_ID)
  assert.equal(puts.length, 1)
  assert.match(puts[0].content, /--spool "\/x\/spool" --owner <owner> account-context/)
})

test('the skill carries a version and is reinstalled only when its version or content changed, or when it is missing', async () => {
  const puts = []
  const store = new Map()
  let present = true
  const ctx = (permissions = ['skills:write']) => ({
    permissions,
    storage: { kv: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v) } } },
    skills: { put: async (id, content) => { puts.push({ id, content }) }, get: async () => (present ? { id: TOOLS_SKILL_ID } : null) },
  })
  const seen = []
  const onInstall = (r) => seen.push(r.written)
  await installToolsSkill(ctx(), () => '/x/spool', { onInstall })
  assert.match(puts[0].content, new RegExp(`^---\\nname: ${TOOLS_SKILL_ID}\\nversion: ${TOOLS_SKILL_VERSION}\\n`))
  assert.equal(store.get('toolsSkillInstalled').version, TOOLS_SKILL_VERSION)
  await installToolsSkill(ctx(['skills:write', 'skills:read']), () => '/x/spool', { onInstall })   // same version and paths, skill readable: untouched
  assert.equal(puts.length, 1)
  await installToolsSkill(ctx(), () => '/x/spool', { onInstall })   // cannot check it is still there: rewritten
  assert.equal(puts.length, 2)
  store.set('toolsSkillInstalled', { ...store.get('toolsSkillInstalled'), version: TOOLS_SKILL_VERSION - 1 })
  await installToolsSkill(ctx(), () => '/x/spool', { onInstall })   // older version installed: rewritten
  assert.equal(puts.length, 3)
  await installToolsSkill(ctx(['skills:write', 'skills:read']), () => '/y/spool', { onInstall })   // paths of the installation changed: rewritten
  assert.equal(puts.length, 4)
  present = false
  await installToolsSkill(ctx(['skills:write', 'skills:read']), () => '/y/spool', { onInstall })   // deleted by hand: rewritten
  assert.equal(puts.length, 5)
  assert.deepEqual(seen, [true, false, true, true, true, true])
})

test('the spool folder is private to the user', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-spool-'))
  try {
    const s = ensureSpool(spoolDir('/some/storage', dir))
    assert.equal(spoolDir('/some/storage', dir), s)
    assert.notEqual(spoolDir('/other/storage', dir), s)
    if (process.platform !== 'win32') assert.equal(statSync(s).mode & 0o077, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the CLI goes through the spool: the host runs the command and answers with its exit code', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-channel-'))
  try {
    const dbFile = fixtureDb(dir)
    const spool = ensureSpool(path.join(dir, 'spool'))
    const paths = { base: dir, mediaDir: path.join(dir, 'media') }
    const owners = []
    const handle = async ({ argv, files, owner }) => {
      owners.push(owner)
      const db = new DatabaseSync(dbFile, { readOnly: isReadOnly(argv) })
      try { scopeDb(db, owner, { readOnly: isReadOnly(argv) }); return { code: 0, out: runTool(db, argv, { paths, input: inlineInput(files) }), err: '' } } catch (e) { return { code: e instanceof UsageError ? 2 : 1, out: '', err: e.message } } finally { db.close() }
    }
    const host = setInterval(() => { drain(spool, handle).catch(() => {}) }, 50)
    try {
      const ctxOut = await runCli(['--spool', spool, '--owner', 'u1', 'account-context', 'acme_dev'])
      assert.equal(ctxOut.code, 0, ctxOut.stderr)
      assert.match(ctxOut.stdout, /# Account @acme_dev \(x, account_id 1\)/)
      assert.match(ctxOut.stdout, /## Recent feedback/)
      // a write: the post text is read by the CLI and carried in the request
      const txt = path.join(dir, 'post.txt')
      writeFileSync(txt, 'A notes index in one command, and search is instant.')
      const draft = await runCli(['--spool', spool, '--owner', 'u1', 'post', 'draft', '--account', 'acme_dev', '--item', '1', '--file', txt])
      assert.equal(draft.code, 0, draft.stderr)
      assert.match(draft.stdout, /draft #3 created/)
      const refused = await runCli(['--spool', spool, '--owner', 'u1', 'account-context', 'nobody'])
      assert.equal(refused.code, 1)
      assert.match(refused.stderr, /unknown managed account/)
      assert.equal((await runCli(['--spool', spool, '--owner', 'u1', 'post', 'unknown'])).code, 2)
      // the user comes from the mission: without it nothing is sent to the host
      const anonymous = await runCli(['--spool', spool, 'accounts'])
      assert.equal(anonymous.code, 2)
      assert.match(anonymous.stderr, /--owner <user id> is required/)
      // another user's account does not exist for this user
      const other = await runCli(['--spool', spool, '--owner', 'u2', 'account-context', 'acme_dev'])
      assert.equal(other.code, 1)
      assert.match(other.stderr, /unknown managed account/)
      assert.ok(owners.length && owners.every((o) => o === 'u1' || o === 'u2'), 'every request carries its user')
    } finally { clearInterval(host) }
    const db = new DatabaseSync(dbFile)
    const p = db.prepare('SELECT status, validated_by, idea_id FROM posts WHERE id = 3').get()
    assert.equal(p.status, 'pending_validation')
    assert.equal(p.validated_by, null)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without the host, the CLI reports it instead of hanging', async () => {
  const r = await runCli(['--spool', path.join(tmpdir(), 'gs-no-such-spool'), '--owner', 'u1', 'accounts'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not reachable/)
})
