import { stripHtml } from '../core/utils.js';
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

interface AshbyPosting {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  department?: string;
  team?: string;
  employmentType?: string;
  isRemote?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    summaryComponents?: {
      minValue?: number;
      maxValue?: number;
      currencyCode?: string;
      interval?: string;
    }[];
  };
}

interface AshbyResponse {
  jobs?: AshbyPosting[];
  name?: string;
}

/** Public Ashby job board API — no authentication required. */
export const ashbyCollector: CollectorDefinition = {
  id: 'ashby',
  name: 'Ashby',
  source: 'ashby',
  description:
    'Reads public Ashby job boards. Configure board names under Settings → Search → Boards (e.g. "ramp").',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.ashby ?? [];
    if (boards.length === 0) {
      context.logger.warn('ashby collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const payload = await context.http.getJson<AshbyResponse>(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
        );
        const companyName = payload.name?.trim() || slug;

        for (const posting of payload.jobs ?? []) {
          if (results.length >= context.limit) break;

          const html = posting.descriptionHtml
            ? decodeHtmlEntities(posting.descriptionHtml)
            : null;
          const description = posting.descriptionPlain ?? (html ? stripHtml(html) : null);
          const location =
            posting.location ?? posting.secondaryLocations?.[0]?.location ?? null;
          const postedAt = toIsoDate(posting.publishedAt ?? null);

          if (
            !matchesSearchFilters(
              { title: posting.title, company: companyName, location, description, postedAt },
              filters,
            )
          ) {
            continue;
          }

          const component = posting.compensation?.summaryComponents?.[0];
          const parsedSalary = parseSalary(
            posting.compensation?.compensationTierSummary ?? description,
          );

          results.push({
            source: 'ashby',
            externalId: posting.id,
            title: posting.title,
            company: companyName,
            location,
            remoteType: posting.isRemote
              ? 'remote'
              : detectRemoteType(location, posting.title, description),
            employmentType: detectEmploymentType(
              posting.employmentType,
              posting.title,
              description,
            ),
            experienceLevel: detectExperienceLevel(posting.title, description),
            salaryMin: component?.minValue ?? parsedSalary.min,
            salaryMax: component?.maxValue ?? parsedSalary.max,
            salaryCurrency: component?.currencyCode ?? parsedSalary.currency,
            salaryPeriod: component?.interval ?? parsedSalary.period,
            description,
            descriptionHtml: html,
            applicationUrl: posting.applyUrl ?? posting.jobUrl ?? '',
            postedAt,
            raw: posting,
          });
        }
      } catch (error) {
        context.logger.error('ashby board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results.filter((job) => job.applicationUrl.length > 0);
  },
};
