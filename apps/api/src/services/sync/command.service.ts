import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  applicationStatusSchema,
  remoteCommandSchema,
  type CommandStatus,
  type RemoteCommand,
} from '@deedy/shared';
import { AppError, toErrorMessage } from '../../core/errors.js';
import type { EventBus } from '../../core/events.js';
import type { Logger } from '../../core/logger.js';
import { nowIso, truncate } from '../../core/utils.js';
import type { Db } from '../../db/client.js';
import { remoteCommands } from '../../db/schema.js';
import type { ApplicationRepository } from '../../repositories/application.repository.js';
import type { JobRepository } from '../../repositories/job.repository.js';
import type { QueueRepository } from '../../repositories/queue.repository.js';
import type { SettingsService } from '../settings.service.js';

/**
 * The slice of the Supabase REST client this service needs. Declared here as a
 * structural type so the command channel depends on behaviour, not on a class:
 * `SyncService` satisfies it as-is.
 *
 * `query` and `match` are PostgREST filters (`{ status: 'eq.pending' }`).
 */
export interface SyncCommandChannel {
  isConfigured(): boolean;
  select<T>(table: string, query: Record<string, string>): Promise<T[]>;
  update(
    table: string,
    match: Record<string, string>,
    values: Record<string, unknown>,
  ): Promise<void>;
}

export interface CommandServiceOptions {
  /**
   * Invoked by the `sync.full` command. Wired by the container to
   * `SyncService.fullResync` - passing the service itself would be a cycle,
   * since SyncService owns the poller that drives this class.
   */
  onFullResync?: () => Promise<void>;
}

/** Local ledger of every remote command ever claimed. Dedupe lives here. */
export class CommandRepository {
  constructor(private readonly db: Db) {}

  hasHandled(remoteId: string): boolean {
    return (
      this.db
        .select({ id: remoteCommands.id })
        .from(remoteCommands)
        .where(eq(remoteCommands.remoteId, remoteId))
        .get() !== undefined
    );
  }

  record(remoteId: string, kind: RemoteCommand, payload: unknown): void {
    this.db
      .insert(remoteCommands)
      .values({ remoteId, kind, payload, status: 'claimed', claimedAt: nowIso() })
      .onConflictDoNothing()
      .run();
  }

  complete(remoteId: string, status: CommandStatus, result: string): void {
    this.db
      .update(remoteCommands)
      .set({ status, result, completedAt: nowIso() })
      .where(eq(remoteCommands.remoteId, remoteId))
      .run();
  }
}

/** Envelope shape, validated because it arrives off the network. */
const commandEnvelopeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown().default({}),
});

const applicationRetrySchema = z.object({ applicationId: z.number().int().positive() });
const applicationSetStatusSchema = z.object({
  applicationId: z.number().int().positive(),
  status: applicationStatusSchema,
});
const jobScoreSchema = z.object({
  jobId: z.number().int().positive(),
  resumeId: z.number().int().positive().nullable().optional(),
});
const jobArchiveSchema = z.object({
  jobId: z.number().int().positive(),
  archived: z.boolean().default(true),
});
const collectorRunSchema = z.object({ collectorId: z.string().min(1).max(120) });
const queueRetryFailedSchema = z.object({});
const queuePauseSchema = z.object({ paused: z.boolean() });
const syncFullSchema = z.object({});

interface CommandOutcome {
  status: 'succeeded' | 'failed';
  result: string;
}

function ok(result: string): CommandOutcome {
  return { status: 'succeeded', result };
}

function failed(result: string): CommandOutcome {
  return { status: 'failed', result };
}

function parsePayload<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> | string {
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'payload';
  return `invalid payload: ${where} ${issue?.message ?? 'is invalid'}`;
}

function isPayloadError<T>(value: T | string): value is string {
  return typeof value === 'string';
}

/**
 * Control channel for the mobile app. The phone cannot reach this host - it
 * writes a row to the `commands` table in Supabase and this service claims,
 * executes and answers it, so no inbound port or tunnel is ever opened.
 *
 * Nothing leaves the host here beyond a command status and a short, locally
 * authored result string: no documents, no PII, no credentials.
 */
export class CommandService {
  constructor(
    private readonly sync: SyncCommandChannel,
    private readonly commands: CommandRepository,
    private readonly queue: QueueRepository,
    private readonly jobs: JobRepository,
    private readonly applications: ApplicationRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly options: CommandServiceOptions = {},
  ) {}

  async poll(): Promise<{ claimed: number; succeeded: number; failed: number }> {
    const summary = { claimed: 0, succeeded: 0, failed: 0 };
    const settings = this.settingsService.get().sync;
    if (!settings.enabled || settings.userId.trim().length === 0 || !this.sync.isConfigured()) {
      return summary;
    }

    let rows: unknown[];
    try {
      rows = await this.sync.select<unknown>('commands', {
        user_id: `eq.${settings.userId}`,
        status: 'eq.pending',
        order: 'created_at.asc',
        limit: '25',
      });
    } catch (error) {
      this.logger.warn('failed to fetch remote commands', { error: toErrorMessage(error) });
      return summary;
    }

    for (const row of rows) {
      const envelope = commandEnvelopeSchema.safeParse(row);
      if (!envelope.success) {
        // Without a usable id there is nothing to write back to; drop it.
        this.logger.warn('discarding malformed remote command row');
        continue;
      }
      const { id: remoteId, payload } = envelope.data;

      const kind = remoteCommandSchema.safeParse(envelope.data.kind);
      if (!kind.success) {
        summary.failed += 1;
        await this.writeRemote(remoteId, 'failed', 'unsupported command kind');
        continue;
      }

      // The local ledger, not the remote status, is what makes execution
      // exactly-once: a crash after executing but before the write-back still
      // leaves the command handled here.
      if (this.commands.hasHandled(remoteId)) continue;
      this.commands.record(remoteId, kind.data, payload);
      summary.claimed += 1;
      await this.writeRemote(remoteId, 'claimed', null);

      let outcome: CommandOutcome;
      try {
        outcome = await this.execute(kind.data, payload);
      } catch (error) {
        // Only our own errors carry text safe to put on the wire; anything else
        // stays in the host logs.
        this.logger.error('remote command failed', {
          remoteId,
          kind: kind.data,
          error: toErrorMessage(error),
        });
        outcome = failed(
          error instanceof AppError ? error.message : 'command failed; see host logs',
        );
      }

      const result = truncate(outcome.result, 500);
      this.commands.complete(remoteId, outcome.status, result);
      if (outcome.status === 'succeeded') summary.succeeded += 1;
      else summary.failed += 1;
      await this.writeRemote(remoteId, outcome.status, result);
    }

    if (summary.claimed > 0) {
      this.logger.info('remote commands processed', summary);
    }
    return summary;
  }

  private async execute(kind: RemoteCommand, payload: unknown): Promise<CommandOutcome> {
    switch (kind) {
      case 'application.retry':
        return this.applicationRetry(payload);
      case 'application.set_status':
        return this.applicationSetStatus(payload);
      case 'job.score':
        return this.jobScore(payload);
      case 'job.archive':
        return this.jobArchive(payload);
      case 'collector.run':
        return this.collectorRun(payload);
      case 'queue.retry_failed':
        return this.queueRetryFailed(payload);
      case 'queue.pause':
        return this.queuePause(payload);
      case 'sync.full':
        return this.syncFull(payload);
    }
  }

  private applicationRetry(payload: unknown): CommandOutcome {
    const input = parsePayload(applicationRetrySchema, payload);
    if (isPayloadError(input)) return failed(input);

    const application = this.applications.byId(input.applicationId);
    if (!application) return failed(`application ${input.applicationId} not found`);

    this.applications.update(application.id, { status: 'pending', error: null });
    const queued = this.queue.enqueue({
      task: 'application.apply',
      payload: { jobId: application.jobId },
      dedupeKey: `application.apply:${application.jobId}`,
      priority: 12,
    });
    this.events.emit('queue.enqueued', { id: queued.id, task: 'application.apply' });
    return ok(`application ${application.id} reset and queued as job ${queued.id}`);
  }

  private applicationSetStatus(payload: unknown): CommandOutcome {
    const input = parsePayload(applicationSetStatusSchema, payload);
    if (isPayloadError(input)) return failed(input);

    const application = this.applications.byId(input.applicationId);
    if (!application) return failed(`application ${input.applicationId} not found`);

    this.applications.setStatus(application.id, input.status);
    return ok(`application ${application.id} set to ${input.status}`);
  }

  private jobScore(payload: unknown): CommandOutcome {
    const input = parsePayload(jobScoreSchema, payload);
    if (isPayloadError(input)) return failed(input);

    if (!this.jobs.byId(input.jobId)) return failed(`job ${input.jobId} not found`);
    const queued = this.queue.enqueue({
      task: 'job.score',
      payload: { jobId: input.jobId, resumeId: input.resumeId ?? null },
      dedupeKey: `job.score:${input.jobId}`,
      priority: 8,
    });
    this.events.emit('queue.enqueued', { id: queued.id, task: 'job.score' });
    return ok(`job ${input.jobId} queued for scoring as job ${queued.id}`);
  }

  private jobArchive(payload: unknown): CommandOutcome {
    const input = parsePayload(jobArchiveSchema, payload);
    if (isPayloadError(input)) return failed(input);

    if (!this.jobs.byId(input.jobId)) return failed(`job ${input.jobId} not found`);
    this.jobs.setArchived(input.jobId, input.archived);
    return ok(`job ${input.jobId} ${input.archived ? 'archived' : 'unarchived'}`);
  }

  private collectorRun(payload: unknown): CommandOutcome {
    const input = parsePayload(collectorRunSchema, payload);
    if (isPayloadError(input)) return failed(input);

    const queued = this.queue.enqueue({
      task: 'collect.jobs',
      payload: { collectorId: input.collectorId },
      dedupeKey: `collect.jobs:${input.collectorId}`,
      priority: 4,
    });
    this.events.emit('queue.enqueued', { id: queued.id, task: 'collect.jobs' });
    return ok(`collector ${input.collectorId} queued as job ${queued.id}`);
  }

  private queueRetryFailed(payload: unknown): CommandOutcome {
    const input = parsePayload(queueRetryFailedSchema, payload);
    if (isPayloadError(input)) return failed(input);

    const retried = this.queue.retryAllFailed();
    return ok(`re-armed ${retried} failed queue job${retried === 1 ? '' : 's'}`);
  }

  private queuePause(payload: unknown): CommandOutcome {
    const input = parsePayload(queuePauseSchema, payload);
    if (isPayloadError(input)) return failed(input);

    this.settingsService.update({ queue: { paused: input.paused } });
    return ok(input.paused ? 'queue paused' : 'queue resumed');
  }

  private async syncFull(payload: unknown): Promise<CommandOutcome> {
    const input = parsePayload(syncFullSchema, payload);
    if (isPayloadError(input)) return failed(input);

    const onFullResync = this.options.onFullResync;
    if (!onFullResync) return failed('full resync is not wired on this host');

    await onFullResync();
    return ok('full resync completed');
  }

  /** Best effort: a failed write-back never re-runs a command, the ledger wins. */
  private async writeRemote(
    remoteId: string,
    status: CommandStatus,
    result: string | null,
  ): Promise<void> {
    const timestamps = status === 'claimed' ? { claimed_at: nowIso() } : { completed_at: nowIso() };
    try {
      await this.sync.update(
        'commands',
        { id: `eq.${remoteId}` },
        { status, result, ...timestamps },
      );
    } catch (error) {
      this.logger.warn('failed to write command status back', {
        remoteId,
        status,
        error: toErrorMessage(error),
      });
    }
  }
}
