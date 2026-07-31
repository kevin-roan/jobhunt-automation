import { and, count, desc, eq, gte, like, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  LlmCallDto,
  LlmTask,
  LogDto,
  LogLevel,
  LogQuery,
  Paginated,
  Pagination,
  PromptTemplateDto,
} from '@deedy/shared';
import type { Db } from '../db/client.js';
import { llmCalls, logs, promptTemplates, type LlmCallRow, type LogRow } from '../db/schema.js';
import { nowIso } from '../core/utils.js';

export class LogRepository {
  constructor(private readonly db: Db) {}

  search(query: LogQuery): Paginated<LogDto> {
    const conditions: SQL[] = [];
    if (query.level) conditions.push(eq(logs.level, query.level));
    if (query.scope) conditions.push(like(logs.scope, `${query.scope}%`));
    if (query.since) conditions.push(gte(logs.createdAt, query.since));
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      const match = or(
        like(sql`lower(${logs.message})`, needle),
        like(sql`lower(coalesce(${logs.context}, ''))`, needle),
      );
      if (match) conditions.push(match);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = this.db.select({ value: count() }).from(logs).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(logs)
      .where(where)
      .orderBy(desc(logs.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    return {
      items: rows.map(toLogDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  scopes(): string[] {
    return this.db
      .selectDistinct({ scope: logs.scope })
      .from(logs)
      .all()
      .map((r) => r.scope)
      .sort();
  }

  purgeBefore(iso: string): number {
    return this.db.delete(logs).where(lte(logs.createdAt, iso)).returning({ id: logs.id }).all()
      .length;
  }
}

export function toLogDto(row: LogRow): LogDto {
  return {
    id: row.id,
    level: row.level as LogLevel,
    scope: row.scope,
    message: row.message,
    context: row.context,
    createdAt: row.createdAt,
  };
}

export function toLlmCallDto(row: LlmCallRow): LlmCallDto {
  return {
    id: row.id,
    task: row.task as LlmTask,
    provider: row.provider,
    model: row.model,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    success: row.success,
    attempt: row.attempt,
    error: row.error,
    jobId: row.jobId,
    createdAt: row.createdAt,
  };
}

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  record(input: {
    task: LlmTask;
    provider: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    durationMs: number;
    success: boolean;
    attempt: number;
    error: string | null;
    jobId: number | null;
    applicationId: number | null;
  }): number {
    const row = this.db
      .insert(llmCalls)
      .values(input)
      .returning({ id: llmCalls.id })
      .get();
    return row.id;
  }

  search(params: Pagination & { task?: LlmTask; success?: boolean }): Paginated<LlmCallDto> {
    const conditions: SQL[] = [];
    if (params.task) conditions.push(eq(llmCalls.task, params.task));
    if (params.success !== undefined) conditions.push(eq(llmCalls.success, params.success));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = this.db.select({ value: count() }).from(llmCalls).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(llmCalls)
      .where(where)
      .orderBy(desc(llmCalls.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)
      .all();

    return {
      items: rows.map(toLlmCallDto),
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  byId(id: number): LlmCallRow | undefined {
    return this.db.select().from(llmCalls).where(eq(llmCalls.id, id)).get();
  }

  totals(): { calls: number; tokens: number } {
    const row = this.db
      .select({
        calls: count(),
        tokens: sql<number>`coalesce(sum(${llmCalls.totalTokens}), 0)`,
      })
      .from(llmCalls)
      .get();
    return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0 };
  }

  purgeBefore(iso: string): number {
    return this.db
      .delete(llmCalls)
      .where(lte(llmCalls.createdAt, iso))
      .returning({ id: llmCalls.id })
      .all().length;
  }
}

export class PromptTemplateRepository {
  constructor(private readonly db: Db) {}

  list(): PromptTemplateDto[] {
    return this.db
      .select()
      .from(promptTemplates)
      .orderBy(promptTemplates.task, desc(promptTemplates.version))
      .all()
      .map(toPromptTemplateDto);
  }

  /** The active template for a task, or undefined to fall back to the built-in prompt. */
  active(task: LlmTask): PromptTemplateDto | undefined {
    const row = this.db
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.task, task), eq(promptTemplates.isActive, true)))
      .orderBy(desc(promptTemplates.version))
      .get();
    return row ? toPromptTemplateDto(row) : undefined;
  }

  upsert(input: {
    task: LlmTask;
    name: string;
    system: string;
    user: string;
    isActive: boolean;
  }): PromptTemplateDto {
    return this.db.transaction((tx) => {
      const latest = tx
        .select({ version: promptTemplates.version })
        .from(promptTemplates)
        .where(and(eq(promptTemplates.task, input.task), eq(promptTemplates.name, input.name)))
        .orderBy(desc(promptTemplates.version))
        .get();

      if (input.isActive) {
        tx.update(promptTemplates)
          .set({ isActive: false })
          .where(eq(promptTemplates.task, input.task))
          .run();
      }

      const row = tx
        .insert(promptTemplates)
        .values({ ...input, version: (latest?.version ?? 0) + 1 })
        .returning()
        .get();
      return toPromptTemplateDto(row);
    });
  }

  activate(id: number): void {
    this.db.transaction((tx) => {
      const row = tx.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
      if (!row) return;
      tx.update(promptTemplates)
        .set({ isActive: false })
        .where(eq(promptTemplates.task, row.task))
        .run();
      tx.update(promptTemplates)
        .set({ isActive: true, updatedAt: nowIso() })
        .where(eq(promptTemplates.id, id))
        .run();
    });
  }

  delete(id: number): void {
    this.db.delete(promptTemplates).where(eq(promptTemplates.id, id)).run();
  }
}

function toPromptTemplateDto(row: typeof promptTemplates.$inferSelect): PromptTemplateDto {
  return {
    id: row.id,
    task: row.task as LlmTask,
    name: row.name,
    system: row.system,
    user: row.user,
    isActive: row.isActive,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
