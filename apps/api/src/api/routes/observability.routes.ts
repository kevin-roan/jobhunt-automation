import { z } from 'zod';
import {
  llmCallDtoSchema,
  llmTaskSchema,
  logDtoSchema,
  logQuerySchema,
  paginationSchema,
  promptTemplateDtoSchema,
} from '@deedy/shared';
import { NotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import { DEFAULT_PROMPTS } from '../../services/llm/prompts.js';
import { commonErrors, idParamSchema, okSchema, paginatedSchema, type ApiInstance } from '../types.js';

export async function observabilityRoutes(app: ApiInstance, container: Container): Promise<void> {
  const { logs, llmCalls, promptTemplates, analytics } = container.repositories;

  app.get(
    '/logs',
    {
      schema: {
        tags: ['observability'],
        summary: 'Search persisted logs',
        querystring: logQuerySchema,
        response: { 200: paginatedSchema(logDtoSchema), ...commonErrors },
      },
    },
    async (request) => logs.search(request.query),
  );

  app.get(
    '/logs/scopes',
    {
      schema: {
        tags: ['observability'],
        summary: 'List log scopes seen so far',
        response: { 200: z.object({ scopes: z.array(z.string()) }), ...commonErrors },
      },
    },
    async () => ({ scopes: logs.scopes() }),
  );

  app.get(
    '/llm-calls',
    {
      schema: {
        tags: ['observability'],
        summary: 'List LLM activity',
        querystring: paginationSchema.extend({
          task: llmTaskSchema.optional(),
          success: z.coerce.boolean().optional(),
        }),
        response: { 200: paginatedSchema(llmCallDtoSchema), ...commonErrors },
      },
    },
    async (request) => llmCalls.search(request.query),
  );

  app.get(
    '/llm-calls/:id',
    {
      schema: {
        tags: ['observability'],
        summary: 'Read one LLM call, including the prompts and raw response',
        params: idParamSchema,
        response: {
          200: llmCallDtoSchema.extend({
            systemPrompt: z.string().nullable(),
            userPrompt: z.string().nullable(),
            response: z.string().nullable(),
          }),
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const row = llmCalls.byId(request.params.id);
      if (!row) throw new NotFoundError('LLM call', request.params.id);
      return {
        id: row.id,
        task: row.task as z.infer<typeof llmTaskSchema>,
        provider: row.provider,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        durationMs: row.durationMs,
        success: row.success,
        attempt: row.attempt,
        error: row.error,
        jobId: row.jobId,
        createdAt: row.createdAt,
        systemPrompt: row.systemPrompt,
        userPrompt: row.userPrompt,
        response: row.response,
      };
    },
  );

  app.get(
    '/prompts',
    {
      schema: {
        tags: ['observability'],
        summary: 'List prompt templates, including the built-in defaults',
        response: {
          200: z.object({
            templates: z.array(promptTemplateDtoSchema),
            defaults: z.array(
              z.object({ task: llmTaskSchema, system: z.string(), user: z.string() }),
            ),
          }),
          ...commonErrors,
        },
      },
    },
    async () => ({
      templates: promptTemplates.list(),
      defaults: Object.entries(DEFAULT_PROMPTS).map(([task, template]) => ({
        task: task as z.infer<typeof llmTaskSchema>,
        system: template.system,
        user: template.user,
      })),
    }),
  );

  app.post(
    '/prompts',
    {
      schema: {
        tags: ['observability'],
        summary: 'Create a new prompt template version',
        body: z.object({
          task: llmTaskSchema,
          name: z.string().min(1).max(120),
          system: z.string().min(1),
          user: z.string().min(1),
          isActive: z.boolean().default(true),
        }),
        response: { 201: promptTemplateDtoSchema, ...commonErrors },
      },
    },
    async (request, reply) => reply.status(201).send(promptTemplates.upsert(request.body)),
  );

  app.post(
    '/prompts/:id/activate',
    {
      schema: {
        tags: ['observability'],
        summary: 'Make a prompt template version active for its task',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      promptTemplates.activate(request.params.id);
      return { ok: true as const };
    },
  );

  app.delete(
    '/prompts/:id',
    {
      schema: {
        tags: ['observability'],
        summary: 'Delete a prompt template version',
        params: idParamSchema,
        response: { 200: okSchema, ...commonErrors },
      },
    },
    async (request) => {
      promptTemplates.delete(request.params.id);
      return { ok: true as const };
    },
  );

  app.get(
    '/analytics/overview',
    {
      schema: {
        tags: ['analytics'],
        summary: 'Headline metrics for the dashboard',
        response: { 200: z.unknown(), ...commonErrors },
      },
    },
    async () => analytics.overview(),
  );

  app.get(
    '/analytics',
    {
      schema: {
        tags: ['analytics'],
        summary: 'Full analytics payload: time series, funnel and distributions',
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
        response: { 200: z.unknown(), ...commonErrors },
      },
    },
    async (request) => analytics.full(request.query.days),
  );

  /** Server-sent events so the dashboard reflects pipeline activity live. */
  app.get(
    '/events',
    {
      schema: {
        tags: ['observability'],
        summary: 'Live event stream (Server-Sent Events)',
        description:
          'Emits queue, application, job, LLM and log events as they happen. Durable state always lives in SQLite; this stream is a convenience only.',
      },
    },
    async (request, reply) => {
      // Take ownership of the socket: Fastify must not also send a response.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

      const unsubscribe = container.events.onAny(({ event, payload }) => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
          unsubscribe();
        }
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

    },
  );
}
