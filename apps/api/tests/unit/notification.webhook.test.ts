import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NotificationDto, type Settings } from '@deedy/shared';
import type { LogContext, Logger } from '../../src/core/logger.js';
import type { CreateNotificationInput, NotificationRepository } from '../../src/repositories/notification.repository.js';
import { NotificationService, resolveWebhookTarget } from '../../src/services/notification.service.js';
import type { SettingsService } from '../../src/services/settings.service.js';

const CANDIDATE = {
  fullName: 'Jonathan Fairweather',
  firstName: 'Jonathan',
  lastName: 'Fairweather',
  email: 'jonathan.fairweather@example.com',
  phone: '+44 7700 900123',
  city: 'Manchester',
  postalCode: 'M15 4FN',
} as const;

interface LogEntry {
  level: string;
  message: string;
  context: LogContext | undefined;
}

function createTestLogger(entries: LogEntry[]): Logger {
  const record = (level: string) => (message: string, context?: LogContext) => {
    entries.push({ level, message, context });
  };
  const logger: Logger = {
    scope: 'test',
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

interface Harness {
  service: NotificationService;
  /** Everything handed to the repository, i.e. what lands in SQLite. */
  stored: CreateNotificationInput[];
  logs: LogEntry[];
  fetchMock: ReturnType<typeof vi.fn>;
  /** Parsed body of the single webhook POST, or undefined if none was made. */
  sentBody(): Record<string, unknown> | undefined;
}

function createHarness(webhookUrl: string, enabled = true): Harness {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    profile: { ...DEFAULT_SETTINGS.profile, ...CANDIDATE },
    notifications: { ...DEFAULT_SETTINGS.notifications, enabled, webhookUrl },
  };
  const settingsService = { get: () => settings } as unknown as SettingsService;

  const stored: CreateNotificationInput[] = [];
  let nextId = 1;
  const repository = {
    create: (input: CreateNotificationInput): NotificationDto => {
      stored.push(input);
      return {
        id: nextId++,
        kind: input.kind,
        level: input.level,
        title: input.title,
        body: input.body ?? '',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actionable: input.actionable ?? false,
        read: false,
        createdAt: new Date().toISOString(),
      };
    },
  } as unknown as NotificationRepository;

  const logs: LogEntry[] = [];
  const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  return {
    service: new NotificationService(repository, settingsService, createTestLogger(logs)),
    stored,
    logs,
    fetchMock,
    sentBody: () => {
      const call = fetchMock.mock.calls[0] as [string, { body: string }] | undefined;
      if (!call) return undefined;
      return JSON.parse(call[1].body) as Record<string, unknown>;
    },
  };
}

const JOB = { id: 7, title: 'Staff Engineer', company: 'Globex' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveWebhookTarget', () => {
  it.each([
    ['loopback v4', 'http://127.0.0.1:8080/topic'],
    ['loopback name', 'http://localhost:8080/topic'],
    ['loopback v6', 'http://[::1]:8080/topic'],
    ['RFC1918 10/8', 'http://10.0.0.5:8080/'],
    ['RFC1918 192.168/16', 'http://192.168.1.20:8080/'],
    ['RFC1918 172.16/12', 'http://172.20.0.3:8080/'],
    ['link-local', 'http://169.254.10.1/'],
    ['unique local v6', 'http://[fd12:3456::1]:8080/'],
    // `URL` rewrites this to `[::ffff:7f00:1]` before the guard ever sees it.
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]:8080/'],
    // The compose file addresses sibling containers by service name.
    ['docker service name', 'http://ntfy:8080/deedy'],
    ['mDNS', 'http://nas.local:8080/'],
    ['container suffix', 'https://gotify.internal/message'],
  ])('allows %s', (_label, url) => {
    expect(resolveWebhookTarget(url)).toEqual({ url: new URL(url).toString() });
  });

  it.each([
    ['public hostname', 'https://ntfy.sh/my-topic'],
    ['public IPv4', 'http://8.8.8.8:8080/'],
    ['public IPv6', 'http://[2606:4700:4700::1111]/'],
    ['IPv4-mapped public address', 'http://[::ffff:8.8.8.8]/'],
    // 172.32 is outside the RFC1918 block; an off-by-one here leaks.
    ['just outside RFC1918', 'http://172.32.0.1:8080/'],
    ['credentialed public host', 'https://user:pw@hooks.example.com/x'],
  ])('refuses %s', (_label, url) => {
    const result = resolveWebhookTarget(url);
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain('notifications.webhookUrl');
  });

  it('refuses a non-http scheme', () => {
    const result = resolveWebhookTarget('file:///etc/passwd');
    expect('error' in result && result.error).toContain('must be http or https');
  });

  it('refuses a value that is not a URL at all', () => {
    expect('error' in resolveWebhookTarget('not a url')).toBe(true);
  });
});

describe('NotificationService webhook payload', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness('http://127.0.0.1:8080/deedy');
  });

  it('redacts the candidate email out of a failure body before sending', async () => {
    // Verbatim shape of a real ATS/Playwright failure: it quotes the value it
    // was filling, which is the candidate's address.
    const error = `Timeout filling #email with "${CANDIDATE.email}" (${CANDIDATE.phone})`;
    await harness.service.applicationFailed(JOB, error);

    const body = harness.sentBody();
    expect(body).toBeDefined();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(CANDIDATE.email);
    expect(serialised).not.toContain('900123');
    expect(serialised).toContain('[REDACTED:email]');
    expect(serialised).toContain('[REDACTED:phone]');
    // Operational context must survive, otherwise the webhook is useless.
    expect(serialised).toContain('Staff Engineer');
    expect(serialised).toContain('Globex');
  });

  it('redacts the candidate name out of a needs-human reason', async () => {
    await harness.service.needsHuman(JOB, `Unanswerable question for ${CANDIDATE.fullName}`);
    const serialised = JSON.stringify(harness.sentBody());
    expect(serialised).not.toContain(CANDIDATE.fullName);
    expect(serialised).toContain('[REDACTED:name]');
  });

  it('redacts caller-supplied data and drops credential-shaped keys', async () => {
    await harness.service.record({
      kind: 'system',
      level: 'info',
      title: 'Manual',
      body: 'body',
      data: {
        applicant: CANDIDATE.email,
        nested: { note: `call ${CANDIDATE.phone}`, list: [CANDIDATE.city] },
        sessionCookie: 'li_at=abcdef',
        attempts: 2,
      },
    });

    const body = harness.sentBody();
    const data = body?.data as Record<string, unknown>;
    expect(data.applicant).toBe('[REDACTED:email]');
    expect(JSON.stringify(data.nested)).not.toContain('900123');
    expect(JSON.stringify(data.nested)).not.toContain(CANDIDATE.city);
    expect(data.sessionCookie).toBe('[REDACTED]');
    // Non-PII structure is untouched, including the routing fields `record` adds.
    expect(data.attempts).toBe(2);
    expect(data.entityType).toBe(null);
  });

  it('keeps the real text in the locally stored row', async () => {
    const error = `Timeout filling #email with "${CANDIDATE.email}"`;
    await harness.service.applicationFailed(JOB, error);

    expect(harness.stored).toHaveLength(1);
    const row = harness.stored[0] as CreateNotificationInput;
    // The dashboard is local and must show the user what actually happened.
    expect(row.body).toContain(CANDIDATE.email);
    expect(row.kind).toBe('application.failed');
    expect(row.entityId).toBe(JOB.id);
    expect(row.actionable).toBe(true);
    expect(row.dedupeKey).toBe('application.failed:7');
  });
});

describe('NotificationService webhook destination', () => {
  it('posts to a loopback host', async () => {
    const harness = createHarness('http://127.0.0.1:8080/deedy');
    await harness.service.applicationSubmitted(JOB, false);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a remote host and says which setting is at fault', async () => {
    const harness = createHarness('https://ntfy.sh/my-topic');
    await harness.service.applicationFailed(JOB, `boom for ${CANDIDATE.email}`);

    expect(harness.fetchMock).not.toHaveBeenCalled();
    const refusal = harness.logs.find((entry) => entry.message === 'notification webhook refused');
    expect(refusal?.level).toBe('error');
    expect(JSON.stringify(refusal?.context)).toContain('notifications.webhookUrl');
    // Refusing to send must not cost the local record.
    expect(harness.stored).toHaveLength(1);
  });

  it('sends nothing when notifications are disabled', async () => {
    const harness = createHarness('http://127.0.0.1:8080/deedy', false);
    await harness.service.applicationSubmitted(JOB, false);
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });
});
