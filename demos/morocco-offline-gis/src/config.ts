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
  roads: "osm-roads",
  roadsCasing: "osm-roads-casing",
  peaks: "osm-peaks",
  peakLabels: "osm-peak-labels",
  places: "osm-places",
  placeLabels: "osm-place-labels",
  ranSectors: "ran-sectors",
  ranRsrp: "ran-rsrp",
  ranSites: "ran-sites",
  ranSiteLabels: "ran-site-labels",
  profileLine: "profile-line",
  profilePoints: "profile-points",
} as const;

export async function loadMetadata(): Promise<AppMetadata> {
  const res = await fetch("/data/metadata.json");
  if (!res.ok) throw new Error(`metadata.json HTTP ${res.status}`);
  return (await res.json()) as AppMetadata;
}
