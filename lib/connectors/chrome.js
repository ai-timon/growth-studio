// Headless Chrome connector: renders the HTML page the agent wrote for a "chart or diagram" visual into a
// 1200×675 PNG, on the host. The binary is the `chromeBinary` setting (a name or an absolute path); empty = the first
// common name the operator allowed. When the plugin cannot run a browser, the mission renders the page itself.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectorError } from './common.js'

export const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'msedge']
export const RENDER_SIZE = { width: 1200, height: 675 }

export const descriptor = {
  id: 'chrome',
  label: 'Headless Chrome',
  kind: 'exec',
  features: ['render-html'],
  hosts: [],
  policy: { exec: ['google-chrome (or chromium, or the absolute path set in chromeBinary)'] },
  settings: ['chromeBinary'],
  costs: [{ what: 'one HTML → PNG rendering', usd: 0 }],
}

// No network from the rendered page: what the agent wrote is rendered as it is, self-contained.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`
export function sealHtml(html) {
  const s = String(html || '')
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => `${m}${CSP}`)
  return `<!doctype html><html><head>${CSP}</head><body>${s}</body></html>`
}

export function createChrome(ctx, probe) {
  const configured = () => String(ctx.settings.get('chromeBinary') || '').trim()
  async function find() {
    const names = configured() ? [configured()] : CHROME_CANDIDATES
    const tried = []
    for (const bin of names) {
      const p = await probe(bin)
      if (p.ok) return { bin, tried }
      tried.push({ bin, ...p })
    }
    return { bin: null, tried }
  }
  return {
    ...descriptor,
    async check() {
      const { bin, tried } = await find()
      if (bin) return { ok: true, missing: [], hint: `renders with ${bin}`, bin }
      const policy = tried.every((t) => t.reason === 'policy')
      return {
        ok: false,
        missing: tried.map((t) => `${t.reason}:${t.bin}`),
        hint: policy
          ? `no browser allowed for the plugin: add google-chrome (or chromium, or its absolute path) to pluginPolicy.exec.allow, or set chromeBinary${configured() ? '' : ' to the one you allowed'}; until then the agent renders the page itself`
          : `no headless browser found (${tried.map((t) => t.bin).join(', ')}): install Chrome or Chromium, or set chromeBinary; until then the agent renders the page itself`,
      }
    },
    /** Renders `html` to a PNG buffer. Throws ConnectorError. Works in a private folder of the plugin storage. */
    async render(html, { workDir }) {
      const { bin } = await find()
      if (!bin) throw new ConnectorError('no headless browser available to the plugin', { connector: 'chrome' })
      const dir = path.join(workDir, `render-${randomUUID()}`)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        const page = path.join(dir, 'page.html')
        const out = path.join(dir, 'out.png')
        writeFileSync(page, sealHtml(html))
        const r = await ctx.host.exec(bin, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
          '--disable-extensions', '--disable-background-networking', `--user-data-dir=${path.join(dir, 'profile')}`,
          `--window-size=${RENDER_SIZE.width},${RENDER_SIZE.height}`, `--screenshot=${out}`, pathToFileURL(page).href,
        ])
        if (!existsSync(out)) throw new ConnectorError(`the browser produced no image (${String(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200)})`, { connector: 'chrome' })
        return readFileSync(out)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
