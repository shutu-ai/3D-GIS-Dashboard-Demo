#!/usr/bin/env node
// measure_geo_context.mjs - v1.2.1 section 8 performance probe (raw runtime evidence).
//
// Measures the PACKAGED offline build (dist/) served at GIS_DEMO_URL
// (default http://127.0.0.1:17841 - start it with start-offline.ps1 first).
// ONE fresh headless Chromium (ANGLE D3D11) process+context PER VIEWPORT,
// sequential, mirroring e2e/playwright.config.ts launch semantics.
//
// Per viewport it records (raw numbers, no pass/fail verdicts):
//   - browser.version, navigator.userAgent, launch args
//   - boot duration until map registered (__gisApp + geo layers) and until
//     render stable (approxIdle + tile-network quiet)
//   - overview transition (#btn-extent-overview) and atlas transition
//     (#btn-extent-atlas): click -> camera/terrain state settle, then
//     render-stability wait
//   - 10 GIS/RAN roundtrips (#btn-view-ran / #btn-view-gis): per-leg
//     transition + label/render stability durations
//   - JSHeapUsedSize via CDP Performance metrics (V8 JS heap ONLY -
//     NOT total browser process RAM)
//   - every EXTERNAL http request ATTEMPT (blocked client-side via route
//     abort 'blockedbyclient'), all pageerror, all console type=error, and
//     all maplibre map 'error' events (incl. tile decoding errors)
//
// Transport honesty: Range GET bytes=0-127 on BOTH geo pmtiles must return
// status 206 with 128 bytes (server preflight, node-side).
//
// HONESTY / SCOPE (mirrored into the evidence JSON):
//   - physical_disconnect_verified is ALWAYS false: external requests are
//     intercepted in the browser (route abort), NOT physically disconnected.
//     This is NOT a disconnected cold boot claim.
//   - No screenshots, no human visual verification of any kind.
//   - Localhost-only: the probe refuses non-loopback GIS_DEMO_URL and never
//     fetches anything non-local itself.
//
// Usage:
//   node scripts/measure_geo_context.mjs
//   GIS_DEMO_URL=http://127.0.0.1:17842 node scripts/measure_geo_context.mjs
//   EVIDENCE_OUT=<path> node scripts/measure_geo_context.mjs
//
// Exit codes: 0 all viewports measured + preflight OK; 1 preflight or
// viewport error (evidence JSON is still written when possible).

import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ config
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DIST_ROOT = path.join(DEMO_ROOT, 'dist');
const DEFAULT_URL = 'http://127.0.0.1:17841';
const BASE_URL = (process.env.GIS_DEMO_URL ?? DEFAULT_URL).replace(/\/+$/, '');
const OUT_PATH = process.env.EVIDENCE_OUT
  ? path.resolve(process.env.EVIDENCE_OUT)
  : path.join(DEMO_ROOT, 'Docs', 'v1_2_1_runtime_evidence.json');

const GEO_PMTILES = ['morocco-overview.pmtiles', 'high-atlas-context.pmtiles'];
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
];
const LAUNCH_ARGS = ['--use-angle=d3d11', '--enable-unsafe-swiftshader'];

const BOOT_REGISTERED_TIMEOUT_MS = 120_000;
const BOOT_QUIET_MS = 3_000;
const STABILITY_CAP_MS = 60_000;
const TRANSITION_STATE_TIMEOUT_MS = 90_000;
const TRANSITION_QUIET_MS = 2_000;
const TRANSITION_QUIET_CAP_MS = 45_000;
const ROUNDTRIP_STATE_TIMEOUT_MS = 20_000;
const ROUNDTRIP_QUIET_MS = 1_200;
const ROUNDTRIP_QUIET_CAP_MS = 20_000;
const ROUNDS = 10; // task section 8: exactly 10 GIS/RAN roundtrips
const MAX_LOG_ENTRIES = 500;

// Same archive set the v1.2.1 e2e suite tracks for tile-network silence.
const TILE_RE = /\/data\/(hypso|dem-terrarium|contours|morocco-overview|high-atlas-context)\.pmtiles/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// ------------------------------------------------------------------ guards
function requireLocalBaseUrl() {
  let u;
  try {
    u = new URL(BASE_URL);
  } catch {
    throw new Error(`GIS_DEMO_URL is not a valid URL: "${BASE_URL}"`);
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) {
    throw new Error(
      `GIS_DEMO_URL must be a loopback http:// URL (localhost-only probe), got: "${BASE_URL}"`,
    );
  }
  return u.origin;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// ----------------------------------------------------- server preflight
/** Range GET bytes=0-127 against a geo pmtiles on the local server. */
async function rangeProbe(origin, file) {
  const url = `${origin}/data/${file}`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Range: 'bytes=0-127' } });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    file,
    url,
    status: res.status,
    bytesReceived: buf.length,
    expected: { status: 206, bytes: 128 },
    statusOk: res.status === 206,
    bytesOk: buf.length === 128,
    contentRange: res.headers.get('content-range'),
    acceptRanges: res.headers.get('accept-ranges'),
    ms: Math.round((performance.now() - t0) * 10) / 10,
  };
}

async function preflight(origin) {
  const indexRes = await fetch(`${origin}/index.html`);
  const index = {
    url: `${origin}/index.html`,
    status: indexRes.status,
    ok: indexRes.ok,
  };
  const ranges = [];
  for (const f of GEO_PMTILES) ranges.push(await rangeProbe(origin, f));
  const allOk =
    index.ok && ranges.every((r) => r.statusOk && r.bytesOk);
  return { index, rangeProbes: ranges, allOk };
}

/** Optional local file facts (sizes + sha256 of the dist archives). */
async function fileFacts() {
  const out = {};
  for (const f of GEO_PMTILES) {
    const p = path.join(DIST_ROOT, 'data', f);
    try {
      const st = await fsp.stat(p);
      const sha = await new Promise((res, rej) => {
        const h = createHash('sha256');
        const s = createReadStream(p);
        s.on('data', (d) => h.update(d));
        s.on('end', () => res(h.digest('hex')));
        s.on('error', rej);
      });
      out[f] = { path: p, bytes: st.size, sha256: sha };
    } catch (e) {
      out[f] = { path: p, error: `unavailable: ${e?.message ?? e}` };
    }
  }
  return out;
}

// ------------------------------------------------- in-page predicate fns
// Serialized by Playwright; must be fully self-contained.
const bootRegisteredPred = () => {
  const app = window.__gisApp;
  return !!(
    app &&
    app.map &&
    typeof app.map.getLayer === 'function' &&
    app.map.getLayer('geo-admin-country') &&
    app.map.getLayer('geo-water-fill')
  );
};

// maplibre 'idle' semantics approximated WITHOUT relying on catching the
// literal idle event: no incomplete tiles + camera not moving.
const approxIdlePred = () => {
  const app = window.__gisApp;
  if (!app || !app.map) return false;
  return !!app.map.loaded && !!app.map.loaded() && !app.map.isMoving();
};

// Verified production contract: MapApp.extent is a PLAIN public class field
// (src/map/map.ts:122, mutated at :163/:220 — no getter), so reading
// window.__gisApp.extent is exact.
const overviewSettledPred = () => {
  const app = window.__gisApp;
  if (!app || !app.map) return false;
  const terrain = typeof app.map.getTerrain === 'function' ? app.map.getTerrain() : null;
  return (
    app.extent === 'overview' &&
    app.map.getPitch() < 0.5 &&
    terrain === null &&
    !app.map.isMoving()
  );
};

const atlasSettledPred = () => {
  const app = window.__gisApp;
  if (!app || !app.map) return false;
  const terrain = typeof app.map.getTerrain === 'function' ? app.map.getTerrain() : null;
  return (
    app.extent === 'atlas' &&
    !!terrain &&
    terrain.source === 'dem' &&
    !app.map.isMoving()
  );
};

// Verified production contract (src/map/ran-overlay.ts:389): the banner is
// toggled via classList.toggle("hidden", !visible) — the ".visible" class
// belongs to toasts/#overview-hint, NOT to #ran-banner. Snapshots also
// record the raw classList so the evidence is self-documenting.
const ranActivePred = () => {
  const b = document.getElementById('ran-banner');
  const app = window.__gisApp;
  const op =
    app && app.map && app.map.getLayer && app.map.getLayer('geo-place-labels-local')
      ? app.map.getPaintProperty('geo-place-labels-local', 'text-opacity')
      : null;
  return !!b && !b.classList.contains('hidden') && op === 0;
};

const ranInactivePred = () => {
  const b = document.getElementById('ran-banner');
  const app = window.__gisApp;
  const op =
    app && app.map && app.map.getLayer && app.map.getLayer('geo-place-labels-local')
      ? app.map.getPaintProperty('geo-place-labels-local', 'text-opacity')
      : null;
  return !!b && b.classList.contains('hidden') && (op === 1 || op === null);
};

const extentSnapshot = () => {
  const app = window.__gisApp;
  if (!app || !app.map) return null;
  const terrain = typeof app.map.getTerrain === 'function' ? app.map.getTerrain() : null;
  const hint = document.getElementById('overview-hint');
  return {
    extent: app.extent ?? null,
    center: app.map.getCenter ? app.map.getCenter() : null,
    zoom: app.map.getZoom ? app.map.getZoom() : null,
    pitch: app.map.getPitch ? app.map.getPitch() : null,
    terrainSource: terrain && terrain.source ? terrain.source : null,
    overviewHintVisible: !!hint && hint.classList.contains('visible'),
  };
};

const ranSnapshot = () => {
  const b = document.getElementById('ran-banner');
  const app = window.__gisApp;
  const op =
    app && app.map && app.map.getLayer && app.map.getLayer('geo-place-labels-local')
      ? app.map.getPaintProperty('geo-place-labels-local', 'text-opacity')
      : null;
  return {
    bannerVisible: !!b && !b.classList.contains('hidden'),
    bannerClassRaw: b ? b.className : null,
    geoLabelTextOpacity: op,
  };
};

// ------------------------------------------------------ timing helpers
async function waitForState(page, pred, timeoutMs) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(pred, undefined, { timeout: timeoutMs, polling: 100 });
    return { ok: true, ms: Date.now() - t0 };
  } catch {
    return { ok: false, timedOut: true, ms: Date.now() - t0, timeoutMs };
  }
}

async function waitApproxIdle(page, capMs) {
  const r = await waitForState(page, approxIdlePred, capMs);
  return { approxIdle: r.ok, waitMs: r.ms };
}

async function renderStability(page, waitQuiet, quietMs, capMs) {
  const t0 = Date.now();
  // INFORMATIONAL ONLY, 5s cap: map.loaded() && !isMoving() was observed to
  // never settle on this app (maplibre 5.24; transitions settle fine via
  // isMoving-based predicates), so it must not gate the stability metric.
  const idle = await waitApproxIdle(page, 5_000);
  const quiet = await waitQuiet(quietMs, capMs);
  return {
    approxIdleObserved: idle.approxIdle,
    approxIdleWaitMs: idle.waitMs,
    quietSettled: quiet.settled,
    quietWaitedMs: quiet.waitedMs,
    quietInFlightAtCap: quiet.inFlightAtCap ?? null,
    totalMs: Date.now() - t0,
    definition: `tile-network quiet ${quietMs}ms (same archive set as e2e suite); approxIdle (map.loaded() && !isMoving()) recorded informationally with 5s cap, NOT gating`,
  };
}

/** node-side tile-network traffic tracker (same archive regex as the e2e suite). */
function attachTileTraffic(page) {
  let inFlight = 0;
  let lastActivity = Date.now();
  page.on('request', (r) => {
    if (TILE_RE.test(r.url())) {
      inFlight++;
      lastActivity = Date.now();
    }
  });
  page.on('requestfinished', (r) => {
    if (TILE_RE.test(r.url())) {
      inFlight--;
      lastActivity = Date.now();
    }
  });
  page.on('requestfailed', (r) => {
    if (TILE_RE.test(r.url())) {
      inFlight--;
      lastActivity = Date.now();
    }
  });
  return async function waitQuiet(quietMs, capMs) {
    const t0 = Date.now();
    for (;;) {
      if (inFlight === 0 && Date.now() - lastActivity >= quietMs) {
        return { settled: true, waitedMs: Date.now() - t0 };
      }
      if (Date.now() - t0 > capMs) {
        return { settled: false, waitedMs: Date.now() - t0, inFlightAtCap: inFlight };
      }
      await page.waitForTimeout(200);
    }
  };
}

async function cdpHeap(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const pick = (name) => metrics.find((m) => m.name === name)?.value ?? null;
    return {
      note: 'CDP Performance.getMetrics - JSHeapUsedSize is the V8 JavaScript heap in bytes; it is NOT total browser process RAM.',
      jsHeapUsedSizeBytes: pick('JSHeapUsedSize'),
      jsHeapTotalSizeBytes: pick('JSHeapTotalSize'),
      documents: pick('Documents'),
      nodes: pick('Nodes'),
      jsEventListeners: pick('JSEventListeners'),
      capturedAtIso: new Date().toISOString(),
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// ------------------------------------------------------- per-viewport run
async function measureViewport(viewport, origin, playwrightVersion) {
  const logs = {
    externalRequestAttemptsBlocked: [],
    externalAttemptsTruncated: false,
    consoleErrors: [],
    consoleErrorsTruncated: false,
    pageErrors: [],
    pageErrorsTruncated: false,
    mapErrors: [],
    mapErrorsTruncated: false,
  };

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({
    viewport: { ...viewport, deviceScaleFactor: 1 },
  });
  const page = await context.newPage();
  const browserVersion = browser.version();

  // External request ATTEMPTS are recorded then blocked client-side.
  // This is interception, NOT a physical network disconnect.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '(unparsable)';
    }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
      return route.continue();
    }
    if (logs.externalRequestAttemptsBlocked.length < MAX_LOG_ENTRIES) {
      logs.externalRequestAttemptsBlocked.push({
        url: url.slice(0, 500),
        method: route.request().method(),
        resourceType: route.request().resourceType(),
        blockedWith: 'blockedbyclient',
        atIso: new Date().toISOString(),
      });
    } else {
      logs.externalAttemptsTruncated = true;
    }
    return route.abort('blockedbyclient');
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (logs.consoleErrors.length >= MAX_LOG_ENTRIES) {
      logs.consoleErrorsTruncated = true;
      return;
    }
    logs.consoleErrors.push({
      text: msg.text().slice(0, 2000),
      location: msg.location()?.url?.slice(0, 300) ?? null,
      atIso: new Date().toISOString(),
    });
  });
  page.on('pageerror', (err) => {
    if (logs.pageErrors.length >= MAX_LOG_ENTRIES) {
      logs.pageErrorsTruncated = true;
      return;
    }
    logs.pageErrors.push({
      message: String(err?.message ?? err).slice(0, 2000),
      atIso: new Date().toISOString(),
    });
  });

  // Attach the maplibre map 'error' listener at the EARLIEST moment:
  // intercept the __gisApp assignment itself (main.ts sets it right after
  // MapApp.create resolves).
  await page.addInitScript(() => {
    const errs = [];
    let real;
    try {
      Object.defineProperty(window, '__gisApp', {
        configurable: true,
        get() {
          return real;
        },
        set(v) {
          real = v;
          try {
            if (v && v.map && typeof v.map.on === 'function') {
              v.map.on('error', (e) => {
                if (errs.length >= 500) return;
                errs.push({
                  message: String(
                    (e && e.error && e.error.message) || (e && e.message) || 'unknown',
                  ).slice(0, 500),
                  sourceId: e && e.sourceId !== undefined ? String(e.sourceId) : null,
                  tileCoord:
                    e && e.tileCoord ? `${e.tileCoord.z}/${e.tileCoord.x}/${e.tileCoord.y}` : null,
                  atIso: new Date().toISOString(),
                });
              });
            }
          } catch {}
          window.__gisMapErrors = errs;
        },
      });
    } catch {}
  });

  const waitQuiet = attachTileTraffic(page);

  // Drains only NEW map-error entries. The page-side queue only grows, so
  // without a cursor every drain would re-append the full history and
  // inflate mapErrorCount with duplicates.
  let mapErrorCursor = 0;
  const drainMapErrors = async () => {
    const errs = await page.evaluate(() => (window.__gisMapErrors ?? []).slice());
    for (const e of errs.slice(mapErrorCursor)) {
      const msg = String(e?.message ?? '');
      logs.mapErrors.push({
        ...e,
        isTileRelated: /tile|decod|pmtiles|range|glyph/i.test(msg),
      });
    }
    mapErrorCursor = errs.length;
    if (logs.mapErrors.length > MAX_LOG_ENTRIES) {
      logs.mapErrorsTruncated = true;
      logs.mapErrors.length = MAX_LOG_ENTRIES;
    }
  };

  const bootUrl = `${origin}/?cold=1`;
  const result = {
    viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
    playwright: playwrightVersion,
    browser: {
      version: browserVersion,
      headless: true,
      freshProcess: true,
      launchArgs: LAUNCH_ARGS,
      angleBackend: 'd3d11',
      userAgent: null,
    },
    boot: { url: bootUrl },
    overview_transition: {
      selector: '#btn-extent-overview',
      definition:
        'stateSettleMs = click -> extent==="overview" && pitch<0.5 && terrain===null && !isMoving(); renderStabilityMs = then tile-network quiet window (approxIdle informational only)',
    },
    atlas_transition: {
      selector: '#btn-extent-atlas',
      definition:
        'stateSettleMs = click -> extent==="atlas" && terrain.source==="dem" && !isMoving(); renderStabilityMs = then tile-network quiet window (approxIdle informational only)',
    },
    gis_ran_roundtrips: [],
    gis_ran_definition:
      'per leg: transitionMs = click -> banner class + geo-place-labels-local text-opacity state; stabilityMs = then tile-network quiet window; 10 full roundtrips, ends in GIS',
    js_heap_cdp: {
      postBoot: null,
      postRoundtrips: null,
      note: 'JSHeapUsedSize is V8 JS heap via CDP - NOT total browser RAM.',
    },
    requests: null,
    errors: null,
    error: null,
  };

  try {
    // ---- boot ----------------------------------------------------------
    const t0 = Date.now();
    await page.goto(bootUrl, { waitUntil: 'load', timeout: 60_000 });
    const gotoDoneMs = Date.now() - t0;
    const registered = await waitForState(page, bootRegisteredPred, BOOT_REGISTERED_TIMEOUT_MS);
    const registeredMs = Date.now() - t0;
    const stability = await renderStability(page, waitQuiet, BOOT_QUIET_MS, STABILITY_CAP_MS);
    result.boot = {
      url: bootUrl,
      gotoLoadMs: gotoDoneMs,
      registeredMs,
      registeredOk: registered.ok,
      registeredTimeoutMs: BOOT_REGISTERED_TIMEOUT_MS,
      registeredDefinition:
        'page load -> window.__gisApp present with geo-admin-country + geo-water-fill layers registered',
      renderStability: stability,
      startedAtIso: new Date(t0).toISOString(),
    };
    result.browser.userAgent = await page.evaluate(() => navigator.userAgent);
    result.geographic_label_style = await page.evaluate(async () => {
      const map = window.__gisApp.map;
      const metadata = await (await fetch('/data/metadata.json')).json();
      const contract = metadata.geo_context.administrative_label_font;
      const actual = map.getStyle().layers
        .filter((layer) => layer.type === 'symbol' && JSON.stringify(layer.layout?.['text-font']) === JSON.stringify([contract.fontstack]))
        .map((layer) => ({ id: layer.id, color: map.getPaintProperty(layer.id, 'text-color'),
          halo: map.getPaintProperty(layer.id, 'text-halo-color'), width: map.getPaintProperty(layer.id, 'text-halo-width') }));
      return { expected: contract.used_by_layers, actual,
        exactUsage: JSON.stringify(actual.map((layer) => layer.id).sort()) === JSON.stringify([...contract.used_by_layers].sort()),
        allWhite: actual.length > 0 && actual.every((layer) => layer.color === '#ffffff') };
    });
    if (!result.geographic_label_style.exactUsage || !result.geographic_label_style.allWhite) {
      throw new Error('Runtime geographic font usage/white-fill contract does not match the packaged metadata');
    }
    result.js_heap_cdp.postBoot = await cdpHeap(context, page);
    await drainMapErrors();

    // ---- overview transition -------------------------------------------
    // t0 BEFORE the click: measured window includes actionability+dispatch latency
    const ovT0 = Date.now();
    await page.locator('#btn-extent-overview').click();
    const ovState = await waitForState(page, overviewSettledPred, TRANSITION_STATE_TIMEOUT_MS);
    const ovStateMs = Date.now() - ovT0;
    const ovStability = await renderStability(
      page,
      waitQuiet,
      TRANSITION_QUIET_MS,
      TRANSITION_QUIET_CAP_MS,
    );
    result.overview_transition.clickedAtIso = new Date(ovT0).toISOString();
    result.overview_transition.stateSettleMs = ovStateMs;
    result.overview_transition.stateSettledOk = ovState.ok;
    result.overview_transition.renderStabilityMs = ovStability.totalMs;
    result.overview_transition.renderStability = ovStability;
    result.overview_transition.postState = await page.evaluate(extentSnapshot);
    await drainMapErrors();

    // ---- atlas transition -----------------------------------------------
    // t0 BEFORE the click: measured window includes actionability+dispatch latency
    const atT0 = Date.now();
    await page.locator('#btn-extent-atlas').click();
    const atState = await waitForState(page, atlasSettledPred, TRANSITION_STATE_TIMEOUT_MS);
    const atStateMs = Date.now() - atT0;
    const atStability = await renderStability(
      page,
      waitQuiet,
      TRANSITION_QUIET_MS,
      TRANSITION_QUIET_CAP_MS,
    );
    result.atlas_transition.clickedAtIso = new Date(atT0).toISOString();
    result.atlas_transition.stateSettleMs = atStateMs;
    result.atlas_transition.stateSettledOk = atState.ok;
    result.atlas_transition.renderStabilityMs = atStability.totalMs;
    result.atlas_transition.renderStability = atStability;
    result.atlas_transition.postState = await page.evaluate(extentSnapshot);
    await drainMapErrors();

    // ---- 10 GIS/RAN roundtrips ------------------------------------------
    for (let i = 1; i <= ROUNDS; i++) {
      const rt = { index: i, toRan: null, toGis: null };
      // t0 BEFORE each click: measured window includes actionability+dispatch latency
      const rtT0 = Date.now();

      const rT0 = Date.now();
      await page.locator('#btn-view-ran').click();
      const rState = await waitForState(page, ranActivePred, ROUNDTRIP_STATE_TIMEOUT_MS);
      const rStateMs = Date.now() - rT0;
      const rStability = await renderStability(
        page,
        waitQuiet,
        ROUNDTRIP_QUIET_MS,
        ROUNDTRIP_QUIET_CAP_MS,
      );
      rt.toRan = {
        selector: '#btn-view-ran',
        clickedAtIso: new Date(rT0).toISOString(),
        transitionMs: rStateMs,
        transitionOk: rState.ok,
        renderStabilityMs: rStability.totalMs,
        renderStability: rStability,
        postState: await page.evaluate(ranSnapshot),
      };

      const gT0 = Date.now();
      await page.locator('#btn-view-gis').click();
      const gState = await waitForState(page, ranInactivePred, ROUNDTRIP_STATE_TIMEOUT_MS);
      const gStateMs = Date.now() - gT0;
      const gStability = await renderStability(
        page,
        waitQuiet,
        ROUNDTRIP_QUIET_MS,
        ROUNDTRIP_QUIET_CAP_MS,
      );
      rt.toGis = {
        selector: '#btn-view-gis',
        clickedAtIso: new Date(gT0).toISOString(),
        transitionMs: gStateMs,
        transitionOk: gState.ok,
        renderStabilityMs: gStability.totalMs,
        renderStability: gStability,
        postState: await page.evaluate(ranSnapshot),
      };

      rt.roundtripTotalMs = Date.now() - rtT0;
      result.gis_ran_roundtrips.push(rt);
      await drainMapErrors();
    }

    result.js_heap_cdp.postRoundtrips = await cdpHeap(context, page);
    await drainMapErrors(); // catch stragglers emitted during the heap capture
  } catch (e) {
    result.error = String(e?.message ?? e).slice(0, 2000);
  } finally {
    result.requests = {
      localhostOnly: true,
      externalRequestAttemptCount: logs.externalRequestAttemptsBlocked.length,
      externalAttemptsZero: logs.externalRequestAttemptsBlocked.length === 0,
      externalRequestAttemptsBlocked: logs.externalRequestAttemptsBlocked,
      externalAttemptsTruncated: logs.externalAttemptsTruncated,
      tileTrafficTrackedRegex: TILE_RE.source,
      interception: "page.route abort('blockedbyclient') - client-side interception, NOT physical disconnect",
    };
    result.errors = {
      consoleErrorCount: logs.consoleErrors.length,
      consoleErrors: logs.consoleErrors,
      consoleErrorsTruncated: logs.consoleErrorsTruncated,
      pageErrorCount: logs.pageErrors.length,
      pageErrors: logs.pageErrors,
      pageErrorsTruncated: logs.pageErrorsTruncated,
      mapErrorCount: logs.mapErrors.length,
      tileRelatedMapErrorCount: logs.mapErrors.filter((m) => m.isTileRelated).length,
      mapErrors: logs.mapErrors,
      mapErrorsTruncated: logs.mapErrorsTruncated,
      mapErrorCaptureNote:
        "listener attached by intercepting the __gisApp assignment; earlier errors still surface as console errors",
    };
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

// ------------------------------------------------------------------ main
async function main() {
  const origin = requireLocalBaseUrl();
  const require = createRequire(import.meta.url);
  let playwrightVersion = null;
  try {
    playwrightVersion = require('@playwright/test/package.json').version ?? null;
  } catch {
    playwrightVersion = null;
  }

  const startedAtIso = new Date().toISOString();
  console.log(`[measure] target      : ${origin} (localhost-only)`);
  console.log(`[measure] viewports    : ${VIEWPORTS.map((v) => `${v.width}x${v.height}`).join(', ')}`);
  console.log(`[measure] evidence out : ${OUT_PATH}`);

  const pf = await preflight(origin);
  if (!pf.allOk) {
    const detail = pf.rangeProbes
      .map((r) => `${r.file}: status=${r.status} bytes=${r.bytesReceived}`)
      .join('; ');
    throw new Error(
      `Server preflight failed (index=${pf.index.status}; ${detail}). ` +
        `Start the packaged dist server first: powershell -ExecutionPolicy Bypass -File start-offline.ps1 ` +
        `from the dist package root, then pass the ACTUALLY bound port via GIS_DEMO_URL ` +
        `(the server falls forward when 17841 is reserved).`,
    );
  }
  console.log('[measure] preflight    : index 200; both geo pmtiles Range 0-127 -> 206 / 128B');

  const evidence = {
    schema: 'morocco-offline-gis/v1.2.1-runtime-evidence/1',
    generatedAtIso: startedAtIso,
    task: 'V1.2.1 Geographic Context Plan section 8 - measured runtime performance evidence (raw)',
    tool: {
      node: process.version,
      playwright: playwrightVersion,
      platform: `${process.platform} ${process.arch}`,
      gisDemoUrl: origin,
      gisDemoUrlSource: process.env.GIS_DEMO_URL ? 'env GIS_DEMO_URL' : 'default',
      evidenceOutPath: OUT_PATH,
      headless: true,
      freshChromiumPerViewport: true,
      sequentialViewports: true,
    },
    server_preflight: pf,
    data_files_optional: await fileFacts(),
    // ---- honesty / scope (fixed values, not measured) -------------------
    physical_disconnect_verified: false,
    visual_verification: 'none - no screenshots captured, no human visual review claimed',
    scope_notes: [
      'External http request attempts are blocked via Playwright route interception (client-side abort "blockedbyclient"); this is NOT a physically disconnected network and this run is NOT a disconnected cold boot.',
      'JSHeapUsedSize comes from CDP Performance metrics and measures the V8 JavaScript heap of the page only - it is NOT total browser process RAM.',
      'All browser runtime traffic is restricted to the localhost server; the probe itself only talks to that same loopback origin.',
      'Render stability is measured as a tile-network quiet window over the same archive set the e2e suite tracks; map.loaded() && !isMoving() was observed never to settle on this app (maplibre 5.24) and is recorded informationally (5s cap) only. Durations are wall-clock Date.now() deltas.',
      'This file records raw measurements only; interpretation/verdicts belong to the report author.',
    ],
    viewports: [],
  };

  let anyError = false;
  for (const vp of VIEWPORTS) {
    console.log(`[measure] launching fresh Chromium ${vp.width}x${vp.height} ...`);
    const res = await measureViewport(vp, origin, playwrightVersion);
    evidence.viewports.push(res);
    // incremental save: partial evidence survives an interrupted run
    await fsp.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fsp.writeFile(OUT_PATH, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`[measure] incremental evidence saved after ${vp.width}x${vp.height}`);
    if (res.error) {
      anyError = true;
      console.error(`[measure] ERROR ${vp.width}x${vp.height}: ${res.error}`);
    } else {
      console.log(
        `[measure] ${vp.width}x${vp.height} done: boot registered ${res.boot.registeredMs}ms, ` +
          `stability ${res.boot.renderStability.totalMs}ms, overview settle ${res.overview_transition.stateSettleMs}ms, ` +
          `atlas settle ${res.atlas_transition.stateSettleMs}ms, ` +
          `${res.gis_ran_roundtrips.length} roundtrips (median ${(median(res.gis_ran_roundtrips.map((r) => r.roundtripTotalMs)) ?? 0).toFixed(0)}ms), ` +
          `external attempts ${res.requests.externalRequestAttemptCount}, console errors ${res.errors.consoleErrorCount}, ` +
          `page errors ${res.errors.pageErrorCount}, map errors ${res.errors.mapErrorCount} (tile-related ${res.errors.tileRelatedMapErrorCount})`,
      );
    }
  }

  evidence.completedAtIso = new Date().toISOString();
  await fsp.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fsp.writeFile(OUT_PATH, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`[measure] evidence written: ${OUT_PATH}`);
  if (anyError) process.exit(1);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

main().catch((e) => {
  console.error('MEASURE FAILED:', e?.stack ?? e);
  process.exit(1);
});
