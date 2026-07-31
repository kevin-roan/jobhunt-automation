-- Provider credentials, notifications and mobile sync bookkeeping.

-- Pasted browser sessions for providers that block automated login.
-- `value` is always AES-256-GCM ciphertext; it is never returned by the API.
CREATE TABLE provider_credentials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  value           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown',
  cookie_count    INTEGER,
  domains         TEXT NOT NULL DEFAULT '[]',
  expires_at      TEXT,
  last_checked_at TEXT,
  last_used_at    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX provider_credentials_provider_idx ON provider_credentials (provider);
CREATE INDEX provider_credentials_status_idx ON provider_credentials (status);

-- Durable notification feed. Mirrored to Supabase so the phone sees the same list.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id   INTEGER,
  read        INTEGER NOT NULL DEFAULT 0,
  actionable  INTEGER NOT NULL DEFAULT 0,
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX notifications_created_idx ON notifications (created_at);
CREATE INDEX notifications_read_idx ON notifications (read);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (dedupe_key);

-- Outbox: rows waiting to be pushed to Supabase. Survives restarts and outages,
-- so a network failure delays the mirror rather than losing it.
CREATE TABLE sync_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  operation   TEXT NOT NULL DEFAULT 'upsert',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX sync_outbox_entity_idx ON sync_outbox (entity, entity_id);
CREATE INDEX sync_outbox_created_idx ON sync_outbox (created_at);

-- Commands claimed from Supabase, recorded locally so a command is executed once.
CREATE TABLE remote_commands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  remote_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'claimed',
  result       TEXT,
  claimed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE UNIQUE INDEX remote_commands_remote_idx ON remote_commands (remote_id);

CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
