// Set up screen of a BLANK studio, step by step: a real host half on a fresh database (temporary folder), the routes
// and the agent tools called as the screen and the agent would, each state exported as fixtures then captured
// (shot.sh). `node tools/render-bench/setup-shots.mjs [backends.json]` (catalogue of `timon backends`, optional).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const { apply, testing } = await import('../../lib/index.js')
const bench = path.dirname(new URL(import.meta.url).pathname)
const fx = path.join(bench, 'fx'); mkdirSync(fx, { recursive: true })
const dir = mkdtempSync(path.join(tmpdir(), 'gs-setup-bench-'))
const catalogue = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : { defaultBackend: 'b1', backends: [{ id: 'b1', label: 'Backend one', models: [{ slug: 'm1' }], defaultModel: 'm1' }] }
const routes = {}
const settings = { dataSource: 'plugin', agent: '' }
const kv = new Map(); const agents = []
const ctx = {
  permissions: ['settings', 'storage', 'missions:spawn', 'skills:write', 'agents:manage', 'backends:read', 'host:exec', 'http:outbound', 'secrets:read'],
  router: () => new Proxy({}, { get: (_, m) => (p, fn) => { if (m !== 'use') routes[`${m.toUpperCase()} ${p}`] = fn } }),
  storage: { dir: path.join(dir, 'plugins-data'), kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
  settings: { get: (k) => settings[k] }, log: { info() {}, warn() {}, error() {} }, effect() {},
  user: () => ({ id: 'u1', name: 'Bench', is_superadmin: true }), realtime: { publish() {} }, notify: { report() {}, alert() {} },
  skills: { put: async () => {} }, missions: { spawn: async () => 'bench-mission' },
  agents: { list: async () => agents, create: async (i) => { const a = { name: i.name, backend: i.backend, model: i.model, role: i.role, mine: true }; agents.push(a); return a } },
  backends: { list: async () => catalogue },
  host: { exec: async (bin) => (bin === 'google-chrome' ? { code: 0, stdout: 'Google Chrome 141' } : { code: 1, stdout: '', stderr: 'not found' }) },
  fetch: async () => { throw new Error('no network in the bench') }, secrets: { get: async () => undefined },
}
apply(ctx)
const call = async (key, { body, params = {} } = {}) => {
  let status = 200, json
  const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
  await routes[key]({ body, params, query: {}, url: '/' }, res)
  if (status >= 400) throw new Error(`${key}: ${JSON.stringify(json)}`)
  return json
}
const dump = async (accountId = null) => {
  for (const [route, name] of [['GET /overview', 'overview'], ['GET /status', 'status'], ['GET /setup', 'setup']]) writeFileSync(path.join(fx, `${name}.json`), JSON.stringify(await call(route)))
  if (accountId) writeFileSync(path.join(fx, `scope_account_${accountId}_settings.json`), JSON.stringify(await call('GET /scope/:scope/:id/settings', { params: { scope: 'account', id: String(accountId) } })))
}
const shot = (name, query, h = 1100) => console.log(execFileSync(path.join(bench, 'shot.sh'), [name, query, '1280', String(h)], { encoding: 'utf8' }).trim())
try {
  await dump(); shot('setup-1-agent', 'view=setup&step=agent', 1500); shot('setup-1-agent-fr', 'page&lang=fr', 1500)
  const a = await call('POST /setup/agent', { body: { name: 'growth-studio.writer', backend: catalogue.defaultBackend, model: (catalogue.backends.find((b) => b.id === catalogue.defaultBackend) || {}).defaultModel } })
  settings.agent = a.agent.name
  await call('POST /setup/agent/check')
  await testing.handleTool({ argv: ['ping'], files: {}, owner: 'u1', node: process.versions.node })
  await dump(); shot('setup-2-agent-checked', 'view=setup&step=agent', 1500); shot('setup-3-accounts', 'view=setup&step=accounts')
  const org = (await call('POST /orgs', { body: { name: 'Acme' } })).id
  const acc = (await call('POST /accounts', { body: { organization_id: org, network: 'x', handle: 'acme_dev', lang: 'en', role: 'personal' } })).id
  await call('POST /setup/starter', { body: { account_id: acc } })
  await dump(acc); shot('setup-4-writing', 'view=setup&step=writing', 1400); shot('setup-5-connectors', 'view=setup&step=connectors', 1700); shot('setup-6-import', 'view=setup&step=import')
  await call('POST /setup/test', { body: { account_id: acc } })
  // what the test mission's agent does with the tools skill
  const r = await testing.handleTool({ argv: ['post', 'draft', '--account', 'acme_dev', '--file', 'p.txt', '--title', 'Set up test'], files: { 'p.txt': Buffer.from('This account now drafts its posts with Growth Studio. Every post is validated before it goes out.').toString('base64') }, owner: 'u1' })
  if (r.code) throw new Error(r.err)
  await dump(acc); shot('setup-7-test', 'view=setup&step=test')
  writeFileSync(path.join(fx, 'posts.json'), JSON.stringify(await call('GET /posts')))
  shot('setup-8-studio', 'view=queue', 700)
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(0)
