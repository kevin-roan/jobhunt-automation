import type { Logger } from '../core/logger.js';
import { toErrorMessage } from '../core/errors.js';
import type { JobRepository } from '../repositories/job.repository.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import type { SchedulerStateRepository } from '../repositories/browser.repository.js';
import type { ApplicationService } from '../services/application.service.js';
import type { JobService } from '../services/job.service.js';
import type { SettingsService } from '../services/settings.service.js';

export interface ScheduledTask {
  name: string;
  /** Interval read fresh on every tick so Settings changes apply immediately. */
  intervalMinutes(): number;
  run(): Promise<void>;
}

interface TaskState {
  task: ScheduledTask;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

/**
 * Interval-driven background scheduler. Last/next run times are persisted, so a
 * restart resumes the cadence instead of firing everything at once.
 */
export class Scheduler {
  private readonly tasks = new Map<string, TaskState>();
  private started = false;

  constructor(
    private readonly state: SchedulerStateRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
  ) {}

  register(task: ScheduledTask): void {
    this.tasks.set(task.name, { task, timer: null, running: false });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const entry of this.tasks.values()) {
      this.schedule(entry, this.initialDelayMs(entry.task));
    }
    this.logger.info('scheduler started', { tasks: Array.from(this.tasks.keys()) });
  }

  /** Honours the persisted next-run time so restarts do not reset the clock. */
  private initialDelayMs(task: ScheduledTask): number {
    const persisted = this.state.get(task.name);
    const intervalMs = task.intervalMinutes() * 60000;
    if (!persisted?.nextRunAt) return Math.min(intervalMs, 30000);
    const remaining = new Date(persisted.nextRunAt).getTime() - Date.now();
    return Math.max(5000, Math.min(remaining, intervalMs));
  }

  private schedule(entry: TaskState, delayMs: number): void {
    if (!this.started) return;
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.state.upsert(entry.task.name, { nextRunAt });

    entry.timer = setTimeout(() => {
      void this.execute(entry);
    }, delayMs);
  }

  private async execute(entry: TaskState): Promise<void> {
    if (!this.settingsService.get().scheduler.enabled) {
      this.schedule(entry, entry.task.intervalMinutes() * 60000);
      return;
    }
    if (entry.running) return;

    entry.running = true;
    this.state.upsert(entry.task.name, { running: true });
    const startedAt = Date.now();

    try {
      await entry.task.run();
      this.state.upsert(entry.task.name, {
        lastRunAt: new Date().toISOString(),
        running: false,
        lastError: null,
      });
      this.logger.debug('scheduled task finished', {
        task: entry.task.name,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      this.state.upsert(entry.task.name, {
        lastRunAt: new Date().toISOString(),
        running: false,
        lastError: message,
      });
      this.logger.error('scheduled task failed', { task: entry.task.name, error: message });
    } finally {
      entry.running = false;
      this.schedule(entry, entry.task.intervalMinutes() * 60000);
    }
  }

  /** Runs a task immediately without disturbing its schedule. */
  async runNow(name: string): Promise<void> {
    const entry = this.tasks.get(name);
    if (!entry) throw new Error(`Unknown scheduled task: ${name}`);
    await entry.task.run();
  }

  stop(): void {
    this.started = false;
    for (const entry of this.tasks.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.logger.info('scheduler stopped');
  }

  status(): { running: boolean; tasks: { name: string; nextRunAt: string | null }[] } {
    return {
      running: this.started,
      tasks: Array.from(this.tasks.keys()).map((name) => ({
        name,
        nextRunAt: this.state.get(name)?.nextRunAt ?? null,
      })),
    };
  }
}

export interface SchedulerTaskDependencies {
  queue: QueueRepository;
  jobs: JobRepository;
  jobService: JobService;
  applicationService: ApplicationService;
  settingsService: SettingsService;
  logger: Logger;
  syncService: SyncTasks;
  commandService: CommandTasks;
  credentialService: CredentialTasks;
  notificationService: CredentialNotifier;
}

/** Structural views, so the scheduler stays free of concrete service imports. */
export interface SyncTasks {
  flush(): Promise<{ pushed: number; failed: number }>;
  pushQueueStats(): Promise<void>;
}

export interface CommandTasks {
  poll(): Promise<{ claimed: number; succeeded: number; failed: number }>;
}

export interface CredentialTasks {
  checkExpiry(): { provider: string }[];
}

export interface CredentialNotifier {
  credentialExpired(provider: string): Promise<void>;
}

/** The standard set of recurring jobs that keep the pipeline moving. */
export function createScheduledTasks(deps: SchedulerTaskDependencies): ScheduledTask[] {
  const settings = () => deps.settingsService.get();

  return [
    {
      name: 'collect',
      intervalMinutes: () => settings().scheduler.collectIntervalMinutes,
      async run() {
        for (const collectorId of deps.jobService.plannedCollectors()) {
          deps.queue.enqueue({
            task: 'collect.jobs',
            payload: { collectorId },
            dedupeKey: `collect.jobs:${collectorId}`,
            priority: 1,
          });
        }
      },
    },
    {
      name: 'score',
      intervalMinutes: () => settings().scheduler.scoreIntervalMinutes,
      async run() {
        const pending = deps.jobs.pendingScoring(50);
        for (const job of pending) {
          deps.queue.enqueue({
            task: 'job.enrich',
            payload: { jobId: job.id },
            dedupeKey: `job.enrich:${job.id}`,
            priority: 5,
          });
        }
      },
    },
    {
      name: 'apply',
      intervalMinutes: () => settings().scheduler.applyIntervalMinutes,
      async run() {
        const application = settings().application;
        if (!application.autoApply) return;

        // Re-queue anything a crash left half-finished before starting new work.
        deps.applicationService.recoverStuck();

        const candidates = deps.jobs.readyToApply(application.minScoreToApply, 25);
        for (const job of candidates) {
          deps.queue.enqueue({
            task: 'application.apply',
            payload: { jobId: job.id },
            dedupeKey: `application.apply:${job.id}`,
            priority: 10,
          });
        }
      },
    },
    {
      // Mirroring runs on its own cadence so the phone stays fresh without
      // waiting for a collection or apply cycle.
      name: 'sync',
      intervalMinutes: () => Math.max(1, Math.round(settings().sync.intervalSeconds / 60)),
      async run() {
        if (!settings().sync.enabled) return;
        await deps.syncService.flush();
        await deps.syncService.pushQueueStats();
      },
    },
    {
      name: 'commands',
      intervalMinutes: () => Math.max(1, Math.round(settings().sync.commandPollSeconds / 60)),
      async run() {
        if (!settings().sync.enabled) return;
        await deps.commandService.poll();
      },
    },
    {
      // An expired session is the most common silent failure: collectors keep
      // running and quietly return nothing, so it gets its own alert.
      name: 'credentials',
      intervalMinutes: () => 60,
      async run() {
        for (const expired of deps.credentialService.checkExpiry()) {
          await deps.notificationService.credentialExpired(expired.provider);
        }
      },
    },
    {
      name: 'cleanup',
      intervalMinutes: () => settings().scheduler.cleanupIntervalMinutes,
      async run() {
        deps.queue.enqueue({
          task: 'maintenance.cleanup',
          payload: {},
          dedupeKey: `maintenance.cleanup:${new Date().toISOString().slice(0, 10)}`,
        });
      },
    },
    {
      name: 'backup',
      intervalMinutes: () => settings().scheduler.backupIntervalMinutes,
      async run() {
        deps.queue.enqueue({
          task: 'maintenance.backup',
          payload: {},
          dedupeKey: `maintenance.backup:${new Date().toISOString().slice(0, 10)}`,
        });
      },
    },
  ];
}
