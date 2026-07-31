import type { Logger } from '../../core/logger.js';
import { createFormApplier } from './form.applier.js';
import { createWizardApplier } from './wizard.applier.js';
import type { ApplierDefinition } from './types.js';

export const greenhouseApplier = createFormApplier({
  id: 'greenhouse',
  provider: 'greenhouse',
  name: 'Greenhouse',
  hostPatterns: [/greenhouse\.io/i, /boards\.greenhouse/i, /job-boards\.greenhouse/i],
  applyButtons: [
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'button:has-text("Apply")',
    '#apply_button',
  ],
  submitButtons: ['#submit_app', 'input[type="submit"][value*="Submit"]', 'button:has-text("Submit Application")'],
  confirmationPatterns: [/thank you for applying/i, /your application has been submitted/i],
  coverLetterSelectors: ['#cover_letter_text', 'textarea[name*="cover" i]'],
});

export const leverApplier = createFormApplier({
  id: 'lever',
  provider: 'lever',
  name: 'Lever',
  hostPatterns: [/jobs\.lever\.co/i, /lever\.co/i],
  applyButtons: ['a:has-text("Apply for this job")', 'a.postings-btn:has-text("Apply")', 'a:has-text("Apply")'],
  submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
  confirmationPatterns: [/thank you for applying/i, /application received/i],
  coverLetterSelectors: ['textarea[name="comments"]', 'textarea[name*="cover" i]'],
});

export const ashbyApplier = createFormApplier({
  id: 'ashby',
  provider: 'ashby',
  name: 'Ashby',
  hostPatterns: [/jobs\.ashbyhq\.com/i, /ashbyhq\.com/i],
  applyButtons: ['button:has-text("Apply for this Job")', 'a:has-text("Apply")', 'button:has-text("Apply")'],
  submitButtons: ['button:has-text("Submit Application")', 'button[type="submit"]'],
  confirmationPatterns: [/thanks for applying/i, /application (has been )?submitted/i],
  coverLetterSelectors: ['textarea[aria-label*="cover" i]', 'textarea[name*="cover" i]'],
});

export const smartRecruitersApplier = createFormApplier({
  id: 'smartrecruiters',
  provider: 'smartrecruiters',
  name: 'SmartRecruiters',
  hostPatterns: [/jobs\.smartrecruiters\.com/i, /smartrecruiters\.com/i],
  applyButtons: [
    'button:has-text("I\'m interested")',
    'a:has-text("I\'m interested")',
    'button:has-text("Apply")',
  ],
  submitButtons: ['button:has-text("Submit application")', 'button[type="submit"]'],
  confirmationPatterns: [/thank you for your interest/i, /application (has been )?(sent|submitted)/i],
  coverLetterSelectors: ['textarea[name*="cover" i]', 'textarea[id*="cover" i]'],
});

export const workdayApplier = createWizardApplier({
  id: 'workday',
  provider: 'workday',
  name: 'Workday',
  hostPatterns: [/myworkdayjobs\.com/i, /myworkdaysite\.com/i, /wd\d+\./i],
  applyButtons: [
    'a[data-automation-id="adventureButton"]',
    'button:has-text("Apply Manually")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
  ],
  nextButtons: [
    'button[data-automation-id="bottom-navigation-next-button"]',
    'button:has-text("Save and Continue")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ],
  submitButtons: [
    'button[data-automation-id="bottom-navigation-next-button"]:has-text("Submit")',
    'button:has-text("Submit")',
  ],
  confirmationPatterns: [/your application (has been|was) submitted/i, /thank you for applying/i],
  maxPages: 8,
});

export const linkedinApplier = createWizardApplier({
  id: 'linkedin',
  provider: 'linkedin',
  name: 'LinkedIn Easy Apply',
  hostPatterns: [/linkedin\.com/i],
  applyButtons: [
    'button.jobs-apply-button',
    'button:has-text("Easy Apply")',
    'button[aria-label*="Easy Apply"]',
  ],
  nextButtons: [
    'button[aria-label="Continue to next step"]',
    'button[aria-label="Review your application"]',
    'button:has-text("Next")',
    'button:has-text("Review")',
  ],
  submitButtons: ['button[aria-label="Submit application"]', 'button:has-text("Submit application")'],
  confirmationPatterns: [/your application was sent/i, /application sent/i],
  maxPages: 8,
});

const BUILT_IN: ApplierDefinition[] = [
  greenhouseApplier,
  leverApplier,
  ashbyApplier,
  smartRecruitersApplier,
  workdayApplier,
  linkedinApplier,
];

/** Resolves the right applier for a posting URL; plugins can add more. */
export class ApplierRegistry {
  private readonly appliers: ApplierDefinition[] = [...BUILT_IN];

  constructor(private readonly logger: Logger) {}

  register(applier: ApplierDefinition): void {
    this.appliers.unshift(applier);
    this.logger.info('applier registered', { id: applier.id, provider: applier.provider });
  }

  all(): ApplierDefinition[] {
    return [...this.appliers];
  }

  /** Prefers a URL match, then a source-name match. */
  resolve(url: string, source: string): ApplierDefinition | undefined {
    return (
      this.appliers.find((applier) => applier.matches(url)) ??
      this.appliers.find((applier) => applier.provider === source)
    );
  }
}
