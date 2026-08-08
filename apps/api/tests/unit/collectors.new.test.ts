import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { DEFAULT_SETTINGS, type SessionStrategy, type Settings } from '@deedy/shared';

import { ashbyCollector } from '../../src/collectors/ashby.collector.js';
import { greenhouseCollector } from '../../src/collectors/greenhouse.collector.js';
import { leverCollector } from '../../src/collectors/lever.collector.js';
import {
  challengeFixHint,
  isChallengePage,
  isSignedOutUrl,
  linkedinCollector,
  noListingsFixHint,
  searchChallengeFixHint,
  sessionFixHint as linkedinSessionFixHint,
} from '../../src/collectors/linkedin.collector.js';
import {
  indeedCollector,
  sessionFixHint as indeedSessionFixHint,
} from '../../src/collectors/indeed.collector.js';
import { recruiteeCollector } from '../../src/collectors/recruitee.collector.js';
import { smartRecruitersCollector } from '../../src/collectors/smartrecruiters.collector.js';
import { workableCollector } from '../../src/collectors/workable.collector.js';
import { workdayCollector } from '../../src/collectors/workday.collector.js';
import {
  HttpError,
  type CollectorContext,
  type CollectorDefinition,
  type HttpClient,
} from '../../src/collectors/types.js';
import type { BrowserManager } from '../../src/browser/browser.manager.js';
import type { LogContext, Logger } from '../../src/core/logger.js';

const DAY_MS = 86400000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

interface LogEntry {
  level: string;
  message: string;
  context?: LogContext;
}

interface FakeLogger extends Logger {
  readonly entries: LogEntry[];
  messages(level: string): string[];
}

function createFakeLogger(scope = 'test'): FakeLogger {
  const entries: LogEntry[] = [];
  const push =
    (level: string) =>
    (message: string, context?: LogContext): void => {
      entries.push({ level, message, context });
    };
  const logger: FakeLogger = {
    scope,
    entries,
    messages(level: string): string[] {
      return entries.filter((entry) => entry.level === level).map((entry) => entry.message);
    },
    trace: push('trace'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    fatal: push('fatal'),
    child: (): Logger => logger,
  };
  return logger;
}

/**
 * Routes are matched by substring so a test only has to name the distinctive
 * part of a provider URL. A route value that is an Error is thrown instead of
 * returned, which is how board failures are simulated.
 */
type Routes = Record<string, unknown>;

interface StubHttp extends HttpClient {
  readonly requests: string[];
}

function createStubHttp(routes: Routes): StubHttp {
  const requests: string[] = [];

  function resolve(url: string): unknown {
    requests.push(url);
    for (const [fragment, value] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new HttpError(`No stub route for ${url}`, 404, url);
  }

  return {
    requests,
    getJson<T>(url: string): Promise<T> {
      return Promise.resolve(resolve(url) as T);
    },
    getText(url: string): Promise<string> {
      return Promise.resolve(String(resolve(url)));
    },
    postJson<T>(url: string): Promise<T> {
      return Promise.resolve(resolve(url) as T);
    },
  };
}

/** Any property access is a bug: these collectors are HTTP-only. */
const noBrowser = new Proxy(
  {},
  {
    get(): never {
      throw new Error('collector must not touch the browser');
    },
  },
) as BrowserManager;

function makeSettings(search: Partial<Settings['search']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, search: { ...DEFAULT_SETTINGS.search, ...search } };
}

interface Harness {
  context: CollectorContext;
  logger: FakeLogger;
  http: StubHttp;
}

function harness(options: {
  routes: Routes;
  search?: Partial<Settings['search']>;
  limit?: number;
}): Harness {
  const logger = createFakeLogger();
  const http = createStubHttp(options.routes);
  return {
    logger,
    http,
    context: {
      settings: makeSettings(options.search),
      logger,
      http,
      browser: noBrowser,
      limit: options.limit ?? 50,
    },
  };
}

const WORKABLE_WIDGET = {
  name: 'Acme Inc',
  jobs: [
    {
      id: 991,
      shortcode: 'ABC123',
      title: 'Backend Engineer',
      city: 'Berlin',
      country: 'Germany',
      employment_type: 'Full-time',
      experience: 'Senior',
      telecommuting: true,
      application_url: 'https://apply.workable.com/acme/j/ABC123/',
      published_on: '2026-07-20',
      description: '<p>We build payment rails. Base salary $120k - $150k per year.</p>',
      requirements: '<p>5 years of TypeScript.</p>',
    },
    {
      shortcode: 'MKT9',
      title: 'Marketing Manager',
      city: 'Berlin',
      country: 'Germany',
      url: 'https://apply.workable.com/acme/j/MKT9/',
      published_on: '2026-07-21',
      description: '<p>Own the brand.</p>',
    },
  ],
};

describe('workableCollector', () => {
  it('normalizes a widget payload into NormalizedJob fields', async () => {
    const { context, http } = harness({
      routes: { 'widget/accounts/acme': WORKABLE_WIDGET },
      search: { boards: { workable: ['acme'] }, postedWithinDays: 3650 },
    });

    const jobs = await workableCollector.collect(context);

    expect(http.requests[0]).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/acme?details=true',
    );
    expect(jobs).toHaveLength(2);

    const [job] = jobs;
    expect(job).toBeDefined();
    expect(job?.source).toBe('workable');
    expect(job?.externalId).toBe('ABC123');
    expect(job?.title).toBe('Backend Engineer');
    expect(job?.company).toBe('Acme Inc');
    expect(job?.location).toBe('Berlin, Germany');
    expect(job?.remoteType).toBe('remote');
    expect(job?.employmentType).toBe('full_time');
    expect(job?.experienceLevel).toBe('senior');
    expect(job?.salaryMin).toBe(120000);
    expect(job?.salaryMax).toBe(150000);
    expect(job?.salaryCurrency).toBe('USD');
    expect(job?.salaryPeriod).toBe('year');
    expect(job?.applicationUrl).toBe('https://apply.workable.com/acme/j/ABC123/');
    expect(job?.postedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(job?.description).toContain('We build payment rails.');
    expect(job?.description).toContain('5 years of TypeScript.');
    expect(job?.descriptionHtml).toContain('<p>5 years of TypeScript.</p>');
  });

  it('falls back to the SPI board when the widget endpoint 404s', async () => {
    const { context, logger } = harness({
      routes: {
        'widget/accounts/acme': new HttpError('gone', 404, 'widget'),
        'acme.workable.com/spi/v3/jobs': {
          name: 'Acme Inc',
          results: [
            {
              shortcode: 'SPI1',
              title: 'Platform Engineer',
              city: 'Remote',
              url: 'https://acme.workable.com/j/SPI1',
              published_on: daysAgo(1),
            },
          ],
        },
      },
      search: { boards: { workable: ['acme'] } },
    });

    const jobs = await workableCollector.collect(context);

    expect(jobs.map((job) => job.externalId)).toEqual(['SPI1']);
    expect(logger.messages('warn')).toContain('workable widget endpoint missing, falling back to spi');
  });

  it('drops jobs that do not match the search filters', async () => {
    const { context } = harness({
      routes: { 'widget/accounts/acme': WORKABLE_WIDGET },
      search: {
        boards: { workable: ['acme'] },
        keywords: ['engineer'],
        excludedKeywords: ['brand'],
        postedWithinDays: 3650,
      },
    });

    const jobs = await workableCollector.collect(context);

    expect(jobs.map((job) => job.title)).toEqual(['Backend Engineer']);
  });

  it('excludes a job from an excluded company', async () => {
    const { context } = harness({
      routes: { 'widget/accounts/acme': WORKABLE_WIDGET },
      search: {
        boards: { workable: ['acme'] },
        excludedCompanies: ['acme inc'],
        postedWithinDays: 3650,
      },
    });

    expect(await workableCollector.collect(context)).toEqual([]);
  });

  it('respects context.limit', async () => {
    const { context } = harness({
      routes: { 'widget/accounts/acme': WORKABLE_WIDGET },
      search: { boards: { workable: ['acme'] }, postedWithinDays: 3650 },
      limit: 1,
    });

    expect(await workableCollector.collect(context)).toHaveLength(1);
  });

  it('keeps collecting the remaining boards when one board throws', async () => {
    const { context, logger } = harness({
      routes: {
        'widget/accounts/broken': new Error('connection reset'),
        'widget/accounts/acme': WORKABLE_WIDGET,
      },
      search: { boards: { workable: ['broken', 'acme'] }, postedWithinDays: 3650 },
    });

    const jobs = await workableCollector.collect(context);

    expect(jobs).toHaveLength(2);
    expect(logger.messages('error')).toContain('workable board failed');
    expect(logger.entries.find((entry) => entry.level === 'error')?.context).toMatchObject({
      board: 'broken',
      error: 'connection reset',
    });
  });

  it('returns nothing and warns when no boards are configured', async () => {
    const { context, logger, http } = harness({ routes: {} });

    expect(await workableCollector.collect(context)).toEqual([]);
    expect(http.requests).toEqual([]);
    expect(logger.messages('warn')).toContain('workable collector has no boards configured');
  });
});

const RECRUITEE_PAYLOAD = {
  offers: [
    {
      id: 4242,
      slug: 'senior-backend-engineer',
      title: 'Senior Backend Engineer',
      company_name: 'Acme BV',
      careers_apply_url: 'https://acme.recruitee.com/o/senior-backend-engineer/c/new',
      location: 'Amsterdam, Netherlands',
      employment_type_code: 'full_time',
      experience_code: 'senior_level',
      remote: true,
      published_at: '2026-07-18T09:00:00Z',
      description: '<p>Own our billing platform. €60000-€80000 per year.</p>',
      requirements: '<p>Strong TypeScript background.</p>',
    },
    {
      id: 4243,
      slug: 'office-manager',
      title: 'Office Manager',
      city: 'Amsterdam',
      country: 'Netherlands',
      published_at: '2026-07-19T09:00:00Z',
      description: '<p>Keep the office running.</p>',
    },
  ],
};

describe('recruiteeCollector', () => {
  it('normalizes an offers payload into NormalizedJob fields', async () => {
    const { context, http } = harness({
      routes: { 'acme.recruitee.com/api/offers/': RECRUITEE_PAYLOAD },
      search: { boards: { recruitee: ['acme'] }, postedWithinDays: 3650 },
    });

    const jobs = await recruiteeCollector.collect(context);

    expect(http.requests).toEqual(['https://acme.recruitee.com/api/offers/']);
    expect(jobs).toHaveLength(2);

    const [job] = jobs;
    expect(job?.source).toBe('recruitee');
    expect(job?.externalId).toBe('4242');
    expect(job?.title).toBe('Senior Backend Engineer');
    expect(job?.company).toBe('Acme BV');
    expect(job?.location).toBe('Amsterdam, Netherlands');
    expect(job?.remoteType).toBe('remote');
    expect(job?.employmentType).toBe('full_time');
    expect(job?.experienceLevel).toBe('senior');
    expect(job?.salaryMin).toBe(60000);
    expect(job?.salaryMax).toBe(80000);
    expect(job?.salaryCurrency).toBe('EUR');
    expect(job?.applicationUrl).toBe('https://acme.recruitee.com/o/senior-backend-engineer/c/new');
    expect(job?.postedAt).toBe('2026-07-18T09:00:00.000Z');
    expect(job?.description).toContain('Strong TypeScript background.');
  });

  it('builds the apply url from the slug and joins city and country', async () => {
    const { context } = harness({
      routes: { 'acme.recruitee.com/api/offers/': RECRUITEE_PAYLOAD },
      search: { boards: { recruitee: ['acme'] }, postedWithinDays: 3650 },
    });

    const jobs = await recruiteeCollector.collect(context);
    const fallback = jobs[1];

    expect(fallback?.applicationUrl).toBe('https://acme.recruitee.com/o/office-manager');
    expect(fallback?.location).toBe('Amsterdam, Netherlands');
    expect(fallback?.company).toBe('acme');
  });

  it('drops jobs that do not match the search filters', async () => {
    const { context } = harness({
      routes: { 'acme.recruitee.com/api/offers/': RECRUITEE_PAYLOAD },
      search: {
        boards: { recruitee: ['acme'] },
        keywords: ['engineer'],
        postedWithinDays: 3650,
      },
    });

    const jobs = await recruiteeCollector.collect(context);

    expect(jobs.map((job) => job.title)).toEqual(['Senior Backend Engineer']);
  });

  it('drops jobs posted outside the postedWithinDays window', async () => {
    const { context } = harness({
      routes: {
        'acme.recruitee.com/api/offers/': {
          offers: [
            {
              id: 1,
              slug: 'stale',
              title: 'Stale Engineer',
              published_at: daysAgo(90),
            },
            {
              id: 2,
              slug: 'fresh',
              title: 'Fresh Engineer',
              published_at: daysAgo(2),
            },
          ],
        },
      },
      search: { boards: { recruitee: ['acme'] }, postedWithinDays: 30 },
    });

    const jobs = await recruiteeCollector.collect(context);

    expect(jobs.map((job) => job.title)).toEqual(['Fresh Engineer']);
  });

  it('respects context.limit', async () => {
    const { context } = harness({
      routes: { 'acme.recruitee.com/api/offers/': RECRUITEE_PAYLOAD },
      search: { boards: { recruitee: ['acme'] }, postedWithinDays: 3650 },
      limit: 1,
    });

    expect(await recruiteeCollector.collect(context)).toHaveLength(1);
  });

  it('keeps collecting the remaining boards when one board throws', async () => {
    const { context, logger } = harness({
      routes: {
        'broken.recruitee.com': new Error('socket hang up'),
        'acme.recruitee.com': RECRUITEE_PAYLOAD,
      },
      search: { boards: { recruitee: ['broken', 'acme'] }, postedWithinDays: 3650 },
    });

    const jobs = await recruiteeCollector.collect(context);

    expect(jobs).toHaveLength(2);
    expect(logger.messages('error')).toContain('recruitee board failed');
  });

  it('returns nothing and warns when no boards are configured', async () => {
    const { context, logger, http } = harness({ routes: {} });

    expect(await recruiteeCollector.collect(context)).toEqual([]);
    expect(http.requests).toEqual([]);
    expect(logger.messages('warn')).toContain('recruitee collector has no boards configured');
  });
});

describe('linkedin session detection helpers', () => {
  it('flags the login and auth wall redirects as signed out', () => {
    expect(isSignedOutUrl('https://www.linkedin.com/login')).toBe(true);
    expect(isSignedOutUrl('https://www.linkedin.com/uas/login?session_redirect=%2Fjobs')).toBe(true);
    expect(isSignedOutUrl('https://www.linkedin.com/authwall?trk=bf')).toBe(true);
  });

  it('treats a normal jobs url as signed in', () => {
    expect(isSignedOutUrl('https://www.linkedin.com/jobs/')).toBe(false);
    expect(isSignedOutUrl('https://www.linkedin.com/jobs/view/123456/')).toBe(false);
    expect(isSignedOutUrl('')).toBe(false);
  });

  it('flags a checkpoint url as a challenge', () => {
    expect(isChallengePage('https://www.linkedin.com/checkpoint/challenge/', '')).toBe(true);
  });

  it('flags challenge wording in the body regardless of case', () => {
    expect(isChallengePage('https://www.linkedin.com/jobs/', 'We noticed unusual activity')).toBe(
      true,
    );
    expect(isChallengePage('https://www.linkedin.com/jobs/', 'Please Verify Your Identity')).toBe(
      true,
    );
    expect(isChallengePage('https://www.linkedin.com/jobs/', 'Security verification')).toBe(true);
  });

  it('does not flag an ordinary results page', () => {
    expect(isChallengePage('https://www.linkedin.com/jobs/search/?keywords=go', '120 results')).toBe(
      false,
    );
    expect(isChallengePage('', '')).toBe(false);
  });
});

describe('mode-aware session hints', () => {
  function withSession(attended: boolean, sessionStrategy: SessionStrategy = 'auto'): Settings {
    return {
      ...DEFAULT_SETTINGS,
      browser: { ...DEFAULT_SETTINGS.browser, attended, sessionStrategy },
    };
  }

  /** Every hint that has to name a repair, so a new one cannot skip the branch. */
  function everyHint(settings: Settings): string[] {
    return [
      linkedinSessionFixHint(settings),
      challengeFixHint(settings),
      searchChallengeFixHint(settings),
      noListingsFixHint(settings),
      indeedSessionFixHint(settings),
    ];
  }

  const attended = withSession(true);
  const headless = withSession(false);

  it('tells the attended user to sign in the window that is already open', () => {
    for (const hint of [
      linkedinSessionFixHint(attended),
      challengeFixHint(attended),
      indeedSessionFixHint(attended),
    ]) {
      expect(hint).toContain('press Sign in');
      expect(hint).toContain('a window is already open on this machine');
      // Pasting a cookie is exactly the advice attended mode exists to avoid.
      expect(hint).not.toContain('paste');
    }
    expect(linkedinSessionFixHint(attended)).toContain('Sign in for LinkedIn');
    expect(indeedSessionFixHint(attended)).toContain('Sign in for Indeed');
  });

  it('keeps the paste-a-session advice for headless runs', () => {
    for (const hint of [
      linkedinSessionFixHint(headless),
      challengeFixHint(headless),
      indeedSessionFixHint(headless),
    ]) {
      expect(hint).toContain('Browser Sessions');
      expect(hint).not.toContain('press Sign in');
    }
    expect(linkedinSessionFixHint(headless)).toContain('`li_at` cookie');
    expect(indeedSessionFixHint(headless)).toContain('paste a fresh Indeed session');
  });

  it('never gives the same instruction in both modes', () => {
    expect(linkedinSessionFixHint(attended)).not.toBe(linkedinSessionFixHint(headless));
    expect(challengeFixHint(attended)).not.toBe(challengeFixHint(headless));
    expect(indeedSessionFixHint(attended)).not.toBe(indeedSessionFixHint(headless));
  });

  it('advises the window for every hint under the attended strategy', () => {
    for (const hint of everyHint(withSession(false, 'attended'))) {
      expect(hint).toContain('press Sign in');
      expect(hint).not.toContain('paste');
    }
  });

  it('advises pasting for every hint under the stored strategy', () => {
    for (const hint of everyHint(withSession(true, 'stored'))) {
      expect(hint).toMatch(/paste|Browser Sessions/);
      expect(hint).not.toContain('press Sign in');
    }
  });

  /**
   * The whole point of the explicit setting: the visible window can be open for
   * debugging while a pasted cookie is still what the run replays, and advice
   * that reads the raw switch would send the user to sign in to a session no
   * collector is going to use.
   */
  it('honours stored pinned while attended mode is on', () => {
    const pinned = withSession(true, 'stored');

    expect(linkedinSessionFixHint(pinned)).toBe(linkedinSessionFixHint(headless));
    expect(challengeFixHint(pinned)).toBe(challengeFixHint(headless));
    expect(indeedSessionFixHint(pinned)).toBe(indeedSessionFixHint(headless));
    expect(linkedinSessionFixHint(pinned)).toContain('`li_at` cookie');
  });

  /** And the reverse: a headless host driving a signed-in shared profile. */
  it('honours attended pinned while the attended switch is off', () => {
    const pinned = withSession(false, 'attended');

    expect(linkedinSessionFixHint(pinned)).toBe(linkedinSessionFixHint(attended));
    expect(challengeFixHint(pinned)).toBe(challengeFixHint(attended));
    expect(indeedSessionFixHint(pinned)).toBe(indeedSessionFixHint(attended));
    expect(indeedSessionFixHint(pinned)).toContain('Sign in for Indeed');
  });

  it('follows the attended switch when the strategy is left on auto', () => {
    expect(linkedinSessionFixHint(withSession(true, 'auto'))).toBe(linkedinSessionFixHint(attended));
    expect(linkedinSessionFixHint(withSession(false, 'auto'))).toBe(
      linkedinSessionFixHint(headless),
    );
  });
});

const BLOCK_PAGE_TEXT = 'Request Blocked\nYou have been blocked.\nRay ID: 8f2c0a1b9d';
const RESULTS_PAGE_TEXT = 'Software Engineer jobs\n1 - 10 of 240 jobs';

/** Long enough that the collector treats it as a description and skips the detail hit. */
const LONG_SNIPPET = `<p>${'We build payment rails and the platform behind them. '.repeat(12)}</p>`;

const MOSAIC_CARD = {
  jobkey: 'abc123',
  title: 'Backend Engineer',
  company: 'Acme Inc',
  formattedLocation: 'Berlin',
  jobDescription: LONG_SNIPPET,
  pubDate: Date.now(),
};

interface IndeedPageStub {
  page: Page;
  navigations: string[];
}

/**
 * Playwright's `evaluate` runs its callback inside a real browser, so a stub
 * cannot execute it. Each extractor is instead recognised by a distinctive
 * token in its source and answered with canned data. That couples the stub to
 * the collector's selectors, which is the price of testing the block/rotate
 * decision without launching Chromium.
 */
function createIndeedPageStub(blockedOn: (visit: number) => boolean): IndeedPageStub {
  const navigations: string[] = [];
  let blocked = false;

  const page = {
    async goto(url: string): Promise<null> {
      navigations.push(url);
      blocked = blockedOn(navigations.length);
      return null;
    },
    url(): string {
      return navigations[navigations.length - 1] ?? 'about:blank';
    },
    async waitForSelector(): Promise<null> {
      return null;
    },
    async evaluate(fn: unknown): Promise<unknown> {
      const source = String(fn);
      if (source.includes('innerText')) return blocked ? BLOCK_PAGE_TEXT : RESULTS_PAGE_TEXT;
      if (source.includes('mosaic-provider-jobcards')) return blocked ? [] : [MOSAIC_CARD];
      if (source.includes('job_seen_beacon')) return [];
      if (source.includes('jobDescriptionText')) return null;
      throw new Error(`unexpected page.evaluate in the indeed stub: ${source.slice(0, 80)}`);
    },
    async close(): Promise<void> {},
  };

  return { page: page as unknown as Page, navigations };
}

describe('indeed collector exit-location rotation', () => {
  /**
   * Two blocks in one run. The first is allowed to rotate and retry; the second
   * must not, or a refusing site gets hammered from every exit the user owns.
   */
  it('rotates the exit at most once per run', async () => {
    vi.useFakeTimers();
    try {
      // gotoTolerantOfChallenge retries once on its own, so the first block
      // costs two navigations; the third is the post-rotation retry that works.
      const { page, navigations } = createIndeedPageStub((visit) => visit !== 3);
      const logger = createFakeLogger();
      const onBlocked = vi.fn(async () => true);

      const context: CollectorContext = {
        settings: makeSettings({ postedWithinDays: 3650 }),
        logger,
        http: createStubHttp({}),
        browser: {
          newPage: async (): Promise<Page> => page,
          saveStorageState: async (): Promise<string | null> => null,
        } as unknown as BrowserManager,
        keywords: ['backend engineer'],
        limit: 50,
        onBlocked,
      };

      const pending = indeedCollector.collect(context);
      // The collector backs off 20s between challenge attempts; drain those
      // timers instead of spending the wall clock on them.
      for (let round = 0; round < 12; round += 1) {
        await vi.advanceTimersByTimeAsync(30000);
      }
      const jobs = await pending;

      expect(onBlocked).toHaveBeenCalledTimes(1);
      expect(onBlocked.mock.calls[0]?.[0]).toContain('indeed');
      // The retry after the successful rotation is what produced this job.
      expect(jobs.map((job) => job.externalId)).toEqual(['abc123']);
      // Two attempts, one rotated retry, then two attempts on the next page.
      expect(navigations).toHaveLength(5);
      expect(logger.messages('info')).toContain(
        'indeed exit location rotated after a block; retrying this search page once',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry when the exit location did not actually move', async () => {
    vi.useFakeTimers();
    try {
      const { page, navigations } = createIndeedPageStub(() => true);
      const logger = createFakeLogger();
      const onBlocked = vi.fn(async () => false);

      const context: CollectorContext = {
        settings: makeSettings({ postedWithinDays: 3650 }),
        logger,
        http: createStubHttp({}),
        browser: {
          newPage: async (): Promise<Page> => page,
          saveStorageState: async (): Promise<string | null> => null,
        } as unknown as BrowserManager,
        keywords: ['backend engineer'],
        limit: 50,
        onBlocked,
      };

      const pending = indeedCollector.collect(context);
      for (let round = 0; round < 12; round += 1) {
        await vi.advanceTimersByTimeAsync(30000);
      }
      const jobs = await pending;

      expect(onBlocked).toHaveBeenCalledTimes(1);
      expect(jobs).toEqual([]);
      // Only the original two attempts: a rotation that did not move is not a
      // reason to ask the same server again.
      expect(navigations).toHaveLength(2);
      expect(logger.messages('warn')).toContain(
        'indeed is blocking this run and the exit location did not move; not retrying',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls onBlocked when nothing blocks the run', async () => {
    vi.useFakeTimers();
    try {
      const { page } = createIndeedPageStub(() => false);
      const logger = createFakeLogger();
      const onBlocked = vi.fn(async () => true);

      const context: CollectorContext = {
        settings: makeSettings({ postedWithinDays: 3650 }),
        logger,
        http: createStubHttp({}),
        browser: {
          newPage: async (): Promise<Page> => page,
          saveStorageState: async (): Promise<string | null> => null,
        } as unknown as BrowserManager,
        keywords: ['backend engineer'],
        limit: 1,
        onBlocked,
      };

      const pending = indeedCollector.collect(context);
      for (let round = 0; round < 12; round += 1) {
        await vi.advanceTimersByTimeAsync(30000);
      }
      const jobs = await pending;

      expect(onBlocked).not.toHaveBeenCalled();
      expect(jobs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collector definition contract', () => {
  const collectors: CollectorDefinition[] = [
    workableCollector,
    recruiteeCollector,
    linkedinCollector,
    greenhouseCollector,
    leverCollector,
    ashbyCollector,
    smartRecruitersCollector,
    workdayCollector,
  ];

  it.each<[string, CollectorDefinition]>([
    ['workable', workableCollector],
    ['recruitee', recruiteeCollector],
    ['linkedin', linkedinCollector],
  ])('%s satisfies the CollectorDefinition contract', (id, collector) => {
    expect(collector.id).toBe(id);
    expect(collector.source).toBe(id);
    expect(collector.name.length).toBeGreaterThan(0);
    expect(collector.description.length).toBeGreaterThan(0);
    expect(typeof collector.requiresAuth).toBe('boolean');
    expect(typeof collector.requiresBoards).toBe('boolean');
    expect(typeof collector.collect).toBe('function');
  });

  it('declares board-backed collectors as board-requiring and unauthenticated', () => {
    for (const collector of [workableCollector, recruiteeCollector]) {
      expect(collector.requiresBoards).toBe(true);
      expect(collector.requiresAuth).toBe(false);
      expect(collector.builtIn).toBe(true);
    }
    expect(linkedinCollector.requiresAuth).toBe(true);
    expect(linkedinCollector.requiresBoards).toBe(false);
  });

  it('keeps every collector id unique', () => {
    const ids = collectors.map((collector) => collector.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
