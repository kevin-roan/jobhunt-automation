import type {
  BrowserSessionControlInput,
  BrowserSessionStatus,
  ProviderSessionDto,
} from '@deedy/shared';
import { resolveSessionStrategy } from '@deedy/shared';
import type { BrowserManager } from '../browser/browser.manager.js';
import type { CollectorRegistry } from '../collectors/registry.js';
import { ConfigurationError, ValidationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { BrowserSessionRepository } from '../repositories/browser.repository.js';
import type { SettingsService } from './settings.service.js';

/** Everything needed to send the user to a provider's login and to check it later. */
interface ProviderSignIn {
  /** The page a "Sign in" button opens in the attended window. */
  loginUrl: string;
  /** A page that only renders for a signed-in session. */
  probeUrl: string;
  /**
   * Matched against the settled URL and the page text. A hit means the site
   * bounced us to a signed-out view.
   */
  signedOut: RegExp;
}

/**
 * Per-provider sign-in facts.
 *
 * LinkedIn and Indeed are the two sources that block automated login outright —
 * they challenge, rate-limit and authwall a scripted sign-in no matter how the
 * credentials are supplied — which is exactly why attended mode exists: the
 * user signs in by hand, once, in a real window, and the profile on disk keeps
 * the session for every later run.
 */
const PROVIDER_SIGN_IN: Record<string, ProviderSignIn> = {
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    probeUrl: 'https://www.linkedin.com/feed/',
    signedOut: /\/login|\/authwall|\/uas\/login|\/signup|session_redirect/i,
  },
  indeed: {
    loginUrl: 'https://secure.indeed.com/account/login',
    // Must be a page that only a signed-in account can see. The home page is
    // not: it renders the same for a stranger, so probing it reported every
    // machine as signed in. Saved jobs redirects to `secure.indeed.com/auth`
    // when there is no session, which is an unambiguous answer.
    probeUrl: 'https://myjobs.indeed.com/saved',
    // The block page has to count as signed-out. Indeed answers 403 "Request
    // Blocked" (with a Ray ID) to addresses it distrusts, and that page neither
    // redirects to the login URL nor mentions it — so a URL-only test reported
    // a blocked machine as happily signed in, and the Sources page showed no
    // blocker for a source that could not fetch a single listing.
    signedOut: /\/account\/login|secure\.indeed\.com|request blocked|you have been blocked|\bray id\b/i,
  },
};

/**
 * A plugin collector can require auth without this file knowing anything about
 * it. Guessing the conventional login path is better than refusing to open a
 * tab at all — the user can always override it with `url` on the control call.
 */
function signInFor(provider: string): ProviderSignIn {
  const known = PROVIDER_SIGN_IN[provider];
  if (known) return known;
  const origin = `https://www.${provider}.com`;
  return {
    loginUrl: `${origin}/login`,
    probeUrl: `${origin}/`,
    signedOut: /\/login|\/signin|\/sign-in/i,
  };
}

/**
 * The control surface for the one visible browser the user signs into by hand.
 *
 * Nothing here ever reads, logs or returns a cookie: whether a provider is
 * signed in is decided only by navigating to a signed-in-only page and looking
 * at where we land. Credentials are typed by the user into the browser window
 * itself and are never seen by this application.
 */
export class BrowserSessionService {
  /**
   * Opening the window twice is the failure mode this guards: two dashboard
   * clicks arrive within milliseconds of each other and each launches its own
   * Chromium. Every mutating call chains onto this promise instead.
   */
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly browser: BrowserManager,
    private readonly registry: CollectorRegistry,
    private readonly sessions: BrowserSessionRepository,
    private readonly settingsService: SettingsService,
    private readonly logger: Logger,
    /**
     * Viewer for the screen the window is drawn on, when the user is not
     * sitting in front of that screen — noVNC in the container image. Empty on
     * a desktop install.
     */
    private readonly remoteViewUrl: string = '',
  ) {}

  async status(): Promise<BrowserSessionStatus> {
    const settings = this.settingsService.get().browser;
    const displayAvailable = this.browser.displayAvailable();
    const pageUrls = this.browser.openPageUrls();
    const providers = this.providerSessions();

    // Anchor on the first provider that needs a login, so the path shown is one
    // a real session lives in. Under the attended strategy every provider
    // resolves to the same shared directory and the choice of anchor does not
    // matter; with "stored" pinned the profiles are per-provider, so this is the
    // first such provider's profile rather than a single global one.
    const anchor = providers[0]?.provider ?? null;

    return {
      attended: settings.attended,
      sessionStrategy: settings.sessionStrategy,
      // Resolved here rather than in the dashboard so the badge the user reads
      // and the branch the run takes come from the same function.
      effectiveSessionStrategy: resolveSessionStrategy(settings),
      displayAvailable,
      unavailableReason: displayAvailable ? null : this.browser.displayUnavailableReason(),
      // The attended window registers as an open provider context, so an open
      // context is the same question as "is the window up".
      running: this.browser.openProviders().length > 0,
      openPages: pageUrls.length,
      pageUrls,
      engine: settings.engine,
      // Only offered when a window can actually be drawn — a viewer pointed at
      // a display that was never started shows a connection error, which reads
      // as a broken feature rather than a disabled one.
      remoteViewUrl: displayAvailable && this.remoteViewUrl.trim() ? this.remoteViewUrl.trim() : null,
      profilePath: anchor === null ? null : this.browser.activeProfilePath(anchor),
      providers,
    };
  }

  async control(input: BrowserSessionControlInput): Promise<BrowserSessionStatus> {
    switch (input.action) {
      case 'open':
        await this.serialise(async () => {
          this.assertCanOpen();
          await this.browser.openAttended();
          this.logger.info('attended browser window opened');
        });
        break;

      case 'close':
        await this.serialise(async () => {
          await this.browser.closeAttended();
          this.logger.info('attended browser window closed');
        });
        break;

      case 'signin': {
        const provider = this.requireProvider(input.provider);
        await this.serialise(async () => {
          this.assertCanOpen();
          await this.browser.openAttended();
          // The tab is opened and then left alone. The user completes the login
          // by hand in that window: nothing about entering credentials is
          // automated, and this application never sees or stores them.
          await this.browser.openTab(provider, input.url ?? signInFor(provider).loginUrl);
          this.logger.info('opened a sign-in tab for the user to complete by hand', { provider });
        });
        break;
      }

      case 'check': {
        const targets = input.provider
          ? [this.requireProvider(input.provider)]
          : this.providerSessions().map((session) => session.provider);
        await this.serialise(async () => {
          for (const provider of targets) {
            await this.checkProvider(provider);
          }
        });
        break;
      }
    }

    return this.status();
  }

  /** Probes one provider and persists the result. Returns whether it is signed in. */
  async checkProvider(provider: string): Promise<boolean> {
    const { probeUrl, signedOut } = signInFor(provider);
    const signedIn = await this.browser.probeSignedIn(provider, probeUrl, signedOut);
    this.sessions.setLoggedIn(
      provider,
      signedIn,
      signedIn ? null : 'The probe page redirected to a signed-out view. Sign in again.',
    );
    this.logger.info('provider session probed', { provider, signedIn });
    return signedIn;
  }

  /**
   * Every source that needs a login, joined with the last probe result.
   *
   * Deliberately reads the stored result rather than probing: the dashboard
   * polls this, and probing navigates a real page, so probing here would have
   * every poll hammer LinkedIn and Indeed. `check` is what refreshes it.
   */
  private providerSessions(): ProviderSessionDto[] {
    const stored = new Map(this.sessions.list().map((row) => [row.provider, row]));
    const seen = new Set<string>();
    const sessions: ProviderSessionDto[] = [];

    for (const collector of this.registry.all()) {
      if (!collector.requiresAuth) continue;
      // Several collectors can share one source, and one source is one login.
      if (seen.has(collector.source)) continue;
      seen.add(collector.source);

      const row = stored.get(collector.source);
      sessions.push({
        provider: collector.source,
        name: collector.name,
        requiresAuth: true,
        signedIn: row?.loggedIn ?? false,
        checkedAt: row?.lastCheckAt ?? null,
        loginUrl: signInFor(collector.source).loginUrl,
        note: row?.note ?? null,
      });
    }

    return sessions;
  }

  private requireProvider(provider: string | undefined): string {
    const normalized = provider?.trim().toLowerCase();
    if (!normalized) {
      throw new ValidationError('A "provider" is required for this action.');
    }
    return normalized;
  }

  /**
   * Every gate that stops a window from appearing, in the order the user has to
   * clear them: the feature has to be on, the attended profile has to be the
   * session runs actually use, and the host has to have a screen.
   *
   * The middle gate mirrors `BrowserManager.openAttended()` deliberately, so the
   * dashboard refuses with the reason rather than letting the manager throw
   * after the click - see the comment there for why a window under the "stored"
   * strategy would be a profile no collector drives.
   */
  private assertCanOpen(): void {
    const browser = this.settingsService.get().browser;
    if (!browser.attended) {
      throw new ConfigurationError(
        'Attended browsing is off. Turn it on under Settings → Browser to let this app open a window you sign in to yourself.',
      );
    }
    if (resolveSessionStrategy(browser) !== 'attended') {
      throw new ConfigurationError(
        'The session source is set to "stored", so each source runs on its own profile seeded from the session you pasted - a window opened here would not be the session collectors use, and signing in there would change nothing. Fix: set Settings → Browser → session source to "attended" (or to "auto", which follows the attended switch).',
      );
    }
    if (!this.browser.displayAvailable()) {
      const reason = this.browser.displayUnavailableReason();
      throw new ConfigurationError(
        `No display is available for a visible browser${reason ? `: ${reason}` : ''}. Fix: run the API from a desktop session on this host, or use the Docker image, which ships a virtual screen and a noVNC viewer for exactly this.`,
      );
    }
  }

  /** Chains work onto the single in-flight promise so controls cannot interleave. */
  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    // Chain off a settled copy so one failed control does not poison the queue
    // for every later one.
    const next = this.inFlight.then(operation, operation);
    this.inFlight = next.catch(() => undefined);
    return next;
  }
}
