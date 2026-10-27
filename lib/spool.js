// Spool: how the agent CLI reaches the plugin's data from inside a sandboxed mission.
// A sandboxed backend (Codex in `workspace-write`, measured on 2026-10-24) can neither read nor write
// `<plugins-data>/growth-studio/`: only its working folder and the system temporary folder are open to it. So the CLI
// never opens the database: it drops a request file in a private folder of the temporary directory, the plugin's host
// half (not sandboxed) runs the command with the same functions (lib/agent-tools.js) and drops the answer next to it,
// and the CLI prints that answer with the command's exit code. Same path for every backend.
// Files are written under a temporary name then renamed, so a reader never sees half a file.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SPOOL_VERSION = 1
const REQ = /^req-([0-9a-f-]{36})\.json$/
const RES_MAX_AGE_MS = 10 * 60_000
const REQ_MAX_BYTES = 12 * 1024 * 1024

/** Spool folder of one installation (one per plugin storage folder), in the system temporary directory. */
export function spoolDir(storageDir, tmp = os.tmpdir()) {
  const tag = createHash('sha256').update(path.resolve(String(storageDir))).digest('hex').slice(0, 12)
  return path.join(tmp, `growth-studio-spool-${tag}`)
}

/** Creates the folder, private to the current user; refuses one that another user owns or could write to. */
export function ensureSpool(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    const st = statSync(dir)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`spool folder ${dir} belongs to another user`)
    if (st.mode & 0o022) throw new Error(`spool folder ${dir} is writable by other users`)
  }
  return dir
}

const writeAtomic = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, file) }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * CLI side: sends one command and waits for the answer (synchronously, the agent needs the refusal in the same call).
 * `files` maps each path the command reads to its content (base64), so the host never opens a path an agent chose.
 * `knows` is the schema version the CLI knows: the host refuses its writes on a newer database. `owner` is the Timon
 * user the command acts for (`--owner`): the host only shows and changes that user's data. `node` is the version of
 * the runtime the agent ran the CLI with (agent check of the Set up).
 * Returns { code, out, err }.
 */
export function request(dir, { argv, files = {}, knows = null, owner = null, node = null }, { timeoutMs = 60_000, pollMs = 100 } = {}) {
  if (!existsSync(dir)) return { code: 1, out: '', err: `Growth Studio is not reachable (no spool folder ${dir}): is the plugin active?` }
  const id = randomUUID()
  const res = path.join(dir, `res-${id}.json`)
  writeAtomic(path.join(dir, `req-${id}.json`), JSON.stringify({ v: SPOOL_VERSION, id, argv, files, knows, owner, node, at: new Date().toISOString() }))
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (existsSync(res)) {
      try {
        const r = JSON.parse(readFileSync(res, 'utf8'))
        rmSync(res, { force: true })
        return { code: Number(r.code) || 0, out: String(r.out || ''), err: String(r.err || '') }
      } catch { /* renamed but not readable yet: retry */ }
    }
    sleep(pollMs)
  }
  rmSync(path.join(dir, `req-${id}.json`), { force: true })
  return { code: 1, out: '', err: `Growth Studio did not answer within ${Math.round(timeoutMs / 1000)} s: is the plugin active?` }
}

/**
 * Host side: handles the pending requests once. `handle({ argv, files, knows, owner })` returns { code, out, err } (it must not
 * throw; a throw is reported as an error answer). Old unread answers are removed. Returns the number handled.
 */
export async function drain(dir, handle) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name)
    const m = REQ.exec(name)
    if (!m) {
      if (/^res-/.test(name)) { try { if (Date.now() - statSync(file).mtimeMs > RES_MAX_AGE_MS) rmSync(file, { force: true }) } catch { /* gone */ } }
      continue
    }
    let req = null
    try {
      if (statSync(file).size > REQ_MAX_BYTES) throw new Error('request too large')
      req = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) { req = { error: e.message } }
    rmSync(file, { force: true })
    let answer
    if (req.error) answer = { code: 1, out: '', err: `unreadable request: ${req.error}` }
    else if (req.v !== SPOOL_VERSION || !Array.isArray(req.argv)) answer = { code: 2, out: '', err: 'request in an unknown format: update the plugin' }
    else {
      try { answer = await handle({ argv: req.argv.map(String), files: req.files && typeof req.files === 'object' ? req.files : {}, knows: Number.isInteger(req.knows) ? req.knows : null, owner: typeof req.owner === 'string' && req.owner ? req.owner : null, node: typeof req.node === 'string' ? req.node.slice(0, 40) : null }) } catch (e) { answer = { code: 1, out: '', err: e.message } }
    }
    writeAtomic(path.join(dir, `res-${m[1]}.json`), JSON.stringify(answer))
    n++
  }
  return n
}
