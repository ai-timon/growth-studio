// The user's own image on a post (host routes POST /posts/:id/media and /media/remove): same storage as attach-media.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 1)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 2)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(80, 3)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(80, 4)])
const b64 = (b) => b.toString('base64')

function host(dir) {
  const storageDir = path.join(dir, 'data')
  mkdirSync(storageDir, { recursive: true })
  const db = new DatabaseSync(path.join(storageDir, 'growth.db'))
  db.exec(readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'))
  db.exec(readFileSync(path.join(root, 'db', 'demo-seed.sql'), 'utf8'))
  db.close()
  const routes = {}
  const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
  const ctx = {
    permissions: ['settings', 'storage'],
    router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
    storage: { dir: storageDir, kv: { get: async () => undefined, set: async () => {} } },
    settings: { get: (k) => ({ dataSource: 'plugin', legacyDbPath: path.join(dir, 'none.db') })[k] },
    log: { info() {}, warn() {}, error() {} },
    effect() {},
    user: () => ({ id: 'u1', is_superadmin: true }),
    realtime: { publish() {} },
    notify: { report() {}, alert() {} },
  }
  apply(ctx)
  const call = async (key, { body, params = {} } = {}) => {
    let status = 200, json
    const res = { status(s) { status = s; return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
    await routes[key]({ body, params, query: {}, url: '/' }, res)
    return { status, json }
  }
  const sql = (q, ...a) => { const d = new DatabaseSync(path.join(storageDir, 'growth.db')); try { return d.prepare(q).all(...a) } finally { d.close() } }
  const exec = (q) => { const d = new DatabaseSync(path.join(storageDir, 'growth.db')); try { d.exec(q) } finally { d.close() } }
  return { call, sql, exec, media: path.join(storageDir, 'media') }
}

test('upload: stores the image like attach-media, by real type, with alt; add up to 4; replace; remove', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-upload-'))
  try {
    const h = host(dir)
    const P = { params: { id: '1' } }
    let r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(PNG), alt: 'A terminal' } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.ok(existsSync(path.join(h.media, '1.png')))
    assert.deepEqual(JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media), [{ type: 'image', path: 'media/1.png', alt: 'A terminal' }])
    assert.equal(r.json.post.has_media, true)
    assert.ok(r.json.post.media_mtime)

    for (const [b, ext] of [[JPG, 'jpg'], [WEBP, 'webp'], [GIF, 'gif']]) {
      r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(b), mode: 'add' } })
      assert.equal(r.status, 200, JSON.stringify(r.json))
      assert.ok(JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media).some((m) => m.path.endsWith(`.${ext}`)))
    }
    assert.equal(JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media).length, 4)
    r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(PNG), mode: 'add' } })
    assert.equal(r.status, 400); assert.match(r.json.error, /already has 4 images/)

    r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(JPG) } })   // replace the first image
    assert.equal(JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media).length, 4)
    assert.match(JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media)[0].path, /1\.jpg$/)

    r = await h.call('POST /posts/:id/media/remove', { ...P, body: { index: 3 } })
    assert.equal(r.json.post.media.length, 3)
    assert.equal((await h.call('POST /posts/:id/media/remove', { ...P, body: { index: 9 } })).status, 404)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('upload: adding after a removal takes a free name and never overwrites a live file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-upload-'))
  try {
    const h = host(dir)
    const P = { params: { id: '1' } }
    await h.call('POST /posts/:id/media', { ...P, body: { data: b64(PNG) } })
    await h.call('POST /posts/:id/media', { ...P, body: { data: b64(JPG), mode: 'add' } })
    await h.call('POST /posts/:id/media/remove', { ...P, body: { index: 0 } })
    const r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(WEBP), mode: 'add' } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const media = JSON.parse(h.sql('SELECT media FROM posts WHERE id = 1')[0].media)
    assert.equal(media.length, 2)
    assert.notEqual(media[0].path, media[1].path)
    assert.deepEqual(media.map((m) => m.path).sort(), ['media/1-2.jpg', 'media/1.webp'])
    const base = path.dirname(h.media)
    assert.deepEqual(readFileSync(path.join(base, 'media/1-2.jpg')), JPG)
    assert.deepEqual(readFileSync(path.join(base, 'media/1.webp')), WEBP)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('upload: refuses wrong files, too large, a published post; checks the post exists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-upload-'))
  try {
    const h = host(dir)
    const P = { params: { id: '1' } }
    const bad = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(Buffer.from('<svg>'.padEnd(100, 'x'))) } })
    assert.equal(bad.status, 400); assert.match(bad.json.error, /unsupported image/)
    const big = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) } })
    assert.equal(big.status, 400); assert.match(big.json.error, /too large/)
    assert.equal((await h.call('POST /posts/:id/media', { ...P, body: {} })).status, 400)
    assert.equal((await h.call('POST /posts/:id/media', { params: { id: '2' }, body: { data: b64(PNG) } })).status, 400, 'published post')
    assert.equal((await h.call('POST /posts/:id/media', { params: { id: '999' }, body: { data: b64(PNG) } })).status, 404)
    assert.equal(h.sql('SELECT media FROM posts WHERE id = 1')[0].media, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('upload: a validated post without a visual is scheduled; removing its only image unschedules it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-upload-'))
  try {
    const h = host(dir)
    const P = { params: { id: '1' } }
    assert.equal((await h.call('POST /posts/:id/approve', { ...P, body: {} })).json.post.status, 'approved')
    const r = await h.call('POST /posts/:id/media', { ...P, body: { data: b64(PNG) } })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.ok(r.json.scheduled)
    assert.equal(r.json.post.status, 'scheduled')
    const back = await h.call('POST /posts/:id/media/remove', { ...P, body: { index: 0 } })
    assert.equal(back.json.post.status, 'approved')
    assert.equal(back.json.post.scheduled_for, null)
    assert.equal(h.sql('SELECT no_media FROM posts WHERE id = 1')[0].no_media, 0, 'no_media is never set here')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
