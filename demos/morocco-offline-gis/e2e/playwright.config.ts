import { defineConfig } from '@playwright/test';

// Offline acceptance config: the app under test is served by the packaged
// PowerShell server (see scripts/verify-offline.ps1). External network is
// blocked per-test via context.route in the tests themselves.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: '../Docs/e2e-report', open: 'never' }],
  ],
  outputDir: '../.data/playwright-artifacts',
  use: {
    baseURL: process.env.GIS_DEMO_URL ?? 'http://127.0.0.1:17841/',
    viewport: { width: 1920, height: 1080 },
    // fresh profile each test: no cache, no service workers from previous runs
    contextOptions: { bypassServiceWorker: false },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-1080p', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'desktop-768p', use: { viewport: { width: 1366, height: 768 } } },
  ],
});
