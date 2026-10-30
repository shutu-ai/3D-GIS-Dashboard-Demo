# v1.2.0 Interaction & Data Contract

Morocco High Atlas — Offline 3D GIS Lab · RAN Coverage Visualization.
This document is the behavioral contract shipped in v1.2.0: view-mode state
machine, selection/linkage interaction, field provenance, and the
real-vs-simulated boundary. Normative for regression tests (`e2e/g1-smoke.spec.ts`,
`g2-linkage.spec.ts`, `g3-regression.spec.ts`, `offline.spec.ts`).

## 1. View-mode state machine

Exactly two modes, owned by `src/map/view-mode.ts` (`ViewModeControl`):

```
            +--------------------------------------------+
            |                    boot                    |
            |  hash has &m=ran ?  -- yes --> RAN (after   |
            |        | no                boot gate passes)|
            v        v                                    |
      +---------+   #btn-view-ran   +---------+          |
      |   GIS   | ----------------> |   RAN   |          |
      | (mode=  | <---------------- | (mode=  |          |
      |  'gis') |   #btn-view-gis   |  'ran') |          |
      +---------+                   +---------+          |
```

- Single UI sync point: `syncMode(mode)` updates buttons, banner, legend,
  selection cards and map paint together. No other component mutates mode.
- URL hash carries an **additive** suffix `&m=ran` (written by `writeHash`);
  removing it restores GIS. Deep-link boot into RAN waits for the layer-boot
  gate before showing anything.
- GIS restore is a **deterministic paint reset** to explicit values
  (`BASE_DAMPEN` inverse): `contour-lines.line-opacity = 1`,
  `contour-labels-minor.text-opacity = 1`, `hillshade-exaggeration = 0.35`.
  These are normalized at construction time so the state is assertable
  (visual result equals v1.1.0).
- On every RAN→GIS transition: selection cleared (`sel` properties wiped),
  linkage card/profile residue cleared, banner + RAN legend + ticks hidden,
  `m=ran` dropped from the hash. g3 loops this ×10 and asserts zero residue.

### RAN-layer boot gate (unchanged from v1.1.0, restated)

`RanOverlay` (re)adds layers when `map.getLayer('contour-lines')` first
answers (poll) with a `'load'` event backstop; hidden = **runtime**
`visibility: 'none'` (style-level `none` permanently breaks GeoJSON source
processing in MapLibre v5). The `SIMULATED NETWORK DATA` banner is rendered
**iff** RAN mode is active — cold start shows neither; g1/g3 assert the
coupling in both directions.

### Basemap dampening (RAN mode only)

| Property | GIS | RAN |
|---|---|---|
| `contour-lines` `line-opacity` | 1 | 0.16 |
| `contour-labels-minor` `text-opacity` | 1 | 0.22 |
| `hillshade` `hillshade-exaggeration` | 0.35 | 0.2 |

## 2. Selection model (site / road)

Selection state lives in `RanOverlay` as `selSite: string | null` and
`selRoad: number | null` (selection-space road ordinal, baked into every
feature as `roadIdx` at source-build time — MapLibre tiles GeoJSON sources,
so post-click geometry coordinate matching is unreliable).

- Clicking a site point sets `selSite`; clicking an RSRP road segment sets
  `selRoad`. Both are re-baked into the source data via a `sel` property.
- Visual hierarchy is expressed as **base layer + filtered overlay layers**
  (`ranSitesSel`, `ranSiteLabelsSel`, `ranRsrpSel`), because MapLibre v5
  allows only one zoom-interpolate per paint property and only at top level —
  selection highlight must not live inside paint expressions.
- Overlays carry geometry-type filters (`Point`) and `ranRsrpSel` requires
  `has rsrp_dbm`, so sector polygons/axes can never render as circles/lines.
- One selected pair at a time; a new site click keeps the road selection and
  vice versa; **any** partial selection with both fields present triggers the
  linkage automatically (§3).

## 3. Site→road→profile linkage (the one-click chain)

`Controls.runRanLinkage(siteId, roadIdx)` — triggered when a site AND a road
segment are selected simultaneously (map clicks or a demo card). The manual
two-click A-B flow remains available and takes the shared profile view over.

### Endpoints (provenance-separated)

| Endpoint | Position | Height | Provenance |
|---|---|---|---|
| A | site coordinates (`simulated-ran.geojson`) | `height_m` mast height | position+height **SIMULATED** |
| B | road segment first-segment midpoint | **1.5 m** terminal assumption, explicitly labelled 模拟终端假设 | position SIMULATED, endpoint height SIMULATED |

Frequency = the site's first advertised band (e.g. `900 MHz` → 900).
The A→B line reuses the shared `profile` GeoJSON source/layers; profile math
reuses `computeProfile`/`drawProfileChart` — **LOS logic is not duplicated**.

### Verdict rules (`losVerdict`, honesty contract)

Let `S` = sample count, `G` = `outOfCoverage` samples, `B` = `blocked`
(terrain-ray/terrain intersection found over the covered part).

| Condition | Verdict | Never allowed to say |
|---|---|---|
| `G == S` | **UNKNOWN / 无法判断** | any LOS claim |
| `G > 0` ∧ `B` | **BLOCKED (INCOMPLETE)** — covered part has a definite intersection; gaps cannot upgrade it | green CLEAR |
| `G > 0` ∧ ¬`B` | **INCOMPLETE / 部分未知** — missing DEM may hide blocking | LOS 通畅 (green) |
| `G == 0` ∧ `B` | **BLOCKED (terrain-only)** + 疑似遮挡，需现场验证 | an operator conclusion; an RSRP-cause claim |
| `G == 0` ∧ ¬`B` | **CLEAR (terrain-only)** + 几何视距参考，非覆盖/RSRP 预测 | an RSRP/coverage prediction |

Every verdict color travels with text (`.st-clear/.st-blocked/.st-unknown`
classes); `worstClearanceM` is printed with the sign convention
正=射线高于地形，负=与地形相交; Fresnel stays a midpoint reference.

### Race & ownership

- `linkageToken` increments on every linkage (re)start and on clear; an
  in-flight `computeProfile` whose token no longer matches is discarded —
  rapid card switching or leave-RAN can never let a stale result overwrite
  the newest UI (g2/g3 assert final state + no resurrection after exit).
- `linkageOwnsProfile` marks the shared profile view as linkage-owned. A
  manual A-B click takes ownership; 清除剖面 / leaving RAN clears residue
  **only** when the linkage owns it (a manual profile the user ran survives
  partial-selection changes).

### Demo target cards

Four curated pairs (`#ran-weak-list`), one click = full chain, values stated
in the card label come from the same GeoJSON the map renders:
TICHKA-05→road209 (−110.7 dBm, real-DEM BLOCKED, clearance −389 m),
TICHKA-05→road193 (−62.7 dBm, near-site contrast, CLEAR +2 m),
TICHKA-04→road172 (−110.5 dBm), IMLIL-01→road273 (−111.7 dBm).

## 4. Field provenance (what the UI shows, where it comes from)

| UI field | Source | Label in UI |
|---|---|---|
| Terrain tiles, contours, hypsometric tint | real Copernicus DEM GLO-30 (EGM2008, ~30 m) build-time pipeline | `REAL TERRAIN · OFFLINE` badge |
| Elevation query / profile samples | same real DEM, nearest-pixel decode, unaffected by exaggeration | 真实 DEM 采样 / `DEM: REAL TERRAIN · OFFLINE — Copernicus DEM GLO-30` |
| Site coordinates, mast `height_m`, bands, sector azimuths | `public/data/simulated-ran.geojson` | `SIMULATED` chips |
| 站址海拔 (site popup/card) | **real DEM sample at the site coordinate** — deliberately separate from mast height | `站址海拔 (DEM)`, next to 天线挂高（模拟）`35 m` — never conflated |
| Road RSRP values | toy distance+terrain-shadow model, fixed GeoJSON | `SIMULATED RSRP`, banner while visible |
| Weak-coverage classification | `rsrp_dbm < WEAK_RSRP_DBM` (`-110`, configurable in `src/config.ts`) | legend ticks use the same stops as the map layer (`RSRP_COLOR_STOPS`, single source) |
| Peak/pass label elevations | published nominal values (`roads-peaks.geojson`) | separate from `dem_ele` QA values |
| Road geometries (base layer) | hand-authored `roads-peaks.geojson` | `SIMULATED GEO FEATURES` |
| Sector fan geometry | `fanPolygon` from azimuth/beamwidth/radius | `SIMULATED GEOMETRY` (popup) |

## 5. Simulated/real boundary rules

1. The RAN overlay (sites, sectors, RSRP, linkage endpoints A/B heights) is
   **simulated** and is visible **only** while the `SIMULATED NETWORK DATA`
   banner is visible. No simulated layer renders ungated. (Red line #2.)
2. Terrain-only LOS is a geometric reference; the UI never calls it a real
   RSRP/coverage prediction, never derives RSRP conclusions from LOS, and
   never presents operator-grade conclusions. (Red line #3.)
3. DEM gaps are reported UNKNOWN/INCOMPLETE; missing data never reads as
   clear terrain or green LOS.
4. Provenance chips (`SIM` / `SIMULATED` / `DEM`) travel with every number in
   selection, linkage and popup cards; colors never encode meaning alone.
5. `exaggeration` is display-only: queried elevations, linkage numbers and
   verdicts are invariant (g3 asserts bitwise-equal numbers at 1.5×).
6. No external request is performed in any mode; the RSRP color scale, legend
   and threshold stay consistent from one shared constant.

## 6. Regression test map (behavior → test)

| Contract clause | Asserted by |
|---|---|
| §1 cold start / banner coupling | g1-smoke (mode switch), g3 (cold start) |
| §1 GIS restore paint + zero residue ×10 loop | g3 loop test |
| §1 hash `&m=ran` additive | g1-smoke, g3 (final hash) |
| §2 selection bake + overlays + popups | g1-smoke (site/road) |
| §3 one-click chain, numbers, expanded card | g2 (chain test) |
| §3 CLEAR contrast per real DEM | g2 (contrast test) |
| §3 race guard / exit no-resurrection | g2 + g3 |
| §3 verdict honesty incl. out-of-coverage | g2 wording checks; g3 UNKNOWN test |
| §4 exaggeration invariance | g3 |
| §5 zero external requests | every spec (`blockExternal`) + verify-offline |
| baseline (24 v1.1.0 tests) | `offline.spec.ts` (untouched) |
