# Morocco High Atlas — Offline 3D GIS Lab

A fully offline 3D terrain-capability demo for the High Atlas (Morocco):
interactive 2D/3D terrain, hypsometric tint, hillshade, labeled contours,
raw DEM elevation query, A→B profile with terrain-only LOS + Fresnel, and a
simulated RAN overlay.

> **REAL TERRAIN · OFFLINE — Copernicus DEM GLO-30 / SIMULATED NETWORK DATA.**
> v1.1.0 builds every terrain artifact (DEM tiles, contours, hypsometric tint,
> elevation queries, profiles) from the real Copernicus DEM GLO-30 (ESA,
> EGM2008, ~30 m), processed at build time and bundled offline — see
> [`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md) for
> provenance, license and attribution. The RAN overlay stays **simulated**
> ("SIMULATED NETWORK DATA"), and road geometries are hand-authored
> ("SIMULATED GEO FEATURES"); peak/pass labels show published nominal
> elevations kept separate from DEM pixel values.

## Run it (Windows, one click)

```
dist\start-offline.bat          → http://127.0.0.1:<port>  (auto-fallback if reserved)
```

The launcher starts a zero-dependency PowerShell HTTP server (supports the
Range/206 requests PMTiles needs; if the default port is reserved — e.g. by
Hyper-V/WinNAT — it falls forward and opens the browser at the bound port). It
performs **no external requests**; the whole package works with the network
cable pulled.

From source instead:

```
npm install
python scripts/prepare_data.py --terrain-source real --dem-dir data_sources/copernicus-glo30
                                    # regenerate public/data from the real DEM
                                    # (default `synthetic` is a dev-only mode)
npm run dev                        # dev server
```

## Features

| Feature | How |
|---|---|
| 2D ⇄ 3D, pitch 0–70°, exaggeration 1.0/1.2/1.5 (visual only) | maplibre terrain on real terrarium DEM |
| Hypsometric tint + hillshade | separate raster layers from the same real elevation raster |
| Contours with `ele` labels, zoom-dependent interval (500/100/50 m) | MVT PMTiles, major/minor styling, collision-managed labels |
| Elevation query | decodes terrarium tiles **directly from the archive** (nearest-pixel, no interpolation, unaffected by visual exaggeration) |
| A→B profile | ~30 m sampling, canvas chart, ascent/descent, terrain-only LOS clearance, 1st Fresnel radius |
| Simulated RAN overlay | 9 sites with sector fans, popups, RSRP-colored road; banner “SIMULATED NETWORK DATA” |
| Data-boundary UX | camera constrained to real coverage; clear hint + Reset when the view leaves the offline domain |
| Shareable view | all state in the URL hash (`#v=lng,lat,z,pitch,bearing,ex`) |

## Repository layout

```
index.html, src/            front-end (TypeScript + maplibre-gl + pmtiles)
scripts/pipeline/           real DEM loader (mosaic/void mask/pyramid),
                            synthetic dev DEM, PMTiles writer, MVT encoder,
                            contours (marching squares), glyph generator
scripts/prepare_data.py     one-shot data build → public/data + public/assets
                            (--terrain-source real|synthetic)
scripts/validate_data.py    data acceptance validator (provenance, accuracy,
                            seams, contour consistency, synthetic-fallback
                            detection)
scripts/test_pmtiles_writer.py + verify-pmtiles-node.mjs
                            PMTiles v3 writer round-trip vs the official reader
start-offline.ps1/.bat      zero-dependency offline server (ships in dist/)
scripts/package-dist.ps1    build the self-contained dist/ package
                            (real-terrain release gate)
scripts/verify-offline.ps1  offline acceptance runner (Range gate + Playwright)
e2e/                        Playwright offline suite (blocks all external hosts)
Docs/                       Architecture.md, Acceptance.md, visual RCA,
                            real-DEM pipeline, screenshots/
data_sources/               source DEM manifest (TIFs fetched separately,
                            gitignored; SHA-256 recorded)
```

## Acceptance

`Docs/Acceptance.md` records the v1.0.0 (synthetic) evidence history.
v1.1.0 evidence: `Docs/V1_1_0_Real_DEM_Pipeline.md` (data QA),
`Docs/V1_1_0_Visual_RCA.md` (baseline + root causes),
`Docs/V1_1_0_Visual_Acceptance.md` + `Docs/V1_1_0_Acceptance.json`
(visual + functional + offline acceptance, machine-readable).

## Licenses

Demo code MIT; Noto Sans OFL-1.1; maplibre-gl & pmtiles BSD-3-Clause. Terrain
elevation: Copernicus DEM GLO-30 under the Copernicus free-and-open data
policy, attribution required — see
[`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md).
