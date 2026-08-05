import { writeFile } from 'node:fs/promises';
import {
  DEFAULT_RESUME_THEME,
  resumeThemeSchema,
  type AssistResumeInput,
  type AssistResumeResult,
  type CreateResumeInput,
  type ResumeTheme,
  type UpdateResumeInput,
} from '@deedy/shared';
import { ConfigurationError, NotFoundError, toErrorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { truncate } from '../core/utils.js';
import type { JobRepository } from '../repositories/job.repository.js';
import { toResumeTheme } from '../repositories/resume.repository.js';
import type { CoverLetterRepository, ResumeRepository } from '../repositories/resume.repository.js';
import type { ResumeRow } from '../db/schema.js';
import type { DocumentService } from './document.service.js';
import type { LatexService } from './latex/latex.service.js';
import { findUnsafeConstruct, latexToPlainText } from './latex/latex.utils.js';
import type { LlmService } from './llm/llm.service.js';
import { LlmAbortError } from './llm/providers.js';
import type { SettingsService } from './settings.service.js';
import { describeProfile } from './job.service.js';

const CONTENT_BUDGET = 12000;

export class ResumeService {
  constructor(
    private readonly resumes: ResumeRepository,
    private readonly jobs: JobRepository,
    private readonly documents: DocumentService,
    private readonly latex: LatexService,
    private readonly llm: LlmService,
    private readonly logger: Logger,
  ) {}

  /** Creates a base resume and compiles its PDF/DOCX immediately. */
  async create(input: CreateResumeInput): Promise<ResumeRow> {
    const theme = normaliseTheme(input.theme);
    const resume = this.resumes.create({
      name: input.name,
      targetRole: input.targetRole ?? null,
      latex: input.latex,
      theme,
      // The plain-text mirror is always derived, never authored: it is what the
      // DOCX and every downstream prompt read.
      markdown: latexToPlainText(input.latex),
      isBase: input.isBase,
      isDefault: input.isDefault,
      generatedBy: 'user',
    });
    await this.renderDocuments(resume);
    return this.resumes.byId(resume.id) ?? resume;
  }

  async update(id: number, patch: UpdateResumeInput): Promise<ResumeRow> {
    const existing = this.resumes.byId(id);
    if (!existing) throw new NotFoundError('Resume', id);

    const currentTheme = toResumeTheme(existing.theme);
    const nextTheme = patch.theme ? normaliseTheme(patch.theme) : currentTheme;
    const latexChanged = patch.latex !== undefined && patch.latex !== existing.latex;
    const themeChanged = patch.theme !== undefined && !sameTheme(currentTheme, nextTheme);

    // Editing the document or its theme creates a new version rather than
    // mutating history; both change what the rendered PDF looks like.
    if (latexChanged || themeChanged) {
      const latex = patch.latex ?? existing.latex;
      const created = this.resumes.create({
        name: patch.name ?? existing.name,
        targetRole: patch.targetRole ?? existing.targetRole,
        latex,
        theme: nextTheme,
        templateId: existing.templateId,
        markdown: latexToPlainText(latex),
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

  /**
   * Compiles the LaTeX to PDF, keeps the .tex next to it, and derives a DOCX
   * from the plain-text mirror for portals that reject PDFs.
   *
   * A failed compile is recorded, not thrown: the row still holds usable LaTeX
   * and the editor needs the engine log to tell the user what to fix.
   */
  async renderDocuments(resume: ResumeRow): Promise<void> {
    const theme = toResumeTheme(resume.theme);
    const baseName = `${resume.name}-v${resume.version}`;
    const title = `${resume.name} — ${resume.targetRole ?? 'Resume'}`;
    const text = latexToPlainText(resume.latex);

    let pdfPath: string | null = null;
    let texPath: string | null = null;
    let compileOk = false;
    let compileLog = '';

    try {
      const compiled = await this.latex.compile({ latex: resume.latex, theme, baseName });
      compileOk = compiled.ok;
      compileLog = compiled.log;
      pdfPath = compiled.pdfPath;

      if (pdfPath) {
        // The .tex lives beside the PDF so a user who downloads one can hand
        // the other to any LaTeX editor and reproduce it exactly. A failed
        // compile writes none: the row still holds the source verbatim.
        const candidate = pdfPath.replace(/\.pdf$/i, '.tex');
        await writeFile(candidate, resume.latex, 'utf8');
        texPath = candidate;
      }
    } catch (error) {
      compileLog = toErrorMessage(error);
      this.logger.error('resume latex compile failed', {
        resumeId: resume.id,
        error: compileLog,
      });
    }

    const docxPath = await this.documents.renderPlainTextDocx(text, title, baseName, 'resume');

    this.resumes.setCompileResult(resume.id, {
      compileOk,
      compileLog,
      texPath,
      pdfPath,
      docxPath,
      // `filePath` is the human-editable source; for a LaTeX resume that is the
      // .tex, which is what the `md` download slot now serves.
      filePath: texPath,
      markdown: text,
    });
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
    signal?: AbortSignal;
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
        variables: { description, resume: truncate(base.latex, CONTENT_BUDGET) },
        jobId: job.id,
        signal: input.signal,
      });
      keywords = [...ats.data.keywords, ...ats.data.missingFromResume];
      atsScore = ats.data.estimatedAtsScore;
    } catch (error) {
      // A cancellation is not a degraded keyword pass to shrug off; continuing
      // would run the far more expensive tailoring generation right after Stop.
      if (error instanceof LlmAbortError) throw error;
      this.logger.warn('ats keyword pass failed; tailoring without it', {
        jobId: job.id,
        error: toErrorMessage(error),
      });
    }

    // Second of two generations: re-checked so a stop during the first one does
    // not immediately buy the second.
    if (input.signal?.aborted) {
      throw new LlmAbortError('Resume tailoring was cancelled before the tailoring pass');
    }

    const tailored = await this.llm.run('resume_tailoring', {
      variables: {
        title: job.title,
        company: job.company,
        description,
        keywords: keywords.join(', '),
        macros: this.latex.macros(),
        resume: truncate(base.latex, CONTENT_BUDGET),
      },
      jobId: job.id,
      signal: input.signal,
    });

    // A model that emits \input or \write18 would run arbitrary work on the
    // host at compile time, so an unsafe document is discarded outright.
    const unsafe = findUnsafeConstruct(tailored.data.latex);
    if (unsafe) {
      this.logger.warn('tailored resume rejected; falling back to the base document', {
        jobId: job.id,
        baseResumeId: base.id,
        construct: unsafe,
      });
    }
    const latex = unsafe ? base.latex : tailored.data.latex;

    const created = this.resumes.create({
      name: `${base.name} — ${job.company} ${job.title}`.slice(0, 180),
      targetRole: job.title,
      latex,
      theme: toResumeTheme(base.theme),
      templateId: base.templateId,
      markdown: latexToPlainText(latex),
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

  /** Free-text editing driven by the resume editor. Compiles the result so the caller can show a real preview. */
  async assist(
    id: number,
    input: AssistResumeInput,
    signal?: AbortSignal,
  ): Promise<AssistResumeResult> {
    const existing = this.resumes.byId(id);
    if (!existing) throw new NotFoundError('Resume', id);

    // The editor sends its unsaved buffer; the stored row is only the fallback.
    const latex = input.latex || existing.latex;
    const currentTheme = input.theme ? normaliseTheme(input.theme) : toResumeTheme(existing.theme);

    const edited = await this.llm.run('resume_latex_edit', {
      variables: {
        instruction: input.instruction,
        latex: truncate(latex, CONTENT_BUDGET),
        theme: describeTheme(currentTheme),
        macros: this.latex.macros(),
        job: this.describeTargetJob(input.jobId ?? null),
      },
      jobId: input.jobId ?? null,
      signal,
    });

    const unsafe = findUnsafeConstruct(edited.data.latex);
    if (unsafe) {
      this.logger.warn('assisted resume edit rejected; keeping the current document', {
        resumeId: id,
        construct: unsafe,
      });
    }
    const nextLatex = unsafe ? latex : edited.data.latex;
    const nextTheme = mergeThemePatch(currentTheme, edited.data.theme);

    const compiled = await this.latex.compile({ latex: nextLatex, theme: nextTheme });

    return {
      latex: nextLatex,
      theme: nextTheme,
      summary: edited.data.summary,
      model: edited.model,
      compileOk: compiled.ok,
      compileLog: compiled.log || null,
    };
  }

  /** The posting the instruction may refer to, or a placeholder when there is none. */
  private describeTargetJob(jobId: number | null): string {
    if (!jobId) return '(no target job)';
    const job = this.jobs.byId(jobId);
    if (!job) return '(no target job)';
    return [
      `Title: ${job.title}`,
      `Company: ${job.company}`,
      '',
      truncate(job.description ?? job.summary ?? '', CONTENT_BUDGET),
    ].join('\n');
  }
}

function normaliseTheme(theme?: ResumeTheme | Record<string, unknown>): ResumeTheme {
  const parsed = resumeThemeSchema.safeParse(theme ?? {});
  return parsed.success ? parsed.data : DEFAULT_RESUME_THEME;
}

/**
 * Applies the model's partial theme patch key by key. A key the model invented
 * or put out of range is dropped rather than failing the whole edit — the
 * document is the valuable part of the answer.
 */
function mergeThemePatch(current: ResumeTheme, patch: Record<string, unknown>): ResumeTheme {
  let merged = current;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const candidate = resumeThemeSchema.safeParse({ ...merged, [key]: value });
    if (candidate.success) merged = candidate.data;
  }
  return merged;
}

/** The theme as readable `key=value` lines; a JSON blob invites the model to echo it. */
function describeTheme(theme: ResumeTheme): string {
  return Object.entries(theme)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
}

function sameTheme(a: ResumeTheme, b: ResumeTheme): boolean {
  return (Object.keys(a) as (keyof ResumeTheme)[]).every((key) => a[key] === b[key]);
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
    signal?: AbortSignal;
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
      signal: input.signal,
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
