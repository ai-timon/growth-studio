// Browser half of Growth Studio: an island tab (or the /growth page) with the posts queue, the sheet of a post
// (source, editable network preview, visual, actions), the calendar, the feed of watched content and the settings;
// plus a compact card in the cockpit. Inline styles (the product's CSS is not recompiled for a plugin), colors
// through the theme variables. Every text goes through `tr()` (translations below).
import React from 'react'
import { Button, Switch, createTranslator, getLocale, openInIsland, useIslandContent } from '@timon/ui'

const h = React.createElement
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/><path d="M7.5 14.5l2 2 4-4.5"/><path d="M15 16h2.5"/></svg>'
const V = {
  fg: 'hsl(var(--foreground))', mutedFg: 'hsl(var(--muted-foreground))', muted: 'hsl(var(--muted))', border: 'hsl(var(--border))',
  card: 'hsl(var(--card))', primary: 'hsl(var(--primary))', primaryFg: 'hsl(var(--primary-foreground))', accent: 'hsl(var(--accent))',
  bg: 'hsl(var(--background))', shadow: 'var(--shadow-1, 0 1px 2px rgba(0,0,0,.08))',
}
/** Color of a theme token (`--warning`…); `tint` gives a transparent version of it. */
const tok = (name) => `hsl(var(--${name}))`
const tint = (color, a) => (/^hsl\(var\(--[\w-]+\)\)$/.test(color) ? color.replace('))', `) / ${a})`) : color)
// Status of a post: color here, label translated at render time (`status.<key>`).
const STATUS = {
  pending_validation: { color: tok('warning') },
  approved: { color: tok('info') },
  scheduled: { color: tok('primary') },
  published: { color: tok('success') },
  rejected: { color: tok('muted-foreground') },
  failed: { color: tok('destructive') },
  draft: { color: tok('muted-foreground') },
}
const statusLabel = (s) => (STATUS[s] ? tr(`status.${s}`) : s)
const NETWORK = { x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit', youtube: 'YouTube', hn: 'Hacker News' }

// ---------- translations ----------
// English is the reference and ships in this file (EN, at the end); the other languages are lib/i18n/<locale>.json,
// served by the host half (the daemon only serves client.js to the browser) and loaded once, before the first render
// of each root (LocaleGate). A key missing in a language falls back to English, then to the key itself.
const MESSAGES = {}
const tr = createTranslator(MESSAGES)
const localeLoads = new Map()
/** Loads the messages of the current locale once (null when there is nothing to load). */
function loadLocale(ctx) {
  const lang = locale()
  if (!lang || lang === 'en' || MESSAGES[lang]) return null
  if (!localeLoads.has(lang)) {
    localeLoads.set(lang, ctx.api(`i18n/${encodeURIComponent(lang)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((msgs) => { if (msgs && typeof msgs === 'object' && !Array.isArray(msgs)) MESSAGES[lang] = msgs })
      .catch(() => { /* English stays */ }))
  }
  return localeLoads.get(lang)
}
/** Renders its children once the messages of the interface's language are there (no English flash). */
function LocaleGate({ ctx, children }) {
  const [ready, setReady] = React.useState(() => !loadLocale(ctx))
  React.useEffect(() => {
    const pending = loadLocale(ctx)
    if (!pending) { setReady(true); return undefined }
    let on = true
    pending.then(() => { if (on) setReady(true) })
    return () => { on = false }
  }, [])
  return ready ? children : null
}

// ---------- helpers ----------
// Locale of Timon's interface and time zone of the browser (fallback when the studio sends none): never hard-coded.
const locale = () => { try { return getLocale() || undefined } catch { return undefined } }
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
const n = (x) => (x == null ? '—' : Number(x).toLocaleString(locale()))
/** An amount in dollars, in the interface's number format (0.20 $ / 0,20 $). */
const usd = (x, digits = 2) => `${Number(x || 0).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 3) })} $`
const trunc = (s, k) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > k ? `${t.slice(0, k - 1)}…` : t }
function fmt(iso, tz, opts) {
  if (!iso) return '—'
  try { return new Intl.DateTimeFormat(locale(), { timeZone: tz || browserTz(), ...(opts || { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }).format(new Date(iso)) } catch { return iso }
}
const fmtTime = (iso, tz) => fmt(iso, tz, { hour: '2-digit', minute: '2-digit' })
const fmtDay = (iso, tz) => fmt(iso, tz, { weekday: 'long', day: 'numeric', month: 'long' })
function relative(iso) {
  if (!iso) return ''
  const d = (new Date(iso).getTime() - Date.now()) / 60000
  const abs = Math.abs(d)
  const value = abs < 60 ? tr('rel.minutes', { n: Math.round(abs) }) : abs < 48 * 60 ? tr('rel.hours', { n: Math.round(abs / 60) }) : tr('rel.days', { n: Math.round(abs / 1440) })
  return tr(d < 0 ? 'rel.past' : 'rel.future', { value })
}
/** Local parts (time zone of the project) of an instant, to place an event in the grid. */
function parts(iso, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(iso)).reduce((a, x) => ({ ...a, [x.type]: x.value }), {})
  return { key: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) }
}
/** UTC ISO instant of `minutes` after midnight on day `key` (YYYY-MM-DD) in a time zone (same rule as schedule.js). */
function zonedIso(key, minutes, tz) {
  const [y, m, d] = key.split('-').map(Number)
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60))
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(guess).reduce((a, x) => (x.type !== 'literal' ? { ...a, [x.type]: Number(x.value) } : a), {})
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess.getTime()
  return new Date(guess.getTime() - offset).toISOString()
}
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// `ctx.api()` targets /api/ui/plugins/<id>/…; images must follow the same authenticated
// route. The old /api/plugins/… route answered 401 inside an <img>.
const mediaUrl = (ctx, id, i = 0) => `/api/ui/plugins/${encodeURIComponent(ctx.id)}/media/${id}?i=${i}`
/** Texts fetched from X sometimes keep their HTML entities (&amp;amp;, &amp;gt;…): decode them for display. */
const unescapeX = (t) => String(t || '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])
const itemThumb = (m) => (m && (m.url || m.media_url_https || m.preview_image_url)) || null

// ---------- styles ----------
const S = {
  chip: (color) => ({ fontSize: 11, padding: '1px 8px', borderRadius: 999, background: tint(color, 0.12), color, border: `1px solid ${tint(color, 0.3)}`, whiteSpace: 'nowrap', fontWeight: 500 }),
  card: { border: `1px solid ${V.border}`, borderRadius: 10, background: V.card, padding: 10 },
  muted: { color: V.mutedFg, fontSize: 12 },
  textarea: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14, lineHeight: '20px', color: V.fg, background: 'transparent', border: `1px solid ${V.border}`, borderRadius: 8, padding: 8, resize: 'vertical' },
  input: { fontFamily: 'inherit', fontSize: 13, color: V.fg, background: 'transparent', border: `1px solid ${V.border}`, borderRadius: 8, padding: '6px 8px' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  col: { display: 'flex', flexDirection: 'column', gap: 8 },
  h2: { fontSize: 15, fontWeight: 600, margin: 0 },
  link: { color: V.primary, textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 12 },
}
const Chip = ({ color, children }) => h('span', { style: S.chip(color) }, children)
const StatusChip = ({ status }) => h(Chip, { color: (STATUS[status] || STATUS.draft).color }, statusLabel(status))
const Muted = ({ children, style }) => h('span', { style: { ...S.muted, ...(style || {}) } }, children)
const Btn = ({ children, ...props }) => h(Button, { type: 'button', size: 'sm', ...props }, children)
const Err = ({ error }) => (error ? h('div', { role: 'alert', style: { color: tok('destructive'), fontSize: 12, padding: '8px 10px', border: `1px solid ${tint(tok('destructive'), 0.3)}`, borderRadius: 8, background: tint(tok('destructive'), 0.08) } }, String(error)) : null)

function PostMedia({ ctx, post, compact = false }) {
  const [failed, setFailed] = React.useState(false)
  if (!post.has_media) return null
  if (failed) return h('div', { style: { color: tok('destructive'), fontSize: 12, padding: 8, border: `1px solid ${tint(tok('destructive'), 0.3)}`, borderRadius: 8 } }, tr('media.loadFailed'))
  return h('img', {
    src: mediaUrl(ctx, post.id),
    alt: post.media && post.media[0] && post.media[0].alt ? post.media[0].alt : tr('media.alt', { id: post.id }),
    loading: 'lazy',
    onError: () => setFailed(true),
    style: compact
      ? { width: 72, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0, border: `1px solid ${V.border}` }
      : { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', borderRadius: 8, border: `1px solid ${V.border}`, marginTop: 10 },
  })
}

// ---------- API ----------
function makeApi(ctx) {
  const call = async (raw, init) => {
    // The interface proxy drops the query string: pass it in the path (`_q/…`, decoded on the host side).
    const q = raw.indexOf('?')
    const p = q < 0 ? raw : `_q/${encodeURIComponent(raw.slice(q + 1))}/${raw.slice(0, q)}`
    const r = await ctx.api(p, { cache: 'no-store', ...(init || {}) })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    return body
  }
  return {
    get: (p) => call(p),
    post: (p, body) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
    // PUT rather than PATCH: the interface proxy does not relay PATCH (HTTP 405)
    patch: (p, body) => call(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
  }
}

/** Loads a resource and reloads it on every "changed" signal (150 ms debounce). */
function useResource(ctx, api, path, deps = []) {
  const [state, setState] = React.useState({ data: null, error: null, loading: true })
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    let active = true
    setState((s) => ({ ...s, loading: true }))
    api.get(path).then((data) => active && setState({ data, error: null, loading: false }))
      .catch((e) => active && setState((s) => ({ ...s, error: e.message, loading: false })))
    return () => { active = false }
  }, [path, tick, ...deps])
  React.useEffect(() => {
    let timer
    const unsubscribe = ctx.realtime ? ctx.realtime.subscribe('changed', () => { clearTimeout(timer); timer = setTimeout(() => setTick((t) => t + 1), 150) }) : () => {}
    return () => { clearTimeout(timer); unsubscribe() }
  }, [])
  return { ...state, reload: () => setTick((t) => t + 1) }
}

// ---------- icons (1.75 stroke, same family as the plugin's icon) ----------
const PATHS = {
  back: 'M15 18l-6-6 6-6',
  chevron: 'M6 9l6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  check: 'M20 6L9 17l-5-5',
  pencil: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  x: 'M18 6L6 18M6 6l12 12',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  reopen: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5',
}
const Icon = ({ name, size = 14 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: PATHS[name] }))

// ---------- network previews (in the theme's colors, not the network's) ----------
function AutoTextarea({ value, onChange, style, readOnly, onFocus, onBlur, label }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }, [value])
  return h('textarea', { ref, value, readOnly, onFocus, onBlur, 'aria-label': label, onChange: (e) => onChange && onChange(e.target.value), style: { ...S.textarea, overflow: 'hidden', resize: 'none', ...(style || {}) } })
}
function QuotedTweet({ item }) {
  return h('div', { style: { marginTop: 12, border: `1px solid ${V.border}`, borderRadius: 12, padding: '10px 12px' } },
    h('div', { style: { fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 } }, h(Avatar, { url: item.avatar_url, name: item.author_name || item.author, size: 20 }), h('b', null, item.author_name || item.author), h('span', { style: { color: V.mutedFg } }, ` @${item.author} · ${fmt(item.posted_at, undefined, { day: 'numeric', month: 'short' })}`)),
    h('div', { style: { fontSize: 14, lineHeight: '20px', marginTop: 4, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, unescapeX(item.text)))
}
function XPreview({ post, body, onChange, imageSrc, readOnly, quoteItem }) {
  const [focus, setFocus] = React.useState(false)
  const name = post.account_name || post.account
  return h('article', { style: { background: V.card, border: `1px solid ${focus ? V.primary : V.border}`, boxShadow: focus ? `0 0 0 3px ${tint(V.primary, 0.15)}` : V.shadow, borderRadius: 12, padding: '16px 18px', transition: 'border-color .15s, box-shadow .15s' } },
    h('div', { style: { display: 'flex', gap: 12 } },
      h(Avatar, { url: post.account_avatar, name, size: 40 }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 14 } }, h('b', null, name), h('span', { style: { color: V.mutedFg } }, `@${post.account}`)),
        h(AutoTextarea, { value: body, onChange, readOnly, label: tr('post.textLabel'), onFocus: () => setFocus(!readOnly), onBlur: () => setFocus(false), style: { border: 0, padding: 0, marginTop: 4, fontSize: 15, lineHeight: '22px', borderRadius: 0, outline: 'none' } }),
        imageSrc ? h('img', { src: imageSrc, alt: '', style: { marginTop: 12, width: '100%', borderRadius: 12, border: `1px solid ${V.border}`, display: 'block' } }) : null,
        quoteItem ? h(QuotedTweet, { item: quoteItem }) : null)))
}
function LinkedInPreview({ post, body, onChange, imageSrc, readOnly }) {
  const name = post.account_name || post.account
  return h('article', { style: { background: V.card, border: `1px solid ${V.border}`, boxShadow: V.shadow, borderRadius: 12, padding: '16px 18px' } },
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
      h(Avatar, { url: post.account_avatar, name, size: 44 }),
      h('div', null, h('div', { style: { fontWeight: 600, fontSize: 14 } }, name), h('div', { style: { fontSize: 12, color: V.mutedFg } }, 'LinkedIn'))),
    h(AutoTextarea, { value: body, onChange, readOnly, label: tr('post.textLabel'), style: { border: 0, padding: 0, marginTop: 10, fontSize: 14, lineHeight: '21px', borderRadius: 0, outline: 'none' } }),
    imageSrc ? h('img', { src: imageSrc, alt: '', style: { marginTop: 10, width: '100%', display: 'block', borderRadius: 8 } }) : null)
}
function Preview(props) {
  if (props.post.network === 'linkedin') return h(LinkedInPreview, props)
  return h(XPreview, props)
}

// Own image of the user (file picker or drop): sent as base64 to the host, which stores it like the agent's attach-media.
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const UPLOAD_MAX = 5 * 1024 * 1024
const readBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] || '')
  r.onerror = () => reject(new Error('read failed'))
  r.readAsDataURL(file)
})
function MediaUpload({ post, ctx, api, disabled, tr, onDone, onError }) {
  const [alt, setAlt] = React.useState('')
  const [over, setOver] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const input = React.useRef(null)
  if (['published', 'rejected'].includes(post.status)) return null
  const count = (post.media || []).length
  const send = async (files, mode) => {
    const list = Array.from(files || [])
    if (!list.length) return
    onError(null); setSending(true)
    try {
      let last = null
      for (const [i, file] of list.entries()) {
        if (!UPLOAD_TYPES.includes(file.type)) throw new Error(tr('post.upload.type'))
        if (file.size > UPLOAD_MAX) throw new Error(tr('post.upload.size'))
        last = await api.post(`posts/${post.id}/media`, { data: await readBase64(file), alt, mode: i === 0 ? mode : 'add' })
      }
      setAlt(''); onDone(last)
    } catch (e) { onError(e.message) } finally { setSending(false); if (input.current) input.current.value = '' }
  }
  const mode = count ? 'add' : 'replace'
  return h('div', { style: { marginTop: 10 } },
    h('div', {
      onDragOver: (e) => { e.preventDefault(); setOver(true) }, onDragLeave: () => setOver(false),
      onDrop: (e) => { e.preventDefault(); setOver(false); if (!disabled && !sending) send(e.dataTransfer.files, mode) },
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderRadius: 6, border: `1px dashed ${over ? tok('info') : V.border}` } },
      h('span', { style: D.help }, tr('post.upload.hint', { max: 4 })),
      h('input', { ref: input, type: 'file', accept: UPLOAD_TYPES.join(','), multiple: true, hidden: true, onChange: (e) => send(e.target.files, mode) }),
      h(Btn, { variant: 'outline', disabled: disabled || sending || count >= 4, onClick: () => input.current && input.current.click() }, sending ? tr('post.upload.sending') : tr(count ? 'post.upload.add' : 'post.upload.pick'))),
    h('input', { value: alt, onChange: (e) => setAlt(e.target.value), maxLength: 400, placeholder: tr('post.upload.alt'), 'aria-label': tr('post.upload.alt'), style: { ...D.input, marginTop: 6, width: '100%' } }),
    count ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
      ...post.media.map((m, i) => h('div', { key: i, style: { position: 'relative' } },
        h('img', { src: `${mediaUrl(ctx, post.id, i)}&v=${post.media_mtime || ''}`, alt: m.alt || '', style: { width: 64, height: 64, objectFit: 'cover', borderRadius: 4, background: V.muted } }),
        h('button', { type: 'button', disabled: disabled || sending, 'aria-label': tr('post.upload.remove'), title: tr('post.upload.remove'),
          onClick: async () => { onError(null); try { await api.post(`posts/${post.id}/media/remove`, { index: i }); onDone(null) } catch (e) { onError(e.message) } },
          style: { position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer', background: V.fg, color: V.bg, fontSize: 12, lineHeight: '18px', padding: 0 } }, '×')))) : null)
}

// ---------- sheet of a post ----------
// On the left the editor (editable preview); on the right a "Publishing" panel (status, quote, visual, cost,
// action tiles), then the source. Colors: theme tokens only.
const D = {
  panel: { background: V.card, border: `1px solid ${V.border}`, borderRadius: 12, boxShadow: V.shadow, overflow: 'hidden' },
  section: { padding: '14px 16px', borderTop: `1px solid ${V.border}` },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: V.mutedFg, margin: '0 0 8px' },
  label: { fontSize: 13, fontWeight: 500 },
  help: { fontSize: 12, color: V.mutedFg, lineHeight: '17px', marginTop: 2 },
  between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  dot: (c) => ({ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: c, marginRight: 7, flexShrink: 0 }),
  summary: { cursor: 'pointer', color: V.mutedFg, fontSize: 12, padding: '10px 16px', listStylePosition: 'inside' },
  num: { fontVariantNumeric: 'tabular-nums' },
}

function SourceItem({ item }) {
  const thumb = item.media && item.media.length ? itemThumb(item.media[0]) : null
  return h('div', { style: { padding: '12px 16px', borderTop: `1px solid ${V.border}`, display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: D.between },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 } }, h(Avatar, { url: item.avatar_url, name: item.author_name || item.author, size: 24 }),
        h('span', null, h('b', null, item.author ? `@${item.author}` : tr('source.title')), h('span', { style: { color: V.mutedFg } }, ` · ${fmt(item.posted_at)}`))),
      item.url ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', title: tr('source.viewOnX'), 'aria-label': tr('source.viewOnX'), style: { color: V.mutedFg, display: 'inline-flex' } }, h(Icon, { name: 'external' })) : null),
    h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: '19px' } }, unescapeX(item.text)),
    thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', style: { width: '100%', borderRadius: 8, border: `1px solid ${V.border}` } }) : null,
    (item.likes != null || item.views != null) ? h('div', { style: { ...D.help, ...D.num } }, tr('metrics.line', { views: n(item.views), likes: n(item.likes), saves: n(item.saves) })) : null)
}

/** Real cost of publishing: a real quote goes through GetXAPI; through the official API a link in the text costs 0.20 $.
 *  The saved post carries `cost` ({ usd, reason }); a link typed in the editor and not saved yet is taken into account. */
const COST_WHY = { quote: 'cost.quote', link: 'cost.link' }
function costOf(p, body) {
  if (p.kind === 'quote' && p.quote_item_id) return { value: usd(0.002, 3), why: tr('cost.quote') }
  if (p.has_url || /https?:\/\//.test(body)) return { value: usd(0.2), why: tr('cost.link') }
  const c = p.cost && typeof p.cost === 'object' ? p.cost : { usd: 0.015, reason: null }
  return { value: usd(c.usd, c.usd < 0.01 ? 3 : 2), why: COST_WHY[c.reason] ? tr(COST_WHY[c.reason]) : '' }
}

// Visual engines (the brief given to the agent is on the host side, IMAGE_ENGINES in briefs.js): [key, title key, subtitle key]
const IMAGE_ENGINES = [['gpt-image', 'engine.gpt.title', 'engine.gpt.sub'], ['code', 'engine.code.title', 'engine.code.sub']]
// Qualify a feedback (rejection, rewrite): the category helps the weekly synthesis; "nothing to learn" leaves out tests
// and misclicks. The keys are stored in the database (learnings.category): only their labels are translated.
const FB_CATEGORIES = ['fond', 'ton', 'longueur', 'fait', 'timing', 'visuel', 'autre']
function FeedbackOptions({ fb, setFb }) {
  return h('div', { style: { ...S.row, gap: 6 } },
    ...FB_CATEGORIES.map((k) => h('button', { key: k, type: 'button', 'aria-pressed': fb.category === k, onClick: () => setFb({ ...fb, category: fb.category === k ? null : k }),
      style: { font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '2px 10px', borderRadius: 999, border: `1px solid ${fb.category === k ? V.primary : V.border}`, background: fb.category === k ? tint(V.primary, 0.12) : 'transparent', color: fb.category === k ? V.primary : V.mutedFg } }, tr(`fb.${k}`))),
    h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg, marginLeft: 6, cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: !!fb.ignored, onChange: (e) => setFb({ ...fb, ignored: e.target.checked }) }), tr('fb.ignore')))
}

function PostDetail({ ctx, api, id, tz, onBack, onOpen }) {
  const res = useResource(ctx, api, `posts/${id}`)
  const [body, setBody] = React.useState(null)
  const [prompt, setPrompt] = React.useState(null)          // GPT Image brief (posts.image_prompt)
  const [promptCode, setPromptCode] = React.useState(null)  // brief of the coded graphic (posts.image_prompt_code)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [mode, setMode] = React.useState(null)      // 'reject' | 'rewrite' | 'image' | 'date' | 'publish'
  const [note, setNote] = React.useState('')
  const [fb, setFb] = React.useState({ category: null, ignored: false })
  const [when, setWhen] = React.useState('')
  const [imgKey, setImgKey] = React.useState(0)
  const [engine, setEngine] = React.useState(null)   // engine chosen for this visual (otherwise the account's)
  const d = res.data
  React.useEffect(() => { if (d) { setBody((b) => (b === null || b === d.post.body ? d.post.body : b)); setPrompt((p) => (p === null ? d.post.image_prompt || '' : p)); setPromptCode((p) => (p === null ? d.post.image_prompt_code || '' : p)); setImgKey((k) => k + 1) } }, [d && d.post.body, d && d.post.media && d.post.media.length, d && d.post.media_mtime, d && d.post.status])
  // a request to the agent in progress (visual, rewrite): the agent writes outside the plugin, the sheet is read again every 10 s
  const waiting = Boolean(d && d.post.pending && ((d.post.pending.image && !d.post.pending.image.stale) || (d.post.pending.rewrite && !d.post.pending.rewrite.stale)))
  React.useEffect(() => {
    if (!waiting) return undefined
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) res.reload() }, 10_000)
    return () => clearInterval(t)
  }, [waiting])
  if (res.error && !d) return h('div', { style: S.col }, h(BackLink, { onBack }), h(Err, { error: res.error }))
  if (!d) return h('div', { style: S.muted }, tr('common.loading'))
  const p = d.post
  // visual engines this install can use (server side: lib/connectors): an engine clearly unavailable is hidden
  const states = d.engines || {}
  const offered = IMAGE_ENGINES.filter(([k]) => !states[k] || states[k].available !== false)
  const engineNotes = IMAGE_ENGINES.map(([k, titleKey]) => {
    const st = states[k]
    if (!st || !st.hint) return null
    if (st.available === false) return tr('engine.unavailable', { engine: tr(titleKey), hint: st.hint })
    if (st.available === null) return tr('engine.note', { engine: tr(titleKey), hint: st.hint })
    return null
  }).filter(Boolean)
  const pend = p.pending || {}
  const ago = (r) => (r.minutes < 1 ? tr('rel.justNow') : tr('rel.past', { value: tr('rel.minutes', { n: r.minutes }) }))
  const st = p.status
  const live = st !== 'published'
  const text = body === null ? p.body : body
  const dirty = body !== null && body !== p.body
  const toggle = (m) => setMode(mode === m ? null : m)
  const act = async (label, fn) => { setBusy(label); setError(null); setNotice(null); try { await fn(); setMode(null); setNote(''); setFb({ category: null, ignored: false }) } catch (e) { setError(e.message) } finally { setBusy(null) } }
  const saveFirst = async () => { if (dirty) await api.patch(`posts/${p.id}`, { body }) }
  const approve = (schedule) => act('approve', async () => { const r = await api.post(`posts/${p.id}/approve`, { body: dirty ? body : undefined, schedule }); if (r.reason) setNotice(tr(r.reason_code === 'no_image' ? 'post.validatedNoImage' : 'post.validatedNoSlot')) })
  const publishNow = () => act('publish', async () => { await saveFirst(); if (st === 'pending_validation') await api.post(`posts/${p.id}/approve`, { schedule: 'none' }); await api.post(`posts/${p.id}/publish`) })
  const ask = (kind) => act(kind, async () => { await api.post(`posts/${p.id}/ask`, { kind, text: note, ...(kind === 'rewrite' ? fb : {}) }); res.reload() })
  const setQuote = (itemId) => act('quote', async () => { await saveFirst(); await api.post(`posts/${p.id}/quote`, { item_id: itemId }) })
  const imageSrc = p.has_media ? `${mediaUrl(ctx, p.id)}&v=${imgKey}` : null
  const isQuote = p.kind === 'quote' && p.quote_item_id != null
  const mains = d.sources.filter((s) => s.kind !== 'thread')
  const thread = d.sources.filter((s) => s.kind === 'thread')
  const quotable = d.sources.filter((s) => s.url && s.kind !== 'thread')
  const quoteTarget = isQuote ? d.sources.find((s) => s.id === p.quote_item_id) : quotable[0]
  const cost = costOf(p, text)

  // status → state sentence, action tiles (icon + word), discreet secondary links
  let state = null
  const tiles = [], links = []
  const tile = (key, label, icon, onClick, o = {}) => tiles.push({ key, label, icon, onClick, ...o })
  const link = (key, label, onClick, disabled) => links.push({ key, label, onClick, disabled })
  const publishTile = () => tile('publish', tr('post.publish'), 'send', () => toggle('publish'), { active: mode === 'publish', disabled: !p.can_publish, title: p.can_publish ? tr('post.publishNowTitle') : tr('post.visualMissing') })
  const editTile = () => tile('edit', tr('post.edit'), 'pencil', () => toggle('rewrite'), { active: mode === 'rewrite', title: tr('post.editTitle') })
  const rejectTile = () => tile('reject', tr('post.reject'), 'x', () => toggle('reject'), { active: mode === 'reject', danger: true })
  if (['pending_validation', 'draft'].includes(st)) {
    state = p.can_publish ? tr('post.state.pending') : tr('post.state.pendingNoVisual')
    publishTile()
    tile('approve', busy === 'approve' ? tr('post.validating') : tr('post.validate'), 'check', () => approve('auto'), { primary: true, title: tr('post.validateTitle') })
    editTile(); rejectTile()
    link('date', tr('post.validateForDate'), () => toggle('date'))
  } else if (st === 'approved') {
    state = p.can_publish ? tr('post.state.approved') : tr('post.state.approvedNoVisual')
    publishTile()
    tile('schedule', tr('post.schedule'), 'calendar', () => act('schedule', () => api.post(`posts/${p.id}/schedule`, {})), { primary: true, disabled: !p.can_publish, title: tr('post.scheduleTitle') })
    editTile(); rejectTile()
    link('date', tr('post.pickDate'), () => toggle('date'), !p.can_publish)
    link('back', tr('post.backToValidate'), () => act('reopen', () => api.post(`posts/${p.id}/reopen`)))
  } else if (st === 'scheduled') {
    state = tr('post.state.scheduled', { date: fmt(p.scheduled_for, tz), rel: relative(p.scheduled_for) })
    publishTile()
    tile('date', tr('post.date'), 'calendar', () => toggle('date'), { active: mode === 'date', title: tr('post.dateTitle') })
    editTile(); rejectTile()
    link('un', tr('post.unschedule'), () => act('unschedule', () => api.post(`posts/${p.id}/unschedule`)))
  } else if (st === 'published') {
    state = tr('post.state.published', { date: fmt(p.published_at, tz) })
  } else if (['rejected', 'failed'].includes(st)) {
    state = st === 'failed' ? (p.validation_note || tr('post.state.failed')) : p.validation_note ? tr('post.state.rejectedNote', { note: p.validation_note }) : tr('post.state.rejected')
    tile('reopen', tr('post.reopen'), 'reopen', () => act('reopen', () => api.post(`posts/${p.id}/reopen`)), { primary: true })
    editTile()
  }
  const panel = mode === 'reject' ? h('div', { style: S.col },
      h('textarea', { value: note, onChange: (e) => setNote(e.target.value), placeholder: tr('post.rejectPlaceholder'), rows: 3, style: S.textarea, autoFocus: true, 'aria-label': tr('post.rejectLabel') }),
      h(FeedbackOptions, { fb, setFb }),
      h('div', { style: S.row }, h(Btn, { variant: 'destructive', onClick: () => act('reject', () => api.post(`posts/${p.id}/reject`, { note, ...fb })), disabled: !note.trim() || !!busy }, tr('post.reject')), h(Btn, { variant: 'ghost', onClick: () => setMode(null) }, tr('common.cancel'))))
    : mode === 'rewrite' ? h('div', { style: S.col },
      h('div', { style: D.help }, tr('post.rewriteHelp')),
      h('textarea', { value: note, onChange: (e) => setNote(e.target.value), placeholder: tr('post.rewritePlaceholder'), rows: 3, style: S.textarea, autoFocus: true, 'aria-label': tr('post.rewriteLabel') }),
      h(FeedbackOptions, { fb, setFb }),
      h('div', { style: S.row }, h(Btn, { onClick: () => ask('rewrite'), disabled: !!busy }, tr('common.sendToAgent')), h(Btn, { variant: 'ghost', onClick: () => setMode(null) }, tr('common.cancel'))))
    : mode === 'date' ? h('div', { style: S.col },
      h('input', { type: 'datetime-local', value: when, onChange: (e) => setWhen(e.target.value), style: { ...S.input, width: '100%', boxSizing: 'border-box' }, 'aria-label': tr('post.dateLabel') }),
      h('div', { style: S.row }, h(Btn, { onClick: () => (st === 'pending_validation' ? approve(new Date(when).toISOString()) : act('schedule', () => api.post(`posts/${p.id}/schedule`, { at: new Date(when).toISOString() }))), disabled: !when || !!busy }, st === 'pending_validation' ? tr('post.validateAndSchedule') : tr('post.schedule')),
        h(Btn, { variant: 'ghost', onClick: () => setMode(null) }, tr('common.cancel'))))
    : mode === 'publish' ? h('div', { style: S.col },
      h('div', { style: { fontSize: 13 } }, tr('post.publishConfirm', { account: p.account, cost: cost.value })),
      h('div', { style: S.row }, h(Btn, { onClick: publishNow, disabled: !!busy }, busy === 'publish' ? tr('post.publishing') : tr('post.publish')), h(Btn, { variant: 'ghost', onClick: () => setMode(null) }, tr('common.cancel'))))
    : null

  const statusColor = (STATUS[st] || STATUS.draft).color
  const publication = h('section', { style: D.panel, 'aria-label': tr('post.publishing.title') },
    // state
    h('div', { style: { padding: '14px 16px' } },
      h('div', { style: D.between }, h('span', { style: { fontSize: 14, fontWeight: 600 } }, tr('post.publishing.title')), h(StatusChip, { status: st })),
      state ? h('div', { style: { ...D.help, marginTop: 6, color: st === 'failed' ? statusColor : V.mutedFg } }, state) : null,
      st === 'published' && p.url ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer', style: { ...S.link, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 } }, tr('post.viewOnX'), h(Icon, { name: 'external', size: 12 })) : null,
      st === 'published' ? h('div', { style: { ...D.help, ...D.num, marginTop: 4 } }, d.metrics ? tr('metrics.line', { views: n(d.metrics.views), likes: n(d.metrics.likes), saves: n(d.metrics.saves) }) : tr('metrics.none')) : null),
    // quote
    live && quoteTarget ? h('div', { style: D.section },
      h('div', { style: D.between },
        h('label', { htmlFor: `quote-${p.id}`, style: { ...D.label, cursor: 'pointer' } }, tr('post.quoteOf', { author: quoteTarget.author })),
        h(Switch, { id: `quote-${p.id}`, checked: isQuote, disabled: !!busy, onCheckedChange: (on) => setQuote(on ? quoteTarget.id : null) })),
      h('div', { style: D.help }, isQuote ? tr('post.quoteOn') : tr('post.quoteOff'))) : null,
    // visual
    live ? h('div', { style: D.section },
      h('div', { style: D.between },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: D.label }, tr('post.visual')),
          h('div', { style: { ...D.help, display: 'flex', alignItems: 'center' } },
            h('span', { style: D.dot(pend.image ? (pend.image.stale ? tok('destructive') : tok('info')) : p.has_media ? tok('success') : isQuote || p.no_media ? V.mutedFg : tok('warning')) }),
            pend.image && !pend.image.stale ? tr(p.has_media ? 'post.visual.askedReplace' : 'post.visual.askedNew', { ago: ago(pend.image) })
              : pend.image ? tr('post.visual.stale', { ago: ago(pend.image) })
                : p.has_media ? tr('post.visual.ready') : isQuote ? tr('post.visual.optional') : p.no_media ? tr('post.visual.none') : tr('post.visual.missing'))),
        h(Btn, { variant: 'outline', onClick: () => toggle('image'), disabled: !!busy }, pend.image ? tr('post.visual.askAgain') : p.has_media ? tr('post.visual.redo') : tr('post.visual.ask'))),
      !p.has_media && !isQuote ? h('div', { style: { ...D.between, marginTop: 10 } },
        h('label', { htmlFor: `nomedia-${p.id}`, style: { ...D.help, cursor: 'pointer', color: V.fg } }, tr('post.noMedia')),
        h(Switch, { id: `nomedia-${p.id}`, checked: !!p.no_media, disabled: !!busy, onCheckedChange: (on) => act('nomedia', async () => { const r = await api.post(`posts/${p.id}/no-media`, { on }); if (r.scheduled) setNotice(tr('post.scheduledFor', { date: fmt(r.scheduled, tz) })); res.reload() }) })) : null,
      h(MediaUpload, { post: p, ctx, api, disabled: !!busy, tr, onDone: (r) => { if (r && r.scheduled) setNotice(tr('post.scheduledFor', { date: fmt(r.scheduled, tz) })); res.reload() }, onError: setError }),
      mode === 'image' ? h('div', { style: { ...S.col, marginTop: 10 } },
        h('div', { role: 'radiogroup', 'aria-label': tr('post.engineLabel'), style: { display: 'grid', gridTemplateColumns: offered.length > 1 ? '1fr 1fr' : '1fr', gap: 8 } },
          ...offered.map(([k, titleKey, subKey]) => {
            const on = (engine || p.image_engine || 'gpt-image') === k
            return h('button', { key: k, type: 'button', role: 'radio', 'aria-checked': on, onClick: () => setEngine(k),
              style: { textAlign: 'left', cursor: 'pointer', font: 'inherit', padding: '8px 10px', borderRadius: 8, color: V.fg, border: `1px solid ${on ? V.primary : V.border}`, background: on ? tint(V.primary, 0.08) : 'transparent' } },
              h('div', { style: { fontSize: 13, fontWeight: 600, color: on ? V.primary : V.fg } }, tr(titleKey)), h('div', { style: { fontSize: 12, color: V.mutedFg, marginTop: 2 } }, tr(subKey)))
          })),
        ...engineNotes.map((t, i) => h('div', { key: `en-${i}`, style: D.help }, t)),
        (engine || p.image_engine || 'gpt-image') === 'code'
          ? h('textarea', { key: 'code', value: promptCode, onChange: (e) => setPromptCode(e.target.value), rows: 5, placeholder: tr('post.briefCodePlaceholder'), style: S.textarea, autoFocus: true, 'aria-label': tr('post.briefCodeLabel') })
          : h('textarea', { key: 'gpt', value: prompt, onChange: (e) => setPrompt(e.target.value), rows: 5, placeholder: tr('post.briefGptPlaceholder'), style: S.textarea, autoFocus: true, 'aria-label': tr('post.briefGptLabel') }),
        h('div', { style: S.row }, h(Btn, { onClick: () => act('image', async () => { const eng = engine || p.image_engine || 'gpt-image'; await api.patch(`posts/${p.id}`, eng === 'code' ? { image_prompt_code: promptCode } : { image_prompt: prompt }); await api.post(`posts/${p.id}/ask`, { kind: 'image', text: '', engine: eng }); res.reload() }), disabled: !!busy }, busy === 'image' ? tr('common.sending') : tr('common.sendToAgent')),
          h(Btn, { variant: 'ghost', onClick: () => setMode(null) }, tr('common.cancel')))) : null) : null,
    // cost
    live ? h('div', { style: { ...D.section, ...D.between } },
      h('div', null, h('div', { style: D.label }, tr('post.cost')), cost.why ? h('div', { style: D.help }, cost.why) : null),
      h('span', { style: { fontSize: 13, fontWeight: 600, ...D.num } }, cost.value)) : null,
    // actions: square tiles on one line, then discreet links and the panel of the open action
    tiles.length ? h('div', { style: { ...D.section, ...S.col, gap: 10 } },
      notice ? h('div', { role: 'status', style: { ...D.help, color: V.fg } }, notice) : null,
      pend.rewrite ? h('div', { role: 'status', style: { ...D.help, display: 'flex', alignItems: 'center', color: V.fg } }, h('span', { style: D.dot(pend.rewrite.stale ? tok('destructive') : tok('info')) }),
        tr(pend.rewrite.stale ? 'post.rewriteStale' : 'post.rewriteAsked', { ago: ago(pend.rewrite) })) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`, gap: 8 } },
        ...tiles.map((t) => h(ActionTile, { key: t.key, ...t, disabled: t.disabled || !!busy }))),
      links.length ? h('div', { style: { display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' } },
        ...links.map((l) => h('button', { key: l.key, type: 'button', onClick: l.onClick, disabled: l.disabled || !!busy, style: { ...S.link, color: V.mutedFg, textDecoration: 'none', opacity: l.disabled ? 0.5 : 1, cursor: l.disabled ? 'default' : 'pointer' } }, l.label))) : null,
      panel ? h('div', { style: { paddingTop: 4 } }, panel) : null) : null)

  const source = d.sources.length ? h('section', { style: D.panel, 'aria-label': tr('source.title') },
    h('div', { style: { padding: '12px 16px 10px', fontSize: 14, fontWeight: 600 } }, tr('source.title')),
    ...mains.map((it) => h(SourceItem, { key: it.id, item: it })),
    thread.length ? h('details', { style: { borderTop: `1px solid ${V.border}` } }, h('summary', { style: D.summary }, tr('source.thread', { n: thread.length })), ...thread.map((it) => h(SourceItem, { key: it.id, item: it }))) : null,
    p.idea_concept ? h('details', { style: { borderTop: `1px solid ${V.border}` } }, h('summary', { style: D.summary }, tr('source.ideaConcept')), h('div', { style: { ...D.help, whiteSpace: 'pre-wrap', padding: '0 16px 12px' } }, p.idea_concept)) : null)
    : p.idea_concept ? h('section', { style: { ...D.panel, padding: '12px 16px' } }, h('div', { style: { fontSize: 14, fontWeight: 600 } }, tr('source.ownIdea')), h('div', { style: { ...D.help, whiteSpace: 'pre-wrap', marginTop: 6 } }, p.idea_concept)) : null

  const history = d.versions.length || d.successors.length || d.missions.length ? h('div', { style: { ...S.col, gap: 6, fontSize: 12, color: V.mutedFg } },
    d.successors.length ? h('div', null, tr('post.replacedBy'), ' ', ...d.successors.map((s) => h('button', { key: s.id, type: 'button', style: S.link, onClick: () => onOpen(s.id) }, `#${s.id} `))) : null,
    d.versions.length ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, tr('post.versions', { n: d.versions.length })),
      ...d.versions.map((v) => h('div', { key: v.id, style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${V.border}` } },
        h('div', { style: S.row }, h(StatusChip, { status: v.status }), h('span', null, `#${v.id} · ${fmt(v.created_at, tz)}`), h('button', { type: 'button', style: S.link, onClick: () => onOpen(v.id) }, tr('common.open'))),
        h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, color: V.fg, opacity: 0.75 } }, v.body)))) : null,
    d.missions.length ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, tr('post.requests', { n: d.missions.length })),
      ...d.missions.map((m) => h('div', { key: m.id, style: { marginTop: 4 } }, `${fmt(m.created_at, tz)} · ${m.kind}`))) : null) : null

  return h('div', { style: { ...S.col, gap: 18, maxWidth: 1120, margin: '0 auto' } },
    h('header', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
      h('div', { style: { minWidth: 0, flex: 1 } },
        h(BackLink, { onBack }),
        h('h1', { style: { fontSize: 18, fontWeight: 600, margin: '6px 0 2px', lineHeight: '24px', textWrap: 'balance' } }, p.idea_title || tr('post.title', { id: p.id })),
        h('div', { style: { ...S.row, gap: 6, fontSize: 12, color: V.mutedFg } }, tr('post.meta', { id: p.id, network: NETWORK[p.network] || p.network, account: p.account, lang: String(p.lang).toUpperCase(), created: relative(p.created_at) }),
          (p.types || []).length ? h('select', { value: p.post_type || '', disabled: !live || !!busy, 'aria-label': tr('post.type'), onChange: (e) => act('type', async () => { await api.patch(`posts/${p.id}`, { post_type: e.target.value || null }); res.reload() }),
            style: { ...S.input, padding: '1px 6px', fontSize: 12, color: p.post_type ? V.primary : V.mutedFg } },
            h('option', { value: '' }, tr('post.noType')), ...p.types.map((t) => h('option', { key: t.key, value: t.key }, t.label))) : null)),
      dirty ? h(Btn, { onClick: () => act('save', saveFirst), disabled: !!busy, style: { marginTop: 22 } }, busy === 'save' ? tr('common.saving') : tr('post.saveText')) : null),
    h(Err, { error }),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', flexDirection: 'row-reverse', gap: 24, alignItems: 'flex-start' } },
      h('div', { style: { ...S.col, gap: 16, flex: '1 1 300px' } }, publication, source),
      h('div', { style: { ...S.col, gap: 8, minWidth: 0, flex: '3 1 440px' } },
        h(Preview, { post: p, body: text, onChange: live ? setBody : undefined, imageSrc, readOnly: !live, quoteItem: isQuote ? quoteTarget : null }),
        h('div', { style: { ...D.between, fontSize: 12, color: V.mutedFg, padding: '0 4px', ...D.num } },
          h('span', null, tr('post.chars', { n: n(text.length) })), dirty ? h('span', null, tr('post.unsaved')) : live ? h('span', null, tr('post.clickToEdit')) : null),
        history)))
}
/** Square action tile: centered icon, word below. `primary` = recommended action, `danger` = rejection, `active` = open panel. */
function ActionTile({ label, icon, onClick, primary, danger, active, disabled, title }) {
  const [hover, setHover] = React.useState(false)
  const accent = danger ? tok('destructive') : V.primary
  const bg = primary ? V.primary : active ? tint(accent, 0.1) : hover && !disabled ? tint(accent, 0.06) : V.card
  return h('button', { type: 'button', onClick, disabled, title, 'aria-pressed': active || undefined, onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, aspectRatio: '1 / 1', maxHeight: 84, minHeight: 64, padding: 6, boxSizing: 'border-box',
      borderRadius: 10, font: 'inherit', fontSize: 12, fontWeight: 500, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, transition: 'background .15s, border-color .15s, filter .15s',
      background: bg, color: primary ? V.primaryFg : danger ? accent : V.fg, filter: primary && hover && !disabled ? 'brightness(1.08)' : 'none',
      border: `1px solid ${primary ? V.primary : active || (hover && !disabled) ? tint(accent, 0.5) : V.border}` } },
    h(Icon, { name: icon, size: 20 }), label)
}
function BackLink({ onBack }) {
  return h('button', { type: 'button', onClick: onBack, style: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 12, color: V.mutedFg, cursor: 'pointer' } }, h(Icon, { name: 'back' }), tr('tab.posts'))
}

// ---------- queue (columns) ----------
function PostCard({ ctx, post, tz, onOpen }) {
  const when = post.status === 'scheduled' ? fmt(post.scheduled_for, tz) : post.status === 'published' ? fmt(post.published_at, tz, { day: 'numeric', month: 'short' }) : relative(post.created_at)
  const flag = post.status === 'failed' ? { text: trunc(post.validation_note || tr('queue.failed'), 80), color: tok('destructive') }
    : !post.can_publish && post.status !== 'published' && post.status !== 'rejected'
      ? (post.image_requested_at && Date.now() - new Date(post.image_requested_at).getTime() < 45 * 60_000 ? { text: tr('queue.visualAsked'), color: tok('info') } : { text: tr('post.visualMissing'), color: tok('warning') })
      : post.kind === 'quote' && post.quote_item_id ? { text: tr('queue.quote'), color: V.mutedFg } : null
  return h('button', { type: 'button', onClick: () => onOpen(post.id), style: { ...S.card, padding: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, width: '100%', color: 'inherit', font: 'inherit', boxShadow: V.shadow } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: V.mutedFg, width: '100%' } },
      h('b', { style: { color: V.fg } }, `#${post.id}`), post.post_type ? h('span', { style: { color: V.primary, fontWeight: 500, whiteSpace: 'nowrap' } }, post.post_type.replace(/_/g, ' ')) : null, post.source_author ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr('queue.after', { author: post.source_author })) : null,
      h('span', { style: { marginLeft: 'auto', whiteSpace: 'nowrap', color: post.status === 'scheduled' ? V.primary : V.mutedFg, fontWeight: post.status === 'scheduled' ? 500 : 400 } }, when)),
    h('div', { style: { fontSize: 13, lineHeight: '18px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, post.body),
    post.has_media ? h(PostMedia, { ctx, post }) : null,
    flag ? h('div', { style: { display: 'flex', alignItems: 'center', fontSize: 12, color: flag.color } }, h('span', { style: { display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: flag.color, marginRight: 6 } }), flag.text) : null)
}
function Queue({ ctx, api, tz, onOpen }) {
  const res = useResource(ctx, api, 'posts?status=pending_validation,approved,scheduled,published,failed,draft&limit=300')
  const [showRejected, setShowRejected] = React.useState(false)
  const rej = useResource(ctx, api, showRejected ? 'posts?status=rejected&limit=50' : 'settings')
  if (res.error && !res.data) return h(Err, { error: res.error })
  const posts = (res.data && res.data.posts) || []
  const cols = [
    ['pending_validation', tr('queue.col.pending'), posts.filter((p) => ['pending_validation', 'draft'].includes(p.status))],
    ['approved', tr('queue.col.approved'), posts.filter((p) => p.status === 'approved')],
    ['scheduled', tr('queue.col.scheduled'), posts.filter((p) => p.status === 'scheduled').sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))],
    ['published', tr('queue.col.published'), posts.filter((p) => ['published', 'failed'].includes(p.status)).slice(0, 20)],
  ]
  return h('div', { style: { ...S.col, gap: 16 } },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 16, alignItems: 'start' } },
      ...cols.map(([k, label, list]) => h('section', { key: k, 'aria-label': label, style: { ...S.col, gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 } },
          h('span', { style: { width: 8, height: 8, borderRadius: 999, background: STATUS[k].color } }), label,
          h('span', { style: { color: V.mutedFg, fontWeight: 500, fontVariantNumeric: 'tabular-nums' } }, String(list.length))),
        list.length ? list.map((p) => h(PostCard, { key: p.id, ctx, post: p, tz, onOpen }))
          : h('div', { style: { fontSize: 12, color: V.mutedFg, padding: '18px 12px', textAlign: 'center', border: `1px dashed ${V.border}`, borderRadius: 10 } }, k === 'scheduled' ? tr('queue.noScheduled') : tr('queue.noPost'))))),
    h('div', null, h('button', { type: 'button', style: S.link, onClick: () => setShowRejected((v) => !v) }, showRejected ? tr('queue.hideRejected') : tr('queue.showRejected'))),
    showRejected && rej.data && rej.data.posts ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 } }, ...rej.data.posts.map((p) => h(PostCard, { key: p.id, ctx, post: p, tz, onOpen }))) : null)
}

// ---------- calendar ----------
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6)   // 06:00 → 23:00
const HOUR_KEY = 'growth-studio:calendar-hour-h'
/** Short week day names, Monday first, in the interface's language (2024-01-01 was a Monday). */
const WEEKDAYS = () => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'short' }))
const readHourH = () => { try { const v = Number(localStorage.getItem(HOUR_KEY)); if (v >= 30 && v <= 400) return v } catch { /* nothing */ } return 44 }
const EVENT_MIN = 30   // a post takes 30 min in the grid
const SNAP_MIN = 5     // a dropped post lands on a 5-minute step
/** Lays overlapping posts side by side: { …p, lane, lanes }. */
function layoutLanes(list) {
  const out = []; let group = []; let groupEnd = -1; let laneEnds = []
  const flush = () => { const lanes = laneEnds.length; for (const e of group) out.push({ ...e, lanes }); group = []; laneEnds = []; groupEnd = -1 }
  for (const p of list) {
    const start = p.hour * 60 + p.minute
    if (group.length && start >= groupEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= start)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0) }
    laneEnds[lane] = start + EVENT_MIN; groupEnd = Math.max(groupEnd, start + EVENT_MIN)
    group.push({ ...p, lane })
  }
  flush()
  return out
}
function Calendar({ ctx, api, tz, onOpen, accounts = [] }) {
  const [account, setAccount] = React.useState(0)   // 0 = all accounts
  const [cursor, setCursor] = React.useState(() => new Date())
  const [view, setView] = React.useState('week')
  const [hourH, setHourH] = React.useState(readHourH)
  const dragRef = React.useRef(null)
  const startDrag = (e) => {
    e.preventDefault()
    dragRef.current = { y: e.clientY, h: hourH }
    const mv = (ev) => { const d = dragRef.current; if (d) setHourH(Math.max(30, Math.min(400, Math.round(d.h + (ev.clientY - d.y) / 4)))) }
    const up = () => { dragRef.current = null; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  const [jump, setJump] = React.useState(0)
  const goToday = () => { setCursor(new Date()); setView('day'); setJump((j) => j + 1) }
  const nowRef = React.useRef(null)
  React.useEffect(() => { if (jump && nowRef.current) nowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, [jump])
  React.useEffect(() => { try { localStorage.setItem(HOUR_KEY, String(hourH)) } catch { /* nothing */ } }, [hourH])
  const rangeKey = `${cursor.getFullYear()}-${cursor.getMonth()}`
  const range = React.useMemo(() => { const c = new Date(cursor.getFullYear(), cursor.getMonth(), 1); return `calendar?from=${new Date(c.getTime() - 45 * 86400000).toISOString()}&to=${new Date(c.getTime() + 75 * 86400000).toISOString()}${account ? `&account=${account}` : ''}` }, [rangeKey, account])
  const res = useResource(ctx, api, range)
  // Drag & drop of a scheduled post: grabbed post, slot under the pointer, new times shown until the next load.
  const grabRef = React.useRef(null)
  const [drop, setDrop] = React.useState(null)
  const [moved, setMoved] = React.useState({})
  const [moveErr, setMoveErr] = React.useState(null)
  React.useEffect(() => { setMoved({}) }, [res.data])
  // Width of the hours grid, to know whether a post has room for the thumbnail of its image.
  const [gridW, setGridW] = React.useState(0)
  const roRef = React.useRef(null)
  const gridRef = React.useCallback((el) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null }
    if (el && typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(([e]) => setGridW(e.contentRect.width)); ro.observe(el); roRef.current = ro }
  }, [])
  if (res.error && !res.data) return h(Err, { error: res.error })
  const data = res.data || { posts: [], slots: [], waiting: [] }
  const z = data.tz || tz
  const nDays = view === 'day' ? 1 : view === '3days' ? 3 : 7
  const startDay = new Date(cursor); startDay.setHours(0, 0, 0, 0)
  if (view === 'week') startDay.setDate(startDay.getDate() - ((startDay.getDay() + 6) % 7))
  const days = Array.from({ length: nDays }, (_, i) => { const d = new Date(startDay); d.setDate(startDay.getDate() + i); return d })
  const win = data.window || {}
  const hm = (s) => (s ? `${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}` : '—')
  const byDay = new Map()
  for (const p of data.posts) { const at = p.status === 'published' ? p.published_at : moved[p.id] || p.scheduled_for; if (!at) continue; const k = parts(at, z); (byDay.get(k.key) || byDay.set(k.key, []).get(k.key)).push({ ...p, at, ...k }) }
  const todayKey = dayKey(new Date())
  const move = (dir) => setCursor((c) => { const d = new Date(c); if (view === 'month') d.setMonth(d.getMonth() + dir); else d.setDate(d.getDate() + nDays * dir); return d })
  const fd = (d, o) => d.toLocaleDateString(locale(), o)
  const label = view === 'month' ? fd(cursor, { month: 'long', year: 'numeric' }) : view === 'day' ? fd(days[0], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : `${fd(days[0], { day: 'numeric', month: 'short' })} – ${fd(days[nDays - 1], { day: 'numeric', month: 'short', year: 'numeric' })}`
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  const canMove = (p) => p.status === 'scheduled'
  const startMove = (e, p) => {
    const r = e.currentTarget.getBoundingClientRect()
    grabRef.current = { id: p.id, key: p.key, minutes: p.hour * 60 + p.minute, offsetMin: ((e.clientY - r.top) / hourH) * 60 }
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(p.id)) } catch { /* nothing */ }
    setMoveErr(null)
  }
  const endMove = () => { grabRef.current = null; setDrop(null) }
  // Pointer over a day: in the hours grid the time follows the pointer (where the post was grabbed stays under it),
  // in the month view the post keeps its time.
  const overDay = (e, key, inGrid) => {
    const g = grabRef.current
    if (!g) return
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'
    let minutes = g.minutes
    if (inGrid) {
      const raw = HOURS[0] * 60 + ((e.clientY - e.currentTarget.getBoundingClientRect().top) / hourH) * 60 - g.offsetMin
      minutes = Math.max(HOURS[0] * 60, Math.min(24 * 60 - SNAP_MIN, Math.round(raw / SNAP_MIN) * SNAP_MIN))
    }
    const at = zonedIso(key, minutes, z)
    if (!drop || drop.key !== key || drop.minutes !== minutes) setDrop({ key, minutes, at, past: new Date(at).getTime() < Date.now() })
  }
  const dropOn = async (e) => {
    e.preventDefault()
    const g = grabRef.current; const d = drop
    endMove()
    if (!g || !d || (d.key === g.key && d.minutes === g.minutes)) return
    if (d.past) { setMoveErr(tr('cal.movePast')); return }
    setMoved((m) => ({ ...m, [g.id]: d.at }))
    try { await api.post(`posts/${g.id}/schedule`, { at: d.at }); res.reload() } catch (err) {
      setMoved((m) => { const next = { ...m }; delete next[g.id]; return next })
      setMoveErr(tr('cal.moveFailed', { error: err.message }))
    }
  }
  const dragProps = (p) => (canMove(p) ? { draggable: true, onDragStart: (e) => startMove(e, p), onDragEnd: endMove } : {})
  const Event = ({ p, compact, style, thumb }) => h('button', { type: 'button', onClick: () => onOpen(p.id), title: canMove(p) ? `${p.body}\n\n${tr('cal.moveHint')}` : p.body, style: { display: thumb ? 'flex' : 'block', gap: 5, alignItems: 'flex-start', width: '100%', boxSizing: 'border-box', textAlign: 'left', cursor: canMove(p) ? 'grab' : 'pointer', font: 'inherit', color: 'inherit', fontSize: 11, lineHeight: '14px', padding: '2px 5px', borderRadius: 6, overflow: 'hidden', background: tint((STATUS[p.status] || STATUS.draft).color, 0.12), border: `1px solid ${tint((STATUS[p.status] || STATUS.draft).color, 0.4)}`, marginBottom: compact && !style ? 2 : 0, opacity: moved[p.id] ? 0.6 : 1, ...style } },
    thumb ? h('img', { src: mediaUrl(ctx, p.id), alt: '', loading: 'lazy', draggable: false, onError: (e) => { e.currentTarget.style.display = 'none' }, style: { flex: 'none', width: thumb.w, height: thumb.h, objectFit: 'cover', borderRadius: 4, background: V.muted } }) : null,
    h('span', { style: thumb ? { minWidth: 0, overflow: 'hidden', alignSelf: 'stretch' } : null }, h('b', null, `${hhmm(p.hour * 60 + p.minute)} `), `@${p.account} · ${trunc(p.body, style ? 200 : compact ? 28 : 60)}`))
  // Thumbnail of the post's image when its box has room for it (at least 30 px high and 120 px wide).
  const thumbOf = (p, boxH) => {
    if (!p.has_media || !gridW) return null
    const laneW = (gridW - 48) / nDays / p.lanes - 4
    if (boxH < 30 || laneW < 120) return null
    const hgt = Math.min(boxH - 6, Math.round(laneW * 0.4 * 9 / 16))
    return hgt >= 22 ? { h: hgt, w: Math.round(hgt * 16 / 9) } : null
  }
  const cols = `48px repeat(${nDays}, 1fr)`
  const week = h('div', { style: { border: `1px solid ${V.border}`, borderRadius: 10, overflow: 'hidden' } },
    h('div', { style: { display: 'grid', gridTemplateColumns: cols, borderBottom: `1px solid ${V.border}`, background: V.muted } }, h('div'),
      ...days.map((d) => h('div', { key: d.toISOString(), style: { textAlign: 'center', padding: '6px 0', fontSize: 12, fontWeight: dayKey(d) === todayKey ? 700 : 500, color: dayKey(d) === todayKey ? V.primary : V.fg } }, fd(d, { weekday: 'short', day: 'numeric' })))),
    h('div', { ref: gridRef, style: { position: 'relative', display: 'grid', gridTemplateColumns: cols, height: HOURS.length * hourH } },
      h('div', { onPointerDown: startDrag, title: tr('cal.dragHint'), style: { position: 'relative', cursor: 'ns-resize', touchAction: 'none', userSelect: 'none' } }, ...HOURS.map((hr, i) => h('div', { key: hr, style: { position: 'absolute', top: i * hourH - 7, right: 6, fontSize: 10, color: V.mutedFg } }, tr('cal.hour', { h: String(hr).padStart(2, '0') })))),
      ...days.map((d) => {
        const k = dayKey(d); const list = layoutLanes((byDay.get(k) || []).sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)))
        return h('div', { key: k, onDragOver: (e) => overDay(e, k, true), onDrop: dropOn, style: { position: 'relative', borderLeft: `1px solid ${V.border}`, background: k === todayKey ? `${V.primary.replace(')', ' / 0.05)')}` : 'transparent' } },
          ...HOURS.map((hr, i) => h('div', { key: `l${hr}`, onPointerDown: startDrag, title: tr('cal.dragHint'), style: { position: 'absolute', top: i * hourH - 3, height: 7, left: 0, right: 0, cursor: 'ns-resize', touchAction: 'none', zIndex: 1 } }, h('div', { style: { marginTop: 3, borderTop: `1px solid ${V.border}`, opacity: 0.5 } }))),
          ...[win.start, win.end].filter(Boolean).map((s, i) => h('div', { key: `w${i}`, title: i ? tr('cal.windowEnd') : tr('cal.windowStart'), style: { position: 'absolute', top: (s.h - 6) * hourH + (s.m / 60) * hourH, left: 2, right: 2, borderTop: `2px dashed ${tint(STATUS.scheduled.color, 0.35)}`, pointerEvents: 'none' } })),
          k === todayKey ? (() => { const np = parts(new Date().toISOString(), z); const top = (np.hour - 6 + np.minute / 60) * hourH; return np.hour >= 6 ? h('div', { key: 'now', ref: nowRef, title: tr('cal.now'), style: { position: 'absolute', top, left: 0, right: 0, height: 0, borderTop: `2px solid ${tok('destructive')}`, zIndex: 3, pointerEvents: 'none' } }, h('span', { style: { position: 'absolute', left: -4, top: -5, width: 8, height: 8, borderRadius: 4, background: tok('destructive') } })) : null })() : null,
          ...list.map((p) => { const w = 100 / p.lanes; const boxH = Math.max(16, (EVENT_MIN / 60) * hourH - 2); return h('div', { key: `e${p.id}`, ...dragProps(p), style: { position: 'absolute', left: `calc(${p.lane * w}% + 2px)`, width: `calc(${w}% - 4px)`, top: Math.max(0, (p.hour - 6) * hourH + (p.minute / 60) * hourH) + 1, height: boxH, zIndex: 2 } }, h(Event, { p, compact: true, thumb: thumbOf(p, boxH), style: { height: '100%' } })) }),
          drop && drop.key === k ? h('div', { key: 'drop', style: { position: 'absolute', left: 2, right: 2, top: (drop.minutes / 60 - HOURS[0]) * hourH + 1, height: Math.max(16, (EVENT_MIN / 60) * hourH - 2), zIndex: 4, pointerEvents: 'none', borderRadius: 6, border: `2px dashed ${drop.past ? tok('destructive') : V.primary}`, background: tint(drop.past ? tok('destructive') : V.primary, 0.08), fontSize: 11, fontWeight: 600, padding: '1px 5px', boxSizing: 'border-box', color: drop.past ? tok('destructive') : V.primary } }, drop.past ? tr('cal.dropPast', { time: hhmm(drop.minutes) }) : hhmm(drop.minutes)) : null)
      })),
    h('div', { onPointerDown: startDrag, title: tr('cal.dragHint'), style: { height: 12, cursor: 'ns-resize', touchAction: 'none', background: V.muted, borderTop: `1px solid ${V.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h('div', { style: { width: 40, height: 3, borderRadius: 2, background: V.mutedFg, opacity: 0.5 } })))
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1); const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7))
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d })
  const month = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 } },
    ...WEEKDAYS().map((w, i) => h('div', { key: i, style: { fontSize: 11, color: V.mutedFg, textAlign: 'center' } }, w)),
    ...cells.map((d) => { const k = dayKey(d); const list = (byDay.get(k) || []).sort((a, b) => a.hour - b.hour)
      const target = drop && drop.key === k
      return h('div', { key: k, onDragOver: (e) => overDay(e, k, false), onDrop: dropOn, style: { minHeight: 76, border: target ? `2px dashed ${drop.past ? tok('destructive') : V.primary}` : `1px solid ${V.border}`, borderRadius: 8, padding: target ? 3 : 4, opacity: d.getMonth() === cursor.getMonth() ? 1 : 0.45, background: k === todayKey ? V.accent : 'transparent' } },
        h('div', { style: { fontSize: 11, fontWeight: k === todayKey ? 700 : 400, marginBottom: 2 } }, d.getDate()), ...list.slice(0, 3).map((p) => h('div', { key: p.id, ...dragProps(p) }, h(Event, { p, compact: true }))), list.length > 3 ? h(Muted, null, `+${list.length - 3}`) : null) }))
  return h('div', { style: S.col },
    h('div', { style: S.row }, h('b', { style: { textTransform: 'capitalize', fontSize: 14 } }, label), h('span', { style: { marginLeft: 'auto' } }),
      h(Btn, { variant: view === '3days' ? 'default' : 'outline', onClick: () => setView('3days') }, tr('cal.3days')), h(Btn, { variant: view === 'week' ? 'default' : 'outline', onClick: () => setView('week') }, tr('cal.week')), h(Btn, { variant: view === 'month' ? 'default' : 'outline', onClick: () => setView('month') }, tr('cal.month')),
      h(Btn, { variant: view === 'day' ? 'default' : 'outline', onClick: goToday }, tr('cal.today')), h(Btn, { variant: 'outline', onClick: () => move(-1) }, '‹'), h(Btn, { variant: 'outline', onClick: () => move(1) }, '›'),
      accounts.length > 1 ? h('select', { value: String(account), onChange: (e) => setAccount(Number(e.target.value)), style: { ...S.input, padding: '4px 6px', fontSize: 12 }, 'aria-label': tr('cal.accountShown') },
        h('option', { value: '0' }, tr('common.allAccounts')), ...accounts.map((a) => h('option', { key: a.id, value: String(a.id) }, `@${a.handle} · ${NETWORK[a.network] || a.network}`))) : null,
      h(Muted, null, tr(account ? 'cal.window' : 'cal.windowGlobal', { start: hm(win.start), end: hm(win.end), gapMin: win.gapMin, gapMax: win.gapMax, tz: z }))),
    moveErr ? h(Err, { error: moveErr }) : null,
    view === 'month' ? month : week,
    data.waiting && data.waiting.length ? h('div', { style: { ...S.card, ...S.col } }, h('b', { style: { fontSize: 13 } }, tr('cal.waiting', { n: data.waiting.length })),
      ...data.waiting.map((p) => h('div', { key: p.id, style: S.row }, h('button', { type: 'button', style: S.link, onClick: () => onOpen(p.id) }, `#${p.id}`), h('span', { style: { fontSize: 12 } }, trunc(p.body, 90)), p.can_publish ? null : h(Chip, { color: STATUS.pending_validation.color }, tr('cal.missingImage'))))) : null)
}

// ---------- feed ----------
// Bookmarks, brands and watchlist in a single grid of cards. The filters combine on the fly
// (new request, no reload) and are remembered; "Load more" paginates with a cursor. Labels: `feed.<key>.*`.
const FEED = { bookmark: {}, brand: {}, watch: {} }
const FEED_KEY = 'growth-studio:feed-sources'
const readFeedSources = () => { try { const v = JSON.parse(localStorage.getItem(FEED_KEY)); if (Array.isArray(v)) return v.filter((s) => FEED[s]) } catch { /* nothing */ } return Object.keys(FEED) }

/** Official X logo, in `currentColor` to follow the filter's color. */
const XLogo = ({ size = 13 }) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': true, style: { flex: 'none' } },
  h('path', { d: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' }))

// On: the theme's primary color; off: the theme's light grey (muted token, darker in a dark theme). No box, no border.
function FeedFilter({ id, on, count, onToggle }) {
  return h('button', { type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': tr(`feed.${id}.label`), onClick: onToggle,
    style: { display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px', borderRadius: 999, font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
      border: 'none', background: on ? V.primary : V.muted, color: on ? V.primaryFg : V.mutedFg, transition: 'background .15s, color .15s' } },
    h(XLogo),
    tr(`feed.${id}.name`),
    count != null ? h('span', { style: { fontSize: 12, fontWeight: 400, fontVariantNumeric: 'tabular-nums', opacity: 0.8 } }, n(count)) : null)
}

/** Profile picture (accounts.avatar_url); falls back to the initial when it is missing or does not load. */
function Avatar({ url, name, size = 32 }) {
  const [broken, setBroken] = React.useState(false)
  const box = { width: size, height: size, borderRadius: 999, flexShrink: 0 }
  if (url && !broken) return h('img', { src: url, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onError: () => setBroken(true), style: { ...box, objectFit: 'cover', background: V.muted } })
  return h('div', { 'aria-hidden': true, style: { ...box, background: V.muted, color: V.mutedFg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: Math.round(size * 0.4) } }, String(name || '?').slice(0, 1).toUpperCase())
}
function Tag({ children, color }) {
  const c = color || V.mutedFg
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500, height: 20, padding: '0 7px', borderRadius: 6, color: c, background: color ? tint(color, 0.1) : V.muted, whiteSpace: 'nowrap' } }, children)
}

function FeedCard({ ctx, api, item, onOpen, onGone, onChange, target, isNew, ptype }) {
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [asked, setAsked] = React.useState(false)
  const a = item.assessment
  const thumb = item.media && item.media.length ? itemThumb(item.media[0]) : null
  const blocked = item.watch_role === 'reference' ? tr('feed.blockedReference') : item.competitor_id || (a && a.pillar === 'competitor') ? tr('feed.blockedCompetitor') : null
  const act = (key, fn) => async () => { setBusy(key); setError(null); try { await fn() } catch (e) { setError(e.message) } finally { setBusy(null) } }
  const keep = act('keep', async () => { await api.post(`items/${item.id}/verdict`, { verdict: 'keep' }); onChange({ ...item, assessment: { ...(a || {}), verdict: 'keep' } }) })
  const draft = act('draft', async () => { if (!a || a.verdict !== 'keep') await api.post(`items/${item.id}/verdict`, { verdict: 'keep' }); await api.post(`items/${item.id}/draft`, { text: '', account_id: target || undefined, post_type: ptype || undefined }); setAsked(true); onChange({ ...item, assessment: { ...(a || {}), verdict: 'keep' } }) })
  const ignore = act('ignore', async () => { await api.post(`items/${item.id}/verdict`, { verdict: 'ignore' }); onGone(item.id) })
  const long = (unescapeX(item.text)).length > 280
  return h('article', { style: { ...S.card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, boxShadow: V.shadow, breakInside: 'avoid' } },
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
      h(Avatar, { url: item.avatar_url, name: item.author_name || item.author, size: 36 }),
      h('div', { style: { flex: 1, minWidth: 0, lineHeight: '17px' } },
        h('div', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.author_name || `@${item.author}`),
        h('div', { style: { fontSize: 12, color: V.mutedFg } }, `@${item.author} · ${relative(item.posted_at)}`,
          // fetched long after it was posted (old bookmark, catch-up): also say when it arrived
          item.arrived_at && new Date(item.arrived_at) - new Date(item.posted_at) > 3600e3 ? ` · ${tr('feed.arrived', { rel: relative(item.arrived_at) })}` : '')),
      item.url ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer', title: tr('source.viewOnX'), 'aria-label': tr('source.viewOnX'), style: { color: V.mutedFg, display: 'inline-flex', padding: 2 } }, h(Icon, { name: 'external' })) : null),
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      isNew ? h(Tag, { color: V.primary }, tr('feed.new')) : null,
      ...item.sources.map((s) => h(Tag, { key: s }, FEED[s] ? tr(`feed.${s}.tag`) : s)),
      a && a.verdict === 'to_confirm' ? h(Tag, { color: tok('warning') }, tr('feed.toTriage')) : null,
      a && a.verdict === 'keep' ? h(Tag, { color: tok('success') }, tr('feed.kept')) : null,
      a && a.score != null ? h(Tag, null, `${a.score}/5`) : null,
      item.news ? h(Tag, { color: tok('info') }, item.news.status === 'skipped' ? tr('feed.newsSkipped') : tr('feed.news')) : null),
    h('div', { style: { fontSize: 13, lineHeight: '19px', whiteSpace: 'pre-wrap', ...(open ? {} : { display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) } }, unescapeX(item.text)),
    long ? h('button', { type: 'button', onClick: () => setOpen(!open), style: { ...S.link, alignSelf: 'flex-start', textDecoration: 'none', marginTop: -4 } }, open ? tr('feed.less') : tr('feed.more')) : null,
    thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', style: { width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8, border: `1px solid ${V.border}` } }) : null,
    item.metrics ? h('div', { style: { fontSize: 12, color: V.mutedFg, fontVariantNumeric: 'tabular-nums' } }, tr('metrics.line', { views: n(item.metrics.views), likes: n(item.metrics.likes), saves: n(item.metrics.saves) })) : null,
    a && a.angle && a.verdict === 'to_confirm' ? h('div', { style: { fontSize: 12, color: V.mutedFg, lineHeight: '17px' } }, h('b', { style: { color: V.fg, fontWeight: 500 } }, tr('feed.angle')), ' ', a.angle) : null,
    error ? h(Err, { error }) : null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 10, marginTop: 'auto', borderTop: `1px solid ${V.border}` } },
      item.posts.length ? item.posts.map((p) => h(Btn, { key: p.id, variant: 'outline', onClick: () => onOpen(p.id) }, tr('post.title', { id: p.id }), h('span', { style: { color: (STATUS[p.status] || STATUS.draft).color, fontWeight: 500 } }, ` · ${statusLabel(p.status)}`)))
        : blocked ? h('span', { style: { fontSize: 12, color: V.mutedFg } }, blocked)
          : asked ? h('span', { style: { fontSize: 12, color: tok('success') } }, tr('feed.draftAsked'))
            : [h(Btn, { key: 'd', onClick: draft, disabled: !!busy }, busy === 'draft' ? tr('common.sending') : tr('feed.draft')),
              !a || a.verdict !== 'keep' ? h(Btn, { key: 'k', variant: 'outline', onClick: keep, disabled: !!busy }, tr('feed.keep')) : null],
      !item.posts.length ? h(Btn, { variant: 'ghost', onClick: ignore, disabled: !!busy, style: { marginLeft: 'auto', color: V.mutedFg } }, tr('feed.ignore')) : null))
}

/** Approximate height of a feed card, to lay cards out without measuring the DOM. */
const estimateCard = (it) => 170 + Math.min(6, Math.ceil((it.text || '').length / 45) + ((it.text || '').match(/\n/g) || []).length) * 19 + (it.media && it.media.length && itemThumb(it.media[0]) ? 200 : 0) + (it.assessment && it.assessment.angle ? 40 : 0)

/** Masonry: as many columns as the width allows (>= 300 px), each card in the shortest column. */
function Masonry({ items, render, dim, min = 300, gap = 14 }) {
  const ref = React.useRef(null)
  const [cols, setCols] = React.useState(3)
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const fit = () => setCols(Math.max(1, Math.floor((el.clientWidth + gap) / (min + gap))))
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    if (ro) ro.observe(el)
    return () => ro && ro.disconnect()
  }, [])
  const lanes = Array.from({ length: cols }, () => ({ h: 0, items: [] }))
  for (const it of items) { const lane = lanes.reduce((a, b) => (b.h < a.h ? b : a)); lane.items.push(it); lane.h += estimateCard(it) + gap }
  return h('div', { ref, style: { display: 'flex', gap, alignItems: 'flex-start', opacity: dim ? 0.55 : 1, transition: 'opacity .15s' } },
    ...lanes.map((l, i) => h('div', { key: i, style: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap } }, ...l.items.map(render))))
}

const TARGET_KEY = 'growth-studio:draft-target'
const SORT_KEY = 'growth-studio:feed-sort'
const SEEN_KEY = 'growth-studio:feed-seen'
const FEED_REFRESH_MS = 60000
const SORTS = [['arrived', 'feed.sort.arrived'], ['posted', 'feed.sort.posted']]
function Feed({ ctx, api, onOpen, accounts = [] }) {
  const [sources, setSources] = React.useState(readFeedSources)
  const [sort, setSort] = React.useState(() => { try { return localStorage.getItem(SORT_KEY) === 'posted' ? 'posted' : 'arrived' } catch { return 'arrived' } })
  // last visit: read on opening (reference of the "New" badges for the whole visit), then replaced by now
  const seen = React.useRef(null)
  if (seen.current === null) {
    let prev = null
    try { prev = localStorage.getItem(SEEN_KEY); localStorage.setItem(SEEN_KEY, new Date().toISOString()) } catch { /* nothing */ }
    seen.current = prev || new Date().toISOString()   // first visit: no badge
  }
  React.useEffect(() => () => { try { localStorage.setItem(SEEN_KEY, new Date().toISOString()) } catch { /* nothing */ } }, [])
  // account for which "Draft" asks for a post (remembered; useful as soon as there are several managed accounts)
  const [target, setTarget] = React.useState(() => { try { return Number(localStorage.getItem(TARGET_KEY)) || null } catch { return null } })
  const tgt = accounts.some((a) => a.id === target) ? target : (accounts[0] && accounts[0].id) || null
  React.useEffect(() => { try { if (tgt) localStorage.setItem(TARGET_KEY, String(tgt)) } catch { /* nothing */ } }, [tgt])
  const [ptype, setPtype] = React.useState('')   // type imposed on the drafts asked from the feed ('' = the agent picks)
  const tgtTypes = ((accounts.find((a) => a.id === tgt) || {}).types) || []
  const ptypeOk = tgtTypes.some((t) => t.key === ptype) ? ptype : ''
  const [state, setState] = React.useState({ items: [], counts: null, next: null, loading: true, more: false, error: null })
  const key = [...sources].sort().join(',')
  React.useEffect(() => { try { localStorage.setItem(FEED_KEY, JSON.stringify(sources)) } catch { /* nothing */ } }, [key])
  React.useEffect(() => { try { localStorage.setItem(SORT_KEY, sort) } catch { /* nothing */ } }, [sort])
  const shown = React.useRef(24)   // loaded cards: a background reload takes as many again (max 100)
  React.useEffect(() => {
    if (!sources.length) { setState((s) => ({ ...s, items: [], next: null, loading: false })); return }
    let live = true
    shown.current = 24
    setState((s) => ({ ...s, loading: true, error: null }))
    api.get(`feed?sources=${key}&sort=${sort}&limit=24`).then((d) => live && setState({ items: d.items, counts: d.counts, next: d.next, loading: false, more: false, error: null }))
      .catch((e) => live && setState((s) => ({ ...s, loading: false, error: e.message })))
    // silent reload: every minute (watch and fetch write outside the plugin) and on every "changed" signal
    let timer
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      api.get(`feed?sources=${key}&sort=${sort}&limit=${Math.min(100, Math.max(24, shown.current))}`)
        .then((d) => live && setState((s) => (s.more ? s : { ...s, items: d.items, counts: d.counts, next: d.next, error: null }))).catch(() => { /* next pass */ })
    }
    const every = setInterval(refresh, FEED_REFRESH_MS)
    const unsubscribe = ctx.realtime ? ctx.realtime.subscribe('changed', () => { clearTimeout(timer); timer = setTimeout(refresh, 300) }) : () => {}
    const onVisible = () => { if (!document.hidden) refresh() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; clearInterval(every); clearTimeout(timer); unsubscribe(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible) }
  }, [key, sort])
  React.useEffect(() => { shown.current = Math.max(24, state.items.length) }, [state.items.length])
  const loadMore = () => {
    setState((s) => ({ ...s, more: true }))
    // no encodeURIComponent here: makeApi already encodes the whole query (otherwise the cursor arrives encoded twice)
    api.get(`feed?sources=${key}&sort=${sort}&limit=24&before=${state.next}`).then((d) => setState((s) => ({ ...s, items: [...s.items, ...d.items.filter((x) => !s.items.some((y) => y.id === x.id))], next: d.next, more: false })))
      .catch((e) => setState((s) => ({ ...s, more: false, error: e.message })))
  }
  const toggle = (id) => setSources((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]))
  const gone = (id) => setState((s) => ({ ...s, items: s.items.filter((x) => x.id !== id) }))
  const change = (it) => setState((s) => ({ ...s, items: s.items.map((x) => (x.id === it.id ? it : x)) }))
  const total = state.counts ? sources.reduce((t, s) => t + (state.counts[s] || 0), 0) : null
  return h('div', { style: { ...S.col, gap: 16, maxWidth: 1240, margin: '0 auto' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      ...Object.keys(FEED).map((id) => h(FeedFilter, { key: id, id, on: sources.includes(id), count: state.counts ? state.counts[id] : null, onToggle: () => toggle(id) })),
      accounts.length > 1 ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg, marginLeft: 8 } }, tr('feed.draftsFor'),
        h('select', { value: String(tgt || ''), onChange: (e) => setTarget(Number(e.target.value)), style: { ...S.input, padding: '3px 6px', fontSize: 12 } },
          ...accounts.map((a) => h('option', { key: a.id, value: String(a.id) }, `@${a.handle} · ${NETWORK[a.network] || a.network}`)))) : null,
      tgtTypes.length ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg, marginLeft: 8 } }, tr('feed.type'),
        h('select', { value: ptypeOk, onChange: (e) => setPtype(e.target.value), style: { ...S.input, padding: '3px 6px', fontSize: 12 } },
          h('option', { value: '' }, tr('feed.agentPicks')), ...tgtTypes.map((t) => h('option', { key: t.key, value: t.key }, t.label)))) : null,
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg, marginLeft: 8 } }, tr('feed.sortBy'),
        h('select', { value: sort, onChange: (e) => setSort(e.target.value), style: { ...S.input, padding: '3px 6px', fontSize: 12 } },
          ...SORTS.map(([v, l]) => h('option', { key: v, value: v }, tr(l))))),
      h('span', { style: { marginLeft: 'auto', fontSize: 12, color: V.mutedFg, fontVariantNumeric: 'tabular-nums' } }, state.loading ? tr('common.loading') : sources.length ? tr('feed.shown', { n: n(state.items.length) }) : '')),
    state.error ? h(Err, { error: state.error }) : null,
    !sources.length ? h('div', { style: { padding: '48px 16px', textAlign: 'center', color: V.mutedFg, fontSize: 13 } }, tr('feed.noFilter'))
      : !state.loading && !state.items.length ? h('div', { style: { padding: '48px 16px', textAlign: 'center', color: V.mutedFg, fontSize: 13 } }, tr('feed.empty'))
        : h(Masonry, { items: state.items, dim: state.loading, render: (it) => h(FeedCard, { key: it.id, ctx, api, item: it, onOpen, onGone: gone, onChange: change, target: tgt, ptype: ptypeOk, isNew: !!it.arrived_at && new Date(it.arrived_at) > new Date(seen.current) }) }),
    state.next && sources.length ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '4px 0 8px' } },
      h(Btn, { variant: 'outline', onClick: loadMore, disabled: state.more }, state.more ? tr('common.loading') : tr('feed.loadMore'))) : null)
}

// ---------- original post ideas (reflections: neither news nor share) ----------
// The agent suggests ideas following the account's instructions (Settings › Original ideas), each on a pain already
// identified and a verified solution (v19, no question to the user any more); the user keeps one in a click ("Write",
// optional instruction) or drops it (reason read before the next suggestions). With direct drafting, the agent writes alone.
const IDEA_TARGET_KEY = 'growth-studio:ideas-account'
// keys stored in the database (ideas.solution_kind, ideas.status): only their labels are translated
const SOLUTION_KIND = ['timon', 'outil', 'methode']
const IDEA_STATUS = { idea: tok('warning'), approved: tok('info'), in_progress: tok('primary'), done: tok('success'), dropped: V.mutedFg }
function TypeMix({ mix }) {
  return h('div', { style: { ...S.col, gap: 4 } },
    h(Muted, null, mix.total ? tr(mix.total > 1 ? 'mix.title.many' : 'mix.title.one', { days: mix.days, n: mix.total }) : tr('mix.none')),
    h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, ...mix.mix.map((m) => h('span', { key: m.key, style: { fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 } },
      h('b', { style: { color: m.key === mix.next ? V.primary : V.fg, fontWeight: m.key === mix.next ? 600 : 500 } }, m.label),
      h('span', { style: { position: 'relative', width: 60, height: 6, borderRadius: 3, background: V.muted, overflow: 'hidden' }, title: tr('mix.bar', { actual: m.actual, target: m.target }) },
        h('span', { style: { position: 'absolute', inset: 0, width: `${Math.min(100, m.actual)}%`, background: m.key === mix.next ? V.primary : V.mutedFg } }),
        h('span', { style: { position: 'absolute', top: 0, bottom: 0, left: `${Math.min(99, m.target)}%`, width: 2, background: V.fg } })),
      h(Muted, null, `${m.actual} / ${m.target} %`)))))
}
function IdeaCard({ api, idea, types = [], onOpen, onDone }) {
  const [ptype, setPtype] = React.useState(idea.post_type || '')
  const typeLabel = (k) => (types.find((t) => t.key === k) || { label: k }).label
  const [mode, setMode] = React.useState(null)   // 'draft' (with an instruction) | 'drop'
  const [note, setNote] = React.useState(''); const [fb, setFb] = React.useState({ category: null, ignored: false })
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null)
  const act = async (fn, ok) => { setBusy(true); setErr(null); try { await fn(); setMsg(ok); setMode(null); setNote(''); onDone() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const label = IDEA_STATUS[idea.status] ? tr(`idea.status.${idea.status}`) : idea.status
  const color = IDEA_STATUS[idea.status] || V.mutedFg
  const open = idea.status === 'idea'
  const draft = (text = '') => act(() => api.post(`ideas/${idea.id}/draft`, { text, post_type: ptype || null }), tr('idea.writingAsked'))
  return h('article', { style: { ...S.card, ...S.col, gap: 8, padding: 14, opacity: idea.status === 'dropped' ? 0.6 : 1 } },
    h('div', { style: S.row }, h(Chip, { color }, label), idea.post_type ? h(Chip, { color: V.primary }, typeLabel(idea.post_type)) : null, h(Muted, null, `#${idea.id} · ${relative(idea.created_at)}`)),
    h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: '20px' } }, idea.title),
    idea.pain ? h('div', { style: { ...S.col, gap: 4, fontSize: 13, lineHeight: '19px' } },
      h('div', null, h(Muted, null, `${tr('idea.pain')} · `), idea.pain),
      h('div', null, h(Muted, null, `${tr('idea.solution')}${idea.solution_kind ? ` (${SOLUTION_KIND.includes(idea.solution_kind) ? tr(`solution.${idea.solution_kind}`) : idea.solution_kind})` : ''} · `), idea.solution)) : null,
    h('div', { style: { fontSize: 13, lineHeight: '19px', whiteSpace: 'pre-wrap', color: idea.pain ? V.mutedFg : V.fg } }, idea.concept),
    idea.evidence || (idea.sources && idea.sources.length) ? h('div', { style: { fontSize: 12, lineHeight: '17px', color: V.mutedFg } }, `${tr('idea.sources')} `, idea.evidence || '',
      ...(idea.sources || []).map((x) => h('span', { key: x.id }, ' · ', x.url ? h('a', { href: x.url, target: '_blank', rel: 'noreferrer', style: { color: V.primary } }, x.handle ? `@${x.handle}` : tr('idea.item', { id: x.id })) : tr('idea.item', { id: x.id })))) : null,
    idea.angle ? h('div', { style: { fontSize: 13, lineHeight: '19px' } }, h(Muted, null, `${tr('idea.position')} · `), idea.angle) : null,
    idea.why_follow ? h('div', { style: { fontSize: 12, lineHeight: '17px', color: V.mutedFg } }, tr('idea.whyFollow', { text: idea.why_follow })) : null,
    idea.decision_note && !open ? h(Muted, null, tr(idea.status === 'dropped' ? 'idea.reasonNote' : 'idea.yourInstruction', { note: idea.decision_note })) : null,
    idea.posts.length ? h('div', { style: S.row }, ...idea.posts.map((p) => h(Btn, { key: p.id, variant: 'outline', onClick: () => onOpen(p.id) }, tr('post.title', { id: p.id }), h('span', { style: { color: (STATUS[p.status] || STATUS.draft).color, fontWeight: 500 } }, ` · ${statusLabel(p.status)}`)))) : null,
    mode === 'draft' ? h('div', { style: S.col },
      types.length ? h('label', { style: { ...S.row, fontSize: 12, color: V.mutedFg } }, tr('post.type'),
        h('select', { value: ptype, onChange: (e) => setPtype(e.target.value), style: { ...S.input, padding: '3px 6px', fontSize: 12 } },
          h('option', { value: '' }, tr('post.noType')), ...types.map((t) => h('option', { key: t.key, value: t.key }, t.label)))) : null,
      h('textarea', { value: note, rows: 2, onChange: (e) => setNote(e.target.value), placeholder: tr('idea.instructionPlaceholder'), style: { ...S.textarea, fontSize: 13 }, 'aria-label': tr('idea.instructionLabel') }),
      h('div', { style: S.row }, h(Btn, { disabled: busy, onClick: () => draft(note) }, busy ? tr('common.sending') : tr('idea.write')), h(Btn, { variant: 'outline', onClick: () => setMode(null) }, tr('common.cancel')))) : null,
    mode === 'drop' ? h('div', { style: S.col },
      h('input', { value: note, onChange: (e) => setNote(e.target.value), placeholder: tr('idea.dropPlaceholder'), style: S.input, 'aria-label': tr('idea.dropLabel') }),
      note.trim() ? h(FeedbackOptions, { fb, setFb }) : null,
      h('div', { style: S.row }, h(Btn, { variant: 'outline', disabled: busy, onClick: () => act(() => api.post(`ideas/${idea.id}/drop`, { note, ...fb }), tr('idea.dropped')) }, tr('idea.drop')), h(Btn, { variant: 'outline', onClick: () => setMode(null) }, tr('common.cancel')))) : null,
    !mode && open ? h('div', { style: S.row },
      h(Btn, { disabled: busy, onClick: () => { setMsg(null); draft() } }, busy ? tr('common.sending') : tr('idea.writePost')),
      h(Btn, { variant: 'outline', onClick: () => { setMode('drop'); setMsg(null) } }, tr('idea.drop')),
      h('button', { type: 'button', style: { ...S.link, marginLeft: 'auto' }, onClick: () => { setMode('draft'); setMsg(null) } }, tr('idea.withInstruction'))) : null,
    !mode && idea.status === 'approved' && !idea.posts.length ? h(Muted, null, tr('idea.agentWriting')) : null,
    !mode && idea.status === 'dropped' ? h('div', null, h('button', { type: 'button', style: S.link, onClick: () => act(() => api.post(`ideas/${idea.id}/restore`, {}), tr('idea.restored')) }, tr('idea.restore'))) : null,
    err ? h(Err, { error: err }) : null, msg ? h(Muted, null, msg) : null)
}
function Ideas({ ctx, api, onOpen, accounts = [] }) {
  const [target, setTarget] = React.useState(() => { try { return Number(localStorage.getItem(IDEA_TARGET_KEY)) || null } catch { return null } })
  const acc = accounts.find((a) => a.id === target) || accounts[0] || null
  React.useEffect(() => { try { if (acc) localStorage.setItem(IDEA_TARGET_KEY, String(acc.id)) } catch { /* nothing */ } }, [acc && acc.id])
  const res = useResource(ctx, api, acc ? `ideas?account=${acc.id}` : 'ideas', [acc && acc.id])
  const [direction, setDirection] = React.useState(''); const [busy, setBusy] = React.useState(false); const [msg, setMsg] = React.useState(null); const [err, setErr] = React.useState(null)
  const [showOld, setShowOld] = React.useState(false)
  const d = res.data
  if (!acc) return h(Muted, null, tr('ideas.noAccount'))
  const ideas = (d && d.ideas) || []
  const waiting = ideas.filter((i) => i.status === 'idea')
  const active = ideas.filter((i) => ['approved', 'in_progress'].includes(i.status))
  const old = ideas.filter((i) => ['done', 'dropped'].includes(i.status))
  const cfg = d && d.config
  const types = (d && d.types) || []
  const mix = d && d.mix
  const suggest = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try { await api.post('ideas/suggest', { account_id: acc.id, text: direction }); setDirection(''); setMsg(cfg && cfg.autoDraft ? tr('ideas.sentDrafts') : tr('ideas.sentIdeas')); res.reload() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const grid = (list) => h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, alignItems: 'start' } },
    ...list.map((i) => h(IdeaCard, { key: `${i.id}-${i.status}`, api, idea: i, types, onOpen, onDone: res.reload })))
  return h('div', { style: { ...S.col, gap: 16, maxWidth: 1240, margin: '0 auto' } },
    h('div', { style: { ...S.card, ...S.col, gap: 8, padding: 14 } },
      h('div', { style: S.row },
        h('b', null, tr('ideas.title')),
        accounts.length > 1 ? h('select', { value: String(acc.id), onChange: (e) => setTarget(Number(e.target.value)), style: { ...S.input, padding: '3px 6px', fontSize: 12 }, 'aria-label': tr('ideas.account') },
          ...accounts.map((a) => h('option', { key: a.id, value: String(a.id) }, `@${a.handle} · ${NETWORK[a.network] || a.network}`))) : h(Muted, null, `@${acc.handle}`),
        cfg ? h(Muted, { style: { marginLeft: 'auto' } }, cfg.autoDraft
          ? (cfg.stockMin ? tr('ideas.refillDirect', { n: cfg.stockMin }) : tr('ideas.directOnRequest'))
          : cfg.stockMin ? tr('ideas.refill', { n: cfg.stockMin }) : tr('ideas.onRequest')) : null),
      h(Muted, null, cfg && cfg.autoDraft
        ? tr('ideas.helpDirect')
        : tr('ideas.help')),
      mix && mix.mix.length ? h(TypeMix, { mix }) : null,
      cfg && !cfg.ready ? h(Err, { error: tr('ideas.notReady') }) : null,
      h('div', { style: S.row },
        h('input', { value: direction, onChange: (e) => setDirection(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && !busy) suggest() }, placeholder: tr('ideas.directionPlaceholder'), style: { ...S.input, flex: 1, minWidth: 240 }, 'aria-label': tr('ideas.directionLabel') }),
        h(Btn, { disabled: Boolean(busy || (d && d.pending) || (cfg && !cfg.ready)), onClick: suggest }, busy ? tr('common.sending') : d && d.pending ? tr('ideas.preparing') : cfg && cfg.autoDraft ? tr('ideas.suggestAndWrite', { n: cfg.batch }) : tr('ideas.suggest', { n: cfg ? cfg.batch : '' }))),
      err ? h(Err, { error: err }) : null, msg ? h(Muted, null, msg) : null),
    res.error && !d ? h(Err, { error: res.error }) : null,
    h('b', { style: { fontSize: 13 } }, tr('ideas.waiting', { n: waiting.length })),
    waiting.length ? grid(waiting) : h('div', { style: { fontSize: 12, color: V.mutedFg, padding: '18px 12px', textAlign: 'center', border: `1px dashed ${V.border}`, borderRadius: 10 } }, d ? tr('ideas.noneWaiting') : tr('common.loading')),
    active.length ? h('b', { style: { fontSize: 13 } }, tr('ideas.kept', { n: active.length })) : null,
    active.length ? grid(active) : null,
    old.length ? h('div', null, h('button', { type: 'button', style: S.link, onClick: () => setShowOld((v) => !v) }, showOld ? tr('ideas.hideOld') : tr('ideas.showOld', { n: old.length }))) : null,
    showOld ? grid(old) : null)
}

// ---------- prospecting comments: replies to validate ----------
// The agent drafts a reply under a post found by a campaign; nothing is sent until the user clicks Validate here
// (validated_by, written by the host with the signed-in user). The publication task sends a validated reply.
const COMMENT_TABS = ['pending', 'sent', 'dismissed']
const COMMENTS_ACCOUNT_KEY = 'growth-studio:comments-account'
const REPLY_MAX = 280
const STANCE_COLOR = { critical: tok('info'), neutral: V.mutedFg, praise: tok('warning') }
function ReplyCard({ api, r, tz }) {
  const [body, setBody] = React.useState(r.body)
  const [mode, setMode] = React.useState(null)   // 'rewrite' | 'dismiss'
  const [note, setNote] = React.useState('')
  const [ignored, setIgnored] = React.useState(false)
  const [busy, setBusy] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  React.useEffect(() => { setBody(r.body) }, [r.id, r.body])
  const act = (key, fn) => async () => { setBusy(key); setError(null); setNotice(null); try { await fn() } catch (e) { setError(e.message) } finally { setBusy(null) } }
  const validate = act('validate', async () => { await api.post(`comments/${r.id}/approve`, { body }) })
  const rewrite = act('rewrite', async () => { await api.post(`posts/${r.id}/ask`, { kind: 'rewrite', text: note.trim() }); setMode(null); setNote(''); setNotice(tr('comments.rewriteSent')) })
  const dismiss = act('dismiss', async () => { await api.post(`comments/${r.id}/dismiss`, { note: note.trim(), ignored }) })
  const save = act('save', async () => { await api.patch(`posts/${r.id}`, { body }); setNotice(tr('comments.saved')) })
  // what the card shows follows the reply's own status (a list may lag behind a change)
  const pending = r.status === 'pending_validation'
  const sent = ['approved', 'scheduled', 'published', 'failed'].includes(r.status)
  const rewriting = r.rewrite_requested_at && Date.now() - new Date(r.rewrite_requested_at).getTime() < 45 * 60_000
  const metrics = [r.views != null ? tr('comments.views', { n: n(r.views) }) : null, r.likes != null ? tr('comments.likes', { n: n(r.likes) }) : null, r.replies != null ? tr('comments.replies', { n: n(r.replies) }) : null].filter(Boolean).join(' · ')
  const sentState = r.status === 'published' ? { text: tr('comments.state.sent', { date: fmt(r.published_at, tz) }), color: STATUS.published.color }
    : r.status === 'failed' ? { text: tr('comments.state.failed'), color: STATUS.failed.color }
      : { text: tr('comments.state.waiting', { date: fmt(r.validated_at, tz) }), color: STATUS.approved.color }
  const len = body.length
  return h('article', { style: { ...S.card, padding: 0, boxShadow: V.shadow, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', overflow: 'hidden' } },
    // the post found by the campaign
    h('div', { style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 8, borderRight: `1px solid ${V.border}` } },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        h(Avatar, { url: r.avatar_url, name: r.author_name || r.author, size: 36 }),
        h('div', { style: { flex: 1, minWidth: 0, lineHeight: '17px' } },
          h('div', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.author_name || `@${r.author || '?'}`),
          h('div', { style: { fontSize: 12, color: V.mutedFg } }, `@${r.author || '?'}`, r.followers != null ? ` · ${tr('comments.followers', { n: n(r.followers) })}` : '', r.posted_at ? ` · ${relative(r.posted_at)}` : '')),
        r.item_url ? h('a', { href: r.item_url, target: '_blank', rel: 'noreferrer', title: tr('source.viewOnX'), 'aria-label': tr('source.viewOnX'), style: { color: V.mutedFg, display: 'inline-flex', padding: 2 } }, h(Icon, { name: 'external' })) : null),
      h('div', { style: { fontSize: 13, lineHeight: '19px', whiteSpace: 'pre-wrap' } }, unescapeX(r.item_text)),
      metrics ? h('div', { style: { fontSize: 12, color: V.mutedFg, fontVariantNumeric: 'tabular-nums' } }, metrics) : null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 6 } },
        r.score != null ? h(Tag, { color: r.score >= 4 ? tok('success') : V.primary }, tr('comments.score', { n: r.score })) : null,
        r.pain ? h(Tag, { color: V.primary }, trunc(r.pain, 60)) : null,
        r.competitor_stance && r.competitor_stance !== 'none' ? h(Tag, { color: STANCE_COLOR[r.competitor_stance] }, tr(`comments.stance.${r.competitor_stance}`)) : null,
        h(Tag, null, `${r.campaign}`)),
      r.reason ? h('div', { style: { fontSize: 12, color: V.mutedFg, lineHeight: '17px' } }, h('b', { style: { color: V.fg, fontWeight: 500 } }, tr('comments.why')), ' ', r.reason) : null),
    // the reply of the managed account
    h('div', { style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { ...D.between, fontSize: 12, color: V.mutedFg } },
        h('span', null, tr('comments.replyAs', { account: r.account, author: r.author || '?' })),
        h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } }, rewriting && pending ? h(Tag, { color: tok('info') }, tr('comments.rewriteAsked')) : null, `#${r.id}`)),
      pending
        ? h(AutoTextarea, { value: body, onChange: setBody, label: tr('comments.replyLabel', { id: r.id }), style: { minHeight: 80 } })
        : h('div', { style: { fontSize: 14, lineHeight: '20px', whiteSpace: 'pre-wrap' } }, r.body),
      pending ? h('div', { style: { fontSize: 11, color: len > REPLY_MAX ? tok('destructive') : V.mutedFg, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${len} / ${REPLY_MAX}`) : null,
      sent ? h('div', { style: { ...S.row, fontSize: 12 } }, h('span', { style: D.dot(sentState.color) }), h('span', { style: { color: sentState.color } }, sentState.text),
        r.reply_url ? h('a', { href: r.reply_url, target: '_blank', rel: 'noreferrer', style: S.link }, tr('comments.viewReply')) : null,
        r.validated_by ? h(Muted, null, tr('comments.validatedBy', { who: r.validated_by })) : null) : null,
      r.status === 'failed' && r.validation_note ? h(Muted, null, r.validation_note) : null,
      r.status === 'rejected' && r.validation_note ? h('div', { style: { fontSize: 12 } }, h('b', { style: { fontWeight: 500 } }, tr('comments.dismissedWhy')), ' ', h(Muted, null, r.validation_note)) : null,
      error ? h(Err, { error }) : null,
      notice ? h('div', { style: { fontSize: 12, color: tok('success') } }, notice) : null,
      pending && mode ? h('div', { style: { ...S.col, gap: 6 } },
        h('input', { value: note, autoFocus: true, onChange: (e) => setNote(e.target.value), placeholder: tr(mode === 'rewrite' ? 'comments.rewritePlaceholder' : 'comments.dismissPlaceholder'), 'aria-label': tr(mode === 'rewrite' ? 'comments.rewriteLabel' : 'comments.dismissLabel'), style: S.input }),
        mode === 'dismiss' ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg } }, h('input', { type: 'checkbox', checked: ignored, onChange: (e) => setIgnored(e.target.checked) }), tr('fb.ignore')) : null,
        h('div', { style: S.row },
          mode === 'rewrite'
            ? h(Btn, { disabled: !!busy, onClick: rewrite }, busy === 'rewrite' ? tr('common.sending') : tr('common.sendToAgent'))
            : h(Btn, { variant: 'destructive', disabled: !!busy || !note.trim(), onClick: dismiss }, tr('comments.dismissConfirm')),
          h(Btn, { variant: 'ghost', onClick: () => { setMode(null); setNote('') } }, tr('common.cancel')))) : null,
      pending && !mode ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 8, marginTop: 'auto', borderTop: `1px solid ${V.border}` } },
        h(Btn, { disabled: !!busy || !body.trim(), onClick: validate, title: tr('comments.validateTitle') }, h(Icon, { name: 'check' }), busy === 'validate' ? tr('common.sending') : tr('comments.validate')),
        h(Btn, { variant: 'outline', disabled: !!busy, onClick: () => { setMode('rewrite'); setNote('') } }, h(Icon, { name: 'pencil' }), tr('comments.rewrite')),
        body !== r.body ? h(Btn, { variant: 'ghost', disabled: !!busy, onClick: save }, tr('common.save')) : null,
        h(Btn, { variant: 'ghost', disabled: !!busy, onClick: () => { setMode('dismiss'); setNote('') }, style: { marginLeft: 'auto', color: V.mutedFg } }, h(Icon, { name: 'x' }), tr('comments.dismiss'))) : null))
}
function Comments({ ctx, api, tz, accounts = [], onSettings }) {
  const [tab, setTab] = React.useState('pending')
  const [account, setAccount] = React.useState(() => { try { return Number(localStorage.getItem(COMMENTS_ACCOUNT_KEY)) || 0 } catch { return 0 } })
  const acc = accounts.some((a) => a.id === account) ? account : 0
  React.useEffect(() => { try { localStorage.setItem(COMMENTS_ACCOUNT_KEY, String(acc)) } catch { /* nothing */ } }, [acc])
  const res = useResource(ctx, api, `comments?tab=${tab}${acc ? `&account=${acc}` : ''}`)
  const d = res.data
  const counts = (d && d.counts) || {}
  const today = ((d && d.today) || []).filter((t) => !acc || t.account_id === acc)
  const tabBtn = (k) => h('button', { key: k, type: 'button', role: 'tab', 'aria-selected': tab === k, onClick: () => setTab(k), style: { ...navBtn(tab === k), width: 'auto' } },
    tr(`comments.tab.${k}`), counts[k] ? h('span', { style: { fontSize: 11, color: V.mutedFg, fontVariantNumeric: 'tabular-nums' } }, n(counts[k])) : null)
  return h('div', { style: { ...S.col, gap: 14, maxWidth: 1100, margin: '0 auto' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('div', { role: 'tablist', 'aria-label': tr('comments.tabs'), style: { display: 'flex', gap: 4 } }, ...COMMENT_TABS.map(tabBtn)),
      accounts.length > 1 ? h('select', { value: String(acc), onChange: (e) => setAccount(Number(e.target.value)), 'aria-label': tr('comments.account'), style: { ...S.input, padding: '3px 6px', fontSize: 12 } },
        h('option', { value: '0' }, tr('common.allAccounts')), ...accounts.map((a) => h('option', { key: a.id, value: String(a.id) }, `@${a.handle}`))) : null,
      h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: V.mutedFg } },
        ...today.map((t) => h('span', { key: t.account_id, title: tr('comments.todayTitle'), style: { fontVariantNumeric: 'tabular-nums', color: t.cap != null && t.sent >= t.cap ? tok('warning') : V.mutedFg } },
          `@${t.account} · `, t.cap != null ? tr('comments.todayCap', { sent: t.sent, cap: t.cap }) : tr('comments.today', { sent: t.sent }),
          t.queued ? ` · ${tr('comments.queued', { n: t.queued })}` : '', t.active ? '' : ` · ${tr('comments.inactive')}`)))),
    tab === 'pending' ? h(Muted, null, tr('comments.help')) : null,
    res.error && !d ? h(Err, { error: res.error }) : null,
    !d ? (res.error ? null : h(Muted, null, tr('common.loading')))
      : !d.replies.length ? h('div', { style: { padding: '48px 16px', textAlign: 'center', color: V.mutedFg, fontSize: 13 } },
        tr(`comments.empty.${tab}`), tab === 'pending' && !(d.today || []).length ? h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', style: S.link, onClick: onSettings }, tr('comments.setUp'))) : null)
        : h('div', { style: { ...S.col, gap: 12, opacity: res.loading ? 0.7 : 1 } }, ...d.replies.map((r) => h(ReplyCard, { key: r.id, api, r, tz }))))
}

// ---------- post types (setting `post_types`: the instruction of each type is editorial) ----------
const parseTypes = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
const slugType = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
function PostTypesEditor({ scope, own, inherited, onChange }) {
  const list = parseTypes(own)
  const inh = inherited && inherited.value ? parseTypes(inherited.value) : []
  const mine = list.length > 0
  const shown = mine ? list : inh
  const write = (next) => onChange(next.length ? JSON.stringify(next) : '')
  const edit = (i, patch) => write(list.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const total = shown.reduce((a, t) => a + (Number(t.share) || 0), 0)
  return h('div', { style: S.col },
    h(Muted, null, tr('types.help')),
    !mine && inh.length ? h('div', { style: S.row }, h(Muted, null, scope === 'global' ? tr('types.default') : tr(inherited.from === 'organization' ? 'types.inheritedOrg' : 'types.inheritedGlobal')),
      h('button', { type: 'button', style: S.link, onClick: () => write(inh) }, tr('types.copy'))) : null,
    ...shown.map((t, i) => h('div', { key: `${t.key}-${i}`, style: { ...S.card, ...S.col, gap: 6, padding: 12, opacity: mine ? 1 : 0.75 } },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px 90px', gap: 8 } },
        h(TextField, { label: tr('types.label'), value: t.label, onChange: (v) => mine && edit(i, { label: v, ...(t._new ? { key: slugType(v) } : {}) }) }),
        h(TextField, { label: tr('types.key'), value: t.key, onChange: (v) => mine && t._new && edit(i, { key: slugType(v) }) }),
        h(TextField, { label: tr('types.share'), value: String(t.share ?? ''), onChange: (v) => mine && edit(i, { share: Number(v.replace(/\D/g, '')) || 0 }) })),
      h(TextField, { label: tr('types.goal'), value: t.goal, onChange: (v) => mine && edit(i, { goal: v }) }),
      h(TextField, { label: tr('idea.instructionLabel'), value: t.prompt, multiline: true, rows: 5, onChange: (v) => mine && edit(i, { prompt: v }) }),
      mine ? h('div', null, h('button', { type: 'button', style: { ...S.link, color: tok('destructive') }, onClick: () => write(list.filter((_, j) => j !== i)) }, tr('types.remove'))) : null)),
    h('div', { style: S.row },
      h(Muted, null, tr(total !== 100 && shown.length ? 'types.totalScaled' : 'types.total', { n: total })),
      mine || !inh.length ? h('button', { type: 'button', style: S.link, onClick: () => write([...list, { key: '', label: '', goal: '', share: 0, prompt: '', _new: true }]) }, tr('types.add')) : null,
      mine && scope !== 'global' ? h('button', { type: 'button', style: S.link, onClick: () => write([]) }, tr('types.backToInherited')) : null))
}

// ---------- settings: global, organizations and accounts (cascade account → organization → global) ----------
const NET_LABEL = (id) => NETWORK[id] || id
/** Label of a setting: the host's English label (accounts.js), or its translation `setting.<key>` when there is one. */
const settingLabel = (k, meta) => { const key = `setting.${k}`; const v = tr(key); return v === key ? meta.label : v }
// tabs of each level; `rules` is called "common rules" at the global level
const TABS = {
  global: ['schedule', 'agent', 'rules', 'goals', 'sources', 'types', 'original', 'comments', 'global', 'learning'],
  organization: ['org', 'agent', 'goals', 'writing', 'rules', 'sources', 'types', 'original', 'comments', 'schedule'],
  account: ['profile', 'agent', 'publish', 'goals', 'writing', 'rules', 'sources', 'types', 'original', 'comments', 'schedule', 'learning'],
}
const tabLabel = (scope, k) => tr(scope === 'global' && k === 'rules' ? 'tab.commonRules' : `tab.${k}`)
const navBtn = (active) => ({ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', fontSize: 13, color: active ? V.primary : V.fg, fontWeight: active ? 600 : 400, background: active ? tint(V.primary, 0.08) : 'transparent', border: 0, borderRadius: 6, padding: '5px 8px' })

function Settings({ ctx, api, initial = null, onSetup = null }) {
  const res = useResource(ctx, api, 'orgs')
  // `initial`: starting level and tab ({ scope, id, tab }), only given by a development tool rendering the studio
  const [sel, setSel] = React.useState(() => (initial && initial.scope ? { scope: initial.scope, id: initial.id || 0 } : { scope: 'global', id: 0 }))
  const d = res.data
  if (!d) return res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading'))
  const is = (scope, id) => sel.scope === scope && sel.id === id
  const accounts = [...d.organizations.flatMap((o) => o.accounts), ...d.unassigned]
  const accItem = (a) => h('button', { key: `a${a.id}`, type: 'button', style: { ...navBtn(is('account', a.id)), paddingLeft: 22 }, onClick: () => setSel({ scope: 'account', id: a.id }) },
    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, `@${a.handle}`), h(Muted, { style: { fontSize: 11 } }, NET_LABEL(a.network)),
    a.connected ? null : h('span', { title: tr('settings.notConnected'), style: { width: 7, height: 7, borderRadius: 4, background: tok('warning'), marginLeft: 'auto', flexShrink: 0 } }))
  const nav = h('nav', { 'aria-label': tr('settings.nav'), style: { ...S.col, gap: 2, borderRight: `1px solid ${V.border}`, paddingRight: 12 } },
    onSetup ? h('button', { type: 'button', style: { ...navBtn(false), color: V.primary, marginBottom: 8 }, onClick: onSetup }, tr('settings.setup')) : null,
    h('button', { type: 'button', style: navBtn(is('global', 0)), onClick: () => setSel({ scope: 'global', id: 0 }) }, tr('settings.general')),
    h('button', { type: 'button', style: navBtn(is('competitors', 0)), onClick: () => setSel({ scope: 'competitors', id: 0 }) }, tr('settings.competitors')),
    ...d.organizations.flatMap((o) => [
      h('button', { key: `o${o.id}`, type: 'button', style: { ...navBtn(is('organization', o.id)), marginTop: 8, fontWeight: 600 }, onClick: () => setSel({ scope: 'organization', id: o.id }) }, o.name),
      ...o.accounts.map(accItem),
      h('button', { key: `n${o.id}`, type: 'button', style: { ...navBtn(is('new-account', o.id)), paddingLeft: 22, color: V.mutedFg, fontSize: 12 }, onClick: () => setSel({ scope: 'new-account', id: o.id }) }, tr('settings.addAccount')),
    ]),
    d.unassigned.length ? h('div', { style: { ...S.muted, marginTop: 8, padding: '0 8px' } }, tr('settings.noOrg')) : null,
    ...d.unassigned.map(accItem),
    h('button', { type: 'button', style: { ...navBtn(is('new-org', 0)), marginTop: 12, color: V.mutedFg, fontSize: 12 }, onClick: () => setSel({ scope: 'new-org', id: 0 }) }, tr('settings.newOrgLink')))
  const acc = sel.scope === 'account' ? accounts.find((a) => a.id === sel.id) : null
  const org = sel.scope === 'organization' ? d.organizations.find((o) => o.id === sel.id) : null
  const pane = sel.scope === 'competitors' ? h(Competitors, { ctx, api })
    : sel.scope === 'new-org' ? h(NewOrg, { api, onDone: (id) => { res.reload(); setSel({ scope: 'organization', id }) } })
    : sel.scope === 'new-account' ? h(NewAccount, { api, tree: d, orgId: sel.id, onDone: (id) => { res.reload(); setSel({ scope: 'account', id }) } })
      : (sel.scope === 'account' && !acc) || (sel.scope === 'organization' && !org) ? h(Muted, null, tr('settings.notFound'))
        : h(ScopeEditor, { key: `${sel.scope}${sel.id}`, ctx, api, tree: d, scope: sel.scope, id: sel.id, acc, org, initialTab: initial && initial.tab, onTree: res.reload, onGone: () => { res.reload(); setSel({ scope: 'global', id: 0 }) } })
  return h('div', { style: { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 20, alignItems: 'start', maxWidth: 1100 } }, nav, h('div', { style: { minWidth: 0 } }, pane))
}

function NewOrg({ api, onDone }) {
  const [f, setF] = React.useState({ name: '', notes: '' }); const [err, setErr] = React.useState(null)
  return h('div', { style: { ...S.col, maxWidth: 520 } }, h('h2', { style: S.h2 }, tr('settings.newOrg')),
    h(Muted, null, tr('settings.newOrgHelp')),
    h(TextField, { label: tr('settings.name'), value: f.name, onChange: (v) => setF({ ...f, name: v }) }),
    h(TextField, { label: tr('settings.notes'), value: f.notes, onChange: (v) => setF({ ...f, notes: v }) }),
    err ? h(Err, { error: err }) : null,
    h('div', null, h(Btn, { disabled: !f.name.trim(), onClick: async () => { setErr(null); try { onDone((await api.post('orgs', f)).id) } catch (e) { setErr(e.message) } } }, tr('settings.create'))))
}

const ROLES = () => [['personal', tr('role.personal')], ['brand', tr('role.brand')], ['automated', tr('role.automated')]]
function NewAccount({ api, tree, orgId, onDone }) {
  const [f, setF] = React.useState({ network: 'x', handle: '', display_name: '', lang: 'en', role: 'brand', organization_id: orgId }); const [err, setErr] = React.useState(null)
  const set = (k) => (v) => setF({ ...f, [k]: v })
  return h('div', { style: { ...S.col, maxWidth: 520 } }, h('h2', { style: S.h2 }, tr('settings.addManaged')),
    h(Muted, null, tr('settings.addManagedHelp')),
    h(SelectField, { label: tr('tab.org'), value: String(f.organization_id), options: tree.organizations.map((o) => [String(o.id), o.name]), onChange: (v) => setF({ ...f, organization_id: Number(v) }) }),
    h(SelectField, { label: tr('settings.network'), value: f.network, options: tree.networks.map((n) => [n.id, n.name]), onChange: set('network') }),
    h(TextField, { label: tr('settings.handle'), value: f.handle, onChange: set('handle') }),
    h(TextField, { label: tr('settings.displayName'), value: f.display_name, onChange: set('display_name') }),
    h(TextField, { label: tr('settings.lang'), value: f.lang, onChange: set('lang'), hint: tr('settings.langHint') }),
    h(SelectField, { label: tr('settings.role'), value: f.role, options: ROLES(), onChange: set('role') }),
    err ? h(Err, { error: err }) : null,
    h('div', null, h(Btn, { disabled: !f.handle.trim(), onClick: async () => { setErr(null); try { onDone((await api.post('accounts', f)).id) } catch (e) { setErr(e.message) } } }, tr('settings.add'))))
}

const fieldLabel = (label, hint, children) => h('label', { style: { ...S.col, gap: 4, fontSize: 13 } }, h('span', null, label), children, hint ? h(Muted, null, hint) : null)
function TextField({ label, value, onChange, hint, placeholder, multiline, rows }) {
  return fieldLabel(label, hint, multiline
    ? h('textarea', { value: value || '', placeholder, rows: rows || 5, onChange: (e) => onChange(e.target.value), style: { ...S.textarea, fontSize: 13 } })
    : h('input', { value: value || '', placeholder, onChange: (e) => onChange(e.target.value), style: S.input }))
}
function SelectField({ label, value, options, onChange, hint }) {
  return fieldLabel(label, hint, h('select', { value, onChange: (e) => onChange(e.target.value), style: S.input }, ...options.map(([v, l]) => h('option', { key: v, value: v }, l))))
}

/** Editor of a level: each field shows the value own to the level, or the inherited value (and its origin). */
function ScopeEditor({ ctx, api, tree, scope, id, acc, org, initialTab = null, onTree, onGone }) {
  const path = `scope/${scope}/${id}/settings`
  const res = useResource(ctx, api, path)
  const tabs = TABS[scope]
  const [tab, setTab] = React.useState(tabs.includes(initialTab) ? initialTab : tabs[0])
  const [form, setForm] = React.useState(null)
  const [voice, setVoice] = React.useState(null)
  const [msg, setMsg] = React.useState(null); const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const v = res.data
  React.useEffect(() => { if (v) { setForm({ ...v.own }); setVoice(v.own.voice || '') } }, [v])
  if (!v || !form) return res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading'))
  const keys = tree.keys
  const inh = (k) => (v.inherited ? v.inherited[k] : null)
  const inhText = (k) => {
    const i = inh(k); if (!i || i.value === '') return null
    const val = keys[k].type === 'bool' ? tr(i.value === '1' ? 'common.yes' : 'common.no') : i.value
    return i.from === 'default' ? tr('settings.byDefault', { value: val }) : tr('settings.inheritedFrom', { from: tr(`from.${i.from}`), value: val })
  }
  const set = (k) => (val) => setForm({ ...form, [k]: val })
  const changes = () => Object.fromEntries(Object.keys(keys).filter((k) => k !== 'voice' && (form[k] || '') !== (v.own[k] || '')).map((k) => [k, form[k] || '']))
  const save = async (extra = {}) => {
    setBusy(true); setErr(null); setMsg(null)
    try { const out = await api.post(path, { changes: changes(), ...extra }); setMsg(out.voice && out.voice.wrote ? tr('settings.savedNote') : tr('settings.saved')); res.reload(); onTree() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const field = (k) => {
    const m = keys[k]; if (!m || !m.levels.includes(scope)) return null
    const label = settingLabel(k, m)
    const hint = scope === 'global' ? (m.default != null && m.default !== '' ? tr('settings.defaultIs', { value: m.default }) : null) : inhText(k)
    if (m.type === 'bool') return h(SelectField, { key: k, label, value: form[k] || '', hint: scope === 'global' ? null : hint, onChange: set(k),
      options: [['', scope === 'global' ? tr('settings.defaultOption', { value: tr(m.default === '1' ? 'common.yes' : 'common.no') }) : tr('settings.inheritedOption', { value: tr(inh(k) && inh(k).value === '1' ? 'common.yes' : 'common.no') })], ['1', tr('common.yesCap')], ['0', tr('common.noCap')]] })
    if (m.type === 'enum') return h(SelectField, { key: k, label, value: form[k] || '', hint, onChange: set(k), options: [['', scope === 'global' ? tr('settings.defaultOption', { value: m.default }) : tr('settings.inheritedOption', { value: inh(k) ? inh(k).value : m.default })], ...m.options.map((o) => [o, o])] })
    if (m.type === 'list') {
      const cur = (() => { try { return JSON.parse(form[k] || '[]') } catch { return [] } })()
      const toggle = (hd) => { const nx = cur.includes(hd) ? cur.filter((x) => x !== hd) : [...cur, hd]; set(k)(nx.length ? JSON.stringify(nx) : '') }
      return fieldLabel(label, cur.length ? tr('settings.accountsKept', { n: cur.length }) : hint, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', maxHeight: 180, overflow: 'auto', ...S.card } },
        ...tree.watched.map((w) => h('label', { key: w.id, style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: cur.includes(w.handle), onChange: () => toggle(w.handle) }), `@${w.handle}`, w.watch_priority ? h(Muted, { style: { fontSize: 11 } }, w.watch_priority) : null))))
    }
    const multiline = m.type === 'text'
    // an instruction left empty shows the one that applies (inherited or the default), copyable to adapt it at this level
    const under = scope === 'global' ? (m.default ? { value: m.default, from: 'default' } : null) : inh(k)
    if (multiline && (m.group === 'original' || m.prompt) && under && under.value && !(form[k] || '').trim()) {
      // inherited instruction: shown in grey in the field, copyable to adapt it at this level
      return h('div', { key: k, style: S.col },
        h(TextField, { label, value: '', onChange: set(k), multiline, rows: /_prompt$/.test(k) || m.prompt ? 10 : 4, placeholder: under.value }),
        h('div', { style: S.row }, h(Muted, null, tr({ default: 'settings.emptyDefault', global: 'settings.emptyGlobal', organization: 'settings.emptyOrg' }[under.from] || 'settings.emptyInherited')),
          h('button', { type: 'button', style: S.link, onClick: () => set(k)(under.value) }, tr('settings.copyInstruction'))))
    }
    return h(TextField, { key: k, label, value: form[k], onChange: set(k), multiline, rows: k === 'rules' ? 6 : /_prompt$/.test(k) ? 10 : 4,
      placeholder: !multiline && inh(k) && inh(k).value ? inh(k).value : !multiline && scope === 'global' ? m.default : undefined,
      hint: m.merge === 'append' ? null : hint })
  }
  const group = (g) => Object.keys(keys).filter((k) => keys[k].group === g && k !== 'voice').map(field)
  const saveBar = (label = tr('common.save')) => h('div', { style: S.row }, h(Btn, { disabled: busy, onClick: () => save() }, busy ? tr('common.saving') : label), msg ? h(Muted, null, msg) : null)
  const inheritedRules = scope !== 'global' && v.inherited && v.inherited.rules && v.inherited.rules.value
    ? h('div', { style: { ...S.card, fontSize: 12, whiteSpace: 'pre-wrap' } }, h(Muted, null, scope === 'account' ? tr('settings.rulesInheritedAccount') : tr('settings.rulesInheritedOrg')), '\n', v.inherited.rules.value) : null
  const body = {
    schedule: () => [h(Muted, { key: 'm' }, tr('settings.scheduleHelp')), ...group('schedule'), saveBar()],
    rules: () => [h(Muted, { key: 'm' }, tr('settings.rulesHelp')), inheritedRules, ...group('rules'), saveBar()],
    goals: () => [...group('goals'), saveBar()],
    sources: () => [h(Muted, { key: 'm' }, tr('settings.sourcesHelp')), ...group('sources'), saveBar()],
    types: () => [h(PostTypesEditor, { key: 't', scope, own: form.post_types || '', inherited: inh('post_types'), onChange: set('post_types') }), saveBar()],
    original: () => [h(Muted, { key: 'm' }, tr('settings.originalHelp')), ...group('original'), saveBar()],
    comments: () => [scope === 'account' ? h(CampaignsEditor, { key: 'c', ctx, api, acc }) : h(Muted, { key: 'm' }, tr('settings.commentsHelp')),
      scope === 'account' ? h('h3', { key: 'h', style: { ...S.h2, fontSize: 14, marginTop: 8 } }, tr('campaign.instruction')) : null, ...group('comments'), saveBar()],
    global: () => [...group('global'), saveBar()],
    publish: () => [h(PublishHelp, { key: 'h', acc, ready: Boolean((v.own.x_publish_target || '').trim()) }), ...group('publish'), saveBar()],
    writing: () => [h(VoiceEditor, { key: 'v', api, path, view: v, voice, setVoice, scope, onSaved: () => { res.reload(); onTree() } }), ...group('writing'), saveBar()],
    learning: () => [h(Learning, { key: 'l', ctx, api, account: scope === 'account' ? id : null })],
    org: () => [h(OrgProfile, { key: 'o', api, org, onTree, onGone })],
    agent: () => [h(AgentPicker, { key: 'a', ctx, api, scope, view: v, value: form.agent || '', onChange: set('agent') }), saveBar()],
    profile: () => [h(AccountProfile, { key: 'p', api, acc, tree, onTree, onGone })],
  }
  const title = scope === 'global' ? tr('settings.generalTitle') : scope === 'organization' ? org.name : `@${acc.handle}`
  const sub = scope === 'global' ? tr('settings.generalSub') : scope === 'organization' ? tr('settings.orgSub') : `${NET_LABEL(acc.network)} · ${tree.organizations.find((o) => o.id === acc.organization_id)?.name || tr('settings.noOrgLower')}${acc.lang ? ` · ${acc.lang}` : ''}`
  return h('div', { style: S.col },
    h('div', null, h('h2', { style: { ...S.h2, fontSize: 17 } }, title), h(Muted, null, sub)),
    h('div', { role: 'tablist', style: { display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: `1px solid ${V.border}`, paddingBottom: 6 } },
      ...tabs.map((k) => h('button', { key: k, type: 'button', role: 'tab', 'aria-selected': tab === k, onClick: () => { setTab(k); setMsg(null); setErr(null) }, style: { ...navBtn(tab === k), width: 'auto' } }, tabLabel(scope, k)))),
    err ? h(Err, { error: err }) : null,
    h('div', { style: { ...S.col, gap: 12, maxWidth: 640 } }, ...body[tab]().filter(Boolean)))
}

/** Agent of the missions at this level: one of the user's Timon agents, or empty to inherit (the level above, then the
 *  plugin's agent). The host refuses an agent the user's account does not see. */
function AgentPicker({ ctx, api, scope, view, value, onChange }) {
  const res = useResource(ctx, api, 'agents')
  const d = res.data || { agents: [], plugin: null, error: null }
  const up = (view.agent && view.agent.inherited) || { value: d.plugin || '', from: 'plugin' }
  const upText = up.value ? `${up.value} — ${tr(`from.${up.from}`)}` : tr('agent.none')
  const names = d.agents.map((a) => a.name)
  const options = [['', tr('settings.inheritedOption', { value: upText })],
    ...d.agents.map((a) => [a.name, a.model ? `${a.name} (${a.backend} · ${a.model})` : `${a.name} (${a.backend})`])]
  if (value && !names.some((n) => n.toLowerCase() === value.toLowerCase())) options.push([value, tr('agent.notVisible', { name: value })])
  return h('div', { style: S.col },
    h(Muted, null, tr(scope === 'organization' ? 'agent.helpOrg' : scope === 'account' ? 'agent.helpAccount' : 'agent.helpGlobal')),
    h(SelectField, { label: tr('tab.agent'), value, onChange, options,
      hint: value ? null : up.value ? tr('settings.inheritedFrom', { from: tr(`from.${up.from}`), value: up.value }) : tr('agent.none') }),
    res.error ? h(Err, { error: res.error }) : d.error ? h(Muted, null, d.error) : null)
}

function PublishHelp({ acc, ready }) {
  return h('div', { style: { ...S.card, ...S.col, gap: 6, fontSize: 12 } },
    h('div', { style: S.row }, h(Chip, { color: ready ? tok('success') : tok('warning') }, ready ? tr('publish.connected') : tr('publish.notConnected')),
      h('span', null, tr(ready ? 'publish.readyText' : 'publish.notReadyText', { handle: acc.handle }))),
    h('div', null, tr('publish.howTo')))
}

function VoiceEditor({ api, path, view, voice, setVoice, scope, onSaved }) {
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const st = view.voice || {}
  const inherited = view.inherited && view.inherited.voice && view.inherited.voice.value && !(view.own.voice || '').trim()
  const run = async (fn, ok) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); setMsg(ok); onSaved() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const conflict = st.noteChanged && (view.own.voice || '') !== ''
  return h('div', { style: S.col },
    h(Muted, null, `${tr(st.sync ? 'voice.helpSync' : 'voice.helpLocal')}${inherited ? ` ${tr('voice.inherited')}` : ''}`),
    st.note && st.sync ? h('div', { style: S.row },
      h(Chip, { color: st.error ? tok('destructive') : !st.exists ? tok('warning') : st.synced ? tok('success') : tok('warning') },
        st.error ? tr('voice.error') : !st.exists ? tr('voice.noNote') : st.synced ? tr('voice.synced') : st.noteChanged ? tr('voice.noteChanged') : tr('voice.toCopy')),
      h(Muted, null, st.error || st.note),
      st.exists ? h(Btn, { variant: 'outline', disabled: busy, onClick: () => run(() => api.post(path.replace(/settings$/, 'voice/import'), {}), tr('voice.imported')) }, tr('voice.import')) : null) : null,
    h('textarea', { value: voice || '', rows: 16, placeholder: inherited ? view.inherited.voice.value.slice(0, 400) : tr('voice.placeholder'), onChange: (e) => setVoice(e.target.value), style: { ...S.textarea, fontSize: 13, fontFamily: 'ui-monospace, monospace' }, 'aria-label': tr('voice.label') }),
    err ? h(Err, { error: err }) : null,
    h('div', { style: S.row },
      h(Btn, { disabled: busy || voice === (view.own.voice || ''), onClick: () => run(() => api.post(path, { changes: {}, voice }), st.note && st.sync ? tr('voice.savedCopied') : tr('voice.saved')) }, tr('voice.save')),
      conflict ? h(Btn, { variant: 'outline', disabled: busy, onClick: () => { if (window.confirm(tr('voice.overwriteConfirm'))) run(() => api.post(path, { changes: {}, voice, force: true }), tr('voice.overwritten')) } }, tr('voice.overwrite')) : null,
      msg ? h(Muted, null, msg) : null))
}

function OrgProfile({ api, org, onTree, onGone }) {
  const [f, setF] = React.useState({ name: org.name, notes: org.notes || '' }); const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null)
  const run = async (fn, ok) => { setErr(null); setMsg(null); try { await fn(); setMsg(ok) } catch (e) { setErr(e.message) } }
  return h('div', { style: S.col },
    h(TextField, { label: tr('settings.name'), value: f.name, onChange: (v) => setF({ ...f, name: v }) }),
    h(TextField, { label: tr('settings.notes'), value: f.notes, onChange: (v) => setF({ ...f, notes: v }), multiline: true, rows: 3 }),
    h(Muted, null, tr('settings.orgMeta', { n: org.accounts.length, slug: org.slug })),
    err ? h(Err, { error: err }) : null,
    h('div', { style: S.row },
      h(Btn, { onClick: () => run(async () => { await api.patch(`orgs/${org.id}`, f); onTree() }, tr('settings.saved')) }, tr('common.save')),
      h(Btn, { variant: 'outline', disabled: org.accounts.length > 0, title: org.accounts.length ? tr('settings.orgHasAccounts') : undefined, onClick: () => { if (window.confirm(tr('settings.deleteOrgConfirm', { name: org.name }))) run(async () => { await api.post(`orgs/${org.id}/delete`, {}); onGone() }, '') } }, tr('common.delete')),
      msg ? h(Muted, null, msg) : null))
}

function AccountProfile({ api, acc, tree, onTree, onGone }) {
  const [f, setF] = React.useState({ handle: acc.handle, display_name: acc.display_name || '', lang: acc.lang || '', role: acc.role || 'brand', organization_id: acc.organization_id, is_automated: !!acc.is_automated })
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null)
  const set = (k) => (v) => setF({ ...f, [k]: v })
  const run = async (fn, ok) => { setErr(null); setMsg(null); try { await fn(); setMsg(ok) } catch (e) { setErr(e.message) } }
  return h('div', { style: S.col },
    h(SelectField, { label: tr('tab.org'), value: String(f.organization_id || ''), options: [...(f.organization_id ? [] : [['', '—']]), ...tree.organizations.map((o) => [String(o.id), o.name])], onChange: (v) => setF({ ...f, organization_id: Number(v) }) }),
    h(TextField, { label: tr('settings.networkHandle', { network: NET_LABEL(acc.network) }), value: f.handle, onChange: set('handle'), hint: tr('settings.handleHint') }),
    h(TextField, { label: tr('settings.displayName'), value: f.display_name, onChange: set('display_name') }),
    h(TextField, { label: tr('settings.lang'), value: f.lang, onChange: set('lang'), hint: tr('settings.langHint') }),
    h(SelectField, { label: tr('settings.role'), value: f.role, options: ROLES(), onChange: set('role') }),
    h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 } }, h('input', { type: 'checkbox', checked: f.is_automated, onChange: (e) => set('is_automated')(e.target.checked) }), tr('settings.automated')),
    h(Muted, null, tr(acc.requires_validation ? 'settings.validationRequired' : 'settings.validationNo', { n: acc.posts })),
    err ? h(Err, { error: err }) : null,
    h('div', { style: S.row },
      h(Btn, { onClick: () => run(async () => { await api.patch(`accounts/${acc.id}`, f); onTree() }, tr('settings.saved')) }, tr('common.save')),
      h(Btn, { variant: 'outline', disabled: acc.posts > 0, title: acc.posts ? tr('settings.accountHasPosts') : undefined, onClick: () => { if (window.confirm(tr('settings.deleteAccountConfirm', { handle: acc.handle }))) run(async () => { await api.post(`accounts/${acc.id}/delete`, {}); onGone() }, '') } }, tr('common.delete')),
      msg ? h(Muted, null, msg) : null))
}

// ---------- comment campaigns of an account (Settings › account › Comments) ----------
// A campaign holds the pains the account answers (the reader's words, the searches that find them, examples, the
// verified way out) and its limits. Empty limits follow the defaults of the studio. It starts off.
const lines = (a) => (Array.isArray(a) ? a.join('\n') : '')
const numField = (v) => (v == null ? '' : String(v))
function CampaignForm({ api, k, onSaved }) {
  const init = () => ({ name: k.name, active: !!k.active, langs: (k.langs || []).join(', '), max_replies_per_day: numField(k.max_replies_per_day), min_gap_min: numField(k.min_gap_min),
    same_author_days: numField(k.same_author_days), search_budget_usd: numField(k.search_budget_usd), active_hours: k.active_hours || '', max_author_followers: numField(k.max_author_followers), notes: k.notes || '' })
  const [f, setF] = React.useState(init)
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { setF(init()) }, [k.id, k.updated_at])
  const set = (key) => (v) => setF({ ...f, [key]: v })
  const save = async () => { setBusy(true); setErr(null); setMsg(null); try { await api.patch(`comments/campaigns/${k.id}`, f); setMsg(tr('settings.saved')); onSaved() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const activePains = (k.pains || []).filter((p) => p.active).length
  const num = (key, label, hint) => h(TextField, { label, value: f[key], onChange: set(key), hint, placeholder: '—' })
  return h('div', { style: { ...S.col, gap: 10 } },
    h('label', { style: { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 500 } },
      h(Switch, { checked: f.active, onCheckedChange: set('active'), 'aria-label': tr('campaign.active') }), tr('campaign.active')),
    f.active && !activePains ? h(Muted, { style: { color: tok('warning') } }, tr('campaign.noActivePain')) : null,
    h(TextField, { label: tr('settings.name'), value: f.name, onChange: set('name') }),
    h(TextField, { label: tr('campaign.langs'), value: f.langs, onChange: set('langs'), hint: tr('campaign.langsHint'), placeholder: 'en' }),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 } },
      num('max_replies_per_day', tr('campaign.perDay')),
      num('min_gap_min', tr('campaign.gap')),
      num('same_author_days', tr('campaign.sameAuthor')),
      num('search_budget_usd', tr('campaign.budget')),
      h(TextField, { label: tr('campaign.hours'), value: f.active_hours, onChange: set('active_hours'), placeholder: '08-20', hint: tr('campaign.hoursHint') }),
      num('max_author_followers', tr('campaign.followers'))),
    h(Muted, null, tr('campaign.limitsHint')),
    h(TextField, { label: tr('settings.notes'), value: f.notes, onChange: set('notes'), multiline: true, rows: 2 }),
    err ? h(Err, { error: err }) : null,
    h('div', { style: S.row }, h(Btn, { disabled: busy || !f.name.trim(), onClick: save }, busy ? tr('common.saving') : tr('campaign.save')), msg ? h(Muted, null, msg) : null))
}
function PainForm({ api, campaignId, p, onSaved, onCancel }) {
  const init = () => (p ? { pain: p.pain, queries: lines(p.queries), examples_positive: lines(p.examples_positive), examples_negative: lines(p.examples_negative),
    solution: p.solution || '', solution_source: p.solution_source || '', evidence: p.evidence || '', active: !!p.active }
    : { pain: '', queries: '', examples_positive: '', examples_negative: '', solution: '', solution_source: '', evidence: '', active: true })
  const [f, setF] = React.useState(init)
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const set = (key) => (v) => setF({ ...f, [key]: v })
  const save = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try { if (p) await api.patch(`comments/pains/${p.id}`, f); else await api.post(`comments/campaigns/${campaignId}/pains`, f); setMsg(tr('settings.saved')); onSaved(!p) } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return h('div', { style: { ...S.card, ...S.col, gap: 10, padding: 14 } },
    h('div', { style: D.between },
      h('b', { style: { fontSize: 13 } }, p ? tr('campaign.painN', { id: p.id }) : tr('campaign.newPain')),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        p && p.candidates ? h(Muted, null, tr('campaign.painCandidates', { n: p.candidates })) : null,
        h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 } }, h(Switch, { checked: f.active, onCheckedChange: set('active'), 'aria-label': tr('campaign.painActive') }), tr('campaign.painActive')))),
    h(TextField, { label: tr('campaign.pain'), value: f.pain, onChange: set('pain'), multiline: true, rows: 2, hint: tr('campaign.painHint') }),
    h(TextField, { label: tr('campaign.queries'), value: f.queries, onChange: set('queries'), multiline: true, rows: 3, hint: tr('campaign.queriesHint') }),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 } },
      h(TextField, { label: tr('campaign.examplesPos'), value: f.examples_positive, onChange: set('examples_positive'), multiline: true, rows: 3, hint: tr('campaign.oneLine') }),
      h(TextField, { label: tr('campaign.examplesNeg'), value: f.examples_negative, onChange: set('examples_negative'), multiline: true, rows: 3, hint: tr('campaign.oneLine') })),
    h(TextField, { label: tr('campaign.solution'), value: f.solution, onChange: set('solution'), multiline: true, rows: 2, hint: tr('campaign.solutionHint') }),
    h(TextField, { label: tr('campaign.source'), value: f.solution_source, onChange: set('solution_source'), hint: tr('campaign.sourceHint') }),
    h(TextField, { label: tr('campaign.evidence'), value: f.evidence, onChange: set('evidence') }),
    err ? h(Err, { error: err }) : null,
    h('div', { style: S.row },
      h(Btn, { disabled: busy || !f.pain.trim(), onClick: save }, busy ? tr('common.saving') : p ? tr('common.save') : tr('campaign.addPain')),
      onCancel ? h(Btn, { variant: 'ghost', onClick: onCancel }, tr('common.cancel')) : null,
      msg ? h(Muted, null, msg) : null))
}
function CampaignsEditor({ ctx, api, acc }) {
  const res = useResource(ctx, api, `comments/campaigns?account=${acc.id}`)
  const [sel, setSel] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const d = res.data
  if (!d) return res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading'))
  const camps = d.campaigns
  const k = camps.find((c) => c.id === sel) || camps[0] || null
  const create = async () => {
    setBusy(true); setErr(null)
    try { const r = await api.post('comments/campaigns', { account_id: acc.id, name: camps.length ? tr('campaign.newName', { n: camps.length + 1 }) : tr('campaign.defaultName') }); setSel(r.id); res.reload() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return h('div', { style: { ...S.col, gap: 12 } },
    h(Muted, null, tr('campaign.help', { handle: acc.handle })),
    err ? h(Err, { error: err }) : null,
    !k ? h('div', null, h(Btn, { disabled: busy, onClick: create }, tr('campaign.create'))) : h('div', { style: { ...S.row, gap: 4 } },
      ...camps.map((c) => h('button', { key: c.id, type: 'button', onClick: () => { setSel(c.id); setAdding(false) }, style: { ...navBtn(c.id === k.id), width: 'auto' } },
        h('span', { style: D.dot(c.active ? tok('success') : V.mutedFg) }), c.name)),
      h('button', { type: 'button', style: { ...S.link, marginLeft: 8 }, disabled: busy, onClick: create }, tr('campaign.another'))),
    k ? h(CampaignForm, { key: k.id, api, k, onSaved: res.reload }) : null,
    k ? h('h3', { style: { ...S.h2, fontSize: 14, marginTop: 8 } }, tr('campaign.pains', { n: k.pains.length })) : null,
    k ? h(Muted, null, tr('campaign.painsHelp')) : null,
    ...(k ? k.pains.map((p) => h(PainForm, { key: `${p.id}`, api, campaignId: k.id, p, onSaved: res.reload })) : []),
    k && adding ? h(PainForm, { key: 'new', api, campaignId: k.id, p: null, onSaved: () => { setAdding(false); res.reload() }, onCancel: () => setAdding(false) }) : null,
    k && !adding ? h('div', null, h(Btn, { variant: 'outline', onClick: () => setAdding(true) }, tr('campaign.addPain'))) : null)
}

// ---------- competitors and their teams (Settings › Competitors, shared by the installation) ----------
// A member of a competitor's team (founder, developer, employee, official account) is never replied to nor quoted,
// and a competitor's names and aliases never appear in a post: the database refuses it.
const TEAM_ROLES = ['official', 'founder', 'employee', 'developer', 'contributor', 'other']
const roleOptions = () => TEAM_ROLES.map((r) => [r, tr(`team.role.${r}`)])
function CompetitorCard({ api, c, onChanged }) {
  const [f, setF] = React.useState({ name: c.name, website: c.website || '', active: !!c.active })
  const [alias, setAlias] = React.useState('')
  const [m, setM] = React.useState({ handle: '', role: 'developer', source: '' })
  const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { setF({ name: c.name, website: c.website || '', active: !!c.active }) }, [c.name, c.website, c.active])
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); onChanged() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const dirty = f.name !== c.name || f.website !== (c.website || '') || f.active !== !!c.active
  const x = (label, onClick) => h('button', { type: 'button', onClick, disabled: busy, 'aria-label': label, title: label, style: { border: 0, background: 'transparent', color: V.mutedFg, cursor: 'pointer', padding: 0, display: 'inline-flex' } }, h(Icon, { name: 'x', size: 12 }))
  return h('section', { style: { ...S.card, ...S.col, gap: 10, padding: 14, opacity: c.active ? 1 : 0.7 } },
    h('div', { style: { ...S.row, alignItems: 'flex-end' } },
      h('div', { style: { flex: 2, minWidth: 160 } }, h(TextField, { label: tr('settings.name'), value: f.name, onChange: (v) => setF({ ...f, name: v }) })),
      h('div', { style: { flex: 3, minWidth: 180 } }, h(TextField, { label: tr('competitors.website'), value: f.website, onChange: (v) => setF({ ...f, website: v }) })),
      h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, paddingBottom: 6 } }, h('input', { type: 'checkbox', checked: f.active, onChange: (e) => setF({ ...f, active: e.target.checked }) }), tr('competitors.active')),
      dirty ? h(Btn, { disabled: busy || !f.name.trim(), onClick: () => run(() => api.patch(`competitors/${c.id}`, f)) }, tr('common.save')) : null),
    h('div', { style: S.col },
      h('span', { style: { fontSize: 12, fontWeight: 600, color: V.mutedFg } }, tr('competitors.aliases')),
      h('div', { style: { ...S.row, gap: 6 } },
        ...c.aliases.map((a) => h(Tag, { key: a }, a, x(tr('competitors.removeAlias', { alias: a }), () => run(() => api.post(`competitors/${c.id}/aliases/remove`, { alias: a }))))),
        h('input', { value: alias, onChange: (e) => setAlias(e.target.value), placeholder: tr('competitors.aliasPlaceholder'), 'aria-label': tr('competitors.aliasLabel'), style: { ...S.input, padding: '3px 8px', fontSize: 12, width: 160 },
          onKeyDown: (e) => { if (e.key === 'Enter' && alias.trim()) run(async () => { await api.post(`competitors/${c.id}/aliases`, { alias }); setAlias('') }) } }))),
    h('div', { style: S.col },
      h('span', { style: { fontSize: 12, fontWeight: 600, color: V.mutedFg } }, tr('competitors.team', { n: c.team.length })),
      c.team.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 120px minmax(0, 2fr) 20px', gap: '4px 10px', alignItems: 'center', fontSize: 12 } },
        ...c.team.flatMap((t) => [
          h('a', { key: `h${t.handle}`, href: t.network === 'x' ? `https://x.com/${t.handle}` : undefined, target: '_blank', rel: 'noreferrer', style: { color: V.fg, textDecoration: 'none', fontWeight: 500 } }, `@${t.handle}`),
          h('span', { key: `r${t.handle}` }, tr(`team.role.${t.role}`)),
          h(Muted, { key: `s${t.handle}`, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.source || ''),
          h('span', { key: `x${t.handle}` }, x(tr('competitors.removeMember', { handle: t.handle }), () => { if (window.confirm(tr('competitors.removeConfirm', { handle: t.handle, name: c.name }))) run(() => api.post(`competitors/${c.id}/team/remove`, { handle: t.handle, network: t.network })) })),
        ])) : h(Muted, null, tr('competitors.noTeam')),
      h('div', { style: { ...S.row, gap: 6 } },
        h('input', { value: m.handle, onChange: (e) => setM({ ...m, handle: e.target.value }), placeholder: '@handle', 'aria-label': tr('competitors.handleLabel'), style: { ...S.input, width: 150 } }),
        h('select', { value: m.role, onChange: (e) => setM({ ...m, role: e.target.value }), 'aria-label': tr('competitors.roleLabel'), style: S.input }, ...roleOptions().map(([v, l]) => h('option', { key: v, value: v }, l))),
        h('input', { value: m.source, onChange: (e) => setM({ ...m, source: e.target.value }), placeholder: tr('competitors.sourcePlaceholder'), 'aria-label': tr('competitors.sourceLabel'), style: { ...S.input, flex: 1, minWidth: 140 } }),
        h(Btn, { variant: 'outline', disabled: busy || !m.handle.trim(), onClick: () => run(async () => { await api.post(`competitors/${c.id}/team`, m); setM({ ...m, handle: '', source: '' }) }) }, tr('competitors.addMember')))),
    err ? h(Err, { error: err }) : null)
}
function AffiliatedRow({ api, a, competitors, onChanged }) {
  const [cid, setCid] = React.useState(competitors[0] ? String(competitors[0].id) : '')
  const [role, setRole] = React.useState('employee')
  const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const add = async () => {
    setBusy(true); setErr(null)
    try { await api.post(`competitors/${cid}/team`, { handle: a.handle, network: a.network, role, source: trunc(`comment candidate #${a.candidate_id}: ${a.dismiss_reason || a.reason || a.author_affiliation}`, 300) }); onChanged() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return h('div', { style: { ...S.card, ...S.col, gap: 6 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h(Avatar, { url: a.avatar_url, name: a.author_name || a.handle, size: 28 }),
      h('div', { style: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: '16px' } },
        h('b', null, a.author_name || `@${a.handle}`), h('span', { style: { color: V.mutedFg } }, ` @${a.handle} · ${tr('competitors.foundBy', { account: a.account })}`)),
      h(Tag, { color: a.author_affiliation === 'competitor' ? tok('destructive') : tok('warning') }, tr(`competitors.affiliation.${a.author_affiliation}`)),
      a.item_url ? h('a', { href: a.item_url, target: '_blank', rel: 'noreferrer', title: tr('source.viewOnX'), 'aria-label': tr('source.viewOnX'), style: { color: V.mutedFg, display: 'inline-flex' } }, h(Icon, { name: 'external' })) : null),
    a.dismiss_reason || a.reason ? h(Muted, null, trunc(a.dismiss_reason || a.reason, 220)) : null,
    a.item_text ? h('div', { style: { fontSize: 12, lineHeight: '17px' } }, trunc(unescapeX(a.item_text), 220)) : null,
    competitors.length ? h('div', { style: { ...S.row, gap: 6 } },
      h('select', { value: cid, onChange: (e) => setCid(e.target.value), 'aria-label': tr('competitors.whichLabel'), style: { ...S.input, padding: '3px 6px', fontSize: 12 } }, ...competitors.map((c) => h('option', { key: c.id, value: String(c.id) }, c.name))),
      h('select', { value: role, onChange: (e) => setRole(e.target.value), 'aria-label': tr('competitors.roleLabel'), style: { ...S.input, padding: '3px 6px', fontSize: 12 } }, ...roleOptions().map(([v, l]) => h('option', { key: v, value: v }, l))),
      h(Btn, { variant: 'outline', disabled: busy || !cid, onClick: add }, tr('competitors.addToTeam'))) : null,
    err ? h(Err, { error: err }) : null)
}
function Competitors({ ctx, api }) {
  const res = useResource(ctx, api, 'competitors')
  const [f, setF] = React.useState({ name: '', website: '' })
  const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const d = res.data
  if (!d) return res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading'))
  const create = async () => { setBusy(true); setErr(null); try { await api.post('competitors', f); setF({ name: '', website: '' }); res.reload() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  return h('div', { style: { ...S.col, gap: 14, maxWidth: 760 } },
    h('div', null, h('h2', { style: { ...S.h2, fontSize: 17 } }, tr('settings.competitors')), h(Muted, null, tr('competitors.help'))),
    d.affiliated.length ? h('div', { style: S.col },
      h('h3', { style: { ...S.h2, fontSize: 14 } }, tr('competitors.affiliatedTitle', { n: d.affiliated.length })),
      h(Muted, null, tr('competitors.affiliatedHelp')),
      ...d.affiliated.map((a) => h(AffiliatedRow, { key: `${a.network}:${a.handle}`, api, a, competitors: d.competitors, onChanged: res.reload }))) : null,
    d.competitors.length ? null : h(Muted, null, tr('competitors.none')),
    ...d.competitors.map((c) => h(CompetitorCard, { key: c.id, api, c, onChanged: res.reload })),
    h('div', { style: { ...S.card, ...S.col, gap: 8, padding: 14 } },
      h('b', { style: { fontSize: 13 } }, tr('competitors.add')),
      h('div', { style: { ...S.row, alignItems: 'flex-end' } },
        h('div', { style: { flex: 2, minWidth: 160 } }, h(TextField, { label: tr('settings.name'), value: f.name, onChange: (v) => setF({ ...f, name: v }) })),
        h('div', { style: { flex: 3, minWidth: 180 } }, h(TextField, { label: tr('competitors.website'), value: f.website, onChange: (v) => setF({ ...f, website: v }) })),
        h(Btn, { disabled: busy || !f.name.trim(), onClick: create }, tr('settings.add'))),
      err ? h(Err, { error: err }) : null))
}

// ---------- learning ----------
// The user's feedback (rejections, rewrites asked, direct edits of the text) is read by the agent before each
// writing; every week it draws rules from it, which apply at once unless automatic acceptance is off; any rule can be revoked.
const FB_SOURCE = ['reject', 'rewrite', 'edit']
// prefix of a feedback text written by the host (English since v6, French before): hidden in the list
const FEEDBACK_PREFIX = /^(Rejected|Comment rejected|Rewrite requested|Rejet|R\S+criture demand\S+) ?: /
function Learning({ ctx, api, account = null }) {
  const res = useResource(ctx, api, `learnings?limit=60${account ? `&account=${account}` : ''}`)
  const [msg, setMsg] = React.useState(null); const [notes, setNotes] = React.useState({}); const [busy, setBusy] = React.useState(null)
  const d = res.data
  const run = async (key, fn) => { setBusy(key); setMsg(null); try { await fn() } catch (e) { setMsg(e.message) } finally { setBusy(null) } }
  if (!d) return h('div', { style: { ...S.col, marginTop: 24 } }, h('h2', { style: S.h2 }, tr('tab.learning')), res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading')))
  const rules = d.rules || []; const learnings = d.learnings || []
  const open = rules.filter((r) => r.status === 'proposed'); const applied = rules.filter((r) => r.status === 'accepted'); const decided = rules.filter((r) => r.status === 'refused' || r.status === 'revoked')
  const autoPath = account ? `scope/account/${account}/settings` : 'scope/global/0/settings'
  return h('div', { style: { ...S.col, marginTop: 24 } },
    h('h2', { style: S.h2 }, tr('tab.learning')),
    h(Muted, null, tr('learning.help')),
    msg ? h(Err, { error: msg }) : null,
    h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: !!d.auto_accept, disabled: !!busy, onChange: (e) => run('auto', () => api.post(autoPath, { changes: { rules_auto_accept: e.target.checked ? '1' : '0' } })) }), tr('learning.autoAccept')),
    h('b', { style: { fontSize: 13, marginTop: 6 } }, open.length ? tr('learning.proposedN', { n: open.length }) : tr('learning.proposed')),
    open.length ? null : h(Muted, null, tr('learning.noneProposed')),
    ...open.map((r) => h('div', { key: `r${r.id}`, style: { ...S.card, ...S.col } },
      h('div', { style: { fontSize: 13, fontWeight: 500 } }, r.account ? h(Chip, { color: V.primary }, `@${r.account}`) : h(Chip, { color: V.mutedFg }, tr('common.allAccounts')), ' ', r.text),
      r.rationale ? h(Muted, null, r.rationale) : null,
      r.evidence.length ? h(Muted, null, tr('learning.evidence', { ids: r.evidence.map((x) => `#${x}`).join(', ') })) : null,
      h('input', { value: notes[r.id] || '', onChange: (e) => setNotes({ ...notes, [r.id]: e.target.value }), placeholder: tr('learning.notePlaceholder'), style: S.input, 'aria-label': tr('learning.noteLabel') }),
      h('div', { style: S.row },
        h(Btn, { disabled: !!busy, onClick: () => run(`a${r.id}`, () => api.post(`rules/${r.id}/accept`, { note: notes[r.id] || '' })) }, busy === `a${r.id}` ? tr('common.sending') : tr('learning.accept')),
        h(Btn, { variant: 'outline', disabled: !!busy, onClick: () => run(`f${r.id}`, () => api.post(`rules/${r.id}/refuse`, { note: notes[r.id] || '' })) }, tr('learning.refuse'))))),
    applied.length ? h('b', { style: { fontSize: 13, marginTop: 6 } }, tr('learning.appliedN', { n: applied.length })) : null,
    ...applied.map((r) => h('div', { key: `x${r.id}`, style: { ...S.card, ...S.row, justifyContent: 'space-between', fontSize: 13 } },
      h('div', null, r.account ? h(Chip, { color: V.primary }, `@${r.account}`) : h(Chip, { color: V.mutedFg }, tr('common.allAccounts')), ' ', r.decision_note === 'auto' ? h(Chip, { color: tok('success') }, tr('learning.auto')) : null, ' ', r.text),
      h(Btn, { variant: 'outline', disabled: !!busy, onClick: () => run(`v${r.id}`, async () => { const out = await api.post(`rules/${r.id}/revoke`, {}); if (out && out.warning) setMsg(out.warning) }) }, busy === `v${r.id}` ? tr('common.sending') : tr('learning.revoke')))),
    decided.length ? h('details', null, h('summary', { style: { cursor: 'pointer', fontSize: 12, color: V.mutedFg } }, tr('learning.decided', { n: decided.length })),
      ...decided.map((r) => h('div', { key: `d${r.id}`, style: { fontSize: 12, padding: '4px 0' } }, h(Chip, { color: V.mutedFg }, r.status === 'revoked' ? tr('learning.revoked') : tr('learning.refused')), ' ', r.text))) : null,
    h('b', { style: { fontSize: 13, marginTop: 6 } }, tr('learning.latest')),
    learnings.length ? null : h(Muted, null, tr('learning.none')),
    ...learnings.map((l) => h('div', { key: `l${l.id}`, style: { ...S.card, ...S.col, gap: 6, opacity: l.ignored ? 0.55 : 1 } },
      h('div', { style: S.row },
        h(Chip, { color: l.source === 'reject' ? tok('destructive') : l.source === 'edit' ? tok('info') : V.primary }, FB_SOURCE.includes(l.source) ? tr(`fbsource.${l.source}`) : l.source),
        l.post_kind === 'reply' ? h(Chip, { color: V.mutedFg }, tr('learning.comment')) : null,
        h(Muted, null, `#${l.id} · ${fmt(l.created_at)}${l.account ? ` · @${l.account}` : ''}${l.post_id ? ` · ${tr('learning.post', { id: l.post_id })}` : ''}`),
        h('span', { style: { marginLeft: 'auto' } }),
        h('select', { value: l.category || '', onChange: (e) => run(`c${l.id}`, () => api.post(`learnings/${l.id}`, { category: e.target.value || null })), style: { ...S.input, padding: '2px 6px', fontSize: 12 }, 'aria-label': tr('learning.category') },
          h('option', { value: '' }, tr('learning.noCategory')), ...FB_CATEGORIES.map((k) => h('option', { key: k, value: k }, tr(`fb.${k}`)))),
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: V.mutedFg, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: !!l.ignored, onChange: (e) => run(`i${l.id}`, () => api.post(`learnings/${l.id}`, { ignored: e.target.checked })) }), tr('learning.ignore'))),
      l.source === 'edit'
        ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 } },
          h('div', null, h(Muted, null, tr('learning.agentText')), h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 2 } }, trunc(l.before_text, 400))),
          h('div', null, h(Muted, null, tr('learning.yourVersion')), h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 2 } }, trunc(l.after_text, 400))))
        : h('div', { style: { fontSize: 13 } }, l.text.replace(FEEDBACK_PREFIX, '')))))
}

// ---------- set up (first launch) ----------
// Six steps, the same as the conversational path (setup skill): agent, accounts, writing, optional connectors,
// optional import, test draft. The plugin never edits timon.config.json: it shows the lines the user adds.
const SETUP_STEPS = [
  ['agent', () => tr('setup.step.agent')], ['accounts', () => tr('setup.step.accounts')], ['writing', () => tr('setup.step.writing')],
  ['connectors', () => tr('setup.step.connectors')], ['import', () => tr('setup.step.import')], ['test', () => tr('setup.step.test')],
]
const WRITING_LABELS = { voice: () => tr('setup.writing.voice'), rules: () => tr('setup.writing.rules'), post_types: () => tr('setup.writing.types'), original_suggest_prompt: () => tr('setup.writing.suggest'), original_write_prompt: () => tr('setup.writing.write'), triage_prompt: () => tr('setup.writing.triage') }
const Code = ({ children }) => h('pre', { style: { margin: 0, padding: '8px 10px', borderRadius: 8, background: V.muted, fontSize: 12, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, children)
const missionLink = (id) => h('a', { href: `/chat?mission=${encodeURIComponent(id)}`, style: S.link }, tr('setup.openMission'))
/** Writes a plugin setting (the agent, its Node command) through the browser settings API. */
async function setSetting(ctx, key, value) {
  const r = await ctx.settings.set(key, value)
  if (r && r.ok === false) throw new Error(tr('setup.settingRefused', { key }))
}

function SetupAgent({ ctx, api, d, reload }) {
  const [pick, setPick] = React.useState(d.agent.name || '')
  const backends = d.backends || []
  const [f, setF] = React.useState(() => { const b = backends.find((x) => x.id === d.defaultBackend) || backends[0]; return { name: 'growth-studio.writer', backend: b ? b.id : '', model: b ? b.defaultModel || b.models[0] || '' : '' } })
  const [node, setNode] = React.useState(d.agent.check.agentNode || '')
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const run = async (fn) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); reload() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const backend = backends.find((b) => b.id === f.backend)
  const check = d.agent.check
  const checkChip = { ok: [tok('success'), tr('setup.agent.checkOk', { node: check.node || '?' })], pending: [tok('info'), tr('setup.agent.checkPending')], failed: [tok('destructive'), tr('setup.agent.checkFailed')], old: [tok('destructive'), tr('setup.agent.checkOld', { node: check.node || '?' })], none: [tok('warning'), tr('setup.agent.checkNone')] }[check.state] || [V.mutedFg, check.state]
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.agent.help')),
    h('div', { style: { ...S.card, ...S.col } },
      h('b', null, tr('setup.agent.current')),
      h('div', { style: S.row }, d.agent.name ? h('code', null, d.agent.name) : h(Muted, null, tr('setup.agent.none')),
        d.agent.name && d.agent.exists === false ? h(Chip, { color: tok('destructive') }, tr('setup.agent.unknown')) : null,
        d.agent.info ? h(Muted, null, `${d.agent.info.backend}${d.agent.info.model ? ` · ${d.agent.info.model}` : ''}`) : null),
      d.agents && d.agents.length
        ? h(SelectField, { label: tr('setup.agent.choose'), value: pick, options: [['', '—'], ...d.agents.map((a) => [a.name, `${a.name} (${a.backend}${a.model ? ` · ${a.model}` : ''})`])], onChange: setPick })
        : h(TextField, { label: tr('setup.agent.chooseName'), value: pick, onChange: setPick, hint: d.agentsError || tr('setup.agent.chooseHint') }),
      h('div', null, h(Btn, { disabled: busy || !pick.trim() || pick === d.agent.name, onClick: () => run(() => setSetting(ctx, 'agent', pick.trim())) }, tr('setup.agent.use')))),
    h('div', { style: { ...S.card, ...S.col } },
      h('b', null, tr('setup.agent.create')),
      d.canCreateAgent ? [
        h(Muted, { key: 'h' }, tr('setup.agent.createHelp', { role: d.role })),
        h(TextField, { key: 'n', label: tr('setup.agent.name'), value: f.name, onChange: (v) => setF({ ...f, name: v }) }),
        backends.length ? h(SelectField, { key: 'b', label: tr('setup.agent.provider'), value: f.backend, options: backends.map((b) => [b.id, `${b.label}${b.signedIn === false ? ` (${tr('setup.agent.signedOut')})` : ''}`]), onChange: (v) => { const b = backends.find((x) => x.id === v); setF({ ...f, backend: v, model: b ? b.defaultModel || b.models[0] || '' : '' }) } })
          : h(Muted, { key: 'b' }, tr('setup.agent.noBackends')),
        backend && backend.models.length ? h(SelectField, { key: 'm', label: tr('setup.agent.model'), value: f.model, options: backend.models.map((m) => [m, m]), onChange: (v) => setF({ ...f, model: v }) }) : null,
        h('div', { key: 'c' }, h(Btn, { disabled: busy || !f.name.trim(), onClick: () => run(async () => { const r = await api.post('setup/agent', f); await setSetting(ctx, 'agent', r.agent.name); setPick(r.agent.name); setMsg(tr('setup.agent.created', { name: r.agent.name })) }) }, tr('setup.agent.createBtn'))),
      ] : h(Muted, null, tr('setup.agent.createManual')),
      h('div', null, h('a', { href: '/agents', style: S.link }, tr('setup.agent.agentsPage')))),
    h('div', { style: { ...S.card, ...S.col } },
      h('b', null, tr('setup.agent.check')),
      h(Muted, null, tr('setup.agent.checkHelp')),
      h('div', { style: S.row }, h(Chip, { color: checkChip[0] }, checkChip[1]), check.missionId ? missionLink(check.missionId) : null,
        h(Btn, { variant: check.state === 'ok' ? 'outline' : 'default', disabled: busy || !d.agent.name, onClick: () => run(() => api.post('setup/agent/check', {})) }, tr(check.state === 'none' ? 'setup.agent.checkBtn' : 'setup.agent.checkAgain'))),
      ['failed', 'old'].includes(check.state) ? h('div', { style: { ...S.col, gap: 6, fontSize: 12 } },
        h('div', null, tr('setup.agent.fixIntro')),
        h('div', null, tr('setup.agent.fix1')), h('div', null, tr('setup.agent.fix2')), h('div', null, tr('setup.agent.fix3'))) : null,
      h(Muted, null, tr('setup.agent.runtime')), h(Code, null, check.nodeCommand),
      h(TextField, { label: tr('setup.agent.nodeLabel'), value: node, onChange: setNode, placeholder: 'node', hint: tr('setup.agent.nodeHint') }),
      h('div', null, h(Btn, { variant: 'outline', disabled: busy || node.trim() === (check.agentNode || ''), onClick: () => run(() => setSetting(ctx, 'agentNode', node.trim())) }, tr('common.save')))),
    err ? h(Err, { error: err }) : null, msg ? h(Muted, null, msg) : null)
}

function SetupAccounts({ api, d, reload }) {
  const org = d.organizations[0] || null
  const [f, setF] = React.useState({ org: '', network: 'x', handle: '', display_name: '', lang: 'en', role: 'personal' })
  const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  const set = (k) => (v) => setF({ ...f, [k]: v })
  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const oid = org ? org.id : (await api.post('orgs', { name: f.org })).id
      await api.post('accounts', { organization_id: oid, network: f.network, handle: f.handle, display_name: f.display_name, lang: f.lang, role: f.role })
      reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.accounts.help')),
    d.organizations.map((o) => h('div', { key: o.id, style: { ...S.card, ...S.col, gap: 4 } }, h('b', null, o.name),
      o.accounts.length ? o.accounts.map((a) => h('div', { key: a.id, style: S.row }, h('span', null, `@${a.handle}`), h(Muted, null, `${NET_LABEL(a.network)} · ${a.lang || '—'} · ${a.role || '—'}`))) : h(Muted, null, tr('setup.accounts.noAccount')))),
    d.accounts ? h(Muted, null, tr('setup.accounts.more')) : h('div', { style: { ...S.card, ...S.col } },
      org ? null : h(TextField, { label: tr('setup.accounts.org'), value: f.org, onChange: set('org'), hint: tr('setup.accounts.orgHint') }),
      h(SelectField, { label: tr('settings.network'), value: f.network, options: d.networks.map((n) => [n.id, n.name]), onChange: set('network') }),
      h(TextField, { label: tr('settings.handle'), value: f.handle, onChange: set('handle'), placeholder: 'handle' }),
      h(TextField, { label: tr('settings.displayName'), value: f.display_name, onChange: set('display_name') }),
      h(TextField, { label: tr('settings.lang'), value: f.lang, onChange: set('lang'), hint: tr('settings.langHint') }),
      h(SelectField, { label: tr('settings.role'), value: f.role, options: ROLES(), onChange: set('role') }),
      h('div', null, h(Btn, { disabled: busy || !f.handle.trim() || (!org && !f.org.trim()), onClick: save }, tr('setup.accounts.create')))),
    err ? h(Err, { error: err }) : null)
}

function SetupWriting({ ctx, api, d, reload, converse }) {
  const w = d.writing
  const path = w ? `scope/account/${w.account.id}/settings` : null
  const [voice, setVoice] = React.useState(null)
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { if (path) api.get(path).then((v) => setVoice(v.own.voice || '')).catch((e) => setErr(e.message)) }, [path, w && w.filled.voice])
  if (!w) return h(Muted, null, tr('setup.writing.needAccount'))
  const run = async (fn, ok) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); setMsg(ok); reload() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.writing.help', { handle: w.account.handle })),
    h('div', { style: { ...S.card, ...S.col, gap: 4 } }, d.writingKeys.map((k) => h('div', { key: k, style: S.row },
      h(Chip, { color: w.filled[k] ? tok('success') : tok('warning') }, tr(w.filled[k] ? 'setup.writing.set' : 'setup.writing.empty')), h('span', null, WRITING_LABELS[k] ? WRITING_LABELS[k]() : k)))),
    h('div', { style: S.row },
      h(Btn, { disabled: busy, onClick: () => run(async () => { const r = await api.post('setup/starter', { account_id: w.account.id }); if (!r.written.length) throw new Error(tr('setup.writing.nothing')) }, tr('setup.writing.starterDone')) }, tr('setup.writing.starter')),
      h(Btn, { variant: 'outline', disabled: busy || !d.agent.name, onClick: () => converse('writing') }, tr('setup.writing.withAgent'))),
    h(Muted, null, tr('setup.writing.starterHelp')),
    voice === null ? h(Muted, null, tr('common.loading')) : h(TextField, { label: tr('setup.writing.voice'), value: voice, onChange: setVoice, multiline: true, rows: 10, hint: tr('setup.writing.voiceHint') }),
    h('div', null, h(Btn, { variant: 'outline', disabled: busy || voice === null, onClick: () => run(() => api.post(path, { changes: {}, voice }), tr('voice.saved')) }, tr('voice.save'))),
    err ? h(Err, { error: err }) : null, msg ? h(Muted, null, msg) : null)
}

function SetupConnectors({ d }) {
  const [copied, setCopied] = React.useState(false)
  const state = (c) => (c.ok === true ? [tok('success'), tr('setup.connectors.ready')] : c.ok === false ? [tok('warning'), tr('setup.connectors.missing')] : [V.mutedFg, tr('setup.connectors.unknown')])
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.connectors.help')),
    d.connectors.map((c) => {
      const [color, label] = state(c)
      return h('div', { key: c.id, style: { ...S.card, ...S.col, gap: 6 } },
        h('div', { style: S.row }, h('b', null, c.label), h(Chip, { color }, label), h(Muted, null, (c.features || []).join(', '))),
        c.hint ? h(Muted, null, c.hint) : null,
        c.guide.exec.length || c.guide.http.length ? h('div', { style: { fontSize: 12 } }, tr('setup.connectors.policy'),
          c.guide.exec.length ? h(Code, null, `"exec": { "allow": ${JSON.stringify(c.guide.exec)} }`) : null,
          c.guide.http.length ? h(Code, null, `"http": { "allow": ${JSON.stringify(c.guide.http)} }`) : null) : h(Muted, null, tr('setup.connectors.noPolicy')),
        c.guide.secrets.length ? h('div', { style: { ...S.col, gap: 4, fontSize: 12 } }, tr('setup.connectors.secrets'),
          ...c.guide.secrets.map((s) => h(Code, { key: s.name }, s.set))) : null)
    }),
    h('div', { style: { ...S.card, ...S.col, gap: 6 } },
      h('b', null, tr('setup.connectors.block')),
      h(Muted, null, tr('setup.connectors.blockHelp')),
      h(Code, null, d.policy),
      h('div', null, h(Btn, { variant: 'outline', onClick: () => { try { navigator.clipboard.writeText(d.policy).then(() => setCopied(true)) } catch { /* no clipboard */ } } }, tr(copied ? 'setup.connectors.copied' : 'setup.connectors.copy')))))
}

function SetupImport({ api, d, reload }) {
  const [f, setF] = React.useState({ path: '', media_dir: '' })
  const [err, setErr] = React.useState(null); const [msg, setMsg] = React.useState(null); const [busy, setBusy] = React.useState(false)
  if (!d.admin) return h(Muted, null, tr('setup.import.admin'))
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.import.help')),
    d.data.source === 'legacy' || d.data.fallback ? h(Muted, null, tr('setup.import.legacy')) : null,
    h(TextField, { label: tr('setup.import.path'), value: f.path, onChange: (v) => setF({ ...f, path: v }), placeholder: '/path/to/growth.db' }),
    h(TextField, { label: tr('setup.import.media'), value: f.media_dir, onChange: (v) => setF({ ...f, media_dir: v }), hint: tr('setup.import.mediaHint') }),
    h('div', null, h(Btn, { disabled: busy || !f.path.trim(), onClick: async () => {
      if (!window.confirm(tr('setup.import.confirm'))) return
      setBusy(true); setErr(null); setMsg(null)
      try { const r = await api.post('admin/import', { path: f.path.trim(), media_dir: f.media_dir.trim() || undefined }); setMsg(tr('setup.import.done', { n: (r.counts && r.counts.posts && r.counts.posts.target) || 0 })); reload() } catch (e) { setErr(e.message) } finally { setBusy(false) }
    } }, tr('setup.import.btn'))),
    err ? h(Err, { error: err }) : null, msg ? h(Muted, null, msg) : null)
}

function SetupTest({ api, d, onOpenPost }) {
  const accounts = d.organizations.flatMap((o) => o.accounts)
  const [acc, setAcc] = React.useState(accounts[0] ? String(accounts[0].id) : '')
  const [mission, setMission] = React.useState(null); const [err, setErr] = React.useState(null); const [busy, setBusy] = React.useState(false)
  if (!accounts.length) return h(Muted, null, tr('setup.writing.needAccount'))
  const last = d.test.last
  return h('div', { style: S.col },
    h(Muted, null, tr('setup.test.help')),
    h(SelectField, { label: tr('setup.test.account'), value: acc, options: accounts.map((a) => [String(a.id), `@${a.handle}`]), onChange: setAcc }),
    h('div', { style: S.row }, h(Btn, { disabled: busy || !d.agent.name, onClick: async () => { setBusy(true); setErr(null); try { setMission((await api.post('setup/test', { account_id: Number(acc) })).mission_id) } catch (e) { setErr(e.message) } finally { setBusy(false) } } }, tr('setup.test.btn')),
      mission ? h(Muted, null, tr('setup.test.started')) : null, mission ? missionLink(mission) : null),
    last ? h('div', { style: { ...S.card, ...S.row } }, h('span', null, tr('setup.test.last', { id: last.id, handle: last.handle })), h(StatusChip, { status: last.status }),
      h(Btn, { variant: 'outline', onClick: () => onOpenPost(last.id) }, tr('common.open'))) : null,
    err ? h(Err, { error: err }) : null)
}

function Setup({ ctx, api, onClose, onOpenPost, onChanged, initialStep = null }) {
  const res = useResource(ctx, api, 'setup')
  const d = res.data
  const [step, setStep] = React.useState(initialStep)
  const [conv, setConv] = React.useState(null); const [convErr, setConvErr] = React.useState(null)
  if (!d) return res.error ? h(Err, { error: res.error }) : h(Muted, null, tr('common.loading'))
  const done = Object.fromEntries(d.steps.map((s) => [s.key, s]))
  const current = step || (d.steps.find((s) => s.required && !s.done) || d.steps.find((s) => !s.done) || d.steps[0]).key
  const converse = async (focus = null) => { setConvErr(null); try { setConv((await api.post('setup/converse', focus ? { focus } : {})).mission_id) } catch (e) { setConvErr(e.message) } }
  const props = { ctx, api, d, reload: () => { res.reload(); if (onChanged) onChanged() }, converse, onOpenPost }
  const pane = { agent: SetupAgent, accounts: SetupAccounts, writing: SetupWriting, connectors: SetupConnectors, import: SetupImport, test: SetupTest }[current]
  const ready = d.steps.filter((s) => s.required).every((s) => s.done)
  const idx = SETUP_STEPS.findIndex(([k]) => k === current)
  return h('div', { style: { ...S.col, gap: 16, maxWidth: 1100 } },
    h('div', { style: { ...S.row, justifyContent: 'space-between' } },
      h('div', { style: S.col }, h('h2', { style: { ...S.h2, fontSize: 18 } }, tr('setup.title')), h(Muted, null, tr('setup.intro'))),
      h('div', { style: S.row },
        h(Btn, { variant: 'outline', disabled: !d.agent.name, title: d.agent.name ? undefined : tr('setup.converseNeedsAgent'), onClick: () => converse() }, tr('setup.converse')),
        !d.needed && onClose ? h(Btn, { variant: 'outline', onClick: onClose }, tr('setup.back')) : null)),
    conv ? h('div', { style: { ...S.card, ...S.row } }, h('span', null, tr('setup.converseStarted')), missionLink(conv)) : null,
    convErr ? h(Err, { error: convErr }) : null,
    h('div', { style: { display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 20, alignItems: 'start' } },
      h('nav', { 'aria-label': tr('setup.title'), style: { ...S.col, gap: 2, borderRight: `1px solid ${V.border}`, paddingRight: 12 } },
        SETUP_STEPS.map(([k, label], i) => h('button', { key: k, type: 'button', style: navBtn(current === k), onClick: () => setStep(k) },
          h('span', { style: { width: 18, height: 18, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: done[k].done ? '#fff' : V.mutedFg, background: done[k].done ? tok('success') : V.muted } }, done[k].done ? '✓' : String(i + 1)),
          h('span', null, label()), done[k].required ? null : h(Muted, { style: { fontSize: 11, marginLeft: 'auto' } }, tr('setup.optional'))))),
      h('div', { style: { ...S.col, minWidth: 0 } },
        h('h3', { style: S.h2 }, SETUP_STEPS[idx][1]()),
        h(pane, props),
        h('div', { style: { ...S.row, marginTop: 8, paddingTop: 12, borderTop: `1px solid ${V.border}` } },
          idx > 0 ? h(Btn, { variant: 'outline', onClick: () => setStep(SETUP_STEPS[idx - 1][0]) }, tr('setup.prev')) : null,
          idx < SETUP_STEPS.length - 1 ? h(Btn, { variant: 'outline', onClick: () => setStep(SETUP_STEPS[idx + 1][0]) }, tr('setup.next')) : null,
          h('span', { style: { marginLeft: 'auto' } }),
          ready ? h(Muted, null, tr('setup.ready')) : h(Muted, null, tr('setup.notReady')),
          ready && onClose ? h(Btn, { onClick: onClose }, tr('setup.finish')) : null))))
}

// ---------- studio ----------
/**
 * Read-only banner: shown when the startup update of the database failed or when the database is newer than this
 * plugin (lib/upgrade.js). Read from `status`, which answers even when the database cannot be read.
 */
function DataBanner({ status }) {
  const d = status && status.data
  if (!d || d.writable) return null
  const title = tr(d.mode === 'newer' ? 'banner.newer' : d.mode === 'read-only' ? 'banner.readOnly' : 'banner.error')
  return h('div', { role: 'alert', style: { fontSize: 12, padding: '10px 12px', marginBottom: 12, borderRadius: 8, border: `1px solid ${tint(tok('destructive'), 0.3)}`, background: tint(tok('destructive'), 0.08), color: V.fg } },
    h('b', { style: { display: 'block', marginBottom: 4, color: tok('destructive') } }, title),
    h('div', null, String(d.message || '')),
    d.backup ? h('div', { style: { marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' } }, tr('banner.backup', { path: d.backup })) : null)
}
/** The studio. `initialView` / `initialPost` / `initialSettings` / `initialSetupStep`: starting state, only set by a development tool. */
// The studio's agent in the view's workspace, beside the page: a chat tab of the agent set in the plugin settings.
// An already open chat of that agent is only activated (same island identity), never duplicated.
const AGENT_PANE_KEY = 'growth-studio:agent-pane-opened'
const openAgentPane = (agent, fresh) => openInIsland({ type: '@timon/missions:chat', params: { agent, missionId: null, fresh } }, { edge: 'right' })

export function Studio({ ctx, initialView, initialPost = null, initialSettings = null, initialSetupStep = null, asPage = false }) {
  const api = React.useMemo(() => makeApi(ctx), [ctx])
  const ov = useResource(ctx, api, 'overview')
  const status = useResource(ctx, api, 'status')
  const [view, setView] = React.useState(initialView || 'queue')
  const [postId, setPostId] = React.useState(initialPost)
  const [ask, setAsk] = React.useState(''); const [askMsg, setAskMsg] = React.useState(null)
  const [settingsAt, setSettingsAt] = React.useState(initialSettings)
  const tz = (ov.data && ov.data.settings && ov.data.settings.publish_tz) || browserTz()
  const open = (id) => { setPostId(id); setView('post') }
  const counts = (ov.data && ov.data.counts) || {}
  // a blank studio (no agent or no managed account) shows the Set up instead of the usual views; Settings stays open
  const setupMode = view === 'setup' || Boolean(ov.data && ov.data.setupNeeded && view !== 'settings')
  const current = view === 'post' ? 'queue' : setupMode ? 'setup' : view
  const sendAsk = () => { if (!ask.trim()) return; api.post('ask', { text: ask }).then(() => { setAsk(''); setAskMsg(tr('studio.askSent')) }).catch((e) => setAskMsg(e.message)) }
  const tab = (k, label, count) => h('button', { key: k, type: 'button', role: 'tab', 'aria-selected': current === k, onClick: () => { setView(k); setPostId(null); if (k === 'settings') setSettingsAt(initialSettings) },
    style: { font: 'inherit', fontSize: 13, cursor: 'pointer', height: 44, padding: '0 2px', border: 0, background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6,
      color: current === k ? V.fg : V.mutedFg, fontWeight: current === k ? 600 : 500, boxShadow: current === k ? `inset 0 -2px 0 ${V.primary}` : 'none' } },
    label, count ? h('span', { style: { fontSize: 11, fontWeight: 600, minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: current === k ? tint(V.primary, 0.14) : V.muted, color: current === k ? V.primary : V.mutedFg, fontVariantNumeric: 'tabular-nums' } }, count) : null)
  const o = ov.data
  const agentName = (o && o.agent && o.agent.name) || null
  const [agentMsg, setAgentMsg] = React.useState(null)
  // first visit of the page once the studio is set up: open the agent's chat beside it, once (closing it is respected)
  React.useEffect(() => {
    if (!asPage || !agentName || (o && o.setupNeeded)) return
    let done = false
    try { done = window.localStorage.getItem(AGENT_PANE_KEY) === '1' } catch { /* storage unavailable: try once per load */ }
    if (done) return
    if (openAgentPane(agentName, true)) { try { window.localStorage.setItem(AGENT_PANE_KEY, '1') } catch { /* ignore */ } }
  }, [asPage, agentName, o && o.setupNeeded])
  const showAgent = () => setAgentMsg(openAgentPane(agentName, false) ? null : tr('studio.agentRefused'))
  const facts = o ? [
    o.next ? h('span', { key: 'next' }, tr('studio.next', { date: fmt(o.next.scheduled_for, tz) })) : h('span', { key: 'next' }, tr('studio.nothingScheduled')),
    o.needImage ? h('span', { key: 'img', style: { color: tok('warning'), fontWeight: 500 } }, tr('studio.needImage', { n: o.needImage })) : null,
    o.news ? h('span', { key: 'news', style: { color: tok('info'), fontWeight: 500 } }, tr('studio.news', { n: o.news })) : null,
    h('span', { key: 'cost', title: tr('studio.costTitle'), style: { fontVariantNumeric: 'tabular-nums' } }, tr('studio.cost', { spent: usd(o.costToday), budget: usd(o.budget || 0.25) })),
  ].filter(Boolean) : []
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', fontSize: 13, color: V.fg, background: V.bg } },
    h('header', { style: { display: 'flex', alignItems: 'center', gap: 24, padding: '0 20px', borderBottom: `1px solid ${V.border}`, background: V.card, flexShrink: 0, flexWrap: 'wrap' } },
      h('nav', { role: 'tablist', 'aria-label': tr('studio.views'), style: { display: 'flex', gap: 20 } },
        tab('queue', tr('tab.posts'), counts.pending_validation || 0), tab('calendar', tr('tab.calendar')), tab('feed', tr('tab.feed'), (o && o.toConfirm) || 0), tab('ideas', tr('tab.ideas'), (o && o.ideasOpen) || 0), tab('comments', tr('tab.comments'), (o && o.commentsPending) || 0), tab('settings', tr('tab.settings'), (o && o.rulesPending) || 0)),
      h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.mutedFg, flexWrap: 'wrap' } },
        ...facts.flatMap((f, i) => (i ? [h('span', { key: `sep${i}`, 'aria-hidden': true, style: { opacity: 0.5 } }, '·'), f] : [f])),
        agentName ? h('button', { type: 'button', onClick: showAgent, title: tr('studio.openAgentTitle', { agent: agentName }),
          style: { font: 'inherit', fontSize: 12, cursor: 'pointer', marginLeft: 8, padding: '4px 10px', borderRadius: 6, border: `1px solid ${V.border}`, background: 'transparent', color: V.fg } }, tr('studio.openAgent')) : null,
        agentMsg ? h('span', { style: { color: tok('warning') } }, agentMsg) : null)),
    h('main', { style: { flex: 1, overflow: 'auto', padding: 20 } },
      h(DataBanner, { status }),
      ov.error ? h(Err, { error: tr('studio.apiDown', { error: ov.error }) }) : null,
      o && o.agent && o.agent.issue && !setupMode ? h(Err, { error: o.agent.issue }) : null,
      setupMode ? h(Setup, { ctx, api, initialStep: initialSetupStep, onChanged: ov.reload, onOpenPost: open, onClose: () => { ov.reload(); setView('queue') } })
      : view === 'post' && postId ? h(PostDetail, { key: postId, ctx, api, id: postId, tz, onBack: () => setView('queue'), onOpen: open })
        : view === 'calendar' ? h(Calendar, { ctx, api, tz, onOpen: open, accounts: (ov.data && ov.data.accounts) || [] })
          : view === 'feed' || view === 'triage' ? h(Feed, { ctx, api, onOpen: open, accounts: (ov.data && ov.data.accounts) || [] })
            : view === 'ideas' ? h(Ideas, { ctx, api, onOpen: open, accounts: (ov.data && ov.data.accounts) || [] })
              : view === 'comments' ? h(Comments, { ctx, api, tz, accounts: (ov.data && ov.data.accounts) || [],
                onSettings: () => { const a = ((ov.data && ov.data.accounts) || [])[0]; setSettingsAt(a ? { scope: 'account', id: a.id, tab: 'comments' } : null); setView('settings') } })
                : view === 'settings' ? h(Settings, { ctx, api, initial: settingsAt, onSetup: () => setView('setup') })
                  : h(Queue, { ctx, api, tz, onOpen: open })),
    h('footer', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderTop: `1px solid ${V.border}`, background: V.card, flexShrink: 0 } },
      h('input', { value: ask, onChange: (e) => setAsk(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') sendAsk() }, 'aria-label': tr('studio.askLabel'),
        placeholder: tr('studio.askPlaceholder'), style: { ...S.input, flex: 1, minWidth: 200, height: 32, boxSizing: 'border-box', background: V.bg } }),
      h(Btn, { variant: 'outline', disabled: !ask.trim(), onClick: sendAsk }, tr('common.send')),
      askMsg ? h(Muted, null, askMsg) : null))
}

// ---------- compact cockpit card ----------
function makeWidget(ctx) {
  return function GrowthStudioWidget() {
    const api = React.useMemo(() => makeApi(ctx), [])
    const ov = useResource(ctx, api, 'overview')
    const status = useResource(ctx, api, 'status')
    const [refused, setRefused] = React.useState(false)
    const d = ov.data; const c = (d && d.counts) || {}
    const openStudio = () => setRefused(!openInIsland({ type: `${ctx.id}:studio`, params: {} }, { edge: 'left' }))
    const line = (label, value, color) => h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' } }, h('span', null, label), h('b', { style: { color } }, String(value)))
    return h('section', { style: { padding: 12, fontSize: 13 } },
      h('div', { style: { ...S.row, marginBottom: 6 } }, h('b', null, 'Growth Studio'), h('span', { style: { marginLeft: 'auto' } }), h(Btn, { onClick: openStudio }, tr('common.open'))),
      status.data && !status.data.writable ? h(Err, { error: status.data.mode === 'newer' ? tr('widget.readOnlyNewer') : tr('widget.readOnly') }) : null,
      ov.error ? h(Err, { error: ov.error }) : null,
      refused ? h(Muted, null, tr('widget.cannotOpen')) : null,
      d ? h('div', null,
        line(tr('queue.col.pending'), c.pending_validation || 0, STATUS.pending_validation.color),
        line(tr('widget.needImage'), d.needImage || 0, STATUS.pending_validation.color),
        line(tr('queue.col.scheduled'), c.scheduled || 0, STATUS.scheduled.color),
        line(tr('widget.toConfirm'), d.toConfirm || 0, V.fg),
        d.next ? h(Muted, null, tr('widget.next', { date: fmt(d.next.scheduled_for, d.settings.publish_tz), account: d.next.account })) : h(Muted, null, tr('studio.nothingScheduled')))
        : h(Muted, null, tr('common.loading')))
  }
}

// ---------- side menu entry ----------
const ROUTE = '/growth'
const ICON_MASK = `url("data:image/svg+xml;utf8,${encodeURIComponent(ICON)}")`
const onRoute = () => (typeof window === 'undefined' ? false : window.location.pathname === ROUTE || window.location.pathname.startsWith(`${ROUTE}/`))

function NavItem({ ctx }) {
  const [active, setActive] = React.useState(onRoute)
  const [hover, setHover] = React.useState(false)
  React.useEffect(() => {
    const sync = () => setActive(onRoute())
    sync()
    window.addEventListener('popstate', sync)
    const timer = setInterval(sync, 1000)   // client navigations do not fire popstate
    return () => { window.removeEventListener('popstate', sync); clearInterval(timer) }
  }, [])
  return h('a', {
    href: ROUTE, title: 'Growth Studio', 'aria-current': active ? 'page' : undefined,
    onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault(); ctx.navigate(ROUTE); setActive(true)
    },
    style: {
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12.5, lineHeight: '20px',
      whiteSpace: 'nowrap', overflow: 'hidden', textDecoration: 'none', cursor: 'pointer', transition: 'background-color .15s, color .15s',
      // same look as the product rows: primary at 10 % behind primary text
      background: active ? 'hsl(var(--primary) / 0.1)' : hover ? V.muted : 'transparent', color: active ? V.primary : hover ? V.fg : V.mutedFg,
    },
  },
  h('span', { 'aria-hidden': true, style: { width: 16, height: 16, flex: '0 0 16px', background: 'currentColor', WebkitMask: `${ICON_MASK} center / contain no-repeat`, mask: `${ICON_MASK} center / contain no-repeat` } }),
  h('span', null, 'Growth Studio'))
}

export function apply(ctx) {
  const parseParams = (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? {} : {})
  const disposeIsland = ctx.slots.register({
    slot: 'island.content', key: 'studio',
    island: { title: 'Growth Studio', parseParams, params: {}, minWidth: 520, minHeight: 320, icon: ICON, keepMounted: true },
  }, function StudioIsland() {
    const { setTitle } = useIslandContent()
    React.useEffect(() => { setTitle('Growth Studio') }, [setTitle])
    return h(LocaleGate, { ctx }, h(Studio, { ctx }))
  })
  const disposePage = ctx.slots.register({ slot: 'page', key: ROUTE }, function StudioPage() {
    return h('main', { style: { height: '100vh' } }, h(LocaleGate, { ctx }, h(Studio, { ctx, asPage: true })))
  })
  const disposeNav = ctx.slots.register({ slot: 'nav.item', key: ROUTE }, function GrowthStudioNav() { return h(NavItem, { ctx }) })
  const Widget = makeWidget(ctx)
  // the widget's catalog entry is read before any translation is loaded: English
  const disposeWidget = ctx.slots.register(
    { slot: 'cockpit.widget', key: 'growth-studio', widget: { title: 'Growth Studio', description: tr('widget.description'), icon: ICON, height: 220 } },
    function GrowthStudioCard() { return h(LocaleGate, { ctx }, h(Widget)) },
  )
  return () => { disposeWidget(); disposeNav(); disposePage(); disposeIsland() }
}

// ---------- English messages (reference; other languages: lib/i18n/<locale>.json) ----------
const EN = {
  "status.pending_validation": "To validate",
  "status.approved": "Validated",
  "status.scheduled": "Scheduled",
  "status.published": "Published",
  "status.rejected": "Rejected",
  "status.failed": "Failed",
  "status.draft": "Draft",
  "rel.minutes": "{n} min",
  "rel.hours": "{n} h",
  "rel.days": "{n} d",
  "rel.past": "{value} ago",
  "rel.future": "in {value}",
  "media.loadFailed": "The visual could not be loaded. Reload the page; if the problem persists, the media file is missing.",
  "media.alt": "Visual of post #{id}",
  "post.textLabel": "Text of the post",
  "source.title": "Source",
  "source.viewOnX": "View on X",
  "metrics.line": "{views} views · {likes} likes · {saves} bookmarks",
  "cost.quote": "Real quote through GetXAPI",
  "cost.link": "Link in the text, billed by X",
  "engine.gpt.title": "Realistic image",
  "engine.gpt.sub": "the agent's image generation tool",
  "engine.code.title": "Chart or diagram",
  "engine.code.sub": "drawn in code by the agent (HTML → PNG)",
  "fb.fond": "Substance / angle",
  "fb.ton": "Tone / voice",
  "fb.longueur": "Length",
  "fb.fait": "Factual error",
  "fb.timing": "Timing",
  "fb.visuel": "Visual",
  "fb.autre": "Other",
  "fb.ignore": "Nothing to learn from it (test, misclick)",
  "common.loading": "Loading…",
  "engine.unavailable": "{engine}: unavailable. {hint}.",
  "engine.note": "{engine}: {hint}.",
  "rel.justNow": "just now",
  "post.validatedNoImage": "Validated. Missing image: it will be scheduled as soon as the visual is ready.",
  "post.validatedNoSlot": "Validated. No publishing time found.",
  "post.publish": "Publish",
  "post.publishNowTitle": "Publish right away",
  "post.visualMissing": "Missing visual",
  "post.edit": "Edit",
  "post.editTitle": "Ask the agent for a rewrite",
  "post.reject": "Reject",
  "post.state.pending": "Validating schedules it after the posts of the day.",
  "post.state.pendingNoVisual": "Once validated, it will wait for its visual before being scheduled (or check \"Publish without a visual\").",
  "post.validating": "Validating…",
  "post.validate": "Validate",
  "post.validateTitle": "Validate and schedule after the posts of the day",
  "post.validateForDate": "Validate for a given date",
  "post.state.approved": "Validated, not scheduled yet.",
  "post.state.approvedNoVisual": "Validated. It will be scheduled as soon as the visual is ready.",
  "post.schedule": "Schedule",
  "post.scheduleTitle": "Schedule after the posts of the day",
  "post.pickDate": "Pick a date",
  "post.backToValidate": "Back to validation",
  "post.state.scheduled": "Goes out on {date} ({rel}).",
  "post.date": "Date",
  "post.dateTitle": "Change the publishing date",
  "post.unschedule": "Unschedule",
  "post.state.published": "Published on {date}.",
  "post.state.failed": "Publishing failed.",
  "post.state.rejectedNote": "Rejected: {note}",
  "post.state.rejected": "Rejected.",
  "post.reopen": "Reopen",
  "post.rejectPlaceholder": "Why is this post wrong? The agent will remember it.",
  "post.rejectLabel": "Reason for the rejection",
  "common.cancel": "Cancel",
  "post.rewriteHelp": "You can fix the text directly in the preview, or ask the agent for a new version.",
  "post.rewritePlaceholder": "What is wrong, the angle you want… The new version will replace this one.",
  "post.rewriteLabel": "Rewrite instructions",
  "common.sendToAgent": "Send to the agent",
  "post.dateLabel": "Publishing date, local time",
  "post.validateAndSchedule": "Validate and schedule",
  "post.publishConfirm": "Publish right away on @{account} for {cost}?",
  "post.publishing": "Publishing…",
  "post.publishing.title": "Publishing",
  "post.viewOnX": "View the post on X",
  "metrics.none": "No metrics yet",
  "post.quoteOf": "Quote the post of @{author}",
  "post.quoteOn": "Their post shows under your text. The visual becomes optional.",
  "post.quoteOff": "For a brand announcement, a quote carries further.",
  "post.visual": "Visual",
  "post.visual.askedReplace": "Asked from the agent {ago}: the new visual will replace this one",
  "post.visual.askedNew": "Asked from the agent {ago}: it will show here as soon as it is ready",
  "post.visual.stale": "No visual received since the request ({ago}): the mission probably failed",
  "post.visual.ready": "Ready",
  "post.visual.optional": "Optional for a quote",
  "post.visual.none": "None: the post will go out without a visual",
  "post.visual.missing": "Missing, required to publish",
  "post.visual.askAgain": "Ask again",
  "post.visual.redo": "Redo",
  "post.visual.ask": "Ask",
  "post.noMedia": "Publish without a visual",
  "post.upload.hint": "Or use your own image: drop it here (PNG, JPEG, WebP, GIF, 5 MB, up to {max})",
  "post.upload.pick": "Add an image…",
  "post.upload.add": "Add another image…",
  "post.upload.sending": "Sending…",
  "post.upload.alt": "Alt text (optional)",
  "post.upload.remove": "Remove this image",
  "post.upload.type": "Only PNG, JPEG, WebP or GIF images.",
  "post.upload.size": "Image too large (5 MB at most).",
  "post.scheduledFor": "Scheduled for {date}.",
  "post.engineLabel": "Visual engine",
  "post.briefCodePlaceholder": "The diagram or chart: elements, exact texts, structure, palette. Empty: the agent writes it from the post.",
  "post.briefCodeLabel": "Brief of the coded graphic",
  "post.briefGptPlaceholder": "The scene: subject, framing, light, style. Empty: the agent writes it from the post.",
  "post.briefGptLabel": "Brief of the realistic image",
  "common.sending": "Sending…",
  "post.cost": "Cost",
  "post.rewriteStale": "Rewrite requested {ago}, no new version received: the mission probably failed.",
  "post.rewriteAsked": "Rewrite requested {ago}: the new version will appear in Posts.",
  "source.thread": "Rest of the thread ({n})",
  "source.ideaConcept": "Concept of the idea",
  "source.ownIdea": "Our own idea",
  "post.replacedBy": "Replaced by",
  "post.versions": "Previous versions ({n})",
  "common.open": "Open",
  "post.requests": "Requests to the agent ({n})",
  "post.title": "Post #{id}",
  "post.meta": "#{id} · {network} · @{account} · {lang} · created {created}",
  "post.type": "Post type",
  "post.noType": "No type",
  "common.saving": "Saving…",
  "post.saveText": "Save the text",
  "post.chars": "{n} characters",
  "post.unsaved": "Unsaved changes",
  "post.clickToEdit": "Click in the text to edit it",
  "tab.posts": "Posts",
  "queue.failed": "Publishing failed",
  "queue.visualAsked": "Visual asked from the agent…",
  "queue.quote": "Quote",
  "queue.after": "after @{author}",
  "queue.col.pending": "To validate",
  "queue.col.approved": "Validated, no slot",
  "queue.col.scheduled": "Scheduled",
  "queue.col.published": "Published",
  "queue.noScheduled": "No scheduled post",
  "queue.noPost": "No post",
  "queue.hideRejected": "Hide rejected posts",
  "queue.showRejected": "Show rejected posts",
  "cal.dragHint": "Drag vertically to change the height of the hours",
  "cal.hour": "{h}:00",
  "cal.windowEnd": "end of the publishing window",
  "cal.windowStart": "start of the publishing window",
  "cal.now": "now",
  "cal.3days": "3 days",
  "cal.week": "Week",
  "cal.month": "Month",
  "cal.today": "Today",
  "cal.accountShown": "Account shown",
  "common.allAccounts": "All accounts",
  "cal.window": "window: {start}–{end}, gap {gapMin}–{gapMax} min ({tz})",
  "cal.windowGlobal": "window (global setting): {start}–{end}, gap {gapMin}–{gapMax} min ({tz})",
  "cal.waiting": "{n} validated without a slot",
  "cal.missingImage": "missing image",
  "cal.moveHint": "Drag to another slot to reschedule it",
  "cal.dropPast": "{time} · already past",
  "cal.movePast": "This slot is already past: pick a time to come.",
  "cal.moveFailed": "Could not move the post: {error}",
  "feed.bookmark.label": "X bookmarks",
  "feed.bookmark.name": "bookmarks",
  "feed.bookmark.tag": "Bookmark",
  "feed.brand.label": "X brands",
  "feed.brand.name": "brands",
  "feed.brand.tag": "Brand",
  "feed.watch.label": "X watchlist",
  "feed.watch.name": "watchlist",
  "feed.watch.tag": "Watchlist",
  "feed.blockedReference": "Reference account: never reused",
  "feed.blockedCompetitor": "Competitor: internal watch only",
  "feed.arrived": "arrived {rel}",
  "feed.new": "New",
  "feed.toTriage": "To triage",
  "feed.kept": "Kept",
  "feed.newsSkipped": "News skipped",
  "feed.news": "News",
  "feed.less": "Show less",
  "feed.more": "Read more",
  "feed.angle": "Suggested angle:",
  "feed.draftAsked": "Draft asked from the agent",
  "feed.draft": "Draft",
  "feed.keep": "Keep",
  "feed.ignore": "Ignore",
  "feed.sort.arrived": "Recently arrived",
  "feed.sort.posted": "Publishing date",
  "feed.draftsFor": "Drafts for",
  "feed.type": "Type",
  "feed.agentPicks": "The agent's choice",
  "feed.sortBy": "Sort by",
  "feed.shown": "{n} shown",
  "feed.noFilter": "Turn on at least one filter to see the feed.",
  "feed.empty": "Nothing for these filters.",
  "feed.loadMore": "Load more",
  "solution.timon": "Timon",
  "solution.outil": "Tool",
  "solution.methode": "Method",
  "idea.status.idea": "Waiting",
  "idea.status.approved": "Writing requested",
  "idea.status.in_progress": "Draft ready",
  "idea.status.done": "Published",
  "idea.status.dropped": "Dropped",
  "mix.title.one": "Mix of the last {days} days ({n} typed post), actual / target",
  "mix.title.many": "Mix of the last {days} days ({n} typed posts), actual / target",
  "mix.none": "No typed post in the last 30 days: target shares",
  "mix.bar": "{actual} % actual, {target} % target",
  "idea.writingAsked": "Writing asked from the agent: the draft will arrive in Posts.",
  "idea.pain": "Pain",
  "idea.solution": "Solution",
  "idea.sources": "Sources:",
  "idea.item": "item #{id}",
  "idea.position": "Position",
  "idea.whyFollow": "Why follow: {text}",
  "idea.reasonNote": "Reason: {note}",
  "idea.yourInstruction": "Your instruction: {note}",
  "idea.instructionPlaceholder": "Instruction for this post (optional)",
  "idea.instructionLabel": "Writing instruction",
  "idea.write": "Write",
  "idea.dropPlaceholder": "Why? (optional, the agent takes it into account)",
  "idea.dropLabel": "Reason",
  "idea.dropped": "Idea dropped.",
  "idea.drop": "Drop",
  "idea.writePost": "Write the post",
  "idea.withInstruction": "With an instruction…",
  "idea.agentWriting": "The agent is writing…",
  "idea.restored": "Back to waiting.",
  "idea.restore": "Put back to waiting",
  "ideas.noAccount": "No managed account.",
  "ideas.sentDrafts": "Request sent: the drafts arrive in Posts within a few minutes.",
  "ideas.sentIdeas": "Request sent: the ideas arrive here within a few minutes.",
  "ideas.title": "Original post ideas",
  "ideas.account": "Account",
  "ideas.refillDirect": "Direct drafting: refilled automatically under {n} drafts to validate",
  "ideas.directOnRequest": "Direct drafting, on request",
  "ideas.refill": "Refilled automatically under {n} waiting ideas",
  "ideas.onRequest": "On request only",
  "ideas.helpDirect": "Each idea starts from a pain already identified and a verified solution. Direct drafting: the agent writes the post right away, you only validate the draft in Posts (rejecting it drops the idea). Settings › Original ideas.",
  "ideas.help": "Each idea starts from a pain already identified and a verified solution: \"Write the post\" is enough, the instruction is optional. Settings › Original ideas.",
  "ideas.notReady": "Empty suggestion or writing instruction for this account: fill it in Settings › Original ideas.",
  "ideas.directionPlaceholder": "Direction for this time (optional), e.g. \"juniors\", \"code review\"",
  "ideas.directionLabel": "Direction of the ideas",
  "ideas.preparing": "Ideas in preparation…",
  "ideas.suggestAndWrite": "Suggest and write {n} ideas",
  "ideas.suggest": "Suggest {n} ideas",
  "ideas.waiting": "Waiting for your decision ({n})",
  "ideas.noneWaiting": "No waiting idea.",
  "ideas.kept": "Kept ({n})",
  "ideas.hideOld": "Hide published and dropped ideas",
  "ideas.showOld": "Show published and dropped ideas ({n})",
  "types.help": "Each type says what a post is for and how to write it. The agent aims at one per draft, and the ideas are spread by the target shares, catching up with the type most behind over 30 days. The instruction is sent to the agent as is.",
  "types.default": "Default types.",
  "types.inheritedOrg": "Types inherited from the organization (read-only here).",
  "types.inheritedGlobal": "Types inherited from the general settings (read-only here).",
  "types.copy": "Copy them to adapt them at this level",
  "types.label": "Label",
  "types.key": "Id",
  "types.share": "Target share %",
  "types.goal": "Goal",
  "types.remove": "Remove this type",
  "types.total": "Total of the shares: {n} %",
  "types.totalScaled": "Total of the shares: {n} % (brought back to 100 % when the mix is computed)",
  "types.add": "+ Add a type",
  "types.backToInherited": "Back to the inherited types",
  "tab.schedule": "Scheduling",
  "tab.commonRules": "Common rules",
  "tab.goals": "Goals",
  "tab.sources": "Sources",
  "tab.types": "Post types",
  "tab.original": "Original ideas",
  "tab.global": "Watch",
  "tab.learning": "Learning",
  "tab.org": "Organization",
  "tab.writing": "Writing",
  "tab.rules": "Rules",
  "tab.profile": "Profile",
  "tab.publish": "Publishing",
  "from.account": "this account",
  "from.organization": "the organization",
  "from.global": "the global setting",
  "from.default": "default",
  "from.merged": "combined",
  "tab.agent": "Agent",
  "from.plugin": "the plugin setting",
  "agent.helpOrg": "The Timon agent that writes for the accounts of this organization: posts, ideas, news, bookmark triage, visuals, rewrites and comment campaigns. Its brief (product, targets, interdicts) lives in the agent's own documents. Empty: the general setting, then the plugin's agent.",
  "agent.helpAccount": "The Timon agent that writes for this account. Empty: the organization's, then the general setting, then the plugin's agent.",
  "agent.helpGlobal": "The Timon agent that writes for all your accounts, unless an organization or an account chooses another one. Empty: the plugin's agent.",
  "agent.none": "no agent: set the plugin's agent in the Set up",
  "agent.notVisible": "{name} (not one of your agents)",
  "settings.notConnected": "not connected for publishing",
  "settings.nav": "Organizations and accounts",
  "settings.general": "General",
  "settings.addAccount": "+ Add an account",
  "settings.noOrg": "No organization",
  "settings.newOrgLink": "+ New organization",
  "settings.notFound": "Item not found (deleted?).",
  "settings.newOrg": "New organization",
  "settings.newOrgHelp": "An organization (e.g. a company or a product) groups accounts on several networks. Its settings are the defaults of its accounts.",
  "settings.name": "Name",
  "settings.notes": "Notes",
  "settings.create": "Create",
  "settings.addManaged": "Add a managed account",
  "settings.addManagedHelp": "The account is created without a publishing connection: nothing can go out until the Publishing tab is filled in.",
  "settings.network": "Network",
  "settings.handle": "Handle (without @)",
  "settings.displayName": "Display name",
  "settings.lang": "Language (en, fr…)",
  "settings.langHint": "One language per account.",
  "settings.role": "Role",
  "role.personal": "Personal",
  "role.brand": "Brand",
  "role.automated": "Automated (openly identified)",
  "settings.add": "Add",
  "common.yes": "yes",
  "common.no": "no",
  "settings.byDefault": "default: {value}",
  "settings.inheritedFrom": "inherited from {from}: {value}",
  "settings.savedNote": "Saved, note updated.",
  "settings.saved": "Saved.",
  "settings.defaultIs": "default: {value}",
  "settings.defaultOption": "Default ({value})",
  "settings.inheritedOption": "Inherited ({value})",
  "common.yesCap": "Yes",
  "common.noCap": "No",
  "settings.accountsKept": "{n} account(s) kept",
  "settings.emptyDefault": "Empty: the default instruction applies.",
  "settings.emptyGlobal": "Empty: the instruction of the general settings applies.",
  "settings.emptyOrg": "Empty: the organization's instruction applies.",
  "settings.emptyInherited": "Empty: the inherited instruction applies.",
  "settings.copyInstruction": "Copy it to adapt it at this level",
  "common.save": "Save",
  "settings.rulesInheritedAccount": "Inherited rules (global + organization), always applied:",
  "settings.rulesInheritedOrg": "Common rules (global), always applied:",
  "settings.scheduleHelp": "A validated post without a date goes after the last post of the day of this account, with a random gap; no post that day: right away when inside the window. Leaving a field empty = inherited value.",
  "settings.rulesHelp": "One rule per line. The rules add up: those of the global setting, of the organization, then of the account all apply.",
  "settings.sourcesHelp": "Where the agent draws its draft ideas from for this level. The \"news\" source triggers an automatic draft for every novelty of an account under fast watch.",
  "settings.originalHelp": "Posts that come neither from news nor from a share: reflections, observations, analyses. These instructions are sent as is to the agent when it suggests ideas (Ideas tab) and when it writes the one you keep; the studio only adds the mechanics (format, recording). Leaving a field empty = inherited value.",
  "settings.generalTitle": "General settings",
  "settings.generalSub": "Defaults of every organization and every account.",
  "settings.orgSub": "Defaults of the accounts of this organization (each account can override them).",
  "settings.noOrgLower": "no organization",
  "publish.connected": "Connected",
  "publish.notConnected": "Not connected",
  "publish.readyText": "The posts of @{handle} go out with these settings, and only these.",
  "publish.notReadyText": "No post of @{handle} can go out: publishing is refused until the treg tool is filled in.",
  "publish.howTo": "To connect an X account: (1) connect the account in treg (OAuth, with the right to publish) and note the name of the tool or authorization method it exposes; (2) create the Timon secret holding the x.com cookie of this account and grant it to the plugin (scope agent:plugin:growth-studio); (3) fill in the three fields below. These settings are never inherited from an organization.",
  "voice.helpSync": "The voice guide is edited here and copied into the linked note of the notes folder; a change made in the note is detected and imported without losing anything.",
  "voice.helpLocal": "The voice guide is edited here and kept in the studio (voice guide sync with a notes folder is off: Settings › General).",
  "voice.inherited": "Empty: the organization's voice applies.",
  "voice.error": "Error",
  "voice.noNote": "Note missing",
  "voice.synced": "Synced",
  "voice.noteChanged": "Note changed in the folder",
  "voice.toCopy": "To copy into the note",
  "voice.imported": "Note imported.",
  "voice.import": "Import the note",
  "voice.placeholder": "Tone, length, verbal tics, examples of real posts…",
  "voice.label": "Voice guide",
  "voice.savedCopied": "Voice saved and copied into the note.",
  "voice.saved": "Voice saved.",
  "voice.save": "Save the voice",
  "voice.overwriteConfirm": "Overwrite the note with this text? The changes made in the note will be lost.",
  "voice.overwritten": "Note overwritten.",
  "voice.overwrite": "Overwrite the note",
  "settings.orgMeta": "{n} account(s) · id {slug}",
  "settings.orgHasAccounts": "Move or delete its accounts first",
  "settings.deleteOrgConfirm": "Delete the organization {name}?",
  "common.delete": "Delete",
  "settings.networkHandle": "{network} handle (without @)",
  "settings.handleHint": "No longer changes once a post is published.",
  "settings.automated": "Openly automated account",
  "settings.validationRequired": "Validation by a user before publishing: required (database guard, not editable here) · {n} post(s)",
  "settings.validationNo": "Validation by a user before publishing: no (database guard, not editable here) · {n} post(s)",
  "settings.accountHasPosts": "An account with posts cannot be deleted",
  "settings.deleteAccountConfirm": "Delete the account @{handle}?",
  "fbsource.reject": "Rejection",
  "fbsource.rewrite": "Rewrite",
  "fbsource.edit": "Edit",
  "learning.help": "The agent reads your recent feedback before each writing. Every week, it draws rules from the feedback that comes back. They apply at once unless you turn automatic acceptance off; you can revoke any rule here.",
  "learning.autoAccept": "Apply learned rules automatically",
  "learning.appliedN": "Applied rules ({n})",
  "learning.auto": "auto",
  "learning.revoke": "Revoke",
  "learning.revoked": "Revoked",
  "learning.proposed": "Proposed rules",
  "learning.proposedN": "Proposed rules ({n})",
  "learning.noneProposed": "No waiting proposal.",
  "learning.evidence": "From the feedback {ids}",
  "learning.notePlaceholder": "Detail or reason (optional)",
  "learning.noteLabel": "Detail on the rule",
  "learning.accept": "Accept",
  "learning.refuse": "Refuse",
  "learning.decided": "Rules already decided ({n})",
  "learning.accepted": "Accepted",
  "learning.refused": "Refused",
  "learning.latest": "Your latest feedback",
  "learning.none": "No feedback yet.",
  "learning.post": "post #{id}",
  "learning.category": "Category of the feedback",
  "learning.noCategory": "No category",
  "learning.ignore": "Do not learn",
  "learning.agentText": "The agent's text",
  "learning.yourVersion": "Your version",
  "banner.newer": "Growth Studio is read-only: its data comes from a newer version",
  "banner.readOnly": "Growth Studio is read-only: the database update failed",
  "banner.error": "Growth Studio cannot open its data",
  "banner.backup": "Backup: {path}",
  "studio.askSent": "Request sent to the agent.",
  "studio.openAgent": "Agent",
  "studio.openAgentTitle": "Open the chat of {agent} beside the studio",
  "studio.agentRefused": "The agent chat could not be opened here: drag an agent next to the studio.",
  "studio.next": "Next post out {date}",
  "studio.nothingScheduled": "Nothing scheduled",
  "studio.needImage": "{n} without a visual",
  "studio.news": "{n} news in progress",
  "studio.costTitle": "Today's watch spending / cap",
  "studio.cost": "Watch {spent} / {budget}",
  "studio.views": "Views of the studio",
  "tab.calendar": "Calendar",
  "tab.feed": "Feed",
  "tab.ideas": "Ideas",
  "tab.settings": "Settings",
  "studio.apiDown": "API unavailable: {error}",
  "studio.askLabel": "Free request to the studio's agent",
  "studio.askPlaceholder": "Ask the studio's agent, for example \"propose 3 ideas on this week's releases\"",
  "common.send": "Send",
  "widget.readOnlyNewer": "Read-only: data from a newer version of Growth Studio.",
  "widget.readOnly": "Read-only: open the studio for details.",
  "widget.cannotOpen": "The tab cannot be opened here: go to /growth.",
  "widget.needImage": "Validated without an image",
  "widget.toConfirm": "Bookmarks to confirm",
  "widget.next": "Next: {date} (@{account})",
  "widget.description": "Drafts to validate, scheduled posts, next post out; opens the studio.",
  "settings.setup": "Set up…",
  "setup.title": "Set up Growth Studio",
  "setup.intro": "A few steps before the first draft. The optional ones can wait; everything stays editable in Settings.",
  "setup.converse": "Set up with the agent",
  "setup.converseNeedsAgent": "Choose the agent first (step 1)",
  "setup.converseStarted": "The agent is waiting for you in a conversation.",
  "setup.openMission": "Open the conversation",
  "setup.back": "Back to the studio",
  "setup.optional": "optional",
  "setup.prev": "Previous",
  "setup.next": "Next",
  "setup.ready": "The required steps are done.",
  "setup.notReady": "Steps 1 and 2 are required.",
  "setup.finish": "Open the studio",
  "setup.settingRefused": "Timon refused to save the setting {key}.",
  "setup.step.agent": "The agent",
  "setup.step.accounts": "The accounts",
  "setup.step.writing": "The writing",
  "setup.step.connectors": "Connectors",
  "setup.step.import": "Import",
  "setup.step.test": "The test",
  "setup.agent.help": "The agent writes the drafts, rewrites, visuals and ideas of the studio. Choose one of your Timon agents, or create one with the provider you use. Then check that it can run the studio's tools.",
  "setup.agent.current": "Agent of the studio",
  "setup.agent.none": "none yet",
  "setup.agent.unknown": "not found among your agents",
  "setup.agent.choose": "Choose an existing agent",
  "setup.agent.chooseName": "Name of an existing agent",
  "setup.agent.chooseHint": "As shown on the Agents page of Timon.",
  "setup.agent.use": "Use this agent",
  "setup.agent.create": "Or create a new agent",
  "setup.agent.createHelp": "Created with a neutral instruction and the role \"{role}\"; you can change it later on the Agents page.",
  "setup.agent.name": "Name",
  "setup.agent.provider": "Provider",
  "setup.agent.signedOut": "signed out",
  "setup.agent.noBackends": "The list of providers is not available here: the agent is created with the default provider of Timon.",
  "setup.agent.model": "Model",
  "setup.agent.createBtn": "Create the agent",
  "setup.agent.created": "Agent {name} created and chosen.",
  "setup.agent.createManual": "Growth Studio may not create agents on this installation. Create one on the Agents page of Timon (any provider, any role except orchestrator), then choose it above.",
  "setup.agent.agentsPage": "Open the Agents page",
  "setup.agent.check": "Check the agent",
  "setup.agent.checkHelp": "A short mission asks the agent to run one command of the studio's tools. It proves that the agent can run Node.js 22.5 or newer and reach the studio from its sandbox.",
  "setup.agent.checkOk": "Checked: Node {node}",
  "setup.agent.checkPending": "Check running…",
  "setup.agent.checkFailed": "No answer from the agent",
  "setup.agent.checkOld": "Node {node} is too old",
  "setup.agent.checkNone": "Not checked yet",
  "setup.agent.checkBtn": "Check",
  "setup.agent.checkAgain": "Check again",
  "setup.agent.fixIntro": "The agent did not reach the studio. Open the conversation to read what the command printed, then:",
  "setup.agent.fix1": "1. Node.js missing or older than 22.5 (common with the desktop app, where Timon runs inside its own runtime): install Node.js 22.5 or newer from nodejs.org, then write node (or the absolute path of the node program) in the field below and check again.",
  "setup.agent.fix2": "2. The agent's sandbox refuses the command: give this agent a permission mode that lets it run shell commands, or choose an agent on another provider.",
  "setup.agent.fix3": "3. The plugin was disabled or restarted during the check: check again.",
  "setup.agent.runtime": "Command the agent runs the tools with:",
  "setup.agent.nodeLabel": "Node.js command for the agent (optional)",
  "setup.agent.nodeHint": "Empty = the runtime running Timon. Otherwise node (on the agent's PATH) or an absolute path.",
  "setup.accounts.help": "An organization groups the accounts of one person, company or product. Then add the first account the studio writes for.",
  "setup.accounts.noAccount": "No account yet.",
  "setup.accounts.more": "More organizations and accounts: Settings.",
  "setup.accounts.org": "Organization",
  "setup.accounts.orgHint": "Your name, your company or your product.",
  "setup.accounts.create": "Create the account",
  "setup.writing.help": "How @{handle} writes: its voice guide and the instructions the agent follows. Start from generic content you edit later, or write them with the agent.",
  "setup.writing.voice": "Voice guide",
  "setup.writing.rules": "Rules",
  "setup.writing.types": "Post types",
  "setup.writing.suggest": "Original ideas: suggestion instruction",
  "setup.writing.write": "Original ideas: writing instruction",
  "setup.writing.triage": "Bookmark triage criteria",
  "setup.writing.set": "set",
  "setup.writing.empty": "empty",
  "setup.writing.starter": "Use the generic defaults",
  "setup.writing.starterHelp": "Only empty settings are filled; nothing you wrote is replaced.",
  "setup.writing.starterDone": "Generic content written. Edit it in Settings › account › Writing.",
  "setup.writing.nothing": "Nothing to fill: these settings are already set.",
  "setup.writing.withAgent": "Write them with the agent",
  "setup.writing.voiceHint": "Who writes, the tone, what the account never says. The agent follows it to the letter.",
  "setup.writing.needAccount": "Create an account first (step 2).",
  "setup.connectors.help": "Every connector is optional: without it, only its own feature is off. Growth Studio never edits timon.config.json: you add the lines below yourself, then restart Timon.",
  "setup.connectors.ready": "ready",
  "setup.connectors.missing": "not ready",
  "setup.connectors.unknown": "unknown",
  "setup.connectors.policy": "pluginPolicy lines:",
  "setup.connectors.noPolicy": "No pluginPolicy line needed.",
  "setup.connectors.secrets": "Secrets to create and grant to the plugin (the value never goes through the studio):",
  "setup.connectors.block": "The pluginPolicy block",
  "setup.connectors.blockHelp": "To merge into timon.config.json (with what is already there), then restart Timon. Keep only the connectors you use; spawn lets the studio start the agent's missions and is required.",
  "setup.connectors.copy": "Copy",
  "setup.connectors.copied": "Copied",
  "setup.import.admin": "Importing an existing database is done by an administrator of Timon.",
  "setup.import.help": "Already used Growth Studio elsewhere? Import its growth.db: posts, ideas, accounts, settings and media are copied into the plugin's storage, checked table by table. The original file is only read.",
  "setup.import.legacy": "The studio currently reads a project database: the import makes it use its own copy right away.",
  "setup.import.path": "Absolute path of the growth.db",
  "setup.import.media": "Media folder (optional)",
  "setup.import.mediaHint": "Default: the media folder next to the file.",
  "setup.import.btn": "Import",
  "setup.import.confirm": "The studio switches to the imported data right away (the current data is kept as a backup). Continue?",
  "setup.import.done": "Imported: {n} posts.",
  "setup.test.help": "The agent writes one short test draft. It stays to validate: nothing is published. Reject it once read if you like.",
  "setup.test.account": "Account",
  "setup.test.btn": "Write a test draft",
  "setup.test.started": "Mission started.",
  "setup.test.last": "Last post: #{id} for @{handle}",
  "tab.comments": "Comments",
  "comments.tabs": "Replies",
  "comments.tab.pending": "To validate",
  "comments.tab.sent": "Sent",
  "comments.tab.dismissed": "Discarded",
  "comments.account": "Account",
  "comments.help": "Replies the agent drafted under posts found by your campaigns. Nothing is sent until you validate it; a validated reply goes out within minutes, within the campaign's limits.",
  "comments.empty.pending": "No reply to validate.",
  "comments.empty.sent": "No reply sent yet.",
  "comments.empty.dismissed": "No discarded reply.",
  "comments.setUp": "Set up a comment campaign",
  "comments.today": "{sent} sent today",
  "comments.todayCap": "{sent} / {cap} sent today",
  "comments.todayTitle": "Replies sent today against the daily ceiling of the campaign",
  "comments.queued": "{n} waiting to be sent",
  "comments.inactive": "campaign off",
  "comments.followers": "{n} followers",
  "comments.views": "{n} views",
  "comments.likes": "{n} likes",
  "comments.replies": "{n} replies",
  "comments.score": "Score {n}/5",
  "comments.stance.critical": "Criticizes a competitor",
  "comments.stance.neutral": "Neutral about a competitor",
  "comments.stance.praise": "Praises a competitor",
  "comments.why": "Why:",
  "comments.replyAs": "@{account} replies to @{author}",
  "comments.replyLabel": "Text of reply #{id}",
  "comments.rewriteAsked": "Rewrite asked",
  "comments.validate": "Validate",
  "comments.validateTitle": "Validate this reply: it is sent shortly, as written here",
  "comments.rewrite": "Rewrite…",
  "comments.dismiss": "Discard",
  "comments.dismissConfirm": "Discard the reply",
  "comments.rewriteLabel": "What to change",
  "comments.rewritePlaceholder": "What to change (optional): shorter, less salesy, another tip…",
  "comments.dismissLabel": "Reason for discarding",
  "comments.dismissPlaceholder": "Why this reply is discarded (required, the agent learns from it)",
  "comments.rewriteSent": "Rewrite asked: the new version replaces this one here.",
  "comments.saved": "Text saved.",
  "comments.state.sent": "Sent {date}",
  "comments.state.failed": "Sending failed",
  "comments.state.waiting": "Validated {date}, waiting to be sent",
  "comments.viewReply": "View the reply",
  "comments.validatedBy": "validated by {who}",
  "comments.dismissedWhy": "Discarded:",
  "settings.competitors": "Competitors",
  "settings.commentsHelp": "How the agent picks the found posts worth a reply and writes it. Campaigns (pains, searches, limits) are set on each managed account.",
  "campaign.help": "A campaign of @{handle} searches the network for posts that voice one of its pains, has the agent check each one and draft a reply, then waits for your validation in the Comments view. It never replies to a competitor's team.",
  "campaign.create": "Create the campaign",
  "campaign.another": "Add a campaign",
  "campaign.defaultName": "Comments",
  "campaign.newName": "Campaign {n}",
  "campaign.active": "Campaign on",
  "campaign.noActivePain": "No active pain: the campaign searches nothing until one is active.",
  "campaign.langs": "Languages of the posts",
  "campaign.langsHint": "Two-letter codes separated by commas; empty = the account's language",
  "campaign.perDay": "Replies per day",
  "campaign.gap": "Minutes between two replies",
  "campaign.sameAuthor": "Days before replying to the same author again",
  "campaign.budget": "Search budget per day ($)",
  "campaign.hours": "Active hours",
  "campaign.hoursHint": "HH-HH, in the publishing time zone",
  "campaign.followers": "Skip authors above N followers",
  "campaign.limitsHint": "An empty limit follows the defaults of the studio.",
  "campaign.save": "Save the campaign",
  "campaign.pains": "Pains ({n})",
  "campaign.painsHelp": "The reader's words, the searches that find them, examples that match or not, and the way out you verified. The reply presents that solution, nothing more.",
  "campaign.painN": "Pain #{id}",
  "campaign.newPain": "New pain",
  "campaign.painActive": "Active",
  "campaign.painCandidates": "{n} post(s) found",
  "campaign.pain": "Pain",
  "campaign.painHint": "In the reader's words: what they live, what they look for",
  "campaign.queries": "Searches",
  "campaign.queriesHint": "One search per line, as typed in the network's search",
  "campaign.examplesPos": "Matches (examples)",
  "campaign.examplesNeg": "Does not match (examples)",
  "campaign.oneLine": "One per line",
  "campaign.solution": "Solution",
  "campaign.solutionHint": "The concrete way out the reply gives; required for an active pain",
  "campaign.source": "Verified on",
  "campaign.sourceHint": "Where the solution was checked (page, document, test); required for an active pain",
  "campaign.evidence": "Evidence (optional)",
  "campaign.addPain": "Add a pain",
  "campaign.instruction": "Instruction for the agent",
  "competitors.help": "Shared by every user of the studio. A competitor's names and aliases never appear in a post; a member of its team (founder, developer, employee, official account) is never replied to nor quoted. In doubt, add the person.",
  "competitors.none": "No competitor yet.",
  "competitors.add": "Add a competitor",
  "competitors.website": "Website",
  "competitors.active": "Followed",
  "competitors.aliases": "Names and aliases recognized in a text",
  "competitors.aliasLabel": "New alias",
  "competitors.aliasPlaceholder": "Add an alias, Enter",
  "competitors.removeAlias": "Remove the alias {alias}",
  "competitors.team": "Team ({n})",
  "competitors.noTeam": "Nobody listed yet.",
  "competitors.handleLabel": "Handle of the person",
  "competitors.roleLabel": "Role",
  "competitors.sourceLabel": "How the affiliation is known",
  "competitors.sourcePlaceholder": "How it is known (bio, website…)",
  "competitors.addMember": "Add to the team",
  "competitors.removeMember": "Remove @{handle} from the team",
  "competitors.removeConfirm": "Remove @{handle} from the team of {name}? Replies to this person become possible again.",
  "competitors.affiliatedTitle": "Authors set aside for an affiliation ({n})",
  "competitors.affiliatedHelp": "Authors of found posts the check set aside because they may belong to a competitor. Add them to a team to keep them out for good.",
  "competitors.affiliation.competitor": "Affiliated",
  "competitors.affiliation.unknown": "In doubt",
  "competitors.foundBy": "found for @{account}",
  "competitors.whichLabel": "Competitor",
  "competitors.addToTeam": "Add to its team",
  "team.role.official": "Official account",
  "team.role.founder": "Founder",
  "team.role.employee": "Employee",
  "team.role.developer": "Developer",
  "team.role.contributor": "Contributor",
  "team.role.other": "Other",
  "learning.comment": "Comment"
}
MESSAGES.en = EN
