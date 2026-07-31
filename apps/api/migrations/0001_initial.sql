-- Initial schema for Deedy Automation.
-- Timestamps are ISO-8601 UTC strings so they sort lexicographically.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website         TEXT,
  industry        TEXT,
  size_estimate   TEXT,
  summary         TEXT,
  culture_points  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX companies_normalized_name_idx ON companies (normalized_name);

CREATE TABLE jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  hash             TEXT NOT NULL,
  external_id      TEXT,
  source           TEXT NOT NULL,
  title            TEXT NOT NULL,
  company          TEXT NOT NULL,
  company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  location         TEXT,
  remote_type      TEXT NOT NULL DEFAULT 'unknown',
  employment_type  TEXT NOT NULL DEFAULT 'unknown',
  experience_level TEXT NOT NULL DEFAULT 'unknown',
  salary_min       REAL,
  salary_max       REAL,
  salary_currency  TEXT,
  salary_period    TEXT,
  description      TEXT,
  description_html TEXT,
  summary          TEXT,
  skills           TEXT NOT NULL DEFAULT '[]',
  application_url  TEXT NOT NULL,
  posted_at        TEXT,
  collected_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status           TEXT NOT NULL DEFAULT 'new',
  score            REAL,
  recommendation   TEXT,
  raw              TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX jobs_hash_idx ON jobs (hash);
CREATE UNIQUE INDEX jobs_application_url_idx ON jobs (application_url);
CREATE INDEX jobs_company_title_source_idx ON jobs (company, title, source);
CREATE INDEX jobs_status_idx ON jobs (status);
CREATE INDEX jobs_score_idx ON jobs (score);
CREATE INDEX jobs_collected_at_idx ON jobs (collected_at);
CREATE INDEX jobs_source_idx ON jobs (source);

CREATE TABLE job_skills (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill      TEXT NOT NULL,
  normalized TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'hard'
);
CREATE UNIQUE INDEX job_skills_job_normalized_idx ON job_skills (job_id, normalized);
CREATE INDEX job_skills_normalized_idx ON job_skills (normalized);

CREATE TABLE job_scores (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id                INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id             INTEGER,
  score                 REAL NOT NULL,
  confidence            REAL NOT NULL DEFAULT 0,
  recommendation        TEXT NOT NULL,
  matched_skills        TEXT NOT NULL DEFAULT '[]',
  missing_skills        TEXT NOT NULL DEFAULT '[]',
  red_flags             TEXT NOT NULL DEFAULT '[]',
  reasoning             TEXT NOT NULL DEFAULT '',
  interview_probability REAL,
  model                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX job_scores_job_idx ON job_scores (job_id);
CREATE INDEX job_scores_created_idx ON job_scores (created_at);

CREATE TABLE resumes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  target_role    TEXT,
  markdown       TEXT NOT NULL,
  file_path      TEXT,
  pdf_path       TEXT,
  docx_path      TEXT,
  is_base        INTEGER NOT NULL DEFAULT 1,
  is_default     INTEGER NOT NULL DEFAULT 0,
  parent_id      INTEGER,
  job_id         INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  generated_by   TEXT,
  change_summary TEXT NOT NULL DEFAULT '[]',
  ats_score      REAL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX resumes_name_version_idx ON resumes (name, version);
CREATE INDEX resumes_job_idx ON resumes (job_id);
CREATE INDEX resumes_parent_idx ON resumes (parent_id);

CREATE TABLE applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id         INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  cover_letter_id   INTEGER,
  provider          TEXT NOT NULL DEFAULT 'unknown',
  status            TEXT NOT NULL DEFAULT 'pending',
  current_step      TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  confirmation_text TEXT,
  error             TEXT,
  dry_run           INTEGER NOT NULL DEFAULT 1,
  started_at        TEXT,
  submitted_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX applications_job_idx ON applications (job_id);
CREATE INDEX applications_status_idx ON applications (status);
CREATE INDEX applications_created_idx ON applications (created_at);

CREATE TABLE cover_letters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  application_id INTEGER,
  resume_id      INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  subject        TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL,
  tone           TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  model          TEXT,
  pdf_path       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cover_letters_job_idx ON cover_letters (job_id);
CREATE INDEX cover_letters_application_idx ON cover_letters (application_id);

CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  step           TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 1,
  message        TEXT,
  error          TEXT,
  duration_ms    INTEGER,
  data           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX application_events_app_idx ON application_events (application_id);
CREATE INDEX application_events_created_idx ON application_events (created_at);

CREATE TABLE application_answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  field_type     TEXT NOT NULL DEFAULT 'text',
  source         TEXT NOT NULL DEFAULT 'llm',
  confidence     REAL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX application_answers_app_idx ON application_answers (application_id);

CREATE TABLE answer_bank (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized       TEXT NOT NULL,
  question_pattern TEXT NOT NULL,
  answer           TEXT NOT NULL,
  field_type       TEXT NOT NULL DEFAULT 'text',
  use_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX answer_bank_normalized_idx ON answer_bank (normalized);

CREATE TABLE artifacts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  path           TEXT NOT NULL,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  job_id         INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  step           TEXT,
  bytes          INTEGER,
  meta           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX artifacts_app_idx ON artifacts (application_id);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);
CREATE INDEX artifacts_kind_idx ON artifacts (kind);

CREATE TABLE queue_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 0,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT,
  run_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT,
  finished_at     TEXT,
  dedupe_key      TEXT,
  locked_by       TEXT,
  lock_expires_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX queue_jobs_dedupe_idx ON queue_jobs (dedupe_key);
CREATE INDEX queue_jobs_status_runat_idx ON queue_jobs (status, run_at);
CREATE INDEX queue_jobs_task_idx ON queue_jobs (task);

CREATE TABLE queue_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_job_id INTEGER NOT NULL REFERENCES queue_jobs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  duration_ms  INTEGER,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT
);
CREATE INDEX queue_attempts_job_idx ON queue_attempts (queue_job_id);

CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'app',
  message    TEXT NOT NULL,
  context    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX logs_created_idx ON logs (created_at);
CREATE INDEX logs_level_idx ON logs (level);
CREATE INDEX logs_scope_idx ON logs (scope);

CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task              TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  system_prompt     TEXT,
  user_prompt       TEXT,
  response          TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  duration_ms       INTEGER,
  success           INTEGER NOT NULL DEFAULT 0,
  attempt           INTEGER NOT NULL DEFAULT 1,
  error             TEXT,
  job_id            INTEGER,
  application_id    INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX llm_calls_created_idx ON llm_calls (created_at);
CREATE INDEX llm_calls_task_idx ON llm_calls (task);
CREATE INDEX llm_calls_job_idx ON llm_calls (job_id);

CREATE TABLE prompt_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task       TEXT NOT NULL,
  name       TEXT NOT NULL,
  system     TEXT NOT NULL,
  user       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX prompt_templates_task_name_version_idx ON prompt_templates (task, name, version);

CREATE TABLE browser_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  engine             TEXT NOT NULL DEFAULT 'chromium',
  profile_path       TEXT NOT NULL,
  storage_state_path TEXT,
  logged_in          INTEGER NOT NULL DEFAULT 0,
  last_used_at       TEXT,
  last_check_at      TEXT,
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX browser_sessions_provider_idx ON browser_sessions (provider);

CREATE TABLE collector_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  found        INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  message      TEXT,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT
);
CREATE INDEX collector_runs_collector_idx ON collector_runs (collector_id);

CREATE TABLE scheduler_state (
  name        TEXT PRIMARY KEY,
  last_run_at TEXT,
  next_run_at TEXT,
  running     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
