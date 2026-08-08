import { z } from 'zod';
import {
  notificationDtoSchema,
  notificationKindSchema,
  paginationSchema,
  queryBooleanSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { commonErrors, idParamSchema, okSchema, paginatedSchema, type ApiInstance } from '../types.js';

export async function notificationRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { notifications } = container.repositories;

  app.get(
    '/notifications',
    {
      schema: {
        tags: ['observability'],
        summary: 'List notifications, newest first',
        querystring: paginationSchema.extend({
          unreadOnly: queryBooleanSchema.optional(),
          kind: notificationKindSchema.optional(),
        }),
        response: { 200: paginatedSchema(notificationDtoSchema), ...commonErrors },
      },
    },
    async (request) => notifications.list(request.query),
  );

  app.get(
    '/notifications/unread-count',
    {
      schema: {
        tags: ['observability'],
        summary: 'Number of unread notifications, for the dashboard badge',
        response: { 200: z.object({ count: z.number().int() }), ...commonErrors },
      },
    },
    async () => ({ count: notifications.unreadCount() }),
  );

  app.post(
    '/notifications/:id/read',
    {
      schema: {
        tags: ['observability'],
        summary: 'Mark one notification as read',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      if (!notifications.byId(request.params.id)) {
        throw new NotFoundError('Notification', request.params.id);
      }
      notifications.markRead(request.params.id);
      return { ok: true as const };
    },
  );

  app.post(
    '/notifications/read-all',
    {
      schema: {
        tags: ['observability'],
        summary: 'Mark every unread notification as read',
        response: { 200: z.object({ updated: z.number().int() }), ...commonErrors },
      },
    },
    async () => ({ updated: notifications.markAllRead() }),
  );

  app.delete(
    '/notifications/:id',
    {
      schema: {
        tags: ['observability'],
        summary: 'Delete one notification from the feed',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      if (!notifications.byId(request.params.id)) {
        throw new NotFoundError('Notification', request.params.id);
      }
      notifications.delete(request.params.id);
      return { ok: true as const };
    },
  );
}
