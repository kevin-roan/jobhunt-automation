import { and, count, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type {
  AnswerBankDto,
  ApplicationDto,
  ApplicationEventDto,
  ApplicationStatus,
  ApplicationStep,
  ArtifactDto,
  Paginated,
  Pagination,
  StepStatus,
} from '@deedy/shared';
import type { Db } from '../db/client.js';
import {
  answerBank,
  applicationAnswers,
  applicationEvents,
  applications,
  artifacts,
  jobs,
  type ApplicationEventRow,
  type ApplicationRow,
  type ArtifactRow,
} from '../db/schema.js';
import { normalizeText, nowIso } from '../core/utils.js';

export function toApplicationEventDto(row: ApplicationEventRow): ApplicationEventDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    step: row.step as ApplicationStep,
    status: row.status as StepStatus,
    attempt: row.attempt,
    message: row.message,
    error: row.error,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export function toArtifactDto(row: ArtifactRow): ArtifactDto {
  return {
    id: row.id,
    kind: row.kind as ArtifactDto['kind'],
    path: row.path,
    applicationId: row.applicationId,
    jobId: row.jobId,
    step: row.step,
    bytes: row.bytes,
    createdAt: row.createdAt,
  };
}

export class ApplicationRepository {
  constructor(private readonly db: Db) {}

  byId(id: number): ApplicationRow | undefined {
    return this.db.select().from(applications).where(eq(applications.id, id)).get();
  }

  byJobId(jobId: number): ApplicationRow | undefined {
    return this.db.select().from(applications).where(eq(applications.jobId, jobId)).get();
  }

  /** Idempotent: one application row per job, reused across retries. */
  ensure(input: {
    jobId: number;
    provider: string;
    resumeId: number | null;
    maxAttempts: number;
    dryRun: boolean;
  }): ApplicationRow {
    const existing = this.byJobId(input.jobId);
    if (existing) return existing;
    return this.db
      .insert(applications)
      .values({
        jobId: input.jobId,
        provider: input.provider,
        resumeId: input.resumeId,
        maxAttempts: input.maxAttempts,
        dryRun: input.dryRun,
        status: 'pending',
      })
      .returning()
      .get();
  }

  update(id: number, patch: Partial<Omit<ApplicationRow, 'id' | 'createdAt'>>): void {
    this.db
      .update(applications)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(applications.id, id))
      .run();
  }

  setStatus(id: number, status: ApplicationStatus, error?: string | null): void {
    this.update(id, { status, error: error ?? null });
  }

  incrementAttempt(id: number): number {
    const row = this.db
      .update(applications)
      .set({ attempts: sql`${applications.attempts} + 1`, updatedAt: nowIso() })
      .where(eq(applications.id, id))
      .returning({ attempts: applications.attempts })
      .get();
    return row?.attempts ?? 1;
  }

  recordEvent(input: {
    applicationId: number;
    step: ApplicationStep;
    status: StepStatus;
    attempt: number;
    message?: string | null;
    error?: string | null;
    durationMs?: number | null;
    data?: unknown;
  }): number {
    const row = this.db
      .insert(applicationEvents)
      .values({
        applicationId: input.applicationId,
        step: input.step,
        status: input.status,
        attempt: input.attempt,
        message: input.message ?? null,
        error: input.error ?? null,
        durationMs: input.durationMs ?? null,
        data: input.data ?? null,
      })
      .returning({ id: applicationEvents.id })
      .get();
    return row.id;
  }

  events(applicationId: number): ApplicationEventRow[] {
    return this.db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.applicationId, applicationId))
      .orderBy(applicationEvents.id)
      .all();
  }

  /**
   * The steps that already succeeded on this application, so a resumed run can
   * skip straight to the first unfinished step after a crash.
   */
  completedSteps(applicationId: number): Set<ApplicationStep> {
    const rows = this.db
      .select({ step: applicationEvents.step })
      .from(applicationEvents)
      .where(
        and(
          eq(applicationEvents.applicationId, applicationId),
          eq(applicationEvents.status, 'succeeded'),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.step as ApplicationStep));
  }

  recordAnswer(input: {
    applicationId: number;
    question: string;
    answer: string;
    fieldType: string;
    source: string;
    confidence: number | null;
  }): void {
    this.db.insert(applicationAnswers).values(input).run();
  }

  answers(applicationId: number) {
    return this.db
      .select()
      .from(applicationAnswers)
      .where(eq(applicationAnswers.applicationId, applicationId))
      .all();
  }

  addArtifact(input: {
    kind: ArtifactDto['kind'];
    path: string;
    applicationId?: number | null;
    jobId?: number | null;
    step?: string | null;
    bytes?: number | null;
    meta?: unknown;
  }): number {
    const row = this.db
      .insert(artifacts)
      .values({
        kind: input.kind,
        path: input.path,
        applicationId: input.applicationId ?? null,
        jobId: input.jobId ?? null,
        step: input.step ?? null,
        bytes: input.bytes ?? null,
        meta: input.meta ?? null,
      })
      .returning({ id: artifacts.id })
      .get();
    return row.id;
  }

  artifactById(id: number): ArtifactRow | undefined {
    return this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  }

  artifactsFor(applicationId: number): ArtifactRow[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.applicationId, applicationId))
      .orderBy(desc(artifacts.createdAt))
      .all();
  }

  recentArtifacts(kind: ArtifactDto['kind'], limit: number): ArtifactRow[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.kind, kind))
      .orderBy(desc(artifacts.createdAt))
      .limit(limit)
      .all();
  }

  search(
    params: Pagination & { status?: ApplicationStatus; jobId?: number },
  ): Paginated<ApplicationDto> {
    const conditions: SQL[] = [];
    if (params.status) conditions.push(eq(applications.status, params.status));
    if (params.jobId !== undefined) conditions.push(eq(applications.jobId, params.jobId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total =
      this.db.select({ value: count() }).from(applications).where(where).get()?.value ?? 0;

    const rows = this.db
      .select({
        application: applications,
        title: jobs.title,
        company: jobs.company,
        source: jobs.source,
      })
      .from(applications)
      .leftJoin(jobs, eq(jobs.id, applications.jobId))
      .where(where)
      .orderBy(desc(applications.createdAt))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)
      .all();

    return {
      items: rows.map((row) => this.toDto(row.application, row.title, row.company, row.source)),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  toDto(
    row: ApplicationRow,
    jobTitle: string | null = null,
    company: string | null = null,
    source: string | null = null,
  ): ApplicationDto {
    return {
      id: row.id,
      jobId: row.jobId,
      jobTitle,
      company,
      source,
      resumeId: row.resumeId,
      coverLetterId: row.coverLetterId,
      status: row.status as ApplicationStatus,
      currentStep: row.currentStep as ApplicationStep | null,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      confirmationText: row.confirmationText,
      error: row.error,
      dryRun: row.dryRun,
      startedAt: row.startedAt,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Rate-limit inputs: how many applications were submitted since a timestamp. */
  countSubmittedSince(sinceIso: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(applications)
        .where(and(eq(applications.status, 'submitted'), gte(applications.submittedAt, sinceIso)))
        .get()?.value ?? 0
    );
  }

  countSubmittedForCompanySince(company: string, sinceIso: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(
          and(
            eq(jobs.company, company),
            eq(applications.status, 'submitted'),
            gte(applications.submittedAt, sinceIso),
          ),
        )
        .get()?.value ?? 0
    );
  }

  /** Applications left mid-flight by a crash; the scheduler re-queues these. */
  stuck(): ApplicationRow[] {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.status, 'in_progress'))
      .all();
  }
}

export class AnswerBankRepository {
  constructor(private readonly db: Db) {}

  find(question: string): AnswerBankDto | undefined {
    const normalized = normalizeText(question);
    const row = this.db
      .select()
      .from(answerBank)
      .where(eq(answerBank.normalized, normalized))
      .get();
    return row ? this.toDto(row) : undefined;
  }

  list(): AnswerBankDto[] {
    return this.db
      .select()
      .from(answerBank)
      .orderBy(desc(answerBank.useCount))
      .all()
      .map((row) => this.toDto(row));
  }

  upsert(input: { question: string; answer: string; fieldType: string }): void {
    const normalized = normalizeText(input.question);
    this.db
      .insert(answerBank)
      .values({
        normalized,
        questionPattern: input.question,
        answer: input.answer,
        fieldType: input.fieldType,
        useCount: 0,
      })
      .onConflictDoUpdate({
        target: answerBank.normalized,
        set: { answer: input.answer, fieldType: input.fieldType, updatedAt: nowIso() },
      })
      .run();
  }

  markUsed(normalized: string): void {
    this.db
      .update(answerBank)
      .set({ useCount: sql`${answerBank.useCount} + 1`, updatedAt: nowIso() })
      .where(eq(answerBank.normalized, normalized))
      .run();
  }

  delete(id: number): void {
    this.db.delete(answerBank).where(eq(answerBank.id, id)).run();
  }

  private toDto(row: typeof answerBank.$inferSelect): AnswerBankDto {
    return {
      id: row.id,
      questionPattern: row.questionPattern,
      normalized: row.normalized,
      answer: row.answer,
      fieldType: row.fieldType,
      useCount: row.useCount,
      createdAt: row.createdAt,
    };
  }
}
