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

interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
  ref?: string;
  company?: { identifier?: string; name?: string };
}

interface SmartRecruitersListResponse {
  totalFound?: number;
  content?: SmartRecruitersPosting[];
}

interface SmartRecruitersDetail {
  id: string;
  name: string;
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string } | undefined>;
  };
  applyUrl?: string;
  postingUrl?: string;
}

function formatLocation(location: SmartRecruitersPosting['location']): string | null {
  if (!location) return null;
  const parts = [location.city, location.region, location.country].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

function sectionsToText(detail: SmartRecruitersDetail): string {
  const sections = detail.jobAd?.sections ?? {};
  return Object.values(sections)
    .filter((section): section is { title?: string; text?: string } => Boolean(section))
    .map((section) =>
      [section.title, stripHtml(decodeHtmlEntities(section.text ?? ''))]
        .filter((part) => (part ?? '').trim().length > 0)
        .join('\n'),
    )
    .join('\n\n')
    .trim();
}

/** Public SmartRecruiters postings API — no authentication required. */
export const smartRecruitersCollector: CollectorDefinition = {
  id: 'smartrecruiters',
  name: 'SmartRecruiters',
  source: 'smartrecruiters',
  description:
    'Reads public SmartRecruiters career sites. Configure company identifiers under Settings → Search → Boards.',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.smartrecruiters ?? [];
    if (boards.length === 0) {
      context.logger.warn('smartrecruiters collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings, context.keywords);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const list = await context.http.getJson<SmartRecruitersListResponse>(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
        );

        for (const posting of list.content ?? []) {
          if (results.length >= context.limit) break;

          const companyName = posting.company?.name ?? slug;
          const location = formatLocation(posting.location);
          const postedAt = toIsoDate(posting.releasedDate ?? null);

          let description: string | null = null;
          let applicationUrl = `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${posting.id}`;

          try {
            const detail = await context.http.getJson<SmartRecruitersDetail>(
              `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${posting.id}`,
            );
            description = sectionsToText(detail) || null;
            applicationUrl = detail.applyUrl ?? detail.postingUrl ?? applicationUrl;
          } catch (error) {
            context.logger.debug('smartrecruiters detail fetch failed', {
              postingId: posting.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          if (
            !matchesSearchFilters(
              { title: posting.name, company: companyName, location, description, postedAt },
              filters,
            )
          ) {
            continue;
          }

          const salary = parseSalary(description);
          results.push({
            source: 'smartrecruiters',
            externalId: posting.id,
            title: posting.name,
            company: companyName,
            location,
            remoteType: posting.location?.remote
              ? 'remote'
              : detectRemoteType(location, posting.name, description),
            employmentType: detectEmploymentType(
              posting.typeOfEmployment?.label,
              posting.name,
              description,
            ),
            experienceLevel: detectExperienceLevel(
              posting.experienceLevel?.label,
              posting.name,
              description,
            ),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            salaryPeriod: salary.period,
            description,
            descriptionHtml: null,
            applicationUrl,
            postedAt,
            raw: posting,
          });
        }
      } catch (error) {
        context.logger.error('smartrecruiters board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  },
};
