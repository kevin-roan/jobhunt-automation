import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  /**
   * Loopback by default. The API is unauthenticated and now also drives a LaTeX
   * compiler and a local model, and the product's promise is that nothing
   * leaves the machine — so binding the LAN has to be a deliberate act. The
   * container images set HOST=0.0.0.0 explicitly, because there the network
   * boundary is Docker's published port.
   */
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Root for every piece of persisted state. Bind-mount this in Docker. */
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Directory containing the compiled dashboard. Served at "/". */
  WEB_DIR: z.string().default('./public'),
  /** Comma-separated CORS origins; only needed for the split dev server. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Disable the background worker/scheduler (useful for tests and CLI runs). */
  DISABLE_WORKERS: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** 32-byte hex key used to encrypt secret settings. Generated on first boot. */
  ENCRYPTION_KEY: z.string().optional(),

  /**
   * Bearer token every `/api/*` request must present. Generated on first boot
   * and stored beside the encryption key when unset, exactly like it.
   */
  API_TOKEN: z.string().optional(),

  /**
   * Escape hatch for an install that already has an authenticating proxy in
   * front of the port. Defaults ON — this API serves the candidate's resume,
   * name, email, phone and every stored prompt containing them, so "no auth"
   * has to be a deliberate act rather than the state you land in by omission.
   */
  AUTH_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !(v === 'false' || v === '0')),

  /**
   * Seeds `browser.attended` on first boot. The container image ships a virtual
   * screen (see docker/entrypoint.sh), so attended browsing works there and is
   * turned on by default; a bare-metal install leaves it off because it would
   * pop a window on the user's desktop unasked. Only ever seeds — once the key
   * exists the dashboard is authoritative.
   */
  BROWSER_ATTENDED: z
    .string()
    .default('')
    .transform((v) => (v === '' ? undefined : v === 'true' || v === '1')),

  /**
   * Seeds `browser.sessionStrategy` on first boot: which session a run uses,
   * the signed-in window (`attended`) or a pasted cookie (`stored`). `auto`
   * follows `BROWSER_ATTENDED`. Only ever seeds; the dashboard is authoritative
   * once the key exists.
   */
  BROWSER_SESSION_STRATEGY: z
    .enum(['auto', 'attended', 'stored', ''])
    .default('')
    .transform((v) => (v === '' ? undefined : v)),

  /**
   * URL of a viewer for the screen the attended browser is drawn on — noVNC in
   * the container image. Empty on a desktop install, where the window is simply
   * on the user's own screen and needs no viewer.
   *
   * This is loaded by the user's browser, not by the API, so it has to be an
   * address reachable from the host (`http://localhost:6080/...`), not a
   * container-internal one.
   */
  REMOTE_VIEW_URL: z.string().default(''),

  /**
   * Optional Supabase project for the mobile companion app. These seed the
   * `sync` settings on first boot; the user can change them in the dashboard
   * afterwards. Only operational metadata is ever mirrored there.
   */
  SUPABASE_URL: z.string().default(''),
  SUPABASE_PUBLISHABLE_KEY: z.string().default(''),
  /** Server-only. Grants full table access, so it must never reach a client. */
  SUPABASE_SECRET_KEY: z.string().default(''),
  SUPABASE_USER_ID: z.string().default(''),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppPaths {
  root: string;
  db: string;
  artifacts: string;
  screenshots: string;
  html: string;
  resumes: string;
  coverLetters: string;
  browserProfiles: string;
  backups: string;
  plugins: string;
  keyFile: string;
  tokenFile: string;
}

export interface AppConfig extends RawEnv {
  paths: AppPaths;
  encryptionKey: Buffer;
  /** The bearer token `/api/*` requires. Always populated, even when auth is off. */
  apiToken: string;
  version: string;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolves (and creates) the on-disk layout, and loads or generates the local
 * encryption key. The key never leaves DATA_DIR.
 */
export function loadConfig(overrides: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(overrides);
  const root = ensureDir(path.resolve(env.DATA_DIR));

  const paths: AppPaths = {
    root,
    db: path.join(root, 'deedy.sqlite'),
    artifacts: ensureDir(path.join(root, 'artifacts')),
    screenshots: ensureDir(path.join(root, 'artifacts', 'screenshots')),
    html: ensureDir(path.join(root, 'artifacts', 'html')),
    resumes: ensureDir(path.join(root, 'documents', 'resumes')),
    coverLetters: ensureDir(path.join(root, 'documents', 'cover-letters')),
    browserProfiles: ensureDir(path.join(root, 'browser-profiles')),
    backups: ensureDir(path.join(root, 'backups')),
    plugins: ensureDir(path.join(root, 'plugins')),
    keyFile: path.join(root, '.encryption-key'),
    tokenFile: path.join(root, '.api-token'),
  };

  const encryptionKey = resolveEncryptionKey(env.ENCRYPTION_KEY, paths.keyFile);
  // Resolved even when AUTH_ENABLED is false, so flipping auth back on does not
  // hand the user a different token than the one already in their password
  // manager — and so the file is there to read if they lose the startup log.
  const apiToken = resolveApiToken(env.API_TOKEN, paths.tokenFile);

  return { ...env, paths, encryptionKey, apiToken, version: '1.0.0' };
}

function resolveEncryptionKey(fromEnv: string | undefined, keyFile: string): Buffer {
  if (fromEnv && fromEnv.trim().length > 0) {
    const key = Buffer.from(fromEnv.trim(), 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters');
    }
    return key;
  }
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (key.length === 32) return key;
  }
  const generated = randomBytes(32);
  writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

/**
 * Loads or generates the bearer token, following `resolveEncryptionKey`: an
 * explicit env value wins, otherwise the file in DATA_DIR, otherwise a fresh
 * secret written there with mode 0600.
 *
 * base64url rather than hex, for two reasons: 32 bytes fit in 43 characters
 * instead of 64, and every character is URL-safe — the browser cannot attach a
 * header to an `<img>`, an `<a download>` or an `EventSource`, so this value
 * also travels as a `?token=` query parameter on those three paths.
 */
function resolveApiToken(fromEnv: string | undefined, tokenFile: string): string {
  if (fromEnv && fromEnv.trim().length > 0) {
    const token = fromEnv.trim();
    // A short token is worse than no token: it reads as protection while being
    // guessable by anything that can spend a second on the port.
    if (token.length < MIN_API_TOKEN_LENGTH) {
      throw new Error(`API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters`);
    }
    return token;
  }
  if (existsSync(tokenFile)) {
    const stored = readFileSync(tokenFile, 'utf8').trim();
    if (stored.length >= MIN_API_TOKEN_LENGTH) return stored;
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, generated, { mode: 0o600 });
  return generated;
}

/** Long enough that online guessing is hopeless; short enough to retype once. */
const MIN_API_TOKEN_LENGTH = 16;

export function corsOrigins(config: AppConfig): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
