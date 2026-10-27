// First launch: the Set up path (screen of the studio, or a conversation with the agent through the setup skill).
// Six steps: the agent, the accounts, the writing, the optional connectors, the optional import, the test draft.
// This module holds what both paths share: the state of each step for one user, the generic starter content of the
// writing step, the exact `pluginPolicy` lines and secret commands of the connectors, and the `setup …` commands of
// the agent CLI. The plugin never edits timon.config.json: it only shows the lines the user adds.
import { createAccount, createOrganization, accountRow, resolve, saveScoped, saveVoice, SETTING_KEYS } from './accounts.js'
import { UsageError, parseArgv } from './agent-tools.js'

export const PLUGIN_ID = 'growth-studio'
/** Node version the agent tools need (node:sqlite on the host, same runtime in the CLI). */
export const NODE_MIN = [22, 5]
export const nodeOk = (v) => {
  const m = /^v?(\d+)\.(\d+)/.exec(String(v || ''))
  if (!m) return false
  const [maj, min] = [Number(m[1]), Number(m[2])]
  return maj > NODE_MIN[0] || (maj === NODE_MIN[0] && min >= NODE_MIN[1])
}
/** Role of an agent the Set up creates: a role without code worktree, never the orchestrator. */
export const AGENT_ROLE = 'research'
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** System prompt of an agent the Set up creates: neutral, names no person, project or model provider. */
export const AGENT_PROMPT = [
  'You write social media posts for the users of Growth Studio, a Timon plugin.',
  '',
  'Every mission of the studio gives you its tools skill (growth-studio-tools): read and write the studio\'s data only',
  'through its commands, exactly as written. Before writing for an account, read its writing context and follow it.',
  'Everything you write is a draft that waits for the user\'s validation: you never validate, schedule a post at a',
  'time you chose, or publish. Never invent a fact, a figure or an anecdote: use what the sources and the user gave.',
].join('\n')

// ---------- starter content of the writing step (generic, editable afterwards in Settings) ----------
/** Proposed to the user as a starting point; written at the account level, only where nothing is set yet. */
export const STARTER = {
  voice: [
    'Who writes: describe the person or the brand behind this account in one or two sentences.',
    '',
    'Tone: direct and concrete. Short sentences. Address the reader as "you". Give an opinion when there is one.',
    'Vocabulary: plain words; explain a technical term only when the audience would not know it.',
    'Emojis: a few at most, never as decoration in every line.',
    'Never: hype words ("game changer", "revolutionary"), clickbait hooks, headings or labels inside a post,',
    'a closing question only meant to farm replies.',
  ].join('\n'),
  rules: [
    'Never publish anything without the user\'s validation.',
    'Never invent a fact, a figure, a quote or an anecdote.',
    'One idea per post; keep it short unless the subject needs more.',
  ].join('\n'),
  post_types: JSON.stringify([
    { key: 'value', label: 'Useful (worth saving)', goal: 'saves', share: 40, prompt: 'A tool, a method or a tip the reader can use today: what it is, what it is for, one strength, one limit.' },
    { key: 'reach', label: 'Reach', goal: 'impressions', share: 25, prompt: 'A clear opinion on something new in the field, with the one detail that matters.' },
    { key: 'pain_solution', label: 'Pain → solution', goal: 'replies', share: 20, prompt: 'A problem the audience has, then a verified way to solve it. Only what exists today.' },
    { key: 'proof', label: 'Behind the scenes', goal: 'trust', share: 15, prompt: 'Something real the author did, learnt or shipped, with a concrete detail.' },
  ]),
  original_suggest_prompt: 'Suggest ideas for original posts (observations, analyses, lessons) the audience of this account would want to read. Each idea starts from a problem the audience really has and a solution that exists. Never invent an anecdote or a figure.',
  original_write_prompt: 'Write the post from the chosen idea in the account\'s voice: one idea, concrete, short, no headings.',
  triage_prompt: 'Keep what is useful to the audience of the account (tools, methods, news it would care about) and that it does not already know. Ignore off-topic content. Score 0-5: clear concept (0-2), value for the audience (0-2), freshness (0-1). When unsure, mark it to_confirm.',
}
/** Keys shown in the writing step, in this order. */
export const WRITING_KEYS = ['voice', 'rules', 'post_types', 'original_suggest_prompt', 'original_write_prompt', 'triage_prompt']

/** Writes the starter content on an account where its own level and everything it inherits are empty. Returns the keys written. */
export function applyStarter(db, accountId, keys = WRITING_KEYS) {
  const a = accountRow(db, accountId)
  if (!a) throw new Error('account not found')
  const written = []
  const changes = {}
  for (const k of keys) {
    if (!(k in STARTER)) continue
    if (String(resolve(db, 'account', a.id, k).value || '').trim()) continue
    if (k === 'voice') { saveVoice(db, 'account', a.id, STARTER.voice); written.push(k) } else { changes[k] = STARTER[k]; written.push(k) }
  }
  if (Object.keys(changes).length) saveScoped(db, 'account', a.id, changes)
  return written
}

// ---------- state of the steps for one user (database part) ----------
/** What the database says about the user's progress (the connection is scoped to that user, lib/scope.js). */
export function setupData(db) {
  const orgs = db.prepare('SELECT id, name FROM organizations ORDER BY id').all()
  const accounts = db.prepare(`SELECT id, network, handle, lang, role, organization_id FROM accounts WHERE relation = 'owned' ORDER BY id`).all()
  const first = accounts[0] || null
  const writing = first ? Object.fromEntries(WRITING_KEYS.map((k) => [k, Boolean(String(resolve(db, 'account', first.id, k).value || '').trim())])) : null
  const posts = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n
  const last = db.prepare('SELECT p.id, p.status, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id ORDER BY p.id DESC LIMIT 1').get() || null
  return {
    organizations: orgs.map((o) => ({ ...o, accounts: accounts.filter((a) => a.organization_id === o.id) })),
    accounts: accounts.length,
    networks: db.prepare('SELECT id, name FROM networks ORDER BY rowid').all(),
    writing: first ? { account: { id: first.id, handle: first.handle, network: first.network }, filled: writing } : null,
    test: { posts, last },
  }
}

// ---------- connectors: exact lines for the user ----------
/** Secrets a connector needs, by vault name, with the commands that create and grant them. */
export function secretLines(names) {
  return names.filter(Boolean).map((name) => ({
    name,
    set: `printf %s "<value>" | timon secret set ${name} --scope agent:plugin:${PLUGIN_ID} --stdin`,
    grant: `timon secret grant ${name} --scope agent:plugin:${PLUGIN_ID}`,
  }))
}
/**
 * For each connector: what to add to `pluginPolicy` and which secrets to create, from its descriptor and the current
 * settings. `chromeBinary` replaces the generic browser name; treg in http mode needs a host instead of a binary.
 */
export function connectorGuide(c, { settings = () => '', accountSecrets = [] } = {}) {
  const exec = []; const http = []; let secrets = []
  if (c.id === 'treg') {
    if (String(settings('tregMode') || 'cli').toLowerCase() === 'http') {
      let host = 'treg.to'
      try { host = new URL(String(settings('tregBaseUrl') || 'https://treg.to')).hostname } catch { /* default */ }
      http.push(host)
      secrets = secretLines([String(settings('tregTokenSecret') || '').trim()])
    } else exec.push('treg')
  } else if (c.id === 'getxapi') {
    http.push('api.getxapi.com')
    secrets = secretLines([String(settings('getxapiKeySecret') || 'GETXAPI_KEY').trim(), ...accountSecrets])
  } else if (c.id === 'chrome') {
    exec.push(String(settings('chromeBinary') || '').trim() || 'google-chrome')
  }
  return { exec, http, secrets }
}
/** The `pluginPolicy` block covering the given connectors plus the missions of the studio, as the user pastes it. */
export function policySnippet(guides) {
  const uniq = (a) => [...new Set(a)]
  const exec = uniq(guides.flatMap((g) => g.exec)); const http = uniq(guides.flatMap((g) => g.http))
  const policy = { spawn: { approved: [PLUGIN_ID] } }
  if (exec.length) policy.exec = { allow: exec }
  if (http.length) policy.http = { allow: http }
  return JSON.stringify({ pluginPolicy: policy }, null, 2)
}

// ---------- `setup …` commands of the agent CLI ----------
export const SETUP_USAGE = `Setup commands:
  setup status
  setup org --name "…"
  setup account --org <id> --network <x|linkedin|…> --handle <handle> --lang <en|fr|…> --role <personal|brand|automated> [--display-name "…"]
  setup starter <handle|id> [--keys voice,rules,…]
  setup set <handle|id> <key> --file <value.txt>
  setup keys`
/** Keys the setup may write on an account: the writing step, goals and rules, never publishing or installation keys. */
export const SETUP_SET_KEYS = Object.keys(SETTING_KEYS).filter((k) => ['goals', 'writing', 'rules', 'types', 'original', 'sources'].includes(SETTING_KEYS[k].group)
  && (SETTING_KEYS[k].levels || []).includes('account') && k !== 'voice_note')
export const isSetupReadOnly = (sub) => ['status', 'keys', undefined].includes(sub)

/** Runs `setup <sub> …` on a database scoped to the mission's user. `extra` adds host facts to `status`. */
export function runSetup(db, argv, { input, extra = null }) {
  const { pos, opts } = parseArgv(argv)
  const sub = pos[1]
  switch (sub) {
    case 'status': return statusText(setupData(db), extra)
    case 'keys': return `Settings an account can take with "setup set":\n${SETUP_SET_KEYS.map((k) => `  ${k}: ${SETTING_KEYS[k].label}`).join('\n')}`
    case 'org': {
      const id = createOrganization(db, { name: opts.name, notes: opts.notes })
      return `organization #${id} created ("${String(opts.name).trim()}").`
    }
    case 'account': {
      if (!opts.org) throw new UsageError('--org <organization id> is required (setup status lists them)')
      const id = createAccount(db, { organization_id: opts.org, network: opts.network || 'x', handle: opts.handle, lang: opts.lang, role: opts.role, display_name: opts['display-name'] })
      return `managed account #${id} created (@${String(opts.handle).replace(/^@/, '')}).`
    }
    case 'starter': {
      const a = accountRow(db, pos[2])
      if (!a) throw new Error(`unknown managed account: ${pos[2] || '(none)'}`)
      const keys = opts.keys ? String(opts.keys).split(',').map((s) => s.trim()).filter(Boolean) : WRITING_KEYS
      const bad = keys.filter((k) => !WRITING_KEYS.includes(k))
      if (bad.length) throw new UsageError(`unknown starter key(s): ${bad.join(', ')} (${WRITING_KEYS.join(', ')})`)
      const w = applyStarter(db, a.id, keys)
      return w.length ? `starter content written on @${a.handle}: ${w.join(', ')} (keys already set were kept).` : `nothing written: @${a.handle} already has these settings.`
    }
    case 'set': {
      const a = accountRow(db, pos[2]); const key = pos[3]
      if (!a) throw new Error(`unknown managed account: ${pos[2] || '(none)'}`)
      if (!key || !opts.file) throw new UsageError('usage: setup set <handle|id> <key> --file <value.txt>')
      if (key !== 'voice' && !SETUP_SET_KEYS.includes(key)) throw new UsageError(`"${key}" cannot be set here (setup keys lists the allowed ones)`)
      const value = input.bytes(opts.file).toString('utf8').trim()
      if (key === 'voice') saveVoice(db, 'account', a.id, value)
      else saveScoped(db, 'account', a.id, { [key]: value })
      return `${key} saved on @${a.handle}${value ? '' : ' (empty: inherited again)'}.`
    }
    default: throw new UsageError(SETUP_USAGE)
  }
}

function statusText(d, extra) {
  const yes = (b) => (b ? 'done' : 'to do')
  const lines = ['Growth Studio set up, for the user of this mission:']
  if (extra && extra.agent) lines.push(`1. Agent: ${extra.agent}`)
  lines.push(`2. Accounts: ${yes(d.accounts > 0)}`)
  for (const o of d.organizations) {
    lines.push(`   organization #${o.id} "${o.name}"`)
    for (const a of o.accounts) lines.push(`     account #${a.id} @${a.handle} (${a.network}, ${a.lang || 'no language'}, ${a.role || 'no role'})`)
  }
  if (!d.organizations.length) lines.push('   no organization yet')
  lines.push(`   networks: ${d.networks.map((n) => n.id).join(', ')}`)
  if (d.writing) {
    lines.push(`3. Writing (@${d.writing.account.handle}): ${yes(d.writing.filled.voice)}`)
    for (const [k, v] of Object.entries(d.writing.filled)) lines.push(`   ${k}: ${v ? 'set' : 'empty'}`)
  } else lines.push('3. Writing: needs an account first')
  if (extra && extra.connectors) {
    lines.push('4. Optional connectors (the user adds the pluginPolicy lines and the secrets; never edit timon.config.json):')
    for (const c of extra.connectors) lines.push(`   ${c.label}: ${c.ok === true ? 'ready' : c.ok === false ? `not ready (${c.hint})` : `unknown (${c.hint})`}`)
    if (extra.policy) lines.push('   pluginPolicy to add (timon.config.json, then restart Timon):', ...extra.policy.split('\n').map((l) => `     ${l}`))
    for (const s of extra.secrets || []) lines.push(`   secret ${s.name}: ${s.set}`)
  }
  lines.push('5. Optional import of an existing growth.db: from the Set up screen of the studio only (administrator).')
  lines.push(`6. Test draft: ${d.test.posts ? `done (last post #${d.test.last.id}, ${d.test.last.status})` : 'to do'}`)
  return lines.join('\n')
}
