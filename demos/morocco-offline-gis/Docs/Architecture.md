# Architecture — Morocco High Atlas Offline 3D GIS Lab

Single-page MapLibre application + zero-dependency PowerShell static server +
a Python data pipeline. Everything ships in one folder; runtime touches
nothing but `127.0.0.1`.

```
┌────────────────────────────── runtime (dist/) ──────────────────────────────┐
│  start-offline.bat → start-offline.ps1                                      │
│    .NET HttpListener static server, HTTP Range (206) required by PMTiles    │
│    serves index.html, assets/*.js|css, data/*.pmtiles|geojson|json,         │
│    assets/glyphs/*.pbf  — strictly from its own folder, no egress           │
│                                                                             │
│  browser → maplibre-gl v5 + pmtiles v4 protocol                             │
│    sources: pmtiles://…dem-terrarium | hypso | contours, geojson x2         │
│    glyphs:  local Noto Sans Regular .pbf                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data contract (produced by `scripts/prepare_data.py`)

| File | Kind | Contents |
|---|---|---|
| `data/dem-terrarium.pmtiles` | raster PNG, 512 px, z7–12 | Terrarium-encoded elevation of the synthetic model |
| `data/hypso.pmtiles` | raster PNG, 512 px, z7–12 | Hypsometric tint (same palette as the legend) |
| `data/contours.pmtiles` | vector MVT layer `contour` | `ele` (int m), `major` (bool); z6–12; interval 500/100/50 m by zoom band |
| `data/roads-peaks.geojson` | GeoJSON | roads (LineString), peaks/passes/places (Point, `ele`) |
| `data/simulated-ran.geojson` | GeoJSON | sites (Point + `sectors`), RSRP road segments (LineString, `rsrp_dbm`) |
| `data/metadata.json` | JSON | coverage, zooms, legend stops, scenes, provenance (`simulated: true`) |
| `assets/glyphs/Noto Sans Regular/0-255.pbf` | glyphs | ASCII coverage for symbol layers |

All artifacts sample **one analytic function** (`scripts/pipeline/dem.py`),
so DEM tiles, contours, GeoJSON elevations and RAN site heights agree with
each other by construction.

## Synthetic terrain model

1. **Base field** — ridged Perlin fBm rotated 38° to the Atlas trend, a
   smoothstep mountain mask (SW massif → NE Haouz plain), and a detail fbm.
2. **Road carving** — Gaussian valley trenches along the R202/Ourika/Imlil
   corridors.
3. **Anchor correction** — a damped Gauss–Seidel solve of `W·d = targets −
   raw` over 13 anchors (regional wide-σ + local narrow-σ tiers) pins named
   features to their target elevations exactly (residual < 0.1 m) without
   far-field blowups.
4. Deterministic: fixed permutation seed, pure function of (lon, lat).

## Front-end structure

- `src/map/map.ts` — style construction (all layers centralized), view-state
  URL hash (`#v=lng,lat,zoom,pitch,bearing,ex`), fly-to scenes, reset.
- `src/map/terrain.ts` — 2D/3D toggle, pitch, exaggeration (visual only).
- `src/map/contours.ts` — visibility + zoom-dependent interval indicator.
- `src/map/elevation-query.ts` — **decodes terrarium tiles directly from the
  PMTiles archive** (range requests through the shared `PMTiles` handle),
  nearest-pixel, never through the rendered terrain mesh → exaggeration
  cannot influence reported elevations.
- `src/map/profile.ts` — A–B sampling (~30 m step), chart canvas, stats
  (distance/ascent), terrain-only LOS clearance and 1st Fresnel radius.
- `src/map/ran-overlay.ts` — sector fan polygons injected into the RAN
  source, site popups, SIMULATED banner.
- `src/ui/controls.ts` — panels, mode switching, legends, i18n-mixed copy.

## Packaging & acceptance

- `scripts/package-dist.ps1` — `vite build` + server scripts + version stamp
  into `dist-offline/` (self-contained; `public/` rides along).
- `scripts/verify-offline.ps1` — starts the packaged server, checks the
  206/Range gate, then runs the Playwright suite with all non-localhost
  requests blocked and counted; captures 1920×1080 and 1366×768 evidence
  screenshots into `Docs/screenshots/`.
- `scripts/validate_data.py` — structural + accuracy validation of the
  generated data (tile coverage, terrarium vs analytic ≤ 30 m, contour
  interval/range consistency, glyph coverage, GeoJSON sanity).
