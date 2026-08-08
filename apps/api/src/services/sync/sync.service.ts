/**
 * Supabase mirror (outbox based).
 *
 * THE ONLY FIELDS THAT EVER CROSS THE NETWORK ARE BUILT BY HAND BELOW:
 *   jobs         id, user_id, title, company, location, source, remote_type,
 *                employment_type, experience_level, salary_min, salary_max,
 *                salary_currency, score, recommendation, status,
 *                application_url, posted_at, collected_at, updated_at
 *   applications id, user_id, job_id, job_title, company, provider, status,
 *                current_step, attempts, max_attempts, error, dry_run,
 *                started_at, submitted_at, created_at, updated_at
 *   notifications id, user_id, kind, level, title, body, entity_type,
 *                entity_id, read, actionable, created_at
 *   queue_stats  user_id, pending, active, completed, failed, delayed,
 *                cancelled, worker_running, updated_at
 *
 * NOTHING ELSE. Resume markdown and files, cover letter text, job descriptions,
 * candidate profile PII (email, phone, street address, postal code), provider
 * cookies and tokens, LLM prompts and responses, screenshots, HTML snapshots,
 * the encryption key and the LLM api key stay on the host. Rows are assembled
 * field by field from the allowlists above - a whole database row is never
 * spread into a payload, so a new local column can never leak by accident.
 *
 * Two of those fields (an application's error, a notification's body) are free
 * text authored elsewhere in the pipeline rather than composed here, so they are
 * scrubbed of known secrets and of any email address before they go out, and
 * every text field is capped at the same length as the CHECK constraint on the
 * matching Supabase column.
 */
import type { SyncStatus, SyncedApplicationRow, SyncedJobRow } from '@deedy/shared';
import type { EventBus } from '../../core/events.js';
import type { Logger } from '../../core/logger.js';
import { toErrorMessage } from '../../core/errors.js';
import { installRedactionSource, Redactor } from '../../core/redact.js';
import { nowIso, truncate } from '../../core/utils.js';
import type { NotificationRow } from '../../db/schema.js';
import type { ApplicationRepository } from '../../repositories/application.repository.js';
import type { JobRepository } from '../../repositories/job.repository.js';
import type { QueueRepository } from '../../repositories/queue.repository.js';
import {
  SYNC_STATE_KEYS,
  type SyncEntity,
  type SyncRepository,
} from '../../repositories/sync.repository.js';
import type { SettingsService } from '../settings.service.js';

/** Structural view of the notification repository; only reads are needed here. */
export interface NotificationReader {
  byId(id: number): NotificationRow | undefined;
}

export interface SupabaseRestConfig {
  url: string;
  secretKey: string;
  timeoutMs: number;
}

interface SyncedNotificationRow {
  id: number;
  user_id: string;
  kind: string;
  level: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: number | null;
  read: boolean;
  actionable: boolean;
  created_at: string;
}

interface SyncedQueueStatsRow {
  user_id: string;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  cancelled: number;
  worker_running: boolean;
  updated_at: string;
}

/**
 * Minimal PostgREST client. The official SDK is not a dependency of this
 * workspace and would pull a browser-oriented bundle in for four HTTP verbs.
 */
export class SupabaseRestClient {
  constructor(private readonly config: SupabaseRestConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.secretKey,
      authorization: `Bearer ${this.config.secretKey}`,
      'content-type': 'application/json',
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.url.replace(/\/+$/, '')}/rest/v1/${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`supabase ${response.status}: ${truncate(body, 300)}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async upsert(table: string, rows: readonly unknown[], onConflict: string): Promise<void> {
    if (rows.length === 0) return;
    await this.request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: this.headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows),
    });
  }

  async select<T>(table: string, query: Record<string, string>): Promise<T[]> {
    const params = new URLSearchParams(query).toString();
    const response = await this.request(`${table}${params ? `?${params}` : ''}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return (await response.json()) as T[];
  }

  async update(
    table: string,
    match: Record<string, string>,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const params = new URLSearchParams(match).toString();
    await this.request(`${table}?${params}`, {
      method: 'PATCH',
      headers: this.headers({ prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
  }

  /** Exact row count via the Content-Range header, without downloading rows. */
  async count(table: string, query: Record<string, string>): Promise<number> {
    const params = new URLSearchParams({ ...query, select: 'id' }).toString();
    const response = await this.request(`${table}?${params}`, {
      method: 'HEAD',
      headers: this.headers({ prefer: 'count=exact', range: '0-0' }),
    });
    const range = response.headers.get('content-range');
    const total = range?.split('/')[1];
    const parsed = Number(total);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

const BATCH_SIZE = 200;
const MAX_OUTBOX_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Ceilings for every free-text column, mirrored one-for-one by the CHECK
 * constraints in supabase/schema.sql. Two independent limits means a bug on
 * either side is caught by the other rather than turning a metadata column into
 * somewhere a document could be stored.
 */
const LIMITS = {
  jobTitle: 300,
  company: 200,
  location: 200,
  applicationUrl: 2000,
  applicationError: 500,
  notificationTitle: 200,
  notificationBody: 1000,
} as const;

export interface FlushResult {
  pushed: number;
  failed: number;
}

export class SyncService {
  constructor(
    private readonly sync: SyncRepository,
    private readonly jobs: JobRepository,
    private readonly applications: ApplicationRepository,
    private readonly notifications: NotificationReader,
    private readonly queue: QueueRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {
    this.redactor = new Redactor(settingsService);
    // The composition root builds the logger before any service exists, so this
    // is the earliest point at which the process-wide scrubber can be told the
    // candidate's actual values. Until now it has been running on the generic
    // email and phone patterns alone.
    installRedactionSource(settingsService);
  }

  /**
   * Free text authored deep in the pipeline can quote whatever it was working
   * with at the time: a Playwright failure names the element it was filling, an
   * upstream error echoes the request that produced it. Truncation alone is no
   * defence - the leak would be in the first few characters, so every value the
   * host knows to be personal is stripped before the string reaches the wire.
   */
  private readonly redactor: Redactor;

  /** Built per call so a settings change takes effect without a restart. */
  private client(): SupabaseRestClient | null {
    if (!this.settingsService.get().sync.enabled) return null;
    return this.restClient();
  }

  /**
   * Ignores the `enabled` flag: the settings screen must be able to probe a
   * project before the user commits to turning the mirror on.
   */
  private restClient(): SupabaseRestClient | null {
    const sync = this.settingsService.get().sync;
    if (!this.isConfigured()) return null;
    return new SupabaseRestClient({
      url: sync.url.trim(),
      secretKey: sync.secretKey.trim(),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  isConfigured(): boolean {
    const sync = this.settingsService.get().sync;
    return (
      sync.url.trim().length > 0 &&
      sync.secretKey.trim().length > 0 &&
      sync.userId.trim().length > 0
    );
  }

  private enabled(): boolean {
    const sync = this.settingsService.get().sync;
    if (!sync.enabled) {
      this.logger.debug('sync disabled, skipping');
      return false;
    }
    if (!this.isConfigured()) {
      this.logger.debug('sync not configured, skipping');
      return false;
    }
    return true;
  }

  enqueueJob(jobId: number): void {
    if (!this.enabled() || !this.settingsService.get().sync.syncJobs) return;
    this.sync.enqueue('job', jobId);
  }

  enqueueApplication(applicationId: number): void {
    if (!this.enabled() || !this.settingsService.get().sync.syncApplications) return;
    this.sync.enqueue('application', applicationId);
  }

  enqueueNotification(notificationId: number): void {
    if (!this.enabled() || !this.settingsService.get().sync.syncNotifications) return;
    this.sync.enqueue('notification', notificationId);
  }

  /**
   * Mirrors local activity into the outbox. Subscribing beats calling the
   * enqueue methods from every writer: a missed event costs at most a delayed
   * row, and the next full resync repairs it.
   */
  attach(): () => void {
    const offs = [
      this.events.on('job.scored', ({ jobId }) => this.enqueueJob(jobId)),
      this.events.on('application.created', ({ applicationId }) =>
        this.enqueueApplication(applicationId),
      ),
      this.events.on('application.submitted', ({ applicationId }) =>
        this.enqueueApplication(applicationId),
      ),
      this.events.on('application.failed', ({ applicationId }) =>
        this.enqueueApplication(applicationId),
      ),
      this.events.on('application.needs_human', ({ applicationId }) =>
        this.enqueueApplication(applicationId),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  async flush(): Promise<FlushResult> {
    const client = this.client();
    if (!client) {
      this.logger.debug('flush skipped: sync disabled or unconfigured');
      return { pushed: 0, failed: 0 };
    }

    const settings = this.settingsService.get().sync;
    const userId = settings.userId.trim();
    this.sync.purgeExhausted(MAX_OUTBOX_ATTEMPTS);

    const batch = this.sync.claim(BATCH_SIZE);
    if (batch.length === 0) return { pushed: 0, failed: 0 };

    const jobRows: SyncedJobRow[] = [];
    const applicationRows: SyncedApplicationRow[] = [];
    const notificationRows: SyncedNotificationRow[] = [];
    const jobIds: number[] = [];
    const applicationIds: number[] = [];
    const notificationIds: number[] = [];
    // Rows that can never be sent (entity deleted, entity type disabled, score
    // below the threshold). Dropping them keeps the oldest-first cursor moving.
    const droppable: number[] = [];

    for (const row of batch) {
      const entity = row.entity as SyncEntity;
      if (entity === 'job') {
        const mapped = settings.syncJobs ? this.toJobRow(row.entityId, userId) : null;
        if (mapped && (mapped.score ?? 0) >= settings.minScoreToSync) {
          jobRows.push(mapped);
          jobIds.push(row.id);
        } else {
          droppable.push(row.id);
        }
      } else if (entity === 'application') {
        const mapped = settings.syncApplications
          ? this.toApplicationRow(row.entityId, userId)
          : null;
        if (mapped) {
          applicationRows.push(mapped);
          applicationIds.push(row.id);
        } else {
          droppable.push(row.id);
        }
      } else if (entity === 'notification') {
        const mapped = settings.syncNotifications
          ? this.toNotificationRow(row.entityId, userId)
          : null;
        if (mapped) {
          notificationRows.push(mapped);
          notificationIds.push(row.id);
        } else {
          droppable.push(row.id);
        }
      } else {
        droppable.push(row.id);
      }
    }

    this.sync.remove(droppable);

    let pushed = 0;
    let failed = 0;
    let lastError: string | null = null;

    const groups: { table: string; rows: readonly unknown[]; outboxIds: number[] }[] = [
      { table: 'jobs', rows: jobRows, outboxIds: jobIds },
      { table: 'applications', rows: applicationRows, outboxIds: applicationIds },
      { table: 'notifications', rows: notificationRows, outboxIds: notificationIds },
    ];

    for (const group of groups) {
      if (group.rows.length === 0) continue;
      try {
        await client.upsert(group.table, group.rows, 'id,user_id');
        this.sync.remove(group.outboxIds);
        pushed += group.rows.length;
      } catch (error) {
        lastError = toErrorMessage(error);
        failed += group.rows.length;
        // Keep the outbox rows: the next pass retries them.
        for (const id of group.outboxIds) this.sync.fail(id, lastError);
        this.logger.warn('sync push failed', { table: group.table, error: lastError });
      }
    }

    this.sync.setState(SYNC_STATE_KEYS.lastSyncAt, nowIso());
    this.sync.setState(SYNC_STATE_KEYS.lastSyncError, lastError ?? '');
    this.sync.setState(SYNC_STATE_KEYS.reachable, failed > 0 ? 'false' : 'true');

    if (pushed > 0) this.logger.info('sync flushed', { pushed, failed });
    return { pushed, failed };
  }

  private toJobRow(jobId: number, userId: string): SyncedJobRow | null {
    const job = this.jobs.byId(jobId);
    if (!job) return null;
    return {
      id: job.id,
      user_id: userId,
      title: truncate(job.title, LIMITS.jobTitle),
      company: truncate(job.company, LIMITS.company),
      location: job.location === null ? null : truncate(job.location, LIMITS.location),
      source: job.source,
      remote_type: job.remoteType,
      employment_type: job.employmentType,
      experience_level: job.experienceLevel,
      salary_min: job.salaryMin,
      salary_max: job.salaryMax,
      salary_currency: job.salaryCurrency,
      score: job.score,
      recommendation: job.recommendation,
      status: job.status,
      application_url: truncate(job.applicationUrl, LIMITS.applicationUrl),
      posted_at: job.postedAt,
      collected_at: job.collectedAt,
      updated_at: job.updatedAt,
    };
  }

  private toApplicationRow(applicationId: number, userId: string): SyncedApplicationRow | null {
    const application = this.applications.byId(applicationId);
    if (!application) return null;
    const job = this.jobs.byId(application.jobId);
    return {
      id: application.id,
      user_id: userId,
      job_id: application.jobId,
      job_title: job === undefined ? null : truncate(job.title, LIMITS.jobTitle),
      company: job === undefined ? null : truncate(job.company, LIMITS.company),
      provider: application.provider,
      status: application.status,
      current_step: application.currentStep,
      attempts: application.attempts,
      max_attempts: application.maxAttempts,
      // Redacted then truncated: failure text is operational, but it is authored
      // by whatever threw, so it is treated as untrusted before it is shortened.
      error:
        application.error === null
          ? null
          : truncate(this.redactor.text(application.error), LIMITS.applicationError),
      dry_run: application.dryRun,
      started_at: application.startedAt,
      submitted_at: application.submittedAt,
      created_at: application.createdAt,
      updated_at: application.updatedAt,
    };
  }

  private toNotificationRow(notificationId: number, userId: string): SyncedNotificationRow | null {
    const notification = this.notifications.byId(notificationId);
    if (!notification) return null;
    return {
      id: notification.id,
      user_id: userId,
      kind: notification.kind,
      level: notification.level,
      // Bodies are composed from metadata, but a collector or system alert can
      // embed an upstream error verbatim, so both fields go through the scrub.
      title: truncate(this.redactor.text(notification.title), LIMITS.notificationTitle),
      body: truncate(this.redactor.text(notification.body), LIMITS.notificationBody),
      entity_type: notification.entityType,
      entity_id: notification.entityId,
      read: notification.read,
      actionable: notification.actionable,
      created_at: notification.createdAt,
    };
  }

  async pushQueueStats(): Promise<void> {
    const client = this.client();
    if (!client) {
      this.logger.debug('queue stats push skipped: sync disabled or unconfigured');
      return;
    }
    const settings = this.settingsService.get();
    const stats = this.queue.statsByStatus();
    const row: SyncedQueueStatsRow = {
      user_id: settings.sync.userId.trim(),
      pending: stats.pending,
      active: stats.active,
      completed: stats.completed,
      failed: stats.failed,
      delayed: stats.delayed,
      cancelled: stats.cancelled,
      // The worker is up whenever the queue is not paused; a paused queue is
      // the only state the phone can act on.
      worker_running: !settings.queue.paused,
      updated_at: nowIso(),
    };
    try {
      await client.upsert('queue_stats', [row], 'user_id');
    } catch (error) {
      this.logger.warn('queue stats push failed', { error: toErrorMessage(error) });
    }
  }

  /** Re-enqueues everything so a wiped or newly paired mirror can be rebuilt. */
  async fullResync(): Promise<number> {
    if (!this.enabled()) return 0;
    const settings = this.settingsService.get().sync;
    let total = 0;
    if (settings.syncJobs) total += this.sync.enqueueMany('job', this.sync.allJobIds());
    if (settings.syncApplications) {
      total += this.sync.enqueueMany('application', this.sync.allApplicationIds());
    }
    this.logger.info('full resync queued', { entities: total });
    // Push the first batch immediately so a freshly paired phone shows data
    // without waiting for the scheduler tick.
    await this.flush();
    return total;
  }

  async status(): Promise<SyncStatus> {
    const settings = this.settingsService.get().sync;
    const configured = this.isConfigured();
    const lastSyncError = this.sync.getState(SYNC_STATE_KEYS.lastSyncError) ?? '';
    const base: SyncStatus = {
      enabled: settings.enabled,
      configured,
      reachable: false,
      paired: Boolean(this.sync.getState(SYNC_STATE_KEYS.pairedAt)),
      lastSyncAt: this.sync.getState(SYNC_STATE_KEYS.lastSyncAt) ?? null,
      lastSyncError: lastSyncError.length > 0 ? lastSyncError : null,
      lastCommandPollAt: this.sync.getState(SYNC_STATE_KEYS.lastCommandPollAt) ?? null,
      pendingCommands: this.sync.pendingCommandCount(),
      syncedJobs: Number(this.sync.getState(SYNC_STATE_KEYS.syncedJobs) ?? 0),
      syncedApplications: Number(this.sync.getState(SYNC_STATE_KEYS.syncedApplications) ?? 0),
      devices: Number(this.sync.getState(SYNC_STATE_KEYS.devices) ?? 0),
    };

    const client = this.client();
    if (!client) {
      this.logger.debug('sync status served from local state only');
      return base;
    }

    const filter = { user_id: `eq.${settings.userId.trim()}` };
    try {
      const [syncedJobs, syncedApplications] = await Promise.all([
        client.count('jobs', filter),
        client.count('applications', filter),
      ]);
      this.sync.setState(SYNC_STATE_KEYS.syncedJobs, String(syncedJobs));
      this.sync.setState(SYNC_STATE_KEYS.syncedApplications, String(syncedApplications));
      this.sync.setState(SYNC_STATE_KEYS.reachable, 'true');
      return { ...base, reachable: true, syncedJobs, syncedApplications };
    } catch (error) {
      const message = toErrorMessage(error);
      this.sync.setState(SYNC_STATE_KEYS.reachable, 'false');
      this.logger.debug('sync status probe failed', { error: message });
      return { ...base, reachable: false, lastSyncError: base.lastSyncError ?? message };
    }
  }

  /**
   * Reachability probe for the settings screen. Never throws, and deliberately
   * works while the mirror is still switched off so the user can validate a
   * project before enabling it.
   */
  async test(): Promise<{ reachable: boolean; error: string | null }> {
    const client = this.restClient();
    if (!client) {
      return {
        reachable: false,
        error: 'Set the Supabase URL, secret key and paired user id before testing.',
      };
    }
    const settings = this.settingsService.get().sync;
    try {
      await client.count('jobs', { user_id: `eq.${settings.userId.trim()}` });
      this.sync.setState(SYNC_STATE_KEYS.reachable, 'true');
      return { reachable: true, error: null };
    } catch (error) {
      const message = toErrorMessage(error);
      this.sync.setState(SYNC_STATE_KEYS.reachable, 'false');
      return { reachable: false, error: message };
    }
  }

  /**
   * Records the Supabase auth user id shown on the phone's pairing screen. The
   * timestamp is what makes `status().paired` true, so pairing must go through
   * here rather than writing the setting directly.
   */
  async pair(userId: string): Promise<SyncStatus> {
    this.settingsService.update({ sync: { userId: userId.trim() } });
    this.sync.setState(SYNC_STATE_KEYS.pairedAt, nowIso());
    this.logger.info('paired with mobile account');
    return this.status();
  }

  /**
   * PostgREST passthroughs. They exist so this service satisfies the structural
   * `SyncCommandChannel` the command poller depends on, keeping the Supabase
   * credentials in one place instead of handing a second client to the queue.
   * Both are inert while sync is off, which is what stops the poller talking to
   * a project the user has disabled.
   */
  async select<T>(table: string, query: Record<string, string>): Promise<T[]> {
    const client = this.client();
    if (!client) return [];
    return client.select<T>(table, query);
  }

  async update(
    table: string,
    match: Record<string, string>,
    values: Record<string, unknown>,
  ): Promise<void> {
    const client = this.client();
    if (!client) return;
    await client.update(table, match, values);
  }

  /**
   * Stamped by whoever drives the command poller. Kept here because the poller
   * itself has no repository, and `status().lastCommandPollAt` is otherwise
   * permanently null.
   */
  markCommandPoll(): void {
    this.sync.setState(SYNC_STATE_KEYS.lastCommandPollAt, nowIso());
  }

  /** Exposed for the queue and command workers that report their own progress. */
  pendingCount(): number {
    return this.sync.pendingCount();
  }
}
