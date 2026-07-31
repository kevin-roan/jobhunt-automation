import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResumeDto, Settings } from '@deedy/shared';
import { loadConfig } from '../../src/config/env.js';
import { createContainer, type Container } from '../../src/core/container.js';
import { createServer } from '../../src/api/server.js';

// Booting the real container migrates SQLite and may render documents with
// Playwright, both of which are far slower than the default vitest budget.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

interface HealthBody {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: boolean;
  llm: { reachable: boolean; model: string; error: string | null };
  queue: { running: boolean; paused: boolean; pending: number; active: number };
  scheduler: { running: boolean; tasks: { name: string; nextRunAt: string | null }[] };
}

interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface QueueStatsBody {
  byStatus: Record<string, number>;
  byTask: { task: string; status: string; value: number }[];
  worker: { running: boolean; inFlight: number; workerId: string };
}

interface CollectorsBody {
  collectors: { id: string; name: string; source: string; enabled: boolean }[];
  planned: string[];
}

/** Nothing is listening here, so the LLM health probe always fails fast. */
const UNREACHABLE_LLM_URL = 'http://127.0.0.1:1';
const DEFAULT_LLM_URL = 'http://localhost:11434';

const RESUME_MARKDOWN = [
  '# Ada Lovelace',
  '',
  '## Experience',
  '',
  '- Built the first published algorithm',
  '',
  '## Skills',
  '',
  '- Analytical engines',
  '- Mathematics',
].join('\n');

describe('API integration', () => {
  let dataDir: string;
  let container: Container;
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'deedy-api-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      LOG_LEVEL: 'error',
      DISABLE_WORKERS: 'true',
      // Point at a directory that cannot contain a dashboard build so the
      // server stays API-only and 404s are JSON rather than index.html.
      WEB_DIR: path.join(dataDir, 'no-web-build'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    });

    container = await createContainer(config);
    app = await createServer(container);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await container.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('health', () => {
    it('reports process liveness', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health/live' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ ok: boolean }>()).toEqual({ ok: true });
    });

    it('reports degraded status when the LLM endpoint is unreachable', async () => {
      container.services.settings.update({ llm: { baseUrl: UNREACHABLE_LLM_URL } });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/health' });

        expect(response.statusCode).toBe(200);
        const body = response.json<HealthBody>();
        expect(body.status).toBe('degraded');
        expect(body.database).toBe(true);
        expect(body.llm.reachable).toBe(false);
        expect(typeof body.llm.error).toBe('string');
        expect(body.version).toBe('1.0.0');
        expect(typeof body.uptimeSeconds).toBe('number');
        // Workers are disabled in tests, so nothing should be running.
        expect(body.queue.running).toBe(false);
        expect(body.queue.pending).toBe(0);
        expect(body.queue.active).toBe(0);
        expect(body.scheduler.running).toBe(false);
        expect(Array.isArray(body.scheduler.tasks)).toBe(true);
      } finally {
        container.services.settings.update({ llm: { baseUrl: DEFAULT_LLM_URL } });
      }
    });
  });

  describe('settings', () => {
    it('returns defaults with the LLM api key masked', async () => {
      container.services.settings.update({ llm: { apiKey: 'super-secret-token' } });

      const response = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(response.statusCode).toBe(200);
      const body = response.json<Settings>();
      expect(body.llm.baseUrl).toBe(DEFAULT_LLM_URL);
      expect(body.llm.provider).toBe('ollama');
      // No model is ever hardcoded; the user picks one in Settings.
      expect(body.llm.model).toBe('');
      expect(body.browser.dryRun).toBe(true);
      expect(body.application.autoApply).toBe(false);
      expect(body.queue.paused).toBe(false);

      expect(body.llm.apiKey).not.toBe('super-secret-token');
      expect(body.llm.apiKey).toMatch(/^\*+oken$/);
    });

    it('persists a patch and reflects it on the next read', async () => {
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { application: { maxApplicationsPerDay: 7 }, search: { keywords: ['rust'] } },
      });

      expect(patch.statusCode).toBe(200);
      expect(patch.json<Settings>().application.maxApplicationsPerDay).toBe(7);

      const read = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(read.statusCode).toBe(200);
      const body = read.json<Settings>();
      expect(body.application.maxApplicationsPerDay).toBe(7);
      expect(body.search.keywords).toEqual(['rust']);
    });

    it('rejects a patch with the wrong value type', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { application: { maxApplicationsPerDay: 'not-a-number' } },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<ErrorBody>();
      expect(typeof body.error).toBe('string');
      expect(typeof body.message).toBe('string');

      // The rejected value must not have been persisted.
      const read = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(read.json<Settings>().application.maxApplicationsPerDay).toBe(7);
    });
  });

  describe('resumes', () => {
    let resumeId: number;

    it('creates a resume and renders its markdown', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/resumes',
        payload: {
          name: 'Ada Base Resume',
          targetRole: 'Staff Engineer',
          markdown: RESUME_MARKDOWN,
        },
      });

      expect([200, 201]).toContain(response.statusCode);
      const body = response.json<ResumeDto>();
      resumeId = body.id;
      expect(body.id).toBeGreaterThan(0);
      expect(body.name).toBe('Ada Base Resume');
      expect(body.targetRole).toBe('Staff Engineer');
      expect(body.version).toBe(1);
      expect(body.isBase).toBe(true);
      expect(body.generatedBy).toBe('user');
      // The PDF is best-effort: chromium may be absent, in which case the
      // service logs and leaves pdfPath null. Markdown is always written.
      expect(body.filePath).toMatch(/\.md$/);
    });

    it('lists the created resume', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/resumes' });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ resumes: ResumeDto[] }>();
      expect(body.resumes.some((resume) => resume.id === resumeId)).toBe(true);
    });

    it('creates a new version when the markdown changes', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/resumes/${resumeId}`,
        payload: { markdown: `${RESUME_MARKDOWN}\n\n- Difference engine notes` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<ResumeDto>();
      expect(body.id).not.toBe(resumeId);
      expect(body.version).toBe(2);
      expect(body.name).toBe('Ada Base Resume');
      expect(body.markdown).toContain('Difference engine notes');

      // The original version is untouched.
      const original = await app.inject({ method: 'GET', url: `/api/resumes/${resumeId}` });
      expect(original.statusCode).toBe(200);
      expect(original.json<ResumeDto>().markdown).toBe(RESUME_MARKDOWN);
    });

    it('streams the rendered markdown', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/resumes/${resumeId}/download`,
        query: { format: 'md' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/markdown');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.body).toBe(RESUME_MARKDOWN);
    });

    it('404s when downloading a resume that does not exist', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/resumes/999999/download' });

      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error).toBe('not_found');
    });
  });

  describe('jobs', () => {
    it('returns an empty paginated envelope on a fresh database', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/jobs' });

      expect(response.statusCode).toBe(200);
      const body = response.json<Paginated<unknown>>();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(25);
      expect(body.totalPages).toBe(1);
    });

    it('404s with the standard error shape for an unknown job', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/jobs/999999' });

      expect(response.statusCode).toBe(404);
      const body = response.json<ErrorBody>();
      expect(body.error).toBe('not_found');
      expect(body.message).toContain('999999');
    });
  });

  describe('operations and observability', () => {
    it('returns queue statistics', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/queue/stats' });

      expect(response.statusCode).toBe(200);
      const body = response.json<QueueStatsBody>();
      expect(body.byTask).toEqual([]);
      expect(body.worker.running).toBe(false);
      expect(body.worker.inFlight).toBe(0);
      expect(typeof body.byStatus.pending).toBe('number');
    });

    it('lists the built-in collectors', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/collectors' });

      expect(response.statusCode).toBe(200);
      const body = response.json<CollectorsBody>();
      expect(body.collectors.length).toBeGreaterThan(0);
      expect(Array.isArray(body.planned)).toBe(true);
    });

    it('returns the analytics overview', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/analytics/overview' });

      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, number>>();
      for (const value of Object.values(body)) {
        expect(typeof value).toBe('number');
      }
    });

    it('returns persisted logs', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/logs' });

      expect(response.statusCode).toBe(200);
      const body = response.json<Paginated<{ id: number; level: string; scope: string }>>();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.page).toBe(1);
    });
  });
});
