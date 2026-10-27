-- phase: expand
-- Multi-user: every organization and managed account belongs to a Timon user, and so does everything reached through
-- them (posts, ideas, feedback, rules, requests, settings of the account or organization). Rows that hang on no
-- account (ideas from a bookmark, rules for all accounts, free requests) carry their owner themselves.
-- Watched accounts and the items they publish stay shared by the installation (lib/scope.js).
-- NULL = not adopted yet: written before this version, or by a tool outside the plugin. lib/scope.js gives such rows
-- to their user (the single user of the installation, or the one the previous version recorded).
ALTER TABLE organizations ADD COLUMN owner_user_id TEXT;
ALTER TABLE accounts ADD COLUMN owner_user_id TEXT;          -- managed accounts only; watched accounts stay NULL
ALTER TABLE ideas ADD COLUMN owner_user_id TEXT;             -- ideas without an account
ALTER TABLE learnings ADD COLUMN owner_user_id TEXT;         -- feedback without an account
ALTER TABLE rule_proposals ADD COLUMN owner_user_id TEXT;    -- rules for all the accounts of one user
ALTER TABLE studio_requests ADD COLUMN owner_user_id TEXT;   -- requests without a post or an account

-- Settings of one user (top of the cascade account → organization → user). The `settings` table keeps the settings
-- of the installation (watch budget, fetch window, voice sync) and the internal state of the background jobs.
CREATE TABLE user_settings (
  owner_user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, key)
);

CREATE INDEX organizations_owner ON organizations(owner_user_id);
CREATE INDEX accounts_owner ON accounts(owner_user_id) WHERE relation = 'owned';
CREATE INDEX captures_item ON captures(item_id);
