import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

interface NavCase {
  /** Sidebar link label, also used as the accessible name of the nav link. */
  readonly label: string;
  /** The <h2> the page renders through PageHeader. */
  readonly heading: string;
  readonly path: string;
}

const NAV_CASES: readonly NavCase[] = [
  { label: 'Overview', heading: 'Overview', path: '/' },
  { label: 'Jobs', heading: 'Jobs', path: '/jobs' },
  { label: 'Applications', heading: 'Applications', path: '/applications' },
  { label: 'Analytics', heading: 'Analytics', path: '/analytics' },
  { label: 'Resume Manager', heading: 'Resumes', path: '/resumes' },
  { label: 'Cover Letters', heading: 'Cover letters', path: '/cover-letters' },
  { label: 'Automation Queue', heading: 'Automation queue', path: '/queue' },
  { label: 'Browser Sessions', heading: 'Browser sessions', path: '/browser' },
  { label: 'LLM Activity', heading: 'LLM activity', path: '/llm' },
  { label: 'Logs', heading: 'Logs', path: '/logs' },
  { label: 'Settings', heading: 'Settings', path: '/settings' },
];

/**
 * A stock browser install has no local model server, so transport-level noise from the app's
 * polling queries is expected and is not a UI defect. Anything else is a real regression.
 */
const TOLERATED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /ERR_CONNECTION_REFUSED/i,
  /EventSource/i,
  /favicon/i,
];

function isTolerated(text: string): boolean {
  return TOLERATED_CONSOLE_ERRORS.some((pattern) => pattern.test(text));
}

/** Records console errors and uncaught page exceptions for the lifetime of the page. */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!isTolerated(text)) errors.push(text);
  });
  page.on('pageerror', (error: Error) => {
    errors.push(error.message);
  });
  return errors;
}

function sidebar(page: Page) {
  return page.getByRole('navigation');
}

function heading(page: Page, name: string) {
  return page.getByRole('heading', { level: 2, name, exact: true });
}

test.describe('dashboard shell', () => {
  test('renders the shell and every sidebar nav item', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/');

    await expect(page.getByText('Deedy Automation').first()).toBeVisible();
    await expect(heading(page, 'Overview')).toBeVisible();

    for (const group of ['Pipeline', 'Documents', 'Operations']) {
      await expect(sidebar(page).getByText(group, { exact: true })).toBeVisible();
    }

    for (const item of NAV_CASES) {
      await expect(sidebar(page).getByRole('link', { name: item.label, exact: true })).toBeVisible();
    }

    // The privacy guarantee is a product promise, so it is asserted rather than assumed.
    await expect(page.getByText(/no job data or credentials leave the host/i)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('unknown routes fall back to the overview', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/this-route-does-not-exist');

    await expect(heading(page, 'Overview')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    expect(errors).toEqual([]);
  });
});

test.describe('navigation', () => {
  for (const item of NAV_CASES) {
    test(`navigates to ${item.label} from the sidebar`, async ({ page }) => {
      const errors = collectConsoleErrors(page);

      await page.goto('/');
      await sidebar(page).getByRole('link', { name: item.label, exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`${item.path.replace(/\//g, '\\/')}$`));
      await expect(heading(page, item.heading)).toBeVisible();
      // The topbar mirrors the active nav label, which proves the route actually changed.
      await expect(
        page.getByRole('heading', { level: 1, name: item.label, exact: true }),
      ).toBeVisible();

      expect(errors).toEqual([]);
    });
  }

  test('deep links render the same page as sidebar navigation', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    for (const item of NAV_CASES) {
      await page.goto(item.path);
      await expect(heading(page, item.heading)).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});

test.describe('jobs', () => {
  test('shows either the empty state or the jobs table', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/jobs');
    await expect(heading(page, 'Jobs')).toBeVisible();

    const emptyState = page.getByText('No jobs match these filters', { exact: true });
    const table = page.getByRole('table');
    await expect(emptyState.or(table).first()).toBeVisible();

    if (await table.isVisible()) {
      for (const column of ['Score', 'Role', 'Status']) {
        await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
      }
    }

    await expect(page.getByPlaceholder(/search title, company/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('filtering keeps the page stable', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/jobs');
    await page.getByPlaceholder(/search title, company/i).fill('staff engineer');

    await expect(heading(page, 'Jobs')).toBeVisible();
    await expect(
      page.getByText('No jobs match these filters', { exact: true }).or(page.getByRole('table')).first(),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});

test.describe('settings', () => {
  test('opens on the Local LLM tab with provider and base URL controls', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/settings');
    await expect(heading(page, 'Settings')).toBeVisible();

    const llmTab = page.getByRole('tab', { name: /local llm/i });
    await expect(llmTab).toBeVisible();
    await expect(llmTab).toHaveAttribute('data-state', 'active');

    const panel = page.getByRole('tabpanel');
    await expect(panel.getByText('Provider', { exact: true })).toBeVisible();
    await expect(panel.getByText('Base URL', { exact: true })).toBeVisible();
    await expect(panel.getByPlaceholder('http://localhost:11434')).toBeVisible();
    await expect(panel.getByRole('combobox').first()).toBeVisible();
    await expect(panel.getByRole('button', { name: /refresh models/i })).toBeVisible();
    await expect(panel.getByText('Model', { exact: true })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('every settings section is reachable as a tab', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await page.goto('/settings');

    const sections = [
      'Local LLM',
      'Browser',
      'Search',
      'Applications',
      'Queue',
      'Scheduler',
      'Notifications',
      'Candidate profile',
    ];

    for (const section of sections) {
      const tab = page.getByRole('tab', { name: section, exact: true });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('data-state', 'active');
      await expect(page.getByRole('tabpanel')).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
});
