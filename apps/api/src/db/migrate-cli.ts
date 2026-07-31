import { loadConfig } from '../config/env.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const { sqlite, close } = createDb(config.paths.db);

try {
  const result = runMigrations(sqlite);
  process.stdout.write(
    `Applied ${result.applied.length} migration(s): ${result.applied.join(', ') || '(none)'}\n` +
      `Already applied: ${result.skipped.length}\n`,
  );
} finally {
  close();
}
