import {
  DEFAULT_SETTINGS,
  SECRET_SETTING_PATHS,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from '@deedy/shared';
import { decryptSecret, encryptSecret, isEncrypted, maskSecret } from '../core/crypto.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { SettingsRepository } from '../repositories/settings.repository.js';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{a:{b:1}}` → `{'a.b': 1}`; arrays and scalars are leaves. */
function flatten(value: PlainObject, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) Object.assign(out, flatten(val, path));
    else out[path] = val;
  }
  return out;
}

function setPath(target: PlainObject, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = cursor[segment];
    if (!isPlainObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as PlainObject;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

function deepMerge<T extends PlainObject>(base: T, patch: PlainObject): T {
  const out: PlainObject = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    const existing = out[key];
    out[key] = isPlainObject(val) && isPlainObject(existing) ? deepMerge(existing, val) : val;
  }
  return out as T;
}

const SECRET_PATHS = new Set<string>(SECRET_SETTING_PATHS);

/** The one settings path whose change has to reach the keyword table. */
const SEARCH_KEYWORDS_PATH = 'search.keywords';

/**
 * Notified after `search.keywords` is persisted, with the seed list before and
 * after the write. Declared structurally and registered from the container
 * rather than imported: the only interested party is KeywordService, which
 * already depends on SettingsService, so naming it here would close a cycle.
 */
export type SearchKeywordsListener = (next: string[], previous: string[]) => void;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Single source of truth for configuration. Values live in SQLite (secrets
 * encrypted at rest) and are cached in memory for hot-path reads; the cache is
 * a read-through convenience only — SQLite is authoritative.
 */
export class SettingsService {
  private cache: Settings | null = null;
  /** Optional so the service still constructs standalone (tests, migrations, CLI). */
  private searchKeywordsListener: SearchKeywordsListener | null = null;

  constructor(
    private readonly repository: SettingsRepository,
    private readonly encryptionKey: Buffer,
    private readonly logger: Logger,
    private readonly events: EventBus,
  ) {}

  /** Writes any missing defaults so the settings table is always complete. */
  bootstrap(seed: Record<string, unknown> = {}): Settings {
    const existing = new Set(this.repository.all().map((row) => row.key));
    const defaults = flatten(DEFAULT_SETTINGS as unknown as PlainObject);
    // Environment values seed a key only when it has never been written, so the
    // dashboard stays authoritative once the user edits anything.
    const flat: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(seed)) {
      if (value !== undefined && value !== '' && key in flat) flat[key] = value;
    }
    const missing = Object.entries(flat)
      .filter(([key]) => !existing.has(key))
      .map(([key, value]) => this.encode(key, value));
    if (missing.length > 0) {
      this.repository.setMany(missing);
      this.logger.info('seeded default settings', { count: missing.length });
    }
    this.cache = null;
    return this.get();
  }

  get(): Settings {
    if (this.cache) return this.cache;
    const target: PlainObject = {};
    for (const row of this.repository.all()) {
      setPath(target, row.key, this.decode(row.key, row.value, row.encrypted));
    }
    const merged = deepMerge(DEFAULT_SETTINGS as unknown as PlainObject, target);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      this.logger.warn('stored settings failed validation, falling back to defaults for invalid keys', {
        issues: parsed.error.issues.slice(0, 10),
      });
      this.cache = settingsSchema.parse(
        deepMerge(DEFAULT_SETTINGS as unknown as PlainObject, {}),
      );
      return this.cache;
    }
    this.cache = parsed.data;
    return this.cache;
  }

  /** Settings safe to send to the browser: secrets replaced with a mask. */
  getRedacted(): Settings {
    const settings = structuredClone(this.get()) as unknown as PlainObject;
    for (const path of SECRET_PATHS) {
      const flat = flatten(settings);
      const value = flat[path];
      if (typeof value === 'string' && value.length > 0) setPath(settings, path, maskSecret(value));
    }
    return settings as unknown as Settings;
  }

  update(patch: SettingsPatch): Settings {
    const current = this.get() as unknown as PlainObject;
    const merged = deepMerge(current, patch as PlainObject);
    const validated = settingsSchema.parse(merged);

    const flatNext = flatten(validated as unknown as PlainObject);
    const flatPrev = flatten(current);

    const changed = Object.entries(flatNext).filter(([key, value]) => {
      // A masked secret means "unchanged" — never overwrite a secret with its mask.
      if (SECRET_PATHS.has(key) && typeof value === 'string' && /^\*+.{0,4}$/.test(value)) {
        return false;
      }
      return JSON.stringify(value) !== JSON.stringify(flatPrev[key]);
    });

    if (changed.length > 0) {
      this.repository.setMany(changed.map(([key, value]) => this.encode(key, value)));
      this.cache = null;
      const sections = Array.from(new Set(changed.map(([key]) => key.split('.')[0] as string)));
      this.logger.info('settings updated', { sections, keys: changed.map(([key]) => key) });
      this.events.emit('settings.updated', { sections });

      const seeds = changed.find(([key]) => key === SEARCH_KEYWORDS_PATH);
      if (seeds && this.searchKeywordsListener) {
        // Saving settings must never fail because a downstream table could not
        // be reconciled; the sync is repairable from the Keywords screen.
        try {
          this.searchKeywordsListener(asStringArray(seeds[1]), asStringArray(flatPrev[SEARCH_KEYWORDS_PATH]));
        } catch (error) {
          this.logger.error('search keyword listener failed after settings update', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return this.get();
  }

  /**
   * Registers the (single) listener fired when `search.keywords` actually
   * changes. Wired by the container after both services exist.
   */
  onSearchKeywordsChanged(listener: SearchKeywordsListener): void {
    this.searchKeywordsListener = listener;
  }

  /** Reads a secret in cleartext. Callers must never log the result. */
  secret(path: (typeof SECRET_SETTING_PATHS)[number]): string {
    const flat = flatten(this.get() as unknown as PlainObject);
    const value = flat[path];
    return typeof value === 'string' ? value : '';
  }

  invalidate(): void {
    this.cache = null;
  }

  private encode(key: string, value: unknown): { key: string; value: string; encrypted: boolean } {
    if (SECRET_PATHS.has(key) && typeof value === 'string' && value.length > 0) {
      return { key, value: encryptSecret(value, this.encryptionKey), encrypted: true };
    }
    return { key, value: JSON.stringify(value), encrypted: false };
  }

  private decode(key: string, value: string, encrypted: boolean): unknown {
    if (encrypted || isEncrypted(value)) {
      try {
        return decryptSecret(value, this.encryptionKey);
      } catch {
        this.logger.error('failed to decrypt setting; returning empty value', { key });
        return '';
      }
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
}
