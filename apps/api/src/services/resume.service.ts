import type { CreateResumeInput } from '@deedy/shared';
import { ConfigurationError, NotFoundError, toErrorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { truncate } from '../core/utils.js';
import type { JobRepository } from '../repositories/job.repository.js';
import type { CoverLetterRepository, ResumeRepository } from '../repositories/resume.repository.js';
import type { ResumeRow } from '../db/schema.js';
import type { DocumentService } from './document.service.js';
import type { LlmService } from './llm/llm.service.js';
import type { SettingsService } from './settings.service.js';
import { describeProfile } from './job.service.js';

const CONTENT_BUDGET = 12000;

export class ResumeService {
  constructor(
    private readonly resumes: ResumeRepository,
    private readonly jobs: JobRepository,
    private readonly documents: DocumentService,
    private readonly llm: LlmService,
    private readonly logger: Logger,
  ) {}

  /** Creates a base resume and renders its PDF/DOCX immediately. */
  async create(input: CreateResumeInput): Promise<ResumeRow> {
    const resume = this.resumes.create({
      name: input.name,
      targetRole: input.targetRole ?? null,
      markdown: input.markdown,
      isBase: input.isBase,
      isDefault: input.isDefault,
      generatedBy: 'user',
    });
    await this.renderDocuments(resume);
    return this.resumes.byId(resume.id) ?? resume;
  }

  async update(id: number, patch: Partial<CreateResumeInput>): Promise<ResumeRow> {
    const existing = this.resumes.byId(id);
    if (!existing) throw new NotFoundError('Resume', id);

    // Editing the Markdown creates a new version rather than mutating history.
    if (patch.markdown !== undefined && patch.markdown !== existing.markdown) {
      const created = this.resumes.create({
        name: patch.name ?? existing.name,
        targetRole: patch.targetRole ?? existing.targetRole,
        markdown: patch.markdown,
        isBase: existing.isBase,
        isDefault: patch.isDefault ?? existing.isDefault,
        parentId: existing.parentId,
        generatedBy: 'user',
      });
      await this.renderDocuments(created);
      return this.resumes.byId(created.id) ?? created;
    }

    const updated = this.resumes.update(id, {
      name: patch.name ?? existing.name,
      targetRole: patch.targetRole ?? existing.targetRole,
      isDefault: patch.isDefault ?? existing.isDefault,
    });
    if (!updated) throw new NotFoundError('Resume', id);
    return updated;
  }

  async renderDocuments(resume: ResumeRow): Promise<void> {
    try {
      const rendered = await this.documents.render({
        markdown: resume.markdown,
        baseName: `${resume.name}-v${resume.version}`,
        kind: 'resume',
        title: `${resume.name} — ${resume.targetRole ?? 'Resume'}`,
      });
      this.resumes.setDocuments(resume.id, {
        filePath: rendered.markdownPath,
        ...(rendered.pdfPath ? { pdfPath: rendered.pdfPath } : {}),
        ...(rendered.docxPath ? { docxPath: rendered.docxPath } : {}),
      });
    } catch (error) {
      this.logger.error('failed to render resume documents', {
        resumeId: resume.id,
        error: toErrorMessage(error),
      });
    }
  }

  /**
   * Produces a job-specific resume from a base resume. Re-tailoring the same
   * job returns the existing version unless `force` is set, so a retried
   * application does not burn inference on work already done.
   */
  async tailorForJob(input: {
    jobId: number;
    baseResumeId?: number | null;
    force?: boolean;
  }): Promise<ResumeRow> {
    const job = this.jobs.byId(input.jobId);
    if (!job) throw new NotFoundError('Job', input.jobId);

    const base =
      (input.baseResumeId ? this.resumes.byId(input.baseResumeId) : undefined) ??
      this.resumes.defaultResume();
    if (!base) {
      throw new ConfigurationError(
        'No base resume exists. Add one under Resume Manager before tailoring.',
      );
    }

    if (!input.force) {
      const existing = this.resumes.tailoredFor(input.jobId, base.id);
      if (existing) return existing;
    }

    const description = truncate(job.description ?? job.summary ?? '', CONTENT_BUDGET);

    let keywords: string[] = [];
    let atsScore: number | null = null;
    try {
      const ats = await this.llm.run('ats_keywords', {
        variables: { description, resume: truncate(base.markdown, CONTENT_BUDGET) },
        jobId: job.id,
      });
      keywords = [...ats.data.keywords, ...ats.data.missingFromResume];
      atsScore = ats.data.estimatedAtsScore;
    } catch (error) {
      this.logger.warn('ats keyword pass failed; tailoring without it', {
        jobId: job.id,
        error: toErrorMessage(error),
      });
    }

    const tailored = await this.llm.run('resume_tailoring', {
      variables: {
        title: job.title,
        company: job.company,
        description,
        keywords: keywords.join(', '),
        resume: truncate(base.markdown, CONTENT_BUDGET),
      },
      jobId: job.id,
    });

    const created = this.resumes.create({
      name: `${base.name} — ${job.company} ${job.title}`.slice(0, 180),
      targetRole: job.title,
      markdown: tailored.data.markdown,
      isBase: false,
      parentId: base.id,
      jobId: job.id,
      generatedBy: tailored.model,
      changeSummary: tailored.data.changeSummary,
      atsScore,
    });

    await this.renderDocuments(created);
    this.logger.info('tailored resume generated', {
      jobId: job.id,
      resumeId: created.id,
      baseResumeId: base.id,
    });

    return this.resumes.byId(created.id) ?? created;
  }
}

export class CoverLetterService {
  constructor(
    private readonly coverLetters: CoverLetterRepository,
    private readonly resumes: ResumeRepository,
    private readonly jobs: JobRepository,
    private readonly documents: DocumentService,
    private readonly llm: LlmService,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
  ) {}

  /** Generates a new cover letter version for a job and renders it to PDF. */
  async generate(input: {
    jobId: number;
    resumeId?: number | null;
    applicationId?: number | null;
    reuseExisting?: boolean;
  }) {
    const job = this.jobs.byId(input.jobId);
    if (!job) throw new NotFoundError('Job', input.jobId);

    if (input.reuseExisting) {
      const existing = this.coverLetters.latestForJob(input.jobId);
      if (existing) return existing;
    }

    const resume =
      (input.resumeId ? this.resumes.byId(input.resumeId) : undefined) ??
      this.resumes.defaultResume();
    const settings = this.settingsService.get();

    const generated = await this.llm.run('cover_letter', {
      variables: {
        title: job.title,
        company: job.company,
        location: job.location ?? 'Unspecified',
        description: truncate(job.description ?? job.summary ?? '', CONTENT_BUDGET),
        profile: describeProfile(settings.profile),
        resume: resume ? truncate(resume.markdown, CONTENT_BUDGET) : '(no resume available)',
      },
      jobId: job.id,
      applicationId: input.applicationId ?? null,
    });

    const row = this.coverLetters.create({
      jobId: job.id,
      applicationId: input.applicationId ?? null,
      resumeId: resume?.id ?? null,
      subject: generated.data.subject,
      body: generated.data.body,
      tone: generated.data.tone,
      model: generated.model,
    });

    try {
      const rendered = await this.documents.render({
        markdown: `# ${generated.data.subject}\n\n${generated.data.body}`,
        baseName: `cover-letter-${job.company}-${job.title}`,
        kind: 'cover-letter',
        title: generated.data.subject,
      });
      if (rendered.pdfPath) this.coverLetters.setPdfPath(row.id, rendered.pdfPath);
    } catch (error) {
      this.logger.error('cover letter rendering failed', {
        coverLetterId: row.id,
        error: toErrorMessage(error),
      });
    }

    this.logger.info('cover letter generated', { jobId: job.id, coverLetterId: row.id });
    return this.coverLetters.byId(row.id) ?? row;
  }
}
