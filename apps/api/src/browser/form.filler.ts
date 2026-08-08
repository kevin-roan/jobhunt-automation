import type { Frame, Page } from 'playwright';
import type { ProfileSettings } from '@deedy/shared';
import { normalizeText } from '../core/utils.js';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file';

export interface FormField {
  /** Index used to build the `[data-deedy-field="N"]` selector. */
  index: number;
  kind: FieldKind;
  label: string;
  name: string;
  placeholder: string;
  required: boolean;
  options: string[];
  currentValue: string;
  /** True when a checkbox is a benign acknowledgement gate — see `classifyConsentText`. */
  isConsent: boolean;
  /** True when the field is a personal declaration the candidate must make themselves. */
  isAttestation: boolean;
}

/**
 * Wording that turns a field into a declaration made under the candidate's own
 * name — a certification of truthfulness, an eligibility attestation, or a
 * signature. Ticking one of these is the candidate saying something about
 * themselves that an employer (and sometimes a court) may rely on, so it is
 * always escalated to the human, never inferred.
 *
 * The line is drawn at the verbs that carry legal weight — certify, attest,
 * declare, affirm, swear, penalty of perjury — plus explicit signature widgets
 * and any "… is true / accurate / correct / complete" formulation. Deliberately
 * NOT included: "agree", "acknowledge", "consent", "confirm" on their own. Those
 * words carry every cookie banner and terms-of-service tick on the web, and
 * escalating them would halt essentially every application.
 *
 * `certify` is matched only as the bare verb: "certification"/"certified" appear
 * in ordinary skills questions ("Are you AWS certified?") that must not escalate.
 */
const ATTESTATION_PATTERN =
  /\b(certify|certifying|attest|attests|attesting|attestation|declare|declares|declaring|declaration|affirm|affirms|swear|perjury)\b|\bunder penalt|\b(e-?signature|signature|signed below|sign here|initials)\b|\b(information|statements?|answers?|details?|responses?)\b[^.]{0,80}\b(true|accurate|correct|complete|truthful)\b/;

/**
 * Wording that makes a checkbox a benign acknowledgement — privacy policies,
 * terms, cookie/GDPR notices, marketing opt-ins. These are auto-ticked because
 * refusing them just blocks the application without protecting anyone.
 */
const BENIGN_CONSENT_PATTERN =
  /\b(consent|agree|agreement|acknowledge|acknowledgement|privacy|terms|conditions|gdpr|ccpa|policy|policies|cookies?|data protection|processing|newsletter|marketing|subscribe|updates|opt[\s-]?in|opt[\s-]?out)\b/;

/**
 * Splits acknowledgement wording from declaration wording. Attestation always
 * wins: "I agree that the information provided is true" is an agreement in
 * grammar and a sworn statement in substance.
 */
export function classifyConsentText(text: string): { isConsent: boolean; isAttestation: boolean } {
  const isAttestation = ATTESTATION_PATTERN.test(text);
  return { isAttestation, isConsent: !isAttestation && BENIGN_CONSENT_PATTERN.test(text) };
}

const PROFILE_MATCHERS: { pattern: RegExp; field: keyof ProfileSettings }[] = [
  { pattern: /\b(first[\s_-]?name|given[\s_-]?name|forename)\b/, field: 'firstName' },
  { pattern: /\b(last[\s_-]?name|surname|family[\s_-]?name)\b/, field: 'lastName' },
  { pattern: /\b(full[\s_-]?name|your name|candidate name)\b|^name$/, field: 'fullName' },
  { pattern: /\b(e[\s_-]?mail)\b/, field: 'email' },
  { pattern: /\b(phone|mobile|telephone|contact number)\b/, field: 'phone' },
  { pattern: /\b(city|town)\b/, field: 'city' },
  { pattern: /\b(state|province|region)\b/, field: 'state' },
  { pattern: /\b(country)\b/, field: 'country' },
  { pattern: /\b(zip|postal[\s_-]?code|postcode)\b/, field: 'postalCode' },
  { pattern: /\b(linkedin)\b/, field: 'linkedinUrl' },
  { pattern: /\b(github)\b/, field: 'githubUrl' },
  { pattern: /\b(portfolio|website|personal site)\b/, field: 'portfolioUrl' },
  { pattern: /\b(years? of (professional )?experience)\b/, field: 'yearsOfExperience' },
  { pattern: /\b(desired|expected)\s+(salary|compensation)\b/, field: 'desiredSalary' },
  { pattern: /\b(notice period)\b/, field: 'noticePeriodDays' },
];

/**
 * Jurisdictions we can recognise on both sides of a work-authorization question.
 * Deliberately short: an unrecognised country on either side means "no opinion",
 * which leaves the pre-existing behaviour untouched rather than inventing a
 * mismatch out of a string we do not understand.
 */
const JURISDICTIONS: { code: string; pattern: RegExp }[] = [
  { code: 'us', pattern: /\b(united states|u\.s\.a?\.?|usa|america)\b/ },
  { code: 'ca', pattern: /\bcanada\b/ },
  { code: 'gb', pattern: /\b(united kingdom|u\.k\.|uk|great britain|britain|england|scotland|wales)\b/ },
  { code: 'ie', pattern: /\bireland\b/ },
  { code: 'de', pattern: /\bgermany|deutschland\b/ },
  { code: 'fr', pattern: /\bfrance\b/ },
  { code: 'nl', pattern: /\b(netherlands|holland)\b/ },
  { code: 'es', pattern: /\bspain\b/ },
  { code: 'it', pattern: /\bitaly\b/ },
  { code: 'au', pattern: /\baustralia\b/ },
  { code: 'nz', pattern: /\bnew zealand\b/ },
  { code: 'in', pattern: /\bindia\b/ },
  { code: 'sg', pattern: /\bsingapore\b/ },
  { code: 'ae', pattern: /\b(united arab emirates|u\.a\.e\.?|uae)\b/ },
  { code: 'eu', pattern: /\b(european union|eu|eea|schengen)\b/ },
];

const EU_MEMBERS = new Set(['ie', 'de', 'fr', 'nl', 'es', 'it']);

function detectJurisdiction(text: string): string | null {
  return JURISDICTIONS.find((entry) => entry.pattern.test(text))?.code ?? null;
}

/**
 * True when the question asks about a country the candidate's profile does not
 * describe. "Are you authorized to work in the United States?" answered from a
 * flag set by someone living in India is a legal declaration about the wrong
 * jurisdiction, and a wrong one is worse than an escalation.
 */
function jurisdictionConflict(haystack: string, profile: ProfileSettings): boolean {
  const asked = detectJurisdiction(haystack);
  const home = detectJurisdiction(normalizeText(profile.country));
  if (!asked || !home || asked === home) return false;
  if (asked === 'eu' && EU_MEMBERS.has(home)) return false;
  if (home === 'eu' && EU_MEMBERS.has(asked)) return false;
  return true;
}

/**
 * `resolve` returns null for "the candidate never stated this", which the caller
 * turns into an escalation.
 *
 * Today `requiresSponsorship`, `authorizedToWork` and `willingToRelocate` are
 * non-nullable booleans with schema defaults, so a default is indistinguishable
 * from a deliberate answer and null is unreachable for them — the nullable
 * return type is what lets `packages/shared/src/settings.ts` make those three
 * `.nullable().default(null)` (the way `yearsOfExperience` already is) without a
 * single change here. `jurisdictional` marks the two that are legal
 * declarations about a specific country.
 */
const YES_NO_MATCHERS: {
  pattern: RegExp;
  resolve: (profile: ProfileSettings) => boolean | null;
  jurisdictional?: boolean;
}[] = [
  {
    pattern: /\b(require|need).{0,30}(sponsorship|visa)\b|\bsponsorship\b.{0,20}\brequire/,
    resolve: (profile) => profile.requiresSponsorship,
    jurisdictional: true,
  },
  {
    pattern: /\b(legally )?(authorized|authorised|eligible).{0,30}(work|employment)\b/,
    resolve: (profile) => profile.authorizedToWork,
    jurisdictional: true,
  },
  {
    pattern: /\b(willing|able).{0,20}(relocate|relocation)\b/,
    resolve: (profile) => profile.willingToRelocate,
  },
  {
    pattern: /\b(are you|have you).{0,20}(18|eighteen)\b/,
    resolve: () => true,
  },
];

/**
 * Tags every input in the (i)frame with a stable index and returns a structured
 * description of each field. Running this in the page avoids fragile CSS-path
 * generation on the Node side.
 */
export async function scanFields(target: Page | Frame): Promise<FormField[]> {
  // The callback is serialised into the page, so the classification patterns have
  // to travel as source strings rather than as the compiled regexes above.
  const patterns = {
    attestation: ATTESTATION_PATTERN.source,
    consent: BENIGN_CONSENT_PATTERN.source,
  };

  return target.evaluate((sources: { attestation: string; consent: string }) => {
    const attestationPattern = new RegExp(sources.attestation, 'i');
    const consentPattern = new RegExp(sources.consent, 'i');

    // Attributes from a previous scan would otherwise linger on elements this
    // scan skips (hidden, removed from the flow, or now inside a closed step),
    // and `[data-deedy-field="N"]` would match two elements — a Playwright
    // strict-mode violation that silently drops the field.
    document
      .querySelectorAll('[data-deedy-field]')
      .forEach((element) => element.removeAttribute('data-deedy-field'));

    const kindOf = (element: Element): string => {
      if (element.tagName === 'TEXTAREA') return 'textarea';
      if (element.tagName === 'SELECT') return 'select';
      const type = (element as HTMLInputElement).type?.toLowerCase() ?? 'text';
      if (['email', 'tel', 'url', 'number', 'date', 'file', 'radio', 'checkbox'].includes(type)) {
        return type;
      }
      return 'text';
    };

    const labelFor = (element: HTMLElement): string => {
      const id = element.getAttribute('id');
      if (id) {
        const escaped = id.replace(/["\\]/g, '\\$&');
        const explicit = document.querySelector(`label[for="${escaped}"]`);
        if (explicit?.textContent) return explicit.textContent.trim();
      }
      const wrapping = element.closest('label');
      if (wrapping?.textContent) return wrapping.textContent.trim();

      const aria = element.getAttribute('aria-label');
      if (aria) return aria.trim();

      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((ref) => document.getElementById(ref)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (text) return text;
      }

      // Walk up to a field wrapper and take its first label-ish descendant.
      let node: HTMLElement | null = element.parentElement;
      for (let depth = 0; node && depth < 4; depth += 1) {
        const candidate = node.querySelector('label, legend, .label, [class*="label"]');
        if (candidate?.textContent?.trim()) return candidate.textContent.trim();
        node = node.parentElement;
      }
      return element.getAttribute('name') ?? '';
    };

    const isVisible = (element: HTMLElement): boolean => {
      if (element.hasAttribute('hidden')) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      // File inputs are routinely zero-sized behind a styled button.
      if ((element as HTMLInputElement).type === 'file') return true;
      return rect.width > 0 && rect.height > 0;
    };

    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('input, textarea, select'),
    ).filter((element) => {
      const type = (element as HTMLInputElement).type?.toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') {
        return false;
      }
      return isVisible(element);
    });

    const fields: {
      index: number;
      kind: string;
      label: string;
      name: string;
      placeholder: string;
      required: boolean;
      options: string[];
      currentValue: string;
      isConsent: boolean;
      isAttestation: boolean;
    }[] = [];
    const seenRadioGroups = new Set<string>();

    elements.forEach((element, position) => {
      const kind = kindOf(element);
      const name = element.getAttribute('name') ?? '';

      // Represent a radio group once, carrying all of its option labels.
      if (kind === 'radio') {
        const groupKey = name || labelFor(element);
        if (seenRadioGroups.has(groupKey)) return;
        seenRadioGroups.add(groupKey);
      }

      element.setAttribute('data-deedy-field', String(position));

      let options: string[] = [];
      if (kind === 'select') {
        options = Array.from((element as HTMLSelectElement).options)
          .map((option) => option.textContent?.trim() ?? '')
          .filter((text) => text.length > 0);
      } else if (kind === 'radio' && name) {
        options = Array.from(
          document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`),
        ).map((radio) => labelFor(radio));
      }

      const label = labelFor(element);
      fields.push({
        index: position,
        kind,
        label,
        name,
        placeholder: element.getAttribute('placeholder') ?? '',
        required:
          element.hasAttribute('required') ||
          element.getAttribute('aria-required') === 'true' ||
          /\*/.test(label),
        options,
        // A radio group answers as a group: the entry stands for every radio
        // sharing the name, so "No" being selected has to read as answered, not
        // as an empty first radio.
        currentValue:
          kind === 'radio' && name
            ? String(
                Array.from(
                  document.querySelectorAll<HTMLInputElement>(
                    `input[type="radio"][name="${CSS.escape(name)}"]`,
                  ),
                ).some((radio) => radio.checked),
              )
            : kind === 'checkbox' || kind === 'radio'
              ? String((element as HTMLInputElement).checked)
              : ((element as HTMLInputElement).value ?? ''),
        // Attestation wins over consent — see `classifyConsentText`.
        isConsent:
          kind === 'checkbox' && !attestationPattern.test(label) && consentPattern.test(label),
        isAttestation: attestationPattern.test(label),
      });
    });

    return fields;
  }, patterns) as unknown as Promise<FormField[]>;
}

export function fieldSelector(field: FormField): string {
  return `[data-deedy-field="${field.index}"]`;
}

/**
 * True when the field still has no answer. Checkboxes and radio groups carry the
 * strings 'true'/'false', and 'false' is truthy — reading `currentValue` directly
 * counts every unticked required box as answered.
 */
export function isFieldEmpty(field: FormField): boolean {
  if (field.kind === 'checkbox' || field.kind === 'radio') return field.currentValue !== 'true';
  return field.currentValue.trim() === '';
}

export interface ResolvedAnswer {
  value: string;
  source: 'profile' | 'answer_bank' | 'llm' | 'default';
  confidence: number;
}

/** Answers a field from the candidate profile alone, when the mapping is unambiguous. */
export function resolveFromProfile(
  field: FormField,
  profile: ProfileSettings,
): ResolvedAnswer | null {
  const haystack = normalizeText(`${field.label} ${field.name} ${field.placeholder}`);
  if (!haystack) return null;

  // No declaration is ever made on the candidate's behalf. The flag is recomputed
  // from the full haystack rather than trusted, so a field built by hand — or one
  // whose signature wording lives in the name attribute — is covered too.
  if (field.isAttestation || classifyConsentText(haystack).isAttestation) return null;

  if (field.kind === 'select' || field.kind === 'radio') {
    for (const matcher of YES_NO_MATCHERS) {
      if (!matcher.pattern.test(haystack)) continue;
      const stated = matcher.resolve(profile);
      if (stated === null) return null;
      if (matcher.jurisdictional && jurisdictionConflict(haystack, profile)) return null;
      const wanted = stated ? 'yes' : 'no';
      const option = field.options.find((opt) => normalizeText(opt).startsWith(wanted));
      if (option) return { value: option, source: 'profile', confidence: 0.9 };
    }
    return null;
  }

  if (field.kind === 'checkbox') {
    if (field.isConsent) return { value: 'true', source: 'profile', confidence: 0.95 };
    for (const matcher of YES_NO_MATCHERS) {
      if (!matcher.pattern.test(haystack)) continue;
      const stated = matcher.resolve(profile);
      if (stated === null) return null;
      if (matcher.jurisdictional && jurisdictionConflict(haystack, profile)) return null;
      return { value: String(stated), source: 'profile', confidence: 0.85 };
    }
    return null;
  }

  for (const matcher of PROFILE_MATCHERS) {
    if (!matcher.pattern.test(haystack)) continue;
    const raw = profile[matcher.field];
    if (raw === null || raw === undefined || raw === '') continue;
    if (matcher.field === 'fullName') {
      const value =
        profile.fullName.trim() || `${profile.firstName} ${profile.lastName}`.trim();
      if (!value) continue;
      return { value, source: 'profile', confidence: 0.95 };
    }
    return { value: String(raw), source: 'profile', confidence: 0.95 };
  }

  return null;
}

/** Applies a resolved answer to the page. Returns false when the widget refused it. */
export async function fillField(
  target: Page | Frame,
  field: FormField,
  value: string,
): Promise<boolean> {
  const locator = target.locator(fieldSelector(field));

  switch (field.kind) {
    case 'checkbox': {
      const shouldCheck = /^(true|yes|1|on)$/i.test(value.trim());
      if (shouldCheck) await locator.check({ force: true });
      else await locator.uncheck({ force: true }).catch(() => undefined);
      return true;
    }

    case 'radio': {
      const name = field.name;
      if (!name) return false;
      const radios = target.locator(`input[type="radio"][name="${cssEscape(name)}"]`);
      const total = await radios.count();
      const wanted = normalizeText(value);
      for (let i = 0; i < total; i += 1) {
        const radio = radios.nth(i);
        const label = normalizeText(await labelTextFor(target, radio));
        const radioValue = normalizeText((await radio.getAttribute('value')) ?? '');
        if (label === wanted || radioValue === wanted || label.startsWith(wanted)) {
          await radio.check({ force: true });
          return true;
        }
      }
      return false;
    }

    case 'select': {
      const wanted = normalizeText(value);
      const exact = field.options.find((option) => normalizeText(option) === wanted);
      const partial =
        exact ?? field.options.find((option) => normalizeText(option).includes(wanted));
      if (!partial) return false;
      await locator.selectOption({ label: partial });
      return true;
    }

    case 'file':
      // Files are attached by the applier, which knows the document paths.
      return false;

    default: {
      await locator.fill('');
      await locator.fill(value);
      return true;
    }
  }
}

async function labelTextFor(
  target: Page | Frame,
  locator: ReturnType<Page['locator']>,
): Promise<string> {
  const aria = await locator.getAttribute('aria-label');
  if (aria) return aria;
  const id = await locator.getAttribute('id');
  if (id) {
    const label = target.locator(`label[for="${cssEscape(id)}"]`);
    if ((await label.count()) > 0) return (await label.first().innerText()).trim();
  }
  const parentLabel = locator.locator('xpath=ancestor::label[1]');
  if ((await parentLabel.count()) > 0) return (await parentLabel.first().innerText()).trim();
  return (await locator.getAttribute('value')) ?? '';
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
