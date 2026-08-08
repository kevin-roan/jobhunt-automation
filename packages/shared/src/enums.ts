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
  'resume_latex_edit',
  'cover_letter',
  'ats_keywords',
  'application_scoring',
  'interview_prediction',
  'job_summary',
  'company_summary',
  'salary_extraction',
  'keyword_expansion',
  'form_answer',
] as const;
export const llmTaskSchema = z.enum(LLM_TASKS);
export type LlmTask = z.infer<typeof llmTaskSchema>;

/**
 * Who put a search keyword in the list. `user` keywords are the seeds the
 * candidate typed and are never rewritten; `llm` keywords are expansions the
 * local model generated around a seed and can be regenerated at will.
 */
export const KEYWORD_ORIGINS = ['user', 'llm'] as const;
export const keywordOriginSchema = z.enum(KEYWORD_ORIGINS);
export type KeywordOrigin = z.infer<typeof keywordOriginSchema>;

/**
 * The independently startable/stoppable halves of the pipeline. Inference is
 * by far the most expensive thing this system does, so every stage that calls
 * the model is its own switch: the user can keep collecting while the LLM is
 * completely idle.
 */
export const PIPELINE_STAGES = [
  'collect',
  'enrich',
  'score',
  'tailor',
  'cover_letter',
  'apply',
] as const;
export const pipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

/**
 * The `PipelineSettings` key holding a given stage's switch. Only
 * `cover_letter` differs: settings spell it in camelCase, stage ids in snake.
 */
export type PipelineStageSettingKey<S extends PipelineStage> = S extends 'cover_letter'
  ? 'coverLetter'
  : S;

/**
 * Stage id -> settings key. The one place the two vocabularies meet; the worker
 * and the dashboard both read it so they cannot drift apart. The mapped type
 * pins every entry to its own literal, so a copy/paste slip such as
 * `cover_letter: 'apply'` is a compile error rather than a silent mis-switch.
 */
export const STAGE_SETTING_KEY: { [S in PipelineStage]: PipelineStageSettingKey<S> } = {
  collect: 'collect',
  enrich: 'enrich',
  score: 'score',
  tailor: 'tailor',
  cover_letter: 'coverLetter',
  apply: 'apply',
};

/** Which pipeline stage each unit of background work belongs to. */
export const QUEUE_TASK_STAGE: Record<string, PipelineStage> = {
  'collect.jobs': 'collect',
  'job.enrich': 'enrich',
  'job.score': 'score',
  'resume.tailor': 'tailor',
  'cover_letter.generate': 'cover_letter',
  'application.apply': 'apply',
};

/** The stages that spend inference. Stopping these is what frees the machine. */
export const LLM_PIPELINE_STAGES: PipelineStage[] = [
  'enrich',
  'score',
  'tailor',
  'cover_letter',
];

/**
 * Font presets the resume class can install. Every one of these ships inside
 * TeX Live, so switching typeface never requires a download.
 */
export const RESUME_FONTS = ['raleway', 'sourcesans', 'fira', 'garamond', 'latinmodern'] as const;
export const resumeFontSchema = z.enum(RESUME_FONTS);
export type ResumeFont = z.infer<typeof resumeFontSchema>;

/** How tightly the resume packs vertically. Drives every gap in the class. */
export const RESUME_DENSITIES = ['compact', 'normal', 'relaxed'] as const;
export const resumeDensitySchema = z.enum(RESUME_DENSITIES);
export type ResumeDensity = z.infer<typeof resumeDensitySchema>;

/**
 * How the host's VPN is driven. Proton ships no scriptable CLI on Linux any
 * more — v4 is a GTK app over `proton-vpn-api-core` — so `protonvpn` means the
 * bundled Python helper that talks to that library. The other backends exist
 * because a tunnel is a tunnel: anyone already managing one through
 * NetworkManager, wg-quick or a script of their own should not have to switch.
 */
export const VPN_BACKENDS = ['none', 'protonvpn', 'nmcli', 'wg_quick', 'command'] as const;
export const vpnBackendSchema = z.enum(VPN_BACKENDS);
export type VpnBackend = z.infer<typeof vpnBackendSchema>;

/**
 * Where a signed-in session comes from when a collector or an application run
 * needs one.
 *
 * `attended` — the shared browser profile the user signed in to by hand, in the
 * visible window (on their desktop, or over noVNC in the container). The
 * profile IS the session; the credential vault is not consulted at all, so a
 * source with nothing pasted is still perfectly able to run.
 *
 * `stored` — the classic path: a session the user exported from their own
 * browser and pasted in, injected as cookies into a per-provider profile. Works
 * headlessly and without a screen, at the cost of re-pasting whenever it
 * expires.
 *
 * `auto` — follow `browser.attended`: use the attended profile when attended
 * mode is on, the vault when it is off. The default, because it is what the two
 * switches already implied before this setting existed.
 */
export const SESSION_STRATEGIES = ['auto', 'attended', 'stored'] as const;
export const sessionStrategySchema = z.enum(SESSION_STRATEGIES);
export type SessionStrategy = z.infer<typeof sessionStrategySchema>;

/** `auto` resolved away — what the run path actually branches on. */
export type EffectiveSessionStrategy = Exclude<SessionStrategy, 'auto'>;

/**
 * How much of a posting the auto-apply keyword gate has to recognise before the
 * pipeline is allowed to spend an application on it.
 *
 * `off` — no keyword test at all; selection is score plus recommendation, the
 * behaviour that existed before the gate.
 *
 * `title` — the job title alone must contain an enabled keyword. Strictest, and
 * the one that keeps a high-scoring adjacent role out.
 *
 * `title_or_skills` — the title, or any skill extracted from the posting, must
 * contain an enabled keyword.
 */
export const KEYWORD_MATCH_MODES = ['off', 'title', 'title_or_skills'] as const;
export const keywordMatchModeSchema = z.enum(KEYWORD_MATCH_MODES);
export type KeywordMatchMode = z.infer<typeof keywordMatchModeSchema>;

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
