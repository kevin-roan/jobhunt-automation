import { z } from 'zod';
import {
  answerBankDtoSchema,
  applicationDtoSchema,
  applicationEventDtoSchema,
  applicationStatusSchema,
  applyNowSchema,
  artifactDtoSchema,
  paginationSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import {
  toApplicationEventDto,
  toArtifactDto,
} from '../../repositories/application.repository.js';
import { commonErrors, idParamSchema, okSchema, paginatedSchema, type ApiInstance } from '../types.js';

export async function applicationRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { applications, answerBank, jobs } = container.repositories;

  app.get(
    '/applications',
    {
      schema: {
        tags: ['applications'],
        summary: 'List applications',
        querystring: paginationSchema.extend({
          status: applicationStatusSchema.optional(),
          jobId: z.coerce.number().int().positive().optional(),
        }),
        response: { 200: paginatedSchema(applicationDtoSchema), ...commonErrors },
      },
    },
    async (request) => applications.search(request.query),
  );

  app.get(
    '/applications/:id',
    {
      schema: {
        tags: ['applications'],
        summary: 'Read one application with its full step history',
        params: idParamSchema,
        response: {
          200: applicationDtoSchema.extend({
            events: z.array(applicationEventDtoSchema),
            artifacts: z.array(artifactDtoSchema),
            answers: z.array(
              z.object({
                id: z.number().int(),
                question: z.string(),
                answer: z.string(),
                fieldType: z.string(),
                source: z.string(),
                confidence: z.number().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const row = applications.byId(request.params.id);
      if (!row) throw new NotFoundError('Application', request.params.id);
      const job = jobs.byId(row.jobId);
      return {
        ...applications.toDto(row, job?.title ?? null, job?.company ?? null, job?.source ?? null),
        events: applications.events(row.id).map(toApplicationEventDto),
        artifacts: applications.artifactsFor(row.id).map(toArtifactDto),
        answers: applications.answers(row.id).map((answer) => ({
          id: answer.id,
          question: answer.question,
          answer: answer.answer,
          fieldType: answer.fieldType,
          source: answer.source,
          confidence: answer.confidence,
          createdAt: answer.createdAt,
        })),
      };
    },
  );

  app.post(
    '/applications/apply',
    {
      schema: {
        tags: ['applications'],
        summary: 'Queue an application for a job',
        description:
          'Enqueues the browser pipeline. Set immediate=true to run it synchronously (useful for debugging a single posting).',
        body: applyNowSchema.extend({ immediate: z.boolean().default(false) }),
        response: {
          200: z.object({
            queued: z.boolean(),
            queueJobId: z.number().int().nullable(),
            applicationId: z.number().int().nullable(),
            status: z.string().nullable(),
            submitted: z.boolean().nullable(),
            needsHuman: z.string().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const { immediate, ...input } = request.body;
      if (!jobs.byId(input.jobId)) throw new NotFoundError('Job', input.jobId);

      if (immediate) {
        const result = await container.services.applications.apply(input);
        return {
          queued: false,
          queueJobId: null,
          applicationId: result.applicationId,
          status: result.status,
          submitted: result.submitted,
          needsHuman: result.needsHuman,
        };
      }

      const queued = container.repositories.queue.enqueue({
        task: 'application.apply',
        payload: input,
        dedupeKey: `application.apply:${input.jobId}`,
        priority: 10,
      });
      return {
        queued: true,
        queueJobId: queued.id,
        applicationId: null,
        status: null,
        submitted: null,
        needsHuman: null,
      };
    },
  );

  app.post(
    '/applications/:id/retry',
    {
      schema: {
        tags: ['applications'],
        summary: 'Retry a failed application',
        params: idParamSchema,
        response: { 200: z.object({ queueJobId: z.number().int() }), ...commonErrors },
      },
    },
    async (request) => {
      const row = applications.byId(request.params.id);
      if (!row) throw new NotFoundError('Application', request.params.id);
      applications.update(row.id, { status: 'pending', error: null });
      const queued = container.repositories.queue.enqueue({
        task: 'application.apply',
        payload: { jobId: row.jobId },
        dedupeKey: `application.apply:${row.jobId}`,
        priority: 12,
      });
      return { queueJobId: queued.id };
    },
  );

  app.patch(
    '/applications/:id',
    {
      schema: {
        tags: ['applications'],
        summary: 'Update an application status',
        description:
          'Used to record real-world outcomes such as interview, rejection or offer.',
        params: idParamSchema,
        body: z.object({ status: applicationStatusSchema }),
        response: { 200: applicationDtoSchema, ...commonErrors },
      },
    },
    async (request) => {
      const row = applications.byId(request.params.id);
      if (!row) throw new NotFoundError('Application', request.params.id);
      applications.setStatus(row.id, request.body.status);
      const updated = applications.byId(row.id);
      if (!updated) throw new NotFoundError('Application', request.params.id);
      const job = jobs.byId(updated.jobId);
      return applications.toDto(
        updated,
        job?.title ?? null,
        job?.company ?? null,
        job?.source ?? null,
      );
    },
  );

  app.get(
    '/answers',
    {
      schema: {
        tags: ['applications'],
        summary: 'List the saved answer bank',
        response: { 200: z.object({ answers: z.array(answerBankDtoSchema) }), ...commonErrors },
      },
    },
    async () => ({ answers: answerBank.list() }),
  );

  app.post(
    '/answers',
    {
      schema: {
        tags: ['applications'],
        summary: 'Teach the answer bank a question/answer pair',
        body: z.object({
          question: z.string().min(1),
          answer: z.string(),
          fieldType: z.string().default('text'),
        }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      container.services.applications.saveAnswer(
        request.body.question,
        request.body.answer,
        request.body.fieldType,
      );
      return { ok: true as const };
    },
  );

  app.delete(
    '/answers/:id',
    {
      schema: {
        tags: ['applications'],
        summary: 'Forget a saved answer',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      answerBank.delete(request.params.id);
      return { ok: true as const };
    },
  );
}
