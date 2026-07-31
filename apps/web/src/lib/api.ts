import type {
  AnalyticsPayload,
  AnswerBankDto,
  ApplicationDto,
  ApplicationEventDto,
  ArtifactDto,
  BrowserSessionDto,
  CollectorDto,
  CollectorRunDto,
  CoverLetterDto,
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
  PromptTemplateDto,
  ProviderCredentialDto,
  QueueJobDto,
  ResumeDto,
  SaveCredentialInput,
  Settings,
  SettingsPatch,
  SyncStatus,
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
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
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

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

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
  valid: boolean;
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

  resumes: {
    list: (includeGenerated = true): Promise<{ resumes: ResumeDto[] }> =>
      request(`/resumes${buildQuery({ includeGenerated })}`),
    get: (id: number): Promise<ResumeDto> => request(`/resumes/${id}`),
    create: (body: {
      name: string;
      markdown: string;
      targetRole?: string;
      isBase?: boolean;
      isDefault?: boolean;
    }): Promise<ResumeDto> => post('/resumes', body),
    update: (
      id: number,
      body: { name?: string; markdown?: string; targetRole?: string; isDefault?: boolean },
    ): Promise<ResumeDto> => patch(`/resumes/${id}`, body),
    remove: (id: number): Promise<{ ok: true }> => del(`/resumes/${id}`),
    tailor: (
      id: number,
      body: { jobId: number; force?: boolean; immediate?: boolean },
    ): Promise<{ resume: ResumeDto | null; queueJobId: number | null }> =>
      post(`/resumes/${id}/tailor`, body),
    downloadUrl: (id: number, format: 'pdf' | 'docx' | 'md'): string =>
      `${BASE}/resumes/${id}/download?format=${format}`,
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
    artifactUrl: (id: number): string => `${BASE}/artifacts/${id}/file`,
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

export const eventsUrl = `${BASE}/events`;
