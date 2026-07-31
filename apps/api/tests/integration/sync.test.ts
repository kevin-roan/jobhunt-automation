import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { llmCalls, notifications, type NotificationRow } from '../../src/db/schema.js';
import { encryptSecret } from '../../src/core/crypto.js';
import { EventBus } from '../../src/core/events.js';
import type { LogContext, Logger } from '../../src/core/logger.js';
import { ApplicationRepository } from '../../src/repositories/application.repository.js';
import { CredentialRepository } from '../../src/repositories/credential.repository.js';
import { JobRepository } from '../../src/repositories/job.repository.js';
import { NotificationRepository } from '../../src/repositories/notification.repository.js';
import { QueueRepository } from '../../src/repositories/queue.repository.js';
import {
  CoverLetterRepository,
  ResumeRepository,
} from '../../src/repositories/resume.repository.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import { SyncRepository, SYNC_STATE_KEYS } from '../../src/repositories/sync.repository.js';
import { SettingsService } from '../../src/services/settings.service.js';
import {
  SupabaseRestClient,
  SyncService,
  type NotificationReader,
} from '../../src/services/sync/sync.service.js';
import {
  CommandRepository,
  CommandService,
  type SyncCommandChannel,
} from '../../src/services/sync/command.service.js';

const SUPABASE_URL = 'https://mirror.example.supabase.co';
const SUPABASE_SECRET = 'sb-secret-key-abcdef0123456789';
const USER_ID = 'a0b1c2d3-user';

/** Silent Logger; these tests assert on the wire, not on log lines. */
function createTestLogger(): Logger {
  const noop = (_message: string, _context?: LogContext): void => undefined;
  const logger: Logger = {
    scope: 'test',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

/**
 * The sync service reads notification rows, while NotificationRepository hands
 * out DTOs; this adapter supplies the row-shaped reader it declares.
 */
function createNotificationReader(db: Db): NotificationReader {
  return {
    byId: (id: number): NotificationRow | undefined =>
      db.select().from(notifications).where(eq(notifications.id, id)).get(),
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

interface FetchStub {
  calls: FetchCall[];
  /** Rows a GET on the given table answers with. */
  rows: Map<string, unknown[]>;
  /** Tables whose requests answer 500 instead of succeeding. */
  failing: Set<string>;
  callsTo(table: string): FetchCall[];
  bodiesTo(table: string): Record<string, unknown>[];
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function tableOf(url: string): string {
  const match = /\/rest\/v1\/([^?/]+)/.exec(url);
  return match?.[1] ?? '';
}

/**
 * Stands in for Supabase PostgREST. Every request is recorded verbatim so the
 * privacy assertion can inspect exactly what would have left the host.
 */
function installFetchStub(): FetchStub {
  const stub: FetchStub = {
    calls: [],
    rows: new Map<string, unknown[]>(),
    failing: new Set<string>(),
    callsTo: (table) => stub.calls.filter((call) => tableOf(call.url) === table),
    bodiesTo: (table) =>
      stub
        .callsTo(table)
        .filter((call) => call.body.length > 0)
        .flatMap((call) => JSON.parse(call.body) as Record<string, unknown>[]),
  };

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    stub.calls.push({ url, method, body });

    const table = tableOf(url);
    if (stub.failing.has(table)) {
      return new Response('upstream exploded', { status: 500 });
    }
    if (method === 'GET') {
      return new Response(JSON.stringify(stub.rows.get(table) ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  };

  vi.stubGlobal('fetch', handler);
  return stub;
}

interface Harness {
  handle: DbHandle;
  db: Db;
  key: Buffer;
  events: EventBus;
  settings: SettingsService;
  jobs: JobRepository;
  applications: ApplicationRepository;
  queue: QueueRepository;
  credentials: CredentialRepository;
  notifications: NotificationRepository;
  resumes: ResumeRepository;
  coverLetters: CoverLetterRepository;
  sync: SyncRepository;
  service: SyncService;
  commands: CommandRepository;
  commandService: CommandService;
  channel: SyncCommandChannel;
  fullResyncCalls: number[];
}

let root = '';
const openHandles: DbHandle[] = [];
let harnessCounter = 0;

function createHarness(configure = true): Harness {
  harnessCounter += 1;
  const handle = createDb(path.join(root, `sync-${harnessCounter}.sqlite`));
  openHandles.push(handle);
  runMigrations(handle.sqlite);

  const db = handle.db;
  const key = randomBytes(32);
  const events = new EventBus();
  const logger = createTestLogger();

  const settings = new SettingsService(new SettingsRepository(db), key, logger, events);
  settings.bootstrap();
  if (configure) {
    settings.update({
      sync: {
        enabled: true,
        url: SUPABASE_URL,
        secretKey: SUPABASE_SECRET,
        userId: USER_ID,
      },
    });
  }

  const jobs = new JobRepository(db);
  const applications = new ApplicationRepository(db);
  const queue = new QueueRepository(db);
  const sync = new SyncRepository(db);
  const commands = new CommandRepository(db);
  const notificationRepo = new NotificationRepository(db);

  const service = new SyncService(
    sync,
    jobs,
    applications,
    createNotificationReader(db),
    queue,
    settings,
    logger,
    events,
  );

  const client = new SupabaseRestClient({
    url: SUPABASE_URL,
    secretKey: SUPABASE_SECRET,
    timeoutMs: 5000,
  });
  const channel: SyncCommandChannel = {
    isConfigured: () => service.isConfigured(),
    select: <T>(table: string, query: Record<string, string>): Promise<T[]> =>
      client.select<T>(table, query),
    update: (table, match, values) => client.update(table, match, values),
  };

  const fullResyncCalls: number[] = [];
  const commandService = new CommandService(
    channel,
    commands,
    queue,
    jobs,
    applications,
    settings,
    logger,
    events,
    {
      onFullResync: async () => {
        fullResyncCalls.push(Date.now());
        await service.fullResync();
      },
    },
  );

  return {
    handle,
    db,
    key,
    events,
    settings,
    jobs,
    applications,
    queue,
    credentials: new CredentialRepository(db),
    notifications: notificationRepo,
    resumes: new ResumeRepository(db),
    coverLetters: new CoverLetterRepository(db),
    sync,
    service,
    commands,
    commandService,
    channel,
    fullResyncCalls,
  };
}

function seedScoredJob(
  harness: Harness,
  overrides: { title?: string; company?: string; description?: string; slug?: string } = {},
): number {
  const slug = overrides.slug ?? `job-${harnessCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const { jobId } = harness.jobs.upsert({
    source: 'greenhouse',
    title: overrides.title ?? 'Staff Platform Engineer',
    company: overrides.company ?? 'Globex',
    location: 'Remote - US',
    description: overrides.description ?? 'We are hiring.',
    salaryMin: 180000,
    salaryMax: 220000,
    salaryCurrency: 'USD',
    applicationUrl: `https://boards.example.com/jobs/${slug}`,
    postedAt: '2026-07-20T00:00:00.000Z',
  });
  harness.jobs.recordScore({
    jobId,
    resumeId: null,
    score: 91,
    confidence: 0.8,
    recommendation: 'apply',
    matchedSkills: ['typescript'],
    missingSkills: [],
    redFlags: [],
    reasoning: 'Strong overlap.',
    interviewProbability: 0.4,
    model: 'llama3.1:8b',
  });
  return jobId;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-sync-test-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Cleanup must never fail the run.
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('SyncRepository outbox', () => {
  it('collapses repeated changes to the same entity into one pending row', () => {
    const harness = createHarness();

    harness.sync.enqueue('job', 42);
    harness.sync.enqueue('job', 42);
    harness.sync.enqueue('job', 42);
    harness.sync.enqueue('application', 42);

    expect(harness.sync.pendingCount()).toBe(2);
    const claimed = harness.sync.claim(10);
    expect(claimed.map((row) => row.entity).sort()).toEqual(['application', 'job']);
    expect(claimed.every((row) => row.operation === 'upsert')).toBe(true);
    expect(claimed.every((row) => row.attempts === 0)).toBe(true);
  });

  it('claims the oldest rows first', () => {
    const harness = createHarness();

    // createdAt comes from the clock, so freeze it to make the order explicit.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
      harness.sync.enqueue('job', 1);
      vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
      harness.sync.enqueue('job', 2);
      vi.setSystemTime(new Date('2026-07-31T10:00:00.000Z'));
      harness.sync.enqueue('job', 3);
    } finally {
      vi.useRealTimers();
    }

    expect(harness.sync.claim(10).map((row) => row.entityId)).toEqual([1, 2, 3]);
    expect(harness.sync.claim(2).map((row) => row.entityId)).toEqual([1, 2]);

    // Re-enqueueing an entity refreshes updatedAt but keeps its place in line.
    harness.sync.enqueue('job', 1);
    expect(harness.sync.claim(1).map((row) => row.entityId)).toEqual([1]);
  });

  it('increments attempts and records the error on fail', () => {
    const harness = createHarness();
    harness.sync.enqueue('job', 7);
    const id = harness.sync.claim(1)[0]?.id ?? -1;
    expect(id).toBeGreaterThan(0);

    harness.sync.fail(id, 'supabase 500: upstream exploded');
    harness.sync.fail(id, 'supabase 500: upstream exploded again');

    const row = harness.sync.claim(1)[0];
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe('supabase 500: upstream exploded again');
    // A failed row stays claimable: retries are the whole point of the outbox.
    expect(harness.sync.pendingCount()).toBe(1);
  });

  it('clears rows on remove and drops exhausted rows on purge', () => {
    const harness = createHarness();
    harness.sync.enqueue('job', 1);
    harness.sync.enqueue('job', 2);
    harness.sync.enqueue('job', 3);

    const rows = harness.sync.claim(10);
    const [first, second, third] = rows;
    expect(rows).toHaveLength(3);

    harness.sync.remove([]);
    expect(harness.sync.pendingCount()).toBe(3);

    harness.sync.remove([first?.id ?? -1, second?.id ?? -1]);
    expect(harness.sync.pendingCount()).toBe(1);
    expect(harness.sync.claim(10)[0]?.entityId).toBe(3);

    for (let attempt = 0; attempt < 8; attempt += 1) harness.sync.fail(third?.id ?? -1, 'boom');
    expect(harness.sync.purgeExhausted(8)).toBe(1);
    expect(harness.sync.pendingCount()).toBe(0);
  });

  it('round-trips sync state values', () => {
    const harness = createHarness();
    expect(harness.sync.getState(SYNC_STATE_KEYS.lastSyncAt)).toBeUndefined();

    harness.sync.setState(SYNC_STATE_KEYS.lastSyncAt, '2026-07-31T00:00:00.000Z');
    harness.sync.setState(SYNC_STATE_KEYS.lastSyncAt, '2026-07-31T01:00:00.000Z');

    expect(harness.sync.getState(SYNC_STATE_KEYS.lastSyncAt)).toBe('2026-07-31T01:00:00.000Z');
  });
});

describe('SyncService.flush', () => {
  it('maps a local job onto the allowlisted row shape and upserts it', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    const jobId = seedScoredJob(harness, { slug: 'mapping' });
    harness.service.enqueueJob(jobId);

    const result = await harness.service.flush();

    expect(result).toEqual({ pushed: 1, failed: 0 });
    const posts = stub.callsTo('jobs');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe('POST');
    expect(posts[0]?.url).toBe(
      `${SUPABASE_URL}/rest/v1/jobs?on_conflict=${encodeURIComponent('id,user_id')}`,
    );

    const job = harness.jobs.byId(jobId);
    expect(stub.bodiesTo('jobs')).toEqual([
      {
        id: jobId,
        user_id: USER_ID,
        title: 'Staff Platform Engineer',
        company: 'Globex',
        location: 'Remote - US',
        source: 'greenhouse',
        remote_type: job?.remoteType,
        employment_type: job?.employmentType,
        experience_level: job?.experienceLevel,
        salary_min: 180000,
        salary_max: 220000,
        salary_currency: 'USD',
        score: 91,
        recommendation: 'apply',
        status: 'scored',
        application_url: 'https://boards.example.com/jobs/mapping',
        posted_at: '2026-07-20T00:00:00.000Z',
        collected_at: job?.collectedAt,
        updated_at: job?.updatedAt,
      },
    ]);

    // A pushed row leaves the outbox, and the state row records the success.
    expect(harness.sync.pendingCount()).toBe(0);
    expect(harness.sync.getState(SYNC_STATE_KEYS.reachable)).toBe('true');
    expect(harness.sync.getState(SYNC_STATE_KEYS.lastSyncError)).toBe('');
  });

  it('drops jobs scored below the configured threshold instead of uploading them', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    harness.settings.update({ sync: { minScoreToSync: 95 } });
    const jobId = seedScoredJob(harness, { slug: 'below-threshold' });
    harness.service.enqueueJob(jobId);

    expect(await harness.service.flush()).toEqual({ pushed: 0, failed: 0 });
    expect(stub.callsTo('jobs')).toHaveLength(0);
    expect(harness.sync.pendingCount()).toBe(0);
  });

  it('is a safe no-op when sync is disabled', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    const jobId = seedScoredJob(harness, { slug: 'disabled' });
    harness.sync.enqueue('job', jobId);

    harness.settings.update({ sync: { enabled: false } });

    expect(await harness.service.flush()).toEqual({ pushed: 0, failed: 0 });
    await harness.service.pushQueueStats();

    expect(stub.calls).toHaveLength(0);
    // The work is kept, not discarded: enabling sync later must still ship it.
    expect(harness.sync.pendingCount()).toBe(1);
  });

  it('is a safe no-op when sync is unconfigured', async () => {
    const stub = installFetchStub();
    const harness = createHarness(false);
    const jobId = seedScoredJob(harness, { slug: 'unconfigured' });
    harness.sync.enqueue('job', jobId);

    harness.settings.update({ sync: { enabled: true, url: '', secretKey: '', userId: '' } });

    expect(harness.service.isConfigured()).toBe(false);
    expect(await harness.service.flush()).toEqual({ pushed: 0, failed: 0 });
    expect(stub.calls).toHaveLength(0);
    expect(harness.sync.pendingCount()).toBe(1);

    const status = await harness.service.status();
    expect(status).toMatchObject({ configured: false, reachable: false, enabled: true });
    expect(stub.calls).toHaveLength(0);
  });

  it('keeps the outbox rows for retry when the upsert fails', async () => {
    const stub = installFetchStub();
    stub.failing.add('jobs');
    const harness = createHarness();
    const jobId = seedScoredJob(harness, { slug: 'retry' });
    harness.service.enqueueJob(jobId);

    expect(await harness.service.flush()).toEqual({ pushed: 0, failed: 1 });

    const pending = harness.sync.claim(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.entityId).toBe(jobId);
    expect(pending[0]?.attempts).toBe(1);
    expect(pending[0]?.lastError).toContain('500');
    expect(harness.sync.getState(SYNC_STATE_KEYS.reachable)).toBe('false');
    expect(harness.sync.getState(SYNC_STATE_KEYS.lastSyncError)).toContain('500');

    // The retry succeeds and clears the row.
    stub.failing.delete('jobs');
    expect(await harness.service.flush()).toEqual({ pushed: 1, failed: 0 });
    expect(harness.sync.pendingCount()).toBe(0);
  });
});

/**
 * The privacy boundary, expressed as a test. Everything secret gets a unique
 * sentinel string; after a flush, not one of them may appear anywhere in the
 * captured traffic. The payload key sets are asserted exactly, so a field added
 * carelessly to a synced row fails here even if it carries no sentinel.
 */
describe('SyncService privacy boundary', () => {
  const RESUME_MARKDOWN_SENTINEL = 'SENTINEL_RESUME_MARKDOWN_9f21';
  const COVER_LETTER_SENTINEL = 'SENTINEL_COVER_LETTER_BODY_4c88';
  const DESCRIPTION_SENTINEL = 'SENTINEL_JOB_DESCRIPTION_71ad';
  const EMAIL_SENTINEL = 'sentinel.candidate.3b1f@example.com';
  const PHONE_SENTINEL = '+1-555-0100-SENTINEL-8d4c';
  const ADDRESS_SENTINEL = 'SENTINEL_STREET_ADDRESS_5e70';
  const POSTAL_SENTINEL = 'SENTINEL-POSTAL-2b09';
  const COOKIE_SENTINEL = 'SENTINEL_COOKIE_VALUE_a417';
  const LLM_PROMPT_SENTINEL = 'SENTINEL_LLM_PROMPT_c630';
  const LLM_RESPONSE_SENTINEL = 'SENTINEL_LLM_RESPONSE_d902';
  const LLM_API_KEY_SENTINEL = 'sk-SENTINEL-LLM-API-KEY-e153';
  const SCREENSHOT_SENTINEL = 'SENTINEL_SCREENSHOT_PATH_f284';

  const JOB_KEYS = [
    'application_url',
    'collected_at',
    'company',
    'employment_type',
    'experience_level',
    'id',
    'location',
    'posted_at',
    'recommendation',
    'remote_type',
    'salary_currency',
    'salary_max',
    'salary_min',
    'score',
    'source',
    'status',
    'title',
    'updated_at',
    'user_id',
  ];
  const APPLICATION_KEYS = [
    'attempts',
    'company',
    'created_at',
    'current_step',
    'dry_run',
    'error',
    'id',
    'job_id',
    'job_title',
    'max_attempts',
    'provider',
    'started_at',
    'status',
    'submitted_at',
    'updated_at',
    'user_id',
  ];
  const NOTIFICATION_KEYS = [
    'actionable',
    'body',
    'created_at',
    'entity_id',
    'entity_type',
    'id',
    'kind',
    'level',
    'read',
    'title',
    'user_id',
  ];

  it('puts operational metadata on the wire and nothing else', async () => {
    const stub = installFetchStub();
    const harness = createHarness();

    harness.settings.update({
      llm: { apiKey: LLM_API_KEY_SENTINEL },
      profile: {
        fullName: 'Ada Lovelace',
        email: EMAIL_SENTINEL,
        phone: PHONE_SENTINEL,
        city: ADDRESS_SENTINEL,
        postalCode: POSTAL_SENTINEL,
      },
    });

    const jobId = seedScoredJob(harness, {
      slug: 'privacy',
      title: 'Principal Backend Engineer',
      company: 'Initech',
      description: `Responsibilities: ${DESCRIPTION_SENTINEL}`,
    });

    // A resume, a cover letter, a stored credential, an LLM call and an
    // artifact: every category of local-only data at once.
    const resume = harness.resumes.create({
      name: 'Backend',
      markdown: `# Ada Lovelace\n${RESUME_MARKDOWN_SENTINEL}\n${EMAIL_SENTINEL}`,
      isBase: true,
      isDefault: true,
    });
    harness.coverLetters.create({
      jobId,
      resumeId: resume.id,
      subject: 'Application for Principal Backend Engineer',
      body: `Dear hiring manager, ${COVER_LETTER_SENTINEL}`,
    });

    harness.db
      .insert(llmCalls)
      .values({
        task: 'score_job',
        provider: 'ollama',
        model: 'llama3.1:8b',
        systemPrompt: `You are a recruiter. ${LLM_PROMPT_SENTINEL}`,
        userPrompt: `Candidate email ${EMAIL_SENTINEL}. ${LLM_PROMPT_SENTINEL}`,
        response: LLM_RESPONSE_SENTINEL,
        success: true,
        jobId,
      })
      .run();

    harness.credentials.upsert({
      provider: 'linkedin',
      kind: 'cookies',
      value: encryptSecret(
        JSON.stringify([{ name: 'li_at', value: COOKIE_SENTINEL, domain: '.linkedin.com' }]),
        harness.key,
      ),
      status: 'valid',
      cookieCount: 1,
      domains: ['.linkedin.com'],
      expiresAt: null,
    });

    const application = harness.applications.ensure({
      jobId,
      provider: 'greenhouse',
      resumeId: null,
      maxAttempts: 3,
      dryRun: false,
    });
    harness.applications.update(application.id, {
      status: 'failed',
      currentStep: 'upload_resume',
      error: 'file input rejected the upload',
      startedAt: '2026-07-31T09:00:00.000Z',
    });
    harness.applications.addArtifact({
      applicationId: application.id,
      kind: 'screenshot',
      path: `/home/user/data/artifacts/${SCREENSHOT_SENTINEL}.png`,
      step: 'upload_resume',
    });

    const notification = harness.notifications.create({
      kind: 'application.failed',
      level: 'error',
      title: 'Application failed at Initech',
      body: 'The resume upload step failed.',
      entityType: 'application',
      entityId: application.id,
      actionable: true,
    });

    harness.service.enqueueJob(jobId);
    harness.service.enqueueApplication(application.id);
    harness.service.enqueueNotification(notification.id);

    const result = await harness.service.flush();
    await harness.service.pushQueueStats();

    expect(result).toEqual({ pushed: 3, failed: 0 });
    expect(stub.calls.length).toBeGreaterThan(0);

    // Everything that would have crossed the network, URLs included.
    const wire = stub.calls.map((call) => `${call.url}\n${call.body}`).join('\n');

    const forbidden: [string, string][] = [
      ['resume markdown', RESUME_MARKDOWN_SENTINEL],
      ['cover letter body', COVER_LETTER_SENTINEL],
      ['job description', DESCRIPTION_SENTINEL],
      ['profile email', EMAIL_SENTINEL],
      ['profile phone', PHONE_SENTINEL],
      ['profile address', ADDRESS_SENTINEL],
      ['profile postal code', POSTAL_SENTINEL],
      ['provider cookie value', COOKIE_SENTINEL],
      ['llm prompt', LLM_PROMPT_SENTINEL],
      ['llm response', LLM_RESPONSE_SENTINEL],
      ['llm api key', LLM_API_KEY_SENTINEL],
      ['screenshot path', SCREENSHOT_SENTINEL],
      ['encryption key', harness.key.toString('hex')],
      ['encryption key (base64)', harness.key.toString('base64')],
    ];
    for (const [label, sentinel] of forbidden) {
      expect(`${label}: ${wire.includes(sentinel)}`).toBe(`${label}: false`);
    }

    // Positively: the operational metadata the phone needs did go out.
    expect(wire).toContain('Principal Backend Engineer');
    expect(wire).toContain('Initech');
    expect(wire).toContain('scored');
    expect(wire).toContain('failed');
    expect(wire).toContain('Application failed at Initech');

    // And the payloads carry exactly the allowlisted columns, no more.
    const jobRows = stub.bodiesTo('jobs');
    const applicationRows = stub.bodiesTo('applications');
    const notificationRows = stub.bodiesTo('notifications');
    expect(jobRows).toHaveLength(1);
    expect(applicationRows).toHaveLength(1);
    expect(notificationRows).toHaveLength(1);
    expect(Object.keys(jobRows[0] ?? {}).sort()).toEqual(JOB_KEYS);
    expect(Object.keys(applicationRows[0] ?? {}).sort()).toEqual(APPLICATION_KEYS);
    expect(Object.keys(notificationRows[0] ?? {}).sort()).toEqual(NOTIFICATION_KEYS);
    expect(jobRows[0]).toMatchObject({ title: 'Principal Backend Engineer', company: 'Initech' });
    expect(applicationRows[0]).toMatchObject({ status: 'failed', company: 'Initech' });

    // Queue stats are counters only.
    const queueRows = stub.bodiesTo('queue_stats');
    expect(queueRows).toHaveLength(1);
    expect(Object.keys(queueRows[0] ?? {}).sort()).toEqual([
      'active',
      'cancelled',
      'completed',
      'delayed',
      'failed',
      'pending',
      'updated_at',
      'user_id',
      'worker_running',
    ]);
  });
});

describe('CommandService.poll', () => {
  function pendingCommand(id: string, kind: string, payload: unknown): Record<string, unknown> {
    return { id, kind, payload, status: 'pending', created_at: '2026-07-31T08:00:00.000Z' };
  }

  it('claims a pending command, executes it and writes the result back', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    stub.rows.set('commands', [pendingCommand('cmd-pause', 'queue.pause', { paused: true })]);

    const summary = await harness.commandService.poll();

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(harness.settings.get().queue.paused).toBe(true);
    expect(harness.commands.hasHandled('cmd-pause')).toBe(true);

    const patches = stub.callsTo('commands').filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    const statuses = patches.map((call) => (JSON.parse(call.body) as { status: string }).status);
    expect(statuses).toEqual(['claimed', 'succeeded']);
    expect(patches[1]?.url).toContain(`id=${encodeURIComponent('eq.cmd-pause')}`);
  });

  it('executes a command exactly once across two polls of the same remote id', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    const jobId = seedScoredJob(harness, { slug: 'command-archive' });
    stub.rows.set('commands', [pendingCommand('cmd-archive', 'job.archive', { jobId })]);

    const first = await harness.commandService.poll();
    expect(first).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(harness.jobs.byId(jobId)?.archived).toBe(true);

    // The remote row is still pending (a lost write-back, say); the local
    // ledger must be what stops a second execution.
    harness.jobs.setArchived(jobId, false);
    const second = await harness.commandService.poll();

    expect(second).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(harness.jobs.byId(jobId)?.archived).toBe(false);
    expect(
      stub.callsTo('commands').filter((call) => call.method === 'PATCH'),
    ).toHaveLength(2);
  });

  it('marks an invalid payload failed without throwing', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    stub.rows.set('commands', [
      pendingCommand('cmd-bad-payload', 'application.retry', { applicationId: 'not-a-number' }),
      pendingCommand('cmd-unknown-kind', 'server.shutdown', {}),
      pendingCommand('cmd-missing-entity', 'job.score', { jobId: 987654 }),
    ]);

    const summary = await harness.commandService.poll();

    expect(summary).toEqual({ claimed: 2, succeeded: 0, failed: 3 });
    const patches = stub
      .callsTo('commands')
      .filter((call) => call.method === 'PATCH')
      .map((call) => JSON.parse(call.body) as { status: string; result: string | null });
    expect(patches.filter((patch) => patch.status === 'failed')).toHaveLength(3);
    expect(
      patches.some((patch) => (patch.result ?? '').includes('invalid payload')),
    ).toBe(true);
    expect(
      patches.some((patch) => (patch.result ?? '').includes('unsupported command kind')),
    ).toBe(true);

    // An unsupported kind is never written to the local ledger, so it can be
    // re-answered if the phone ever learns to send a kind this host knows.
    expect(harness.commands.hasHandled('cmd-unknown-kind')).toBe(false);
    expect(harness.commands.hasHandled('cmd-bad-payload')).toBe(true);
  });

  it('does nothing when sync is disabled and survives an unreachable mirror', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    stub.rows.set('commands', [pendingCommand('cmd-quiet', 'queue.retry_failed', {})]);
    harness.settings.update({ sync: { enabled: false } });

    expect(await harness.commandService.poll()).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(stub.calls).toHaveLength(0);

    harness.settings.update({ sync: { enabled: true } });
    stub.failing.add('commands');
    expect(await harness.commandService.poll()).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(harness.commands.hasHandled('cmd-quiet')).toBe(false);
  });

  it('runs a full resync on request', async () => {
    const stub = installFetchStub();
    const harness = createHarness();
    // Distinct titles: the content hash would otherwise fold these into one job.
    seedScoredJob(harness, { slug: 'resync-a', title: 'Backend Engineer A' });
    seedScoredJob(harness, { slug: 'resync-b', title: 'Backend Engineer B' });
    stub.rows.set('commands', [pendingCommand('cmd-full', 'sync.full', {})]);

    const summary = await harness.commandService.poll();

    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(harness.fullResyncCalls).toHaveLength(1);
    expect(stub.bodiesTo('jobs')).toHaveLength(2);
  });
});
