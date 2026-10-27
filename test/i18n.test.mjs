// Volet 6: the plugin is written in English; its interface goes through translation keys (createTranslator), English
// shipped inside client.js, French in lib/i18n/fr.json served by the host half.
import './helpers/private-tmp.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { SETTING_KEYS } from '../lib/accounts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')
const client = readFileSync(path.join(lib, 'client.js'), 'utf8')
const fr = JSON.parse(readFileSync(path.join(lib, 'i18n', 'fr.json'), 'utf8'))

/** The EN object at the end of client.js: one `"key": "value",` per line. */
function englishMessages() {
  const start = client.indexOf('const EN = {')
  assert.ok(start > 0, 'client.js declares the English messages')
  const body = client.slice(start + 'const EN = {'.length, client.indexOf('\n}', start))
  return JSON.parse(`{${body.trim().replace(/,$/, '')}}`)
}
const EN = englishMessages()
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',')

test('every literal key used by the interface exists in English and in French', () => {
  const used = new Set([...client.matchAll(/\btr\('([^']+)'/g)].map((x) => x[1]))
  // keys built at render time: `status.<key>`, `fb.<key>`… each family must exist entirely
  for (const s of ['pending_validation', 'approved', 'scheduled', 'published', 'rejected', 'failed', 'draft']) used.add(`status.${s}`)
  for (const k of ['fond', 'ton', 'longueur', 'fait', 'timing', 'visuel', 'autre']) used.add(`fb.${k}`)
  for (const k of ['bookmark', 'brand', 'watch']) for (const f of ['label', 'name', 'tag']) used.add(`feed.${k}.${f}`)
  for (const k of ['timon', 'outil', 'methode']) used.add(`solution.${k}`)
  for (const k of ['idea', 'approved', 'in_progress', 'done', 'dropped']) used.add(`idea.status.${k}`)
  for (const k of ['reject', 'rewrite', 'edit']) used.add(`fbsource.${k}`)
  for (const k of ['account', 'organization', 'global', 'default', 'merged', 'plugin']) used.add(`from.${k}`)
  for (const k of ['schedule', 'commonRules', 'goals', 'sources', 'types', 'original', 'global', 'learning', 'org', 'writing', 'rules', 'profile', 'publish', 'comments', 'agent']) used.add(`tab.${k}`)
  for (const k of ['pending', 'sent', 'dismissed']) for (const f of ['tab', 'empty']) used.add(`comments.${f}.${k}`)
  for (const k of ['critical', 'neutral', 'praise']) used.add(`comments.stance.${k}`)
  for (const k of ['rewrite', 'dismiss']) for (const f of ['Label', 'Placeholder']) used.add(`comments.${k}${f}`)
  for (const k of ['official', 'founder', 'employee', 'developer', 'contributor', 'other']) used.add(`team.role.${k}`)
  for (const k of ['competitor', 'unknown']) used.add(`competitors.affiliation.${k}`)
  for (const [, k] of client.matchAll(/'((?:engine|feed\.sort)\.[\w.]+)'/g)) used.add(k)
  assert.ok(used.size > 300, `only ${used.size} keys found: the extraction is broken`)
  const missingEn = [...used].filter((k) => !(k in EN))
  const missingFr = [...used].filter((k) => !(k in fr))
  assert.deepEqual(missingEn, [], 'keys missing in the English messages')
  assert.deepEqual(missingFr, [], 'keys missing in the French messages')
})

test('the French translation is complete, has no stray key and keeps the variables', () => {
  assert.deepEqual(Object.keys(EN).filter((k) => !(k in fr)), [], 'English keys without a French translation')
  // `setting.<key>` translates the English labels of accounts.js (SETTING_KEYS), which have no EN entry here
  const stray = Object.keys(fr).filter((k) => !(k in EN) && !(k.startsWith('setting.') && SETTING_KEYS[k.slice(8)]))
  assert.deepEqual(stray, [], 'French keys that nothing uses')
  assert.deepEqual(Object.keys(SETTING_KEYS).filter((k) => !fr[`setting.${k}`]), [], 'settings without a French label')
  for (const k of Object.keys(EN)) assert.equal(vars(fr[k]), vars(EN[k]), `variables of ${k}`)
  for (const v of Object.values(EN)) assert.doesNotMatch(v, /[éèàçêùôîâû]/, `French text in the English messages: ${v}`)
})

test('lib/ holds no French outside the French translation', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p] })
  const offenders = walk(lib).filter((f) => f !== path.join(lib, 'i18n', 'fr.json') && /[éèàçêùôîâû]/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map((f) => path.relative(lib, f)), [])
})

test('the manifest is in English and names no path', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const texts = [pkg.timon.label, pkg.timon.description, ...pkg.timon.settings.map((s) => s.label)]
  for (const t of texts) {
    assert.doesNotMatch(t, /[éèàçêùôîâû]/)
    assert.doesNotMatch(t, /\/home\/|\/Users\/|state\//)
  }
})

test('the host serves the French messages, and an empty set for an unknown locale', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gs-i18n-'))
  try {
    const routes = {}
    const add = (method) => (route, handler) => { routes[`${method} ${route}`] = handler }
    apply({
      permissions: ['settings', 'storage'],
      router: () => ({ use() {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH') }),
      storage: { dir: path.join(dir, 'plugins-data'), kv: { get: async () => undefined, set: async () => {} } },
      settings: { get: (k) => ({ dataSource: 'plugin', agent: '' })[k] },
      log: { info() {}, warn() {}, error() {} },
      effect() {},
      user: () => ({ id: 'u1', name: 'Ada' }),
      realtime: { publish() {} },
      notify: { report() {}, alert() {} },
      skills: { put: async () => {} },
      missions: { spawn: async () => 'm1' },
    })
    const call = async (locale) => {
      let json
      const res = { status() { return res }, json(j) { json = j; return res }, setHeader() {}, end() {} }
      await routes['GET /i18n/:locale']({ params: { locale }, query: {}, url: '/' }, res)
      return json
    }
    assert.equal((await call('fr'))['tab.settings'], 'Réglages')
    assert.deepEqual(await call('de'), {})
    assert.deepEqual(await call('../package'), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the package ships under the official Timon scope, with the stable plugin id', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@timon-ai/growth-studio')
  assert.equal(pkg.timon.id, 'growth-studio')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)
})
