import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Migrations live next to the compiled output as well as in the source tree. */
export function migrationsDir(): string {
  const candidates = [
    path.resolve(here, '../../migrations'),
    path.resolve(here, '../../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'apps/api/migrations'),
  ];
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Could not locate migrations directory. Tried: ${candidates.join(', ')}`);
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies every not-yet-applied .sql file in lexicographic order inside a single
 * transaction per file, recording each in `_migrations`. Safe to run on boot.
 */
export function runMigrations(sqlite: Database.Database, dir = migrationsDir()): MigrationResult {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const alreadyApplied = new Set(
    sqlite
      .prepare<[], { name: string }>('SELECT name FROM _migrations')
      .all()
      .map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sqlText = readFileSync(path.join(dir, file), 'utf8');
    const apply = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });
    apply();
    applied.push(file);
  }

  return { applied, skipped };
}
