import type {
  CredentialKind,
  CredentialStatus,
  ProviderCredentialDto,
  SaveCredentialInput,
} from '@deedy/shared';
import { decryptSecret, encryptSecret } from '../core/crypto.js';
import { ValidationError } from '../core/errors.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { ProviderCredentialRow } from '../db/schema.js';
import {
  toProviderCredentialDto,
  type CredentialRepository,
} from '../repositories/credential.repository.js';

export type SameSite = 'Lax' | 'Strict' | 'None';

/** Playwright's cookie shape, which is also what the HTTP collectors need. */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

export interface StorageOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

/**
 * The canonical decrypted form of every credential, whatever the user pasted.
 * `header` carries token/header kinds, which are sent as request headers rather
 * than cookies.
 */
export interface CredentialBundle {
  cookies: PlaywrightCookie[];
  origins: StorageOrigin[];
  header?: { name: string; value: string };
}

const PROVIDER_DOMAINS: Record<string, string> = {
  linkedin: '.linkedin.com',
  indeed: '.indeed.com',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultDomain(provider: string): string {
  const key = provider.trim().toLowerCase();
  return PROVIDER_DOMAINS[key] ?? `.${key.replace(/[^a-z0-9.-]/g, '')}.com`;
}

function toSameSite(value: unknown): SameSite {
  if (typeof value !== 'string') return 'Lax';
  switch (value.toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'none':
    case 'no_restriction':
      return 'None';
    default:
      return 'Lax';
  }
}

/** Cookie tools emit seconds, milliseconds or an RFC date; all mean the same thing. */
function toUnixSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e11 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric > 1e11 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return -1;
}

function cookieDomain(raw: unknown, hostOnly: unknown, provider: string): string {
  const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : defaultDomain(provider);
  // Playwright treats a leading dot as "and subdomains"; hostOnly means the opposite.
  if (hostOnly === true && value.startsWith('.')) return value.slice(1);
  return value;
}

function normalizeCookieObject(entry: unknown, provider: string): PlaywrightCookie | null {
  if (!isRecord(entry)) return null;
  const name = entry.name ?? entry.key;
  const value = entry.value;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof value !== 'string') return null;

  const session = entry.session === true;
  const expires = session ? -1 : toUnixSeconds(entry.expirationDate ?? entry.expires ?? entry.expiry);

  return {
    name: name.trim(),
    value,
    domain: cookieDomain(entry.domain, entry.hostOnly, provider),
    path: typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : '/',
    expires,
    httpOnly: entry.httpOnly === true,
    secure: entry.secure === true,
    sameSite: toSameSite(entry.sameSite),
  };
}

/** Parses `li_at=abc; JSESSIONID=xyz`, with or without a leading `Cookie:`. */
function parseCookieHeader(raw: string, provider: string): PlaywrightCookie[] {
  const body = raw.replace(/^\s*cookie\s*:/i, '');
  const cookies: PlaywrightCookie[] = [];
  for (const part of body.split(';')) {
    const segment = part.trim();
    if (segment.length === 0) continue;
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (name.length === 0) continue;
    cookies.push({
      name,
      value: value.replace(/^"|"$/g, ''),
      domain: defaultDomain(provider),
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

function parseOrigins(raw: unknown): StorageOrigin[] {
  if (!Array.isArray(raw)) return [];
  const origins: StorageOrigin[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.origin !== 'string') continue;
    const items: { name: string; value: string }[] = [];
    if (Array.isArray(entry.localStorage)) {
      for (const item of entry.localStorage) {
        if (!isRecord(item)) continue;
        if (typeof item.name !== 'string' || typeof item.value !== 'string') continue;
        items.push({ name: item.name, value: item.value });
      }
    }
    origins.push({ origin: entry.origin, localStorage: items });
  }
  return origins;
}

/** Last paste of a given name/domain/path wins, matching browser semantics. */
function dedupe(cookies: PlaywrightCookie[]): PlaywrightCookie[] {
  const byKey = new Map<string, PlaywrightCookie>();
  for (const cookie of cookies) {
    byKey.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
  }
  return Array.from(byKey.values());
}

function parseHeaderPair(raw: string): { name: string; value: string } | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (name.length === 0 || value.length === 0) return null;
  return { name, value };
}

/**
 * Turns whatever the user pasted into the canonical bundle. Deliberately
 * lenient about `kind`: people mislabel their paste far more often than they
 * paste something genuinely unusable.
 */
export function parseCredentialValue(
  kind: CredentialKind,
  provider: string,
  raw: string,
): CredentialBundle {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('The pasted credential is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }

  if (Array.isArray(parsed)) {
    const cookies = dedupe(
      parsed
        .map((entry) => normalizeCookieObject(entry, provider))
        .filter((cookie): cookie is PlaywrightCookie => cookie !== null),
    );
    if (cookies.length === 0) {
      throw new ValidationError(
        'That JSON array contained no usable cookies. Each entry needs a "name" and a "value" - re-export from your cookie extension and paste the whole array.',
      );
    }
    return { cookies, origins: [] };
  }

  if (isRecord(parsed)) {
    const cookies = dedupe(
      (Array.isArray(parsed.cookies) ? parsed.cookies : [])
        .map((entry) => normalizeCookieObject(entry, provider))
        .filter((cookie): cookie is PlaywrightCookie => cookie !== null),
    );
    const origins = parseOrigins(parsed.origins);
    if (cookies.length === 0 && origins.length === 0) {
      throw new ValidationError(
        'That JSON object is not a Playwright storageState. It must contain a "cookies" array or an "origins" array.',
      );
    }
    return { cookies, origins };
  }

  if (kind === 'bearer_token') {
    const token = trimmed.replace(/^bearer\s+/i, '');
    if (/\s/.test(token)) {
      throw new ValidationError(
        'That does not look like a bearer token. Paste the token on its own, with or without the leading "Bearer ".',
      );
    }
    return { cookies: [], origins: [], header: { name: 'Authorization', value: `Bearer ${token}` } };
  }

  if (kind === 'header') {
    const header = parseHeaderPair(trimmed);
    if (!header) {
      throw new ValidationError(
        'A header credential must be pasted as "Name: value", for example "X-Api-Key: abc123".',
      );
    }
    return { cookies: [], origins: [], header };
  }

  const cookies = dedupe(parseCookieHeader(trimmed, provider));
  if (cookies.length === 0) {
    throw new ValidationError(
      'Could not read a single cookie from that value. Paste either a Cookie header ("li_at=...; JSESSIONID=..."), a cookie extension JSON export, or a Playwright storageState file.',
    );
  }
  return { cookies, origins: [] };
}

export function isExpired(row: ProviderCredentialRow): boolean {
  if (!row.expiresAt) return false;
  const at = Date.parse(row.expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

function hostMatches(host: string, domain: string): boolean {
  const bare = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase();
  if (bare.length === 0) return false;
  return host === bare || host.endsWith(`.${bare}`);
}

/**
 * The credential vault. LinkedIn and Indeed block automated login outright, so
 * the only workable path is a session the user already holds in their own
 * browser. Values are encrypted at rest and never returned over the API.
 */
export class CredentialService {
  constructor(
    private readonly repository: CredentialRepository,
    private readonly encryptionKey: Buffer,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  list(): ProviderCredentialDto[] {
    return this.repository.list().map(toProviderCredentialDto);
  }

  get(provider: string): ProviderCredentialDto | undefined {
    const row = this.repository.byProvider(provider);
    return row ? toProviderCredentialDto(row) : undefined;
  }

  save(input: SaveCredentialInput): ProviderCredentialDto {
    const provider = input.provider.trim().toLowerCase();
    const bundle = parseCredentialValue(input.kind, provider, input.value);

    const domains = Array.from(new Set(bundle.cookies.map((cookie) => cookie.domain))).sort();
    const expiries = bundle.cookies.map((cookie) => cookie.expires).filter((value) => value > 0);
    const expiresAt =
      expiries.length > 0 ? new Date(Math.min(...expiries) * 1000).toISOString() : null;

    const row = this.repository.upsert({
      provider,
      kind: input.kind,
      value: encryptSecret(JSON.stringify(bundle), this.encryptionKey),
      // A freshly pasted session is presumed live; expiry checks demote it later.
      status: 'valid',
      cookieCount: bundle.cookies.length,
      domains,
      expiresAt,
      note: input.note ?? null,
    });

    this.logger.info('credential.saved', {
      provider,
      kind: input.kind,
      cookieCount: bundle.cookies.length,
      domains,
      expiresAt,
    });

    return toProviderCredentialDto(row);
  }

  /** Cleartext bundle for the browser and HTTP layers. Never log the result. */
  load(provider: string): CredentialBundle | undefined {
    const row = this.repository.byProvider(provider);
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(decryptSecret(row.value, this.encryptionKey));
      if (!isRecord(parsed)) return undefined;
      const cookies = (Array.isArray(parsed.cookies) ? parsed.cookies : [])
        .map((cookie) => normalizeCookieObject(cookie, provider))
        .filter((cookie): cookie is PlaywrightCookie => cookie !== null);
      const origins = parseOrigins(parsed.origins);
      const header =
        isRecord(parsed.header) &&
        typeof parsed.header.name === 'string' &&
        typeof parsed.header.value === 'string'
          ? { name: parsed.header.name, value: parsed.header.value }
          : undefined;
      return header ? { cookies, origins, header } : { cookies, origins };
    } catch {
      // A key rotation or a truncated row must not take the pipeline down.
      this.logger.error('stored credential could not be decrypted', { provider });
      this.repository.setStatus(provider, 'invalid', 'Stored value could not be decrypted.');
      return undefined;
    }
  }

  /** `name=value; name=value` for the HTTP collectors, scoped to the target host. */
  cookieHeader(provider: string, url: string): string | undefined {
    const bundle = this.load(provider);
    if (!bundle) return undefined;

    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return undefined;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = bundle.cookies
      .filter((cookie) => hostMatches(host, cookie.domain))
      .filter((cookie) => cookie.expires <= 0 || cookie.expires > nowSeconds)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    return header.length > 0 ? header : undefined;
  }

  markUsed(provider: string): void {
    this.repository.markUsed(provider);
  }

  setStatus(provider: string, status: CredentialStatus, note?: string | null): void {
    this.repository.setStatus(provider, status, note);
  }

  delete(provider: string): void {
    this.repository.delete(provider);
    this.logger.info('credential.deleted', { provider });
  }

  /**
   * Demotes lapsed credentials and hands them back so the caller can raise a
   * notification. The status write is the only side effect.
   */
  checkExpiry(): ProviderCredentialRow[] {
    const lapsed: ProviderCredentialRow[] = [];
    for (const row of this.repository.list()) {
      if (row.status === 'expired' || !isExpired(row)) continue;
      const updated = this.repository.setStatus(
        row.provider,
        'expired',
        `Session expired at ${row.expiresAt ?? 'unknown'}.`,
      );
      lapsed.push(updated ?? row);
    }
    if (lapsed.length > 0) {
      this.logger.warn('credential.expired', { providers: lapsed.map((row) => row.provider) });
    }
    return lapsed;
  }

  /** Credentials lapsing inside the window, for pre-emptive warnings. */
  expiringSoon(withinMs: number): ProviderCredentialRow[] {
    return this.repository.expiringSoon(withinMs);
  }
}
