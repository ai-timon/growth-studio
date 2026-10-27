// Shared pieces of the optional connectors (lib/connectors/*.js): probing a host binary, reading a credential.
// A connector that is missing disables its own feature with a clear message, never the studio.
// Nothing here calls the network: a check must never cost anything.

const PROBE_TTL_MS = 5 * 60_000

/** A connector-level failure. `auth` = the provider refused the credential (HTTP 401): stop, alert once, no retry. */
export class ConnectorError extends Error {
  constructor(message, { auth = false, connector = null } = {}) { super(message); this.auth = auth; this.connector = connector }
}

const hasPermission = (ctx, p) => !Array.isArray(ctx.permissions) || ctx.permissions.includes(p)
export const permitted = hasPermission

/**
 * Checks that a host binary can be run by the plugin: declared permission, operator allowlist, binary present.
 * `ctx.host.exec` resolves `{ code: 1 }` for a missing binary and rejects (PluginPolicyError) when the operator's
 * `pluginPolicy.exec.allow` does not list it: the two answers get two different messages. Cached a few minutes.
 * Returns { ok, reason: 'permission' | 'policy' | 'missing' | null, message, version }.
 */
export function createProber(ctx, { ttlMs = PROBE_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map()
  return async function probe(bin, args = ['--version']) {
    const hit = cache.get(bin)
    if (hit && now() - hit.at < ttlMs) return hit.result
    let result
    if (!hasPermission(ctx, 'host:exec') || !ctx.host || typeof ctx.host.exec !== 'function') {
      result = { ok: false, reason: 'permission', message: 'the plugin was installed without the host:exec permission' }
    } else {
      try {
        const r = await ctx.host.exec(bin, args)
        result = r && r.code === 0
          ? { ok: true, reason: null, message: '', version: String(r.stdout || '').trim().split('\n')[0].slice(0, 120) }
          : { ok: false, reason: 'missing', message: `\`${bin}\` was not found on this machine or does not start (${String((r && (r.stderr || r.stdout)) || '').trim().slice(0, 160) || `exit ${r && r.code}`})` }
      } catch (e) {
        result = { ok: false, reason: 'policy', message: `the operator has not allowed \`${bin}\`: add it to pluginPolicy.exec.allow in timon.config.json, then restart Timon (${String(e && e.message || e).slice(0, 200)})` }
      }
    }
    cache.set(bin, { at: now(), result })
    return result
  }
}

/**
 * A credential the user typed in the plugin settings (`type: "secret"`, sealed by Timon) wins over a vault secret
 * whose NAME is a setting. Returns { value, from: 'setting' | 'vault' | null, name }. Never logs the value.
 */
export async function credential(ctx, { valueKey = null, nameKey = null, name = null } = {}) {
  const typed = valueKey ? String(ctx.settings.get(valueKey) || '').trim() : ''
  if (typed) return { value: typed, from: 'setting', name: valueKey }
  const vaultName = String(name || (nameKey ? ctx.settings.get(nameKey) : '') || '').trim()
  if (!vaultName) return { value: null, from: null, name: '' }
  if (!hasPermission(ctx, 'secrets:read') || !ctx.secrets) return { value: null, from: null, name: vaultName }
  const value = await ctx.secrets.get(vaultName)
  return value ? { value: String(value), from: 'vault', name: vaultName } : { value: null, from: null, name: vaultName }
}

/** The plugin may reach the network at all (declared permission). The operator's host allowlist is checked by ctx.fetch. */
export const canFetch = (ctx) => hasPermission(ctx, 'http:outbound') && typeof ctx.fetch === 'function'
