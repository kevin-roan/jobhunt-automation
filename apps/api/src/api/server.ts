import { existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
import { z, ZodError } from 'zod';
import { APP_NAME, APP_VERSION } from '@deedy/shared';
import { corsOrigins } from '../config/env.js';
import { AppError } from '../core/errors.js';
import type { Container } from '../core/container.js';
import { registerRoutes } from './routes/index.js';

/**
 * The only `/api` paths served without a token.
 *
 *   /api/health/live   the Dockerfile HEALTHCHECK and the compose healthcheck
 *                      both curl exactly this, with no way to carry a secret.
 *                      It reports `{ ok: true }` and nothing else, so it
 *                      discloses only that a process is up.
 *   /api/auth/status   how the dashboard learns whether to show its token gate
 *                      at all. Returns one boolean and never the token.
 *
 * `/api/health` (the dependency report) is deliberately NOT here: it names the
 * configured model and exposes queue depth, which is operational detail about
 * the user, not a liveness signal the container runtime needs.
 */
const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/api/health/live', '/api/auth/status']);

/** The query parameter that carries the token where a header cannot go. */
const TOKEN_QUERY_PARAM = 'token';

/** Path without the query string, and without a trailing slash. */
function pathOf(url: string): string {
  const queryStart = url.indexOf('?');
  const pathname = queryStart < 0 ? url : url.slice(0, queryStart);
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Pulls the presented token out of a request.
 *
 * The header is the real interface. The query parameter exists because three
 * things the dashboard needs are issued by the browser itself and cannot carry
 * a header: `EventSource` (the live event stream), `<img src>` for application
 * screenshots, and `<a href>` resume downloads. It is redacted out of the
 * request log below so it does not end up sitting in the `logs` table.
 */
function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const value = match?.[1]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }

  const direct = request.headers['x-api-token'];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const queryStart = request.url.indexOf('?');
  if (queryStart >= 0) {
    const value = new URLSearchParams(request.url.slice(queryStart + 1)).get(TOKEN_QUERY_PARAM);
    if (value !== null && value.length > 0) return value;
  }

  return null;
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` THROWS on a length mismatch, which would turn a wrong-length
 * guess into a 500 and, worse, leak the expected length through the difference
 * in responses. Hashing both sides first makes the buffers the same size by
 * construction, so the comparison itself is reached for every input and the
 * length guard below is only a belt-and-braces check that can never fire.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Removes the submitted value from a Zod issue.
 *
 * Zod puts what the user sent into `received`/`input`, and this handler both
 * logs the issues (into the `logs` table, forever) and echoes them back in the
 * HTTP response. A rejected `profile.email` or a mistyped credential would be
 * copied verbatim into both. The path and the failure code are what a caller
 * actually needs; the value is the one part they already have.
 *
 * Exported so a test can pin it directly. Route-level validation never reaches
 * this branch — fastify-type-provider-zod turns that into a plain Fastify 400
 * first — so the ZodError arriving here is one a service threw, and the only
 * way to assert on it is to call this.
 */
export function sanitiseIssues(issues: readonly unknown[]): Record<string, unknown>[] {
  return issues.map((issue) => {
    const copy = { ...(issue as Record<string, unknown>) };
    delete copy.received;
    delete copy.input;
    return copy;
  });
}

/** Request URL safe to log: the token query parameter masked out. */
function loggableUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  if (!params.has(TOKEN_QUERY_PARAM)) return url;
  params.set(TOKEN_QUERY_PARAM, '[REDACTED]');
  return `${url.slice(0, queryStart)}?${params.toString()}`;
}

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
      const issues = sanitiseIssues(error.issues);
      container.logger.warn('request validation failed', {
        url: loggableUrl(request.url),
        issues,
      });
      return reply
        .status(400)
        .send({ error: 'validation_error', message: 'Request failed validation', details: issues });
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        container.logger.error('request failed', { url: loggableUrl(request.url), error: error.message });
      } else {
        container.logger.warn('request rejected', { url: loggableUrl(request.url), error: error.message });
      }
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      container.logger.error('unhandled request error', {
        url: loggableUrl(request.url),
        error: error.message,
        stack: error.stack,
      });
    }
    return reply
      .status(statusCode)
      .send({ error: 'internal_error', message: error.message || 'Unexpected server error' });
  });

  /**
   * The gate. `onRequest` rather than `preHandler` so an unauthenticated caller
   * is turned away before Fastify parses or validates a body — an anonymous
   * request should not be able to reach the 16MB body parser at all.
   *
   * Only `/api/*` is gated. The dashboard is served from this same origin by
   * `@fastify/static`, and the user has to be able to load it in order to have
   * anywhere to type the token, so the SPA and its assets stay open. They
   * contain no data; every byte of that is behind the paths below.
   */
  app.addHook('onRequest', (request, reply, done) => {
    const pathname = pathOf(request.url);
    if (!pathname.startsWith('/api')) {
      done();
      return;
    }
    if (AUTH_EXEMPT_PATHS.has(pathname)) {
      done();
      return;
    }
    if (!container.config.AUTH_ENABLED) {
      done();
      return;
    }
    // A CORS preflight is issued by the browser and never carries the header it
    // is asking permission to send. Rejecting it would break the split dev
    // server without protecting anything: OPTIONS returns no data.
    if (request.method === 'OPTIONS') {
      done();
      return;
    }

    const presented = presentedToken(request);
    if (presented !== null && tokenMatches(presented, container.config.apiToken)) {
      done();
      return;
    }

    // Levelled by whether anything was offered at all. A request with no token
    // is the ordinary case — a browser tab that has not been unlocked yet — and
    // logging it at warn would both drown the real signal and let anyone who
    // can reach the port grow the `logs` table by hammering it. A request that
    // offered a WRONG token is worth seeing.
    const authLogger = container.logger.child('auth');
    const context = { method: request.method, url: loggableUrl(request.url) };
    if (presented !== null) authLogger.warn('rejected an invalid API token', context);
    else authLogger.debug('rejected a request with no API token', context);

    void reply
      .status(401)
      .header('www-authenticate', 'Bearer realm="deedy-automation"')
      .send({
        error: 'unauthorized',
        message:
          'Missing or invalid API token. Send it as "Authorization: Bearer <token>"; the token is printed at startup and stored in DATA_DIR/.api-token.',
      });
  });

  const authApi = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Unauthenticated on purpose: the dashboard needs to know whether to render
   * its token gate before it has a token, and a single boolean about this
   * host's own configuration is not worth gating.
   */
  authApi.get(
    '/api/auth/status',
    {
      schema: {
        tags: ['health'],
        summary: 'Whether this instance requires a bearer token',
        response: { 200: z.object({ authRequired: z.boolean() }) },
      },
    },
    async () => ({ authRequired: container.config.AUTH_ENABLED }),
  );

  /** Gated like everything else — reaching it at all is the proof of validity. */
  authApi.get(
    '/api/auth/check',
    {
      schema: {
        tags: ['health'],
        summary: 'Verify the presented bearer token',
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async () => ({ ok: true as const }),
  );

  app.addHook('onResponse', (request, reply, done) => {
    if (request.url.startsWith('/api')) {
      container.logger.child('http').debug('request', {
        method: request.method,
        url: loggableUrl(request.url),
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

  announceAuth(container);

  return app;
}

/**
 * Prints the token so the user can actually get in.
 *
 * It goes in the MESSAGE, not in a context field, and this is not stylistic:
 * `maskContext` in core/logger.ts replaces the value of any key matching
 * /token/i with [REDACTED], so `logger.info('...', { apiToken })` would emit a
 * line that is useless for the one job it has. The message string is scrubbed
 * too, by `redactText`, but that only strips the candidate's profile values and
 * generic email/phone shapes — a base64url secret passes through intact. (The
 * phone pattern needs a run of 9-15 digits bounded by non-word characters; a
 * token is one unbroken word, so no interior run of digits can match.)
 *
 * Printing a secret to stdout is a real trade-off. It is the right one here:
 * this is a single-user app on the user's own machine, the same secret is
 * already sitting in DATA_DIR, and the alternative is a user locked out of
 * their own dashboard with no recovery path.
 */
function announceAuth(container: Container): void {
  const logger = container.logger.child('auth');

  if (!container.config.AUTH_ENABLED) {
    logger.warn(
      'API AUTHENTICATION IS DISABLED (AUTH_ENABLED=false). Every endpoint — settings, resumes, ' +
        'screenshots, stored prompts — is served to anyone who can reach the port. This is only ' +
        'safe behind an authenticating proxy AND with the port bound to loopback.',
    );
    return;
  }

  logger.info(
    `API token: ${container.config.apiToken}\n` +
      `  Paste it into the dashboard, or send "Authorization: Bearer <token>".\n` +
      `  Stored at ${container.config.paths.tokenFile} (mode 0600) — read it from there if this line scrolls away.`,
  );
}
