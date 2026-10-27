-- phase: expand
-- Prospecting comments: a campaign of a managed account searches the network for posts that voice a pain it can
-- answer, an LLM checks each match (a candidate), the agent drafts a reply (a post of kind 'reply'), and the user
-- validates it in the studio before anything is sent. Pains, queries and solutions are campaign data, never code.
-- Absolute rules, held here and not only in the prompts:
-- - never a reply (nor a quote) to a post of a member of a competitor's team (founder, developer, employee, official
--   account), nor to a post whose author is unknown;
-- - a reply to a post about a competitor only when the post criticizes it and its author is not affiliated
--   (candidate of the same account with competitor_stance = 'critical' AND author_affiliation = 'none');
-- - the text of a post still never names a competitor (post_text_no_competitor_*).

-- One campaign per need of a managed account. NULL limits = the settings cascade (account → organization → user).
CREATE TABLE comment_campaigns (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),   -- must be 'owned'
  owner_user_id TEXT NOT NULL,                           -- the owner of the account
  network TEXT NOT NULL DEFAULT 'x' REFERENCES networks(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  langs TEXT CHECK (langs IS NULL OR (json_valid(langs) AND json_type(langs) = 'array')),  -- JSON ["en"]; filled with the account's language when omitted
  max_replies_per_day INTEGER CHECK (max_replies_per_day IS NULL OR max_replies_per_day >= 0),
  min_gap_min INTEGER CHECK (min_gap_min IS NULL OR min_gap_min >= 0),           -- minutes between two replies
  same_author_days INTEGER NOT NULL DEFAULT 30 CHECK (same_author_days >= 0),    -- no second reply to one author before N days
  search_budget_usd REAL CHECK (search_budget_usd IS NULL OR search_budget_usd >= 0),  -- search spend per day
  active_hours TEXT,                                     -- e.g. '08-20', in the publishing time zone
  max_author_followers INTEGER CHECK (max_author_followers IS NULL OR max_author_followers >= 0),  -- skip bigger authors
  notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);

-- Pains a campaign answers: the reader's words, the searches that find them, and the verified way out.
CREATE TABLE comment_pains (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES comment_campaigns(id),
  pain TEXT NOT NULL,
  queries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queries) AND json_type(queries) = 'array'),  -- JSON: search queries on the network
  examples_positive TEXT CHECK (examples_positive IS NULL OR (json_valid(examples_positive) AND json_type(examples_positive) = 'array')),
  examples_negative TEXT CHECK (examples_negative IS NULL OR (json_valid(examples_negative) AND json_type(examples_negative) = 'array')),
  solution TEXT,                                         -- the concrete, verified way out
  solution_source TEXT,                                  -- where the solution was verified
  evidence TEXT,                                         -- optional proof (link, figure, demo)
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  -- an active pain needs its verified solution
  CHECK (active = 0 OR (COALESCE(trim(solution), '') <> '' AND COALESCE(trim(solution_source), '') <> ''))
);

-- People of a competitor (founder, developer, employee, official account): never replied to, never quoted.
-- Official accounts may also be recognized through accounts.competitor_id or competitor_aliases.
CREATE TABLE competitor_team (
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  network TEXT NOT NULL REFERENCES networks(id),
  handle TEXT NOT NULL COLLATE NOCASE CHECK (handle <> '' AND handle NOT LIKE '@%'),   -- without @
  role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('official','founder','employee','developer','contributor','other')),
  source TEXT,                                           -- how the affiliation is known (bio, website, manual…)
  added_at TEXT NOT NULL,
  UNIQUE (network, handle)
);

-- A found post, checked against the pains of a campaign.
CREATE TABLE comment_candidates (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES comment_campaigns(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  pain_id INTEGER REFERENCES comment_pains(id),          -- the pain recognized, if any
  score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 5),
  reason TEXT,                                           -- why it matches (or not)
  competitor_stance TEXT NOT NULL DEFAULT 'none' CHECK (competitor_stance IN ('none','critical','neutral','praise')),
  author_affiliation TEXT NOT NULL DEFAULT 'unknown' CHECK (author_affiliation IN ('none','competitor','unknown')),  -- unknown = doubt: no reply about a competitor
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','drafted','dismissed','replied')),
  dismiss_reason TEXT,
  post_id INTEGER REFERENCES posts(id),                  -- the drafted reply
  created_at TEXT NOT NULL, updated_at TEXT,
  UNIQUE (campaign_id, item_id)
);

CREATE INDEX comment_campaigns_account ON comment_campaigns(account_id, active);
CREATE INDEX comment_campaigns_owner ON comment_campaigns(owner_user_id);
CREATE INDEX comment_pains_campaign ON comment_pains(campaign_id, active);
CREATE INDEX competitor_team_competitor ON competitor_team(competitor_id);
CREATE INDEX comment_candidates_status ON comment_candidates(campaign_id, status);
CREATE INDEX comment_candidates_item ON comment_candidates(item_id);

-- A campaign belongs to a managed account, and to the owner of that account.
CREATE TRIGGER comment_campaigns_owned_ins BEFORE INSERT ON comment_campaigns
WHEN COALESCE((SELECT relation FROM accounts WHERE id = NEW.account_id), '') <> 'owned'
  OR (SELECT owner_user_id FROM accounts WHERE id = NEW.account_id) <> NEW.owner_user_id
BEGIN SELECT RAISE(ABORT, 'a comment campaign belongs to a managed account of its owner'); END;

CREATE TRIGGER comment_campaigns_owned_upd BEFORE UPDATE OF account_id, owner_user_id ON comment_campaigns
WHEN COALESCE((SELECT relation FROM accounts WHERE id = NEW.account_id), '') <> 'owned'
  OR (SELECT owner_user_id FROM accounts WHERE id = NEW.account_id) <> NEW.owner_user_id
BEGIN SELECT RAISE(ABORT, 'a comment campaign belongs to a managed account of its owner'); END;

-- Languages default to the account's language.
CREATE TRIGGER comment_campaigns_langs AFTER INSERT ON comment_campaigns
WHEN NEW.langs IS NULL AND (SELECT lang FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN UPDATE comment_campaigns SET langs = json_array((SELECT lang FROM accounts WHERE id = NEW.account_id)) WHERE id = NEW.id; END;

-- Items written by a competitor's team: official accounts (accounts.competitor_id, an alias equal to the handle) and
-- the people listed in competitor_team.
CREATE VIEW v_competitor_team_items AS
SELECT i.id AS item_id FROM items i JOIN accounts a ON a.id = i.author_id
WHERE a.competitor_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM competitor_team t WHERE t.network = a.network AND t.handle = a.handle)
   OR EXISTS (SELECT 1 FROM competitor_aliases x WHERE x.alias = a.handle OR x.alias = '@' || a.handle);

-- Posts about a competitor a managed account may reply to: the post criticizes it and its author is not affiliated.
CREATE VIEW v_critical_candidates AS
SELECT c.item_id, k.account_id FROM comment_candidates c JOIN comment_campaigns k ON k.id = c.campaign_id
WHERE c.competitor_stance = 'critical' AND c.author_affiliation = 'none' AND c.status <> 'dismissed';

-- ABSOLUTE: a reply to a post about a competitor needs a critical candidate of the same account with an unaffiliated
-- author, checked again at every change of status (a candidate revised later stops the reply); rejecting or failing
-- such a reply stays possible.
CREATE TRIGGER posts_reply_competitor_ins BEFORE INSERT ON posts
WHEN NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_items)
 AND NOT (NEW.kind = 'reply' AND EXISTS (SELECT 1 FROM v_critical_candidates v WHERE v.item_id = NEW.reply_to_item_id AND v.account_id = NEW.account_id))
BEGIN SELECT RAISE(ABORT, 'reply to a post about a competitor: only when it criticizes it and its author is not affiliated'); END;

CREATE TRIGGER posts_reply_competitor_upd BEFORE UPDATE OF reply_to_item_id, status, kind, account_id ON posts
WHEN NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_items)
 AND NEW.status NOT IN ('rejected','failed')
 AND NOT (NEW.kind = 'reply' AND EXISTS (SELECT 1 FROM v_critical_candidates v WHERE v.item_id = NEW.reply_to_item_id AND v.account_id = NEW.account_id))
BEGIN SELECT RAISE(ABORT, 'reply to a post about a competitor: only when it criticizes it and its author is not affiliated'); END;

-- The general guard keeps refusing a named competitor and a quoted competitor item; a reply to a competitor item is
-- decided by posts_reply_competitor_* alone (the only case where it is allowed).
DROP TRIGGER post_text_no_competitor_ins;
CREATE TRIGGER post_text_no_competitor_ins BEFORE INSERT ON posts
WHEN EXISTS (SELECT 1 FROM competitor_aliases WHERE instr(lower(NEW.body), lower(alias)) > 0)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor named or targeted: not allowed in a post'); END;

DROP TRIGGER post_text_no_competitor_upd;
CREATE TRIGGER post_text_no_competitor_upd BEFORE UPDATE OF body, quote_item_id ON posts
WHEN EXISTS (SELECT 1 FROM competitor_aliases WHERE instr(lower(NEW.body), lower(alias)) > 0)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_items)
BEGIN SELECT RAISE(ABORT, 'competitor named or targeted: not allowed in a post'); END;

-- A reply to a post needs no visual of its own (a 'reply' without a target is a plain post and still needs one).
DROP TRIGGER posts_need_media;
CREATE TRIGGER posts_need_media BEFORE UPDATE OF status ON posts
WHEN NEW.status IN ('scheduled','published') AND (NEW.media IS NULL OR NEW.media IN ('', '[]'))
 AND NOT (NEW.kind = 'quote' AND NEW.quote_item_id IS NOT NULL)
 AND NOT (NEW.kind = 'reply' AND NEW.reply_to_item_id IS NOT NULL)
 AND COALESCE(NEW.no_media, 0) = 0
BEGIN SELECT RAISE(ABORT, 'a visual is required before scheduling or publishing (or tick "Publish without a visual")'); END;

-- ABSOLUTE: never reply to (nor quote) a member of a competitor's team; never reply to a post of unknown author.
-- On update, a post being rejected or marked failed is let through: it stops it.
-- Created last: SQLite runs the most recent trigger first, so this refusal is the one reported.
CREATE TRIGGER posts_no_competitor_team_ins BEFORE INSERT ON posts
WHEN NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_team_items)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_team_items)
  OR (NEW.reply_to_item_id IS NOT NULL AND (SELECT author_id FROM items WHERE id = NEW.reply_to_item_id) IS NULL)
BEGIN SELECT RAISE(ABORT, 'target written by a competitor''s team or by an unknown author: never reply to it'); END;

CREATE TRIGGER posts_no_competitor_team_upd BEFORE UPDATE OF reply_to_item_id, quote_item_id, status, kind, account_id ON posts
WHEN NEW.status NOT IN ('rejected','failed')
 AND (NEW.reply_to_item_id IN (SELECT item_id FROM v_competitor_team_items)
  OR NEW.quote_item_id IN (SELECT item_id FROM v_competitor_team_items)
  OR (NEW.reply_to_item_id IS NOT NULL AND (SELECT author_id FROM items WHERE id = NEW.reply_to_item_id) IS NULL))
BEGIN SELECT RAISE(ABORT, 'target written by a competitor''s team or by an unknown author: never reply to it'); END;
