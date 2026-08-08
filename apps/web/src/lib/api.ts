import type {
  AnalyticsPayload,
  AnswerBankDto,
  ApplicationDto,
  ApplicationEventDto,
  ArtifactDto,
  AssistResumeResult,
  BrowserSessionDto,
  BrowserSessionStatus,
  CollectorDto,
  CollectorRunDto,
  CompileResumeResult,
  CoverLetterDto,
  EffectiveSessionStrategy,
  ExpandKeywordsResult,
  HealthPayload,
  JobDto,
  JobQuery,
  JobScoreDto,
  LlmCallDto,
  LogDto,
  LogQuery,
  NotificationDto,
  NotificationKind,
  OverviewStats,
  Paginated,
  PipelineStage,
  PipelineStatus,
  PromptTemplateDto,
  ProviderCredentialDto,
  QueueJobDto,
  ResumeDto,
  ResumeTemplate,
  ResumeTheme,
  SaveCredentialInput,
  SearchKeywordDto,
  Settings,
  SettingsPatch,
  SourceStatusDto,
  SyncStatus,
  VpnStatusDto,
} from '@deedy/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api';

/* -------------------------------------------------------------------------- */
/* Bearer token                                                                */
/* -------------------------------------------------------------------------- */

const TOKEN_STORAGE_KEY = 'deedy.apiToken';

/**
 * `localStorage`, not a cookie. A cookie would be attached by the browser to
 * every same-origin request automatically, which is exactly what makes CSRF
 * possible; a header this module sets by hand cannot be forged by another page.
 */
function readStoredToken(): string | null {
  try {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    // Private-mode or a blocked storage partition. The gate simply asks again.
    return null;
  }
}

let apiToken: string | null = readStoredToken();

const unauthorizedListeners = new Set<() => void>();

/**
 * URL of the live event stream, token included.
 *
 * `let`, and reassigned by `setApiToken`, because `EventSource` cannot send an
 * Authorization header — the browser opens that socket itself. ESM live
 * bindings mean `lib/events.ts` reads the current value when its effect runs,
 * which is always after the gate has stored a token.
 */
export let eventsUrl = '';

function withToken(url: string): string {
  if (apiToken === null) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(apiToken)}`;
}

function refreshTokenisedUrls(): void {
  eventsUrl = withToken(`${BASE}/events`);
}

refreshTokenisedUrls();

export function getApiToken(): string | null {
  return apiToken;
}

/** Stores (or clears) the token and re-points every URL that carries it inline. */
export function setApiToken(token: string | null): void {
  apiToken = token !== null && token.length > 0 ? token : null;
  try {
    if (apiToken === null) window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, apiToken);
  } catch {
    // Storage unavailable: the token still works for this page's lifetime.
  }
  refreshTokenisedUrls();
}

/**
 * Fires when the server rejects the stored token. The gate re-renders instead
 * of leaving the dashboard showing empty panels with no explanation.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(apiToken !== null ? { authorization: `Bearer ${apiToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    // A rejected token is never transient, so keeping it would just produce a
    // dashboard full of failing panels. Drop it and let the gate ask again.
    if (response.status === 401) {
      setApiToken(null);
      for (const listener of unauthorizedListeners) listener();
    }

    let message = `Request failed with ${response.status}`;
    let code = 'request_failed';
    let details: unknown;
    try {
      const body = (await response.json()) as { message?: string; error?: string; details?: unknown };
      message = body.message ?? message;
      code = body.error ?? code;
      details = body.details;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(message, response.status, code, details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

export interface JobDetail extends JobDto {
  raw: unknown;
  scores: JobScoreDto[];
  applicationId: number | null;
}

export interface ApplicationDetail extends ApplicationDto {
  events: ApplicationEventDto[];
  artifacts: ArtifactDto[];
  answers: {
    id: number;
    question: string;
    answer: string;
    fieldType: string;
    source: string;
    confidence: number | null;
    createdAt: string;
  }[];
}

/**
 * Saving also injects the session into any live browser context, so the server
 * reports how many cookies it managed to apply on top of the stored metadata.
 */
export interface SaveCredentialResult extends ProviderCredentialDto {
  cookiesApplied: number;
}

/** Result of replaying a stored session against the provider. Never echoes the secret. */
export interface CredentialVerifyResult {
  provider: string;
  /**
   * Whether the pasted vault session still works. It only answers that
   * question: under the `attended` strategy a provider with nothing pasted
   * comes back false because there is nothing in the vault to judge, not
   * because a session broke. Always read it together with `strategy`.
   */
  valid: boolean;
  /**
   * Which session a run would actually use. `attended` plus `valid: false`
   * means "not vault-backed, ask the browser-session check instead", never
   * "invalid".
   */
  strategy: EffectiveSessionStrategy;
  message: string | null;
  checkedAt: string;
}

export interface SyncFlushResult {
  pushed: number;
  failed: number;
}

export interface SyncFullResult {
  enqueued: number;
}

export interface SyncTestResult {
  reachable: boolean;
  error: string | null;
}

export interface QueueStats {
  byStatus: Record<string, number>;
  byTask: { task: string; status: string; value: number }[];
  worker: { running: boolean; inFlight: number; workerId: string };
}

/** Typed client for every endpoint the dashboard uses. */
export const api = {
  health: (): Promise<HealthPayload> => request('/health'),

  /**
   * The token gate. `status` is the one endpoint served without a token — it
   * only reports whether this instance wants one. `check` is gated, so a 200
   * from it IS the verification.
   */
  auth: {
    status: (): Promise<{ authRequired: boolean }> => request('/auth/status'),
    check: (): Promise<{ ok: true }> => request('/auth/check'),
  },

  settings: {
    get: (): Promise<Settings> => request('/settings'),
    update: (body: SettingsPatch): Promise<Settings> => patch('/settings', body),
    models: (): Promise<{ models: { id: string; name: string; sizeBytes?: number | null }[] }> =>
      request('/settings/llm/models'),
    testLlm: (): Promise<{ reachable: boolean; model: string; error: string | null }> =>
      post('/settings/llm/test'),
    pauseQueue: (paused: boolean): Promise<{ ok: true }> =>
      post('/settings/queue/pause', { paused }),
  },

  jobs: {
    list: (query: Partial<JobQuery>): Promise<Paginated<JobDto>> =>
      request(`/jobs${buildQuery(query as Record<string, QueryValue>)}`),
    get: (id: number): Promise<JobDetail> => request(`/jobs/${id}`),
    sources: (): Promise<{ sources: string[] }> => request('/jobs/sources'),
    update: (id: number, body: { status?: string; archived?: boolean }): Promise<JobDto> =>
      patch(`/jobs/${id}`, body),
    remove: (id: number): Promise<{ ok: true }> => del(`/jobs/${id}`),
    score: (
      id: number,
      body: { resumeId?: number | null; immediate?: boolean } = {},
    ): Promise<{ queued: boolean; queueJobId: number | null; score: number | null }> =>
      post(`/jobs/${id}/score`, body),
    enrich: (id: number): Promise<{ queueJobId: number }> => post(`/jobs/${id}/enrich`),
  },

  applications: {
    list: (query: {
      page?: number;
      pageSize?: number;
      status?: string;
      jobId?: number;
    }): Promise<Paginated<ApplicationDto>> => request(`/applications${buildQuery(query)}`),
    get: (id: number): Promise<ApplicationDetail> => request(`/applications/${id}`),
    apply: (body: {
      jobId: number;
      resumeId?: number | null;
      dryRun?: boolean;
      tailorResume?: boolean;
      generateCoverLetter?: boolean;
      immediate?: boolean;
    }): Promise<{
      queued: boolean;
      queueJobId: number | null;
      applicationId: number | null;
      status: string | null;
      needsHuman: string | null;
    }> => post('/applications/apply', body),
    retry: (id: number): Promise<{ queueJobId: number }> => post(`/applications/${id}/retry`),
    setStatus: (id: number, status: string): Promise<ApplicationDto> =>
      patch(`/applications/${id}`, { status }),
  },

  answers: {
    list: (): Promise<{ answers: AnswerBankDto[] }> => request('/answers'),
    save: (body: { question: string; answer: string; fieldType?: string }): Promise<{ ok: true }> =>
      post('/answers', body),
    remove: (id: number): Promise<{ ok: true }> => del(`/answers/${id}`),
  },

  /**
   * Resumes are LaTeX documents for the deedy-resume-openfont class. The
   * `latex` field is the source of truth; `markdown` is a derived plain-text
   * mirror the scoring and cover-letter prompts read.
   */
  resumes: {
    list: (includeGenerated = true): Promise<{ resumes: ResumeDto[] }> =>
      request(`/resumes${buildQuery({ includeGenerated })}`),
    get: (id: number): Promise<ResumeDto> => request(`/resumes/${id}`),
    /** Starter document, default theme, macro cheatsheet and the host's engine. */
    template: (): Promise<ResumeTemplate> => request('/resumes/template'),
    create: (body: {
      name: string;
      latex: string;
      theme?: ResumeTheme;
      targetRole?: string;
      isBase?: boolean;
      isDefault?: boolean;
    }): Promise<ResumeDto> => post('/resumes', body),
    update: (
      id: number,
      body: {
        name?: string;
        latex?: string;
        theme?: ResumeTheme;
        targetRole?: string;
        isDefault?: boolean;
      },
    ): Promise<ResumeDto> => patch(`/resumes/${id}`, body),
    remove: (id: number): Promise<{ ok: true }> => del(`/resumes/${id}`),
    /** Compile without saving; drives the editor's live PDF preview. */
    /**
     * `signal` lets the editor drop a superseded compile. It abandons the
     * response, not the build — the engine runs to completion or hits its own
     * timeout on the host either way.
     */
    compile: (
      body: { latex: string; theme?: ResumeTheme },
      signal?: AbortSignal,
    ): Promise<CompileResumeResult> => post('/resumes/compile', body, signal),
    // Loaded by the browser (an <object>/<a>), which cannot attach a header —
    // hence the inline token. See `withToken`.
    previewUrl: (previewId: string): string => withToken(`${BASE}/resumes/preview/${previewId}`),
    /** Free-text editing: "make it one page", "target this job", "warmer palette". */
    assist: (
      id: number,
      body: { latex: string; theme?: ResumeTheme; instruction: string; jobId?: number | null },
    ): Promise<AssistResumeResult> => post(`/resumes/${id}/assist`, body),
    tailor: (
      id: number,
      body: { jobId: number; force?: boolean; immediate?: boolean },
    ): Promise<{ resume: ResumeDto | null; queueJobId: number | null }> =>
      post(`/resumes/${id}/tailor`, body),
    /** `txt` is the derived plain-text mirror — what an ATS parser sees. */
    downloadUrl: (id: number, format: 'pdf' | 'docx' | 'txt' | 'tex'): string =>
      withToken(`${BASE}/resumes/${id}/download?format=${format}`),
  },

  /**
   * Start/stop control for the pipeline. Inference is the expensive part, so
   * every stage that calls the model can be stopped on its own; stopping also
   * aborts what that stage already has in flight.
   */
  pipeline: {
    status: (): Promise<PipelineStatus> => request('/pipeline'),
    control: (body: {
      stage?: PipelineStage;
      action: 'start' | 'stop';
      abortInFlight?: boolean;
    }): Promise<PipelineStatus> => post('/pipeline/control', body),
    start: (stage?: PipelineStage): Promise<PipelineStatus> =>
      post('/pipeline/control', { stage, action: 'start' }),
    stop: (stage?: PipelineStage, abortInFlight = true): Promise<PipelineStatus> =>
      post('/pipeline/control', { stage, action: 'stop', abortInFlight }),
  },

  /**
   * Exit-location control. Job boards are regional, so the exit country decides
   * which index you actually search; it also spreads a slow crawl across
   * addresses. It is not a way around anti-bot fingerprinting.
   */
  vpn: {
    status: (): Promise<VpnStatusDto> => request('/vpn'),
    control: (body: {
      action: 'connect' | 'disconnect' | 'rotate';
      country?: string;
      force?: boolean;
    }): Promise<VpnStatusDto> => post('/vpn/control', body),
    connect: (country?: string): Promise<VpnStatusDto> =>
      post('/vpn/control', { action: 'connect', country, force: true }),
    disconnect: (): Promise<VpnStatusDto> => post('/vpn/control', { action: 'disconnect' }),
    rotate: (): Promise<VpnStatusDto> => post('/vpn/control', { action: 'rotate', force: true }),
  },

  /** Per-platform state: LinkedIn, Indeed, Greenhouse and friends, side by side. */
  sources: {
    list: (): Promise<{ sources: SourceStatusDto[] }> => request('/sources'),
    run: (
      id: string,
      immediate = false,
    ): Promise<{ queueJobId: number | null; summary: unknown }> =>
      post(`/sources/${encodeURIComponent(id)}/run`, { immediate }),
    stop: (id: string): Promise<{ cancelled: number }> =>
      post(`/sources/${encodeURIComponent(id)}/stop`),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      post(`/sources/${encodeURIComponent(id)}/enabled`, { enabled }),
  },

  /**
   * The terms collectors type into each platform's search box. User seeds and
   * the model's expansions of them are the same kind of row, distinguished by
   * `origin`, so both can be enabled, scoped and deleted individually.
   */
  keywords: {
    list: (): Promise<{ keywords: SearchKeywordDto[] }> => request('/keywords'),
    create: (body: {
      keywords: string;
      origin?: 'user' | 'llm';
      sources?: string[];
    }): Promise<{ keywords: SearchKeywordDto[]; created: number }> => post('/keywords', body),
    update: (
      id: number,
      body: { enabled?: boolean; sources?: string[]; keyword?: string },
    ): Promise<SearchKeywordDto> => patch(`/keywords/${id}`, body),
    remove: (id: number): Promise<{ ok: true }> => del(`/keywords/${id}`),
    /** Widen the seeds with the local model. */
    expand: (body: {
      seeds?: string[];
      perSeed?: number;
      replaceGenerated?: boolean;
    } = {}): Promise<ExpandKeywordsResult> => post('/keywords/expand', body),
    /** Mirror `settings.search.keywords` into rows after editing them in Settings. */
    syncSeeds: (): Promise<{ keywords: SearchKeywordDto[] }> => post('/keywords/sync-seeds'),
  },

  coverLetters: {
    list: (jobId?: number): Promise<{ coverLetters: CoverLetterDto[] }> =>
      request(`/cover-letters${buildQuery({ jobId })}`),
    generate: (body: {
      jobId: number;
      resumeId?: number | null;
      regenerate?: boolean;
    }): Promise<CoverLetterDto> => post('/cover-letters', body),
    remove: (id: number): Promise<{ ok: true }> => del(`/cover-letters/${id}`),
  },

  queue: {
    list: (query: {
      page?: number;
      pageSize?: number;
      status?: string;
      task?: string;
    }): Promise<Paginated<QueueJobDto>> => request(`/queue${buildQuery(query)}`),
    stats: (): Promise<QueueStats> => request('/queue/stats'),
    retry: (id: number): Promise<{ ok: true }> => post(`/queue/${id}/retry`),
    cancel: (id: number): Promise<{ ok: true }> => post(`/queue/${id}/cancel`),
    retryFailed: (): Promise<{ retried: number }> => post('/queue/retry-failed'),
  },

  collectors: {
    list: (): Promise<{ collectors: CollectorDto[]; planned: string[] }> => request('/collectors'),
    runs: (limit = 50): Promise<{ runs: CollectorRunDto[] }> =>
      request(`/collectors/runs${buildQuery({ limit })}`),
    run: (
      collectorId: string,
      immediate = false,
    ): Promise<{ queueJobId: number | null; summary: unknown }> =>
      post(`/collectors/${collectorId}/run`, { immediate }),
  },

  /**
   * The attended browser: one visible window you sign in to yourself, which
   * every collector then reuses. Replaces pasting cookies.
   */
  browser: {
    status: (): Promise<BrowserSessionStatus> => request('/browser/session'),
    open: (): Promise<BrowserSessionStatus> =>
      post('/browser/session/control', { action: 'open' }),
    close: (): Promise<BrowserSessionStatus> =>
      post('/browser/session/control', { action: 'close' }),
    /** Opens a login tab for a provider and brings the window forward. */
    signIn: (provider: string, url?: string): Promise<BrowserSessionStatus> =>
      post('/browser/session/control', { action: 'signin', provider, url }),
    /** Re-probes whether a provider is signed in right now. */
    check: (provider?: string): Promise<BrowserSessionStatus> =>
      post('/browser/session/control', { action: 'check', provider }),
  },

  browserSessions: {
    list: (): Promise<{ sessions: BrowserSessionDto[]; open: string[] }> =>
      request('/browser-sessions'),
    open: (
      provider: string,
      url?: string,
    ): Promise<{ provider: string; url: string; loggedIn: boolean }> =>
      post(`/browser-sessions/${provider}/open`, url ? { url } : {}),
    remove: (provider: string): Promise<{ ok: true }> => del(`/browser-sessions/${provider}`),
  },

  observability: {
    logs: (query: Partial<LogQuery>): Promise<Paginated<LogDto>> =>
      request(`/logs${buildQuery(query as Record<string, QueryValue>)}`),
    logScopes: (): Promise<{ scopes: string[] }> => request('/logs/scopes'),
    llmCalls: (query: {
      page?: number;
      pageSize?: number;
      task?: string;
      success?: boolean;
    }): Promise<Paginated<LlmCallDto>> => request(`/llm-calls${buildQuery(query)}`),
    llmCall: (
      id: number,
    ): Promise<LlmCallDto & { systemPrompt: string | null; userPrompt: string | null; response: string | null }> =>
      request(`/llm-calls/${id}`),
    prompts: (): Promise<{
      templates: PromptTemplateDto[];
      defaults: { task: string; system: string; user: string }[];
    }> => request('/prompts'),
    savePrompt: (body: {
      task: string;
      name: string;
      system: string;
      user: string;
      isActive?: boolean;
    }): Promise<PromptTemplateDto> => post('/prompts', body),
    activatePrompt: (id: number): Promise<{ ok: true }> => post(`/prompts/${id}/activate`),
    deletePrompt: (id: number): Promise<{ ok: true }> => del(`/prompts/${id}`),
    screenshots: (
      limit = 24,
    ): Promise<{
      screenshots: {
        id: number;
        applicationId: number | null;
        jobId: number | null;
        step: string | null;
        createdAt: string;
      }[];
    }> => request(`/artifacts/screenshots${buildQuery({ limit })}`),
    artifactUrl: (id: number): string => withToken(`${BASE}/artifacts/${id}/file`),
  },

  analytics: {
    overview: (): Promise<OverviewStats> => request('/analytics/overview'),
    full: (days = 30): Promise<AnalyticsPayload> => request(`/analytics${buildQuery({ days })}`),
  },

  backups: {
    list: (): Promise<{ backups: { name: string; bytes: number; createdAt: string }[] }> =>
      request('/backups'),
    create: (): Promise<{ path: string; bytes: number; removed: number }> => post('/backups'),
  },

  scheduler: {
    run: (name: string): Promise<{ ok: true }> => post(`/scheduler/${name}/run`),
  },

  /**
   * Pasted provider sessions. Only metadata ever crosses this boundary - the
   * secret is write-only and stays encrypted on the host.
   */
  credentials: {
    list: (): Promise<{ credentials: ProviderCredentialDto[] }> => request('/credentials'),
    save: (body: SaveCredentialInput): Promise<SaveCredentialResult> =>
      post('/credentials', body),
    remove: (provider: string): Promise<{ ok: true }> =>
      del(`/credentials/${encodeURIComponent(provider)}`),
    verify: (provider: string): Promise<CredentialVerifyResult> =>
      post(`/credentials/${encodeURIComponent(provider)}/verify`),
  },

  notifications: {
    list: (query: {
      page?: number;
      pageSize?: number;
      unreadOnly?: boolean;
      kind?: NotificationKind;
    } = {}): Promise<Paginated<NotificationDto>> =>
      request(`/notifications${buildQuery(query)}`),
    unreadCount: (): Promise<{ count: number }> => request('/notifications/unread-count'),
    markRead: (id: number): Promise<{ ok: true }> => post(`/notifications/${id}/read`),
    markAllRead: (): Promise<{ updated: number }> => post('/notifications/read-all'),
    remove: (id: number): Promise<{ ok: true }> => del(`/notifications/${id}`),
  },

  sync: {
    status: (): Promise<SyncStatus> => request('/sync/status'),
    flush: (): Promise<SyncFlushResult> => post('/sync/flush'),
    full: (): Promise<SyncFullResult> => post('/sync/full'),
    test: (): Promise<SyncTestResult> => post('/sync/test'),
    /** Pairing is one-way: the host stores the Supabase user id shown on the phone. */
    pair: (userId: string): Promise<SyncStatus> => post('/sync/pair', { userId }),
  },
};
