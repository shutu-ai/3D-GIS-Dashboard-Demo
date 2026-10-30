/** Entry point: metadata -> map -> controls. No external resource is fetched. */

// MapLibre's own stylesheet — NEVER shipped until v1.2.0 found it missing
// (G1 RCA addendum): .maplibregl-popup stayed position:static, so site
// popups flowed BELOW the canvas and never appeared, and the nav/scale
// controls rendered unstyled.
import "maplibre-gl/dist/maplibre-gl.css";
import { loadMetadata } from "./config";
import { MapApp } from "./map/map";
import { TerrainControl } from "./map/terrain";
import { ContourControl } from "./map/contours";
import { RanOverlay } from "./map/ran-overlay";
import { ViewModeControl, readHashMode } from "./map/view-mode";
import { Controls } from "./ui/controls";

async function boot() {
  const meta = await loadMetadata();
  const app = await MapApp.create(meta);
  // debug/E2E handle: lets tests project known in-coverage points to screen
  (window as unknown as { __gisApp: MapApp }).__gisApp = app;

  // truth-in-labeling: the header badge always mirrors metadata.terrain
  const badge = document.getElementById("terrain-badge");
  if (badge) {
    if (meta.terrain?.mode === "real") {
      badge.textContent = "REAL TERRAIN · OFFLINE";
      badge.classList.remove("badge-sim");
      badge.classList.add("badge-real");
    } else {
      badge.textContent = "SIMULATED TERRAIN"; // markup default; never claim real
    }
  }

  const terrainCtl = new TerrainControl(app.map, 1.2);
  const ran = new RanOverlay(app.map);

  // contour interval indicator is wired through a late-bound callback
  let showInterval: (m: number | null) => void = () => {};
  const contourCtl = new ContourControl(app.map, meta, (m) => showInterval(m));
  let controls: Controls;
  // mode state machine: one owner for RAN layers, banner, base dampening
  const viewModeCtl = new ViewModeControl(app.map, ran, (mode) => controls.syncMode(mode));
  controls = new Controls(app.map, app, meta, terrainCtl, contourCtl, ran, viewModeCtl);
  showInterval = (m) => controls.setContourInterval(m);
  contourCtl.setVisible(true);
  // honour a shared `#v=…&m=ran` link; 'gis' (or absent/unknown) is a no-op sync
  viewModeCtl.setMode(readHashMode());

  // attribution / data provenance footer
  document.getElementById("attribution")!.innerHTML =
    `OFFLINE GIS DEMO · ${meta.dem.source} · nominal ${meta.dem.nominal_resolution_m} · ` +
    `${meta.dem.vertical_datum} · contours: ${meta.contours.source} · font: ${meta.glyphs.fontstack} (${meta.glyphs.license}) · ` +
    `SIMULATED NETWORK DATA when RAN layer is on · seed ${meta.seed}`;

  console.info(
    "[offline-gis] ready - all resources local. DEM:",
    meta.dem.file,
    "coverage:",
    meta.coverage.join(", "),
  );
}

boot().catch((err) => {
  console.error("[offline-gis] boot failed:", err);
  const el = document.createElement("div");
  el.style.cssText =
    "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#e37662;font:14px sans-serif;max-width:480px;text-align:center;z-index:99";
  el.textContent = `启动失败：${err.message}（请确认通过本地服务器访问，且 public/data 已生成）`;
  document.body.appendChild(el);
});
