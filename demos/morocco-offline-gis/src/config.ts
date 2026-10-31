/** Shared app config & metadata types (mirrors scripts/prepare_data.py output). */

export interface HypsoLegendEntry {
  elev_m: number;
  color: string;
}

export interface Scene {
  name: string;
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** Terrain provenance block (present once the real DEM build lands). */
export interface TerrainMeta {
  mode: "real" | "simulated";
  product?: string;
  vertical_datum?: string;
  native_resolution_m?: number;
}

export interface AppMetadata {
  simulated: boolean;
  seed: number;
  bbox: [number, number, number, number];
  coverage: [number, number, number, number];
  dem: {
    file: string;
    encoding: "terrarium";
    zooms: [number, number];
    tile_size: number;
    vertical_datum: string;
    nominal_resolution_m: string;
    source: string;
  };
  terrain?: TerrainMeta;
  contours: {
    file: string;
    layer: string;
    intervals_by_zoom: Record<string, number>;
    source: string;
  };
  hypso: { file: string; legend: HypsoLegendEntry[] };
  glyphs: { fontstack: string; license: string };
  scenes: Scene[];
  ran: { file: string; note: string };
  /** v1.2.1: real open-data geographic context provenance (Protomaps/OSM). */
  geo_context?: GeoContextMeta;
}

/** Provenance contract for the offline vector basemap (metadata.json). */
export interface GeoContextSourceMeta {
  url: string;
  snapshot: string;
  build_version: string;
  retrieved_at: string;
  size_bytes?: number;
  license: string;
  attribution: string;
}

export interface GeoContextFileMeta {
  role: string;
  sha256: string;
  size_bytes: number;
  bbox: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  layers: string[];
}

export interface GeoContextMeta {
  mode: string;
  provider: string;
  source: GeoContextSourceMeta;
  files: Record<string, GeoContextFileMeta>;
  disputed_boundary_handling: string;
  name_field_policy?: string;
  peak_elevation_policy?: string;
  coverage_note?: string;
  /**
   * v1.2.1 revision: named ADM1/ADM2 administrative context (geoBoundaries
   * gbOpen). Presence of this key gates the geojson sources + layers — the
   * app renders NO admin-area lines/labels when the data contract is absent
   * (no dormant layers, no invented names). Exact metadata wording pending
   * the data-fixer lane; typed loosely until then.
   */
  administrative_context?: {
    source: string;
    version?: string;
    year?: number;
    license?: string;
    areas?: string;
    labels?: string;
    [k: string]: unknown;
  };
}

export const FONT_STACK = "Noto Sans Regular";

export const LAYER_IDS = {
  hypso: "hypso-tint",
  hillshade: "hillshade",
  contoursLine: "contour-lines",
  contoursMajor: "contour-lines-major",
  contoursLabel: "contour-labels",
  contoursLabelMinor: "contour-labels-minor",
  roads: "osm-roads",
  roadsCasing: "osm-roads-casing",
  peaks: "osm-peaks",
  peakLabels: "osm-peak-labels",
  peakLabelsTop: "osm-peak-labels-top",
  places: "osm-places",
  placeLabels: "osm-place-labels",
  ranSectors: "ran-sectors",
  ranSectorAxis: "ran-sector-axis",
  ranRsrpCasing: "ran-rsrp-casing",
  ranRsrp: "ran-rsrp",
  ranRsrpSel: "ran-rsrp-selected",
  ranSites: "ran-sites",
  ranSitesSel: "ran-sites-selected",
  ranSiteLabels: "ran-site-labels",
  ranSiteLabelsSel: "ran-site-labels-selected",
  profileLine: "profile-line",
  profilePoints: "profile-points",
  // --- v1.2.1 real geographic context (Protomaps/OSM) ---
  // overview archive layers (nationwide, z<=12.5) carry no suffix; the
  // detail archive (High Atlas, z>=12.5) variants end in "-d".
  geoWaterFill: "geo-water-fill",
  geoWaterFillD: "geo-water-fill-d",
  geoWaterLine: "geo-water-line",
  geoWaterLineD: "geo-water-line-d",
  geoAdminCountry: "geo-admin-country",
  geoAdminDisputed: "geo-admin-disputed",
  geoAdminCountryD: "geo-admin-country-d",
  geoAdminDisputedD: "geo-admin-disputed-d",
  // --- v1.2.1 revision: named ADM1/ADM2 from geoBoundaries gbOpen ---
  // Primary admin-area geometry (lines derived from the areas polygons) +
  // interior anchor labels. ids keep the "geo-admin" prefix so the boundary
  // click-popup branch treats them as admin features.
  geoGb1Casing: "geo-admin-gb1-casing",
  geoGb1Line: "geo-admin-gb1-line",
  geoGb1LabelsO: "geo-admin-gb1-labels",
  geoGb1LabelsA: "geo-admin-gb1-labels-a",
  geoGb2Casing: "geo-admin-gb2-casing",
  geoGb2Line: "geo-admin-gb2-line",
  geoGb2LabelsO: "geo-admin-gb2-labels",
  geoGb2LabelsA: "geo-admin-gb2-labels-a",
  geoRoadsMajor: "geo-roads-major",
  geoRoadsMajorCasing: "geo-roads-major-casing",
  geoRoadsMinor: "geo-roads-minor",
  geoRoadsMajorD: "geo-roads-major-d",
  geoRoadsMajorCasingD: "geo-roads-major-casing-d",
  geoPlaceDots: "geo-place-dots",
  geoPlaceDotsD: "geo-place-dots-d",
  geoPlaceLabelsMajor: "geo-place-labels-major",
  geoPlaceLabelsTown: "geo-place-labels-town",
  geoPlaceLabelsLocal: "geo-place-labels-local",
  geoPlaceLabelsMajorD: "geo-place-labels-major-d",
  geoPlaceLabelsTownD: "geo-place-labels-town-d",
  geoPlaceLabelsLocalD: "geo-place-labels-local-d",
  geoPeakDots: "geo-peak-dots",
  geoPeakDotsD: "geo-peak-dots-d",
  geoPeakLabels: "geo-peak-labels",
  geoPeakLabelsD: "geo-peak-labels-d",
} as const;

/**
 * Demo weak-coverage threshold (SIMULATED RSRP). Must stay consistent with
 * the legend / weak-coverage cards / docs. This is a demo filter, not an
 * operator KPI — never present it as a universal engineering standard.
 */
export const WEAK_RSRP_DBM = -110;

export async function loadMetadata(): Promise<AppMetadata> {
  const res = await fetch("/data/metadata.json");
  if (!res.ok) throw new Error(`metadata.json HTTP ${res.status}`);
  return (await res.json()) as AppMetadata;
}

/**
 * Truth-in-labeling: derive the DEM provenance line from metadata.
 * Real build -> "REAL TERRAIN · OFFLINE — Copernicus DEM GLO-30 · <datum> · ~30 m".
 * Anything else (block absent / mode simulated) -> SIMULATED wording. Never
 * claims real terrain unless metadata says so.
 */
export function demSourceLine(meta: AppMetadata): string {
  const t = meta.terrain;
  if (t?.mode === "real") {
    const product = t.product ?? "DEM";
    const datum = t.vertical_datum ?? meta.dem.vertical_datum;
    const res = t.native_resolution_m ? `~${t.native_resolution_m} m` : meta.dem.nominal_resolution_m;
    return `REAL TERRAIN · OFFLINE — ${product} · ${datum} · ${res}`;
  }
  return `SIMULATED terrain · terrarium · ${meta.dem.nominal_resolution_m} nominal · ${meta.dem.vertical_datum}`;
}
