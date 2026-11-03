import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// all run output outside the repo (the admin Vite dev server watches the project folder and crashes on locked trace files)
const OUT = process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa');

/**
 * WFM production-readiness suite.
 *   $env:QA_ADMIN_PASSWORD='...'; npx playwright test            (all)
 *   npx playwright test --project=api-security                     (one area)
 * Creates its own data (prefixed QA-) — point it at a test stack only.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  outputDir: path.join(OUT, 'artifacts'),
  reporter: [['list'], ['html', { outputFolder: path.join(OUT, 'html'), open: 'never' }], ['json', { outputFile: path.join(OUT, 'data', 'playwright-results.json') }]],
  use: {
    channel: "chrome",   // the installed Google Chrome (the bundled Playwright browser build is not downloaded)
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',          // needs Playwright's ffmpeg download; traces + screenshots cover failures
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'api-functional', testMatch: /api-functional\.spec\.ts/, dependencies: ['setup'] },
    { name: 'api-security', testMatch: /api-security\.spec\.ts/, dependencies: ['setup'] },
    { name: 'api-rbac', testMatch: /api-rbac\.spec\.ts/, dependencies: ['setup'] },
    { name: 'admin-crawl', testMatch: /admin-crawl\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], channel: "chrome", viewport: { width: 1440, height: 900 }, storageState: '.auth/admin.json' } },
    { name: 'admin-e2e', testMatch: /admin-e2e\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], channel: "chrome", viewport: { width: 1440, height: 900 }, storageState: '.auth/admin.json' } },
    { name: 'portal-e2e', testMatch: /portal-e2e\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], channel: "chrome", viewport: { width: 1366, height: 860 } } },
    { name: 'responsive', testMatch: /responsive\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Pixel 7'], channel: "chrome" } },
    { name: 'performance', testMatch: /performance\.spec\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'], channel: "chrome", storageState: '.auth/admin.json' } },
  ],
});
