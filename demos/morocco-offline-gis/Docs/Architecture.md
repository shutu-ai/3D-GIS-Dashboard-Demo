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
| `data/dem-terrarium.pmtiles` | raster PNG, 512 px, z7–12 | Terrarium-encoded **real elevation** (Copernicus DEM GLO-30, release) or the synthetic dev model (`--terrain-source synthetic`) |
| `data/hypso.pmtiles` | raster PNG, 512 px, z7–12 | Hypsometric tint (same palette as the legend) |
| `data/contours.pmtiles` | vector MVT layer `contour` | `ele` (int m), `major` (bool); z6–12; interval 500/100/50 m by zoom band |
| `data/roads-peaks.geojson` | GeoJSON | roads (LineString, `simulated: true`), peaks/passes/places (Point; `ele` = published nominal, `dem_ele` = real DEM sample, `rank`) |
| `data/simulated-ran.geojson` | GeoJSON | sites (Point + `sectors`, ground elevation from the real DEM), RSRP road segments (LineString, `rsrp_dbm`) — SIMULATED |
| `data/metadata.json` | JSON | coverage, zooms, legend stops, scenes, provenance (`terrain.mode: "real"`, source SHA-256, vertical datum EGM2008, `network_data.mode: "simulated"`) |
| `assets/glyphs/Noto Sans Regular/*.pbf` | glyphs | 0-255 ASCII coverage (+ `9472-9727` only when the font maps the requested symbol) |

All terrain artifacts sample **one elevation raster** (`scripts/pipeline/dem_real.py`
mosaic of the Copernicus GLO-30 tiles in release mode; `scripts/pipeline/dem.py`
analytic function in synthetic dev mode), so DEM tiles, contours, GeoJSON
elevations and RAN site heights agree with each other by construction.

## Terrain sources

**Release (`--terrain-source real`)** — six Copernicus DEM GLO-30 COGs
(EPSG:4326, ~30 m, EGM2008) are mosaicked over a camera-aware coverage bbox
(−8.75, 30.80, −6.45, 31.65), void-masked (thresholded fill + report), and
area-average downsampled through a 9-level pyramid so low-zoom tiles stay
free of aliasing speckle; z11–z12 sample near-natively. Contours run over the
same raster on a shared lattice (+margin nodes) so tiles seam-match. Peaks are
labelled with published nominal elevations; their coordinates are snapped to
the local DEM maximum (≤1.5 km) with the offset recorded. Full provenance
(per-file SHA-256, QA numbers, rebuild commands) lives in
`Docs/V1_1_0_Real_DEM_Pipeline.md` and `metadata.json`.

**Dev (`--terrain-source synthetic`, default)** — the v1.0.0 analytic model
remains for fast iteration; release packaging refuses it.

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
  generated data, mode-aware (`metadata.terrain.mode`): release mode checks
  source SHA-256 provenance, terrarium-vs-GeoTIFF accuracy, elevation
  extremes/NoData, tile seams, contour interval/range consistency, glyph
  coverage, GeoJSON sanity, and runs a synthetic-fallback detector so a
  release build can never quietly ship the dev model.
