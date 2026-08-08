import {
  resolveSessionStrategy,
  type EffectiveSessionStrategy,
  type QueueJobDto,
  type SourceStatusDto,
} from '@deedy/shared';
import type { BrowserManager } from '../browser/browser.manager.js';
import type { CollectorRegistry } from '../collectors/registry.js';
import { NotFoundError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { AnalyticsRepository } from '../repositories/analytics.repository.js';
import type {
  BrowserSessionRepository,
  CollectorRunRepository,
} from '../repositories/browser.repository.js';
import type { BrowserSessionRow } from '../db/schema.js';
import type { QueueRepository } from '../repositories/queue.repository.js';
import { REQUIRED_COOKIES, type CredentialService } from './credential.service.js';
import type { SettingsService } from './settings.service.js';

/** Enough to cover every collect job the queue can realistically hold at once. */
const QUEUE_SCAN_PAGE_SIZE = 200;

/**
 * "unknown" is not "signed out": a profile that has never been probed has no
 * evidence either way, and telling the user to sign in when they may already be
 * signed in is exactly the wrong advice.
 */
type SignInState = 'in' | 'out' | 'unknown';

function probedSignIn(row: BrowserSessionRow | undefined): SignInState {
  // `lastCheckAt` is the timestamp the probe writes alongside `loggedIn`, so a
  // row created by `ensure()` and never checked still reads as unknown.
  if (!row || row.lastCheckAt === null) return 'unknown';
  return row.loggedIn ? 'in' : 'out';
}

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
    // Attended mode keeps the session in the browser profile rather than the
    // credential vault, so the probed sign-in state is the only truthful source
    // for "can this collector actually run?".
    private readonly browserSessions: BrowserSessionRepository,
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
    // Resolved once for the whole list: every tile has to agree about which
    // session a run would use, and re-deriving it per source invites drift.
    const strategy = resolveSessionStrategy(settings.browser);
    const jobStats = this.analytics.perSourceJobStats();
    const lastRuns = this.collectorRuns.latestByCollector();
    const running = this.runningCollectorIds();
    const openProviders = new Set(this.browser.openProviders());
    // One read for the whole list: a query per source would scale with the
    // registry (built-ins plus plugins).
    const probedSessions = new Map(
      this.browserSessions.list().map((row) => [row.provider, row]),
    );

    return this.registry.all().map((collector) => {
      const boards = settings.search.boards[collector.source] ?? [];
      // Mirrors the allowlist rule the registry itself applies: an explicit
      // `enabledCollectors` wins, otherwise a collector runs when it is configured.
      const enabled =
        settings.search.enabledCollectors.length > 0
          ? settings.search.enabledCollectors.includes(collector.id)
          : planned.has(collector.id);

      // The DTO carries status only - the credential value never leaves the vault.
      //
      // Under the attended strategy the vault is not consulted by the run path
      // at all, so reporting a row from it would put a status on the tile that
      // nothing acts on: a stale "expired" beside a window that is signed in
      // and collecting fine. No lookup, no credential, no false alarm.
      const usesVault = collector.requiresAuth && strategy === 'stored';
      const stored = usesVault ? this.credentials.get(collector.source) : undefined;
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
          sourceName: collector.name,
          requiresAuth: collector.requiresAuth,
          requiresBoards: collector.requiresBoards,
          boards,
          credentialStatus: credential?.status ?? null,
          hasCredential: credential !== null,
          strategy,
          signedIn: probedSignIn(probedSessions.get(collector.source)),
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
    sourceName: string;
    requiresAuth: boolean;
    requiresBoards: boolean;
    boards: string[];
    credentialStatus: string | null;
    hasCredential: boolean;
    strategy: EffectiveSessionStrategy;
    signedIn: SignInState;
    activeKeywords: number;
  }): string | null {
    if (input.activeKeywords === 0) {
      return 'No search keywords are enabled. Add keywords under Keywords and enable at least one.';
    }
    if (input.requiresBoards && input.boards.length === 0) {
      return `No company boards configured. Add slugs under Settings → Search → Boards → ${input.source}.`;
    }
    if (input.requiresAuth && input.strategy === 'attended') {
      // Under the attended strategy the session lives in the shared browser
      // profile, not in the credential vault, so a source with no stored
      // credential is routinely working perfectly. Judging it by the vault
      // would show a false "No session saved" blocker; the probe is the only
      // honest signal.
      if (input.signedIn === 'in') return null;
      if (input.signedIn === 'out') {
        return `Not signed in to ${input.sourceName}. Open the Browser page and press Sign in; the window is already open.`;
      }
      return 'Sign-in state unknown. Open the Browser page and press Re-check.';
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
