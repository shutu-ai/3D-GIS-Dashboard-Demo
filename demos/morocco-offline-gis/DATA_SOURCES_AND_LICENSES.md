# Data Sources & Licenses

## Summary

**v1.1.0 ships REAL terrain elevation** — Copernicus DEM GLO-30, a satellite-derived
global elevation model published by ESA under the Copernicus programme's free and
open data policy — processed entirely at build time and bundled offline.

Still clearly labelled **SIMULATED**: the mobile-network overlay (RAN/RSRP) and
the legacy hand-authored road geometries. New OSM roads are separate real-data layers. Peak/pass elevations shown on
the map are **curated nominal values** from public geographic references, kept
separate from the DEM pixel values (`dem_ele`) used for QA.

v1.2.1 adds a **fourth** class — REAL offline geographic context (OSM admin
boundaries, real roads, place names, water, natural labels via Protomaps
Basemap) — and keeps all classes strictly separated:

| Class | Content | On-screen label |
|---|---|---|
| **REAL (terrain)** | DEM tiles, contours, hypsometric tint, elevation queries, profile sampling | `REAL TERRAIN · OFFLINE`, `DEM: REAL TERRAIN · OFFLINE — Copernicus DEM GLO-30` |
| **REAL (geo context, v1.2.1)** | OSM ADM0/disputed boundaries and real roads/places/water/natural features from Protomaps; primary named ADM1/ADM2 polygons and labels from geoBoundaries gbOpen MAR (2017) | Geographic Context controls and per-feature provenance distinguish the two source families; both OSM-derived datasets are ODbL 1.0 |
| **SIMULATED (geo features)** | hand-authored road geometries, curated peak/pass nominal elevations | `SIMULATED GEO FEATURES` |
| **SIMULATED (RAN)** | 9 invented sites (coords, mast heights, bands, azimuths), per-segment toy-model RSRP, linkage endpoint heights (mast `height_m`, 1.5 m terminal assumption) | `SIMULATED NETWORK DATA` banner while visible, `SIM`/`SIMULATED`/`SIMULATED RSRP` chips on every card |

See `Docs/V1_2_1_Data_Sources_and_Boundaries.md` for the pinned snapshot
record, archive hashes, validated admin levels and the disputed-boundary
policy (Western Sahara lines render dashed and are disclosed on click — never
removed or re-attributed).

The RAN overlay renders **only** while its banner is visible; terrain-only
LOS verdicts are geometric references and never worded as RSRP/coverage
predictions (see `Docs/V1_2_0_Interaction_and_Data_Contract.md` §5).

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

## Geographic context (admin boundaries, roads, places, water, natural) — REAL (v1.2.1)

- **Product**: Protomaps Basemap v4 (planetiler) — OpenStreetMap + Natural Earth.
- **Pinned snapshot**: `https://build.protomaps.com/20261030.pmtiles`, build
  version 4.15.2, retrieved 2026-10-30 (md5/b3sum in `metadata.json
  geo_context.source`).
- **Bundled archives** (both `pmtiles verify` PASS; hashes enforced by
  `scripts/validate_geo_context.py`):
  - `morocco-overview.pmtiles` — bbox −17.6,20.4,−0.6,36.35, z0–12,
    65,961,582 B, sha256 `f5e587bd800e…ca119`;
  - `high-atlas-context.pmtiles` — bbox −9.15,30.4,−6.05,32.0, z0–14,
    36,675,954 B, sha256 `507986ca83b6…00de`.
- **Extraction**: HTTP-range partial reads only (the ~139 GB planet is never
  downloaded); reproducible via `python scripts/prepare_geo_context.py`.
- **Redistribution**: the OSM-derived databases are offered under ODbL 1.0,
  including attribution, share-alike for derived databases, machine-readable
  access and no DRM-only redistribution. Both unrestricted PMTiles archives
  are supplied in full. See `data/NOTICE.txt` and `licenses/ODbL-1.0.txt` in
  the offline package; source: https://www.openstreetmap.org/copyright and
  https://opendatacommons.org/licenses/odbl/1-0/ . Natural Earth is public
  domain (https://www.naturalearthdata.com/about/terms-of-use/). The archives
  retain an unused ESA WorldCover / Daylight `landcover` layer (CC BY 4.0,
  https://esa-worldcover.org/en/data-access and
  https://creativecommons.org/licenses/by/4.0/); it is not rendered.
- **Boundaries**: `kind=country(2)/region(4)/county(5,6)`; lines the source
  flags `disputed=true` (Morocco/Western Sahara) render **dashed** with an
  explicit disputed note on click — never removed or re-attributed.
- **Labels**: prefer `name:fr`, `name:en`, then a cased Latin `name`, rejecting
  unsupported codepoints observed in the pinned snapshots before rendering;
  no safe candidate means empty text. Noto Sans covers Unicode 0–255 only.
  Peak labels may show the OSM
  nominal `elevation`, always marked `OSM 标称值`; elevation queries stay raw DEM.
- Rebuild/validation: `prepare_geo_context.py` / `validate_geo_context.py` /
  `geo_probe.mjs` (all offline; details in `Docs/V1_2_1_Data_Sources_and_Boundaries.md`).

## Named administrative supplement (acceptance correction)

The Protomaps archive's `region`/`county` line taxonomy has **no name fields**;
it cannot supply administrative name labels. Primary named ADM1/ADM2 geometry
therefore comes from geoBoundaries **gbOpen MAR**, pinned release `9469f09`,
representing **2017** boundaries (upstream update 2023-01-19, build 2023-12-12):

- Official source metadata: https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM1/
  and https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM2/ . These discovery
  endpoints are not runtime URLs or unpinned build inputs.
- Fixed raw inputs: https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1_simplified.geojson
  and https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/MAR/ADM2/geoBoundaries-MAR-ADM2_simplified.geojson .
- Actual source license: **Open Data Commons Open Database License 1.0**,
  not an assumed CC BY license. ODbL attribution/share-alike/access conditions
  apply; source OpenStreetMap/Wambacher, distributed by geoBoundaries.
- `admin-context-areas.geojson`: 12 ADM1 + 75 ADM2 polygons, original geometry,
  full `shapeName` and `shapeID` preserved. `admin-context-labels.geojson`:
  87 overview + 13 DEM-domain interior anchors from those same polygons.
- 41 ADM2 names are bilingual: the existing Latin/French prefix becomes the
  display `label`; full multilingual source names remain intact. No invented
  names, translation, new glyphs or political re-attribution.
- The 2017 named polygons can differ from 2026 Protomaps lines. Do not silently
  attach their names to Protomaps geometry. ADM0/disputed lines remain the
  separate Protomaps source; the MAR dataset's territorial classification is
  attributed to its source, not asserted as an official political position.
- Rebuild/validate: `prepare_admin_context.py` / `validate_admin_context.py`;
  build-time Shapely 2.1.2 only, no added browser/runtime dependency. Pinned
  hashes and complete records: `metadata.json.geo_context.administrative_context`,
  `data/NOTICE.txt`, `data_sources/geoboundaries/` and
  `Docs/V1_2_1_Admin_Acceptance_Correction.md`.

## Peaks / passes / places / roads (`roads-peaks.geojson`) — legacy data

- **Peaks & passes**: real coordinates; `ele` is the **published nominal
  elevation** from public geographic references (Toubkal 4167 m, Ouanoukrim
  4089 m, Aksoual 3910 m, Iguelzoum ~3600 m, Tizi n'Tichka 2260 m,
  Tizi n'Tamatert ~2250 m), displayed on labels. `dem_ele` (DEM sample at the
  same point) is stored alongside for transparency/QA only.
- **Places**: real place names, hand-placed approximate coordinates, `dem_ele`
  from the real DEM (point symbols only; not authoritative locations).
- **Roads**: `simulated: true` — hand-authored geometries carried over from
  v1.0.0. Shown with a "SIMULATED GEO FEATURES" tag in the layers panel;
  those legacy features do not represent the separate bundled OSM road network.
- Reconciliation QA: nominal-vs-DEM differences at the named anchors are
  printed at build time and recorded in `Docs/V1_1_0_Real_DEM_Pipeline.md`.

## RAN overlay (`simulated-ran.geojson`) — SIMULATED

Nine invented sites (`GTW-*`), invented sector azimuths/heights/bands, and an
RSRP value per road segment computed from a toy distance+terrain-shadow model.
Ground elevations are sampled from the **real DEM** (so radio geometry sits on
the real terrain), but **no operator data, no real measurements** — every UI
surface labels it "SIMULATED NETWORK DATA".

v1.2.0 linkage (site→road→profile) endpoint heights are likewise simulated:
A uses the site's invented mast `height_m`; B uses an explicit **1.5 m
terminal assumption** (labelled 模拟终端假设). Profile sampling along A→B and
both ground elevations come from the real DEM; the LOS verdict is a
terrain-only geometric reference — weak RSRP classification uses the
configurable −110 dBm threshold (`WEAK_RSRP_DBM` in `src/config.ts`) and the
verdict never claims an RSRP cause.

## Synthetic terrain mode — dev only

`python scripts/prepare_data.py` (default, `--terrain-source synthetic`) still
produces the v1.0.0 analytic fBm terrain for fast development. It is **not
allowed in release packaging**: `scripts/package-dist.ps1` refuses to build a
dist unless `metadata.json` says `terrain.mode == "real"` (override
`-AllowSimulated` is for local experiments only).

## Fonts — Noto Sans (SIL Open Font License 1.1)

The administrative-readability correction adds one isolated derived stack,
**Offline Admin Latin**, for ADM name labels only. Its input is the immutable
baseline `Noto Sans Regular/0-255.pbf` (SHA-256
`a658f4ca95dbdaa9d54bc10a9bde07cfcb6a42317bcf55bdd1e8e46a4be59715`).
Only bitmap distance bytes and the stack alias change; glyph IDs, metrics,
outlines and the original font asset remain intact. The output
`assets/glyphs/Offline Admin Latin/0-255.pbf` is 417,018 B, SHA-256
`2ee61f0000cfc63ca24462aa08c599a8f512b968d24bfc78c797288e6edede3b`.
It remains under OFL 1.1; source credit, normalization formula and full
license/source links travel in its adjacent `NOTICE.md` and the existing
`licenses/Noto-Sans-OFL.txt`. No new non-Latin ranges are enabled. Build and
independent validation: `prepare_admin_font.py`, `validate_admin_font.py`.

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
| go-pmtiles CLI (build-time extraction/verify, `.data/tools/`) | Apache-2.0 |
| Protomaps Basemap tile schema (build-time source only) | BSD-3-Clause (tile content: OSM ODbL, see above) |
| vite, typescript | MIT |
| Pillow, numpy (build-time only) | HPND / MIT-CMU |
| rasterio (build-time only, reads source COGs) | BSD-3-Clause (bundles GDAL/PROJ wheels; not shipped in the offline package) |
| This demo's own code | MIT |

## Runtime network behaviour

The packaged app performs **zero external requests**: tiles, glyphs, GeoJSON
and metadata all load from the same origin served by `start-offline.ps1`
(127.0.0.1). Playwright acceptance tests assert this (`external requests must
be zero`). Request interception is not physical-disconnection evidence; the
v1.2.1 acceptance report separately records whether a true disconnected
cold-start check has been completed.
