import { and, asc, count, desc, eq, gte, like, lte, or, sql, type SQL } from 'drizzle-orm';
import type { JobDto, JobQuery, JobScoreDto, JobStatus, Paginated } from '@deedy/shared';
import type { Db } from '../db/client.js';
import { companies, jobs, jobScores, jobSkills, type JobRow, type NewJobRow } from '../db/schema.js';
import { canonicalUrl, jobHash, normalizeCompany, normalizeText, nowIso } from '../core/utils.js';

export interface NormalizedJob {
  source: string;
  externalId?: string | null;
  title: string;
  company: string;
  location?: string | null;
  remoteType?: string;
  employmentType?: string;
  experienceLevel?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  description?: string | null;
  descriptionHtml?: string | null;
  skills?: string[];
  applicationUrl: string;
  postedAt?: string | null;
  raw?: unknown;
}

export type UpsertOutcome = 'inserted' | 'duplicate';

export interface UpsertResult {
  outcome: UpsertOutcome;
  jobId: number;
}

export function toJobDto(row: JobRow): JobDto {
  return {
    id: row.id,
    externalId: row.externalId,
    hash: row.hash,
    title: row.title,
    company: row.company,
    companyId: row.companyId,
    location: row.location,
    remoteType: row.remoteType as JobDto['remoteType'],
    employmentType: row.employmentType as JobDto['employmentType'],
    experienceLevel: row.experienceLevel as JobDto['experienceLevel'],
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryPeriod: row.salaryPeriod,
    description: row.description,
    descriptionHtml: row.descriptionHtml,
    summary: row.summary,
    skills: row.skills ?? [],
    applicationUrl: row.applicationUrl,
    source: row.source,
    postedAt: row.postedAt,
    collectedAt: row.collectedAt,
    status: row.status as JobStatus,
    score: row.score,
    recommendation: row.recommendation as JobDto['recommendation'],
    archived: row.archived,
  };
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /**
   * Inserts a job unless an equivalent one already exists. Duplicates are
   * detected by canonical application URL and by the stable content hash
   * (source + company + title + location), enforced by unique indexes so a
   * concurrent writer can never slip a duplicate past the check.
   */
  upsert(input: NormalizedJob): UpsertResult {
    const applicationUrl = canonicalUrl(input.applicationUrl);
    const hash = jobHash({
      source: input.source,
      company: input.company,
      title: input.title,
      location: input.location ?? null,
    });

    const existing = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(or(eq(jobs.hash, hash), eq(jobs.applicationUrl, applicationUrl)))
      .get();

    if (existing) return { outcome: 'duplicate', jobId: existing.id };

    const companyId = this.ensureCompany(input.company);
    const row: NewJobRow = {
      hash,
      externalId: input.externalId ?? null,
      source: input.source,
      title: input.title.trim(),
      company: input.company.trim(),
      companyId,
      location: input.location ?? null,
      remoteType: input.remoteType ?? 'unknown',
      employmentType: input.employmentType ?? 'unknown',
      experienceLevel: input.experienceLevel ?? 'unknown',
      salaryMin: input.salaryMin ?? null,
      salaryMax: input.salaryMax ?? null,
      salaryCurrency: input.salaryCurrency ?? null,
      salaryPeriod: input.salaryPeriod ?? null,
      description: input.description ?? null,
      descriptionHtml: input.descriptionHtml ?? null,
      skills: input.skills ?? [],
      applicationUrl,
      postedAt: input.postedAt ?? null,
      collectedAt: nowIso(),
      status: 'new',
      raw: input.raw ?? null,
    };

    try {
      const inserted = this.db.insert(jobs).values(row).returning({ id: jobs.id }).get();
      if (input.skills?.length) this.replaceSkills(inserted.id, input.skills);
      return { outcome: 'inserted', jobId: inserted.id };
    } catch (error) {
      // Unique index tripped by a concurrent writer — treat as a duplicate.
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        const found = this.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(or(eq(jobs.hash, hash), eq(jobs.applicationUrl, applicationUrl)))
          .get();
        if (found) return { outcome: 'duplicate', jobId: found.id };
      }
      throw error;
    }
  }

  ensureCompany(name: string): number {
    const normalized = normalizeCompany(name);
    const existing = this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.normalizedName, normalized))
      .get();
    if (existing) return existing.id;
    const inserted = this.db
      .insert(companies)
      .values({ name: name.trim(), normalizedName: normalized })
      .onConflictDoNothing()
      .returning({ id: companies.id })
      .get();
    if (inserted) return inserted.id;
    const retry = this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.normalizedName, normalized))
      .get();
    if (!retry) throw new Error(`Failed to resolve company "${name}"`);
    return retry.id;
  }

  updateCompanySummary(
    companyId: number,
    data: { industry: string | null; sizeEstimate: string | null; summary: string; culturePoints: string[] },
  ): void {
    this.db
      .update(companies)
      .set({ ...data, updatedAt: nowIso() })
      .where(eq(companies.id, companyId))
      .run();
  }

  companyById(id: number) {
    return this.db.select().from(companies).where(eq(companies.id, id)).get();
  }

  byId(id: number): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  byHash(hash: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.hash, hash)).get();
  }

  replaceSkills(jobId: number, skills: string[], kind = 'hard'): void {
    this.db.transaction((tx) => {
      tx.delete(jobSkills).where(eq(jobSkills.jobId, jobId)).run();
      const seen = new Set<string>();
      for (const skill of skills) {
        const normalized = normalizeText(skill);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        tx.insert(jobSkills)
          .values({ jobId, skill: skill.trim(), normalized, kind })
          .onConflictDoNothing()
          .run();
      }
      tx.update(jobs)
        .set({ skills: Array.from(new Set(skills.map((s) => s.trim()))), updatedAt: nowIso() })
        .where(eq(jobs.id, jobId))
        .run();
    });
  }

  updateEnrichment(
    jobId: number,
    patch: Partial<
      Pick<
        JobRow,
        | 'summary'
        | 'remoteType'
        | 'employmentType'
        | 'experienceLevel'
        | 'salaryMin'
        | 'salaryMax'
        | 'salaryCurrency'
        | 'salaryPeriod'
        | 'description'
        | 'descriptionHtml'
      >
    >,
  ): void {
    this.db
      .update(jobs)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(jobs.id, jobId))
      .run();
  }

  setStatus(jobId: number, status: JobStatus): void {
    this.db.update(jobs).set({ status, updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
  }

  setArchived(jobId: number, archived: boolean): void {
    this.db.update(jobs).set({ archived, updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
  }

  delete(jobId: number): void {
    this.db.delete(jobs).where(eq(jobs.id, jobId)).run();
  }

  /** Jobs that still need an LLM score, oldest first, so the queue drains fairly. */
  pendingScoring(limit: number): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'new'), eq(jobs.archived, false)))
      .orderBy(asc(jobs.collectedAt))
      .limit(limit)
      .all();
  }

  /**
   * Scored, unarchived jobs the model recommended applying to, best score first.
   *
   * It does NOT exclude jobs that already have an application row — nothing here
   * joins `applications`. The `application.apply` dedupe key and
   * `ApplicationRepository.ensure` are what keep a re-queued job from applying
   * twice; a job still sitting at status `scored` after an attempt is meant to
   * come back through here.
   */
  readyToApply(minScore: number, limit: number): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'scored'),
          eq(jobs.archived, false),
          gte(jobs.score, minScore),
          eq(jobs.recommendation, 'apply'),
        ),
      )
      .orderBy(desc(jobs.score))
      .limit(limit)
      .all();
  }

  recordScore(input: {
    jobId: number;
    resumeId: number | null;
    score: number;
    confidence: number;
    recommendation: string;
    matchedSkills: string[];
    missingSkills: string[];
    redFlags: string[];
    reasoning: string;
    interviewProbability: number | null;
    model: string;
  }): number {
    return this.db.transaction((tx) => {
      const inserted = tx
        .insert(jobScores)
        .values(input)
        .returning({ id: jobScores.id })
        .get();
      tx.update(jobs)
        .set({
          score: input.score,
          recommendation: input.recommendation,
          status: input.recommendation === 'skip' ? 'skipped' : 'scored',
          updatedAt: nowIso(),
        })
        .where(eq(jobs.id, input.jobId))
        .run();
      return inserted.id;
    });
  }

  scoresForJob(jobId: number): JobScoreDto[] {
    return this.db
      .select()
      .from(jobScores)
      .where(eq(jobScores.jobId, jobId))
      .orderBy(desc(jobScores.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        jobId: row.jobId,
        score: row.score,
        confidence: row.confidence,
        recommendation: row.recommendation as JobScoreDto['recommendation'],
        matchedSkills: row.matchedSkills ?? [],
        missingSkills: row.missingSkills ?? [],
        redFlags: row.redFlags ?? [],
        reasoning: row.reasoning,
        interviewProbability: row.interviewProbability,
        model: row.model,
        resumeId: row.resumeId,
        createdAt: row.createdAt,
      }));
  }

  search(query: JobQuery): Paginated<JobDto> {
    const conditions: SQL[] = [];

    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      const match = or(
        like(sql`lower(${jobs.title})`, needle),
        like(sql`lower(${jobs.company})`, needle),
        like(sql`lower(coalesce(${jobs.description}, ''))`, needle),
        like(sql`lower(coalesce(${jobs.location}, ''))`, needle),
      );
      if (match) conditions.push(match);
    }
    if (query.status) conditions.push(eq(jobs.status, query.status));
    if (query.source) conditions.push(eq(jobs.source, query.source));
    if (query.company) conditions.push(eq(jobs.company, query.company));
    if (query.remoteType) conditions.push(eq(jobs.remoteType, query.remoteType));
    if (query.experienceLevel) conditions.push(eq(jobs.experienceLevel, query.experienceLevel));
    if (query.recommendation) conditions.push(eq(jobs.recommendation, query.recommendation));
    if (query.minScore !== undefined) conditions.push(gte(jobs.score, query.minScore));
    if (query.maxScore !== undefined) conditions.push(lte(jobs.score, query.maxScore));
    conditions.push(eq(jobs.archived, query.archived ?? false));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const sortColumn = {
      collectedAt: jobs.collectedAt,
      postedAt: jobs.postedAt,
      score: jobs.score,
      company: jobs.company,
      title: jobs.title,
    }[query.sort];

    const total =
      this.db.select({ value: count() }).from(jobs).where(where).get()?.value ?? 0;

    const rows = this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(query.order === 'asc' ? asc(sortColumn) : desc(sortColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    return {
      items: rows.map(toJobDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  distinctSources(): string[] {
    return this.db
      .selectDistinct({ source: jobs.source })
      .from(jobs)
      .all()
      .map((r) => r.source);
  }

  countAll(): number {
    return this.db.select({ value: count() }).from(jobs).get()?.value ?? 0;
  }
}
