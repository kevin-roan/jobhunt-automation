import { z } from 'zod';
import {
  applicationStatusSchema,
  credentialKindSchema,
  credentialStatusSchema,
  notificationKindSchema,
  notificationLevelSchema,
  type CommandStatus,
  type RemoteCommand,
  applicationStepSchema,
  artifactKindSchema,
  employmentTypeSchema,
  experienceLevelSchema,
  jobStatusSchema,
  keywordOriginSchema,
  llmTaskSchema,
  logLevelSchema,
  pipelineStageSchema,
  vpnBackendSchema,
  queueStatusSchema,
  queueTaskSchema,
  recommendationSchema,
  remoteTypeSchema,
  resumeDensitySchema,
  resumeFontSchema,
  stepStatusSchema,
} from './enums.js';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const jobDtoSchema = z.object({
  id: z.number().int(),
  externalId: z.string().nullable(),
  hash: z.string(),
  title: z.string(),
  company: z.string(),
  companyId: z.number().int().nullable(),
  location: z.string().nullable(),
  remoteType: remoteTypeSchema,
  employmentType: employmentTypeSchema,
  experienceLevel: experienceLevelSchema,
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryPeriod: z.string().nullable(),
  description: z.string().nullable(),
  descriptionHtml: z.string().nullable(),
  summary: z.string().nullable(),
  skills: z.array(z.string()),
  applicationUrl: z.string(),
  source: z.string(),
  postedAt: z.string().nullable(),
  collectedAt: z.string(),
  status: jobStatusSchema,
  score: z.number().nullable(),
  recommendation: recommendationSchema.nullable(),
  archived: z.boolean(),
});
export type JobDto = z.infer<typeof jobDtoSchema>;

export const jobQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  status: jobStatusSchema.optional(),
  source: z.string().optional(),
  company: z.string().optional(),
  remoteType: remoteTypeSchema.optional(),
  experienceLevel: experienceLevelSchema.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  recommendation: recommendationSchema.optional(),
  archived: z.coerce.boolean().optional(),
  sort: z.enum(['collectedAt', 'postedAt', 'score', 'company', 'title']).default('collectedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type JobQuery = z.infer<typeof jobQuerySchema>;

export const jobScoreDtoSchema = z.object({
  id: z.number().int(),
  jobId: z.number().int(),
  score: z.number(),
  confidence: z.number(),
  recommendation: recommendationSchema,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  redFlags: z.array(z.string()),
  reasoning: z.string(),
  interviewProbability: z.number().nullable(),
  model: z.string(),
  resumeId: z.number().int().nullable(),
  createdAt: z.string(),
});
export type JobScoreDto = z.infer<typeof jobScoreDtoSchema>;

/**
 * A colour as six hex digits. The class writes them straight into
 * `\definecolor{...}{HTML}{...}`, which rejects a leading `#`, so one is
 * stripped here rather than in every caller.
 */
const hexColorSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#/, '').toUpperCase())
  .pipe(z.string().regex(/^[0-9A-F]{6}$/, 'Expected a six-digit hex colour'));

/**
 * The knobs the editor and the model are allowed to turn. Everything here is
 * expanded into the class's `\cvtheme{...}` key list at render time, so a theme
 * can never inject arbitrary LaTeX.
 */
export const resumeThemeSchema = z.object({
  font: resumeFontSchema.default('raleway'),
  density: resumeDensitySchema.default('normal'),
  /** Body point size; every other size in the document scales from it. */
  baseFontSize: z.number().min(8).max(12).default(10),
  accent: hexColorSchema.default('2B4C7E'),
  primary: hexColorSchema.default('1F1F1F'),
  headings: hexColorSchema.default('3D3D3D'),
  subheadings: hexColorSchema.default('222222'),
  rule: hexColorSchema.default('BDBDBD'),
  date: hexColorSchema.default('5A5A5A'),
  /** Page margins in centimetres. */
  hmargin: z.number().min(0.6).max(3.5).default(1.45),
  vmargin: z.number().min(0.6).max(3.5).default(1.0),
});
export type ResumeTheme = z.infer<typeof resumeThemeSchema>;

export const DEFAULT_RESUME_THEME: ResumeTheme = resumeThemeSchema.parse({});

export const resumeDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  targetRole: z.string().nullable(),
  /** The source of truth: a full LaTeX document for deedy-resume-openfont. */
  latex: z.string(),
  theme: resumeThemeSchema,
  templateId: z.string(),
  /** Plain-text mirror of the LaTeX, derived at render time for the model. */
  markdown: z.string(),
  /** Engine output from the last compile; shown verbatim when one fails. */
  compileLog: z.string().nullable(),
  compileOk: z.boolean(),
  texPath: z.string().nullable(),
  filePath: z.string().nullable(),
  pdfPath: z.string().nullable(),
  docxPath: z.string().nullable(),
  isBase: z.boolean(),
  isDefault: z.boolean(),
  parentId: z.number().int().nullable(),
  jobId: z.number().int().nullable(),
  generatedBy: z.string().nullable(),
  changeSummary: z.array(z.string()),
  atsScore: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResumeDto = z.infer<typeof resumeDtoSchema>;

export const createResumeSchema = z.object({
  name: z.string().min(1).max(200),
  targetRole: z.string().max(200).optional(),
  latex: z.string().min(1).max(400_000),
  theme: resumeThemeSchema.optional(),
  isBase: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type CreateResumeInput = z.infer<typeof createResumeSchema>;

export const updateResumeSchema = createResumeSchema.partial();
export type UpdateResumeInput = z.infer<typeof updateResumeSchema>;

/** Compile-only request: used by the editor's live preview, saves nothing. */
export const compileResumeSchema = z.object({
  latex: z.string().min(1).max(400_000),
  theme: resumeThemeSchema.optional(),
});
export type CompileResumeInput = z.infer<typeof compileResumeSchema>;

/** "Make it one page", "use a warmer palette", "target this job" — free text. */
export const assistResumeSchema = z.object({
  latex: z.string().min(1).max(400_000),
  theme: resumeThemeSchema.optional(),
  instruction: z.string().min(1).max(4000),
  /** Optional job to tailor against; its description is added to the prompt. */
  jobId: z.number().int().positive().nullable().optional(),
});
export type AssistResumeInput = z.infer<typeof assistResumeSchema>;

export const assistResumeResultSchema = z.object({
  latex: z.string(),
  theme: resumeThemeSchema,
  summary: z.array(z.string()),
  model: z.string(),
  /** Whether the returned document compiled; the log explains it when not. */
  compileOk: z.boolean(),
  compileLog: z.string().nullable(),
});
export type AssistResumeResult = z.infer<typeof assistResumeResultSchema>;

/**
 * Result of a compile-only run. The PDF is not returned inline — it is written
 * to a short-lived preview file and fetched by id, so the editor can point an
 * `<iframe>` straight at it instead of shuttling megabytes of base64.
 */
export const compileResumeResultSchema = z.object({
  ok: z.boolean(),
  /** Engine output, trimmed to the part that explains a failure. */
  log: z.string(),
  /** Fetch at `/api/resumes/preview/{previewId}`; null when the compile failed. */
  previewId: z.string().nullable(),
  pages: z.number().int().nullable(),
  engine: z.string().nullable(),
  durationMs: z.number().int(),
});
export type CompileResumeResult = z.infer<typeof compileResumeResultSchema>;

/** Everything the editor needs to render a blank-slate resume. */
export const resumeTemplateSchema = z.object({
  templateId: z.string(),
  latex: z.string(),
  theme: resumeThemeSchema,
  /** The macro cheatsheet, also injected into every resume prompt. */
  macros: z.string(),
  /** Which engine the host will use, or null when none is installed. */
  engine: z.string().nullable(),
});
export type ResumeTemplate = z.infer<typeof resumeTemplateSchema>;

export const coverLetterDtoSchema = z.object({
  id: z.number().int(),
  jobId: z.number().int().nullable(),
  applicationId: z.number().int().nullable(),
  resumeId: z.number().int().nullable(),
  subject: z.string(),
  body: z.string(),
  tone: z.string().nullable(),
  version: z.number().int(),
  model: z.string().nullable(),
  pdfPath: z.string().nullable(),
  createdAt: z.string(),
});
export type CoverLetterDto = z.infer<typeof coverLetterDtoSchema>;

export const applicationDtoSchema = z.object({
  id: z.number().int(),
  jobId: z.number().int(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  source: z.string().nullable(),
  resumeId: z.number().int().nullable(),
  coverLetterId: z.number().int().nullable(),
  status: applicationStatusSchema,
  currentStep: applicationStepSchema.nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  confirmationText: z.string().nullable(),
  error: z.string().nullable(),
  dryRun: z.boolean(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApplicationDto = z.infer<typeof applicationDtoSchema>;

export const applicationEventDtoSchema = z.object({
  id: z.number().int(),
  applicationId: z.number().int(),
  step: applicationStepSchema,
  status: stepStatusSchema,
  attempt: z.number().int(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
});
export type ApplicationEventDto = z.infer<typeof applicationEventDtoSchema>;

export const artifactDtoSchema = z.object({
  id: z.number().int(),
  kind: artifactKindSchema,
  path: z.string(),
  applicationId: z.number().int().nullable(),
  jobId: z.number().int().nullable(),
  step: z.string().nullable(),
  bytes: z.number().int().nullable(),
  createdAt: z.string(),
});
export type ArtifactDto = z.infer<typeof artifactDtoSchema>;

export const queueJobDtoSchema = z.object({
  id: z.number().int(),
  task: queueTaskSchema,
  status: queueStatusSchema,
  priority: z.number().int(),
  payload: z.unknown(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  runAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  createdAt: z.string(),
});
export type QueueJobDto = z.infer<typeof queueJobDtoSchema>;

export const llmCallDtoSchema = z.object({
  id: z.number().int(),
  task: llmTaskSchema,
  provider: z.string(),
  model: z.string(),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  success: z.boolean(),
  attempt: z.number().int(),
  error: z.string().nullable(),
  jobId: z.number().int().nullable(),
  createdAt: z.string(),
});
export type LlmCallDto = z.infer<typeof llmCallDtoSchema>;

export const logQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  level: logLevelSchema.optional(),
  scope: z.string().optional(),
  since: z.string().optional(),
});
export type LogQuery = z.infer<typeof logQuerySchema>;

export const logDtoSchema = z.object({
  id: z.number().int(),
  level: logLevelSchema,
  scope: z.string(),
  message: z.string(),
  context: z.unknown(),
  createdAt: z.string(),
});
export type LogDto = z.infer<typeof logDtoSchema>;

export const browserSessionDtoSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  engine: z.string(),
  profilePath: z.string(),
  loggedIn: z.boolean(),
  lastUsedAt: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  storageStatePath: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type BrowserSessionDto = z.infer<typeof browserSessionDtoSchema>;

export const collectorDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  description: z.string(),
  requiresAuth: z.boolean(),
  requiresBoards: z.boolean(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
});
export type CollectorDto = z.infer<typeof collectorDtoSchema>;

export const collectorRunDtoSchema = z.object({
  id: z.number().int(),
  collectorId: z.string(),
  status: z.string(),
  found: z.number().int(),
  inserted: z.number().int(),
  duplicates: z.number().int(),
  errors: z.number().int(),
  message: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CollectorRunDto = z.infer<typeof collectorRunDtoSchema>;

/* -------------------------------------------------------------------------- */
/* Search keywords                                                            */
/* -------------------------------------------------------------------------- */

export const searchKeywordDtoSchema = z.object({
  id: z.number().int(),
  keyword: z.string(),
  /** The user term this was expanded from; null for a user term itself. */
  seed: z.string().nullable(),
  origin: keywordOriginSchema,
  kind: z.string(),
  confidence: z.number().nullable(),
  /** Only terms that are enabled are ever typed into a search box. */
  enabled: z.boolean(),
  /**
   * Collector ids this term is restricted to. Empty means every collector —
   * useful because "React" is a fine LinkedIn query but a poor Greenhouse one.
   */
  sources: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  jobsFound: z.number().int(),
  createdAt: z.string(),
});
export type SearchKeywordDto = z.infer<typeof searchKeywordDtoSchema>;

export const createKeywordsSchema = z.object({
  /** Free text: newline, comma or semicolon separated. Split server-side. */
  keywords: z.string().min(1).max(8000),
  origin: keywordOriginSchema.default('user'),
  sources: z.array(z.string()).default([]),
});
export type CreateKeywordsInput = z.infer<typeof createKeywordsSchema>;

export const updateKeywordSchema = z.object({
  enabled: z.boolean().optional(),
  sources: z.array(z.string()).optional(),
  keyword: z.string().min(1).max(80).optional(),
});
export type UpdateKeywordInput = z.infer<typeof updateKeywordSchema>;

/** Ask the local model to widen the seed terms. Seeds default to every user term. */
export const expandKeywordsSchema = z.object({
  seeds: z.array(z.string().min(1).max(80)).default([]),
  perSeed: z.number().int().min(1).max(25).optional(),
  /** Drop previously generated terms first, rather than merging into them. */
  replaceGenerated: z.boolean().default(false),
});
export type ExpandKeywordsInput = z.infer<typeof expandKeywordsSchema>;

export const expandKeywordsResultSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  removed: z.number().int(),
  model: z.string(),
  keywords: z.array(searchKeywordDtoSchema),
});
export type ExpandKeywordsResult = z.infer<typeof expandKeywordsResultSchema>;

/* -------------------------------------------------------------------------- */
/* Pipeline control                                                           */
/* -------------------------------------------------------------------------- */

export const pipelineStageStatusSchema = z.object({
  stage: pipelineStageSchema,
  /** Whether this stage is allowed to claim and start new work. */
  running: z.boolean(),
  /** True when this stage spends inference, so the UI can group the costly ones. */
  usesLlm: z.boolean(),
  /** Work already claimed and executing right now. */
  inFlight: z.number().int(),
  pending: z.number().int(),
  failed: z.number().int(),
});
export type PipelineStageStatus = z.infer<typeof pipelineStageStatusSchema>;

export const pipelineStatusSchema = z.object({
  /** Master switch: false means nothing is claimed from the queue at all. */
  enabled: z.boolean(),
  queuePaused: z.boolean(),
  schedulerEnabled: z.boolean(),
  workerRunning: z.boolean(),
  inFlight: z.number().int(),
  stages: z.array(pipelineStageStatusSchema),
  llm: z.object({
    /** Inference calls executing right now across every stage. */
    activeCalls: z.number().int(),
    model: z.string(),
    /** Stages that spend inference and are currently allowed to run. */
    activeStages: z.array(pipelineStageSchema),
  }),
});
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

export const pipelineControlSchema = z.object({
  /** Omit to target the whole pipeline; otherwise just this stage. */
  stage: pipelineStageSchema.optional(),
  action: z.enum(['start', 'stop']),
  /**
   * Abort work already in flight rather than letting it drain. Aborted queue
   * jobs are returned to pending, so nothing is lost — it just stops now.
   */
  abortInFlight: z.boolean().default(true),
});
export type PipelineControlInput = z.infer<typeof pipelineControlSchema>;

/* -------------------------------------------------------------------------- */
/* Per-source dashboard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything the dashboard needs to show one platform as its own tile:
 * whether it is configured, whether its session is alive, when it last ran and
 * what it actually produced. LinkedIn failing silently on an expired cookie is
 * the failure this view exists to make impossible to miss.
 */
export const sourceStatusDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  enabled: z.boolean(),
  requiresAuth: z.boolean(),
  requiresBoards: z.boolean(),
  /** Configured board slugs, for the sources that need them. */
  boards: z.array(z.string()),
  /** Null when this source needs no session. */
  credential: z
    .object({
      status: credentialStatusSchema,
      cookieCount: z.number().int().nullable(),
      expiresAt: z.string().nullable(),
      lastCheckedAt: z.string().nullable(),
    })
    .nullable(),
  /** Whether a persistent browser profile is currently open for it. */
  browserOpen: z.boolean(),
  /** True while a collect run for this source is claimed by the worker. */
  running: z.boolean(),
  lastRun: z
    .object({
      status: z.string(),
      found: z.number().int(),
      inserted: z.number().int(),
      duplicates: z.number().int(),
      errors: z.number().int(),
      message: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  totalJobs: z.number().int(),
  jobsToday: z.number().int(),
  scoredJobs: z.number().int(),
  averageScore: z.number().nullable(),
  applications: z.number().int(),
  /** How many active search terms this source will actually run. */
  activeKeywords: z.number().int(),
  /** Set when the source cannot run as configured, with the fix. */
  blockedReason: z.string().nullable(),
});
export type SourceStatusDto = z.infer<typeof sourceStatusDtoSchema>;

/* -------------------------------------------------------------------------- */
/* VPN exit location                                                          */
/* -------------------------------------------------------------------------- */

export const vpnCountryDtoSchema = z.object({
  /** ISO 3166-1 alpha-2. */
  code: z.string(),
  name: z.string(),
  /** How many servers the backend knows about there; 0 for a hand-configured backend. */
  servers: z.number().int(),
});
export type VpnCountryDto = z.infer<typeof vpnCountryDtoSchema>;

export const vpnStatusDtoSchema = z.object({
  enabled: z.boolean(),
  backend: vpnBackendSchema,
  /** False when the backend's tooling is missing or not signed in on this host. */
  available: z.boolean(),
  /** Why it is unavailable, with the command that fixes it. */
  unavailableReason: z.string().nullable(),
  connected: z.boolean(),
  /** Current exit country, when the backend reports one. */
  country: z.string().nullable(),
  serverName: z.string().nullable(),
  /** Only populated when `verifyExitIp` is on; otherwise null. */
  exitIp: z.string().nullable(),
  lastRotatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The rotation list from settings, in order. */
  rotation: z.array(z.string()),
  /** Everything the backend could connect to, for the country picker. */
  countries: z.array(vpnCountryDtoSchema),
});
export type VpnStatusDto = z.infer<typeof vpnStatusDtoSchema>;

export const vpnControlSchema = z.object({
  action: z.enum(['connect', 'disconnect', 'rotate']),
  /** Explicit exit country for `connect`; ignored by the others. */
  country: z.string().length(2).optional(),
  /**
   * Bypass `minRotationSeconds`. The dashboard button sets this — a human
   * pressing rotate is not the runaway case the floor exists to prevent.
   */
  force: z.boolean().default(false),
});
export type VpnControlInput = z.infer<typeof vpnControlSchema>;

export interface CountByLabel {
  label: string;
  count: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface OverviewStats {
  totalJobs: number;
  newJobs: number;
  scoredJobs: number;
  totalApplications: number;
  submittedApplications: number;
  failedApplications: number;
  needsHuman: number;
  interviews: number;
  offers: number;
  rejections: number;
  averageScore: number;
  successRate: number;
  failureRate: number;
  responseRate: number;
  interviewRate: number;
  applicationsToday: number;
  jobsToday: number;
  queuePending: number;
  queueActive: number;
  queueFailed: number;
  llmTokensTotal: number;
  llmCallsTotal: number;
}

export interface AnalyticsPayload {
  overview: OverviewStats;
  applicationsPerDay: TimeSeriesPoint[];
  jobsPerDay: TimeSeriesPoint[];
  averageScorePerDay: TimeSeriesPoint[];
  tokensPerDay: TimeSeriesPoint[];
  funnel: CountByLabel[];
  sourceDistribution: CountByLabel[];
  topCompanies: CountByLabel[];
  topSkills: CountByLabel[];
  locationDemand: CountByLabel[];
  scoreHistogram: CountByLabel[];
  resumeEffectiveness: {
    resumeId: number;
    name: string;
    used: number;
    submitted: number;
    interviews: number;
    successRate: number;
  }[];
  statusBreakdown: CountByLabel[];
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: boolean;
  llm: { reachable: boolean; model: string; error: string | null };
  queue: { running: boolean; paused: boolean; pending: number; active: number };
  scheduler: { running: boolean; tasks: { name: string; nextRunAt: string | null }[] };
}

export const applyNowSchema = z.object({
  jobId: z.number().int(),
  resumeId: z.number().int().nullable().optional(),
  dryRun: z.boolean().optional(),
  tailorResume: z.boolean().optional(),
  generateCoverLetter: z.boolean().optional(),
});
export type ApplyNowInput = z.infer<typeof applyNowSchema>;

export const answerBankDtoSchema = z.object({
  id: z.number().int(),
  questionPattern: z.string(),
  normalized: z.string(),
  answer: z.string(),
  fieldType: z.string(),
  useCount: z.number().int(),
  createdAt: z.string(),
});
export type AnswerBankDto = z.infer<typeof answerBankDtoSchema>;

export const promptTemplateDtoSchema = z.object({
  id: z.number().int(),
  task: llmTaskSchema,
  name: z.string(),
  system: z.string(),
  user: z.string(),
  isActive: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptTemplateDto = z.infer<typeof promptTemplateDtoSchema>;

/* -------------------------------------------------------------------------- */
/* Provider credentials                                                       */
/* -------------------------------------------------------------------------- */

export const providerCredentialDtoSchema = z.object({
  id: z.number().int(),
  provider: z.string(),
  kind: credentialKindSchema,
  status: credentialStatusSchema,
  /** Never the secret itself: a count or a masked hint only. */
  summary: z.string(),
  cookieCount: z.number().int().nullable(),
  domains: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderCredentialDto = z.infer<typeof providerCredentialDtoSchema>;

export const saveCredentialSchema = z.object({
  provider: z.string().min(1).max(60),
  kind: credentialKindSchema,
  /**
   * Accepts any of: a raw `Cookie:` header string, a JSON array exported by a
   * cookie extension, a Playwright storageState JSON object, or a bare token.
   */
  value: z.string().min(1),
  note: z.string().max(500).optional(),
});
export type SaveCredentialInput = z.infer<typeof saveCredentialSchema>;

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

export const notificationDtoSchema = z.object({
  id: z.number().int(),
  kind: notificationKindSchema,
  level: notificationLevelSchema,
  title: z.string(),
  body: z.string(),
  entityType: z.string().nullable(),
  entityId: z.number().int().nullable(),
  read: z.boolean(),
  actionable: z.boolean(),
  createdAt: z.string(),
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

/* -------------------------------------------------------------------------- */
/* Mobile sync                                                                */
/* -------------------------------------------------------------------------- */

export const syncStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  reachable: z.boolean(),
  paired: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  lastCommandPollAt: z.string().nullable(),
  pendingCommands: z.number().int(),
  syncedJobs: z.number().int(),
  syncedApplications: z.number().int(),
  devices: z.number().int(),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/** Row shape mirrored to Supabase. Deliberately free of documents and PII. */
export interface SyncedJobRow {
  id: number;
  user_id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  remote_type: string;
  employment_type: string;
  experience_level: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  score: number | null;
  recommendation: string | null;
  status: string;
  application_url: string;
  posted_at: string | null;
  collected_at: string;
  updated_at: string;
}

export interface SyncedApplicationRow {
  id: number;
  user_id: string;
  job_id: number;
  job_title: string | null;
  company: string | null;
  provider: string;
  status: string;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
  dry_run: boolean;
  started_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemoteCommandRow {
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
