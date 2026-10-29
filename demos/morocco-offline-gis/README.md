# Morocco High Atlas — Offline 3D GIS Lab

A fully offline 3D terrain-capability demo for the High Atlas (Morocco):
interactive 2D/3D terrain, hypsometric tint, hillshade, labeled contours,
raw DEM elevation query, A→B profile with terrain-only LOS + Fresnel, and a
simulated RAN overlay.

> **SIMULATED TERRAIN / SIMULATED NETWORK DATA.** Per project decision, every
> byte of runtime data is programmatically generated. The model is anchored to
> real coordinates and approximate real elevations of named features
> (Toubkal 4167 m, Tizi n'Tichka 2260 m, …) but it is **not survey data**.
> See [`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md).

## Run it (Windows, one click)

```
dist\start-offline.bat          → http://127.0.0.1:17841
```

The launcher starts a zero-dependency PowerShell HTTP server (supports the
Range/206 requests PMTiles needs) and opens the browser. It performs **no
external requests**; the whole package works with the network cable pulled.

From source instead:

```
npm install
python scripts/prepare_data.py     # regenerate public/data (numpy + pillow)
npm run dev                        # dev server
```

## Features

| Feature | How |
|---|---|
| 2D ⇄ 3D, pitch 0–70°, exaggeration 1.0/1.2/1.5 (visual only) | maplibre terrain on terrarium DEM |
| Hypsometric tint + hillshade | separate raster layers from the same model |
| Contours with `ele` labels, zoom-dependent interval (500/100/50 m) | MVT PMTiles, major/minor styling |
| Elevation query | decodes terrarium tiles **directly from the archive** (nearest-pixel, no interpolation, unaffected by visual exaggeration) |
| A→B profile | ~30 m sampling, canvas chart, ascent/descent, terrain-only LOS clearance, 1st Fresnel radius |
| Simulated RAN overlay | 9 sites with sector fans, popups, RSRP-colored road; banner “SIMULATED NETWORK DATA” |
| Shareable view | all state in the URL hash (`#v=lng,lat,z,pitch,bearing,ex`) |

## Repository layout

```
index.html, src/            front-end (TypeScript + maplibre-gl + pmtiles)
scripts/pipeline/           synthetic DEM, PMTiles writer, MVT encoder,
                            contours (marching squares), glyph generator
scripts/prepare_data.py     one-shot data build → public/data + public/assets
scripts/validate_data.py    data acceptance validator
scripts/test_pmtiles_writer.py + verify-pmtiles-node.mjs
                            PMTiles v3 writer round-trip vs the official reader
start-offline.ps1/.bat      zero-dependency offline server (ships in dist/)
scripts/package-dist.ps1    build the self-contained dist/ package
scripts/verify-offline.ps1  offline acceptance runner (Range gate + Playwright)
e2e/                        Playwright offline suite (blocks all external hosts)
Docs/                       Architecture.md, Acceptance.md, screenshots/
```

## Acceptance

`Docs/Acceptance.md` records the delivered evidence: cold-start with zero
external requests, feature checks at 1920×1080 and 1366×768, data validation
output, and the honest REAL_DEM = NO statement.

## Licenses

Demo code MIT; Noto Sans OFL-1.1; maplibre-gl & pmtiles BSD-3-Clause. The
generated data carries no third-party rights. Details in
[`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md).
