import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHOT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Docs', 'screenshots');

/**
 * v1.2.0 G1 smoke/verification: GIS/RAN mode state machine, RAN visual
 * hierarchy (sites/sectors/RSRP roads), selection states, banner sync and
 * no-residue GIS restore. Doubles as the first batch of the task-doc §十
 * assertions; the full G3 expansion extends offline.spec.ts.
 */

function blockExternal(page: Page) {
  const external: string[] = [];
  // blob: URLs are in-memory objects with an opaque URL parse (empty
  // hostname) — same-origin by construction, never a network request.
  const isLocal = (u: URL) => u.protocol === 'blob:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (!isLocal(u)) external.push(req.url());
  });
  return () => external;
}

test.beforeEach(async ({ page }) => {
  // enforce what we assert: abort any non-localhost network request
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

/** Paint reads require a registered style: getPaintProperty before the style
 *  layers exist throws inside MapLibre internals. */
async function waitStyleReady(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { getLayer: (id: string) => unknown } } };
    return !!w.__gisApp?.map?.getLayer?.('contour-lines');
  }, undefined, { timeout, polling: 500 });
}

/** Deterministic click at a lngLat (mirrors offline.spec.ts pattern). */
async function fireClick(page: Page, lngLat: [number, number]) {
  await page.evaluate(([lng, lat]) => {
    const w = window as unknown as { __gisApp: { map: { fire: (e: string, o: unknown) => void; project: (c: [number, number]) => { x: number; y: number } } } };
    w.__gisApp.map.fire('click', { lngLat: { lng, lat }, point: w.__gisApp.map.project([lng, lat]) });
  }, lngLat);
}

// GTW-TICHKA-05 (2825 m, azimuth 75°) and the -110.7 dBm road segment 4.6 km
// due east (inside its 65° sector) — the same pair the G2 linkage demo uses.
const DEMO_SITE: [number, number] = [-7.664, 31.142];
const DEMO_ROAD: [number, number] = [-7.709756097560976, 31.13170731707317];

test('G1: GIS/RAN mode switch, selection hierarchy, banner sync, GIS restore', async ({ page }) => {
  test.setTimeout(420_000);
  const external = blockExternal(page);
  const settle = trackTileTraffic(page);
  const dir = path.join(SHOT_ROOT, 'v1.2.0-g1', test.info().project.name);
  const paint = (id: string, prop: string) =>
    page.evaluate(([layer, p]) => {
      const w = window as unknown as { __gisApp: { map: { getPaintProperty: (i: string, pr: string) => unknown } } };
      return w.__gisApp.map.getPaintProperty(layer, p);
    }, [id, prop]);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);

  // ---- GIS default: v1.1.0 rendering, no RAN residue ----
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#btn-view-gis')).toHaveClass(/active/);
  expect(await paint('contour-lines', 'line-opacity')).toBe(1);
  expect(await paint('hillshade', 'hillshade-exaggeration')).toBe(0.35);
  await settle();
  await page.screenshot({ path: path.join(dir, '01-gis-default.png') });

  // ---- enter RAN Coverage View via the mode button ----
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#ran-banner')).toHaveText(/SIMULATED NETWORK DATA/i);
  await expect(page.locator('#btn-view-ran')).toHaveClass(/active/);
  await expect(page.locator('#ly-ran')).toBeChecked();
  await expect(page.locator('#legend-ran')).toBeVisible();
  // base-map dampening applied through the single state machine
  expect(await paint('contour-lines', 'line-opacity')).toBe(0.16);
  expect(await paint('contour-labels-minor', 'text-opacity')).toBe(0.22);
  expect(await paint('hillshade', 'hillshade-exaggeration')).toBe(0.2);
  // hash carries the mode suffix (back-compatible additive form)
  await page.evaluate(() => (window as unknown as { __gisApp: { writeHash: () => void } }).__gisApp.writeHash());
  expect(new URL(page.url()).hash).toMatch(/&m=ran$/);
  await settle();
  // sector fans must be real rendered geometry, not an empty shell
  const sectorCount = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { querySourceFeatures: (s: string) => Array<{ geometry: { type: string } }> } } };
    return w.__gisApp.map.querySourceFeatures('ran').filter((f) => f.geometry.type === 'Polygon').length;
  });
  expect(sectorCount, 'sector fan polygons must exist in the source').toBeGreaterThan(0);
  await page.screenshot({ path: path.join(dir, '02-ran-overview.png') });

  // ---- select site: card + rendered selection state ----
  await waitTerrainReadyAt(page, DEMO_SITE);
  await fireClick(page, DEMO_SITE);
  await expect(page.locator('#ran-selection')).toContainText('GTW-TICHKA-05', { timeout: 10_000 });
  await expect(page.locator('#ran-selection')).toContainText('SIMULATED');
  // site card must keep DEM ground elevation separate from simulated mast height
  await expect(page.locator('#ran-selection')).toContainText('站址海拔');
  await expect(page.locator('#ran-selection')).toContainText('天线挂高');
  // the map popup shows the same provenance-separated fields
  await expect(page.locator('.maplibregl-popup')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.maplibregl-popup')).toContainText('GTW-TICHKA-05');
  await expect(page.locator('.maplibregl-popup')).toContainText('站址海拔 (DEM)');
  await expect(page.locator('.maplibregl-popup')).toContainText('天线挂高');
  await expect(page.locator('.maplibregl-popup')).toContainText('SIMULATED GEOMETRY');
  const siteSel = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => Array<{ properties: { id?: string; sel?: string } }> } } };
    return w.__gisApp.map
      .queryRenderedFeatures({ layers: ['ran-sites'] })
      .find((f) => f.properties.id === 'GTW-TICHKA-05')?.properties.sel;
  });
  expect(siteSel, 'selected site must carry sel=selected in rendered features').toBe('selected');
  await settle();
  await page.screenshot({ path: path.join(dir, '03-selected-site.png') });

  // ---- select the weak road segment (-110.7 dBm < demo threshold -110) ----
  await waitTerrainReadyAt(page, DEMO_ROAD);
  await fireClick(page, DEMO_ROAD);
  await expect(page.locator('#ran-road-info')).toContainText('-110.7', { timeout: 10_000 });
  await expect(page.locator('#ran-road-info')).toContainText('模拟弱覆盖');
  await expect(page.locator('#ran-road-info')).toContainText('SIMULATED');
  const roadSel = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => Array<{ properties: { sel?: string; rsrp_dbm?: number } }> } } };
    return w.__gisApp.map
      .queryRenderedFeatures({ layers: ['ran-rsrp'] })
      .find((f) => f.properties.rsrp_dbm === -110.7)?.properties.sel;
  });
  expect(roadSel, 'clicked weak segment must be selected').toBe('selected');
  await settle();
  await page.screenshot({ path: path.join(dir, '04-weak-road-selected.png') });

  // ---- back to GIS: selection, banner, legend, dampening all restored ----
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#ran-card')).toBeHidden();
  await expect(page.locator('#legend-ran')).toBeHidden();
  await expect(page.locator('#ly-ran')).not.toBeChecked();
  expect(await paint('contour-lines', 'line-opacity')).toBe(1);
  expect(await paint('hillshade', 'hillshade-exaggeration')).toBe(0.35);
  await page.evaluate(() => (window as unknown as { __gisApp: { writeHash: () => void } }).__gisApp.writeHash());
  expect(new URL(page.url()).hash).not.toMatch(/m=ran/);
  const residualSel = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { querySourceFeatures: (s: string) => Array<{ properties: { sel?: string } }> } } };
    return w.__gisApp.map.querySourceFeatures('ran').some((f) => f.properties.sel);
  });
  expect(residualSel, 'no feature may keep a selection state after leaving RAN').toBe(false);
  await settle();
  await page.screenshot({ path: path.join(dir, '05-back-to-gis.png') });

  expect(external(), 'external requests must be zero').toHaveLength(0);
});
