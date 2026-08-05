import { randomUUID } from 'node:crypto';
import {
  PIPELINE_STAGES,
  QUEUE_TASK_STAGE,
  STAGE_SETTING_KEY,
  type PipelineSettings,
  type PipelineStage,
  type QueueTask,
} from '@deedy/shared';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { toErrorMessage } from '../core/errors.js';
import type { QueueJobRow } from '../db/schema.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import type { SettingsService } from '../services/settings.service.js';

export type TaskHandler = (
  payload: unknown,
  job: QueueJobRow,
  signal: AbortSignal,
) => Promise<void>;
export type TaskHandlerMap = Partial<Record<QueueTask, TaskHandler>>;

/** Tasks that drive a browser; limited by a separate, smaller concurrency cap. */
const BROWSER_TASKS: QueueTask[] = ['application.apply', 'collect.jobs'];

/** How often the poll loop re-checks for jobs whose worker died holding a lock. */
const RECLAIM_INTERVAL_MS = 60000;

/**
 * Whether a thrown value is an abort rather than a genuine failure.
 *
 * The signal alone cannot decide this: an abort landing between a handler's
 * `throw` and our `catch` would otherwise erase a real error's message and
 * refile it as a stop. Abort rejections are identifiable by shape — `fetch` and
 * friends reject with a `DOMException` named `AbortError`, and the LLM layer
 * throws an `Error` carrying the same name.
 */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

/** Whether a stage may run, honouring the master switch as well as its own. */
export function isPipelineStageEnabled(
  pipeline: PipelineSettings,
  stage: PipelineStage,
): boolean {
  return pipeline.enabled && pipeline[STAGE_SETTING_KEY[stage]] === true;
}

/** Queue tasks belonging to stages that are currently stopped. */
function stoppedStageTasks(pipeline: PipelineSettings): QueueTask[] {
  return Object.entries(QUEUE_TASK_STAGE)
    .filter(([, stage]) => !isPipelineStageEnabled(pipeline, stage))
    .map(([task]) => task as QueueTask);
}

interface InFlightJob {
  task: QueueTask;
  stage: PipelineStage | null;
  controller: AbortController;
}

/**
 * Polls the SQLite queue and executes claimed jobs. All state lives in the
 * database, so killing the process mid-task loses nothing: the stalled lock is
 * reclaimed on the next boot and the job runs again.
 */
export class QueueWorker {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  /**
   * One entry per executing job, created before `execute()` starts and removed
   * in a single `finally`. Keeping the task, stage and abort controller in the
   * same map is what makes the browser-concurrency count and the in-flight
   * count impossible to disagree.
   */
  private readonly inFlight = new Map<number, InFlightJob>();
  private running = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;
  /** Epoch ms of the last stalled-lock sweep; throttles it off the poll rate. */
  private lastReclaimAt = 0;

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

    this.reclaimStalled();

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

  /**
   * Sweeps rows whose lock expired back to pending, at most once a minute.
   *
   * Boot-time reclaiming alone is not enough: a process killed while a lock was
   * still live leaves an `active` row that the next boot skips (its lock had not
   * expired yet), stranding the job forever. Running the sweep on the loop means
   * every stalled row is eventually picked up, whatever the crash timing.
   */
  private reclaimStalled(): void {
    this.lastReclaimAt = Date.now();
    const reclaimed = this.queue.reclaimStalled();
    if (reclaimed > 0) this.logger.warn('reclaimed stalled queue jobs', { count: reclaimed });
  }

  private async tick(): Promise<void> {
    const settings = this.settingsService.get();
    const queueSettings = settings.queue;

    // Ahead of every gate below: a stopped or paused pipeline must still recover
    // its own stranded rows, otherwise they stay invisible until someone starts
    // the pipeline again.
    if (Date.now() - this.lastReclaimAt >= RECLAIM_INTERVAL_MS) this.reclaimStalled();

    if (queueSettings.paused) return;

    const capacity = queueSettings.concurrency - this.inFlight.size;
    if (capacity <= 0) return;

    // A stopped pipeline claims no stage-bearing work — that is what frees the
    // machine — but maintenance tasks have no stage and must keep running:
    // stopping the pipeline to save CPU must not silently end backups and log
    // retention. `stoppedStageTasks` already excludes every stage task when the
    // master switch is off, so no extra gate is needed here.
    const excludeTasks = new Set<QueueTask>(stoppedStageTasks(settings.pipeline));
    if (this.countInFlightBrowserJobs() >= queueSettings.browserConcurrency) {
      for (const task of BROWSER_TASKS) excludeTasks.add(task);
    }

    const claimed = this.queue.claim({
      limit: capacity,
      workerId: this.workerId,
      lockMs: queueSettings.stalledAfterMs,
      ...(excludeTasks.size > 0 ? { excludeTasks: Array.from(excludeTasks) } : {}),
    });

    for (const job of claimed) {
      const task = job.task as QueueTask;
      const entry: InFlightJob = {
        task,
        stage: QUEUE_TASK_STAGE[task] ?? null,
        controller: new AbortController(),
      };
      this.inFlight.set(job.id, entry);
      // `execute` swallows handler errors, but its own bookkeeping writes can
      // still throw (a locked database, say). Without this catch that would be
      // an unhandled rejection and take the process down.
      void this.execute(job, entry)
        .catch((error: unknown) => {
          this.logger.error('queue job bookkeeping failed', {
            id: job.id,
            task,
            error: toErrorMessage(error),
          });
        })
        .finally(() => this.inFlight.delete(job.id));
    }
  }

  private countInFlightBrowserJobs(): number {
    let count = 0;
    for (const entry of this.inFlight.values()) {
      if (BROWSER_TASKS.includes(entry.task)) count += 1;
    }
    return count;
  }

  /**
   * Aborts in-flight jobs, optionally only those belonging to one stage.
   * Returns how many were signalled.
   *
   * Without a stage this is the master stop, which still only touches
   * stage-bearing work: a backup halfway through copying the database is not
   * what the user asked to stop, and killing it wastes the whole copy.
   */
  abort(stage?: PipelineStage): number {
    let signalled = 0;
    for (const [id, entry] of this.inFlight) {
      if (entry.stage === null) continue;
      if (stage && entry.stage !== stage) continue;
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort();
      signalled += 1;
      this.logger.info('queue job aborted', { id, task: entry.task, stage: entry.stage });
    }
    return signalled;
  }

  /** Tasks currently executing, by stage. */
  inFlightByStage(): Record<PipelineStage, number> {
    const counts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, 0])) as Record<
      PipelineStage,
      number
    >;
    for (const entry of this.inFlight.values()) {
      if (entry.stage) counts[entry.stage] += 1;
    }
    return counts;
  }

  private async execute(job: QueueJobRow, entry: InFlightJob): Promise<void> {
    const task = entry.task;
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
      return;
    }

    try {
      await handler(job.payload, job, entry.controller.signal);
      const durationMs = Date.now() - startedAt;
      this.queue.finishAttempt(attemptId, 'succeeded', durationMs);
      this.queue.complete(job.id);
      this.events.emit('queue.completed', { id: job.id, task, durationMs });
      this.logger.info('queue job completed', { id: job.id, task, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = toErrorMessage(error);

      // Stopping a stage is a user decision, not a fault: the job goes back to
      // pending via `release()`, which hands back the attempt `claim()` charged
      // so a stop is genuinely neutral — and, unlike `retry()`, leaves the
      // attempt history intact so a job that always fails still reaches
      // `failed` instead of being resurrected by every stop/start cycle.
      //
      // Both conditions are required. The signal alone would misfile a genuine
      // error that raced the abort, recording "stage stopped" and losing the
      // real message; the error shape alone could not tell a stop apart from a
      // transport timing out on its own.
      if (entry.controller.signal.aborted && isAbortError(error)) {
        this.queue.finishAttempt(attemptId, 'failed', durationMs, 'aborted: stage stopped');
        this.queue.release(job.id);
        this.logger.info('queue job returned to pending after abort', {
          id: job.id,
          task,
          stage: entry.stage,
          durationMs,
        });
        return;
      }

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
