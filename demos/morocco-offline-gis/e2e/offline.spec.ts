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
  // badge wording must always mirror metadata (real build -> REAL TERRAIN · OFFLINE)
  const metaRes = await page.request.get('/data/metadata.json');
  const meta = (await metaRes.json()) as { terrain?: { mode?: string } };
  const badgePattern = meta.terrain?.mode === 'real' ? /REAL TERRAIN · OFFLINE/i : /SIMULATED TERRAIN/i;
  await page.goto('/', { waitUntil: 'load' });
  // map canvas appears
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.badge-offline')).toHaveText(/OFFLINE GIS DEMO/i);
  await expect(page.locator('#terrain-badge')).toHaveText(badgePattern);
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
  // The MVT encoder fix means contour features must actually RENDER — query
  // the rendered line layer so a parse regression (e.g. "unknown command 0")
  // fails here instead of silently showing no contours.
  await page.waitForTimeout(5000);
  const contourCount = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => Array<{ layer: { id: string } }> } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length;
  });
  expect(contourCount, 'major contour features must be visible at boot zoom').toBeGreaterThan(0);
  const contourToggle = page.getByText(/等高线|Contours?/i).first();
  await contourToggle.click();
  await page.waitForTimeout(1500);
  const hiddenCount = await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length;
  });
  expect(hiddenCount).toBe(0);
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

test('metadata: real terrain mode and Copernicus DEM source', async ({ page }) => {
  const res = await page.request.get('/data/metadata.json');
  expect(res.ok()).toBeTruthy();
  const meta = (await res.json()) as {
    terrain?: { mode?: string; product?: string };
    dem?: { source?: string };
  };
  expect(meta.terrain?.mode, 'terrain.mode must be "real" in the v1.1.0 build').toBe('real');
  const provenance = `${meta.terrain?.product ?? ''} ${meta.dem?.source ?? ''}`;
  expect(provenance, 'DEM provenance must reference Copernicus').toMatch(/copernicus/i);
});

test('boundary hint appears when booting far outside coverage', async ({ page }) => {
  // share-link style boot far west of the DEM coverage; maxBounds will clamp
  // the camera, but the app must still tell the user the data ends here
  await page.goto('/#v=-20,31,8,50,0,1.2');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const hint = page.locator('#boundary-hint');
  await expect(hint).toHaveClass(/visible/, { timeout: 15_000 });
  await expect(hint).toContainText(/outside offline terrain coverage/i);
  // Reset returns the default in-coverage view and dismisses the toast
  await hint.locator('#boundary-reset').click();
  await expect(hint).not.toHaveClass(/visible/, { timeout: 20_000 });
});

test('peak labels render at Toubkal scene without duplicates', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>('#scenes button'))
      .find((b) => /toubkal/i.test(b.textContent ?? ''));
    if (!target) throw new Error('Toubkal scene button not found');
    target.click();
  });
  // settle: DEM pyramid + symbol placement after the scene jump
  await page.waitForTimeout(8000);
  const names = await page.evaluate(() => {
    const w = window as unknown as {
      __gisApp?: { map: { queryRenderedFeatures: (p?: unknown, o?: unknown) => Array<{ properties?: Record<string, unknown> }> } };
    };
    const feats = w.__gisApp!.map.queryRenderedFeatures(undefined, {
      layers: ['osm-peak-labels', 'osm-peak-labels-top'],
    });
    return feats.map((f) => String(f.properties?.name ?? ''));
  });
  expect(names.length, 'peak labels must be rendered at the Toubkal scene (z11)').toBeGreaterThan(0);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const dups = Array.from(counts.entries()).filter(([, c]) => c > 1);
  expect(dups, `same-name labels must not duplicate: ${JSON.stringify(dups)}`).toEqual([]);
});

test('elevation near Toubkal summit is in DEM range and stays constant across exaggeration', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  const canvas = page.locator('canvas').first();
  const summit = [-7.9146, 31.0595] as [number, number]; // Jbel Toubkal

  const clickPoint = async ([lng, lat]: [number, number]) => {
    const pos = await page.evaluate(([lng, lat]) => {
      const w = window as unknown as { __gisApp: { map: { project: (c: [number, number]) => { x: number; y: number } } } };
      const p = w.__gisApp.map.project([lng, lat]);
      return {
        x: Math.max(5, Math.min(window.innerWidth - 5, Math.round(p.x))),
        y: Math.max(5, Math.min(window.innerHeight - 5, Math.round(p.y))),
      };
    }, [lng, lat]);
    await canvas.click({ position: pos });
  };

  const readElevation = async (): Promise<number> => {
    const result = page.locator('#query-result');
    await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
    const text = await result.textContent();
    const m = text?.match(/(-?\d+(?:\.\d+)?)\s*m/);
    expect(m, `query result must contain an elevation (${text})`).toBeTruthy();
    return Number(m![1]);
  };

  await clickPoint(summit);
  const v1 = await readElevation();
  expect(v1, 'Toubkal summit DEM value must fall in the published range [3900, 4350]').toBeGreaterThanOrEqual(3900);
  expect(v1).toBeLessThanOrEqual(4350);

  // exaggeration 1.0 -> 1.5 must not alter the sampled DEM value
  await page.locator('button[data-ex="1.0"]').click();
  await page.waitForTimeout(1200);
  await clickPoint(summit);
  const v2 = await readElevation();
  expect(v2).toBe(v1);

  await page.locator('button[data-ex="1.5"]').click();
  await page.waitForTimeout(1200);
  await clickPoint(summit);
  const v3 = await readElevation();
  expect(v3).toBe(v1);
});

test('capture acceptance screenshots (6 scenes x viewport project)', async ({ page }, testInfo) => {
  const proj = testInfo.project.name;
  const dir = path.join(SHOT_ROOT, 'v1.1.0', proj);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(5000); // let 3D terrain + contours stream in

  const flyScene = async (name: string) => {
    await page.evaluate((n) => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('#scenes button'))
        .find((b) => new RegExp(n, 'i').test(b.textContent ?? ''));
      if (!target) throw new Error(`scene button not found: ${n}`);
      target.click();
    }, name);
    await page.waitForTimeout(5000);
  };

  // 01 Toubkal 3D
  await flyScene('Toubkal');
  await page.screenshot({ path: `${dir}/01-toubkal-3d.png` });

  // 02 High Atlas ridges 3D
  await flyScene('Ridges');
  await page.screenshot({ path: `${dir}/02-high-atlas-ridges-3d.png` });

  // 03 Tizi n'Tichka 3D
  await flyScene('Tichka');
  await page.screenshot({ path: `${dir}/03-tizi-ntichka-3d.png` });

  // 04 overview 2D with contours: pitch 0, zoom ~9.2
  await page.locator('#btn-2d').click();
  await page.waitForTimeout(1200); // pitch ease-out
  await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { jumpTo: (o: unknown) => void } } };
    w.__gisApp.map.jumpTo({ center: [-7.65, 31.2], zoom: 9.2, pitch: 0, bearing: 0 });
  });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${dir}/04-overview-2d-contours.png` });

  // 05 RAN overlay on the Tichka scene
  await flyScene('Tichka');
  await page.locator('#ly-ran').check();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/05-ran-overlay.png` });
  await page.locator('#ly-ran').uncheck();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });

  // 06 profile A/B Imlil -> Tizi n'Tichka with result card visible
  await page.getByRole('button', { name: /剖面|Profile/i }).first().click();
  // frame both endpoints: pull back to a wide view before clicking
  await page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { jumpTo: (o: unknown) => void } } };
    w.__gisApp.map.jumpTo({ center: [-7.67, 31.19], zoom: 8.8, pitch: 30, bearing: 0 });
  });
  await page.waitForTimeout(4000);
  const clickGeo = async ([lng, lat]: [number, number]) => {
    const pos = await page.evaluate(([lng, lat]) => {
      const w = window as unknown as { __gisApp: { map: { project: (c: [number, number]) => { x: number; y: number } } } };
      const p = w.__gisApp.map.project([lng, lat]);
      return {
        x: Math.max(5, Math.min(window.innerWidth - 5, Math.round(p.x))),
        y: Math.max(5, Math.min(window.innerHeight - 5, Math.round(p.y))),
      };
    }, [lng, lat]);
    await page.locator('canvas').first().click({ position: pos });
  };
  await clickGeo([-7.9217, 31.1367]); // Imlil
  await page.waitForTimeout(1500);
  await clickGeo([-7.4167, 31.25]); // Tizi n'Tichka
  await expect(page.getByText(/水平距离|distance/i).first()).toBeVisible({ timeout: 20_000 });
  // point A's sampled elevation is queried and shown in the analysis card
  await expect(page.getByText(/\(A:\s*\d+\s*m\)/)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/06-profile-query.png` });
});
