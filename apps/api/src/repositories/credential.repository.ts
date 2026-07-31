import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type {
  CredentialKind,
  CredentialStatus,
  ProviderCredentialDto,
} from '@deedy/shared';
import type { Db } from '../db/client.js';
import { providerCredentials, type ProviderCredentialRow } from '../db/schema.js';
import { isoPlusMs, nowIso } from '../core/utils.js';

export interface UpsertCredentialInput {
  provider: string;
  kind: CredentialKind;
  /** Already-encrypted ciphertext. The repository never sees cleartext. */
  value: string;
  status: CredentialStatus;
  cookieCount: number | null;
  domains: string[];
  expiresAt: string | null;
  note?: string | null;
}

function describe(row: ProviderCredentialRow): string {
  const domains = row.domains.length > 0 ? row.domains.join(', ') : 'this provider';
  switch (row.kind as CredentialKind) {
    case 'cookies':
    case 'storage_state': {
      const count = row.cookieCount ?? 0;
      return `${count} ${count === 1 ? 'cookie' : 'cookies'} for ${domains}`;
    }
    case 'bearer_token':
      return `bearer token for ${domains}`;
    case 'header':
      return `custom header for ${domains}`;
    default:
      return `credential for ${domains}`;
  }
}

/**
 * Projection for the API. The `value` column is deliberately absent: the
 * ciphertext (and anything derived from it) never leaves the host process.
 */
export function toProviderCredentialDto(row: ProviderCredentialRow): ProviderCredentialDto {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind as CredentialKind,
    status: row.status as CredentialStatus,
    summary: describe(row),
    cookieCount: row.cookieCount,
    domains: row.domains,
    expiresAt: row.expiresAt,
    lastCheckedAt: row.lastCheckedAt,
    lastUsedAt: row.lastUsedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CredentialRepository {
  constructor(private readonly db: Db) {}

  list(): ProviderCredentialRow[] {
    return this.db.select().from(providerCredentials).orderBy(providerCredentials.provider).all();
  }

  byProvider(provider: string): ProviderCredentialRow | undefined {
    return this.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.provider, provider))
      .get();
  }

  upsert(input: UpsertCredentialInput): ProviderCredentialRow {
    const timestamp = nowIso();
    const values = {
      provider: input.provider,
      kind: input.kind,
      value: input.value,
      status: input.status,
      cookieCount: input.cookieCount,
      domains: input.domains,
      expiresAt: input.expiresAt,
      note: input.note ?? null,
      updatedAt: timestamp,
    };
    return this.db
      .insert(providerCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: providerCredentials.provider,
        // A re-paste replaces the secret wholesale; stale derived columns would lie.
        set: {
          kind: values.kind,
          value: values.value,
          status: values.status,
          cookieCount: values.cookieCount,
          domains: values.domains,
          expiresAt: values.expiresAt,
          note: values.note,
          lastCheckedAt: null,
          updatedAt: timestamp,
        },
      })
      .returning()
      .get();
  }

  setStatus(
    provider: string,
    status: CredentialStatus,
    note?: string | null,
  ): ProviderCredentialRow | undefined {
    const timestamp = nowIso();
    return this.db
      .update(providerCredentials)
      .set({
        status,
        lastCheckedAt: timestamp,
        ...(note === undefined ? {} : { note }),
        updatedAt: timestamp,
      })
      .where(eq(providerCredentials.provider, provider))
      .returning()
      .get();
  }

  markUsed(provider: string): void {
    const timestamp = nowIso();
    this.db
      .update(providerCredentials)
      .set({ lastUsedAt: timestamp, updatedAt: timestamp })
      .where(eq(providerCredentials.provider, provider))
      .run();
  }

  delete(provider: string): void {
    this.db.delete(providerCredentials).where(eq(providerCredentials.provider, provider)).run();
  }

  /**
   * Credentials that will lapse inside the window. Already-lapsed rows still
   * marked `valid` are included: they are the most urgent case, not the least.
   */
  expiringSoon(withinMs: number): ProviderCredentialRow[] {
    return this.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.status, 'valid'),
          isNotNull(providerCredentials.expiresAt),
          lte(providerCredentials.expiresAt, isoPlusMs(withinMs)),
        ),
      )
      .orderBy(providerCredentials.expiresAt)
      .all();
  }
}
