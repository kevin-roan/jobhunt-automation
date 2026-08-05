-- Search terms become first-class rows instead of a settings array.
--
-- The candidate types a handful of seeds; the local model widens each one into
-- the vocabulary job boards actually index. Both live here so the dashboard can
-- show, enable, disable and scope every individual term that will be typed into
-- a search box. `settings.search.keywords` is kept as the seed list, and every
-- row with origin='user' mirrors it.
--
-- A term is unique per (keyword, seed): the same word can legitimately be
-- reached from two different seeds, and collapsing those would lose the
-- provenance the editor groups on.

CREATE TABLE IF NOT EXISTS search_keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT    NOT NULL,
  -- Normalised for de-duplication only; `keyword` is what gets searched.
  normalized   TEXT    NOT NULL,
  -- The user term this was expanded from. NULL for a user term itself.
  seed         TEXT,
  origin       TEXT    NOT NULL DEFAULT 'user',
  kind         TEXT    NOT NULL DEFAULT 'alternate_title',
  confidence   REAL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- JSON array of collector ids. Empty means "every collector".
  sources      TEXT    NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  jobs_found   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS search_keywords_unique_idx
  ON search_keywords (normalized, COALESCE(seed, ''));

CREATE INDEX IF NOT EXISTS search_keywords_enabled_idx ON search_keywords (enabled, origin);
