/** Map instance, style construction, view-state hash, fly-to, reset. */

import maplibregl, { type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { FONT_STACK, LAYER_IDS, type AppMetadata } from "../config";

// register the pmtiles:// protocol exactly once
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

/** Single shared archive handle (range-request reader) for elevation queries. */
export const demArchive = new PMTiles("/data/dem-terrarium.pmtiles");

/** Default 3D pitch (was 60; v1.1.0 calmer terrain framing). */
export const DEFAULT_PITCH = 50;

/**
 * Shrink a bbox by a margin (degrees) on every side so free-flight camera
 * centres stay over real terrain tiles instead of the archive edge.
 */
function shrinkBounds(b: [number, number, number, number], marginDeg = 0.05): [[number, number], [number, number]] {
  return [
    [b[0] + marginDeg, b[1] + marginDeg],
    [b[2] - marginDeg, b[3] - marginDeg],
  ];
}

export interface ViewState {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
  ex: number;
}

export class MapApp {
  map: MLMap;
  meta: AppMetadata;
  private terrainRestoreTimer: number | null = null;
  private terrainRestore: ReturnType<MLMap["getTerrain"]> = null;

  private constructor(map: MLMap, meta: AppMetadata) {
    this.map = map;
    this.meta = meta;
  }

  static async create(meta: AppMetadata): Promise<MapApp> {
    const style = buildStyle(meta);
    const initial = readHash() ?? fitBoundsView(meta);
    const map = new maplibregl.Map({
      container: "map",
      style,
      center: [initial.lng, initial.lat],
      zoom: initial.zoom,
      pitch: initial.pitch,
      bearing: initial.bearing,
      maxPitch: 70,
      hash: false,
      attributionControl: false,
      // keep free flight inside the real DEM coverage so the camera never
      // hovers past the "floating rectangle" data edge (C1)
      maxBounds: shrinkBounds(meta.coverage, 0.05),
      // Deterministic rendering: MapLibre's symbol crossfade (default 300 ms)
      // composites previous placement quads while a placement re-commits;
      // zeroing it drops old quads immediately (symbolFadeChange() == 1),
      // which removes fade mid-state flakiness from screenshot capture and
      // shortens render-settle time. NOT a fix for the acceptance label
      // double-draw — that root cause was corrupted SDF glyph data (see
      // Docs/V1_1_0_Visual_RCA.md §5); the fade experiment was proven
      // ineffective against it.
      fadeDuration: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    const app = new MapApp(map, meta);
    map.on("moveend", () => app.writeHash());
    app.wireBoundaryHint(initial);
    return app;
  }

  getViewState(): ViewState {
    const c = this.map.getCenter();
    return {
      lng: +c.lng.toFixed(5),
      lat: +c.lat.toFixed(5),
      zoom: +this.map.getZoom().toFixed(2),
      pitch: Math.round(this.map.getPitch()),
      bearing: Math.round(this.map.getBearing()),
      ex: currentExaggeration,
    };
  }

  writeHash() {
    const v = this.getViewState();
    const h = `#v=${v.lng},${v.lat},${v.zoom},${v.pitch},${v.bearing},${v.ex}`;
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  flyToScene(name: string) {
    const s = this.meta.scenes.find((x) => x.name === name);
    if (!s) return;
    // A direct local jump avoids decoding every intermediate viewport along
    // the route. Reset the terrain tile pyramid around the new camera before
    // rebuilding it; keeping the old high-pitch pyramid alive while jumping
    // between distant scenes can stall WebGL in offline/headless browsers.
    const terrain = this.map.getTerrain() ?? this.terrainRestore;
    if (terrain) {
      if (this.map.getTerrain()) this.map.setTerrain(null);
      this.terrainRestore = terrain;
      if (this.terrainRestoreTimer !== null) {
        window.clearTimeout(this.terrainRestoreTimer);
        this.terrainRestoreTimer = null;
      }
    }
    this.map.jumpTo({
      center: [s.lng, s.lat],
      zoom: s.zoom,
      pitch: s.pitch,
      bearing: s.bearing,
    });
    if (terrain) {
      // Let a burst of scene clicks settle on one camera before rebuilding
      // the DEM pyramid. This prevents repeated terrain teardown/reload work
      // from starving the WebGL event loop on the offline bundle.
      this.terrainRestoreTimer = window.setTimeout(() => {
        const restore = this.terrainRestore;
        this.terrainRestore = null;
        this.terrainRestoreTimer = null;
        if (restore && !this.map.getTerrain() && this.map.getPitch() >= 1) {
          this.map.setTerrain(restore);
        }
      }, 600);
    } else {
      // scenes are 3D; re-enable terrain if the user is in 2D
      window.dispatchEvent(new CustomEvent("gis:request-3d"));
    }
  }

  resetView() {
    const v = fitBoundsView(this.meta);
    this.map.flyTo({
      center: [v.lng, v.lat],
      zoom: v.zoom,
      pitch: DEFAULT_PITCH,
      bearing: 0,
      duration: 2400,
      essential: true,
    });
  }

  // ------------------------------------------------- data-boundary hint (C2)
  private boundaryTimer: number | null = null;
  private boundaryShown = false;
  private boundarySticky = false;

  /**
   * On moveend (debounced), warn when the camera centre sits outside the DEM
   * coverage bbox or below the first terrain zoom — the point where rendered
   * terrain/labels run out. Non-blocking toast, bottom-centre, with a Reset
   * shortcut. Only shown when the condition actually holds.
   *
   * `bootView` is the raw hash-derived initial view: maxBounds clamps the
   * actual camera, so a far-outside share link must be detected before the
   * clamp erases the evidence.
   */
  private wireBoundaryHint(bootView: ViewState | null) {
    const check = () => {
      if (this.boundarySticky) return; // boot-latched hint stays until Reset
      const c = this.map.getCenter();
      const [minLon, minLat, maxLon, maxLat] = this.meta.coverage;
      const outside =
        c.lng < minLon || c.lng > maxLon || c.lat < minLat || c.lat > maxLat;
      const tooZoomedOut = this.map.getZoom() < this.meta.dem.zooms[0];
      if (outside || tooZoomedOut) this.showBoundaryHint();
      else this.hideBoundaryHint();
    };
    this.map.on("moveend", () => {
      if (this.boundaryTimer !== null) window.clearTimeout(this.boundaryTimer);
      this.boundaryTimer = window.setTimeout(check, 250);
    });
    if (bootView) {
      const [minLon, minLat, maxLon, maxLat] = this.meta.coverage;
      const bootOutside =
        bootView.lng < minLon ||
        bootView.lng > maxLon ||
        bootView.lat < minLat ||
        bootView.lat > maxLat ||
        bootView.zoom < this.meta.dem.zooms[0];
      if (bootOutside) {
        // latch: maxBounds already clamped the camera, and the initial load's
        // own moveend would otherwise clear the toast before it is read
        this.boundarySticky = true;
        this.showBoundaryHint();
        return;
      }
    }
    check();
  }

  private showBoundaryHint() {
    let toast = document.getElementById("boundary-hint");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "boundary-hint";
      toast.className = "boundary-hint";
      toast.innerHTML =
        `<span>Outside offline terrain coverage — data ends here</span>` +
        `<button id="boundary-reset" type="button">Reset</button>`;
      toast.querySelector("#boundary-reset")?.addEventListener("click", () => {
        this.boundarySticky = false;
        this.hideBoundaryHint();
        this.resetView();
      });
      document.getElementById("app")!.appendChild(toast);
    }
    toast.classList.add("visible");
    this.boundaryShown = true;
  }

  private hideBoundaryHint() {
    if (!this.boundaryShown) return;
    document.getElementById("boundary-hint")?.classList.remove("visible");
    this.boundaryShown = false;
  }
}

/** Current visual exaggeration (kept here so the hash can include it). */
let currentExaggeration = 1.2;
export function setExaggerationCached(v: number) {
  currentExaggeration = v;
}

function fitBoundsView(meta: AppMetadata): ViewState {
  const [minLon, minLat, maxLon, maxLat] = meta.bbox;
  const lng = (minLon + maxLon) / 2;
  const lat = (minLat + maxLat) / 2;
  // zoom so the bbox fits in ~70% of a 1600px viewport
  const spanLon = (maxLon - minLon) * Math.cos((lat * Math.PI) / 180);
  const spanLat = maxLat - minLat;
  const zoom = Math.min(11.2, Math.log2(360 / Math.max(spanLon, spanLat * 1.6)) - 0.4);
  return { lng, lat, zoom: Math.max(zoom, 8.5), pitch: DEFAULT_PITCH, bearing: 0, ex: 1.2 };
}

function readHash(): ViewState | null {
  const m = /#v=(-?[\d.]+),(-?[\d.]+),([\d.]+),(\d+),(-?\d+),([\d.]+)/.exec(location.hash);
  if (!m) return null;
  return {
    lng: +m[1]!,
    lat: +m[2]!,
    zoom: +m[3]!,
    pitch: +m[4]!,
    bearing: +m[5]!,
    ex: +m[6]!,
  };
}

export function buildStyle(meta: AppMetadata): StyleSpecification {
  // The PMTiles MapLibre protocol receives a concrete z/x/y URL. Keep the
  // archive path local, but include the tile template required by Protocol.
  const demUrl = "pmtiles:///data/dem-terrarium.pmtiles/{z}/{x}/{y}";
  const hypsoUrl = "pmtiles:///data/hypso.pmtiles/{z}/{x}/{y}";
  const contourUrl = "pmtiles:///data/contours.pmtiles/{z}/{x}/{y}";
  return {
    version: 8,
    glyphs: `/assets/glyphs/{fontstack}/{range}.pbf`,
    sources: {
      dem: {
        type: "raster-dem",
        tiles: [demUrl],
        encoding: "terrarium",
        tileSize: meta.dem.tile_size,
        minzoom: meta.dem.zooms[0],
        maxzoom: meta.dem.zooms[1],
      },
      // MapLibre keeps an independent tile manager for terrain and hillshade;
      // sharing one raster-dem source makes one manager cancel the other's
      // decode during terrain reloads.
      demHillshade: {
        type: "raster-dem",
        tiles: [demUrl],
        encoding: "terrarium",
        tileSize: meta.dem.tile_size,
        minzoom: meta.dem.zooms[0],
        maxzoom: meta.dem.zooms[1],
      },
      hypso: {
        type: "raster",
        tiles: [hypsoUrl],
        tileSize: meta.dem.tile_size,
        minzoom: meta.dem.zooms[0],
        maxzoom: meta.dem.zooms[1],
      },
      contours: {
        type: "vector",
        tiles: [contourUrl],
        minzoom: meta.contours ? 6 : 6,
        maxzoom: 12,
      },
      osm: {
        type: "geojson",
        data: "/data/roads-peaks.geojson",
      },
      ran: {
        type: "geojson",
        data: "/data/simulated-ran.geojson",
      },
      profile: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        // dark slate tuned to the hypsometric ramp's lowest band so the
        // terrain edge never reads as a hard rectangle against the void
        paint: { "background-color": "#1c2822" },
      },
      {
        id: LAYER_IDS.hypso,
        type: "raster",
        source: "hypso",
        // opacity 1.0: 0.9 let background bleed through and produced washed
        // seams between adjacent raster tiles. Fade 0: no LOD crossfade —
        // zero-fade removes tile LOD transition mid-states from capture
        // (deterministic compositing). 
        paint: { "raster-opacity": 1.0, "raster-fade-duration": 0 },
      },
      {
        id: LAYER_IDS.hillshade,
        type: "hillshade",
        source: "demHillshade",
        paint: {
          // NW illumination (315°) is standard cartographic practice; the
          // softened palette keeps relief readable without the "plastic
          // wrinkled paper" look of near-black shadows on white highlights.
          "hillshade-illumination-direction": 315,
          "hillshade-illumination-anchor": "map",
          "hillshade-exaggeration": 0.35,
          "hillshade-shadow-color": "#1a2430",
          "hillshade-highlight-color": "#f5f2e8",
          "hillshade-accent-color": "#3e4a42",
        },
      },
      // --- contours (minor under major) ---
      {
        id: LAYER_IDS.contoursLine,
        type: "line",
        source: "contours",
        "source-layer": "contour",
        filter: ["!", ["get", "major"]],
        paint: {
          "line-color": "rgba(235, 215, 170, 0.5)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.7, 13, 1.1],
        },
      },
      {
        id: LAYER_IDS.contoursMajor,
        type: "line",
        source: "contours",
        "source-layer": "contour",
        filter: ["==", ["get", "major"], true],
        paint: {
          "line-color": "rgba(240, 220, 175, 0.85)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 13, 2.0],
        },
      },
      {
        id: LAYER_IDS.contoursLabel,
        type: "symbol",
        source: "contours",
        "source-layer": "contour",
        filter: ["==", ["get", "major"], true],
        minzoom: 9,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 300,
          "text-padding": 4,
          "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9.5, 13, 12],
        },
        paint: {
          "text-color": "#f2e3bd",
          "text-halo-color": "rgba(14, 20, 28, 0.8)",
          "text-halo-width": 1.4,
        },
      },
      // minor contour labels only appear zoomed in (z>=11.5) so the label
      // density ladder reads: fewer numbers zoomed out, more when in
      {
        id: LAYER_IDS.contoursLabelMinor,
        type: "symbol",
        source: "contours",
        "source-layer": "contour",
        filter: ["!", ["get", "major"]],
        minzoom: 11.5,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 280,
          "text-padding": 4,
          "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 9.5, 13, 11],
        },
        paint: {
          "text-color": "rgba(233, 214, 172, 0.85)",
          "text-halo-color": "rgba(14, 20, 28, 0.8)",
          "text-halo-width": 1.4,
        },
      },
      // --- roads / peaks / places ---
      {
        id: LAYER_IDS.roadsCasing,
        type: "line",
        source: "osm",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#1a1410", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.4, 13, 5] },
      },
      {
        id: LAYER_IDS.roads,
        type: "line",
        source: "osm",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#d8986a",
          "line-dasharray": [3, 1.5],
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 13, 2.6],
        },
      },
      {
        id: LAYER_IDS.peaks,
        type: "circle",
        source: "osm",
        filter: ["==", ["get", "kind"], "peak"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.4, 13, 6],
          "circle-color": "#f4e9c8",
          "circle-stroke-color": "#5a4a28",
          "circle-stroke-width": 1.2,
        },
      },
      // Peak labels split by rank: named summits (rank<=3) resolve from z9,
      // the rest from z10.5. Collision is left to the default global symbol
      // placement (no text-allow-overlap anywhere) with sort-key priority
      // peaks > passes > places > contours.
      {
        id: LAYER_IDS.peakLabelsTop,
        type: "symbol",
        source: "osm",
        filter: ["all", ["==", ["get", "kind"], "peak"], ["<=", ["coalesce", ["get", "rank"], 9], 3]],
        minzoom: 9,
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10.5, 13, 12.5],
          "symbol-sort-key": ["coalesce", ["get", "rank"], 9],
          "text-padding": 8,
          "text-max-width": 7,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#f7f0da",
          "text-halo-color": "rgba(18, 26, 36, 0.72)",
          "text-halo-width": 1.2,
        },
      },
      {
        id: LAYER_IDS.peakLabels,
        type: "symbol",
        source: "osm",
        filter: ["all", ["==", ["get", "kind"], "peak"], [">", ["coalesce", ["get", "rank"], 9], 3]],
        minzoom: 10.5,
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10.5, 10, 13, 11.5],
          "symbol-sort-key": ["coalesce", ["get", "rank"], 9],
          "text-padding": 8,
          "text-max-width": 7,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#f7f0da",
          "text-halo-color": "rgba(18, 26, 36, 0.72)",
          "text-halo-width": 1.2,
        },
      },
      {
        id: LAYER_IDS.places,
        type: "circle",
        source: "osm",
        filter: ["==", ["get", "kind"], "place"],
        paint: { "circle-radius": 3, "circle-color": "#9ec3e8", "circle-stroke-width": 1, "circle-stroke-color": "#243448" },
      },
      {
        id: LAYER_IDS.placeLabels,
        type: "symbol",
        source: "osm",
        filter: ["==", ["get", "kind"], "place"],
        minzoom: 10,
        layout: {
          "text-field": ["get", "name"],
          "text-font": [FONT_STACK],
          "text-size": 10,
          // places rank below peaks/passes in the collision hierarchy
          "symbol-sort-key": ["+", ["coalesce", ["get", "rank"], 9], 1],
          "text-padding": 6,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#d5e2ef",
          "text-halo-color": "rgba(18, 26, 36, 0.72)",
          "text-halo-width": 1.2,
        },
      },
      // passes share peak styling but amber
      {
        id: "osm-passes",
        type: "circle",
        source: "osm",
        filter: ["==", ["get", "kind"], "pass"],
        paint: { "circle-radius": 3.6, "circle-color": "#e8c376", "circle-stroke-width": 1, "circle-stroke-color": "#4a3a18" },
      },
      {
        id: "osm-pass-labels",
        type: "symbol",
        source: "osm",
        filter: ["==", ["get", "kind"], "pass"],
        minzoom: 9.5,
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9.5, 9.5, 13, 11],
          // half-step after peaks of the same rank, before places
          "symbol-sort-key": ["+", ["coalesce", ["get", "rank"], 9], 0.5],
          "text-padding": 6,
          "text-max-width": 7,
          "text-offset": [0, 1.0],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#f0d489",
          "text-halo-color": "rgba(18, 26, 36, 0.72)",
          "text-halo-width": 1.2,
        },
      },
      // --- profile highlight (below RAN so analysis stays visible) ---
      {
        id: LAYER_IDS.profileLine,
        type: "line",
        source: "profile",
        filter: ["==", ["get", "role"], "line"],
        paint: { "line-color": "#62e3c8", "line-width": 3, "line-dasharray": [2, 1] },
      },
      {
        id: LAYER_IDS.profilePoints,
        type: "circle",
        source: "profile",
        filter: ["==", ["get", "role"], "point"],
        paint: { "circle-radius": 6, "circle-color": "#62e3c8", "circle-stroke-width": 2, "circle-stroke-color": "#0c3a32" },
      },
      // --- simulated RAN overlay (top) ---
      // NOTE: these layers are visible-in-style ON PURPOSE. MapLibre v5 never
      // processes a GeoJSON source whose referencing layers all start with
      // layout visibility:"none", and the source never recovers — not via
      // setLayoutProperty("visible") nor setData() (verified by probe). The
      // simulated network must still never render without its SIMULATED
      // banner, so RanOverlay hides these layers at the earliest safe moment
      // (race-free constructor boot) instead of relying on style defaults.
      {
        id: LAYER_IDS.ranSectors,
        type: "fill",
        source: "ran",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#5aa0e0", "fill-opacity": 0.12, "fill-outline-color": "rgba(120,180,240,0.45)" },
      },
      {
        id: LAYER_IDS.ranRsrp,
        type: "line",
        source: "ran",
        filter: ["has", "rsrp_dbm"],
        paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3, 13, 7],
          "line-color": [
            "interpolate",
            ["linear"],
            ["get", "rsrp_dbm"],
            -140, "#c0392b",
            -120, "#e07840",
            -105, "#d8c34a",
            -90, "#7dbb5a",
            -75, "#3f9e6f",
            -60, "#2e8b8b",
          ],
        },
      },
      {
        id: LAYER_IDS.ranSites,
        type: "circle",
        source: "ran",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 13, 8],
          "circle-color": "#6ab0f3",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#12324f",
        },
      },
      {
        id: LAYER_IDS.ranSiteLabels,
        type: "symbol",
        source: "ran",
        minzoom: 11,
        layout: {
          "text-field": ["get", "id"],
          "text-font": [FONT_STACK],
          "text-size": 9.5,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#a8d0f5",
          "text-halo-color": "rgba(10, 16, 24, 0.9)",
          "text-halo-width": 1.2,
        },
      },
    ],
  } as StyleSpecification;
}
