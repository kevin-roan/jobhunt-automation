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

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
  offices?: { name?: string }[];
  departments?: { name?: string }[];
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

async function resolveCompanyName(context: CollectorContext, slug: string): Promise<string> {
  try {
    const board = await context.http.getJson<{ name?: string }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
    );
    return board.name?.trim() || slug;
  } catch {
    return slug;
  }
}

/** Public Greenhouse job board API — no authentication required. */
export const greenhouseCollector: CollectorDefinition = {
  id: 'greenhouse',
  name: 'Greenhouse',
  source: 'greenhouse',
  description:
    'Reads public Greenhouse job boards. Configure company board tokens under Settings → Search → Boards (e.g. "stripe").',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.greenhouse ?? [];
    if (boards.length === 0) {
      context.logger.warn('greenhouse collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const companyName = await resolveCompanyName(context, slug);
        const payload = await context.http.getJson<GreenhouseResponse>(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
        );

        for (const job of payload.jobs ?? []) {
          if (results.length >= context.limit) break;
          const html = job.content ? decodeHtmlEntities(job.content) : null;
          const description = html ? stripHtml(html) : null;
          const location = job.location?.name ?? job.offices?.[0]?.name ?? null;
          const postedAt = toIsoDate(job.updated_at ?? null);

          if (
            !matchesSearchFilters(
              { title: job.title, company: companyName, location, description, postedAt },
              filters,
            )
          ) {
            continue;
          }

          const salary = parseSalary(description);
          results.push({
            source: 'greenhouse',
            externalId: String(job.id),
            title: job.title,
            company: companyName,
            location,
            remoteType: detectRemoteType(location, job.title, description),
            employmentType: detectEmploymentType(job.title, description),
            experienceLevel: detectExperienceLevel(job.title, description),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            salaryPeriod: salary.period,
            description,
            descriptionHtml: html,
            applicationUrl: job.absolute_url,
            postedAt,
            raw: job,
          });
        }
      } catch (error) {
        context.logger.error('greenhouse board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  },
};
