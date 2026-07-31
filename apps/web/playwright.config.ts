import { defineConfig, devices } from '@playwright/test';

/**
 * When E2E_BASE_URL is set the suite runs against an already running instance (dev server, docker
 * compose, CI service). Otherwise Playwright boots the built API, which also serves the web bundle.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:8080';
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Relative to this config's directory (apps/web), so it points at apps/api/dist/index.js.
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'node ../api/dist/index.js',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
