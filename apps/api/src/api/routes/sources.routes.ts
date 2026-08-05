import { z } from 'zod';
import { sourceStatusDtoSchema } from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { commonErrors, okSchema, type ApiInstance } from '../types.js';

const sourceParamsSchema = z.object({ id: z.string().min(1) });

export async function sourceRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { queue } = container.repositories;
  const { sources, keywords } = container.services;

  app.get(
    '/sources',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Per-source dashboard: session health, last run and yield',
        description:
          'One tile per platform, including whether its stored session is still valid. A source failing silently on an expired cookie is the failure this view exists to surface.',
        response: {
          200: z.object({ sources: z.array(sourceStatusDtoSchema) }),
          ...commonErrors,
        },
      },
    },
    // Keyword counting is injected rather than imported by the source service so
    // the two stay independent; the route is the only place that knows both.
    async () => ({ sources: sources.list((id: string) => keywords.activeFor(id).length) }),
  );

  app.post(
    '/sources/:id/run',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Run a source now',
        description:
          'Queues a collect run by default. Pass immediate to run it inline and get the summary back in this response, at the cost of holding the request open for the whole collection.',
        params: sourceParamsSchema,
        body: z.object({ immediate: z.boolean().default(false) }),
        response: {
          200: z.object({
            queueJobId: z.number().int().nullable(),
            summary: z
              .object({
                collectorId: z.string(),
                found: z.number().int(),
                inserted: z.number().int(),
                duplicates: z.number().int(),
                errors: z.number().int(),
                message: z.string().nullable(),
              })
              .nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const collectorId = request.params.id;
      if (!container.collectors.get(collectorId)) throw new NotFoundError('Collector', collectorId);

      if (request.body.immediate) {
        return { queueJobId: null, summary: await container.services.jobs.runCollector(collectorId) };
      }
      // The dedupe key collapses repeated clicks into the one pending job.
      const queued = queue.enqueue({
        task: 'collect.jobs',
        payload: { collectorId },
        dedupeKey: `collect.jobs:${collectorId}`,
        priority: 4,
      });
      return { queueJobId: queued.id, summary: null };
    },
  );

  app.post(
    '/sources/:id/stop',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Stop this source and cancel its queued collect runs',
        description:
          'Returns how many queue jobs were cancelled. In-flight work is aborted and returned to pending, so nothing is lost.',
        params: sourceParamsSchema,
        response: { 200: z.object({ cancelled: z.number().int() }), ...commonErrors },
      },
    },
    async (request) => {
      const collectorId = request.params.id;
      if (!container.collectors.get(collectorId)) throw new NotFoundError('Collector', collectorId);
      return { cancelled: sources.stop(collectorId) };
    },
  );

  app.post(
    '/sources/:id/enabled',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Enable or disable a source',
        params: sourceParamsSchema,
        body: z.object({ enabled: z.boolean() }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      const collectorId = request.params.id;
      if (!container.collectors.get(collectorId)) throw new NotFoundError('Collector', collectorId);
      sources.setEnabled(collectorId, request.body.enabled);
      return { ok: true as const };
    },
  );
}
