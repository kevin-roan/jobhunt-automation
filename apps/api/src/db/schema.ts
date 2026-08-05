import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull().default(now),
});

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    website: text('website'),
    industry: text('industry'),
    sizeEstimate: text('size_estimate'),
    summary: text('summary'),
    culturePoints: text('culture_points', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('companies_normalized_name_idx').on(t.normalizedName)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hash: text('hash').notNull(),
    externalId: text('external_id'),
    source: text('source').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    location: text('location'),
    remoteType: text('remote_type').notNull().default('unknown'),
    employmentType: text('employment_type').notNull().default('unknown'),
    experienceLevel: text('experience_level').notNull().default('unknown'),
    salaryMin: real('salary_min'),
    salaryMax: real('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: text('salary_period'),
    description: text('description'),
    descriptionHtml: text('description_html'),
    summary: text('summary'),
    skills: text('skills', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    applicationUrl: text('application_url').notNull(),
    postedAt: text('posted_at'),
    collectedAt: text('collected_at').notNull().default(now),
    status: text('status').notNull().default('new'),
    score: real('score'),
    recommendation: text('recommendation'),
    raw: text('raw', { mode: 'json' }),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('jobs_hash_idx').on(t.hash),
    uniqueIndex('jobs_application_url_idx').on(t.applicationUrl),
    index('jobs_company_title_source_idx').on(t.company, t.title, t.source),
    index('jobs_status_idx').on(t.status),
    index('jobs_score_idx').on(t.score),
    index('jobs_collected_at_idx').on(t.collectedAt),
    index('jobs_source_idx').on(t.source),
  ],
);

export const jobSkills = sqliteTable(
  'job_skills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    skill: text('skill').notNull(),
    normalized: text('normalized').notNull(),
    kind: text('kind').notNull().default('hard'),
  },
  (t) => [
    uniqueIndex('job_skills_job_normalized_idx').on(t.jobId, t.normalized),
    index('job_skills_normalized_idx').on(t.normalized),
  ],
);

export const jobScores = sqliteTable(
  'job_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    resumeId: integer('resume_id'),
    score: real('score').notNull(),
    confidence: real('confidence').notNull().default(0),
    recommendation: text('recommendation').notNull(),
    matchedSkills: text('matched_skills', { mode: 'json' }).$type<string[]>().notNull(),
    missingSkills: text('missing_skills', { mode: 'json' }).$type<string[]>().notNull(),
    redFlags: text('red_flags', { mode: 'json' }).$type<string[]>().notNull(),
    reasoning: text('reasoning').notNull().default(''),
    interviewProbability: real('interview_probability'),
    model: text('model').notNull().default(''),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('job_scores_job_idx').on(t.jobId), index('job_scores_created_idx').on(t.createdAt)],
);

export const resumes = sqliteTable(
  'resumes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    targetRole: text('target_role'),
    /** Source of truth: a LaTeX document for the deedy-resume-openfont class. */
    latex: text('latex').notNull().default(''),
    theme: text('theme', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    templateId: text('template_id').notNull().default('deedy-resume-openfont'),
    /** Plain-text mirror of `latex`, regenerated on every render. */
    markdown: text('markdown').notNull(),
    compileLog: text('compile_log'),
    compileOk: integer('compile_ok', { mode: 'boolean' }).notNull().default(false),
    texPath: text('tex_path'),
    filePath: text('file_path'),
    pdfPath: text('pdf_path'),
    docxPath: text('docx_path'),
    isBase: integer('is_base', { mode: 'boolean' }).notNull().default(true),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    parentId: integer('parent_id'),
    jobId: integer('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    generatedBy: text('generated_by'),
    changeSummary: text('change_summary', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    atsScore: real('ats_score'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('resumes_job_idx').on(t.jobId),
    index('resumes_parent_idx').on(t.parentId),
    uniqueIndex('resumes_name_version_idx').on(t.name, t.version),
  ],
);

export const coverLetters = sqliteTable(
  'cover_letters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    applicationId: integer('application_id'),
    resumeId: integer('resume_id').references(() => resumes.id, { onDelete: 'set null' }),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull(),
    tone: text('tone'),
    version: integer('version').notNull().default(1),
    model: text('model'),
    pdfPath: text('pdf_path'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('cover_letters_job_idx').on(t.jobId),
    index('cover_letters_application_idx').on(t.applicationId),
  ],
);

export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    resumeId: integer('resume_id').references(() => resumes.id, { onDelete: 'set null' }),
    coverLetterId: integer('cover_letter_id'),
    provider: text('provider').notNull().default('unknown'),
    status: text('status').notNull().default('pending'),
    currentStep: text('current_step'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    confirmationText: text('confirmation_text'),
    error: text('error'),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
    startedAt: text('started_at'),
    submittedAt: text('submitted_at'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('applications_job_idx').on(t.jobId),
    index('applications_status_idx').on(t.status),
    index('applications_created_idx').on(t.createdAt),
  ],
);

export const applicationEvents = sqliteTable(
  'application_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    step: text('step').notNull(),
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    message: text('message'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    data: text('data', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('application_events_app_idx').on(t.applicationId),
    index('application_events_created_idx').on(t.createdAt),
  ],
);

export const applicationAnswers = sqliteTable(
  'application_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    fieldType: text('field_type').notNull().default('text'),
    source: text('source').notNull().default('llm'),
    confidence: real('confidence'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('application_answers_app_idx').on(t.applicationId)],
);

export const answerBank = sqliteTable(
  'answer_bank',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    normalized: text('normalized').notNull(),
    questionPattern: text('question_pattern').notNull(),
    answer: text('answer').notNull(),
    fieldType: text('field_type').notNull().default('text'),
    useCount: integer('use_count').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('answer_bank_normalized_idx').on(t.normalized)],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    applicationId: integer('application_id').references(() => applications.id, {
      onDelete: 'cascade',
    }),
    jobId: integer('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    step: text('step'),
    bytes: integer('bytes'),
    meta: text('meta', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('artifacts_app_idx').on(t.applicationId),
    index('artifacts_job_idx').on(t.jobId),
    index('artifacts_kind_idx').on(t.kind),
  ],
);

export const queueJobs = sqliteTable(
  'queue_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task: text('task').notNull(),
    status: text('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(0),
    payload: text('payload', { mode: 'json' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    runAt: text('run_at').notNull().default(now),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    dedupeKey: text('dedupe_key'),
    lockedBy: text('locked_by'),
    lockExpiresAt: text('lock_expires_at'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('queue_jobs_dedupe_idx').on(t.dedupeKey),
    index('queue_jobs_status_runat_idx').on(t.status, t.runAt),
    index('queue_jobs_task_idx').on(t.task),
  ],
);

export const queueAttempts = sqliteTable(
  'queue_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    queueJobId: integer('queue_job_id')
      .notNull()
      .references(() => queueJobs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
  },
  (t) => [index('queue_attempts_job_idx').on(t.queueJobId)],
);

export const logs = sqliteTable(
  'logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull(),
    scope: text('scope').notNull().default('app'),
    message: text('message').notNull(),
    context: text('context', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('logs_created_idx').on(t.createdAt),
    index('logs_level_idx').on(t.level),
    index('logs_scope_idx').on(t.scope),
  ],
);

export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    systemPrompt: text('system_prompt'),
    userPrompt: text('user_prompt'),
    response: text('response'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    durationMs: integer('duration_ms'),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    jobId: integer('job_id'),
    applicationId: integer('application_id'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('llm_calls_created_idx').on(t.createdAt),
    index('llm_calls_task_idx').on(t.task),
    index('llm_calls_job_idx').on(t.jobId),
  ],
);

export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task: text('task').notNull(),
    name: text('name').notNull(),
    system: text('system').notNull(),
    user: text('user').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('prompt_templates_task_name_version_idx').on(t.task, t.name, t.version)],
);

export const browserSessions = sqliteTable(
  'browser_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    engine: text('engine').notNull().default('chromium'),
    profilePath: text('profile_path').notNull(),
    storageStatePath: text('storage_state_path'),
    loggedIn: integer('logged_in', { mode: 'boolean' }).notNull().default(false),
    lastUsedAt: text('last_used_at'),
    lastCheckAt: text('last_check_at'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('browser_sessions_provider_idx').on(t.provider)],
);

export const collectorRuns = sqliteTable(
  'collector_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectorId: text('collector_id').notNull(),
    status: text('status').notNull().default('running'),
    found: integer('found').notNull().default(0),
    inserted: integer('inserted').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    message: text('message'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
  },
  (t) => [index('collector_runs_collector_idx').on(t.collectorId)],
);

export const schedulerState = sqliteTable('scheduler_state', {
  name: text('name').primaryKey(),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  running: integer('running', { mode: 'boolean' }).notNull().default(false),
  lastError: text('last_error'),
});

export const providerCredentials = sqliteTable(
  'provider_credentials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    /** AES-256-GCM ciphertext. Never leaves the host and never hits the API. */
    value: text('value').notNull(),
    status: text('status').notNull().default('unknown'),
    cookieCount: integer('cookie_count'),
    domains: text('domains', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    expiresAt: text('expires_at'),
    lastCheckedAt: text('last_checked_at'),
    lastUsedAt: text('last_used_at'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('provider_credentials_provider_idx').on(t.provider),
    index('provider_credentials_status_idx').on(t.status),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    level: text('level').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    entityType: text('entity_type'),
    entityId: integer('entity_id'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    actionable: integer('actionable', { mode: 'boolean' }).notNull().default(false),
    dedupeKey: text('dedupe_key'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('notifications_created_idx').on(t.createdAt),
    index('notifications_read_idx').on(t.read),
    uniqueIndex('notifications_dedupe_idx').on(t.dedupeKey),
  ],
);

export const syncOutbox = sqliteTable(
  'sync_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entity: text('entity').notNull(),
    entityId: integer('entity_id').notNull(),
    operation: text('operation').notNull().default('upsert'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('sync_outbox_entity_idx').on(t.entity, t.entityId),
    index('sync_outbox_created_idx').on(t.createdAt),
  ],
);

export const remoteCommands = sqliteTable(
  'remote_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    remoteId: text('remote_id').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    status: text('status').notNull().default('claimed'),
    result: text('result'),
    claimedAt: text('claimed_at').notNull().default(now),
    completedAt: text('completed_at'),
  },
  (t) => [uniqueIndex('remote_commands_remote_idx').on(t.remoteId)],
);

/**
 * Every term a collector will type into a search box. User seeds and the local
 * model's expansions of them share one table so the editor can enable, disable
 * and scope each one individually.
 *
 * MIGRATION-OWNED INDEX — do not regenerate this table with drizzle-kit.
 * De-duplication depends on the UNIQUE expression index
 *   search_keywords_unique_idx ON search_keywords (normalized, COALESCE(seed, ''))
 * declared in migrations/0004_search_keywords.sql. Drizzle cannot express a
 * COALESCE index, so it is intentionally absent below and `drizzle-kit
 * generate`/`push` will emit a DROP for it. Losing it does not fail loudly: it
 * turns every `onConflictDoNothing` in KeywordRepository into an unconditional
 * insert, and the keyword list quietly fills with duplicates. If this table
 * ever has to change, hand-write the migration and re-create that index.
 */
export const searchKeywords = sqliteTable(
  'search_keywords',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    keyword: text('keyword').notNull(),
    /** Lower-cased and whitespace-collapsed; used only for de-duplication. */
    normalized: text('normalized').notNull(),
    /** The user term this was expanded from; null for a user term itself. */
    seed: text('seed'),
    origin: text('origin').notNull().default('user'),
    kind: text('kind').notNull().default('alternate_title'),
    confidence: real('confidence'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Collector ids this term is limited to; empty means every collector. */
    sources: text('sources', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    lastUsedAt: text('last_used_at'),
    jobsFound: integer('jobs_found').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [index('search_keywords_enabled_idx').on(t.enabled, t.origin)],
);

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

export type SearchKeywordRow = typeof searchKeywords.$inferSelect;
export type NewSearchKeywordRow = typeof searchKeywords.$inferInsert;
export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type RemoteCommandRow = typeof remoteCommands.$inferSelect;

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type ResumeRow = typeof resumes.$inferSelect;
export type NewResumeRow = typeof resumes.$inferInsert;
export type ApplicationRow = typeof applications.$inferSelect;
export type NewApplicationRow = typeof applications.$inferInsert;
export type QueueJobRow = typeof queueJobs.$inferSelect;
export type NewQueueJobRow = typeof queueJobs.$inferInsert;
export type CoverLetterRow = typeof coverLetters.$inferSelect;
export type LogRow = typeof logs.$inferSelect;
export type LlmCallRow = typeof llmCalls.$inferSelect;
export type BrowserSessionRow = typeof browserSessions.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type JobScoreRow = typeof jobScores.$inferSelect;
export type ApplicationEventRow = typeof applicationEvents.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type CollectorRunRow = typeof collectorRuns.$inferSelect;
export type PromptTemplateRow = typeof promptTemplates.$inferSelect;
export type AnswerBankRow = typeof answerBank.$inferSelect;
