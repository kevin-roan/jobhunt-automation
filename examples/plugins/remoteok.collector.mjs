/**
 * RemoteOK collector plugin.
 *
 * Plain ESM: the registry imports this file directly with `await import()`, so
 * there is no build step and no way to import the app's TypeScript helpers.
 * Everything it needs (filtering, salary handling, HTML stripping) is
 * reimplemented here in a few small local functions. Copy this file, rename the
 * id/source, and swap `fetchPostings` to target another public JSON feed.
 *
 * @typedef {object} Logger
 * @property {(message: string, context?: Record<string, unknown>) => void} trace
 * @property {(message: string, context?: Record<string, unknown>) => void} debug
 * @property {(message: string, context?: Record<string, unknown>) => void} info
 * @property {(message: string, context?: Record<string, unknown>) => void} warn
 * @property {(message: string, context?: Record<string, unknown>) => void} error
 *
 * @typedef {object} HttpClient
 * @property {(url: string, init?: RequestInit) => Promise<unknown>} getJson
 * @property {(url: string, init?: RequestInit) => Promise<string>} getText
 *
 * @typedef {object} SearchSettings
 * @property {string[]} keywords
 * @property {string[]} excludedKeywords
 * @property {string[]} locations
 * @property {string[]} excludedCompanies
 * @property {number} postedWithinDays
 *
 * @typedef {object} CollectorContext
 * @property {{ search: SearchSettings }} settings
 * @property {Logger} logger
 * @property {HttpClient} http
 * @property {number} limit Hard cap on jobs to return in this run.
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} NormalizedJob
 * @property {string} source
 * @property {string | null} externalId
 * @property {string} title
 * @property {string} company
 * @property {string | null} location
 * @property {string} remoteType
 * @property {string} employmentType
 * @property {string} experienceLevel
 * @property {number | null} salaryMin
 * @property {number | null} salaryMax
 * @property {string | null} salaryCurrency
 * @property {string | null} salaryPeriod
 * @property {string | null} description
 * @property {string | null} descriptionHtml
 * @property {string} applicationUrl
 * @property {string | null} postedAt
 * @property {unknown} raw
 *
 * @typedef {object} RemoteOkPosting
 * @property {string | number} [id]
 * @property {string} [slug]
 * @property {string} [company]
 * @property {string} [position]
 * @property {string} [description]
 * @property {string} [location]
 * @property {string} [date]
 * @property {number} [epoch]
 * @property {string} [url]
 * @property {string} [apply_url]
 * @property {string[]} [tags]
 * @property {number} [salary_min]
 * @property {number} [salary_max]
 * @property {string} [legal] Present only on the first feed element.
 */

const FEED_URL = 'https://remoteok.com/api';
const SOURCE = 'remoteok';

/** RemoteOK pays in USD and quotes annualized ranges on every posting. */
const SALARY_CURRENCY = 'USD';
const SALARY_PERIOD = 'year';

const EMPLOYMENT_PATTERNS = [
  [/\b(full[- ]?time|permanent|fte)\b/i, 'full_time'],
  [/\b(part[- ]?time)\b/i, 'part_time'],
  [/\b(contract|contractor|freelance|b2b)\b/i, 'contract'],
  [/\b(intern|internship|co[- ]?op)\b/i, 'internship'],
  [/\b(temporary|temp|seasonal)\b/i, 'temporary'],
];

const EXPERIENCE_PATTERNS = [
  [/\b(intern|internship)\b/i, 'intern'],
  [/\b(chief|cto|ceo|vp of|vice president|head of)\b/i, 'executive'],
  [/\b(principal|distinguished|fellow)\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(senior|sr\.?|lead)\b/i, 'senior'],
  [/\b(junior|jr\.?|entry[- ]?level|graduate|new grad|associate)\b/i, 'entry'],
  [/\b(mid[- ]?level|intermediate)\b/i, 'mid'],
];

/**
 * @param {readonly [RegExp, string][]} patterns
 * @param {(string | null | undefined)[]} texts
 * @param {string} fallback
 * @returns {string}
 */
function detect(patterns, texts, fallback) {
  const haystack = texts.filter(Boolean).join(' \n ');
  for (const [pattern, value] of patterns) {
    if (pattern.test(haystack)) return value;
  }
  return fallback;
}

/**
 * Mirrors the app's `stripHtml`: block tags become newlines so the LLM sees
 * paragraph structure instead of one run-on line.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string | number | null | undefined} value
 * @returns {string | null}
 */
function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toPositiveNumber(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Applies the user's search settings. Deliberately duplicated from the app's
 * `matchesSearchFilters` because plugins cannot import compiled internals.
 *
 * @param {{ title: string, company: string, location: string | null, description: string | null, postedAt: string | null, tags: string[] }} job
 * @param {SearchSettings} search
 * @returns {boolean}
 */
function matchesFilters(job, search) {
  const haystack = [job.title, job.location ?? '', job.description ?? '', job.tags.join(' ')]
    .join(' ')
    .toLowerCase();

  const excludedKeywords = search.excludedKeywords ?? [];
  if (excludedKeywords.some((word) => haystack.includes(word.toLowerCase()))) return false;

  const excludedCompanies = search.excludedCompanies ?? [];
  const company = job.company.toLowerCase();
  if (excludedCompanies.some((name) => company === name.trim().toLowerCase())) return false;

  const keywords = search.keywords ?? [];
  if (keywords.length > 0 && !keywords.some((word) => haystack.includes(word.toLowerCase()))) {
    return false;
  }

  const postedWithinDays = search.postedWithinDays;
  if (job.postedAt && typeof postedWithinDays === 'number' && postedWithinDays > 0) {
    const posted = new Date(job.postedAt).getTime();
    const cutoff = Date.now() - postedWithinDays * 86400000;
    if (Number.isFinite(posted) && posted < cutoff) return false;
  }

  return true;
}

/**
 * The first element of the RemoteOK feed is a legal notice, not a posting.
 *
 * @param {unknown} payload
 * @returns {RemoteOkPosting[]}
 */
function toPostings(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (/** @type {RemoteOkPosting} */ (entry).legal) !== 'string' &&
      typeof (/** @type {RemoteOkPosting} */ (entry).position) === 'string',
  );
}

/**
 * @param {RemoteOkPosting} posting
 * @param {SearchSettings} search
 * @returns {NormalizedJob | null}
 */
function normalize(posting, search) {
  const title = (posting.position ?? '').trim();
  const company = (posting.company ?? '').trim();
  const applicationUrl = posting.apply_url ?? posting.url ?? null;
  if (!title || !company || !applicationUrl) return null;

  const descriptionHtml = posting.description ? posting.description : null;
  const description = descriptionHtml ? stripHtml(descriptionHtml) : null;
  const location = posting.location ? posting.location.trim() || null : null;
  const postedAt = toIsoDate(posting.date ?? (posting.epoch ? posting.epoch * 1000 : null));
  const tags = Array.isArray(posting.tags) ? posting.tags.filter((tag) => typeof tag === 'string') : [];

  if (!matchesFilters({ title, company, location, description, postedAt, tags }, search)) {
    return null;
  }

  const salaryMin = toPositiveNumber(posting.salary_min);
  const salaryMax = toPositiveNumber(posting.salary_max);
  const hasSalary = salaryMin !== null && salaryMax !== null && salaryMax >= salaryMin;
  const tagText = tags.join(' ');

  return {
    source: SOURCE,
    externalId: posting.id !== undefined && posting.id !== null ? String(posting.id) : (posting.slug ?? null),
    title,
    company,
    location,
    // Every listing on RemoteOK is remote by definition; the location field is
    // a timezone or residency restriction, not an office.
    remoteType: 'remote',
    employmentType: detect(EMPLOYMENT_PATTERNS, [title, tagText, description], 'full_time'),
    experienceLevel: detect(EXPERIENCE_PATTERNS, [title, tagText, description], 'unknown'),
    salaryMin: hasSalary ? salaryMin : null,
    salaryMax: hasSalary ? salaryMax : null,
    salaryCurrency: hasSalary ? SALARY_CURRENCY : null,
    salaryPeriod: hasSalary ? SALARY_PERIOD : null,
    description,
    descriptionHtml,
    applicationUrl,
    postedAt,
    raw: posting,
  };
}

/** @type {{ id: string, name: string, source: string, description: string, requiresAuth: boolean, requiresBoards: boolean, collect: (context: CollectorContext) => Promise<NormalizedJob[]> }} */
const remoteOkCollector = {
  id: 'remoteok',
  name: 'RemoteOK',
  source: SOURCE,
  description:
    'Example plugin. Reads the public RemoteOK JSON feed (remoteok.com/api) - no credentials and no board slugs required.',
  requiresAuth: false,
  requiresBoards: false,

  /**
   * @param {CollectorContext} context
   * @returns {Promise<NormalizedJob[]>}
   */
  async collect(context) {
    const search = context.settings.search;
    /** @type {NormalizedJob[]} */
    const results = [];

    let payload;
    try {
      payload = await context.http.getJson(FEED_URL);
    } catch (error) {
      context.logger.error('remoteok feed request failed', {
        url: FEED_URL,
        error: error instanceof Error ? error.message : String(error),
      });
      return results;
    }

    const postings = toPostings(payload);
    context.logger.debug('remoteok feed fetched', { postings: postings.length });

    for (const posting of postings) {
      if (results.length >= context.limit || context.signal?.aborted) break;
      try {
        const job = normalize(posting, search);
        if (job) results.push(job);
      } catch (error) {
        context.logger.warn('remoteok posting skipped', {
          id: posting.id ?? posting.slug ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    context.logger.info('remoteok collection finished', {
      scanned: postings.length,
      matched: results.length,
    });
    return results;
  },
};

export default remoteOkCollector;
