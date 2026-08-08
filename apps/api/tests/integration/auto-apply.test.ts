import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EventBus } from '../../src/core/events.js';
import type { Logger } from '../../src/core/logger.js';
import { KeywordRepository } from '../../src/repositories/keyword.repository.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import { SettingsService } from '../../src/services/settings.service.js';
import { KeywordService } from '../../src/services/keyword.service.js';
import type { JobRepository } from '../../src/repositories/job.repository.js';
import type { QueueRepository } from '../../src/repositories/queue.repository.js';
import type { LlmService } from '../../src/services/llm/llm.service.js';
import {
  ApplicationService,
  type AutoApplyCandidate,
} from '../../src/services/application.service.js';
import type { JobService } from '../../src/services/job.service.js';
import { createHandlers, type HandlerDependencies } from '../../src/queue/handlers.js';
import {
  createScheduledTasks,
  type SchedulerTaskDependencies,
} from '../../src/scheduler/scheduler.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-auto-apply-test-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface RecordedLog {
  message: string;
  context: Record<string, unknown>;
}

function createTestLogger(sink: RecordedLog[]): Logger {
  const logger: Logger = {
    scope: 'test',
    trace: vi.fn(),
    debug: vi.fn(),
    info: (message: string, context?: Record<string, unknown>) => {
      sink.push({ message, context: context ?? {} });
    },
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  handle: DbHandle;
  settings: SettingsService;
  keywords: KeywordService;
  applications: ApplicationService;
  logs: RecordedLog[];
}

let counter = 0;

/**
 * The keyword gate reads exactly four collaborators — settings, keywords, the
 * logger, and nothing else — so the remaining constructor arguments are left
 * unset rather than faked. Touching one from `autoApplyEligibility` would throw
 * here, which is the point: the gate must stay free of the browser stack.
 */
function harness(): Harness {
  counter += 1;
  const handle = createDb(path.join(root, `auto-apply-${counter}.sqlite`));
  runMigrations(handle.sqlite);
  const logs: RecordedLog[] = [];
  const logger = createTestLogger(logs);

  const settings = new SettingsService(
    new SettingsRepository(handle.db),
    randomBytes(32),
    logger,
    new EventBus(logger),
  );
  settings.bootstrap();
  // The keyword table is only authoritative once it holds a row; until then
  // `activeFor` falls back to the settings seeds, which would quietly rescue
  // every "no keywords enabled" case below.
  settings.update({ search: { keywords: [] } });

  const llm = { run: vi.fn() } as unknown as LlmService;
  const keywords = new KeywordService(new KeywordRepository(handle.db), settings, llm, logger);

  const unused = undefined as never;
  const applications = new ApplicationService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    settings,
    unused,
    keywords,
    logger,
    unused,
  );

  return { handle, settings, keywords, applications, logs };
}

function job(overrides: Partial<AutoApplyCandidate> = {}): AutoApplyCandidate {
  return {
    id: 1,
    title: 'Senior Backend Engineer',
    source: 'linkedin',
    skills: ['Postgres', 'Kubernetes'],
    ...overrides,
  };
}

describe('ApplicationService.autoApplyEligibility', () => {
  let h: Harness;

  beforeEach(() => {
    h?.handle.close();
    h = harness();
  });

  afterAll(() => h.handle.close());

  it('defaults to title_or_skills', () => {
    expect(DEFAULT_SETTINGS.application.keywordMatch).toBe('title_or_skills');
  });

  it('lets everything through when the mode is off, even with no keywords', () => {
    h.settings.update({ application: { keywordMatch: 'off' } });

    const result = h.applications.autoApplyEligibility(job({ title: 'Pastry Chef', skills: [] }));

    expect(result).toEqual({ eligible: true, reason: null });
  });

  it('accepts a title that matches an enabled keyword under title', () => {
    h.keywords.create({ keywords: 'backend engineer', origin: 'user', sources: [] });
    h.settings.update({ application: { keywordMatch: 'title' } });

    expect(h.applications.autoApplyEligibility(job()).eligible).toBe(true);
  });

  it('rejects a skills-only match under title but accepts it under title_or_skills', () => {
    h.keywords.create({ keywords: 'kubernetes', origin: 'user', sources: [] });
    const candidate = job({ title: 'Infrastructure Generalist', skills: ['Kubernetes', 'Go'] });

    h.settings.update({ application: { keywordMatch: 'title' } });
    const strict = h.applications.autoApplyEligibility(candidate);
    expect(strict.eligible).toBe(false);
    expect(strict.reason).toBe('title does not match any enabled keyword');

    h.settings.update({ application: { keywordMatch: 'title_or_skills' } });
    expect(h.applications.autoApplyEligibility(candidate).eligible).toBe(true);
  });

  it('rejects a job that matches neither title nor skills', () => {
    h.keywords.create({ keywords: 'rust', origin: 'user', sources: [] });
    h.settings.update({ application: { keywordMatch: 'title_or_skills' } });

    const result = h.applications.autoApplyEligibility(job());

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('neither title nor extracted skills match any enabled keyword');
  });

  it('refuses everything when no keyword is enabled at all, and says so', () => {
    h.settings.update({ application: { keywordMatch: 'title_or_skills' } });

    const result = h.applications.autoApplyEligibility(job());

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('no keywords are enabled at all');
  });

  it('distinguishes "nothing enabled for this source" from "nothing enabled"', () => {
    h.keywords.create({ keywords: 'backend engineer', origin: 'user', sources: ['indeed'] });
    h.settings.update({ application: { keywordMatch: 'title_or_skills' } });

    const scoped = h.applications.autoApplyEligibility(job({ source: 'linkedin' }));
    expect(scoped.eligible).toBe(false);
    expect(scoped.reason).toBe('no keyword is enabled for source "linkedin"');

    expect(h.applications.autoApplyEligibility(job({ source: 'indeed' })).eligible).toBe(true);
  });

  it('ignores a keyword the user disabled', () => {
    const created = h.keywords.create({ keywords: 'backend engineer', origin: 'user', sources: [] });
    const row = created.keywords[0];
    if (!row) throw new Error('keyword was not created');
    h.keywords.update(row.id, { enabled: false });
    h.settings.update({ application: { keywordMatch: 'title' } });

    expect(h.applications.autoApplyEligibility(job()).eligible).toBe(false);
  });

  it('logs every skip with the job id, title and an actionable reason', () => {
    h.keywords.create({ keywords: 'rust', origin: 'user', sources: [] });
    h.settings.update({ application: { keywordMatch: 'title_or_skills' } });

    expect(h.applications.allowsAutoApply(job({ id: 77 }))).toBe(false);

    const skip = h.logs.find((entry) => entry.message === 'auto-apply skipped by keyword gate');
    expect(skip?.context).toMatchObject({
      jobId: 77,
      title: 'Senior Backend Engineer',
      reason: 'neither title nor extracted skills match any enabled keyword',
    });
  });

  it('says nothing when the job is eligible', () => {
    h.keywords.create({ keywords: 'backend engineer', origin: 'user', sources: [] });
    h.settings.update({ application: { keywordMatch: 'title' } });

    expect(h.applications.allowsAutoApply(job())).toBe(true);
    expect(h.logs.some((entry) => entry.message.includes('keyword gate'))).toBe(false);
  });
});

/**
 * The `job.score` handler re-derives the auto-apply criteria inline instead of
 * going through `readyToApply`, and it is the dominant source of auto-applies.
 * A gate that only the scheduler consults leaks entirely through here, so this
 * asserts the handler itself asks.
 */
describe('job.score handler', () => {
  interface Enqueued {
    task: string;
    payload: Record<string, unknown>;
    dedupeKey: string | undefined;
    priority: number | undefined;
  }

  interface ScoreHarness {
    run: (payload?: unknown) => Promise<void>;
    /** Distinct rows, deduplicated the way the repository deduplicates them. */
    enqueued: Enqueued[];
    tasks: () => string[];
  }

  function scoreHandler(options: {
    eligible: boolean;
    score?: number;
    application?: Partial<Settings['application']>;
  }): ScoreHarness {
    const enqueued: Enqueued[] = [];
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      application: {
        ...DEFAULT_SETTINGS.application,
        autoApply: true,
        minScoreToApply: 70,
        ...options.application,
      },
    };
    const score = options.score ?? 91;

    const deps = {
      jobService: {
        score: () => Promise.resolve({ score, recommendation: 'apply' }),
      } as unknown as JobService,
      applicationService: {
        allowsAutoApply: () => options.eligible,
      } as unknown as ApplicationService,
      settingsService: { get: () => settings },
      queue: {
        // Mirrors `QueueRepository.enqueue`: a key already present is the same
        // unit of work, not a second one. Re-scoring must land here, not in a
        // duplicate row.
        enqueue: (input: Enqueued) => {
          const existing = input.dedupeKey
            ? enqueued.find((row) => row.dedupeKey === input.dedupeKey)
            : undefined;
          if (existing) return { id: 1 };
          enqueued.push(input);
          return { id: enqueued.length };
        },
      } as unknown as QueueRepository,
      jobs: {
        byId: () => ({ id: 5, title: 'Senior Backend Engineer', source: 'linkedin', skills: [] }),
      } as unknown as JobRepository,
    } as unknown as HandlerDependencies;

    const handlers = createHandlers(deps);
    const handler = handlers['job.score'];
    if (!handler) throw new Error('job.score handler is not registered');
    return {
      enqueued,
      tasks: () => enqueued.map((row) => row.task),
      run: (payload: unknown = { jobId: 5 }) =>
        handler(payload, { id: 1 } as never, new AbortController().signal) as Promise<void>,
    };
  }

  it('enqueues an apply when the keyword gate allows it', async () => {
    const h = scoreHandler({ eligible: true });
    await h.run();
    expect(h.tasks()).toContain('application.apply');
  });

  it('does not enqueue an apply when the keyword gate refuses', async () => {
    const h = scoreHandler({ eligible: false });
    await h.run();
    expect(h.tasks()).toEqual([]);
  });

  it('tailors above the threshold even with auto-apply off', async () => {
    const h = scoreHandler({ eligible: true, application: { autoApply: false } });
    await h.run();

    // The documents are what the user reviews by hand, so they must not depend
    // on the switch that decides whether anything is ever submitted.
    expect(h.tasks()).toEqual(['resume.tailor']);
    const tailor = h.enqueued[0];
    expect(tailor?.payload).toMatchObject({ jobId: 5, coverLetter: true });
    // Below the apply priority, above scoring and enrichment.
    expect(tailor?.priority).toBe(8);
  });

  it('enqueues no documents below minScoreToTailor', async () => {
    const h = scoreHandler({
      eligible: true,
      score: 40,
      application: { autoApply: false, minScoreToTailor: 60 },
    });
    await h.run();
    expect(h.tasks()).toEqual([]);
  });

  it('enqueues no documents for a job the keyword gate refuses', async () => {
    const h = scoreHandler({ eligible: false, application: { autoApply: false } });
    await h.run();
    expect(h.tasks()).toEqual([]);
  });

  it('generates a cover letter directly when tailoring is off', async () => {
    const h = scoreHandler({
      eligible: true,
      application: { autoApply: false, tailorResume: false, generateCoverLetter: true },
    });
    await h.run();

    expect(h.tasks()).toEqual(['cover_letter.generate']);
    expect(h.enqueued[0]?.dedupeKey).toBe('cover_letter.generate:5');
  });

  it('enqueues nothing when both document toggles are off and auto-apply is off', async () => {
    const h = scoreHandler({
      eligible: true,
      application: { autoApply: false, tailorResume: false, generateCoverLetter: false },
    });
    await h.run();
    expect(h.tasks()).toEqual([]);
  });

  it('does not duplicate work when a job is scored again', async () => {
    const h = scoreHandler({ eligible: true });
    await h.run();
    await h.run();
    await h.run();

    expect(h.tasks()).toEqual(['resume.tailor', 'application.apply']);
    expect(h.enqueued.map((row) => row.dedupeKey)).toEqual([
      'resume.tailor:5:default',
      'application.apply:5',
    ]);
  });
});

/**
 * The cover letter has to argue from the resume that will actually be uploaded,
 * which is only knowable once the tailoring has run — hence the chain.
 */
describe('resume.tailor handler', () => {
  function tailorHandler(): {
    run: (payload: unknown) => Promise<void>;
    enqueued: { task: string; payload: Record<string, unknown>; dedupeKey?: string }[];
  } {
    const enqueued: { task: string; payload: Record<string, unknown>; dedupeKey?: string }[] = [];
    const deps = {
      resumeService: {
        tailorForJob: () => Promise.resolve({ id: 42 }),
      },
      queue: {
        enqueue: (input: { task: string; payload: Record<string, unknown>; dedupeKey?: string }) => {
          enqueued.push(input);
          return { id: enqueued.length };
        },
      } as unknown as QueueRepository,
    } as unknown as HandlerDependencies;

    const handler = createHandlers(deps)['resume.tailor'];
    if (!handler) throw new Error('resume.tailor handler is not registered');
    return {
      enqueued,
      run: (payload: unknown) =>
        handler(payload, { id: 1 } as never, new AbortController().signal) as Promise<void>,
    };
  }

  it('chains the cover letter onto the tailored resume it just produced', async () => {
    const h = tailorHandler();
    await h.run({ jobId: 5, coverLetter: true });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      task: 'cover_letter.generate',
      payload: { jobId: 5, resumeId: 42 },
      dedupeKey: 'cover_letter.generate:5',
    });
  });

  it('chains nothing when the cover letter was not asked for', async () => {
    const h = tailorHandler();
    await h.run({ jobId: 5 });
    expect(h.enqueued).toEqual([]);
  });
});

describe('scheduler apply task', () => {
  function applyTask(options: { eligible: boolean }): {
    run: () => Promise<void>;
    enqueued: string[];
  } {
    const enqueued: string[] = [];
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      application: { ...DEFAULT_SETTINGS.application, autoApply: true },
    };

    const tasks = createScheduledTasks({
      queue: {
        enqueue: (input: { task: string }) => {
          enqueued.push(input.task);
          return 1;
        },
      } as unknown as QueueRepository,
      jobs: {
        readyToApply: () => [
          { id: 5, title: 'Senior Backend Engineer', source: 'linkedin', skills: [] },
        ],
      } as unknown as JobRepository,
      applicationService: {
        recoverStuck: () => 0,
        allowsAutoApply: () => options.eligible,
      } as unknown as ApplicationService,
      settingsService: { get: () => settings },
    } as unknown as SchedulerTaskDependencies);

    const task = tasks.find((entry) => entry.name === 'apply');
    if (!task) throw new Error('apply task is not registered');
    return { enqueued, run: () => task.run() };
  }

  it('enqueues an apply when the keyword gate allows it', async () => {
    const { run, enqueued } = applyTask({ eligible: true });
    await run();
    expect(enqueued).toEqual(['application.apply']);
  });

  it('does not enqueue an apply when the keyword gate refuses', async () => {
    const { run, enqueued } = applyTask({ eligible: false });
    await run();
    expect(enqueued).toEqual([]);
  });
});
