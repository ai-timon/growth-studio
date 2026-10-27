// Volet 8: first launch. The Set up of a blank studio, by the screen (routes) and by the agent (setup skill + `setup …`
// commands of the CLI): agent (create or choose, check that it runs the tools), accounts, writing, connectors with the
// exact pluginPolicy lines, test draft left to validate.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply, testing } from '../lib/index.js'
import { SETUP_SKILL_ID, TOOLS_SKILL_ID, cliPath, nodeCommand, setupSkillContent } from '../lib/agent-channel.js'
import { STARTER, connectorGuide, nodeOk, policySnippet } from '../lib/setup.js'

const FORBIDDEN = /allowed_tools|scripts\/|AGENTS\.md|state\/|brain|CHANGELOG\.md|Claude|Codex/

/** A blank studio on a fresh plugin database; agents, backends, skills and missions are fakes. */
function blank(dir, { permissions = ['settings', 'storage', 'missions:spawn', 'skills:write', 'agents:manage', 'backends:read'], user = { id: 'u1', name: 'Ada', is_superadmin: true } } = {}) {
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const settings = { dataSource: 'plugin', legacyDbPath: path.join(dir, 'none', 'growth.db'), agent: '' }
  const kv = new Map(); const skills = {}; const spawned = []; const created = []
  const agents = [{ name: 'someone.else', backend: 'b1', model: 'm1', role: 'coder', mine: false }]
  const ctx = {
    permissions,
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: path.join(dir, 'plugins-data'), kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
    settings: { get: (k) => settings[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => user,
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
    skills: { put: async (id, content) => { skills[id] = content } },
    missions: { spawn: async (o) => { spawned.push(o); return `m${spawned.length}` } },
    agents: {
      list: async () => agents,
      create: async (input) => { created.push(input); if (agents.some((a) => a.name === input.name)) { const e = new Error('agent already exists'); e.code = 'conflict'; throw e } const a = { name: input.name, backend: input.backend || 'b1', model: input.model || null, role: input.role, mine: true }; agents.push(a); return a },
    },
    backends: { list: async () => ({ defaultBackend: 'b1', backends: [{ id: 'b1', label: 'Backend one', defaultModel: 'm1', models: [{ slug: 'm1' }, { slug: 'm2' }] }, { id: 'b2', label: 'Backend two', signedIn: false, models: [{ slug: 'x' }] }] }) },
    host: { exec: async () => ({ code: 1, stdout: '', stderr: 'not found' }) },
  }
  apply(ctx)
  const call = async (key, { body, params = {}, query = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query, url: '/' }, res)
    return { status, json }
  }
  const sql = (fn) => { const d = new DatabaseSync(path.join(ctx.storage.dir, 'growth.db')); try { return fn(d) } finally { d.close() } }
  return { ctx, call, settings, kv, skills, spawned, created, sql }
}
const tool = (owner, node, ...argv) => testing.handleTool({ argv, files: {}, owner, node })

test('a blank studio asks for the Set up; the agent step creates an agent from the backend catalogue, then checks it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-setup-'))
  try {
    const s = blank(dir)
    await new Promise((r) => setTimeout(r, 20))   // skills installed at startup
    assert.ok(s.skills[TOOLS_SKILL_ID] && s.skills[SETUP_SKILL_ID], 'both skills are installed')
    assert.equal((await s.call('GET /overview')).json.setupNeeded, true)
    let st = (await s.call('GET /setup')).json
    assert.equal(st.needed, true)
    assert.deepEqual(st.steps.map((x) => [x.key, x.required, x.done]), [['agent', true, false], ['accounts', true, false], ['writing', false, false], ['connectors', false, false], ['import', false, false], ['test', false, false]])
    assert.deepEqual(st.backends.map((b) => [b.id, b.models]), [['b1', ['m1', 'm2']], ['b2', ['x']]], 'providers come from the catalogue, never a fixed list')
    assert.equal(st.canCreateAgent, true)
    assert.equal(st.agent.check.state, 'none')

    // create: neutral prompt, role without worktree, the chosen provider and model
    const c = await s.call('POST /setup/agent', { body: { name: 'acme.writer', backend: 'b2', model: 'x' } })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    assert.deepEqual([s.created[0].role, s.created[0].backend, s.created[0].model], ['research', 'b2', 'x'])
    assert.doesNotMatch(s.created[0].systemPrompt, FORBIDDEN)
    assert.match((await s.call('POST /setup/agent', { body: { name: 'acme.writer' } })).json.error, /already has this name/)
    assert.equal((await s.call('POST /setup/agent', { body: { name: '../bad' } })).status, 400)

    // the browser sets the plugin setting; then the check mission runs the exact ping command of the tools
    s.settings.agent = 'acme.writer'
    const chk = await s.call('POST /setup/agent/check')
    assert.equal(chk.status, 200, JSON.stringify(chk.json))
    const brief = s.spawned.at(-1)
    assert.equal(brief.agent, 'acme.writer')
    assert.ok(brief.mission.includes(`"${cliPath()}" --spool `) && brief.mission.includes('--owner u1 ping'), brief.mission)
    st = (await s.call('GET /setup')).json
    assert.equal(st.agent.check.state, 'pending')
    assert.equal(st.agent.check.missionId, chk.json.mission_id)

    // the agent runs it: a user who owns nothing yet is accepted for ping
    const pong = await tool('u1', '22.13.1', 'ping')
    assert.equal(pong.code, 0, pong.err)
    assert.match(pong.out, /Node 22\.13\.1/)
    st = (await s.call('GET /setup')).json
    assert.equal(st.agent.check.state, 'ok')
    assert.equal(st.agent.check.node, '22.13.1')
    assert.equal(st.steps[0].done, true)

    // another Node command for the agent: the check is to be done again, and the skills are rewritten with it
    s.settings.agentNode = '/opt/node22/bin/node'
    st = (await s.call('GET /setup')).json
    assert.equal(st.agent.check.state, 'none')
    assert.equal(st.agent.check.nodeCommand, '"/opt/node22/bin/node"')
    await s.call('POST /setup/agent/check')
    assert.ok(s.spawned.at(-1).mission.includes('"/opt/node22/bin/node" "'), 'the check runs the tools with the new command')
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(s.skills[TOOLS_SKILL_ID].includes('"/opt/node22/bin/node" "'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without agents:manage the agent step explains how to create one in Timon', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-setup-'))
  try {
    const s = blank(dir, { permissions: ['settings', 'storage', 'missions:spawn', 'skills:write'] })
    const st = (await s.call('GET /setup')).json
    assert.equal(st.canCreateAgent, false)
    assert.equal(st.agents, null)
    const r = await s.call('POST /setup/agent', { body: { name: 'acme.writer' } })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Agents page of Timon/)
    assert.equal(s.created.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('screen path: accounts, generic writing defaults (never over the user\'s text), connectors lines, test draft', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-setup-'))
  try {
    const s = blank(dir)
    s.settings.agent = 'acme.writer'
    s.settings.getxapiKeySecret = 'MY_GETXAPI'
    s.settings.chromeBinary = 'chromium'
    const org = (await s.call('POST /orgs', { body: { name: 'Acme' } })).json.id
    const acc = (await s.call('POST /accounts', { body: { organization_id: org, network: 'x', handle: 'acme', lang: 'fr', role: 'brand' } })).json.id
    let st = (await s.call('GET /setup')).json
    assert.equal(st.needed, false)
    assert.equal(st.steps[1].done, true)
    assert.equal(st.writing.account.handle, 'acme')

    // the user wrote the voice already: the defaults fill the rest only
    await s.call('POST /scope/:scope/:id/settings', { params: { scope: 'account', id: String(acc) }, body: { changes: {}, voice: 'My own voice.' } })
    const w = await s.call('POST /setup/starter', { body: { account_id: acc } })
    assert.deepEqual(w.json.written, ['rules', 'post_types', 'original_suggest_prompt', 'original_write_prompt', 'triage_prompt'])
    const view = (await s.call('GET /scope/:scope/:id/settings', { params: { scope: 'account', id: String(acc) } })).json
    assert.equal(view.own.voice, 'My own voice.')
    assert.equal(view.own.triage_prompt, STARTER.triage_prompt)
    st = (await s.call('GET /setup')).json
    assert.ok(Object.values(st.writing.filled).every(Boolean))
    for (const v of Object.values(STARTER)) assert.doesNotMatch(v, FORBIDDEN)

    // connectors: state + the exact lines the user adds; the plugin writes no config and shows no secret value
    const getx = st.connectors.find((c) => c.id === 'getxapi')
    assert.deepEqual(getx.guide.http, ['api.getxapi.com'])
    assert.equal(getx.guide.secrets[0].name, 'MY_GETXAPI')
    assert.equal(getx.guide.secrets[0].set, 'printf %s "<value>" | timon secret set MY_GETXAPI --scope agent:plugin:growth-studio --stdin')
    assert.deepEqual(st.connectors.find((c) => c.id === 'chrome').guide.exec, ['chromium'])
    assert.deepEqual(JSON.parse(st.policy).pluginPolicy, { spawn: { approved: ['growth-studio'] }, exec: { allow: ['treg', 'chromium'] }, http: { allow: ['api.getxapi.com'] } })

    // test draft: a mission on the agent, never a publication
    const t = await s.call('POST /setup/test', { body: { account_id: acc } })
    assert.equal(t.status, 200, JSON.stringify(t.json))
    const m = s.spawned.at(-1)
    assert.ok(m.mission.includes(`post draft --account ${acc} --file <post.txt> --title "Set up test"`))
    assert.match(m.mission, /pending_validation/)
    assert.deepEqual(m.extraSkills, [TOOLS_SKILL_ID])
    // another user's account is not reachable
    s.ctx.user = () => ({ id: 'u2', is_superadmin: false })
    assert.equal((await s.call('POST /setup/test', { body: { account_id: acc } })).status, 404)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agent path: the setup skill and the `setup` commands give the same result, ending with a test draft to validate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-setup-'))
  try {
    const s = blank(dir)
    s.settings.agent = 'acme.writer'
    const conv = await s.call('POST /setup/converse', { body: { focus: 'writing' } })
    assert.equal(conv.status, 200, JSON.stringify(conv.json))
    assert.deepEqual(s.spawned.at(-1).extraSkills, [TOOLS_SKILL_ID, SETUP_SKILL_ID])
    assert.match(s.spawned.at(-1).mission, /Growth Studio user of this mission/)

    // a brand-new user (owns nothing) runs the setup commands
    let r = await tool('u7', '22.13.1', 'setup', 'status')
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /2\. Accounts: to do/)
    assert.match(r.out, /"approved": \[\s*"growth-studio"\s*\]/)
    r = await tool('u7', null, 'setup', 'org', '--name', 'Solo')
    assert.equal(r.code, 0, r.err)
    const org = Number(/#(\d+)/.exec(r.out)[1])
    r = await tool('u7', null, 'setup', 'account', '--org', String(org), '--network', 'x', '--handle', 'solo_dev', '--lang', 'en', '--role', 'personal')
    assert.equal(r.code, 0, r.err)
    r = await testing.handleTool({ argv: ['setup', 'set', 'solo_dev', 'voice', '--file', 'v.md'], files: { 'v.md': Buffer.from('Plain and short.').toString('base64') }, owner: 'u7' })
    assert.equal(r.code, 0, r.err)
    r = await tool('u7', null, 'setup', 'set', 'solo_dev', 'x_publish_target', '--file', 'v.md')
    assert.equal(r.code, 2, 'publishing settings are not the setup\'s')
    r = await tool('u7', null, 'setup', 'starter', 'solo_dev')
    assert.match(r.out, /rules, post_types/)
    assert.doesNotMatch(r.out, /voice/)
    r = await testing.handleTool({ argv: ['post', 'draft', '--account', 'solo_dev', '--file', 'p.txt', '--title', 'Set up test'], files: { 'p.txt': Buffer.from('Set up done.').toString('base64') }, owner: 'u7' })
    assert.equal(r.code, 0, r.err)
    r = await tool('u7', null, 'setup', 'status')
    assert.match(r.out, /6\. Test draft: done \(last post #\d+, pending_validation\)/)
    // the other user sees nothing of it
    assert.match((await tool('u1', null, 'setup', 'status')).out, /no organization yet/)
    assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE status <> 'pending_validation'`).get().n), 0, 'nothing validated or published')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('setup skill, Node version, connector guides', () => {
  const text = setupSkillContent({ node: nodeCommand('/usr/bin/node', false), spool: '/tmp/growth-studio-spool-abc' })
  assert.doesNotMatch(text.split(cliPath()).join('<cli>'), FORBIDDEN)
  for (const c of ['ping', 'setup status', 'setup org', 'setup account', 'setup starter', 'setup set', 'post draft']) assert.ok(text.includes(` ${c}`), c)
  assert.match(text, /never edit timon\.config\.json/)
  assert.equal(nodeCommand('/x', true, 'node'), 'node')
  assert.equal(nodeCommand('/x', true, 'C:\\Program Files\\nodejs\\node.exe'), '"C:\\\\Program Files\\\\nodejs\\\\node.exe"')
  assert.deepEqual(['22.5.0', 'v22.13.1', '24.0.0', '22.4.9', '20.18.0', ''].map(nodeOk), [true, true, true, false, false, false])
  const settings = { tregMode: 'http', tregBaseUrl: 'https://api.treg.example', tregTokenSecret: 'TREG_KEY' }
  const g = connectorGuide({ id: 'treg' }, { settings: (k) => settings[k] })
  assert.deepEqual([g.exec, g.http, g.secrets.map((x) => x.name)], [[], ['api.treg.example'], ['TREG_KEY']])
  assert.deepEqual(JSON.parse(policySnippet([connectorGuide({ id: 'gpt-image' })])), { pluginPolicy: { spawn: { approved: ['growth-studio'] } } })
})
