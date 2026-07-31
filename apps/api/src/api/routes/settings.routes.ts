import { z } from 'zod';
import { settingsPatchSchema, settingsSchema } from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, okSchema, type ApiInstance } from '../types.js';

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  sizeBytes: z.number().nullable().optional(),
});

export async function settingsRoutes(app: ApiInstance, container: Container): Promise<void> {
  app.get(
    '/settings',
    {
      schema: {
        tags: ['settings'],
        summary: 'Read all settings',
        description: 'Secrets are returned masked; submitting a masked value leaves it unchanged.',
        response: { 200: settingsSchema, ...commonErrors },
      },
    },
    async () => container.services.settings.getRedacted(),
  );

  app.patch(
    '/settings',
    {
      schema: {
        tags: ['settings'],
        summary: 'Update settings',
        description:
          'Deep-merges the patch into the stored configuration. Secret values are encrypted at rest.',
        body: settingsPatchSchema,
        response: { 200: settingsSchema, ...commonErrors },
      },
    },
    async (request) => {
      container.services.settings.update(request.body);
      return container.services.settings.getRedacted();
    },
  );

  app.get(
    '/settings/llm/models',
    {
      schema: {
        tags: ['settings'],
        summary: 'List models available on the configured LLM endpoint',
        response: { 200: z.object({ models: z.array(modelSchema) }), ...commonErrors },
      },
    },
    async () => ({ models: await container.services.llm.listModels() }),
  );

  app.post(
    '/settings/llm/test',
    {
      schema: {
        tags: ['settings'],
        summary: 'Check that the local LLM endpoint is reachable',
        response: {
          200: z.object({
            reachable: z.boolean(),
            model: z.string(),
            error: z.string().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async () => container.services.llm.health(),
  );

  app.post(
    '/settings/queue/pause',
    {
      schema: {
        tags: ['settings'],
        summary: 'Pause or resume the background queue',
        body: z.object({ paused: z.boolean() }),
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      container.services.settings.update({ queue: { paused: request.body.paused } });
      return { ok: true as const };
    },
  );
}
