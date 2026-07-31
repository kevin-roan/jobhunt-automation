import type { Page } from 'playwright';
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
} from './normalize.js';
import type { CollectorContext, CollectorDefinition } from './types.js';

const PROVIDER = 'indeed';
const DEFAULT_HOST = 'www.indeed.com';
const MAX_PAGES_PER_QUERY = 5;
const RESULTS_PER_PAGE = 10;

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
  /hcaptcha|cf-challenge|__cf_chl/i,
];

export function isChallengePage(url: string, body: string): boolean {
  if (/\/challenge|\/captcha|cloudflare/i.test(url)) return true;
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(body));
}

const SESSION_FIX_HINT =
  'Indeed is serving a verification challenge. Fix: open Browser Sessions, paste a fresh Indeed session from a browser where you are already signed in, then re-run the collector.';

/** Honours a country host configured as the first entry under boards.indeed. */
function resolveHost(context: CollectorContext): string {
  const configured = (context.settings.search.boards.indeed ?? [])[0]?.trim();
  if (!configured) return DEFAULT_HOST;
  try {
    // Accept either "uk.indeed.com" or a full URL.
    const host = configured.startsWith('http')
      ? new URL(configured).hostname
      : configured.replace(/^\/+|\/+$/g, '');
    return host || DEFAULT_HOST;
  } catch {
    return DEFAULT_HOST;
  }
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

interface ResultCard {
  key: string;
  title: string;
  company: string;
  location: string;
  salaryText: string;
  snippet: string;
}

async function readResultCards(page: Page): Promise<ResultCard[]> {
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
      });
    }
    return out;
  }) as unknown as Promise<ResultCard[]>;
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
 * Indeed has no public jobs API and blocks datacentre traffic, so this drives
 * the persistent browser profile with whatever session the user has pasted.
 * A challenge page degrades to "return what we have" rather than failing the
 * whole collection run.
 */
export const indeedCollector: CollectorDefinition = {
  id: 'indeed',
  name: 'Indeed',
  source: 'indeed',
  description:
    'Searches Indeed using the persistent browser profile. Indeed blocks automated sign-in, so paste a session under Browser Sessions. Optionally set a country host (e.g. "uk.indeed.com") as the first entry under Settings → Search → Boards → indeed.',
  requiresAuth: true,
  requiresBoards: false,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const keywords = context.settings.search.keywords;
    if (keywords.length === 0) {
      context.logger.warn('indeed collector has no search keywords configured');
      return [];
    }

    const host = resolveHost(context);
    const filters = searchFilters(context.settings);
    const locations = context.settings.search.locations.length
      ? context.settings.search.locations
      : [''];
    const results: NormalizedJob[] = [];
    const page = await context.browser.newPage(PROVIDER);

    try {
      for (const keyword of keywords) {
        for (const location of locations) {
          if (results.length >= context.limit) break;

          for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex += 1) {
            if (results.length >= context.limit) break;

            const searchUrl = buildSearchUrl(
              host,
              keyword,
              location,
              pageIndex * RESULTS_PER_PAGE,
              context,
            );
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
            await page
              .waitForSelector('div.job_seen_beacon, td.resultContent, div.cardOutline', {
                timeout: 15000,
              })
              .catch(() => undefined);

            if (isChallengePage(page.url(), await bodyText(page))) {
              context.logger.warn(SESSION_FIX_HINT, { url: page.url(), keyword, location });
              return results;
            }

            const cards = await readResultCards(page);
            context.logger.debug('indeed results page read', {
              keyword,
              location,
              page: pageIndex + 1,
              found: cards.length,
            });
            if (cards.length === 0) break;

            for (const card of cards) {
              if (results.length >= context.limit) break;
              if (!card.title || !card.company) continue;

              const applicationUrl = canonicalUrl(`https://${host}/viewjob?jk=${card.key}`);
              let description: string | null = card.snippet || null;
              let descriptionHtml: string | null = null;

              try {
                await page.goto(applicationUrl, { waitUntil: 'domcontentloaded' });
                if (isChallengePage(page.url(), await bodyText(page))) {
                  context.logger.warn(SESSION_FIX_HINT, { url: applicationUrl });
                  return results;
                }
                const html = await readDescriptionHtml(page);
                if (html) {
                  descriptionHtml = decodeHtmlEntities(html);
                  description = stripHtml(descriptionHtml);
                }
              } catch (error) {
                context.logger.debug('indeed detail read failed', {
                  jk: card.key,
                  error: error instanceof Error ? error.message : String(error),
                });
              }

              if (
                !matchesSearchFilters(
                  {
                    title: card.title,
                    company: card.company,
                    location: card.location,
                    description,
                    postedAt: null,
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
                remoteType: detectRemoteType(card.location, card.title, description),
                employmentType: detectEmploymentType(card.salaryText, card.title, description),
                experienceLevel: detectExperienceLevel(card.title, description),
                salaryMin: salary.min,
                salaryMax: salary.max,
                salaryCurrency: salary.currency,
                salaryPeriod: salary.period,
                description,
                descriptionHtml,
                applicationUrl,
                postedAt: null,
                raw: { jk: card.key, salaryText: card.salaryText },
              });

              // Indeed rate-limits aggressively; pace the detail navigations.
              await sleep(600 + Math.floor(Math.random() * 700));
            }
          }
        }
      }
    } finally {
      await page.close().catch(() => undefined);
      await context.browser.saveStorageState(PROVIDER);
    }

    return results;
  },
};
