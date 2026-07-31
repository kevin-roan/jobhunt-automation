import { describe, expect, it } from 'vitest';

import {
  decodeHtmlEntities,
  detectEmploymentType,
  detectExperienceLevel,
  detectRemoteType,
  matchesSearchFilters,
  parseSalary,
  toIsoDate,
  type SearchFilters,
} from '../../src/collectors/normalize.js';
import { parseWorkdayBoard } from '../../src/collectors/workday.collector.js';

const DAY_MS = 86400000;

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return {
    keywords: [],
    excludedKeywords: [],
    locations: [],
    excludedCompanies: [],
    postedWithinDays: 30,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('detectRemoteType', () => {
  it('prefers explicit fully-remote phrasing', () => {
    expect(detectRemoteType('100% remote role')).toBe('remote');
    expect(detectRemoteType('Work from home')).toBe('remote');
    expect(detectRemoteType(null, 'Remote-first company')).toBe('remote');
  });

  it('detects hybrid before a bare remote mention', () => {
    expect(detectRemoteType('Hybrid, remote 2 days a week')).toBe('hybrid');
  });

  it('detects onsite variants', () => {
    expect(detectRemoteType('On-site in New York')).toBe('onsite');
    expect(detectRemoteType('In-person collaboration required')).toBe('onsite');
  });

  it('falls back to a bare remote mention', () => {
    expect(detectRemoteType('Engineer', 'Remote (US)')).toBe('remote');
  });

  it('returns unknown when nothing matches or all inputs are empty', () => {
    expect(detectRemoteType('Software Engineer', 'Berlin')).toBe('unknown');
    expect(detectRemoteType(null, undefined)).toBe('unknown');
  });
});

describe('detectEmploymentType', () => {
  it('classifies each supported employment type', () => {
    expect(detectEmploymentType('Full-time Engineer')).toBe('full_time');
    expect(detectEmploymentType('Part time barista')).toBe('part_time');
    expect(detectEmploymentType('Contractor, 6 months')).toBe('contract');
    expect(detectEmploymentType('Summer Internship')).toBe('internship');
    expect(detectEmploymentType('Seasonal warehouse role')).toBe('temporary');
  });

  it('joins multiple text fragments before matching', () => {
    expect(detectEmploymentType('Engineer', null, 'This is a permanent position')).toBe('full_time');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectEmploymentType('Software Engineer')).toBe('unknown');
  });
});

describe('detectExperienceLevel', () => {
  it('classifies levels in priority order', () => {
    expect(detectExperienceLevel('Software Engineering Intern')).toBe('intern');
    expect(detectExperienceLevel('Head of Platform')).toBe('executive');
    expect(detectExperienceLevel('Distinguished Engineer')).toBe('principal');
    expect(detectExperienceLevel('Staff Engineer')).toBe('staff');
    expect(detectExperienceLevel('Senior Backend Engineer')).toBe('senior');
    expect(detectExperienceLevel('New Grad Engineer')).toBe('entry');
    expect(detectExperienceLevel('Mid-level Engineer')).toBe('mid');
  });

  it('prefers the executive match over a senior match in the same text', () => {
    expect(detectExperienceLevel('VP of Engineering, senior leadership role')).toBe('executive');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectExperienceLevel('Software Engineer', null)).toBe('unknown');
  });
});

describe('parseSalary', () => {
  it('expands the k suffix and resolves the currency symbol', () => {
    expect(parseSalary('$120k - $150k per year')).toEqual({
      min: 120000,
      max: 150000,
      currency: 'USD',
      period: 'year',
    });
  });

  it('handles comma-formatted ranges written with "to"', () => {
    expect(parseSalary('£40,000 to £55,000 depending on experience')).toEqual({
      min: 40000,
      max: 55000,
      currency: 'GBP',
      period: 'year',
    });
  });

  it('maps other currency symbols and ISO codes', () => {
    expect(parseSalary('€60000-€80000').currency).toBe('EUR');
    expect(parseSalary('₹1200000 - 1800000').currency).toBe('INR');
    expect(parseSalary('CAD 90,000 - 110,000').currency).toBe('CAD');
  });

  it('reads the currency from the second half when the first is bare', () => {
    expect(parseSalary('90,000 - USD 120,000').currency).toBe('USD');
  });

  it('detects an explicit hourly period', () => {
    expect(parseSalary('$25 - $40 per hour')).toEqual({
      min: 25,
      max: 40,
      currency: 'USD',
      period: 'hour',
    });
    expect(parseSalary('$30 – $45 /hr').period).toBe('hour');
  });

  it('detects monthly and daily periods', () => {
    expect(parseSalary('$5,000 - $7,000 per month').period).toBe('month');
    expect(parseSalary('$400 - $600 per day').period).toBe('day');
  });

  it('infers hourly for small unqualified ranges', () => {
    expect(parseSalary('20 - 35')).toEqual({
      min: 20,
      max: 35,
      currency: null,
      period: 'hour',
    });
  });

  it('returns an empty result when there is no range', () => {
    const empty = { min: null, max: null, currency: null, period: null };
    expect(parseSalary('Competitive salary and equity')).toEqual(empty);
    expect(parseSalary(null)).toEqual(empty);
    expect(parseSalary(undefined)).toEqual(empty);
    expect(parseSalary('')).toEqual(empty);
  });

  it('rejects a reversed range rather than guessing', () => {
    expect(parseSalary('$150,000 - $120,000')).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
    });
  });
});

describe('toIsoDate', () => {
  it('normalizes date strings', () => {
    expect(toIsoDate('2026-07-01')).toBe('2026-07-01T00:00:00.000Z');
    expect(toIsoDate('2026-07-01T12:30:00.000Z')).toBe('2026-07-01T12:30:00.000Z');
  });

  it('accepts epoch milliseconds', () => {
    expect(toIsoDate(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIsoDate(1751328000000)).toBe(new Date(1751328000000).toISOString());
  });

  it('returns null for empty or unparseable values', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('posted recently')).toBeNull();
    expect(toIsoDate(Number.NaN)).toBeNull();
  });
});

describe('matchesSearchFilters', () => {
  const baseJob = {
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Berlin, Germany',
    description: 'Build distributed systems with TypeScript.',
    postedAt: daysAgo(2),
  };

  it('keeps a job whose text contains one of the keywords', () => {
    expect(matchesSearchFilters(baseJob, filters({ keywords: ['backend', 'ml'] }))).toBe(true);
  });

  it('matches keywords found only in the description', () => {
    expect(matchesSearchFilters(baseJob, filters({ keywords: ['typescript'] }))).toBe(true);
  });

  it('drops a job when no keyword matches', () => {
    expect(matchesSearchFilters(baseJob, filters({ keywords: ['rust', 'solidity'] }))).toBe(false);
  });

  it('drops a job containing an excluded keyword', () => {
    const job = { ...baseJob, description: 'Requires an active security clearance.' };
    expect(matchesSearchFilters(job, filters({ excludedKeywords: ['clearance'] }))).toBe(false);
  });

  it('drops a job from an excluded company regardless of case', () => {
    expect(matchesSearchFilters(baseJob, filters({ excludedCompanies: ['acme'] }))).toBe(false);
    expect(matchesSearchFilters(baseJob, filters({ excludedCompanies: ['Globex'] }))).toBe(true);
  });

  it('matches locations as a substring of the job location', () => {
    expect(matchesSearchFilters(baseJob, filters({ locations: ['berlin'] }))).toBe(true);
    expect(matchesSearchFilters(baseJob, filters({ locations: ['Lisbon'] }))).toBe(false);
  });

  it('treats "remote" as a pseudo-location matched anywhere in the text', () => {
    const remoteJob = { ...baseJob, location: 'Anywhere', description: 'Fully remote team.' };
    expect(matchesSearchFilters(remoteJob, filters({ locations: ['Remote'] }))).toBe(true);
    expect(matchesSearchFilters(baseJob, filters({ locations: ['Remote'] }))).toBe(false);
  });

  it('applies the postedWithinDays cutoff', () => {
    expect(
      matchesSearchFilters({ ...baseJob, postedAt: daysAgo(5) }, filters({ postedWithinDays: 30 })),
    ).toBe(true);
    expect(
      matchesSearchFilters({ ...baseJob, postedAt: daysAgo(40) }, filters({ postedWithinDays: 30 })),
    ).toBe(false);
  });

  it('keeps jobs with a missing or unparseable posted date', () => {
    expect(matchesSearchFilters({ ...baseJob, postedAt: null }, filters())).toBe(true);
    expect(matchesSearchFilters({ ...baseJob, postedAt: 'unknown' }, filters())).toBe(true);
  });

  it('tolerates missing optional fields', () => {
    expect(
      matchesSearchFilters({ title: 'Backend Engineer', company: 'Acme' }, filters({ keywords: ['backend'] })),
    ).toBe(true);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the common entity set', () => {
    expect(decodeHtmlEntities('&lt;p&gt;Tom&#39;s &quot;job&quot; &amp; more&nbsp;here&lt;/p&gt;')).toBe(
      '<p>Tom\'s "job" & more here</p>',
    );
  });

  it('decodes both apostrophe spellings', () => {
    expect(decodeHtmlEntities('it&#039;s &apos;fine&apos;')).toBe("it's 'fine'");
  });

  it('unwraps one layer of double encoding by decoding &amp; last', () => {
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
    expect(decodeHtmlEntities('')).toBe('');
  });
});

describe('parseWorkdayBoard', () => {
  it('parses a full locale-prefixed careers URL', () => {
    expect(parseWorkdayBoard('https://acme.wd1.myworkdayjobs.com/en-US/External')).toEqual({
      host: 'acme.wd1.myworkdayjobs.com',
      tenant: 'acme',
      site: 'External',
      companyName: 'acme',
    });
  });

  it('parses a URL without a locale segment', () => {
    expect(parseWorkdayBoard('https://globex.wd5.myworkdayjobs.com/Careers')).toEqual({
      host: 'globex.wd5.myworkdayjobs.com',
      tenant: 'globex',
      site: 'Careers',
      companyName: 'globex',
    });
  });

  it('assumes https when the scheme is omitted and ignores trailing slashes', () => {
    expect(parseWorkdayBoard('  acme.wd1.myworkdayjobs.com/en-US/External/  ')).toEqual({
      host: 'acme.wd1.myworkdayjobs.com',
      tenant: 'acme',
      site: 'External',
      companyName: 'acme',
    });
  });

  it('parses the compact pipe form and trims each part', () => {
    expect(parseWorkdayBoard(' acme.wd1.myworkdayjobs.com | acme | External ')).toEqual({
      host: 'acme.wd1.myworkdayjobs.com',
      tenant: 'acme',
      site: 'External',
      companyName: 'acme',
    });
  });

  it('rejects an incomplete pipe form', () => {
    expect(parseWorkdayBoard('acme.wd1.myworkdayjobs.com|acme')).toBeNull();
    expect(parseWorkdayBoard('|acme|External')).toBeNull();
    expect(parseWorkdayBoard('acme.wd1.myworkdayjobs.com||External')).toBeNull();
  });

  it('rejects empty, path-less, and malformed entries', () => {
    expect(parseWorkdayBoard('')).toBeNull();
    expect(parseWorkdayBoard('   ')).toBeNull();
    expect(parseWorkdayBoard('https://acme.wd1.myworkdayjobs.com')).toBeNull();
    expect(parseWorkdayBoard('http://')).toBeNull();
  });
});
