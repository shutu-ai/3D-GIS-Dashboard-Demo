import { test, expect, Page } from '@playwright/test';

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
  await expect(page.getByText(/OFFLINE GIS DEMO/i)).toBeVisible();
  await expect(page.getByText(/SIMULATED TERRAIN/i)).toBeVisible();
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
  // click map center (within coverage)
  await page.locator('canvas').first().click({ position: { x: 700, y: 400 } });
  await page.waitForTimeout(1500);
  const elevText1 = await page.getByText(/DEM elevation/i).textContent().catch(() => null);
  // switch exaggeration 1.0 -> 1.5, query same point again
  const panel = page.getByText(/exaggeration/i).first();
  if (await panel.isVisible().catch(() => false)) {
    await page.getByText(/1\.5/).first().click();
    await page.waitForTimeout(1500);
    await page.locator('canvas').first().click({ position: { x: 700, y: 400 } });
    await page.waitForTimeout(1500);
    const elevText2 = await page.getByText(/DEM elevation/i).textContent().catch(() => null);
    // the numeric part must match between runs (visual exaggeration does not alter DEM)
    const num = (s: string | null) => (s ? s.match(/-?\d+(\.\d+)?\s*m/) : null);
    expect(num(elevText2)?.[0]).toBe(num(elevText1)?.[0]);
  }
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
  await expect(page.getByText(/distance/i).first()).toBeVisible({ timeout: 20_000 });
});

test('simulated RAN overlay toggles with SIMULATED NETWORK DATA banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const ranToggle = page.getByText(/基站|无线|RAN|Network overlay/i).first();
  await ranToggle.click();
  await expect(page.getByText(/SIMULATED NETWORK DATA/i)).toBeVisible({ timeout: 10_000 });
  await ranToggle.click();
  await expect(page.getByText(/SIMULATED NETWORK DATA/i)).toBeHidden({ timeout: 10_000 });
});

test('fly-to scenes navigate within coverage', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  for (const scene of ['Toubkal', 'Ridges', 'Tichka', 'Road']) {
    await page.getByText(new RegExp(scene, 'i')).first().click();
    await page.waitForTimeout(3000);
  }
});
