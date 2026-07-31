import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

import { DEFAULT_SETTINGS, type ProfileSettings } from '@deedy/shared';
import {
  fieldSelector,
  fillField,
  resolveFromProfile,
  scanFields,
  type FieldKind,
  type FormField,
} from '../../src/browser/form.filler.js';

const BROWSER_TIMEOUT_MS = 60000;

/** noUncheckedIndexedAccess makes every index access optional; fail loudly instead. */
function at(fields: FormField[], index: number): FormField {
  const found = fields[index];
  if (!found) throw new Error(`expected a scanned field at index ${index}`);
  return found;
}

function profile(overrides: Partial<ProfileSettings> = {}): ProfileSettings {
  return {
    ...DEFAULT_SETTINGS.profile,
    fullName: 'Jane Q. Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@localhost.test',
    phone: '+1 555 0100',
    city: 'Austin',
    state: 'Texas',
    country: 'United States',
    postalCode: '78701',
    linkedinUrl: 'https://linkedin.com/in/janedoe',
    githubUrl: 'https://github.com/janedoe',
    portfolioUrl: 'https://janedoe.test',
    yearsOfExperience: 7,
    requiresSponsorship: false,
    authorizedToWork: true,
    willingToRelocate: true,
    noticePeriodDays: 30,
    desiredSalary: 185000,
    ...overrides,
  };
}

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    index: 0,
    kind: 'text' as FieldKind,
    label: '',
    name: '',
    placeholder: '',
    required: false,
    options: [],
    currentValue: '',
    isConsent: false,
    ...overrides,
  };
}

describe('resolveFromProfile - identity and contact fields', () => {
  it('maps first and last name variants', () => {
    expect(resolveFromProfile(field({ label: 'First Name *', name: 'first_name' }), profile()))
      .toEqual({ value: 'Jane', source: 'profile', confidence: 0.95 });
    expect(resolveFromProfile(field({ label: 'Given name', name: 'given-name' }), profile()))
      .toEqual({ value: 'Jane', source: 'profile', confidence: 0.95 });
    expect(resolveFromProfile(field({ label: 'Surname', name: 'surname' }), profile()))
      .toEqual({ value: 'Doe', source: 'profile', confidence: 0.95 });
    expect(resolveFromProfile(field({ label: 'Last Name', name: 'lastName' }), profile()))
      .toEqual({ value: 'Doe', source: 'profile', confidence: 0.95 });
  });

  it('uses the stored full name when it is set', () => {
    expect(resolveFromProfile(field({ label: 'Full name', name: 'name' }), profile())).toEqual({
      value: 'Jane Q. Doe',
      source: 'profile',
      confidence: 0.95,
    });
  });

  it('falls back to first + last when the full name is blank', () => {
    // A whitespace-only value still enters the branch, unlike '' which is skipped.
    const resolved = resolveFromProfile(
      field({ label: 'Candidate name', name: 'candidate_name' }),
      profile({ fullName: '   ' }),
    );
    expect(resolved).toEqual({ value: 'Jane Doe', source: 'profile', confidence: 0.95 });
  });

  it('maps email, phone and location fields', () => {
    expect(resolveFromProfile(field({ label: 'Email', name: 'email', kind: 'email' }), profile())
      ?.value).toBe('jane@localhost.test');
    expect(resolveFromProfile(field({ label: 'E-mail address', name: 'contact' }), profile())
      ?.value).toBe('jane@localhost.test');
    expect(resolveFromProfile(field({ label: 'Mobile phone', name: 'phone', kind: 'tel' }), profile())
      ?.value).toBe('+1 555 0100');
    expect(resolveFromProfile(field({ label: 'City', name: 'city' }), profile())?.value).toBe(
      'Austin',
    );
    expect(resolveFromProfile(field({ label: 'Town', name: 'locality' }), profile())?.value).toBe(
      'Austin',
    );
  });

  it('maps profile URLs to the right property', () => {
    expect(
      resolveFromProfile(field({ label: 'LinkedIn Profile', name: 'linkedin', kind: 'url' }), profile())
        ?.value,
    ).toBe('https://linkedin.com/in/janedoe');
    expect(resolveFromProfile(field({ label: 'GitHub', name: 'github' }), profile())?.value).toBe(
      'https://github.com/janedoe',
    );
    expect(resolveFromProfile(field({ label: 'Personal website', name: 'site' }), profile())?.value)
      .toBe('https://janedoe.test');
  });

  it('stringifies numeric profile values', () => {
    expect(
      resolveFromProfile(
        field({ label: 'Years of professional experience', name: 'yoe', kind: 'number' }),
        profile(),
      ),
    ).toEqual({ value: '7', source: 'profile', confidence: 0.95 });
    expect(
      resolveFromProfile(field({ label: 'Expected salary', name: 'salary' }), profile())?.value,
    ).toBe('185000');
    expect(
      resolveFromProfile(field({ label: 'Notice period', name: 'notice' }), profile())?.value,
    ).toBe('30');
  });

  it('skips matched fields whose profile value is empty and unmatched fields', () => {
    expect(resolveFromProfile(field({ label: 'City', name: 'city' }), profile({ city: '' }))).toBeNull();
    expect(
      resolveFromProfile(field({ label: 'Favourite colour', name: 'colour' }), profile()),
    ).toBeNull();
    expect(resolveFromProfile(field({ label: '', name: '', placeholder: '' }), profile())).toBeNull();
  });

  it('matches against the placeholder when the label is missing', () => {
    expect(
      resolveFromProfile(field({ label: '', name: '', placeholder: 'you@example.com e-mail' }), profile())
        ?.value,
    ).toBe('jane@localhost.test');
  });
});

describe('resolveFromProfile - yes/no questions', () => {
  const yesNo = ['Yes', 'No'];

  it('answers sponsorship questions from requiresSponsorship', () => {
    const sponsorship = field({
      kind: 'select',
      label: 'Will you now or in the future require sponsorship for an employment visa?',
      name: 'sponsorship',
      options: yesNo,
    });
    expect(resolveFromProfile(sponsorship, profile({ requiresSponsorship: false }))).toEqual({
      value: 'No',
      source: 'profile',
      confidence: 0.9,
    });
    expect(resolveFromProfile(sponsorship, profile({ requiresSponsorship: true }))?.value).toBe('Yes');
  });

  it('answers work authorization questions from authorizedToWork', () => {
    const authorized = field({
      kind: 'radio',
      label: 'Are you legally authorized to work in the United States?',
      name: 'work_auth',
      options: yesNo,
    });
    expect(resolveFromProfile(authorized, profile())).toEqual({
      value: 'Yes',
      source: 'profile',
      confidence: 0.9,
    });
    expect(resolveFromProfile(authorized, profile({ authorizedToWork: false }))?.value).toBe('No');
  });

  it('answers relocation questions from willingToRelocate', () => {
    const relocate = field({
      kind: 'radio',
      label: 'Are you willing to relocate?',
      name: 'relocate',
      options: ['Yes, I am', 'No, I am not'],
    });
    expect(resolveFromProfile(relocate, profile({ willingToRelocate: true }))?.value).toBe('Yes, I am');
    expect(resolveFromProfile(relocate, profile({ willingToRelocate: false }))?.value).toBe(
      'No, I am not',
    );
  });

  it('returns null when no option matches the wanted answer', () => {
    const relocate = field({
      kind: 'select',
      label: 'Are you willing to relocate?',
      name: 'relocate',
      options: ['Maybe', 'Prefer not to say'],
    });
    expect(resolveFromProfile(relocate, profile())).toBeNull();
  });

  it('leaves free-text and unknown choice questions to the LLM', () => {
    expect(
      resolveFromProfile(
        field({ kind: 'select', label: 'How did you hear about us?', name: 'source', options: ['Friend'] }),
        profile(),
      ),
    ).toBeNull();
    // Name matchers must not hijack a select widget.
    expect(
      resolveFromProfile(
        field({ kind: 'select', label: 'First name', name: 'first_name', options: ['Jane'] }),
        profile(),
      ),
    ).toBeNull();
  });
});

describe('resolveFromProfile - checkboxes', () => {
  it('always accepts a consent checkbox', () => {
    expect(
      resolveFromProfile(
        field({ kind: 'checkbox', label: 'I agree to the privacy policy', name: 'consent', isConsent: true }),
        profile(),
      ),
    ).toEqual({ value: 'true', source: 'profile', confidence: 0.95 });
  });

  it('answers a boolean checkbox from the matching profile flag', () => {
    const relocate = field({
      kind: 'checkbox',
      label: 'I am willing to relocate for this role',
      name: 'relocate',
    });
    expect(resolveFromProfile(relocate, profile({ willingToRelocate: true }))).toEqual({
      value: 'true',
      source: 'profile',
      confidence: 0.85,
    });
    expect(resolveFromProfile(relocate, profile({ willingToRelocate: false }))?.value).toBe('false');
    expect(
      resolveFromProfile(
        field({ kind: 'checkbox', label: 'Do I need visa sponsorship? I require sponsorship', name: 'spon' }),
        profile({ requiresSponsorship: true }),
      )?.value,
    ).toBe('true');
  });

  it('returns null for an unrecognised checkbox', () => {
    expect(
      resolveFromProfile(
        field({ kind: 'checkbox', label: 'Subscribe to the newsletter', name: 'newsletter' }),
        profile(),
      ),
    ).toBeNull();
  });
});

describe('fieldSelector', () => {
  it('targets the index stamped by scanFields', () => {
    expect(fieldSelector(field({ index: 4 }))).toBe('[data-deedy-field="4"]');
  });
});

const FORM_HTML = `<!doctype html>
<html>
  <body>
    <form>
      <div class="row">
        <label for="first-name">First name</label>
        <input id="first-name" name="first_name" type="text" placeholder="Jane" required />
      </div>
      <div class="row">
        <textarea name="cover_letter" aria-label="Why do you want this role?" rows="4"></textarea>
      </div>
      <div class="row">
        <label for="experience">Years of experience *</label>
        <select id="experience" name="years_of_experience">
          <option value="">Select an option</option>
          <option value="1">0-2 years</option>
          <option value="2">3-5 years</option>
          <option value="3">6+ years</option>
        </select>
      </div>
      <fieldset>
        <legend>Are you willing to relocate?</legend>
        <label for="relocate-yes">Yes</label>
        <input id="relocate-yes" type="radio" name="relocate" value="yes" />
        <label for="relocate-no">No</label>
        <input id="relocate-no" type="radio" name="relocate" value="no" />
      </fieldset>
      <div class="row">
        <label for="consent"><input id="consent" name="consent" type="checkbox" /> I agree to the privacy policy</label>
      </div>
      <input type="hidden" name="csrf_token" value="never-fill-me" />
      <button type="submit">Submit</button>
    </form>
  </body>
</html>`;

describe('scanFields + fillField against a real page', () => {
  let browser: Browser | null = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      // No browser binaries on this host: the suite degrades to the pure tests above.
      browser = null;
    }
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    browser = null;
  }, BROWSER_TIMEOUT_MS);

  it(
    'describes every visible field and writes the resolved values back into the DOM',
    async (ctx) => {
      const launched = browser;
      if (!launched) {
        ctx.skip();
        return;
      }

      const context = await launched.newContext();
      const page: Page = await context.newPage();
      try {
        await page.setContent(FORM_HTML);
        const fields = await scanFields(page);

        // The hidden input is dropped; a radio group collapses into a single entry
        // carried by its first radio.
        expect(fields.map((entry) => entry.name)).toEqual([
          'first_name',
          'cover_letter',
          'years_of_experience',
          'relocate',
          'consent',
        ]);
        expect(fields.map((entry) => entry.kind)).toEqual([
          'text',
          'textarea',
          'select',
          'radio',
          'checkbox',
        ]);
        expect(fields.every((entry) => entry.name !== 'csrf_token')).toBe(true);

        const text = at(fields, 0);
        const textarea = at(fields, 1);
        const select = at(fields, 2);
        const radio = at(fields, 3);
        const consent = at(fields, 4);

        expect(text.label).toBe('First name');
        expect(text.placeholder).toBe('Jane');
        expect(text.required).toBe(true);
        expect(text.options).toEqual([]);
        expect(text.currentValue).toBe('');

        expect(textarea.label).toBe('Why do you want this role?');
        expect(textarea.required).toBe(false);

        expect(select.label).toBe('Years of experience *');
        // Required is inferred from the asterisk, not from a `required` attribute.
        expect(select.required).toBe(true);
        expect(select.options).toEqual(['Select an option', '0-2 years', '3-5 years', '6+ years']);

        expect(radio.options).toEqual(['Yes', 'No']);
        expect(radio.currentValue).toBe('false');
        expect(radio.isConsent).toBe(false);

        expect(consent.label).toBe('I agree to the privacy policy');
        expect(consent.isConsent).toBe(true);
        expect(consent.currentValue).toBe('false');
        expect(fieldSelector(consent)).toBe(`[data-deedy-field="${consent.index}"]`);

        expect(await fillField(page, text, 'Jane')).toBe(true);
        expect(await fillField(page, textarea, 'Because the stack is fully local.')).toBe(true);
        expect(await fillField(page, select, '3-5 years')).toBe(true);
        expect(await fillField(page, radio, 'Yes')).toBe(true);
        expect(await fillField(page, consent, 'true')).toBe(true);

        expect(await page.inputValue('#first-name')).toBe('Jane');
        expect(await page.inputValue('textarea[name="cover_letter"]')).toBe(
          'Because the stack is fully local.',
        );
        expect(await page.inputValue('#experience')).toBe('2');
        expect(await page.isChecked('#relocate-yes')).toBe(true);
        expect(await page.isChecked('#relocate-no')).toBe(false);
        expect(await page.isChecked('#consent')).toBe(true);
        expect(await page.inputValue('input[name="csrf_token"]')).toBe('never-fill-me');

        // Unchecking a consent box and picking a missing option must be handled, not thrown.
        expect(await fillField(page, consent, 'false')).toBe(true);
        expect(await page.isChecked('#consent')).toBe(false);
        expect(await fillField(page, select, 'a decade')).toBe(false);
        expect(await fillField(page, { ...radio, name: '' }, 'Yes')).toBe(false);
        expect(await fillField(page, { ...text, kind: 'file' }, '/tmp/resume.pdf')).toBe(false);

        // A rescan sees the values that were just written.
        const rescanned = await scanFields(page);
        expect(at(rescanned, 0).currentValue).toBe('Jane');
        expect(at(rescanned, 3).currentValue).toBe('true');
      } finally {
        await context.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
