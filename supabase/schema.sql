-- ===========================================================================
-- deedy-automation : cloud mirror schema for the mobile app
-- ===========================================================================
-- Paste this whole file into the Supabase SQL editor and run it. Every
-- statement is idempotent, so re-running after an upgrade is safe and will not
-- drop or truncate anything.
--
-- PRIVACY BOUNDARY - READ BEFORE ADDING A COLUMN
-- This database is a read-mostly mirror of OPERATIONAL METADATA only. It exists
-- so a phone can watch progress and issue commands without exposing an inbound
-- port on the host machine. The following are NEVER stored here and no column
-- below is capable of holding them:
--   * resume markdown, tailored resumes, or any generated document file
--   * cover letter text
--   * candidate profile PII (email, phone, street address, postal code)
--   * provider cookies, storage state, bearer tokens, or any credential
--   * LLM prompts, LLM responses, or the LLM api key
--   * screenshots, HTML snapshots, or any run artifact
--   * the local encryption key
-- All of that stays on the host machine in the local SQLite database. If a
-- future feature seems to need one of them up here, the answer is no.
--
-- TRUST MODEL
-- The local server authenticates with the Supabase SERVICE ROLE key, which
-- bypasses row level security by design: it is the single writer and it stamps
-- user_id on every row it pushes. The mobile app authenticates as a normal
-- signed-in user with the anon key, so the RLS policies below are what actually
-- confine it to its own rows. Keep the service role key on the host only; it
-- must never ship inside the mobile bundle.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
-- Mirror of the local jobs table minus the description, the parsed
-- requirements, and every generated document. Enough to browse and triage on a
-- phone, useless to anyone who steals it.
create table if not exists public.jobs (
  id               bigint      not null,
  user_id          uuid        not null references auth.users (id) on delete cascade,
  title            text        not null,
  company          text        not null,
  location         text,
  source           text        not null,
  remote_type      text        not null default 'unknown',
  employment_type  text        not null default 'unknown',
  experience_level text        not null default 'unknown',
  salary_min       numeric,
  salary_max       numeric,
  salary_currency  text,
  score            numeric,
  recommendation   text,
  status           text        not null default 'new',
  application_url  text        not null,
  posted_at        timestamptz,
  collected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id, user_id)
);

comment on table public.jobs is
  'Operational job metadata mirrored from the local host. Never contains job descriptions, resumes, cover letters or PII.';

-- Length ceilings on every free-text column, matching LIMITS in
-- apps/api/src/services/sync/sync.service.ts. A metadata column with no bound is
-- a place a document could be put; these make that impossible at the database
-- rather than trusting the writer. NOT VALID keeps this file re-runnable - it
-- skips re-checking rows that already exist while still enforcing every new
-- write, so a re-run can never abort part way through.
alter table public.jobs drop constraint if exists jobs_title_len_check;
alter table public.jobs add constraint jobs_title_len_check
  check (char_length(title) <= 300) not valid;
alter table public.jobs drop constraint if exists jobs_company_len_check;
alter table public.jobs add constraint jobs_company_len_check
  check (char_length(company) <= 200) not valid;
alter table public.jobs drop constraint if exists jobs_location_len_check;
alter table public.jobs add constraint jobs_location_len_check
  check (char_length(location) <= 200) not valid;
alter table public.jobs drop constraint if exists jobs_application_url_len_check;
alter table public.jobs add constraint jobs_application_url_len_check
  check (char_length(application_url) <= 2000) not valid;

-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
-- job_title and company are denormalised so the mobile list renders without a
-- join, and so an application survives locally pruning its job row.
create table if not exists public.applications (
  id           bigint      not null,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  job_id       bigint      not null,
  job_title    text,
  company      text,
  provider     text        not null,
  status       text        not null default 'pending',
  current_step text,
  attempts     integer     not null default 0,
  max_attempts integer     not null default 3,
  error        text,
  dry_run      boolean     not null default false,
  started_at   timestamptz,
  submitted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id, user_id)
);

comment on table public.applications is
  'Application progress only. The error column carries a short failure reason, never a page snapshot, form payload or LLM output.';

-- error is the one column here written by something other than this project's
-- own prose: it carries whatever the automation threw. The host redacts and
-- truncates it to 500 characters; this is the second, independent ceiling.
alter table public.applications drop constraint if exists applications_error_len_check;
alter table public.applications add constraint applications_error_len_check
  check (char_length(error) <= 500) not valid;
alter table public.applications drop constraint if exists applications_job_title_len_check;
alter table public.applications add constraint applications_job_title_len_check
  check (char_length(job_title) <= 300) not valid;
alter table public.applications drop constraint if exists applications_company_len_check;
alter table public.applications add constraint applications_company_len_check
  check (char_length(company) <= 200) not valid;

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          bigint      not null,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  kind        text        not null,
  level       text        not null default 'info',
  title       text        not null,
  body        text        not null default '',
  entity_type text,
  entity_id   bigint,
  read        boolean     not null default false,
  actionable  boolean     not null default false,
  created_at  timestamptz not null default now(),
  primary key (id, user_id)
);

comment on table public.notifications is
  'Short human-readable alerts. Bodies are composed on the host from metadata only.';

alter table public.notifications drop constraint if exists notifications_title_len_check;
alter table public.notifications add constraint notifications_title_len_check
  check (char_length(title) <= 200) not valid;
alter table public.notifications drop constraint if exists notifications_body_len_check;
alter table public.notifications add constraint notifications_body_len_check
  check (char_length(body) <= 1000) not valid;

-- ---------------------------------------------------------------------------
-- queue_stats
-- ---------------------------------------------------------------------------
-- One row per user, upserted by the host. Counts only, no task payloads.
create table if not exists public.queue_stats (
  user_id        uuid        primary key references auth.users (id) on delete cascade,
  pending        integer     not null default 0,
  active         integer     not null default 0,
  completed      integer     not null default 0,
  failed         integer     not null default 0,
  delayed        integer     not null default 0,
  cancelled      integer     not null default 0,
  worker_running boolean     not null default false,
  updated_at     timestamptz not null default now()
);

-- Added after the first release: a project created from the earlier schema has
-- no `delayed` column, and PostgREST rejects the whole upsert when one column is
-- unknown, which silently stopped queue stats syncing altogether.
alter table public.queue_stats add column if not exists delayed integer not null default 0;

comment on table public.queue_stats is
  'Single-row-per-user queue counters. Queue task payloads stay on the host.';

-- ---------------------------------------------------------------------------
-- commands
-- ---------------------------------------------------------------------------
-- The phone writes here; the host polls, claims and completes. This is the only
-- table the mobile app inserts into, and it is why the host needs no inbound
-- port, tunnel or public hostname.
create table if not exists public.commands (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  status       text        not null default 'pending',
  result       text,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  completed_at timestamptz
);

comment on table public.commands is
  'Outbound control channel from phone to host. Payloads are small identifiers and enum values only.';

-- CHECK constraints are added separately so this file stays re-runnable and so
-- widening the enum later is a drop + add rather than a table rewrite.
-- Mirrors COMMAND_STATUSES in packages/shared/src/enums.ts.
alter table public.commands drop constraint if exists commands_status_check;
alter table public.commands add constraint commands_status_check
  check (status in ('pending', 'claimed', 'succeeded', 'failed'));

-- Mirrors REMOTE_COMMANDS in packages/shared/src/enums.ts.
alter table public.commands drop constraint if exists commands_kind_check;
alter table public.commands add constraint commands_kind_check
  check (kind in (
    'application.retry',
    'application.set_status',
    'job.score',
    'job.archive',
    'collector.run',
    'queue.retry_failed',
    'queue.pause',
    'sync.full'
  ));

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
-- Expo push tokens so the host can notify the phone. The token is an opaque
-- routing address issued by Expo, not a credential for any job board.
create table if not exists public.devices (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  expo_push_token text        not null unique,
  platform        text,
  last_seen_at    timestamptz not null default now()
);

comment on table public.devices is
  'Registered mobile devices for push delivery. Contains no device fingerprint beyond platform.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists jobs_user_updated_idx
  on public.jobs (user_id, updated_at desc);
create index if not exists applications_user_updated_idx
  on public.applications (user_id, updated_at desc);
create index if not exists notifications_user_read_idx
  on public.notifications (user_id, read);
create index if not exists commands_user_status_idx
  on public.commands (user_id, status);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Enabled on every table without exception. The service role key used by the
-- local server bypasses these policies by design - it is the trusted single
-- writer running on the user's own machine. Everything holding the anon key
-- (the mobile app) is confined to its own user_id by the policies below.
--
-- The app is granted the verbs it actually uses and nothing more. jobs,
-- applications and queue_stats are host-owned and read-only from the phone, so
-- a stolen handset or a leaked session cannot rewrite or erase the mirror; the
-- host would happily re-push, but silent tampering would not be visible.
alter table public.jobs          enable row level security;
alter table public.applications  enable row level security;
alter table public.notifications enable row level security;
alter table public.queue_stats   enable row level security;
alter table public.commands      enable row level security;
alter table public.devices       enable row level security;

-- Every policy name this file has ever created is dropped first, so re-running
-- after an upgrade that narrows a grant actually removes the wider one.
do $$
declare
  t text;
begin
  foreach t in array array[
    'jobs', 'applications', 'notifications', 'queue_stats', 'commands', 'devices'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);

    -- Read is the one verb every table grants.
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = auth.uid())',
      t || '_select_own', t
    );
  end loop;
end
$$;

-- Writes, granted one at a time only where the app needs them.
-- USING gates which rows a statement may touch; WITH CHECK stops a row being
-- created under, or reassigned to, somebody else's user_id on the way out.

-- The phone marks alerts read and dismisses them; that is the only mirrored
-- state it owns.
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete_own on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- The control channel. The phone appends a command and watches its status. It
-- may not edit or delete one, so it cannot rewrite a command the host has
-- already claimed, nor erase the record of what was asked for.
create policy commands_insert_own on public.commands
  for insert to authenticated with check (user_id = auth.uid());

-- Push registration is entirely phone-owned: register, refresh, unregister.
create policy devices_insert_own on public.devices
  for insert to authenticated with check (user_id = auth.uid());
create policy devices_update_own on public.devices
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy devices_delete_own on public.devices
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- The mobile app subscribes to these four so the dashboard updates live.
-- commands and devices are deliberately excluded: the phone writes those and
-- has no reason to stream them back. Adding a table to a publication twice is
-- an error, so each add is guarded.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['jobs', 'applications', 'notifications', 'queue_stats'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- ===========================================================================
-- End of schema. Nothing above can store a document, a credential, a prompt or
-- a piece of contact information: every column is either a number, a timestamp,
-- an enum or a short length-capped string. Keep it that way.
-- ===========================================================================
