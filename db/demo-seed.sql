-- Optional demo data for screenshots and tests. Entirely fictional: no real account, person or setting.
-- Load it on a fresh database built from schema.sql, never on a database holding real data.
INSERT OR IGNORE INTO networks(id, name) VALUES ('x', 'X'), ('linkedin', 'LinkedIn');

INSERT INTO organizations(id, slug, name, notes, created_at) VALUES
  (1, 'acme', 'Acme Tools', 'Demo organization', '2026-01-05T09:00:00Z');

INSERT INTO accounts(id, network, handle, display_name, relation, role, lang, organization_id) VALUES
  (1, 'x', 'acme_dev', 'Acme Dev', 'owned', 'personal', 'en', 1);
INSERT INTO accounts(id, network, handle, display_name, relation, role, lang, watch_role, watch_priority) VALUES
  (2, 'x', 'example_lab', 'Example Lab', 'watched', 'brand', 'en', 'source', 'daily'),
  (3, 'x', 'jane_builder', 'Jane Builder', 'watched', 'personal', 'en', 'source', 'weekly');

INSERT INTO settings(key, value) VALUES
  ('rules', 'Never name a competitor in a post.'),
  ('publish_window_start', '09:00'),
  ('publish_window_end', '18:00'),
  ('publish_tz', 'UTC');
INSERT INTO scoped_settings(scope, scope_id, key, value, updated_at) VALUES
  ('organization', 1, 'goals', 'Show what Acme Tools does, one concrete example at a time.', '2026-01-05T09:00:00Z'),
  ('account', 1, 'voice', 'Short sentences, first person, one concrete detail per post.', '2026-01-05T09:00:00Z'),
  ('account', 1, 'source_watch', '1', '2026-01-05T09:00:00Z');

INSERT INTO items(id, network, external_id, author_id, kind, url, text, lang, posted_at, first_seen_at) VALUES
  (1, 'x', '1000000000000000001', 2, 'post', 'https://x.com/example_lab/status/1000000000000000001',
   'Example Lab ships a command-line tool that turns a folder of notes into a searchable index.', 'en',
   '2026-01-06T08:00:00Z', '2026-01-06T08:05:00Z'),
  (2, 'x', '1000000000000000002', 3, 'post', 'https://x.com/jane_builder/status/1000000000000000002',
   'I review every change an agent makes before it reaches main. It saved me twice this week.', 'en',
   '2026-01-06T10:00:00Z', '2026-01-06T10:02:00Z');
INSERT INTO item_metrics(item_id, captured_at, likes, views, shares, replies, saves) VALUES
  (1, '2026-01-06T12:00:00Z', 120, 9000, 14, 6, 40),
  (2, '2026-01-06T12:00:00Z', 35, 2100, 2, 4, 11);
INSERT INTO captures(item_id, source, account_id, captured_at) VALUES
  (1, 'watch', 1, '2026-01-06T08:05:00Z'),
  (2, 'bookmark', 1, '2026-01-06T10:02:00Z');
INSERT INTO assessments(item_id, verdict, pillar, already_known, angle, score, assessed_by, assessed_at) VALUES
  (1, 'keep', 'open_source', 0, 'Useful tool worth saving', 4, 'demo', '2026-01-06T09:00:00Z'),
  (2, 'to_confirm', 'other', 0, 'Review habit, could become a how-to', 3, 'demo', '2026-01-06T11:00:00Z');

INSERT INTO ideas(id, title, concept, origin, status, created_at, account_id, post_type) VALUES
  (1, 'Index your notes from the terminal', 'A small tool that makes a notes folder searchable in one command.', 'watch', 'in_progress', '2026-01-06T09:10:00Z', 1, 'valeur');
INSERT INTO idea_items(idea_id, item_id, relation) VALUES (1, 1, 'inspired_by');

INSERT INTO posts(id, idea_id, account_id, kind, lang, body, status, created_at, post_type, image_prompt_code) VALUES
  (1, 1, 1, 'post', 'en', 'Found a tool that indexes a whole notes folder in one command. Took me two minutes to try, and search is instant.',
   'pending_validation', '2026-01-06T09:30:00Z', 'valeur', 'A terminal window with one command and a results list, dark background, one accent colour.');
INSERT INTO post_items(post_id, item_id, relation) VALUES (1, 1, 'inspired_by');
INSERT INTO posts(id, account_id, kind, lang, body, status, created_at, validated_at, validated_by, no_media) VALUES
  (2, 1, 'post', 'en', 'Every change an agent makes goes through a review before main. Boring, and it works.',
   'approved', '2026-01-05T15:00:00Z', '2026-01-05T16:00:00Z', 'demo', 1);
UPDATE posts SET status = 'published', published_at = '2026-01-05T16:30:00Z', external_id = '1000000000000000100',
  url = 'https://x.com/acme_dev/status/1000000000000000100' WHERE id = 2;
INSERT INTO post_metrics(post_id, captured_at, likes, views, shares, replies, saves) VALUES
  (2, '2026-01-06T16:30:00Z', 18, 1400, 1, 3, 5);

INSERT INTO learnings(created_at, post_id, text, source, category, account_id) VALUES
  ('2026-01-05T15:30:00Z', 2, 'Too long, keep one detail.', 'rewrite', 'longueur', 1);
