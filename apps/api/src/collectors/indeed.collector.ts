import type { Page } from 'playwright';
import { resolveSessionStrategy, type Settings } from '@deedy/shared';
import { canonicalUrl, sleep, stripHtml } from '../core/utils.js';
import type { NormalizedJob } from '../repositories/job.repository.js';
import {
  decodeHtmlEntities,
  detectEmploymentType,
  detectExperienceLevel,
  detectRemoteType,
  matchesSearchFilters,
  parseSalary,
  searchFilters,
  toIsoDate,
} from './normalize.js';
import type { CollectorContext, CollectorDefinition } from './types.js';

const PROVIDER = 'indeed';
const DEFAULT_HOST = 'www.indeed.com';
const MAX_PAGES_PER_QUERY = 5;
const RESULTS_PER_PAGE = 10;
/** Below this the snippet is a teaser, not a description, and is worth a detail hit. */
const DETAIL_SNIPPET_MIN = 400;
const CHALLENGE_BACKOFF_MS = 20000;
/**
 * Wall-clock ceiling for one collect(). keywords × locations × pages × cards,
 * each card costing a detail read plus a ~1s pace, runs for hours when a tight
 * filter config means `context.limit` is never reached.
 */
const COLLECT_BUDGET_MS = 20 * 60 * 1000;

/**
 * Indeed serves a Cloudflare or hCaptcha interstitial to traffic it does not
 * trust. It renders as a normal 200, so it has to be detected from the content
 * or the run silently reports zero jobs.
 */
const CHALLENGE_PATTERNS = [
  /additional verification required/i,
  /verify you are a human/i,
  /checking your browser/i,
  /unusual traffic from your computer/i,
  /we(?:'|’)?ve detected unusual activity/i,
  /detected unusual activity from your (?:device|network)/i,
  /hcaptcha|cf-challenge|__cf_chl|cf_chl_opt/i,
  // Indeed's outright block page, observed live: it answers 403 with the title
  // "Blocked - Indeed.com" and a body carrying a Ray ID. It renders as an
  // ordinary page, so without these the run reports a clean zero and the user
  // is told nothing — which is exactly how this failure went unnoticed.
  /request blocked/i,
  /you have been blocked/i,
  /\bray id\b/i,
];

export function isChallengePage(url: string, body: string, status?: number | null): boolean {
  // Cloudflare and Indeed both answer a block with 403, and 429 is an explicit
  // rate limit. Either way the page holds no listings.
  if (status === 403 || status === 429) return true;
  if (/\/challenge|\/captcha|\/hcaptcha|cloudflare/i.test(url)) return true;
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Which repair to advise depends entirely on the resolved session strategy:
 * under `attended` there is already a visible window on this machine to sign in
 * and clear the interstitial in, under `stored` there is not, and the only route
 * back is pasting a session exported from another browser. Reading the raw
 * `attended` switch instead would misadvise anyone who pinned a strategy - an
 * open window is not the same thing as the session a run will actually use.
 */
const ATTENDED_SIGN_IN =
  'open the Browser page and press Sign in for Indeed — a window is already open on this machine; log in there once and this collector will reuse the session';

const BLOCK_SYMPTOM =
  'Indeed is blocking this machine (it answers 403 to traffic it does not trust) or is serving a verification challenge.';

const COUNTRY_HOST_TIP =
  'consider setting a country host such as "uk.indeed.com" under Settings → Search → Boards → indeed';

export function sessionFixHint(settings: Settings): string {
  return resolveSessionStrategy(settings.browser) === 'attended'
    ? `${BLOCK_SYMPTOM} Fix: ${ATTENDED_SIGN_IN}, clearing any verification in that same window, and ${COUNTRY_HOST_TIP}.`
    : `${BLOCK_SYMPTOM} Fix: open Browser Sessions, paste a fresh Indeed session from a browser where you are already signed in on this network, and ${COUNTRY_HOST_TIP}.`;
}

/** A country host must still resolve to Indeed — a typo would otherwise send the session elsewhere. */
const INDEED_HOST = /(^|\.)indeed\.[a-z]{2,3}(\.[a-z]{2})?$/i;
const COUNTRY_CODE = /^[a-z]{2}$/i;

/**
 * Honours a country host configured as the first entry under boards.indeed.
 * Accepts a full URL, a hostname, or a bare country code ("uk" → uk.indeed.com).
 */
function resolveHost(context: CollectorContext): string {
  const configured = (context.settings.search.boards.indeed ?? [])[0]?.trim();
  if (!configured) return DEFAULT_HOST;

  let host: string;
  try {
    host = configured.startsWith('http')
      ? new URL(configured).hostname
      : (configured.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '');
  } catch {
    host = '';
  }

  if (COUNTRY_CODE.test(host)) host = `${host.toLowerCase()}.indeed.com`;
  if (!host || !INDEED_HOST.test(host)) {
    context.logger.warn('ignoring non-Indeed host configured under boards.indeed', {
      configured,
      using: DEFAULT_HOST,
    });
    return DEFAULT_HOST;
  }
  return host.toLowerCase();
}

function buildSearchUrl(
  host: string,
  keyword: string,
  location: string,
  start: number,
  context: CollectorContext,
): string {
  const url = new URL(`https://${host}/jobs`);
  url.searchParams.set('q', keyword);
  if (location) url.searchParams.set('l', location);
  url.searchParams.set('fromage', String(context.settings.search.postedWithinDays));
  url.searchParams.set('sort', 'date');
  if (context.settings.search.remotePreference.includes('remote')) {
    url.searchParams.set('sc', '0kf:attr(DSQF7);');
  }
  if (start > 0) url.searchParams.set('start', String(start));
  return url.toString();
}

const DAY_MS = 86400000;
const UNIT_MS: Record<string, number> = {
  minute: 60000,
  min: 60000,
  hour: 3600000,
  hr: 3600000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/**
 * Indeed publishes dates three different ways: epoch milliseconds in the mosaic
 * payload, epoch seconds in older payloads, and relative text ("Posted 3 days
 * ago") in the DOM. Pure so the relative arithmetic can be unit-tested.
 */
export function parseIndeedPostedAt(value: unknown, now: number): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return toIsoDate(value < 1e12 ? value * 1000 : value);
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return parseIndeedPostedAt(Number(text), now);

  if (/\b(just posted|today)\b/i.test(text)) return new Date(now).toISOString();
  if (/\byesterday\b/i.test(text)) return new Date(now - DAY_MS).toISOString();

  const relative = /(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago/i.exec(text);
  const unit = UNIT_MS[(relative?.[2] ?? '').toLowerCase()];
  if (relative && unit) {
    const amount = Number(relative[1]);
    if (Number.isFinite(amount)) return new Date(now - amount * unit).toISOString();
  }

  return toIsoDate(text);
}

/**
 * The subset of the mosaic job card payload this collector reads. Every field is
 * `unknown` on purpose: this is untrusted JSON lifted out of Indeed's page, and
 * declaring the optimistic shape let a numeric `title` throw
 * "123.replace is not a function" and fail the entire run.
 */
interface MosaicJobCard {
  jobkey?: unknown;
  title?: unknown;
  company?: unknown;
  formattedLocation?: unknown;
  snippet?: unknown;
  jobDescription?: unknown;
  salarySnippet?: unknown;
  estimatedSalary?: unknown;
  pubDate?: unknown;
  createDate?: unknown;
  jobTypes?: unknown;
  remoteWorkModel?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface ResultCard {
  key: string;
  title: string;
  company: string;
  location: string;
  salaryText: string;
  snippet: string;
  snippetIsHtml: boolean;
  postedRaw: string | number | null;
  attributes: string;
  fromPayload: boolean;
}

/**
 * Reads the result set Indeed inlines into the page. This is the primary path:
 * the DOM class names churn constantly, the payload does not, and it carries
 * fields (pubDate, jobTypes, remoteWorkModel) the cards never render.
 */
async function readMosaicCards(page: Page): Promise<MosaicJobCard[]> {
  return page.evaluate(() => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;

    // `_initialData` is large and self-referential in places, so the walk needs a
    // visited set and a hard node budget on top of the depth cap or a single
    // page can burn seconds (or loop) inside the evaluate.
    const MAX_VISITED_NODES = 20000;
    const visited = new WeakSet<object>();
    let budget = MAX_VISITED_NODES;

    /** Depth-first hunt for the `results` array — its nesting moves between releases. */
    const collect = (root: unknown, depth: number): unknown[] => {
      if (!isRecord(root) || depth > 6 || budget <= 0) return [];
      if (visited.has(root)) return [];
      visited.add(root);
      budget -= 1;

      const results = root.results;
      if (
        Array.isArray(results) &&
        results.some((entry) => isRecord(entry) && typeof entry.jobkey === 'string')
      ) {
        // Only the well-formed entries survive: a null or otherwise shaped
        // element would throw later, outside the caller's catch, and fail the
        // whole run with zero jobs.
        return results.filter((entry) => isRecord(entry) && typeof entry.jobkey === 'string');
      }
      for (const value of Object.values(root)) {
        const found = collect(value, depth + 1);
        if (found.length > 0) return found;
      }
      return [];
    };

    /** Brace-scans the inline script when the globals were never assigned. */
    const fromScripts = (): unknown[] => {
      for (const script of Array.from(document.querySelectorAll('script'))) {
        const text = script.textContent ?? '';
        const at = text.indexOf('mosaic-provider-jobcards"]');
        const start = at < 0 ? -1 : text.indexOf('{', at);
        if (start < 0) continue;

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i += 1) {
          const ch = text[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth !== 0) continue;
            try {
              return collect(JSON.parse(text.slice(start, i + 1)), 0);
            } catch {
              break;
            }
          }
        }
      }
      return [];
    };

    const globals = window as unknown as {
      mosaic?: { providerData?: Record<string, unknown> };
      _initialData?: unknown;
      jobmap?: unknown;
    };

    for (const root of [globals.mosaic?.providerData?.['mosaic-provider-jobcards'], globals._initialData]) {
      const found = collect(root, 0);
      if (found.length > 0) return found as MosaicJobCard[];
    }

    const scripted = fromScripts();
    if (scripted.length > 0) return scripted as MosaicJobCard[];

    // Legacy layout: a flat jobmap array keyed by `jk`.
    if (Array.isArray(globals.jobmap)) {
      return globals.jobmap
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.jk === 'string')
        .map((entry) => ({
          jobkey: String(entry.jk),
          title: typeof entry.title === 'string' ? entry.title : '',
          company: typeof entry.cmp === 'string' ? entry.cmp : '',
          formattedLocation: typeof entry.loc === 'string' ? entry.loc : '',
        })) as MosaicJobCard[];
    }

    return [];
  });
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mosaicSalaryText(card: MosaicJobCard): string {
  if (typeof card.salarySnippet === 'string') return card.salarySnippet;
  if (isRecordValue(card.salarySnippet) && typeof card.salarySnippet.text === 'string') {
    return card.salarySnippet.text;
  }
  if (isRecordValue(card.estimatedSalary)) return asString(card.estimatedSalary.formattedRange);
  return '';
}

/** The card's job-type and workplace labels, joined for the type detectors. */
function mosaicAttributes(card: MosaicJobCard): string {
  // A bare string here used to be spread into individual characters.
  const jobTypes = Array.isArray(card.jobTypes)
    ? card.jobTypes.filter((type): type is string => typeof type === 'string')
    : typeof card.jobTypes === 'string'
      ? [card.jobTypes]
      : [];
  const model = card.remoteWorkModel;
  const remote = isRecordValue(model)
    ? asString(model.text) || asString(model.inlineText) || asString(model.type)
    : '';
  return [...jobTypes, remote].filter(Boolean).join(' ');
}

function toResultCard(card: MosaicJobCard): ResultCard | null {
  if (!isRecordValue(card)) return null;
  const key = asString(card.jobkey).trim();
  if (!key) return null;
  const snippet = asString(card.jobDescription) || asString(card.snippet);
  const posted = card.pubDate ?? card.createDate ?? null;
  return {
    key,
    title: decodeHtmlEntities(asString(card.title)).trim(),
    company: decodeHtmlEntities(asString(card.company)).trim(),
    location: decodeHtmlEntities(asString(card.formattedLocation)).trim(),
    salaryText: mosaicSalaryText(card),
    snippet,
    snippetIsHtml: true,
    postedRaw: typeof posted === 'string' || typeof posted === 'number' ? posted : null,
    attributes: mosaicAttributes(card),
    fromPayload: true,
  };
}

/** Fallback for the rare render where no payload is inlined. */
async function readDomCards(page: Page): Promise<ResultCard[]> {
  return page.evaluate(() => {
    const text = (root: Element, selectors: string[]): string => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const value = node?.textContent?.trim();
        if (value) return value;
      }
      return '';
    };

    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('div.job_seen_beacon, td.resultContent, div.cardOutline'),
    );
    const seen = new Set<string>();
    const out: {
      key: string;
      title: string;
      company: string;
      location: string;
      salaryText: string;
      snippet: string;
      snippetIsHtml: boolean;
      postedRaw: string | null;
      attributes: string;
      fromPayload: boolean;
    }[] = [];

    for (const card of cards) {
      const anchor = card.querySelector<HTMLAnchorElement>('a[data-jk], a[href*="jk="], h2 a');
      const key =
        anchor?.getAttribute('data-jk') ??
        card.getAttribute('data-jk') ??
        (anchor?.getAttribute('href')
          ? new URLSearchParams(anchor.getAttribute('href')?.split('?')[1] ?? '').get('jk')
          : null);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      out.push({
        key,
        title: text(card, ['h2.jobTitle span[title]', 'h2.jobTitle', 'h2 a span', 'h2']),
        company: text(card, ['[data-testid="company-name"]', 'span.companyName', '.company_location a']),
        location: text(card, ['[data-testid="text-location"]', 'div.companyLocation', '.company_location div']),
        salaryText: text(card, [
          '[data-testid="attribute_snippet_testid"]',
          '.salary-snippet-container',
          '.metadata.salary-snippet-container',
        ]),
        snippet: text(card, ['[data-testid="belowJobSnippet"]', '.job-snippet', 'div.underShelfFooter']),
        snippetIsHtml: false,
        postedRaw: text(card, [
          '[data-testid="myJobsStateDate"]',
          'span.date',
          '.jobMetaDataGroup',
          '.result-footer .date',
        ]),
        attributes: text(card, ['[data-testid="attribute_snippet_testid"]', '.metadataContainer']),
        fromPayload: false,
      });
    }
    return out;
  });
}

async function readDescriptionHtml(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const node =
      document.querySelector('#jobDescriptionText') ??
      document.querySelector('.jobsearch-JobComponent-description') ??
      document.querySelector('[data-testid="jobsearch-JobComponent-description"]');
    return node?.innerHTML ?? null;
  });
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

/**
 * Navigates and, on a challenge, backs off once and retries the same URL. A
 * single interstitial is usually pacing, not a dead session — only the second
 * consecutive one is treated as a real block.
 */
async function gotoTolerantOfChallenge(
  page: Page,
  url: string,
  context: CollectorContext,
  waitSelector?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => undefined);
    }
    if (!isChallengePage(page.url(), await bodyText(page))) return true;

    context.logger.warn('indeed challenge page encountered', { url, attempt: attempt + 1 });
    if (attempt === 0 && !context.signal?.aborted) await sleep(CHALLENGE_BACKOFF_MS);
  }
  return false;
}

/**
 * Indeed has no public jobs API and blocks datacentre traffic, so this drives
 * the persistent browser profile with whatever session the user has pasted.
 * Extraction reads the inlined mosaic payload first and only falls back to
 * scraping cards; a challenge page degrades to "return what we have" rather
 * than failing the whole collection run.
 */
export const indeedCollector: CollectorDefinition = {
  id: 'indeed',
  name: 'Indeed',
  source: 'indeed',
  description:
    'Searches Indeed using the persistent browser profile. Indeed blocks automated sign-in, so paste a session under Browser Sessions. Optionally set a country host (e.g. "uk.indeed.com" or just "uk") as the first entry under Settings → Search → Boards → indeed.',
  requiresAuth: true,
  requiresBoards: false,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const keywords = context.keywords;
    if (keywords.length === 0) {
      context.logger.warn('indeed collector has no search keywords configured');
      return [];
    }

    const host = resolveHost(context);
    // Indeed already searched by the term, so re-testing keywords locally would
    // discard legitimate adjacent matches. Exclusions still apply.
    const filters = searchFilters(context.settings, keywords, { matchKeywords: false });
    const locations = context.settings.search.locations.length
      ? context.settings.search.locations
      : [''];
    const results: NormalizedJob[] = [];
    const seen = new Set<string>();
    // Resolved once: the mode cannot change mid-run, and both warning sites
    // below must give the same, mode-correct instruction.
    const sessionHint = sessionFixHint(context.settings);
    let detailNavigation = true;
    /**
     * At most one rotation per run, and only for the search page. Moving the
     * exit can reach a different regional index and a fresh rate-limit bucket,
     * but it does not change how this browser fingerprints — so if the second
     * exit refuses us too, that is an answer, not an invitation to keep dialling.
     */
    let rotatedOnce = false;
    const deadline = Date.now() + COLLECT_BUDGET_MS;
    let budgetExhausted = false;
    const outOfTime = (): boolean => {
      if (Date.now() < deadline) return false;
      budgetExhausted = true;
      return true;
    };
    const page = await context.browser.newPage(PROVIDER);

    try {
      for (const keyword of keywords) {
        if (context.signal?.aborted) return results;
        // Without this the run keeps querying remaining keywords long after the
        // caller's cap is met.
        if (results.length >= context.limit) break;
        if (outOfTime()) break;

        for (const location of locations) {
          if (context.signal?.aborted) return results;
          if (results.length >= context.limit) break;
          if (outOfTime()) break;

          for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex += 1) {
            if (context.signal?.aborted) return results;
            if (results.length >= context.limit) break;
            if (outOfTime()) break;

            const searchUrl = buildSearchUrl(
              host,
              keyword,
              location,
              pageIndex * RESULTS_PER_PAGE,
              context,
            );

            let loaded = await gotoTolerantOfChallenge(
              page,
              searchUrl,
              context,
              'div.job_seen_beacon, td.resultContent, div.cardOutline',
            );
            if (!loaded && !rotatedOnce && !context.signal?.aborted) {
              rotatedOnce = true;
              const moved =
                (await context.onBlocked?.('indeed served a block or verification page')) ?? false;
              if (moved) {
                context.logger.info(
                  'indeed exit location rotated after a block; retrying this search page once',
                  { url: searchUrl, keyword, location },
                );
                loaded = await gotoTolerantOfChallenge(
                  page,
                  searchUrl,
                  context,
                  'div.job_seen_beacon, td.resultContent, div.cardOutline',
                );
              } else {
                context.logger.warn(
                  'indeed is blocking this run and the exit location did not move; not retrying',
                  { url: searchUrl, keyword, location },
                );
              }
            }
            if (!loaded) {
              context.logger.warn(sessionHint, { url: searchUrl, keyword, location });
              return results;
            }

            const payload = await readMosaicCards(page).catch(() => [] as MosaicJobCard[]);
            const cards =
              payload.length > 0
                ? payload
                    .map(toResultCard)
                    .filter((card): card is ResultCard => card !== null)
                : await readDomCards(page);

            context.logger.debug('indeed results page read', {
              keyword,
              location,
              page: pageIndex + 1,
              found: cards.length,
              strategy: payload.length > 0 ? 'mosaic' : 'dom',
            });
            if (cards.length === 0) break;

            for (const card of cards) {
              if (context.signal?.aborted) return results;
              if (results.length >= context.limit) break;
              if (!card.title || !card.company) continue;
              if (seen.has(card.key)) continue;
              seen.add(card.key);

              const applicationUrl = canonicalUrl(`https://${host}/viewjob?jk=${card.key}`);
              let descriptionHtml: string | null = card.snippetIsHtml
                ? decodeHtmlEntities(card.snippet)
                : null;
              let description: string | null =
                (descriptionHtml ? stripHtml(descriptionHtml) : card.snippet) || null;

              // Visiting every /viewjob is the fastest way to earn an interstitial,
              // so only pay for it when the snippet is a teaser.
              if (detailNavigation && (description?.length ?? 0) < DETAIL_SNIPPET_MIN) {
                try {
                  const opened = await gotoTolerantOfChallenge(page, applicationUrl, context);
                  if (!opened) {
                    detailNavigation = false;
                    context.logger.warn(sessionHint, { url: applicationUrl });
                  } else {
                    const html = await readDescriptionHtml(page);
                    if (html) {
                      descriptionHtml = decodeHtmlEntities(html);
                      description = stripHtml(descriptionHtml);
                    }
                  }
                } catch (error) {
                  context.logger.debug('indeed detail read failed', {
                    jk: card.key,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }

                // Indeed rate-limits aggressively; pace the detail navigations.
                await sleep(900 + Math.floor(Math.random() * 1300));
              }

              const postedAt = parseIndeedPostedAt(card.postedRaw, Date.now());

              if (
                !matchesSearchFilters(
                  {
                    title: card.title,
                    company: card.company,
                    location: card.location,
                    description,
                    postedAt,
                  },
                  filters,
                )
              ) {
                continue;
              }

              const salary = parseSalary(`${card.salaryText}\n${description ?? ''}`);
              results.push({
                source: 'indeed',
                externalId: card.key,
                title: card.title,
                company: card.company,
                location: card.location || null,
                remoteType: detectRemoteType(card.location, card.attributes, card.title, description),
                employmentType: detectEmploymentType(
                  card.attributes,
                  card.salaryText,
                  card.title,
                  description,
                ),
                experienceLevel: detectExperienceLevel(card.title, description),
                salaryMin: salary.min,
                salaryMax: salary.max,
                salaryCurrency: salary.currency,
                salaryPeriod: salary.period,
                description,
                descriptionHtml,
                applicationUrl,
                postedAt,
                raw: {
                  jk: card.key,
                  salaryText: card.salaryText,
                  attributes: card.attributes,
                  strategy: card.fromPayload ? 'mosaic' : 'dom',
                },
              });
            }

            // The search page itself is cheap but still paced when we skipped details.
            if (!detailNavigation) await sleep(900 + Math.floor(Math.random() * 1300));
          }
        }
      }
      // Otherwise a budget-truncated run is indistinguishable from "no results".
      if (budgetExhausted) {
        context.logger.warn('indeed collector stopped early: run time budget exhausted', {
          budgetMs: COLLECT_BUDGET_MS,
          keywords: keywords.length,
          locations: locations.length,
          collected: results.length,
        });
      }
    } finally {
      await page.close().catch(() => undefined);
      await context.browser.saveStorageState(PROVIDER);
    }

    return results;
  },
};
