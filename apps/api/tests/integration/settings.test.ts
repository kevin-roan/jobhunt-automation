import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SECRET_SETTING_PATHS,
  settingsSchema,
  type Settings,
} from '@deedy/shared';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EventBus } from '../../src/core/events.js';
import type { LogContext, Logger } from '../../src/core/logger.js';
import { maskSecret } from '../../src/core/crypto.js';
import { SettingsRepository } from '../../src/repositories/settings.repository.js';
import { SettingsService } from '../../src/services/settings.service.js';

const ENCRYPTED_PREFIX = 'enc:v1:';

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
  repository: SettingsRepository;
  service: SettingsService;
  logger: RecordingLogger;
  events: EventBus;
  key: Buffer;
  /** Fresh service over the same file, to prove a value was actually persisted. */
  reopen(): SettingsService;
  rawValue(key: string): { value: string; encrypted: boolean } | undefined;
}

let root = '';
const openHandles: DbHandle[] = [];
let harnessCounter = 0;

/** Each test gets its own on-disk database so ordering never matters. */
function createHarness(): Harness {
  harnessCounter += 1;
  const file = path.join(root, `settings-${harnessCounter}.sqlite`);
  const handle = createDb(file);
  openHandles.push(handle);
  runMigrations(handle.sqlite);

  const repository = new SettingsRepository(handle.db);
  const key = randomBytes(32);
  const logger = createTestLogger();
  const events = new EventBus();

  return {
    handle,
    repository,
    logger,
    events,
    key,
    service: new SettingsService(repository, key, logger, events),
    reopen: () => new SettingsService(repository, key, createTestLogger(), events),
    rawValue: (settingKey: string) => {
      const row = repository.get(settingKey);
      return row ? { value: row.value, encrypted: row.encrypted } : undefined;
    },
  };
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors the service's own flattening so we can assert on stored row keys. */
function flattenKeys(value: PlainObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, val] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) out.push(...flattenKeys(val, dotted));
    else out.push(dotted);
  }
  return out;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deedy-settings-test-'));
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

describe('SettingsService.bootstrap', () => {
  it('seeds a row for every default settings key', () => {
    const harness = createHarness();
    expect(harness.repository.all()).toHaveLength(0);

    harness.service.bootstrap();

    const expected = flattenKeys(DEFAULT_SETTINGS as unknown as PlainObject).sort();
    const stored = harness.repository
      .all()
      .map((row) => row.key)
      .sort();

    expect(expected.length).toBeGreaterThan(50);
    expect(stored).toEqual(expected);
    expect(stored).toContain('llm.model');
    expect(stored).toContain('application.minScoreToApply');
    expect(stored).toContain('search.keywords');
  });

  it('is idempotent and never clobbers existing values', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { model: 'qwen2.5:14b' } });

    const before = harness.repository.all().length;
    const rebooted = harness.reopen().bootstrap();

    expect(harness.repository.all()).toHaveLength(before);
    expect(rebooted.llm.model).toBe('qwen2.5:14b');
  });

  it('returns a fully valid Settings object from get()', () => {
    const harness = createHarness();
    const bootstrapped = harness.service.bootstrap();

    expect(settingsSchema.safeParse(bootstrapped).success).toBe(true);
    expect(harness.service.get()).toEqual(DEFAULT_SETTINGS);

    const settings: Settings = harness.service.get();
    expect(settings.llm.provider).toBe(DEFAULT_SETTINGS.llm.provider);
    expect(settings.browser.dryRun).toBe(true);
    expect(Array.isArray(settings.search.remotePreference)).toBe(true);
    expect(settings.application.defaultResumeId).toBeNull();
  });

  it('reads scalars back with their original JSON types', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    const settings = harness.service.get();

    expect(typeof settings.queue.concurrency).toBe('number');
    expect(typeof settings.browser.headless).toBe('boolean');
    expect(typeof settings.profile.fullName).toBe('string');
  });
});

describe('SettingsService.update', () => {
  it('deep-merges a partial patch without dropping sibling keys', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    const updated = harness.service.update({
      llm: { model: 'llama3.1:8b', temperature: 0.7 },
      search: { keywords: ['typescript', 'platform engineer'] },
    });

    expect(updated.llm.model).toBe('llama3.1:8b');
    expect(updated.llm.temperature).toBe(0.7);
    // Untouched siblings inside the patched section survive the merge.
    expect(updated.llm.maxTokens).toBe(DEFAULT_SETTINGS.llm.maxTokens);
    expect(updated.llm.baseUrl).toBe(DEFAULT_SETTINGS.llm.baseUrl);
    // Untouched sections survive too.
    expect(updated.queue).toEqual(DEFAULT_SETTINGS.queue);
    expect(updated.search.keywords).toEqual(['typescript', 'platform engineer']);
    expect(updated.search.postedWithinDays).toBe(DEFAULT_SETTINGS.search.postedWithinDays);
  });

  it('persists changes to SQLite, not just to the in-memory cache', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ scheduler: { retentionDays: 7 }, queue: { paused: true } });

    const fresh = harness.reopen().get();
    expect(fresh.scheduler.retentionDays).toBe(7);
    expect(fresh.queue.paused).toBe(true);

    expect(harness.rawValue('scheduler.retentionDays')).toEqual({ value: '7', encrypted: false });
    expect(harness.rawValue('queue.paused')).toEqual({ value: 'true', encrypted: false });
  });

  it('only writes the keys that actually changed and emits settings.updated', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    const sections: string[][] = [];
    harness.events.on('settings.updated', (payload) => sections.push(payload.sections));

    harness.service.update({ browser: { headless: false } });
    expect(sections).toEqual([['browser']]);

    const writes = entriesFor(harness.logger, 'info', 'settings updated');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.context).toMatchObject({ keys: ['browser.headless'] });

    // A no-op patch must not emit or write again.
    harness.service.update({ browser: { headless: false } });
    expect(sections).toHaveLength(1);
  });

  it('rejects a patch that violates the schema', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    expect(() => harness.service.update({ llm: { temperature: 99 } })).toThrow();
    expect(harness.service.get().llm.temperature).toBe(DEFAULT_SETTINGS.llm.temperature);
  });
});

describe('SettingsService secrets', () => {
  const API_KEY = 'sk-local-gateway-0123456789-abcdef';

  it('stores llm.apiKey encrypted at rest and decrypts it through get()', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });

    const raw = harness.rawValue('llm.apiKey');
    expect(raw).toBeDefined();
    expect(raw?.encrypted).toBe(true);
    expect(raw?.value.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(raw?.value).not.toContain(API_KEY);

    expect(harness.service.get().llm.apiKey).toBe(API_KEY);
    // And from a cold service reading the same rows.
    expect(harness.reopen().get().llm.apiKey).toBe(API_KEY);
    expect(harness.service.secret('llm.apiKey')).toBe(API_KEY);
  });

  it('encrypts every declared secret path that has a non-empty value', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    // Every declared secret path must be populated here, so adding a new one
    // without encrypting it fails this test rather than leaking silently.
    harness.service.update({
      llm: { apiKey: API_KEY },
      notifications: { webhookUrl: 'http://localhost:8080/hook/abcd1234' },
      vpn: {
        connectCommand: 'openvpn --config /etc/vpn.conf --auth-user-pass /etc/vpn.creds',
        disconnectCommand: 'pkill openvpn',
        statusCommand: 'pgrep openvpn',
      },
      sync: {
        secretKey: 'sb_secret_test_value_1234567890',
        url: 'https://project-ref.supabase.co',
        publishableKey: 'sb_publishable_test_value_123456',
        userId: '4f9c2c1e-2f1a-4f6a-9a3f-2c9d5b7e1a10',
      },
    });

    for (const secretPath of SECRET_SETTING_PATHS) {
      const raw = harness.rawValue(secretPath);
      expect(raw?.encrypted).toBe(true);
      expect(raw?.value.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    }
  });

  it('leaves an empty secret stored as plain JSON', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    const raw = harness.rawValue('llm.apiKey');
    expect(raw).toEqual({ value: '""', encrypted: false });
    expect(harness.service.get().llm.apiKey).toBe('');
  });

  it('masks secrets in getRedacted() while get() stays in cleartext', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });

    const redacted = harness.service.getRedacted();
    expect(redacted.llm.apiKey).toBe(maskSecret(API_KEY));
    expect(redacted.llm.apiKey).not.toBe(API_KEY);
    expect(redacted.llm.apiKey.endsWith(API_KEY.slice(-4))).toBe(true);
    // Non-secret values are untouched and the object is still a valid Settings.
    expect(redacted.llm.baseUrl).toBe(DEFAULT_SETTINGS.llm.baseUrl);
    expect(settingsSchema.safeParse(redacted).success).toBe(true);

    // getRedacted must not mutate the cached settings.
    expect(harness.service.get().llm.apiKey).toBe(API_KEY);
  });

  it('does not mask an empty secret', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    expect(harness.service.getRedacted().llm.apiKey).toBe('');
  });

  it('ignores a masked secret submitted back through update()', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });
    const encryptedBefore = harness.rawValue('llm.apiKey')?.value;

    // The UI round-trips whatever getRedacted() gave it.
    const result = harness.service.update({
      llm: { apiKey: harness.service.getRedacted().llm.apiKey, model: 'mistral-nemo' },
    });

    expect(result.llm.apiKey).toBe(API_KEY);
    expect(result.llm.model).toBe('mistral-nemo');
    expect(harness.rawValue('llm.apiKey')?.value).toBe(encryptedBefore);
    expect(harness.reopen().get().llm.apiKey).toBe(API_KEY);
  });

  it('overwrites the secret when a genuinely new value is submitted', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });
    const encryptedBefore = harness.rawValue('llm.apiKey')?.value;

    harness.service.update({ llm: { apiKey: 'sk-rotated-key-9876543210' } });

    const raw = harness.rawValue('llm.apiKey');
    expect(raw?.value).not.toBe(encryptedBefore);
    expect(raw?.encrypted).toBe(true);
    expect(harness.service.get().llm.apiKey).toBe('sk-rotated-key-9876543210');
  });

  it('clears a secret when an empty string is submitted', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });
    harness.service.update({ llm: { apiKey: '' } });

    expect(harness.service.get().llm.apiKey).toBe('');
    expect(harness.rawValue('llm.apiKey')).toEqual({ value: '""', encrypted: false });
  });

  it('returns an empty secret rather than throwing when the ciphertext is unreadable', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { apiKey: API_KEY } });

    // Simulates a rotated or lost ENCRYPTION_KEY.
    harness.repository.set('llm.apiKey', `${ENCRYPTED_PREFIX}AAAA:BBBB:CCCC`, true);
    harness.service.invalidate();

    expect(harness.service.get().llm.apiKey).toBe('');
    const failures = entriesFor(
      harness.logger,
      'error',
      'failed to decrypt setting; returning empty value',
    );
    expect(failures.map((entry) => entry.context)).toContainEqual({ key: 'llm.apiKey' });
  });
});

describe('SettingsService resilience', () => {
  it('falls back to defaults instead of throwing when a stored value is invalid', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    harness.service.update({ llm: { model: 'llama3.1:8b' } });

    // Out of the schema's allowed range; could only come from a hand-edited db.
    harness.repository.set('llm.temperature', JSON.stringify(42), false);
    harness.service.invalidate();

    const settings = harness.service.get();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.llm.temperature).toBe(DEFAULT_SETTINGS.llm.temperature);
    const warnings = entriesFor(
      harness.logger,
      'warn',
      'stored settings failed validation, falling back to defaults for invalid keys',
    );
    expect(warnings).toHaveLength(1);
    expect(Array.isArray(warnings[0]?.context?.issues)).toBe(true);
  });

  it('falls back to defaults when a stored value has the wrong type', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    harness.repository.set('queue.concurrency', JSON.stringify('two'), false);
    harness.service.invalidate();

    expect(() => harness.service.get()).not.toThrow();
    expect(harness.service.get().queue.concurrency).toBe(DEFAULT_SETTINGS.queue.concurrency);
  });

  it('tolerates a non-JSON stored value by treating it as a raw string', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    harness.repository.set('profile.fullName', 'Ada Lovelace', false);
    harness.service.invalidate();

    expect(harness.service.get().profile.fullName).toBe('Ada Lovelace');
  });

  it('recovers keys deleted from the table by falling back to the default', () => {
    const harness = createHarness();
    harness.service.bootstrap();

    harness.repository.delete('scheduler.retentionDays');
    harness.service.invalidate();

    expect(harness.service.get().scheduler.retentionDays).toBe(
      DEFAULT_SETTINGS.scheduler.retentionDays,
    );
  });

  it('invalidate() forces the next get() to re-read SQLite', () => {
    const harness = createHarness();
    harness.service.bootstrap();
    expect(harness.service.get().browser.locale).toBe(DEFAULT_SETTINGS.browser.locale);

    harness.repository.set('browser.locale', JSON.stringify('en-GB'), false);
    expect(harness.service.get().browser.locale).toBe(DEFAULT_SETTINGS.browser.locale);

    harness.service.invalidate();
    expect(harness.service.get().browser.locale).toBe('en-GB');
  });
});
