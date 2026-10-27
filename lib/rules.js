// Learned rules: applying a proposal to the studio's rules (the account's, or the user's for all accounts) and taking
// it back. Shared by the user's click (host routes) and the automatic acceptance of `feedback propose`.
// The functions do not open a transaction: the caller wraps them with whatever else it writes.
import { globalValue, resolve, saveScoped } from './accounts.js'
import { ownerOf } from './scope.js'

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Own `rules` value of the level a proposal targets: [scope, scope id, value]. */
function target(db, r) {
  if (r.account_id) {
    const cur = db.prepare(`SELECT value FROM scoped_settings WHERE scope = 'account' AND scope_id = ? AND key = 'rules'`).get(r.account_id)
    return ['account', r.account_id, cur ? String(cur.value) : '']
  }
  return ['global', 0, globalValue(db, 'rules', ownerOf(db)) || '']
}

/** Does the user (or the account's cascade) let the studio apply a learned rule by itself? Default: yes. */
export function autoAcceptRules(db, accountId = null) {
  const v = accountId ? resolve(db, 'account', accountId, 'rules_auto_accept') : resolve(db, 'global', 0, 'rules_auto_accept')
  return v.value !== '0'
}

/** Writes a proposed rule into the rules of its scope and marks it accepted. `auto` records an automatic acceptance
 *  (decision_note 'auto'). Returns the stored text (the user's note is appended to it). */
export function acceptRule(db, r, { note = '', auto = false } = {}) {
  const text = note ? `${r.text} (${note})` : r.text
  const [scope, sid, cur] = target(db, r)
  saveScoped(db, scope, sid, { rules: [cur, text].filter(Boolean).join('\n') })
  db.prepare(`UPDATE main.rule_proposals SET status = 'accepted', decided_at = ?, decision_note = ?, text = ? WHERE id = ?`)
    .run(nowIso(), auto ? 'auto' : (note || null), text, r.id)
  return text
}

/** Removes the exact line of an accepted rule from the rules of its scope (other lines, hand-written ones included,
 *  stay) and marks it revoked. Returns { found }: false when the line is no longer there (edited by hand). */
export function revokeRule(db, r, { note = '' } = {}) {
  const [scope, sid, cur] = target(db, r)
  const lines = cur.split('\n')
  const wanted = String(r.text).trim()
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === wanted) { at = i; break }
  if (at >= 0) {
    lines.splice(at, 1)
    saveScoped(db, scope, sid, { rules: lines.join('\n') })
  }
  db.prepare(`UPDATE main.rule_proposals SET status = 'revoked', decided_at = ?, decision_note = ? WHERE id = ?`).run(nowIso(), note || null, r.id)
  return { found: at >= 0 }
}
