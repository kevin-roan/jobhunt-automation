import type { ApplicationStep, StepStatus } from '@deedy/shared';
import { ConfigurationError, NotFoundError, toErrorMessage } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import { normalizeText, truncate } from '../core/utils.js';
import { matchesAnyKeyword } from '../collectors/normalize.js';
import type { BrowserManager } from '../browser/browser.manager.js';
import type { ApplierRegistry } from '../browser/appliers/index.js';
import { isPipelineStageEnabled } from '../queue/worker.js';
import type {
  AnswerRequest,
  AnswerResult,
  ApplyContext,
  ApplyOutcome,
} from '../browser/appliers/types.js';
import type {
  AnswerBankRepository,
  ApplicationRepository,
} from '../repositories/application.repository.js';
import type { JobRepository } from '../repositories/job.repository.js';
import type { CoverLetterRepository, ResumeRepository } from '../repositories/resume.repository.js';
import { describeProfile } from './job.service.js';
import type { CoverLetterService, ResumeService } from './resume.service.js';
import type { LlmService } from './llm/llm.service.js';
import type { KeywordService } from './keyword.service.js';
import type { NotificationService } from './notification.service.js';
import type { SettingsService } from './settings.service.js';

export interface ApplyRequest {
  jobId: number;
  resumeId?: number | null;
  dryRun?: boolean;
  tailorResume?: boolean;
  generateCoverLetter?: boolean;
}

export interface ApplyResult {
  applicationId: number;
  status: string;
  submitted: boolean;
  dryRun: boolean;
  needsHuman: string | null;
  confirmationText: string | null;
}

/** Reason an application was not attempted; surfaced verbatim to the user. */
export class RateLimitedError extends ConfigurationError {}

/** The only fields the auto-apply keyword gate reads off a job row. */
export interface AutoApplyCandidate {
  id: number;
  title: string;
  source: string;
  skills: string[] | null;
}

export interface AutoApplyEligibility {
  eligible: boolean;
  /** Null when eligible; otherwise a specific, actionable sentence. */
  reason: string | null;
}

export class ApplicationService {
  constructor(
    private readonly applications: ApplicationRepository,
    private readonly answerBank: AnswerBankRepository,
    private readonly jobs: JobRepository,
    private readonly resumes: ResumeRepository,
    private readonly coverLetters: CoverLetterRepository,
    private readonly resumeService: ResumeService,
    private readonly coverLetterService: CoverLetterService,
    private readonly appliers: ApplierRegistry,
    private readonly browser: BrowserManager,
    private readonly llm: LlmService,
    private readonly settingsService: SettingsService,
    private readonly notifications: NotificationService,
    private readonly keywords: KeywordService,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  /**
   * Whether the pipeline may spend an application on this job *by itself*.
   *
   * It lives here rather than in either caller because there are two places
   * that queue `application.apply` automatically — the scheduler's `apply` task
   * and the `job.score` handler, which re-derives the score criteria inline —
   * and they have already drifted apart once. A gate implemented in only one of
   * them leaks every auto-apply that comes through the other, so the predicate
   * gets exactly one home, next to `assertWithinLimits`, the other policy that
   * decides whether an application is allowed to happen at all.
   *
   * Manual applies never call this: asking for one posting by id is explicit
   * intent and outranks the vocabulary.
   */
  autoApplyEligibility(job: AutoApplyCandidate): AutoApplyEligibility {
    const mode = this.settingsService.get().application.keywordMatch;
    if (mode === 'off') return { eligible: true, reason: null };

    const keywords = this.keywords.activeFor(job.source);
    // `matchesAnyKeyword` answers true for an empty list — the right default for
    // a collector's own search results, and exactly wrong here. An empty active
    // set means the user has nothing enabled that could ever match, so leaning
    // on that return would turn the gate off silently at the moment it matters
    // most. Refuse instead, and say which of the two empty cases it is.
    if (keywords.length === 0) {
      const anyEnabled = this.keywords.list().some((keyword) => keyword.enabled);
      return {
        eligible: false,
        reason: anyEnabled
          ? `no keyword is enabled for source "${job.source}"`
          : 'no keywords are enabled at all',
      };
    }

    if (matchesAnyKeyword(job.title, keywords)) return { eligible: true, reason: null };
    if (mode === 'title') {
      return { eligible: false, reason: 'title does not match any enabled keyword' };
    }

    // Skills are matched one at a time rather than joined: a joined string lets a
    // phrase keyword straddle two unrelated skills ("data engineer" hitting
    // "…data" + "engineering…").
    const skills = job.skills ?? [];
    if (skills.some((skill) => matchesAnyKeyword(skill, keywords))) {
      return { eligible: true, reason: null };
    }
    return {
      eligible: false,
      reason: 'neither title nor extracted skills match any enabled keyword',
    };
  }

  /**
   * The gate plus its log line. Both automatic enqueue sites call this and
   * nothing else, so a skip is impossible to make invisible by forgetting to
   * log it at a new call site — silent stoppage is the failure mode users
   * cannot debug.
   */
  allowsAutoApply(job: AutoApplyCandidate): boolean {
    const { eligible, reason } = this.autoApplyEligibility(job);
    if (!eligible) {
      this.logger.info('auto-apply skipped by keyword gate', {
        jobId: job.id,
        title: job.title,
        source: job.source,
        reason,
      });
    }
    return eligible;
  }

  /** Enforces the daily and per-company caps configured in Settings. */
  private assertWithinLimits(company: string): void {
    const limits = this.settingsService.get().application;
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();

    if (limits.maxApplicationsPerDay > 0) {
      const today = this.applications.countSubmittedSince(since);
      if (today >= limits.maxApplicationsPerDay) {
        throw new RateLimitedError(
          `Daily application limit reached (${today}/${limits.maxApplicationsPerDay})`,
        );
      }
    }

    if (limits.maxApplicationsPerCompanyPerDay > 0) {
      const forCompany = this.applications.countSubmittedForCompanySince(company, since);
      if (forCompany >= limits.maxApplicationsPerCompanyPerDay) {
        throw new RateLimitedError(
          `Daily limit for ${company} reached (${forCompany}/${limits.maxApplicationsPerCompanyPerDay})`,
        );
      }
    }
  }

  /**
   * Runs the full application pipeline for a job. Idempotent: an application
   * that already reached `submitted` is returned untouched, and a partially
   * completed one resumes from its persisted state.
   */
  async apply(request: ApplyRequest, signal?: AbortSignal): Promise<ApplyResult> {
    const job = this.jobs.byId(request.jobId);
    if (!job) throw new NotFoundError('Job', request.jobId);

    const settings = this.settingsService.get();
    const dryRun = request.dryRun ?? settings.browser.dryRun;
    const applier = this.appliers.resolve(job.applicationUrl, job.source);
    if (!applier) {
      throw new ConfigurationError(
        `No applier supports ${job.applicationUrl}. Add a plugin for this provider.`,
      );
    }

    const application = this.applications.ensure({
      jobId: job.id,
      provider: applier.provider,
      resumeId: request.resumeId ?? settings.application.defaultResumeId,
      maxAttempts: settings.queue.maxAttempts,
      dryRun,
    });

    if (application.status === 'submitted') {
      this.logger.info('application already submitted; skipping', { applicationId: application.id });
      return {
        applicationId: application.id,
        status: application.status,
        submitted: true,
        dryRun: application.dryRun,
        needsHuman: null,
        confirmationText: application.confirmationText,
      };
    }

    if (!dryRun) this.assertWithinLimits(job.company);

    const logger = this.logger.child('apply', { applicationId: application.id, jobId: job.id });
    const attempt = this.applications.incrementAttempt(application.id);
    this.applications.update(application.id, {
      status: 'in_progress',
      startedAt: application.startedAt ?? new Date().toISOString(),
      error: null,
      dryRun,
    });
    this.events.emit('application.created', { applicationId: application.id, jobId: job.id });

    // Prepare the documents before opening a browser so failures are cheap.
    let resumeId = request.resumeId ?? settings.application.defaultResumeId ?? null;
    // The request's flag outranks Settings; the stage switch outranks both,
    // because stopping the tailor stage is how the user hands the CPU back and a
    // manual apply spending two generations anyway would make that switch a lie.
    // Read structurally off settings rather than through `PipelineService`: that
    // service owns the worker, whose handlers own this service.
    const tailoringEnabled =
      (request.tailorResume ?? settings.application.tailorResume) &&
      isPipelineStageEnabled(settings.pipeline, 'tailor');

    if (tailoringEnabled) {
      const minScore = settings.application.minScoreToTailor;
      // A null score is not a low score. Treating it as zero meant an unscored
      // job — one applied to straight from the dashboard, before the pipeline
      // ever reached it — silently got the untailored base resume, with nothing
      // in the log to say why. It still does, because tailoring against a job we
      // have not read is guesswork; the difference is that it now says so.
      if (job.score === null) {
        logger.info('resume not tailored: the job has no score yet', {
          jobId: job.id,
          minScoreToTailor: minScore,
        });
      } else if (job.score < minScore) {
        logger.info('resume not tailored: score is below the tailoring threshold', {
          jobId: job.id,
          score: job.score,
          minScoreToTailor: minScore,
        });
      } else {
        try {
          const tailored = await this.resumeService.tailorForJob({
            jobId: job.id,
            baseResumeId: resumeId,
            signal,
          });
          // `renderDocuments` records a failed compile instead of throwing, so a
          // tailored row can exist with no PDF at all. Adopting it anyway means
          // the applier falls back to the DOCX rendered from the broken source —
          // it uploads a mangled resume and reports success. The base document
          // compiled, so it is strictly the better of the two.
          if (tailored.compileOk) {
            resumeId = tailored.id;
          } else {
            logger.warn('tailored resume did not compile; falling back to the base resume', {
              jobId: job.id,
              tailoredResumeId: tailored.id,
              baseResumeId: resumeId,
            });
          }
        } catch (error) {
          logger.warn('resume tailoring failed; falling back to the base resume', {
            error: toErrorMessage(error),
          });
        }
      }
    }

    const resume =
      (resumeId ? this.resumes.byId(resumeId) : undefined) ?? this.resumes.defaultResume();
    if (!resume) {
      throw new ConfigurationError(
        'No resume is available. Add one under Resume Manager before applying.',
      );
    }
    resumeId = resume.id;

    let coverLetterId: number | null = null;
    let coverLetterText: string | null = null;
    let coverLetterPath: string | null = null;
    if (
      (request.generateCoverLetter ?? settings.application.generateCoverLetter) &&
      isPipelineStageEnabled(settings.pipeline, 'cover_letter')
    ) {
      try {
        const letter = await this.coverLetterService.generate({
          jobId: job.id,
          resumeId,
          applicationId: application.id,
          reuseExisting: true,
          signal,
        });
        coverLetterId = letter.id;
        coverLetterText = letter.body;
        coverLetterPath = letter.pdfPath;
      } catch (error) {
        logger.warn('cover letter generation failed; continuing without one', {
          error: toErrorMessage(error),
        });
      }
    }

    this.applications.update(application.id, { resumeId, coverLetterId });

    const page = await this.browser.newPage(applier.provider);
    const completed = this.applications.completedSteps(application.id);

    const recordStep = async (
      step: ApplicationStep,
      status: StepStatus,
      detail?: { message?: string; error?: string; data?: unknown },
    ): Promise<void> => {
      const startedAt = Date.now();
      this.applications.update(application.id, { currentStep: step });
      this.applications.recordEvent({
        applicationId: application.id,
        step,
        status,
        attempt,
        message: detail?.message ?? null,
        error: detail?.error ?? null,
        durationMs: Date.now() - startedAt,
        data: detail?.data ?? null,
      });
      this.events.emit('application.step', {
        applicationId: application.id,
        step,
        status,
        attempt,
        message: detail?.message,
      });

      if (status === 'succeeded' || status === 'failed') {
        const capture = await this.browser.capture(page, `${application.id}-${step}-${status}`);
        if (capture.screenshotPath) {
          this.applications.addArtifact({
            kind: 'screenshot',
            path: capture.screenshotPath,
            applicationId: application.id,
            jobId: job.id,
            step,
          });
        }
        if (capture.htmlPath) {
          this.applications.addArtifact({
            kind: 'html',
            path: capture.htmlPath,
            applicationId: application.id,
            jobId: job.id,
            step,
          });
        }
      }
    };

    const context: ApplyContext = {
      page,
      logger,
      profile: settings.profile,
      documents: {
        resumePath: resume.pdfPath,
        resumeDocxPath: resume.docxPath,
        coverLetterPath,
        coverLetterText,
      },
      job: {
        id: job.id,
        title: job.title,
        company: job.company,
        applicationUrl: job.applicationUrl,
      },
      applicationId: application.id,
      dryRun,
      completed,
      answer: (requestBody) =>
        this.resolveAnswer(requestBody, {
          applicationId: application.id,
          jobId: job.id,
          jobTitle: job.title,
          company: job.company,
          resumeMarkdown: resume.markdown,
        }),
      recordStep,
    };

    let outcome: ApplyOutcome;
    try {
      outcome = await applier.apply(context);
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error('application attempt failed', { error: message, attempt });
      this.applications.recordEvent({
        applicationId: application.id,
        step: (this.applications.byId(application.id)?.currentStep as ApplicationStep) ?? 'navigate',
        status: 'failed',
        attempt,
        error: message,
      });
      this.applications.setStatus(application.id, 'failed', message);
      this.events.emit('application.failed', {
        applicationId: application.id,
        jobId: job.id,
        error: message,
      });
      await this.notifications.applicationFailed(job, message);
      throw error;
    } finally {
      await this.browser.saveStorageState(applier.provider);
      await page.close().catch(() => undefined);
    }

    if (outcome.needsHuman) {
      this.applications.update(application.id, {
        status: 'needs_human',
        error: outcome.needsHuman,
      });
      this.jobs.setStatus(job.id, 'manual_review');
      this.events.emit('application.needs_human', {
        applicationId: application.id,
        jobId: job.id,
        question: outcome.needsHuman,
      });
      await this.notifications.needsHuman(job, outcome.needsHuman);
      return {
        applicationId: application.id,
        status: 'needs_human',
        submitted: false,
        dryRun,
        needsHuman: outcome.needsHuman,
        confirmationText: outcome.confirmationText,
      };
    }

    const status = outcome.submitted ? 'submitted' : dryRun ? 'pending' : 'failed';
    this.applications.update(application.id, {
      status,
      confirmationText: outcome.confirmationText,
      submittedAt: outcome.submitted ? new Date().toISOString() : null,
      error: null,
    });
    this.jobs.setStatus(job.id, outcome.submitted ? 'applied' : dryRun ? 'queued' : 'failed');

    if (outcome.submitted) {
      this.events.emit('application.submitted', {
        applicationId: application.id,
        jobId: job.id,
        dryRun,
      });
    }
    await this.notifications.applicationSubmitted(job, dryRun);

    logger.info('application finished', { status, submitted: outcome.submitted, dryRun });

    return {
      applicationId: application.id,
      status,
      submitted: outcome.submitted,
      dryRun,
      needsHuman: null,
      confirmationText: outcome.confirmationText,
    };
  }

  /**
   * Answers a form question: reuse a stored answer first, then ask the LLM, and
   * escalate to the user when the model has no grounded answer.
   */
  private async resolveAnswer(
    request: AnswerRequest,
    context: {
      applicationId: number;
      jobId: number;
      jobTitle: string;
      company: string;
      resumeMarkdown: string;
    },
  ): Promise<AnswerResult> {
    const settings = this.settingsService.get();
    const stored = this.answerBank.find(request.question);
    if (stored) {
      this.answerBank.markUsed(stored.normalized);
      this.applications.recordAnswer({
        applicationId: context.applicationId,
        question: request.question,
        answer: stored.answer,
        fieldType: request.fieldType,
        source: 'answer_bank',
        confidence: 1,
      });
      return { value: stored.answer, source: 'answer_bank', confidence: 1, needsHuman: false };
    }

    try {
      const result = await this.llm.run('form_answer', {
        variables: {
          question: request.question,
          fieldType: request.fieldType,
          options: request.options.length > 0 ? request.options.join(' | ') : '(free text)',
          profile: describeProfile(settings.profile),
          resume: truncate(context.resumeMarkdown, 8000),
          title: context.jobTitle,
          company: context.company,
        },
        jobId: context.jobId,
        applicationId: context.applicationId,
      });

      const needsHuman =
        result.data.needsHuman ||
        result.data.answer.trim().length === 0 ||
        (settings.application.pauseOnUnknownQuestion && result.data.confidence < 0.5);

      this.applications.recordAnswer({
        applicationId: context.applicationId,
        question: request.question,
        answer: result.data.answer,
        fieldType: request.fieldType,
        source: 'llm',
        confidence: result.data.confidence,
      });

      // Cache confident answers so the same question is free next time.
      if (!needsHuman && result.data.confidence >= 0.8) {
        this.answerBank.upsert({
          question: request.question,
          answer: result.data.answer,
          fieldType: request.fieldType,
        });
      }

      return {
        value: result.data.answer,
        source: 'llm',
        confidence: result.data.confidence,
        needsHuman,
      };
    } catch (error) {
      this.logger.warn('llm could not answer a form question', {
        question: truncate(request.question, 120),
        error: toErrorMessage(error),
      });
      return { value: '', source: 'llm', confidence: 0, needsHuman: true };
    }
  }

  /** Teaches the answer bank from a human correction. */
  saveAnswer(question: string, answer: string, fieldType = 'text'): void {
    this.answerBank.upsert({ question, answer, fieldType });
    this.logger.info('answer bank updated', { normalized: normalizeText(question) });
  }

  /** Marks applications abandoned mid-flight by a crash so they can be retried. */
  recoverStuck(): number {
    const stuck = this.applications.stuck();
    for (const application of stuck) {
      this.applications.update(application.id, {
        status: 'pending',
        error: 'Interrupted by a restart; re-queued automatically',
      });
    }
    if (stuck.length > 0) {
      this.logger.warn('recovered interrupted applications', { count: stuck.length });
    }
    return stuck.length;
  }

  latestCoverLetter(jobId: number) {
    return this.coverLetters.latestForJob(jobId);
  }
}
