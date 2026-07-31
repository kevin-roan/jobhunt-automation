/**
 * Row shapes for every Supabase table the mobile app reads.
 *
 * Columns are snake_case because these are the literal wire shapes returned by
 * PostgREST - they mirror supabase/schema.sql one-for-one. Keep them in sync
 * with that file and with SyncedJobRow / SyncedApplicationRow / RemoteCommandRow
 * in packages/shared/src/dto.ts.
 *
 * The enum unions below are copies of packages/shared/src/enums.ts rather than
 * an import: the Expo bundler would have to compile the workspace package for
 * four string unions, and the cloud mirror stores these as plain `text` anyway.
 *
 * PRIVACY: nothing here is a document, a credential, a prompt or a piece of
 * contact information, and nothing here ever should be. Resumes, cover letters,
 * profile PII, cookies, tokens, LLM traffic and screenshots stay on the host
 * machine in local SQLite. If a screen seems to need one of them, it does not.
 */

/* -------------------------------------------------------------------------- */
/* Enum unions (mirrors of packages/shared/src/enums.ts)                      */
/* -------------------------------------------------------------------------- */

export const JOB_STATUSES = [
  'new',
  'scored',
  'queued',
  'applying',
  'applied',
  'skipped',
  'failed',
  'manual_review',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RECOMMENDATIONS = ['apply', 'skip', 'manual_review'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const APPLICATION_STATUSES = [
  'pending',
  'in_progress',
  'submitted',
  'failed',
  'abandoned',
  'needs_human',
  'interview',
  'rejected',
  'offer',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STEPS = [
  'login',
  'navigate',
  'read_description',
  'start_application',
  'upload_resume',
  'upload_cover_letter',
  'fill_form',
  'answer_questions',
  'review',
  'submit',
  'confirm',
] as const;
export type ApplicationStep = (typeof APPLICATION_STEPS)[number];

export const REMOTE_TYPES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type RemoteType = (typeof REMOTE_TYPES)[number];

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'unknown',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EXPERIENCE_LEVELS = [
  'intern',
  'entry',
  'mid',
  'senior',
  'staff',
  'principal',
  'executive',
  'unknown',
] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'error'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_KINDS = [
  'application.submitted',
  'application.failed',
  'application.needs_human',
  'job.high_score',
  'credential.expired',
  'collector.failed',
  'queue.stalled',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const REMOTE_COMMANDS = [
  'application.retry',
  'application.set_status',
  'job.score',
  'job.archive',
  'collector.run',
  'queue.retry_failed',
  'queue.pause',
  'sync.full',
] as const;
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export const COMMAND_STATUSES = ['pending', 'claimed', 'succeeded', 'failed'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Table rows                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * public.jobs. `id` is the host's local SQLite id, unique only within a user,
 * so the primary key up here is (id, user_id) - always scope a lookup by id to
 * the signed-in user, which RLS already does for us.
 */
export interface JobRow {
  id: number;
  user_id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  remote_type: RemoteType;
  employment_type: EmploymentType;
  experience_level: ExperienceLevel;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  score: number | null;
  recommendation: Recommendation | null;
  status: JobStatus;
  application_url: string;
  posted_at: string | null;
  collected_at: string;
  updated_at: string;
}

/** public.applications. job_title and company are denormalised by the host. */
export interface ApplicationRow {
  id: number;
  user_id: string;
  job_id: number;
  job_title: string | null;
  company: string | null;
  provider: string;
  status: ApplicationStatus;
  current_step: ApplicationStep | null;
  attempts: number;
  max_attempts: number;
  /** Short failure reason only. Never a page snapshot, form payload or LLM output. */
  error: string | null;
  dry_run: boolean;
  started_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** public.notifications. entity_type/entity_id let a row deep link to a screen. */
export interface NotificationRow {
  id: number;
  user_id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: number | null;
  read: boolean;
  actionable: boolean;
  created_at: string;
}

/** public.queue_stats. Exactly one row per user, upserted by the host. */
export interface QueueStatsRow {
  user_id: string;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  /** Retry backoff: queued but not yet runnable. */
  delayed: number;
  cancelled: number;
  worker_running: boolean;
  updated_at: string;
}

/**
 * public.commands - the only table the app writes to. The phone inserts a row,
 * the host polls, claims it (`claimed`) and completes it (`succeeded`/`failed`).
 */
export interface CommandRow {
  id: string;
  user_id: string;
  kind: RemoteCommand;
  payload: Record<string, unknown>;
  status: CommandStatus;
  result: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

/** public.devices. The Expo push token is a routing address, not a credential. */
export interface DeviceRow {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: string | null;
  last_seen_at: string;
}
