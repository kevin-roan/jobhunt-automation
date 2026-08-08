import type { NotificationDto, NotificationKind, NotificationLevel } from '@deedy/shared';
import type { Logger } from '../core/logger.js';
import { REDACTED, Redactor } from '../core/redact.js';
import { dayKey, nowIso } from '../core/utils.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import type { SettingsService } from './settings.service.js';

export interface NotificationPayload {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface NotificationRecordInput {
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body?: string;
  entityType?: string | null;
  entityId?: number | null;
  actionable?: boolean;
  dedupeKey?: string | null;
  /** Extra context for the webhook only. Never persisted, never synced. */
  data?: Record<string, unknown>;
}

interface JobRef {
  id?: number;
  title: string;
  company: string;
}

/**
 * Structural view of the sync outbox. Declared here so the notification layer
 * depends on a behaviour rather than on the sync service, and so it can be
 * constructed without one when the mirror is not in play.
 */
export interface NotificationSyncSink {
  enqueueNotification(notificationId: number): void;
}

/**
 * Hostnames that are local by convention rather than by address: mDNS names,
 * the container/VM suffixes the usual self-hosted stacks hand out, and the
 * reserved `.home.arpa` for residential networks.
 */
const LOCAL_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'] as const;

function isLocalIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 0) return true; // loopback, and "this host"
  if (a === 10) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isLocalIpv6(host: string): boolean {
  const address = host.toLowerCase();
  if (address === '::1' || address === '::') return true;
  // IPv4-mapped (`::ffff:127.0.0.1`) is still an IPv4 destination — but `URL`
  // has already rewritten the dotted tail into hextets (`::ffff:7f00:1`) by the
  // time we see it, so the hex form is the one that has to be understood.
  const mapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1] as string, 16);
    const low = Number.parseInt(mapped[2] as string, 16);
    return isLocalIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isLocalIpv4(dotted[1] as string);
  if (/^f[cd]/.test(address)) return true; // fc00::/7, unique local
  if (/^fe[89ab]/.test(address)) return true; // fe80::/10, link-local
  return false;
}

/**
 * Whether a URL's host is somewhere on this machine or this LAN.
 *
 * A bare, dot-less hostname counts as local on purpose: this project's own
 * compose file addresses sibling containers by service name (`http://ntfy:8080`)
 * and there is no such thing as a single-label name on the public internet, so
 * rejecting them would break the intended deployment while blocking nothing.
 */
function isLocalWebhookHost(hostname: string): boolean {
  // `URL.hostname` keeps the brackets around an IPv6 literal.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.length === 0) return false;
  if (host === 'localhost') return true;
  if (host.includes(':')) return isLocalIpv6(host);
  if (/^\d/.test(host) && /^[\d.]+$/.test(host)) return isLocalIpv4(host);
  if (!host.includes('.')) return true;
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Resolves the configured webhook, or explains why it will not be used.
 *
 * The setting has always been documented as a local-only webhook but nothing
 * enforced it, so a typo — or a copied-in ntfy.sh URL — silently shipped job
 * titles and failure text off the machine. Enforcement is a hard restriction to
 * private destinations rather than an opt-in flag: an opt-in would mean a new
 * settings key, and "nothing leaves this host" is a property of the product, not
 * a preference. Exported so it can be tested directly.
 */
export function resolveWebhookTarget(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `notifications.webhookUrl is not a valid URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `notifications.webhookUrl must be http or https, got ${parsed.protocol}` };
  }
  if (!isLocalWebhookHost(parsed.hostname)) {
    return {
      error:
        `notifications.webhookUrl points at ${parsed.hostname}, which is not on this host or LAN. ` +
        `Notifications quote job titles and error text, so only loopback, private (RFC1918), ` +
        `link-local or single-label/.local hosts are allowed.`,
    };
  }
  return { url: parsed.toString() };
}

/** Deep enough for the shapes a caller realistically passes; guards cycles. */
const MAX_DATA_DEPTH = 4;

/**
 * Mirrors the key-name rule in `maskContext`: a value under a key that names a
 * credential is dropped outright rather than scrubbed, because the value
 * scrubber only knows the two secrets the host has stored.
 */
const SECRET_KEY_PATTERN = /(api[-_]?key|password|passwd|secret|token|authorization|cookie)/i;

/**
 * Durable notification feed plus an optional push to a user-supplied local
 * webhook (ntfy, gotify, Home Assistant…). The row in SQLite is the source of
 * truth so the dashboard and phone have something to read; the webhook is a
 * best-effort side channel and nothing is sent unless the user configured one.
 */
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    private readonly sync?: NotificationSyncSink,
  ) {
    this.redactor = new Redactor(settingsService);
  }

  /**
   * The webhook is the one notification sink that is a network call, and its
   * strings are assembled from whatever failed deep in the pipeline: a
   * Playwright error names the field it was filling and quotes the value, an ATS
   * echoes the address it rejected. The SQLite row keeps the real text — the
   * dashboard exists to show the user what happened — and only the copy that
   * crosses a socket is scrubbed.
   */
  private readonly redactor: Redactor;

  /** Low-level entry point: persist first, then push. */
  async record(input: NotificationRecordInput): Promise<NotificationDto | undefined> {
    const saved = this.persist(input);
    await this.sendWebhook({
      title: input.title,
      message: input.body ?? '',
      level: toPayloadLevel(input.level),
      data: {
        ...input.data,
        kind: input.kind,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });
    return saved;
  }

  /** Kept for callers that just want a free-form message on the feed. */
  async notify(payload: NotificationPayload): Promise<void> {
    this.persist({
      kind: 'system',
      level: payload.level,
      title: payload.title,
      body: payload.message,
    });
    await this.sendWebhook(payload);
  }

  async applicationSubmitted(job: JobRef, dryRun: boolean): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnApplied) return;
    await this.record({
      kind: 'application.submitted',
      level: 'success',
      title: dryRun ? 'Application prepared (dry run)' : 'Application submitted',
      body: `${job.title} at ${job.company}`,
      entityType: 'job',
      entityId: job.id ?? null,
      dedupeKey: dedupe('application.submitted', job.id, dryRun ? 'dry' : 'live'),
    });
  }

  async applicationFailed(job: JobRef, error: string): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnFailure) return;
    await this.record({
      kind: 'application.failed',
      level: 'error',
      title: 'Application failed',
      body: `${job.title} at ${job.company}: ${error}`,
      entityType: 'job',
      entityId: job.id ?? null,
      actionable: true,
      dedupeKey: dedupe('application.failed', job.id),
    });
  }

  async needsHuman(job: JobRef, reason: string): Promise<void> {
    if (!this.settingsService.get().notifications.notifyOnNeedsHuman) return;
    await this.record({
      kind: 'application.needs_human',
      level: 'warning',
      title: 'Application needs you',
      body: `${job.title} at ${job.company}: ${reason}`,
      entityType: 'job',
      entityId: job.id ?? null,
      actionable: true,
      dedupeKey: dedupe('application.needs_human', job.id),
    });
  }

  async highScore(job: JobRef, score: number): Promise<void> {
    const settings = this.settingsService.get().notifications;
    if (!settings.notifyOnHighScore || score < settings.highScoreThreshold) return;
    await this.record({
      kind: 'job.high_score',
      level: 'info',
      title: `High match: ${score}`,
      body: `${job.title} at ${job.company}`,
      entityType: 'job',
      entityId: job.id ?? null,
      dedupeKey: dedupe('job.high_score', job.id),
    });
  }

  async credentialExpired(provider: string): Promise<void> {
    await this.record({
      kind: 'credential.expired',
      level: 'warning',
      title: `${provider} session expired`,
      body: `Automation for ${provider} is paused. Open Settings and paste a fresh session cookie to resume.`,
      entityType: 'credential',
      actionable: true,
      // One reminder per provider per day rather than one per failed attempt.
      dedupeKey: `credential.expired:${provider}:${dayKey(nowIso())}`,
    });
  }

  async collectorFailed(collectorId: string, error: string): Promise<void> {
    await this.record({
      kind: 'collector.failed',
      level: 'error',
      title: `Collector failed: ${collectorId}`,
      body: error,
      entityType: 'collector',
      actionable: true,
      dedupeKey: `collector.failed:${collectorId}:${dayKey(nowIso())}`,
    });
  }

  async queueStalled(count: number): Promise<void> {
    await this.record({
      kind: 'queue.stalled',
      level: 'warning',
      title: 'Queue stalled',
      body: `${count} queued ${count === 1 ? 'task has' : 'tasks have'} not progressed. Check the worker.`,
      entityType: 'queue',
      actionable: true,
      dedupeKey: `queue.stalled:${nowIso().slice(0, 13)}`,
    });
  }

  private persist(input: NotificationRecordInput): NotificationDto | undefined {
    try {
      const saved = this.notifications.create({
        kind: input.kind,
        level: input.level,
        title: input.title,
        body: input.body ?? '',
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actionable: input.actionable ?? false,
        dedupeKey: input.dedupeKey ?? null,
      });
      // Mirroring is opt-in and filtered downstream; the outbox row is the only
      // thing created here, so a disabled mirror costs nothing.
      this.sync?.enqueueNotification(saved.id);
      return saved;
    } catch (error) {
      // Losing a notification must never break the pipeline that raised it.
      this.logger.warn('notification persist failed', {
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Every value that is about to be serialised, with the PII taken out. */
  private scrubValue(value: unknown, depth: number): unknown {
    if (depth > MAX_DATA_DEPTH) return '[depth-limit]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.redactor.text(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((item) => this.scrubValue(item, depth + 1));
    if (value instanceof Error) return this.redactor.text(value.message);
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : this.scrubValue(val, depth + 1);
      }
      return out;
    }
    // A function, symbol or bigint has no place on the wire; name it, don't send it.
    return `[${typeof value}]`;
  }

  private scrub(payload: NotificationPayload): NotificationPayload {
    return {
      title: this.redactor.text(payload.title),
      message: this.redactor.text(payload.message),
      level: payload.level,
      data:
        payload.data === undefined
          ? undefined
          : (this.scrubValue(payload.data, 0) as Record<string, unknown>),
    };
  }

  private async sendWebhook(payload: NotificationPayload): Promise<void> {
    const settings = this.settingsService.get().notifications;
    if (!settings.enabled || !settings.webhookUrl.trim()) return;

    const target = resolveWebhookTarget(settings.webhookUrl);
    if ('error' in target) {
      // Refusing is the whole point, so this is an error rather than a warning —
      // but it still must not break the pipeline that raised the notification.
      this.logger.error('notification webhook refused', { reason: target.error });
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...this.scrub(payload), source: 'deedy-automation' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // A failing webhook must never break the pipeline.
      this.logger.warn('notification webhook failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toPayloadLevel(level: NotificationLevel): NotificationPayload['level'] {
  return level === 'success' ? 'info' : level;
}

/** Undefined when there is no entity to key on, so the row is never collapsed. */
function dedupe(kind: NotificationKind, id: number | undefined, suffix?: string): string | null {
  if (id === undefined) return null;
  return suffix ? `${kind}:${id}:${suffix}` : `${kind}:${id}`;
}
