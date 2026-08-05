import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { CredentialKind } from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { providerCredentials, type ProviderCredentialRow } from '../../src/db/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ValidationError } from '../../src/core/errors.js';
import type { LogContext, Logger } from '../../src/core/logger.js';
import { decryptSecret } from '../../src/core/crypto.js';
import {
  CredentialRepository,
  toProviderCredentialDto,
} from '../../src/repositories/credential.repository.js';
import {
  CredentialService,
  isExpired,
  parseCredentialValue,
  type CredentialBundle,
  type PlaywrightCookie,
} from '../../src/services/credential.service.js';

const ENCRYPTED_PREFIX = 'enc:v1:';
const HOUR_MS = 60 * 60 * 1000;

type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: LogLevelName;
  message: string;
  context: LogContext | undefined;
}

interface RecordingLogger extends Logger {
  readonly entries: LogEntry[];
}

/** Minimal Logger that keeps every line in memory so tests can assert on them. */
function createTestLogger(scope = 'test'): RecordingLogger {
  const entries: LogEntry[] = [];
  const record = (level: LogLevelName) =>
    vi.fn((message: string, context?: LogContext): void => {
      entries.push({ level, message, context });
    });

  const logger: RecordingLogger = {
    scope,
    entries,
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  return logger;
}

function entriesFor(logger: RecordingLogger, level: LogLevelName, message: string): LogEntry[] {
  return logger.entries.filter((entry) => entry.level === level && entry.message === message);
}

interface Harness {
  handle: DbHandle;
  repository: CredentialRepository;
  service: CredentialService;
  logger: RecordingLogger;
  events: EventBus;
  key: Buffer;
  /** Raw ciphertext straight out of SQLite, bypassing every projection. */
  rawValue(provider: string): string | undefined;
  /** Overwrites the stored ciphertext to simulate a rotated encryption key. */
  corrupt(provider: string): void;
}

let root = '';
const openHandles: DbHandle[] = [];
let harnessCounter = 0;

/** Each test gets its own on-disk database so ordering never matters. */
function createHarness(): Harness {
  harnessCounter += 1;
  const file = path.join(root, `credentials-${harnessCounter}.sqlite`);
  const handle = createDb(file);
  openHandles.push(handle);
  runMigrations(handle.sqlite);

  const repository = new CredentialRepository(handle.db);
  const key = randomBytes(32);
  const logger = createTestLogger();
  const events = new EventBus();

  return {
    handle,
    repository,
    logger,
    events,
    key,
    service: new CredentialService(repository, key, logger, events),
    rawValue: (provider: string) => repository.byProvider(provider)?.value,
    corrupt: (provider: string) => {
      handle.db
        .update(providerCredentials)
        .set({ value: `${ENCRYPTED_PREFIX}AAAA:BBBB:CCCC` })
        .where(eq(providerCredentials.provider, provider))
        .run();
    },
  };
}

function makeRow(overrides: Partial<ProviderCredentialRow>): ProviderCredentialRow {
  return {
    id: 1,
    provider: 'linkedin',
    kind: 'cookies',
    value: 'enc:v1:x',
    status: 'valid',
    cookieCount: 1,
    domains: ['.linkedin.com'],
    expiresAt: null,
    lastCheckedAt: null,
    lastUsedAt: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function byName(bundle: CredentialBundle, name: string): PlaywrightCookie | undefined {
  return bundle.cookies.find((cookie) => cookie.name === name);
}

function saveCookies(harness: Harness, provider: string, value: string, kind: CredentialKind) {
  return harness.service.save({ provider, kind, value });
}

/** Seconds in the far future / far past, well clear of any test clock drift. */
const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
const PAST_SECONDS = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-credentials-test-'));
});

afterAll(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // A test may have closed it already; cleanup must not fail the run.
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('parseCredentialValue: raw Cookie header', () => {
  it('parses a single pair', () => {
    const bundle = parseCredentialValue('cookies', 'linkedin', 'li_at=AQEDATest123');

    expect(bundle.cookies).toHaveLength(1);
    expect(bundle.origins).toEqual([]);
    expect(bundle.header).toBeUndefined();
    // A header paste carries no attributes, so known LinkedIn cookies get the
    // ones the site actually sets. `li_at` is Secure + HttpOnly + SameSite=None;
    // a `Lax` li_at is withheld on LinkedIn's cross-site navigations.
    expect(bundle.cookies[0]).toEqual({
      name: 'li_at',
      value: 'AQEDATest123',
      domain: '.linkedin.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
  });

  it('falls back to secure + Lax for a cookie with no known attributes', () => {
    const bundle = parseCredentialValue('cookies', 'linkedin', 'lidc=b=OB1');

    expect(bundle.cookies[0]).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  });

  it('parses many pairs, extra whitespace, quotes and a trailing semicolon', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      '   li_at =  AQEDATest123 ;   JSESSIONID="ajax:9876543210" ;;  lidc=b=OB1  ;  ',
    );

    expect(bundle.cookies.map((cookie) => cookie.name)).toEqual([
      'li_at',
      'JSESSIONID',
      'lidc',
    ]);
    expect(byName(bundle, 'li_at')?.value).toBe('AQEDATest123');
    // Surrounding quotes are stripped but an inner colon survives.
    expect(byName(bundle, 'JSESSIONID')?.value).toBe('ajax:9876543210');
    // Only the first `=` separates; the rest belongs to the value.
    expect(byName(bundle, 'lidc')?.value).toBe('b=OB1');
  });

  it('tolerates a leading "Cookie:" prefix in any casing', () => {
    const lower = parseCredentialValue('cookies', 'indeed', 'cookie: CTK=abc; SESSION=def');
    const upper = parseCredentialValue('cookies', 'indeed', '  Cookie:CTK=abc; SESSION=def');

    expect(lower.cookies.map((cookie) => cookie.name)).toEqual(['CTK', 'SESSION']);
    expect(upper.cookies).toEqual(lower.cookies);
    expect(lower.cookies.every((cookie) => cookie.domain === '.indeed.com')).toBe(true);
  });

  it('keeps the last paste of a duplicated cookie name', () => {
    const bundle = parseCredentialValue('cookies', 'linkedin', 'li_at=first; li_at=second');

    expect(bundle.cookies).toHaveLength(1);
    expect(bundle.cookies[0]?.value).toBe('second');
  });

  it('skips segments with no name or no separator', () => {
    const bundle = parseCredentialValue('cookies', 'linkedin', 'li_at=ok; garbage; =novalue; x=1');

    expect(bundle.cookies.map((cookie) => cookie.name)).toEqual(['li_at', 'x']);
  });
});

describe('parseCredentialValue: cookie extension JSON array', () => {
  const editThisCookie = JSON.stringify([
    {
      domain: '.linkedin.com',
      expirationDate: FUTURE_SECONDS + 1000,
      hostOnly: false,
      httpOnly: true,
      name: 'li_at',
      path: '/',
      sameSite: 'no_restriction',
      secure: true,
      session: false,
      value: 'AQEDATest123',
    },
    {
      domain: '.www.linkedin.com',
      expirationDate: FUTURE_SECONDS,
      hostOnly: false,
      httpOnly: false,
      name: 'lidc',
      path: '/feed',
      sameSite: 'lax',
      secure: true,
      session: false,
      value: 'b=OB1',
    },
    {
      domain: 'linkedin.com',
      hostOnly: true,
      name: 'bcookie',
      sameSite: 'strict',
      session: true,
      value: 'v=2',
    },
  ]);

  it('maps every EditThisCookie field onto the Playwright shape', () => {
    const bundle = parseCredentialValue('cookies', 'linkedin', editThisCookie);

    expect(bundle.cookies).toHaveLength(3);
    expect(byName(bundle, 'li_at')).toEqual({
      name: 'li_at',
      value: 'AQEDATest123',
      domain: '.linkedin.com',
      path: '/',
      expires: FUTURE_SECONDS + 1000,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
    expect(byName(bundle, 'lidc')?.path).toBe('/feed');
    expect(byName(bundle, 'lidc')?.sameSite).toBe('Lax');
    expect(byName(bundle, 'lidc')?.httpOnly).toBe(false);
    expect(bundle.origins).toEqual([]);
  });

  it('translates every sameSite spelling', () => {
    const cases: [unknown, string][] = [
      ['no_restriction', 'None'],
      ['none', 'None'],
      ['None', 'None'],
      ['strict', 'Strict'],
      ['STRICT', 'Strict'],
      ['lax', 'Lax'],
      ['unspecified', 'Lax'],
      [undefined, 'Lax'],
      [42, 'Lax'],
    ];

    for (const [input, expected] of cases) {
      const bundle = parseCredentialValue(
        'cookies',
        'linkedin',
        JSON.stringify([{ name: 'a', value: 'b', sameSite: input }]),
      );
      expect(bundle.cookies[0]?.sameSite).toBe(expected);
    }
  });

  it('drops the leading dot only when hostOnly is true', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      JSON.stringify([
        { name: 'host', value: '1', domain: '.linkedin.com', hostOnly: true },
        { name: 'wide', value: '2', domain: '.linkedin.com', hostOnly: false },
        { name: 'bare', value: '3', domain: 'www.linkedin.com', hostOnly: true },
      ]),
    );

    expect(byName(bundle, 'host')?.domain).toBe('linkedin.com');
    expect(byName(bundle, 'wide')?.domain).toBe('.linkedin.com');
    expect(byName(bundle, 'bare')?.domain).toBe('www.linkedin.com');
  });

  it('accepts expiry as seconds, milliseconds, a numeric string or an RFC date', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      JSON.stringify([
        { name: 'seconds', value: '1', expirationDate: 1893456000 },
        { name: 'millis', value: '2', expirationDate: 1893456000000 },
        { name: 'numericString', value: '3', expirationDate: '1893456000' },
        { name: 'rfc', value: '4', expirationDate: '2030-01-01T00:00:00.000Z' },
        { name: 'fractional', value: '5', expirationDate: 1893456000.87 },
      ]),
    );

    for (const name of ['seconds', 'millis', 'numericString', 'rfc', 'fractional']) {
      expect(byName(bundle, name)?.expires).toBe(1893456000);
    }
  });

  it('treats session cookies and unparseable expiries as -1', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      JSON.stringify([
        { name: 'session', value: '1', session: true, expirationDate: FUTURE_SECONDS },
        { name: 'missing', value: '2' },
        { name: 'junk', value: '3', expirationDate: 'not-a-date' },
        { name: 'negative', value: '4', expires: -1 },
      ]),
    );

    expect(bundle.cookies.map((cookie) => cookie.expires)).toEqual([-1, -1, -1, -1]);
  });

  it('reads the alternate key/expires/expiry field names', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'indeed',
      JSON.stringify([
        { key: 'CTK', value: 'abc', expires: FUTURE_SECONDS },
        { name: 'SESSION', value: 'def', expiry: FUTURE_SECONDS },
      ]),
    );

    expect(byName(bundle, 'CTK')?.expires).toBe(FUTURE_SECONDS);
    expect(byName(bundle, 'SESSION')?.expires).toBe(FUTURE_SECONDS);
  });

  it('skips entries with a missing or non-string name or value', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      JSON.stringify([
        { name: 'good', value: 'yes' },
        { name: '   ', value: 'blank name' },
        { name: 'numeric', value: 12345 },
        { value: 'nameless' },
        'not-an-object',
        null,
      ]),
    );

    expect(bundle.cookies.map((cookie) => cookie.name)).toEqual(['good']);
  });
});

describe('parseCredentialValue: Playwright storageState', () => {
  const storageState = JSON.stringify({
    cookies: [
      {
        name: 'li_at',
        value: 'AQEDATest123',
        domain: '.linkedin.com',
        path: '/',
        expires: FUTURE_SECONDS,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'bcookie',
        value: 'v=2',
        domain: 'www.linkedin.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: 'https://www.linkedin.com',
        localStorage: [
          { name: 'voyager', value: '{"a":1}' },
          { name: 'broken' },
          'nope',
        ],
      },
      { origin: 'https://static.linkedin.com' },
      { localStorage: [] },
    ],
  });

  it('keeps cookies and origins together', () => {
    const bundle = parseCredentialValue('storage_state', 'linkedin', storageState);

    expect(bundle.cookies.map((cookie) => cookie.name)).toEqual(['li_at', 'bcookie']);
    expect(byName(bundle, 'li_at')?.sameSite).toBe('None');
    expect(byName(bundle, 'bcookie')?.expires).toBe(-1);
    expect(bundle.origins).toEqual([
      {
        origin: 'https://www.linkedin.com',
        localStorage: [{ name: 'voyager', value: '{"a":1}' }],
      },
      { origin: 'https://static.linkedin.com', localStorage: [] },
    ]);
  });

  it('accepts a storageState that only carries origins', () => {
    const bundle = parseCredentialValue(
      'storage_state',
      'linkedin',
      JSON.stringify({ cookies: [], origins: [{ origin: 'https://www.linkedin.com' }] }),
    );

    expect(bundle.cookies).toEqual([]);
    expect(bundle.origins).toHaveLength(1);
  });

  it('is lenient about a mislabelled kind', () => {
    // Users routinely pick "cookies" and then paste a storageState file.
    const bundle = parseCredentialValue('cookies', 'linkedin', storageState);
    expect(bundle.cookies).toHaveLength(2);
    expect(bundle.origins).toHaveLength(2);
  });
});

describe('parseCredentialValue: tokens and headers', () => {
  it('accepts a bare bearer token and normalises the header', () => {
    const bundle = parseCredentialValue('bearer_token', 'workday', 'abc.def.ghi');

    expect(bundle.cookies).toEqual([]);
    expect(bundle.origins).toEqual([]);
    expect(bundle.header).toEqual({ name: 'Authorization', value: 'Bearer abc.def.ghi' });
  });

  it('strips an existing Bearer prefix in any casing rather than doubling it', () => {
    for (const raw of ['Bearer abc.def.ghi', 'bearer   abc.def.ghi', 'BEARER abc.def.ghi']) {
      expect(parseCredentialValue('bearer_token', 'workday', raw).header).toEqual({
        name: 'Authorization',
        value: 'Bearer abc.def.ghi',
      });
    }
  });

  it('parses a "Name: value" header pair', () => {
    const bundle = parseCredentialValue('header', 'greenhouse', '  X-Api-Key:   abc123  ');

    expect(bundle.header).toEqual({ name: 'X-Api-Key', value: 'abc123' });
    expect(bundle.cookies).toEqual([]);
  });

  it('keeps colons inside a header value', () => {
    const bundle = parseCredentialValue('header', 'greenhouse', 'X-Trace: id:123:456');
    expect(bundle.header).toEqual({ name: 'X-Trace', value: 'id:123:456' });
  });
});

describe('parseCredentialValue: rejections', () => {
  function messageFor(kind: CredentialKind, provider: string, raw: string): string {
    try {
      parseCredentialValue(kind, provider, raw);
    } catch (error) {
      if (error instanceof ValidationError) return error.message;
      throw error;
    }
    throw new Error('expected parseCredentialValue to throw');
  }

  it('rejects an empty or whitespace-only paste', () => {
    expect(() => parseCredentialValue('cookies', 'linkedin', '   \n\t ')).toThrow(ValidationError);
    expect(messageFor('cookies', 'linkedin', '')).toBe('The pasted credential is empty.');
  });

  it('rejects a JSON array with no usable cookies and says how to fix it', () => {
    const message = messageFor('cookies', 'linkedin', '[{"foo":"bar"},{"value":"orphan"}]');

    expect(message).toContain('no usable cookies');
    expect(message).toContain('"name"');
    expect(message).toContain('"value"');
    expect(() => parseCredentialValue('cookies', 'linkedin', '[]')).toThrow(ValidationError);
  });

  it('rejects a JSON object that is not a storageState', () => {
    const message = messageFor('storage_state', 'linkedin', '{"session":"abc","user":1}');

    expect(message).toContain('storageState');
    expect(message).toContain('"cookies"');
    expect(message).toContain('"origins"');
  });

  it('rejects a bearer token containing whitespace', () => {
    const message = messageFor('bearer_token', 'workday', 'abc def ghi');

    expect(message).toContain('bearer token');
    expect(message).toContain('Bearer');
  });

  it('rejects a header without a colon separator', () => {
    expect(messageFor('header', 'greenhouse', 'X-Api-Key abc123')).toContain('"Name: value"');
    expect(messageFor('header', 'greenhouse', ': novalue')).toContain('"Name: value"');
    expect(messageFor('header', 'greenhouse', 'X-Api-Key:')).toContain('"Name: value"');
  });

  it('rejects free-form garbage pasted as cookies', () => {
    const message = messageFor('cookies', 'linkedin', 'I logged in already, please just work');

    expect(message).toContain('Could not read a single cookie');
    expect(message).toContain('storageState');
    expect(() => parseCredentialValue('cookies', 'linkedin', '12345')).toThrow(ValidationError);
    expect(() => parseCredentialValue('cookies', 'linkedin', 'null')).toThrow(ValidationError);
  });

  it('throws ValidationError with a 400 status code', () => {
    try {
      parseCredentialValue('cookies', 'linkedin', 'nonsense');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error instanceof ValidationError ? error.statusCode : 0).toBe(400);
      expect(error instanceof ValidationError ? error.code : '').toBe('validation_error');
    }
  });
});

describe('parseCredentialValue: domain inference', () => {
  it('uses the known domain for each supported provider', () => {
    expect(parseCredentialValue('cookies', 'linkedin', 'a=1').cookies[0]?.domain).toBe(
      '.linkedin.com',
    );
    expect(parseCredentialValue('cookies', 'indeed', 'a=1').cookies[0]?.domain).toBe('.indeed.com');
  });

  it('falls back to a dotted provider domain for anything else', () => {
    expect(parseCredentialValue('cookies', 'Workday', 'a=1').cookies[0]?.domain).toBe(
      '.workday.com',
    );
    expect(parseCredentialValue('cookies', 'boards.greenhouse', 'a=1').cookies[0]?.domain).toBe(
      '.boards.greenhouse.com',
    );
  });

  it('applies the inferred domain to JSON entries that omit one', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'indeed',
      JSON.stringify([{ name: 'CTK', value: 'abc' }, { name: 'X', value: 'y', domain: '   ' }]),
    );

    expect(bundle.cookies.every((cookie) => cookie.domain === '.indeed.com')).toBe(true);
  });

  it('defaults path to "/" and sameSite to Lax', () => {
    const bundle = parseCredentialValue(
      'cookies',
      'linkedin',
      JSON.stringify([{ name: 'a', value: '1' }, { name: 'b', value: '2', path: '' }]),
    );

    expect(bundle.cookies.map((cookie) => cookie.path)).toEqual(['/', '/']);
    expect(bundle.cookies.map((cookie) => cookie.sameSite)).toEqual(['Lax', 'Lax']);
    expect(bundle.cookies.map((cookie) => cookie.httpOnly)).toEqual([false, false]);
    expect(bundle.cookies.map((cookie) => cookie.secure)).toEqual([false, false]);
  });
});

describe('CredentialService.save derivation', () => {
  it('records cookieCount, sorted unique domains and the earliest expiry', () => {
    const harness = createHarness();

    const dto = saveCookies(
      harness,
      'linkedin',
      JSON.stringify([
        { name: 'li_at', value: 'a', domain: '.linkedin.com', expirationDate: FUTURE_SECONDS },
        {
          name: 'lidc',
          value: 'b',
          domain: '.www.linkedin.com',
          expirationDate: FUTURE_SECONDS - 500,
        },
        {
          name: 'bcookie',
          value: 'c',
          domain: '.linkedin.com',
          expirationDate: FUTURE_SECONDS + 900,
        },
      ]),
      'cookies',
    );

    expect(dto.cookieCount).toBe(3);
    expect(dto.domains).toEqual(['.linkedin.com', '.www.linkedin.com']);
    expect(dto.expiresAt).toBe(new Date((FUTURE_SECONDS - 500) * 1000).toISOString());
    expect(dto.status).toBe('valid');
    expect(dto.summary).toContain('3 cookies');
  });

  it('ignores session cookies when deriving the expiry', () => {
    const harness = createHarness();

    const dto = saveCookies(
      harness,
      'linkedin',
      JSON.stringify([
        { name: 'session', value: 'a', session: true },
        { name: 'li_at', value: 'b', expirationDate: FUTURE_SECONDS },
      ]),
      'cookies',
    );

    expect(dto.cookieCount).toBe(2);
    expect(dto.expiresAt).toBe(new Date(FUTURE_SECONDS * 1000).toISOString());
  });

  it('leaves expiresAt null when every cookie is a session cookie', () => {
    const harness = createHarness();
    const dto = saveCookies(harness, 'linkedin', 'li_at=abc; JSESSIONID=xyz', 'cookies');

    expect(dto.cookieCount).toBe(2);
    expect(dto.expiresAt).toBeNull();
    expect(isExpired(harness.repository.byProvider('linkedin') ?? makeRow({}))).toBe(false);
  });

  it('normalises the provider name and stores a single row per provider', () => {
    const harness = createHarness();

    saveCookies(harness, '  LinkedIn  ', 'li_at=first', 'cookies');
    const second = saveCookies(harness, 'linkedin', 'li_at=second; lidc=b', 'cookies');

    expect(second.provider).toBe('linkedin');
    expect(harness.repository.list()).toHaveLength(1);
    expect(second.cookieCount).toBe(2);
    expect(harness.service.load('linkedin')?.cookies[0]?.value).toBe('second');
  });

  it('describes a bearer token credential without any cookies', () => {
    const harness = createHarness();
    const dto = harness.service.save({
      provider: 'workday',
      kind: 'bearer_token',
      value: 'abc.def.ghi',
      note: 'from devtools',
    });

    expect(dto.cookieCount).toBe(0);
    expect(dto.domains).toEqual([]);
    expect(dto.expiresAt).toBeNull();
    expect(dto.note).toBe('from devtools');
    expect(dto.summary).toContain('bearer token');
  });

  it('logs the save without logging the secret', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', 'li_at=SUPERSECRETVALUE', 'cookies');

    const saved = entriesFor(harness.logger, 'info', 'credential.saved');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.context).toMatchObject({ provider: 'linkedin', kind: 'cookies' });
    expect(JSON.stringify(saved[0]?.context)).not.toContain('SUPERSECRETVALUE');
  });
});

describe('CredentialService encryption round-trip', () => {
  const secretValue = 'AQEDATest-SUPERSECRETVALUE-0123456789';

  it('stores ciphertext and never the cleartext cookie', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', `li_at=${secretValue}`, 'cookies');

    const raw = harness.rawValue('linkedin');
    expect(raw?.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(raw).not.toContain(secretValue);
    expect(raw).not.toContain('li_at');
    expect(decryptSecret(raw ?? '', harness.key)).toContain(secretValue);
  });

  it('load() returns the canonical bundle unchanged across the round-trip', () => {
    const harness = createHarness();
    const parsed = parseCredentialValue(
      'storage_state',
      'linkedin',
      JSON.stringify({
        cookies: [
          {
            name: 'li_at',
            value: secretValue,
            domain: '.linkedin.com',
            path: '/',
            expires: FUTURE_SECONDS,
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
          { name: 'bcookie', value: 'v=2', domain: 'linkedin.com', expires: -1 },
        ],
        origins: [
          { origin: 'https://www.linkedin.com', localStorage: [{ name: 'voyager', value: '1' }] },
        ],
      }),
    );

    harness.service.save({
      provider: 'linkedin',
      kind: 'storage_state',
      value: JSON.stringify({ cookies: parsed.cookies, origins: parsed.origins }),
    });

    expect(harness.service.load('linkedin')).toEqual(parsed);
  });

  it('round-trips a header credential', () => {
    const harness = createHarness();
    harness.service.save({ provider: 'workday', kind: 'bearer_token', value: 'abc.def.ghi' });

    expect(harness.service.load('workday')).toEqual({
      cookies: [],
      origins: [],
      header: { name: 'Authorization', value: 'Bearer abc.def.ghi' },
    });
  });

  it('returns undefined for an unknown provider', () => {
    const harness = createHarness();
    expect(harness.service.load('nobody')).toBeUndefined();
    expect(harness.service.get('nobody')).toBeUndefined();
  });

  it('marks the credential invalid when the ciphertext cannot be decrypted', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', `li_at=${secretValue}`, 'cookies');
    harness.corrupt('linkedin');

    expect(harness.service.load('linkedin')).toBeUndefined();
    expect(harness.repository.byProvider('linkedin')?.status).toBe('invalid');
    expect(
      entriesFor(harness.logger, 'error', 'stored credential could not be decrypted'),
    ).toHaveLength(1);
  });

  it('never exposes the stored value through the DTO', () => {
    const harness = createHarness();
    const dto = saveCookies(harness, 'linkedin', `li_at=${secretValue}`, 'cookies');
    const row = harness.repository.byProvider('linkedin');

    for (const projection of [dto, harness.service.get('linkedin'), harness.service.list()[0]]) {
      expect(projection).toBeDefined();
      expect(Object.keys(projection ?? {})).not.toContain('value');
      const serialised = JSON.stringify(projection);
      expect(serialised).not.toContain(secretValue);
      expect(serialised).not.toContain(ENCRYPTED_PREFIX);
      expect(serialised).not.toContain(row?.value ?? 'unreachable');
    }

    expect(Object.keys(toProviderCredentialDto(makeRow({ value: 'enc:v1:secret' })))).not.toContain(
      'value',
    );
  });
});

describe('CredentialService.cookieHeader', () => {
  function seed(harness: Harness): void {
    harness.service.save({
      provider: 'linkedin',
      kind: 'storage_state',
      value: JSON.stringify({
        cookies: [
          { name: 'li_at', value: 'A1', domain: '.linkedin.com', expires: FUTURE_SECONDS },
          { name: 'host_only', value: 'B2', domain: 'www.linkedin.com', expires: -1 },
          { name: 'other', value: 'C3', domain: '.indeed.com', expires: FUTURE_SECONDS },
          { name: 'stale', value: 'D4', domain: '.linkedin.com', expires: PAST_SECONDS },
        ],
        origins: [],
      }),
    });
  }

  it('includes leading-dot domains for the host and its subdomains', () => {
    const harness = createHarness();
    seed(harness);

    expect(harness.service.cookieHeader('linkedin', 'https://www.linkedin.com/jobs')).toBe(
      'li_at=A1; host_only=B2',
    );
    expect(harness.service.cookieHeader('linkedin', 'https://linkedin.com/feed')).toBe('li_at=A1');
  });

  it('excludes cookies belonging to a different registrable domain', () => {
    const harness = createHarness();
    seed(harness);

    expect(harness.service.cookieHeader('linkedin', 'https://www.indeed.com/jobs')).toBe(
      'other=C3',
    );
    expect(harness.service.cookieHeader('linkedin', 'https://notlinkedin.com/')).toBeUndefined();
    expect(harness.service.cookieHeader('linkedin', 'https://example.com/')).toBeUndefined();
  });

  it('drops cookies whose expiry has already passed but keeps session cookies', () => {
    const harness = createHarness();
    seed(harness);

    const header = harness.service.cookieHeader('linkedin', 'https://www.linkedin.com/jobs') ?? '';
    expect(header).not.toContain('stale');
    expect(header).toContain('host_only=B2');
  });

  it('is case-insensitive about the host', () => {
    const harness = createHarness();
    seed(harness);

    expect(harness.service.cookieHeader('linkedin', 'https://WWW.LinkedIn.COM/jobs')).toBe(
      'li_at=A1; host_only=B2',
    );
  });

  it('returns undefined for a malformed url, an unknown provider or a cookieless bundle', () => {
    const harness = createHarness();
    seed(harness);
    harness.service.save({ provider: 'workday', kind: 'bearer_token', value: 'abc.def' });

    expect(harness.service.cookieHeader('linkedin', 'not a url')).toBeUndefined();
    expect(harness.service.cookieHeader('nobody', 'https://www.linkedin.com/')).toBeUndefined();
    expect(harness.service.cookieHeader('workday', 'https://workday.com/')).toBeUndefined();
  });
});

describe('isExpired', () => {
  it('treats a null or unparseable expiry as not expired', () => {
    expect(isExpired(makeRow({ expiresAt: null }))).toBe(false);
    expect(isExpired(makeRow({ expiresAt: 'sometime next week' }))).toBe(false);
  });

  it('is true at and after the boundary, false before it', () => {
    const now = Date.now();
    expect(isExpired(makeRow({ expiresAt: new Date(now + HOUR_MS).toISOString() }))).toBe(false);
    expect(isExpired(makeRow({ expiresAt: new Date(now + 5000).toISOString() }))).toBe(false);
    // The boundary itself counts as expired: `at <= now`.
    expect(isExpired(makeRow({ expiresAt: new Date(now).toISOString() }))).toBe(true);
    expect(isExpired(makeRow({ expiresAt: new Date(now - 1).toISOString() }))).toBe(true);
    expect(isExpired(makeRow({ expiresAt: new Date(now - HOUR_MS).toISOString() }))).toBe(true);
  });
});

describe('CredentialService.checkExpiry', () => {
  it('demotes lapsed credentials once and leaves live ones alone', () => {
    const harness = createHarness();
    saveCookies(
      harness,
      'linkedin',
      JSON.stringify([{ name: 'li_at', value: 'a', expirationDate: PAST_SECONDS }]),
      'cookies',
    );
    saveCookies(
      harness,
      'indeed',
      JSON.stringify([{ name: 'CTK', value: 'b', expirationDate: FUTURE_SECONDS }]),
      'cookies',
    );

    const lapsed = harness.service.checkExpiry();

    expect(lapsed.map((row) => row.provider)).toEqual(['linkedin']);
    expect(lapsed[0]?.status).toBe('expired');
    expect(lapsed[0]?.note).toContain('Session expired at');
    expect(lapsed[0]?.lastCheckedAt).not.toBeNull();
    expect(harness.repository.byProvider('indeed')?.status).toBe('valid');

    const warnings = entriesFor(harness.logger, 'warn', 'credential.expired');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({ providers: ['linkedin'] });

    // A second sweep is a no-op: the row is already marked expired.
    expect(harness.service.checkExpiry()).toEqual([]);
    expect(entriesFor(harness.logger, 'warn', 'credential.expired')).toHaveLength(1);
  });

  it('does nothing for session-only credentials with no expiry at all', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', 'li_at=abc', 'cookies');

    expect(harness.service.checkExpiry()).toEqual([]);
    expect(harness.repository.byProvider('linkedin')?.status).toBe('valid');
  });

  it('re-pasting a fresh session clears the expired status', () => {
    const harness = createHarness();
    saveCookies(
      harness,
      'linkedin',
      JSON.stringify([{ name: 'li_at', value: 'old', expirationDate: PAST_SECONDS }]),
      'cookies',
    );
    harness.service.checkExpiry();
    expect(harness.repository.byProvider('linkedin')?.status).toBe('expired');

    const refreshed = saveCookies(
      harness,
      'linkedin',
      JSON.stringify([{ name: 'li_at', value: 'new', expirationDate: FUTURE_SECONDS }]),
      'cookies',
    );

    expect(refreshed.status).toBe('valid');
    expect(refreshed.lastCheckedAt).toBeNull();
    expect(harness.service.checkExpiry()).toEqual([]);
  });
});

describe('CredentialService lifecycle helpers', () => {
  it('expiringSoon only reports valid credentials inside the window', () => {
    const harness = createHarness();
    const soonSeconds = Math.floor((Date.now() + HOUR_MS) / 1000);

    saveCookies(
      harness,
      'linkedin',
      JSON.stringify([{ name: 'li_at', value: 'a', expirationDate: soonSeconds }]),
      'cookies',
    );
    saveCookies(
      harness,
      'indeed',
      JSON.stringify([{ name: 'CTK', value: 'b', expirationDate: FUTURE_SECONDS }]),
      'cookies',
    );

    expect(harness.service.expiringSoon(6 * HOUR_MS).map((row) => row.provider)).toEqual([
      'linkedin',
    ]);
    expect(harness.service.expiringSoon(60 * 1000)).toEqual([]);

    harness.service.setStatus('linkedin', 'invalid', 'revoked by the user');
    expect(harness.service.expiringSoon(6 * HOUR_MS)).toEqual([]);
  });

  it('markUsed, setStatus and delete write through to the row', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', 'li_at=abc', 'cookies');

    harness.service.markUsed('linkedin');
    expect(harness.repository.byProvider('linkedin')?.lastUsedAt).not.toBeNull();

    harness.service.setStatus('linkedin', 'invalid', 'challenge page returned');
    const invalid = harness.service.get('linkedin');
    expect(invalid?.status).toBe('invalid');
    expect(invalid?.note).toBe('challenge page returned');

    harness.service.delete('linkedin');
    expect(harness.service.list()).toEqual([]);
    expect(entriesFor(harness.logger, 'info', 'credential.deleted')).toHaveLength(1);
  });

  it('lists every provider in provider order', () => {
    const harness = createHarness();
    saveCookies(harness, 'linkedin', 'li_at=abc', 'cookies');
    saveCookies(harness, 'indeed', 'CTK=abc', 'cookies');

    expect(harness.service.list().map((dto) => dto.provider)).toEqual(['indeed', 'linkedin']);
  });
});
