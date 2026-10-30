import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHOT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Docs', 'screenshots');

/**
 * v1.2.0 G2 verification: site→road→DEM profile linkage (task §7).
 * The full analysis chain must complete WITHOUT the manual free A-B mode
 * (G2 gate), verdicts must follow the honesty rules (§7.2), rapid switching
 * must never let stale results overwrite the newest selection, and leaving
 * RAN must leave no linkage residue.
 */

function blockExternal(page: Page) {
  const external: string[] = [];
  const isLocal = (u: URL) =>
    u.protocol === 'blob:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (!isLocal(u)) external.push(req.url());
  });
  return () => external;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'blob:') {
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
});

async function waitStyleReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { getLayer: (id: string) => unknown } } };
    return !!w.__gisApp?.map?.getLayer?.('contour-lines');
  }, undefined, { timeout, polling: 500 });
}

async function enterRan(page: Page) {
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  // demo cards are static DOM, but their linkage reads baseData — wait for the
  // ran source to be queryable before clicking anything
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => unknown[] } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.length ?? 0) > 0;
  }, undefined, { timeout: 30_000, polling: 500 });
}

const CARD_BLOCKED = 'TICHKA-05 → 道路东段 4.6 km · -110.7 dBm（弱）';
const CARD_CLEAR = 'TICHKA-05 → 近站段 0.3 km · -62.7 dBm（对比）';
const CARD_T04 = 'TICHKA-04 → 4.5 km · -110.5 dBm（弱）';

async function cardByText(page: Page, label: string) {
  return page.locator('#ran-weak-list button', { hasText: label });
}

async function waitLinkVerdict(page: Page) {
  await page.waitForFunction(
    () => document.getElementById('ran-link')?.textContent?.includes('判定'),
    undefined,
    { timeout: 60_000, polling: 500 },
  );
}

test('G2: demo card completes site→road→profile chain without manual A-B', async ({ page }) => {
  test.setTimeout(300_000);
  const external = blockExternal(page);
  const dir = path.join(SHOT_ROOT, 'v1.2.0-g2', test.info().project.name);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await enterRan(page);

  // --- one click = the whole chain (G2 gate) ---
  await (await cardByText(page, CARD_BLOCKED)).click();
  await waitLinkVerdict(page);

  const link = await page.locator('#ran-link').innerText();
  // provenance-separated fields (task §7.3)
  expect(link).toContain('GTW-TICHKA-05');
  expect(link).toContain('-110.7 dBm');
  expect(link).toContain('SIMULATED');
  expect(link).toContain('端高 1.5 m（模拟终端假设）');
  expect(link).toContain('真实 DEM 采样');
  // verdict + sign convention + demo/verification boundary wording
  expect(link).toMatch(/BLOCKED[^\n]*terrain-only/);
  expect(link).toContain('正=射线高于地形，负=与地形相交');
  expect(link).toContain('疑似遮挡风险，需现场验证');
  expect(link).not.toMatch(/CLEAR[^\n]*视距通畅/);
  // numeric consistency: distance A→B must match the card's stated 4.6 km
  const km = parseFloat(/距离 ([\d.]+) km/.exec(link)![1]!);
  expect(km).toBeGreaterThan(4.3);
  expect(km).toBeLessThan(4.9);
  // clearance negative (blocked) and parsed from the same verdict block
  const clearance = parseFloat(/最小净空 (-?[\d.]+) m/.exec(link)![1]!);
  expect(clearance).toBeLessThan(0);

  // expanded readability mode (task §7.3)
  await expect(page.locator('#panel-right')).toHaveClass(/expanded/);
  expect(await page.evaluate(() => (document.getElementById('profile-chart') as HTMLCanvasElement).width)).toBe(560);
  expect(await page.locator('#profile-status')).toContainText('联动剖面');
  await expect(page.locator('#los-result')).toContainText('terrain-only');
  // verdict-specific disclaimer: blocked note carries the demo/verification
  // boundary wording (task §7.1.6); the clear note carries the
  // not-a-coverage-prediction line instead — do not cross-assert
  await expect(page.locator('#los-result')).toContainText('演示解释，不是运营商验证结论');
  await expect(page.locator('#los-result')).not.toContainText('视距通畅');

  // A→B highlight reuses the shared profile source on the map
  const lineCount = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['profile-line', 'profile-points'] }).length;
  });
  expect(lineCount, 'A-B line + endpoints must render on the map').toBeGreaterThan(0);

  await page.screenshot({ path: path.join(dir, '06-linkage-blocked.png') });
  expect(external(), 'external requests must be zero').toHaveLength(0);
});

test('G2: contrast card yields CLEAR per real DEM; race guard keeps newest selection', async ({ page }) => {
  test.setTimeout(300_000);
  const external = blockExternal(page);
  const dir = path.join(SHOT_ROOT, 'v1.2.0-g2', test.info().project.name);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await enterRan(page);

  // contrast card: strong segment near the same site -> real DEM says clear
  await (await cardByText(page, CARD_CLEAR)).click();
  await waitLinkVerdict(page);
  const link = await page.locator('#ran-link').innerText();
  expect(link).toContain('-62.7 dBm');
  expect(link).toMatch(/CLEAR[^\n]*视距通畅[^\n]*terrain-only/);
  const clearance = parseFloat(/最小净空 \+?([\d.]+) m/.exec(link)![1]!);
  expect(clearance).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: path.join(dir, '07-linkage-clear-contrast.png') });

  // race: three rapid switches — the final state must be the LAST click's
  // pair, and the verdict text must belong to it (stale computes discarded)
  await (await cardByText(page, CARD_T04)).click();
  await (await cardByText(page, CARD_CLEAR)).click();
  await (await cardByText(page, CARD_T04)).click();
  await page.waitForFunction(
    () => document.getElementById('ran-link')?.textContent?.includes('GTW-TICHKA-04'),
    undefined,
    { timeout: 60_000, polling: 500 },
  );
  // let any trailing stale async land; the text must still be TICHKA-04's
  await page.waitForTimeout(2_000);
  const finalLink = await page.locator('#ran-link').innerText();
  expect(finalLink).toContain('GTW-TICHKA-04');
  expect(finalLink).toContain('-110.5 dBm');
  expect(finalLink).not.toContain('GTW-TICHKA-05');
  expect(await page.locator('#profile-status')).toContainText('GTW-TICHKA-04');

  expect(external(), 'external requests must be zero').toHaveLength(0);
});

test('G2: leaving RAN clears linkage residue; GIS view untouched', async ({ page }) => {
  test.setTimeout(300_000);
  const external = blockExternal(page);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await enterRan(page);

  await (await cardByText(page, CARD_BLOCKED)).click();
  await waitLinkVerdict(page);
  await expect(page.locator('#panel-right')).toHaveClass(/expanded/);

  // back to GIS: linkage card, expanded panel, A-B line, banner all gone
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#ran-card')).toBeHidden();
  const text = await page.locator('#ran-link').innerText();
  expect(text.trim()).toBe('');
  await expect(page.locator('#panel-right')).not.toHaveClass(/expanded/);
  expect(await page.evaluate(() => (document.getElementById('profile-chart') as HTMLCanvasElement).width)).toBe(360);
  const lineCount = () =>
    page.evaluate(() => {
      const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
      return w.__gisApp.map.queryRenderedFeatures({ layers: ['profile-line', 'profile-points'] }).length;
    });
  // tile feature index rebuilds asynchronously after the source wipe — poll
  await expect.poll(lineCount, { timeout: 45_000, intervals: [500] }).toBe(0);

  expect(external(), 'external requests must be zero').toHaveLength(0);
});
