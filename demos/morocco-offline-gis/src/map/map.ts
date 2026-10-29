/** Map instance, style construction, view-state hash, fly-to, reset. */

import maplibregl, { type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { FONT_STACK, LAYER_IDS, type AppMetadata } from "../config";

// register the pmtiles:// protocol exactly once
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

/** Single shared archive handle (range-request reader) for elevation queries. */
export const demArchive = new PMTiles("/data/dem-terrarium.pmtiles");

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
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    const app = new MapApp(map, meta);
    map.on("moveend", () => app.writeHash());
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
      pitch: 60,
      bearing: 0,
      duration: 2400,
      essential: true,
    });
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
  return { lng, lat, zoom: Math.max(zoom, 8.5), pitch: 60, bearing: 0, ex: 1.2 };
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
        paint: { "background-color": "#101820" },
      },
      {
        id: LAYER_IDS.hypso,
        type: "raster",
        source: "hypso",
        paint: { "raster-opacity": 0.9, "raster-fade-duration": 150 },
      },
      {
        id: LAYER_IDS.hillshade,
        type: "hillshade",
        source: "demHillshade",
        paint: {
          "hillshade-exaggeration": 0.45,
          "hillshade-shadow-color": "#0a1018",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#3a4a5a",
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
          "symbol-spacing": 260,
          "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 13],
        },
        paint: {
          "text-color": "#f2e3bd",
          "text-halo-color": "rgba(10, 16, 24, 0.85)",
          "text-halo-width": 1.6,
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
      {
        id: LAYER_IDS.peakLabels,
        type: "symbol",
        source: "osm",
        filter: ["==", ["get", "kind"], "peak"],
        layout: {
          "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-max-width": 8,
        },
        paint: {
          "text-color": "#f7f0da",
          "text-halo-color": "rgba(10, 16, 24, 0.9)",
          "text-halo-width": 1.5,
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
        layout: {
          "text-field": ["get", "name"],
          "text-font": [FONT_STACK],
          "text-size": 10.5,
          "text-offset": [0, 0.9],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#cfe0f0",
          "text-halo-color": "rgba(10, 16, 24, 0.9)",
          "text-halo-width": 1.4,
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
        layout: {
          "text-field": ["concat", ["get", "name"], " ", ["to-string", ["get", "ele"]], " m"],
          "text-font": [FONT_STACK],
          "text-size": 10.5,
          "text-offset": [0, 1.0],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#f0dcae",
          "text-halo-color": "rgba(10, 16, 24, 0.9)",
          "text-halo-width": 1.4,
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
        filter: ["==", ["geometry-type"], "Point"],
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
