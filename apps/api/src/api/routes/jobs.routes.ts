import { z } from 'zod';
import {
  jobDtoSchema,
  jobQuerySchema,
  jobScoreDtoSchema,
  jobStatusSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { toJobDto } from '../../repositories/job.repository.js';
import { commonErrors, idParamSchema, okSchema, paginatedSchema, type ApiInstance } from '../types.js';

const jobDetailSchema = jobDtoSchema.extend({
  raw: z.unknown().nullable(),
  scores: z.array(jobScoreDtoSchema),
  applicationId: z.number().int().nullable(),
});

export async function jobRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { jobs } = container.repositories;

  app.get(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Search collected jobs',
        querystring: jobQuerySchema,
        response: { 200: paginatedSchema(jobDtoSchema), ...commonErrors },
      },
    },
    async (request) => jobs.search(request.query),
  );

  app.get(
    '/jobs/sources',
    {
      schema: {
        tags: ['jobs'],
        summary: 'List the sources that have produced jobs',
        response: { 200: z.object({ sources: z.array(z.string()) }), ...commonErrors },
      },
    },
    async () => ({ sources: jobs.distinctSources() }),
  );

  app.get(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Read one job with its scoring history',
        params: idParamSchema,
        response: { 200: jobDetailSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = jobs.byId(request.params.id);
      if (!row) throw new NotFoundError('Job', request.params.id);
      const application = container.repositories.applications.byJobId(row.id);
      return {
        ...toJobDto(row),
        raw: row.raw ?? null,
        scores: jobs.scoresForJob(row.id),
        applicationId: application?.id ?? null,
      };
    },
  );

  app.patch(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Update a job status or archive it',
        params: idParamSchema,
        body: z.object({
          status: jobStatusSchema.optional(),
          archived: z.boolean().optional(),
        }),
        response: { 200: jobDtoSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = jobs.byId(request.params.id);
      if (!row) throw new NotFoundError('Job', request.params.id);
      if (request.body.status) jobs.setStatus(row.id, request.body.status);
      if (request.body.archived !== undefined) jobs.setArchived(row.id, request.body.archived);
      const updated = jobs.byId(row.id);
      if (!updated) throw new NotFoundError('Job', request.params.id);
      return toJobDto(updated);
    },
  );

  app.delete(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Delete a job and everything derived from it',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      jobs.delete(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/jobs/:id/score',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Queue an LLM scoring pass for a job',
        params: idParamSchema,
        body: z.object({
          resumeId: z.number().int().positive().nullable().optional(),
          immediate: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            queued: z.boolean(),
            queueJobId: z.number().int().nullable(),
            score: z.number().nullable(),
            recommendation: z.string().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const jobId = request.params.id;
      if (!jobs.byId(jobId)) throw new NotFoundError('Job', jobId);

      if (request.body.immediate) {
        const result = await container.services.jobs.score(jobId, request.body.resumeId ?? null);
        return {
          queued: false,
          queueJobId: null,
          score: result.score,
          recommendation: result.recommendation,
        };
      }

      const queued = container.repositories.queue.enqueue({
        task: 'job.score',
        payload: { jobId, resumeId: request.body.resumeId ?? null },
        dedupeKey: `job.score:${jobId}`,
        priority: 8,
      });
      return { queued: true, queueJobId: queued.id, score: null, recommendation: null };
    },
  );

  app.post(
    '/jobs/:id/enrich',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Queue skill extraction, classification and summarization for a job',
        params: idParamSchema,
        response: { 200: z.object({ queueJobId: z.number().int() }), ...commonErrors },
      },
    },
    async (request) => {
      const jobId = request.params.id;
      if (!jobs.byId(jobId)) throw new NotFoundError('Job', jobId);
      const queued = container.repositories.queue.enqueue({
        task: 'job.enrich',
        payload: { jobId },
        dedupeKey: `job.enrich:${jobId}`,
        priority: 7,
      });
      return { queueJobId: queued.id };
    },
  );

  app.get(
    '/jobs/:id/scores',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Scoring history for a job',
        params: idParamSchema,
        response: { 200: z.object({ scores: z.array(jobScoreDtoSchema) }), ...commonErrors },
      },
    },
    async (request) => ({ scores: jobs.scoresForJob(request.params.id) }),
  );
}
