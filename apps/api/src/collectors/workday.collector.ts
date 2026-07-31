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

interface WorkdayJobPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WorkdaySearchResponse {
  total?: number;
  jobPostings?: WorkdayJobPosting[];
}

interface WorkdayJobDetail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    startDate?: string;
    postedOn?: string;
    timeType?: string;
    jobReqId?: string;
    externalUrl?: string;
    remoteType?: string;
  };
  hiringOrganization?: { name?: string };
}

export interface WorkdaySite {
  host: string;
  tenant: string;
  site: string;
  companyName: string;
}

/**
 * Accepts either a full careers URL
 * (`https://acme.wd1.myworkdayjobs.com/en-US/External`) or the compact
 * `host|tenant|site` form, and derives the CXS API endpoint from it.
 */
export function parseWorkdayBoard(entry: string): WorkdaySite | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  if (trimmed.includes('|')) {
    const [host, tenant, site] = trimmed.split('|').map((part) => part.trim());
    if (!host || !tenant || !site) return null;
    return { host, tenant, site, companyName: tenant };
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const tenant = url.hostname.split('.')[0];
    if (!tenant) return null;
    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    // Path is either /<site> or /<locale>/<site>.
    const site = segments.length >= 2 ? segments[1] : segments[0];
    if (!site) return null;
    return { host: url.hostname, tenant, site, companyName: tenant };
  } catch {
    return null;
  }
}

/**
 * Workday's CXS endpoint powers the public careers search UI. It is a plain
 * JSON POST, so no browser is required for collection (applying still uses one).
 */
export const workdayCollector: CollectorDefinition = {
  id: 'workday',
  name: 'Workday',
  source: 'workday',
  description:
    'Reads public Workday career sites via the CXS search API. Configure entries as a careers URL, e.g. "https://acme.wd1.myworkdayjobs.com/en-US/External".',
  requiresAuth: false,
  requiresBoards: true,
  builtIn: true,

  async collect(context: CollectorContext): Promise<NormalizedJob[]> {
    const boards = context.settings.search.boards.workday ?? [];
    if (boards.length === 0) {
      context.logger.warn('workday collector has no boards configured');
      return [];
    }

    const filters = searchFilters(context.settings);
    const searchTerms = context.settings.search.keywords.length
      ? context.settings.search.keywords
      : [''];
    const results: NormalizedJob[] = [];

    for (const board of boards) {
      if (results.length >= context.limit) break;
      const site = parseWorkdayBoard(board);
      if (!site) {
        context.logger.warn('unparseable workday board entry', { board });
        continue;
      }

      const base = `https://${site.host}/wday/cxs/${site.tenant}/${site.site}`;

      for (const term of searchTerms) {
        if (results.length >= context.limit) break;
        let offset = 0;

        for (let page = 0; page < 5; page += 1) {
          if (results.length >= context.limit) break;

          let payload: WorkdaySearchResponse;
          try {
            payload = await context.http.postJson<WorkdaySearchResponse>(`${base}/jobs`, {
              appliedFacets: {},
              limit: 20,
              offset,
              searchText: term,
            });
          } catch (error) {
            context.logger.error('workday search failed', {
              board,
              term,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }

          const postings = payload.jobPostings ?? [];
          if (postings.length === 0) break;

          for (const posting of postings) {
            if (results.length >= context.limit) break;
            if (!posting.externalPath || !posting.title) continue;

            const applicationUrl = `https://${site.host}/en-US/${site.site}${posting.externalPath}`;
            let description: string | null = null;
            let companyName = site.companyName;
            let location = posting.locationsText ?? null;
            let postedAt = toIsoDate(posting.postedOn ?? null);
            let remoteHint: string | null = null;

            try {
              const detail = await context.http.getJson<WorkdayJobDetail>(
                `${base}${posting.externalPath}`,
              );
              const info = detail.jobPostingInfo;
              if (info?.jobDescription) {
                description = stripHtml(decodeHtmlEntities(info.jobDescription));
              }
              companyName = detail.hiringOrganization?.name ?? companyName;
              location = info?.location ?? location;
              postedAt = toIsoDate(info?.startDate ?? null) ?? postedAt;
              remoteHint = info?.remoteType ?? null;
            } catch (error) {
              context.logger.debug('workday detail fetch failed', {
                path: posting.externalPath,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            if (
              !matchesSearchFilters(
                { title: posting.title, company: companyName, location, description, postedAt },
                filters,
              )
            ) {
              continue;
            }

            const salary = parseSalary(description);
            results.push({
              source: 'workday',
              externalId: posting.externalPath,
              title: posting.title,
              company: companyName,
              location,
              remoteType: detectRemoteType(remoteHint, location, posting.title, description),
              employmentType: detectEmploymentType(posting.title, description),
              experienceLevel: detectExperienceLevel(posting.title, description),
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

          offset += postings.length;
          if (payload.total !== undefined && offset >= payload.total) break;
        }
      }
    }

    return results;
  },
};
