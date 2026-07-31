import { z } from 'zod';
import { APP_VERSION } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, type ApiInstance } from '../types.js';

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  database: z.boolean(),
  llm: z.object({
    reachable: z.boolean(),
    model: z.string(),
    error: z.string().nullable(),
  }),
  queue: z.object({
    running: z.boolean(),
    paused: z.boolean(),
    pending: z.number().int(),
    active: z.number().int(),
  }),
  scheduler: z.object({
    running: z.boolean(),
    tasks: z.array(z.object({ name: z.string(), nextRunAt: z.string().nullable() })),
  }),
});

export async function healthRoutes(app: ApiInstance, container: Container): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness and dependency status',
        description:
          'Reports database reachability, local LLM reachability, queue depth and scheduler state.',
        response: { 200: healthSchema, ...commonErrors },
      },
    },
    async () => {
      let database = true;
      try {
        container.sqlite.prepare('SELECT 1').get();
      } catch {
        database = false;
      }

      const llm = await container.services.llm
        .health()
        .catch((error: unknown) => ({
          reachable: false,
          model: '',
          error: error instanceof Error ? error.message : String(error),
        }));

      const queueStats = container.repositories.queue.statsByStatus();
      const workerStatus = container.worker.status();
      const settings = container.services.settings.get();

      return {
        status: database && llm.reachable ? ('ok' as const) : ('degraded' as const),
        version: APP_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        database,
        llm,
        queue: {
          running: workerStatus.running,
          paused: settings.queue.paused,
          pending: queueStats.pending,
          active: queueStats.active,
        },
        scheduler: container.scheduler.status(),
      };
    },
  );

  app.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Process liveness probe',
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async () => ({ ok: true as const }),
  );
}
