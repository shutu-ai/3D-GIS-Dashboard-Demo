# Data Sources & Licenses

## Summary

**v1.1.0 ships REAL terrain elevation** — Copernicus DEM GLO-30, a satellite-derived
global elevation model published by ESA under the Copernicus programme's free and
open data policy — processed entirely at build time and bundled offline.

Still clearly labelled **SIMULATED**: the mobile-network overlay (RAN/RSRP), the
road geometries (hand-authored), and nothing else. Peak/pass elevations shown on
the map are **curated nominal values** from public geographic references, kept
separate from the DEM pixel values (`dem_ele`) used for QA.

Build-time provenance (per-file SHA-256, extents, void statistics) is embedded in
`public/data/metadata.json` under `terrain`, and mirrored in
`data_sources/copernicus-glo30/SHA256SUMS.txt` / `MANIFEST.md`.

## Terrain (DEM, contours, hypsometric tint) — REAL

| Item | Value |
|---|---|
| Product | **Copernicus DEM GLO-30** (Global 30 m, 2019–2021 acquisitions; GLO-30 Public instance on AWS Open Data) |
| Provider | European Space Agency (ESA) / Copernicus programme |
| Source tiles | 6 × 1°×1° COG GeoTIFFs covering lon −9…−6, lat 30…32 (High Atlas, Morocco): `Copernicus_DSM_COG_10_{N30_00,N31_00}_{W009_00,W008_00,W007_00}_DEM` |
| Download URLs | `https://copernicus-dem-30m.s3.amazonaws.com/<tile>/<tile>.tif` (see `data_sources/copernicus-glo30/MANIFEST.md` for the exact list + hashes) |
| Source format | Cloud-Optimized GeoTIFF, EPSG:4326, float32 metres, 1/3600° (≈30 m) postings, 3600×3600 px per tile |
| Vertical datum | **EGM2008** geoid heights (per the Copernicus DEM product specification) |
| Processing | mosaic → void mask (thresholded fill + report) → area-average pyramid → terrarium PNG tiles (z7–12, 512 px) in PMTiles v3; contours via marching squares on the **same** real raster; hypsometric tint from the same elevations |
| Offline rebuild | `python scripts/prepare_data.py --terrain-source real --dem-dir data_sources/copernicus-glo30` (no network needed once the six TIFs are in place) |
| QA | `python scripts/validate_data.py` — provenance hashes, source-vs-terrarium sampling error, extremes, seams, contour consistency, and a synthetic-fallback detector (decoded elevations that exactly match the old simulated model's anchors fail the build) |

### License & attribution

Copernicus data is made available under **free, full and open access**
(Commission Delegated Regulation (EU) 2017/2271; "Copernicus Open Data
Licence"): free use and redistribution, including commercial and offline use,
**with attribution and source disclosure; no warranty**. Derived raster products
(the PMTiles in this repo) may be redistributed provided this attribution is
kept:

> Terrain elevation: "Contains Copernicus data / Copernicus DEM GLO-30
> (ESA), processed at build time for offline use."

The original 30 m GeoTIFFs are **not** redistributed from this repository's git
history (gitignored under `data_sources/**/*.tif`); fetch them from the URLs
above and verify against the recorded SHA-256 sums.

### Honesty boundaries

- The DEM is a **Digital Surface Model** (includes canopy/buildings where
  present); at 30 m posting in the High Atlas this is negligible for
  visualisation, but it is **not survey-grade ground truth**.
- Map zoom beyond the archive's native resolution over-samples the source;
  elevation queries remain the encoded DEM values and never gain precision.
- Visual exaggeration (1.0×/1.2×/1.5×) is display-only — queried elevations,
  profiles and contours are always the raw DEM values.

## Contour lines — derived from the REAL DEM

Marching squares over the real elevation raster (shared lattice + margin nodes
so neighbouring tiles seam-match), emitted as MVT `contour` layers (`ele`,
`major`) in PMTiles v3, z6–z12, interval 500 m (z6–8) / 100 m (z9–11) / 50 m
(z12). DEM tiles, contour values, click-elevation and A–B profiles all come
from the same raster, so they are mutually consistent by construction.

## Peaks / passes / places / roads (`roads-peaks.geojson`)

- **Peaks & passes**: real coordinates; `ele` is the **published nominal
  elevation** from public geographic references (Toubkal 4167 m, Ouanoukrim
  4089 m, Aksoual 3910 m, Iguelzoum ~3600 m, Tizi n'Tichka 2260 m,
  Tizi n'Tamatert ~2250 m), displayed on labels. `dem_ele` (DEM sample at the
  same point) is stored alongside for transparency/QA only.
- **Places**: real place names, hand-placed approximate coordinates, `dem_ele`
  from the real DEM (point symbols only; not authoritative locations).
- **Roads**: `simulated: true` — hand-authored geometries carried over from
  v1.0.0. Shown with a "SIMULATED GEO FEATURES" tag in the layers panel; no
  OSM/official road network is bundled.
- Reconciliation QA: nominal-vs-DEM differences at the named anchors are
  printed at build time and recorded in `Docs/V1_1_0_Real_DEM_Pipeline.md`.

## RAN overlay (`simulated-ran.geojson`) — SIMULATED

Nine invented sites (`GTW-*`), invented sector azimuths/heights/bands, and an
RSRP value per road segment computed from a toy distance+terrain-shadow model.
Ground elevations are sampled from the **real DEM** (so radio geometry sits on
the real terrain), but **no operator data, no real measurements** — every UI
surface labels it "SIMULATED NETWORK DATA".

## Synthetic terrain mode — dev only

`python scripts/prepare_data.py` (default, `--terrain-source synthetic`) still
produces the v1.0.0 analytic fBm terrain for fast development. It is **not
allowed in release packaging**: `scripts/package-dist.ps1` refuses to build a
dist unless `metadata.json` says `terrain.mode == "real"` (override
`-AllowSimulated` is for local experiments only).

## Fonts — Noto Sans (SIL Open Font License 1.1)

- Source package: `@expo-google-fonts/noto-sans` (npm), file
  `400Regular/NotoSans_400Regular.ttf`
- License: SIL Open Font License 1.1 — permits bundling, redistribution and
  conversion. A copy is preserved at `.data/fonts/LICENSE-noto-sans.txt` and
  in the upstream npm package.
- The `.pbf` glyph ranges under `public/assets/glyphs/` (including the
  `▲` marker range `9472-9727.pbf` when shipped) are generated from that TTF
  by `scripts/pipeline/glyphs.py` (rasterisation + signed Euclidean distance
  field, hand-encoded glyphs.proto wire format; no third-party glyph binary
  is bundled).

## Software

| Component | License |
|---|---|
| maplibre-gl (v5) | BSD-3-Clause |
| pmtiles (v4) | BSD-3-Clause |
| vite, typescript | MIT |
| Pillow, numpy (build-time only) | HPND / MIT-CMU |
| rasterio (build-time only, reads source COGs) | BSD-3-Clause (bundles GDAL/PROJ wheels; not shipped in the offline package) |
| This demo's own code | MIT |

## Runtime network behaviour

The packaged app performs **zero external requests**: tiles, glyphs, GeoJSON
and metadata all load from the same origin served by `start-offline.ps1`
(127.0.0.1). Playwright acceptance tests assert this (`external requests must
be zero`), in addition to a true disconnected cold-start check.
