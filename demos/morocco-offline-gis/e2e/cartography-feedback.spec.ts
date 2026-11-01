import { expect, Page, TestInfo, test as base } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * User-feedback CARTOGRAPHY regression (2026-10-31) — contract-level checks
 * only. This spec intentionally does NOT cover visual styling (white label
 * ink, halo contrast, 3D line widths): those belong to the designer's image
 * review and get their own numeric contracts later. Everything here is
 * structural/geometric and stays verifiable offline:
 *
 *   1. The nationwide overview button must frame the REAL metadata bbox
 *      (`geo_context.files["morocco-overview.pmtiles"].bbox`) so all four
 *      corners project on-canvas, clear of visible UI overlays (fixed
 *      30px tolerance), with an honest 2D camera (pitch 0, terrain null).
 *      KNOWN RED today: flyToOverview uses the fixed OVERVIEW_ZOOM 5.55
 *      camera, which crops the bbox north/south edges. This spec records
 *      the real projections + rects as design-acceptance evidence and does
 *      NOT assert the current zoom/center values — the camera fix belongs
 *      to the implementation.
 *
 *   2. The overview archive's `earth` polygons must be registered as a real
 *      fill layer and render land; the `water` group must be a real polygon
 *      fill (line-only ink is not fill evidence). KNOWN RED today: no
 *      earth fill layer is registered at all.
 *
 *   3. Ocean fill must never be the only "lake" evidence: an inland water
 *      polygon is pinned at a deterministic High Atlas location
 *      (Lalla Takerkoust reservoir, verified offline against
 *      high-atlas-context.pmtiles) via BOTH source query and rendered
 *      query. If it cannot be found the test FAILS with an explicit
 *      UNCOVERED verdict — it never test.skip()s the gap away.
 *
 * Every test enforces localhost-only networking and zero page errors.
 * Evidence lands in testInfo.outputPath() (config outputDir
 * ../.data/playwright-artifacts) — never in Docs/.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The served contract file, read from the repo tree (same bytes as /data/metadata.json). */
const META: {
  geo_context?: {
    files?: Record<string, { bbox?: number[] } | undefined>;
  };
} = JSON.parse(readFileSync(path.join(REPO_ROOT, 'public', 'data', 'metadata.json'), 'utf8'));

/** The confirmed metadata field for the nationwide overview bbox [w, s, e, n]. */
const OVERVIEW_BBOX: [number, number, number, number] = (() => {
  const b = META.geo_context?.files?.['morocco-overview.pmtiles']?.bbox;
  if (!b || b.length !== 4 || b.some((v) => typeof v !== 'number')) {
    throw new Error(
      'metadata.geo_context.files["morocco-overview.pmtiles"].bbox is missing or malformed — ' +
        'the overview corner contract has no real bbox to verify against',
    );
  }
  return [b[0]!, b[1]!, b[2]!, b[3]!];
})();

/** Fixed design-acceptance tolerance: corners must clear the canvas edge by this much (px). */
const VIEW_PADDING_PX = 30;

/**
 * Deterministic inland-water anchor: INTERIOR point of the Lalla Takerkoust
 * reservoir polygon (kind=water, NOT ocean), verified offline on 2026-10-31
 * by point-in-polygon against the z12 outer ring (434 pts) decoded directly
 * from public/data/high-atlas-context.pmtiles. Ocean polygons in the same
 * archive can never satisfy a containment test at this anchor.
 */
const LAKE_ANCHOR: [number, number] = [-8.145, 31.33];

/**
 * Visible UI overlay roots (index.html markup + MapLibre chrome + runtime
 * hints). Deliberately duplicated from the existing suites instead of
 * imported — importing a spec file would re-register its tests.
 */
const OVERLAY_SELECTOR = [
  '#topbar', '#panel-left', '#panel-right', '#attribution',
  '#overview-hint', '.boundary-hint', '#terrain-denied-toast',
  '#panel-tab-map', '#panel-tab-data', '#panel-page-map', '#panel-page-data',
  '.maplibregl-ctrl-bottom-left', '.maplibregl-ctrl-bottom-right',
  '.maplibregl-ctrl-top-left', '.maplibregl-ctrl-top-right',
  '.maplibregl-ctrl-attrib', '.maplibregl-popup',
  '.maplibregl-popup-content', '.maplibregl-popup-tip',
].join(', ');

type OverlayRect = { id: string; l: number; r: number; t: number; b: number };

type GisApp = {
  extent: 'atlas' | 'overview';
  map: {
    getLayer: (id: string) => { type: string; source: string } | undefined;
    getStyle: () => {
      layers: Array<{ id: string; type: string; source: string; 'source-layer'?: string }>;
    };
    getCenter: () => { lng: number; lat: number };
    getZoom: () => number;
    getPitch: () => number;
    getBearing: () => number;
    getTerrain: () => { source?: string } | null;
    project: (c: [number, number]) => { x: number; y: number };
    unproject: (p: [number, number]) => { lng: number; lat: number };
    queryRenderedFeatures: (
      p: unknown,
      o?: { layers?: string[] },
    ) => Array<{
      layer: { id: string; type?: string };
      properties: Record<string, unknown>;
      geometry?: { type: string };
    }>;
    querySourceFeatures: (
      sourceId: string,
      o?: { sourceLayer?: string },
    ) => Array<{
      properties: Record<string, unknown>;
      geometry?: unknown;
    }>;
    jumpTo: (o: unknown) => void;
    loaded: () => boolean;
    once: (ev: string, cb: () => void) => void;
  };
};

/** Offline guard state, asserted clean in the fixture teardown. */
type OfflineGuard = { external: string[]; pageErrors: string[] };

const test = base.extend<{ offlineGuard: OfflineGuard }>({
  offlineGuard: async ({ page }, use) => {
    // enforce what we assert: any non-localhost request is blocked outright
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (
        u.hostname === '127.0.0.1' || u.hostname === 'localhost' ||
        u.protocol === 'blob:' || u.protocol === 'data:'
      ) {
        return route.continue();
      }
      return route.abort('blockedbyclient');
    });
    const state: OfflineGuard = { external: [], pageErrors: [] };
    page.on('request', (req) => {
      const u = new URL(req.url());
      // blob:/data: URLs are in-memory — same-origin by construction.
      if (u.protocol === 'blob:' || u.protocol === 'data:') return;
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        state.external.push(req.url());
      }
    });
    page.on('pageerror', (e) => state.pageErrors.push(String(e)));
    await use(state);
    // teardown verdicts (a grace beat first for late stragglers)
    await page.waitForTimeout(250);
    expect(
      state.external,
      `non-localhost requests must be empty (offline contract):\n${state.external.join('\n')}`,
    ).toEqual([]);
    expect(
      state.pageErrors,
      `uncaught page errors must be empty:\n${state.pageErrors.join('\n')}`,
    ).toEqual([]);
  },
});

/** Geo/DEM archive request counters, for a "framing tiles settled" quiet window. */
function trackTileTraffic(page: Page) {
  let inFlight = 0;
  let lastActivity = Date.now();
  const isTile = (u: string) =>
    /\/data\/(hypso|dem-terrarium|contours|morocco-overview|high-atlas-context)\.pmtiles/.test(u);
  page.on('request', (r) => {
    if (isTile(r.url())) { inFlight++; lastActivity = Date.now(); }
  });
  page.on('requestfinished', (r) => {
    // clamp: this tracker may attach mid-burst (after gotoOverview's click),
    // so a finish for a request it never counted must not push inFlight negative
    if (isTile(r.url())) { inFlight = Math.max(0, inFlight - 1); lastActivity = Date.now(); }
  });
  page.on('requestfailed', (r) => {
    if (isTile(r.url())) { inFlight = Math.max(0, inFlight - 1); lastActivity = Date.now(); }
  });
  return async (quietMs = 2_000, timeout = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      if (inFlight === 0 && Date.now() - lastActivity >= quietMs) return;
      if (Date.now() - t0 > timeout) {
        throw new Error(`tile traffic did not settle within ${timeout}ms (inFlight=${inFlight})`);
      }
      await page.waitForTimeout(250);
    }
  };
}

/** Boot the packaged offline app and wait for the geo context style. */
async function boot(page: Page) {
  if (!page.url().startsWith('about:')) await page.goto('about:blank');
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && !!app.map.getLayer('geo-water-fill');
  }, undefined, { timeout: 60_000, polling: 250 });
  await page.waitForTimeout(500);
}

/** Map-settled wait: MapLibre idle (or 20s cap) + quiet geo/DEM tile window. */
async function waitMapSettled(page: Page, quiet = 1_500) {
  await page.evaluate(() => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    return new Promise<void>((resolve) => {
      if (map.loaded()) { resolve(); return; }
      const cap = setTimeout(resolve, 20_000); // never hang the worker on idle
      map.once('idle', () => { clearTimeout(cap); resolve(); });
    });
  });
  const settle = trackTileTraffic(page);
  await settle(quiet, 45_000);
}

/** Click the nationwide overview segment and wait for the camera to settle. */
async function gotoOverview(page: Page) {
  const btn = page.locator('#btn-extent-overview');
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
  await btn.click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return app?.extent === 'overview';
  }, undefined, { timeout: 15_000, polling: 100 });
  await expect(btn, 'the nationwide segment must take the active state').toHaveClass(/active/);
  await waitMapSettled(page);
}

/** Canvas rect + visible UI overlay rects in viewport coordinates. */
async function uiGeometry(page: Page): Promise<{ canvas: { left: number; top: number; width: number; height: number }; overlays: OverlayRect[] }> {
  return page.evaluate((sel) => {
    const cv = document.querySelector('#map canvas');
    const box = cv ? cv.getBoundingClientRect() : null;
    if (!box) throw new Error('#map canvas not found');
    const overlays: OverlayRect[] = [];
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const id = (el as HTMLElement).id || String(el.className);
      overlays.push({ id: `${el.tagName.toLowerCase()}#${id}`, l: r.left, r: r.right, t: r.top, b: r.bottom });
    }
    return {
      canvas: { left: box.left, top: box.top, width: box.width, height: box.height },
      overlays,
    };
  }, OVERLAY_SELECTOR);
}

/** Evidence writer — testInfo.outputPath only; never the Docs tree. */
function writeEvidence(testInfo: TestInfo, name: string, data: unknown) {
  const p = testInfo.outputPath(name);
  writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: false });
}

// ---------------------------------------------------------------------------
// 1 — nationwide overview must frame the REAL metadata bbox (2D honest camera)
// ---------------------------------------------------------------------------
test('[cartography] overview extent: metadata bbox corners project on-canvas, unoccluded (pitch 0 / terrain null)', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(150_000);

  await boot(page);
  await gotoOverview(page);

  const camera = await page.evaluate(() => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    const c = map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      terrain: map.getTerrain()?.source ?? null,
    };
  });

  // The overview domain is honest 2D: no pitch, no terrain source attached.
  expect(camera.pitch, `overview camera pitch must be 0 (2D domain), got ${camera.pitch}`).toBeLessThan(0.01);
  expect(camera.terrain, 'overview camera must have NO terrain source attached (map.getTerrain() === null)').toBeNull();

  const { canvas, overlays } = await uiGeometry(page);
  const corners = await page.evaluate((bbox) => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    const [w, s, e, n] = bbox;
    const pts: Record<string, [number, number]> = {
      westSouth: [w!, s!],
      eastSouth: [e!, s!],
      westNorth: [w!, n!],
      eastNorth: [e!, n!],
    };
    const out: Record<string, { x: number; y: number; over: string | null }> = {};
    for (const [name, lngLat] of Object.entries(pts)) {
      const p = map.project(lngLat);
      const el = document.elementFromPoint(p.x, p.y);
      const id = el ? (el as HTMLElement).id || String(el.className) : '';
      out[name] = { x: p.x, y: p.y, over: el ? `${el.tagName.toLowerCase()}#${id}` : null };
    }
    return out;
  }, OVERVIEW_BBOX);

  // Evidence FIRST: the real projections + rects are the designer's
  // acceptance input, so they land on disk even when an assert below fails.
  writeEvidence(testInfo, 'overview-bbox-corner-projections.json', {
    project: testInfo.project.name,
    metadataField: 'geo_context.files["morocco-overview.pmtiles"].bbox',
    bbox: OVERVIEW_BBOX,
    camera,
    canvas,
    tolerancePaddingPx: VIEW_PADDING_PX,
    visibleOverlays: overlays,
    projectedCorners: corners,
  });
  await screenshot(page, testInfo, 'overview-bbox-corner-canvas.png');

  const x0 = canvas.left + VIEW_PADDING_PX;
  const y0 = canvas.top + VIEW_PADDING_PX;
  const x1 = canvas.left + canvas.width - VIEW_PADDING_PX;
  const y1 = canvas.top + canvas.height - VIEW_PADDING_PX;
  for (const [name, corner] of Object.entries(corners)) {
    expect(
      corner.x >= x0 && corner.x <= x1,
      `bbox corner ${name} x=${corner.x.toFixed(1)}px must sit inside the canvas minus ${VIEW_PADDING_PX}px padding ` +
        `(allowed ${x0.toFixed(0)}..${x1.toFixed(0)}, canvas ${canvas.width.toFixed(0)}px wide) — ` +
        `the overview camera must frame the full metadata bbox, not crop it (see overview-bbox-corner-projections.json)`,
    ).toBe(true);
    expect(
      corner.y >= y0 && corner.y <= y1,
      `bbox corner ${name} y=${corner.y.toFixed(1)}px must sit inside the canvas minus ${VIEW_PADDING_PX}px padding ` +
        `(allowed ${y0.toFixed(0)}..${y1.toFixed(0)}, canvas ${canvas.height.toFixed(0)}px tall) — ` +
        `the overview camera must frame the full metadata bbox, not crop it (see overview-bbox-corner-projections.json)`,
    ).toBe(true);
    expect(
      corner.over?.startsWith('canvas#') ?? false,
      `bbox corner ${name} must land on the map canvas itself (got "${corner.over}") — UI chrome may not cover the bbox extent`,
    ).toBe(true);
    const covered = overlays.find((o) => o.l < corner.x && o.r > corner.x && o.t < corner.y && o.b > corner.y);
    expect(
      covered,
      `bbox corner ${name} at (${corner.x.toFixed(1)}, ${corner.y.toFixed(1)}) is covered by visible overlay "${covered?.id}" — ` +
        `the camera frame (or its fit padding) must keep all four bbox corners clear of panels/header/footer`,
    ).toBeUndefined();
  }
  void offlineGuard;
});

// ---------------------------------------------------------------------------
// 2 — earth polygons from the overview archive: registered fill + rendered land
// ---------------------------------------------------------------------------
test('[cartography] overview: earth polygon fill registered and rendering land', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(150_000);

  await boot(page);
  await gotoOverview(page);

  const discovery = await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const water = app.map.getLayer('geo-water-fill');
    const overviewSource = water?.source ?? null;
    const layers = app.map.getStyle().layers;
    const earthFills = layers
      .filter((l) => l.type === 'fill' && l['source-layer'] === 'earth' && (overviewSource === null || l.source === overviewSource))
      .map((l) => l.id);
    return { overviewSource, earthFills };
  });

  // KNOWN RED today: no earth fill layer is registered — this is the
  // user-feedback regression (land shows only the flat background color).
  expect(
    discovery.earthFills.length,
    `USER FEEDBACK REGRESSION: no earth polygon fill layer is registered ` +
      `(expected a type:"fill" layer on source-layer:"earth" of the overview source "${discovery.overviewSource ?? '<unresolved>'}"). ` +
      `The nationwide overview must render the archive's real land polygons.`,
  ).toBeGreaterThan(0);

  const rendered = await page.evaluate((ids) => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    const feats = map.queryRenderedFeatures(undefined, { layers: ids });
    const center = map.unproject([window.innerWidth / 2, window.innerHeight / 2]);
    const atCenter = map.queryRenderedFeatures([window.innerWidth / 2, window.innerHeight / 2], { layers: ids });
    return {
      count: feats.length,
      geometryTypes: [...new Set(feats.map((f) => f.geometry?.type ?? '<none>'))],
      centerLngLat: [center.lng, center.lat],
      centerHits: atCenter.length,
      centerTopLayer: atCenter[0]?.layer.id ?? null,
    };
  }, discovery.earthFills);

  writeEvidence(testInfo, 'overview-earth-fill.json', {
    project: testInfo.project.name,
    ...discovery,
    ...rendered,
  });
  await screenshot(page, testInfo, 'overview-earth-fill.png');

  expect(rendered.count, 'the registered earth fill must produce rendered features at the overview camera').toBeGreaterThan(0);
  expect(
    rendered.geometryTypes.every((t) => t === 'Polygon' || t === 'MultiPolygon'),
    `earth layer must be a real POLYGON fill; rendered geometry types: ${JSON.stringify(rendered.geometryTypes)}`,
  ).toBe(true);
  expect(
    rendered.centerHits,
    `earth fill must render land under the viewport center (center ${rendered.centerLngLat.map((v) => v.toFixed(2)).join(', ')})`,
  ).toBeGreaterThan(0);
  void offlineGuard;
});

// ---------------------------------------------------------------------------
// 3 — water group is a real polygon fill (line-only ink is not fill evidence)
// ---------------------------------------------------------------------------
test('[cartography] overview: water layer is a real polygon fill, not line-only', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(150_000);

  await boot(page);
  await gotoOverview(page);

  const ids = ['geo-water-fill', 'geo-water-fill-d'];
  const layers = await page.evaluate((ids) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const style = app.map.getStyle().layers;
    return ids.map((id) => {
      const runtime = app.map.getLayer(id);
      const serialized = style.find((l) => l.id === id);
      return {
        id,
        registered: !!runtime,
        type: runtime?.type ?? serialized?.type ?? null,
        sourceLayer: serialized?.['source-layer'] ?? null,
        source: runtime?.source ?? serialized?.source ?? null,
      };
    });
  }, ids);

  for (const l of layers) {
    expect(l.registered, `water fill layer ${l.id} must be registered`).toBe(true);
    expect(l.type, `water layer ${l.id} must be a FILL layer (a line layer cannot prove water fill)`).toBe('fill');
    expect(l.sourceLayer, `water fill layer ${l.id} must bind the archive "water" source-layer`).toBe('water');
  }

  const rendered = await page.evaluate((fillIds) => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    const feats = map.queryRenderedFeatures(undefined, { layers: fillIds });
    return {
      count: feats.length,
      geometryTypes: [...new Set(feats.map((f) => f.geometry?.type ?? '<none>'))],
      layersHit: [...new Set(feats.map((f) => f.layer.id))],
      kinds: feats.reduce<Record<string, number>>((acc, f) => {
        const k = String(f.properties?.kind ?? '<none>');
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }, layers.filter((l) => l.registered).map((l) => l.id!));

  writeEvidence(testInfo, 'overview-water-fill.json', {
    project: testInfo.project.name,
    layers,
    rendered,
  });
  await screenshot(page, testInfo, 'overview-water-fill.png');

  expect(rendered.count, 'the water FILL layers must produce rendered polygon features at the overview camera').toBeGreaterThan(0);
  expect(
    rendered.geometryTypes.every((t) => t === 'Polygon' || t === 'MultiPolygon'),
    `water fill evidence must be polygon geometry ONLY — a line-feature hit would fake fill evidence. ` +
      `Rendered geometry types: ${JSON.stringify(rendered.geometryTypes)}`,
  ).toBe(true);
  // Ocean vs lake separation is NOT judged here: at nationwide zoom the
  // loaded tiles may legitimately hold only ocean polygons. The dedicated
  // inland-lake contract lives in the Lalla Takerkoust test below; the kind
  // histogram above is recorded as design-acceptance evidence.
  void offlineGuard;
});

// ---------------------------------------------------------------------------
// 4 — deterministic inland lake: source + rendered evidence at Lalla Takerkoust
// ---------------------------------------------------------------------------
test('[cartography] atlas lake fill: deterministic inland water polygon at Lalla Takerkoust (source + rendered)', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(150_000);

  await boot(page);
  await page.locator('#btn-extent-atlas').click();
  await page.waitForFunction(() => (window as unknown as { __gisApp?: GisApp }).__gisApp?.extent === 'atlas');
  await waitMapSettled(page);

  // Deterministic framing over the reservoir. Pitch 0 makes map.project
  // elevation-exact (no DEM displacement), so the rendered-query point is
  // trustworthy without jitter windows.
  await page.evaluate(([lng, lat]) => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map;
    map.jumpTo({ center: [lng, lat], zoom: 13, pitch: 0, bearing: 0 });
  }, LAKE_ANCHOR);
  await waitMapSettled(page);

  const probe = await page.evaluate(([lng, lat]) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const detailLayer = app.map.getLayer('geo-water-fill-d');
    const detailSource = detailLayer?.source ?? null;
    if (!detailSource) {
      return { detailSource, source: null, rendered: null, projected: null };
    }

    // point-in-polygon predicate over GeoJSON polygon rings in lng/lat space
    const pip = (rings: unknown): boolean => {
      if (!Array.isArray(rings) || !rings.length) return false;
      const contains = (ring: unknown): boolean => {
        if (!Array.isArray(ring)) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i] as number[];
          const b = ring[j] as number[];
          if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
          if ((a[1]! > lat) !== (b[1]! > lat) && lng < ((b[0]! - a[0]!) * (lat - a[1]!)) / (b[1]! - a[1]!) + a[0]!) inside = !inside;
        }
        return inside;
      };
      return contains(rings[0]) && !rings.slice(1).some(contains);
    };
    const isPoly = (g: unknown): g is { type: string; coordinates: unknown } =>
      !!g && typeof g === 'object' && ['Polygon', 'MultiPolygon'].includes((g as { type?: string }).type ?? '');

    // ---- source query (tile-cache truth, camera-independent) --------------
    const water = app.map.querySourceFeatures(detailSource, { sourceLayer: 'water' });
    const polys = water.filter((f) => isPoly(f.geometry));
    const inland = polys.filter((f) => String(f.properties?.kind ?? '') !== 'ocean');
    const hits = inland.filter((f) => {
      const g = f.geometry as { type: string; coordinates: unknown };
      const ringLists = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as unknown[]);
      return ringLists.some((r) => pip(r));
    });

    // ---- rendered query at the projected anchor pixel ---------------------
    const p = app.map.project([lng, lat]);
    const rf = app.map.queryRenderedFeatures([p.x, p.y], { layers: ['geo-water-fill-d'] });
    return {
      detailSource,
      projected: { x: p.x, y: p.y },
      source: {
        waterFeatures: water.length,
        polygonFeatures: polys.length,
        inlandPolygonFeatures: inland.length,
        inlandKinds: [...new Set(inland.map((f) => String(f.properties?.kind ?? '<none>')))],
        anchorHits: hits.length,
        anchorSample: hits[0]
          ? { kind: String(hits[0]!.properties?.kind ?? ''), name: String(hits[0]!.properties?.name ?? '') }
          : null,
      },
      rendered: {
        hits: rf.length,
        topLayer: rf[0]?.layer.id ?? null,
        topKind: rf[0] ? String(rf[0]!.properties?.kind ?? '') : null,
        topGeometry: rf[0]?.geometry?.type ?? null,
      },
    };
  }, LAKE_ANCHOR);

  writeEvidence(testInfo, 'atlas-lake-source-query.json', { project: testInfo.project.name, anchor: LAKE_ANCHOR, ...probe });
  await screenshot(page, testInfo, 'atlas-lake-fill.png');

  expect(probe.detailSource, 'geo-water-fill-d must be registered with a resolvable detail source').toBeTruthy();
  // EXPLICIT UNCOVERED verdict — never test.skip(): a missing lake polygon at
  // a data-verified anchor must be visible as a failure, not masked as skipped.
  expect(
    probe.source?.anchorHits ?? 0,
    `LAKE FILL UNCOVERED: the detail archive's water source-layer holds ` +
      `${probe.source?.inlandPolygonFeatures ?? 0} inland polygon feature(s) in loaded tiles ` +
      `(kinds: ${JSON.stringify(probe.source?.inlandKinds ?? [])}) but NONE contains the deterministic ` +
      `Lalla Takerkoust anchor ${JSON.stringify(LAKE_ANCHOR)} — lake rendering is UNCOVERED by the current ` +
      `data/style, see atlas-lake-source-query.json. Do not mask this with skip.`,
  ).toBeGreaterThan(0);
  expect(
    probe.rendered?.hits ?? 0,
    `the inland lake polygon must actually RENDER under its projected anchor pixel on geo-water-fill-d ` +
      `(projected ${probe.projected ? `${probe.projected.x.toFixed(0)}, ${probe.projected.y.toFixed(0)}` : '<n/a>'}, ` +
      `top hit: ${probe.rendered?.topLayer ?? 'none'}) — source presence without rendered fill does not prove the lake is drawn`,
  ).toBeGreaterThan(0);
  expect(
    probe.rendered?.topKind,
    `the rendered fill at the lake anchor must NOT be the ocean polygon — ocean fill is not lake evidence`,
  ).not.toBe('ocean');
  expect(
    probe.rendered?.topGeometry ?? '<none>',
    `rendered lake evidence must be polygon geometry (line-only is not fill evidence)`,
  ).toMatch(/^(?:Multi)?Polygon$/);
  void offlineGuard;
});

// ---------------------------------------------------------------------------
// Additions for tests 5 & 6 — type declarations + local helpers ONLY. The
// four tests above and every helper they use stay byte-identical.
// ---------------------------------------------------------------------------

/** Map capabilities the high-pitch regression needs beyond the shared type. */
type MotionMap = GisApp['map'] & {
  isMoving: () => boolean;
  isSourceLoaded: (id: string) => boolean;
  easeTo: (o: unknown) => void;
  setLayoutProperty: (id: string, name: string, value: unknown) => void;
  getLayoutProperty: (id: string, name: string) => unknown;
};

/** Serialized style shape for the runtime font contract (layout + paint). */
type StyledLayer = {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  layout?: { 'text-font'?: unknown };
  paint?: { 'text-color'?: unknown };
};

/** Served metadata shape for the ADMIN font whitelist contract (test 6). */
type AdminFontMeta = {
  geo_context?: {
    administrative_label_font?: {
      fontstack?: string;
      used_by_layers?: unknown;
    };
  };
};

/** One terrain probe: terrain source identity + camera motion context. */
type TerrainSample = { t: number; terrain: string | null; pitch: number; moving: boolean };

/** One per-stage camera + source + rendered evidence snapshot. */
type StageRecord = Awaited<ReturnType<typeof snapshotStage>>;

/**
 * Fixed ink-visibility gate for the contour ON/OFF pixel diff. Values mirror
 * the pre-committed v121 gate (contrast >= 3:1, max-channel delta >= 24,
 * >= 24 qualifying pixels) and are NOT tunable per run: a miss is a FAIL,
 * never a threshold/ROI renegotiation.
 */
const INK_GATE = { minContrastRatio: 3.0, minChannelDelta: 24, minQualifyingPixels: 24 } as const;

/** Fixed central capture rect: cleared of panels/header/footer by measurement. */
const INK_ROI = { width: 640, height: 320 } as const;

/**
 * The ONLY layers toggled for the ON/OFF pair (minor + major contour LINES;
 * labels stay untouched so the diff isolates line ink). Runtime ids from
 * LAYER_IDS.contoursLine / contoursMajor.
 */
const CONTOUR_LINE_LAYERS = ['contour-lines', 'contour-lines-major'] as const;

/**
 * Inline Pillow analyzer — same math as the proven v121 gate (WCAG luminance,
 * max RGB channel delta); local copy on purpose because importing a spec file
 * would re-register its tests. stdin: {on, off, roi, gate} -> stdout: metrics.
 */
const PILLOW_INK_GATE = [
  'import sys, json',
  'from PIL import Image',
  'cfg = json.load(sys.stdin)',
  'box = (cfg["roi"]["x"], cfg["roi"]["y"], cfg["roi"]["x"] + cfg["roi"]["width"], cfg["roi"]["y"] + cfg["roi"]["height"])',
  'a = Image.open(cfg["on"]).convert("RGB").crop(box)',
  'b = Image.open(cfg["off"]).convert("RGB").crop(box)',
  'pa, pb, w, h = a.load(), b.load(), a.size[0], a.size[1]',
  'def lin(c):',
  '    c = c / 255.0',
  '    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4',
  'def lum(p):',
  '    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])',
  'min_r = float(cfg["gate"]["minContrastRatio"])',
  'min_d = int(cfg["gate"]["minChannelDelta"])',
  'qual = 0; deltas = []; ratios = []; maxd = 0',
  'for y in range(h):',
  '    for x in range(w):',
  '        p = pa[x, y]; q = pb[x, y]',
  '        d = max(abs(p[0] - q[0]), abs(p[1] - q[1]), abs(p[2] - q[2]))',
  '        deltas.append(d)',
  '        if d > maxd: maxd = d',
  '        la = lum(p); lb = lum(q)',
  '        hi = la if la >= lb else lb; lo = lb if la >= lb else la',
  '        r = (hi + 0.05) / (lo + 0.05)',
  '        ratios.append(r)',
  '        if d >= min_d and r >= min_r: qual += 1',
  'deltas.sort(); ratios.sort()',
  'def pct(arr, p):',
  '    return round(arr[min(len(arr) - 1, int(p * len(arr)))], 3)',
  'print(json.dumps({"qualifying": qual, "pixels": w * h, "maxDelta": maxd,',
  '    "deltaP50": pct(deltas, 0.5), "deltaP90": pct(deltas, 0.9), "deltaP99": pct(deltas, 0.99),',
  '    "contrastP50": pct(ratios, 0.5), "contrastP90": pct(ratios, 0.9), "contrastMax": round(ratios[-1], 3)}))',
].join('\n');

/** Run the Pillow ON/OFF contrast gate for one ROI of a captured PNG pair. */
function pillowInkGate(onPng: string, offPng: string, roi: { x: number; y: number; width: number; height: number }) {
  const py = process.env.PYTHON_BIN ?? 'python';
  // Stage ASCII-named copies next to the originals: Playwright derives artifact
  // directories from test titles, and a non-ASCII title character corrupts the
  // path when it crosses the Node -> python stdin boundary (lone surrogate ->
  // FileNotFoundError even though the PNG exists on disk).
  const stagedOn = join(dirname(onPng), 'ink-gate-staged-on.png');
  const stagedOff = join(dirname(offPng), 'ink-gate-staged-off.png');
  copyFileSync(onPng, stagedOn);
  copyFileSync(offPng, stagedOff);
  const out = execFileSync(py, ['-c', PILLOW_INK_GATE], {
    input: JSON.stringify({ on: stagedOn, off: stagedOff, roi, gate: INK_GATE }),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return JSON.parse(out.trim()) as {
    qualifying: number;
    pixels: number;
    maxDelta: number;
    deltaP50: number;
    deltaP90: number;
    deltaP99: number;
    contrastP50: number;
    contrastP90: number;
    contrastMax: number;
  };
}

/**
 * Boot the packaged offline app AT a deterministic `#v=` shared link. `#v=`
 * links carry no `&e=` and boot the atlas extent by contract (map.ts
 * readHashExtent) — asserted by the caller. Local copy of boot()'s wait
 * ladder because boot() itself is pinned to `/` and must not change.
 */
async function bootAtHash(page: Page, hash: string) {
  if (!page.url().startsWith('about:')) await page.goto('about:blank');
  await page.goto(`/${hash}`, { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && !!app.map.getLayer('geo-water-fill');
  }, undefined, { timeout: 60_000, polling: 250 });
  await page.waitForTimeout(500);
}

/** Fully rendered, non-moving frame (idle event or cap — never a fixed sleep). */
async function waitIdle(page: Page, capMs = 15_000) {
  await page.evaluate((cap) => new Promise<void>((resolve) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) { resolve(); return; }
    const map = app.map as MotionMap;
    if (map.loaded() && !map.isMoving()) { resolve(); return; }
    const t = setTimeout(resolve, cap);
    map.once('idle', () => { clearTimeout(t); resolve(); });
  }), capMs);
}

/**
 * Drive the pitch slider the way the app actually listens: set the range
 * input's value and dispatch a real bubbling `input` event — locator.fill is
 * unreliable/unsupported on input[type=range]. The app's own listener then
 * runs setPitch -> easeTo, so the true UI event path stays under test (this
 * must never degrade to calling map.setPitch directly).
 */
async function setPitchSlider(page: Page, deg: number) {
  await page.evaluate((v) => {
    const el = document.getElementById('pitch-slider') as HTMLInputElement | null;
    if (!el) throw new Error('#pitch-slider not found in DOM');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, deg);
}

/**
 * Deterministic contour source-readiness gate: map NOT moving + contours
 * source loaded + real source-tile features present. No fixed sleep anywhere;
 * a timeout FAILS with an explicit tile-not-loaded verdict — never a skip,
 * never deferred to "upstream". Layer ids travel as SERIALIZED evaluate args
 * (the Node-side constant is not visible inside the browser callback).
 */
async function waitContoursReady(page: Page, atZoom: number, lineLayers: string[], timeoutMs = 60_000) {
  try {
    await page.waitForFunction(() => {
      const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
      if (!app) return false;
      const map = app.map as MotionMap;
      if (map.isMoving()) return false;
      if (!map.isSourceLoaded('contours')) return false;
      return map.querySourceFeatures('contours', { sourceLayer: 'contour' }).length > 0;
    }, undefined, { timeout: timeoutMs, polling: 150 });
  } catch {
    const diag = await page.evaluate((layers) => {
      const map = (window as unknown as { __gisApp?: GisApp }).__gisApp?.map as MotionMap | undefined;
      if (!map) return null;
      return {
        moving: map.isMoving(),
        sourceLoaded: map.isSourceLoaded('contours'),
        sourceFeatures: map.querySourceFeatures('contours', { sourceLayer: 'contour' }).length,
        renderedFeatures: map.queryRenderedFeatures(undefined, { layers }).length,
        zoom: map.getZoom(),
        loaded: map.loaded(),
      };
    }, lineLayers).catch(() => null);
    throw new Error(
      `CONTOUR TILES NOT LOADED: the contours source never became ready within ${timeoutMs}ms ` +
        `(camera z${atZoom}; diagnostics: ${JSON.stringify(diag)}). ` +
        `The contour tile pipeline must deliver source tiles for the current viewport — this is a hard ` +
        `source-ready FAIL (not a skip, not an upstream assumption).`,
    );
  }
}

/**
 * Per-stage evidence snapshot: camera + terrain + contours source/rendered
 * counts + the detail water source (resolved DYNAMICALLY from the
 * geo-water-fill-d layer). Layer ids travel as a SERIALIZED evaluate arg —
 * Node-side constants are not visible inside the browser callback. Detail
 * numbers are RECORDED ONLY — that source may legitimately report
 * loaded:false (unusedsource) at some cameras, so it is never gated on and
 * can never hang the test.
 */
async function snapshotStage(page: Page, args: { stage: string; lineLayers: string[] }) {
  return page.evaluate(({ stage, lineLayers }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const map = app.map as MotionMap;
    const c = map.getCenter();
    const detailSource = map.getLayer('geo-water-fill-d')?.source ?? null;
    return {
      stage,
      extent: app.extent,
      camera: {
        center: [c.lng, c.lat] as [number, number],
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      },
      terrain: map.getTerrain()?.source ?? null,
      contours: {
        sourceLoaded: map.isSourceLoaded('contours'),
        sourceFeatures: map.querySourceFeatures('contours', { sourceLayer: 'contour' }).length,
        renderedFeatures: map.queryRenderedFeatures(undefined, { layers: lineLayers }).length,
      },
      detail: {
        source: detailSource,
        sourceLoaded: detailSource ? map.isSourceLoaded(detailSource) : null,
        sourceFeatures: detailSource ? map.querySourceFeatures(detailSource, { sourceLayer: 'water' }).length : 0,
        renderedFeatures: map.queryRenderedFeatures(undefined, { layers: ['geo-water-fill-d'] }).length,
      },
    };
  }, args);
}

// ---------------------------------------------------------------------------
// 5 — HIGH-PITCH REGRESSION: terrain stays attached through the whole camera
//     path (no "close terrain during motion" hack), contour tiles actually
//     load, and the contour ink is proven by a REAL pixel diff (fixed central
//     ROI, ON/OFF visibility pair, Pillow gate).
// ---------------------------------------------------------------------------
test('[cartography] atlas high-pitch regression: terrain attached through p50-60-easeTo-65, contour ink pixel-real', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(240_000);

  // Deterministic shared-link boot: atlas extent, High-Atlas start camera at
  // pitch 50 (#v = lng,lat,zoom,pitch,bearing,exaggeration).
  await bootAtHash(page, '#v=-7.6,31.2,9.6,50,0,1.2');

  const bootProbe = await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    return {
      extent: app.extent,
      atlasBtnActive: document.getElementById('btn-extent-atlas')?.classList.contains('active') ?? false,
      c: app.map.getCenter(),
      zoom: app.map.getZoom(),
      pitch: app.map.getPitch(),
    };
  });
  expect(
    bootProbe.extent,
    `the #v= link (no &e= suffix) must boot the ATLAS extent explicitly, got "${bootProbe.extent}"`,
  ).toBe('atlas');
  expect(bootProbe.atlasBtnActive, 'the atlas segment button must reflect the boot extent').toBe(true);

  // Terrain must be attached BEFORE the guarded motion window opens; from the
  // first slider move to the final restore, a 30ms probe continuously samples
  // getTerrain() — any mid-motion null is the regression this test exists for.
  await page.waitForFunction(() => {
    const map = (window as unknown as { __gisApp?: GisApp }).__gisApp?.map;
    return !!map && map.getTerrain() !== null;
  }, undefined, { timeout: 20_000, polling: 100 });

  const terrainSamples: TerrainSample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const t0 = Date.now();
      try {
        const s = await page.evaluate(() => {
          const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map as MotionMap;
          return { terrain: map.getTerrain()?.source ?? null, pitch: map.getPitch(), moving: map.isMoving() };
        });
        terrainSamples.push({ t: Date.now(), ...s });
        // pace INSIDE the try: a destroyed context mid-wait must not reject
        // the sampler promise (finally awaits it and must never mask the
        // original failure or skip the layout restore)
        const rest = 30 - (Date.now() - t0);
        if (rest > 0) await page.waitForTimeout(rest);
      } catch {
        break; // page gone (teardown) — sampler dies quietly, finally stops it
      }
    }
  })();

  // The contour LINE visibility toggle is reverted in finally even on failure.
  let inkHidden = false;
  // Serialized evaluate arg: browser callbacks cannot see Node-side constants.
  const lineLayers: string[] = [...CONTOUR_LINE_LAYERS];
  try {
    const stages: StageRecord[] = [];

    await waitContoursReady(page, 9.6, lineLayers);
    stages.push(await snapshotStage(page, { stage: 'boot-p50', lineLayers }));

    // stage: UI-owned pitch slider to 60 — a real bubbling `input` event on
    // the range input (locator.fill is unreliable on input[type=range]); the
    // app's own listener drives setPitch -> easeTo, keeping the UI path tested
    const slider = page.locator('#pitch-slider');
    await expect(slider).toBeVisible();
    await expect(slider).toBeEnabled();
    await setPitchSlider(page, 60);
    await waitContoursReady(page, 60, lineLayers);
    stages.push(await snapshotStage(page, { stage: 'pitch-60', lineLayers }));

    // stage: 2.5s camera flight into the contour-dense High Atlas target —
    // readiness comes from the gate below, never from a fixed 12s sleep
    await page.evaluate(() => {
      const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map as MotionMap;
      map.easeTo({ center: [-7.55, 31.14], zoom: 13.2, duration: 2500 });
    });
    await waitContoursReady(page, 13.2, lineLayers);
    stages.push(await snapshotStage(page, { stage: 'easeTo-z13.2', lineLayers }));

    // stage: steepen to pitch 65 — the regression end state
    await setPitchSlider(page, 65);
    await waitContoursReady(page, 65, lineLayers);
    stages.push(await snapshotStage(page, { stage: 'pitch-65', lineLayers }));

    // ---- real pixel evidence: FIXED central ROI, contour ON/OFF pair -------
    const { canvas, overlays } = await uiGeometry(page);
    expect(
      canvas.width >= INK_ROI.width && canvas.height >= INK_ROI.height,
      `canvas ${canvas.width.toFixed(0)}x${canvas.height.toFixed(0)} must fit the fixed ` +
        `${INK_ROI.width}x${INK_ROI.height} central ROI — the ROI never shrinks or moves to chase pixels`,
    ).toBe(true);
    const roi = {
      x: Math.round(canvas.left + canvas.width / 2 - INK_ROI.width / 2),
      y: Math.round(canvas.top + canvas.height / 2 - INK_ROI.height / 2),
      width: INK_ROI.width,
      height: INK_ROI.height,
    };
    const occluders = overlays.filter(
      (o) => o.l < roi.x + roi.width && o.r > roi.x && o.t < roi.y + roi.height && o.b > roi.y,
    );
    expect(
      occluders,
      `the FIXED central ROI ${JSON.stringify(roi)} must sit clear of panels/header/footer/attribution; ` +
        `overlapping UI: ${JSON.stringify(occluders.map((o) => o.id))}`,
    ).toEqual([]);

    // Camera is FROZEN from here (p65 end state, source ready). ON first…
    await waitIdle(page);
    const onPng = testInfo.outputPath('atlas-p65-contours-on.png');
    await page.screenshot({ path: onPng, clip: roi });
    // …then hide ONLY the two contour line layers (labels etc. untouched)…
    await page.evaluate((ids) => {
      const map = (window as unknown as { __gisApp?: GisApp }).__gisApp!.map as MotionMap;
      for (const id of ids) map.setLayoutProperty(id, 'visibility', 'none');
    }, CONTOUR_LINE_LAYERS as unknown as string[]);
    inkHidden = true;
    await waitIdle(page);
    const offPng = testInfo.outputPath('atlas-p65-contours-off.png');
    await page.screenshot({ path: offPng, clip: roi });

    // …and judge the pair with the fixed Pillow gate (single fixed ROI; a
    // threshold miss below is a FAIL — no ROI shopping, no per-candidate
    // best-of, no relaxed numbers).
    const gate = pillowInkGate(onPng, offPng, { x: 0, y: 0, width: INK_ROI.width, height: INK_ROI.height });

    const t0 = terrainSamples[0]?.t ?? Date.now();
    const tN = terrainSamples[terrainSamples.length - 1]?.t ?? t0;
    const evidence = {
      project: testInfo.project.name,
      boot: bootProbe,
      bootLink: '#v=-7.6,31.2,9.6,50,0,1.2',
      flightTarget: { center: [-7.55, 31.14], zoom: 13.2, durationMs: 2500 },
      stages,
      roi,
      toggledLayers: CONTOUR_LINE_LAYERS,
      pngOn: 'atlas-p65-contours-on.png',
      pngOff: 'atlas-p65-contours-off.png',
      inkGate: { thresholds: INK_GATE, ...gate },
      terrainSampling: {
        intervalMs: 30,
        samples: terrainSamples.length,
        windowMs: tN - t0,
        movingSamples: terrainSamples.filter((s) => s.moving).length,
        nullTerrainSamples: terrainSamples.filter((s) => s.terrain === null).length,
        pitchMin: terrainSamples.length ? Math.min(...terrainSamples.map((s) => s.pitch)) : null,
        pitchMax: terrainSamples.length ? Math.max(...terrainSamples.map((s) => s.pitch)) : null,
      },
    };
    writeEvidence(testInfo, 'atlas-high-pitch-regression.json', evidence);
    await screenshot(page, testInfo, 'atlas-high-pitch-final.png');

    // ---- verdicts (evidence already on disk) -------------------------------
    const p65 = stages[stages.length - 1]!;
    expect(
      p65.terrain,
      `pitch-65 end state must keep a terrain source attached (map.getTerrain().source) — ` +
        `steepening the camera is never allowed to silently drop the DEM mesh`,
    ).toBeTruthy();
    expect(
      p65.camera.pitch,
      `pitch-65 end state must sit at the slider target 65° (got ${p65.camera.pitch})`,
    ).toBeGreaterThanOrEqual(64.5);
    expect(
      p65.camera.pitch,
      `pitch-65 end state must sit at the slider target 65° (got ${p65.camera.pitch})`,
    ).toBeLessThanOrEqual(65.5);
    expect(
      p65.contours.sourceFeatures,
      'the pitch-65 contour source must hold real source-tile features after the ready gate',
    ).toBeGreaterThan(0);
    expect(
      p65.contours.renderedFeatures,
      'the pitch-65 contour line layers must produce rendered features after the ready gate',
    ).toBeGreaterThan(0);
    expect(
      gate.qualifying,
      `CONTOUR INK NOT PROVEN: the ON/OFF pixel diff over the FIXED ROI ${JSON.stringify(roi)} produced ` +
        `${gate.qualifying} qualifying pixels (need >= ${INK_GATE.minQualifyingPixels}; maxDelta=${gate.maxDelta}, ` +
        `contrastMax=${gate.contrastMax}). The contour lines must leave REAL pixel ink when toggled — ` +
        `see atlas-p65-contours-on.png / atlas-p65-contours-off.png / atlas-high-pitch-regression.json`,
    ).toBeGreaterThanOrEqual(INK_GATE.minQualifyingPixels);
    const nullSamples = terrainSamples.filter((s) => s.terrain === null);
    expect(
      nullSamples,
      `TERRAIN DETACHED MID-MOTION: ${nullSamples.length}/${terrainSamples.length} samples (30ms interval) saw ` +
        `map.getTerrain() === null while the camera moved — the "close terrain during motion" hack regression. ` +
        `First null at t+${nullSamples[0] ? nullSamples[0]!.t - t0 : '<n/a>'}ms`,
    ).toEqual([]);
    expect(
      terrainSamples.length,
      'the terrain sampler must actually cover the motion window (>= 20 samples at 30ms)',
    ).toBeGreaterThan(20);
    expect(
      evidence.terrainSampling.movingSamples,
      'the sampler must overlap actual camera motion (easeTo + slider flights)',
    ).toBeGreaterThan(0);
  } finally {
    // stop the sampler FIRST (no leak past test end), then restore layouts.
    // .catch guards the theoretical case where the loop promise itself is
    // already rejected — it must never mask the test's original failure.
    sampling = false;
    await sampler.catch(() => { /* sampler already dead */ });
    if (inkHidden) {
      await page.evaluate((ids) => {
        const map = (window as unknown as { __gisApp?: GisApp }).__gisApp?.map as MotionMap | undefined;
        if (!map) return;
        for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
      }, CONTOUR_LINE_LAYERS as unknown as string[]).catch(() => { /* page already gone */ });
    }
  }
  void offlineGuard;
});

// ---------------------------------------------------------------------------
// 6 — RUNTIME FONT CONTRACT: the SERVED metadata whitelist is exactly 20
//     layers, the runtime style's ADMIN fontstack usage set matches it
//     EXACTLY (both directions), and every whitelisted layer paints white.
//     STRUCTURAL only — ink color/contrast on pixels belongs to the
//     designer's image review lane.
// ---------------------------------------------------------------------------
test('[cartography] runtime font contract: served metadata ADMIN whitelist is exactly 20 symbol layers, all #ffffff', async ({ page, offlineGuard }, testInfo) => {
  test.setTimeout(90_000);

  await boot(page);

  // The contract must come from the BYTES THE SERVER ACTUALLY SERVES — the
  // data lane may be regenerating the repo tree copy mid-run.
  const metaUrl = new URL('/data/metadata.json', page.url()).toString();
  const served = await page.request.get(metaUrl);
  expect(
    served.ok(),
    `GET ${metaUrl} must serve metadata.json over the offline origin (status ${served.status()})`,
  ).toBe(true);
  const meta = (await served.json()) as AdminFontMeta;
  const contract = meta.geo_context?.administrative_label_font;

  // ---- EXACTLY 20 (the closed whitelist; never relaxed to ">= 20") --------
  const used = contract?.used_by_layers;
  expect(
    Array.isArray(used),
    `geo_context.administrative_label_font.used_by_layers must be an array (got ${typeof used})`,
  ).toBe(true);
  const usedIds = (used as unknown[]).map(String);
  expect(new Set(usedIds).size, 'used_by_layers must not repeat a layer id').toBe(usedIds.length);
  expect(
    usedIds.length,
    `used_by_layers must be EXACTLY 20 layers (4 ADM + 8 real geo + 4 curated osm + 2 contour + 2 RAN) — ` +
      `the whitelist is a closed contract and is never relaxed to ">= 20" (served ${usedIds.length})`,
  ).toBe(20);
  expect(
    contract?.fontstack,
    'the isolated ADMIN glyph stack must be named "Offline Admin Latin"',
  ).toBe('Offline Admin Latin');

  // ---- runtime style: symbol layers actually using the ADMIN stack --------
  const runtime = await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: { map: { getStyle: () => { layers: StyledLayer[] } } } }).__gisApp!;
    return app.map.getStyle().layers
      .filter((l) => l.type === 'symbol')
      .map((l) => ({
        id: l.id,
        textFont: l.layout?.['text-font'],
        textColor: l.paint?.['text-color'],
      }));
  });
  const adminUsed = runtime.filter(
    (l) => Array.isArray(l.textFont) && (l.textFont as unknown[]).includes('Offline Admin Latin'),
  );
  const runtimeIds = adminUsed.map((l) => l.id).sort();
  const contractIds = [...usedIds].sort();
  expect(
    runtimeIds,
    `the runtime ADMIN-stack usage set must EXACTLY equal the served used_by_layers whitelist — ` +
      `runtime-only layers: ${JSON.stringify(runtimeIds.filter((id) => !contractIds.includes(id)))}, ` +
      `whitelist-only layers: ${JSON.stringify(contractIds.filter((id) => !runtimeIds.includes(id)))}`,
  ).toEqual(contractIds);

  // ---- every whitelisted layer declares white ink -------------------------
  const offenders = adminUsed
    .filter((l) => l.textColor !== '#ffffff')
    .map((l) => `${l.id}=${JSON.stringify(l.textColor)}`);
  expect(
    offenders,
    `all ${usedIds.length} whitelisted ADMIN-stack symbol layers must declare text-color #ffffff; ` +
      `offenders: ${offenders.join(', ')}`,
  ).toEqual([]);

  writeEvidence(testInfo, 'runtime-font-contract.json', {
    project: testInfo.project.name,
    servedUrl: metaUrl,
    fontstack: contract?.fontstack,
    usedByLayersCount: usedIds.length,
    usedByLayers: contractIds,
    runtimeAdminStackLayers: runtimeIds,
    runtimeTextColors: Object.fromEntries(adminUsed.map((l) => [l.id, l.textColor])),
    scopeNote:
      'STRUCTURAL contract only: whitelist size/exact set/white declaration. ' +
      'Pixel ink color, halo contrast and visual readability remain the designer image-review lane.',
  });
  void offlineGuard;
});
