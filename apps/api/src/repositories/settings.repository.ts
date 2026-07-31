import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { nowIso } from '../core/utils.js';

export interface SettingRow {
  key: string;
  value: string;
  encrypted: boolean;
}

/** Flat key/value store for settings; one row per dotted path (e.g. `llm.model`). */
export class SettingsRepository {
  constructor(private readonly db: Db) {}

  all(): SettingRow[] {
    return this.db
      .select({ key: settings.key, value: settings.value, encrypted: settings.encrypted })
      .from(settings)
      .all();
  }

  get(key: string): SettingRow | undefined {
    return this.db
      .select({ key: settings.key, value: settings.value, encrypted: settings.encrypted })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
  }

  set(key: string, value: string, encrypted: boolean): void {
    this.db
      .insert(settings)
      .values({ key, value, encrypted, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, encrypted, updatedAt: nowIso() },
      })
      .run();
  }

  setMany(entries: SettingRow[]): void {
    if (entries.length === 0) return;
    this.db.transaction((tx) => {
      const timestamp = nowIso();
      for (const entry of entries) {
        tx.insert(settings)
          .values({ ...entry, updatedAt: timestamp })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: entry.value, encrypted: entry.encrypted, updatedAt: timestamp },
          })
          .run();
      }
    });
  }

  delete(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
