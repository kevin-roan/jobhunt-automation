import { z } from 'zod';
import type { EffectiveSessionStrategy } from './enums.js';
import {
  browserEngineSchema,
  sessionStrategySchema,
  vpnBackendSchema,
  employmentTypeSchema,
  experienceLevelSchema,
  keywordMatchModeSchema,
  llmProviderSchema,
  remoteTypeSchema,
} from './enums.js';

export const llmSettingsSchema = z.object({
  provider: llmProviderSchema.default('ollama'),
  /**
   * Base URL of the OpenAI-compatible / Ollama endpoint.
   *
   * Being a valid URL is not the same as being a local one, and every prompt
   * this app builds carries the candidate's name, email, phone, whole resume and
   * the job description. `allowRemoteEndpoint` is what actually holds that
   * promise — see `assertLocalLlmEndpoint` in `services/llm/providers.ts`.
   */
  baseUrl: z.string().url().default('http://localhost:11434'),
  /**
   * Permit a base URL that is not demonstrably on this host or its private
   * network. Off by default and deliberately awkward to turn on: flipping it
   * means prompts containing full PII may be sent to a third party.
   */
  allowRemoteEndpoint: z.boolean().default(false),
  /** Optional bearer token for local gateways. Stored encrypted, masked in logs. */
  apiKey: z.string().default(''),
  /** Chosen by the user in Settings — never hardcoded anywhere in the codebase. */
  model: z.string().default(''),
  /** Optional smaller/faster model for cheap classification tasks. */
  fastModel: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(64).max(131072).default(4096),
  contextWindow: z.number().int().min(512).max(1048576).default(16384),
  requestTimeoutMs: z.number().int().min(1000).max(1800000).default(300000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  /** Ask the server to constrain decoding to the JSON schema when supported. */
  useStructuredOutputs: z.boolean().default(true),
  /**
   * Ask reasoning models (Qwen 3, DeepSeek-R1, …) to skip their chain-of-thought.
   * These tasks want structured JSON, not deliberation, and the thinking block
   * can cost hundreds of tokens per call — crippling on CPU-only inference.
   */
  disableThinking: z.boolean().default(true),
});
export type LlmSettings = z.infer<typeof llmSettingsSchema>;

/**
 * Exit-location control.
 *
 * Two honest reasons this exists. First, job boards are regional: Indeed serves
 * a different result set per country, so searching "jobs in Berlin" from an
 * Indian exit returns the wrong index. Second, a shared or datacentre IP gets
 * rate-limited quickly, and moving exits spreads a slow crawl out.
 *
 * It is NOT a way to defeat a determined anti-bot system — those fingerprint far
 * more than the IP — and rotating harder is not a substitute for crawling
 * politely. Every rotation is rate-limited by `minRotationSeconds` for that
 * reason.
 */
export const vpnSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  backend: vpnBackendSchema.default('none'),
  /**
   * ISO 3166-1 alpha-2 exit countries, tried in order. Empty means "let the
   * backend pick", which for Proton is its own fastest-server choice.
   */
  countries: z.array(z.string().length(2)).default([]),
  /** Reconnect to the next country when a collector reports a block or challenge. */
  rotateOnBlock: z.boolean().default(false),
  /** Floor between rotations, so a blocked run cannot thrash the tunnel. */
  minRotationSeconds: z.number().int().min(30).max(86400).default(300),
  /** Bring the tunnel up before a collector run that needs it. */
  connectBeforeCollect: z.boolean().default(false),
  /** Drop the tunnel again once the run finishes. */
  disconnectAfterCollect: z.boolean().default(false),
  /** Only these collectors trigger VPN handling; empty means every collector. */
  collectors: z.array(z.string()).default([]),
  /** Seconds to wait for the tunnel to report connected before giving up. */
  connectTimeoutSeconds: z.number().int().min(5).max(300).default(60),
  /**
   * Command templates for `backend: 'command'`. `{{country}}` is substituted.
   * Split on whitespace and executed directly — never through a shell — so a
   * template can neither pipe nor chain.
   */
  connectCommand: z.string().default(''),
  disconnectCommand: z.string().default(''),
  statusCommand: z.string().default(''),
  /** NetworkManager connection name per country, for `backend: 'nmcli'`. */
  nmcliConnectionPrefix: z.string().default(''),
  /**
   * Confirm the exit actually moved after connecting. This contacts one
   * IP-echo endpoint — the only outbound call this feature makes — so it is off
   * by default and the endpoint is yours to choose.
   */
  verifyExitIp: z.boolean().default(false),
  /**
   * Empty by default, and empty disables the check even when `verifyExitIp` is
   * on. Shipping a third party's hostname as the default would have made this
   * app contact them the moment someone flipped the switch, without ever having
   * chosen them — in a product whose whole promise is that nothing leaves the
   * host, that choice has to be typed out by hand.
   */
  exitIpEndpoint: z.string().default(''),
});
export type VpnSettings = z.infer<typeof vpnSettingsSchema>;

export const browserSettingsSchema = z.object({
  engine: browserEngineSchema.default('chromium'),
  headless: z.boolean().default(true),
  /**
   * Attended mode: one visible Chromium window, shared by every provider, that
   * stays open between runs.
   *
   * The point is to stop hand-feeding cookies. You sign in to LinkedIn or
   * Indeed yourself, in that window, the way you would in any browser; the
   * profile on disk keeps the session, and every collector and application run
   * afterwards drives the same profile. Nothing has to be exported, pasted or
   * decrypted, and the site sees an ordinary browser it has already challenged
   * and cleared.
   *
   * It needs a graphical session on the host, so it is off by default and a
   * headless deployment is unaffected.
   */
  attended: z.boolean().default(false),
  /**
   * Which session a collector or application run uses. See
   * `SESSION_STRATEGIES`. Left at `auto` this follows `attended`, which is what
   * that switch already implied; set it explicitly to pin the behaviour — most
   * usefully `attended`, so a signed-in window is the single source of truth and
   * a stale pasted cookie can never be replayed over it.
   */
  sessionStrategy: sessionStrategySchema.default('auto'),
  /**
   * Every provider shares one browser profile instead of getting its own.
   * Implied by `attended` — a single visible window cannot be per-provider —
   * but available on its own for a headless install that still wants one
   * cookie jar.
   */
  sharedProfile: z.boolean().default(false),
  /**
   * Leave the window open when a run finishes. Off closes it after each run,
   * which loses the point of signing in once.
   */
  keepAlive: z.boolean().default(true),
  /** Directory root for persistent profiles; one sub-directory per provider. */
  profileRoot: z.string().default('./data/browser-profiles'),
  slowMoMs: z.number().int().min(0).max(5000).default(0),
  navigationTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  actionTimeoutMs: z.number().int().min(500).max(600000).default(30000),
  viewportWidth: z.number().int().min(320).max(3840).default(1440),
  viewportHeight: z.number().int().min(320).max(2160).default(900),
  userAgent: z.string().default(''),
  locale: z.string().default('en-US'),
  timezone: z.string().default('UTC'),
  /**
   * Full-page screenshots of every application step.
   *
   * These are pixels of whatever was on screen, which on an application form is
   * the candidate's typed name, email, phone and address, plus the signed-in
   * chrome of the site. No scrubber can redact an image, so unlike the HTML
   * snapshots below these are stored exactly as captured. They never leave the
   * host, but they are the most sensitive thing in DATA_DIR. Turn this off if
   * that is not a trade you want.
   */
  captureScreenshots: z.boolean().default(true),
  /** DOM snapshots. Field values and inline scripts are redacted before write. */
  captureHtml: z.boolean().default(true),
  /** Hard stop: never click submit, only prepare the application. */
  dryRun: z.boolean().default(true),
});
export type BrowserSettings = z.infer<typeof browserSettingsSchema>;

/**
 * How aggressively the local model widens the candidate's own search terms.
 * Expansion runs on demand and its output is stored as editable rows, so the
 * user always sees — and can veto — every term that is actually searched.
 */
export const keywordExpansionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Extra terms generated per seed keyword. */
  perSeed: z.number().int().min(1).max(25).default(6),
  /** Terms below this confidence are stored but start disabled. */
  minConfidence: z.number().min(0).max(1).default(0.45),
  /** Hard cap on how many terms any one collector run will search. */
  maxActiveKeywords: z.number().int().min(1).max(200).default(30),
  /** Re-expand automatically whenever the seed list changes. */
  autoExpandOnSeedChange: z.boolean().default(false),
});
export type KeywordExpansionSettings = z.infer<typeof keywordExpansionSettingsSchema>;

export const searchSettingsSchema = z.object({
  /**
   * The candidate's own seed terms. These are never rewritten; the expanded
   * terms the collectors actually search live in the `search_keywords` table.
   */
  keywords: z.array(z.string().min(1)).default([]),
  excludedKeywords: z.array(z.string().min(1)).default([]),
  keywordExpansion: keywordExpansionSettingsSchema.default({}),
  locations: z.array(z.string().min(1)).default([]),
  remotePreference: z.array(remoteTypeSchema).default(['remote']),
  employmentTypes: z.array(employmentTypeSchema).default(['full_time']),
  experienceLevels: z.array(experienceLevelSchema).default(['mid', 'senior']),
  minSalary: z.number().min(0).nullable().default(null),
  maxSalary: z.number().min(0).nullable().default(null),
  currency: z.string().max(8).default('USD'),
  postedWithinDays: z.number().int().min(1).max(365).default(30),
  excludedCompanies: z.array(z.string()).default([]),
  /** Company slugs/boards per source, e.g. { greenhouse: ["stripe","figma"] }. */
  boards: z.record(z.string(), z.array(z.string())).default({}),
  enabledCollectors: z.array(z.string()).default([]),
  maxJobsPerCollectorRun: z.number().int().min(1).max(2000).default(100),
});
export type SearchSettings = z.infer<typeof searchSettingsSchema>;

export const applicationSettingsSchema = z.object({
  autoApply: z.boolean().default(false),
  minScoreToApply: z.number().min(0).max(100).default(75),
  minScoreToTailor: z.number().min(0).max(100).default(60),
  maxApplicationsPerDay: z.number().int().min(0).max(500).default(20),
  maxApplicationsPerCompanyPerDay: z.number().int().min(0).max(50).default(2),
  defaultResumeId: z.number().int().nullable().default(null),
  generateCoverLetter: z.boolean().default(true),
  tailorResume: z.boolean().default(true),
  /** Escalate to the Applications page instead of guessing an answer. */
  pauseOnUnknownQuestion: z.boolean().default(true),
  /**
   * How much of a posting an *automatic* apply has to recognise from the enabled
   * search keywords before it is queued. A score is a model's opinion; this is
   * the user's own vocabulary, so it acts as a hard gate on top of the score.
   *
   * `off` — no keyword test; score plus recommendation alone decide, which is
   * exactly the behaviour that existed before this setting.
   * `title` — the job title must contain an enabled keyword.
   * `title_or_skills` — the title *or* one of the skills extracted from the
   * posting must contain an enabled keyword. The default.
   *
   * Manual applies (the Apply and Retry buttons, and the phone's retry command)
   * are never gated: asking for one posting by id is explicit intent.
   */
  keywordMatch: keywordMatchModeSchema.default('title_or_skills'),
});
export type ApplicationSettings = z.infer<typeof applicationSettingsSchema>;

export const queueSettingsSchema = z.object({
  concurrency: z.number().int().min(1).max(32).default(2),
  browserConcurrency: z.number().int().min(1).max(8).default(1),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoffBaseMs: z.number().int().min(100).max(600000).default(5000),
  backoffFactor: z.number().min(1).max(10).default(2),
  stalledAfterMs: z.number().int().min(10000).max(7200000).default(900000),
  pollIntervalMs: z.number().int().min(100).max(60000).default(1000),
  paused: z.boolean().default(false),
});
export type QueueSettings = z.infer<typeof queueSettingsSchema>;

/**
 * Per-stage master switches, owned by the dashboard's start/stop controls.
 *
 * Local inference saturates a machine: one 14B model scoring a backlog will
 * take every core it can get. Each stage that calls the model is therefore
 * independently stoppable, and stopping one both blocks new work from being
 * claimed and aborts whatever that stage already has in flight. The flags are
 * persisted, so a stopped pipeline stays stopped across a restart.
 */
export const pipelineSettingsSchema = z.object({
  /** Master switch. Off means nothing is claimed from the queue at all. */
  enabled: z.boolean().default(true),
  collect: z.boolean().default(true),
  enrich: z.boolean().default(true),
  score: z.boolean().default(true),
  tailor: z.boolean().default(true),
  coverLetter: z.boolean().default(true),
  apply: z.boolean().default(true),
});
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>;

export const schedulerSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  collectIntervalMinutes: z.number().int().min(5).max(10080).default(180),
  scoreIntervalMinutes: z.number().int().min(1).max(1440).default(10),
  applyIntervalMinutes: z.number().int().min(5).max(10080).default(60),
  cleanupIntervalMinutes: z.number().int().min(60).max(20160).default(1440),
  backupIntervalMinutes: z.number().int().min(60).max(20160).default(1440),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  backupsToKeep: z.number().int().min(1).max(365).default(14),
});
export type SchedulerSettings = z.infer<typeof schedulerSettingsSchema>;

export const notificationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Local-only webhook (e.g. an ntfy/gotify container on the same host). */
  webhookUrl: z.string().default(''),
  notifyOnApplied: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
  notifyOnNeedsHuman: z.boolean().default(true),
  notifyOnHighScore: z.boolean().default(false),
  highScoreThreshold: z.number().min(0).max(100).default(90),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const profileSettingsSchema = z.object({
  fullName: z.string().default(''),
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  country: z.string().default(''),
  postalCode: z.string().default(''),
  linkedinUrl: z.string().default(''),
  githubUrl: z.string().default(''),
  portfolioUrl: z.string().default(''),
  /**
   * Null means "not set", and that distinction is load-bearing. The form filler
   * only skips a field when the answer is empty, so a numeric default of 0 is
   * indistinguishable from a real answer and gets typed into a live application
   * as "0 years of experience". Null makes the filler escalate instead.
   */
  yearsOfExperience: z.number().min(0).max(60).nullable().default(null),
  /**
   * Null means "the candidate has not said", and that is why these are nullable
   * rather than defaulted booleans.
   *
   * The form filler answers work-authorisation and sponsorship questions from
   * these values, on a real application, under the candidate's name — they are
   * legal declarations, not preferences. A `false`/`true` default would be
   * indistinguishable from a deliberate answer, so an untouched install would
   * confidently declare work authorisation nobody ever claimed. Null escalates
   * to the human instead, which is the only safe default for a declaration.
   */
  requiresSponsorship: z.boolean().nullable().default(null),
  authorizedToWork: z.boolean().nullable().default(null),
  /** A preference rather than a declaration, but unset is still not "no". */
  willingToRelocate: z.boolean().nullable().default(null),
  /** Null means "not set" — see `yearsOfExperience`. 0 is a real notice period. */
  noticePeriodDays: z.number().int().min(0).max(365).nullable().default(null),
  desiredSalary: z.number().min(0).nullable().default(null),
  summary: z.string().default(''),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;


/**
 * Mobile sync. Only operational metadata crosses the network: titles,
 * companies, statuses, errors and timestamps. Resumes, cover letters, profile
 * PII, provider cookies, LLM prompts and screenshots never leave the host.
 */
export const syncSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  /** Safe for the mobile client; protected by row level security. */
  publishableKey: z.string().default(''),
  /** Server-only. Encrypted at rest and never sent to any client. */
  secretKey: z.string().default(''),
  /** Supabase auth user id, pasted from the mobile app's pairing screen. */
  userId: z.string().default(''),
  intervalSeconds: z.number().int().min(15).max(3600).default(60),
  /** Poll interval for commands issued by the phone. */
  commandPollSeconds: z.number().int().min(5).max(600).default(20),
  pushEnabled: z.boolean().default(true),
  /** Upload only jobs at or above this score to keep the mirror small. */
  minScoreToSync: z.number().min(0).max(100).default(0),
  syncJobs: z.boolean().default(true),
  syncApplications: z.boolean().default(true),
  syncNotifications: z.boolean().default(true),
});
export type SyncSettings = z.infer<typeof syncSettingsSchema>;

export const settingsSchema = z.object({
  llm: llmSettingsSchema,
  browser: browserSettingsSchema,
  search: searchSettingsSchema,
  application: applicationSettingsSchema,
  queue: queueSettingsSchema,
  scheduler: schedulerSettingsSchema,
  pipeline: pipelineSettingsSchema,
  vpn: vpnSettingsSchema,
  notifications: notificationSettingsSchema,
  profile: profileSettingsSchema,
  sync: syncSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = z
  .object({
    llm: llmSettingsSchema.partial(),
    browser: browserSettingsSchema.partial(),
    search: searchSettingsSchema.partial(),
    application: applicationSettingsSchema.partial(),
    queue: queueSettingsSchema.partial(),
    scheduler: schedulerSettingsSchema.partial(),
    pipeline: pipelineSettingsSchema.partial(),
    vpn: vpnSettingsSchema.partial(),
    notifications: notificationSettingsSchema.partial(),
    profile: profileSettingsSchema.partial(),
    sync: syncSettingsSchema.partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * Dotted paths whose values must be encrypted at rest and masked in every log
 * line — and, since `GET /api/settings` returns them masked, in every response.
 *
 * Adding a path here has a second half that is easy to miss: the dashboard reads
 * the mask and would write it straight back, overwriting the real value. Any
 * path listed here must also be stripped-when-unchanged in `buildPatch` in
 * `apps/web/src/pages/Settings.tsx`. Both are covered for everything below.
 *
 * `llm.baseUrl` is deliberately NOT here, though it can legally carry
 * `https://user:pass@host`. Two reasons, either one sufficient:
 *
 *   1. It is the only field validated with `z.string().url()`, and
 *      `SettingsService.update` runs `settingsSchema.parse` on the merged object
 *      *before* the mask-means-unchanged filter gets a say. A mask is not a URL,
 *      so any client that round-trips the redacted payload — a curl PATCH, a
 *      test, a future client that does not replicate `buildPatch` — would fail
 *      the whole save. That is a strictly worse failure than the leak it fixes.
 *   2. Masking it would hide from the user the one value that says where their
 *      prompts are going, which is exactly what `allowRemoteEndpoint` exists to
 *      make visible. Redacting the evidence and guarding the behaviour are not
 *      the same trade.
 *
 * Credentials embedded in the base URL are instead handled where they matter:
 * the endpoint guard refuses non-local hosts outright, and the redactor keeps
 * URL userinfo out of logs.
 */
export const SECRET_SETTING_PATHS = [
  'llm.apiKey',
  'notifications.webhookUrl',
  'sync.secretKey',
  // Routinely carry `--username x --password y` on the command line.
  'vpn.connectCommand',
  'vpn.disconnectCommand',
  'vpn.statusCommand',
  // Together these identify and address the user's sync project. The
  // publishable key is only as safe as row level security, and the URL plus
  // user id are enough to fingerprint the account.
  'sync.url',
  'sync.publishableKey',
  'sync.userId',
] as const;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({
  llm: {},
  browser: {},
  search: {},
  application: {},
  queue: {},
  scheduler: {},
  pipeline: {},
  vpn: {},
  notifications: {},
  profile: {},
  sync: {},
});

/**
 * Resolves `auto` into the strategy the run path actually branches on.
 *
 * Kept here, in shared, so the API and the dashboard can never disagree about
 * which session a run is going to use — the answer is shown in the UI and acted
 * on by `BrowserManager`, and those drifting apart is precisely the kind of bug
 * that costs someone a day.
 *
 * `auto` follows `attended` because that switch already meant "there is a window
 * I sign in to myself"; an explicit value overrides it, including the
 * deliberately awkward combination of attended mode ON with `stored` chosen,
 * which is legitimate when someone wants the visible window for debugging but
 * still wants the pasted cookie to be authoritative.
 */
export function resolveSessionStrategy(
  browser: Pick<BrowserSettings, 'attended' | 'sessionStrategy'>,
): EffectiveSessionStrategy {
  if (browser.sessionStrategy !== 'auto') return browser.sessionStrategy;
  return browser.attended ? 'attended' : 'stored';
}
