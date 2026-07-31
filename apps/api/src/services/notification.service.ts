import type { NotificationDto, NotificationKind, NotificationLevel } from '@deedy/shared';
import type { Logger } from '../core/logger.js';
import { dayKey, nowIso } from '../core/utils.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import type { SettingsService } from './settings.service.js';

export interface NotificationPayload {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface NotificationRecordInput {
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body?: string;
  entityType?: string | null;
  entityId?: number | null;
  actionable?: boolean;
  dedupeKey?: string | null;
  /** Extra context for the webhook only. Never persisted, never synced. */
  data?: Record<string, unknown>;
}

interface JobRef {
  id?: number;
  title: string;
  company: string;
}

/**
 * Structural view of the sync outbox. Declared here so the notification layer
 * depends on a behaviour rather than on the sync service, and so it can be
 * constructed without one when the mirror is not in play.
 */
export interface NotificationSyncSink {
  enqueueNotification(notificationId: number): void;
}

/**
 * Durable notification feed plus an optional push to a user-supplied local
 * webhook (ntfy, gotify, Home Assistant…). The row in SQLite is the source of
 * truth so the dashboard and phone have something to read; the webhook is a
 * best-effort side channel and nothing is sent unless the user configured one.
 */
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    private readonly sync?: NotificationSyncSink,
  ) {}

  /** Low-level entry point: persist first, then push. */
  async record(input: NotificationRecordInput): Promise<NotificationDto | undefined> {
    const saved = this.persist(input);
    await this.sendWebhook({
      title: input.title,
      message: input.body ?? '',
      level: toPayloadLevel(input.level),
      data: {
        ...input.data,
        kind: input.kind,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });
    return saved;
  }

  /** Kept for callers that just want a free-form message on the feed. */
  async notify(payload: NotificationPayload): Promise<void> {
    this.persist({
      kind: 'system',
      level: payload.level,
      title: payload.title,
      body: payload.message,
    });
    await this.sendWebhook(payload);
  }

  async applicationSubmitted(job: JobRef, dryRun: boolean): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnApplied) return;
    await this.record({
      kind: 'application.submitted',
      level: 'success',
      title: dryRun ? 'Application prepared (dry run)' : 'Application submitted',
      body: `${job.title} at ${job.company}`,
      entityType: 'job',
      entityId: job.id ?? null,
      dedupeKey: dedupe('application.submitted', job.id, dryRun ? 'dry' : 'live'),
    });
  }

  async applicationFailed(job: JobRef, error: string): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnFailure) return;
    await this.record({
      kind: 'application.failed',
      level: 'error',
      title: 'Application failed',
      body: `${job.title} at ${job.company}: ${error}`,
      entityType: 'job',
      entityId: job.id ?? null,
      actionable: true,
      dedupeKey: dedupe('application.failed', job.id),
    });
  }

  async needsHuman(job: JobRef, reason: string): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnNeedsHuman) return;
    await this.record({
      kind: 'application.needs_human',
      level: 'warning',
      title: 'Application needs you',
      body: `${job.title} at ${job.company}: ${reason}`,
      entityType: 'job',
      entityId: job.id ?? null,
      actionable: true,
      dedupeKey: dedupe('application.needs_human', job.id),
    });
  }

  async highScore(job: JobRef, score: number): Promise<void> {
    const settings = this.settingsService.get().notifications;
    if (!settings.notifyOnHighScore || score < settings.highScoreThreshold) return;
    await this.record({
      kind: 'job.high_score',
      level: 'info',
      title: `High match: ${score}`,
      body: `${job.title} at ${job.company}`,
      entityType: 'job',
      entityId: job.id ?? null,
      dedupeKey: dedupe('job.high_score', job.id),
    });
  }

  async credentialExpired(provider: string): Promise<void> {
    await this.record({
      kind: 'credential.expired',
      level: 'warning',
      title: `${provider} session expired`,
      body: `Automation for ${provider} is paused. Open Settings and paste a fresh session cookie to resume.`,
      entityType: 'credential',
      actionable: true,
      // One reminder per provider per day rather than one per failed attempt.
      dedupeKey: `credential.expired:${provider}:${dayKey(nowIso())}`,
    });
  }

  async collectorFailed(collectorId: string, error: string): Promise<void> {
    await this.record({
      kind: 'collector.failed',
      level: 'error',
      title: `Collector failed: ${collectorId}`,
      body: error,
      entityType: 'collector',
      actionable: true,
      dedupeKey: `collector.failed:${collectorId}:${dayKey(nowIso())}`,
    });
  }

  async queueStalled(count: number): Promise<void> {
    await this.record({
      kind: 'queue.stalled',
      level: 'warning',
      title: 'Queue stalled',
      body: `${count} queued ${count === 1 ? 'task has' : 'tasks have'} not progressed. Check the worker.`,
      entityType: 'queue',
      actionable: true,
      dedupeKey: `queue.stalled:${nowIso().slice(0, 13)}`,
    });
  }

  private persist(input: NotificationRecordInput): NotificationDto | undefined {
    try {
      const saved = this.notifications.create({
        kind: input.kind,
        level: input.level,
        title: input.title,
        body: input.body ?? '',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actionable: input.actionable ?? false,
        dedupeKey: input.dedupeKey ?? null,
      });
      // Mirroring is opt-in and filtered downstream; the outbox row is the only
      // thing created here, so a disabled mirror costs nothing.
      this.sync?.enqueueNotification(saved.id);
      return saved;
    } catch (error) {
      // Losing a notification must never break the pipeline that raised it.
      this.logger.warn('notification persist failed', {
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async sendWebhook(payload: NotificationPayload): Promise<void> {
    const settings = this.settingsService.get().notifications;
    if (!settings.enabled || !settings.webhookUrl.trim()) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        await fetch(settings.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, source: 'deedy-automation' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // A failing webhook must never break the pipeline.
      this.logger.warn('notification webhook failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toPayloadLevel(level: NotificationLevel): NotificationPayload['level'] {
  return level === 'success' ? 'info' : level;
}

/** Undefined when there is no entity to key on, so the row is never collapsed. */
function dedupe(kind: NotificationKind, id: number | undefined, suffix?: string): string | null {
  if (id === undefined) return null;
  return suffix ? `${kind}:${id}:${suffix}` : `${kind}:${id}`;
}
