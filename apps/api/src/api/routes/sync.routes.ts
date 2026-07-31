import { z } from 'zod';
import { syncStatusSchema } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, type ApiInstance } from '../types.js';

/**
 * Control surface for the Supabase mirror. Only operational metadata ever
 * leaves the host; these routes toggle and inspect that mirror, they never
 * expose documents, profile PII or credentials.
 */
export async function syncRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { sync } = container.services;

  app.get(
    '/sync/status',
    {
      schema: {
        tags: ['sync'],
        summary: 'Sync configuration, reachability and mirror counters',
        response: { 200: syncStatusSchema, ...commonErrors },
      },
    },
    async () => sync.status(),
  );

  app.post(
    '/sync/flush',
    {
      schema: {
        tags: ['sync'],
        summary: 'Push the pending outbox once',
        description:
          'Runs a single flush pass instead of waiting for the scheduler tick. Rows that fail stay in the outbox and are retried.',
        response: {
          200: z.object({ pushed: z.number().int(), failed: z.number().int() }),
          ...commonErrors,
        },
      },
    },
    async () => sync.flush(),
  );

  app.post(
    '/sync/full',
    {
      schema: {
        tags: ['sync'],
        summary: 'Re-enqueue every syncable entity',
        description: 'Rebuilds a wiped or newly paired mirror from local state.',
        response: { 200: z.object({ enqueued: z.number().int() }), ...commonErrors },
      },
    },
    async () => ({ enqueued: await sync.fullResync() }),
  );

  app.post(
    '/sync/test',
    {
      schema: {
        tags: ['sync'],
        summary: 'Probe the configured Supabase project',
        response: {
          200: z.object({ reachable: z.boolean(), error: z.string().nullable() }),
          ...commonErrors,
        },
      },
    },
    async () => sync.test(),
  );

  app.post(
    '/sync/pair',
    {
      schema: {
        tags: ['sync'],
        summary: 'Pair this host with a mobile account',
        description:
          'Stores the Supabase auth user id shown on the phone pairing screen, then reports the resulting sync status.',
        body: z.object({ userId: z.string().uuid() }),
        response: { 200: syncStatusSchema, ...commonErrors },
      },
    },
    async (request) => sync.pair(request.body.userId),
  );
}
