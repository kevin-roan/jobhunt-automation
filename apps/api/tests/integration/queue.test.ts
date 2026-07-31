import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type QueueSettings, type Settings } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EventBus } from '../../src/core/events.js';
import type { LogContext, Logger } from '../../src/core/logger.js';
import { QueueRepository } from '../../src/repositories/queue.repository.js';
import { QueueWorker, type TaskHandler, type TaskHandlerMap } from '../../src/queue/worker.js';
import type { SettingsService } from '../../src/services/settings.service.js';

let workDir = '';
const openHandles: DbHandle[] = [];

/** Each test gets its own file-backed database so claims never cross-contaminate. */
function newDb(name: string): { handle: DbHandle; repo: QueueRepository } {
  const handle = createDb(path.join(workDir, `${name}.sqlite`));
  runMigrations(handle.sqlite);
  openHandles.push(handle);
  return { handle, repo: new QueueRepository(handle.db) };
}

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

class SilentLogger implements Logger {
  readonly scope = 'test';
  trace(_message: string, _context?: LogContext): void {}
  debug(_message: string, _context?: LogContext): void {}
  info(_message: string, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  error(_message: string, _context?: LogContext): void {}
  fatal(_message: string, _context?: LogContext): void {}
  child(_scope: string, _base?: LogContext): Logger {
    return this;
  }
}

/**
 * The worker only ever calls `settingsService.get()`, so a read-only stub is
 * enough; the cast keeps the constructor signature honest without a real DB.
 */
function settingsStub(queue: Partial<QueueSettings>): SettingsService {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    queue: { ...DEFAULT_SETTINGS.queue, ...queue },
  };
  const stub: Pick<SettingsService, 'get'> = {
    get: (): Settings => settings,
  };
  return stub as unknown as SettingsService;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'deedy-queue-test-'));
});

afterAll(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // a test may already have closed it
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('QueueRepository', () => {
  it('reuses a pending row for the same dedupeKey and revives a completed one', () => {
    const { repo } = newDb('dedupe');

    const first = repo.enqueue({ task: 'job.score', payload: { jobId: 7 }, dedupeKey: 'score:7' });
    const second = repo.enqueue({ task: 'job.score', payload: { jobId: 7 }, dedupeKey: 'score:7' });

    expect(second.id).toBe(first.id);
    expect(repo.search({ page: 1, pageSize: 50 }).total).toBe(1);

    repo.complete(first.id);
    expect(repo.byId(first.id)?.status).toBe('completed');

    const revived = repo.enqueue({
      task: 'job.score',
      payload: { jobId: 7, refreshed: true },
      dedupeKey: 'score:7',
      maxAttempts: 5,
    });

    expect(revived.id).toBe(first.id);
    expect(revived.status).toBe('pending');
    expect(revived.attempts).toBe(0);
    expect(revived.maxAttempts).toBe(5);
    expect(revived.lastError).toBeNull();
    expect(revived.finishedAt).toBeNull();
    expect(revived.payload).toEqual({ jobId: 7, refreshed: true });
    expect(repo.search({ page: 1, pageSize: 50 }).total).toBe(1);
  });

  it('claims rows by priority then runAt, increments attempts and never hands one out twice', () => {
    const { repo } = newDb('claim-order');

    const oldLow = repo.enqueue({
      task: 'job.score',
      payload: { n: 'oldLow' },
      priority: 0,
      runAt: isoOffset(-3000),
    });
    const high = repo.enqueue({
      task: 'job.score',
      payload: { n: 'high' },
      priority: 5,
      runAt: isoOffset(-1000),
    });
    const newLow = repo.enqueue({
      task: 'job.score',
      payload: { n: 'newLow' },
      priority: 0,
      runAt: isoOffset(-2000),
    });

    const firstBatch = repo.claim({ limit: 2, workerId: 'worker-a', lockMs: 60000 });
    expect(firstBatch.map((row) => row.id)).toEqual([high.id, oldLow.id]);
    for (const row of firstBatch) {
      expect(row.status).toBe('active');
      expect(row.attempts).toBe(1);
      expect(row.lockedBy).toBe('worker-a');
      expect(row.lockExpiresAt).not.toBeNull();
      expect(row.startedAt).not.toBeNull();
    }

    const secondBatch = repo.claim({ limit: 5, workerId: 'worker-b', lockMs: 60000 });
    expect(secondBatch.map((row) => row.id)).toEqual([newLow.id]);

    const thirdBatch = repo.claim({ limit: 5, workerId: 'worker-b', lockMs: 60000 });
    expect(thirdBatch).toEqual([]);
    expect(repo.claim({ limit: 0, workerId: 'worker-b', lockMs: 60000 })).toEqual([]);
  });

  it('honours excludeTasks and skips rows scheduled in the future', () => {
    const { repo } = newDb('claim-filters');

    const apply = repo.enqueue({
      task: 'application.apply',
      payload: {},
      runAt: isoOffset(-1000),
    });
    const score = repo.enqueue({ task: 'job.score', payload: {}, runAt: isoOffset(-1000) });
    const future = repo.enqueue({ task: 'collect.jobs', payload: {}, runAt: isoOffset(3600000) });

    const filtered = repo.claim({
      limit: 10,
      workerId: 'worker-a',
      lockMs: 60000,
      excludeTasks: ['application.apply', 'collect.jobs'],
    });
    expect(filtered.map((row) => row.id)).toEqual([score.id]);

    const rest = repo.claim({ limit: 10, workerId: 'worker-a', lockMs: 60000 });
    expect(rest.map((row) => row.id)).toEqual([apply.id]);
    expect(repo.byId(future.id)?.status).toBe('pending');

    const onlyCollect = repo.claim({
      limit: 10,
      workerId: 'worker-a',
      lockMs: 60000,
      tasks: ['collect.jobs'],
    });
    expect(onlyCollect).toEqual([]);
  });

  it('fail() reschedules with a delay or marks the job failed when given null', () => {
    const { repo } = newDb('fail');

    const job = repo.enqueue({ task: 'job.enrich', payload: {}, runAt: isoOffset(-1000) });
    repo.claim({ limit: 1, workerId: 'worker-a', lockMs: 60000 });

    expect(repo.fail(job.id, 'transient boom', 30000)).toBe('retrying');
    const retrying = repo.byId(job.id);
    expect(retrying?.status).toBe('pending');
    expect(retrying?.lastError).toBe('transient boom');
    expect(retrying?.finishedAt).toBeNull();
    expect(retrying?.lockedBy).toBeNull();
    expect(retrying?.lockExpiresAt).toBeNull();
    expect(Date.parse(retrying?.runAt ?? '')).toBeGreaterThan(Date.now());

    expect(repo.fail(job.id, 'fatal boom', null)).toBe('failed');
    const failed = repo.byId(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toBe('fatal boom');
    expect(failed?.finishedAt).not.toBeNull();
  });

  it('reclaimStalled() returns expired locks to pending and leaves live locks alone', () => {
    const { repo } = newDb('reclaim');

    const stalled = repo.enqueue({ task: 'job.score', payload: {}, runAt: isoOffset(-1000) });
    const healthy = repo.enqueue({ task: 'job.enrich', payload: {}, runAt: isoOffset(-1000) });

    repo.claim({ limit: 1, workerId: 'dead-worker', lockMs: -1000, tasks: ['job.score'] });
    repo.claim({ limit: 1, workerId: 'live-worker', lockMs: 60000, tasks: ['job.enrich'] });

    expect(repo.reclaimStalled()).toBe(1);

    const recovered = repo.byId(stalled.id);
    expect(recovered?.status).toBe('pending');
    expect(recovered?.lockedBy).toBeNull();
    expect(recovered?.lockExpiresAt).toBeNull();
    expect(recovered?.startedAt).toBeNull();
    expect(recovered?.lastError).toBe('Reclaimed after stalled lock');
    // The reclaimed attempt is preserved, so retries stay bounded across restarts.
    expect(recovered?.attempts).toBe(1);

    expect(repo.byId(healthy.id)?.status).toBe('active');
    expect(repo.reclaimStalled()).toBe(0);
  });
});

describe('QueueWorker', () => {
  it('completes healthy jobs and retries failing ones up to maxAttempts', async () => {
    const { repo } = newDb('worker');
    const events = new EventBus();
    const completed: number[] = [];
    const failures: { id: number; willRetry: boolean }[] = [];
    events.on('queue.completed', (payload) => completed.push(payload.id));
    events.on('queue.failed', (payload) =>
      failures.push({ id: payload.id, willRetry: payload.willRetry }),
    );

    const okHandler = vi.fn<TaskHandler>(async () => {
      await Promise.resolve();
    });
    const badHandler = vi.fn<TaskHandler>(async () => {
      await Promise.resolve();
      throw new Error('kaboom');
    });
    const handlers: TaskHandlerMap = {
      'job.score': okHandler,
      'job.enrich': badHandler,
    };

    const worker = new QueueWorker(
      repo,
      handlers,
      settingsStub({
        concurrency: 4,
        browserConcurrency: 1,
        pollIntervalMs: 10,
        backoffBaseMs: 20,
        backoffFactor: 1,
        stalledAfterMs: 60000,
        paused: false,
      }),
      new SilentLogger(),
      events,
    );

    const good = repo.enqueue({ task: 'job.score', payload: { jobId: 1 }, maxAttempts: 3 });
    const bad = repo.enqueue({ task: 'job.enrich', payload: { jobId: 2 }, maxAttempts: 2 });

    worker.start();
    expect(worker.status().running).toBe(true);

    try {
      await waitFor(
        () => repo.byId(good.id)?.status === 'completed' && repo.byId(bad.id)?.status === 'failed',
        'both jobs to reach a terminal state',
      );
    } finally {
      await worker.stop(5000);
    }

    const goodRow = repo.byId(good.id);
    expect(goodRow?.status).toBe('completed');
    expect(goodRow?.attempts).toBe(1);
    expect(goodRow?.finishedAt).not.toBeNull();
    expect(goodRow?.lastError).toBeNull();
    expect(okHandler).toHaveBeenCalledTimes(1);
    expect(completed).toContain(good.id);

    const goodAttempts = repo.attempts(good.id);
    expect(goodAttempts).toHaveLength(1);
    expect(goodAttempts[0]?.status).toBe('succeeded');

    const badRow = repo.byId(bad.id);
    expect(badRow?.status).toBe('failed');
    expect(badRow?.attempts).toBe(2);
    expect(badRow?.lastError).toContain('kaboom');
    expect(badRow?.finishedAt).not.toBeNull();
    expect(badHandler).toHaveBeenCalledTimes(2);

    const badAttempts = repo.attempts(bad.id);
    expect(badAttempts).toHaveLength(2);
    expect(badAttempts.map((row) => row.attempt)).toEqual([1, 2]);
    expect(badAttempts.every((row) => row.status === 'failed')).toBe(true);
    expect(badAttempts.every((row) => (row.error ?? '').includes('kaboom'))).toBe(true);

    expect(failures.filter((f) => f.id === bad.id).map((f) => f.willRetry)).toEqual([true, false]);
    expect(worker.status().running).toBe(false);
    expect(worker.status().inFlight).toBe(0);
  });
});
