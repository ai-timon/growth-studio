// Vérifie le passage de la query string par le segment `_q/…` avec le vrai Express de Timon (copie de base).
import { createRequire } from 'node:module'
const require = createRequire(process.env.TIMON_ORCHESTRATOR_PKG || new URL('../../../timon/orchestrator/package.json', import.meta.url).pathname)
const express = require('express')
const mod = await import('../../lib/index.js')
const root = new URL('./testroot', import.meta.url).pathname
const app = express(); app.use(express.json())
const router = express.Router()
mod.apply({ router: () => router, settings: { get: (k) => ({ dataSource: 'legacy', legacyDbPath: root + '/state/growth.db' })[k] }, storage: { dir: root + '/plugins-data', kv: { get: async () => null, set: async () => {} } },
  log: { warn() {}, error() {}, info() {} }, realtime: { publish() {} }, user: () => ({ id: process.env.BENCH_USER || 'bench', is_superadmin: true }), notify: {}, host: {}, effect() {} })
app.use('/api/plugins/growth-studio', router)
const srv = app.listen(0); const port = srv.address().port
const get = async (p) => (await fetch(`http://127.0.0.1:${port}/api/plugins/growth-studio/${p}`)).json()
const q = (s) => `_q/${encodeURIComponent(s)}/feed`
const all = await get(q('sources=bookmark,brand,watch&limit=24'))
const bm = await get(q('sources=bookmark&limit=24'))
const br = await get(q('sources=brand&limit=5'))
const p2 = await get(q(`sources=bookmark,brand,watch&limit=24&before=${all.next}`))
console.log({ all: all.items.length, bookmarkOnly: bm.items.every((x) => x.sources.includes('bookmark')), brandOnly: br.items.length === 5 && br.items.every((x) => x.sources.includes('brand')),
  page2: p2.items.length, overlap: p2.items.filter((x) => all.items.some((y) => y.id === x.id)).length, plain: (await get('overview')).counts ? 'overview ok' : 'overview KO' })
srv.close(); process.exit(0)
