import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type {
  NotificationDto,
  NotificationKind,
  NotificationLevel,
  Paginated,
} from '@deedy/shared';
import type { Db } from '../db/client.js';
import { notifications, type NotificationRow } from '../db/schema.js';

export interface CreateNotificationInput {
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body?: string;
  entityType?: string | null;
  entityId?: number | null;
  actionable?: boolean;
  /**
   * Collapses repeats of the same real-world event. The unique index is on a
   * nullable column, so leaving it undefined always creates a new row.
   */
  dedupeKey?: string | null;
}

export interface NotificationQuery {
  page: number;
  pageSize: number;
  unreadOnly?: boolean;
  kind?: NotificationKind;
}

export class NotificationRepository {
  constructor(private readonly db: Db) {}

  create(input: CreateNotificationInput): NotificationDto {
    const values = {
      kind: input.kind,
      level: input.level,
      title: input.title,
      body: input.body ?? '',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actionable: input.actionable ?? false,
      dedupeKey: input.dedupeKey ?? null,
    };

    const inserted = this.db
      .insert(notifications)
      .values(values)
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) return toNotificationDto(inserted);

    // Conflict on dedupeKey: the event is already on record, hand back the original.
    const existing = values.dedupeKey
      ? this.db
          .select()
          .from(notifications)
          .where(eq(notifications.dedupeKey, values.dedupeKey))
          .get()
      : undefined;
    if (!existing) throw new Error(`Failed to persist notification "${input.title}"`);
    return toNotificationDto(existing);
  }

  list(query: NotificationQuery): Paginated<NotificationDto> {
    const conditions: SQL[] = [];
    if (query.unreadOnly) conditions.push(eq(notifications.read, false));
    if (query.kind) conditions.push(eq(notifications.kind, query.kind));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total =
      this.db.select({ value: count() }).from(notifications).where(where).get()?.value ?? 0;
    const rows = this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    return {
      items: rows.map(toNotificationDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  byId(id: number): NotificationDto | undefined {
    const row = this.rowById(id);
    return row ? toNotificationDto(row) : undefined;
  }

  /**
   * The stored row rather than the DTO. The sync mirror maps database columns
   * onto its own wire shape, so handing it a DTO would only make it map twice.
   */
  rowById(id: number): NotificationRow | undefined {
    return this.db.select().from(notifications).where(eq(notifications.id, id)).get();
  }

  unreadCount(): number {
    return (
      this.db
        .select({ value: count() })
        .from(notifications)
        .where(eq(notifications.read, false))
        .get()?.value ?? 0
    );
  }

  markRead(id: number): void {
    this.db.update(notifications).set({ read: true }).where(eq(notifications.id, id)).run();
  }

  markAllRead(): number {
    return this.db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.read, false))
      .returning({ id: notifications.id })
      .all().length;
  }

  delete(id: number): void {
    this.db.delete(notifications).where(eq(notifications.id, id)).run();
  }

  purgeBefore(iso: string): number {
    return this.db
      .delete(notifications)
      .where(lte(notifications.createdAt, iso))
      .returning({ id: notifications.id })
      .all().length;
  }

  /** Rows created at or after an ISO timestamp, oldest first. */
  since(iso: string, limit = 200): NotificationDto[] {
    return this.db
      .select()
      .from(notifications)
      .where(gte(notifications.createdAt, iso))
      .orderBy(notifications.id)
      .limit(limit)
      .all()
      .map(toNotificationDto);
  }
}

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    level: row.level as NotificationLevel,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    read: row.read,
    actionable: row.actionable,
    createdAt: row.createdAt,
  };
}
