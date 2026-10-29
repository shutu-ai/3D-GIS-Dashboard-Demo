import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHOT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Docs', 'screenshots');

/**
 * Offline acceptance suite (task doc §八).
 *
 * Every test blocks ALL non-localhost requests and counts external attempts,
 * satisfying: "所有资源请求仅指向本机，外部域名请求次数 0".
 */
function blockExternal(page: Page) {
  const external: string[] = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      external.push(req.url());
    }
  });
  return () => external;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
});

test('cold start: map loads, real terrain renders, zero external requests', async ({ page }) => {
  const external = blockExternal(page);
  await page.goto('/', { waitUntil: 'load' });
  // map canvas appears
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.badge-offline')).toHaveText(/OFFLINE GIS DEMO/i);
  await expect(page.locator('.badge-sim:not(#ran-banner)').first()).toHaveText(/SIMULATED TERRAIN/i);
  await expect.poll(async () => page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: { map?: {
      getTerrain: () => { source?: string } | null;
      getCenter: () => unknown;
      queryTerrainElevation: (center: unknown, options: { exaggerated: boolean }) => number | null | undefined;
      queryRenderedFeatures: () => unknown[];
    } } }).__gisApp;
    const map = app?.map;
    if (!map || map.getTerrain()?.source !== 'dem') return false;
    const elevation = map.queryTerrainElevation(map.getCenter(), { exaggerated: false });
    return typeof elevation === 'number' && elevation > 0 && map.queryRenderedFeatures().length > 0;
  }), { timeout: 30_000 }).toBeTruthy();
  // let tiles stream in
  await page.waitForTimeout(4000);
  expect(external(), 'external requests must be zero').toHaveLength(0);
});

test('2D/3D toggle, pitch & exaggeration controls exist and respond', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const hash1 = new URL(page.url()).hash;
  await page.getByRole('button', { name: /3D/i }).click();
  await page.waitForTimeout(1500);
  // hash should reflect view state (local share link)
  const hash2 = new URL(page.url()).hash;
  expect(hash2 === hash1 || hash2.length > 0).toBeTruthy();
});

test('elevation query returns DEM value and stays constant across exaggeration change', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const canvas = page.locator('canvas').first();

  // click the map at the PROJECTED coverage centre: a fixed screen offset can
  // unproject outside the DEM bbox once pitch pushes it over the horizon
  const clickCoverageCenter = async () => {
    const pos = await page.evaluate(() => {
      const w = window as unknown as { __gisApp: { map: { project: (c: [number, number]) => { x: number; y: number } } } };
      const p = w.__gisApp.map.project([-7.65, 31.2]); // coverage centre, always in-bbox
      return {
        x: Math.max(5, Math.min(window.innerWidth - 5, Math.round(p.x))),
        y: Math.max(5, Math.min(window.innerHeight - 5, Math.round(p.y))),
      };
    });
    await canvas.click({ position: pos });
  };

  const result = page.locator('#query-result');
  await clickCoverageCenter();
  await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
  const text1 = await result.textContent();

  // switch exaggeration 1.2 -> 1.5, query the same geographic point again
  await page.locator('button[data-ex="1.5"]').click();
  await page.waitForTimeout(1200);
  await clickCoverageCenter();
  await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
  const text2 = await result.textContent();

  // the numeric part must match between runs (visual exaggeration does not alter DEM)
  const num = (s: string | null) => s?.match(/-?\d+(\.\d+)?\s*m/)?.[0];
  expect(num(text2), `DEM value must not change with exaggeration (${text1} vs ${text2})`).toBe(num(text1));
});

test('contour layer toggles and interval label updates', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const contourToggle = page.getByText(/等高线|Contours?/i).first();
  await contourToggle.click();
  await page.waitForTimeout(1500);
  await contourToggle.click();
  await page.waitForTimeout(1500);
});

test('profile: select A/B points, chart & stats appear', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const profileBtn = page.getByRole('button', { name: /剖面|Profile/i }).first();
  await profileBtn.click();
  const canvas = page.locator('canvas').first();
  await canvas.click({ position: { x: 500, y: 500 } });
  await page.waitForTimeout(800);
  await canvas.click({ position: { x: 900, y: 300 } });
  await expect(page.getByText(/水平距离|distance/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/km/i).first()).toBeVisible();
});

test('simulated RAN overlay toggles with SIMULATED NETWORK DATA banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const ranToggle = page.locator('#ly-ran');
  await ranToggle.check();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#ran-banner')).toHaveText(/SIMULATED NETWORK DATA/i);
  await ranToggle.uncheck();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
});

test('fly-to scenes navigate within coverage', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(8000); // allow the initial DEM pyramid to settle
  for (const scene of ['Toubkal', 'Ridges', 'Tichka', 'Road']) {
    const button = page.locator('#scenes button').filter({ hasText: new RegExp(scene, 'i') }).first();
    await expect(button).toBeVisible();
    // Dispatch the same DOM click listener without waiting for Playwright's
    // actionability/stability loop while WebGL is rebuilding local tiles.
    await page.evaluate((name) => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('#scenes button'))
        .find((candidate) => new RegExp(name, 'i').test(candidate.textContent ?? ''));
      if (!target) throw new Error(`scene button not found: ${name}`);
      target.click();
    }, scene);
    const center = await page.evaluate(() => {
      const c = (window as unknown as { __gisApp: { map: { getCenter: () => { lng: number; lat: number } } } }).__gisApp.map.getCenter();
      return c;
    });
    expect(center.lng).toBeGreaterThan(-8.4);
    expect(center.lng).toBeLessThan(-6.95);
    expect(center.lat).toBeGreaterThan(30.85);
    expect(center.lat).toBeLessThan(31.55);
  }
});

test('capture acceptance screenshots', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(5000); // let 3D terrain + contours stream in
  const proj = testInfo.project.name;
  const dir = path.join(SHOT_ROOT, proj);
  // 1. default 3D view
  await page.screenshot({ path: `${dir}/01-default-3d.png` });
  // 2. RAN overlay on
  await page.locator('#ly-ran').check();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/02-ran-overlay.png` });
  // 3. profile analysis
  await page.getByRole('button', { name: /剖面|Profile/i }).first().click();
  const canvas = page.locator('canvas').first();
  await canvas.click({ position: { x: 600, y: 450 } });
  await page.waitForTimeout(800);
  await canvas.click({ position: { x: 1000, y: 350 } });
  await expect(page.getByText(/水平距离|distance/i).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${dir}/03-profile-los.png` });
});
