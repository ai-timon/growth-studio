// Appelle la route /feed du plugin sur une COPIE de la base (testroot) et écrit la fixture du banc de rendu.
import { writeFileSync } from 'node:fs'
const mod = await import('../../lib/index.js')
const routes = {}
const router = new Proxy({}, { get: (_, m) => (p, fn) => { routes[`${m} ${p}`] = fn } })
const root = new URL('./testroot', import.meta.url).pathname
const ctx = { router: () => router, settings: { get: (k) => ({ dataSource: 'legacy', legacyDbPath: root + '/state/growth.db' })[k] }, storage: { dir: root + '/plugins-data', kv: { get: async () => null, set: async () => {} } },
  log: { warn() {}, error() {}, info() {} }, realtime: { publish() {} }, user: () => ({ id: process.env.BENCH_USER || 'bench', is_superadmin: true }), notify: {}, host: {}, onDispose() {}, lifecycle: { onStart() {}, onStop() {} }, effect() {} }
const stop = mod.apply(ctx)
const call = (q) => new Promise((ok) => routes['get /feed']({ query: q, params: {} }, { json: ok, status: () => ({ json: (e) => ok({ error: e }) }) }))
const a = await call({ sources: 'bookmark,brand,watch', limit: '24' })
console.log('page1', a.error || { n: a.items.length, counts: a.counts, next: a.next, first: a.items[0] && { id: a.items[0].id, sources: a.items[0].sources, posts: a.items[0].posts, asm: a.items[0].assessment } })
const b = await call({ sources: 'bookmark,brand,watch', limit: '24', before: a.next })
console.log('page2', b.error || { n: b.items.length, overlap: b.items.filter((x) => a.items.some((y) => y.id === x.id)).length })
const c = await call({ sources: 'bookmark', limit: '24' })
console.log('bookmarks', c.error || { n: c.items.length, allBookmark: c.items.every((x) => x.sources.includes('bookmark')) })
writeFileSync(new URL('./fx/feed_sources_bookmark_brand_watch_limit_24.json', import.meta.url), JSON.stringify(a))
writeFileSync(new URL('./fx/feed_sources_bookmark_limit_24.json', import.meta.url), JSON.stringify(c))
if (typeof stop === 'function') stop()
process.exit(0)
