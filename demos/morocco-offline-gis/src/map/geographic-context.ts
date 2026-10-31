/**
 * v1.2.1 Real geographic context (Protomaps Basemap v4 / OSM extract).
 *
 * Two offline PMTiles vector archives:
 *  - morocco-overview.pmtiles   nationwide z0-12  (country lines,
 *                               cities/towns, major roads, water, peaks)
 *  - high-atlas-context.pmtiles High Atlas z0-14   (villages, local roads,
 *                               rivers/streams, peaks)
 *
 * v1.2.1 revision: named ADM1/ADM2 context is geoBoundaries gbOpen (local
 * geojson, gated on metadata.geo_context.administrative_context) — the OSM
 * archive still provides ADM0 country + disputed lines ONLY.
 *
 * Separation rules (task v1.2.1 §2/§4):
 *  - These layers are REAL OPEN DATA (© OpenStreetMap contributors, ODbL,
 *    via Protomaps Basemap). The hand-made features in roads-peaks.geojson
 *    stay CURATED/SIMULATED and keep their own layers; this module dedupes
 *    labels against them (data-driven, no hardcoded geography) instead of
 *    mixing the two sources.
 *  - Disputed boundary lines (source disputed=true) are rendered dashed and
 *    described as disputed; never removed or silently re-styled as ordinary.
 *
 * Everything mode-driven is a table consumed by view-mode.ts (the single
 * owner of GIS/RAN differences), everything user-driven is setGroupVisible().
 */

import type { Map as MLMap, LayerSpecification, FilterSpecification, LineLayerSpecification } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { LAYER_IDS, type AppMetadata } from "../config";

export const GEO_SOURCES = {
  overview: "geo-overview",
  detail: "geo-detail",
} as const;

export const GEO_TILE_URLS = {
  overview: "pmtiles:///data/morocco-overview.pmtiles/{z}/{x}/{y}",
  detail: "pmtiles:///data/high-atlas-context.pmtiles/{z}/{x}/{y}",
} as const;

/** Fallback when metadata.geo_context is missing (should never happen). */
export const OVERVIEW_BBOX_FALLBACK: [number, number, number, number] = [-17.6, 20.4, -0.6, 36.35];

/** Zoom seam between the overview and detail archives. */
export const GEO_ZOOM_SEAM = 12.5;

/**
 * ADM label scope seam (v1.2.1 revision): overview-scope anchor labels
 * render nationwide below this zoom, atlas-scope (DEM-interior) anchor
 * labels from this zoom up. Lower than the archive seam so the final
 * scenario02 framing (~z10.4, both atlas fixture anchors in frame) shows
 * verified ADM1+ADM2 names; at no zoom do both scopes of one feature
 * place twice (they hand over at the seam).
 */
export const GEO_ADM_LABEL_SEAM = 9.5;

/**
 * Isolated glyph stack for the 16 explicitly allowlisted geographic-name
 * layers (4 ADM, 8 real, 4 curated). Derived from Noto Sans Regular 0-255 by a
 * bitmap-only SDF-edge remap (128 -> 191.25, MapLibre 5.24 gamma-0.75 /
 * TinySDF 2.1.0 cutoff-0.25 convention); ids and metrics are untouched and
 * the baseline font bytes stay unmodified (see
 * scripts/prepare_admin_font.py + Docs/V1_2_1_Admin_Font_Encoding.md).
 * The old edge-128 bytes collapsed the fill interior below the shader
 * paint threshold at overview sizes, leaving halo-ink "ghost" labels on
 * dark terrain (exact-fixture A/B/C probe: A FAIL Δ42 / B PASS Δ214).
 */
export const ADMIN_FONT_STACK = "Offline Admin Latin";

/**
 * Latin-safe label expression (metadata name_field_policy, hardened
 * 2026-10-30). The bundled glyph set is Noto Sans Regular 0-255 ONLY, so a
 * label may only contain Unicode <= U+00FF — otherwise the renderer fires
 * glyph-range requests that 404 offline (three ranges observed live:
 * 1536-1791 Arabic, 8192-8447 typographic quotes, 11520-11775 Tifinagh).
 *
 * Probed offline against BOTH shipped snapshots (re-runnable audit:
 * scripts/audit_geo_glyphs.mjs sweeps every place/peak-saddle POI candidate
 * in both archives at EVERY native zoom 0..maxzoom; evidence snapshot
 * Docs/geo_glyph_audit_snapshot_20261030.json): even
 * `name:fr` can carry Arabic ("رياض الجديدة" has an Arabic name:fr) and
 * transliteration chars (ɣ U+0263, ɛ U+025B, œ U+0153, ’ U+2019, ḍ ḥ ṭ
 * U+1E0C-1E6D), and an Arabic-only `name` can slip past the case test.
 * So every coalesce candidate (name:fr, name:en, and the cased-guarded raw
 * `name`) is guarded by an `index-of` scan over the exact non-0-255
 * codepoints present in the shipped data; a candidate containing any of them
 * falls through to the next, and features with no Latin-safe name get an
 * empty label (the renderer skips empty text — no glyph requests). Source
 * data and popups keep the original multilingual `name` untouched.
 */
const UNSAFE_CODEPOINTS = [
  299, // U+012B ī
  339, // U+0153 œ
  603, // U+025B ɛ
  611, // U+0263 ɣ
  1575, 1577, 1580, 1583, 1585, 1590, 1604, 1610, // U+0627-064A Arabic
  7692, 7693, 7716, 7717, 7788, 7789, // U+1E0C-1E6D Ḍ ḍ Ḥ ḥ Ṭ ṭ
  8216, 8217, // U+2018/2019 ‘ ’
];

/** Test: field is present AND contains none of the non-0-255 glyphs. */
function latinSafeTest(key: string): unknown {
  const value = ["coalesce", ["get", key], ""] as unknown as string;
  return [
    "all",
    ["has", key],
    ...UNSAFE_CODEPOINTS.map(
      (cp) => ["==", ["index-of", String.fromCodePoint(cp), value], -1] as unknown as boolean,
    ),
  ];
}

/**
 * Nested case, not coalesce+null: text-field is a formatted expression and
 * MapLibre rejects null branches there ("Expected formatted but found null").
 */
const NAME_FIELD = [
  "case",
  latinSafeTest("name:fr"),
  ["get", "name:fr"],
  latinSafeTest("name:en"),
  ["get", "name:en"],
  // raw `name`: additionally require at least one cased letter — Arabic and
  // Tifinagh have no case, so downcase(name) == upcase(name) there.
  [
    "all",
    latinSafeTest("name"),
    ["!=", ["downcase", ["coalesce", ["get", "name"], ""]], ["upcase", ["coalesce", ["get", "name"], ""]]],
  ],
  ["get", "name"],
  "",
];

const WATER_POLY_KINDS = ["ocean", "water", "lake", "playa"] as const;
const WATER_LINE_KINDS = ["river", "stream", "canal", "ditch", "drain"] as const;

interface LayerDraft {
  layer: LayerSpecification;
  /** Which toggle group controls this layer. */
  group: GeoGroupKey;
}

export type GeoGroupKey = "admin0" | "adm1" | "adm2" | "places" | "roads" | "water" | "natural";

/**
 * Admin casing layer IDs (module-local on purpose: a casing is a pure
 * visual underlay of its admin line, not a separately configured feature,
 * so it does not go into src/config.ts LAYER_IDS). The ids keep the
 * "geo-admin-" prefix so wireClick's boundary branch (layer id contains
 * "admin") treats a click on a casing exactly like a click on its main
 * line — popup provenance (kind/disputed) is unchanged. Casing applies to
 * the OSM ADM0 country + disputed lines only; the primary ADM1/ADM2
 * geometry is now geoBoundaries gbOpen (casing ids live in config.ts
 * LAYER_IDS because those layers ARE the primary features).
 * Reversibility: deleting the casing entries from the paint block, the
 * toggle groups and the RAN dim table restores the previous look exactly.
 */
const ADMIN_CASING_IDS = {
  country: "geo-admin-country-casing",
  disputed: "geo-admin-disputed-casing",
  countryD: "geo-admin-country-d-casing",
  disputedD: "geo-admin-disputed-d-casing",
} as const;

/**
 * Named ADM1/ADM2 context (geoBoundaries gbOpen) — local geojson endpoints
 * written by the data-fixer lane, and the map source ids they register
 * under. The app activates these ONLY when metadata.geo_context declares
 * the administrative_context contract (see buildGeoContextLayers).
 */
export const ADMIN_GEOJSON_URLS = {
  areas: "/data/admin-context-areas.geojson",
  labels: "/data/admin-context-labels.geojson",
} as const;
export const ADMIN_SOURCES = {
  areas: "gb-admin-areas",
  labels: "gb-admin-labels",
} as const;

/**
 * Toggle groups in display order. Both archive variants of a layer belong to
 * the same group so one checkbox controls the feature across the seam.
 */
export const GEO_TOGGLE_GROUPS: Record<GeoGroupKey, string[]> = {
  admin0: [
    ADMIN_CASING_IDS.country,
    LAYER_IDS.geoAdminCountry,
    ADMIN_CASING_IDS.disputed,
    LAYER_IDS.geoAdminDisputed,
    ADMIN_CASING_IDS.countryD,
    LAYER_IDS.geoAdminCountryD,
    ADMIN_CASING_IDS.disputedD,
    LAYER_IDS.geoAdminDisputedD,
  ],
  adm1: [
    LAYER_IDS.geoGb1Casing,
    LAYER_IDS.geoGb1Line,
    LAYER_IDS.geoGb1LabelsO,
    LAYER_IDS.geoGb1LabelsA,
  ],
  adm2: [
    LAYER_IDS.geoGb2Casing,
    LAYER_IDS.geoGb2Line,
    LAYER_IDS.geoGb2LabelsO,
    LAYER_IDS.geoGb2LabelsA,
  ],
  places: [
    LAYER_IDS.geoPlaceDots,
    LAYER_IDS.geoPlaceDotsD,
    LAYER_IDS.geoPlaceLabelsMajor,
    LAYER_IDS.geoPlaceLabelsTown,
    LAYER_IDS.geoPlaceLabelsLocal,
    LAYER_IDS.geoPlaceLabelsMajorD,
    LAYER_IDS.geoPlaceLabelsTownD,
    LAYER_IDS.geoPlaceLabelsLocalD,
  ],
  roads: [
    LAYER_IDS.geoRoadsMajorCasing,
    LAYER_IDS.geoRoadsMajor,
    LAYER_IDS.geoRoadsMajorCasingD,
    LAYER_IDS.geoRoadsMajorD,
    LAYER_IDS.geoRoadsMinor,
  ],
  water: [
    LAYER_IDS.geoWaterFill,
    LAYER_IDS.geoWaterFillD,
    LAYER_IDS.geoWaterLine,
    LAYER_IDS.geoWaterLineD,
  ],
  natural: [
    LAYER_IDS.geoPeakDots,
    LAYER_IDS.geoPeakDotsD,
    LAYER_IDS.geoPeakLabels,
    LAYER_IDS.geoPeakLabelsD,
  ],
};

/**
 * RAN-mode dampening for geo layers (view-mode consumes this table). GIS
 * values are the style-declared look; RAN values de-emphasize SECONDARY
 * context only — country/region lines, major cities, major roads and water
 * stay readable as background (task §4.3: RAN keeps high-grade geo info).
 */
export const GEO_RAN_DIM_TABLE: Array<[string, string, unknown, unknown]> = [
  // named ADM1/ADM2 (geoBoundaries gbOpen): secondary context dims hard;
  // labels dim with their lines so RAN focus stays on the corridor.
  [LAYER_IDS.geoGb2Line, "line-opacity", 1, 0.14],
  [LAYER_IDS.geoGb2Casing, "line-opacity", 1, 0.2],
  [LAYER_IDS.geoGb2LabelsO, "text-opacity", 1, 0.2],
  [LAYER_IDS.geoGb2LabelsA, "text-opacity", 1, 0.2],
  [LAYER_IDS.geoGb1Line, "line-opacity", 1, 0.45],
  [LAYER_IDS.geoGb1Casing, "line-opacity", 1, 0.5],
  [LAYER_IDS.geoGb1LabelsO, "text-opacity", 1, 0.45],
  [LAYER_IDS.geoGb1LabelsA, "text-opacity", 1, 0.45],
  [LAYER_IDS.geoRoadsMinor, "line-opacity", 1, 0],
  [LAYER_IDS.geoPlaceLabelsLocal, "text-opacity", 1, 0],
  [LAYER_IDS.geoPlaceLabelsLocalD, "text-opacity", 1, 0],
  [LAYER_IDS.geoPlaceLabelsTown, "text-opacity", 1, 0.55],
  [LAYER_IDS.geoPlaceLabelsTownD, "text-opacity", 1, 0.55],
  [LAYER_IDS.geoPeakLabels, "text-opacity", 1, 0.4],
  [LAYER_IDS.geoPeakLabelsD, "text-opacity", 1, 0.4],
];

function boundaryBase(paint: Record<string, unknown>, minzoom: number, maxzoom?: number): LayerSpecification {
  return {
    id: "",
    type: "line",
    source: GEO_SOURCES.overview,
    "source-layer": "boundaries",
    minzoom,
    ...(maxzoom !== undefined ? { maxzoom } : {}),
    layout: { "line-join": "round", "line-cap": "round" },
    paint: paint as LayerSpecification["paint"],
  } as LayerSpecification;
}

function withSource(l: LayerSpecification, source: string): LayerSpecification {
  return { ...l, source } as LayerSpecification;
}

/** The metadata contract that gates the named ADM1/ADM2 geojson sources. */
type AdminContextContract = NonNullable<AppMetadata["geo_context"]>["administrative_context"];

/**
 * Build all geo context layers. `base` ones render under the contours
 * (terrain -> water/admin/roads -> contours), `label` ones above the contour
 * labels so toponyms win the collision order over contour numbers.
 * `admin` is the metadata.geo_context.administrative_context contract — when
 * absent, NO gbOpen ADM1/2 layers are produced (the sources wouldn't exist).
 */
export function buildGeoContextLayers(admin?: AdminContextContract): { base: LayerDraft[]; label: LayerDraft[] } {
  const base: LayerDraft[] = [];
  const label: LayerDraft[] = [];

  // ---- water -------------------------------------------------------------
  const waterFillPaint = {
    "fill-color": ["match", ["get", "kind"], "ocean", "rgba(36, 62, 96, 0.72)", "rgba(56, 94, 134, 0.6)"],
    "fill-opacity": 1,
  };
  const waterLinePaint = {
    "line-color": "#4f7ea8",
    "line-opacity": 1,
    "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.7, 12, 1.5, 14, 2.4],
  };
  base.push({
    group: "water",
    layer: {
      id: LAYER_IDS.geoWaterFill,
      type: "fill",
      source: GEO_SOURCES.overview,
      "source-layer": "water",
      filter: ["in", ["get", "kind"], ["literal", WATER_POLY_KINDS]],
      minzoom: 4,
      maxzoom: GEO_ZOOM_SEAM,
      paint: waterFillPaint as LayerSpecification["paint"],
    } as LayerSpecification,
  });
  base.push({
    group: "water",
    layer: {
      ...({
        id: LAYER_IDS.geoWaterFillD,
        type: "fill",
        source: GEO_SOURCES.detail,
        "source-layer": "water",
        filter: ["in", ["get", "kind"], ["literal", WATER_POLY_KINDS]],
        minzoom: GEO_ZOOM_SEAM,
        paint: waterFillPaint as LayerSpecification["paint"],
      } as LayerSpecification),
    },
  });
  const waterLineFilter = [
    "all",
    ["==", ["geometry-type"], "LineString"],
    ["in", ["get", "kind"], ["literal", WATER_LINE_KINDS]],
  ];
  base.push({
    group: "water",
    layer: {
      id: LAYER_IDS.geoWaterLine,
      type: "line",
      source: GEO_SOURCES.overview,
      "source-layer": "water",
      filter: waterLineFilter,
      minzoom: 7,
      maxzoom: GEO_ZOOM_SEAM,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: waterLinePaint as LayerSpecification["paint"],
    } as LayerSpecification,
  });
  base.push({
    group: "water",
    layer: {
      id: LAYER_IDS.geoWaterLineD,
      type: "line",
      source: GEO_SOURCES.detail,
      "source-layer": "water",
      filter: waterLineFilter,
      minzoom: GEO_ZOOM_SEAM,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: waterLinePaint as LayerSpecification["paint"],
    } as LayerSpecification,
  });

  // ---- administrative boundaries ----------------------------------------
  // Two provenance families, kept separate ON PURPOSE (no silent mix):
  //  1. OSM ADM0 (archive `boundaries` layer): country + source-flagged
  //     disputed lines only, with the casing/contrast recognizability
  //     revision retained verbatim.
  //  2. geoBoundaries gbOpen ADM1/ADM2 — the PRIMARY named admin-area
  //     geometry (local geojson from the data-fixer lane; lines are drawn
  //     from the areas polygons, labels sit on interior anchor points).
  //     Gated on metadata.geo_context.administrative_context: when the
  //     contract is absent the app shows NO ADM1/2 geometry at all (no
  //     dormant layers, no invented names). The old OSM region/county line
  //     layers are retired — NOT rebuilt here.
  // Draw order: gbOpen edges are pushed BEFORE the OSM ADM0 lines so the
  // disputed dash always paints above any gbOpen polygon edge it crosses.
  const countryPaint = {
    "line-color": "rgba(245, 240, 214, 0.85)",
    "line-opacity": 1,
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 12, 2.4, 14, 2.8],
  };
  const disputedPaint = {
    "line-color": "rgba(240, 214, 140, 0.95)",
    "line-opacity": 1,
    "line-dasharray": [2.5, 1.8],
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 12, 2.6, 14, 3.0],
  };
  // Per-class casing paint: width = main + ~1.2, same dasharray so the
  // underlay outlines the dashes instead of becoming a solid rail.
  const countryCasingPaint = {
    "line-color": "rgba(14, 20, 18, 0.5)",
    "line-opacity": 1,
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.4, 12, 3.6, 14, 4.0],
  };
  const disputedCasingPaint = {
    "line-color": "rgba(14, 20, 18, 0.55)",
    "line-opacity": 1,
    "line-dasharray": [2.5, 1.8],
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.6, 12, 3.8, 14, 4.2],
  };
  const country = boundaryBase(countryPaint, 4, GEO_ZOOM_SEAM);
  const disputed = boundaryBase(disputedPaint, 4, GEO_ZOOM_SEAM);
  const countryC = boundaryBase(countryCasingPaint, 4, GEO_ZOOM_SEAM);
  const disputedC = boundaryBase(disputedCasingPaint, 4, GEO_ZOOM_SEAM);
  country.id = LAYER_IDS.geoAdminCountry;
  disputed.id = LAYER_IDS.geoAdminDisputed;
  countryC.id = ADMIN_CASING_IDS.country;
  disputedC.id = ADMIN_CASING_IDS.disputed;
  (disputed as LineLayerSpecification).filter = ["all", ["==", ["get", "kind"], "country"], ["==", ["get", "disputed"], true]];
  (country as LineLayerSpecification).filter = ["all", ["==", ["get", "kind"], "country"], ["!=", ["get", "disputed"], true]];
  // the casings share their main lines' filters verbatim
  (disputedC as LineLayerSpecification).filter = (disputed as LineLayerSpecification).filter;
  (countryC as LineLayerSpecification).filter = (country as LineLayerSpecification).filter;
  if (admin) {
    // Named ADM lines keep the recognizability hierarchy from the revision
    // pass: dark casing underlay + brighter cream main line, dasharrays
    // coarsened ([5,3] ADM1, [3,3] ADM2) so they never read as contour
    // texture. Minzooms inherit the old OSM ladder (ADM1 z5.8, ADM2 z8.5);
    // no maxzoom — the geojson covers every camera (no archive seam).
    // v1.2.1 contrast fix: the CASINGS are SOLID (matching the admin0
    // house style — country casing is solid under its dashed main). A
    // dasharray-mirrored casing left ~50% of the boundary path with no
    // dark ink at all, so the dashed cream mains washed out completely
    // on light terrain (plain/hypso); probe-measured on/off gate at the
    // strict 02b camera went 7 -> 150 qualifying pixels (768p ADM2
    // boundary ROI) with the mains, dashes and RAN dim table untouched.
    const gb1Paint = {
      "line-color": "rgba(235, 228, 195, 0.55)",
      "line-opacity": 1,
      "line-dasharray": [5, 3],
      "line-width": ["interpolate", ["linear"], ["zoom"], 5.8, 1.1, 12, 1.8, 14, 2.2],
    };
    const gb1CasingPaint = {
      "line-color": "rgba(10, 14, 12, 0.7)",
      "line-opacity": 1,
      "line-width": ["interpolate", ["linear"], ["zoom"], 5.8, 2.7, 12, 3.4, 14, 3.8],
    };
    const gb2Paint = {
      "line-color": "rgba(235, 228, 195, 0.45)",
      "line-opacity": 1,
      "line-dasharray": [3, 3],
      "line-width": ["interpolate", ["linear"], ["zoom"], 8.5, 0.9, 12, 1.4, 14, 1.8],
    };
    const gb2CasingPaint = {
      "line-color": "rgba(10, 14, 12, 0.7)",
      "line-opacity": 1,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8.5, 2.5, 12, 3.0, 14, 3.4],
    };
    const gbLine = (
      id: string,
      casingId: string,
      paint: Record<string, unknown>,
      casingPaint: Record<string, unknown>,
      minzoom: number,
      level: "ADM1" | "ADM2",
    ) => {
      const filter = ["==", ["get", "level"], level] as FilterSpecification;
      const mk = (layerId: string, layerPaint: Record<string, unknown>) =>
        ({
          id: layerId,
          type: "line",
          source: ADMIN_SOURCES.areas,
          filter,
          minzoom,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: layerPaint as LayerSpecification["paint"],
        }) as LayerSpecification;
      return { casing: mk(casingId, casingPaint), line: mk(id, paint) };
    };
    const gb1 = gbLine(LAYER_IDS.geoGb1Line, LAYER_IDS.geoGb1Casing, gb1Paint, gb1CasingPaint, 5.8, "ADM1");
    const gb2 = gbLine(LAYER_IDS.geoGb2Line, LAYER_IDS.geoGb2Casing, gb2Paint, gb2CasingPaint, 8.5, "ADM2");
    base.push(
      // ADM2 first so ADM1 paints above it on shared segments; both before
      // the OSM ADM0 lines (disputed dash must stay on top of gbOpen edges).
      { group: "adm2", layer: gb2.casing },
      { group: "adm2", layer: gb2.line },
      { group: "adm1", layer: gb1.casing },
      { group: "adm1", layer: gb1.line },
    );
  }
  base.push(
    // casing first inside each class so the main line paints on top
    { group: "admin0", layer: countryC },
    { group: "admin0", layer: country },
    { group: "admin0", layer: disputedC },
    { group: "admin0", layer: disputed },
  );
  // detail-archive variants (same look, seam-shifted zoom window) — OSM
  // ADM0 only; the gbOpen geojson needs no archive-seam variants.
  // ORDER MATTERS: casing clones BEFORE their main clones (same class order
  // as the low-zoom push above), otherwise a z>=12.5 casing overpaints the
  // main line it underlays.
  for (const [proto, id] of [
    [countryC, ADMIN_CASING_IDS.countryD],
    [country, LAYER_IDS.geoAdminCountryD],
    [disputedC, ADMIN_CASING_IDS.disputedD],
    [disputed, LAYER_IDS.geoAdminDisputedD],
  ] as Array<[LayerSpecification, string]>) {
    const d = withSource(proto, GEO_SOURCES.detail) as LayerSpecification;
    d.id = id;
    delete (d as { maxzoom?: number }).maxzoom;
    d.minzoom = GEO_ZOOM_SEAM;
    base.push({ group: "admin0", layer: d });
  }

  // ---- real roads --------------------------------------------------------
  // Solid neutral lines — visually distinct from the SIMULATED amber dashed
  // RSRP roads AND from the curated dashed amber roads-peaks features.
  const majorPaint = {
    "line-color": "#cfcbba",
    "line-opacity": 1,
    "line-width": ["interpolate", ["linear"], ["zoom"], 7.5, 0.8, 10, 1.4, 14, 3.0],
  };
  const majorCasingPaint = {
    "line-color": "rgba(18, 24, 20, 0.75)",
    "line-width": ["interpolate", ["linear"], ["zoom"], 7.5, 1.3, 10, 2.2, 14, 4.4],
  };
  const majorFilter = ["in", ["get", "kind"], ["literal", ["highway", "major_road"]]];
  const roadBase = (id: string, source: string, paint: Record<string, unknown>, minzoom: number, maxzoom?: number) =>
    ({
      id,
      type: "line",
      source,
      "source-layer": "roads",
      filter: majorFilter,
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: paint as LayerSpecification["paint"],
    }) as LayerSpecification;
  base.push(
    { group: "roads", layer: roadBase(LAYER_IDS.geoRoadsMajorCasing, GEO_SOURCES.overview, majorCasingPaint, 7.5, GEO_ZOOM_SEAM) },
    { group: "roads", layer: roadBase(LAYER_IDS.geoRoadsMajor, GEO_SOURCES.overview, majorPaint, 7.5, GEO_ZOOM_SEAM) },
  );
  const majorDCasing = roadBase(LAYER_IDS.geoRoadsMajorCasingD, GEO_SOURCES.detail, majorCasingPaint, GEO_ZOOM_SEAM);
  const majorD = roadBase(LAYER_IDS.geoRoadsMajorD, GEO_SOURCES.detail, majorPaint, GEO_ZOOM_SEAM);
  base.push({ group: "roads", layer: majorDCasing }, { group: "roads", layer: majorD });
  base.push({
    group: "roads",
    layer: {
      id: LAYER_IDS.geoRoadsMinor,
      type: "line",
      source: GEO_SOURCES.detail,
      "source-layer": "roads",
      filter: ["in", ["get", "kind"], ["literal", ["minor_road", "path", "aerialway"]]],
      minzoom: 12.2,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#b5b0a0",
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12.2, 0.6, 14, 1.8],
      } as LayerSpecification["paint"],
    } as LayerSpecification,
  });

  // ---- places ------------------------------------------------------------
  const placeDots = (id: string, source: string, minzoom: number, maxzoom?: number) =>
    ({
      id,
      type: "circle",
      source,
      "source-layer": "places",
      filter: ["in", ["get", "kind_detail"], ["literal", ["city", "town"]]],
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      paint: {
        // v1.2.1: slightly smaller dots so the stroke no longer clips the
        // first glyph row of the town label below the anchor (Moulay Brahim).
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 1.8, 10, 2.6],
        "circle-color": "#e8dfc8",
        "circle-stroke-color": "rgba(30, 36, 30, 0.9)",
        "circle-stroke-width": 1,
      } as LayerSpecification["paint"],
    }) as LayerSpecification;
  label.push(
    { group: "places", layer: placeDots(LAYER_IDS.geoPlaceDots, GEO_SOURCES.overview, 5, GEO_ZOOM_SEAM) },
    { group: "places", layer: placeDots(LAYER_IDS.geoPlaceDotsD, GEO_SOURCES.detail, GEO_ZOOM_SEAM) },
  );

  // prominence ladder: country label -> cities -> towns -> villages/hamlets.
  // population_rank is the source's importance field (bigger = more
  // prominent); negated so symbol placement resolves big cities first.
  const placeLabel = (
    id: string,
    source: string,
    filter: unknown,
    minzoom: number,
    maxzoom: number | undefined,
    sizeStart: number,
    sizeEnd: number,
  ) =>
    ({
      id,
      type: "symbol",
      source,
      "source-layer": "places",
      filter: filter as FilterSpecification,
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      layout: {
        "text-field": NAME_FIELD,
        // v1.2.1 readability (approved scope): corrected-SDF stack on ALL real
        // place labels (8 layers incl. -d variants). NAME_FIELD is
        // latin-safe-guarded, so no unsupported-glyph request can occur.
        "text-font": [ADMIN_FONT_STACK],
        "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, sizeStart, Math.min(minzoom + 4, 14), sizeEnd],
        "symbol-sort-key": ["*", -1, ["coalesce", ["get", "population_rank"], 0]],
        "text-padding": 6,
        // 1.0em (was 0.85): keeps glyph tops clear of the geo-place-dots
        // circle + stroke at the anchor point (proven overlap at Moulay
        // Brahim, 02b camera).
        "text-offset": [0, 1.0],
        "text-anchor": "top",
        "text-max-width": 9,
      },
      paint: {
        // v1.2.1 legibility: pure white fill + THINNER dark halo (1.3 -> 1.0).
        // The old 1.3 halo at 10px Noto sizes swallowed the glyph cores into
        // a dark smear (probe: dark halo ink 266 -> 151 px, light glyph ink
        // 37 -> 52 px per label box at the strict 02b camera). The residual
        // glyph muddiness is the Noto SDF stack itself — evidence captured
        // (same layer/text/paint with the Offline Admin Latin stack renders
        // crisp solid glyphs); font change is a data-lane decision, pending.
        "text-color": "#ffffff",
        "text-halo-color": "rgba(16, 22, 30, 0.85)",
        "text-halo-width": 1.0,
      } as LayerSpecification["paint"],
    }) as unknown as LayerSpecification;

  // ---- named ADM1/ADM2 labels (geoBoundaries gbOpen, gated on contract) ---
  // Interior anchor points from admin-context-labels.geojson. The label text
  // is the data lane's `label` field ONLY (Latin-safe prefix, guarded) — NO
  // raw-name fallback, so a glyph outside the bundled Noto 0-255 set can
  // never trigger a glyph request. Uppercase + letter-spacing reads as an
  // AREA name rather than a place dot label; anchor is the anchor point
  // itself (already computed by the data lane as the polygon interior).
  const admLabel = (
    id: string,
    level: "ADM1" | "ADM2",
    scope: "overview" | "atlas",
    minzoom: number,
    maxzoom: number | undefined,
  ) =>
    ({
      id,
      type: "symbol",
      source: ADMIN_SOURCES.labels,
      filter: ["all", ["==", ["get", "level"], level], ["==", ["get", "scope"], scope]] as FilterSpecification,
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      layout: {
        // Shipped data lane field is `label` (the deterministic Latin-safe
        // prefix of the verbatim shapeName; metadata label_transform
        // guarantees every codepoint <= U+00FF). The latin-safe guard below
        // stays as defense-in-depth — a non-0-255 codepoint would render an
        // empty label rather than trigger a missing-glyph request.
        "text-field": ["case", latinSafeTest("label"), ["get", "label"], ""] as unknown as string,
        // isolated corrected-SDF stack — ONLY the 4 ADM label layers use it
        // (overview+atlas ADM1/ADM2); every other layer keeps FONT_STACK.
        "text-font": [ADMIN_FONT_STACK],
        "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, level === "ADM1" ? 10 : 9, 14, level === "ADM1" ? 12 : 10.5],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
        // constant within a layer (level-filtered); kept declarative so a
        // future multi-level source sorts higher admin levels first.
        "symbol-sort-key": ["coalesce", ["get", "admin_level"], 2],
        "text-padding": 8,
        "text-anchor": "center",
        "text-max-width": 10,
      },
      paint: {
        // v1.2.1 uniform white-on-dark-halo across ALL 16 named geographic
        // label layers (user requirement). Admin hierarchy is carried by
        // uppercase + letter-spacing + the size/sort-key ladder above, not
        // by fill color. Single halo — no multi-extrusion.
        "text-color": "#ffffff",
        "text-halo-color": "rgba(16, 22, 30, 0.85)",
        "text-halo-width": 1.0,
      } as LayerSpecification["paint"],
    }) as unknown as LayerSpecification;

  const cityFilter = [
    "any",
    ["==", ["get", "kind"], "country"],
    ["in", ["get", "kind_detail"], ["literal", ["city"]]],
  ];
  const townFilter = ["==", ["get", "kind_detail"], "town"];
  const localFilter = ["in", ["get", "kind_detail"], ["literal", ["village", "hamlet", "neighbourhood"]]];
  // PROMINENCE LADDER — MapLibre 5 placement priority is REVERSE style
  // order: the LAST symbol layer in the stack places first and keeps its
  // labels under collision (verified in maplibre-gl 5.24 placement.ts, and
  // live: hiding geo-place-labels-local-d freed the Tahannaout town label
  // that the low-rank hamlet "Douar el bared Tahannaout" was culling). It
  // also matches the draw order — higher-prominence toponyms paint on top.
  // The array is authored low -> high: local -> town -> ADM2 -> ADM1 ->
  // major (country/cities), with peaks (pushed below, last) at the very
  // top. BOTH scopes of each tier stay adjacent (their zoom windows are
  // disjoint: overview <= seams < atlas), and BOTH major layers sit after
  // ALL four ADM name layers so majors outrank ADM names at EVERY active
  // zoom (the pre-v1.2.1 order put majorO before the atlas ADM pair,
  // inverting 9.5..12.5 against this comment). The scope seam
  // (GEO_ADM_LABEL_SEAM) hands overview anchors over to the DEM-interior
  // atlas anchors so no feature ever labels twice.
  const admOverviewLabels = admin
    ? [
        { group: "adm2" as GeoGroupKey, layer: admLabel(LAYER_IDS.geoGb2LabelsO, "ADM2", "overview", 8.5, GEO_ADM_LABEL_SEAM) },
        { group: "adm1" as GeoGroupKey, layer: admLabel(LAYER_IDS.geoGb1LabelsO, "ADM1", "overview", 5.8, GEO_ADM_LABEL_SEAM) },
      ]
    : [];
  const admAtlasLabels = admin
    ? [
        { group: "adm2" as GeoGroupKey, layer: admLabel(LAYER_IDS.geoGb2LabelsA, "ADM2", "atlas", GEO_ADM_LABEL_SEAM, undefined) },
        { group: "adm1" as GeoGroupKey, layer: admLabel(LAYER_IDS.geoGb1LabelsA, "ADM1", "atlas", GEO_ADM_LABEL_SEAM, undefined) },
      ]
    : [];
  label.push(
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsLocal, GEO_SOURCES.overview, localFilter, 11.5, GEO_ZOOM_SEAM, 9.5, 11) },
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsLocalD, GEO_SOURCES.detail, localFilter, GEO_ZOOM_SEAM, undefined, 9.5, 11) },
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsTown, GEO_SOURCES.overview, townFilter, 9, GEO_ZOOM_SEAM, 10, 11.5) },
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsTownD, GEO_SOURCES.detail, townFilter, GEO_ZOOM_SEAM, undefined, 10.5, 12) },
    ...admOverviewLabels,
    ...admAtlasLabels,
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsMajor, GEO_SOURCES.overview, cityFilter, 4.2, GEO_ZOOM_SEAM, 10.5, 13) },
    { group: "places", layer: placeLabel(LAYER_IDS.geoPlaceLabelsMajorD, GEO_SOURCES.detail, cityFilter, GEO_ZOOM_SEAM, undefined, 11, 12.5) },
  );

  // ---- natural: peaks (pois, with OSM nominal elevation) ------------------
  const peakDots = (id: string, source: string, minzoom: number, maxzoom?: number) =>
    ({
      id,
      type: "circle",
      source,
      "source-layer": "pois",
      filter: ["in", ["get", "kind"], ["literal", ["peak", "saddle"]]],
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.4, 14, 4.4],
        "circle-color": "#f4e9c8",
        "circle-stroke-color": "rgba(74, 58, 24, 0.9)",
        "circle-stroke-width": 1,
      } as LayerSpecification["paint"],
    }) as LayerSpecification;
  const peakLabel = (id: string, source: string, minzoom: number, maxzoom?: number) =>
    ({
      id,
      type: "symbol",
      source,
      "source-layer": "pois",
      filter: ["in", ["get", "kind"], ["literal", ["peak", "saddle"]]],
      minzoom,
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      layout: {
        "text-field": [
          "concat",
          NAME_FIELD,
          "\n",
          ["coalesce", ["to-string", ["get", "elevation"]], ""],
          ["case", ["has", "elevation"], " m", ""],
        ],
        // v1.2.1 readability (approved scope): corrected-SDF stack on the
        // real peak/saddle labels too (geo-peak-labels + -d).
        "text-font": [ADMIN_FONT_STACK],
        "text-size": ["interpolate", ["linear"], ["zoom"], minzoom, 9.5, 14, 11.5],
        "symbol-sort-key": ["coalesce", ["get", "min_zoom"], 14],
        "text-padding": 8,
        "text-max-width": 8,
        "text-offset": [0, 0.9],
        "text-anchor": "top",
      },
      paint: {
        // v1.2.1 legibility: white fill + thinner halo (see placeLabel note)
        "text-color": "#ffffff",
        "text-halo-color": "rgba(18, 26, 36, 0.78)",
        "text-halo-width": 1.0,
      } as LayerSpecification["paint"],
    }) as unknown as LayerSpecification;
  label.push(
    { group: "natural", layer: peakDots(LAYER_IDS.geoPeakDots, GEO_SOURCES.overview, 11.2, GEO_ZOOM_SEAM) },
    { group: "natural", layer: peakLabel(LAYER_IDS.geoPeakLabels, GEO_SOURCES.overview, 11.2, GEO_ZOOM_SEAM) },
    { group: "natural", layer: peakDots(LAYER_IDS.geoPeakDotsD, GEO_SOURCES.detail, GEO_ZOOM_SEAM) },
    { group: "natural", layer: peakLabel(LAYER_IDS.geoPeakLabelsD, GEO_SOURCES.detail, GEO_ZOOM_SEAM) },
  );

  return { base, label };
}

/** Every geo layer id, for layer-existence polling. */
export function allGeoLayerIds(): string[] {
  const { base, label } = buildGeoContextLayers();
  return [...base, ...label].map((d) => (d.layer as { id: string }).id);
}

function normName(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Layers whose labels must yield to the curated roads-peaks features. */
const DEDUP_TARGETS = [
  LAYER_IDS.geoPlaceLabelsMajor,
  LAYER_IDS.geoPlaceLabelsTown,
  LAYER_IDS.geoPlaceLabelsLocal,
  LAYER_IDS.geoPlaceLabelsMajorD,
  LAYER_IDS.geoPlaceLabelsTownD,
  LAYER_IDS.geoPlaceLabelsLocalD,
  LAYER_IDS.geoPeakLabels,
  LAYER_IDS.geoPeakLabelsD,
];

interface CuratedProps {
  kind?: string;
  name?: string;
}

export class GeoContextOverlay {
  private map: MLMap;
  private meta: AppMetadata;
  private groupOn: Record<GeoGroupKey, boolean> = {
    admin0: true,
    adm1: true,
    adm2: true,
    places: true,
    roads: true,
    water: true,
    natural: true,
  };
  private popup: maplibregl.Popup | null = null;
  // ---- reversible curated dedup (v1.2.1 rev4) -----------------------------
  /** Latest desired dedup state. Effective switch = ly-osm checked AND atlas
   * extent (controls.ts); default true keeps the atlas checked-at-boot
   * behavior byte-identical to pre-rev4. */
  private curatedDedupOn = true;
  /** True once every DEDUP_TARGETS layer registered and was written once. */
  private dedupReady = false;
  /** Single readiness retry lane (original pattern — no extra async lanes). */
  private dedupRetryPending = false;
  /** Base filters captured EXACTLY once, before the first filter write. */
  private baseFilters = new Map<string, FilterSpecification>();
  /** Guard + apply cached in the owner once the curated fetch resolves. */
  private dedupGuard: FilterSpecification | null = null;
  private dedupApply: (() => boolean) | null = null;

  constructor(map: MLMap, meta: AppMetadata) {
    this.map = map;
    this.meta = meta;
    this.wireClick();
    void this.applyDedupFromCurated();
  }

  // ------------------------------------------------------------- visibility
  /** One checkbox = one group; both archive variants flip together. */
  setGroupVisible(group: GeoGroupKey, on: boolean) {
    this.groupOn[group] = on;
    for (const id of GEO_TOGGLE_GROUPS[group]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
  }

  /** Restore every group (used after boot-race visibility application). */
  applyAllGroups() {
    for (const key of Object.keys(this.groupOn) as GeoGroupKey[]) {
      this.setGroupVisible(key, this.groupOn[key]);
    }
  }

  /** RAN-mode dampening — view-mode.ts calls this; GIS restores style values. */
  applyRanDim(on: boolean, progress: (id: string, prop: string, value: unknown) => void) {
    for (const [id, prop, gis, ran] of GEO_RAN_DIM_TABLE) {
      progress(id, prop, on ? ran : gis);
    }
  }

  // ---------------------------------------------------------------- dedup
  /**
   * Label dedup (task §4.3): the curated roads-peaks.geojson features keep
   * their labels; real labels whose case-folded name appears in the curated
   * exclusion set yield, so one point never carries two overlapping names
   * with two provenances. NORMALIZATION IS ASYMMETRIC by design: the set
   * keys pass through normName (NFD accent-strip + lowercase + trim) while
   * the guard folds CASE ONLY (MapLibre `downcase` — no diacritic
   * stripping), so a diacritic-bearing real same-name WOULD escape the
   * exclusion. Verified against the current curated file: every
   * peak/pass/place name there is already diacritic-free (normName is a
   * no-op on all of them), so case folding alone matches exactly and no
   * plain-form alias branch is added — it would be dead code on real data
   * (nothing invented); revisit only if curated data ever carries
   * diacritics. The exclusion set comes from the actual curated file at
   * boot — no hardcoded geography. Real peaks/places not in the curated
   * set (Toubkal Sommet ouest, Aiguille d'Ifni, Oukaïmeden, …) keep
   * rendering.
   */
  private async applyDedupFromCurated() {
    try {
      const res = await fetch("/data/roads-peaks.geojson");
      if (!res.ok) return;
      const data = (await res.json()) as { features: Array<{ properties: CuratedProps }> };
      const dupes = new Set<string>();
      for (const f of data.features) {
        const n = normName(f.properties.name);
        if (n && (f.properties.kind === "peak" || f.properties.kind === "pass" || f.properties.kind === "place")) {
          dupes.add(n);
        }
      }
      if (dupes.size === 0) return;
      const guard = [
        "!",
        // MapLibre expression for case folding is `downcase` (not JS's
        // to-lowercase) — the wrong op makes setFilter throw and silently
        // kills the whole dedup pass. Case-ONLY fold: no diacritic
        // stripping on this side (see the asymmetry note above; exact for
        // the current diacritic-free curated file).
        ["in", ["downcase", NAME_FIELD] as unknown as string, ["literal", Array.from(dupes)]],
      ] as unknown as FilterSpecification;
      // compose guard with each layer's BASE kind filter — the base filter
      // must be captured before the first write, never re-read afterwards
      const baseFilters = this.baseFilters;
      this.dedupGuard = guard;
      const apply = () => {
        let ready = true;
        for (const id of DEDUP_TARGETS) {
          if (!this.map.getLayer(id)) {
            ready = false;
            continue;
          }
          if (!baseFilters.has(id)) baseFilters.set(id, this.map.getFilter(id) as FilterSpecification);
          const base = baseFilters.get(id)!;
          const composed: FilterSpecification =
            base && (base as { length?: number }).length
              ? (["all", base, this.dedupGuard!] as unknown as FilterSpecification)
              : this.dedupGuard!;
          // race-safe: EVERY write reads the latest switch state, so a
          // toggle landing while layers still register wins the race
          this.map.setFilter(id, this.curatedDedupOn ? composed : base);
        }
        return ready;
      };
      this.dedupApply = apply;
      this.applyCuratedDedupState();
    } catch {
      // dedup is a quality improvement, never a boot blocker
    }
  }

  /**
   * Re-run the cached apply with the latest switch state. ONE readiness
   * retry lane total (original pattern): while a chain is pending, toggles
   * only flip `curatedDedupOn` — the running chain applies the latest state
   * on its next poll. After readiness, direct synchronous application.
   */
  private applyCuratedDedupState() {
    if (!this.dedupApply) return; // fetch pending — completion path reads latest state
    if (this.dedupReady) {
      this.dedupApply();
      return;
    }
    if (this.dedupRetryPending) return;
    this.dedupRetryPending = true;
    let tries = 0;
    const retry = () => {
      if (this.dedupApply && this.dedupApply()) {
        this.dedupReady = true;
        this.dedupRetryPending = false;
        return;
      }
      if (++tries > 300) {
        this.dedupRetryPending = false;
        return;
      }
      window.setTimeout(retry, 100);
    };
    retry();
  }

  /**
   * Curated-dedup master switch (controls.ts: effective = ly-osm checked AND
   * atlas extent). on=false restores each target layer's EXACT base filter
   * from the once-captured cache; on=true re-applies the cached guard.
   * Safe at any time — a call before the fetch completes only updates the
   * tracked state, and the fetch completion applies that latest state.
   */
  setCuratedDedup(on: boolean) {
    this.curatedDedupOn = on;
    this.applyCuratedDedupState();
  }

  // ---------------------------------------------------------------- popups
  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Admin level wording from the metadata contract — no invented taxonomy. */
  private adminWording(props: Record<string, unknown>): string {
    // gbOpen named admin features carry their own provenance props
    // (source/level/source_version) — they are NEVER mapped onto the OSM
    // kind_detail taxonomy (no ADM2→5/6 remapping).
    if (props.source === "geoBoundaries gbOpen") {
      const ver = String(props.source_version ?? "?");
      const yr = String(props.source_year ?? "?");
      return props.level === "ADM1"
        ? `大区 ADM1 (geoBoundaries gbOpen ${yr} · ${ver})`
        : `行政区 ADM2 (geoBoundaries gbOpen ${yr} · ${ver})`;
    }
    const kind = String(props.kind ?? "");
    if (kind === "country") return "国家边界 ADM0 (country)";
    return `行政边界 (${kind})`;
  }

  private placeWording(props: Record<string, unknown>): string {
    const kd = String(props.kind_detail ?? props.kind ?? "?");
    const map: Record<string, string> = {
      country: "国家",
      city: "主要城市 (city)",
      town: "城镇 (town)",
      village: "村庄 (village)",
      hamlet: "村落 (hamlet)",
      neighbourhood: "街区 (neighbourhood)",
      macrohood: "区域 (macrohood)",
      locality: "地名 (locality)",
    };
    return map[kd] ?? kd;
  }

  private wireClick() {
    const layers = Array.from(new Set(Object.values(GEO_TOGGLE_GROUPS).flat()));
    this.map.on("click", (e) => {
      const hits = this.map.queryRenderedFeatures(e.point, { layers: layers.filter((id) => this.map.getLayer(id)) });
      const f = hits.find((h) => h.layer.id.startsWith("geo-"));
      if (!f) return;
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const src = this.meta.geo_context?.source;
      const esc = this.escapeHtml;
      // gbOpen named features surface their raw original shapeName (full,
      // unmodified) per the contract; OSM features keep the existing
      // name/name:fr fallback chain.
      const isGb = p.source === "geoBoundaries gbOpen";
      const name = esc(
        isGb
          ? String(p.shapeName ?? p.name ?? "(未命名)")
          : String(p.name ?? p["name:fr"] ?? "(未命名)"),
      );
      const isBoundary = f.layer.id.includes("admin");
      const isPeak = f.layer.id.includes("peak");
      let typeLine: string;
      if (isBoundary) typeLine = this.adminWording(p);
      else if (isPeak) typeLine = `山峰/山口 (${esc(String(p.kind ?? "?"))})`;
      else typeLine = this.placeWording(p);

      const inCoverage = (() => {
        const [minLon, minLat, maxLon, maxLat] = this.meta.coverage;
        const { lng, lat } = e.lngLat;
        return lng >= minLon && lng <= maxLon && lat >= minLat && lat <= maxLat;
      })();

      const rows: string[] = [
        `<tr><td class="k">类型</td><td>${esc(typeLine)}</td></tr>`,
        `<tr><td class="k">坐标</td><td>${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}</td></tr>`,
        `<tr><td class="k">地形覆盖</td><td>${inCoverage ? "在 High Atlas DEM 覆盖区内" : "DEM 覆盖区外（2D 底图区域）"}</td></tr>`,
      ];
      if (typeof p.elevation === "number") {
        rows.push(
          `<tr><td class="k">标注标高</td><td>${p.elevation} m <span class="k">(OSM 标称值；海拔查询始终返回原始 DEM 值)</span></td></tr>`,
        );
      }
      if (p.disputed === true || String(p.disputed) === "true") {
        rows.push(
          `<tr><td class="k">边界属性</td><td><span style="color:#f0d489">disputed — 源数据标记为争议边界，如实展示，不作政治归属断言</span></td></tr>`,
        );
      }
      if (isGb) {
        // raw identifiers straight from the gbOpen release — no renaming
        rows.push(
          `<tr><td class="k">shapeID</td><td>${esc(String(p.shapeID ?? "?"))}</td></tr>`,
          `<tr><td class="k">来源</td><td>geoBoundaries gbOpen (ODbL 1.0) · ${esc(String(p.source_year ?? "?"))} · ${esc(String(p.source_version ?? "?"))}</td></tr>`,
        );
      } else {
        rows.push(
          `<tr><td class="k">来源</td><td>© OpenStreetMap contributors (ODbL) · Protomaps Basemap v${esc(src?.build_version ?? "?")} · 快照 ${esc(src?.snapshot ?? "?")}</td></tr>`,
        );
      }
      if (!this.popup) {
        this.popup = new maplibregl.Popup({ closeButton: false, maxWidth: "300px" });
      }
      this.popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-weight:700;margin-bottom:4px">${name}</div>` +
            `<table style="font-size:11px;line-height:1.6;max-width:280px">${rows.join("")}</table>`,
        )
        .addTo(this.map);
    });
  }
}
