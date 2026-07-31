import type { ProfileSettings } from '@deedy/shared';
import { NotFoundError, toErrorMessage } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { truncate } from '../core/utils.js';
import type { BrowserManager } from '../browser/browser.manager.js';
import { createHttpClient, type CollectorContext } from '../collectors/types.js';
import type { CollectorRegistry } from '../collectors/registry.js';
import type { CollectorRunRepository } from '../repositories/browser.repository.js';
import type { JobRepository } from '../repositories/job.repository.js';
import type { ResumeRepository } from '../repositories/resume.repository.js';
import type { SettingsService } from './settings.service.js';
import type { LlmService } from './llm/llm.service.js';

export interface CollectionSummary {
  collectorId: string;
  found: number;
  inserted: number;
  duplicates: number;
  errors: number;
  message: string | null;
}

/** Maximum characters of a job description handed to the model in one prompt. */
const DESCRIPTION_BUDGET = 12000;

export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly resumes: ResumeRepository,
    private readonly collectorRuns: CollectorRunRepository,
    private readonly registry: CollectorRegistry,
    private readonly browser: BrowserManager,
    private readonly settingsService: SettingsService,
    private readonly llm: LlmService,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  /** Runs one collector and persists every job it returns, skipping duplicates. */
  async runCollector(collectorId: string, signal?: AbortSignal): Promise<CollectionSummary> {
    const collector = this.registry.get(collectorId);
    if (!collector) throw new NotFoundError('Collector', collectorId);

    const settings = this.settingsService.get();
    const runId = this.collectorRuns.start(collectorId);
    const logger = this.logger.child('collector', { collectorId });

    const context: CollectorContext = {
      settings,
      logger,
      http: createHttpClient(),
      browser: this.browser,
      limit: settings.search.maxJobsPerCollectorRun,
      signal,
    };

    let found = 0;
    let inserted = 0;
    let duplicates = 0;
    let errors = 0;
    let message: string | null = null;

    try {
      const collected = await collector.collect(context);
      found = collected.length;

      for (const job of collected) {
        try {
          const result = this.jobs.upsert(job);
          if (result.outcome === 'inserted') {
            inserted += 1;
            this.events.emit('job.collected', {
              jobId: result.jobId,
              source: job.source,
              title: job.title,
              company: job.company,
            });
          } else {
            duplicates += 1;
          }
        } catch (error) {
          errors += 1;
          logger.error('failed to persist collected job', {
            title: job.title,
            company: job.company,
            error: toErrorMessage(error),
          });
        }
      }

      this.collectorRuns.finish(runId, {
        status: 'completed',
        found,
        inserted,
        duplicates,
        errors,
      });
      logger.info('collector run finished', { found, inserted, duplicates, errors });
      this.events.emit('collector.run', { collectorId, found, inserted, duplicates });
    } catch (error) {
      message = toErrorMessage(error);
      errors += 1;
      this.collectorRuns.finish(runId, {
        status: 'failed',
        found,
        inserted,
        duplicates,
        errors,
        message,
      });
      logger.error('collector run failed', { error: message });
      throw error;
    }

    return { collectorId, found, inserted, duplicates, errors, message };
  }

  /** The collectors that will run given the current settings. */
  plannedCollectors(): string[] {
    const settings = this.settingsService.get();
    return this.registry
      .enabled(settings.search.enabledCollectors, settings.search.boards)
      .map((collector) => collector.id);
  }

  /**
   * Enriches a job with LLM-derived structure: skills, classification, salary
   * and a summary. Each sub-task is independent, so one failure does not lose
   * the others.
   */
  async enrich(jobId: number): Promise<void> {
    const job = this.jobs.byId(jobId);
    if (!job) throw new NotFoundError('Job', jobId);

    const description = truncate(job.description ?? '', DESCRIPTION_BUDGET);
    const variables = {
      title: job.title,
      company: job.company,
      location: job.location ?? 'Unspecified',
      description: description || '(no description was published)',
    };
    const logger = this.logger.child('enrich', { jobId });

    try {
      const skills = await this.llm.run('skill_extraction', { variables, jobId, useFastModel: true });
      const all = [
        ...skills.data.hardSkills,
        ...skills.data.tools,
        ...skills.data.certifications,
        ...skills.data.softSkills,
      ];
      if (all.length > 0) this.jobs.replaceSkills(jobId, all);
    } catch (error) {
      logger.warn('skill extraction failed', { error: toErrorMessage(error) });
    }

    try {
      const classification = await this.llm.run('job_classification', {
        variables,
        jobId,
        useFastModel: true,
      });
      this.jobs.updateEnrichment(jobId, {
        remoteType: classification.data.remoteType,
        employmentType: classification.data.employmentType,
        experienceLevel: classification.data.seniority,
      });
    } catch (error) {
      logger.warn('job classification failed', { error: toErrorMessage(error) });
    }

    if (job.salaryMin === null && job.salaryMax === null && description) {
      try {
        const salary = await this.llm.run('salary_extraction', {
          variables,
          jobId,
          useFastModel: true,
        });
        if (salary.data.min !== null || salary.data.max !== null) {
          this.jobs.updateEnrichment(jobId, {
            salaryMin: salary.data.min,
            salaryMax: salary.data.max,
            salaryCurrency: salary.data.currency,
            salaryPeriod: salary.data.period,
          });
        }
      } catch (error) {
        logger.warn('salary extraction failed', { error: toErrorMessage(error) });
      }
    }

    if (description) {
      try {
        const summary = await this.llm.run('job_summary', { variables, jobId });
        this.jobs.updateEnrichment(jobId, {
          summary: [
            summary.data.headline,
            '',
            summary.data.summary,
            '',
            ...(summary.data.requirements.length
              ? ['Requirements:', ...summary.data.requirements.map((r) => `- ${r}`)]
              : []),
          ].join('\n'),
        });
      } catch (error) {
        logger.warn('job summary failed', { error: toErrorMessage(error) });
      }
    }
  }

  /** Scores a job against a resume and persists the full explanation. */
  async score(jobId: number, resumeIdOverride?: number | null): Promise<{ score: number; recommendation: string }> {
    const job = this.jobs.byId(jobId);
    if (!job) throw new NotFoundError('Job', jobId);

    const settings = this.settingsService.get();
    const resume =
      (resumeIdOverride ? this.resumes.byId(resumeIdOverride) : undefined) ??
      (settings.application.defaultResumeId
        ? this.resumes.byId(settings.application.defaultResumeId)
        : undefined) ??
      this.resumes.defaultResume();

    const variables = {
      title: job.title,
      company: job.company,
      location: job.location ?? 'Unspecified',
      experienceLevel: job.experienceLevel,
      salary: formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod),
      description: truncate(job.description ?? job.summary ?? '', DESCRIPTION_BUDGET) || '(no description)',
      profile: describeProfile(settings.profile),
      resume: resume ? truncate(resume.markdown, DESCRIPTION_BUDGET) : '(no resume uploaded yet)',
    };

    const scoring = await this.llm.run('application_scoring', { variables, jobId });

    let interviewProbability: number | null = null;
    if (resume) {
      try {
        const prediction = await this.llm.run('interview_prediction', {
          variables,
          jobId,
          useFastModel: true,
        });
        interviewProbability = prediction.data.interviewProbability;
      } catch (error) {
        this.logger.debug('interview prediction failed', { jobId, error: toErrorMessage(error) });
      }
    }

    this.jobs.recordScore({
      jobId,
      resumeId: resume?.id ?? null,
      score: scoring.data.score,
      confidence: scoring.data.confidence,
      recommendation: scoring.data.recommendation,
      matchedSkills: scoring.data.matchedSkills,
      missingSkills: scoring.data.missingSkills,
      redFlags: scoring.data.redFlags,
      reasoning: scoring.data.reasoning,
      interviewProbability,
      model: scoring.model,
    });

    this.events.emit('job.scored', {
      jobId,
      score: scoring.data.score,
      recommendation: scoring.data.recommendation,
    });
    this.logger.info('job scored', {
      jobId,
      score: scoring.data.score,
      recommendation: scoring.data.recommendation,
    });

    return { score: scoring.data.score, recommendation: scoring.data.recommendation };
  }

  /** Builds a company profile from the postings already collected for it. */
  async summarizeCompany(companyId: number): Promise<void> {
    const company = this.jobs.companyById(companyId);
    if (!company) throw new NotFoundError('Company', companyId);

    const evidence = this.jobs
      .search({
        page: 1,
        pageSize: 5,
        company: company.name,
        sort: 'collectedAt',
        order: 'desc',
      })
      .items.map((job) => `# ${job.title}\n${truncate(job.description ?? '', 3000)}`)
      .join('\n\n---\n\n');

    if (!evidence.trim()) return;

    const summary = await this.llm.run('company_summary', {
      variables: { company: company.name, evidence: truncate(evidence, DESCRIPTION_BUDGET) },
    });

    this.jobs.updateCompanySummary(companyId, {
      industry: summary.data.industry,
      sizeEstimate: summary.data.sizeEstimate,
      summary: summary.data.summary,
      culturePoints: summary.data.culturePoints,
    });
  }
}

export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: string | null,
): string {
  if (min === null && max === null) return 'Not disclosed';
  const unit = currency ?? '';
  const range =
    min !== null && max !== null
      ? `${min.toLocaleString()} – ${max.toLocaleString()}`
      : (min ?? max ?? 0).toLocaleString();
  return `${unit} ${range}${period ? ` per ${period}` : ''}`.trim();
}

/** Renders the profile settings as the plain-text block prompts expect. */
export function describeProfile(profile: ProfileSettings): string {
  const lines: string[] = [];
  const push = (label: string, value: string | number | boolean | null): void => {
    if (value === null || value === '' || value === undefined) return;
    lines.push(`${label}: ${String(value)}`);
  };

  push('Name', profile.fullName || `${profile.firstName} ${profile.lastName}`.trim());
  push('Email', profile.email);
  push('Phone', profile.phone);
  push(
    'Location',
    [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
  );
  push('LinkedIn', profile.linkedinUrl);
  push('GitHub', profile.githubUrl);
  push('Portfolio', profile.portfolioUrl);
  push('Years of experience', profile.yearsOfExperience);
  push('Authorized to work', profile.authorizedToWork ? 'Yes' : 'No');
  push('Requires visa sponsorship', profile.requiresSponsorship ? 'Yes' : 'No');
  push('Willing to relocate', profile.willingToRelocate ? 'Yes' : 'No');
  push('Notice period (days)', profile.noticePeriodDays);
  push('Desired salary', profile.desiredSalary);
  if (profile.summary.trim()) lines.push(`Summary: ${profile.summary.trim()}`);

  return lines.length > 0 ? lines.join('\n') : '(no candidate profile configured)';
}
