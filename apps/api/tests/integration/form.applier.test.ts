import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

import { DEFAULT_SETTINGS, type ApplicationStep, type ProfileSettings } from '@deedy/shared';
import { createFormApplier } from '../../src/browser/appliers/form.applier.js';
import type {
  AnswerRequest,
  AnswerResult,
  ApplyContext,
} from '../../src/browser/appliers/types.js';
import type { Logger } from '../../src/core/logger.js';

const BROWSER_TIMEOUT_MS = 60000;

function silentLogger(): Logger {
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => logger,
    scope: 'test',
  };
  return logger;
}

function profile(overrides: Partial<ProfileSettings> = {}): ProfileSettings {
  return {
    ...DEFAULT_SETTINGS.profile,
    fullName: 'Jane Q. Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@localhost.test',
    ...overrides,
  };
}

interface RecordedStep {
  step: ApplicationStep;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  error?: string;
}

/** A single-page applier pointed at an inline document, with every call recorded. */
function applier() {
  return createFormApplier({
    id: 'test-form',
    provider: 'test',
    name: 'Test form',
    hostPatterns: [/./],
    applyButtons: [],
    submitButtons: ['button[type="submit"]'],
    confirmationPatterns: [/application received/i],
  });
}

function contextFor(
  html: string,
  page: Awaited<ReturnType<Browser['newPage']>>,
  options: { dryRun: boolean; answer: AnswerResult; profile?: ProfileSettings },
): { context: ApplyContext; steps: RecordedStep[]; questions: AnswerRequest[] } {
  const steps: RecordedStep[] = [];
  const questions: AnswerRequest[] = [];

  const context: ApplyContext = {
    page,
    logger: silentLogger(),
    profile: options.profile ?? profile(),
    documents: {
      resumePath: null,
      resumeDocxPath: null,
      coverLetterPath: null,
      coverLetterText: null,
    },
    job: {
      id: 1,
      title: 'Staff Engineer',
      company: 'Local Co',
      applicationUrl: `data:text/html,${encodeURIComponent(html)}`,
    },
    applicationId: 1,
    dryRun: options.dryRun,
    answer: async (request) => {
      questions.push(request);
      return options.answer;
    },
    recordStep: async (step, status, detail) => {
      steps.push({ step, status, error: detail?.error });
    },
    completed: new Set<ApplicationStep>(),
  };

  return { context, steps, questions };
}

const REQUIRED_EMPTY_HTML = `<!doctype html>
<html><body><form>
  <label for="first">First name *</label>
  <input id="first" name="first_name" required />
  <label for="relocate">Are you willing to relocate? *</label>
  <select id="relocate" name="relocate" required>
    <option value="">Select an option</option>
    <option value="maybe">Maybe</option>
    <option value="never">Prefer not to say</option>
  </select>
  <button type="submit">Submit application</button>
</form></body></html>`;

const COMPLETE_HTML = `<!doctype html>
<html><body><form>
  <label for="first">First name *</label>
  <input id="first" name="first_name" required />
  <label for="consent"><input id="consent" name="consent" type="checkbox" required /> I agree to the privacy policy</label>
  <button type="submit">Submit application</button>
</form></body></html>`;

const ATTESTATION_HTML = `<!doctype html>
<html><body><form>
  <label for="first">First name *</label>
  <input id="first" name="first_name" required />
  <label for="certify"><input id="certify" name="certify" type="checkbox" required /> I certify that the information provided is true and complete</label>
  <button type="submit">Submit application</button>
</form></body></html>`;

describe('createFormApplier - submission gates', () => {
  let browser: Browser | null = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      // No browser binaries on this host.
      browser = null;
    }
  }, BROWSER_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    browser = null;
  }, BROWSER_TIMEOUT_MS);

  it(
    'refuses to submit while a required field is still empty',
    async (ctx) => {
      const launched = browser;
      if (!launched) {
        ctx.skip();
        return;
      }

      const browserContext = await launched.newContext();
      const page = await browserContext.newPage();
      try {
        // The answer bank offers an option the select does not have, so the
        // field stays empty even though the question was "answered".
        const { context, steps } = contextFor(REQUIRED_EMPTY_HTML, page, {
          dryRun: false,
          answer: { value: 'Definitely', source: 'llm', confidence: 0.4, needsHuman: false },
        });

        const outcome = await applier().apply(context);

        expect(outcome.submitted).toBe(false);
        expect(outcome.needsHuman).toMatch(/required field/i);
        expect(outcome.needsHuman).toContain('Are you willing to relocate?');
        expect(steps.some((entry) => entry.step === 'review' && entry.status === 'failed')).toBe(true);
        expect(steps.some((entry) => entry.step === 'submit')).toBe(false);
      } finally {
        await browserContext.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'reports the incomplete form in a dry run too',
    async (ctx) => {
      const launched = browser;
      if (!launched) {
        ctx.skip();
        return;
      }

      const browserContext = await launched.newContext();
      const page = await browserContext.newPage();
      try {
        const { context, steps } = contextFor(REQUIRED_EMPTY_HTML, page, {
          dryRun: true,
          answer: { value: 'Definitely', source: 'llm', confidence: 0.4, needsHuman: false },
        });

        const outcome = await applier().apply(context);

        expect(outcome.needsHuman).toMatch(/required field/i);
        expect(steps.some((entry) => entry.step === 'review' && entry.status === 'failed')).toBe(true);
      } finally {
        await browserContext.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'passes review when every required field is answered',
    async (ctx) => {
      const launched = browser;
      if (!launched) {
        ctx.skip();
        return;
      }

      const browserContext = await launched.newContext();
      const page = await browserContext.newPage();
      try {
        const { context, steps, questions } = contextFor(COMPLETE_HTML, page, {
          dryRun: true,
          answer: { value: '', source: 'default', confidence: 0, needsHuman: true },
        });

        const outcome = await applier().apply(context);

        expect(questions).toEqual([]);
        expect(outcome.needsHuman).toBeNull();
        expect(steps.some((entry) => entry.step === 'review' && entry.status === 'succeeded')).toBe(
          true,
        );
        expect(steps.some((entry) => entry.step === 'submit' && entry.status === 'skipped')).toBe(
          true,
        );
        expect(await page.isChecked('#consent')).toBe(true);
      } finally {
        await browserContext.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    'escalates an attestation checkbox instead of ticking or asking the model',
    async (ctx) => {
      const launched = browser;
      if (!launched) {
        ctx.skip();
        return;
      }

      const browserContext = await launched.newContext();
      const page = await browserContext.newPage();
      try {
        const { context, steps, questions } = contextFor(ATTESTATION_HTML, page, {
          dryRun: true,
          answer: { value: 'true', source: 'llm', confidence: 0.9, needsHuman: false },
        });

        const outcome = await applier().apply(context);

        expect(outcome.submitted).toBe(false);
        expect(outcome.needsHuman).toMatch(/attestation must be signed by you/i);
        // The model is never consulted about a declaration.
        expect(questions).toEqual([]);
        expect(await page.isChecked('#certify')).toBe(false);
        expect(steps.some((entry) => entry.step === 'fill_form' && entry.status === 'failed')).toBe(
          true,
        );
      } finally {
        await browserContext.close();
      }
    },
    BROWSER_TIMEOUT_MS,
  );
});
