import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'Docs',
  'screenshots',
  'v1.2.1',
);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Real primary admin fixture (geoBoundaries gbOpen), validated by the data
 * writers: 87 polygons (12 ADM1 + 75 ADM2) + 100 label points (87 overview /
 * 13 atlas). Read from the repo tree at test time so the spec never depends
 * on the served data path. Runtime admin layer ids are NOT guessed — they
 * are discovered from rendered symbol features carrying the exact fixture
 * properties (see fixtureFeaturePoint).
 */
const ADMIN_PROBE_IDS = {
  adm1: '70788906B60308563647099', // Marrakech-Safi (ADM1)
  adm2: '96644757B698999344864', // Al Haouz Province (ADM2)
};
type AdminLabelFeature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: [number, number] };
};
const ADMIN_LABELS_FIXTURE: { features: AdminLabelFeature[] } = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'public', 'data', 'admin-context-labels.geojson'), 'utf8'),
);
/** Probe contract lives in the separate metadata.json (NOT the label geojson). */
const ADMIN_METADATA: {
  geo_context?: {
    administrative_context?: { fixture_probe?: { labels?: Array<Record<string, unknown>> } };
  };
} = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'public', 'data', 'metadata.json'), 'utf8'),
);

/** Fixture probe anchor: label-point feature of `shapeID` in `scope`. */
function adminProbe(shapeID: string, scope: 'overview' | 'atlas') {
  const f = ADMIN_LABELS_FIXTURE.features.find(
    (x) => x.properties.shapeID === shapeID && x.properties.scope === scope,
  );
  if (!f) throw new Error(`fixture probe ${shapeID}/${scope} missing from admin-context-labels.geojson`);
  return {
    shapeID,
    scope,
    level: String(f.properties.level),
    label: String(f.properties.label),
    lngLat: f.geometry.coordinates,
  };
}

/** ROI evidence for the paired on/off PNGs (Pillow contrast analysis input). */
type RoiRow = {
  project: string;
  capture: string;
  kind: 'glyph' | 'boundary';
  level: string;
  shapeID: string;
  label: string;
  layer: string;
  point: { x: number; y: number };
  roi: { x: number; y: number; width: number; height: number };
  pngOn: string;
  pngOff: string;
  /** How the on/off pair isolates this kind's ink (set on boundary rows). */
  isolation?: string;
  /** Injection stamp: identity of the invocation that wrote this row. */
  runId?: string;
  gate?: {
    thresholds: typeof VISIBILITY_GATE;
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
};

/**
 * Visibility gate — fixed BEFORE first execution (review defect 3); never
 * lowered to make a pass. A pixel "qualifies" only when BOTH hold:
 * WCAG-style on/off luminance contrast ratio >= 3:1 AND max RGB channel
 * delta >= 24. Each ROI must produce >= 24 qualifying pixels. This numeric
 * proxy supports — never replaces — the designer's actual image review.
 */
const VISIBILITY_GATE = {
  minContrastRatio: 3.0,
  minChannelDelta: 24,
  minQualifyingPixels: 24,
} as const;

// Inline Pillow analyzer (no new helper file; Pillow already installed).
// stdin: { on, off, roi, gate } -> stdout: one JSON metrics object.
const PILLOW_GATE = [
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

/** Run the Pillow on/off contrast gate for one ROI of a captured PNG pair. */
function pillowGate(onPng: string, offPng: string, roi: RoiRow['roi']) {
  const py = process.env.PYTHON_BIN ?? 'python';
  const out = execFileSync(py, ['-c', PILLOW_GATE], {
    input: JSON.stringify({ on: onPng, off: offPng, roi, gate: VISIBILITY_GATE }),
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

/** Viewport-clamped clip box centred on a screen point. */
function clipAround(p: { x: number; y: number }, w: number, h: number, vw: number, vh: number) {
  return {
    x: Math.max(0, Math.min(Math.round(p.x - w / 2), vw - w)),
    y: Math.max(0, Math.min(Math.round(p.y - h / 2), vh - h)),
    width: w,
    height: h,
  };
}

/**
 * MapLibre layout-visibility enum. `getLayoutProperty(id, 'visibility')`
 * returns null/undefined for an absent property; String() of that would
 * smuggle the literal 'undefined'/'null' into setLayoutProperty (invalid
 * enum, silent no-op). Normalize through this closed enum instead — any
 * absent/unknown read restores as the style default 'visible'.
 */
type LayerVisibility = 'visible' | 'none';

/**
 * Ink-class layer ids per admin level (src/config.ts LAYER_IDS; the gbOpen
 * casings live there because those layers ARE primary features). A probe may
 * legitimately anchor to the casing — the distinct symbol of the same
 * boundary class — so line ink = main line + casing. Symmetric glyph ink =
 * both scope variants of the level's label layers.
 */
const ADM_INK_LAYER_IDS: Record<'ADM1' | 'ADM2', Record<'line' | 'symbol', string[]>> = {
  ADM1: {
    line: ['geo-admin-gb1-casing', 'geo-admin-gb1-line'],
    symbol: ['geo-admin-gb1-labels', 'geo-admin-gb1-labels-a'],
  },
  ADM2: {
    line: ['geo-admin-gb2-casing', 'geo-admin-gb2-line'],
    symbol: ['geo-admin-gb2-labels', 'geo-admin-gb2-labels-a'],
  },
};

/**
 * Ink-evidence isolation (v1.2.1 rev3 — mechanism corrected per the official
 * strict4 evidence of the 13:08:19.817Z run): a checkbox toggle hides the
 * level's labels AND boundaries together, so ink of the OTHER class inside
 * an ROI could fake on/off contrast in either direction. Evidence frames
 * therefore hide ONLY the ink class under test, with a CLASS-SPECIFIC
 * mechanism:
 *
 * - BOUNDARY (line class): layout visibility='none'. Line layers take no
 *   part in symbol placement/collision, so hiding them cannot reflow any
 *   other ink.
 *
 * - GLYPH (symbol class): paint text-opacity=0 (captureGlyphPaintOffFrame).
 *   The rev2 layout-visibility mechanism is BROKEN for glyphs: visibility=
 *   'none' removes labels from symbol placement, MapLibre re-runs
 *   collision, and FOREIGN labels reflow into the ROI — observed in the
 *   official run as geo-place-labels-town "Moulay Brahim" appearing in the
 *   02b ADM2 glyph ROI after ADM2 labels visibility='none' (correctly
 *   caught by the foreign-symbol guard).
 *
 * Reliable preconditions, verified hard BEFORE any evidence frame is
 * captured: the probed layer is one of the level's layers of that ink
 * class; hiding actually reached at least one registered layer.
 */
async function captureLineOnlyOffFrame(page: Page, level: 'ADM1' | 'ADM2', probeLayer: string) {
  const ids = ADM_INK_LAYER_IDS[level].line;
  expect(
    ids.includes(probeLayer),
    `line probe anchored to ${probeLayer}, which is not one of the ${level} boundary layers ${JSON.stringify(ids)} — line-only isolation precondition violated`,
  ).toBeTruthy();
  const touched = await page.evaluate((ids) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const saved: Array<[string, LayerVisibility]> = [];
    for (const id of ids) {
      if (!app.map.getLayer(id)) continue;
      // This callback runs in the browser: normalize here, without capturing
      // a Node-side helper. Missing visibility restores the 'visible' default.
      saved.push([id, app.map.getLayoutProperty(id, 'visibility') === 'none' ? 'none' : 'visible']);
      app.map.setLayoutProperty(id, 'visibility', 'none');
    }
    return saved;
  }, ids);
  expect(
    touched.length,
    `no ${level} boundary line layers are registered — a line-only OFF frame would not isolate anything`,
  ).toBeGreaterThan(0);
  return touched;
}

/**
 * Boundary OFF frame: hides ONLY the level's line+casing via layout
 * visibility (safe — lines take no part in symbol placement/collision).
 */
async function captureBoundaryOffFrame(page: Page, level: 'ADM1' | 'ADM2', probeLayer: string) {
  return captureLineOnlyOffFrame(page, level, probeLayer);
}

/**
 * Glyph paint save record, JSON-boundary-safe: `prior` holds the exact
 * pre-hide `text-opacity` value — a number, an expression object/array, or
 * `null` as the serialized marker for a property that was UNSET (the
 * runtime reads absent properties as undefined, which Playwright
 * serialization cannot carry through an object). `layout` keeps the
 * (inline-normalized) layout visibility at capture time.
 */
type GlyphPaintSave = { id: string; prior: unknown; layout: LayerVisibility };

/** One accepted (owned + unobstructed) evidence anchor from discovery. */
type OwnedFeaturePoint = {
  x: number;
  y: number;
  layer: string;
  shapeID: string;
  level: string;
  label: string;
  source: string;
  source_version: string;
  source_year: string;
  admin_level: string;
  scope: string;
  topmostLevel: string;
};

/**
 * Glyph OFF frame (v1.2.1 rev3): PAINT text-opacity=0 over ONLY the level's
 * label layers — collision-preserving label hiding. Installed maplibre-gl
 * 5.24 behavior (verified in node_modules source, not assumed):
 * - src/symbol/placement.ts reads NO text-opacity among paint props (only
 *   text/icon-translate) — placement/collision inputs are unchanged, so the
 *   labels keep FULL placement participation and NO other label reflows;
 * - src/webgl/draw/draw_symbol.ts skips text drawing entirely when the
 *   constant text-opacity is 0 — the glyphs render zero ink;
 * - a CONSTANT paint value does not trigger relayout
 *   (style_layer.setPaintProperty returns requiresRelayout only for
 *   data-driven/cross-faded changes).
 */
async function captureGlyphPaintOffFrame(page: Page, level: 'ADM1' | 'ADM2', probeLayer: string) {
  const ids = ADM_INK_LAYER_IDS[level].symbol;
  expect(
    ids.includes(probeLayer),
    `symbol probe anchored to ${probeLayer}, which is not one of the ${level} label layers ${JSON.stringify(ids)} — glyph-only isolation precondition violated`,
  ).toBeTruthy();
  const saved: GlyphPaintSave[] = await page.evaluate((ids) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const out: GlyphPaintSave[] = [];
    for (const id of ids) {
      if (!app.map.getLayer(id)) continue;
      // Browser-side normalization only (no Node closures): an unset paint
      // property reads as undefined here and is serialized as the null
      // marker; the layout read is enum-normalized the same way.
      const prior = app.map.getPaintProperty(id, 'text-opacity');
      out.push({
        id,
        prior: prior === undefined ? null : prior,
        layout: app.map.getLayoutProperty(id, 'visibility') === 'none' ? 'none' : 'visible',
      });
      app.map.setPaintProperty(id, 'text-opacity', 0);
    }
    return out;
  }, ids);
  expect(
    saved.length,
    `no ${level} label layers are registered — a glyph-only OFF frame would not isolate anything`,
  ).toBeGreaterThan(0);
  for (const t of saved) {
    // Collision preservation ONLY holds while the layers stay layout-visible:
    // a paint hide on a layout-hidden layer would prove nothing about glyph
    // ink (the glyphs would be gone for the wrong reason).
    expect(t.layout, `${t.id} must be layout-'visible' before the paint hide — collision-preservation precondition`).toBe('visible');
  }
  // The hide must actually reach every registered layer: exact readback.
  const hidden = await page.evaluate((ids) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    return ids.filter((id) => app.map.getLayer(id)).map((id) => app.map.getPaintProperty(id, 'text-opacity'));
  }, ids);
  expect(hidden).toEqual(saved.map(() => 0));
  return saved;
}

/** Exact-visibility restore after a line-only OFF frame (closed enum). */
async function restoreLayerVisibility(page: Page, touched: Array<[string, LayerVisibility]>) {
  await page.evaluate((touched) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    for (const [id, visibility] of touched) {
      if (app.map.getLayer(id)) app.map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, touched);
}

/**
 * Exact paint restore after a glyph paint-hide OFF frame, readback-proved
 * per layer. `prior === null` (the unset marker) is restored by setting
 * null, which maplibre-gl 5.24 style_layer.setPaintProperty treats as a
 * reset to the style default — the layer ends byte-identical to its
 * pre-evidence state. Expression objects round-trip through Playwright
 * serialization and are compared via exact JSON string equality.
 */
async function restoreGlyphPaint(page: Page, saved: GlyphPaintSave[]) {
  const readback: Array<{ id: string; value: unknown }> = await page.evaluate((saved) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    const out: Array<{ id: string; value: unknown }> = [];
    for (const t of saved) {
      if (!app.map.getLayer(t.id)) continue;
      app.map.setPaintProperty(t.id, 'text-opacity', t.prior);
      out.push({ id: t.id, value: app.map.getPaintProperty(t.id, 'text-opacity') });
    }
    return out;
  }, saved);
  expect(readback.length, 'paint restore must reach every saved layer').toBe(saved.length);
  for (let i = 0; i < saved.length; i++) {
    const t = saved[i]!;
    if (t.prior === null) {
      // unset marker: after the null reset the property reads back
      // undefined (serialized across the boundary as null) — both prove
      // "unset again".
      const value = readback[i]!.value;
      expect(
        value === undefined || value === null,
        `${t.id} text-opacity must be UNSET after restore (got ${JSON.stringify(value)})`,
      ).toBe(true);
    } else {
      expect(
        JSON.stringify(readback[i]!.value) === JSON.stringify(t.prior),
        `${t.id} text-opacity restore mismatch: got ${JSON.stringify(readback[i]!.value)}, captured ${JSON.stringify(t.prior)}`,
      ).toBe(true);
    }
  }
}

/**
 * Real symbol matching over a rect: identity keys (layer + fixture fields)
 * of every rendered symbol feature intersecting the ROI. Used to prove the
 * label-only glyph OFF frame introduces no foreign ink (label hiding can
 * re-run symbol placement) and that only target-class ink vanishes.
 */
const GEO_SYMBOL_LAYERS = [
  'geo-admin-gb1-labels', 'geo-admin-gb1-labels-a',
  'geo-admin-gb2-labels', 'geo-admin-gb2-labels-a',
  'geo-place-labels-major', 'geo-place-labels-town', 'geo-place-labels-local',
  'geo-place-labels-major-d', 'geo-place-labels-town-d', 'geo-place-labels-local-d',
  'geo-peak-labels', 'geo-peak-labels-d',
];
async function symbolInkInRect(page: Page, roi: RoiRow['roi']): Promise<Set<string>> {
  const keys = await page.evaluate(({ roi, layers }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) return [];
    const ids = layers.filter((l) => app.map.getLayer(l));
    if (!ids.length) return [];
    return app.map
      .queryRenderedFeatures([[roi.x, roi.y], [roi.x + roi.width, roi.y + roi.height]], { layers: ids })
      .map((f) =>
        `${f.layer.id}::${String(f.properties?.name ?? '')}::${String(f.properties?.label ?? '')}::${String(f.properties?.shapeID ?? '')}`,
      );
  }, { roi, layers: GEO_SYMBOL_LAYERS });
  return new Set(keys);
}

/**
 * v1.2.1 panel TAB contract (designer-finalized ids, stable): trigger
 * #panel-tab-map (boot default) drives #panel-page-map with the ORIGINAL
 * controls (view mode, extent, 3D, osm/scene/legacy layers, legend);
 * trigger #panel-tab-data drives #panel-page-data hosting the whole
 * #grp-geo (every ly-geo-* toggle). Activation is a REAL click with the
 * two-way page swap hard-asserted — evidence never force-reveals a
 * display:none control and never screenshots a silently stale page.
 */
async function selectPanelTab(page: Page, tab: 'map' | 'data') {
  const other = tab === 'map' ? 'data' : 'map';
  const trigger = page.locator(`#panel-tab-${tab}`);
  await expect(trigger, `panel tab trigger #panel-tab-${tab} must be reachable`).toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(
    page.locator(`#panel-page-${tab}`),
    `#panel-page-${tab} must become visible after activating its tab`,
  ).toBeVisible();
  await expect(
    page.locator(`#panel-page-${other}`),
    `#panel-page-${other} must hide after activating #panel-tab-${tab}`,
  ).toBeHidden();
}

/**
 * DOM preference snapshot (every geo toggle's checked state + the active
 * view-mode segment). Pure property/class reads — no actionability — so it
 * works no matter which panel page is showing; used to prove TAB switching
 * and the GIS/RAN roundtrip change NO control preference.
 */
async function controlPrefsSnapshot(page: Page) {
  return page.evaluate((ids: string[]) => {
    const checks: Record<string, boolean | null> = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      checks[id] = el instanceof HTMLInputElement ? el.checked : null;
    }
    const activeSeg = document.querySelector('#grp-viewmode .seg.active');
    return { checks, activeView: activeSeg instanceof HTMLElement ? activeSeg.id : null };
  }, Object.keys(GROUP_REPRESENTATIVE));
}

/** Hard functional assertion: every registered group layer reports `expected`. */
async function assertGroupToggle(page: Page, ids: string[], expected: LayerVisibility) {
  for (const id of ids) {
    const visibility = await layerVisibility(page, id);
    if (visibility === null) continue; // layer not registered in this frame
    expect(visibility, `${id} visibility after checkbox toggle`).toBe(expected);
  }
}

const ROI_PATH = path.join(REPO_ROOT, 'Docs', 'v1_2_1_admin_visibility_rois.json');
/** Identity of THIS spec invocation (module load ≈ worker start). */
const ROI_RUN_ID = `${new Date().toISOString()}#${process.pid}`;
/**
 * Narrow per-run reset, called at scenario-02 START before anything can
 * capture: drop THIS project's scenario-02 rows left by ANY previous
 * invocation, so per-run evidence can never retain stale entries. No other
 * test writes ROI rows, so this covers the project's whole footprint.
 */
function resetProjectScenario02RoiKeys(project: string) {
  let all: Record<string, RoiRow> = {};
  try { all = JSON.parse(readFileSync(ROI_PATH, 'utf8')); } catch { return; /* no file yet */ }
  let changed = false;
  for (const key of Object.keys(all)) {
    const row = all[key];
    if (row?.project === project && /^02/.test(row.capture)) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) writeFileSync(ROI_PATH, JSON.stringify(all, null, 2));
}
/**
 * Evidence is written immediately (logger-first: on disk BEFORE any numeric
 * gate so a threshold failure still lands in the JSON). Every row is stamped
 * with this invocation's ROI_RUN_ID, and any same-project row carrying a
 * DIFFERENT run id is pruned on write — belt-and-suspenders on top of the
 * scenario-02 start reset, so stale entries cannot survive even if a run
 * dies before the reset could matter. Other projects' rows are untouched
 * here (suite projects run serially; each resets/prunes only its own keys).
 */
function recordRoi(rows: RoiRow[]) {
  let all: Record<string, RoiRow> = {};
  try { all = JSON.parse(readFileSync(ROI_PATH, 'utf8')); } catch { /* first write */ }
  const project = rows[0]?.project;
  if (project) {
    for (const key of Object.keys(all)) {
      const row = all[key];
      if (row?.project === project && row.runId !== ROI_RUN_ID) delete all[key];
    }
  }
  for (const r of rows) all[`${r.project}::${r.capture}::${r.kind}`] = { ...r, runId: ROI_RUN_ID };
  writeFileSync(ROI_PATH, JSON.stringify(all, null, 2));
}

/**
 * v1.2.1 Geographic Context acceptance suite (task doc §八 scenarios 1-12).
 *
 * Runs against the PACKAGED offline build served by start-offline.ps1
 * (GIS_DEMO_URL). All non-localhost requests are blocked and counted in every
 * test; the app must serve everything (PMTiles archives, glyphs, geojson)
 * from 127.0.0.1 only.
 */

// representative layer per toggle group (first overview-archive member)
const GROUP_REPRESENTATIVE: Record<string, string> = {
  'ly-geo-admin': 'geo-admin-country',
  'ly-geo-adm1': 'geo-admin-gb1-line',
  'ly-geo-adm2': 'geo-admin-gb2-line',
  'ly-geo-places': 'geo-place-labels-major',
  'ly-geo-roads': 'geo-roads-major',
  'ly-geo-water': 'geo-water-fill',
  'ly-geo-natural': 'geo-peak-labels',
};

function blockExternal(page: Page) {
  const external: string[] = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    // In-memory worker/data URLs perform no external network request.
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      external.push(req.url());
    }
  });
  return () => external;
}

/** Tile-network silence across BOTH terrain and geo PMTiles archives. */
function trackTileTraffic(page: Page) {
  let inFlight = 0;
  let lastActivity = Date.now();
  const isTile = (u: string) =>
    /\/data\/(hypso|dem-terrarium|contours|morocco-overview|high-atlas-context)\.pmtiles/.test(u);
  page.on('request', (r) => {
    if (isTile(r.url())) { inFlight++; lastActivity = Date.now(); }
  });
  page.on('requestfinished', (r) => {
    if (isTile(r.url())) { inFlight--; lastActivity = Date.now(); }
  });
  page.on('requestfailed', (r) => {
    if (isTile(r.url())) { inFlight--; lastActivity = Date.now(); }
  });
  return async (quietMs = 3_000, timeout = 180_000) => {
    const t0 = Date.now();
    for (;;) {
      // Quiet must be measured from AFTER the caller's camera change: tile
      // requests register a tick or two after jumpTo returns, so silence
      // inherited from before the move is not settlement (full-suite flake
      // 2026-11-01: 01-overview queried a tile-less frame 1ms after jumpTo).
      if (inFlight === 0 && Date.now() - Math.max(lastActivity, t0) >= quietMs) return;
      if (Date.now() - t0 > timeout) throw new Error(`tile traffic did not settle within ${timeout}ms (inFlight=${inFlight})`);
      await page.waitForTimeout(250);
    }
  };
}

type GisApp = {
  map: {
    getLayer: (id: string) => boolean;
    getLayoutProperty: (id: string, prop: string) => unknown;
    getPaintProperty: (id: string, prop: string) => unknown;
    setPaintProperty: (id: string, prop: string, value: unknown) => void;
    setLayoutProperty: (id: string, prop: string, value: unknown) => void;
    getCenter: () => { lng: number; lat: number };
    getZoom: () => number;
    getPitch: () => number;
    getTerrain: () => { source?: string } | null;
    setTerrain: (t: unknown) => void;
    queryTerrainElevation: (c: [number, number], o: { exaggerated: boolean }) => number | null;
    queryRenderedFeatures: (
      p: unknown,
      o?: { layers?: string[] },
    ) => Array<{
      layer: { id: string; type?: string };
      properties: Record<string, unknown>;
      // Explicit any matches the pre-existing downstream casts verbatim (the
      // geometry-walk code narrows raw GeoJSON shapes itself).
      geometry?: any;
    }>;
    project: (c: [number, number]) => { x: number; y: number };
    jumpTo: (o: unknown) => void;
    getFilter: (id: string) => unknown;
  };
  extent: 'atlas' | 'overview';
};

/** Boot the app and wait until the geo context layers are registered. */
async function boot(page: Page, hash = '') {
  // A goto that only changes the hash does NOT reload the document, so a
  // second boot() on the same page would inherit the first app instance
  // (mode/extent/hash state). Force a real document navigation every time.
  if (!page.url().startsWith('about:')) await page.goto('about:blank');
  await page.goto('/' + hash, { waitUntil: 'load' });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.map.getLayer('geo-admin-country') && app.map.getLayer('geo-water-fill');
  }, undefined, { timeout: 60_000, polling: 250 });
  // boot-race visibility sync (controls.ts retries for ~30 s) must have applied
  await page.waitForTimeout(500);
}

/** Whole-viewport rendered feature names on the given geo layers. */
async function renderedNames(page: Page, layers: string[], limit = 400) {
  return page.evaluate(({ layers, limit }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) return [];
    const ids = layers.filter((l) => app.map.getLayer(l));
    if (!ids.length) return [];
    return app.map
      .queryRenderedFeatures(undefined, { layers: ids })
      .slice(0, limit)
      .map((f) => ({
        name: String(f.properties?.name ?? ''),
        layer: f.layer?.id ?? '',
        disputed: f.properties?.disputed,
      }));
  }, { layers, limit });
}

async function layerVisibility(page: Page, id: string): Promise<string | null> {
  return page.evaluate((id) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app || !app.map.getLayer(id)) return null;
    return String(app.map.getLayoutProperty(id, 'visibility'));
  }, id);
}

/** Exact style-filter JSON of a layer (curated-dedup reversibility evidence). */
async function layerFilterJson(page: Page, id: string): Promise<string> {
  return page.evaluate((id) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app || !app.map.getLayer(id)) return '<unregistered>';
    return JSON.stringify(app.map.getFilter(id) ?? null);
  }, id);
}

/**
 * Known SOURCE base filters of the 8 dedup-target label layers, verbatim
 * from src/map/geographic-context.ts buildGeoContextLayers (cityFilter /
 * townFilter / localFilter / peak filter — static in source). The dedup
 * un-check must restore EXACTLY these values, so the test compares against
 * the known source baseline instead of capturing a possibly-already-guarded
 * "original" at runtime.
 */
const DEDUP_BASE_FILTERS: Record<string, unknown> = {
  'geo-place-labels-major': ['any', ['==', ['get', 'kind'], 'country'], ['in', ['get', 'kind_detail'], ['literal', ['city']]]],
  'geo-place-labels-town': ['==', ['get', 'kind_detail'], 'town'],
  'geo-place-labels-local': ['in', ['get', 'kind_detail'], ['literal', ['village', 'hamlet', 'neighbourhood']]],
  'geo-place-labels-major-d': ['any', ['==', ['get', 'kind'], 'country'], ['in', ['get', 'kind_detail'], ['literal', ['city']]]],
  'geo-place-labels-town-d': ['==', ['get', 'kind_detail'], 'town'],
  'geo-place-labels-local-d': ['in', ['get', 'kind_detail'], ['literal', ['village', 'hamlet', 'neighbourhood']]],
  'geo-peak-labels': ['in', ['get', 'kind'], ['literal', ['peak', 'saddle']]],
  'geo-peak-labels-d': ['in', ['get', 'kind'], ['literal', ['peak', 'saddle']]],
};

async function paintProp(page: Page, id: string, prop: string): Promise<unknown> {
  return page.evaluate(({ id, prop }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app || !app.map.getLayer(id)) return null;
    return app.map.getPaintProperty(id, prop);
  }, { id, prop });
}

async function extent(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return app ? app.extent : null;
  });
}

async function terrainSource(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return app ? app.map.getTerrain()?.source ?? null : null;
  });
}

/**
 * Find a rendered feature of `layers` and return a screen point hitting it.
 *
 * When `match` is given, `layers` may be empty (query all layers) and only
 * features whose properties equal every `match` entry exactly are accepted —
 * this is how the geoBoundaries fixture layers are targeted without knowing
 * their runtime layer ids.
 *
 * Strategy 1 (geometry-first): query the rendered features of exactly these
 * layers across the viewport, walk their LineString/MultiLineString/Point
 * geometry (lng/lat), project vertices + segment midpoints to screen space
 * and verify every candidate with a point queryRenderedFeatures before
 * returning it. This pins the click to the actual line even when it is a
 * thin dashed stroke the coarse grid would step over.
 *
 * Strategy 2 (fallback): the historical 30px grid scan — still needed for
 * terrain cameras, where map.project() ignores elevation displacement and
 * geometry candidates can verify false.
 *
 * queryRenderedFeatures is camera-space only — it cannot know which UI
 * panels overlay the map — so every candidate point is DOM hit-tested and
 * only points landing on the map canvas are returned (otherwise the
 * follow-up page.mouse.click lands on a panel and no map popup opens).
 */
async function findClickPoint(page: Page, layers: string[], match?: Record<string, string>) {
  return page.evaluate(({ layers, match }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) return null;
    const ids = layers.filter((l) => app.map.getLayer(l));
    const ok = match
      ? (props: Record<string, unknown> | undefined) =>
          !!props && Object.entries(match).every(([k, v]) => String(props[k]) === String(v))
      : null;
    const overMapCanvas = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el && el.tagName === 'CANVAS' && !!el.closest('#map');
    };
    const candidate = (x: number, y: number) => {
      if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) return null;
      if (!overMapCanvas(x, y)) return null;
      // PointLike is a plain [x, y] pair (an array of objects is not a
      // valid geometry argument and yields no hits)
      const hits = ids.length
        ? app.map.queryRenderedFeatures([x, y], { layers: ids })
        : app.map.queryRenderedFeatures([x, y]);
      if (!hits.length) return null;
      const f = ok
        ? hits.find((h) => ok(h.properties))
        : hits.find((h) => h.layer.id.startsWith('geo-')) ?? hits[0];
      if (!f) return null;
      return {
        x, y,
        name: String(f.properties?.name ?? ''),
        layer: f.layer.id,
        shapeID: f.properties?.shapeID != null ? String(f.properties.shapeID) : null,
      };
    };

    // ---- strategy 1: sample the rendered geometry itself ------------------
    const seen = new Set<string>();
    let attempts = 0;
    let feats: ReturnType<typeof app.map.queryRenderedFeatures> = [];
    try {
      feats = ids.length
        ? app.map.queryRenderedFeatures(undefined, { layers: ids })
        : app.map.queryRenderedFeatures(undefined);
    } catch { feats = []; }
    for (const f of feats) {
      if (ok && !ok(f.properties)) continue;
      const g = f.geometry as { type?: string; coordinates?: unknown } | null;
      if (!g || attempts > 400) break;
      const coords = g.coordinates as unknown;
      const lines: number[][][] =
        g.type === 'LineString' ? [coords as number[][]] :
        g.type === 'MultiLineString' ? (coords as number[][][]) :
        g.type === 'Point' ? [[coords as number[]]] :
        // MultiPoint coordinates are number[][]; each point walks as its own
        // single-vertex line.
        g.type === 'MultiPoint' ? (coords as number[][]).map((point) => [point]) :
        []; // Polygon/MultiPolygon -> grid fallback below
      let perFeature = 0;
      for (const line of lines) {
        const pts: number[][] = line.length === 1 ? [line[0]!, line[0]!] : line;
        for (let i = 1; i < pts.length; i++) {
          // length === 1 widened to two identical stops; loop bounds keep
          // i-1/i inside the array and every walked position carries [x, y]
          // (geojson lint) — the non-null assertions below are sound.
          const a = pts[i - 1]!;
          const b = pts[i]!;
          const ax = a[0]!;
          const ay = a[1]!;
          const bx = b[0]!;
          const by = b[1]!;
          for (const t of [0, 0.5, 1]) { // vertices + segment midpoint
            const p = app.map.project([ax + (bx - ax) * t, ay + (by - ay) * t]);
            const x = Math.round(p.x);
            const y = Math.round(p.y);
            const key = `${Math.round(x / 4)}:${Math.round(y / 4)}`;
            if (seen.has(key) || perFeature > 120) continue;
            seen.add(key);
            perFeature++;
            attempts++;
            const hit = candidate(x, y);
            if (hit) return hit;
          }
        }
      }
    }

    // ---- strategy 2: historical 30px grid scan ----------------------------
    for (let y = 70; y < window.innerHeight - 60; y += 30) {
      for (let x = 70; x < window.innerWidth - 60; x += 30) {
        const hit = candidate(x, y);
        if (hit) return hit;
      }
    }
    return null;
  }, { layers, match: match ?? null });
}

/**
 * Exact screen point of a rendered label at a known lng/lat (map.project()),
 * probing a small window around the anchor because the symbol text sits
 * below the point anchor (text-offset 0.85em, text-anchor top). DOM
 * hit-tested like findClickPoint; only the named feature matches.
 */
async function labelPointFor(
  page: Page,
  lngLat: [number, number],
  layers: string[],
  namePattern: string,
) {
  return page.evaluate(({ lngLat, layers, namePattern }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) return null;
    const ids = layers.filter((l) => app.map.getLayer(l));
    if (!ids.length) return null;
    const re = new RegExp(namePattern, 'i');
    const overMapCanvas = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el && el.tagName === 'CANVAS' && !!el.closest('#map');
    };
    const base = app.map.project(lngLat);
    for (const dy of [0, 6, 12, 18, 24, 30, -6, -12]) {
      for (const dx of [0, -12, 12, -24, 24]) {
        const x = base.x + dx;
        const y = base.y + dy;
        if (!overMapCanvas(x, y)) continue;
        const hits = app.map.queryRenderedFeatures([x, y], { layers: ids });
        const f = hits.find((h) => re.test(String(h.properties?.name ?? '')));
        if (f) return { x, y, name: String(f.properties?.name ?? ''), layer: f.layer.id };
      }
    }
    return null;
  }, { lngLat, layers, namePattern });
}

/**
 * Locate a fixture-identified admin feature (geoBoundaries gbOpen) on screen
 * WITHOUT knowing the runtime layer ids. `kind` pins the maplibre layer type
 * exactly: 'symbol' for label glyphs, 'line' for boundary stroke/casing —
 * a boundary probe can therefore never resolve to the same symbol feature
 * as the glyph probe, and must sit on the physical line stroke (query hits
 * on line layers are exact stroke intersections), never on points.
 *
 * Acceptance for a candidate screen point, ALL of:
 * - queryRenderedFeatures at that exact point returns a feature whose
 *   properties match every `match` entry exactly AND whose layer.type
 *   equals `kind`;
 * - for symbols, the layer's text-field binds the fixture `label` field
 *   and does NOT bind the original `name` field;
 * - for lines (v1.2.1 rev3, designer probe10): the TOPMOST admin boundary
 *   stroke at the point must be the TARGET's own level — a different level
 *   painted above is occlusion and the candidate is rejected; discovery
 *   continues over the remaining real geometry candidates and returns null
 *   when no owned candidate exists (the caller's toBeTruthy then fails and
 *   the CAMERA must be fixed — never a weakened anchor);
 *   same-level co-owners at shared edges stay accepted: one physical shared
 *   boundary stroke legitimately belongs to BOTH adjacent same-level shapes
 *   (probe10 observed gb1-line carrying TWO ADM1 shapeIDs at the exact
 *   shared point), so the topmost check is deliberately LEVEL-only while the
 *   matching hit itself still satisfies the exact target property match —
 *   requiring the first same-level hit's shapeID to equal the target's would
 *   wrongly reject those genuine shared-edge evidence points;
 * - the WHOLE evidence patch around the point (240x72 for symbols,
 *   160x160 for lines) is verified unobstructed by TWO guards, neither
 *   sufficient alone: (1) a canvas grid over corners + intermediate points
 *   — catches ANY overlay at a sample point, known or unknown — and (2)
 *   every VISIBLE known UI overlay's bounding box (panels/header/legend/
 *   attribution/controls/popups/hints) must NOT intersect the patch rect,
 *   closing the between-sample-points gap the grid cannot prove. checkbox/
 *   UI pixels can therefore never fake the on/off contrast ROI.
 *
 * Strategy A: probe a window around the projected anchor — symbol glyphs are
 * queryable across their whole text box, not only at the anchor pixel, and
 * the fixture label point is the anchor.
 * Strategy B: geometry-first sampling of the matching features' own rendered
 * geometry (vertices + segment midpoints) with a ±6px jitter neighbourhood
 * to absorb terrain elevation displacement (map.project is elevation-blind).
 *
 * v1.2.1 rev6: discovery returns an ORDERED candidate list
 * (fixtureOwnedPoints) — per-candidate validation is unchanged, but the
 * caller's unchanged fixed on/off gate picks the winning anchor point by
 * point (test 02's main-frame ADM1 boundary block). fixtureFeaturePoint
 * keeps the single-anchor convenience: the first candidate of the same
 * deterministic walk.
 */
async function fixtureOwnedPoints(
  page: Page,
  match: Record<string, string>,
  kind: 'symbol' | 'line',
  near: [number, number] | null,
  windowPx = 64,
  limit = 1,
): Promise<OwnedFeaturePoint[]> {
  return page.evaluate(({ match, kind, near, windowPx, limit }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    if (!app) return null;
    const ok = (props: Record<string, unknown> | undefined) =>
      !!props && Object.entries(match).every(([k, v]) => String(props[k]) === String(v));
    const patch = kind === 'symbol' ? { w: 240, h: 72 } : { w: 160, h: 160 };
    // Known UI overlay roots (from index.html markup + MapLibre chrome; the
    // two hints are created at runtime in map.ts). Review finding: the point
    // grid ALONE cannot prove the whole patch unobstructed — a small overlay
    // can sit between sample points — so every VISIBLE overlay's bounding
    // box must additionally NOT intersect the patch rect. Extensible: the
    // designer's TAB panel roots get appended to this selector.
    const OVERLAY_SELECTOR = [
      '#topbar', '#panel-left', '#panel-right', '#attribution',
      '#overview-hint', '.boundary-hint', '#terrain-denied-toast',
      // designer-finalized panel TAB roots (v1.2.1): triggers + both pages
      '#panel-tab-map', '#panel-tab-data', '#panel-page-map', '#panel-page-data',
      '.maplibregl-ctrl-bottom-left', '.maplibregl-ctrl-bottom-right',
      '.maplibregl-ctrl-top-left', '.maplibregl-ctrl-top-right',
      '.maplibregl-ctrl-attrib', '.maplibregl-popup',
      '.maplibregl-popup-content', '.maplibregl-popup-tip',
    ].join(', ');
    // The UI is static for the whole discovery pass (no DOM interaction
    // inside this evaluate), so collect overlay rects exactly once.
    let overlayRects: Array<{ l: number; r: number; t: number; b: number }> | null = null;
    const knownOverlays = () => {
      if (overlayRects) return overlayRects;
      const rects: Array<{ l: number; r: number; t: number; b: number }> = [];
      for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        rects.push({ l: box.left, r: box.right, t: box.top, b: box.bottom });
      }
      overlayRects = rects;
      return rects;
    };
    const patchFree = (cx: number, cy: number) => {
      const x0 = Math.round(cx - patch.w / 2);
      const y0 = Math.round(cy - patch.h / 2);
      const x1 = x0 + patch.w;
      const y1 = y0 + patch.h;
      if (x0 < 0 || y0 < 0 || x1 > window.innerWidth || y1 > window.innerHeight) return false;
      // guard 1 — canvas grid (kept as ADDITIONAL guard): any overlay at a
      // sample point fails, including overlays not in the known list.
      // (#map is inset:0, so map.project coords == viewport coords.)
      const nx = kind === 'symbol' ? 5 : 4;
      const ny = kind === 'symbol' ? 3 : 4;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const px = x0 + Math.round(((patch.w - 1) * ix) / (nx - 1));
          const py = y0 + Math.round(((patch.h - 1) * iy) / (ny - 1));
          const el = document.elementFromPoint(px, py);
          if (!el || el.tagName !== 'CANVAS' || !el.closest('#map')) return false;
        }
      }
      // guard 2 — visible known-overlay bounding boxes must NOT overlap the
      // patch (strict inequalities: boxes merely touching the rect edge do
      // not count; the ROI is never shrunk).
      for (const o of knownOverlays()) {
        if (o.l < x1 && o.r > x0 && o.t < y1 && o.b > y0) return false;
      }
      return true;
    };
    const pick = (f: { layer: { id: string; type?: string }; properties?: Record<string, unknown> }) => {
      const p = f.properties ?? {};
      return {
        x: 0,
        y: 0,
        layer: f.layer.id,
        shapeID: String(p.shapeID ?? ''),
        level: String(p.level ?? ''),
        label: String(p.label ?? ''),
        source: String(p.source ?? ''),
        source_version: String(p.source_version ?? ''),
        source_year: String(p.source_year ?? ''),
        admin_level: String(p.admin_level ?? ''),
        scope: String(p.scope ?? ''),
      };
    };
    // v1.2.1 rev3 — topmost-stroke ownership for line candidates (designer
    // probe10): at an ADM1/ADM2 SHARED edge the same physical stroke is
    // drawn twice, and ADM1 is styled ABOVE ADM2 (probe10 top hits at the
    // shared point: gb1-line Marrakech-Safi, then Souss-Massa, casing gb1,
    // then gb2 Al Haouz / Taroudant). A candidate anchored where a DIFFERENT
    // level paints OVER the target level yields contaminated OFF evidence —
    // hiding the target level changes almost nothing (probe10: maxΔ 23
    // occluded under ADM1 vs maxΔ 154 on the same path). queryRenderedFeatures
    // returns features TOPMOST-FIRST (installed 5.24 source
    // _flattenAndSortRenderedFeatures iterates style._order from the top;
    // probe10 observed the same order live), so the FIRST admin-line hit
    // owns the visible stroke; if its level differs from the target's, the
    // candidate is rejected and discovery continues over the remaining REAL
    // geometry candidates. Budgets, fixed thresholds, whole-ROI guards and
    // shapeID/source/line-type matching are all unchanged; no pixel-maximum
    // search; no hiding ADM1/terrain/contours.
    //
    // Shared-edge identity: one same-level boundary segment legitimately
    // belongs to BOTH adjacent shapes (probe10: gb1-line carries TWO ADM1
    // shapeIDs at the exact same point), so requiring the top hit's shapeID
    // to equal the target's would be over-strict and would reject genuine
    // evidence. The honest rule is LEVEL ownership only: same-level
    // co-owners are accepted, a different level above is occlusion.
    const ADMIN_LINE_LEVEL_BY_LAYER: Record<string, string> = {
      'geo-admin-country': 'ADM0',
      'geo-admin-gb2-casing': 'ADM2',
      'geo-admin-gb2-line': 'ADM2',
      'geo-admin-gb1-casing': 'ADM1',
      'geo-admin-gb1-line': 'ADM1',
    };
    const topmostAdminStrokeLevel = (
      all: ReturnType<typeof app.map.queryRenderedFeatures>,
    ): string | null => {
      const top = all.find(
        (h) => h.layer.type === 'line' && ADMIN_LINE_LEVEL_BY_LAYER[h.layer.id] !== undefined,
      );
      if (!top) return null; // no admin line drawn at the point — cannot occlude
      return ADMIN_LINE_LEVEL_BY_LAYER[top.layer.id]!;
    };
    const targetLevelOf = (target: { layer: { id: string }; properties?: Record<string, unknown> }) =>
      String(target.properties?.level ?? '') || ADMIN_LINE_LEVEL_BY_LAYER[target.layer.id] || '';
    // v1.2.1 rev5 — non-coincidence for ADM1 candidates: at an ADM1/ADM2
    // shared edge the topmost stroke IS the target (ownership passes), yet
    // hiding ADM1 reveals ADM2's dark solid casing — not terrain — so the
    // on/off diff measures the 55%-alpha cream dash against that dark
    // residual (rev4 1080p failure: 433 ROI pixels carried ADM1 ink but
    // only 5 reached 3:1 against the residual). The corrupting case is
    // ADM2 ink persisting INSIDE the removed stroke's own footprint: the
    // z10 ADM1 casing is ~3.2px wide (half-width ≈1.6px), so a candidate
    // whose ±2px rendered-geometry box intersects `geo-admin-gb2-line` or
    // `geo-admin-gb2-casing` is rejected and discovery continues over the
    // remaining real geometry candidates. ADM2 (provinces) aggregates into
    // ADM1 (regions) along most of the boundary, so the box stays at the
    // footprint scale: a wider ±4px box rejected every on-screen candidate
    // in the rev5 attempt (both viewports toBeTruthy null) without making
    // the evidence cleaner. Rendered-box query — same deterministic-
    // geometry evidence class as the ownership check; no pixel scan, no
    // threshold change. ADM2 needs no mirror rule: ADM1 always paints
    // above it, so a shared-edge ADM2 candidate is already rejected by
    // the ownership gate.
    const tryPoint = (x: number, y: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) return null;
      // One query per candidate; `all` is ordered TOPMOST-FIRST (see the
      // ownership note above).
      const all = app.map.queryRenderedFeatures([x, y]);
      const f = all.find((h) => h.layer.type === kind && ok(h.properties));
      if (!f) return null;
      if (kind === 'symbol') {
        const tf = JSON.stringify(app.map.getLayoutProperty(f.layer.id, 'text-field'));
        if (!tf.includes('"label"') || tf.includes('"name"')) return null;
        if (!patchFree(x, y)) return null;
        return { ...pick(f), x, y, topmostLevel: '' };
      }
      // line candidate: whole-ROI guard first, then STRICT topmost-stroke
      // ownership — the candidate is evidence only if the topmost admin
      // stroke at the point IS the target level. A different level above is
      // occlusion: reject and continue over the remaining real geometry
      // candidates. No fallback path exists by design; on a camera whose
      // panel composition hides every owned stroke of the target level this
      // returns null and the caller's toBeTruthy fails correctly.
      if (!patchFree(x, y)) return null;
      const targetLevel = targetLevelOf(f);
      const topmost = topmostAdminStrokeLevel(all);
      if (topmost === null || topmost !== targetLevel) return null;
      // v1.2.1 rev6: NO geometry-based non-coincidence filter here. The rev5
      // ±2px gb2-box check was PROVEN wrong by measurement: it rejected
      // (1146,652), whose ROI the fixed Pillow gate had already passed at
      // 54 qualifying px / 7.6:1 (rev4) — the pass comes from ADM1/ADM2
      // deviation stretches elsewhere in the 160×160 ROI, not from the
      // center. ADM1 (regions) aggregates ADM2 (provinces) along nearly its
      // whole on-screen length, so center-coincidence is the NORM and
      // ROI-level gate quality is the discriminator. Discovery therefore
      // returns an ORDERED candidate list (see fixtureOwnedPoints) and the
      // unchanged fixed gate selects the first anchor that actually proves
      // the level; every tried candidate is recorded. Ownership stays strict.
      return { ...pick(f), x, y, topmostLevel: topmost };
    };

    // ---- ordered candidate collection (v1.2.1 rev6) -----------------------
    // Accepted anchors land in `accepted` in deterministic walk order,
    // suppressed to ~24px spacing so the ±6px jitter clones of one physical
    // stroke cannot flood the list with near-identical ROIs. Discovery makes
    // NO pixel decision — the caller's unchanged fixed gate does.
    const accepted: OwnedFeaturePoint[] = [];
    const consider = (hit: OwnedFeaturePoint | null) => {
      if (!hit || accepted.length >= limit) return;
      if (accepted.some((c) => Math.abs(c.x - hit.x) < 24 && Math.abs(c.y - hit.y) < 24)) return;
      accepted.push(hit);
    };
    // ---- strategy A: window probe around the projected anchor -------------
    // Strategy A is capped at half the limit so the geometry walk (strategy
    // B) always contributes its share of the ordered list: at the rev4 1080p
    // failing camera the ADM1/ADM2 deviation stretches that can pass the
    // gate lie far from the label anchor, reachable only via strategy B.
    const capA = Math.ceil(limit / 2);
    if (near) {
      const base = app.map.project(near);
      for (let dy = -windowPx; dy <= windowPx && accepted.length < capA; dy += 8) {
        for (let dx = -windowPx; dx <= windowPx && accepted.length < capA; dx += 8) {
          consider(tryPoint(base.x + dx, base.y + dy));
        }
      }
    }

    // ---- strategy B: geometry-first sampling of matching features ---------
    // v1.2.1 rev6: attempt/perFeature caps bound DISCOVERY breadth only —
    // they are not acceptance thresholds. rev5 measured the 400-cap running
    // out before the deterministic walk finished the visible boundary once
    // ownership rejections started spending budget; 4000/600 (kept in rev6)
    // lets the walk complete and feed the ordered candidate list that the
    // caller's unchanged fixed gate judges point by point.
    let feats: ReturnType<typeof app.map.queryRenderedFeatures> = [];
    try { feats = app.map.queryRenderedFeatures(undefined); } catch { feats = []; }
    const seen = new Set<string>();
    let attempts = 0;
    outer: for (const f of feats) {
      if (f.layer.type !== kind || !ok(f.properties) || attempts > 4000) continue;
      const g = f.geometry as { type?: string; coordinates?: unknown } | null;
      if (!g) continue;
      const coords = g.coordinates as unknown;
      const lines: number[][][] =
        g.type === 'LineString' ? [coords as number[][]] :
        g.type === 'MultiLineString' ? (coords as number[][][]) :
        g.type === 'Polygon' ? (coords as number[][][]) :
        g.type === 'MultiPolygon' ? ((coords as number[][][][]).flat()) :
        g.type === 'Point' ? [[coords as number[]]] :
        // MultiPoint coordinates are number[][]; each point walks as its own
        // single-vertex line.
        g.type === 'MultiPoint' ? (coords as number[][]).map((point) => [point]) :
        [];
      let perFeature = 0;
      for (const line of lines) {
        const pts: number[][] = line.length === 1 ? [line[0]!, line[0]!] : line;
        for (let i = 1; i < pts.length; i++) {
          // length === 1 widened to two identical stops; loop bounds keep
          // i-1/i inside the array and every walked position carries [x, y]
          // (geojson lint) — the non-null assertions below are sound.
          const a = pts[i - 1]!;
          const b = pts[i]!;
          const ax = a[0]!;
          const ay = a[1]!;
          const bx = b[0]!;
          const by = b[1]!;
          for (const t of [0, 0.5, 1]) {
            const pr = app.map.project([ax + (bx - ax) * t, ay + (by - ay) * t]);
            for (const jx of [0, 6, -6]) {
              for (const jy of [0, 6, -6]) {
                if (accepted.length >= limit || attempts > 4000 || perFeature > 600) break outer;
                const x = Math.round(pr.x + jx);
                const y = Math.round(pr.y + jy);
                // Spend the query budget only on candidates whose entire ROI
                // is visible and unobstructed, not offscreen polygon vertices.
                if (!patchFree(x, y)) continue;
                const key = `${Math.round(x / 4)}:${Math.round(y / 4)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                attempts++;
                perFeature++;
                consider(tryPoint(x, y));
              }
            }
          }
        }
      }
    }
    // Strict ownership: only genuinely top-level-owned strokes are evidence.
    // Returning an EMPTY list here is the CORRECT outcome at a camera whose
    // panel composition hides every owned stroke of the target level — the
    // caller's toBeTruthy fails and the camera must be fixed (designer-owned
    // change).
    return accepted;
  }, { match, kind, near, windowPx, limit });
}

/** Single-anchor convenience: first candidate of the ordered discovery. */
async function fixtureFeaturePoint(
  page: Page,
  match: Record<string, string>,
  kind: 'symbol' | 'line',
  near: [number, number] | null,
  windowPx = 64,
): Promise<OwnedFeaturePoint | null> {
  const pts = await fixtureOwnedPoints(page, match, kind, near, windowPx, 1);
  return pts[0] ?? null;
}

/** DEM decoded at a location (copied pattern from offline.spec.ts). */
async function waitTerrainReadyAt(page: Page, lngLat: [number, number], timeout = 150_000) {
  await page.waitForFunction(
    ({ lng, lat }) => {
      const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
      if (!app) return false;
      const el = app.map.queryTerrainElevation([lng, lat], { exaggerated: false });
      return typeof el === 'number' && el > 0;
    },
    { lng: lngLat[0], lat: lngLat[1] },
    { timeout, polling: 500 },
  );
}

/** Stable screenshot into Docs/screenshots/v1.2.1/<project>/<name>.png */
async function shot(page: Page, name: string) {
  // full stability + 1s MapLibre symbol-fade budget, so unrelated frame
  // animation cannot fake patch differences in on/off comparisons
  await page.waitForTimeout(1_800);
  await page.screenshot({ path: path.join(SHOT_DIR, test.info().project.name, name) });
}

const externalByPage = new WeakMap<Page, () => string[]>();
const errorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  externalByPage.set(page, blockExternal(page));
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // Interception is installed once per fresh page and survives real reloads.
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return route.continue();
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    return route.abort('blockedbyclient');
  });
});
test.afterEach(async ({ page }) => {
  expect(externalByPage.get(page)?.(), 'all scenarios must make zero external requests').toEqual([]);
  expect(errorsByPage.get(page), 'all scenarios must have zero JS/console/resource errors').toEqual([]);
});

// ---------------------------------------------------------------------------
// S8.1 — Morocco Overview: nationwide 2D, real admin/city labels, no fake DEM
// ---------------------------------------------------------------------------
test('01 Morocco Overview: 2D nationwide extent, admin lines + city labels, terrain off', async ({ page }) => {
  test.setTimeout(240_000);
  const external = blockExternal(page);
  const quiet = trackTileTraffic(page);
  await boot(page);
  await page.locator('#btn-extent-overview').click();
  await expect(page.locator('#btn-extent-overview')).toHaveClass(/active/, { timeout: 20_000 });
  await expect(page.locator('#overview-hint')).toHaveClass(/visible/, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview' && app.map.getPitch() < 0.5 && app.map.getTerrain() === null;
  }, undefined, { timeout: 30_000, polling: 250 });

  // honesty: persistent note that real terrain does NOT extend nationwide
  await expect(page.locator('#overview-hint')).toContainText(/High Atlas/);

  // fly finishes, vector tiles settle, then real nationwide content must show
  await quiet(4_000);
  // The fixed overview framing renders a viewport-dependent subset of city
  // labels: on small viewports the placement solver collision-culls some
  // (Marrakech yields its spot to the higher-rank "Maroc" country label at
  // 768p — diagnosed 2026-10-30, rendered set: Funchal/Safi/Es-Semara/
  // Laâyoune/Tan-Tan/Errachidia/Agadir/...). Never assert invisible labels:
  // require a genuine nationwide set here, then probe Marrakech itself at a
  // zoom where no country label competes (still overview, still 2D).
  const cities = await renderedNames(page, ['geo-place-labels-major', 'geo-place-labels-town']);
  const distinct = [...new Set(cities.map((c) => c.name).filter(Boolean))];
  expect(
    distinct.length,
    `expected a real nationwide city-label set, got: ${distinct.slice(0, 14).join(' | ')}`,
  ).toBeGreaterThanOrEqual(6);
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  expect(
    distinct.some((n) =>
      /^(marrakech|agadir|safi|errachidia|laayoune|casablanca|rabat|fes|ouarzazate)$/i.test(norm(n)),
    ),
    `at least one major Moroccan hub must render, got: ${distinct.slice(0, 14).join(' | ')}`,
  ).toBeTruthy();
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-7.989, 31.45], zoom: 6.3, pitch: 0, bearing: 0 }); // Marrakech
  });
  await quiet(3_500);
  const marrakech = await renderedNames(page, ['geo-place-labels-major']);
  expect(
    marrakech.some((c) => /marrakech/i.test(c.name)),
    `Marrakech must render from the real overview archive, got: ${marrakech.map((c) => c.name).join(' | ')}`,
  ).toBeTruthy();
  // restore the exact default overview framing (OVERVIEW_CENTER/OVERVIEW_ZOOM)
  // for the visual record
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-9.0, 28.9], zoom: 5.55, pitch: 0, bearing: 0 });
  });
  await quiet(3_000);

  // country (OSM ADM0) + real gbOpen ADM1 boundaries render
  const admin = await renderedNames(page, ['geo-admin-country', 'geo-admin-gb1-line']);
  expect(admin.length).toBeGreaterThan(0);

  // no fake nationwide elevation: terrain stays detached in overview
  expect(await terrainSource(page)).toBeNull();
  await shot(page, '01-morocco-overview.png');
  expect(external(), 'external requests must be zero').toHaveLength(0);
});

// ---------------------------------------------------------------------------
// S8.2 — Admin zoom ladder: ADM1 regions then ADM2 provinces in High Atlas
// ---------------------------------------------------------------------------
test('02 admin context: real ADM1/ADM2 gbOpen labels + boundaries, exact provenance, on/off contrast', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  const project = test.info().project.name;
  // per-run ROI freshness: drop THIS project's scenario-02 rows from any
  // previous invocation BEFORE anything can capture or write evidence
  resetProjectScenario02RoiKeys(project);
  await boot(page); // default boot = atlas (real DEM domain)

  // retired primary OSM admin layers must NOT exist in the runtime
  const retired = await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    return ['geo-admin-region', 'geo-admin-region-d', 'geo-admin-county', 'geo-admin-county-d'].filter(
      (id) => app.map.getLayer(id),
    );
  });
  expect(retired, 'retired OSM region/county layers must not exist').toEqual([]);

  // ---- fixture integrity: the contract's probe anchors must ship ----------
  const adm1 = adminProbe(ADMIN_PROBE_IDS.adm1, 'overview'); // Marrakech-Safi
  const adm2 = adminProbe(ADMIN_PROBE_IDS.adm2, 'atlas'); // Al Haouz Province
  // probe contract lives in public/data/metadata.json (NOT the label geojson)
  const probeMeta = ADMIN_METADATA.geo_context?.administrative_context?.fixture_probe?.labels;
  expect(
    Array.isArray(probeMeta),
    'public/data/metadata.json must carry geo_context.administrative_context.fixture_probe.labels',
  ).toBe(true);
  const metaEntries = probeMeta as Array<Record<string, unknown>>;
  const metaById = new Map(metaEntries.map((e) => [String(e.id ?? e.shapeID ?? ''), e]));
  for (const probe of [adm1, adm2]) {
    const entry = metaById.get(probe.shapeID);
    expect(entry, `fixture_probe.labels must list probe ${probe.shapeID} (${probe.label})`).toBeTruthy();
    expect(String(entry!.label), `fixture_probe label mismatch for ${probe.shapeID}`).toBe(probe.label);
  }

  const vp = page.viewportSize()!;

  // ---- overview: real ADM1 label at real z7 (2D, deterministic pixels) ----
  await page.locator('#btn-extent-overview').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview';
  }, undefined, { timeout: 30_000, polling: 250 });
  await page.evaluate(({ c }) => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: c, zoom: 7, pitch: 0, bearing: 0 });
  }, { c: adm1.lngLat });
  await quiet(3_500);
  // Probe against the same visible panels used by every evidence frame.
  await selectPanelTab(page, 'data');

  // the ADM1 symbol glyph itself, discovered at runtime by exact fixture
  // properties at the exact screen point (no guessed layer ids)
  const glyph1 = await fixtureFeaturePoint(
    page,
    { shapeID: adm1.shapeID, scope: 'overview', source: 'geoBoundaries gbOpen' },
    'symbol',
    adm1.lngLat,
  );
  expect(glyph1, `rendered ADM1 "${adm1.label}" glyph must be findable at its fixture anchor (z7 overview)`).toBeTruthy();
  expect(glyph1!.shapeID).toBe(adm1.shapeID);
  expect(glyph1!.level).toBe('ADM1');
  expect(glyph1!.admin_level).toBe('1');
  expect(glyph1!.label).toBe(adm1.label);
  expect(glyph1!.source).toBe('geoBoundaries gbOpen');
  expect(glyph1!.source_version).toBe('9469f09');
  expect(glyph1!.source_year).toBe('2017');
  // text comes from the fixture `label` field, never the original `name`
  const tf1 = await page.evaluate(
    (id) => JSON.stringify((window as unknown as { __gisApp?: GisApp }).__gisApp!.map.getLayoutProperty(id, 'text-field')),
    glyph1!.layer,
  );
  expect(tf1, 'ADM1 text-field must bind the fixture `label` field').toContain('"label"');
  expect(tf1, 'ADM1 text-field must not bind the original `name` field').not.toContain('"name"');

  // corresponding boundary: same shapeID on an actual line/casing layer at
  // the physical stroke — layer.type 'line' can never be the glyph symbol
  const bound1 = await fixtureFeaturePoint(
    page,
    { shapeID: adm1.shapeID, level: 'ADM1', source: 'geoBoundaries gbOpen' },
    'line',
    null,
  );
  expect(bound1, 'corresponding ADM1 boundary geometry must render at z7 overview').toBeTruthy();
  expect(bound1!.shapeID).toBe(adm1.shapeID);
  // v1.2.1 rev3 topmost-stroke ownership: an owned ADM1 anchor must sit under
  // NO other admin level; ADM1 is the top admin stroke at its evidence point.
  expect(
    bound1!.topmostLevel,
    `ADM1 boundary anchor must be topmost-ADM1 (owned) at the overview camera, got "${bound1!.topmostLevel}"`,
  ).toBe('ADM1');

  // admin on/off visual contrast: judged by the fixed Pillow pixel gate over
  // panel-free ROIs (raw clip buffer inequality is not evidence — one
  // checkbox pixel could satisfy it). SYMMETRIC ink isolation: the checkbox
  // on/off pair is kept ONLY as archival toggle-functionality evidence (its
  // frames hide labels+lines together, so neither ROI is gated on it); the
  // GLYPH gate compares against a LABELS-only OFF frame and the BOUNDARY
  // gate against a LINES-only OFF frame — no cross-class ink can fake a
  // pass in either direction.
  const glyphRoi1 = clipAround(glyph1!, 240, 72, vp.width, vp.height);
  const boundRoi1 = clipAround(bound1!, 160, 160, vp.width, vp.height);
  // ly-geo-* toggles live on the panel's DATA page (v1.2.1 TAB contract):
  // activate it by real click so the checkbox interactions below are
  // actionable and all four evidence frames show the same real UI state.
  await shot(page, '02a-overview-adm1-gbopen-on.png');
  const onInk1 = await symbolInkInRect(page, glyphRoi1);
  await page.locator('#ly-geo-adm1').setChecked(false);
  await shot(page, '02a-overview-adm1-gbopen-off.png'); // archival toggle capture
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM1.line, ...ADM_INK_LAYER_IDS.ADM1.symbol], 'none');
  await page.locator('#ly-geo-adm1').setChecked(true);
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM1.line, ...ADM_INK_LAYER_IDS.ADM1.symbol], 'visible');
  const hiddenLabels1 = await captureGlyphPaintOffFrame(page, 'ADM1', glyph1!.layer);
  await shot(page, '02a-overview-adm1-gbopen-labels-off.png');
  const offInk1 = await symbolInkInRect(page, glyphRoi1);
  await restoreGlyphPaint(page, hiddenLabels1);
  const hidden1 = await captureBoundaryOffFrame(page, 'ADM1', bound1!.layer);
  await shot(page, '02a-overview-adm1-gbopen-lines-off.png');
  await restoreLayerVisibility(page, hidden1);
  const shotDir = path.join(SHOT_DIR, project);
  const on1 = path.join(shotDir, '02a-overview-adm1-gbopen-on.png');
  const off1Labels = path.join(shotDir, '02a-overview-adm1-gbopen-labels-off.png');
  const off1Lines = path.join(shotDir, '02a-overview-adm1-gbopen-lines-off.png');
  const glyphGate1 = pillowGate(on1, off1Labels, glyphRoi1);
  const boundGate1 = pillowGate(on1, off1Lines, boundRoi1);
  // logger-first: persist all ROI metrics BEFORE the numeric gates so a
  // threshold failure still lands in Docs/v1_2_1_admin_visibility_rois.json
  recordRoi([
    {
      project, capture: '02a-overview-adm1', kind: 'glyph', level: 'ADM1', shapeID: adm1.shapeID,
      label: adm1.label, layer: glyph1!.layer, point: { x: glyph1!.x, y: glyph1!.y }, roi: glyphRoi1,
      pngOn: '02a-overview-adm1-gbopen-on.png', pngOff: '02a-overview-adm1-gbopen-labels-off.png',
      isolation: 'off frame hides only the ADM1 label layers; line ink identical in both frames',
      gate: { thresholds: VISIBILITY_GATE, ...glyphGate1 },
    },
    {
      project, capture: '02a-overview-adm1', kind: 'boundary', level: 'ADM1', shapeID: adm1.shapeID,
      label: adm1.label, layer: bound1!.layer, point: { x: bound1!.x, y: bound1!.y }, roi: boundRoi1,
      pngOn: '02a-overview-adm1-gbopen-on.png', pngOff: '02a-overview-adm1-gbopen-lines-off.png',
      isolation: 'off frame hides only the ADM1 line+casing layers; glyph ink identical in both frames',
      gate: { thresholds: VISIBILITY_GATE, ...boundGate1 },
    },
  ]);
  // glyph-pair validity (real symbol matching): label-only hiding can re-run
  // symbol placement, so the OFF frame must introduce no FOREIGN symbol ink
  // and only target-class (ADM1 label layer) ink may vanish — otherwise the
  // diff is contaminated. Hard fails; metrics are already on disk above.
  const foreign1 = [...offInk1].filter((k) => !onInk1.has(k));
  expect(foreign1, `label-only OFF frame introduced foreign symbol ink into the ADM1 glyph ROI (placement re-run): ${JSON.stringify(foreign1)}`).toEqual([]);
  const vanished1 = [...onInk1].filter((k) => !offInk1.has(k) && !ADM_INK_LAYER_IDS.ADM1.symbol.some((id) => k.startsWith(`${id}::`)));
  expect(vanished1, `non-target symbol ink vanished from the ADM1 glyph ROI in the label-only OFF frame: ${JSON.stringify(vanished1)}`).toEqual([]);
  // pixel numeric gates only: expect.soft so a threshold failure still marks
  // the case FAILED while 02b/main evidence collection continues; structural
  // (null/source/line-type) assertions above stay hard, thresholds untouched
  expect.soft(glyphGate1.qualifying, `ADM1 glyph ROI on/off gate failed (fixed thresholds ${JSON.stringify(VISIBILITY_GATE)}): ${JSON.stringify(glyphGate1)}`).toBeGreaterThanOrEqual(VISIBILITY_GATE.minQualifyingPixels);
  expect.soft(boundGate1.qualifying, `ADM1 boundary ROI on/off gate failed (fixed thresholds ${JSON.stringify(VISIBILITY_GATE)}): ${JSON.stringify(boundGate1)}`).toBeGreaterThanOrEqual(VISIBILITY_GATE.minQualifyingPixels);

  // ---- atlas MAIN frame: designer-approved v1.2.1 main camera (frozen) ----
  // extent atlas, center [-8.08, 31.30] z10.0 pitch0 bearing0 — designer
  // probe11 evidence (.data/v121-admin-ui-reflow-failure/probe11-report.json,
  // cam-gate-results.json): owned non-shared-edge ADM2 strokes exist in this
  // frame at both viewports (768p (544,185) ~19px / 1080p (825,282) ~59px
  // from the ADM1 boundary; ADM1 top-owned (1066,618)/(1282,744)), and the
  // 0.22°-apart Marrakech-Safi (ADM1) and Al Haouz Province (ADM2) anchors
  // BOTH render with complete 2-viewport labels (ROI canvas-free).
  // Physical terrain stays enabled — never disabled to make labels easier.
  // Extent/view controls are ORIGINAL controls on the MAP page (TAB contract).
  await selectPanelTab(page, 'map');
  await page.locator('#btn-extent-atlas').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'atlas';
  }, undefined, { timeout: 30_000, polling: 250 });
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-8.08, 31.3], zoom: 10.0, pitch: 0, bearing: 0 });
  });
  await waitTerrainReadyAt(page, [-8.08, 31.3]);
  await quiet(3_500);
  expect(await terrainSource(page)).toBe('dem'); // terrain must stay on
  await selectPanelTab(page, 'data');

  const glyph2 = await fixtureFeaturePoint(
    page,
    { shapeID: adm2.shapeID, scope: 'atlas', source: 'geoBoundaries gbOpen' },
    'symbol',
    adm2.lngLat,
    96, // wider window: symbols sit on the displaced terrain surface
  );
  expect(glyph2, `rendered ADM2 "${adm2.label}" glyph must be findable at its atlas anchor (z10, terrain on)`).toBeTruthy();
  expect(glyph2!.shapeID).toBe(adm2.shapeID);
  expect(glyph2!.level).toBe('ADM2');
  expect(glyph2!.admin_level).toBe('2');
  expect(glyph2!.label).toBe(adm2.label);
  expect(glyph2!.source).toBe('geoBoundaries gbOpen');
  expect(glyph2!.source_version).toBe('9469f09');
  expect(glyph2!.source_year).toBe('2017');
  const tf2 = await page.evaluate(
    (id) => JSON.stringify((window as unknown as { __gisApp?: GisApp }).__gisApp!.map.getLayoutProperty(id, 'text-field')),
    glyph2!.layer,
  );
  expect(tf2, 'ADM2 text-field must bind the fixture `label` field').toContain('"label"');
  expect(tf2, 'ADM2 text-field must not bind the original `name` field').not.toContain('"name"');
  const bound2 = await fixtureFeaturePoint(
    page,
    { shapeID: adm2.shapeID, level: 'ADM2', source: 'geoBoundaries gbOpen' },
    'line',
    adm2.lngLat,
    96,
  );
  expect(bound2, 'corresponding ADM2 boundary line must render at the main frame').toBeTruthy();
  expect(bound2!.shapeID).toBe(adm2.shapeID);
  // v1.2.1 rev3 topmost-stroke ownership (designer probe10/probe11), STRICT:
  // the ADM2 anchor must sit under NO other admin level — topmost admin
  // stroke must be ADM2 (owned). The gate rejects every guarded candidate
  // occluded by a different level while scanning. The v1.2.1 main camera
  // above IS the designer-frozen frame that exposes owned ADM2 strokes
  // (probe11: non-shared-edge, >=10px from the ADM1 boundary at both
  // viewports), so this gate passes there; if any future camera re-hides
  // every owned stroke, returning null fails here correctly — never a
  // shared-edge or pixel-picked fallback.
  expect(
    bound2!.topmostLevel,
    `ADM2 boundary anchor must be topmost-ADM2 (owned) at the main frame, got "${bound2!.topmostLevel}"`,
  ).toBe('ADM2');
  // bound2 may legitimately anchor to the ADM2 CASING layer (a distinct
  // symbol of the same boundary class; both are primary gbOpen features).
  // It stays recorded as-is in evidence — never normalized to the main line.

  // ADM1 (Marrakech-Safi) at its fixture anchor in the SAME frame
  const adm1Atlas = adminProbe(ADMIN_PROBE_IDS.adm1, 'atlas');
  const glyph1b = await fixtureFeaturePoint(
    page,
    { shapeID: adm1Atlas.shapeID, scope: 'atlas', source: 'geoBoundaries gbOpen' },
    'symbol',
    adm1Atlas.lngLat,
    96,
  );
  expect(glyph1b, `rendered ADM1 "${adm1Atlas.label}" glyph must also render at the main frame`).toBeTruthy();
  expect(glyph1b!.shapeID).toBe(adm1Atlas.shapeID);
  expect(glyph1b!.level).toBe('ADM1');
  expect(glyph1b!.label).toBe(adm1Atlas.label);
  expect(glyph1b!.source).toBe('geoBoundaries gbOpen');
  expect(glyph1b!.source_version).toBe('9469f09');
  expect(glyph1b!.source_year).toBe('2017');
  // v1.2.1 rev6: the main-frame ADM1 BOUNDARY anchor is discovered as an
  // ORDERED candidate list and judged by the unchanged fixed Pillow gate in
  // the pixel-analysis block below (see adm1Candidates) — a single pre-gate
  // anchor cannot exist when nearly the whole on-screen ADM1 stroke shares
  // its geometry with ADM2 and the OFF-frame residual differs per ROI.

  const glyphRoi2 = clipAround(glyph2!, 240, 72, vp.width, vp.height);
  const boundRoi2 = clipAround(bound2!, 160, 160, vp.width, vp.height);
  // back to the DATA page for the ly-geo-* toggles (the extent click above
  // required the map page); the ADM1 block below stays on this page
  await shot(page, '02b-atlas-adm2-gbopen-on.png');
  const onInk2 = await symbolInkInRect(page, glyphRoi2);
  await page.locator('#ly-geo-adm2').setChecked(false);
  await shot(page, '02b-atlas-adm2-gbopen-off.png'); // archival toggle capture
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM2.line, ...ADM_INK_LAYER_IDS.ADM2.symbol], 'none');
  await page.locator('#ly-geo-adm2').setChecked(true);
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM2.line, ...ADM_INK_LAYER_IDS.ADM2.symbol], 'visible');
  // glyph OFF frame hides ONLY the ADM2 label layers (see 02a note)
  const hiddenLabels2 = await captureGlyphPaintOffFrame(page, 'ADM2', glyph2!.layer);
  await shot(page, '02b-atlas-adm2-gbopen-labels-off.png');
  const offInk2 = await symbolInkInRect(page, glyphRoi2);
  await restoreGlyphPaint(page, hiddenLabels2);
  // boundary OFF frame hides ONLY the ADM2 line+casing (see 02a note)
  const hidden2 = await captureBoundaryOffFrame(page, 'ADM2', bound2!.layer);
  await shot(page, '02b-atlas-adm2-gbopen-lines-off.png');
  await restoreLayerVisibility(page, hidden2);
  const on2 = path.join(shotDir, '02b-atlas-adm2-gbopen-on.png');
  const off2Labels = path.join(shotDir, '02b-atlas-adm2-gbopen-labels-off.png');
  const off2Lines = path.join(shotDir, '02b-atlas-adm2-gbopen-lines-off.png');
  const glyphGate2 = pillowGate(on2, off2Labels, glyphRoi2);
  const boundGate2 = pillowGate(on2, off2Lines, boundRoi2);
  // logger-first: persist metrics BEFORE the numeric gates (see 02a note)
  recordRoi([
    {
      project, capture: '02b-atlas-adm2', kind: 'glyph', level: 'ADM2', shapeID: adm2.shapeID,
      label: adm2.label, layer: glyph2!.layer, point: { x: glyph2!.x, y: glyph2!.y }, roi: glyphRoi2,
      pngOn: '02b-atlas-adm2-gbopen-on.png', pngOff: '02b-atlas-adm2-gbopen-labels-off.png',
      isolation: 'off frame hides only the ADM2 label layers; line ink identical in both frames',
      gate: { thresholds: VISIBILITY_GATE, ...glyphGate2 },
    },
    {
      project, capture: '02b-atlas-adm2', kind: 'boundary', level: 'ADM2', shapeID: adm2.shapeID,
      label: adm2.label, layer: bound2!.layer, point: { x: bound2!.x, y: bound2!.y }, roi: boundRoi2,
      pngOn: '02b-atlas-adm2-gbopen-on.png', pngOff: '02b-atlas-adm2-gbopen-lines-off.png',
      isolation: 'off frame hides only the ADM2 line+casing layers; glyph ink identical in both frames',
      gate: { thresholds: VISIBILITY_GATE, ...boundGate2 },
    },
  ]);
  // glyph-pair validity (see 02a note)
  const foreign2 = [...offInk2].filter((k) => !onInk2.has(k));
  expect(foreign2, `label-only OFF frame introduced foreign symbol ink into the ADM2 glyph ROI (placement re-run): ${JSON.stringify(foreign2)}`).toEqual([]);
  const vanished2 = [...onInk2].filter((k) => !offInk2.has(k) && !ADM_INK_LAYER_IDS.ADM2.symbol.some((id) => k.startsWith(`${id}::`)));
  expect(vanished2, `non-target symbol ink vanished from the ADM2 glyph ROI in the label-only OFF frame: ${JSON.stringify(vanished2)}`).toEqual([]);
  // pixel numeric gates only: soft (see 02a note)
  expect.soft(glyphGate2.qualifying, `ADM2 glyph ROI on/off gate failed (fixed thresholds ${JSON.stringify(VISIBILITY_GATE)}): ${JSON.stringify(glyphGate2)}`).toBeGreaterThanOrEqual(VISIBILITY_GATE.minQualifyingPixels);
  expect.soft(boundGate2.qualifying, `ADM2 boundary ROI on/off gate failed (fixed thresholds ${JSON.stringify(VISIBILITY_GATE)}): ${JSON.stringify(boundGate2)}`).toBeGreaterThanOrEqual(VISIBILITY_GATE.minQualifyingPixels);

  // ---- SAME main frame: independent ADM1 on/off pixel analysis -----------
  // v1.2.1 rev2 completeness gap: overview ADM1 (02a) and atlas ADM2 (02b)
  // had pixel gates, but the main frame's ADM1 name + line were only ever
  // checked structurally. Same camera, same fixture source IDs/provenance,
  // same fixed thresholds, terrain never disabled — glyph pair via the ADM1
  // checkbox, boundary pair via the ADM1 lines-only OFF frame (see 02a).
  expect(await terrainSource(page)).toBe('dem');
  const glyphRoi1b = clipAround(glyph1b!, 240, 72, vp.width, vp.height);
  // still on the DATA page (inherited from the ADM2 block) — the ADM1
  // checkbox is actionable here without another TAB switch
  await shot(page, '02b-atlas-adm1-gbopen-on.png');
  const onInk1b = await symbolInkInRect(page, glyphRoi1b);
  await page.locator('#ly-geo-adm1').setChecked(false);
  await shot(page, '02b-atlas-adm1-gbopen-off.png'); // archival toggle capture
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM1.line, ...ADM_INK_LAYER_IDS.ADM1.symbol], 'none');
  await page.locator('#ly-geo-adm1').setChecked(true);
  await assertGroupToggle(page, [...ADM_INK_LAYER_IDS.ADM1.line, ...ADM_INK_LAYER_IDS.ADM1.symbol], 'visible');
  const hiddenLabels1b = await captureGlyphPaintOffFrame(page, 'ADM1', glyph1b!.layer);
  await shot(page, '02b-atlas-adm1-gbopen-labels-off.png');
  const offInk1b = await symbolInkInRect(page, glyphRoi1b);
  await restoreGlyphPaint(page, hiddenLabels1b);
  const on1b = path.join(shotDir, '02b-atlas-adm1-gbopen-on.png');
  const off1bLabels = path.join(shotDir, '02b-atlas-adm1-gbopen-labels-off.png');
  const glyphGate1b = pillowGate(on1b, off1bLabels, glyphRoi1b);
  // logger-first: persist glyph metrics BEFORE the numeric gate (see 02a);
  // boundary metrics are persisted per rev6 candidate below, also pre-gate.
  recordRoi([
    {
      project, capture: '02b-atlas-adm1', kind: 'glyph', level: 'ADM1', shapeID: adm1Atlas.shapeID,
      label: adm1Atlas.label, layer: glyph1b!.layer, point: { x: glyph1b!.x, y: glyph1b!.y }, roi: glyphRoi1b,
      pngOn: '02b-atlas-adm1-gbopen-on.png', pngOff: '02b-atlas-adm1-gbopen-labels-off.png',
      isolation: 'off frame hides only the ADM1 label layers; line ink identical in both frames',
      gate: { thresholds: VISIBILITY_GATE, ...glyphGate1b },
    },
  ]);
  // glyph-pair validity (see 02a note)
  const foreign1b = [...offInk1b].filter((k) => !onInk1b.has(k));
  expect(foreign1b, `label-only OFF frame introduced foreign symbol ink into the main-frame ADM1 glyph ROI (placement re-run): ${JSON.stringify(foreign1b)}`).toEqual([]);
  const vanished1b = [...onInk1b].filter((k) => !offInk1b.has(k) && !ADM_INK_LAYER_IDS.ADM1.symbol.some((id) => k.startsWith(`${id}::`)));
  expect(vanished1b, `non-target symbol ink vanished from the main-frame ADM1 glyph ROI in the label-only OFF frame: ${JSON.stringify(vanished1b)}`).toEqual([]);
  expect.soft(glyphGate1b.qualifying, `main-frame ADM1 glyph ROI on/off gate failed (fixed thresholds ${JSON.stringify(VISIBILITY_GATE)}): ${JSON.stringify(glyphGate1b)}`).toBeGreaterThanOrEqual(VISIBILITY_GATE.minQualifyingPixels);

  // ---- rev6 main-frame ADM1 BOUNDARY gate: ordered candidates ------------
  // rev4/rev5 evidence: at the z10 atlas camera nearly the whole on-screen
  // ADM1 stroke shares its geometry with ADM2 (a region boundary IS the
  // aggregate of its provinces), so the OFF-frame residual differs per ROI
  // and NO single pre-gate anchor can be trusted — the rev5 point-level
  // non-coincidence box even rejected the anchor whose ROI rev4 had already
  // PASSED (54 px / 7.6:1). Correction: discovery returns every owned,
  // unobstructed ADM1 stroke candidate in deterministic walk order
  // (fixtureOwnedPoints), and the UNCHANGED fixed Pillow gate picks the
  // first candidate that actually proves the level. Thresholds, ROI size
  // and budgets are untouched; no pixel-maximum search — each candidate is
  // judged once, pass/fail, and every tried candidate's metrics are
  // persisted BEFORE its verdict.
  //
  // limit 24 (rev6b): the rev6a run (archived under
  // `.data/v121-rev6a-limit12-failure/`) judged only 12 candidates at 1080p
  // — the walk was still ENTERING the rev4-diagnosed ADM1/ADM2 deviation
  // band (1461-1604, 674-796) when the list filled: c10/c11 measured
  // contrast 5.4→6.1, maxΔ 122→130, qualifying 10→14, still rising. The
  // deviation diag counts 40 owned on-stroke candidates on this camera, so
  // 24 lets the deterministic walk finish the visible deviation band while
  // keeping the worst-case capture loop (~24 × 2.5 s ≈ 60 s) inside the
  // 240 s test budget.
  const adm1Candidates = await fixtureOwnedPoints(
    page,
    { shapeID: adm1Atlas.shapeID, level: 'ADM1', source: 'geoBoundaries gbOpen' },
    'line',
    adm1Atlas.lngLat,
    96,
    24,
  );
  expect(
    adm1Candidates.length,
    `main frame must render owned, unobstructed ADM1 boundary candidates (owned = topmost-stroke ADM1), got ${adm1Candidates.length}`,
  ).toBeGreaterThan(0);
  const tried: Array<Record<string, unknown>> = adm1Candidates.map((c, i) => ({
    candidate: i, x: c.x, y: c.y, layer: c.layer, topmostLevel: c.topmostLevel,
  }));
  let winner: { cand: OwnedFeaturePoint; index: number; roi: RoiRow['roi']; gate: ReturnType<typeof pillowGate> } | null = null;
  for (let i = 0; i < adm1Candidates.length && !winner; i++) {
    const cand = adm1Candidates[i]!;
    const roiC = clipAround(cand, 160, 160, vp.width, vp.height);
    const hiddenC = await captureBoundaryOffFrame(page, 'ADM1', cand.layer);
    const offNameC = `02b-atlas-adm1-c${i}-gbopen-lines-off.png`;
    await shot(page, offNameC);
    await restoreLayerVisibility(page, hiddenC);
    const gateC = pillowGate(on1b, path.join(shotDir, offNameC), roiC);
    recordRoi([
      {
        project, capture: `02b-atlas-adm1-c${i}`, kind: 'boundary', level: 'ADM1', shapeID: adm1Atlas.shapeID,
        label: adm1Atlas.label, layer: cand.layer, point: { x: cand.x, y: cand.y }, roi: roiC,
        pngOn: '02b-atlas-adm1-gbopen-on.png', pngOff: offNameC,
        isolation: 'off frame hides only the ADM1 line+casing layers; glyph ink identical in both frames',
        gate: { thresholds: VISIBILITY_GATE, ...gateC },
      },
    ]);
    tried[i]!.qualifying = gateC.qualifying;
    tried[i]!.contrastMax = gateC.contrastMax;
    tried[i]!.maxDelta = gateC.maxDelta;
    if (gateC.qualifying >= VISIBILITY_GATE.minQualifyingPixels) {
      winner = { cand, index: i, roi: roiC, gate: gateC };
      // Canonical OFF filename stays stable for downstream readers
      // (Visual_Acceptance, reports): the winner's frame doubles as the
      // canonical evidence file.
      copyFileSync(path.join(shotDir, offNameC), path.join(shotDir, '02b-atlas-adm1-gbopen-lines-off.png'));
    }
  }
  expect(
    winner,
    `no main-frame ADM1 boundary candidate reached the UNCHANGED fixed gate (thresholds ${JSON.stringify(VISIBILITY_GATE)}); ${tried.length} owned candidates tried in walk order: ${JSON.stringify(tried)}`,
  ).toBeTruthy();
  const bound1b = winner!.cand;
  expect(bound1b.shapeID).toBe(adm1Atlas.shapeID);
  // v1.2.1 rev3 topmost-stroke ownership (designer probe10 confirmed live:
  // at the shared ADM1 edge the stack is gb1 Marrakech-Safi + Souss-Massa
  // ABOVE gb2 Al Haouz + Taroudant) — an ADM1 anchor must be topmost-ADM1.
  expect(
    bound1b.topmostLevel,
    `ADM1 boundary anchor must be topmost-ADM1 (owned) at the main frame, got "${bound1b.topmostLevel}"`,
  ).toBe('ADM1');
  // canonical boundary row: rev4 capture key preserved, pointing at the
  // winner candidate's evidence under the canonical OFF filename
  recordRoi([
    {
      project, capture: '02b-atlas-adm1', kind: 'boundary', level: 'ADM1', shapeID: adm1Atlas.shapeID,
      label: adm1Atlas.label, layer: bound1b.layer, point: { x: bound1b.x, y: bound1b.y }, roi: winner!.roi,
      pngOn: '02b-atlas-adm1-gbopen-on.png', pngOff: '02b-atlas-adm1-gbopen-lines-off.png',
      isolation: `off frame hides only the ADM1 line+casing layers; rev6 winner candidate c${winner!.index} of the ordered list`,
      gate: { thresholds: VISIBILITY_GATE, ...winner!.gate },
    },
  ]);
  expect(await terrainSource(page)).toBe('dem'); // evidence never disabled terrain

  // ---- main admin frame shot: BOTH names + corresponding lines proven ----
  await shot(page, '02-high-atlas-admin-boundaries.png');

  // ---- preserved regression: gbOpen boundary zoom behaviour ---------------
  // (retired primary OSM region/county layers are asserted absent in boot;
  // these counts are regression signals, never the acceptance criterion)
  // ADM1: zoom to the High Atlas / Marrakech-Safi area at z7
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-8.2, 31.3], zoom: 7, pitch: 0, bearing: 0 });
  });
  await quiet(3_500);
  const regions = await renderedNames(page, ['geo-admin-gb1-line']);
  expect(regions.length, 'ADM1 gbOpen boundary lines must render at z7').toBeGreaterThan(0);

  // ADM2: closer in at z11
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-8.2, 31.2], zoom: 11, pitch: 0, bearing: 0 });
  });
  await quiet(3_500);
  const counties = await renderedNames(page, ['geo-admin-gb2-line']);
  expect(counties.length, 'ADM2 gbOpen boundary lines must render at z11').toBeGreaterThan(0);
  // regression only — the acceptance main frame is shot at the proven 02b
  // atlas camera above, never on counts alone
});

// ---------------------------------------------------------------------------
// S8.3 — Town & Road: real towns/roads distinguishable from simulated RAN
// ---------------------------------------------------------------------------
test('03 real towns + roads render and are styled apart from SIMULATED layers', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    // Tahannaout on the RN7 (tile 13/3915/3343, probed offline: town label +
    // RN7/RP2010 roads). Constraints probed 2026-10-30: Marrakech (lat
    // 31.626) sits north of the atlas maxBounds clamp (coverage 31.65 -
    // 0.05), and the curated SIM geojson carries same-name "Asni"/"Imlil"
    // places, which dedup (§4.3) hides — so the real town label must be one
    // that is both centerable in the atlas domain and dedup-free.
    app.map.jumpTo({ center: [-7.94477, 31.36727], zoom: 13, pitch: 0, bearing: 0 }); // Tahannaout
  });
  await quiet(4_000);

  const towns = await renderedNames(page, ['geo-place-labels-major-d', 'geo-place-labels-town-d']);
  expect(towns.some((t) => /tahannaout/i.test(t.name)), `expected the Tahannaout town label, got: ${towns.map((t) => t.name).join(' | ')}`).toBeTruthy();
  const roads = await renderedNames(page, ['geo-roads-major-d']);
  expect(roads.length, 'real OSM roads must render in the detail domain').toBeGreaterThan(0);

  // style + provenance separation: real roads neutral #cfcbba; the curated
  // SIMULATED roads layer keeps its own look (never recolored to match)
  const geoColor = await paintProp(page, 'geo-roads-major-d', 'line-color');
  expect(String(geoColor)).toBe('#cfcbba');
  const curColor = await paintProp(page, 'osm-roads', 'line-color');
  expect(curColor, 'curated SIM roads must exist').not.toBeNull();
  expect(String(curColor)).not.toBe(String(geoColor));
  await shot(page, '03-high-atlas-real-roads-towns.png');
});

// ---------------------------------------------------------------------------
// S8.4 — Water & natural labels, no duplicated same-name peak labels
// ---------------------------------------------------------------------------
test('04 water features + peak labels render; no same-name duplicate peak labels', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);
  // Toubkal massif: rivers south of it, peaks on it
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-7.9149, 31.0566], zoom: 13.5, pitch: 0, bearing: 0 });
  });
  await quiet(4_000);

  const water = await renderedNames(page, ['geo-water-line-d', 'geo-water-fill-d', 'geo-water-line', 'geo-water-fill']);
  expect(water.length, 'rivers/lakes must render around the massif').toBeGreaterThan(0);

  const peaks = await renderedNames(page, ['geo-peak-labels-d', 'geo-peak-labels']);
  const names = peaks.map((p) => p.name.toLowerCase());
  expect(names.some((n) => n.includes('toubkal')), `expected a Toubkal peak label, got: ${names.join(' | ')}`).toBeTruthy();
  // dedup (task §4.3): no normalized name may appear on two labels
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const counts = new Map<string, number>();
  for (const n of names) counts.set(norm(n), (counts.get(norm(n)) ?? 0) + 1);
  const dupes = [...counts.entries()].filter(([, c]) => c > 1);
  expect(dupes, `duplicate same-name peak labels: ${JSON.stringify(dupes)}`).toEqual([]);
  await shot(page, '04-water-natural-labels.png');
});

// ---------------------------------------------------------------------------
// S8.5 — Layers Toggle: independent groups; GIS/RAN roundtrip keeps prefs
// ---------------------------------------------------------------------------
test('05 geo layer toggles act independently and survive a GIS/RAN roundtrip', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);
  await quiet(2_000);

  // v1.2.1 2-TAB contract (checked here; no extra test cases): boot lands on
  // the MAP page with the original controls, both tab triggers are
  // reachable, and the pages start in their default swap state. No TAB
  // switch anywhere in this suite may change a control preference.
  await expect(page.locator('#panel-tab-map')).toBeVisible();
  await expect(page.locator('#panel-tab-data')).toBeVisible();
  await expect(page.locator('#panel-page-map')).toBeVisible();
  await expect(page.locator('#panel-page-data')).toBeHidden();

  // every group starts visible per markup defaults (all groups checked,
  // including ADM2 county lines); the ly-geo-* toggles live on the DATA page
  const expectation: Record<string, 'visible' | 'none'> = {
    'ly-geo-admin': 'visible',
    'ly-geo-adm1': 'visible',
    'ly-geo-adm2': 'visible',
    'ly-geo-places': 'visible',
    'ly-geo-roads': 'visible',
    'ly-geo-water': 'visible',
    'ly-geo-natural': 'visible',
  };
  await selectPanelTab(page, 'data');
  for (const [cb, layer] of Object.entries(GROUP_REPRESENTATIVE)) {
    await page.locator(`#${cb}`).setChecked(expectation[cb] === 'visible');
    expect(await layerVisibility(page, layer)).toBe(expectation[cb]);
  }
  // toggle each one independently: exactly its own group flips
  await page.locator('#ly-geo-water').setChecked(false);
  expect(await layerVisibility(page, 'geo-water-fill')).toBe('none');
  expect(await layerVisibility(page, 'geo-roads-major')).toBe('visible');
  expect(await layerVisibility(page, 'geo-place-labels-major')).toBe('visible');
  await page.locator('#ly-geo-water').setChecked(true);

  // preference snapshot: the TAB switches and the roundtrip below must
  // leave every geo toggle and the active view-mode segment unchanged
  const prefsBefore = await controlPrefsSnapshot(page);

  // GIS -> RAN -> GIS roundtrip must not leak or permanently change prefs
  // (view-mode buttons are ORIGINAL controls on the MAP page)
  await selectPanelTab(page, 'map');
  expect(await controlPrefsSnapshot(page), 'switching to the map TAB alone must not change any preference').toEqual(prefsBefore);
  await page.locator('#btn-view-ran').click();
  await page.waitForTimeout(1500);
  await page.locator('#btn-view-gis').click();
  await page.waitForTimeout(1500);
  // verify + screenshot on the DATA page — the real tab for toggle evidence
  await selectPanelTab(page, 'data');
  const prefsAfter = await controlPrefsSnapshot(page);
  expect(prefsAfter, 'GIS/RAN roundtrip + TAB switches must not change any preference').toEqual(prefsBefore);
  for (const [cb, layer] of Object.entries(GROUP_REPRESENTATIVE)) {
    const checkboxOn = await page.locator(`#${cb}`).isChecked();
    expect(await layerVisibility(page, layer)).toBe(checkboxOn ? 'visible' : 'none');
    expect(checkboxOn).toBe(expectation[cb] === 'visible');
  }

  // v1.2.1 rev4 — curated-dedup reversibility (REAL user checkbox on the MAP
  // tab; geo prefs live on the DATA tab, reached by real tab clicks).
  // Unchecking the curated control must restore every dedup-target label
  // layer's EXACT source base filter (real same-named labels render again —
  // the old code left them permanently guarded); re-checking must restore a
  // BYTE-EQUIVALENT dedup filter; no geo preference may change.
  await selectPanelTab(page, 'map');
  const dedupTargetIds = Object.keys(DEDUP_BASE_FILTERS);
  const dedupOnJson: Record<string, string> = {};
  for (const id of dedupTargetIds) {
    dedupOnJson[id] = await layerFilterJson(page, id);
    expect(
      dedupOnJson[id],
      `${id} must carry the COMPOSED dedup guard at atlas boot (curated checked)`,
    ).not.toBe(JSON.stringify(DEDUP_BASE_FILTERS[id]));
  }
  await page.locator('#ly-osm').setChecked(false);
  // the checkbox still does its original job: legacy curated layers hide
  expect(await layerVisibility(page, 'osm-roads'), 'legacy curated roads must hide on uncheck').toBe('none');
  for (const id of dedupTargetIds) {
    expect(
      await layerFilterJson(page, id),
      `${id} filter after unchecking curated must equal its known SOURCE base filter`,
    ).toBe(JSON.stringify(DEDUP_BASE_FILTERS[id]));
  }
  await page.locator('#ly-osm').setChecked(true);
  expect(await layerVisibility(page, 'osm-roads'), 'legacy curated roads must re-show on re-check').toBe('visible');
  for (const id of dedupTargetIds) {
    expect(
      await layerFilterJson(page, id),
      `${id} filter after re-checking curated must be BYTE-EQUIVALENT to the pre-uncheck dedup filter`,
    ).toBe(dedupOnJson[id]);
  }
  expect(
    await controlPrefsSnapshot(page),
    'curated-dedup roundtrip must not change any geo preference',
  ).toEqual(prefsBefore);
  await selectPanelTab(page, 'data');

  await shot(page, '05-geo-layer-toggles.png');
});

// ---------------------------------------------------------------------------
// S8.6 — 3D Enter & Exit: honest denial in overview, real DEM only in atlas
// ---------------------------------------------------------------------------
test('06 3D denied in overview with jump-back; real DEM restores inside atlas', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);

  // to overview, then request 3D -> honest denial toast, terrain stays off
  await page.locator('#btn-extent-overview').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview';
  }, undefined, { timeout: 30_000, polling: 250 });
  // v1.2.1 rev4 bounded extent crosscheck: in the nationwide overview the
  // curated legacy layers are intentionally hidden even when checked — the
  // real-name dedup exclusion must NOT stay applied there.
  expect(
    await layerFilterJson(page, 'geo-place-labels-town'),
    'overview must lift the curated dedup exclusion (real nationwide names render)',
  ).toBe(JSON.stringify(DEDUP_BASE_FILTERS['geo-place-labels-town']));
  await page.locator('#btn-3d').click();
  const toast = page.locator('#terrain-denied-toast');
  await expect(toast).toHaveClass(/visible/, { timeout: 10_000 });
  await expect(toast).toContainText(/DEM|地形/);
  expect(await terrainSource(page)).toBeNull();

  // one click returns to the real-DEM domain; terrain must re-attach
  await toast.locator('#terrain-denied-atlas').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'atlas' && app.map.getTerrain()?.source === 'dem';
  }, undefined, { timeout: 60_000, polling: 500 });
  // and the atlas domain re-applies the dedup guard (composed again)
  expect(
    await layerFilterJson(page, 'geo-place-labels-town'),
    'atlas must re-apply the curated dedup guard after returning from overview',
  ).not.toBe(JSON.stringify(DEDUP_BASE_FILTERS['geo-place-labels-town']));

  // back out again: terrain detaches, no floating DEM rectangle
  await page.locator('#btn-extent-overview').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview' && app.map.getTerrain() === null && app.map.getPitch() < 0.5;
  }, undefined, { timeout: 30_000, polling: 250 });

  // and into real 3D High Atlas with natural labels for the visual record
  await page.locator('#btn-extent-atlas').click();
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-7.9149, 31.0566], zoom: 12.8, pitch: 50, bearing: 0 });
  });
  await waitTerrainReadyAt(page, [-7.9149, 31.0566]);
  await quiet(4_000);
  expect(await terrainSource(page)).toBe('dem');
  await shot(page, '06-real-3d-terrain-natural-labels.png');
});

// ---------------------------------------------------------------------------
// S8.7 — Admin Click: real provenance popup; disputed boundary disclosed
// ---------------------------------------------------------------------------
test('07 admin click popup cites geoBoundaries gbOpen provenance; disputed line stays honest OSM', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);

  // ADM1/ADM2 admin popup inside the DEM domain. z10 keeps region/county
  // lines plus the gbOpen fixture polygons on screen across viewports (at
  // z11 the 768p viewport's panel-free strip misses every line). Terrain
  // stays enabled; the clicked feature is discovered at runtime by its
  // exact fixture source identity — no guessed layer ids.
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-8.2, 31.2], zoom: 10, pitch: 0, bearing: 0 });
  });
  await quiet(3_500);
  const hit = await findClickPoint(page, [], { source: 'geoBoundaries gbOpen' });
  expect(hit, 'a geoBoundaries gbOpen admin polygon must be clickable in the High Atlas view').toBeTruthy();
  await page.mouse.click(hit!.x, hit!.y);
  const popup = page.locator('.maplibregl-popup');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText(/geoBoundaries/);
  await expect(popup).toContainText(/gbOpen/);
  await expect(popup).toContainText(/2017/);
  await expect(popup).toContainText(/9469f09/);
  // stable id: the popup must cite the exact clicked feature's shapeID
  expect(hit!.shapeID, 'clicked admin feature must carry a stable shapeID').toBeTruthy();
  await expect(popup).toContainText(hit!.shapeID!);
  // Independent provenance probe: reload rather than deleting a library-owned
  // popup DOM node and corrupting its reusable MapLibre instance.
  await boot(page);

  // disputed boundary (Western Sahara lines): popup must pass the flag through
  await page.locator('#btn-extent-overview').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview';
  }, undefined, { timeout: 30_000, polling: 250 });
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    app.map.jumpTo({ center: [-13.2, 27.15], zoom: 6, pitch: 0, bearing: 0 }); // Laâyoune
  });
  await quiet(3_500);
  const disputedRendered = await renderedNames(page, ['geo-admin-disputed']);
  expect(disputedRendered.length, 'disputed boundary lines must render (dashed) around Laâyoune').toBeGreaterThan(0);
  const dHit = await findClickPoint(page, ['geo-admin-disputed']);
  expect(dHit, 'a disputed boundary must be clickable outside the panels').toBeTruthy();
  await page.mouse.click(dHit!.x, dHit!.y);
  const dPopup = page.locator('.maplibregl-popup');
  await expect(dPopup).toBeVisible({ timeout: 10_000 });
  await expect(dPopup).toContainText(/disputed/i);
  await expect(dPopup).toContainText(/不作政治归属断言/);
});

// ---------------------------------------------------------------------------
// S8.8 — RAN Switch x10: banner + geo dimming/restore stay in sync
// ---------------------------------------------------------------------------
test('08 ten GIS/RAN switches: banner and geo dim/restore remain synchronized', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);
  await quiet(2_000);

  const banner = page.locator('#ran-banner');
  await expect(banner).toBeHidden();
  const localLabel = 'geo-place-labels-local';

  for (let i = 1; i <= 10; i++) {
    const toRan = i % 2 === 1;
    await page.locator(toRan ? '#btn-view-ran' : '#btn-view-gis').click();
    await page.waitForTimeout(1600); // dampening transition + banner sync
    if (toRan) {
      await expect(banner).toBeVisible();
      // secondary real geo info fades in RAN mode (GEO_RAN_DIM_TABLE ran value)
      expect(await paintProp(page, localLabel, 'text-opacity')).toBe(0);
    } else {
      await expect(banner).toBeHidden();
      expect(await paintProp(page, localLabel, 'text-opacity')).toBe(1);
    }
  }
  // final state: GIS fully restored
  await expect(banner).toBeHidden();
  expect(await layerVisibility(page, 'geo-roads-major')).toBe('visible');
});

// ---------------------------------------------------------------------------
// S8.9 — RAN Linkage + screenshots 07 (RAN view) and 08 (back to GIS)
// ---------------------------------------------------------------------------
test('09 RAN linkage: weak-coverage card selects site+road+profile; exit to GIS', async ({ page }) => {
  test.setTimeout(280_000);
  const quiet = trackTileTraffic(page);
  await boot(page);

  // enter RAN: simulated network data comes back with its honest banner
  await page.locator('#btn-view-ran').click();
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 10_000 });
  await quiet(3_000);
  await shot(page, '07-ran-coverage-real-geo-background.png');

  // one-click demo target: selects a site + a weak road (curated SIM data)
  const card = page.locator('#ran-weak-list > *').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.locator('#ran-selection')).not.toHaveText('', { timeout: 20_000 });

  // profile side panel engages on linkage (DEM-based; never RF prediction)
  await expect(page.locator('#profile-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#profile-status')).toContainText(/剖面|profile|→/i, { timeout: 30_000 });

  // the linked site/road/profile view is itself evidence: capture it while
  // RAN is still active, once the profile's DEM tiles have settled — before
  // the GIS exit clears the simulated layers (final full run refreshes the
  // profile proof directly instead of copying it from an older capture set)
  await quiet(3_000);
  await shot(page, '08-ran-site-road-profile.png');

  // exit back to GIS: banner clears, simulated RAN layers go away
  await page.locator('#btn-view-gis').click();
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await shot(page, '08-back-to-gis.png');
});

// ---------------------------------------------------------------------------
// S8.10 — Fonts & offline cold boot: zero external, PMTiles served via 206
// ---------------------------------------------------------------------------
test('10 cold boot: zero external requests, geo PMTiles fetched with 206 Range', async ({ page }) => {
  test.setTimeout(240_000);
  const external = blockExternal(page);
  const range206: string[] = [];
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (/\/data\/(morocco-overview|high-atlas-context)\.pmtiles/.test(u.pathname) && res.status() === 206) {
      range206.push(`${u.pathname} ${res.status()}`);
    }
  });
  await page.goto('/?cold=1', { waitUntil: 'load' }); // fresh profile is default; query busts any hash state
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.map.getLayer('geo-admin-country') && app.map.getLayer('geo-peak-labels');
  }, undefined, { timeout: 60_000, polling: 250 });

  // let both terrain + geo tiles stream, then audit transport honesty
  await page.waitForTimeout(6_000);
  expect(range206.length, `geo PMTiles must be served via HTTP Range 206; saw: ${range206.slice(0, 4).join(', ')}`).toBeGreaterThan(0);
  expect(external(), 'external requests must be zero').toHaveLength(0);

  // glyphs: bundled Noto Sans serves labels — some rendered text feature exists
  const labels = await renderedNames(page, ['geo-place-labels-major', 'geo-place-labels-town', 'geo-place-labels-local']);
  expect(labels.length, 'at least one real place label must render with bundled glyphs').toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// S8.11 — Data Accuracy Probe: rendered names/provenance match the archives
// ---------------------------------------------------------------------------
test('11 accuracy probe: Marrakech city + Toubkal west-summit provenance from OSM snapshot', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);
  await boot(page);

  // ---- Toubkal massif (atlas domain): real peak label + popup provenance --
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    // Toubkal massif camera (same as scenario 04; z13.5 loads z14 source
    // tiles where the west-summit pois feature, min_zoom 14, lives)
    app.map.jumpTo({ center: [-7.915, 31.0566], zoom: 13.5, pitch: 0, bearing: 0 });
  });
  await quiet(4_000);
  // real peak label: "Jbel Toubkal" yields to the curated same-name feature
  // by design (§4.3 dedup); the dedup-free real west summit must render
  const peaks = await renderedNames(page, ['geo-peak-labels-d', 'geo-peak-labels']);
  expect(peaks.some((p) => /toubkal/i.test(p.name)), `expected a real Toubkal peak label, got: ${peaks.map((p) => p.name).join(' | ')}`).toBeTruthy();
  const peakHit = await labelPointFor(page, [-7.924565, 31.055884], ['geo-peak-labels-d'], 'sommet ouest');
  expect(peakHit, 'the real Toubkal west-summit label must be clickable').toBeTruthy();
  await page.mouse.click(peakHit!.x, peakHit!.y);
  const peakPopup = page.locator('.maplibregl-popup');
  await expect(peakPopup).toBeVisible({ timeout: 10_000 });
  await expect(peakPopup).toContainText(/Toubkal Sommet ouest/i);
  await expect(peakPopup).toContainText(/OpenStreetMap contributors/);
  // OSM nominal elevation is disclosed as such, never mixed with DEM queries
  await expect(peakPopup).toContainText(/标注标高/);
  await expect(peakPopup).toContainText(/4018\s*m/);
  await expect(peakPopup).toContainText(/OSM 标称值/);
  // Reset the independent city probe through the real boot path; never remove
  // library-managed popup DOM directly.
  await boot(page);

  // ---- Marrakech city: probed on the nationwide overview archive ---------
  // (the atlas maxBounds clamp keeps every z13 camera south of the city
  // point, so the detail domain cannot show it; in overview the city point
  // — overview tile 6/30/25+26, probed offline — is genuinely visible.)
  await page.locator('#btn-extent-overview').click();
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.extent === 'overview';
  }, undefined, { timeout: 30_000, polling: 250 });
  await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    // z6.3: city labels have no competing country label here
    app.map.jumpTo({ center: [-7.989, 31.45], zoom: 6.3, pitch: 0, bearing: 0 });
  });
  await quiet(4_000);
  const cities = await renderedNames(page, ['geo-place-labels-major']);
  expect(cities.some((c) => /marrakech/i.test(c.name)), `Marrakech must render from real data, got: ${cities.map((c) => c.name).join(' | ')}`).toBeTruthy();

  // click the Marrakech label point -> popup provenance = OSM snapshot
  const hit = await labelPointFor(page, [-7.98916, 31.62582], ['geo-place-labels-major'], 'marrakech');
  expect(hit, 'the rendered Marrakech label must be clickable').toBeTruthy();
  await page.mouse.click(hit!.x, hit!.y);
  const popup = page.locator('.maplibregl-popup');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText(/Marrakech/);
  await expect(popup).toContainText(/OpenStreetMap contributors/);
  // popup cites the snapshot in the app's zh-CN wording (快照 <date>)
  await expect(popup).toContainText(/快照\s*2026-10-30|snapshot\s*2026-10-30/i);

  // layer separation: curated SIMULATED peak labels and real geo peak labels
  // coexist as distinct layers (no silent mixing of geometries)
  const separation = await page.evaluate(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp!;
    return {
      curatedPeaks: app.map.getLayer('osm-peak-labels') !== undefined,
      realPeaks: app.map.getLayer('geo-peak-labels-d') !== undefined || app.map.getLayer('geo-peak-labels') !== undefined,
    };
  });
  expect(separation.curatedPeaks, 'curated SIMULATED peaks layer must still exist').toBeTruthy();
  expect(separation.realPeaks, 'real geo peaks layer must exist').toBeTruthy();
});

// ---------------------------------------------------------------------------
// S8.12 — RAN Hash Backward Compatibility (&m=ran old links, &e=ov new)
// ---------------------------------------------------------------------------
test('12 hash compat: &m=ran restores mode; &m=ran&e=ov forces atlas; no suffix defaults GIS', async ({ page }) => {
  test.setTimeout(240_000);
  const quiet = trackTileTraffic(page);

  // old v1.1/v1.2 style link: view + ran mode, no extent suffix
  await boot(page, '#v=-7.9,31.3,11,50,0,1.2&m=ran');
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 15_000 });
  expect(await extent(page)).toBe('atlas');
  await quiet(2_000);

  // adversarial combination: ran mode wins over overview extent (line 106 map.ts)
  await boot(page, '#v=-9,28.9,5.55,0,0,1.2&m=ran&e=ov');
  await expect(page.locator('#ran-banner')).toBeVisible({ timeout: 15_000 });
  expect(await extent(page)).toBe('atlas');

  // new nationwide overview link (no mode suffix)
  await boot(page, '#v=-9,28.9,5.55,0,0,1.2&e=ov');
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 15_000 });
  expect(await extent(page)).toBe('overview');
  await page.waitForFunction(() => {
    const app = (window as unknown as { __gisApp?: GisApp }).__gisApp;
    return !!app && app.map.getTerrain() === null;
  }, undefined, { timeout: 30_000, polling: 250 });

  // plain boot: GIS view, atlas extent, no banner
  await boot(page);
  await expect(page.locator('#ran-banner')).toBeHidden({ timeout: 15_000 });
  expect(await extent(page)).toBe('atlas');
});
