/**
 * The half of the snapshot redaction that only a real browser can prove.
 *
 * `fill()` sets the value IDL property and leaves the `value` ATTRIBUTE alone,
 * so `page.content()` on a freshly filled form serialises the site's defaults
 * and not what was typed — which is exactly why the in-page pass exists and why
 * a string-level test cannot stand in for this one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { DEFAULT_SETTINGS, type Settings } from '@deedy/shared';

import {
  neutraliseLiveFormValues,
  redactHtmlSnapshot,
  REDACTED_INPUT,
} from '../../src/browser/browser.manager.js';
import { Redactor } from '../../src/core/redact.js';

const BROWSER_TIMEOUT_MS = 60000;

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  profile: {
    ...DEFAULT_SETTINGS.profile,
    fullName: 'Jane Q. Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.doe@localhost.test',
    phone: '+1 555 0100 991',
    city: 'Austin',
  },
};
const redactor = new Redactor({ get: () => settings });

/** Attribute values are the site's own defaults, as they are on a real page. */
const PAGE = `
  <form id="apply" class="ia-Form">
    <label for="name">Full name</label>
    <input id="name" name="applicant.name" type="text" placeholder="Your name">
    <label for="email">Email address</label>
    <input id="email" name="applicant.email" type="email">
    <input type="hidden" name="csrf" value="live-session-token-9f2">
    <label for="cover">Cover letter</label>
    <textarea id="cover" name="applicant.cover" rows="6"></textarea>
    <div id="notes" contenteditable="true"></div>
    <label><input type="checkbox" name="relocate" checked> Willing to relocate</label>
    <select name="auth"><option value="yes">Yes</option><option value="no">No</option></select>
    <button type="submit">Continue</button>
  </form>`;

describe('in-page snapshot redaction', () => {
  let browser: Browser;
  let page: Page;
  let raw: string;
  let redacted: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setContent(PAGE, { waitUntil: 'load' });
    await page.fill('#name', 'Jane Q. Doe');
    await page.fill('#email', 'jane.doe@localhost.test');
    await page.fill('#cover', 'Reach me on +1 555 0100 991 — Jane Q. Doe');
    await page.evaluate(() => {
      const notes = document.querySelector('#notes');
      if (notes) notes.textContent = 'Prefers Austin';
    });
    await page.selectOption('select[name="auth"]', 'no');

    raw = await page.content();
    redacted = redactHtmlSnapshot(
      await page.evaluate(neutraliseLiveFormValues, REDACTED_INPUT),
      redactor,
    );
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  /** The premise of the whole in-page pass — if this ever stops holding, say so. */
  it('serialised markup does not carry the typed values, but the live tree does', async () => {
    expect(raw).not.toContain('Jane Q. Doe');
    await expect(page.inputValue('#name')).resolves.toBe('Jane Q. Doe');
  });

  it('replaces what the run typed with the marker', () => {
    expect(redacted).not.toContain('Jane Q. Doe');
    expect(redacted).not.toContain('jane.doe@localhost.test');
    expect(redacted).not.toContain('555 0100 991');
    expect(redacted).not.toContain('Prefers Austin');
    expect(redacted).not.toContain('live-session-token-9f2');
    expect(redacted).toContain(`value="${REDACTED_INPUT}"`);
    expect(redacted).toContain(`<textarea id="cover" name="applicant.cover" rows="6">`);
  });

  /** State the run produced but the candidate did not type: keep it, it is the evidence. */
  it('keeps structure, labels, options and checkbox state', () => {
    for (const fragment of [
      'id="apply"',
      'class="ia-Form"',
      '<label for="name">Full name</label>',
      'name="applicant.email"',
      'placeholder="Your name"',
      'name="csrf"',
      '<option value="yes">Yes</option>',
      '<option value="no" selected="">No</option>',
      '<button type="submit">Continue</button>',
    ]) {
      expect(redacted).toContain(fragment);
    }
    expect(redacted).toMatch(/<input type="checkbox" name="relocate" checked=""/);
  });
});
