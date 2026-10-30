import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * v1.2.0 G3 regression extension (task §十). Complements offline.spec.ts
 * (24 baseline tests, untouched) and g1/g2 specs:
 *  - GIS→RAN→GIS loop x10: no selection/legend/paint residue
 *  - cold start: RAN layers + SIMULATED banner invisible before any input
 *  - RSRP rendered set matches the GeoJSON range; color is data-driven
 *  - exaggeration 1.5 leaves linkage profile numbers unchanged
 *  - out-of-coverage A-B reports UNKNOWN, never a green CLEAR
 *  - in-flight linkage compute must not resurrect UI after leaving RAN
 *  - boot / RAN-switch / linkage timings recorded (no PASS thresholds set)
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

const paint = (page: Page, layer: string, prop: string) =>
  page.evaluate(([l, p]) => {
    const w = window as unknown as { __gisApp: { map: { getPaintProperty: (i: string, pr: string) => unknown } } };
    return w.__gisApp.map.getPaintProperty(l, p);
  }, [layer, prop]);

const layout = (page: Page, layer: string, prop: string) =>
  page.evaluate(([l, p]) => {
    const w = window as unknown as { __gisApp: { map: { getLayoutProperty: (i: string, pr: string) => unknown } } };
    return w.__gisApp.map.getLayoutProperty(l, p);
  }, [layer, prop]);

const renderedOnLayers = (page: Page, layers: string[]) =>
  page.evaluate((ls) => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ls }).length;
  }, layers);

async function cardByText(page: Page, label: string) {
  return page.locator('#ran-weak-list button', { hasText: label });
}

const CARD_BLOCKED = 'TICHKA-05 → 道路东段 4.6 km · -110.7 dBm（弱）';

test('G3: cold start invisible + GIS/RAN loop x10 leaves zero residue', async ({ page }) => {
  test.setTimeout(300_000);
  const external = blockExternal(page);

  await page.goto('/', { waitUntil: 'load' });
  const t0 = Date.now();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);

  // --- cold start: simulated network must not leak before any input ---
  await expect(page.locator('#ran-banner')).toBeHidden();
  expect(await layout(page, 'ran-rsrp', 'visibility')).toBe('none');
  await expect.poll(async () => renderedOnLayers(page, ['ran-rsrp', 'ran-sites', 'ran-sectors']), {
    timeout: 45_000, intervals: [500],
  }).toBe(0);
  expect(await paint(page, 'contour-lines', 'line-opacity')).toBe(1);
  const bootMs = Date.now() - t0;

  // --- enable: banner and layers appear together ---
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => unknown[] } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.length ?? 0) > 0;
  }, undefined, { timeout: 30_000, polling: 500 });
  expect(await layout(page, 'ran-rsrp', 'visibility')).toBe('visible');
  expect(await paint(page, 'contour-lines', 'line-opacity')).toBe(0.16);
  const ranEnterMs = Date.now() - t0 - bootMs;

  // --- disable: both disappear together ---
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  expect(await layout(page, 'ran-rsrp', 'visibility')).toBe('none');

  // --- GIS→RAN→GIS x10: banner/legend/paint sync every round, deep assert at end ---
  for (let i = 0; i < 10; i++) {
    await page.locator('#btn-view-ran').click();
    await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#legend-ran-ticks')).toBeVisible();
    await page.locator('#btn-view-gis').click();
    await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#legend-ran')).toBeHidden();
    await expect(page.locator('#legend-ran-ticks')).toBeHidden();
  }
  // final state identical to a fresh GIS boot: paint, selection, legend, hash
  expect(await paint(page, 'contour-lines', 'line-opacity')).toBe(1);
  expect(await paint(page, 'contour-labels-minor', 'text-opacity')).toBe(1);
  expect(await paint(page, 'hillshade', 'hillshade-exaggeration')).toBe(0.35);
  const selResidue = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { querySourceFeatures: (s: string) => Array<{ properties: { sel?: string } }> } } };
    return w.__gisApp.map.querySourceFeatures('ran').some((f) => f.properties.sel);
  });
  expect(selResidue).toBe(false);
  // NB: queryRenderedFeatures reads the tile feature index, which rebuilds
  // asynchronously after visibility flips (probe: 301 -> 0 within ~1.5 s) —
  // poll like the v1.1.0 baseline does, never assert it synchronously
  await expect.poll(async () => renderedOnLayers(page, ['ran-rsrp', 'ran-sites', 'ran-sectors']), {
    timeout: 45_000, intervals: [500],
  }).toBe(0);
  await page.evaluate(() => (window as unknown as { __gisApp: { writeHash: () => void } }).__gisApp.writeHash());
  expect(new URL(page.url()).hash).not.toMatch(/m=ran/);

  expect(external()).toHaveLength(0);
  // timings are RECORDED, never asserted (task §十)
  if (test.info().project.name === 'desktop-1080p') {
    fs.writeFileSync(
      path.join(SPEC_DIR, '..', 'Docs', 'v1_2_0_timings.json'),
      JSON.stringify({ boot_to_style_ready_ms: bootMs, ran_enter_ms: ranEnterMs, mode_loop_10x_ms: Date.now() - t0 - bootMs - ranEnterMs, viewport: '1920x1080', note: 'recording only, no performance gate' }, null, 2),
    );
  }
});

test('G3: rendered RSRP set matches GeoJSON range; color mapping is data-driven', async ({ page }) => {
  test.setTimeout(240_000);
  const external = blockExternal(page);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => Array<{ properties: { rsrp_dbm?: number } }> } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.filter((f) => typeof f.properties.rsrp_dbm === 'number').length ?? 0) > 20;
  }, undefined, { timeout: 30_000, polling: 500 });

  const probe = await page.evaluate(() => {
    const w = window as unknown as {
      __gisApp: {
        map: {
          querySourceFeatures: (s: string) => Array<{ properties: { rsrp_dbm?: number } }>;
          getPaintProperty: (l: string, p: string) => unknown;
        };
      };
    };
    const vals = w.__gisApp.map
      .querySourceFeatures('ran')
      .map((f) => f.properties.rsrp_dbm)
      .filter((v): v is number => typeof v === 'number');
    const colorExpr = w.__gisApp.map.getPaintProperty('ran-rsrp', 'line-color');
    return { vals, colorExpr };
  });
  // the source document's full range must be present in the tiled render
  expect(probe.vals.length).toBeGreaterThan(20);
  expect(Math.min(...probe.vals)).toBeGreaterThanOrEqual(-129.2);
  expect(Math.max(...probe.vals)).toBeLessThanOrEqual(-59.4);
  // data-driven: an interpolate over rsrp_dbm, not a single hardcoded color
  const expr = probe.colorExpr as unknown[];
  expect(Array.isArray(expr)).toBe(true);
  expect(expr[0]).toBe('interpolate');
  expect(JSON.stringify(expr[2])).toContain('rsrp_dbm');

  expect(external()).toHaveLength(0);
});

test('G3: exaggeration 1.5 leaves linkage numbers unchanged; out-of-coverage is UNKNOWN', async ({ page }) => {
  test.setTimeout(300_000);
  const external = blockExternal(page);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => unknown[] } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.length ?? 0) > 0;
  }, undefined, { timeout: 30_000, polling: 500 });

  const readVerdict = () =>
    page.evaluate(() => {
      const link = document.getElementById('ran-link')!.textContent ?? '';
      const km = /距离 ([\d.]+) km/.exec(link)?.[1] ?? null;
      const clearance = /最小净空 (-?[\d.]+) m/.exec(link)?.[1] ?? null;
      const ground = /A 地面 (\d+) m/.exec(link)?.[1] ?? null;
      return { km, clearance, ground };
    });

  await (await cardByText(page, CARD_BLOCKED)).click();
  await page.waitForFunction(() => document.getElementById('ran-link')?.textContent?.includes('判定'), undefined, { timeout: 60_000, polling: 500 });
  const v1 = await readVerdict();

  // exaggeration 1.5 (visual only) must not move a single reported number
  await page.locator('.seg.ex[data-ex="1.5"]').click();
  await (await cardByText(page, CARD_BLOCKED)).click(); // re-runs the same linkage
  await page.waitForFunction(() => document.getElementById('ran-link')?.textContent?.includes('判定'), undefined, { timeout: 60_000, polling: 500 });
  const v2 = await readVerdict();
  expect(v2).toEqual(v1);

  // manual flow, out-of-coverage A-B: UNKNOWN, never a green CLEAR
  await page.locator('#btn-mode-profile').click();
  await page.locator('#btn-clear-profile').click();
  const fire = (lngLat: [number, number]) =>
    page.evaluate(([lng, lat]) => {
      const w = window as unknown as { __gisApp: { map: { fire: (e: string, o: unknown) => void; project: (c: [number, number]) => { x: number; y: number } } } };
      w.__gisApp.map.fire('click', { lngLat: { lng, lat }, point: w.__gisApp.map.project([lng, lat]) });
    }, lngLat);
  await fire([-7.0, 31.9]); // north of the DEM coverage edge (31.65)
  await fire([-7.05, 31.95]);
  await expect(page.locator('#los-result')).toContainText('UNKNOWN', { timeout: 30_000 });
  await expect(page.locator('#los-result')).not.toContainText('视距通畅');
  await expect(page.locator('#profile-stats')).toContainText('超出离线覆盖');

  expect(external()).toHaveLength(0);
});

test('G3: in-flight linkage compute cannot resurrect UI after leaving RAN', async ({ page }) => {
  test.setTimeout(240_000);
  const external = blockExternal(page);

  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await waitStyleReady(page);
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp?: { map?: { querySourceFeatures: (s: string) => unknown[] } } };
    return (w.__gisApp?.map?.querySourceFeatures?.('ran')?.length ?? 0) > 0;
  }, undefined, { timeout: 30_000, polling: 500 });

  // start the linkage and leave RAN while the compute is still in flight
  await (await cardByText(page, CARD_BLOCKED)).click();
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  // give any stale Promise plenty of time to land — it must change nothing
  await page.waitForTimeout(8_000);
  expect((await page.locator('#ran-link').innerText()).trim()).toBe('');
  await expect(page.locator('#panel-right')).not.toHaveClass(/expanded/);
  expect(await page.evaluate(() => (document.getElementById('profile-chart') as HTMLCanvasElement).width)).toBe(360);
  expect(
    await page.evaluate(() => {
      const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
      return w.__gisApp.map.queryRenderedFeatures({ layers: ['profile-line', 'profile-points'] }).length;
    }),
  ).toBe(0);

  expect(external()).toHaveLength(0);
});
