import { z } from 'zod';
import type { QueueTask } from '@deedy/shared';
import type { Logger } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import type { JobRepository } from '../repositories/job.repository.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import type { LlmCallRepository, LogRepository } from '../repositories/observability.repository.js';
import type { ApplicationService } from '../services/application.service.js';
import type { JobService } from '../services/job.service.js';
import type { ResumeService, CoverLetterService } from '../services/resume.service.js';
import type { BackupService } from '../services/backup.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { TaskHandler, TaskHandlerMap } from './worker.js';

const collectPayload = z.object({ collectorId: z.string().min(1) });
const jobPayload = z.object({ jobId: z.number().int().positive() });
const scorePayload = jobPayload.extend({ resumeId: z.number().int().positive().nullable().optional() });
const tailorPayload = jobPayload.extend({
  baseResumeId: z.number().int().positive().nullable().optional(),
  force: z.boolean().optional(),
});
const coverLetterPayload = jobPayload.extend({
  resumeId: z.number().int().positive().nullable().optional(),
});
const applyPayload = jobPayload.extend({
  resumeId: z.number().int().positive().nullable().optional(),
  dryRun: z.boolean().optional(),
  tailorResume: z.boolean().optional(),
  generateCoverLetter: z.boolean().optional(),
});
const companyPayload = z.object({ companyId: z.number().int().positive() });
const emptyPayload = z.object({}).passthrough();

function parse<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ValidationError('Queue payload failed validation', result.error.issues);
  }
  return result.data;
}

export interface HandlerDependencies {
  jobService: JobService;
  resumeService: ResumeService;
  coverLetterService: CoverLetterService;
  applicationService: ApplicationService;
  backupService: BackupService;
  settingsService: SettingsService;
  queue: QueueRepository;
  jobs: JobRepository;
  logs: LogRepository;
  llmCalls: LlmCallRepository;
  logger: Logger;
}

/**
 * Wires every queue task to its service call. Handlers are thin: they validate
 * the payload, delegate, and let the worker own retries and persistence.
 *
 * Every handler receives the worker's abort signal and hands it to the service
 * it calls, so stopping a stage from the dashboard cancels the inference that
 * is running right now instead of waiting for it — and for the calls queued
 * behind it — to finish.
 */
export function createHandlers(deps: HandlerDependencies): TaskHandlerMap {
  const handlers: Record<QueueTask, TaskHandler> = {
    'collect.jobs': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const { collectorId } = parse(collectPayload, payload);
      const summary = await deps.jobService.runCollector(collectorId, signal);

      // Newly collected jobs are queued for scoring immediately.
      if (summary.inserted > 0) {
        const pending = deps.jobs.pendingScoring(summary.inserted);
        for (const job of pending) {
          deps.queue.enqueue({
            task: 'job.enrich',
            payload: { jobId: job.id },
            dedupeKey: `job.enrich:${job.id}`,
            priority: 5,
          });
        }
      }
    },

    // `enrich` runs up to four generations in sequence; the signal cancels the
    // one in flight and stops the rest from starting.
    'job.enrich': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const { jobId } = parse(jobPayload, payload);
      await deps.jobService.enrich(jobId, signal);
      deps.queue.enqueue({
        task: 'job.score',
        payload: { jobId },
        dedupeKey: `job.score:${jobId}`,
        priority: 6,
      });
    },

    'job.score': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const { jobId, resumeId } = parse(scorePayload, payload);
      const result = await deps.jobService.score(jobId, resumeId ?? null, signal);

      const settings = deps.settingsService.get().application;
      if (
        settings.autoApply &&
        result.recommendation === 'apply' &&
        result.score >= settings.minScoreToApply
      ) {
        deps.queue.enqueue({
          task: 'application.apply',
          payload: { jobId },
          dedupeKey: `application.apply:${jobId}`,
          priority: 10,
        });
      }
    },

    // Tailoring is a two-call sequence inside the service; the signal cancels
    // the call in flight and skips the one that would follow it.
    'resume.tailor': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const input = parse(tailorPayload, payload);
      await deps.resumeService.tailorForJob({
        jobId: input.jobId,
        baseResumeId: input.baseResumeId ?? null,
        force: input.force ?? false,
        signal,
      });
    },

    'cover_letter.generate': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const input = parse(coverLetterPayload, payload);
      await deps.coverLetterService.generate({
        jobId: input.jobId,
        resumeId: input.resumeId ?? null,
        signal,
      });
    },

    // The browser session owns its own lifecycle, so an apply in progress
    // finishes its current step; the abort takes effect before the next job.
    'application.apply': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const input = parse(applyPayload, payload);
      await deps.applicationService.apply(input, signal);
    },

    'company.summarize': async (payload, _job, signal) => {
      if (signal.aborted) return;
      const { companyId } = parse(companyPayload, payload);
      await deps.jobService.summarizeCompany(companyId, signal);
    },

    'maintenance.cleanup': async (payload) => {
      parse(emptyPayload, payload ?? {});
      const retentionDays = deps.settingsService.get().scheduler.retentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const removedLogs = deps.logs.purgeBefore(cutoff);
      const removedCalls = deps.llmCalls.purgeBefore(cutoff);
      const removedQueue = deps.queue.purgeCompletedBefore(cutoff);
      deps.logger.info('cleanup finished', {
        cutoff,
        removedLogs,
        removedCalls,
        removedQueue,
      });
    },

    'maintenance.backup': async (payload) => {
      parse(emptyPayload, payload ?? {});
      await deps.backupService.run();
    },
  };

  return handlers;
}
