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
  /** True when a checkbox/radio group is a consent or acknowledgement gate. */
  isConsent: boolean;
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

const YES_NO_MATCHERS: { pattern: RegExp; resolve: (profile: ProfileSettings) => boolean }[] = [
  {
    pattern: /\b(require|need).{0,30}(sponsorship|visa)\b|\bsponsorship\b.{0,20}\brequire/,
    resolve: (profile) => profile.requiresSponsorship,
  },
  {
    pattern: /\b(legally )?(authorized|authorised|eligible).{0,30}(work|employment)\b/,
    resolve: (profile) => profile.authorizedToWork,
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
  return target.evaluate(() => {
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
        currentValue:
          kind === 'checkbox' || kind === 'radio'
            ? String((element as HTMLInputElement).checked)
            : ((element as HTMLInputElement).value ?? ''),
        isConsent:
          kind === 'checkbox' &&
          /consent|agree|acknowledge|privacy|terms|gdpr|policy|certify/i.test(label),
      });
    });

    return fields;
  }) as unknown as Promise<FormField[]>;
}

export function fieldSelector(field: FormField): string {
  return `[data-deedy-field="${field.index}"]`;
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

  if (field.kind === 'select' || field.kind === 'radio') {
    for (const matcher of YES_NO_MATCHERS) {
      if (!matcher.pattern.test(haystack)) continue;
      const wanted = matcher.resolve(profile) ? 'yes' : 'no';
      const option = field.options.find((opt) => normalizeText(opt).startsWith(wanted));
      if (option) return { value: option, source: 'profile', confidence: 0.9 };
    }
    return null;
  }

  if (field.kind === 'checkbox') {
    if (field.isConsent) return { value: 'true', source: 'profile', confidence: 0.95 };
    for (const matcher of YES_NO_MATCHERS) {
      if (matcher.pattern.test(haystack)) {
        return { value: String(matcher.resolve(profile)), source: 'profile', confidence: 0.85 };
      }
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
