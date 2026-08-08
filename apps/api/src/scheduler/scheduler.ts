import type { PipelineStage } from '@deedy/shared';
import type { Logger } from '../core/logger.js';
import { toErrorMessage } from '../core/errors.js';
import { isPipelineStageEnabled } from '../queue/worker.js';
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
  resumes: TailoredResumeLookup;
  coverLetters: CoverLetterLookup;
}

/**
 * Read-only structural views of the document repositories. The backfill only
 * ever asks "does this job already have one?", so it takes the two lookups
 * rather than the repositories — nothing in the scheduler may write a document.
 */
export interface TailoredResumeLookup {
  tailoredFor(jobId: number, parentId: number): { id: number } | undefined;
  defaultResume(): { id: number } | undefined;
}

export interface CoverLetterLookup {
  latestForJob(jobId: number): { id: number } | undefined;
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

/**
 * How many already-scored jobs the document backfill inspects per tick. Every
 * one it enqueues is two model calls and a LaTeX compile on this host, so the
 * backlog is drained a slice at a time rather than dumped into the queue at
 * once — the ticks keep coming until it is empty.
 */
const DOCUMENT_BACKFILL_BATCH = 10;

/** The standard set of recurring jobs that keep the pipeline moving. */
export function createScheduledTasks(deps: SchedulerTaskDependencies): ScheduledTask[] {
  const settings = () => deps.settingsService.get();
  /**
   * A stopped stage must not accumulate a backlog while it is off, so the
   * scheduler stops enqueuing for it too. This is the coarse half of the
   * switch; the worker enforces the fine half by refusing to claim.
   */
  const stageRuns = (stage: PipelineStage) => isPipelineStageEnabled(settings().pipeline, stage);

  return [
    {
      name: 'collect',
      intervalMinutes: () => settings().scheduler.collectIntervalMinutes,
      async run() {
        if (!stageRuns('collect')) return;
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
        // The task is named for scoring but everything it enqueues is a
        // `job.enrich`, so the enrich switch alone decides. Gating on `score`
        // too would mean stopping scoring — the obvious way to free the LLM —
        // silently starved enrichment as well, even with its own switch on.
        if (!stageRuns('enrich')) return;
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
        if (!stageRuns('apply')) return;
        const application = settings().application;
        if (!application.autoApply) return;

        // Re-queue anything a crash left half-finished before starting new work.
        deps.applicationService.recoverStuck();

        const candidates = deps.jobs.readyToApply(application.minScoreToApply, 25);
        for (const job of candidates) {
          // Score says the model liked it; the keyword gate says the user's own
          // vocabulary recognises it. Both automatic paths ask the same method.
          if (!deps.applicationService.allowsAutoApply(job)) continue;
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
      /**
       * Backfill for jobs that were scored before `job.score` learned to chain
       * `resume.tailor` -> `cover_letter.generate`. Those rows are already
       * `scored`, so nothing else will ever revisit them: without this task the
       * only way to get their documents is to re-score each one by hand.
       *
       * It shares `applyIntervalMinutes` rather than getting a setting of its
       * own. The cadence it wants is the apply task's — a slow sweep over
       * already-scored jobs, hours apart, not the minutes-apart scoring loop —
       * and a backlog that is finite by definition does not justify a new knob
       * on the Settings page that every user would have to understand.
       */
      name: 'documents',
      intervalMinutes: () => settings().scheduler.applyIntervalMinutes,
      async run() {
        const application = settings().application;
        // Each half is its own toggle AND its own stage switch: the switch is
        // how the user hands the CPU back, so a stopped stage must not have work
        // piled behind it while it is off.
        const wantsResume = application.tailorResume && stageRuns('tailor');
        const wantsLetter = application.generateCoverLetter && stageRuns('cover_letter');
        if (!wantsResume && !wantsLetter) return;

        // The same criteria the `job.score` handler applies inline: scored, not
        // archived, at or above the tailoring threshold. Jobs the model told us
        // to skip never reach status `scored`, so they are excluded already.
        const candidates = deps.jobs.search({
          status: 'scored',
          minScore: application.minScoreToTailor,
          archived: false,
          page: 1,
          pageSize: DOCUMENT_BACKFILL_BATCH,
          sort: 'score',
          order: 'desc',
        }).items;

        // `tailoredFor` is keyed by the base the tailoring descended from, so the
        // resolution has to match what `resume.tailor` will itself resolve —
        // Settings' default id when set, otherwise the default base resume.
        const baseResumeId = application.defaultResumeId ?? deps.resumes.defaultResume()?.id ?? null;

        for (const job of candidates) {
          // A tailoring pass is two model calls and a LaTeX compile. The gate's
          // whole claim is that the user would never apply to this posting, so
          // the automatic path must ask it here exactly as scoring does.
          if (!deps.applicationService.allowsAutoApply(job)) continue;

          const tailored =
            baseResumeId === null ? undefined : deps.resumes.tailoredFor(job.id, baseResumeId);

          if (wantsResume && !tailored) {
            // Same task, same payload shape and the same dedupe key scoring
            // uses, so a job that gets re-scored between two ticks lands on the
            // one queue row instead of tailoring twice.
            deps.queue.enqueue({
              task: 'resume.tailor',
              payload: {
                jobId: job.id,
                baseResumeId: application.defaultResumeId,
                coverLetter: wantsLetter,
              },
              dedupeKey: `resume.tailor:${job.id}:${application.defaultResumeId ?? 'default'}`,
              priority: 8,
            });
            // The letter is chained by the tailor handler off the resume it
            // produces; enqueuing one here too would write it against the base.
            continue;
          }

          if (wantsLetter && !deps.coverLetters.latestForJob(job.id)) {
            deps.queue.enqueue({
              task: 'cover_letter.generate',
              // The resume that will actually be uploaded, when there is one —
              // the same id the tailor handler passes when it chains the letter.
              payload: { jobId: job.id, resumeId: tailored?.id ?? null },
              dedupeKey: `cover_letter.generate:${job.id}`,
              priority: 7,
            });
          }
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
