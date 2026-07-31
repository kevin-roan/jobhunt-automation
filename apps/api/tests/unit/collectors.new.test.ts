import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@deedy/shared';

import { ashbyCollector } from '../../src/collectors/ashby.collector.js';
import { greenhouseCollector } from '../../src/collectors/greenhouse.collector.js';
import { leverCollector } from '../../src/collectors/lever.collector.js';
import {
  isChallengePage,
  isSignedOutUrl,
  linkedinCollector,
} from '../../src/collectors/linkedin.collector.js';
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
