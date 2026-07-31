import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import { ashbyCollector } from './ashby.collector.js';
import { greenhouseCollector } from './greenhouse.collector.js';
import { indeedCollector } from './indeed.collector.js';
import { leverCollector } from './lever.collector.js';
import { linkedinCollector } from './linkedin.collector.js';
import { recruiteeCollector } from './recruitee.collector.js';
import { smartRecruitersCollector } from './smartrecruiters.collector.js';
import { workableCollector } from './workable.collector.js';
import { workdayCollector } from './workday.collector.js';
import type { CollectorDefinition } from './types.js';

const BUILT_IN: CollectorDefinition[] = [
  greenhouseCollector,
  leverCollector,
  ashbyCollector,
  smartRecruitersCollector,
  workdayCollector,
  workableCollector,
  recruiteeCollector,
  linkedinCollector,
  indeedCollector,
];

function isCollector(value: unknown): value is CollectorDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CollectorDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.collect === 'function'
  );
}

/**
 * Holds every known job source. Built-ins are registered at construction;
 * additional providers are loaded from `DATA_DIR/plugins` at boot without any
 * change to core code.
 */
export class CollectorRegistry {
  private readonly collectors = new Map<string, CollectorDefinition>();

  constructor(private readonly logger: Logger) {
    for (const collector of BUILT_IN) {
      this.collectors.set(collector.id, { ...collector, builtIn: true });
    }
  }

  register(collector: CollectorDefinition): void {
    if (!isCollector(collector)) {
      throw new ValidationError('Collector is missing required fields (id, name, source, collect)');
    }
    if (this.collectors.has(collector.id)) {
      this.logger.warn('collector id already registered; overwriting', { id: collector.id });
    }
    this.collectors.set(collector.id, collector);
    this.logger.info('collector registered', { id: collector.id, builtIn: collector.builtIn ?? false });
  }

  /**
   * Loads `*.collector.js` / `*.collector.mjs` modules from the plugin
   * directory. Each module may default-export a collector or an array of them.
   */
  async loadPlugins(pluginDir: string): Promise<number> {
    let files: string[];
    try {
      files = readdirSync(pluginDir).filter(
        (file) => file.endsWith('.collector.js') || file.endsWith('.collector.mjs'),
      );
    } catch {
      return 0;
    }

    let loaded = 0;
    for (const file of files) {
      const fullPath = path.join(pluginDir, file);
      try {
        const module = (await import(pathToFileURL(fullPath).href)) as {
          default?: unknown;
          collectors?: unknown;
        };
        const exported = module.collectors ?? module.default;
        const candidates = Array.isArray(exported) ? exported : [exported];
        for (const candidate of candidates) {
          if (!isCollector(candidate)) {
            this.logger.warn('plugin export is not a valid collector', { file });
            continue;
          }
          this.register({ ...candidate, builtIn: false });
          loaded += 1;
        }
      } catch (error) {
        this.logger.error('failed to load collector plugin', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return loaded;
  }

  get(id: string): CollectorDefinition | undefined {
    return this.collectors.get(id);
  }

  all(): CollectorDefinition[] {
    return Array.from(this.collectors.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The collectors that should run. An explicit allowlist in Settings wins;
   * otherwise every collector that has the configuration it needs runs.
   */
  enabled(enabledIds: string[], boards: Record<string, string[] | undefined>): CollectorDefinition[] {
    if (enabledIds.length > 0) {
      return enabledIds
        .map((id) => this.collectors.get(id))
        .filter((collector): collector is CollectorDefinition => collector !== undefined);
    }
    return this.all().filter((collector) => {
      if (!collector.requiresBoards) return true;
      return (boards[collector.source] ?? []).length > 0;
    });
  }
}
