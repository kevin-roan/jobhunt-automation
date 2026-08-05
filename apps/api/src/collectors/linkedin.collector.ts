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
  toIsoDate,
} from './normalize.js';
import type { CollectorContext, CollectorDefinition } from './types.js';

const PROVIDER = 'linkedin';

/** LinkedIn serves 25 results per page and pages via the `start` offset. */
const PAGE_SIZE = 25;
const MAX_PAGES_PER_QUERY = 5;
/** Bounds the virtualised-list scroll so a stuck pane cannot stall the run. */
const MAX_SCROLL_ROUNDS = 25;
const SCROLL_BUDGET_MS = 20000;
/**
 * Wall-clock ceiling for one collect(). The structural bound is
 * keywords × locations × 5 pages × 25 cards, and each card costs a detail read
 * plus a ~1s pace: at the default 30 active keywords and two locations that is
 * ~7,500 detail reads, i.e. hours. `results.length >= limit` cannot help when a
 * tight filter config means the limit is never reached.
 */
const COLLECT_BUDGET_MS = 20 * 60 * 1000;
const SCROLL_SETTLE_MS = 450;
/** Detail reads are paced randomly — a fixed cadence trips rate limiting fast. */
const DETAIL_PACE_MIN_MS = 700;
const DETAIL_PACE_MAX_MS = 1800;

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

function buildSearchUrl(
  keyword: string,
  location: string,
  context: CollectorContext,
  start: number,
): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', keyword);
  if (location) url.searchParams.set('location', location);
  url.searchParams.set('f_TPR', postedWithinSeconds(context.settings.search.postedWithinDays));
  const facet = workplaceFacet(context.settings.search.remotePreference);
  if (facet) url.searchParams.set('f_WT', facet);
  url.searchParams.set('sortBy', 'DD');
  if (start > 0) url.searchParams.set('start', String(start));
  return url.toString();
}

/**
 * LinkedIn bounces unauthenticated traffic to the login page, the public auth
 * wall, the signup funnel, or a `session_redirect` bounce that lands on any of
 * them — all four mean the `li_at` cookie is missing or expired.
 */
export function isSignedOutUrl(url: string): boolean {
  return (
    url.includes('/login') ||
    url.includes('/uas/login') ||
    url.includes('/authwall') ||
    url.includes('/signup') ||
    url.includes('session_redirect')
  );
}

const SIGNED_OUT_BODY_PATTERN = /(sign in to view|join linkedin|sign in to see who)/i;

/** The auth wall can also render on a normal jobs URL, so the body matters too. */
function isSignedOutBody(body: string): boolean {
  return SIGNED_OUT_BODY_PATTERN.test(body);
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

const CHALLENGE_FIX_HINT =
  'linkedin is serving a challenge/checkpoint page. Fix: open Browser Sessions, complete the challenge in a real browser and paste a fresh `li_at` cookie.';

const DAY_MS = 86400000;

const MS_PER_UNIT: Record<string, number | undefined> = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

/**
 * Converts LinkedIn's relative posting label ("2 days ago", "Reposted 3 hours
 * ago") to an absolute ISO timestamp. Exported so the arithmetic can be unit
 * tested without a browser.
 */
export function parseRelativePostedAt(text: string, now: number): string | null {
  const cleaned = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  // The relative form wins: "today only 5 days ago" is a real card label, and
  // short-circuiting on "today" first dated it to now. Also accepts LinkedIn's
  // capped "30+ days ago".
  const match = /(\d+|an?)\s*\+?\s*(second|minute|hour|day|week|month|year)s?\s+ago/.exec(cleaned);
  if (!match) {
    if (/\b(just now|moments? ago|today)\b/.test(cleaned)) return new Date(now).toISOString();
    if (/\byesterday\b/.test(cleaned)) return new Date(now - DAY_MS).toISOString();
    return null;
  }

  const rawAmount = match[1] ?? '';
  const amount = rawAmount === 'a' || rawAmount === 'an' ? 1 : Number(rawAmount);
  const unit = MS_PER_UNIT[match[2] ?? ''];
  if (!unit || !Number.isFinite(amount) || amount <= 0) return null;

  const posted = now - amount * unit;
  if (posted <= 0) return null;
  return new Date(posted).toISOString();
}

/**
 * LinkedIn renders the job title twice inside the card link — once for screen
 * readers and once visibly — so `textContent` comes back exactly doubled.
 */
function dedupeTitle(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 2) return text;
  if (text.length % 2 === 0) {
    const half = text.length / 2;
    if (text.slice(0, half) === text.slice(half)) return text.slice(0, half).trim();
  }
  // "Title Title" — the two copies separated by the whitespace we collapsed.
  const separated = Math.floor(text.length / 2);
  if (text.length % 2 === 1 && text[separated] === ' ') {
    if (text.slice(0, separated) === text.slice(separated + 1)) return text.slice(0, separated);
  }
  return text;
}

async function readBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

function detailPace(): number {
  return DETAIL_PACE_MIN_MS + Math.floor(Math.random() * (DETAIL_PACE_MAX_MS - DETAIL_PACE_MIN_MS));
}

const CARD_SELECTOR =
  'li[data-occludable-job-id], li[data-job-id], li.jobs-search-results__list-item, li.scaffold-layout__list-item, div.job-card-container';

interface ScrollProbe {
  cards: number;
  usedPane: boolean;
  atEnd: boolean;
}

/**
 * The results are virtualised inside an inner scroll pane, so scrolling the
 * window renders nothing. Drives the pane's own `scrollTop` until the card
 * count stops growing, bounded by rounds and wall time, and falls back to the
 * window when no scrollable pane can be found.
 */
async function scrollResultsPane(page: Page, signal?: AbortSignal): Promise<number> {
  const deadline = Date.now() + SCROLL_BUDGET_MS;
  let previous = -1;
  let stableRounds = 0;
  let cards = 0;

  for (let round = 0; round < MAX_SCROLL_ROUNDS; round += 1) {
    if (signal?.aborted || Date.now() > deadline) break;

    const probe = await page
      .evaluate((selector: string): ScrollProbe => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const scrollable = (node: HTMLElement | null): HTMLElement | null => {
          let current = node?.parentElement ?? null;
          while (current && current !== document.body) {
            const overflow = getComputedStyle(current).overflowY;
            if (
              (overflow === 'auto' || overflow === 'scroll') &&
              current.scrollHeight > current.clientHeight + 40
            ) {
              return current;
            }
            current = current.parentElement;
          }
          return null;
        };

        let pane: HTMLElement | null = null;
        const paneSelectors = [
          '.jobs-search-results-list',
          '.scaffold-layout__list > div',
          '.scaffold-layout__list',
        ];
        for (const paneSelector of paneSelectors) {
          const candidate = document.querySelector<HTMLElement>(paneSelector);
          if (candidate && candidate.scrollHeight > candidate.clientHeight + 40) {
            pane = candidate;
            break;
          }
        }
        if (!pane) pane = scrollable(nodes[nodes.length - 1] ?? null);

        const step = Math.max(600, (pane?.clientHeight ?? window.innerHeight) * 0.85);
        if (pane) {
          pane.scrollTop += step;
          return {
            cards: nodes.length,
            usedPane: true,
            atEnd: pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 8,
          };
        }

        window.scrollBy(0, step);
        return {
          cards: nodes.length,
          usedPane: false,
          atEnd: window.scrollY + window.innerHeight >= document.body.scrollHeight - 8,
        };
      }, CARD_SELECTOR)
      .catch((): ScrollProbe => ({ cards: 0, usedPane: false, atEnd: true }));

    cards = probe.cards;
    await sleep(SCROLL_SETTLE_MS);

    if (probe.cards > previous) {
      previous = probe.cards;
      stableRounds = 0;
      continue;
    }
    // Two quiet rounds at the bottom means every card has been materialised.
    stableRounds += 1;
    if (stableRounds >= 2 && probe.atEnd) break;
    if (stableRounds >= 4) break;
  }

  return cards;
}

interface ListingStub {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  postedText: string;
  postedDateTime: string;
}

async function readListingStubs(page: Page): Promise<ListingStub[]> {
  const stubs = await page.evaluate((selector: string) => {
    const text = (root: Element, selectors: string): string =>
      root.querySelector(selectors)?.textContent?.trim() ?? '';

    const cards = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const seen = new Set<string>();
    const out: {
      id: string;
      title: string;
      company: string;
      location: string;
      postedText: string;
      postedDateTime: string;
    }[] = [];

    for (const card of cards) {
      const anchor = card.querySelector<HTMLAnchorElement>(
        'a.job-card-container__link, a.job-card-job-posting-card-wrapper__card-link, a.job-card-list__title, a[href*="/jobs/view/"]',
      );
      const href = anchor?.getAttribute('href') ?? '';
      const urn = card.getAttribute('data-entity-urn') ?? '';
      const id =
        card.getAttribute('data-occludable-job-id') ??
        card.getAttribute('data-job-id') ??
        /\/jobs\/view\/(\d+)/.exec(href)?.[1] ??
        /currentJobId=(\d+)/.exec(href)?.[1] ??
        /(\d+)$/.exec(urn)?.[1] ??
        '';
      if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);

      // `anchor.textContent` returns the title twice (visually-hidden + visible
      // copy), so prefer the accessible name or the single visible node.
      const title =
        [
          anchor?.getAttribute('aria-label')?.trim(),
          anchor?.querySelector('strong')?.textContent?.trim(),
          anchor?.querySelector('span[aria-hidden="true"]')?.textContent?.trim(),
          text(
            card,
            '.job-card-list__title--link, .job-card-list__title, .artdeco-entity-lockup__title',
          ),
          anchor?.textContent?.trim(),
        ].find((candidate) => Boolean(candidate)) ?? '';

      const time = card.querySelector('time[datetime]');

      out.push({
        id,
        title,
        company: text(
          card,
          '.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name',
        ),
        location: text(
          card,
          '.artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper li, .job-card-container__metadata-item',
        ),
        postedText: `${time?.textContent?.trim() ?? ''} ${text(card, '.job-card-container__footer-item, .job-card-container__listed-status, time')}`.trim(),
        postedDateTime: time?.getAttribute('datetime') ?? '',
      });
    }
    return out;
  }, CARD_SELECTOR);

  return stubs.map((stub) => ({
    ...stub,
    url: `https://www.linkedin.com/jobs/view/${stub.id}/`,
    title: dedupeTitle(stub.title),
    company: dedupeTitle(stub.company),
  }));
}

async function readDetail(
  page: Page,
): Promise<{ descriptionHtml: string | null; criteria: string[] }> {
  return page.evaluate(() => {
    const description =
      document.querySelector('.jobs-description__content') ??
      document.querySelector('.jobs-box__html-content') ??
      document.querySelector('.jobs-description-content__text') ??
      document.querySelector('#job-details');
    const criteria = Array.from(
      document.querySelectorAll(
        '.jobs-unified-top-card__job-insight, .job-details-jobs-unified-top-card__job-insight, .job-details-preferences-and-skills__pill, .job-details-jobs-unified-top-card__primary-description-container',
      ),
    ).map((node) => node.textContent?.trim() ?? '');
    return { descriptionHtml: description?.innerHTML ?? null, criteria };
  });
}

/** Expands the truncated description; absent on short postings, so failures are ignored. */
async function expandDescription(page: Page): Promise<void> {
  await page
    .locator(
      'button:has-text("See more"), button.jobs-description__footer-button, .jobs-description__footer-button',
    )
    .first()
    .click({ timeout: 3000 })
    .catch(() => undefined);
}

/**
 * Clicking the card renders the detail in the right-hand pane, which costs one
 * XHR instead of a full navigation to /jobs/view/{id} — LinkedIn rate limits
 * the latter aggressively. Returns false when the pane never appears so the
 * caller can fall back to direct navigation.
 */
async function openDetailInPane(page: Page, id: string): Promise<boolean> {
  const card = page
    .locator(
      `li[data-occludable-job-id="${id}"] a, li[data-job-id="${id}"] a, a[href*="/jobs/view/${id}"]`,
    )
    .first();
  try {
    await card.scrollIntoViewIfNeeded({ timeout: 3000 });
    await card.click({ timeout: 5000 });
  } catch {
    return false;
  }
  const shown = await page
    .waitForSelector('#job-details, .jobs-description__content, .jobs-search__job-details', {
      timeout: 10000,
    })
    .catch(() => null);
  return shown !== null;
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
    const keywords = context.keywords;
    if (keywords.length === 0) {
      context.logger.warn('linkedin collector has no search keywords configured');
      return [];
    }

    // LinkedIn already ranked these results for the searched term, so a local
    // substring re-test would only throw away legitimate adjacent matches.
    const filters = searchFilters(context.settings, keywords, { matchKeywords: false });
    const locations = context.settings.search.locations.length
      ? context.settings.search.locations
      : [''];
    const results: NormalizedJob[] = [];
    const page = await context.browser.newPage(PROVIDER);

    /**
     * Rotation is offered for a challenge page only, and only once per run.
     *
     * A LinkedIn session is the `li_at` cookie, which is bound to the account
     * and not to the IP, so a signed-out page is never something a different
     * exit can fix — re-running the same dead cookie from Zurich still lands on
     * the auth wall. Worse, LinkedIn scores a mid-session country change as a
     * suspicious signal in its own right, so a rotation can *produce* the
     * checkpoint we were trying to escape. Hence: challenge only, at most one
     * move, and stop as before if the exit did not actually change.
     */
    let rotatedOnce = false;
    const rotateForChallenge = async (reason: string): Promise<boolean> => {
      if (rotatedOnce) return false;
      rotatedOnce = true;
      const moved = (await context.onBlocked?.(reason)) ?? false;
      if (moved) {
        context.logger.info(
          'linkedin exit location rotated after a checkpoint; retrying this page once',
          { reason },
        );
      } else {
        context.logger.warn(
          'linkedin checkpoint and the exit location did not move; not retrying',
          { reason },
        );
      }
      return moved;
    };

    /** One listing-page load: navigate, let the virtualised pane materialise, read. */
    const loadListingPage = async (url: string): Promise<ListingStub[]> => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { timeout: 20000 }).catch(() => undefined);
      await scrollResultsPane(page, context.signal);
      return readListingStubs(page);
    };

    try {
      await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded' });
      let landingBody = await readBodyText(page);
      if (isSignedOutUrl(page.url()) || isSignedOutBody(landingBody)) {
        context.logger.warn(SESSION_FIX_HINT, { url: page.url() });
        return [];
      }
      if (isChallengePage(page.url(), landingBody)) {
        context.logger.warn(CHALLENGE_FIX_HINT, { url: page.url() });
        if (!(await rotateForChallenge('linkedin checkpoint on the jobs landing page'))) return [];

        await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded' });
        landingBody = await readBodyText(page);
        if (
          isSignedOutUrl(page.url()) ||
          isSignedOutBody(landingBody) ||
          isChallengePage(page.url(), landingBody)
        ) {
          context.logger.warn(CHALLENGE_FIX_HINT, { url: page.url(), afterRotation: true });
          return [];
        }
      }

      let totalStubs = 0;
      let sawChallenge = false;
      let stop = false;
      const seenIds = new Set<string>();

      const deadline = Date.now() + COLLECT_BUDGET_MS;
      let budgetExhausted = false;
      const outOfTime = (): boolean => {
        if (Date.now() < deadline) return false;
        budgetExhausted = true;
        return true;
      };

      for (const keyword of keywords) {
        if (stop || context.signal?.aborted || results.length >= context.limit) break;
        if (outOfTime()) break;

        for (const location of locations) {
          if (stop || context.signal?.aborted || results.length >= context.limit) break;
          if (outOfTime()) break;

          for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex += 1) {
            if (stop || context.signal?.aborted || results.length >= context.limit) break;
            if (outOfTime()) break;

            const searchUrl = buildSearchUrl(keyword, location, context, pageIndex * PAGE_SIZE);
            let stubs = await loadListingPage(searchUrl);

            if (stubs.length === 0) {
              const url = page.url();
              const body = await readBodyText(page);
              if (isSignedOutUrl(url) || isSignedOutBody(body)) {
                // Deliberately no rotation here: the cookie, not the exit, is
                // what LinkedIn rejected.
                context.logger.warn(SESSION_FIX_HINT, { url, keyword, location });
                sawChallenge = true;
                stop = true;
              } else if (isChallengePage(url, body)) {
                context.logger.warn(
                  'linkedin search returned a challenge/checkpoint page instead of results. Fix: complete the challenge in a real browser and paste a fresh `li_at` cookie under Browser Sessions.',
                  { url, keyword, location },
                );
                if (await rotateForChallenge('linkedin checkpoint on the jobs search page')) {
                  stubs = await loadListingPage(searchUrl);
                }
                if (stubs.length === 0) {
                  sawChallenge = true;
                  stop = true;
                }
              }
            }

            totalStubs += stubs.length;
            const fresh = stubs.filter((stub) => !seenIds.has(stub.id));
            context.logger.debug('linkedin listing page read', {
              keyword,
              location,
              page: pageIndex + 1,
              found: stubs.length,
              fresh: fresh.length,
            });

            if (stubs.length === 0) break;

            // No unseen ids means LinkedIn is replaying the last page rather
            // than honouring a deeper `start` offset.
            if (fresh.length === 0) break;

            // Direct navigation destroys the results pane, so once we fall back
            // every remaining card on this page has to use it too.
            let paneLost = false;

            for (const stub of fresh) {
              if (context.signal?.aborted || results.length >= context.limit) break;
              seenIds.add(stub.id);
              if (!stub.title || !stub.company) continue;

              let description: string | null = null;
              let descriptionHtml: string | null = null;
              let criteria: string[] = [];

              try {
                const inPane = paneLost ? false : await openDetailInPane(page, stub.id);
                if (!inPane) {
                  paneLost = true;
                  await page.goto(stub.url, { waitUntil: 'domcontentloaded' });
                  await page
                    .waitForSelector('#job-details, .jobs-description__content', { timeout: 15000 })
                    .catch(() => undefined);
                }
                await expandDescription(page);
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

              await sleep(detailPace());

              if (description === null) {
                const body = await readBodyText(page);
                // No rotation mid-detail: the results pane and the card cursor
                // would be lost anyway, so the retry has nothing to resume.
                if (isChallengePage(page.url(), body)) {
                  context.logger.warn(CHALLENGE_FIX_HINT, { url: page.url() });
                  sawChallenge = true;
                  stop = true;
                  break;
                }
                if (isSignedOutUrl(page.url()) || isSignedOutBody(body)) {
                  context.logger.warn(SESSION_FIX_HINT, { url: page.url() });
                  sawChallenge = true;
                  stop = true;
                  break;
                }
              }

              const criteriaText = criteria.join(' | ');
              const postedAt =
                toIsoDate(stub.postedDateTime || null) ??
                parseRelativePostedAt(stub.postedText, Date.now());

              if (
                !matchesSearchFilters(
                  {
                    title: stub.title,
                    company: stub.company,
                    location: stub.location,
                    description,
                    postedAt,
                  },
                  filters,
                )
              ) {
                continue;
              }

              const salary = parseSalary(`${criteriaText}\n${description ?? ''}`);
              results.push({
                source: 'linkedin',
                externalId: stub.id,
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
                postedAt,
                raw: { criteria },
              });
            }
          }
        }
      }

      // Otherwise a budget-truncated run is indistinguishable from "no results".
      if (budgetExhausted) {
        context.logger.warn('linkedin collector stopped early: run time budget exhausted', {
          budgetMs: COLLECT_BUDGET_MS,
          keywords: keywords.length,
          locations: locations.length,
          collected: results.length,
        });
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
