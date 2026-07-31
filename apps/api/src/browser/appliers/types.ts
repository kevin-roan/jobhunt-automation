import type { Frame, Page } from 'playwright';
import type { ApplicationStep, ProfileSettings } from '@deedy/shared';
import type { Logger } from '../../core/logger.js';

export interface ApplicationDocuments {
  resumePath: string | null;
  resumeDocxPath: string | null;
  coverLetterPath: string | null;
  coverLetterText: string | null;
}

export interface AnswerRequest {
  question: string;
  fieldType: string;
  options: string[];
}

export interface AnswerResult {
  value: string;
  source: 'profile' | 'answer_bank' | 'llm' | 'default';
  confidence: number;
  needsHuman: boolean;
}

export interface ApplyContext {
  page: Page;
  logger: Logger;
  profile: ProfileSettings;
  documents: ApplicationDocuments;
  job: { id: number; title: string; company: string; applicationUrl: string };
  applicationId: number;
  /** When true the pipeline stops before the final submit click. */
  dryRun: boolean;
  /** Resolves a form question through the answer bank, then the LLM. */
  answer(request: AnswerRequest): Promise<AnswerResult>;
  /** Persists a step transition and captures screenshot + HTML. */
  recordStep(
    step: ApplicationStep,
    status: 'running' | 'succeeded' | 'failed' | 'skipped',
    detail?: { message?: string; error?: string; data?: unknown },
  ): Promise<void>;
  /** Steps already completed on a previous attempt, safe to skip. */
  completed: Set<ApplicationStep>;
}

export interface ApplyOutcome {
  submitted: boolean;
  confirmationText: string | null;
  /** Set when a human must finish the application (unanswerable question, captcha, …). */
  needsHuman: string | null;
}

/**
 * Provider-specific application driver. Appliers own navigation and submission;
 * generic form filling is shared.
 */
export interface ApplierDefinition {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  /** Decides whether this applier handles a given posting URL. */
  matches(url: string): boolean;
  apply(context: ApplyContext): Promise<ApplyOutcome>;
}

/** Frame containing the application form — many ATSes embed it in an iframe. */
export async function formRoot(page: Page): Promise<Page | Frame> {
  const iframe = page
    .frameLocator('iframe[src*="greenhouse"], iframe[src*="lever"], iframe[id*="grnhse"], iframe[title*="pplication"]')
    .locator('body');
  try {
    if ((await iframe.count()) > 0) {
      const frames = page.frames();
      const candidate = frames.find(
        (frame) =>
          frame !== page.mainFrame() &&
          /greenhouse|lever|ashby|smartrecruiters|workday/i.test(frame.url()),
      );
      if (candidate) return candidate;
    }
  } catch {
    // Fall through to the main frame.
  }
  return page;
}

export const CONSENT_BUTTON_PATTERNS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Accept cookies")',
  'button:has-text("Allow all")',
  'button:has-text("I agree")',
  '#onetrust-accept-btn-handler',
  '[aria-label="Accept cookies"]',
];

/** Dismisses cookie banners that would otherwise intercept clicks. */
export async function dismissConsentBanners(page: Page): Promise<void> {
  for (const selector of CONSENT_BUTTON_PATTERNS) {
    try {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible())) {
        await button.click({ timeout: 2000 });
        return;
      }
    } catch {
      // Banner absent or already dismissed.
    }
  }
}
