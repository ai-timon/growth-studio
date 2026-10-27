-- Growth Studio database: multi-network, multi-account. SQLite. Dates are ISO 8601 UTC.
-- Schema version 20 (consolidated). Later changes ship as db/migrations/NNN-*.sql, starting at 021.
-- Never store a secret here (keys, tokens, cookies).
PRAGMA foreign_keys = ON;

-- ── Reference data ─────────────────────────────────────────────────────────
CREATE TABLE networks (
  id   TEXT PRIMARY KEY,               -- x, linkedin, reddit, youtube, hn…
  name TEXT NOT NULL
);

-- ── Competitors: internal watch only, NEVER named in our posts ─────────────
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  website TEXT, category TEXT, brain_note TEXT,   -- path of a related note, if any
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE competitor_aliases (               -- names, handles, keywords spotted in a text
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  alias TEXT NOT NULL COLLATE NOCASE, UNIQUE (alias)
);

-- Accounts we MANAGE (relation='owned') or OBSERVE ('watched').
-- Organizations (v15) group managed accounts; their settings cascade (account → organization → global).
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  network       TEXT NOT NULL REFERENCES networks(id),
  handle        TEXT NOT NULL,         -- without @
  external_id   TEXT,                  -- numeric id on the network
  display_name  TEXT,
  relation      TEXT NOT NULL CHECK (relation IN ('owned','watched')),
  role          TEXT CHECK (role IN ('personal','brand','automated')),  -- owned: role of the account; watched (v20): brand = official account of a company or product, personal = a person (Feed grouping)
  lang          TEXT,                  -- editorial language of the account
  is_automated  INTEGER NOT NULL DEFAULT 0,  -- openly automated account
  watch_role    TEXT CHECK (watch_role IN ('source','reference','audience','candidate')),  -- source = content to adapt; reference = method to study, never copied; audience = target profile; candidate = awaiting the owner's decision
  watch_priority TEXT CHECK (watch_priority IN ('breaking','daily','weekly')),  -- breaking = polled often, a news item triggers a draft
  poll_mode     TEXT NOT NULL DEFAULT 'timeline' CHECK (poll_mode IN ('timeline','search_originals')),  -- search_originals: accounts that reply all the time (bots), only their original posts are fetched
  poll_interval_min INTEGER,            -- minutes between two polls (NULL = priority default)
  active_hours  TEXT,                   -- polling window in the publishing time zone, e.g. '07-23'
  avatar_url    TEXT,                   -- profile picture URL (v13)
  last_polled_at TEXT,
  competitor_id INTEGER REFERENCES competitors(id),  -- a competitor's account: internal watch only
  requires_validation INTEGER NOT NULL DEFAULT 1,  -- rule: human validation before publishing
  notes         TEXT,
  organization_id INTEGER REFERENCES organizations(id),  -- owned accounts only (v15)
  UNIQUE (network, handle)
);

-- Dated audience snapshots (followers, etc.): growth tracking and the "already known" criterion.
CREATE TABLE account_metrics (
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  captured_at TEXT NOT NULL,
  followers   INTEGER, following INTEGER, posts_count INTEGER,
  PRIMARY KEY (account_id, captured_at)
);

-- ── Observed content (watch, bookmarks…): what comes from the networks ─────
CREATE TABLE items (
  id          INTEGER PRIMARY KEY,
  network     TEXT NOT NULL REFERENCES networks(id),
  external_id TEXT NOT NULL,
  author_id   INTEGER REFERENCES accounts(id),
  kind        TEXT NOT NULL DEFAULT 'post',  -- post, reply, quote, thread, video, repo, article
  url         TEXT,
  text        TEXT,
  lang        TEXT,
  posted_at   TEXT,
  first_seen_at TEXT NOT NULL,
  conversation_id TEXT,                -- id of the thread's root post; = external_id for a root
  quoted_item_id INTEGER REFERENCES items(id),
  media       TEXT,                    -- JSON
  extra       TEXT,                    -- network-specific JSON
  UNIQUE (network, external_id)
);

CREATE TABLE item_metrics (
  item_id INTEGER NOT NULL REFERENCES items(id),
  captured_at TEXT NOT NULL,
  likes INTEGER, views INTEGER, shares INTEGER, replies INTEGER, saves INTEGER,
  PRIMARY KEY (item_id, captured_at)
);

-- Where an item comes from: one item can have several captures
-- (bookmark of an account, watch of a followed account, search, manual add…).
CREATE TABLE captures (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  source      TEXT NOT NULL CHECK (source IN ('bookmark','watch','search','manual','starred')),
  account_id  INTEGER REFERENCES accounts(id),  -- managed account concerned (owner of the bookmarks)
  query       TEXT,
  run_id      INTEGER REFERENCES ingest_runs(id),
  captured_at TEXT NOT NULL,
  UNIQUE (item_id, source, account_id)
);

-- Triage: one assessment per item (can be revised).
CREATE TABLE assessments (
  item_id     INTEGER PRIMARY KEY REFERENCES items(id),
  verdict     TEXT NOT NULL CHECK (verdict IN ('keep','to_confirm')),
  pillar      TEXT CHECK (pillar IN ('open_source','model','adapt_en','reference','build_in_public','competitor','other')),
  already_known INTEGER,               -- 1 = already seen by the audience (big account / viral) → no "discovery" post
  angle       TEXT,
  score       INTEGER CHECK (score BETWEEN 0 AND 5),   -- format/concept 0-2 + value for the audience 0-2 + freshness 0-1, -1 if the source is unverified; NULL for a competitor
  competitor_id INTEGER REFERENCES competitors(id),  -- the item is about a competitor (internal watch only)
  assessed_by TEXT, assessed_at TEXT NOT NULL
);

-- Off-topic: ONLY the identifier is kept (no text, no author), so it is never triaged again.
CREATE TABLE ignored_items (
  network TEXT NOT NULL REFERENCES networks(id),
  external_id TEXT NOT NULL,
  ignored_at TEXT NOT NULL,
  PRIMARY KEY (network, external_id)
);

-- ── Creation: above the networks ───────────────────────────────────────────
CREATE TABLE ideas (
  id        INTEGER PRIMARY KEY,
  title     TEXT NOT NULL,
  concept   TEXT NOT NULL,             -- the substance, independent of network and language
  pillar    TEXT,
  objective TEXT,                      -- measurable objective
  measure   TEXT,                      -- how it is measured
  origin    TEXT NOT NULL DEFAULT 'own' CHECK (origin IN ('own','watch','bookmark','other')),  -- where the idea comes from
  status    TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','approved','in_progress','done','dropped')),
  created_at TEXT NOT NULL,
  -- v16: original post ideas (reflection, observation, analysis: neither news nor share), proposed for one account
  kind      TEXT CHECK (kind IN ('reflection')),   -- NULL = regular idea (watch, bookmark…)
  account_id INTEGER REFERENCES accounts(id),      -- account the idea is proposed for
  angle     TEXT,                                  -- the position defended
  why_follow TEXT,                                 -- why a reader would want to follow
  ask_rom   TEXT,                                  -- legacy (before v19): question to the owner to anchor the post in lived experience
  decision_note TEXT,                              -- owner's writing instruction, or reason for dropping
  decided_at TEXT,
  post_type TEXT,                                  -- v17: key of a type from the post_types setting
  -- v19: idea built on an identified pain and a verified solution
  pain      TEXT,                                  -- the pain, in the reader's words
  solution  TEXT,                                  -- the concrete, verified way out
  solution_kind TEXT CHECK (solution_kind IN ('timon','outil','methode')),
  evidence  TEXT                                   -- where the pain and the solution come from
);

-- Inspirations: items that fed the idea.
CREATE TABLE idea_items (
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  relation TEXT NOT NULL DEFAULT 'inspired_by' CHECK (relation IN ('inspired_by','quotes','replies_to','counterpoint')),
  PRIMARY KEY (idea_id, item_id)
);

-- References of a post: any watch / bookmark item that fed it or that it cites
-- (besides the idea, through posts.idea_id). The technical target of a quote / reply stays
-- in posts.quote_item_id / reply_to_item_id.
CREATE TABLE post_items (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  relation TEXT NOT NULL DEFAULT 'inspired_by' CHECK (relation IN ('inspired_by','quotes','replies_to','counterpoint','cites')),
  PRIMARY KEY (post_id, item_id)
);

-- Drafts AND published posts: one idea → N posts (one per account / network).
CREATE TABLE posts (
  id         INTEGER PRIMARY KEY,
  idea_id    INTEGER REFERENCES ideas(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),   -- must be 'owned'
  kind       TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post','thread','reply','quote','article','video','comment')),
  lang       TEXT NOT NULL,
  body       TEXT NOT NULL,
  media      TEXT,                     -- JSON: [{"type":"image","path":"media/<id>.png","alt":"…"}], paths relative to the data folder
  image_prompt TEXT,                   -- visual brief for an image model (realistic or illustrated image)
  image_prompt_code TEXT,              -- v18: visual brief for a coded graphic (HTML -> PNG)
  quote_item_id    INTEGER REFERENCES items(id),
  reply_to_item_id INTEGER REFERENCES items(id),
  status     TEXT NOT NULL DEFAULT 'draft'
             CHECK (status IN ('draft','pending_validation','approved','scheduled','published','rejected','failed')),
  supersedes_post_id INTEGER REFERENCES posts(id),       -- successive versions of a draft
  validation_note TEXT,
  created_at TEXT NOT NULL,
  validated_at TEXT, validated_by TEXT,
  scheduled_for TEXT,
  published_at TEXT, external_id TEXT, url TEXT,
  post_type TEXT,                      -- v17: key of a type from the post_types setting
  no_media INTEGER NOT NULL DEFAULT 0  -- v18: 1 = the owner ticked "Publish without a visual" (never set by the agent)
);

CREATE TABLE post_metrics (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  captured_at TEXT NOT NULL,
  likes INTEGER, views INTEGER, shares INTEGER, replies INTEGER, saves INTEGER,
  followers_gained INTEGER, link_clicks INTEGER,
  PRIMARY KEY (post_id, captured_at)
);

-- ── Settings and fast reaction to primary-source news ──────────────────────
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- global settings (top of the cascade)
-- Settings of an organization or an account (v15); keys are described in lib/accounts.js.
CREATE TABLE scoped_settings (
  scope TEXT NOT NULL CHECK (scope IN ('organization','account')), scope_id INTEGER NOT NULL,
  key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key)
);

CREATE TABLE news_queue (               -- a detected news item -> explained draft -> validation
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  posted_at TEXT, detected_at TEXT NOT NULL,       -- detection delay = detected_at - posted_at
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','queued','drafted','validated','published','skipped')),
  mission_id TEXT, post_id INTEGER REFERENCES posts(id), drafted_at TEXT, note TEXT
);

-- ── Operations ─────────────────────────────────────────────────────────────
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL, account_id INTEGER REFERENCES accounts(id),
  started_at TEXT NOT NULL, pages INTEGER, items_new INTEGER, cost_usd REAL,
  status TEXT NOT NULL DEFAULT 'ok', error TEXT
);

-- Output of the competitor watch (internal only).
CREATE TABLE competitor_events (
  id INTEGER PRIMARY KEY, competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  item_id INTEGER REFERENCES items(id), occurred_at TEXT, recorded_at TEXT NOT NULL,
  type TEXT CHECK (type IN ('release','feature','pricing','funding','partnership','other')),
  summary TEXT NOT NULL, impact TEXT, reported_in_brain INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE learnings (               -- the owner's feedback and lessons learned, v14
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
  idea_id INTEGER REFERENCES ideas(id), post_id INTEGER REFERENCES posts(id),
  text TEXT NOT NULL,
  source TEXT CHECK (source IN ('reject','rewrite','edit','manual','synthesis')),
  category TEXT CHECK (category IN ('fond','ton','longueur','fait','timing','visuel','autre')),
  ignored INTEGER NOT NULL DEFAULT 0,    -- 1 = test or misclick: nothing to learn from it
  before_text TEXT, after_text TEXT,     -- direct edit: agent's text / owner's text
  synthesized_at TEXT,                   -- taken into account by a weekly synthesis
  account_id INTEGER REFERENCES accounts(id)   -- account of the post concerned (v15)
);

CREATE TABLE rule_proposals (          -- rules proposed by the weekly synthesis, decided by the owner in Growth Studio
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
  text TEXT NOT NULL, rationale TEXT,
  evidence TEXT,                         -- JSON: ids of the supporting learnings
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','refused')),
  decided_at TEXT, decision_note TEXT, mission_id TEXT,
  account_id INTEGER REFERENCES accounts(id)   -- rule specific to one account (NULL = all), v15
);

-- Requests the studio sent to the agent (rewrite, visual, idea suggestions…) and the mission that handles them.
CREATE TABLE studio_requests (
  id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id), kind TEXT NOT NULL, brief TEXT NOT NULL,
  mission_id TEXT, status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL,
  account_id INTEGER                     -- target account (original idea suggestions)
);

-- ── Mechanical guard rails ─────────────────────────────────────────────────
-- 1. Only a managed account can publish.
CREATE TRIGGER posts_owned_only BEFORE INSERT ON posts
WHEN (SELECT relation FROM accounts WHERE id = NEW.account_id) <> 'owned'
BEGIN SELECT RAISE(ABORT, 'posts.account_id must be an owned account'); END;

-- 2. No publication without explicit validation when the account requires it.
CREATE TRIGGER posts_need_validation BEFORE UPDATE OF status ON posts
WHEN NEW.status IN ('scheduled','published')
 AND (SELECT requires_validation FROM accounts WHERE id = NEW.account_id) = 1
 AND (NEW.validated_at IS NULL OR NEW.validated_by IS NULL)
BEGIN SELECT RAISE(ABORT, 'validation required before scheduling/publishing'); END;

CREATE TRIGGER posts_need_validation_ins BEFORE INSERT ON posts
WHEN NEW.status IN ('scheduled','published')
 AND (SELECT requires_validation FROM accounts WHERE id = NEW.account_id) = 1
 AND (NEW.validated_at IS NULL OR NEW.validated_by IS NULL)
BEGIN SELECT RAISE(ABORT, 'validation required before scheduling/publishing'); END;

-- 3. A competitor is NEVER mentioned in a post, not even to present a feature.
--    a) a competitor item (pillar 'competitor', competitor_id, or author = competitor account) feeds no idea and no post;
--    b) a post's text cannot contain any competitor alias.
CREATE VIEW v_competitor_items AS
SELECT i.id AS item_id FROM items i
LEFT JOIN assessments s ON s.item_id = i.id
LEFT JOIN accounts a ON a.id = i.author_id
WHERE s.pillar = 'competitor' OR s.competitor_id IS NOT NULL OR a.competitor_id IS NOT NULL;

CREATE TRIGGER idea_no_competitor BEFORE INSERT ON idea_items
WHEN NEW.item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor item: no post idea'); END;

CREATE TRIGGER post_no_competitor BEFORE INSERT ON post_items
WHEN NEW.item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor item: no post reference'); END;

CREATE TRIGGER post_text_no_competitor_ins BEFORE INSERT ON posts
WHEN EXISTS (SELECT 1 FROM competitor_aliases WHERE instr(lower(NEW.body), lower(alias)) > 0)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_items)
  OR NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor named or targeted: not allowed in a post'); END;

CREATE TRIGGER post_text_no_competitor_upd BEFORE UPDATE OF body, quote_item_id, reply_to_item_id ON posts
WHEN EXISTS (SELECT 1 FROM competitor_aliases WHERE instr(lower(NEW.body), lower(alias)) > 0)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_items)
  OR NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor named or targeted: not allowed in a post'); END;


-- 4. "reference" accounts are never copied: none of their posts feeds an idea or a post.
CREATE VIEW v_reference_items AS
SELECT i.id AS item_id FROM items i JOIN accounts a ON a.id = i.author_id WHERE a.watch_role = 'reference';

CREATE TRIGGER idea_no_reference BEFORE INSERT ON idea_items
WHEN NEW.item_id IN (SELECT item_id FROM v_reference_items)
BEGIN SELECT RAISE(ABORT, 'item from a reference account: its content is never reused'); END;

CREATE TRIGGER post_no_reference BEFORE INSERT ON post_items
WHEN NEW.item_id IN (SELECT item_id FROM v_reference_items)
BEGIN SELECT RAISE(ABORT, 'item from a reference account: its content is never reused'); END;

-- 5. A visual (image or video) on every post: no scheduling or publishing without media.
--    Exceptions: a quote (kind='quote' + quote_item_id) already shows the quoted post's visual; no_media = 1.
CREATE TRIGGER posts_need_media BEFORE UPDATE OF status ON posts
WHEN NEW.status IN ('scheduled','published') AND (NEW.media IS NULL OR NEW.media IN ('', '[]'))
 AND NOT (NEW.kind = 'quote' AND NEW.quote_item_id IS NOT NULL)
 AND COALESCE(NEW.no_media, 0) = 0
BEGIN SELECT RAISE(ABORT, 'a visual is required before scheduling or publishing (or tick "Publish without a visual")'); END;

-- ── Read views (the per-network "tables") ──────────────────────────────────
CREATE VIEW v_bookmarks AS
SELECT c.account_id AS owner_account_id, i.network, i.id AS item_id, a.handle AS author, i.url, i.text,
       asm.verdict, asm.pillar, asm.already_known, asm.angle, asm.score, c.captured_at
FROM captures c JOIN items i ON i.id = c.item_id
LEFT JOIN accounts a ON a.id = i.author_id
LEFT JOIN assessments asm ON asm.item_id = i.id
WHERE c.source = 'bookmark';

CREATE VIEW v_veille AS
SELECT i.network, i.id AS item_id, a.handle AS author, i.url, i.text, i.posted_at, c.captured_at
FROM captures c JOIN items i ON i.id = c.item_id
LEFT JOIN accounts a ON a.id = i.author_id
WHERE c.source IN ('watch','search');

CREATE VIEW v_drafts AS
SELECT p.*, a.network, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id
WHERE p.status IN ('draft','pending_validation','approved','scheduled');

CREATE VIEW v_published AS
SELECT p.*, a.network, a.handle FROM posts p JOIN accounts a ON a.id = p.account_id
WHERE p.status = 'published';

CREATE INDEX idx_items_author ON items(author_id);
CREATE INDEX idx_items_conv ON items(network, conversation_id);
CREATE INDEX idx_captures_source ON captures(source, account_id);
CREATE INDEX idx_posts_status ON posts(account_id, status);
CREATE INDEX idx_posts_idea ON posts(idea_id);
CREATE INDEX idx_learnings_recent ON learnings(ignored, created_at);
CREATE INDEX idx_learnings_account ON learnings(account_id, created_at);

CREATE INDEX idx_ideas_kind ON ideas(kind, account_id, status);

CREATE INDEX idx_posts_type ON posts(account_id, post_type, created_at);

PRAGMA user_version = 20;
