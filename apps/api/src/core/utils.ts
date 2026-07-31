import { sha256 } from './crypto.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoPlusMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collapses whitespace, strips punctuation and lowercases — used for all matching keys. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompany(name: string): string {
  return normalizeText(name)
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|bv|plc|co|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops tracking parameters and fragments so the same posting always maps to one URL. */
export function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    const drop = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gh_src',
      'trk',
      'refId',
      'trackingId',
      'position',
      'pageNum',
    ];
    for (const param of drop) url.searchParams.delete(param);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/** Stable identity of a posting: source + company + title + location. */
export function jobHash(input: {
  source: string;
  company: string;
  title: string;
  location?: string | null;
}): string {
  return sha256(
    [
      normalizeText(input.source),
      normalizeCompany(input.company),
      normalizeText(input.title),
      normalizeText(input.location ?? ''),
    ].join('|'),
  );
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Filesystem-safe slug for artifact filenames. */
export function slugify(value: string, max = 60): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.length > 0 ? slug : 'item').slice(0, max);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}
