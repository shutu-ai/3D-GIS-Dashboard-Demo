# Morocco High Atlas — Offline 3D GIS Lab

A fully offline 3D terrain-capability demo for the High Atlas (Morocco):
interactive 2D/3D terrain, hypsometric tint, hillshade, labeled contours,
raw DEM elevation query, A→B profile with terrain-only LOS + Fresnel, and a
simulated RAN overlay.

> **REAL TERRAIN · OFFLINE — Copernicus DEM GLO-30 / REAL GEO CONTEXT · OSM / SIMULATED NETWORK DATA.**
> v1.1.0 builds every terrain artifact (DEM tiles, contours, hypsometric tint,
> elevation queries, profiles) from the real Copernicus DEM GLO-30 (ESA,
> EGM2008, ~30 m), processed at build time and bundled offline — see
> [`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md) for
> provenance, license and attribution. v1.2.0 adds a GIS/RAN view-mode
> system, RAN visual hierarchy and site→road→DEM-profile linkage; the RAN
> overlay stays **simulated** ("SIMULATED NETWORK DATA"), road geometries
> are hand-authored ("SIMULATED GEO FEATURES"), and peak/pass labels show
> published nominal elevations kept separate from DEM pixel values.
> The full real/simulated boundary contract lives in
> [`Docs/V1_2_0_Interaction_and_Data_Contract.md`](./Docs/V1_2_0_Interaction_and_Data_Contract.md).
> v1.2.1 adds **fully offline real geographic context** — OSM country and
> disputed boundaries, real roads, city/town labels, rivers/lakes and natural
> names from a pinned Protomaps snapshot; primary **named ADM1/ADM2 polygons
> and labels** use geoBoundaries gbOpen MAR (2017, fixed release `9469f09`).
> Source families and vintages are disclosed, not silently merged; Western
> Sahara disputed country lines remain dashed and disclosed — plus a nationwide
> 2D **Morocco Overview** extent (`&e=ov`) beside the real-DEM High Atlas 3D
> domain. Details:
> [`Docs/V1_2_1_Geographic_Context_Plan.md`](./Docs/V1_2_1_Geographic_Context_Plan.md)
> · [`Docs/V1_2_1_Data_Sources_and_Boundaries.md`](./Docs/V1_2_1_Data_Sources_and_Boundaries.md).

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
| GIS ⇄ RAN Coverage view modes | one state machine: RAN mode damps the basemap (contours/labels/hillshade + real geo context), shows the 9-site overlay with the SIMULATED banner, hash suffix `&m=ran` |
| Morocco Overview ⇄ High Atlas extents (v1.2.1) | nationwide 2D geographic context (no fake DEM — terrain detached, honest persistent hint) vs real-DEM 3D domain; hash suffix `&e=ov`; 3D requests outside the DEM area are denied with an explanation + jump-back button |
| Real geographic context (v1.2.1) | independent toggles: OSM country borders (+ **dashed disputed lines**); named geoBoundaries gbOpen ADM1/ADM2 polygons/labels; real roads/places/water/natural features from Protomaps; popups distinguish source, version/year and stable administrative identity |
| RAN visual hierarchy | selected site/sector highlighted (base layer + filtered overlay), other sites dimmed, RSRP roads with dark casing, legend from the same color stops as the map (weak-coverage threshold −110 dBm, configurable) |
| Site→road→profile linkage | select site + road (or a demo card) → automatic terrain profile: A = simulated mast (35 m etc.), B = road midpoint with an explicit simulated 1.5 m terminal height; honest verdicts — DEM gaps are UNKNOWN/INCOMPLETE, never a green CLEAR; BLOCKED says 疑似遮挡，需现场验证, never an RSRP-cause claim |
| Simulated RAN overlay | 9 sites with sector fans, popups, RSRP-colored road; banner “SIMULATED NETWORK DATA” |
| Data-boundary UX | camera constrained to real coverage; clear hint + Reset when the view leaves the offline domain |
| Shareable view | all state in the URL hash (`#v=lng,lat,z,pitch,bearing,ex`) |

### Legacy geography versus real geographic context

The legacy “roads / peaks / places” group is **not another OSM basemap**:
its roads are hand-authored simulated examples, peaks/passes are curated
reference points with nominal elevations, and some place positions are
approximate. The new real-road and natural-label groups use the pinned
OSM/Protomaps geometry and names. Two sources can refer to the same locality;
they must not become duplicate labels or be silently presented as one source.
For known same-name reference points, the current deduplication keeps the
curated label (including its disclosed nominal elevation) and suppresses the
matching real-context label. This is an explicit reference-label choice,
not a claim that the curated point or example road is real OSM geometry.

Real context is the preferred general map background. Legacy reference
features remain separately identified; the nine-site RAN overlay and its
colored example road segments remain **SIMULATED NETWORK DATA**, regardless
of which real geographic layers are visible. A peak's nominal label elevation
is not the raw DEM measurement returned by the elevation query.

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
scripts/prepare_geo_context.py
                            reproducible Protomaps snapshot extraction →
                            public/data + metadata geo_context contract
scripts/validate_geo_context.py
                            geo archive acceptance validator (header/hashes/
                            layers/key places/disputed sweep; 10 checks)
scripts/geo_probe.mjs       offline PMTiles/MVT tile probe (layers/features/
                            sweep) used by the validator
e2e/                        Playwright offline suite (blocks all external
                            hosts): baseline 42 + v121-geo 12 scenarios
Docs/                       Architecture.md, Acceptance.md, visual RCA,
                            real-DEM pipeline, screenshots/
data_sources/               source DEM manifest (TIFs fetched separately,
                            gitignored; SHA-256 recorded)
```

## Acceptance

### Rebuilding the named administrative supplement

Build-time prerequisite: **Shapely 2.1.2** (no added browser/runtime dependency).
Raw source copies under `data_sources/geoboundaries/` are pinned and hash-checked.

```powershell
python scripts/prepare_admin_context.py --source-dir data_sources/geoboundaries
python scripts/validate_admin_context.py --idempotence-run
python scripts/prepare_admin_font.py
python scripts/validate_admin_font.py
# If raw inputs are absent, --fetch-pinned fetches only the fixed 9469f09 files.
```

This emits `public/data/admin-context-areas.geojson` (12 ADM1 + 75 ADM2),
`admin-context-labels.geojson` (87 overview + 13 DEM-domain interior anchors),
and the separate `metadata.geo_context.administrative_context` provenance
contract. The full original names/geometry and `shapeID` remain intact;
only existing Latin/French prefixes are used for map text. ODbL 1.0 applies.
Names and boundaries come from the **same** 2017 polygons, not from mixing
their names with 2026 Protomaps lines. `start-offline.bat` never runs these
build/download scripts. Current correction status and evidence:
`Docs/V1_2_1_Admin_Acceptance_Correction.md`.

The isolated **Offline Admin Latin** glyph stack was initially limited to
four ADM name layers. The user's subsequent geographic-label readability
request extends its explicit usage contract to eight real place/natural-label
layers and four curated reference-label layers (16 in total). Its 224 Latin
glyphs retain the original IDs/metrics; bitmap distance bytes are normalized
to the MapLibre/TinySDF cutoff convention. Original Noto Sans bytes and the
remaining contour/RAN font consumers are unchanged. No Arabic, Tifinagh or CJK
range is added. Source/transform/license records and bitmap/render proof:
`Docs/V1_2_1_Admin_Font_Encoding.md`. Final runtime visibility acceptance is
separate from the font's structural validation.

### Acceptance evidence

`Docs/Acceptance.md` records the v1.0.0 (synthetic) evidence history.
v1.1.0 evidence: `Docs/V1_1_0_Real_DEM_Pipeline.md` (data QA),
`Docs/V1_1_0_Visual_RCA.md` (baseline + root causes),
`Docs/V1_1_0_Visual_Acceptance.md` + `Docs/V1_1_0_Acceptance.json`
(visual + functional + offline acceptance, machine-readable).
v1.2.0 evidence: `Docs/V1_2_0_RAN_Visual_RCA.md` (G0/G1 root causes +
implementation appendices), `Docs/V1_2_0_Interaction_and_Data_Contract.md`
(behavior/provenance contract), `Docs/V1_2_0_Visual_Acceptance.md`
(12-screenshot review) + `Docs/V1_2_0_Acceptance.json` (machine-readable),
`Docs/v1_2_0_timings.json` (boot/switch/linkage timings, no perf gate).
v1.2.1 evidence: `Docs/V1_2_1_Geographic_Context_Plan.md` (plan +
implementation record), `Docs/V1_2_1_Data_Sources_and_Boundaries.md` (pinned
snapshot, hashes, admin levels, disputed policy),
`Docs/V1_2_1_Visual_Acceptance.md` + `Docs/V1_2_1_Acceptance.json`
(screenshot review + machine-readable gates), `Docs/screenshots/v1.2.1/`
(01–08 per viewport).

## Licenses

Demo code MIT; Noto Sans OFL-1.1; maplibre-gl & pmtiles BSD-3-Clause. Terrain
elevation: Copernicus DEM GLO-30 under the Copernicus free-and-open data
policy, attribution required — see
[`DATA_SOURCES_AND_LICENSES.md`](./DATA_SOURCES_AND_LICENSES.md).
