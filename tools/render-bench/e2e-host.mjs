// End-to-end check of the Set up with a REAL agent: a host half of the studio on a fresh database (in <dir>), with its
// spool folder served (the effects run), for <seconds> at most or until <dir>/stop exists. It writes <dir>/commands.json
// (the exact tool commands for the user `e2e`, as the skills give them) and, at the end, <dir>/report.json (state of
// the Set up, posts). The missions are started separately (any agent, any backend) with those commands.
//   node tools/render-bench/e2e-host.mjs <dir> [seconds]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const { apply, testing } = await import('../../lib/index.js')
const { setupSkillContent, skillContent, toolCommand, nodeCommand } = await import('../../lib/agent-channel.js')
const { spoolDir } = await import('../../lib/spool.js')
const dir = path.resolve(process.argv[2]); const seconds = Number(process.argv[3] || 600)
mkdirSync(dir, { recursive: true })
const routes = {}; const kv = new Map(); const stops = []; const owner = 'e2e'
const settings = { dataSource: 'plugin', agent: process.env.E2E_AGENT || 'e2e.agent' }
const ctx = {
  permissions: ['settings', 'storage', 'skills:write'],
  router: () => new Proxy({}, { get: (_, m) => (p, fn) => { if (m !== 'use') routes[`${m.toUpperCase()} ${p}`] = fn } }),
  storage: { dir: path.join(dir, 'plugins-data'), kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
  settings: { get: (k) => settings[k] }, log: { info: (m) => console.log(m), warn: (m) => console.log(m), error: (m) => console.log(m) },
  effect: (fn) => { const stop = fn(); if (typeof stop === 'function') stops.push(stop) },
  user: () => ({ id: owner, name: 'E2E', is_superadmin: true }), realtime: { publish() {} }, notify: { report() {}, alert() {} },
  skills: { put: async () => {} }, missions: { spawn: async () => 'not-used' },
}
apply(ctx)
const call = async (key, { body, params = {} } = {}) => {
  let status = 200, json
  const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
  await routes[key]({ body, params, query: {}, url: '/' }, res)
  return { status, json }
}
const spool = spoolDir(ctx.storage.dir)
const cmd = (c) => toolCommand({ node: nodeCommand(), spool, owner }, c)
writeFileSync(path.join(dir, 'commands.json'), JSON.stringify({ ping: cmd('ping'), status: cmd('setup status'), owner, spool,
  setupSkill: setupSkillContent({ spool }), toolsSkill: skillContent({ spool }) }, null, 2))
console.log(`serving ${spool} for ${seconds}s`)
const end = Date.now() + seconds * 1000
while (Date.now() < end && !existsSync(path.join(dir, 'stop'))) await new Promise((r) => setTimeout(r, 500))
const report = { setup: (await call('GET /setup')).json, posts: (await call('GET /posts')).json, check: kv.get('agentCheck') || null }
writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
for (const s of stops) s()
console.log('report written'); process.exit(0)
