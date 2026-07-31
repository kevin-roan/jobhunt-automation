import type { Settings } from '@deedy/shared';
import type { Logger } from '../core/logger.js';
import type { NormalizedJob } from '../repositories/job.repository.js';
import type { BrowserManager } from '../browser/browser.manager.js';

export interface HttpClient {
  getJson<T>(url: string, init?: RequestInit): Promise<T>;
  getText(url: string, init?: RequestInit): Promise<string>;
  postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T>;
}

export interface CollectorContext {
  settings: Settings;
  logger: Logger;
  http: HttpClient;
  /** Lazily created — HTTP-only collectors never touch Playwright. */
  browser: BrowserManager;
  /** Hard cap on jobs to return in this run. */
  limit: number;
  signal?: AbortSignal;
}

/**
 * A job source. Implementations are pure: they fetch and normalize, and never
 * write to the database — persistence and de-duplication are the caller's job.
 */
export interface CollectorDefinition {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly description: string;
  /** Needs a logged-in persistent browser profile. */
  readonly requiresAuth: boolean;
  /** Needs company board slugs configured under Settings → Search → Boards. */
  readonly requiresBoards: boolean;
  readonly builtIn?: boolean;
  collect(context: CollectorContext): Promise<NormalizedJob[]>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DEFAULT_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/** Small fetch wrapper with timeouts, retries and consistent errors. */
export function createHttpClient(timeoutMs = 30000, retries = 2): HttpClient {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: { ...DEFAULT_HEADERS, ...(init.headers as Record<string, string> | undefined) },
        });
        if (response.status >= 500 && attempt < retries) {
          lastError = new HttpError(`HTTP ${response.status}`, response.status, url);
          continue;
        }
        if (!response.ok) {
          throw new HttpError(
            `Request to ${url} failed with ${response.status}`,
            response.status,
            url,
          );
        }
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && error.status < 500) throw error;
        if (attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Request to ${url} failed`);
  }

  return {
    async getJson<T>(url: string, init?: RequestInit): Promise<T> {
      const response = await request(url, { ...init, method: 'GET' });
      return (await response.json()) as T;
    },
    async getText(url: string, init?: RequestInit): Promise<string> {
      const response = await request(url, { ...init, method: 'GET' });
      return response.text();
    },
    async postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
      const response = await request(url, {
        ...init,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        body: JSON.stringify(body),
      });
      return (await response.json()) as T;
    },
  };
}
