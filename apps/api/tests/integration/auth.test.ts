import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config/env.js';
import { createContainer, type Container } from '../../src/core/container.js';
import { createServer, sanitiseIssues } from '../../src/api/server.js';

// Booting the real container migrates SQLite, which is far slower than the
// default vitest budget.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const API_TOKEN = randomBytes(32).toString('base64url');

describe('API authentication', () => {
  let dataDir: string;
  let container: Container;
  let app: FastifyInstance;
  /** The same routes with the escape hatch thrown — see AUTH_ENABLED. */
  let openApp: FastifyInstance;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'deedy-auth-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'error',
      DISABLE_WORKERS: 'true',
      WEB_DIR: path.join(dataDir, 'no-web-build'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      API_TOKEN,
    });

    container = await createContainer(config);
    app = await createServer(container);
    await app.ready();

    // A second server over the same container, differing only in the flag. It
    // shares the database deliberately: the point is that identical routes with
    // identical data answer differently purely because auth is off.
    openApp = await createServer({
      ...container,
      config: { ...container.config, AUTH_ENABLED: false },
    });
    await openApp.ready();
  });

  afterAll(async () => {
    await openApp.close();
    await app.close();
    await container.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('the gate', () => {
    it('rejects an unauthenticated read of the candidate profile', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: string }>().error).toBe('unauthorized');
      expect(response.headers['www-authenticate']).toContain('Bearer');
      // The body must not hand back the thing it is protecting.
      expect(response.body).not.toContain(API_TOKEN);
    });

    it('allows the same read with the token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects a wrong token of the same length without throwing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
      });

      expect(response.statusCode).toBe(401);
    });

    /**
     * The regression this file exists for: `timingSafeEqual` throws a TypeError
     * on buffers of unequal length, which would turn every short guess into a
     * 500 and leak the expected length through the status code.
     */
    it('rejects wrong-length tokens rather than erroring', async () => {
      for (const candidate of ['', 'x', 'short', `${API_TOKEN}extra`, API_TOKEN.slice(0, -1)]) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/settings',
          headers: { authorization: `Bearer ${candidate}` },
        });

        expect(response.statusCode).toBe(401);
      }
    });

    it('rejects a malformed authorization scheme', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { authorization: API_TOKEN },
      });

      expect(response.statusCode).toBe(401);
    });

    it('gates every data route, not just settings', async () => {
      for (const url of [
        '/api/health',
        '/api/jobs',
        '/api/resumes',
        '/api/logs',
        '/api/llm-calls',
        '/api/prompts',
        '/api/credentials',
        '/api/artifacts/screenshots',
        '/api/events',
      ]) {
        const response = await app.inject({ method: 'GET', url });

        expect(response.statusCode, `${url} should require a token`).toBe(401);
      }
    });

    it('accepts the token as a query parameter, for browser-issued requests', async () => {
      // EventSource, <img src> and <a href> cannot carry a header.
      const response = await app.inject({
        method: 'GET',
        url: `/api/resumes?token=${encodeURIComponent(API_TOKEN)}`,
      });

      expect(response.statusCode).toBe(200);
    });

    it('accepts the x-api-token header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { 'x-api-token': API_TOKEN },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('exemptions', () => {
    /**
     * The Dockerfile HEALTHCHECK and the compose healthcheck both curl exactly
     * this path and cannot present a secret. If it ever needs one, the
     * container reports unhealthy forever.
     */
    it('serves /api/health/live without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/live' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ ok: boolean }>()).toEqual({ ok: true });
    });

    it('serves /api/auth/status without a token, and never leaks the token there', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ authRequired: boolean }>()).toEqual({ authRequired: true });
      expect(response.body).not.toContain(API_TOKEN);
    });

    it('gates /api/auth/check, so a 200 from it verifies the token', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/auth/check' });
      expect(anonymous.statusCode).toBe(401);

      const authenticated = await app.inject({
        method: 'GET',
        url: '/api/auth/check',
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json<{ ok: boolean }>()).toEqual({ ok: true });
    });

    it('does not gate the dashboard, which is where the token is typed', async () => {
      // No dashboard build in a test data directory, so the SPA fallback is a
      // 404 — but a 401 here would mean the user could never load the page that
      // asks them for the token.
      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).not.toBe(401);
    });
  });

  describe('the escape hatch', () => {
    it('lets everything through when AUTH_ENABLED is false', async () => {
      const response = await openApp.inject({ method: 'GET', url: '/api/settings' });

      expect(response.statusCode).toBe(200);
    });

    it('reports that no token is required, so the dashboard skips its gate', async () => {
      const response = await openApp.inject({ method: 'GET', url: '/api/auth/status' });

      expect(response.json<{ authRequired: boolean }>()).toEqual({ authRequired: false });
    });
  });

  describe('token issuance', () => {
    it('generates a token on first boot and stores it 0600 in DATA_DIR', () => {
      const generatedDir = mkdtempSync(path.join(tmpdir(), 'deedy-auth-gen-'));
      try {
        const first = loadConfig({ DATA_DIR: generatedDir, WEB_DIR: generatedDir });
        expect(first.apiToken.length).toBeGreaterThanOrEqual(16);
        expect(readFileSync(first.paths.tokenFile, 'utf8').trim()).toBe(first.apiToken);
        expect(statSync(first.paths.tokenFile).mode & 0o777).toBe(0o600);

        // Stable across restarts, or the user is locked out on every reboot.
        const second = loadConfig({ DATA_DIR: generatedDir, WEB_DIR: generatedDir });
        expect(second.apiToken).toBe(first.apiToken);
      } finally {
        rmSync(generatedDir, { recursive: true, force: true });
      }
    });

    it('refuses a token too short to be worth having', () => {
      const shortDir = mkdtempSync(path.join(tmpdir(), 'deedy-auth-short-'));
      try {
        expect(() => loadConfig({ DATA_DIR: shortDir, API_TOKEN: 'hunter2' })).toThrow(
          /at least 16 characters/,
        );
      } finally {
        rmSync(shortDir, { recursive: true, force: true });
      }
    });
  });

  describe('validation errors', () => {
    /**
     * The Zod branch of the error handler both logs its issues into the `logs`
     * table and echoes them to the caller, and Zod puts the submitted value in
     * `received`/`input`. A rejected profile field would otherwise be copied
     * verbatim into both places.
     */
    it('strips the submitted value out of Zod issues', () => {
      const secret = 'ada.lovelace@analytical-engines.example';
      const schema = z.object({ profile: z.object({ email: z.number() }) });
      const parsed = schema.safeParse({ profile: { email: secret } });
      expect(parsed.success).toBe(false);

      const issues = sanitiseIssues(parsed.error!.issues);

      expect(issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(issues)).not.toContain(secret);
      for (const issue of issues) {
        expect(issue).not.toHaveProperty('received');
        expect(issue).not.toHaveProperty('input');
        // The useful half survives: a caller still learns which field failed.
        expect(issue).toHaveProperty('path');
        expect(issue).toHaveProperty('code');
      }
    });

    it('does not echo the submitted value back over HTTP either', async () => {
      const secret = 'ada.lovelace@analytical-engines.example';
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { application: { maxApplicationsPerDay: secret } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain('analytical-engines');
    });
  });
});
