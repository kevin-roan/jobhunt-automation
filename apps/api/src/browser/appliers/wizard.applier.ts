import type { Locator, Page } from 'playwright';
import { sleep, truncate } from '../../core/utils.js';
import { fieldSelector, scanFields } from '../form.filler.js';
import { fillVisibleFields } from './form.applier.js';
import {
  dismissConsentBanners,
  type ApplierDefinition,
  type ApplyContext,
  type ApplyOutcome,
} from './types.js';

export interface WizardApplierConfig {
  id: string;
  provider: string;
  name: string;
  hostPatterns: RegExp[];
  applyButtons: string[];
  /** Buttons that advance the wizard one page. */
  nextButtons: string[];
  submitButtons: string[];
  confirmationPatterns: RegExp[];
  maxPages: number;
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible()) && (await locator.isEnabled())) {
        return locator;
      }
    } catch {
      // Ignore and continue.
    }
  }
  return null;
}

/**
 * Drives multi-page application wizards (Workday, LinkedIn Easy Apply): fill
 * everything visible, advance, repeat, and submit on the final page. Each page
 * transition is persisted as its own step so a crash is diagnosable.
 */
export function createWizardApplier(config: WizardApplierConfig): ApplierDefinition {
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
      const body = await page.locator('body').innerText().catch(() => '');
      await context.recordStep('read_description', 'succeeded', {
        message: `read ${body.length} characters`,
      });

      await context.recordStep('start_application', 'running');
      const applyButton = await firstVisible(page, config.applyButtons);
      if (!applyButton) {
        const error = 'Apply button not found — the posting may be closed or require sign-in';
        await context.recordStep('start_application', 'failed', { error });
        return { submitted: false, confirmationText: null, needsHuman: error };
      }
      await applyButton.click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await sleep(2000);
      await context.recordStep('start_application', 'succeeded');

      let resumeAttached = false;
      let submitted = false;

      for (let pageIndex = 0; pageIndex < config.maxPages; pageIndex += 1) {
        const fields = await scanFields(page);

        // Attach the resume the first time a file input appears in the wizard.
        if (!resumeAttached) {
          const fileField = fields.find((field) => field.kind === 'file');
          const path = context.documents.resumePath ?? context.documents.resumeDocxPath;
          if (fileField && path) {
            await context.recordStep('upload_resume', 'running');
            try {
              await page.locator(fieldSelector(fileField)).setInputFiles(path);
              resumeAttached = true;
              await sleep(2500);
              await context.recordStep('upload_resume', 'succeeded', { message: path });
            } catch (error) {
              await context.recordStep('upload_resume', 'failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        await context.recordStep('fill_form', 'running', {
          message: `wizard page ${pageIndex + 1}`,
        });
        const result = await fillVisibleFields(page, context, await scanFields(page));
        if (result.needsHuman) {
          const error = `Unanswerable question: ${result.needsHuman}`;
          await context.recordStep('fill_form', 'failed', { error });
          return { submitted: false, confirmationText: null, needsHuman: error };
        }
        await context.recordStep('fill_form', 'succeeded', {
          message: `page ${pageIndex + 1}: filled ${result.filled} fields`,
        });

        const submitButton = await firstVisible(page, config.submitButtons);
        if (submitButton) {
          await context.recordStep('review', 'succeeded', {
            message: `reached final page after ${pageIndex + 1} steps`,
          });

          if (context.dryRun) {
            await context.recordStep('submit', 'skipped', {
              message: 'dry run — application prepared but not submitted',
            });
            return { submitted: false, confirmationText: null, needsHuman: null };
          }

          await context.recordStep('submit', 'running');
          await submitButton.scrollIntoViewIfNeeded().catch(() => undefined);
          await submitButton.click();
          await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
          await sleep(2500);
          await context.recordStep('submit', 'succeeded');
          submitted = true;
          break;
        }

        const nextButton = await firstVisible(page, config.nextButtons);
        if (!nextButton) {
          const error = `Wizard stalled on page ${pageIndex + 1}: no Next or Submit button is enabled`;
          await context.recordStep('review', 'failed', { error });
          return { submitted: false, confirmationText: null, needsHuman: error };
        }

        await nextButton.click();
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await sleep(1800);
      }

      if (!submitted) {
        const error = `Wizard exceeded ${config.maxPages} pages without reaching a submit button`;
        await context.recordStep('review', 'failed', { error });
        return { submitted: false, confirmationText: null, needsHuman: error };
      }

      await context.recordStep('confirm', 'running');
      const text = await page.locator('body').innerText().catch(() => '');
      const confirmation =
        config.confirmationPatterns.map((pattern) => pattern.exec(text)?.[0]).find(Boolean) ?? null;

      await context.recordStep('confirm', confirmation ? 'succeeded' : 'failed', {
        message: confirmation ? truncate(confirmation, 300) : undefined,
        error: confirmation ? undefined : 'No confirmation message was detected after submitting',
      });

      return {
        submitted: confirmation !== null,
        confirmationText: confirmation ? truncate(confirmation, 300) : null,
        needsHuman:
          confirmation === null
            ? 'Submitted but no confirmation was detected — verify manually'
            : null,
      };
    },
  };
}
