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

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  lists?: { text?: string; content?: string }[];
  categories?: {
    location?: string;
    team?: string;
    commitment?: string;
    department?: string;
  };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

/** Public Lever postings API — no authentication required. */
export const leverCollector: CollectorDefinition = {
  id: 'lever',
  name: 'Lever',
  source: 'lever',
  description:
    'Reads public Lever job boards. Configure company slugs under Settings → Search → Boards (e.g. "netflix").',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.lever ?? [];
    if (boards.length === 0) {
      context.logger.warn('lever collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings, context.keywords);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const postings = await context.http.getJson<LeverPosting[]>(
          `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
        );

        for (const posting of postings) {
          if (results.length >= context.limit) break;

          const listsText = (posting.lists ?? [])
            .map((list) => `${list.text ?? ''}\n${stripHtml(decodeHtmlEntities(list.content ?? ''))}`)
            .join('\n\n');
          const html = posting.description ? decodeHtmlEntities(posting.description) : null;
          const description = [posting.descriptionPlain ?? (html ? stripHtml(html) : ''), listsText]
            .filter((part) => part.trim().length > 0)
            .join('\n\n');
          const location = posting.categories?.location ?? null;
          const postedAt = toIsoDate(posting.createdAt ?? null);

          if (
            !matchesSearchFilters(
              { title: posting.text, company: slug, location, description, postedAt },
              filters,
            )
          ) {
            continue;
          }

          const parsedSalary = parseSalary(description);
          results.push({
            source: 'lever',
            externalId: posting.id,
            title: posting.text,
            company: slug,
            location,
            remoteType: detectRemoteType(location, posting.text, description),
            employmentType: detectEmploymentType(
              posting.categories?.commitment,
              posting.text,
              description,
            ),
            experienceLevel: detectExperienceLevel(posting.text, description),
            salaryMin: posting.salaryRange?.min ?? parsedSalary.min,
            salaryMax: posting.salaryRange?.max ?? parsedSalary.max,
            salaryCurrency: posting.salaryRange?.currency ?? parsedSalary.currency,
            salaryPeriod: posting.salaryRange?.interval ?? parsedSalary.period,
            description,
            descriptionHtml: html,
            applicationUrl: posting.applyUrl ?? posting.hostedUrl,
            postedAt,
            raw: posting,
          });
        }
      } catch (error) {
        context.logger.error('lever board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  },
};
