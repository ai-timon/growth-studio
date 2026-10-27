// GPT Image connector (realistic visual). A plugin can never run the Codex CLI (`host:exec` refuses backend CLIs),
// so the image is made by a mission of the studio's agent with its own tools, which then attaches the PNG with the
// `attach-media` tool. This connector only tells whether the user has Codex at all: the engine is hidden when the
// backend catalogue clearly says no Codex backend is connected, and shown (with a note) when that cannot be known.
import { permitted } from './common.js'

export const descriptor = {
  id: 'gpt-image',
  label: 'GPT Image (Codex)',
  kind: 'agent',
  features: ['realistic-image'],
  hosts: [],
  policy: {},
  settings: [],
  costs: [{ what: 'one image, made by the agent with the user\'s own Codex subscription', usd: 0 }],
}

const isCodex = (b) => /codex/i.test(`${b && b.id} ${b && b.brand} ${b && b.label}`)

const CHECK_TTL_MS = 5 * 60_000

export function createGptImage(ctx, { now = () => Date.now() } = {}) {
  let cached = null
  return {
    ...descriptor,
    /** { ok: true | false | null, hint }: null = unknown (no backends:read, or the catalogue failed). Cached a few minutes. */
    async check() {
      if (cached && now() - cached.at < CHECK_TTL_MS) return cached.result
      const result = await this.probe()
      cached = { at: now(), result }
      return result
    },
    async probe() {
      if (!permitted(ctx, 'backends:read') || !ctx.backends || typeof ctx.backends.list !== 'function') {
        return { ok: null, missing: [], hint: 'cannot tell whether Codex is connected (the plugin has no backends:read permission): the agent must have Codex to make this image' }
      }
      try {
        const cat = await ctx.backends.list()
        const codex = ((cat && cat.backends) || []).filter(isCodex)
        if (!codex.length) return { ok: false, missing: ['backend:codex'], hint: 'Realistic images need Codex: no Codex backend is set up in Timon' }
        if (codex.every((b) => b.signedIn === false)) return { ok: false, missing: ['backend:codex:signed-out'], hint: 'Realistic images need Codex: the Codex backend is signed out' }
        return { ok: true, missing: [], hint: 'made by the agent with Codex' }
      } catch (e) {
        return { ok: null, missing: [], hint: `cannot tell whether Codex is connected (${String(e && e.message || e).slice(0, 120)})` }
      }
    },
  }
}
