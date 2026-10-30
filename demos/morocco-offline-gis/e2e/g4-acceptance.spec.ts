import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHOT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Docs', 'screenshots');

/**
 * v1.2.0 G4 visual acceptance (task §十一): six scenarios, each captured at
 * 1920×1080 and 1366×768, from the packaged dist under offline conditions.
 * Screenshots wait for real tile decoding (network-quiet heuristic), never a
 * fixed sleep alone. Review notes go to Docs/V1_2_0_Visual_Acceptance.md.
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

function trackTileTraffic(page: Page) {
  let inFlight = 0;
  let lastActivity = Date.now();
  const isTile = (u: string) => /\/data\/(hypso|dem-terrarium|contours)\.pmtiles/.test(u);
  page.on('request', (r) => {
    if (isTile(r.url())) { inFlight++; lastActivity = Date.now(); }
  });
  page.on('requestfinished', (r) => {
    if (isTile(r.url())) { inFlight--; lastActivity = Date.now(); }
  });
  page.on('requestfailed', (r) => {
    if (isTile(r.url())) { inFlight--; lastActivity = Date.now(); }
  });
  return async (quietMs = 4_000, timeout = 180_000) => {
    const t0 = Date.now();
    for (;;) {
      if (inFlight === 0 && Date.now() - lastActivity >= quietMs) return;
      if (Date.now() - t0 > timeout) throw new Error(`tile traffic did not settle within ${timeout}ms (inFlight=${inFlight})`);
      await page.waitForTimeout(250);
    }
  };
}

async function waitStyleReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { getLayer: (id: string) => unknown } } };
    return !!w.__gisApp?.map?.getLayer?.('contour-lines');
  }, undefined, { timeout, polling: 500 });
}

async function waitTerrainReadyAt(page: Page, lngLat: [number, number], timeout = 150_000) {
  await page.waitForFunction(
    ({ lng, lat }) => {
      const map = (window as unknown as { __gisApp?: { map?: { queryTerrainElevation: (c: unknown, o: { exaggerated: boolean }) => number | null } } }).__gisApp?.map;
      if (!map) return false;
      const el = map.queryTerrainElevation([lng, lat], { exaggerated: false });
      return typeof el === 'number' && el > 0;
    },
    { lng: lngLat[0], lat: lngLat[1] },
    { timeout, polling: 500 },
  );
}

async function fireClick(page: Page, lngLat: [number, number]) {
  await page.evaluate(([lng, lat]) => {
    const w = window as unknown as { __gisApp: { map: { fire: (e: string, o: unknown) => void; project: (c: [number, number]) => { x: number; y: number } } } };
    w.__gisApp.map.fire('click', { lngLat: { lng, lat }, point: w.__gisApp.map.project([lng, lat]) });
  }, lngLat);
}

const DEMO_SITE: [number, number] = [-7.664, 31.142]; // GTW-TICHKA-05
const CARD_BLOCKED = 'TICHKA-05 → 道路东段 4.6 km · -110.7 dBm（弱）';

test('G4: six acceptance scenarios captured per viewport', async ({ page }) => {
  test.setTimeout(600_000);
  const external = blockExternal(page);
  const settle = trackTileTraffic(page);
  const dir = path.join(SHOT_ROOT, 'v1.2.0', test.info().project.name);
  const shot = (name: string) => page.screenshot({ path: path.join(dir, name) });

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);

  // 01 — GIS default 3D: real terrain natural, peaks/contours intact
  await settle();
  await shot('01-gis-default-3d.png');

  // 02 — RAN overview: damped basemap, multiple sites, SIMULATED banner
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => unknown[] } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.length ?? 0) > 0;
  }, undefined, { timeout: 30_000, polling: 500 });
  await settle();
  await shot('02-ran-overview.png');

  // 03 — selected site: card + popup + sector focus, other sites dimmed
  await waitTerrainReadyAt(page, DEMO_SITE);
  await fireClick(page, DEMO_SITE);
  await expect(page.locator('#ran-selection')).toContainText('GTW-TICHKA-05', { timeout: 10_000 });
  await expect(page.locator('.maplibregl-popup')).toBeVisible({ timeout: 10_000 });
  await settle();
  await shot('03-selected-site.png');

  // 04 — road RSRP: colored roads + legend, weak segments identifiable
  await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { flyToScene: (n: string) => void } };
    w.__gisApp.flyToScene('Mountain Road');
  });
  await page.waitForFunction(
    () => !(window as unknown as { __gisApp: { map: { isMoving: () => boolean } } }).__gisApp.map.isMoving(),
    undefined,
    { timeout: 90_000, polling: 250 },
  );
  await settle();
  await shot('04-road-rsrp.png');

  // 05 — site→road→profile linkage, all on one screen
  await (await page.locator('#ran-weak-list button', { hasText: CARD_BLOCKED })).click();
  await page.waitForFunction(
    () => document.getElementById('ran-link')?.textContent?.includes('判定'),
    undefined,
    { timeout: 60_000, polling: 500 },
  );
  await settle();
  await shot('05-site-road-profile.png');

  // 06 — back to GIS: no RSRP, sectors, banner or risk card remain
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#legend-ran')).toBeHidden();
  await expect(page.locator('#ran-card')).toBeHidden();
  await settle();
  await shot('06-back-to-gis.png');

  expect(external(), 'external requests must be zero').toHaveLength(0);
});
