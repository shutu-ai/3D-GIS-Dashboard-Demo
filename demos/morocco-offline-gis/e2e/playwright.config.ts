import { defineConfig } from '@playwright/test';

// Offline acceptance config: the app under test is served by the packaged
// PowerShell server (see scripts/verify-offline.ps1). External network is
// blocked per-test via context.route in the tests themselves.
export default defineConfig({
  testDir: '.',
  // The offline DEM is intentionally large; serial WebGL contexts keep the
  // two viewport projects from competing for the same headless GPU process.
  workers: 1,
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
    // Launch with the real GPU via ANGLE D3D11: closer to end-user hardware
    // and ~4x faster than the SwiftShader default (full suite 4.9 min vs
    // 17.5+ min). NOTE: the v1.1.0 label double-draw was NOT a SwiftShader
    // defect — it was corrupted SDF data from our own glyph generator (fixed
    // in scripts/pipeline/glyphs.py, see Docs/V1_1_0_Visual_RCA.md §5); the
    // suite renders cleanly on both backends. --enable-unsafe-swiftshader
    // keeps the software fallback legal on GPU-less hosts.
    launchOptions: { args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'desktop-1080p', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'desktop-768p', use: { viewport: { width: 1366, height: 768 } } },
  ],
});
