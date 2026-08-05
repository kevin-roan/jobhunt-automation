import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { searchKeywords } from '../../src/db/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ConflictError } from '../../src/core/errors.js';
import type { Logger } from '../../src/core/logger.js';
import { KeywordRepository } from '../../src/repositories/keyword.repository.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import { SettingsService } from '../../src/services/settings.service.js';
import { KeywordService } from '../../src/services/keyword.service.js';
import type { LlmService } from '../../src/services/llm/llm.service.js';

/** One throwaway directory per run; every test gets its own database file inside it. */
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-keywords-test-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function createTestLogger(): Logger {
  const logger: Logger = {
    scope: 'test',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  handle: DbHandle;
  repository: KeywordRepository;
  settings: SettingsService;
  keywords: KeywordService;
  /** Resolves when a run the service fired in the background has settled. */
  expansions: string[][];
}

let counter = 0;

function harness(): Harness {
  counter += 1;
  const handle = createDb(path.join(root, `keywords-${counter}.sqlite`));
  runMigrations(handle.sqlite);
  const logger = createTestLogger();
  const settings = new SettingsService(
    new SettingsRepository(handle.db),
    randomBytes(32),
    logger,
    new EventBus(logger),
  );
  settings.bootstrap();

  const expansions: string[][] = [];
  // The local model is never reachable in tests; recording the call is enough to
  // prove auto-expansion fired (or did not) without inventing a fake response.
  const llm = {
    run: vi.fn((_task: string, options: { variables: Record<string, string> }) => {
      expansions.push((options.variables.seeds ?? '').split('\n').filter((s) => s.length > 0));
      return Promise.reject(new Error('llm offline'));
    }),
  } as unknown as LlmService;

  const repository = new KeywordRepository(handle.db);
  const keywords = new KeywordService(repository, settings, llm, logger);
  return { handle, repository, settings, keywords, expansions };
}

/** Inserts an llm-generated expansion the way `expand` would have. */
function expansion(repository: KeywordRepository, keyword: string, seed: string): void {
  repository.upsertMany([
    {
      keyword,
      normalized: keyword.toLowerCase(),
      seed,
      origin: 'llm',
      kind: 'alternate_title',
      confidence: 0.9,
      enabled: true,
      sources: [],
    },
  ]);
}

describe('KeywordService.syncSeeds', () => {
  let h: Harness;

  beforeEach(() => {
    h?.handle.close();
    h = harness();
  });

  afterAll(() => h.handle.close());

  it('keeps terms hand-added on the Keywords page', () => {
    h.settings.update({ search: { keywords: ['rust'] } });
    h.keywords.create({ keywords: 'staff platform engineer', origin: 'user', sources: [] });

    const result = h.keywords.syncSeedsDetailed();

    const terms = result.keywords.map((row) => row.keyword);
    expect(terms).toContain('staff platform engineer');
    expect(terms).toContain('rust');
    expect(result.removedSeeds).toBe(0);
  });

  it('removes a seed dropped from Settings together with its expansions', () => {
    h.settings.update({ search: { keywords: ['rust'] } });
    h.keywords.syncSeeds();
    for (const term of ['systems engineer', 'embedded engineer', 'firmware engineer']) {
      expansion(h.repository, term, 'rust');
    }
    expect(h.repository.list()).toHaveLength(4);

    h.settings.update({ search: { keywords: [] } });
    const result = h.keywords.syncSeedsDetailed();

    expect(result.removedSeeds).toBe(1);
    expect(result.removedExpansions).toBe(3);
    expect(result.keywords).toHaveLength(0);
    expect(h.keywords.activeFor('linkedin')).toEqual([]);
  });

  it('runs automatically when Settings changes its seed list', () => {
    h.settings.onSearchKeywordsChanged(() => {
      h.keywords.handleSeedsChanged();
    });

    h.settings.update({ search: { keywords: ['rust'] } });
    expect(h.repository.list().map((row) => row.keyword)).toEqual(['rust']);
    expansion(h.repository, 'systems engineer', 'rust');

    h.settings.update({ search: { keywords: ['golang'] } });
    expect(h.repository.list().map((row) => row.keyword)).toEqual(['golang']);
    // The seed change alone must not call the model while autoExpandOnSeedChange is off.
    expect(h.expansions).toHaveLength(0);
  });

  it('expands in the background when autoExpandOnSeedChange is on, without failing the save', async () => {
    h.settings.onSearchKeywordsChanged(() => {
      h.keywords.handleSeedsChanged();
    });
    h.settings.update({ search: { keywordExpansion: { autoExpandOnSeedChange: true } } });

    expect(() => h.settings.update({ search: { keywords: ['rust'] } })).not.toThrow();
    await vi.waitFor(() => expect(h.expansions).toEqual([['rust']]));
  });
});

describe('KeywordService editing', () => {
  let h: Harness;

  beforeEach(() => {
    h?.handle.close();
    h = harness();
  });

  afterAll(() => h.handle.close());

  it('rejects a rename onto an existing term with a conflict, not a SQL error', () => {
    h.keywords.create({ keywords: 'rust, golang', origin: 'user', sources: [] });
    const golang = h.repository.list().find((row) => row.keyword === 'golang');

    expect(() => h.keywords.update(golang?.id ?? 0, { keyword: 'Rust' })).toThrow(ConflictError);
    expect(() => h.keywords.update(golang?.id ?? 0, { keyword: 'Rust' })).toThrow(/rust/i);
  });

  it('records searches against the rows the collector actually used', () => {
    h.keywords.create({ keywords: 'rust, golang', origin: 'user', sources: [] });

    h.keywords.markSearched('linkedin', ['rust'], 7);

    const rows = h.handle.db.select().from(searchKeywords).all();
    const rust = rows.find((row) => row.keyword === 'rust');
    const golang = rows.find((row) => row.keyword === 'golang');
    expect(rust?.jobsFound).toBe(7);
    expect(rust?.lastUsedAt).not.toBeNull();
    expect(golang?.jobsFound).toBe(0);
    expect(golang?.lastUsedAt).toBeNull();
  });
});

describe('KeywordService.activeFor', () => {
  let h: Harness;

  beforeEach(() => {
    h?.handle.close();
    h = harness();
  });

  afterAll(() => h.handle.close());

  it('falls back to the settings seeds only while the table is empty', () => {
    h.settings.update({ search: { keywords: ['rust'] } });
    expect(h.keywords.activeFor('indeed')).toEqual(['rust']);

    h.keywords.create({ keywords: 'golang', origin: 'user', sources: ['linkedin'] });
    // Populated table wins: scoping a term to LinkedIn is a decision, so Indeed
    // gets nothing rather than silently re-running the raw seed list.
    expect(h.keywords.activeFor('linkedin')).toEqual(['golang']);
    expect(h.keywords.activeFor('indeed')).toEqual([]);
  });
});
