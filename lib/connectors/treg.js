// treg connector: official X publishing (the account's treg tool, e.g. x.x.post.create, also for the replies) and the watch of public
// accounts (treg.x.user.posts, treg.x.search.posts), one post read by its URL for `item add` (anyapi.twitter.tweet).
// Two ways in, chosen by the `tregMode` setting:
//   cli  (default) — `ctx.host.exec('treg', …)` with the user's own `treg login` session. host.exec passes no vault
//                    secret, so a dedicated TREG_TOKEN cannot be injected this way.
//   http           — `ctx.fetch` on `<tregBaseUrl>/call/<tool>` with the `X-Treg-Token` header, the same request the
//                    CLI sends (read in its source); the key is a typed setting (`tregToken`) or a vault secret whose
//                    name is a setting (`tregTokenSecret`).
import { ConnectorError, canFetch, credential } from './common.js'

export const TREG_DEFAULT_URL = 'https://treg.to'

export const descriptor = {
  id: 'treg',
  label: 'treg',
  kind: 'exec',   // 'http' when tregMode = http
  features: ['publish', 'reply', 'watch', 'item add'],
  hosts: ['treg.to'],
  policy: { exec: ['treg'], http: ['treg.to'] },
  settings: ['tregMode', 'tregBaseUrl', 'tregToken', 'tregTokenSecret'],
  costs: [
    { what: 'watch: one page of ~20 posts of an account (treg.x.user.posts)', usd: 0.00045 },
    { what: 'watch: one search page of a bot account\'s original posts (treg.x.search.posts)', usd: 0.0006 },
    { what: 'item add: one X post read by its URL (anyapi.twitter.tweet)', usd: 0.00075 },
    { what: 'publish one post on X (x.x.post.create, official API)', usd: 0.015 },
    { what: 'send one validated prospecting reply on X (the publishing tool, in_reply_to)', usd: 0.015 },
    { what: 'publish one post whose text contains a URL (billed by X)', usd: 0.2 },
  ],
}

const modeOf = (ctx) => (String(ctx.settings.get('tregMode') || 'cli').trim().toLowerCase() === 'http' ? 'http' : 'cli')
const baseOf = (ctx) => String(ctx.settings.get('tregBaseUrl') || TREG_DEFAULT_URL).trim().replace(/\/+$/, '') || TREG_DEFAULT_URL
const isAuth = (s) => /\b401\b|unauthori[sz]ed|invalid token|not logged in|treg login/i.test(String(s || ''))
const costOf = (json, header) => {
  const micro = json && json._treg && Number(json._treg.charged_micro)
  if (Number.isFinite(micro) && micro > 0) return micro / 1e6
  const h = Number(header)
  return Number.isFinite(h) && h > 0 ? h / 1e6 : 0
}

export function createTreg(ctx, probe) {
  const tokenOf = () => credential(ctx, { valueKey: 'tregToken', nameKey: 'tregTokenSecret' })
  return {
    ...descriptor,
    mode: () => modeOf(ctx),
    async check() {
      const mode = modeOf(ctx)
      if (mode === 'cli') {
        const p = await probe('treg')
        return p.ok
          ? { ok: true, mode, missing: [], hint: 'uses the `treg login` session of the user who runs Timon' }
          : { ok: false, mode, missing: [p.reason === 'missing' ? 'binary:treg' : `policy:exec:treg`], hint: `treg: ${p.message}. Install the treg CLI and run \`treg login\`, or set tregMode to http.` }
      }
      if (!canFetch(ctx)) return { ok: false, mode, missing: ['permission:http:outbound'], hint: 'treg (http): the plugin was installed without http:outbound' }
      const t = await tokenOf()
      if (!t.value) return { ok: false, mode, missing: ['secret:tregToken'], hint: t.name ? `treg (http): the vault secret ${t.name} is not granted to the plugin (grant it to agent:plugin:growth-studio)` : 'treg (http): set the treg API key (setting tregToken) or the name of the vault secret holding it (tregTokenSecret)' }
      return { ok: true, mode, missing: [], hint: `calls ${baseOf(ctx)} (add its host to pluginPolicy.http.allow)` }
    },
    /**
     * Calls a treg tool. Returns { json, costUsd }. Throws ConnectorError (auth = true on a refused credential).
     * Never retries.
     */
    async call(tool, data, { maxCost = null, authMethod = null } = {}) {
      if (!/^[\w.-]+$/.test(String(tool || ''))) throw new ConnectorError(`invalid treg tool name: ${tool}`, { connector: 'treg' })
      if (modeOf(ctx) === 'http') {
        const t = await tokenOf()
        if (!t.value) throw new ConnectorError('treg (http): no API key configured', { connector: 'treg' })
        const headers = { 'content-type': 'application/json', 'x-treg-token': t.value, 'x-treg-client': 'growth-studio', 'x-treg-key-protocol': '1' }
        if (maxCost != null) headers['x-treg-route-max-cost'] = String(maxCost)
        if (authMethod) headers['x-treg-authorization-method'] = String(authMethod)
        const r = await ctx.fetch(`${baseOf(ctx)}/call/${tool}`, { method: 'POST', headers, body: JSON.stringify(data ?? {}) })
        const raw = await r.text()
        if (r.status === 401) throw new ConnectorError('treg refused the key (HTTP 401)', { auth: true, connector: 'treg' })
        if (!r.ok) throw new ConnectorError(`treg answered HTTP ${r.status}: ${raw.slice(0, 300)}`, { connector: 'treg' })
        let json
        try { json = JSON.parse(raw) } catch { throw new ConnectorError(`treg: unreadable answer: ${raw.slice(0, 200)}`, { connector: 'treg' }) }
        const header = r.headers && typeof r.headers.get === 'function' ? r.headers.get('x-treg-cost-micro') : null
        return { json, costUsd: costOf(json, header) }
      }
      const args = ['call', tool, '--method', 'POST', '--data', JSON.stringify(data ?? {})]
      if (maxCost != null) args.push('--header', `X-Treg-Route-Max-Cost: ${maxCost}`)
      if (authMethod) args.push('--authorization-method', String(authMethod))
      let r
      try { r = await ctx.host.exec('treg', args) } catch (e) { throw new ConnectorError(`treg cannot be run: ${e.message}`, { connector: 'treg' }) }
      if (r.code !== 0) {
        const msg = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 400)
        throw new ConnectorError(`treg failed: ${msg || `exit ${r.code}`}`, { auth: isAuth(msg), connector: 'treg' })
      }
      const out = String(r.stdout || '')
      const start = out.indexOf('{')
      let json
      try { json = JSON.parse(out.slice(start)) } catch { throw new ConnectorError(`treg: unreadable answer: ${out.slice(0, 200)}`, { connector: 'treg' }) }
      return { json, costUsd: costOf(json, null) }
    },
  }
}
