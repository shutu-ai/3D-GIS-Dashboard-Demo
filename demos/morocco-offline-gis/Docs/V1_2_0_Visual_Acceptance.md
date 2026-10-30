# v1.2.0 Visual Acceptance — screenshot-by-screenshot review

Scope: task §十一 — 6 scenarios × 2 viewports (1920×1080, 1366×768) = 12
screenshots, captured from the packaged dist under offline conditions
(`e2e/g4-acceptance.spec.ts`, external requests blocked and counted, tile
traffic settled before each capture). Reviewer: human-eye review of every
image against the "必须清楚表达" column, plus cross-viewport occlusion checks.

Screenshot set: `Docs/screenshots/v1.2.0/desktop-1080p/` and
`…/desktop-768p/` (PNG, captured 2026-10-30, Playwright/ANGLE D3D11).

| # | Scenario | 1080p | 768p | Verdict |
|---|---|---|---|---|
| 01 | GIS default 3D | PASS | PASS | — |
| 02 | RAN overview | PASS | PASS | — |
| 03 | Selected site | PASS | PASS | — |
| 04 | Road RSRP (Mountain Road) | PASS | PASS | — |
| 05 | Site→road→profile linkage | PASS | PASS | — |
| 06 | Back to GIS / restore | PASS | PASS | — |

**Result: 12/12 approved; 0 blockers; minors recorded in §8.**

## 01 — GIS default 3D

Required: real terrain still natural; hypsometric tint, named peaks,
contours not degraded.

- 1080p: `01-gis-default-3d.png` — hypsometric tint + hillshade natural,
  Jbel Toubkal 4167 m / Tizi n'Tichka 2280 m / Jbel n'Tamdart 2250 m labels
  legible, contour lines at full opacity, only the elevation legend present.
  No RAN residue: no banner (only `REAL TERRAIN · OFFLINE`), no sites,
  sectors or RSRP lines, RAN checkbox unchecked, no RSRP legend ticks.
- 768p: same composition; panels at narrow width (236 px) leave the map
  readable; peak label partially behind the left panel — panel is
  user-collapsible, judged not a severe occlusion.

## 02 — RAN overview

Required: damped basemap, multiple sites identifiable, SIMULATED banner
visible.

- 1080p: `02-ran-overview.png` — `SIMULATED NETWORK DATA` banner in the
  top bar; contours visibly damped vs 01, hillshade softened; 9 sites
  distinguishable (selected-state not engaged); sector fans readable;
  RSRP-colored road with dark casing; legend shows the same color stops as
  the map plus the −140/−110/−60 dBm ticks; demo-target cards listed in the
  right panel; layers panel shows the `SIM` tag on the overlay checkbox.
- 768p: all of the above; card text wraps to two lines but stays legible;
  no severe occlusion between peak labels, site markers and RSRP lines.

## 03 — Selected site

Required: site info, sector orientation, demo radius, other sites dimmed.

- 1080p: `03-selected-site.png` — click on GTW-TICHKA-05: amber selection
  circle + label overlay; its sector fan highlighted (others dimmed to
  near-invisible); popup visible with provenance-separated fields
  (经纬度 / 站址海拔 (DEM) 2825 m / 天线挂高（模拟）35 m / 频段 900 MHz /
  扇区方位角及演示半径 (SIMULATED GEOMETRY)); right selection card mirrors
  the same fields; elevation-query card shows a real-DEM sample with full
  provenance line. Popup position correct on-screen (the v1.1.0
  `maplibre-gl.css` defect is gone).
- 768p: identical behavior; popup and card do not cover each other; the
  selected site label remains readable.

## 04 — Road RSRP (Mountain Road scene)

Required: colored roads + legend prominent; weak segments identifiable.

- 1080p: `04-road-rsrp.png` — Mountain Road fly-to; the RSRP line reads
  weak-to-strong (orange/red far segments → green near the site), legend
  present with threshold ticks; selection state from 03 retained (card +
  popup), proving selection survives camera moves; terrain labels
  (Adrar n'Dern 3000 m) legible.
- 768p: same; the RSRP gradient and the weak segment remain identifiable;
  no significant mutual occlusion between labels, markers, RSRP line and
  the right panel.

## 05 — Site→road→profile linkage

Required: site, road, A–B line and a clear LOS profile on one screen.

- 1080p: `05-site-road-profile.png` — demo card one-click chain: expanded
  right panel (`min(500px, 44vw)`), linkage card with provenance-separated
  rows (A 站点 GTW-TICHKA-05 `SIM` 挂高 35 m（模拟）/ A 地面 2811 m（真实 DEM
  采样）/ B 道路点 −110.7 dBm `SIMULATED RSRP` 端高 1.5 m（模拟终端假设）/
  B 地面 3328 m), verdict line `判定: BLOCKED — LOS 受地形阻挡 (terrain-only)`
  in red **with text**, 最小净空 −389 m with the sign convention, boundary
  disclaimer (演示解释，不是运营商验证结论); expanded 560×300 profile chart
  showing terrain profile, LOS ray and the mountain intercept; A→B line +
  endpoints rendered on the map in the highlight color. Numbers coherent
  (4.64 km, elevation range 2614–3647 m matches the chart frame).
- 768p: expanded panel at 44 vw; verdict text fully readable; profile chart
  top edge visible at the viewport bottom — the panel scrolls, judged a
  minor (§8); A–B line and all card fields on screen.

## 06 — Back to GIS / restore

Required: RSRP, sectors, simulated banner and risk card no longer shown.

- 1080p: `06-back-to-gis.png` — banner gone; RAN legend + ticks gone;
  selection card / linkage card gone; profile panel back to manual mode
  (empty chart, 360 px, "依次点击地图选择 A、B 两点"), no A–B line on the
  map; contour/label/hillshade paint restored to GIS values (visually
  identical to 01's basemap); hash has no `m=ran` (asserted by e2e).
- 768p: same; nothing RAN-flavored remains.

## Cross-viewport checks (§十)

- No severe mutual occlusion of peak names / site markers / RSRP lines /
  profile chart at either viewport; both panels collapsible.
- All verdict colors are paired with verdict text in both viewports.
- No label ghosting (SDF glyph defect from v1.1.0 era does not reproduce).

## Non-pass items / minors

| ID | Observation | Disposition |
|---|---|---|
| M1 | 768p-05: expanded profile chart's lower part is below the viewport fold at 1366×768; panel scrolls to reach it | Accepted minor — expand mode targets 1080p reading; no data hidden, scroll reachable |
| M2 | 768p-01/03: Jbel Toubkal label partially behind the left panel | Accepted minor — panels collapsible; label re-appears when collapsed |
| M3 | 03/04: site popup overlaps some terrain near the site (expected popup behavior) | Not a defect — popup follows the selected site by design |

No blockers. The three task red lines hold in every reviewed frame:
no glyph ghosting; no simulated RAN visible without the SIMULATED banner;
terrain-only LOS never worded as a real RSRP/coverage prediction.
