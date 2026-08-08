/**
 * The single PII/secret scrubber for the whole host.
 *
 * The rule this file exists to enforce: the application always works with the
 * candidate's REAL values - a resume is tailored with a real name, a form is
 * filled with a real email, a prompt is sent to the local model verbatim - but
 * anything that is PERSISTED or DISPLAYED for observability is scrubbed first.
 * Logs, the `llm_calls` table, the log table and the Supabase mirror are all
 * downstream copies whose only purpose is for a human to read later, so none of
 * them needs the real value and every one of them is a place it can leak from.
 *
 * There used to be one private copy of this inside SyncService. It is shared
 * now so there is exactly one answer to "what counts as personal data here",
 * and so a new call site cannot quietly ship a weaker one.
 *
 * Two layers, in this order:
 *   1. Exact matches of the values the host actually knows (profile fields plus
 *      the two stored API secrets). Precise, and the only way to catch a name
 *      or a city, which no pattern can recognise.
 *   2. Generic email and phone patterns, for values the host was never told -
 *      a recruiter's address quoted in an error, a number scraped off a form.
 *
 * Deliberately NOT a general heuristic sweep. A log line that has been shredded
 * into `[REDACTED] [REDACTED] [REDACTED]` is a support cost with no privacy
 * gain, so structure and non-PII text always survive and every substitution is
 * visibly labelled rather than silently dropped.
 */
import type { Settings } from '@deedy/shared';

/** What a redaction leaves behind. Labelled, so a reader knows what was there. */
export const REDACTED = '[REDACTED]';

export type RedactionLabel =
  | 'name'
  | 'email'
  | 'phone'
  | 'city'
  | 'postal-code'
  | 'url'
  | 'secret';

export function redactionToken(label: RedactionLabel): string {
  return `[REDACTED:${label}]`;
}

/**
 * Below this length a value is too likely to collide with an ordinary word or
 * number to strip blindly - and, critically, an UNSET profile field is the
 * empty string, which would compile to a pattern that matches at every single
 * character position and turn every log line into nothing but tokens. That is
 * the failure this floor exists to make impossible; `compile()` re-checks it.
 */
const MIN_REDACTABLE_LENGTH = 5;

/** Never operationally useful in a stored string, and always personal data. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Phone candidates. Intentionally loose about separators and tightened by
 * `isPhoneLike` instead of by the pattern, because the things that must NOT
 * match - ISO dates, durations in ms, version strings, row ids - are told apart
 * by how many digits they carry, not by their punctuation.
 *
 * The `\w` boundaries stop a match starting or ending in the middle of a longer
 * token, so `2026-08-06T09:15:00` cannot contribute a fragment.
 */
const PHONE_CANDIDATE_PATTERN = /(?<!\w)\+?\d[\d\s().-]{7,18}\d(?!\w)/g;

/** Cheap pre-tests, non-global so they carry no `lastIndex` state. */
const HAS_DIGIT = /\d/;

/**
 * Real phone numbers carry 9-15 digits (E.164 caps at 15). A shorter run is a
 * date, a port, a duration or an id; a longer one is a hash or a token, which
 * the key-name masking already covers.
 */
function isPhoneLike(candidate: string): boolean {
  let digits = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    const code = candidate.charCodeAt(i);
    if (code >= 48 && code <= 57) digits += 1;
  }
  return digits >= 9 && digits <= 15;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A purely numeric value (a postal code) needs digit boundaries, otherwise it
 * would also match inside an unrelated number such as a timeout in ms.
 */
function valuePattern(value: string): RegExp {
  const body = escapeRegExp(value);
  return /^\d+$/.test(value) ? new RegExp(`(?<!\\d)${body}(?!\\d)`, 'g') : new RegExp(body, 'gi');
}

interface CompiledRule {
  pattern: RegExp;
  token: string;
  /** Length of the source value, used only to order the rules. */
  length: number;
}

const NO_RULES: readonly CompiledRule[] = [];

/**
 * Structurally `SettingsService`, declared as an interface so this module sits
 * at the bottom of the dependency graph - the logger needs it, and the logger
 * is constructed before any service exists.
 */
export interface RedactionSource {
  get(): Settings;
}

export class Redactor {
  private source: RedactionSource | null;
  private rules: readonly CompiledRule[] = NO_RULES;
  /**
   * Identity of the `Settings` object the rules were built from. SettingsService
   * caches one frozen-in-practice object per configuration and replaces it on
   * every write, so a reference comparison is an exact, allocation-free "have
   * the values changed?" test - which matters, because logging is hot and this
   * runs on every single line.
   */
  private compiledFrom: Settings | null = null;

  constructor(source: RedactionSource | null = null) {
    this.source = source;
  }

  /** Late binding, for the logger: it exists before settings can be read. */
  setSource(source: RedactionSource | null): void {
    this.source = source;
    this.rules = NO_RULES;
    this.compiledFrom = null;
  }

  private compile(): readonly CompiledRule[] {
    const settings = this.source?.get() ?? null;
    if (settings === null) return NO_RULES;
    if (settings === this.compiledFrom) return this.rules;

    const { profile, llm, sync } = settings;
    const candidates: readonly (readonly [string, RedactionLabel])[] = [
      [profile.fullName, 'name'],
      [profile.firstName, 'name'],
      [profile.lastName, 'name'],
      [profile.email, 'email'],
      [profile.phone, 'phone'],
      [profile.city, 'city'],
      [profile.postalCode, 'postal-code'],
      [profile.linkedinUrl, 'url'],
      [profile.githubUrl, 'url'],
      [llm.apiKey, 'secret'],
      [sync.secretKey, 'secret'],
    ];

    const rules: CompiledRule[] = [];
    const seen = new Set<string>();
    for (const [raw, label] of candidates) {
      const value = raw.trim();
      // The guard that makes an empty or near-empty profile field inert rather
      // than catastrophic. Never relax it.
      if (value.length < MIN_REDACTABLE_LENGTH) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ pattern: valuePattern(value), token: redactionToken(label), length: value.length });
    }
    // Longest first, so a full name is replaced as one unit instead of being
    // eaten piecemeal by its own first and last name rules.
    rules.sort((a, b) => b.length - a.length);

    this.rules = rules;
    this.compiledFrom = settings;
    return this.rules;
  }

  /** Scrubs one string. Safe to call on hot paths; see `compiledFrom`. */
  text(value: string): string {
    if (value.length === 0) return value;
    let out = value;
    for (const rule of this.compile()) out = out.replace(rule.pattern, rule.token);
    // `indexOf` beats running the pattern: most log lines contain no address.
    if (out.includes('@')) out = out.replace(EMAIL_PATTERN, redactionToken('email'));
    if (HAS_DIGIT.test(out)) {
      out = out.replace(PHONE_CANDIDATE_PATTERN, (match) =>
        isPhoneLike(match) ? redactionToken('phone') : match,
      );
    }
    return out;
  }

  /** Convenience for nullable columns, which most stored text is. */
  nullable(value: string | null): string | null {
    return value === null ? null : this.text(value);
  }
}

/**
 * The process-wide instance the logger uses.
 *
 * The logger is built by the composition root before `SettingsService` exists -
 * SettingsService needs a Logger - so the profile values cannot be injected at
 * construction. Until a source is installed the scrubber still runs, using the
 * generic email and phone patterns only, which is exactly the "empty profile"
 * case the class already handles.
 */
const defaultRedactor = new Redactor(null);

export function installRedactionSource(source: RedactionSource): void {
  defaultRedactor.setSource(source);
}

/** Test seam: restores the pattern-only behaviour. */
export function clearRedactionSource(): void {
  defaultRedactor.setSource(null);
}

export function redactText(value: string): string {
  return defaultRedactor.text(value);
}
