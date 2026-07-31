import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Paginated, Pagination, QueueJobDto, QueueStatus, QueueTask } from '@deedy/shared';
import type { Db } from '../db/client.js';
import { queueAttempts, queueJobs, type QueueJobRow } from '../db/schema.js';
import { isoPlusMs, nowIso } from '../core/utils.js';

export interface EnqueueInput {
  task: QueueTask;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  runAt?: string;
  /** When set, an existing pending/active job with the same key is reused. */
  dedupeKey?: string | null;
}

export function toQueueJobDto(row: QueueJobRow): QueueJobDto {
  return {
    id: row.id,
    task: row.task as QueueTask,
    status: row.status as QueueStatus,
    priority: row.priority,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    runAt: row.runAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
  };
}

/**
 * SQLite-backed persistent queue. Every state transition is a durable write, so
 * a crash mid-task leaves a recoverable row rather than lost work.
 */
export class QueueRepository {
  constructor(private readonly db: Db) {}

  enqueue(input: EnqueueInput): QueueJobRow {
    const dedupeKey = input.dedupeKey ?? null;
    if (dedupeKey) {
      const existing = this.db
        .select()
        .from(queueJobs)
        .where(eq(queueJobs.dedupeKey, dedupeKey))
        .get();
      if (existing) {
        if (existing.status === 'pending' || existing.status === 'active') return existing;
        // Re-arm a finished job under the same key instead of creating a duplicate.
        const revived = this.db
          .update(queueJobs)
          .set({
            status: 'pending',
            payload: input.payload,
            priority: input.priority ?? 0,
            attempts: 0,
            maxAttempts: input.maxAttempts ?? existing.maxAttempts,
            lastError: null,
            runAt: input.runAt ?? nowIso(),
            startedAt: null,
            finishedAt: null,
            lockedBy: null,
            lockExpiresAt: null,
            updatedAt: nowIso(),
          })
          .where(eq(queueJobs.id, existing.id))
          .returning()
          .get();
        return revived;
      }
    }

    return this.db
      .insert(queueJobs)
      .values({
        task: input.task,
        payload: input.payload,
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
        runAt: input.runAt ?? nowIso(),
        dedupeKey,
        status: 'pending',
      })
      .returning()
      .get();
  }

  /**
   * Atomically moves up to `limit` due jobs to `active` and stamps a lock.
   * Runs inside a transaction so two workers can never claim the same row.
   */
  claim(input: {
    limit: number;
    workerId: string;
    lockMs: number;
    tasks?: QueueTask[];
    excludeTasks?: QueueTask[];
  }): QueueJobRow[] {
    if (input.limit <= 0) return [];
    return this.db.transaction((tx) => {
      const conditions: SQL[] = [eq(queueJobs.status, 'pending'), lte(queueJobs.runAt, nowIso())];
      if (input.tasks?.length) conditions.push(inArray(queueJobs.task, input.tasks));
      if (input.excludeTasks?.length) {
        conditions.push(notInArray(queueJobs.task, input.excludeTasks));
      }

      const candidates = tx
        .select({ id: queueJobs.id })
        .from(queueJobs)
        .where(and(...conditions))
        .orderBy(desc(queueJobs.priority), asc(queueJobs.runAt), asc(queueJobs.id))
        .limit(input.limit)
        .all();

      if (candidates.length === 0) return [];
      const ids = candidates.map((c) => c.id);

      const claimed = tx
        .update(queueJobs)
        .set({
          status: 'active',
          startedAt: nowIso(),
          lockedBy: input.workerId,
          lockExpiresAt: isoPlusMs(input.lockMs),
          attempts: sql`${queueJobs.attempts} + 1`,
          updatedAt: nowIso(),
        })
        .where(and(inArray(queueJobs.id, ids), eq(queueJobs.status, 'pending')))
        .returning()
        .all();

      // RETURNING yields rows in rowid order, so restore the priority ordering
      // the candidate query established.
      const rank = new Map(ids.map((id, index) => [id, index]));
      return claimed.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    });
  }

  startAttempt(queueJobId: number, attempt: number): number {
    const row = this.db
      .insert(queueAttempts)
      .values({ queueJobId, attempt, status: 'running' })
      .returning({ id: queueAttempts.id })
      .get();
    return row.id;
  }

  finishAttempt(
    attemptId: number,
    status: 'succeeded' | 'failed',
    durationMs: number,
    error?: string | null,
  ): void {
    this.db
      .update(queueAttempts)
      .set({ status, durationMs, error: error ?? null, finishedAt: nowIso() })
      .where(eq(queueAttempts.id, attemptId))
      .run();
  }

  attempts(queueJobId: number) {
    return this.db
      .select()
      .from(queueAttempts)
      .where(eq(queueAttempts.queueJobId, queueJobId))
      .orderBy(asc(queueAttempts.attempt))
      .all();
  }

  complete(id: number): void {
    this.db
      .update(queueJobs)
      .set({
        status: 'completed',
        finishedAt: nowIso(),
        lockedBy: null,
        lockExpiresAt: null,
        lastError: null,
        updatedAt: nowIso(),
      })
      .where(eq(queueJobs.id, id))
      .run();
  }

  /** Schedules a retry, or marks the job failed once attempts are exhausted. */
  fail(id: number, error: string, retryDelayMs: number | null): 'retrying' | 'failed' {
    const willRetry = retryDelayMs !== null;
    this.db
      .update(queueJobs)
      .set({
        status: willRetry ? 'pending' : 'failed',
        lastError: error.slice(0, 4000),
        runAt: willRetry ? isoPlusMs(retryDelayMs) : nowIso(),
        finishedAt: willRetry ? null : nowIso(),
        startedAt: null,
        lockedBy: null,
        lockExpiresAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(queueJobs.id, id))
      .run();
    return willRetry ? 'retrying' : 'failed';
  }

  /**
   * Returns jobs whose lock expired (the process died mid-task) to `pending`.
   * Called on boot and periodically, which is what makes the queue restart-safe.
   */
  reclaimStalled(): number {
    const result = this.db
      .update(queueJobs)
      .set({
        status: 'pending',
        lockedBy: null,
        lockExpiresAt: null,
        startedAt: null,
        lastError: 'Reclaimed after stalled lock',
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(queueJobs.status, 'active'),
          sql`(${queueJobs.lockExpiresAt} IS NULL OR ${queueJobs.lockExpiresAt} <= ${nowIso()})`,
        ),
      )
      .returning({ id: queueJobs.id })
      .all();
    return result.length;
  }

  byId(id: number): QueueJobRow | undefined {
    return this.db.select().from(queueJobs).where(eq(queueJobs.id, id)).get();
  }

  retry(id: number): void {
    this.db
      .update(queueJobs)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        runAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        lockedBy: null,
        lockExpiresAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(queueJobs.id, id))
      .run();
  }

  cancel(id: number): void {
    this.db
      .update(queueJobs)
      .set({ status: 'cancelled', finishedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(queueJobs.id, id))
      .run();
  }

  retryAllFailed(): number {
    const rows = this.db
      .update(queueJobs)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        runAt: nowIso(),
        finishedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(queueJobs.status, 'failed'))
      .returning({ id: queueJobs.id })
      .all();
    return rows.length;
  }

  search(params: Pagination & { status?: QueueStatus; task?: QueueTask }): Paginated<QueueJobDto> {
    const conditions: SQL[] = [];
    if (params.status) conditions.push(eq(queueJobs.status, params.status));
    if (params.task) conditions.push(eq(queueJobs.task, params.task));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = this.db.select({ value: count() }).from(queueJobs).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(queueJobs)
      .where(where)
      .orderBy(desc(queueJobs.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)
      .all();

    return {
      items: rows.map(toQueueJobDto),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  statsByStatus(): Record<QueueStatus, number> {
    const rows = this.db
      .select({ status: queueJobs.status, value: count() })
      .from(queueJobs)
      .groupBy(queueJobs.status)
      .all();
    const base: Record<QueueStatus, number> = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      cancelled: 0,
    };
    for (const row of rows) base[row.status as QueueStatus] = row.value;
    return base;
  }

  statsByTask(): { task: string; status: string; value: number }[] {
    return this.db
      .select({ task: queueJobs.task, status: queueJobs.status, value: count() })
      .from(queueJobs)
      .groupBy(queueJobs.task, queueJobs.status)
      .all();
  }

  purgeCompletedBefore(iso: string): number {
    const rows = this.db
      .delete(queueJobs)
      .where(and(eq(queueJobs.status, 'completed'), lte(queueJobs.finishedAt, iso)))
      .returning({ id: queueJobs.id })
      .all();
    return rows.length;
  }
}
