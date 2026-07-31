import { z } from 'zod';
import {
  browserSessionDtoSchema,
  collectorDtoSchema,
  collectorRunDtoSchema,
  paginationSchema,
  queueJobDtoSchema,
  queueStatusSchema,
  queueTaskSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { toQueueJobDto } from '../../repositories/queue.repository.js';
import {
  toBrowserSessionDto,
  toCollectorRunDto,
} from '../../repositories/browser.repository.js';
import { commonErrors, idParamSchema, okSchema, paginatedSchema, type ApiInstance } from '../types.js';

export async function operationsRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { queue, browserSessions, collectorRuns } = container.repositories;

  app.get(
    '/queue',
    {
      schema: {
        tags: ['queue'],
        summary: 'List queued, running and finished background jobs',
        querystring: paginationSchema.extend({
          status: queueStatusSchema.optional(),
          task: queueTaskSchema.optional(),
        }),
        response: { 200: paginatedSchema(queueJobDtoSchema), ...commonErrors },
      },
    },
    async (request) => queue.search(request.query),
  );

  app.get(
    '/queue/stats',
    {
      schema: {
        tags: ['queue'],
        summary: 'Queue depth by status and by task',
        response: {
          200: z.object({
            byStatus: z.record(z.string(), z.number().int()),
            byTask: z.array(
              z.object({ task: z.string(), status: z.string(), value: z.number().int() }),
            ),
            worker: z.object({
              running: z.boolean(),
              inFlight: z.number().int(),
              workerId: z.string(),
            }),
          }),
          ...commonErrors,
        },
      },
    },
    async () => ({
      byStatus: queue.statsByStatus(),
      byTask: queue.statsByTask(),
      worker: container.worker.status(),
    }),
  );

  app.get(
    '/queue/:id',
    {
      schema: {
        tags: ['queue'],
        summary: 'Read a queue job with its full retry history',
        params: idParamSchema,
        response: {
          200: queueJobDtoSchema.extend({
            attempts_history: z.array(
              z.object({
                id: z.number().int(),
                attempt: z.number().int(),
                status: z.string(),
                error: z.string().nullable(),
                durationMs: z.number().int().nullable(),
                startedAt: z.string(),
                finishedAt: z.string().nullable(),
              }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const row = queue.byId(request.params.id);
      if (!row) throw new NotFoundError('Queue job', request.params.id);
      return { ...toQueueJobDto(row), attempts_history: queue.attempts(row.id) };
    },
  );

  app.post(
    '/queue/:id/retry',
    {
      schema: {
        tags: ['queue'],
        summary: 'Reset a queue job so it runs again',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      if (!queue.byId(request.params.id)) throw new NotFoundError('Queue job', request.params.id);
      queue.retry(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/queue/:id/cancel',
    {
      schema: {
        tags: ['queue'],
        summary: 'Cancel a pending queue job',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      if (!queue.byId(request.params.id)) throw new NotFoundError('Queue job', request.params.id);
      queue.cancel(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/queue/retry-failed',
    {
      schema: {
        tags: ['queue'],
        summary: 'Re-arm every failed queue job',
        response: { 200: z.object({ retried: z.number().int() }), ...commonErrors },
      },
    },
    async () => ({ retried: queue.retryAllFailed() }),
  );

  app.get(
    '/collectors',
    {
      schema: {
        tags: ['collectors'],
        summary: 'List registered job collectors, including plugins',
        response: {
          200: z.object({
            collectors: z.array(collectorDtoSchema),
            planned: z.array(z.string()),
          }),
          ...commonErrors,
        },
      },
    },
    async () => {
      const settings = container.services.settings.get();
      const planned = new Set(container.services.jobs.plannedCollectors());
      return {
        collectors: container.collectors.all().map((collector) => ({
          id: collector.id,
          name: collector.name,
          source: collector.source,
          description: collector.description,
          requiresAuth: collector.requiresAuth,
          requiresBoards: collector.requiresBoards,
          builtIn: collector.builtIn ?? false,
          enabled:
            settings.search.enabledCollectors.length > 0
              ? settings.search.enabledCollectors.includes(collector.id)
              : planned.has(collector.id),
        })),
        planned: Array.from(planned),
      };
    },
  );

  app.post(
    '/collectors/:collectorId/run',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Run a collector now',
        params: z.object({ collectorId: z.string().min(1) }),
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
      const collectorId = request.params.collectorId;
      if (!container.collectors.get(collectorId)) throw new NotFoundError('Collector', collectorId);

      if (request.body.immediate) {
        return { queueJobId: null, summary: await container.services.jobs.runCollector(collectorId) };
      }
      const queued = queue.enqueue({
        task: 'collect.jobs',
        payload: { collectorId },
        dedupeKey: `collect.jobs:${collectorId}`,
        priority: 4,
      });
      return { queueJobId: queued.id, summary: null };
    },
  );

  app.get(
    '/collectors/runs',
    {
      schema: {
        tags: ['collectors'],
        summary: 'Recent collector runs',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ runs: z.array(collectorRunDtoSchema) }), ...commonErrors },
      },
    },
    async (request) => ({ runs: collectorRuns.recent(request.query.limit).map(toCollectorRunDto) }),
  );

  app.get(
    '/browser-sessions',
    {
      schema: {
        tags: ['browser'],
        summary: 'List persistent browser profiles',
        response: {
          200: z.object({
            sessions: z.array(browserSessionDtoSchema),
            open: z.array(z.string()),
          }),
          ...commonErrors,
        },
      },
    },
    async () => ({
      sessions: browserSessions.list().map(toBrowserSessionDto),
      open: container.browser.openProviders(),
    }),
  );

  app.post(
    '/browser-sessions/:provider/open',
    {
      schema: {
        tags: ['browser'],
        summary: 'Open a provider profile so you can sign in once',
        description:
          'Launches the persistent context and navigates to the provider. Run with headless disabled in Settings to complete a login; the session is then reused forever.',
        params: z.object({ provider: z.string().min(1) }),
        body: z.object({ url: z.string().url().optional() }),
        response: {
          200: z.object({ provider: z.string(), url: z.string(), loggedIn: z.boolean() }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const provider = request.params.provider;
      const url = request.body.url ?? `https://www.${provider}.com/login`;
      const page = await container.browser.newPage(provider);
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      const finalUrl = page.url();
      const loggedIn = !/login|signin|authwall/i.test(finalUrl);
      browserSessions.setLoggedIn(provider, loggedIn, `last opened ${finalUrl}`);
      await container.browser.saveStorageState(provider);
      return { provider, url: finalUrl, loggedIn };
    },
  );

  app.delete(
    '/browser-sessions/:provider',
    {
      schema: {
        tags: ['browser'],
        summary: 'Close a browser profile session record',
        params: z.object({ provider: z.string().min(1) }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      await container.browser.closeProvider(request.params.provider);
      browserSessions.delete(request.params.provider);
      return { ok: true as const };
    },
  );

  app.get(
    '/backups',
    {
      schema: {
        tags: ['queue'],
        summary: 'List database backups',
        response: {
          200: z.object({
            backups: z.array(
              z.object({ name: z.string(), bytes: z.number().int(), createdAt: z.string() }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async () => ({ backups: container.services.backups.list() }),
  );

  app.post(
    '/backups',
    {
      schema: {
        tags: ['queue'],
        summary: 'Take a database backup now',
        response: {
          200: z.object({ path: z.string(), bytes: z.number().int(), removed: z.number().int() }),
          ...commonErrors,
        },
      },
    },
    async () => container.services.backups.run(),
  );

  app.post(
    '/scheduler/:name/run',
    {
      schema: {
        tags: ['queue'],
        summary: 'Run a scheduled task immediately',
        params: z.object({ name: z.string().min(1) }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      await container.scheduler.runNow(request.params.name);
      return { ok: true as const };
    },
  );
}
