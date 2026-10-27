// Optional connectors of Growth Studio, behind one interface (README, "Optional connectors"):
//   { id, label, kind, features, hosts, policy: { exec?, http? }, settings, costs, check(), …capabilities }
// `check()` runs at use time, never at install, and never calls the network. A missing connector disables its own
// feature with a message; the rest of the studio keeps working.
import { createProber } from './common.js'
import { createTreg, descriptor as treg } from './treg.js'
import { createGetXapi, descriptor as getxapi } from './getxapi.js'
import { createGptImage, descriptor as gptImage } from './gpt-image.js'
import { createChrome, descriptor as chrome } from './chrome.js'

export { ConnectorError } from './common.js'
export const DESCRIPTORS = [treg, getxapi, gptImage, chrome]

/** The connectors bound to a plugin context. `overrides` replaces some of them (tests). */
export function createConnectors(ctx, overrides = {}) {
  const probe = createProber(ctx)
  const list = {
    treg: createTreg(ctx, probe),
    getxapi: createGetXapi(ctx),
    gptImage: createGptImage(ctx),
    chrome: createChrome(ctx, probe),
    ...overrides,
  }
  return {
    ...list,
    /** State of every connector, for the UI: never a secret value. */
    async status() {
      const out = []
      for (const c of Object.values(list)) {
        let state
        try { state = await c.check() } catch (e) { state = { ok: false, missing: [], hint: String(e && e.message || e) } }
        out.push({ id: c.id, label: c.label, kind: c.kind, features: c.features, hosts: c.hosts, policy: c.policy, costs: c.costs, ...state })
      }
      return out
    },
  }
}
