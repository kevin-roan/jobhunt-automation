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

/**
 * Cookies a provider needs before its collector can see signed-in content.
 * Used to tell the user precisely what is missing rather than "session invalid".
 */
export const REQUIRED_COOKIES: Record<string, string[]> = {
  linkedin: ['li_at'],
  indeed: ['CTK'],
};

/** The attributes a site actually sets, for cookies pasted without any. */
interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

/**
 * A `Cookie:` header carries names and values only - every attribute is lost.
 * Guessing wrong is not cosmetic: Playwright's `addCookies` rejects
 * `sameSite: 'None'` without `secure: true`, and a `Lax` cookie is withheld on
 * the cross-site navigations LinkedIn performs between www/, static/ and the
 * authwall, so a correctly pasted `li_at` still reads as signed out. This table
 * restores the attributes the site itself sends; unknown cookies fall back to
 * the conservative `secure + Lax` default below.
 */
const KNOWN_COOKIE_ATTRIBUTES: Record<string, Record<string, CookieAttributes>> = {
  linkedin: {
    // The session token itself: Secure, HttpOnly, SameSite=None.
    li_at: { httpOnly: true, secure: true, sameSite: 'None' },
    // Readable by page scripts - it seeds the CSRF token header.
    JSESSIONID: { httpOnly: false, secure: true, sameSite: 'None' },
    liap: { httpOnly: true, secure: true, sameSite: 'None' },
    li_rm: { httpOnly: true, secure: true, sameSite: 'None' },
    bcookie: { httpOnly: false, secure: true, sameSite: 'None' },
    bscookie: { httpOnly: true, secure: true, sameSite: 'None' },
  },
  indeed: {
    CTK: { httpOnly: false, secure: true, sameSite: 'Lax' },
    SHOE: { httpOnly: false, secure: true, sameSite: 'Lax' },
    INDEED_CSRF_TOKEN: { httpOnly: false, secure: true, sameSite: 'Lax' },
  },
};

/** What an unrecognised header-pasted cookie gets: safe on HTTPS, same-site only. */
const DEFAULT_COOKIE_ATTRIBUTES: CookieAttributes = {
  httpOnly: false,
  secure: true,
  sameSite: 'Lax',
};

function attributesFor(provider: string, name: string): CookieAttributes {
  const table = KNOWN_COOKIE_ATTRIBUTES[provider.trim().toLowerCase()];
  return table?.[name] ?? DEFAULT_COOKIE_ATTRIBUTES;
}

/** Cookie names a provider requires that the bundle does not carry. */
function missingFrom(provider: string, cookies: PlaywrightCookie[]): string[] {
  const required = REQUIRED_COOKIES[provider.trim().toLowerCase()] ?? [];
  const present = new Set(cookies.map((cookie) => cookie.name));
  return required.filter((name) => !present.has(name));
}

/** Debug sink for parse-time observations that need a logger the parser lacks. */
export type ParseDebug = (message: string, context: Record<string, unknown>) => void;

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
    // Chrome's own export writes "unspecified" for a cookie with no attribute;
    // the browser then treats it as Lax, so we must too.
    case 'unspecified':
    case 'lax':
      return 'Lax';
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

/**
 * A cookie scoped to `www.linkedin.com` is NOT sent to `linkedin.com`, so a
 * paste that looks complete can still authenticate nothing. We keep the domain
 * the user exported - rewriting it would be a security decision we are not
 * entitled to make - but we say so, because it is a leading cause of
 * "my cookies don't work".
 */
function isStrictSubdomain(domain: string, registrable: string): boolean {
  const bare = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase();
  const root = (registrable.startsWith('.') ? registrable.slice(1) : registrable).toLowerCase();
  return bare !== root && bare.endsWith(`.${root}`);
}

function normalizeCookieObject(
  entry: unknown,
  provider: string,
  debug?: ParseDebug,
): PlaywrightCookie | null {
  if (!isRecord(entry)) return null;
  // Some extensions (and .NET/Java exporters) capitalise the keys.
  const name = entry.name ?? entry.key ?? entry.Name;
  const value = entry.value ?? entry.Value;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof value !== 'string') return null;

  const session = entry.session === true;
  const expires = session ? -1 : toUnixSeconds(entry.expirationDate ?? entry.expires ?? entry.expiry);
  const domain = cookieDomain(entry.domain, entry.hostOnly, provider);

  const registrable = PROVIDER_DOMAINS[provider.trim().toLowerCase()];
  if (debug && registrable && isStrictSubdomain(domain, registrable)) {
    debug('cookie is scoped to a subdomain of the provider domain', {
      provider,
      cookie: name.trim(),
      domain,
      registrable,
    });
  }

  return {
    name: name.trim(),
    value,
    domain,
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
      // A header paste carries no expiry, so every cookie is treated as a
      // session cookie. That is correct - we genuinely do not know when it
      // lapses - but it means `save()` derives no `expiresAt` and the expiry
      // sweep can never demote the row; only a live probe can.
      expires: -1,
      ...attributesFor(provider, name),
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
  debug?: ParseDebug,
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
        .map((entry) => normalizeCookieObject(entry, provider, debug))
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
        .map((entry) => normalizeCookieObject(entry, provider, debug))
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

  /**
   * Required cookie names the stored bundle does not carry, so the UI can name
   * the missing cookie instead of saying "session invalid".
   */
  missingRequired(provider: string): string[] {
    const bundle = this.load(provider);
    if (!bundle) return REQUIRED_COOKIES[provider.trim().toLowerCase()] ?? [];
    return missingFrom(provider, bundle.cookies);
  }

  save(input: SaveCredentialInput): ProviderCredentialDto {
    const provider = input.provider.trim().toLowerCase();
    const bundle = parseCredentialValue(input.kind, provider, input.value, (message, context) =>
      this.logger.debug(message, context),
    );

    const domains = Array.from(new Set(bundle.cookies.map((cookie) => cookie.domain))).sort();
    // Session cookies carry `expires: -1`; a header paste has nothing else, so
    // `expiresAt` stays null and the expiry sweep cannot demote the row. That is
    // intentional - the `note` below tells the user we could not date it.
    const expiries = bundle.cookies.map((cookie) => cookie.expires).filter((value) => value > 0);
    const expiresAt =
      expiries.length > 0 ? new Date(Math.min(...expiries) * 1000).toISOString() : null;

    const missing = missingFrom(provider, bundle.cookies);
    const note = input.note ?? this.derivedNote(provider, bundle, missing, expiresAt);

    const row = this.repository.upsert({
      provider,
      kind: input.kind,
      value: encryptSecret(JSON.stringify(bundle), this.encryptionKey),
      // A freshly pasted session is presumed live; expiry checks demote it later.
      status: 'valid',
      cookieCount: bundle.cookies.length,
      domains,
      expiresAt,
      note,
    });

    this.logger.info('credential.saved', {
      provider,
      kind: input.kind,
      cookieCount: bundle.cookies.length,
      domains,
      expiresAt,
      missingRequired: missing,
    });

    return toProviderCredentialDto(row);
  }

  /**
   * A save is never rejected for being incomplete - the user would simply lose
   * the paste - so anything we noticed is reported back as a note instead.
   */
  private derivedNote(
    provider: string,
    bundle: CredentialBundle,
    missing: string[],
    expiresAt: string | null,
  ): string | null {
    const parts: string[] = [];
    if (missing.length > 0) {
      const label = provider.charAt(0).toUpperCase() + provider.slice(1);
      const names = missing.join(', ');
      const plural = missing.length === 1 ? 'cookie is' : 'cookies are';
      parts.push(
        `Saved, but the ${names} ${plural} missing - ${label} will still treat this session as signed out.`,
      );
    }
    if (expiresAt === null && bundle.cookies.length > 0) {
      parts.push(
        'No expiry could be determined from this paste, so the session cannot be aged out automatically - verify it if sign-in starts failing.',
      );
    }
    return parts.length > 0 ? parts.join(' ') : null;
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
