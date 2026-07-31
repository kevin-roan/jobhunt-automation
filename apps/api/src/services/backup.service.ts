import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppPaths } from '../config/env.js';
import type { Logger } from '../core/logger.js';
import { toErrorMessage } from '../core/errors.js';
import type { SettingsService } from './settings.service.js';

export interface BackupResult {
  path: string;
  bytes: number;
  removed: number;
}

/**
 * Uses SQLite's online backup API so a consistent snapshot can be taken while
 * the application keeps writing.
 */
export class BackupService {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly paths: AppPaths,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<BackupResult> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.paths.backups, `deedy-${stamp}.sqlite`);

    await this.sqlite.backup(target);
    const bytes = statSync(target).size;
    const removed = this.prune();

    this.logger.info('backup completed', { target, bytes, removed });
    return { path: target, bytes, removed };
  }

  /** Keeps only the N most recent backups configured in Settings → Scheduler. */
  private prune(): number {
    const keep = this.settingsService.get().scheduler.backupsToKeep;
    let removed = 0;
    try {
      const files = readdirSync(this.paths.backups)
        .filter((file) => file.startsWith('deedy-') && file.endsWith('.sqlite'))
        .sort()
        .reverse();

      for (const file of files.slice(keep)) {
        unlinkSync(path.join(this.paths.backups, file));
        removed += 1;
      }
    } catch (error) {
      this.logger.warn('failed to prune old backups', { error: toErrorMessage(error) });
    }
    return removed;
  }

  list(): { name: string; bytes: number; createdAt: string }[] {
    try {
      return readdirSync(this.paths.backups)
        .filter((file) => file.endsWith('.sqlite'))
        .map((file) => {
          const stats = statSync(path.join(this.paths.backups, file));
          return { name: file, bytes: stats.size, createdAt: stats.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }
}
