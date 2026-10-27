# Changelog

Versions follow [semver](https://semver.org). The schema version of the database (`PRAGMA user_version`) is given
when it changes; every shipped schema version has its fixture in `test/fixtures/`.

## 0.2.0-rc.17 — 2026-10-27

Calendar drag and drop and open source preparation. No schema change (22).

- Calendar: a scheduled post moves by drag and drop. In the day, 3-day and week views the time follows the pointer
  (5-minute steps, the part of the post that was grabbed stays under it) and a dashed box shows the slot and its time;
  in the month view the post keeps its time and changes day. A slot already past is shown in red and refused. The move
  goes through `POST posts/:id/schedule` (same checks as "Schedule for…"); the post shows at its new place at once and
  goes back if the server refuses. Published and failed posts do not move.
- Calendar: a post with an image shows its thumbnail when its box has room for it (at least 30 px high and 120 px wide
  per post: enlarge the hours by dragging the hour column).
- The package is released under the MIT licence (`LICENSE`), its author is Timon (https://timon-ai.com), and
  `package.json` gets `repository`, `homepage` and `bugs` pointing to github.com/ai-timon/growth-studio.

## 0.2.0-rc.16 — 2026-10-26

Release of the prospecting comments (0.2.0-rc.10 to rc.15), schema version 22. No change of code since rc.15.

- Upgrading from 0.2.0-rc.9 or older runs migration `022-comment-campaigns` at start-up, after a backup of the
  database (`growth.db.bak-v21-…`). Nothing is searched nor sent until an administrator switches the plugin setting
  `commentsJob` on, a user creates a campaign and switches it on, and every reply is validated in the studio.
- The changelog entries of rc.10 to rc.15 are now in version order.

## 0.2.0-rc.15 — 2026-10-26

One agent per organization. No schema change (22).

- New setting `agent` (tab **Agent** of Settings › General, an organization or an account), in cascade account →
  organization → user → plugin setting `agent`. Every mission about an account runs on the agent resolved for it:
  post requests, ideas and their drafts, drafts from an item, bookmark triage, comment qualification, the Set up test
  draft; the user's level for the synthesis, the free request without account and the rule sent to memory. The Set up
  conversation and the agent check stay on the plugin's agent. Nothing set anywhere: unchanged, the plugin's agent.
- A news item serving accounts of organizations with different agents starts one mission per agent (and per user); an
  agent refused for some accounts does not stop the others' mission.
- Scoping: an agent is chosen among the user's Timon agents (`GET /agents`, `ctx.agents.list()` in their request) and
  then granted to that user (kv `agentGrants`). A mission only starts on the plugin's agent or on an agent granted to
  its user (and still listed for them in their request); otherwise it is refused with a clear message.

## 0.2.0-rc.14 — 2026-10-26

Prospecting comments, the studio side. No schema change (22).

- **Comments** view in the studio menu (badge: replies to validate): tabs To validate / Sent / Discarded, each reply
  beside the post it answers (author, picture, followers, metrics, link), the score, the pain recognized, the reason
  and the competitor stance; the reply is editable. **Validate** (`POST /comments/:id/approve`) writes `validated_by`
  with the signed-in user and leaves the reply `approved` without a slot, for the publication task; refused for a
  reply whose candidate is not `drafted` or whose author is not unaffiliated, or with a URL. **Rewrite…** reuses the
  direct rewrite mission of the posts. **Discard** (`POST /comments/:id/dismiss`) needs a reason: the reply becomes
  rejected, its candidate dismissed, and the reason is recorded as feedback on the reply (text `Comment rejected: …`,
  shown with a "Comment" tag in Learning). Today's sent replies per account against the lowest daily ceiling of its
  active campaigns, in the account's publishing time zone.
- Replies to comment candidates (kind and post type `reply`) no longer show in the Posts queue nor in its counters.
- Settings › account › **Comments** tab: create and edit the account's campaigns (on/off, name, languages, limits,
  budget, active hours, follower ceiling, notes) and their pains (pain, searches, examples, solution, source,
  evidence; an active pain needs its solution and source); then the instruction `comments_prompt`, also editable at
  the organization and global levels.
- Settings › **Competitors**: competitors (name, website, followed), their aliases and their team (handle, role,
  source); authors of candidates dismissed for an affiliation (`competitor` or `unknown`) are listed with a one-click
  add to a team. Shared by the installation, like the competitors.
- Routes `GET /comments`, `GET|POST /comments/campaigns`, `PUT /comments/campaigns/:id`,
  `POST /comments/campaigns/:id/pains`, `PUT /comments/pains/:id`, `GET|POST /competitors`, `PUT /competitors/:id`,
  `POST /competitors/:id/aliases[/remove]`, `POST /competitors/:id/team[/remove]`; another user's campaign, pain or
  reply answers 404.
- English and French; render bench `tools/render-bench/comments-shots.mjs`.

## 0.2.0-rc.13 — 2026-10-26

Prospecting comments, sending of the validated replies. No schema change (22).

- A validated reply (kind `reply`, aimed at a post) has no editorial slot: validating it schedules nothing, and the
  publishing check (every 30 s) sends it as soon as its campaign allows it, through the account's treg publishing tool
  with `reply.in_reply_to_tweet_id`. The cost goes to `ingest_runs` (source `reply`; $0.015 when treg reports none).
  The "Publish" button of a reply follows the same path.
- Checked again right before sending: affiliation of the targeted author (competitor team, official account, handle or
  stored bio matching a competitor alias, unknown author), candidate still drafted with an unaffiliated author and,
  for a post about a competitor, a critical stance; no URL and no competitor name in the text; one reply per post.
  Any doubt marks the reply `failed`, nothing is sent.
- Limits of the campaign, empty ones from the new settings `comments_max_replies_per_day` (10) and
  `comments_min_gap_min` (15) (group "comments", cascade account → organization → user): replies per day (local day
  of the account), minutes since the account's last reply, days before replying to the same author again, campaign
  switched on. A limit reached leaves the reply `approved`; it goes at the next allowed moment.
- A failure marks the reply `failed` with an urgent alert and is never tried again; success marks it `published` with
  the X post id and its candidate `replied`. A reply sent but not recorded is marked `failed` with its X id, never
  sent twice.

## 0.2.0-rc.12 — 2026-10-26

Second part of the prospecting comments: the search job. No schema change.

- Background job `commentsJob` (plugin setting, off by default; `POST /admin/jobs/comments/run` for an administrator,
  state in `GET /connectors`): for each active campaign, searches the queries of its active pains through treg
  (`treg.x.search.posts`), within an interval (`comments_poll_interval_min`), a window (`comments_window_start` /
  `_end`, publishing time zone), the campaign's active hours, its daily search budget (`search_budget_usd`, else the
  new cascade setting `comments_search_budget_usd`) and a ceiling for all campaigns (`comments_daily_budget_usd`).
  Each pass is one `ingest_runs` row (source `search`); found posts are items captured with source `search`.
- Pre-filter without any model: post younger than 48 hours, not a retweet, in a language of the campaign, not a
  candidate yet; author neither managed, nor a reference account, nor contacted by the same account within the
  campaign's "same author" days.
- Affiliation checked before any qualification: the author's handle against `competitor_team`, competitor accounts
  and aliases, then the author's profile (`treg.x.user.profile`, kept a week: followers in `account_metrics`, bio in
  the item's `extra.author`) against the aliases. A match is set aside with `author_affiliation = 'competitor'`; an
  unreadable profile with `unknown` (never drafted); an author over the follower ceiling (`max_author_followers`, else
  the new setting `comments_max_author_followers`) is set aside too.
- One qualification mission at a time, for the waiting candidates of one account (`comments_batch_size`), at most
  `comments_max_missions_per_day` a day, started on the studio's agent. A candidate still waiting when its post is 48
  hours old is set aside. treg 401 stops the search with one alert.

## 0.2.0-rc.11 — 2026-10-26

Prospecting comments, second part: the agent's commands and the qualification mission. No schema change (22).

- Agent commands, scoped to the `--owner` user like every other: `comments campaign show <account>` (campaigns,
  pains with their searches, examples and verified solutions, limits, competitors and their teams),
  `comments candidates list [--account]` (to qualify, then qualified), `comments candidate show <id>` (post, author,
  bio when the search stored it, followers, metrics, known thread, competitor warnings),
  `comments qualify-commit <verdicts.json>` (per candidate: verdict qualify | dismiss, score, pain, reason, competitor
  stance, author affiliation) and `comments reply draft <candidate_id> --file <reply.txt>` (a post of kind and type
  `reply`, aimed at the candidate's post, pending validation, linked to the candidate).
- Stricter than the SQL guards: a verdict never clears an affiliation the studio recorded (`unknown` or
  `competitor`), a post of a competitor's team is never qualified, a post about a competitor only when it criticizes
  it, qualifying needs an active pain of the campaign and a score of 3 or more, one wrong verdict refuses the whole
  file; a reply only for a qualified candidate with an unaffiliated author, without URL and without a competitor name.
  `post revise` of a reply moves its candidate to the new version; `post show` shows the post a reply answers.
- Setting `comments_prompt` (group "comments", cascade account → organization → user): which found posts deserve a
  reply and how to write it, with a neutral default; `commentsBrief` frames the qualification mission (started by the
  comments job).
- Tools skill version 8.

## 0.2.0-rc.10 — 2026-10-26

Schema version 22 (migration `022-comment-campaigns`, expand). First part of the prospecting comments; no command or
screen uses it yet.

- New tables: `comment_campaigns` (one per managed account and owner: name, active (off by default), languages
  (the account's by default), replies per day, minutes between two replies, days before replying to the same author
  again (30 by default), daily search budget, active hours, follower ceiling of the targeted author), `comment_pains`
  (pain, search queries, positive and negative examples, verified solution and its source, evidence; an active pain
  needs its solution and source), `competitor_team` (people of a competitor: handle, role, source) and
  `comment_candidates` (found post, pain recognized, score 0-5, reason, competitor stance, author affiliation,
  status, dismissal reason, drafted reply).
- Absolute guards in SQL on `posts`, at insert and at every change of target, kind, account or status: never a reply
  to (nor a quote of) a post of a competitor's team (listed in `competitor_team`, official account, handle equal to a
  competitor alias), never a reply to a post of unknown author; a reply to a post about a competitor only with a
  candidate of the same account that marks it `critical` with an author affiliation `none`. A competitor is still
  never named in a post.
- A reply (`kind = 'reply'`) needs no visual of its own.
- Multi-user: campaigns, pains and candidates are scoped by their owner; competitor teams are shared like competitors.

## 0.2.0-rc.9 — 2026-10-25

- Agent command `item add <url> [--role brand|personal]`: stores an X post that is not in the studio yet, so that a draft
  can quote it. The studio reads it through its treg connector (`anyapi.twitter.tweet`, about $0.00075), creates its
  author if missing (watched, not polled, with its name and picture; `--role`, else `brand` when its name looks like a
  company or product's, else `personal`), the item, its metrics and a `manual` capture,
  and prints the item id. A post already in the studio gives its id back without any call. As in the triage, a
  competitor's author or text sets `competitor_id`, and a reference account's post is stored with a warning (it never
  feeds an idea or a post). The cost goes to `ingest_runs` (source `manual`) and counts in the daily watch budget, which
  the watch now shares with it. Without a treg connector the command says so.
- `post revise <post_id> … --quote <item_id>`: the new version quotes that item (kind `quote`, no visual of its own
  required). Tools skill version 7.

## 0.2.0-rc.8 — 2026-10-25

- Agent command `watch` to manage the watched accounts without touching the database: `watch list [--all]`,
  `watch add <handle> --role brand|personal --priority breaking|daily|weekly [--watch-role source|reference]
  [--interval <min>] [--hours HH-HH] [--lang xx] [--name …] [--notes …]`, `watch set <handle> …` (same options, `none`
  clears) and `watch remove <handle>` (stops the polling, keeps the account and its items). An account already in the
  studio is refused, a competitor alias sets its `competitor_id`, nothing is fetched (the next poll is the baseline).
  Watched accounts stay shared by every user of the installation. Tools skill version 6.

## 0.2.0-rc.7 — 2026-10-25

- Fixed: the active side menu entry was a solid block hiding its label and picto; it now looks like the product's own entries.

## 0.2.0-rc.6 — 2026-10-25

- The studio's agent beside the page: the first time the `/growth` page opens on a set-up studio, the chat of the studio's agent opens on its right, once (closing it is respected). An « Agent » button in the header opens it again or brings it forward.

## 0.2.0-rc.5 — 2026-10-25

- Entry in the side menu: Growth Studio now has its own row with its picto, opening the `/growth` page.

## 0.2.0-rc.4 — 2026-10-24

- Weekly synthesis of the feedback as a plugin job (`synthesisJob`, off by default): once a week (Sunday 19:00 in the
  publishing time zone by default, global settings `synthesis_weekday` / `synthesis_hour`), one mission per user with
  feedback not synthesized yet proposes rules; the user decides in Settings › Learning.
- `POST /admin/jobs/<bookmarks|watch|synthesis>/run` (administrator): one forced pass of a job whose switch is on, to
  check it right after switching from another tool.

## 0.2.0-rc.3 — 2026-10-24

- npm package named `@timon-ai/growth-studio`, the official Timon scope (the archive is
  `timon-ai-growth-studio-<version>.tgz`); the plugin id stays `growth-studio`, so installed data, settings, grants
  and `pluginPolicy` entries are unchanged.
- 0.2.0-rc.2, published under another scope by mistake, is withdrawn.
- README: upgrading from a package with another npm name (remove the old package first, data kept).

## 0.2.0-rc.1 — 2026-10-24

First release candidate of the self-contained plugin, unsigned, for tests on a clean instance.

- Package: npm `files` limited to what ships (`lib/`, `bin/`, `db/`, icon, screenshots, README, CHANGELOG, LICENSE),
  author, licence, cover and screenshots taken on the fictional demo seed; tests shipped with the sources.
- README: permissions and why, settings, optional connectors (binaries, domains, secrets, `pluginPolicy`, costs),
  what stops when disabled, uninstall, import, known limits (Node.js missing from the agent's PATH, Windows, macOS),
  release cycle.
- First launch: Set up screen and `growth-studio-setup` skill (agent, accounts, writing, connectors, import, test
  draft).
- One studio per Timon user: organizations, accounts and what depends on them belong to their user; global settings
  per user. Schema version 21 (`owner_user_id`, `user_settings`).
- Interface in English, French translation through `createTranslator`.
- Editorial instructions in settings with generic defaults; no person, path, locale or zone in the code.
- Optional connectors (treg, GetXAPI, GPT Image through the agent, headless Chrome); bookmarks and watch jobs in the
  plugin, off by default.
- Updates without data loss: backup before migrating, all-or-nothing migrations, read-only on failure, no downgrade.
- The agent's tools ship with the plugin (`bin/studio.mjs` and the `growth-studio-tools` skill), through an exchange
  folder: the agent never opens the database.
- Own database in the plugin's storage folder (schema version 20 shipped, migrations from 21), import of an existing
  `growth.db`.

## 0.1.0

Studio used from its original project folder: drafts queue, validation, automatic scheduling, calendar, triage,
publishing on X. Not distributed.
