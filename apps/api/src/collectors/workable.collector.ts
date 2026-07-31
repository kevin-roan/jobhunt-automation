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
import { HttpError, type CollectorContext, type CollectorDefinition } from './types.js';

interface WorkableJob {
  id?: number | string;
  shortcode?: string;
  title?: string;
  full_title?: string;
  city?: string;
  state?: string;
  region?: string;
  country?: string;
  location?: { city?: string; region?: string; state?: string; country?: string };
  department?: string;
  employment_type?: string;
  experience?: string;
  telecommuting?: boolean;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  description?: string;
  requirements?: string;
  benefits?: string;
}

interface WorkableAccountResponse {
  name?: string;
  /** Widget endpoint returns `jobs`; the SPI endpoint returns `results`. */
  jobs?: WorkableJob[];
  results?: WorkableJob[];
}

interface WorkableBoard {
  companyName: string;
  jobs: WorkableJob[];
}

/**
 * The widget endpoint carries the account name and the full description in one
 * call, so it is preferred; some accounts only expose the SPI board.
 */
async function fetchBoard(context: CollectorContext, slug: string): Promise<WorkableBoard> {
  const encoded = encodeURIComponent(slug);
  try {
    const widget = await context.http.getJson<WorkableAccountResponse>(
      `https://apply.workable.com/api/v1/widget/accounts/${encoded}?details=true`,
    );
    const jobs = widget.jobs ?? widget.results ?? [];
    if (jobs.length > 0 || widget.name) {
      return { companyName: widget.name?.trim() || slug, jobs };
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    context.logger.warn('workable widget endpoint missing, falling back to spi', { board: slug });
  }

  const spi = await context.http.getJson<WorkableAccountResponse>(
    `https://${encoded}.workable.com/spi/v3/jobs`,
  );
  return { companyName: spi.name?.trim() || slug, jobs: spi.results ?? spi.jobs ?? [] };
}

function locationOf(job: WorkableJob): string | null {
  const parts = [
    job.city ?? job.location?.city,
    job.state ?? job.region ?? job.location?.state ?? job.location?.region,
    job.country ?? job.location?.country,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length > 0 ? unique.join(', ') : null;
}

function descriptionHtmlOf(job: WorkableJob): string | null {
  const sections = [job.description, job.requirements, job.benefits]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => decodeHtmlEntities(part));
  return sections.length > 0 ? sections.join('\n') : null;
}

/** Public Workable job board API — no authentication required. */
export const workableCollector: CollectorDefinition = {
  id: 'workable',
  name: 'Workable',
  source: 'workable',
  description:
    'Reads public Workable job boards. Configure company slugs under Settings → Search → Boards (e.g. "acme-inc").',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.workable ?? [];
    if (boards.length === 0) {
      context.logger.warn('workable collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const slug = board.trim();
      if (!slug) continue;

      try {
        const { companyName, jobs } = await fetchBoard(context, slug);

        for (const job of jobs) {
          if (results.length >= context.limit) break;

          const title = job.title?.trim() || job.full_title?.trim();
          const applicationUrl = job.application_url ?? job.url ?? job.shortlink;
          if (!title || !applicationUrl) continue;

          const html = descriptionHtmlOf(job);
          const description = html ? stripHtml(html) : null;
          const location = locationOf(job);
          const postedAt = toIsoDate(job.published_on ?? job.created_at ?? null);

          if (
            !matchesSearchFilters({ title, company: companyName, location, description, postedAt }, filters)
          ) {
            continue;
          }

          const salary = parseSalary(description);
          results.push({
            source: 'workable',
            externalId: job.shortcode ?? (job.id !== undefined ? String(job.id) : null),
            title,
            company: companyName,
            location,
            remoteType: detectRemoteType(
              job.telecommuting ? 'remote' : null,
              location,
              title,
              description,
            ),
            employmentType: detectEmploymentType(job.employment_type, title, description),
            experienceLevel: detectExperienceLevel(job.experience, title, description),
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            salaryPeriod: salary.period,
            description,
            descriptionHtml: html,
            applicationUrl,
            postedAt,
            raw: job,
          });
        }
      } catch (error) {
        context.logger.error('workable board failed', {
          board: slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  },
};
