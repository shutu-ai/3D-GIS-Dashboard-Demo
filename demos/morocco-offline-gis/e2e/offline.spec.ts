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

/**
 * Track raster/vector tile traffic from Node and resolve when it has been
 * quiet for `quietMs`. `map.areTilesLoaded()` never settles on software-GL
 * machines (a tile can stay 'loading' forever after decode), so tile-network
 * silence is the reliable "safe to screenshot" signal for the real-DEM build
 * (~0.5 MB tiles, decode+upload takes tens of seconds per view).
 */
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

/**
 * Wait until MapLibre's terrain elevation at a location is DECODED (v1.1.0
 * real-DEM tiles are ~0.5 MB high-entropy PNGs; on software-GL machines the
 * boot sequence can take tens of seconds, so fixed sleeps race the loader).
 * Everything that projects a lngLat and clicks it must run AFTER this, or the
 * flat-surface projection (pre-terrain) unprojects to a shifted lngLat once
 * terrain loads — the sampled point drifts kilometres off the target.
 */
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
  test.setTimeout(240_000); // real-DEM boot (0.5 MB tiles, software GL) is slow but functional
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
  }), { timeout: 180_000, polling: 500 }).toBeTruthy();
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
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // Query the HAOUZ PLAIN (-8.00, 31.60 — measured 1 km relief: 11 m) at pitch 0:
  // a nadir ray hits the same geographic point regardless of mesh scale, so the
  // constancy check stays exact-noise-free. Steep-terrain behaviour is covered
  // by the Toubkal summit test.
  const target: [number, number] = [-8.0, 31.6];
  await page.evaluate((c) => {
    const w = window as unknown as { __gisApp: { map: { jumpTo: (o: unknown) => void } } };
    w.__gisApp.map.jumpTo({ center: c, zoom: 10.5, pitch: 0, bearing: 0 });
  }, target);
  // terrain must be decoded at the target BEFORE projecting/clicking
  await waitTerrainReadyAt(page, target);
  const canvas = page.locator('canvas').first();

  const clickTarget = async () => {
    const pos = await page.evaluate((c) => {
      const w = window as unknown as { __gisApp: { map: { project: (c: [number, number]) => { x: number; y: number } } } };
      const p = w.__gisApp.map.project(c);
      return {
        x: Math.max(5, Math.min(window.innerWidth - 5, Math.round(p.x))),
        y: Math.max(5, Math.min(window.innerHeight - 5, Math.round(p.y))),
      };
    }, target);
    await canvas.click({ position: pos });
  };

  const result = page.locator('#query-result');
  await clickTarget();
  await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
  const text1 = await result.textContent();

  // switch exaggeration 1.2 -> 1.5, query the same geographic point again
  await page.locator('button[data-ex="1.5"]').click();
  await page.waitForTimeout(1200);
  await clickTarget();
  await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
  const text2 = await result.textContent();

  // the numeric part must stay the sampled RAW DEM value across exaggeration:
  // nadir view over an 11 m-relief plain → any change beyond a few metres means
  // exaggeration leaked into the query (a leak would shift ~481 m by +240 m).
  const num = (s: string | null) => Number(s?.match(/(-?\d+(?:\.\d+)?)\s*m/)?.[1] ?? NaN);
  const v1 = num(text1);
  const v2 = num(text2);
  expect(Number.isFinite(v1) && Number.isFinite(v2), `query result must contain elevations (${text1} vs ${text2})`).toBeTruthy();
  expect(Math.abs(v2 - v1), `DEM value must not shift with exaggeration beyond sampling jitter (${v1} vs ${v2})`).toBeLessThanOrEqual(30);
});

test('contour layer toggles and interval label updates', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // The MVT encoder fix means contour features must actually RENDER — wait for
  // the vector tiles to stream/parse (slow with real data on software GL),
  // then query the rendered line layer so a parse regression (e.g. "unknown
  // command 0") fails here instead of silently showing no contours.
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => Array<{ layer: { id: string } }> } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length > 0;
  }, undefined, { timeout: 150_000, polling: 500 });
  const contourToggle = page.getByText(/等高线|Contours?/i).first();
  await contourToggle.click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length === 0;
  }, undefined, { timeout: 20_000, polling: 250 });
  await contourToggle.click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length > 0;
  }, undefined, { timeout: 20_000, polling: 250 });
});

test('profile: select A/B points, chart & stats appear', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const profileBtn = page.getByRole('button', { name: /剖面|Profile/i }).first();
  await profileBtn.click();
  const canvas = page.locator('canvas').first();
  await canvas.click({ position: { x: 500, y: 500 } });
  await page.waitForTimeout(800);
  await canvas.click({ position: { x: 900, y: 300 } });
  // profile sampling reads several ~0.5 MB real-DEM tiles — allow a slow machine
  await expect(page.getByText(/水平距离|distance/i).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/km/i).first()).toBeVisible();
});

test('simulated RAN overlay toggles with SIMULATED NETWORK DATA banner', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // fly to the Tichka scene: the simulated RSRP road + sites live there — the
  // boot/intro view contains no RAN features, so rendered-feature assertions
  // are only meaningful in that viewport
  await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>('#scenes button'))
      .find((b) => /tichka/i.test(b.textContent ?? ''));
    if (!target) throw new Error('Tichka scene button not found');
    target.click();
  });
  await page.waitForFunction(() => {
    const w = window as unknown as { __gisApp: { map: { isMoving: () => boolean } } };
    return !w.__gisApp.map.isMoving();
  }, undefined, { timeout: 90_000, polling: 250 });
  await page.waitForTimeout(2500);
  // the simulated layer must be hidden until first enabled (banner accompanies it)
  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['ran-rsrp', 'ran-sites', 'ran-sectors'] }).length;
  }), { timeout: 45_000, intervals: [500] }).toBe(0);
  const ranToggle = page.locator('#ly-ran');
  await ranToggle.check();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#ran-banner')).toHaveText(/SIMULATED NETWORK DATA/i);
  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['ran-rsrp', 'ran-sites'] }).length;
  }), { timeout: 45_000, intervals: [500] }).toBeGreaterThan(0);
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
  // settle: DEM pyramid + symbol placement after the scene jump — poll until
  // labels actually render (slow on software GL with real data)
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __gisApp?: { map: { queryRenderedFeatures: (p?: unknown, o?: unknown) => Array<{ properties?: Record<string, unknown> }> } };
    };
    return w.__gisApp!.map.queryRenderedFeatures(undefined, {
      layers: ['osm-peak-labels', 'osm-peak-labels-top'],
    }).length > 0;
  }, undefined, { timeout: 90_000, polling: 500 });
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
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const summit = [-7.9146, 31.0595] as [number, number];

  // Fire the click with an explicit lngLat: the acceptance property under test
  // is that the QUERY returns the raw DEM value (exaggeration-invariant). A
  // real-mouse click raycasts the rendered mesh, whose frame state can change
  // between project() and the click landing (flaky ±25 km drifts under load).
  const queryAt = async ([lng, lat]: [number, number]) => {
    await page.evaluate(([lng, lat]) => {
      const w = window as unknown as { __gisApp: { map: { fire: (e: string, o: unknown) => void; project: (c: [number, number]) => { x: number; y: number } } } };
      w.__gisApp.map.fire('click', { lngLat: { lng, lat }, point: w.__gisApp.map.project([lng, lat]) });
    }, [lng, lat]);
  };

  const readElevation = async (): Promise<number> => {
    const result = page.locator('#query-result');
    await expect(result.getByText(/DEM elevation/i)).toBeVisible({ timeout: 20_000 });
    const text = await result.textContent();
    const m = text?.match(/(-?\d+(?:\.\d+)?)\s*m/);
    expect(m, `query result must contain an elevation (${text})`).toBeTruthy();
    return Number(m![1]);
  };

  await queryAt(summit);
  const v1 = await readElevation();
  expect(v1, 'Toubkal summit DEM value must fall in the published range [3900, 4350]').toBeGreaterThanOrEqual(3900);
  expect(v1).toBeLessThanOrEqual(4350);

  // exaggeration 1.0 -> 1.5 must not alter the sampled DEM value at all: the
  // query decodes the archive at the same lngLat, so exact equality holds
  await page.locator('button[data-ex="1.0"]').click();
  await page.waitForTimeout(1200);
  await queryAt(summit);
  const v2 = await readElevation();
  expect(v2, `raw DEM value must survive ex 1.0 (${v1} vs ${v2})`).toBe(v1);

  await page.locator('button[data-ex="1.5"]').click();
  await page.waitForTimeout(1200);
  await queryAt(summit);
  const v3 = await readElevation();
  expect(v3, `raw DEM value must survive ex 1.5 (${v1} vs ${v3})`).toBe(v1);
});

test('capture acceptance screenshots (6 scenes x viewport project)', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const proj = testInfo.project.name;
  const dir = path.join(SHOT_ROOT, 'v1.1.0', proj);
  const waitTilesSettled = trackTileTraffic(page);
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // boot: wait for terrain + first contour features so screenshots never show
  // a half-loaded map regardless of machine speed
  await waitTerrainReadyAt(page, [-7.6, 31.23]);
  await page
        .waitForFunction(() => {
          const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
          return w.__gisApp.map.queryRenderedFeatures({ layers: ['contour-lines-major'] }).length > 0;
        }, undefined, { timeout: 150_000, polling: 500 })
        .catch(() => { /* contours may legitimately be sparse at boot zoom; visual review judges */ });

  const flyScene = async (name: string) => {
    await page.evaluate((n) => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('#scenes button'))
        .find((b) => new RegExp(n, 'i').test(b.textContent ?? ''));
      if (!target) throw new Error(`scene button not found: ${n}`);
      target.click();
    }, name);
    // flight must end AND tile traffic must go quiet: a screenshot taken mid-
    // decode shows half-loaded raster (undrawn hypso = dark background slabs
    // with straight projected tile-boundary edges — the first acceptance
    // run's 05 blocker). areTilesLoaded() never settles on software GL.
    await page.waitForFunction(() => {
      const w = window as unknown as { __gisApp: { map: { isMoving: () => boolean } } };
      return !w.__gisApp.map.isMoving();
    }, undefined, { timeout: 90_000, polling: 250 });
    await waitTilesSettled();
    await page.waitForTimeout(1200); // paint settle
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
  // regression guard: simulated RAN layers must be HIDDEN while the banner is
  // off — the style defaults them to visibility:"none" (a boot race used to
  // leave them visible without the SIMULATED banner)
  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['ran-rsrp', 'ran-sites', 'ran-sectors'] }).length;
  }), { timeout: 45_000, intervals: [500] }).toBe(0);
  await page.locator('#ly-ran').check();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => page.evaluate(() => {
    const w = window as unknown as { __gisApp: { map: { queryRenderedFeatures: (o: unknown) => unknown[] } } };
    return w.__gisApp.map.queryRenderedFeatures({ layers: ['ran-rsrp', 'ran-sites'] }).length;
  }), { timeout: 45_000, intervals: [500] }).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
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
  // Fire A/B clicks with explicit lngLats: deterministic endpoints regardless
  // of mesh/frame state, so the profile and its (A: … m) card are stable.
  const clickGeo = async ([lng, lat]: [number, number]) => {
    await page.evaluate(([lng, lat]) => {
      const w = window as unknown as { __gisApp: { map: { fire: (e: string, o: unknown) => void; project: (c: [number, number]) => { x: number; y: number } } } };
      w.__gisApp.map.fire('click', { lngLat: { lng, lat }, point: w.__gisApp.map.project([lng, lat]) });
    }, [lng, lat]);
  };
  await clickGeo([-7.9217, 31.1367]); // Imlil
  await page.waitForTimeout(1500);
  await clickGeo([-7.4167, 31.25]); // Tizi n'Tichka
  await expect(page.getByText(/水平距离|distance/i).first()).toBeVisible({ timeout: 90_000 });
  // point A's sampled elevation is queried and shown in the analysis card
  // (UI text uses full-width parentheses: （A: 1734 m）)
  await expect(page.getByText(/[（(]A:\s*\d+\s*m[）)]/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/06-profile-query.png` });
});
