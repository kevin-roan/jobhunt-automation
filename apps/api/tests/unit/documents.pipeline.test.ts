import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type JobDto, type JobQuery, type Settings } from '@deedy/shared';
import type { JobRepository } from '../../src/repositories/job.repository.js';
import type { QueueRepository } from '../../src/repositories/queue.repository.js';
import type { ApplicationService } from '../../src/services/application.service.js';
import {
  createScheduledTasks,
  type SchedulerTaskDependencies,
} from '../../src/scheduler/scheduler.js';
import { documentRoutes } from '../../src/api/routes/documents.routes.js';
import type { Container } from '../../src/core/container.js';
import type { ApiInstance } from '../../src/api/types.js';

interface Enqueued {
  task: string;
  payload: Record<string, unknown>;
  dedupeKey: string | undefined;
  priority: number | undefined;
}

function scoredJob(id: number): JobDto {
  return {
    id,
    title: 'Senior Backend Engineer',
    company: 'Analytical Engines',
    source: 'linkedin',
    skills: ['Postgres'],
    score: 88,
  } as unknown as JobDto;
}

/**
 * The backfill exists for rows nothing else will revisit, so every case here is
 * about what it does NOT enqueue: a task that re-tailors on every tick would
 * spend the host's CPU forever on jobs that are already done.
 */
describe('scheduler documents backfill', () => {
  interface BackfillHarness {
    run: () => Promise<void>;
    enqueued: Enqueued[];
    queries: JobQuery[];
  }

  function backfill(options: {
    eligible?: boolean;
    jobs?: JobDto[];
    tailored?: { id: number } | undefined;
    letter?: { id: number } | undefined;
    application?: Partial<Settings['application']>;
    pipeline?: Partial<Settings['pipeline']>;
  }): BackfillHarness {
    const enqueued: Enqueued[] = [];
    const queries: JobQuery[] = [];
    const pool = options.jobs ?? [scoredJob(5)];

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      application: { ...DEFAULT_SETTINGS.application, ...options.application },
      pipeline: { ...DEFAULT_SETTINGS.pipeline, ...options.pipeline },
    };

    const tasks = createScheduledTasks({
      queue: {
        enqueue: (input: Enqueued) => {
          enqueued.push(input);
          return { id: enqueued.length };
        },
      } as unknown as QueueRepository,
      jobs: {
        search: (query: JobQuery) => {
          queries.push(query);
          // Sliced like the real query so a task that forgets its page size
          // cannot pass by asking for everything.
          const items = pool.slice(0, query.pageSize);
          return { items, total: pool.length, page: 1, pageSize: query.pageSize, totalPages: 1 };
        },
      } as unknown as JobRepository,
      applicationService: {
        allowsAutoApply: () => options.eligible ?? true,
      } as unknown as ApplicationService,
      resumes: {
        defaultResume: () => ({ id: 1 }),
        tailoredFor: () => options.tailored,
      },
      coverLetters: {
        latestForJob: () => options.letter,
      },
      settingsService: { get: () => settings },
    } as unknown as SchedulerTaskDependencies);

    const task = tasks.find((entry) => entry.name === 'documents');
    if (!task) throw new Error('documents task is not registered');
    return { enqueued, queries, run: () => task.run() };
  }

  it('enqueues a tailoring for an eligible scored job with no documents', async () => {
    const h = backfill({});
    await h.run();

    expect(h.enqueued).toHaveLength(1);
    // The payload, dedupe key and priority the `job.score` handler would have
    // used, so a re-score between two ticks collapses onto the same queue row.
    expect(h.enqueued[0]).toMatchObject({
      task: 'resume.tailor',
      payload: { jobId: 5, baseResumeId: null, coverLetter: true },
      dedupeKey: 'resume.tailor:5:default',
      priority: 8,
    });
  });

  it('asks only for scored jobs at or above the tailoring threshold', async () => {
    const h = backfill({ application: { minScoreToTailor: 72 } });
    await h.run();

    expect(h.queries[0]).toMatchObject({ status: 'scored', minScore: 72, archived: false });
  });

  it('skips a job that already has both documents', async () => {
    const h = backfill({ tailored: { id: 42 }, letter: { id: 7 } });
    await h.run();
    expect(h.enqueued).toEqual([]);
  });

  it('generates only the missing letter when the tailored resume already exists', async () => {
    const h = backfill({ tailored: { id: 42 } });
    await h.run();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      task: 'cover_letter.generate',
      // The resume the application would upload, not the base document.
      payload: { jobId: 5, resumeId: 42 },
      dedupeKey: 'cover_letter.generate:5',
      priority: 7,
    });
  });

  it('does not enqueue a letter beside the tailoring it just queued', async () => {
    // The tailor handler chains the letter off the resume it produces; a second
    // one enqueued here would argue from the base resume and win the dedupe key.
    const h = backfill({});
    await h.run();
    expect(h.enqueued.map((row) => row.task)).toEqual(['resume.tailor']);
  });

  it('enqueues nothing for a job the keyword gate refuses', async () => {
    const h = backfill({ eligible: false });
    await h.run();
    expect(h.enqueued).toEqual([]);
  });

  it('respects the tailor stage switch, falling through to the letter', async () => {
    const h = backfill({ pipeline: { tailor: false } });
    await h.run();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      task: 'cover_letter.generate',
      payload: { jobId: 5, resumeId: null },
    });
  });

  it('does not ask the cover letter stage to run while it is stopped', async () => {
    const h = backfill({ pipeline: { coverLetter: false } });
    await h.run();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      task: 'resume.tailor',
      payload: { coverLetter: false },
    });
  });

  it('does nothing at all when both stages are stopped', async () => {
    const h = backfill({ pipeline: { tailor: false, coverLetter: false } });
    await h.run();

    expect(h.enqueued).toEqual([]);
    // Not even the query: a stopped pipeline should cost nothing per tick.
    expect(h.queries).toEqual([]);
  });

  it('does nothing when both document toggles are off', async () => {
    const h = backfill({ application: { tailorResume: false, generateCoverLetter: false } });
    await h.run();
    expect(h.enqueued).toEqual([]);
  });

  it('generates letters directly when tailoring is switched off in Settings', async () => {
    const h = backfill({ application: { tailorResume: false } });
    await h.run();
    expect(h.enqueued.map((row) => row.task)).toEqual(['cover_letter.generate']);
  });

  it('bounds the batch, leaving the rest of the backlog for the next tick', async () => {
    const pool = Array.from({ length: 60 }, (_, index) => scoredJob(index + 1));
    const h = backfill({ jobs: pool });
    await h.run();

    // Each of these is two model calls and a LaTeX compile on this host.
    expect(h.queries[0]?.pageSize).toBe(10);
    expect(h.enqueued).toHaveLength(10);
  });
});

/**
 * The manual route has to reach the same resume the automatic chain reaches, or
 * a letter generated from the dashboard argues from a document the application
 * never uploads.
 */
describe('POST /cover-letters', () => {
  interface RouteHarness {
    post: (body: Record<string, unknown>) => Promise<{ statusCode: number }>;
    resumeIds: (number | null | undefined)[];
  }

  async function routeHarness(options: {
    tailored?: { id: number; compileOk: boolean };
    defaultResumeId?: number | null;
  }): Promise<RouteHarness> {
    const resumeIds: (number | null | undefined)[] = [];
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      application: {
        ...DEFAULT_SETTINGS.application,
        defaultResumeId: options.defaultResumeId ?? null,
      },
    };

    const container = {
      config: { paths: { root: tmpdir() } },
      repositories: {
        resumes: {
          defaultResume: () => ({ id: 1 }),
          tailoredFor: () => options.tailored,
        },
        coverLetters: {},
        applications: {},
      },
      services: {
        settings: { get: () => settings },
        coverLetters: {
          generate: (input: { resumeId?: number | null }) => {
            resumeIds.push(input.resumeId);
            return Promise.resolve({
              id: 9,
              jobId: 5,
              applicationId: null,
              resumeId: input.resumeId ?? null,
              subject: 'Application for Senior Backend Engineer',
              body: 'REDACTED',
              tone: null,
              version: 1,
              model: null,
              pdfPath: null,
              createdAt: new Date().toISOString(),
            });
          },
        },
      },
    } as unknown as Container;

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await documentRoutes(app.withTypeProvider<ZodTypeProvider>() as ApiInstance, container);
    await app.ready();

    return {
      resumeIds,
      post: (body) => app.inject({ method: 'POST', url: '/cover-letters', payload: body }),
    };
  }

  it('writes the letter against the resume already tailored for the job', async () => {
    const h = await routeHarness({ tailored: { id: 42, compileOk: true } });

    const response = await h.post({ jobId: 5 });

    expect(response.statusCode).toBe(201);
    expect(h.resumeIds).toEqual([42]);
  });

  it('falls back to the base resume when the job has no tailored version', async () => {
    const h = await routeHarness({});

    await h.post({ jobId: 5 });

    // Null, not an id: the service owns the "which base?" decision.
    expect(h.resumeIds).toEqual([null]);
  });

  it('ignores a tailored resume that did not compile', async () => {
    // That PDF is never uploaded, so a letter describing it would be wrong.
    const h = await routeHarness({ tailored: { id: 42, compileOk: false } });

    await h.post({ jobId: 5 });

    expect(h.resumeIds).toEqual([null]);
  });

  it('lets an explicit resume id win over the tailored one', async () => {
    const h = await routeHarness({ tailored: { id: 42, compileOk: true } });

    await h.post({ jobId: 5, resumeId: 7 });

    expect(h.resumeIds).toEqual([7]);
  });
});
