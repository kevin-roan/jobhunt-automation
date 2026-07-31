import type { Frame, Locator, Page } from 'playwright';
import { sleep, truncate } from '../../core/utils.js';
import {
  fieldSelector,
  fillField,
  resolveFromProfile,
  scanFields,
  type FormField,
} from '../form.filler.js';
import {
  dismissConsentBanners,
  formRoot,
  type ApplierDefinition,
  type ApplyContext,
  type ApplyOutcome,
} from './types.js';

export interface FormApplierConfig {
  id: string;
  provider: string;
  name: string;
  hostPatterns: RegExp[];
  /** Buttons that open the application form when it is not already visible. */
  applyButtons: string[];
  submitButtons: string[];
  confirmationPatterns: RegExp[];
  /** Selector for the cover-letter free-text area, when the provider has one. */
  coverLetterSelectors?: string[];
}

const DEFAULT_SUBMIT_BUTTONS = [
  'button[type="submit"]:has-text("Submit")',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'input[type="submit"]',
  'button:has-text("Submit")',
];

const DEFAULT_CONFIRMATIONS = [
  /thank you for applying/i,
  /application (has been )?(received|submitted)/i,
  /we(?:'| ha)ve received your application/i,
  /your application was submitted/i,
  /thanks for (your interest|applying)/i,
];

async function firstVisible(
  target: Page | Frame,
  selectors: string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = target.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
    } catch {
      // Selector unsupported on this page; try the next one.
    }
  }
  return null;
}

/** Attaches the resume (and DOCX fallback) to every file input on the form. */
async function attachDocuments(
  root: Page | Frame,
  fields: FormField[],
  context: ApplyContext,
): Promise<{ resumeAttached: boolean; coverLetterAttached: boolean }> {
  let resumeAttached = false;
  let coverLetterAttached = false;

  for (const field of fields.filter((f) => f.kind === 'file')) {
    const haystack = `${field.label} ${field.name}`.toLowerCase();
    const isCoverLetter = /cover|letter|motivation/.test(haystack);
    const path = isCoverLetter
      ? context.documents.coverLetterPath
      : (context.documents.resumePath ?? context.documents.resumeDocxPath);

    if (!path) continue;

    try {
      await root.locator(fieldSelector(field)).setInputFiles(path);
      if (isCoverLetter) coverLetterAttached = true;
      else resumeAttached = true;
      context.logger.debug('attached document', { field: field.label, path, isCoverLetter });
      await sleep(750);
    } catch (error) {
      context.logger.warn('failed to attach document', {
        field: field.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { resumeAttached, coverLetterAttached };
}

/**
 * Fills every non-file field, resolving values from the profile first and
 * escalating to the answer bank / LLM only for genuinely unknown questions.
 */
export async function fillVisibleFields(
  root: Page | Frame,
  context: ApplyContext,
  fields: FormField[],
): Promise<{ filled: number; needsHuman: string | null }> {
  let filled = 0;

  for (const field of fields) {
    if (field.kind === 'file') continue;
    if (field.currentValue && field.kind !== 'checkbox' && field.kind !== 'radio') continue;
    if (!field.label && !field.name) continue;

    const fromProfile = resolveFromProfile(field, context.profile);
    let value = fromProfile?.value ?? null;
    let source = fromProfile?.source ?? 'default';
    let confidence = fromProfile?.confidence ?? 0;

    if (value === null) {
      // Optional free-text fields are left blank rather than guessed at.
      if (!field.required && field.kind !== 'checkbox') continue;

      const resolved = await context.answer({
        question: field.label || field.name,
        fieldType: field.kind,
        options: field.options,
      });
      if (resolved.needsHuman) {
        return { filled, needsHuman: field.label || field.name };
      }
      value = resolved.value;
      source = resolved.source;
      confidence = resolved.confidence;
    }

    if (!value) continue;

    try {
      const ok = await fillField(root, field, value);
      if (ok) {
        filled += 1;
        context.logger.debug('filled field', {
          label: truncate(field.label, 80),
          kind: field.kind,
          source,
          confidence,
        });
      }
    } catch (error) {
      context.logger.warn('failed to fill field', {
        label: truncate(field.label, 80),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { filled, needsHuman: null };
}

async function detectConfirmation(
  page: Page,
  patterns: RegExp[],
): Promise<string | null> {
  const body = await page.locator('body').innerText().catch(() => '');
  for (const pattern of [...patterns, ...DEFAULT_CONFIRMATIONS]) {
    const match = pattern.exec(body);
    if (match) return truncate(match[0], 300);
  }
  return null;
}

/** Detects the captcha and human-verification gates that stop automation. */
async function detectHumanGate(page: Page): Promise<string | null> {
  const selectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '[data-sitekey]',
    'iframe[title*="challenge"]',
    'text=/verify you are human/i',
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return `Human verification challenge detected (${selector})`;
      }
    } catch {
      // Ignore selector errors and keep checking.
    }
  }
  return null;
}

/**
 * Builds an applier for a conventional single-page ATS form. Greenhouse, Lever,
 * Ashby and SmartRecruiters all use this shape; only their selectors differ.
 */
export function createFormApplier(config: FormApplierConfig): ApplierDefinition {
  return {
    id: config.id,
    provider: config.provider,
    name: config.name,

    matches(url: string): boolean {
      return config.hostPatterns.some((pattern) => pattern.test(url));
    },

    async apply(context: ApplyContext): Promise<ApplyOutcome> {
      const { page, job } = context;

      await context.recordStep('navigate', 'running');
      await page.goto(job.applicationUrl, { waitUntil: 'domcontentloaded' });
      await dismissConsentBanners(page);
      await context.recordStep('navigate', 'succeeded', { message: page.url() });

      await context.recordStep('read_description', 'running');
      const description = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      await context.recordStep('read_description', 'succeeded', {
        message: `read ${description.length} characters`,
      });

      await context.recordStep('start_application', 'running');
      const applyButton = await firstVisible(page, config.applyButtons);
      if (applyButton) {
        await applyButton.click().catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await sleep(1200);
      }
      const root = await formRoot(page);
      await context.recordStep('start_application', 'succeeded', {
        message: applyButton ? 'apply button clicked' : 'form already visible',
      });

      const gate = await detectHumanGate(page);
      if (gate) {
        await context.recordStep('fill_form', 'failed', { error: gate });
        return { submitted: false, confirmationText: null, needsHuman: gate };
      }

      let fields = await scanFields(root);
      if (fields.length === 0) {
        const error = 'No application form fields were found on the page';
        await context.recordStep('fill_form', 'failed', { error });
        return { submitted: false, confirmationText: null, needsHuman: error };
      }

      await context.recordStep('upload_resume', 'running');
      const attached = await attachDocuments(root, fields, context);
      await context.recordStep(
        'upload_resume',
        attached.resumeAttached ? 'succeeded' : 'skipped',
        { message: attached.resumeAttached ? 'resume attached' : 'no resume file input found' },
      );

      // Re-scan: attaching a resume often triggers autofill and reveals new fields.
      await sleep(1500);
      fields = await scanFields(root);

      await context.recordStep('fill_form', 'running');
      const result = await fillVisibleFields(root, context, fields);
      if (result.needsHuman) {
        await context.recordStep('fill_form', 'failed', {
          error: `Unanswerable question: ${result.needsHuman}`,
        });
        return {
          submitted: false,
          confirmationText: null,
          needsHuman: `Unanswerable question: ${result.needsHuman}`,
        };
      }
      await context.recordStep('fill_form', 'succeeded', {
        message: `filled ${result.filled} fields`,
      });

      await context.recordStep('upload_cover_letter', 'running');
      let coverLetterDone = attached.coverLetterAttached;
      if (!coverLetterDone && context.documents.coverLetterText) {
        const selectors = config.coverLetterSelectors ?? [
          'textarea[name*="cover" i]',
          'textarea[id*="cover" i]',
          'textarea[aria-label*="cover" i]',
        ];
        const area = await firstVisible(root, selectors);
        if (area) {
          await area.fill(context.documents.coverLetterText).catch(() => undefined);
          coverLetterDone = true;
        }
      }
      await context.recordStep(
        'upload_cover_letter',
        coverLetterDone ? 'succeeded' : 'skipped',
        { message: coverLetterDone ? 'cover letter provided' : 'no cover letter target found' },
      );

      await context.recordStep('review', 'running');
      const remaining = (await scanFields(root)).filter(
        (field) => field.required && !field.currentValue && field.kind !== 'file',
      );
      await context.recordStep('review', 'succeeded', {
        message: `${remaining.length} required fields still empty`,
        data: { remaining: remaining.map((field) => field.label).slice(0, 20) },
      });

      if (context.dryRun) {
        await context.recordStep('submit', 'skipped', {
          message: 'dry run — application prepared but not submitted',
        });
        return { submitted: false, confirmationText: null, needsHuman: null };
      }

      await context.recordStep('submit', 'running');
      const submitButton =
        (await firstVisible(root, config.submitButtons)) ??
        (await firstVisible(root, DEFAULT_SUBMIT_BUTTONS)) ??
        (await firstVisible(page, DEFAULT_SUBMIT_BUTTONS));

      if (!submitButton) {
        const error = 'Submit button not found';
        await context.recordStep('submit', 'failed', { error });
        return { submitted: false, confirmationText: null, needsHuman: error };
      }

      await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await submitButton.click();
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
      await sleep(2500);
      await context.recordStep('submit', 'succeeded');

      await context.recordStep('confirm', 'running');
      const confirmation = await detectConfirmation(page, config.confirmationPatterns);
      const postGate = confirmation ? null : await detectHumanGate(page);

      if (postGate) {
        await context.recordStep('confirm', 'failed', { error: postGate });
        return { submitted: false, confirmationText: null, needsHuman: postGate };
      }

      await context.recordStep('confirm', confirmation ? 'succeeded' : 'failed', {
        message: confirmation ?? undefined,
        error: confirmation ? undefined : 'No confirmation message was detected after submitting',
      });

      return {
        submitted: confirmation !== null,
        confirmationText: confirmation,
        needsHuman:
          confirmation === null
            ? 'Submitted but no confirmation was detected — verify manually'
            : null,
      };
    },
  };
}
