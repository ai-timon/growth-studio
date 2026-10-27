// Screenshots of the shipped package (manifest `cover` and `screenshots`), taken on the fictional demo seed only: a real
// host half of the studio on a fresh database (temporary folder) loaded with db/demo-seed.sql plus a few fictional posts,
// its routes served over HTTP to the bench page (`index.html?live`), then captured with headless Chrome.
//   node tools/render-bench/demo-shots.mjs [out-dir]   (default: screenshots)
// Bounded: the server stops once the captures are taken (60 s at most).
process.env.TZ = 'UTC'   // the captures never show the time zone of the machine they are taken on
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const bench = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(bench, '..', '..')
const plugin = path.join(root, 'plugin', 'growth-studio')
const { apply } = await import(path.join(plugin, 'lib', 'index.js'))
const { migrate } = await import(path.join(plugin, 'lib', 'db.js'))
const out = path.resolve(process.argv[2] || path.join(plugin, 'screenshots'))
mkdirSync(out, { recursive: true })
for (const f of ['react.production.min.js', 'react-dom.production.min.js']) {
  if (!existsSync(path.join(bench, f))) { console.error(`tools/render-bench/${f} is missing (UMD build of React 18, local copy, not versioned)`); process.exit(1) }
}

const dir = mkdtempSync(path.join(tmpdir(), 'gs-demo-shots-'))
const storage = path.join(dir, 'plugins-data'); mkdirSync(storage, { recursive: true })
// fresh database: shipped schema + migrations, then the demo seed and a few more fictional posts for the calendar
const db = new DatabaseSync(path.join(storage, 'growth.db'))
migrate(db)
db.exec(readFileSync(path.join(plugin, 'db', 'demo-seed.sql'), 'utf8'))
const day = (offset, hour) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); d.setUTCHours(hour, 0, 0, 0); return d.toISOString() }
const extra = db.prepare(`INSERT INTO posts(account_id, kind, lang, body, status, created_at, validated_at, validated_by, scheduled_for, no_media, post_type)
  VALUES (1, 'post', 'en', ?, ?, ?, ?, ?, ?, 1, ?)`)
extra.run('Three commands I run before every release: tests, a dry-run pack, a grep for anything personal. Ten seconds, zero surprises.', 'scheduled', day(-1, 9), day(-1, 10), 'demo', day(0, 14), 'valeur')
extra.run('Shipped the calendar view today. Drag a post, it moves; leave it, it finds the next free slot.', 'scheduled', day(-1, 11), day(-1, 12), 'demo', day(1, 10), 'preuve')
extra.run('Small habit: one concrete detail per post. People remember the detail, not the adjective.', 'pending_validation', day(0, 8), null, null, null, 'reach')
extra.run('A notes folder you can search from the terminal is the best tool you will install this week.', 'pending_validation', day(0, 9), null, null, null, 'valeur')
db.exec("UPDATE accounts SET owner_user_id = 'demo' WHERE relation = 'owned'; UPDATE organizations SET owner_user_id = 'demo'")
db.close()

const handlers = []; const middlewares = []
const settings = { dataSource: 'plugin', agent: 'demo.writer' }
const kv = new Map()
const ctx = {
  permissions: ['settings', 'storage', 'missions:spawn', 'skills:write', 'agents:manage', 'backends:read'],
  router: () => new Proxy({}, { get: (_, m) => (p, fn) => { if (m === 'use') middlewares.push(p); else handlers.push({ method: m.toUpperCase(), re: new RegExp(`^${p.replace(/:([a-z]+)/gi, '(?<$1>[^/]+)')}$`), fn }) } }),
  storage: { dir: storage, kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v) }, del: async (k) => { kv.delete(k) } } },
  settings: { get: (k) => settings[k] }, log: { info() {}, warn() {}, error() {} }, effect() {},
  user: () => ({ id: 'demo', name: 'Demo', is_superadmin: true }), realtime: { publish() {} }, notify: { report() {}, alert() {} },
  skills: { put: async () => {} }, missions: { spawn: async () => 'demo-mission' },
  agents: { list: async () => [{ name: 'demo.writer', backend: 'b1', model: 'm1', mine: true }], create: async () => { throw new Error('not in the demo') } },
  backends: { list: async () => ({ defaultBackend: 'b1', backends: [{ id: 'b1', label: 'Backend one', models: [{ slug: 'm1' }], defaultModel: 'm1' }] }) },
  host: { exec: async () => ({ code: 1, stdout: '', stderr: 'not in the demo' }) },
  fetch: async () => { throw new Error('no network in the demo') }, secrets: { get: async () => undefined },
}
apply(ctx)
await kv.set('agentCheck', { ok: true, at: new Date().toISOString(), node: process.versions.node })

const PREFIX = '/api/ui/plugins/growth-studio/'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith(PREFIX)) {
    let body = ''
    for await (const c of req) body += c
    const r = { method: req.method, url: '/' + url.pathname.slice(PREFIX.length), query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : {}, params: {} }
    let status = 200
    const reply = { status(s) { status = s; return reply }, json(j) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); return reply }, setHeader(k, v) { res.setHeader(k, v) }, end(b) { res.statusCode = status; res.end(b) } }
    for (const m of middlewares) await new Promise((next) => m(r, reply, next))
    const p = r.url.split('?')[0]
    if (r.url.includes('?') && !Object.keys(r.query).length) r.query = Object.fromEntries(new URLSearchParams(r.url.split('?')[1]))
    for (const h of handlers) {
      const m = h.method === r.method && h.re.exec(p)
      if (m) { r.params = { ...(m.groups || {}) }; return h.fn(r, reply) }
    }
    res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"no route"}')
  }
  const f = path.join(root, decodeURIComponent(url.pathname))
  if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
const stop = setTimeout(() => { console.error('timeout'); process.exit(1) }, 60_000)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// asynchronous: the server answering the page runs in this same process
const shot = async (name, query, w = 1280, h = 800) => {
  const file = path.join(out, `${name}.png`)
  await promisify(execFile)('timeout', ['30', 'google-chrome', '--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`, '--virtual-time-budget=5000',
    `--screenshot=${file}`, `http://127.0.0.1:${port}/tools/render-bench/index.html?live&${query}`])
  console.log(path.relative(root, file))
}
try {
  await shot('posts', 'view=queue&theme=dark')
  await shot('post', 'view=post&id=1&theme=dark')
  await shot('calendar', 'view=calendar&theme=dark')
  await shot('feed', 'view=triage&theme=dark')
  await shot('settings', 'view=settings&scope=account&sid=1&tab=writing&theme=dark')
} finally {
  clearTimeout(stop); server.close(); rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
