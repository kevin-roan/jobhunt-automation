import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@deedy/shared';
import type { Logger } from '../../src/core/logger.js';
import type { EventBus } from '../../src/core/events.js';
import type { ApplierRegistry } from '../../src/browser/appliers/index.js';
import type { ApplyContext } from '../../src/browser/appliers/types.js';
import type { BrowserManager } from '../../src/browser/browser.manager.js';
import type {
  AnswerBankRepository,
  ApplicationRepository,
} from '../../src/repositories/application.repository.js';
import type { JobRepository } from '../../src/repositories/job.repository.js';
import type {
  CoverLetterRepository,
  ResumeRepository,
} from '../../src/repositories/resume.repository.js';
import type { ResumeRow } from '../../src/db/schema.js';
import type { LlmService } from '../../src/services/llm/llm.service.js';
import type { KeywordService } from '../../src/services/keyword.service.js';
import type { NotificationService } from '../../src/services/notification.service.js';
import type { SettingsService } from '../../src/services/settings.service.js';
import type { CoverLetterService, ResumeService } from '../../src/services/resume.service.js';
import { ApplicationService } from '../../src/services/application.service.js';

interface RecordedLog {
  level: 'info' | 'warn';
  message: string;
  context: Record<string, unknown>;
}

function testLogger(sink: RecordedLog[]): Logger {
  const record =
    (level: 'info' | 'warn') => (message: string, context?: Record<string, unknown>) => {
      sink.push({ level, message, context: context ?? {} });
    };
  const logger: Logger = {
    scope: 'test',
    trace: vi.fn(),
    debug: vi.fn(),
    info: record('info'),
    warn: record('warn'),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function resume(overrides: Partial<ResumeRow> & Pick<ResumeRow, 'id'>): ResumeRow {
  return {
    name: `resume-${overrides.id}`,
    markdown: 'resume text',
    latex: '\\documentclass{article}',
    pdfPath: `/tmp/resume-${overrides.id}.pdf`,
    docxPath: `/tmp/resume-${overrides.id}.docx`,
    compileOk: true,
    ...overrides,
  } as ResumeRow;
}

interface Harness {
  service: ApplicationService;
  logs: RecordedLog[];
  /** The resume path the applier was actually handed. */
  usedResumePath: () => string | null;
  tailorCalls: () => number;
}

function harness(options: {
  jobScore: number | null;
  tailored?: ResumeRow;
  application?: Partial<Settings['application']>;
  pipeline?: Partial<Settings['pipeline']>;
}): Harness {
  const logs: RecordedLog[] = [];
  const logger = testLogger(logs);
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    // A dry run keeps the daily-limit policy out of the way; the document
    // preparation under test runs identically either way.
    browser: { ...DEFAULT_SETTINGS.browser, dryRun: true },
    application: {
      ...DEFAULT_SETTINGS.application,
      generateCoverLetter: false,
      defaultResumeId: 1,
      ...options.application,
    },
    pipeline: { ...DEFAULT_SETTINGS.pipeline, ...options.pipeline },
  };

  const base = resume({ id: 1 });
  const rows = new Map<number, ResumeRow>([[1, base]]);
  if (options.tailored) rows.set(options.tailored.id, options.tailored);

  let handed: string | null = null;
  let tailorCalls = 0;

  const service = new ApplicationService(
    {
      ensure: () => ({ id: 7, status: 'pending', startedAt: null, dryRun: true, confirmationText: null }),
      incrementAttempt: () => 1,
      update: () => undefined,
      completedSteps: () => new Set(),
      recordEvent: () => undefined,
      addArtifact: () => undefined,
      byId: () => ({ id: 7, currentStep: 'navigate' }),
      setStatus: () => undefined,
    } as unknown as ApplicationRepository,
    {} as unknown as AnswerBankRepository,
    {
      byId: () => ({
        id: 5,
        title: 'Senior Backend Engineer',
        company: 'Acme',
        source: 'linkedin',
        applicationUrl: 'https://example.test/apply',
        score: options.jobScore,
        skills: [],
      }),
      setStatus: () => undefined,
    } as unknown as JobRepository,
    {
      byId: (id: number) => rows.get(id),
      defaultResume: () => base,
    } as unknown as ResumeRepository,
    {} as unknown as CoverLetterRepository,
    {
      tailorForJob: () => {
        tailorCalls += 1;
        if (!options.tailored) throw new Error('tailoring was not expected here');
        return Promise.resolve(options.tailored);
      },
    } as unknown as ResumeService,
    { generate: () => Promise.reject(new Error('not used')) } as unknown as CoverLetterService,
    {
      resolve: () => ({
        provider: 'test',
        apply: (context: ApplyContext) => {
          handed = context.documents.resumePath;
          return Promise.resolve({ submitted: true, confirmationText: null, needsHuman: null });
        },
      }),
    } as unknown as ApplierRegistry,
    {
      newPage: () => Promise.resolve({ close: () => Promise.resolve() }),
      capture: () => Promise.resolve({ screenshotPath: null, htmlPath: null }),
      saveStorageState: () => Promise.resolve(),
    } as unknown as BrowserManager,
    {} as unknown as LlmService,
    { get: () => settings } as unknown as SettingsService,
    {
      applicationSubmitted: () => Promise.resolve(),
      applicationFailed: () => Promise.resolve(),
      needsHuman: () => Promise.resolve(),
    } as unknown as NotificationService,
    {} as unknown as KeywordService,
    logger,
    { emit: () => undefined } as unknown as EventBus,
  );

  return { service, logs, usedResumePath: () => handed, tailorCalls: () => tailorCalls };
}

describe('ApplicationService document preparation', () => {
  it('uploads the tailored resume when it compiled', async () => {
    const h = harness({ jobScore: 88, tailored: resume({ id: 2, compileOk: true }) });

    await h.service.apply({ jobId: 5 });

    expect(h.usedResumePath()).toBe('/tmp/resume-2.pdf');
  });

  it('falls back to the base resume when the tailored one did not compile', async () => {
    // A failed compile leaves no PDF, so the applier would otherwise upload a
    // DOCX rendered from broken LaTeX and report success.
    const h = harness({
      jobScore: 88,
      tailored: resume({ id: 2, compileOk: false, pdfPath: null }),
    });

    await h.service.apply({ jobId: 5 });

    expect(h.usedResumePath()).toBe('/tmp/resume-1.pdf');
    expect(
      h.logs.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message === 'tailored resume did not compile; falling back to the base resume',
      ),
    ).toBe(true);
  });

  it('says out loud that an unscored job is not tailored', async () => {
    const h = harness({ jobScore: null });

    await h.service.apply({ jobId: 5 });

    expect(h.tailorCalls()).toBe(0);
    expect(h.usedResumePath()).toBe('/tmp/resume-1.pdf');
    expect(
      h.logs.some((entry) => entry.message === 'resume not tailored: the job has no score yet'),
    ).toBe(true);
  });

  it('says out loud that a low-scoring job is not tailored', async () => {
    const h = harness({ jobScore: 12, application: { minScoreToTailor: 60 } });

    await h.service.apply({ jobId: 5 });

    expect(h.tailorCalls()).toBe(0);
    expect(
      h.logs.some(
        (entry) =>
          entry.message === 'resume not tailored: score is below the tailoring threshold' &&
          entry.context.score === 12,
      ),
    ).toBe(true);
  });

  it('honours a stopped tailor stage', async () => {
    // Stopping the stage is how the user gives the CPU back; an inline apply
    // spending two generations anyway would make the switch a lie.
    const h = harness({ jobScore: 88, pipeline: { tailor: false } });

    await h.service.apply({ jobId: 5 });

    expect(h.tailorCalls()).toBe(0);
    expect(h.usedResumePath()).toBe('/tmp/resume-1.pdf');
  });
});
