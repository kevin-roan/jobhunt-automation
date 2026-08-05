import { and, desc, eq, isNull, max, sql } from 'drizzle-orm';
import {
  DEFAULT_RESUME_THEME,
  resumeThemeSchema,
  type CoverLetterDto,
  type ResumeDto,
  type ResumeTheme,
} from '@deedy/shared';
import type { Db } from '../db/client.js';
import { coverLetters, resumes, type CoverLetterRow, type ResumeRow } from '../db/schema.js';
import { nowIso } from '../core/utils.js';

/**
 * The theme column is free-form JSON on disk: rows written before the LaTeX
 * migration hold `{}`, and a hand-edited row can hold anything at all. Parsing
 * defensively keeps one bad row from throwing out of the list endpoint.
 */
export function toResumeTheme(value: unknown): ResumeTheme {
  const parsed = resumeThemeSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_RESUME_THEME;
}

export function toResumeDto(row: ResumeRow): ResumeDto {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    targetRole: row.targetRole,
    latex: row.latex,
    theme: toResumeTheme(row.theme),
    templateId: row.templateId,
    markdown: row.markdown,
    compileLog: row.compileLog,
    compileOk: row.compileOk,
    texPath: row.texPath,
    filePath: row.filePath,
    pdfPath: row.pdfPath,
    docxPath: row.docxPath,
    isBase: row.isBase,
    isDefault: row.isDefault,
    parentId: row.parentId,
    jobId: row.jobId,
    generatedBy: row.generatedBy,
    changeSummary: row.changeSummary ?? [],
    atsScore: row.atsScore,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCoverLetterDto(row: CoverLetterRow): CoverLetterDto {
  return {
    id: row.id,
    jobId: row.jobId,
    applicationId: row.applicationId,
    resumeId: row.resumeId,
    subject: row.subject,
    body: row.body,
    tone: row.tone,
    version: row.version,
    model: row.model,
    pdfPath: row.pdfPath,
    createdAt: row.createdAt,
  };
}

export class ResumeRepository {
  constructor(private readonly db: Db) {}

  list(includeGenerated = true): ResumeRow[] {
    const query = this.db.select().from(resumes);
    const rows = includeGenerated
      ? query.orderBy(desc(resumes.updatedAt)).all()
      : query.where(eq(resumes.isBase, true)).orderBy(desc(resumes.updatedAt)).all();
    return rows;
  }

  byId(id: number): ResumeRow | undefined {
    return this.db.select().from(resumes).where(eq(resumes.id, id)).get();
  }

  defaultResume(): ResumeRow | undefined {
    return (
      this.db
        .select()
        .from(resumes)
        .where(and(eq(resumes.isDefault, true), eq(resumes.isBase, true)))
        .get() ??
      this.db
        .select()
        .from(resumes)
        .where(eq(resumes.isBase, true))
        .orderBy(desc(resumes.updatedAt))
        .get()
    );
  }

  /** Base resumes are versioned by name; a new row is created per edit. */
  nextVersion(name: string): number {
    const row = this.db
      .select({ value: max(resumes.version) })
      .from(resumes)
      .where(eq(resumes.name, name))
      .get();
    return (row?.value ?? 0) + 1;
  }

  create(input: {
    name: string;
    targetRole?: string | null;
    latex: string;
    theme?: ResumeTheme;
    templateId?: string;
    /** Plain-text mirror of `latex`; derived by the service, never authored. */
    markdown: string;
    compileOk?: boolean;
    compileLog?: string | null;
    texPath?: string | null;
    isBase: boolean;
    isDefault?: boolean;
    parentId?: number | null;
    jobId?: number | null;
    generatedBy?: string | null;
    changeSummary?: string[];
    atsScore?: number | null;
    filePath?: string | null;
    pdfPath?: string | null;
    docxPath?: string | null;
  }): ResumeRow {
    return this.db.transaction((tx) => {
      const version =
        (tx
          .select({ value: max(resumes.version) })
          .from(resumes)
          .where(eq(resumes.name, input.name))
          .get()?.value ?? 0) + 1;

      if (input.isDefault) {
        tx.update(resumes).set({ isDefault: false }).run();
      }

      const row = tx
        .insert(resumes)
        .values({
          name: input.name,
          version,
          targetRole: input.targetRole ?? null,
          latex: input.latex,
          theme: input.theme ?? DEFAULT_RESUME_THEME,
          ...(input.templateId ? { templateId: input.templateId } : {}),
          markdown: input.markdown,
          compileOk: input.compileOk ?? false,
          compileLog: input.compileLog ?? null,
          texPath: input.texPath ?? null,
          isBase: input.isBase,
          isDefault: input.isDefault ?? false,
          parentId: input.parentId ?? null,
          jobId: input.jobId ?? null,
          generatedBy: input.generatedBy ?? null,
          changeSummary: input.changeSummary ?? [],
          atsScore: input.atsScore ?? null,
          filePath: input.filePath ?? null,
          pdfPath: input.pdfPath ?? null,
          docxPath: input.docxPath ?? null,
        })
        .returning()
        .get();
      return row;
    });
  }

  update(id: number, patch: Partial<Omit<ResumeRow, 'id' | 'createdAt'>>): ResumeRow | undefined {
    return this.db.transaction((tx) => {
      if (patch.isDefault) {
        tx.update(resumes).set({ isDefault: false }).run();
      }
      return tx
        .update(resumes)
        .set({ ...patch, updatedAt: nowIso() })
        .where(eq(resumes.id, id))
        .returning()
        .get();
    });
  }

  setDocuments(id: number, paths: { pdfPath?: string; docxPath?: string; filePath?: string }): void {
    this.db
      .update(resumes)
      .set({ ...paths, updatedAt: nowIso() })
      .where(eq(resumes.id, id))
      .run();
  }

  /**
   * One write for everything a render produces. The compile log is stored even
   * when the compile failed, so the editor can show the engine's own error.
   */
  setCompileResult(
    id: number,
    result: {
      compileOk: boolean;
      compileLog?: string | null;
      texPath?: string | null;
      pdfPath?: string | null;
      docxPath?: string | null;
      filePath?: string | null;
      markdown?: string;
    },
  ): void {
    this.db
      .update(resumes)
      .set({
        compileOk: result.compileOk,
        compileLog: result.compileLog ?? null,
        ...(result.texPath !== undefined ? { texPath: result.texPath } : {}),
        ...(result.pdfPath !== undefined ? { pdfPath: result.pdfPath } : {}),
        ...(result.docxPath !== undefined ? { docxPath: result.docxPath } : {}),
        ...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
        ...(result.markdown !== undefined ? { markdown: result.markdown } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(resumes.id, id))
      .run();
  }

  delete(id: number): void {
    this.db.delete(resumes).where(eq(resumes.id, id)).run();
  }

  /** A previously generated tailored resume for this exact job, if any. */
  tailoredFor(jobId: number, parentId: number): ResumeRow | undefined {
    return this.db
      .select()
      .from(resumes)
      .where(and(eq(resumes.jobId, jobId), eq(resumes.parentId, parentId)))
      .orderBy(desc(resumes.createdAt))
      .get();
  }

  countBase(): number {
    return (
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(resumes)
        .where(eq(resumes.isBase, true))
        .get()?.value ?? 0
    );
  }
}

export class CoverLetterRepository {
  constructor(private readonly db: Db) {}

  list(limit = 200): CoverLetterRow[] {
    return this.db
      .select()
      .from(coverLetters)
      .orderBy(desc(coverLetters.createdAt))
      .limit(limit)
      .all();
  }

  byId(id: number): CoverLetterRow | undefined {
    return this.db.select().from(coverLetters).where(eq(coverLetters.id, id)).get();
  }

  forJob(jobId: number): CoverLetterRow[] {
    return this.db
      .select()
      .from(coverLetters)
      .where(eq(coverLetters.jobId, jobId))
      .orderBy(desc(coverLetters.version))
      .all();
  }

  latestForJob(jobId: number): CoverLetterRow | undefined {
    return this.db
      .select()
      .from(coverLetters)
      .where(eq(coverLetters.jobId, jobId))
      .orderBy(desc(coverLetters.version))
      .get();
  }

  /** Every generated version is kept; regeneration appends a new version. */
  create(input: {
    jobId: number | null;
    applicationId?: number | null;
    resumeId?: number | null;
    subject: string;
    body: string;
    tone?: string | null;
    model?: string | null;
    pdfPath?: string | null;
  }): CoverLetterRow {
    return this.db.transaction((tx) => {
      const previous = input.jobId
        ? tx
            .select({ version: coverLetters.version })
            .from(coverLetters)
            .where(eq(coverLetters.jobId, input.jobId))
            .orderBy(desc(coverLetters.version))
            .get()
        : tx
            .select({ version: coverLetters.version })
            .from(coverLetters)
            .where(isNull(coverLetters.jobId))
            .orderBy(desc(coverLetters.version))
            .get();

      return tx
        .insert(coverLetters)
        .values({
          jobId: input.jobId,
          applicationId: input.applicationId ?? null,
          resumeId: input.resumeId ?? null,
          subject: input.subject,
          body: input.body,
          tone: input.tone ?? null,
          model: input.model ?? null,
          pdfPath: input.pdfPath ?? null,
          version: (previous?.version ?? 0) + 1,
        })
        .returning()
        .get();
    });
  }

  setPdfPath(id: number, pdfPath: string): void {
    this.db.update(coverLetters).set({ pdfPath }).where(eq(coverLetters.id, id)).run();
  }

  delete(id: number): void {
    this.db.delete(coverLetters).where(eq(coverLetters.id, id)).run();
  }
}
