import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/**
 * Opens the SQLite database with the pragmas required for a long-running,
 * crash-safe, concurrently-read workload.
 */
export function createDb(file: string): DbHandle {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  sqlite.pragma('temp_store = MEMORY');

  const db = drizzle(sqlite, { schema }) as Db;

  return {
    db,
    sqlite,
    close() {
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        sqlite.close();
      }
    },
  };
}
