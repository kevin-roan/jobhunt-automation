import { asc, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  applications,
  jobs,
  remoteCommands,
  syncOutbox,
  syncState,
  type SyncOutboxRow,
} from '../db/schema.js';
import { nowIso, truncate } from '../core/utils.js';

export type SyncEntity = 'job' | 'application' | 'notification';

/** Keys used by the sync service; kept here so both sides agree on spelling. */
export const SYNC_STATE_KEYS = {
  lastSyncAt: 'sync.last_sync_at',
  lastSyncError: 'sync.last_sync_error',
  lastCommandPollAt: 'sync.last_command_poll_at',
  reachable: 'sync.reachable',
  pairedAt: 'sync.paired_at',
  devices: 'sync.devices',
  syncedJobs: 'sync.synced_jobs',
  syncedApplications: 'sync.synced_applications',
} as const;

/**
 * Durable outbox for the Supabase mirror. Nothing is pushed directly from the
 * hot path: writers record an entity id here and the sync service decides much
 * later what (if anything) is allowed to cross the network.
 */
export class SyncRepository {
  constructor(private readonly db: Db) {}

  /**
   * Repeated changes to the same entity collapse into a single pending row, so
   * a job that is scored, enriched and applied to still costs one upload.
   */
  enqueue(entity: SyncEntity, entityId: number): void {
    const timestamp = nowIso();
    this.db
      .insert(syncOutbox)
      .values({ entity, entityId, operation: 'upsert', createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: [syncOutbox.entity, syncOutbox.entityId],
        set: { operation: 'upsert', updatedAt: timestamp },
      })
      .run();
  }

  enqueueMany(entity: SyncEntity, entityIds: number[]): number {
    if (entityIds.length === 0) return 0;
    this.db.transaction(() => {
      for (const entityId of entityIds) this.enqueue(entity, entityId);
    });
    return entityIds.length;
  }

  /** Oldest first: the mirror stays in causal order even after a long outage. */
  claim(limit: number): SyncOutboxRow[] {
    return this.db
      .select()
      .from(syncOutbox)
      .orderBy(asc(syncOutbox.createdAt), asc(syncOutbox.id))
      .limit(limit)
      .all();
  }

  remove(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.delete(syncOutbox).where(inArray(syncOutbox.id, ids)).run();
  }

  fail(id: number, error: string): void {
    this.db
      .update(syncOutbox)
      .set({
        attempts: sql`${syncOutbox.attempts} + 1`,
        lastError: truncate(error, 500),
        updatedAt: nowIso(),
      })
      .where(eq(syncOutbox.id, id))
      .run();
  }

  pendingCount(): number {
    return this.db.select({ value: count() }).from(syncOutbox).get()?.value ?? 0;
  }

  getState(key: string): string | undefined {
    return this.db.select().from(syncState).where(eq(syncState.key, key)).get()?.value;
  }

  setState(key: string, value: string): void {
    const timestamp = nowIso();
    this.db
      .insert(syncState)
      .values({ key, value, updatedAt: timestamp })
      .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: timestamp } })
      .run();
  }

  /** Drops rows that keep failing so one poisoned entity cannot stall the mirror. */
  purgeExhausted(maxAttempts: number): number {
    return this.db
      .delete(syncOutbox)
      .where(gte(syncOutbox.attempts, maxAttempts))
      .returning({ id: syncOutbox.id })
      .all().length;
  }

  allJobIds(): number[] {
    return this.db
      .select({ id: jobs.id })
      .from(jobs)
      .orderBy(asc(jobs.id))
      .all()
      .map((row) => row.id);
  }

  allApplicationIds(): number[] {
    return this.db
      .select({ id: applications.id })
      .from(applications)
      .orderBy(asc(applications.id))
      .all()
      .map((row) => row.id);
  }

  /** Commands pulled from the phone that the local worker has not finished yet. */
  pendingCommandCount(): number {
    return (
      this.db
        .select({ value: count() })
        .from(remoteCommands)
        .where(eq(remoteCommands.status, 'claimed'))
        .get()?.value ?? 0
    );
  }
}
