import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chromium,
  firefox,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import type { BrowserEngine, BrowserSettings, EffectiveSessionStrategy } from '@deedy/shared';
import { resolveSessionStrategy } from '@deedy/shared';
import type { AppPaths } from '../config/env.js';
import type { Logger } from '../core/logger.js';
import { AppError, ConfigurationError } from '../core/errors.js';
import { Redactor } from '../core/redact.js';
import { nowIso, slugify } from '../core/utils.js';
import type { BrowserSessionRepository } from '../repositories/browser.repository.js';
import type { SettingsService } from '../services/settings.service.js';

export interface ProviderContext {
  context: BrowserContext;
  provider: string;
  profilePath: string;
}

/** A cookie in Playwright's `addCookies` shape. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** One origin's localStorage, as it appears in a Playwright storageState. */
export interface BrowserOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export type CredentialStatusValue = 'unknown' | 'valid' | 'expired' | 'invalid';

/**
 * Structural view of the credential store. Declared here (rather than importing
 * credential.service) so the browser layer stays free of a service dependency
 * and can be constructed without one in tests.
 */
export interface CredentialProvider {
  load(provider: string): { cookies: BrowserCookie[]; origins: BrowserOrigin[] } | undefined;
  markUsed(provider: string): void;
  setStatus(provider: string, status: CredentialStatusValue, note?: string | null): void;
}

type PlaywrightCookies = Parameters<BrowserContext['addCookies']>[0];

export interface CaptureResult {
  screenshotPath: string | null;
  htmlPath: string | null;
}

function engineFor(engine: BrowserEngine) {
  return engine === 'firefox' ? firefox : chromium;
}

/**
 * What a neutralised field leaves behind. Labelled like every other redaction
 * on the host, and deliberately not the empty string: "this field held
 * something" is exactly the fact a debugger needs, and dropping the attribute
 * entirely would make a filled field indistinguishable from an untouched one.
 */
export const REDACTED_INPUT = '[REDACTED:input-value]';

/** Inline script bodies are replaced wholesale; see `redactHtmlSnapshot`. */
export const REDACTED_SCRIPT = '[REDACTED:script]';

/**
 * Runs INSIDE the page. Must stay self-contained — Playwright ships its source
 * to the browser, so it can close over nothing, not even an import.
 *
 * This exists because `page.content()` alone does not see what the run typed:
 * `fill()` sets the value IDL property, and the `value` ATTRIBUTE it serialises
 * usually still holds the page's original default. So the live tree is walked
 * here, where the typed values are, and the clone is what gets serialised.
 *
 * The clone is queried with the same selector in the same order as the live
 * tree, which is what makes positional pairing exact — `cloneNode(true)`
 * preserves document order, and nothing mutates the live tree meanwhile.
 */
export function neutraliseLiveFormValues(marker: string): string {
  const selector = 'input, textarea, select, [contenteditable]';
  const root = document.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;
  const live = Array.from(root.querySelectorAll(selector));
  const copies = Array.from(clone.querySelectorAll(selector));

  for (let index = 0; index < live.length && index < copies.length; index += 1) {
    const source = live[index];
    const copy = copies[index];
    if (!source || !copy) continue;

    if (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      // Checked-ness is state, not typed content: it says which radio or box the
      // run selected and carries nothing the candidate wrote, so it survives.
      if (source.type === 'checkbox' || source.type === 'radio') {
        if (source.checked) copy.setAttribute('checked', '');
        else copy.removeAttribute('checked');
        continue;
      }
      copy.setAttribute('value', source.value.length > 0 ? marker : '');
      continue;
    }

    if (source instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.textContent = source.value.length > 0 ? marker : '';
      continue;
    }

    if (source instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      // Which option is selected is the answer to "did the dropdown take?"; the
      // option list is the site's own vocabulary, not the candidate's data.
      const options = copy.querySelectorAll('option');
      for (let option = 0; option < options.length; option += 1) {
        const node = options[option];
        if (!node) continue;
        if (option === source.selectedIndex) node.setAttribute('selected', '');
        else node.removeAttribute('selected');
      }
      continue;
    }

    // `isContentEditable` lives on HTMLElement, not Element — an SVG node can
    // carry the attribute and match the selector without ever having one.
    if (!(source instanceof HTMLElement)) continue;
    if (source.isContentEditable && (source.textContent ?? '').trim().length > 0) {
      copy.textContent = marker;
    }
  }

  // A fixed doctype rather than serialising the real one: every page these
  // collectors touch is HTML5, and the snapshot is read, not re-rendered.
  return `<!DOCTYPE html>\n${clone.outerHTML}`;
}

/** Whole `<input>` tags, so a stray `value=` in a script or URL is left alone. */
const INPUT_TAG_PATTERN = /<input\b[^>]*>/gi;
const VALUE_ATTRIBUTE_PATTERN = /\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+)/gi;
const TEXTAREA_PATTERN = /(<textarea\b[^>]*>)([\s\S]*?)(<\/textarea\s*>)/gi;
const INLINE_SCRIPT_PATTERN = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;

function neutraliseValueAttributes(tag: string, marker: string): string {
  return tag.replace(VALUE_ATTRIBUTE_PATTERN, (attribute: string) => {
    const raw = attribute.slice(attribute.indexOf('=') + 1).trim();
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    const value = quoted ? raw.slice(1, -1) : raw;
    // An already-empty field is not a redaction candidate, and marking it would
    // claim the run filled something it never touched.
    return value.length === 0 ? attribute : ` value="${marker}"`;
  });
}

/**
 * Makes a DOM snapshot safe to keep on disk while leaving it worth keeping.
 *
 * What survives, because it is what a snapshot is FOR — answering "why did this
 * form fill, or not?": every tag, attribute, name, id, class, label, aria text,
 * placeholder, option list, checkbox/radio state and the whole DOM shape.
 *
 * What does not: the values of text-like fields (the candidate's name, email,
 * phone, address, and any hidden CSRF or session token carried as an input),
 * textarea and contenteditable bodies, and inline script bodies — the last
 * because that is where these sites embed a JSON blob of the signed-in viewer
 * and its auth tokens, and because a snapshot with live script in it should not
 * be able to run if someone opens the file in a browser. Script TAGS and their
 * attributes stay, so the shape of the page is unchanged.
 *
 * Finally the whole document goes through the shared `Redactor`, which catches
 * the same PII rendered as ordinary page text ("Signed in as …", a confirmation
 * screen echoing the address) and any address or phone number the host was
 * never told about.
 *
 * Idempotent, and safe to run on markup that has already been through the
 * in-page pass — which is precisely how it is used.
 */
export function redactHtmlSnapshot(html: string, redactor: Redactor): string {
  const neutralised = html
    .replace(INPUT_TAG_PATTERN, (tag: string) => neutraliseValueAttributes(tag, REDACTED_INPUT))
    .replace(
      TEXTAREA_PATTERN,
      (_match: string, open: string, body: string, close: string) =>
        `${open}${body.trim().length === 0 ? body : REDACTED_INPUT}${close}`,
    )
    .replace(
      INLINE_SCRIPT_PATTERN,
      (_match: string, open: string, body: string, close: string) =>
        `${open}${body.trim().length === 0 ? body : `/* ${REDACTED_SCRIPT} */`}${close}`,
    );
  return redactor.text(neutralised);
}

/** Profile key used when every provider shares one cookie jar. */
const SHARED_PROFILE_KEY = 'shared';

/**
 * Owns every Playwright process. Contexts are persistent (one profile directory
 * per provider) so cookies and logins survive restarts and the user never has
 * to authenticate twice.
 *
 * In attended mode there is exactly ONE visible window and ONE profile for all
 * providers: the user signs in to each site by hand in that window, the profile
 * on disk keeps the session, and every later run drives the same profile.
 */
export class BrowserManager {
  /** Keyed by `profileKey(provider)`, not by provider - shared mode collapses them. */
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly launching = new Map<string, Promise<BrowserContext>>();
  /**
   * Which providers are served by each live context. Needed because the context
   * map is keyed by profile: `openProviders()` must still report the provider
   * names its callers passed in, not the profile key they collapsed into.
   */
  private readonly providersByKey = new Map<string, Set<string>>();
  private closed = false;
  /** Scrubs DOM snapshots before they reach disk; see `redactHtmlSnapshot`. */
  private readonly redactor: Redactor;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly sessions: BrowserSessionRepository,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly credentials?: CredentialProvider,
  ) {
    // Built here rather than injected: it must follow the same settings object
    // the manager already reads, so a profile edit takes effect on the next
    // capture without anything having to re-wire it.
    this.redactor = new Redactor(settingsService);
  }

  private settings(): BrowserSettings {
    return this.settingsService.get().browser;
  }

  /** Which session a run treats as authoritative, with `auto` already resolved. */
  private strategy(): EffectiveSessionStrategy {
    return resolveSessionStrategy(this.settings());
  }

  /** True when one profile (and one window) serves every provider. */
  private isShared(settings: BrowserSettings = this.settings()): boolean {
    // The argument only supplies `sharedProfile`; the attended half comes from
    // the resolved strategy, which is read from the live settings either way.
    // Keyed off the strategy, not the `attended` switch: the attended session is
    // one hand-made profile and so cannot be per-provider, but pinning `stored`
    // while the window stays visible means the pasted cookies are authoritative,
    // and those are per-provider - collapsing them would put LinkedIn's and
    // Indeed's sessions in one jar for no reason.
    return this.strategy() === 'attended' || settings.sharedProfile;
  }

  /**
   * The profile a provider resolves to. Everything that is per-browser - the
   * context map, the in-flight launch map, the profile directory - is keyed by
   * this, so in shared mode two providers land on the same live context.
   */
  private profileKey(provider: string): string {
    return this.isShared() ? SHARED_PROFILE_KEY : slugify(provider);
  }

  profilePath(provider: string): string {
    const dir = path.join(this.paths.browserProfiles, this.profileKey(provider));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Absolute profile directory currently in use for a provider. */
  activeProfilePath(provider: string): string {
    return path.resolve(this.profilePath(provider));
  }

  /** Whether a visible window can be opened here at all. */
  displayAvailable(): boolean {
    return Boolean(process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim());
  }

  /** Null when it can, otherwise the reason with the fix. */
  displayUnavailableReason(): string | null {
    if (this.displayAvailable()) return null;
    return 'No graphical display was found (neither DISPLAY nor WAYLAND_DISPLAY is set), so a visible browser window cannot be opened. This is normal on a headless server or in a systemd unit that has no session. Fix: run the API from inside your desktop session, or run the Docker image (it starts a virtual screen and serves it over noVNC), or leave attended mode off and keep using headless runs.';
  }

  private contextOptions(settings: BrowserSettings, headed: boolean): BrowserContextOptions {
    const options: BrowserContextOptions = {
      // A headed window is sized by the window manager; forcing a viewport would
      // letterbox the page inside the window the user is looking at.
      viewport: headed ? null : { width: settings.viewportWidth, height: settings.viewportHeight },
      locale: settings.locale,
      timezoneId: settings.timezone,
      acceptDownloads: true,
      ignoreHTTPSErrors: false,
    };
    // A real headed Chromium already sends a clean UA. Overriding it is exactly
    // how you get a UA/client-hints mismatch that reads as automation, so only
    // an explicitly configured UA is applied.
    if (settings.userAgent.trim()) options.userAgent = settings.userAgent.trim();
    return options;
  }

  /**
   * Returns the persistent context for a provider, launching it on first use.
   * Concurrent callers share a single launch.
   */
  async contextFor(provider: string): Promise<ProviderContext> {
    if (this.closed) throw new AppError('Browser manager has been shut down', 503, 'shutting_down');

    const key = this.profileKey(provider);

    const existing = this.contexts.get(key);
    if (existing) {
      this.trackProvider(key, provider);
      this.sessions.markUsed(provider);
      return { context: existing, provider, profilePath: this.profilePath(provider) };
    }

    const pending = this.launching.get(key);
    if (pending) {
      const context = await pending;
      this.trackProvider(key, provider);
      return { context, provider, profilePath: this.profilePath(provider) };
    }

    const launch = this.launch(provider);
    this.launching.set(key, launch);
    try {
      const context = await launch;
      return { context, provider, profilePath: this.profilePath(provider) };
    } finally {
      this.launching.delete(key);
    }
  }

  private trackProvider(key: string, provider: string): void {
    const known = this.providersByKey.get(key);
    if (known) known.add(provider);
    else this.providersByKey.set(key, new Set([provider]));
  }

  /**
   * Removes the singleton lock a previous Chromium left in a persistent
   * profile, which otherwise makes every later launch fail outright with
   * "The profile appears to be in use by another Chromium process".
   *
   * Chromium writes `SingletonLock` as a symlink named `<hostname>-<pid>` and
   * reclaims it on the next start only when the hostname matches and the pid is
   * gone. That works on a desktop, where the hostname is stable. It does not
   * work in a container: Docker assigns a new random hostname on every
   * recreate, so a lock written before a restart names a host that will never
   * exist again and is never reclaimed. Since the profile is on a persistent
   * volume, one `docker compose up` with the window open used to brick attended
   * mode permanently — the volume had to be edited by hand to recover.
   *
   * Deleting it here is safe precisely because of where this is called from
   * (see the call site) and it is the same thing Chromium would do itself if it
   * could recognise its own corpse. Deliberately not conditional on the
   * hostname matching: relying on the pid check would be worse in a fresh
   * container, where pids restart from 1 and an unrelated live process can
   * easily occupy the recorded number.
   */
  private clearStaleProfileLocks(profilePath: string): void {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const target = path.join(profilePath, name);
      try {
        // lstat, not existsSync: these are symlinks, usually dangling, and
        // existsSync follows the link and so reports a live lock as absent.
        lstatSync(target);
      } catch {
        continue;
      }
      try {
        // The link body is `<hostname>-<pid>`, which is what makes the log line
        // diagnostic rather than just noise.
        const heldBy = name === 'SingletonLock' ? readlinkSync(target) : null;
        rmSync(target, { force: true });
        this.logger.info('removed a stale browser profile lock left by a previous run', {
          profile: path.basename(profilePath),
          lock: name,
          ...(heldBy ? { heldBy } : {}),
        });
      } catch (error) {
        // Not fatal on its own: report it and let the launch produce the real
        // error, which says far more about why the profile is unusable.
        this.logger.warn('could not remove a stale browser profile lock', {
          profile: path.basename(profilePath),
          lock: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async launch(provider: string): Promise<BrowserContext> {
    const settings = this.settings();
    const key = this.profileKey(provider);
    const profilePath = this.profilePath(provider);
    const engine = engineFor(settings.engine);

    // Attended mode needs a graphical session. Falling back to headless keeps
    // collectors running on a headless box instead of failing the launch; the
    // reason is reported through `displayUnavailableReason()`.
    // Deliberately `settings.attended` and not the session strategy: the window
    // is about visibility, not about which session is authoritative. Someone who
    // pins `stored` while attended stays on wants to watch the run happen with
    // their pasted cookies - so this and `isShared()` can legitimately disagree.
    const wantsHeaded = settings.attended;
    const canBeHeaded = this.displayAvailable();
    if (wantsHeaded && !canBeHeaded) {
      this.logger.warn(
        'attended mode requested but no display is available, falling back to headless',
        {
          provider,
          reason: this.displayUnavailableReason(),
        },
      );
    }
    const headed = wantsHeaded && canBeHeaded;

    // Nothing holds this profile: `launch()` is only reached when the context
    // map has no live entry for it, and every context this process owns is in
    // that map. So any lock still on disk is a corpse from a previous process.
    this.clearStaleProfileLocks(profilePath);

    this.logger.info('launching persistent browser context', {
      provider,
      profile: key,
      engine: settings.engine,
      headless: headed ? false : settings.headless,
      attended: headed,
    });

    let context: BrowserContext;
    try {
      context = await engine.launchPersistentContext(profilePath, {
        headless: headed ? false : settings.headless,
        slowMo: settings.slowMoMs,
        // "chrome" uses the branded Google Chrome build when it is installed.
        ...(settings.engine === 'chrome' ? { channel: 'chrome' } : {}),
        args:
          settings.engine === 'firefox'
            ? []
            : [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                ...(headed
                  ? [
                      '--no-first-run',
                      '--no-default-browser-check',
                      '--start-maximized',
                      // Chromium only writes a clean-exit marker when it shuts
                      // down gracefully, and an attended window rarely does:
                      // stopping the container or the service kills it while it
                      // is open. Without this, the next launch greets the user
                      // with "Chromium didn't shut down correctly - Restore
                      // pages?" sitting over the login they came to do. The
                      // profile itself is unaffected either way, so the prompt
                      // is pure noise here.
                      '--hide-crash-restore-bubble',
                    ]
                  : []),
              ],
        ...this.contextOptions(settings, headed),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A host that never ran `playwright install` fails here with a wall of
      // ASCII art. LinkedIn and Indeed are browser-only, so this is the single
      // most likely reason they "do not work" — surface the one command that
      // fixes it instead of a 500 with a stack trace.
      if (/Executable doesn't exist|please run the following command/i.test(message)) {
        throw new ConfigurationError(
          `The ${settings.engine} browser is not installed, so browser-driven sources (LinkedIn, Indeed, and form filling) cannot run. Fix: run "npx playwright install ${settings.engine === 'firefox' ? 'firefox' : 'chromium'}" on this host.`,
        );
      }
      throw error;
    }

    context.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
    context.setDefaultTimeout(settings.actionTimeoutMs);

    context.on('close', () => {
      this.contexts.delete(key);
      this.providersByKey.delete(key);
    });

    this.contexts.set(key, context);
    this.trackProvider(key, provider);
    this.sessions.ensure({
      provider,
      engine: settings.engine,
      profilePath,
      // Same path `saveStorageState` writes, so the row never points at a file
      // that another provider owns.
      storageStatePath: this.storageStatePath(provider),
    });
    this.sessions.markUsed(provider);

    await this.injectCredentials(provider, context);

    return context;
  }

  /**
   * `addCookies` is all-or-nothing: one malformed entry rejects the whole array
   * and the session silently applies nothing. So we try the batch, and on any
   * failure re-add cookies one at a time - a single bad entry must never cost
   * the whole session. Names only are logged, never values.
   */
  private async addCookiesResiliently(
    provider: string,
    context: BrowserContext,
    cookies: PlaywrightCookies,
  ): Promise<{ applied: number; rejected: string[] }> {
    if (cookies.length === 0) return { applied: 0, rejected: [] };

    try {
      await context.addCookies(cookies);
      return { applied: cookies.length, rejected: [] };
    } catch (error) {
      this.logger.debug('batch cookie injection failed, retrying one at a time', {
        provider,
        cookies: cookies.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let applied = 0;
    const rejected: string[] = [];
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        applied += 1;
      } catch (error) {
        rejected.push(cookie.name);
        this.logger.debug('cookie rejected by the browser', {
          provider,
          cookie: cookie.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { applied, rejected };
  }

  /**
   * Replays a pasted session into a live context. A malformed cookie must never
   * stop the browser from opening, so every failure is downgraded to a status
   * update. Values are never logged - only counts and names.
   */
  private async injectCredentials(provider: string, context: BrowserContext): Promise<number> {
    const store = this.credentials;
    if (!store) return 0;

    // Under the attended strategy the profile IS the session: the user signed in
    // by hand in the visible window. Replaying a pasted cookie over a hand-made
    // login is how you log them straight back out, so the vault is not consulted
    // at all here - not even to seed a profile that holds nothing yet. A virgin
    // profile is not a problem to solve, it is a login the user has not done yet,
    // and seeding it would mean the first sign-in they do is fighting a cookie
    // they did not know was there.
    if (this.strategy() === 'attended') {
      this.logger.info(
        'attended session strategy: the profile is the session, not consulting the credential vault',
        { provider },
      );
      return 0;
    }

    const credential = store.load(provider);
    if (!credential) return 0;

    try {
      const cookies: PlaywrightCookies = credential.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        ...(cookie.url ? { url: cookie.url } : {}),
        ...(cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.domain ? { path: cookie.path ?? '/' } : {}),
        ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
        ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
        ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      }));

      const { applied, rejected } = await this.addCookiesResiliently(provider, context, cookies);
      if (rejected.length > 0) {
        store.setStatus(
          provider,
          applied > 0 ? 'valid' : 'invalid',
          `The browser rejected ${rejected.length} of ${cookies.length} cookies: ${rejected.join(', ')}.`,
        );
        this.logger.warn('some cookies were rejected by the browser', {
          provider,
          applied,
          rejected,
        });
      }

      const origins = credential.origins.filter((entry) => entry.localStorage.length > 0);
      if (origins.length > 0) {
        await context.addInitScript((seed: BrowserOrigin[]) => {
          const match = seed.find((entry) => entry.origin === window.location.origin);
          if (!match) return;
          for (const item of match.localStorage) {
            try {
              window.localStorage.setItem(item.name, item.value);
            } catch {
              // Storage can be blocked (private mode, quota); skip that key.
            }
          }
        }, origins);
      }

      store.markUsed(provider);
      this.logger.info('applied stored credentials', {
        provider,
        applied,
        rejected: rejected.length,
        origins: origins.length,
      });
      return applied;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setStatus(provider, 'invalid', message);
      this.logger.warn('failed to apply stored credentials', { provider, error: message });
      return 0;
    }
  }

  /**
   * Re-applies the stored credential to an already-open context so the user can
   * paste a fresh session without restarting the browser. Returns cookies injected.
   */
  async applyCredentialsToContext(provider: string): Promise<number> {
    const { context } = await this.contextFor(provider);
    return this.injectCredentials(provider, context);
  }

  /** Cookies currently live in the context for a provider, by name only. */
  async liveCookieNames(provider: string): Promise<string[]> {
    const { context } = await this.contextFor(provider);
    try {
      const cookies = await context.cookies();
      return Array.from(new Set(cookies.map((cookie) => cookie.name))).sort();
    } catch (error) {
      this.logger.debug('could not read live cookies', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Navigates to a probe URL and decides whether the session is still signed in,
   * stamping the credential row with the verdict when - and only when - the
   * vault is what a run would actually use.
   *
   * The final URL is authoritative: these sites bounce a dead session to a login
   * or authwall URL. Only when the URL is clean do we look at the page, and then
   * at `innerText` rather than the markup - a signed-in LinkedIn feed contains
   * the string "login" in its HTML (script payloads, tracking URLs), which used
   * to mark a perfectly healthy session as expired.
   */
  async isAuthenticated(
    provider: string,
    probeUrl: string,
    signedOutPattern: RegExp,
  ): Promise<boolean> {
    return this.probeSession(provider, probeUrl, signedOutPattern, true);
  }

  /**
   * Navigates and decides, shared by `isAuthenticated` and `probeSignedIn`.
   * Returns true when the page looks SIGNED OUT.
   */
  private async runProbe(page: Page, probeUrl: string, signedOutPattern: RegExp): Promise<boolean> {
    await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });

    if (signedOutPattern.test(page.url())) return true;

    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    return text.length > 0 && signedOutPattern.test(text);
  }

  /**
   * Probes whether a provider's session is live, by navigating a tab in the
   * shared profile and testing the FINAL url and the body text.
   *
   * No cookie is read, exported or pasted: the profile is the session. The tab
   * is opened and closed again, so the user's own tabs are left alone.
   */
  async probeSignedIn(
    provider: string,
    probeUrl: string,
    signedOutPattern: RegExp,
  ): Promise<boolean> {
    return this.probeSession(provider, probeUrl, signedOutPattern, false);
  }

  /**
   * The body of both probes. `stampCredential` is the only difference: whether
   * the caller wants the verdict recorded against the credential vault as well.
   *
   * That stamp is additionally gated on the effective strategy being `stored`,
   * because only then does the probe say anything about the pasted cookie. Under
   * the attended strategy the probe drives the hand-signed-in profile and the
   * vault is not consulted by a run at all, so stamping it lies in both
   * directions: a signed-in window would mark a long-dead pasted cookie `valid`,
   * and a signed-out window would mark a perfectly good one `expired` and fire a
   * credential-expired notification for a credential nothing is using.
   *
   * `sessions.setLoggedIn` is strategy-independent - it records the state of the
   * profile that was actually driven - so it is always written.
   */
  private async probeSession(
    provider: string,
    probeUrl: string,
    signedOutPattern: RegExp,
    stampCredential: boolean,
  ): Promise<boolean> {
    const stamps = stampCredential && this.strategy() === 'stored';
    const page = await this.newPage(provider);
    try {
      const signedOut = await this.runProbe(page, probeUrl, signedOutPattern);
      const note = signedOut ? 'probe reported signed out' : null;

      this.sessions.setLoggedIn(provider, !signedOut, note);
      if (stamps) this.credentials?.setStatus(provider, signedOut ? 'expired' : 'valid', note);
      return !signedOut;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('session probe failed', { provider, error: message });
      if (stamps) this.credentials?.setStatus(provider, 'unknown', message);
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * The shared attended context, opening it if needed. Throws with a clear
   * message when a window here would not be the session anything else uses.
   */
  async openAttended(): Promise<void> {
    const settings = this.settings();
    if (!settings.attended) {
      throw new ConfigurationError(
        'Attended mode is off, so there is no shared browser window to open. Fix: switch on Settings > Browser > attended, then try again.',
      );
    }
    // The window this opens lives on the SHARED_PROFILE_KEY profile, and only
    // the attended strategy makes `profileKey()` resolve providers to it. With
    // `stored` pinned each provider gets its own profile seeded from the pasted
    // session, so a window on `shared` would be a profile no collector ever
    // drives: the user would sign in, see it succeed, and every run would keep
    // using the pasted cookie. Refusing is the honest answer - silently opening
    // the wrong window, or quietly switching the strategy for them, is not.
    if (this.strategy() !== 'attended') {
      throw new ConfigurationError(
        'The session source is set to "stored", so each source runs on its own profile seeded from the session you pasted. A shared attended window would not be the session collectors use, so signing in there would change nothing. Fix: set Settings > Browser > session source to "attended" (or to "auto", which follows the attended switch), then try again.',
      );
    }
    await this.contextFor(SHARED_PROFILE_KEY);
  }

  /**
   * Closes the shared attended window (and only it).
   *
   * Deliberately keyed on SHARED_PROFILE_KEY directly rather than through
   * `profileKey()`: a window opened under the attended strategy is stored under
   * that key forever, so changing the session source while it is up must still
   * leave the user able to close what is on their screen.
   */
  async closeAttended(): Promise<void> {
    const context = this.contexts.get(SHARED_PROFILE_KEY);
    if (!context) return;
    this.contexts.delete(SHARED_PROFILE_KEY);
    this.providersByKey.delete(SHARED_PROFILE_KEY);
    await context.close().catch(() => undefined);
  }

  /**
   * Opens (or focuses) a tab at `url` in the shared window and brings it to the
   * front.
   *
   * `bringToFront()` raises the tab inside the browser. On Wayland the
   * compositor - not Chromium - decides whether the window itself is raised, so
   * the user may still have to click the window in their bar.
   */
  async openTab(provider: string, url: string): Promise<void> {
    const { context } = await this.contextFor(provider);

    const existing = context.pages().find((page) => page.url() === url);
    if (existing) {
      await existing.bringToFront().catch(() => undefined);
      return;
    }

    // Reuse a blank tab rather than piling up new ones; never navigate a tab the
    // user is already working in.
    const blank = context.pages().find((page) => page.url() === 'about:blank');
    const page = blank ?? (await this.newPage(provider));
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
      this.logger.warn('could not open tab', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await page.bringToFront().catch(() => undefined);
  }

  /**
   * URLs of the tabs currently open in the shared attended context. Keyed on
   * SHARED_PROFILE_KEY for the same reason as `closeAttended()`: it reports the
   * window on screen, which outlives a change of session source.
   */
  openPageUrls(): string[] {
    const context = this.contexts.get(SHARED_PROFILE_KEY);
    if (!context) return [];
    return context.pages().map((page) => page.url());
  }

  async newPage(provider: string): Promise<Page> {
    const { context } = await this.contextFor(provider);
    const page = await context.newPage();
    // Hide the most obvious automation signal without fingerprint spoofing.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return page;
  }

  /**
   * Where a provider's storage-state backup lives.
   *
   * The directory is resolved through `profileKey`, so in shared/attended mode
   * every provider resolves to the same one. A fixed `storage-state.json` there
   * meant each provider's backup overwrote the previous provider's - the file
   * named the profile, not the session inside it, so after a LinkedIn save
   * followed by an Indeed one the LinkedIn backup was simply gone. The filename
   * therefore carries the provider whenever the profile is shared, and keeps the
   * old name when the profile is already per-provider so existing files on disk
   * are not orphaned.
   */
  private storageStatePath(provider: string): string {
    const file = this.isShared() ? `storage-state.${slugify(provider)}.json` : 'storage-state.json';
    return path.join(this.profilePath(provider), file);
  }

  /** Persists cookies + localStorage alongside the profile as a portable backup. */
  async saveStorageState(provider: string): Promise<string | null> {
    const context = this.contexts.get(this.profileKey(provider));
    if (!context) return null;
    const target = this.storageStatePath(provider);
    try {
      await context.storageState({ path: target });
      return target;
    } catch (error) {
      this.logger.warn('failed to persist storage state', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The markup that gets persisted for a step: the live tree with every typed
   * value neutralised, then the shared redaction pass.
   *
   * Two sources, in order of fidelity. The in-page pass is the good one — it
   * can see the values `fill()` set, which the serialised attributes do not
   * carry. It fails when the page has navigated or closed under us, and in that
   * case `page.content()` still gives a usable structural snapshot. Either way
   * the string pass runs afterwards, so there is no path on which raw markup
   * reaches `writeFile`: that is the invariant this function exists to hold.
   */
  private async redactedContent(page: Page, label: string): Promise<string> {
    let html: string;
    try {
      html = await page.evaluate(neutraliseLiveFormValues, REDACTED_INPUT);
    } catch (error) {
      this.logger.debug('in-page snapshot redaction failed, falling back to serialised markup', {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      html = await page.content();
    }
    return redactHtmlSnapshot(html, this.redactor);
  }

  /**
   * Captures a screenshot and the DOM snapshot for a step. Both are written to
   * disk under DATA_DIR and registered by the caller as artifacts.
   *
   * The screenshot is PIXELS OF THE PAGE AS IT STANDS. When the run has just
   * filled an application it therefore shows the candidate's real name, email,
   * phone and address, plus whatever the signed-in site renders around them,
   * and no scrubber can do anything about that. It is on by default because
   * inspecting a prepared application is the whole point of a dry run; switch
   * `browser.captureScreenshots` off if that image must not exist on disk.
   * The HTML snapshot beside it is redacted — see `redactedContent`.
   */
  async capture(page: Page, label: string): Promise<CaptureResult> {
    const settings = this.settings();
    const stamp = nowIso().replace(/[:.]/g, '-');
    const base = `${stamp}_${slugify(label)}`;
    const result: CaptureResult = { screenshotPath: null, htmlPath: null };

    if (settings.captureScreenshots) {
      const target = path.join(this.paths.screenshots, `${base}.png`);
      try {
        await page.screenshot({ path: target, fullPage: true });
        result.screenshotPath = target;
      } catch (error) {
        this.logger.debug('screenshot failed', {
          label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (settings.captureHtml) {
      const target = path.join(this.paths.html, `${base}.html`);
      try {
        await writeFile(target, await this.redactedContent(page, label), 'utf8');
        result.htmlPath = target;
      } catch (error) {
        this.logger.debug('html capture failed', {
          label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /** Renders Markdown-derived HTML to a PDF using the bundled Chromium. */
  async renderPdf(html: string, outputPath: string): Promise<void> {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      });
    } finally {
      await browser?.close();
    }
  }

  async closeProvider(provider: string): Promise<void> {
    // In shared mode every provider is the same window. Closing "LinkedIn" would
    // take Indeed's session, the user's open tabs and the whole attended window
    // down with it, so it is deliberately a no-op; `closeAttended()` (or
    // `closeAll()` on shutdown) is the way to close the shared window.
    if (this.isShared()) {
      this.logger.info('ignoring per-provider browser close, the window is shared', { provider });
      return;
    }

    const key = this.profileKey(provider);
    const context = this.contexts.get(key);
    if (!context) return;
    this.contexts.delete(key);
    this.providersByKey.delete(key);
    await context.close().catch(() => undefined);
  }

  /**
   * Shutdown path. Nothing else closes a context when a run goes idle - that is
   * what `keepAlive` buys: the window the user signed in to stays open between
   * runs - so this must keep working even in attended mode.
   */
  async closeAll(): Promise<void> {
    this.closed = true;
    const contexts = Array.from(this.contexts.entries());
    this.contexts.clear();
    this.providersByKey.clear();
    await Promise.all(
      contexts.map(async ([profile, context]) => {
        try {
          await context.close();
        } catch (error) {
          this.logger.debug('failed to close browser context', {
            profile,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  /** Providers with a live context, by the name callers asked for. */
  openProviders(): string[] {
    const open = new Set<string>();
    for (const key of this.contexts.keys()) {
      for (const provider of this.providersByKey.get(key) ?? []) open.add(provider);
    }
    return Array.from(open);
  }
}
