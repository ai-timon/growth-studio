# Migrations

A user who installs an update of the plugin must never lose data. The rules below make that hold.

## Files

`schema.sql` is the consolidated schema at version 20. Every later change is one file here, named
`NNN-<short-name>.sql` with `NNN` >= `021` (three digits or more). Its first lines declare its phase:

```sql
-- phase: expand
ALTER TABLE posts ADD COLUMN summary TEXT;
UPDATE posts SET summary = substr(body, 1, 140);
```

A file never sets `user_version`: the plugin does, in the same transaction.

An optional `NNN-<short-name>.steps.json` next to it holds what SQL alone cannot do:

```json
{
  "settings": { "copy": { "old_key": "new_key" }, "remove": ["older_key"] },
  "kv": { "copy": { "oldKvKey": "newKvKey" }, "remove": ["olderKvKey"] },
  "media": { "rewrite": [{ "from": "media/", "to": "media/posts/" }] }
}
```

- `settings`: keys of the `settings` and `scoped_settings` tables. `copy` writes the value under the new key (unless
  it already exists), `remove` deletes the old key. Both run inside the migration's transaction.
- `kv`: keys of the plugin's key-value store (`ctx.storage.kv`). It lives outside the database, so the plugin applies
  these steps after the commit, at every start, in version order. `copy` only fills a new key that is absent.
- `media`: rewrites the prefix of the paths stored in `posts.media` and copies each file to its new place, inside
  the media folder only. The old files stay.
- The settings declared in the plugin manifest cannot be renamed: the plugin may only read them. Add a new key and
  read the old one as a fallback.

## Expand, then contract

A column, a table or a settings key never disappears in the version that replaces it.

1. **expand** (version N): add the new column, table or key, and copy the data into it. The old one stays and keeps
   being readable. An `expand` migration contains no `DROP TABLE`, `DROP COLUMN` or `ALTER TABLE … RENAME`, and its
   steps only `copy`. `DROP VIEW`, `DROP TRIGGER` and `DROP INDEX` are allowed: they hold no data, and dropping them
   is how they are recreated.
2. **contract** (a later version, N+1 or after): remove what the expand migration replaced, once no shipped code
   reads it any more.

The plugin refuses a migration that breaks this rule (`checkMigration`, lib/db.js), and so does the test suite.

## What happens at startup (lib/upgrade.js)

- **Nothing to migrate**: nothing is written and no backup is taken.
- **Migrations pending**: a `growth.db.migrating` marker tells the agent CLI to refuse writes. The plugin copies the
  database to `growth.db.bak-v<from>-<date>` in its storage folder with `VACUUM INTO`, and keeps the last N copies
  (setting `backupsToKeep`, default 5). Then it applies every pending migration in **one** transaction, with
  foreign keys off. After each migration it runs `integrity_check` and `foreign_key_check`, where only violations
  that did not exist before count. Any failure (SQL error, failed check, failed backup) rolls the whole update back:
  the database stays at its previous version, never half migrated. The studio then turns **read-only**, and the UI
  and the logs show the reason and the backup's path.
- **Database newer than the code** (an older plugin reinstalled): the plugin writes nothing and runs no job
  (publication, watch, missions, agent writes). The UI says `database v23, plugin knows v22: install Growth Studio
  v… or newer`. The version to install comes from the plugin's kv store, where each version records the schema it
  brought. There is never a downward migration.

## At each release that changes the schema

1. Add the migration (and its steps, if any), with its phase, and bump `version` in the plugin's `package.json`:
   it is the version an older plugin names when it meets this database.
2. Freeze a sample database of the new version in `test/fixtures/db-v<N>.sql` (in the plugin folder).
   Fictional data only, at least one row in every table. Build it like this: start from the previous fixture,
   migrate it, add rows to the new tables, then run `sqlite3 sample.db .dump` and append `PRAGMA user_version = N;`.
   `.dump` does not write the version. The test refuses a release without a fixture for its version.
3. `npm test`: every fixture is migrated to the current version, and the test checks that no row is lost (counts per
   table, chosen rows) and that the result passes the integrity checks.
4. Commands or rules of the agent CLI changed? Bump `TOOLS_SKILL_VERSION` (lib/agent-channel.js). The plugin
   reinstalls the skill at its next start.
