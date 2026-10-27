# Growth Studio — project instructions

This folder is both the **Timon project `growth-studio`** and the git repository of the plugin
`@timon-ai/growth-studio` (github.com/ai-timon/growth-studio). Read this file at the start of every mission.
What the plugin does and how to use it: `README.md`.

## Who works here

| Agent | Role |
| --- | --- |
| `growth-studio.main` | Orchestrator, and growth agent of the Timon brand (writes Timon's posts in the studio). Its brand brief is its agent doc `BRIEF.md`, not this file. |
| `growth-studio.coder` / `.reviewer` / `.merger` | Kanban pipeline code → review → merge on this repository. |
| One growth agent per promoted company | Each brand gets its own agent; its brief (product, targets, interdicts, source of truth) lives in its agent docs, never in this repo. |

The plugin is **agnostic**: it can promote any company. Nothing specific to a brand (Timon or a client) goes into
the code, the UI, the mission prompts or this file: it lives in the studio settings (organization, account) and in
the brand agent's docs.

## Rules for code

- Everything in English: code, comments, UI, mission prompts, settings (`createTranslator` for translations).
- No dependency on a model provider: the user picks the agent's backend and may not have Claude.
- Guards live in SQL triggers, not only in prompts: validation by the user's click only (`validated_by` is never
  written by an agent), visual before scheduling unless the user ticked "Publish without a visual", no competitor
  named in a post, reference accounts never feed an idea or a post.
- Multi-user: every read and write is scoped by `owner_user_id`.
- Migrations: shipped in the plugin, applied at start-up with a backup of the database first.
- Never a secret in the code, the database or the logs (key names only).
- Published under the npm scope `@timon-ai`, MIT licence.

## Develop and ship a version

1. Work on a branch; tests: `npm test` (or `npm test -- <file>`), never `node --test` / `vitest` by hand.
2. Test on a **dev Timon instance** with its own folder, never on the user's instance nor on
   `~/.timon/plugins-data/growth-studio/`. Start the dev instance with its own `TIMON_HOME` (for example under
   `/tmp`) and install the packed archive there.
3. Bump the version (`package.json` + `CHANGELOG.md`), `npm pack`, tag `v<version>`, GitHub release with the archive
   and its sha256.
4. Install for the user: copy the archive to `~/.timon/plugins/archives/`, `timon plugin remove growth-studio`, then
   `timon plugin add ~/.timon/plugins/archives/<archive>.tgz --yes` (same id: data, settings, granted secrets and
   `pluginPolicy` are kept); check `timon plugin` (active) and `GET /api/plugins/growth-studio/admin/data`.

Never restart the Timon daemon for a plugin change (the host side reloads hot); only a change of
`~/.timon/timon.config.json` needs a restart, which is the user's gesture. A step to run on the live database after a
merge (SQL, setting, import) is never left to the merger: the coder reports it to `growth-studio.main`, which applies
it after a backup.

## Where things are

- Installed plugin (production): `~/.timon/plugins/node_modules/@timon-ai/growth-studio/`, from a release archive,
  never a link to this repo.
- Plugin data: `~/.timon/plugins-data/growth-studio/` (`growth.db`, `media/`, `staging.json`, `growth.db.bak-*`).
  Read and write it only through the plugin's CLI (skill `growth-studio-tools`), never with sqlite.
- Render bench (dev tool, outside the package): `tools/render-bench/`.
- Agents' working files (post texts, idea or verdict JSON): `/tmp`, never this repo.
