import { desc, eq } from 'drizzle-orm';
import type { BrowserSessionDto, CollectorRunDto } from '@deedy/shared';
import type { Db } from '../db/client.js';
import {
  browserSessions,
  collectorRuns,
  schedulerState,
  type BrowserSessionRow,
  type CollectorRunRow,
} from '../db/schema.js';
import { nowIso } from '../core/utils.js';

export function toBrowserSessionDto(row: BrowserSessionRow): BrowserSessionDto {
  return {
    id: row.id,
    provider: row.provider,
    engine: row.engine,
    profilePath: row.profilePath,
    loggedIn: row.loggedIn,
    lastUsedAt: row.lastUsedAt,
    lastCheckAt: row.lastCheckAt,
    storageStatePath: row.storageStatePath,
    note: row.note,
    createdAt: row.createdAt,
  };
}

export class BrowserSessionRepository {
  constructor(private readonly db: Db) {}

  list(): BrowserSessionRow[] {
    return this.db.select().from(browserSessions).orderBy(browserSessions.provider).all();
  }

  byProvider(provider: string): BrowserSessionRow | undefined {
    return this.db.select().from(browserSessions).where(eq(browserSessions.provider, provider)).get();
  }

  ensure(input: {
    provider: string;
    engine: string;
    profilePath: string;
    storageStatePath: string | null;
  }): BrowserSessionRow {
    const existing = this.byProvider(input.provider);
    if (existing) {
      return (
        this.db
          .update(browserSessions)
          .set({
            engine: input.engine,
            profilePath: input.profilePath,
            storageStatePath: input.storageStatePath,
            updatedAt: nowIso(),
          })
          .where(eq(browserSessions.id, existing.id))
          .returning()
          .get() ?? existing
      );
    }
    return this.db.insert(browserSessions).values(input).returning().get();
  }

  markUsed(provider: string): void {
    this.db
      .update(browserSessions)
      .set({ lastUsedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(browserSessions.provider, provider))
      .run();
  }

  setLoggedIn(provider: string, loggedIn: boolean, note?: string | null): void {
    this.db
      .update(browserSessions)
      .set({ loggedIn, lastCheckAt: nowIso(), note: note ?? null, updatedAt: nowIso() })
      .where(eq(browserSessions.provider, provider))
      .run();
  }

  delete(provider: string): void {
    this.db.delete(browserSessions).where(eq(browserSessions.provider, provider)).run();
  }
}

export function toCollectorRunDto(row: CollectorRunRow): CollectorRunDto {
  return {
    id: row.id,
    collectorId: row.collectorId,
    status: row.status,
    found: row.found,
    inserted: row.inserted,
    duplicates: row.duplicates,
    errors: row.errors,
    message: row.message,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export class CollectorRunRepository {
  constructor(private readonly db: Db) {}

  start(collectorId: string): number {
    return this.db
      .insert(collectorRuns)
      .values({ collectorId, status: 'running' })
      .returning({ id: collectorRuns.id })
      .get().id;
  }

  finish(
    id: number,
    result: {
      status: 'completed' | 'failed';
      found: number;
      inserted: number;
      duplicates: number;
      errors: number;
      message?: string | null;
    },
  ): void {
    this.db
      .update(collectorRuns)
      .set({ ...result, message: result.message ?? null, finishedAt: nowIso() })
      .where(eq(collectorRuns.id, id))
      .run();
  }

  recent(limit = 50): CollectorRunRow[] {
    return this.db
      .select()
      .from(collectorRuns)
      .orderBy(desc(collectorRuns.id))
      .limit(limit)
      .all();
  }
}

export class SchedulerStateRepository {
  constructor(private readonly db: Db) {}

  all() {
    return this.db.select().from(schedulerState).all();
  }

  get(name: string) {
    return this.db.select().from(schedulerState).where(eq(schedulerState.name, name)).get();
  }

  /** Persisted so intervals survive a restart instead of resetting the clock. */
  upsert(name: string, patch: { lastRunAt?: string; nextRunAt?: string; running?: boolean; lastError?: string | null }): void {
    this.db
      .insert(schedulerState)
      .values({ name, ...patch })
      .onConflictDoUpdate({ target: schedulerState.name, set: patch })
      .run();
  }
}
