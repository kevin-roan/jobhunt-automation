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

interface RecruiteeOffer {
  id?: number | string;
  slug?: string;
  title?: string;
  careers_url?: string;
  careers_apply_url?: string;
  location?: string;
  city?: string;
  country?: string;
  department?: string;
  company_name?: string;
  employment_type_code?: string;
  experience_code?: string;
  remote?: boolean;
  created_at?: string;
  published_at?: string;
  description?: string;
  requirements?: string;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

/** Recruitee codes are snake_case; the detectors match on spaced words. */
function humanizeCode(code: string | undefined): string | null {
  if (!code) return null;
  return code.replace(/_/g, ' ');
}

function locationOf(offer: RecruiteeOffer): string | null {
  const direct = offer.location?.trim();
  if (direct) return direct;
  const parts = [offer.city?.trim(), offer.country?.trim()].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Public Recruitee careers API — no authentication required. */
export const recruiteeCollector: CollectorDefinition = {
  id: 'recruitee',
  name: 'Recruitee',
  source: 'recruitee',
  description:
    'Reads public Recruitee career sites. Configure company slugs under Settings → Search → Boards (e.g. "acme").',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.recruitee ?? [];
    if (boards.length === 0) {
      context.logger.warn('recruitee collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const payload = await context.http.getJson<RecruiteeResponse>(
          `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
        );

        for (const offer of payload.offers ?? []) {
          if (results.length >= context.limit) break;

          const title = offer.title?.trim();
          const applicationUrl =
            offer.careers_apply_url ??
            offer.careers_url ??
            (offer.slug ? `https://${slug}.recruitee.com/o/${offer.slug}` : undefined);
          if (!title || !applicationUrl) continue;

          const sections = [offer.description, offer.requirements]
            .filter((part): part is string => Boolean(part && part.trim()))
            .map((part) => decodeHtmlEntities(part));
          const html = sections.length > 0 ? sections.join('\n') : null;
          const description = html ? stripHtml(html) : null;
          const company = offer.company_name?.trim() || slug;
          const location = locationOf(offer);
          const postedAt = toIsoDate(offer.published_at ?? offer.created_at ?? null);

          if (!matchesSearchFilters({ title, company, location, description, postedAt }, filters)) {
            continue;
          }

          const salary = parseSalary(description);
          results.push({
            source: 'recruitee',
            externalId: offer.id !== undefined ? String(offer.id) : (offer.slug ?? null),
            title,
            company,
            location,
            remoteType: detectRemoteType(offer.remote ? 'remote' : null, location, title, description),
            employmentType: detectEmploymentType(
              humanizeCode(offer.employment_type_code),
              title,
              description,
            ),
            experienceLevel: detectExperienceLevel(
              humanizeCode(offer.experience_code),
              title,
              description,
            ),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            salaryPeriod: salary.period,
            description,
            descriptionHtml: html,
            applicationUrl,
            postedAt,
            raw: offer,
          });
        }
      } catch (error) {
        context.logger.error('recruitee board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  },
};
