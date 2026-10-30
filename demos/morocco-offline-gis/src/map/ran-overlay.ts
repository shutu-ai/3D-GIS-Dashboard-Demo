/** Simulated RAN overlay: sector fans + boresight axes, site popups,
 *  RSRP road, banner, and the v1.2.0 selection/focus state.
 *
 *  Selection model: every feature in the 'ran' source carries a runtime
 *  `sel` property ("selected" | "dimmed" | undefined). Selecting a site or
 *  a road re-bakes the whole (small) FeatureCollection — the paint side is
 *  purely declarative expressions in map.ts buildStyle, so there is exactly
 *  one place that changes state and one place that renders it.
 */

import maplibregl, { type Map as MLMap } from "maplibre-gl";
import { LAYER_IDS } from "../config";

interface Sector {
  azimuth: number;
  width_deg: number;
  radius_m: number;
}

interface RanFeatureProps {
  id?: string;
  ele?: number;
  height_m?: number;
  bands?: string[];
  sectors?: Sector[];
  rsrp_dbm?: number;
  role?: string;
  site?: string;
  sel?: "selected" | "dimmed";
  [k: string]: unknown;
}

interface RanSourceData {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: string; coordinates: unknown };
    properties: RanFeatureProps;
  }>;
}

export type RanSelectionListener = (sel: {
  siteId: string | null;
  roadIdx: number | null;
}) => void;

const RAN_LAYERS = [
  LAYER_IDS.ranSectors,
  LAYER_IDS.ranSectorAxis,
  LAYER_IDS.ranRsrpCasing,
  LAYER_IDS.ranRsrp,
  LAYER_IDS.ranRsrpSel,
  LAYER_IDS.ranSites,
  LAYER_IDS.ranSitesSel,
  LAYER_IDS.ranSiteLabels,
  LAYER_IDS.ranSiteLabelsSel,
] as const;

function fanPolygon(lng: number, lat: number, s: Sector): [number, number][] {
  const steps = 24;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const pts: [number, number][] = [[lng, lat]];
  for (let i = 0; i <= steps; i++) {
    const az = ((s.azimuth - s.width_deg / 2 + (s.width_deg * i) / steps) * Math.PI) / 180;
    // azimuth 0 = north, clockwise
    const dKm = s.radius_m / 1000;
    pts.push([lng + (Math.sin(az) * dKm) / kmPerDegLon, lat + (Math.cos(az) * dKm) / kmPerDegLat]);
  }
  return pts;
}

/** Boresight (centre azimuth) line for a sector — geometric direction
 *  indicator, NOT a beam/propagation model. */
function sectorAxis(lng: number, lat: number, s: Sector): [[number, number], [number, number]] {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const az = (s.azimuth * Math.PI) / 180;
  const dKm = (s.radius_m * 0.85) / 1000;
  return [
    [lng, lat],
    [lng + (Math.sin(az) * dKm) / kmPerDegLon, lat + (Math.cos(az) * dKm) / kmPerDegLat],
  ];
}

export class RanOverlay {
  private map: MLMap;
  private visible = false;
  private banner: HTMLElement;
  private booted = false;

  /** Fetched source document (unchanged), cached for selection rebuilds. */
  private baseData: RanSourceData | null = null;
  /** Indices into baseData.features of road segments (rsrp lines). */
  private roadIdxs: number[] = [];
  private dataReady: Promise<void> | null = null;

  private selSite: string | null = null;
  private selRoad: number | null = null; // index into roadIdxs
  private selectListener: RanSelectionListener | null = null;
  private popup: maplibregl.Popup | null = null;

  constructor(map: MLMap) {
    this.map = map;
    this.banner = document.getElementById("ran-banner")!;

    // Race-free boot: NEITHER signal alone is reliable during app boot —
    // 'load' may already have fired before this registration (handler would
    // never run, the original bug: simulated layers rendered without their
    // banner), while isStyleLoaded() can stay false FOREVER on software-GL
    // machines (like areTilesLoaded(), some pipeline stage never goes idle),
    // which starved the retry loop and kept the layers visible (probe:
    // zero setLayoutProperty calls, getLayoutProperty(undefined)).
    // Gate on getLayer() alone: it turns true the moment the style's layers
    // are registered and is exactly the condition applyVisibility needs.
    this.map.on("load", () => this.bootOnce());
    const tryBoot = () => {
      if (this.booted) return;
      if (this.map.getLayer(LAYER_IDS.ranRsrp)) {
        this.bootOnce();
        return;
      }
      setTimeout(tryBoot, 100);
    };
    tryBoot();
  }

  private bootOnce() {
    if (this.booted) return;
    this.booted = true;
    this.applyVisibility(); // this.visible === false -> layers + banner hidden
    void this.ensureData().then(() => this.attachPopups());
  }

  // ------------------------------------------------------------ data rebuild

  /** Fetch once (idempotent under double-invocation from main.ts + bootOnce),
   *  then rebuild the source with selection state baked in. */
  private ensureData(): Promise<void> {
    if (!this.dataReady) {
      this.dataReady = (async () => {
        const res = await fetch("/data/simulated-ran.geojson");
        if (!res.ok) return;
        const data = (await res.json()) as RanSourceData;
        this.baseData = data;
        this.roadIdxs = [];
        data.features.forEach((f, i) => {
          if (f.geometry.type === "LineString" && typeof f.properties.rsrp_dbm === "number") {
            this.roadIdxs.push(i);
          }
        });
        this.pushSourceData();
      })();
    }
    return this.dataReady;
  }

  /** Compose the FeatureCollection: original features + sector fans +
   *  boresight axes, with `sel` stamped from current selection. */
  private pushSourceData() {
    const base = this.baseData;
    if (!base) return;
    const siteSel = (siteId: string | undefined): "selected" | "dimmed" | undefined => {
      if (!this.selSite) return undefined;
      if (siteId === this.selSite) return "selected";
      return "dimmed";
    };
    const features: RanSourceData["features"] = [];
    base.features.forEach((f, i) => {
      if (f.geometry.type === "Point" && f.properties.sectors) {
        const sel = siteSel(f.properties.id);
        features.push({ ...f, properties: { ...f.properties, sel } });
      } else if (f.geometry.type === "LineString" && typeof f.properties.rsrp_dbm === "number") {
        const sel =
          this.selRoad !== null && this.roadIdxs[this.selRoad] === i ? "selected" : undefined;
        // baked selection-space index: clicked (tiled/clipped) features must
        // map back to the road identity without coordinate matching
        features.push({ ...f, properties: { ...f.properties, sel, roadIdx: this.roadIdxs.indexOf(i) } });
      } else {
        features.push({ ...f, properties: { ...f.properties } });
      }
    });
    // sector fan polygons + boresight axes inherit their site's focus state
    base.features
      .filter((f) => f.geometry.type === "Point" && f.properties.sectors)
      .forEach((f) => {
        const c = (f.geometry as { coordinates: [number, number] }).coordinates;
        const raw = f.properties.sectors!;
        const list = Array.isArray(raw) ? raw : (JSON.parse(String(raw)) as Sector[]);
        const sel = siteSel(f.properties.id);
        for (const s of list) {
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [fanPolygon(c[0], c[1], s)] },
            properties: { site: f.properties.id ?? "?", sel },
          });
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: sectorAxis(c[0], c[1], s) },
            properties: { role: "sector-axis", site: f.properties.id ?? "?", sel },
          });
        }
      });
    const apply = () => {
      const src = this.map.getSource("ran") as maplibregl.GeoJSONSource | undefined;
      if (!src) return false;
      src.setData({
        type: "FeatureCollection",
        features,
      } as unknown as GeoJSON.FeatureCollection);
      return true;
    };
    if (!apply()) {
      // Called pre-style from main.ts: poll for the source instead of
      // once("load") — that event may already have fired by now, which would
      // leave the fans un-injected forever.
      let tries = 0;
      const retry = () => {
        if (apply() || ++tries > 300) return; // cap ~30 s
        setTimeout(retry, 100);
      };
      retry();
    }
  }

  // --------------------------------------------------------------- selection

  onSelect(listener: RanSelectionListener) {
    this.selectListener = listener;
  }

  /** Road feature lookup for callers (e2e + weak-coverage cards): the i-th
   *  road segment in the source document order. */
  /** Site properties lookup for the selection card (mirrors popup fields). */
  getSite(siteId: string): RanFeatureProps | null {
    if (!this.baseData) return null;
    const f = this.baseData.features.find(
      (x) => x.geometry.type === "Point" && x.properties.id === siteId,
    );
    return f?.properties ?? null;
  }

  /** Site coordinates (linkage A endpoint). */
  getSiteCoord(siteId: string): [number, number] | null {
    if (!this.baseData) return null;
    const f = this.baseData.features.find(
      (x) => x.geometry.type === "Point" && x.properties.id === siteId,
    );
    return f ? (f.geometry as { coordinates: [number, number] }).coordinates : null;
  }

  /** Demo-card entry (task §6.2): set both linkage ends, notify exactly once
   *  so the controller starts a single linkage run. */
  selectPair(siteId: string, roadIdx: number) {
    this.selSite = siteId;
    this.selRoad = roadIdx;
    this.pushSourceData();
    this.selectListener?.({ siteId, roadIdx });
  }

  getRoadFeature(i: number): { coordinates: [number, number][]; rsrp_dbm: number } | null {
    if (!this.baseData || i < 0 || i >= this.roadIdxs.length) return null;
    const f = this.baseData.features[this.roadIdxs[i]!]!;
    return {
      coordinates: f.geometry.coordinates as [number, number][],
      rsrp_dbm: f.properties.rsrp_dbm!,
    };
  }

  get roadCount(): number {
    return this.roadIdxs.length;
  }

  selectSite(siteId: string | null) {
    this.selSite = siteId;
    this.pushSourceData();
    this.selectListener?.({ siteId: this.selSite, roadIdx: this.selRoad });
  }

  selectRoad(idx: number | null) {
    this.selRoad = idx;
    this.pushSourceData();
    this.selectListener?.({ siteId: this.selSite, roadIdx: this.selRoad });
  }

  clearSelection() {
    this.selSite = null;
    this.selRoad = null;
    this.pushSourceData();
    this.selectListener?.({ siteId: null, roadIdx: null });
  }

  get selectedSite(): string | null {
    return this.selSite;
  }

  get selectedRoad(): number | null {
    return this.selRoad;
  }

  // ------------------------------------------------------------------ popups

  private attachPopups() {
    this.popup = new maplibregl.Popup({
      closeButton: false,
      maxWidth: "260px",
    });
    this.map.on("click", LAYER_IDS.ranSites, (e) => {
      const f = e.features?.[0];
      if (!f || !this.popup) return;
      const p = f.properties as {
        id: string;
        ele: number;
        height_m: number;
        bands: string[] | string;
        sectors: Sector[] | string;
      };
      const bandsRaw = Array.isArray(p.bands) ? p.bands : (() => {
        try { return JSON.parse(String(p.bands)) as string[]; } catch { return [String(p.bands)]; }
      })();
      const bands = bandsRaw.join(", ");
      const sectors = typeof p.sectors === "string" ? JSON.parse(p.sectors) : p.sectors;
      const sectorRows = (sectors as Sector[])
        .map(
          (s) =>
            `<tr><td>${Math.round(s.azimuth)}°</td><td>${Math.round(s.width_deg)}°</td><td>${(s.radius_m / 1000).toFixed(1)} km</td></tr>`,
        )
        .join("");
      const c = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      this.popup
        .setLngLat(c)
        .setHTML(
          `<div style="font-weight:700;margin-bottom:4px">${p.id} <span style="color:#f0c96a;font-size:10px">SIMULATED</span></div>
           <table style="font-size:11px;line-height:1.5">
           <tr><td style="color:#8fa1b5">经纬度</td><td>${c[1].toFixed(5)}, ${c[0].toFixed(5)}</td></tr>
           <tr><td style="color:#8fa1b5">站址海拔 (DEM)</td><td>${p.ele} m</td></tr>
           <tr><td style="color:#8fa1b5">天线挂高 (模拟)</td><td>${p.height_m} m</td></tr>
           <tr><td style="color:#8fa1b5">频段</td><td>${bands}</td></tr>
           </table>
           <div style="margin-top:4px;font-size:10px;color:#8fa1b5">扇区方位/角宽/演示半径 (SIMULATED GEOMETRY)</div>
           <table style="font-size:11px">${sectorRows}</table>`,
        )
        .addTo(this.map);
      // selecting via the map and via the card/list must land in one state
      this.selectSite(p.id);
    });
    this.map.on("mouseenter", LAYER_IDS.ranSites, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", LAYER_IDS.ranSites, () => {
      this.map.getCanvas().style.cursor = "";
    });
    // road segment click -> selection (same single source of truth as the
    // site click; the selection card renders from the same data). The
    // roadIdx property is baked at data build — tiled/clipped click features
    // cannot be matched by coordinates.
    this.map.on("click", LAYER_IDS.ranRsrp, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const idx = (f.properties as { roadIdx?: number }).roadIdx;
      if (typeof idx !== "number" || idx < 0) return;
      this.selectRoad(this.selRoad === idx ? null : idx); // click again to deselect
    });
    this.map.on("mouseenter", LAYER_IDS.ranRsrp, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", LAYER_IDS.ranRsrp, () => {
      this.map.getCanvas().style.cursor = "";
    });
  }


  // --------------------------------------------------------------- visibility

  setVisible(on: boolean) {
    this.visible = on;
    // leaving RAN must not leave a floating site card behind (mode-exit
    // residue would contradict the SIMULATED-banner sync contract)
    if (!on) this.popup?.remove();
    this.applyVisibility();
  }

  private applyVisibility() {
    for (const id of RAN_LAYERS) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, "visibility", this.visible ? "visible" : "none");
      }
    }
    this.banner.classList.toggle("hidden", !this.visible);
  }
}
