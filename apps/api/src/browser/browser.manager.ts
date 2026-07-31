import { existsSync, mkdirSync } from 'node:fs';
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
import type { BrowserEngine, BrowserSettings } from '@deedy/shared';
import type { AppPaths } from '../config/env.js';
import type { Logger } from '../core/logger.js';
import { AppError } from '../core/errors.js';
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
 * Owns every Playwright process. Contexts are persistent (one profile directory
 * per provider) so cookies and logins survive restarts and the user never has
 * to authenticate twice.
 */
export class BrowserManager {
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly launching = new Map<string, Promise<BrowserContext>>();
  private closed = false;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly sessions: BrowserSessionRepository,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    private readonly credentials?: CredentialProvider,
  ) {}

  private settings(): BrowserSettings {
    return this.settingsService.get().browser;
  }

  profilePath(provider: string): string {
    const dir = path.join(this.paths.browserProfiles, slugify(provider));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private contextOptions(settings: BrowserSettings): BrowserContextOptions {
    const options: BrowserContextOptions = {
      viewport: { width: settings.viewportWidth, height: settings.viewportHeight },
      locale: settings.locale,
      timezoneId: settings.timezone,
      acceptDownloads: true,
      ignoreHTTPSErrors: false,
    };
    if (settings.userAgent.trim()) options.userAgent = settings.userAgent.trim();
    return options;
  }

  /**
   * Returns the persistent context for a provider, launching it on first use.
   * Concurrent callers share a single launch.
   */
  async contextFor(provider: string): Promise<ProviderContext> {
    if (this.closed) throw new AppError('Browser manager has been shut down', 503, 'shutting_down');

    const existing = this.contexts.get(provider);
    if (existing) {
      this.sessions.markUsed(provider);
      return { context: existing, provider, profilePath: this.profilePath(provider) };
    }

    const pending = this.launching.get(provider);
    if (pending) {
      const context = await pending;
      return { context, provider, profilePath: this.profilePath(provider) };
    }

    const launch = this.launch(provider);
    this.launching.set(provider, launch);
    try {
      const context = await launch;
      return { context, provider, profilePath: this.profilePath(provider) };
    } finally {
      this.launching.delete(provider);
    }
  }

  private async launch(provider: string): Promise<BrowserContext> {
    const settings = this.settings();
    const profilePath = this.profilePath(provider);
    const engine = engineFor(settings.engine);

    this.logger.info('launching persistent browser context', {
      provider,
      engine: settings.engine,
      headless: settings.headless,
    });

    const context = await engine.launchPersistentContext(profilePath, {
      headless: settings.headless,
      slowMo: settings.slowMoMs,
      // "chrome" uses the branded Google Chrome build when it is installed.
      ...(settings.engine === 'chrome' ? { channel: 'chrome' } : {}),
      args:
        settings.engine === 'firefox'
          ? []
          : ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      ...this.contextOptions(settings),
    });

    context.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
    context.setDefaultTimeout(settings.actionTimeoutMs);

    context.on('close', () => {
      this.contexts.delete(provider);
    });

    this.contexts.set(provider, context);
    this.sessions.ensure({
      provider,
      engine: settings.engine,
      profilePath,
      storageStatePath: path.join(profilePath, 'storage-state.json'),
    });
    this.sessions.markUsed(provider);

    await this.injectCredentials(provider, context);

    return context;
  }

  /**
   * Replays a pasted session into a live context. A malformed cookie must never
   * stop the browser from opening, so every failure is downgraded to a status
   * update. Values are never logged - only counts.
   */
  private async injectCredentials(provider: string, context: BrowserContext): Promise<number> {
    const store = this.credentials;
    if (!store) return 0;

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

      if (cookies.length > 0) await context.addCookies(cookies);

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
        cookies: cookies.length,
        origins: origins.length,
      });
      return cookies.length;
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

  /**
   * Navigates to a probe URL and decides whether the session is still signed in.
   * A match on the final URL or the page body means signed out.
   */
  async isAuthenticated(
    provider: string,
    probeUrl: string,
    signedOutPattern: RegExp,
  ): Promise<boolean> {
    const page = await this.newPage(provider);
    try {
      await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });
      const signedOut =
        signedOutPattern.test(page.url()) || signedOutPattern.test(await page.content());
      const note = signedOut ? 'probe reported signed out' : null;

      this.sessions.setLoggedIn(provider, !signedOut, note);
      this.credentials?.setStatus(provider, signedOut ? 'expired' : 'valid', note);
      return !signedOut;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('authentication probe failed', { provider, error: message });
      this.credentials?.setStatus(provider, 'unknown', message);
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
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

  /** Persists cookies + localStorage alongside the profile as a portable backup. */
  async saveStorageState(provider: string): Promise<string | null> {
    const context = this.contexts.get(provider);
    if (!context) return null;
    const target = path.join(this.profilePath(provider), 'storage-state.json');
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
   * Captures a screenshot and the DOM snapshot for a step. Both are written to
   * disk under DATA_DIR and registered by the caller as artifacts.
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
        await writeFile(target, await page.content(), 'utf8');
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
    const context = this.contexts.get(provider);
    if (!context) return;
    this.contexts.delete(provider);
    await context.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const contexts = Array.from(this.contexts.entries());
    this.contexts.clear();
    await Promise.all(
      contexts.map(async ([provider, context]) => {
        try {
          await context.close();
        } catch (error) {
          this.logger.debug('failed to close browser context', {
            provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  openProviders(): string[] {
    return Array.from(this.contexts.keys());
  }
}
