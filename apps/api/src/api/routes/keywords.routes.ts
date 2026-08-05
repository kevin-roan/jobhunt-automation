import { z } from 'zod';
import {
  createKeywordsSchema,
  expandKeywordsResultSchema,
  expandKeywordsSchema,
  searchKeywordDtoSchema,
  updateKeywordSchema,
} from '@deedy/shared';
import type { Container } from '../../core/container.js';
import { commonErrors, idParamSchema, okSchema, type ApiInstance } from '../types.js';

const keywordListSchema = z.object({ keywords: z.array(searchKeywordDtoSchema) });

export async function keywordRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { keywords } = container.services;

  app.get(
    '/keywords',
    {
      schema: {
        tags: ['keywords'],
        summary: 'List every search term, seeded and model-generated',
        response: { 200: keywordListSchema, ...commonErrors },
      },
    },
    async () => ({ keywords: keywords.list() }),
  );

  app.post(
    '/keywords',
    {
      schema: {
        tags: ['keywords'],
        summary: 'Add search terms from free text',
        description:
          'The body is split server-side on newlines, commas and semicolons, so a pasted list works as-is. Terms that already exist are skipped rather than duplicated.',
        body: createKeywordsSchema,
        response: {
          201: z.object({ keywords: z.array(searchKeywordDtoSchema), created: z.number().int() }),
          ...commonErrors,
        },
      },
    },
    async (request, reply) => reply.status(201).send(keywords.create(request.body)),
  );

  // The literal /keywords/expand and /keywords/sync-seeds routes are declared
  // before /keywords/:id purely for readability: Fastify's radix router always
  // prefers a static segment over a parametric one regardless of registration
  // order, and these are POST while /keywords/:id is only PATCH and DELETE, so
  // the two sets could never collide anyway.
  app.post(
    '/keywords/expand',
    {
      schema: {
        tags: ['keywords'],
        summary: 'Ask the local model to widen the seed terms',
        description:
          'Runs entirely on the local model, so on CPU inference this can take a while — expect tens of seconds per seed and keep the request timeout generous. Set replaceGenerated to drop previously generated terms first instead of merging into them.',
        body: expandKeywordsSchema,
        response: { 200: expandKeywordsResultSchema, ...commonErrors },
      },
    },
    async (request) => keywords.expand(request.body),
  );

  app.post(
    '/keywords/sync-seeds',
    {
      schema: {
        tags: ['keywords'],
        summary: 'Re-import the seed terms from settings',
        description:
          'Brings the keyword table back in line with the search terms configured in Settings, which is what makes editing them there take effect without a restart.',
        response: { 200: keywordListSchema, ...commonErrors },
      },
    },
    async () => ({ keywords: keywords.syncSeeds() }),
  );

  app.patch(
    '/keywords/:id',
    {
      schema: {
        tags: ['keywords'],
        summary: 'Rename a search term, or change which sources use it',
        params: idParamSchema,
        body: updateKeywordSchema,
        response: { 200: searchKeywordDtoSchema, ...commonErrors },
      },
    },
    async (request) => keywords.update(request.params.id, request.body),
  );

  app.delete(
    '/keywords/:id',
    {
      schema: {
        tags: ['keywords'],
        summary: 'Delete a search term',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      keywords.remove(request.params.id);
      return { ok: true as const };
    },
  );
}
