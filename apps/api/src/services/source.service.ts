import type { QueueJobDto, SourceStatusDto } from '@deedy/shared';
import type { BrowserManager } from '../browser/browser.manager.js';
import type { CollectorRegistry } from '../collectors/registry.js';
import { NotFoundError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { AnalyticsRepository } from '../repositories/analytics.repository.js';
import type { CollectorRunRepository } from '../repositories/browser.repository.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import { REQUIRED_COOKIES, type CredentialService } from './credential.service.js';
import type { SettingsService } from './settings.service.js';

/** Enough to cover every collect job the queue can realistically hold at once. */
const QUEUE_SCAN_PAGE_SIZE = 200;

/** The collect job payload the worker and the run route both enqueue. */
function collectorIdOf(job: QueueJobDto): string | null {
  const payload = job.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { collectorId?: unknown }).collectorId;
  return typeof value === 'string' ? value : null;
}

/**
 * The per-platform view of the pipeline. Everything the dashboard needs to
 * answer "why is LinkedIn producing nothing?" without the user reading logs:
 * whether the source is configured, whether its session is alive, when it last
 * ran, what it produced, and the one thing to fix when it cannot run.
 */
export class SourceService {
  constructor(
    private readonly registry: CollectorRegistry,
    private readonly settingsService: SettingsService,
    private readonly credentials: CredentialService,
    private readonly collectorRuns: CollectorRunRepository,
    private readonly analytics: AnalyticsRepository,
    private readonly queue: QueueRepository,
    private readonly browser: BrowserManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Every registered source with everything the dashboard tile needs.
   *
   * The active-keyword count arrives as a callback rather than an injected
   * keyword service: keyword resolution is owned elsewhere, and taking it as a
   * parameter keeps this service free of that dependency (and of the import
   * cycle that would come with it).
   */
  list(activeKeywordsFor: (collectorId: string) => number): SourceStatusDto[] {
    const settings = this.settingsService.get();
    const planned = new Set(
      this.registry
        .enabled(settings.search.enabledCollectors, settings.search.boards)
        .map((collector) => collector.id),
    );
    const jobStats = this.analytics.perSourceJobStats();
    const lastRuns = this.collectorRuns.latestByCollector();
    const running = this.runningCollectorIds();
    const openProviders = new Set(this.browser.openProviders());

    return this.registry.all().map((collector) => {
      const boards = settings.search.boards[collector.source] ?? [];
      // Mirrors the allowlist rule the registry itself applies: an explicit
      // `enabledCollectors` wins, otherwise a collector runs when it is configured.
      const enabled =
        settings.search.enabledCollectors.length > 0
          ? settings.search.enabledCollectors.includes(collector.id)
          : planned.has(collector.id);

      // The DTO carries status only — the credential value never leaves the vault.
      const stored = collector.requiresAuth ? this.credentials.get(collector.source) : undefined;
      const credential = stored
        ? {
            status: stored.status,
            cookieCount: stored.cookieCount,
            expiresAt: stored.expiresAt,
            lastCheckedAt: stored.lastCheckedAt,
          }
        : null;

      const run = lastRuns.get(collector.id);
      const stats = jobStats.get(collector.source);
      const activeKeywords = activeKeywordsFor(collector.id);

      return {
        id: collector.id,
        name: collector.name,
        source: collector.source,
        description: collector.description,
        builtIn: collector.builtIn ?? false,
        enabled,
        requiresAuth: collector.requiresAuth,
        requiresBoards: collector.requiresBoards,
        boards,
        credential,
        browserOpen: openProviders.has(collector.source),
        running: running.has(collector.id),
        lastRun: run
          ? {
              status: run.status,
              found: run.found,
              inserted: run.inserted,
              duplicates: run.duplicates,
              errors: run.errors,
              message: run.message,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
            }
          : null,
        totalJobs: stats?.totalJobs ?? 0,
        jobsToday: stats?.jobsToday ?? 0,
        scoredJobs: stats?.scoredJobs ?? 0,
        averageScore: stats?.averageScore ?? null,
        applications: stats?.applications ?? 0,
        activeKeywords,
        blockedReason: this.blockedReason({
          source: collector.source,
          requiresAuth: collector.requiresAuth,
          requiresBoards: collector.requiresBoards,
          boards,
          credentialStatus: credential?.status ?? null,
          hasCredential: credential !== null,
          activeKeywords,
        }),
      };
    });
  }

  /** Adds or removes a collector from settings.search.enabledCollectors. */
  setEnabled(collectorId: string, enabled: boolean): void {
    if (!this.registry.get(collectorId)) throw new NotFoundError('Collector', collectorId);

    const settings = this.settingsService.get();
    const allowlist = settings.search.enabledCollectors;
    // An empty allowlist means "everything configured runs". Removing one
    // source from that empty list would change nothing, so materialise the
    // currently-planned set first and subtract from it — otherwise "disable
    // LinkedIn" would silently leave LinkedIn enabled.
    const base =
      allowlist.length > 0
        ? allowlist
        : this.registry
            .enabled(allowlist, settings.search.boards)
            .map((collector) => collector.id);

    const next = enabled
      ? Array.from(new Set([...base, collectorId]))
      : base.filter((id) => id !== collectorId);

    this.settingsService.update({ search: { enabledCollectors: next } });
    this.logger.info('collector enablement changed', { collectorId, enabled, count: next.length });
  }

  /** Cancels pending and in-flight collect jobs for one source. Returns how many. */
  stop(collectorId: string): number {
    if (!this.registry.get(collectorId)) throw new NotFoundError('Collector', collectorId);

    let cancelled = 0;
    // Only queued work is cancellable here. A run already claimed by the worker
    // keeps going until the pipeline stop control aborts it — that abort path is
    // owned by the worker, not by this service.
    for (const status of ['pending', 'delayed'] as const) {
      for (const job of this.collectJobs(status)) {
        if (collectorIdOf(job) !== collectorId) continue;
        this.queue.cancel(job.id);
        cancelled += 1;
      }
    }
    this.logger.info('cancelled queued collect jobs for source', { collectorId, cancelled });
    return cancelled;
  }

  /** Collectors the worker is running right now, derived from the active queue. */
  private runningCollectorIds(): Set<string> {
    const ids = new Set<string>();
    for (const job of this.collectJobs('active')) {
      const collectorId = collectorIdOf(job);
      if (collectorId) ids.add(collectorId);
    }
    return ids;
  }

  private collectJobs(status: 'pending' | 'active' | 'delayed'): QueueJobDto[] {
    return this.queue.search({
      page: 1,
      pageSize: QUEUE_SCAN_PAGE_SIZE,
      status,
      task: 'collect.jobs',
    }).items;
  }

  /**
   * The single most useful sentence explaining why this source will produce
   * nothing, in the order the user would have to fix them: no keywords means
   * nothing to search for at all, so it outranks a missing board or session.
   */
  private blockedReason(input: {
    source: string;
    requiresAuth: boolean;
    requiresBoards: boolean;
    boards: string[];
    credentialStatus: string | null;
    hasCredential: boolean;
    activeKeywords: number;
  }): string | null {
    if (input.activeKeywords === 0) {
      return 'No search keywords are enabled. Add keywords under Keywords and enable at least one.';
    }
    if (input.requiresBoards && input.boards.length === 0) {
      return `No company boards configured. Add slugs under Settings → Search → Boards → ${input.source}.`;
    }
    if (input.requiresAuth && !input.hasCredential) {
      return 'No session saved. Paste a signed-in session under Browser Sessions.';
    }
    if (
      input.requiresAuth &&
      (input.credentialStatus === 'expired' || input.credentialStatus === 'invalid')
    ) {
      // Naming the exact cookie turns "session invalid" into something the user
      // can act on; the required names live with the credential service.
      const required = REQUIRED_COOKIES[input.source] ?? [];
      const cookies = required.length > 0 ? ` Include the ${required.join(', ')} cookie.` : '';
      return `The saved session is ${input.credentialStatus}. Paste a fresh one under Browser Sessions.${cookies}`;
    }
    return null;
  }
}
