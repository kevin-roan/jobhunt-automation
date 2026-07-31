import { randomUUID } from 'node:crypto';
import type { QueueTask } from '@deedy/shared';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { toErrorMessage } from '../core/errors.js';
import type { QueueJobRow } from '../db/schema.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import type { SettingsService } from '../services/settings.service.js';

export type TaskHandler = (payload: unknown, job: QueueJobRow) => Promise<void>;
export type TaskHandlerMap = Partial<Record<QueueTask, TaskHandler>>;

/** Tasks that drive a browser; limited by a separate, smaller concurrency cap. */
const BROWSER_TASKS: QueueTask[] = ['application.apply', 'collect.jobs'];

/**
 * Polls the SQLite queue and executes claimed jobs. All state lives in the
 * database, so killing the process mid-task loses nothing: the stalled lock is
 * reclaimed on the next boot and the job runs again.
 */
export class QueueWorker {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private readonly inFlight = new Set<number>();
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly queue: QueueRepository,
    private readonly handlers: TaskHandlerMap,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    const reclaimed = this.queue.reclaimStalled();
    if (reclaimed > 0) this.logger.warn('reclaimed stalled queue jobs', { count: reclaimed });

    this.logger.info('queue worker started', { workerId: this.workerId });
    this.scheduleTick(0);
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.loopPromise = this.tick()
        .catch((error: unknown) => {
          this.logger.error('queue tick failed', { error: toErrorMessage(error) });
        })
        .finally(() => {
          const interval = this.settingsService.get().queue.pollIntervalMs;
          this.scheduleTick(interval);
        });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const settings = this.settingsService.get().queue;
    if (settings.paused) return;

    const browserInFlight = this.countInFlightBrowserJobs();
    const capacity = settings.concurrency - this.inFlight.size;
    if (capacity <= 0) return;

    const excludeBrowserTasks = browserInFlight >= settings.browserConcurrency;
    const claimed = this.queue.claim({
      limit: capacity,
      workerId: this.workerId,
      lockMs: settings.stalledAfterMs,
      ...(excludeBrowserTasks ? { excludeTasks: BROWSER_TASKS } : {}),
    });

    for (const job of claimed) {
      this.inFlight.add(job.id);
      void this.execute(job).finally(() => this.inFlight.delete(job.id));
    }
  }

  private browserJobIds = new Map<number, QueueTask>();

  private countInFlightBrowserJobs(): number {
    let count = 0;
    for (const id of this.inFlight) {
      const task = this.browserJobIds.get(id);
      if (task && BROWSER_TASKS.includes(task)) count += 1;
    }
    return count;
  }

  private async execute(job: QueueJobRow): Promise<void> {
    const task = job.task as QueueTask;
    this.browserJobIds.set(job.id, task);
    const handler = this.handlers[task];
    const attemptId = this.queue.startAttempt(job.id, job.attempts);
    const startedAt = Date.now();

    this.events.emit('queue.started', { id: job.id, task, attempt: job.attempts });
    this.logger.debug('queue job started', { id: job.id, task, attempt: job.attempts });

    if (!handler) {
      const error = `No handler registered for task "${task}"`;
      this.queue.finishAttempt(attemptId, 'failed', Date.now() - startedAt, error);
      this.queue.fail(job.id, error, null);
      this.logger.error('queue job has no handler', { id: job.id, task });
      this.browserJobIds.delete(job.id);
      return;
    }

    try {
      await handler(job.payload, job);
      const durationMs = Date.now() - startedAt;
      this.queue.finishAttempt(attemptId, 'succeeded', durationMs);
      this.queue.complete(job.id);
      this.events.emit('queue.completed', { id: job.id, task, durationMs });
      this.logger.info('queue job completed', { id: job.id, task, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = toErrorMessage(error);
      const settings = this.settingsService.get().queue;
      const willRetry = job.attempts < job.maxAttempts;
      const backoffMs = willRetry
        ? Math.round(settings.backoffBaseMs * settings.backoffFactor ** (job.attempts - 1))
        : null;

      this.queue.finishAttempt(attemptId, 'failed', durationMs, message);
      this.queue.fail(job.id, message, backoffMs);
      this.events.emit('queue.failed', { id: job.id, task, error: message, willRetry });
      this.logger[willRetry ? 'warn' : 'error']('queue job failed', {
        id: job.id,
        task,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        willRetry,
        retryInMs: backoffMs,
        error: message,
      });
    } finally {
      this.browserJobIds.delete(job.id);
    }
  }

  /** Waits for in-flight work to finish so shutdown never orphans a browser. */
  async stop(timeoutMs = 30000): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.loopPromise?.catch(() => undefined);

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.inFlight.size > 0) {
      this.logger.warn('stopping with jobs still in flight; they will be reclaimed on next boot', {
        count: this.inFlight.size,
      });
    }
    this.logger.info('queue worker stopped');
  }

  status(): { running: boolean; inFlight: number; workerId: string } {
    return { running: this.running, inFlight: this.inFlight.size, workerId: this.workerId };
  }
}
