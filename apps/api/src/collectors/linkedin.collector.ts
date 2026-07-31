import type { Page } from 'playwright';
import { canonicalUrl, sleep, stripHtml } from '../core/utils.js';
import type { NormalizedJob } from '../repositories/job.repository.js';
import {
  detectEmploymentType,
  detectExperienceLevel,
  detectRemoteType,
  matchesSearchFilters,
  parseSalary,
  searchFilters,
} from './normalize.js';
import type { CollectorContext, CollectorDefinition } from './types.js';

const PROVIDER = 'linkedin';

/** Maps the user's remote preference onto LinkedIn's `f_WT` facet. */
function workplaceFacet(preferences: string[]): string | null {
  const codes: string[] = [];
  if (preferences.includes('onsite')) codes.push('1');
  if (preferences.includes('remote')) codes.push('2');
  if (preferences.includes('hybrid')) codes.push('3');
  return codes.length > 0 ? codes.join(',') : null;
}

function postedWithinSeconds(days: number): string {
  return `r${Math.max(1, Math.round(days * 86400))}`;
}

function buildSearchUrl(keyword: string, location: string, context: CollectorContext): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', keyword);
  if (location) url.searchParams.set('location', location);
  url.searchParams.set('f_TPR', postedWithinSeconds(context.settings.search.postedWithinDays));
  const facet = workplaceFacet(context.settings.search.remotePreference);
  if (facet) url.searchParams.set('f_WT', facet);
  url.searchParams.set('sortBy', 'DD');
  return url.toString();
}

/** LinkedIn bounces unauthenticated traffic to the login page or the public auth wall. */
export function isSignedOutUrl(url: string): boolean {
  return url.includes('/login') || url.includes('/authwall');
}

const CHALLENGE_BODY_PATTERN = /(unusual activity|verify your identity|security verification)/i;

/**
 * A challenge page looks like a successful navigation, so it has to be detected
 * from the body text as well as the checkpoint path or the run silently
 * reports zero jobs.
 */
export function isChallengePage(url: string, body: string): boolean {
  return url.includes('/checkpoint/') || CHALLENGE_BODY_PATTERN.test(body);
}

const SESSION_FIX_HINT =
  'linkedin session is not authenticated. Fix: open Browser Sessions, paste a fresh LinkedIn session and include the `li_at` cookie, then re-run the collector.';

async function readBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

interface ListingStub {
  url: string;
  title: string;
  company: string;
  location: string;
}

async function readListingStubs(page: Page): Promise<ListingStub[]> {
  return page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a.job-card-container__link, a.job-card-list__title, a[href*="/jobs/view/"]'),
    );
    const seen = new Set<string>();
    const out: { url: string; title: string; company: string; location: string }[] = [];

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      const match = /\/jobs\/view\/(\d+)/.exec(href);
      if (!match) continue;
      const id = match[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const card = anchor.closest('li, div.job-card-container') ?? anchor.parentElement;
      const text = (selector: string): string =>
        card?.querySelector(selector)?.textContent?.trim() ?? '';

      out.push({
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        title: anchor.textContent?.trim() ?? text('.job-card-list__title'),
        company: text('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle'),
        location: text('.job-card-container__metadata-item, .artdeco-entity-lockup__caption'),
      });
    }
    return out;
  });
}

async function readDetail(
  page: Page,
): Promise<{ descriptionHtml: string | null; criteria: string[] }> {
  return page.evaluate(() => {
    const description =
      document.querySelector('.jobs-description__content') ??
      document.querySelector('.jobs-box__html-content') ??
      document.querySelector('#job-details');
    const criteria = Array.from(
      document.querySelectorAll('.jobs-unified-top-card__job-insight, .job-details-jobs-unified-top-card__job-insight'),
    ).map((node) => node.textContent?.trim() ?? '');
    return { descriptionHtml: description?.innerHTML ?? null, criteria };
  });
}

/**
 * LinkedIn has no public jobs API, so this collector drives the logged-in
 * session in the persistent browser profile. If the session is not
 * authenticated it records that fact and returns nothing rather than failing
 * the whole collection run.
 */
export const linkedinCollector: CollectorDefinition = {
  id: 'linkedin',
  name: 'LinkedIn',
  source: 'linkedin',
  description:
    'Searches LinkedIn Jobs using the persistent browser profile. Sign in once from Browser Sessions; the session is then reused.',
  requiresAuth: true,
  requiresBoards: false,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const keywords = context.settings.search.keywords;
    if (keywords.length === 0) {
      context.logger.warn('linkedin collector has no search keywords configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const locations = context.settings.search.locations.length
      ? context.settings.search.locations
      : [''];
    const results: NormalizedJob[] = [];
    const page = await context.browser.newPage(PROVIDER);

    try {
      await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded' });
      if (isSignedOutUrl(page.url())) {
        context.logger.warn(SESSION_FIX_HINT, { url: page.url() });
        return [];
      }
      if (isChallengePage(page.url(), await readBodyText(page))) {
        context.logger.warn(
          'linkedin is serving a challenge/checkpoint page. Fix: open Browser Sessions, complete the challenge in a real browser and paste a fresh `li_at` cookie.',
          { url: page.url() },
        );
        return [];
      }

      let totalStubs = 0;
      let sawChallenge = false;

      for (const keyword of keywords) {
        for (const location of locations) {
          if (results.length >= context.limit) break;

          await page.goto(buildSearchUrl(keyword, location, context), {
            waitUntil: 'domcontentloaded',
          });
          await page
            .waitForSelector('a[href*="/jobs/view/"]', { timeout: 20000 })
            .catch(() => undefined);

          // Virtualised list: scroll so every card renders before reading.
          for (let i = 0; i < 6; i += 1) {
            await page.mouse.wheel(0, 1600);
            await sleep(600);
          }

          const stubs = await readListingStubs(page);
          totalStubs += stubs.length;
          context.logger.debug('linkedin listing page read', {
            keyword,
            location,
            found: stubs.length,
          });

          if (stubs.length === 0) {
            const searchUrl = page.url();
            if (isSignedOutUrl(searchUrl)) {
              context.logger.warn(SESSION_FIX_HINT, { url: searchUrl, keyword, location });
              sawChallenge = true;
            } else if (isChallengePage(searchUrl, await readBodyText(page))) {
              context.logger.warn(
                'linkedin search returned a challenge/checkpoint page instead of results. Fix: complete the challenge in a real browser and paste a fresh `li_at` cookie under Browser Sessions.',
                { url: searchUrl, keyword, location },
              );
              sawChallenge = true;
            }
          }

          for (const stub of stubs) {
            if (results.length >= context.limit) break;
            if (!stub.title || !stub.company) continue;

            let description: string | null = null;
            let descriptionHtml: string | null = null;
            let criteria: string[] = [];

            try {
              await page.goto(stub.url, { waitUntil: 'domcontentloaded' });
              await page
                .waitForSelector('#job-details, .jobs-description__content', { timeout: 15000 })
                .catch(() => undefined);
              await page
                .locator('button:has-text("See more"), button.jobs-description__footer-button')
                .first()
                .click({ timeout: 3000 })
                .catch(() => undefined);
              const detail = await readDetail(page);
              descriptionHtml = detail.descriptionHtml;
              description = detail.descriptionHtml ? stripHtml(detail.descriptionHtml) : null;
              criteria = detail.criteria;
            } catch (error) {
              context.logger.debug('linkedin detail read failed', {
                url: stub.url,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            const criteriaText = criteria.join(' | ');
            if (
              !matchesSearchFilters(
                {
                  title: stub.title,
                  company: stub.company,
                  location: stub.location,
                  description,
                  postedAt: null,
                },
                filters,
              )
            ) {
              continue;
            }

            const salary = parseSalary(`${criteriaText}\n${description ?? ''}`);
            results.push({
              source: 'linkedin',
              externalId: /\/jobs\/view\/(\d+)/.exec(stub.url)?.[1] ?? null,
              title: stub.title,
              company: stub.company,
              location: stub.location || null,
              remoteType: detectRemoteType(criteriaText, stub.location, stub.title, description),
              employmentType: detectEmploymentType(criteriaText, stub.title, description),
              experienceLevel: detectExperienceLevel(criteriaText, stub.title, description),
              salaryMin: salary.min,
              salaryMax: salary.max,
              salaryCurrency: salary.currency,
              salaryPeriod: salary.period,
              description,
              descriptionHtml,
              applicationUrl: canonicalUrl(stub.url),
              postedAt: null,
              raw: { criteria },
            });
          }
        }
      }

      // Zero stubs everywhere is indistinguishable from a clean "no matches" run
      // in the caller, so surface it here as a likely session problem.
      if (totalStubs === 0 && !sawChallenge) {
        context.logger.warn(
          'linkedin search returned zero listings for every keyword and location. This usually means the session expired or LinkedIn is serving a challenge page. Fix: paste a fresh LinkedIn session (the `li_at` cookie) under Browser Sessions.',
          { keywords: keywords.length, locations: locations.length },
        );
      }
    } finally {
      await page.close().catch(() => undefined);
      await context.browser.saveStorageState(PROVIDER);
    }

    return results;
  },
};
