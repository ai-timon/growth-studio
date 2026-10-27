// GetXAPI connector (https://api.getxapi.com): the owner's X bookmarks (read only), media upload before a post, and
// quotes. Never used to publish an ordinary post (that goes through treg).
// Two credentials: the GetXAPI key (typed setting `getxapiKey`, or a vault secret whose name is the setting
// `getxapiKeySecret`) and, per managed account, the x.com session cookie (vault secret named by the account's
// setting `getxapi_token_secret`).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ConnectorError, canFetch, credential } from './common.js'

export const GETXAPI_URL = 'https://api.getxapi.com'
export const GETXAPI_KEY_SECRET_DEFAULT = 'GETXAPI_KEY'

export const descriptor = {
  id: 'getxapi',
  label: 'GetXAPI',
  kind: 'http',
  features: ['bookmarks', 'media-upload', 'quote'],
  hosts: ['api.getxapi.com'],
  policy: { http: ['api.getxapi.com'] },
  settings: ['getxapiKey', 'getxapiKeySecret', 'account: getxapi_token_secret'],
  costs: [
    { what: 'one page of ~20 bookmarks', usd: 0.001 },
    { what: 'one media upload', usd: 0.001 },
    { what: 'one quote post', usd: 0.002 },
  ],
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4' }

export function createGetXapi(ctx) {
  const keyOf = () => credential(ctx, { valueKey: 'getxapiKey', name: String(ctx.settings.get('getxapiKeySecret') || '').trim() || GETXAPI_KEY_SECRET_DEFAULT })
  async function auth(tokenSecret) {
    if (!canFetch(ctx)) throw new ConnectorError('GetXAPI: the plugin was installed without http:outbound', { connector: 'getxapi' })
    if (!tokenSecret) throw new ConnectorError('no x.com cookie secret set for this account (Settings › account › Publishing)', { connector: 'getxapi' })
    const key = await keyOf()
    const token = await credential(ctx, { name: tokenSecret })
    if (!key.value || !token.value) {
      throw new ConnectorError(`secrets ${[!key.value && (key.from === 'setting' ? 'getxapiKey' : key.name), !token.value && tokenSecret].filter(Boolean).join(' / ')} not granted to the plugin (timon secret grant … --scope agent:plugin:growth-studio)`, { connector: 'getxapi' })
    }
    return { key: key.value, token: token.value }
  }
  async function post(route, body, key) {
    return ctx.fetch(`${GETXAPI_URL}${route}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  return {
    ...descriptor,
    /** Presence only: permission and credentials. No request is sent (every endpoint is paid). */
    async check({ tokenSecret = null } = {}) {
      if (!canFetch(ctx)) return { ok: false, missing: ['permission:http:outbound'], hint: 'GetXAPI: the plugin was installed without http:outbound' }
      const key = await keyOf()
      if (!key.value) return { ok: false, missing: ['secret:getxapiKey'], hint: `GetXAPI: the vault secret ${key.name} is not granted to the plugin; grant it, or type the key in the plugin settings (getxapiKey)` }
      if (tokenSecret) {
        const token = await credential(ctx, { name: tokenSecret })
        if (!token.value) return { ok: false, missing: [`secret:${tokenSecret}`], hint: `GetXAPI: the x.com cookie secret ${tokenSecret} is not granted to the plugin` }
      }
      return { ok: true, missing: [], hint: 'add api.getxapi.com to pluginPolicy.http.allow' }
    },
    /** One page of bookmarks of the account whose cookie is `tokenSecret`. Throws ConnectorError (auth on 401). */
    async bookmarks(tokenSecret, cursor = null) {
      const { key, token } = await auth(tokenSecret)
      const body = { auth_token: token }
      if (cursor) body.cursor = cursor
      const r = await post('/twitter/user/bookmarks', body, key)
      if (r.status === 401) throw new ConnectorError('GetXAPI refused the access (HTTP 401)', { auth: true, connector: 'getxapi' })
      if (!r.ok) throw new ConnectorError(`GetXAPI bookmarks: HTTP ${r.status}`, { connector: 'getxapi' })
      return r.json()
    },
    /** Uploads one media file, returns its (short-lived) media id. */
    async uploadMedia(filePath, tokenSecret) {
      const { key, token } = await auth(tokenSecret)
      const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      const r = await post('/twitter/media/upload', { auth_token: token, media_type: mime, media_data: readFileSync(filePath).toString('base64') }, key)
      if (r.status === 401) throw new ConnectorError('GetXAPI upload refused (HTTP 401): stopped, no new attempt', { auth: true, connector: 'getxapi' })
      if (!r.ok) throw new ConnectorError(`GetXAPI upload refused (HTTP ${r.status}): stopped, no new attempt`, { connector: 'getxapi' })
      const j = await r.json()
      const id = j && j.data && j.data.media_id
      if (!id) throw new ConnectorError('GetXAPI upload: media_id missing from the answer', { connector: 'getxapi' })
      return String(id)
    },
    /** Publishes a real quote of `quoteUrl`. Returns the new post id. */
    async createQuote({ text, quoteUrl, mediaIds = [], tokenSecret }) {
      const { key, token } = await auth(tokenSecret)
      const body = { auth_token: token, text, quote_tweet_url: quoteUrl }
      if (mediaIds.length) body.media_ids = mediaIds
      const r = await post('/twitter/tweet/create', body, key)
      const j = await r.json().catch(() => ({}))
      if (r.status !== 200 || j.status !== 'success') throw new ConnectorError(`GetXAPI quote refused (HTTP ${r.status}${j.msg ? `: ${String(j.msg).slice(0, 200)}` : ''}): stopped, no new attempt`, { auth: r.status === 401, connector: 'getxapi' })
      const tid = j.data && j.data.id
      if (!tid) throw new ConnectorError('GetXAPI quote: post id missing from the answer', { connector: 'getxapi' })
      return String(tid)
    },
  }
}
