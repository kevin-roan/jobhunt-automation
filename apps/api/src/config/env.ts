import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
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
}

export interface AppConfig extends RawEnv {
  paths: AppPaths;
  encryptionKey: Buffer;
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
  };

  const encryptionKey = resolveEncryptionKey(env.ENCRYPTION_KEY, paths.keyFile);

  return { ...env, paths, encryptionKey, version: '1.0.0' };
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

export function corsOrigins(config: AppConfig): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
