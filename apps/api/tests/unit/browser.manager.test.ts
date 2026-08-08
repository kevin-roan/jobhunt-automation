import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  resolveSessionStrategy,
  type BrowserSettings,
  type SessionStrategy,
  type Settings,
} from '@deedy/shared';

import {
  BrowserManager,
  redactHtmlSnapshot,
  REDACTED_INPUT,
  REDACTED_SCRIPT,
} from '../../src/browser/browser.manager.js';
import type {
  BrowserCookie,
  BrowserOrigin,
  CredentialProvider,
  CredentialStatusValue,
} from '../../src/browser/browser.manager.js';
import type { AppPaths } from '../../src/config/env.js';
import type { LogContext, Logger } from '../../src/core/logger.js';
import type { BrowserSessionRepository } from '../../src/repositories/browser.repository.js';
import { Redactor } from '../../src/core/redact.js';
import type { SettingsService } from '../../src/services/settings.service.js';

const logged: Array<{ msg: string; context?: LogContext }> = [];
const logger = {
  info: (msg: string, context?: LogContext) => logged.push({ msg, context }),
  warn: (msg: string, context?: LogContext) => logged.push({ msg, context }),
  debug: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as Logger;

function managerFor(
  root: string,
  browser: Partial<BrowserSettings> = {},
  credentials?: CredentialProvider,
  sessions: BrowserSessionRepository = {} as unknown as BrowserSessionRepository,
): BrowserManager {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    browser: { ...DEFAULT_SETTINGS.browser, ...browser },
  };
  const settingsService = { get: (): Settings => settings } as unknown as SettingsService;
  const paths = { browserProfiles: root } as unknown as AppPaths;
  return new BrowserManager(settingsService, sessions, paths, logger, credentials);
}

/** Reaches the private cleaner directly; launching a real Chromium is not the unit under test. */
function clearLocks(manager: BrowserManager, profilePath: string): void {
  (manager as unknown as { clearStaleProfileLocks(p: string): void }).clearStaleProfileLocks(
    profilePath,
  );
}

describe('stale profile locks', () => {
  let root: string;
  let profile: string;

  beforeEach(() => {
    logged.length = 0;
    root = mkdtempSync(path.join(tmpdir(), 'deedy-profiles-'));
    profile = path.join(root, 'shared');
    mkdirSync(profile, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The container case that made this necessary: Chromium records the hostname
   * it was running under, Docker hands out a new one on every recreate, so the
   * lock names a host that will never come back and Chromium never reclaims it.
   * Left alone, every launch afterwards fails and attended mode is bricked.
   */
  it('removes a lock left behind by a container that no longer exists', () => {
    symlinkSync('814ed2246464-50', path.join(profile, 'SingletonLock'));
    symlinkSync('/tmp/org.chromium.Chromium.fMqe0m/SingletonSocket', path.join(profile, 'SingletonSocket'));
    symlinkSync('13138092134762800791', path.join(profile, 'SingletonCookie'));

    clearLocks(managerFor(root), profile);

    expect(existsSync(path.join(profile, 'SingletonLock'))).toBe(false);
    expect(existsSync(path.join(profile, 'SingletonSocket'))).toBe(false);
    expect(existsSync(path.join(profile, 'SingletonCookie'))).toBe(false);
    // The hostname/pid it recorded is the whole diagnostic value of the log line.
    expect(logged.some((entry) => entry.context?.heldBy === '814ed2246464-50')).toBe(true);
  });

  it('leaves the actual session data alone', () => {
    const cookies = path.join(profile, 'Cookies');
    writeFileSync(cookies, 'not-a-lock');
    symlinkSync('host-1', path.join(profile, 'SingletonLock'));

    clearLocks(managerFor(root), profile);

    // Deleting these would silently log the user out of every site, which is
    // exactly what attended mode exists to avoid.
    expect(existsSync(cookies)).toBe(true);
    expect(existsSync(path.join(profile, 'SingletonLock'))).toBe(false);
  });

  it('is a no-op on a clean profile', () => {
    expect(() => clearLocks(managerFor(root), profile)).not.toThrow();
    expect(logged).toHaveLength(0);
  });
});

/** Records what a context was asked to do; launching a real browser is not the unit under test. */
interface FakeContext {
  context: BrowserContext;
  added: string[];
  cookiesRead: number;
}

function fakeContext(existing: string[] = []): FakeContext {
  const state = { added: [] as string[], cookiesRead: 0 };
  const context = {
    addCookies: async (cookies: Array<{ name: string }>) => {
      state.added.push(...cookies.map((cookie) => cookie.name));
    },
    cookies: async () => {
      state.cookiesRead += 1;
      return existing.map((name) => ({ name, value: 'x', domain: '.linkedin.com', path: '/' }));
    },
    addInitScript: async () => undefined,
  } as unknown as BrowserContext;
  return {
    context,
    get added() {
      return state.added;
    },
    get cookiesRead() {
      return state.cookiesRead;
    },
  };
}

/** A vault holding one pasted session, plus a record of every status it was given. */
function fakeVault(cookies: BrowserCookie[], origins: BrowserOrigin[] = []) {
  const statuses: Array<{ provider: string; status: CredentialStatusValue }> = [];
  let loads = 0;
  const store: CredentialProvider = {
    load: () => {
      loads += 1;
      return { cookies, origins };
    },
    markUsed: () => undefined,
    setStatus: (provider: string, status: CredentialStatusValue) =>
      void statuses.push({ provider, status }),
  };
  return {
    store,
    statuses,
    get loads() {
      return loads;
    },
  };
}

function inject(
  manager: BrowserManager,
  provider: string,
  context: BrowserContext,
): Promise<number> {
  return (
    manager as unknown as {
      injectCredentials(provider: string, context: BrowserContext): Promise<number>;
    }
  ).injectCredentials(provider, context);
}

function storageStatePath(manager: BrowserManager, provider: string): string {
  return (manager as unknown as { storageStatePath(provider: string): string }).storageStatePath(
    provider,
  );
}

describe('session strategy', () => {
  let root: string;

  beforeEach(() => {
    logged.length = 0;
    root = mkdtempSync(path.join(tmpdir(), 'deedy-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The whole point of the attended strategy: the login the user performed by
   * hand wins, and a virgin profile is not a hole to plug with a pasted cookie -
   * it is a login they have not done yet.
   */
  it('never consults the vault under the attended strategy, even for a profile with no cookies', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const manager = managerFor(root, { sessionStrategy: 'attended' }, vault.store);
    const fake = fakeContext([]);

    const applied = await inject(manager, 'linkedin', fake.context);

    expect(applied).toBe(0);
    expect(fake.added).toEqual([]);
    // Not merely "did not inject": the stored session was never even read.
    expect(vault.loads).toBe(0);
    expect(logged.some((entry) => /not consulting the credential vault/.test(entry.msg))).toBe(true);
  });

  it('injects the stored session under the stored strategy', async () => {
    const vault = fakeVault([
      { name: 'li_at', value: 'stored', domain: '.linkedin.com' },
      { name: 'JSESSIONID', value: 'stored', domain: '.linkedin.com' },
    ]);
    const manager = managerFor(root, { sessionStrategy: 'stored' }, vault.store);
    const fake = fakeContext([]);

    const applied = await inject(manager, 'linkedin', fake.context);

    expect(applied).toBe(2);
    expect(fake.added).toEqual(['li_at', 'JSESSIONID']);
  });

  /**
   * Attended mode ON with `stored` pinned is the awkward-but-legitimate case:
   * the user wants to watch the run, and still wants the pasted cookie to win.
   */
  it('injects when attended mode is on but the strategy is pinned to stored', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const manager = managerFor(
      root,
      { attended: true, sessionStrategy: 'stored' },
      vault.store,
    );

    expect(await inject(manager, 'linkedin', fakeContext([]).context)).toBe(1);
  });

  it('resolves auto from the attended switch and lets an explicit choice override it', () => {
    const table: Array<[boolean, SessionStrategy, string]> = [
      [false, 'auto', 'stored'],
      [true, 'auto', 'attended'],
      [false, 'attended', 'attended'],
      [true, 'attended', 'attended'],
      [false, 'stored', 'stored'],
      [true, 'stored', 'stored'],
    ];
    for (const [attended, sessionStrategy, expected] of table) {
      expect(resolveSessionStrategy({ attended, sessionStrategy })).toBe(expected);
    }
  });

  it('gives each provider its own profile when attended mode is on but stored is pinned', () => {
    const shared = managerFor(root, { attended: true, sessionStrategy: 'auto' });
    const perProvider = managerFor(root, { attended: true, sessionStrategy: 'stored' });

    expect(shared.activeProfilePath('linkedin')).toBe(shared.activeProfilePath('indeed'));
    expect(perProvider.activeProfilePath('linkedin')).not.toBe(
      perProvider.activeProfilePath('indeed'),
    );
  });
});

/** Records the two session-row writes `contextFor`/the probes make. */
function fakeSessions() {
  const loggedIn: Array<{ provider: string; signedIn: boolean; note: string | null }> = [];
  const used: string[] = [];
  const repository = {
    setLoggedIn: (provider: string, signedIn: boolean, note: string | null) =>
      void loggedIn.push({ provider, signedIn, note }),
    markUsed: (provider: string) => void used.push(provider),
    ensure: () => undefined,
    list: () => [],
  } as unknown as BrowserSessionRepository;
  return { repository, loggedIn, used };
}

/** A page that lands on `url` and renders `bodyText`; no real browser is involved. */
function fakePage(url: string, bodyText = 'Your feed'): Page {
  return {
    goto: async () => null,
    url: () => url,
    evaluate: async () => bodyText,
    addInitScript: async () => undefined,
    close: async () => undefined,
    bringToFront: async () => undefined,
  } as unknown as Page;
}

/**
 * Puts a live context into the manager's map so `contextFor` finds it instead of
 * launching Chromium. Keyed exactly as the manager keys it, so the strategy under
 * test is what decides which profile the caller lands on.
 */
function primeContext(manager: BrowserManager, provider: string, page: Page): void {
  const internals = manager as unknown as {
    contexts: Map<string, BrowserContext>;
    profileKey(provider: string): string;
  };
  const context = { newPage: async () => page } as unknown as BrowserContext;
  internals.contexts.set(internals.profileKey(provider), context);
}

const SIGNED_OUT = /\/login|\/authwall/i;

describe('probe stamping', () => {
  let root: string;

  beforeEach(() => {
    logged.length = 0;
    root = mkdtempSync(path.join(tmpdir(), 'deedy-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The leak this guards: under the attended strategy the probe drives the
   * hand-signed-in profile, so a signed-out window said nothing whatsoever about
   * the pasted cookie - yet it used to mark that credential `expired` and fire an
   * expiry notification for a credential no run would ever read.
   */
  it('leaves the credential untouched under the attended strategy when signed out', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const sessions = fakeSessions();
    const manager = managerFor(
      root,
      { attended: true, sessionStrategy: 'auto' },
      vault.store,
      sessions.repository,
    );
    primeContext(manager, 'linkedin', fakePage('https://www.linkedin.com/authwall'));

    expect(await manager.isAuthenticated('linkedin', 'https://www.linkedin.com/feed/', SIGNED_OUT))
      .toBe(false);

    expect(vault.statuses).toEqual([]);
    // The session row is the honest signal and must still be written.
    expect(sessions.loggedIn).toEqual([
      { provider: 'linkedin', signedIn: false, note: 'probe reported signed out' },
    ]);
  });

  /** The mirror image: a signed-in attended window must not certify a dead pasted cookie. */
  it('leaves the credential untouched under the attended strategy when signed in', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const sessions = fakeSessions();
    const manager = managerFor(
      root,
      { sessionStrategy: 'attended' },
      vault.store,
      sessions.repository,
    );
    primeContext(manager, 'linkedin', fakePage('https://www.linkedin.com/feed/'));

    expect(await manager.isAuthenticated('linkedin', 'https://www.linkedin.com/feed/', SIGNED_OUT))
      .toBe(true);

    expect(vault.statuses).toEqual([]);
    expect(sessions.loggedIn).toEqual([{ provider: 'linkedin', signedIn: true, note: null }]);
  });

  /** Under `stored` the probe really is a verdict on the vault row, so it is stamped. */
  it('stamps the credential under the stored strategy', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const sessions = fakeSessions();
    const manager = managerFor(
      root,
      { attended: true, sessionStrategy: 'stored' },
      vault.store,
      sessions.repository,
    );
    primeContext(manager, 'linkedin', fakePage('https://www.linkedin.com/authwall'));

    expect(await manager.isAuthenticated('linkedin', 'https://www.linkedin.com/feed/', SIGNED_OUT))
      .toBe(false);

    expect(vault.statuses).toEqual([{ provider: 'linkedin', status: 'expired' }]);
    expect(sessions.loggedIn).toHaveLength(1);
  });

  /** `probeSignedIn` never judged the vault, and still must not, whatever the strategy. */
  it('never stamps the credential from probeSignedIn', async () => {
    const vault = fakeVault([{ name: 'li_at', value: 'stored', domain: '.linkedin.com' }]);
    const sessions = fakeSessions();
    const manager = managerFor(root, { sessionStrategy: 'stored' }, vault.store, sessions.repository);
    primeContext(manager, 'linkedin', fakePage('https://www.linkedin.com/authwall'));

    expect(await manager.probeSignedIn('linkedin', 'https://www.linkedin.com/feed/', SIGNED_OUT))
      .toBe(false);

    expect(vault.statuses).toEqual([]);
    expect(sessions.loggedIn).toHaveLength(1);
  });
});

describe('opening the attended window', () => {
  let root: string;

  beforeEach(() => {
    logged.length = 0;
    root = mkdtempSync(path.join(tmpdir(), 'deedy-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The silent trap: attended mode on, session source pinned to `stored`. Every
   * provider then resolves to its own profile, so a window on the shared profile
   * is one the user signs in to and no collector ever drives.
   */
  it('refuses when the effective strategy is not attended', async () => {
    const manager = managerFor(root, { attended: true, sessionStrategy: 'stored' });

    await expect(manager.openAttended()).rejects.toThrow(/session source/i);
  });

  it('still refuses first on attended mode being off', async () => {
    const manager = managerFor(root, { attended: false, sessionStrategy: 'stored' });

    await expect(manager.openAttended()).rejects.toThrow(/Attended mode is off/);
  });

  it('opens the shared profile when the strategy resolves to attended', async () => {
    const sessions = fakeSessions();
    const manager = managerFor(
      root,
      { attended: true, sessionStrategy: 'auto' },
      undefined,
      sessions.repository,
    );
    // Priming the context is what keeps this a unit test: it proves the guard
    // lets the call through to `contextFor`, without launching a real browser.
    primeContext(manager, 'shared', fakePage('about:blank'));

    await expect(manager.openAttended()).resolves.toBeUndefined();
    expect(sessions.used).toContain('shared');
  });
});

describe('storage state backups', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'deedy-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** One directory for every provider, so one filename for every provider lost data. */
  it('names the backup per provider when the profile is shared', () => {
    const manager = managerFor(root, { sharedProfile: true });

    const linkedin = storageStatePath(manager, 'linkedin');
    const indeed = storageStatePath(manager, 'indeed');

    expect(path.dirname(linkedin)).toBe(path.dirname(indeed));
    expect(linkedin).not.toBe(indeed);
    expect(path.basename(linkedin)).toBe('storage-state.linkedin.json');
  });

  /** Per-provider profiles already separate the files; renaming them would orphan what is on disk. */
  it('keeps the original filename when the profile is per-provider', () => {
    const manager = managerFor(root, { attended: false, sharedProfile: false });

    expect(path.basename(storageStatePath(manager, 'linkedin'))).toBe('storage-state.json');
  });
});

/**
 * The DOM snapshot is the one capture that CAN be made safe — the screenshot
 * beside it is pixels of a filled form and cannot. These lock in the bargain:
 * nothing the candidate typed survives, everything a debugger reads does.
 */
describe('HTML snapshot redaction', () => {
  const candidate = {
    fullName: 'Jonathan Fairweather',
    firstName: 'Jonathan',
    lastName: 'Fairweather',
    email: 'jonathan.fairweather@example.com',
    phone: '+44 7700 900123',
    city: 'Manchester',
  };
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    profile: { ...DEFAULT_SETTINGS.profile, ...candidate },
  };
  const redactor = new Redactor({ get: () => settings });

  /** A trimmed-down version of what an Indeed apply step actually serialises. */
  const snapshot = [
    '<!DOCTYPE html><html><body>',
    '<header class="site-chrome">Signed in as Jonathan Fairweather</header>',
    '<form id="apply-form" class="ia-Form" method="post">',
    '<label for="applicant-name">Full name</label>',
    '<input id="applicant-name" name="applicant.name" type="text" class="css-1x" ',
    'placeholder="Your name" value="Jonathan Fairweather">',
    '<label for="applicant-email">Email address</label>',
    '<input id="applicant-email" name="applicant.email" type="email" ',
    'value="jonathan.fairweather@example.com">',
    '<input type="hidden" name="csrfToken" value="a7f3c1e9-session-token">',
    '<input type="hidden" name="jobKey" value="">',
    '<label for="cover">Cover letter</label>',
    '<textarea id="cover" name="applicant.coverLetter" rows="8">',
    'Dear team, I am Jonathan Fairweather and you can reach me on +44 7700 900123.',
    '</textarea>',
    '<select name="workAuth"><option value="yes" selected>Yes</option>',
    '<option value="no">No</option></select>',
    '<button type="submit" class="ia-continueButton">Continue</button>',
    '</form>',
    '<script>window.__VIEWER__={"email":"jonathan.fairweather@example.com","auth":"eyJhbGciOi"};</script>',
    '</body></html>',
  ].join('');

  const redacted = redactHtmlSnapshot(snapshot, redactor);

  it('neutralises every filled input value', () => {
    expect(redacted).toContain(`id="applicant-name" name="applicant.name" type="text"`);
    expect(redacted).toContain(`value="${REDACTED_INPUT}"`);
    expect(redacted).not.toContain('Jonathan Fairweather');
    expect(redacted).not.toContain('jonathan.fairweather@example.com');
  });

  /** A hidden CSRF/session token is a value like any other, and worth as much. */
  it('neutralises hidden token values', () => {
    expect(redacted).not.toContain('a7f3c1e9-session-token');
    expect(redacted).toContain('name="csrfToken"');
  });

  /** An empty field must stay empty — marking it would claim a fill that never happened. */
  it('leaves an already-empty value empty', () => {
    expect(redacted).toContain('name="jobKey" value=""');
  });

  it('neutralises the textarea body and redacts the PII inside it', () => {
    expect(redacted).toContain(`rows="8">${REDACTED_INPUT}</textarea>`);
    expect(redacted).not.toContain('Dear team');
    expect(redacted).not.toContain('7700 900123');
  });

  /** PII rendered as page text, which no value-neutralising pass would reach. */
  it('redacts PII that appears as ordinary page text', () => {
    expect(redacted).toContain('[REDACTED:name]');
    expect(redacted).toContain('<header class="site-chrome">Signed in as ');
  });

  /** Where these sites keep the signed-in viewer and its auth tokens. */
  it('empties inline script bodies but keeps the tag', () => {
    expect(redacted).not.toContain('eyJhbGciOi');
    expect(redacted).toContain(`<script>/* ${REDACTED_SCRIPT} */</script>`);
  });

  /** The whole point: the snapshot has to stay worth reading. */
  it('keeps field names, ids, labels, classes, options and the DOM shape', () => {
    for (const fragment of [
      '<form id="apply-form" class="ia-Form" method="post">',
      '<label for="applicant-name">Full name</label>',
      'name="applicant.email"',
      'type="email"',
      'placeholder="Your name"',
      'class="css-1x"',
      '<label for="cover">Cover letter</label>',
      '<option value="yes" selected>Yes</option>',
      '<button type="submit" class="ia-continueButton">Continue</button>',
    ]) {
      expect(redacted).toContain(fragment);
    }
  });

  /** It runs over markup the in-page pass already touched, so it must not drift. */
  it('is idempotent', () => {
    expect(redactHtmlSnapshot(redacted, redactor)).toBe(redacted);
  });

  /** A `value=` inside a URL or a script is not a form field and must survive. */
  it('only touches value attributes on input tags', () => {
    const other = '<a href="/search?value=engineer">jobs</a><param name="x" value="keepme">';
    expect(redactHtmlSnapshot(other, redactor)).toBe(other);
  });
});
