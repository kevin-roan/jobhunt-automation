import { z } from 'zod';

/** Sources a job can be collected from. Extended dynamically by collector plugins. */
export const JOB_SOURCES = [
  'linkedin',
  'indeed',
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'workable',
  'recruitee',
  'manual',
] as const;
export const jobSourceSchema = z.enum(JOB_SOURCES);
export type JobSource = z.infer<typeof jobSourceSchema>;

export const REMOTE_TYPES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export const remoteTypeSchema = z.enum(REMOTE_TYPES);
export type RemoteType = z.infer<typeof remoteTypeSchema>;

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'unknown',
] as const;
export const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

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
export const experienceLevelSchema = z.enum(EXPERIENCE_LEVELS);
export type ExperienceLevel = z.infer<typeof experienceLevelSchema>;

/** Lifecycle of a collected job inside the pipeline. */
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
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const RECOMMENDATIONS = ['apply', 'skip', 'manual_review'] as const;
export const recommendationSchema = z.enum(RECOMMENDATIONS);
export type Recommendation = z.infer<typeof recommendationSchema>;

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
export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

/** Discrete, resumable steps of the browser application pipeline. */
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
export const applicationStepSchema = z.enum(APPLICATION_STEPS);
export type ApplicationStep = z.infer<typeof applicationStepSchema>;

export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;
export const stepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const QUEUE_STATUSES = [
  'pending',
  'active',
  'completed',
  'failed',
  'delayed',
  'cancelled',
] as const;
export const queueStatusSchema = z.enum(QUEUE_STATUSES);
export type QueueStatus = z.infer<typeof queueStatusSchema>;

/** Every unit of background work the system can perform. */
export const QUEUE_TASKS = [
  'collect.jobs',
  'job.score',
  'job.enrich',
  'resume.tailor',
  'cover_letter.generate',
  'application.apply',
  'company.summarize',
  'maintenance.cleanup',
  'maintenance.backup',
] as const;
export const queueTaskSchema = z.enum(QUEUE_TASKS);
export type QueueTask = z.infer<typeof queueTaskSchema>;

export const LLM_PROVIDERS = [
  'ollama',
  'openai_compatible',
  'llamacpp',
  'lmstudio',
  'openrouter_local',
] as const;
export const llmProviderSchema = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export const LLM_TASKS = [
  'skill_extraction',
  'job_classification',
  'resume_tailoring',
  'cover_letter',
  'ats_keywords',
  'application_scoring',
  'interview_prediction',
  'job_summary',
  'company_summary',
  'salary_extraction',
  'form_answer',
] as const;
export const llmTaskSchema = z.enum(LLM_TASKS);
export type LlmTask = z.infer<typeof llmTaskSchema>;

export const BROWSER_ENGINES = ['chromium', 'chrome', 'firefox'] as const;
export const browserEngineSchema = z.enum(BROWSER_ENGINES);
export type BrowserEngine = z.infer<typeof browserEngineSchema>;

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const ARTIFACT_KINDS = ['screenshot', 'html', 'pdf', 'docx', 'markdown', 'json'] as const;
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * How a provider credential was supplied. Sites that block automated login
 * (LinkedIn, Indeed) are reachable by pasting a session the user already holds
 * in their own browser, so no password ever enters this system.
 */
export const CREDENTIAL_KINDS = ['cookies', 'storage_state', 'bearer_token', 'header'] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

export const CREDENTIAL_STATUSES = ['unknown', 'valid', 'expired', 'invalid'] as const;
export const credentialStatusSchema = z.enum(CREDENTIAL_STATUSES);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'error'] as const;
export const notificationLevelSchema = z.enum(NOTIFICATION_LEVELS);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/** Categories the mobile app filters and routes on. */
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
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * Commands the mobile app can issue. The phone never reaches the local API
 * directly: it writes a row to Supabase and the local worker claims it, so the
 * host needs no inbound ports or tunnels.
 */
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
export const remoteCommandSchema = z.enum(REMOTE_COMMANDS);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

export const COMMAND_STATUSES = ['pending', 'claimed', 'succeeded', 'failed'] as const;
export const commandStatusSchema = z.enum(COMMAND_STATUSES);
export type CommandStatus = z.infer<typeof commandStatusSchema>;
