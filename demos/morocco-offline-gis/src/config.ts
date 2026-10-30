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
