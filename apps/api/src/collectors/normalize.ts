import type { EmploymentType, ExperienceLevel, RemoteType, Settings } from '@deedy/shared';

export interface SearchFilters {
  keywords: string[];
  excludedKeywords: string[];
  locations: string[];
  excludedCompanies: string[];
  postedWithinDays: number;
  /**
   * Whether `matchesSearchFilters` applies the keyword test at all. Collectors
   * that queried the platform by term already have relevance-ranked results, so
   * re-testing locally would discard legitimate adjacent matches.
   *
   * Optional, and absent means "apply it": a filter object built by hand must
   * keep filtering, or omitting the flag would silently disable the keyword
   * test rather than fail loudly.
   */
  matchKeywords?: boolean;
}

/**
 * Pulls the subset of settings that every collector filters on. `keywords` is
 * the caller-resolved term list (from the keyword table) and is authoritative
 * whenever it is supplied — including when it is empty, which legitimately
 * means "the user disabled every term". Only an *omitted* argument falls back
 * to settings.search.keywords, which keeps hand-built callers working without
 * letting a resolved-but-empty list silently widen to the settings seed list.
 */
export function searchFilters(
  settings: Settings,
  keywords?: string[],
  options: { matchKeywords?: boolean } = {},
): SearchFilters {
  return {
    keywords: keywords ?? settings.search.keywords,
    excludedKeywords: settings.search.excludedKeywords,
    locations: settings.search.locations,
    excludedCompanies: settings.search.excludedCompanies,
    postedWithinDays: settings.search.postedWithinDays,
    matchKeywords: options.matchKeywords ?? true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the posting matches at least one search term. Collectors that
 * already searched a platform for a term should NOT re-apply this — the
 * platform's own relevance ranking legitimately returns adjacent matches
 * that a substring test would throw away.
 */
export function matchesAnyKeyword(haystack: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const text = haystack.toLowerCase();
  return keywords.some((keyword) => {
    const term = keyword.trim().toLowerCase();
    if (term === '') return false;
    // Multi-word terms are phrases: a plain substring test keeps them tolerant of
    // surrounding punctuation, while single words must not match inside a longer
    // word ("react" should not hit "reactive").
    if (/\s/.test(term)) return text.includes(term);
    // Boundaries only guard the ends that are themselves word characters.
    // ".net" starts with punctuation, so a leading boundary would reject
    // "ASP.NET Core Developer" — the form most real postings use — because the
    // "." sits right after "p". Likewise "c++" ends in punctuation, so only its
    // leading boundary is meaningful.
    const lead = /[\p{L}\p{N}]/u.test(term[0] ?? '') ? '(?<![\\p{L}\\p{N}])' : '';
    const tail = /[\p{L}\p{N}]/u.test(term[term.length - 1] ?? '') ? '(?![\\p{L}\\p{N}])' : '';
    return new RegExp(`${lead}${escapeRegExp(term)}${tail}`, 'u').test(text);
  });
}

/** Decodes the HTML entities providers commonly double-encode in descriptions. */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const REMOTE_PATTERNS: [RegExp, RemoteType][] = [
  [/\b(fully[- ]?remote|100% remote|remote[- ]?first|work from home|wfh)\b/i, 'remote'],
  [/\bhybrid\b/i, 'hybrid'],
  [/\b(on[- ]?site|onsite|in[- ]?office|in[- ]?person)\b/i, 'onsite'],
  [/\bremote\b/i, 'remote'],
];

export function detectRemoteType(...texts: (string | null | undefined)[]): RemoteType {
  const haystack = texts.filter(Boolean).join(' \n ');
  for (const [pattern, type] of REMOTE_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return 'unknown';
}

const EMPLOYMENT_PATTERNS: [RegExp, EmploymentType][] = [
  [/\b(full[- ]?time|permanent|fte)\b/i, 'full_time'],
  [/\b(part[- ]?time)\b/i, 'part_time'],
  [/\b(contract|contractor|freelance|b2b)\b/i, 'contract'],
  [/\b(intern|internship|co[- ]?op)\b/i, 'internship'],
  [/\b(temporary|temp|seasonal)\b/i, 'temporary'],
];

export function detectEmploymentType(...texts: (string | null | undefined)[]): EmploymentType {
  const haystack = texts.filter(Boolean).join(' \n ');
  for (const [pattern, type] of EMPLOYMENT_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return 'unknown';
}

const EXPERIENCE_PATTERNS: [RegExp, ExperienceLevel][] = [
  [/\b(intern|internship)\b/i, 'intern'],
  [/\b(chief|cto|ceo|vp of|vice president|head of)\b/i, 'executive'],
  [/\b(principal|distinguished|fellow)\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(senior|sr\.?|lead)\b/i, 'senior'],
  [/\b(junior|jr\.?|entry[- ]?level|graduate|new grad|associate)\b/i, 'entry'],
  [/\b(mid[- ]?level|intermediate)\b/i, 'mid'],
];

export function detectExperienceLevel(...texts: (string | null | undefined)[]): ExperienceLevel {
  const haystack = texts.filter(Boolean).join(' \n ');
  for (const [pattern, level] of EXPERIENCE_PATTERNS) {
    if (pattern.test(haystack)) return level;
  }
  return 'unknown';
}

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '₹': 'INR',
  '¥': 'JPY',
};

/**
 * Best-effort salary parse from free text. The LLM `salary_extraction` task is
 * the fallback for anything this misses; this exists so obvious ranges do not
 * need an inference call.
 */
export function parseSalary(text: string | null | undefined): ParsedSalary {
  const empty: ParsedSalary = { min: null, max: null, currency: null, period: null };
  if (!text) return empty;

  const rangeMatch =
    /([$£€₹¥]|USD|EUR|GBP|INR|CAD|AUD)?\s?([\d][\d,.]*)\s?(k)?\s*(?:-|–|—|to)\s*([$£€₹¥]|USD|EUR|GBP|INR|CAD|AUD)?\s?([\d][\d,.]*)\s?(k)?/i.exec(
      text,
    );
  if (!rangeMatch) return empty;

  const symbol = rangeMatch[1] ?? rangeMatch[4] ?? null;
  const currency = symbol
    ? (CURRENCY_SYMBOLS[symbol] ?? symbol.toUpperCase())
    : null;

  const toNumber = (raw: string | undefined, hasK: boolean): number | null => {
    if (!raw) return null;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    return hasK ? value * 1000 : value;
  };

  const min = toNumber(rangeMatch[2], Boolean(rangeMatch[3]));
  const max = toNumber(rangeMatch[5], Boolean(rangeMatch[6]));
  if (min === null || max === null || max < min) return empty;

  let period = 'year';
  if (/\b(per hour|hourly|\/hr|\/hour|an hour)\b/i.test(text)) period = 'hour';
  else if (/\b(per month|monthly|\/mo|\/month)\b/i.test(text)) period = 'month';
  else if (/\b(per day|daily|\/day)\b/i.test(text)) period = 'day';
  else if (max < 500) period = 'hour';

  return { min, max, currency, period };
}

/** Normalizes provider date formats to an ISO string. */
export function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Applies the user's search filters to a candidate posting. */
export function matchesSearchFilters(
  job: { title: string; location?: string | null; description?: string | null; postedAt?: string | null; company: string },
  filters: SearchFilters,
): boolean {
  const haystack = `${job.title} ${job.location ?? ''} ${job.description ?? ''}`.toLowerCase();

  // Exclusions get the same boundary treatment as inclusions: a plain substring
  // test made "go" drop every posting mentioning "algorithm", and "c" drop
  // everything. `matchesAnyKeyword` answers true for an empty list, so the
  // length check keeps "no exclusions" from excluding everything.
  if (
    filters.excludedKeywords.length > 0 &&
    matchesAnyKeyword(haystack, filters.excludedKeywords)
  ) {
    return false;
  }
  if (
    filters.excludedCompanies.some(
      (company) => job.company.toLowerCase() === company.toLowerCase(),
    )
  ) {
    return false;
  }
  if (filters.matchKeywords !== false && !matchesAnyKeyword(haystack, filters.keywords)) {
    return false;
  }
  if (filters.locations.length > 0) {
    const location = (job.location ?? '').toLowerCase();
    const anywhere = filters.locations.some((loc) => {
      const needle = loc.toLowerCase();
      return needle === 'remote' ? haystack.includes('remote') : location.includes(needle);
    });
    if (!anywhere) return false;
  }
  if (job.postedAt) {
    const posted = new Date(job.postedAt).getTime();
    const cutoff = Date.now() - filters.postedWithinDays * 86400000;
    if (Number.isFinite(posted) && posted < cutoff) return false;
  }
  return true;
}
