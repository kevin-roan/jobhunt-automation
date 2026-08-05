import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { APP_NAME, APP_VERSION } from '@deedy/shared';
import { corsOrigins } from '../config/env.js';
import { AppError } from '../core/errors.js';
import type { Container } from '../core/container.js';
import { registerRoutes } from './routes/index.js';

/**
 * Builds the HTTP server: Zod-validated routes, an OpenAPI document generated
 * from those same schemas, and the compiled dashboard served from `/`.
 */
export async function createServer(container: Container): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: corsOrigins(container.config),
    credentials: true,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: `${APP_NAME} API`,
        version: APP_VERSION,
        description:
          'Local-first autonomous job search and application platform. Every endpoint runs on the host; no data leaves the machine.',
      },
      servers: [{ url: '/', description: 'This instance' }],
      tags: [
        { name: 'health', description: 'Liveness and dependency status' },
        { name: 'settings', description: 'Configuration, including the local LLM endpoint' },
        { name: 'jobs', description: 'Collected postings, scoring and enrichment' },
        { name: 'applications', description: 'Browser automation pipeline and history' },
        { name: 'resumes', description: 'Resume versions, tailoring and documents' },
        { name: 'cover-letters', description: 'Generated cover letters' },
        { name: 'queue', description: 'Persistent background queue' },
        { name: 'collectors', description: 'Job sources and plugin registry' },
        {
          name: 'keywords',
          description: 'Search terms typed into each platform, seeded by you and widened locally',
        },
        {
          name: 'vpn',
          description: 'Exit location, which decides the regional job index the collectors search',
        },
        { name: 'browser', description: 'Persistent browser profiles and sessions' },
        { name: 'observability', description: 'Logs, LLM activity and prompt templates' },
        { name: 'analytics', description: 'Aggregated metrics' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { title: `${APP_NAME} API`, theme: 'purple' },
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof ZodError) {
      container.logger.warn('request validation failed', {
        url: request.url,
        issues: error.issues,
      });
      return reply
        .status(400)
        .send({ error: 'validation_error', message: 'Request failed validation', details: error.issues });
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        container.logger.error('request failed', { url: request.url, error: error.message });
      } else {
        container.logger.warn('request rejected', { url: request.url, error: error.message });
      }
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      container.logger.error('unhandled request error', {
        url: request.url,
        error: error.message,
        stack: error.stack,
      });
    }
    return reply
      .status(statusCode)
      .send({ error: 'internal_error', message: error.message || 'Unexpected server error' });
  });

  app.addHook('onResponse', (request, reply, done) => {
    if (request.url.startsWith('/api')) {
      container.logger.child('http').debug('request', {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
    done();
  });

  await app.register(
    async (instance) => {
      await registerRoutes(instance.withTypeProvider<ZodTypeProvider>(), container);
    },
    { prefix: '/api' },
  );

  // Serve the built dashboard, falling back to index.html for client routing.
  const webDir = path.resolve(container.config.WEB_DIR);
  if (existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/docs')) {
        return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    container.logger.warn('dashboard build not found; API only', { webDir });
    app.setNotFoundHandler((_request, reply) =>
      reply.status(404).send({ error: 'not_found', message: 'Route not found' }),
    );
  }

  return app;
}
