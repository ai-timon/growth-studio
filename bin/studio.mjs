#!/usr/bin/env node
// Growth Studio agent CLI. The plugin installs a skill (lib/agent-channel.js) that gives its agent the absolute path
// of this file and of the plugin's spool folder, so a mission reads and writes the plugin's data without depending on
// any project folder, and without touching the database itself (a sandboxed backend cannot open it).
//   node studio.mjs --spool <folder> --owner <user> <command> …   through the plugin (what the skill uses)
//   node studio.mjs --db <growth.db> [--owner <user>] <command> …   directly on a database file (tests, operator)
// `--owner` is the Timon user the command acts for: only that user's accounts, posts and settings are seen and
// changed (lib/scope.js). Required through the plugin; without it in direct mode the whole database is seen.
// Writes are refused while the database is being migrated or when it is newer than the schema this CLI knows.
// `node studio.mjs --db x help` lists the commands. Exit codes: 0 ok, 1 refused or error, 2 usage.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// The tools need Node 22.5 or newer (node:sqlite). Checked before anything is loaded, so that an older runtime gets
// this message instead of an import error.
const NODE_MIN = [22, 5]
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < NODE_MIN[0] || (major === NODE_MIN[0] && minor < NODE_MIN[1])) {
  console.error(`Growth Studio tools need Node ${NODE_MIN.join('.')} or newer; this command ran with Node ${process.versions.node}. Install a newer Node.js, or set the plugin setting "agentNode" to the command of one, then run the agent check of the Set up again.`)
  process.exit(1)
}
// node:sqlite prints an ExperimentalWarning on some Node versions: noise in every answer the agent reads
process.removeAllListeners('warning')
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(String(w.stack || w)) })
const { USAGE, UsageError, diskInput, fileArgs, isReadOnly, runTool } = await import('../lib/agent-tools.js')
const { MEDIA_DIR, knownVersion, openDatabase } = await import('../lib/db.js')
const { checkOwnerId, scopeDb } = await import('../lib/scope.js')
const { request } = await import('../lib/spool.js')
const { writeRefusal } = await import('../lib/upgrade.js')

function take(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return null
  const v = args[i + 1] || null
  args.splice(i, 2)
  return v
}

function viaSpool(dir, argv, owner) {
  if (!owner) return { code: 2, out: '', err: 'usage: --owner <user id> is required: use the value your mission gives ("Growth Studio user of this mission")' }
  const files = {}
  for (const f of fileArgs(argv)) {
    const abs = path.resolve(f)
    if (!existsSync(abs)) return { code: 1, out: '', err: `file not found: ${f}` }
    files[f] = readFileSync(abs).toString('base64')
  }
  return request(dir, { argv, files, knows: knownVersion(), owner, node: process.versions.node })
}

function direct(file, argv, owner) {
  if (!existsSync(file)) return { code: 1, out: '', err: `database not found: ${file}` }
  if (owner) { try { checkOwnerId(owner) } catch (e) { return { code: 2, out: '', err: e.message } } }
  // the schema this CLI knows: never write to a database being migrated or written by a newer plugin
  const refusal = isReadOnly(argv) ? null : writeRefusal(file)
  if (refusal) return { code: 1, out: '', err: refusal }
  const db = openDatabase(file, { readOnly: isReadOnly(argv) })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    if (owner) scopeDb(db, owner, { readOnly: isReadOnly(argv) })
    // a database used directly keeps its media next to it, as in the plugin storage
    const base = path.dirname(path.resolve(file))
    return { code: 0, out: runTool(db, argv, { paths: { base, mediaDir: path.join(base, MEDIA_DIR) }, input: diskInput }), err: '' }
  } catch (e) {
    return { code: e instanceof UsageError ? 2 : 1, out: '', err: e instanceof Error ? e.message : String(e) }
  } finally {
    try { db.close() } catch { /* already closed */ }
  }
}

function main() {
  const args = process.argv.slice(2)
  const spool = take(args, '--spool')
  const db = take(args, '--db')
  const owner = take(args, '--owner')
  if ((!spool && !db) || !args.length) { console.error(`usage: studio.mjs --spool <folder> --owner <user> | --db <growth.db> [--owner <user>] <command>\n\n${USAGE}`); return 2 }
  const r = spool ? viaSpool(spool, args, owner) : direct(db, args, owner)
  if (r.out) console.log(r.out)
  if (r.err) console.error(r.err)
  return r.code
}

process.exitCode = main()
