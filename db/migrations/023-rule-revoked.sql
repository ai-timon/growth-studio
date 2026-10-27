-- phase: contract
-- A learned rule can be revoked after it was accepted (automatically or by the user): rule_proposals.status gains
-- 'revoked'. SQLite cannot alter a CHECK, so the table is rebuilt with the same columns, in the same order, and its
-- rows are copied as they are (foreign keys are off while migrating).
CREATE TABLE rule_proposals_new (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL,
  text TEXT NOT NULL, rationale TEXT,
  evidence TEXT,                         -- JSON: ids of the supporting learnings
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','refused','revoked')),
  decided_at TEXT, decision_note TEXT, mission_id TEXT,
  account_id INTEGER REFERENCES accounts(id),   -- rule specific to one account (NULL = all), v15
  owner_user_id TEXT
);
INSERT INTO rule_proposals_new(id, created_at, text, rationale, evidence, status, decided_at, decision_note, mission_id, account_id, owner_user_id)
  SELECT id, created_at, text, rationale, evidence, status, decided_at, decision_note, mission_id, account_id, owner_user_id FROM rule_proposals;
DROP TABLE rule_proposals;
ALTER TABLE rule_proposals_new RENAME TO rule_proposals;
