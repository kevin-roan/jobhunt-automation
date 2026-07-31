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
  llmTaskSchema,
  logLevelSchema,
  queueStatusSchema,
  queueTaskSchema,
  recommendationSchema,
  remoteTypeSchema,
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

export const resumeDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.number().int(),
  targetRole: z.string().nullable(),
  markdown: z.string(),
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
  markdown: z.string().min(1),
  isBase: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type CreateResumeInput = z.infer<typeof createResumeSchema>;

export const updateResumeSchema = createResumeSchema.partial();
export type UpdateResumeInput = z.infer<typeof updateResumeSchema>;

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
