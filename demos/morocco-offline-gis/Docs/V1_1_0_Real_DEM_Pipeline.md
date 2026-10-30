# v1.1.0 — Real DEM Pipeline (Copernicus DEM GLO-30)

Status: implemented on `feat/v1.1.0-real-dem-visual-upgrade`.
Owner of this doc: data pipeline lane.

## 1. What changed vs v1.0.0

v1.0.0 generated **SIMULATED** terrain from an analytic Perlin-fBm model
(`scripts/pipeline/dem.py`). v1.1.0 adds a **real-DEM terrain mode** built
from the Copernicus DEM GLO-30 product, while keeping every v1.0.0 output
contract field backward compatible (same filenames, terrarium encoding,
512 px tiles, MVT layer `contour` with `ele` int + `major` bool, intervals
500/100/50 m per zoom band, zooms dem z7–12 / contours z6–12).

| Layer | v1.0.0 (synthetic) | v1.1.0 real mode |
|---|---|---|
| `dem-terrarium.pmtiles` | analytic model | Copernicus GLO-30, pyramid-filtered |
| `hypso.pmtiles` | HYPSO_STOPS | HYPSO_STOPS_REAL (bottom extended to ~250 m, top softened off pure white) |
| `contours.pmtiles` | analytic model lattice | same lattice, sampled from the real DEM pyramid |
| `roads-peaks.geojson` | all simulated | roads `simulated:true`; peaks/passes keep curated **nominal** elevations + real `dem_ele` + `rank` 1–7; places `simulated:false`, `rank` 8+ |
| `simulated-ran.geojson` | simulated | **still simulated** (ground elevations now sampled from the real DEM) |
| `metadata.json` | `simulated:true` | `simulated:false`, `terrain{mode:"real",...}`, `network_data{mode:"simulated"}`, `geo_features{mode:"simulated roads / curated nominal peaks"}` |
| glyphs | `0-255.pbf` | `0-255.pbf`; `9472-9727.pbf` **only if** the source TTF maps U+25B2 (see §7) |

## 2. Source data (offline build)

Six 1°×1° GLO-30 GeoTIFFs cover the demo region (N30–N31, W009–W007):

* EPSG:4326, 3600×3600 float32 metres, 1/3600° (~30 m) sampling
* pixel centres on the global 1/3600-degree lattice; vertical datum
  **EGM2008** (per Copernicus DEM product specification)
* ~40 MB each, ~240 MB total

Exact download URLs, byte sizes, SHA-256 digests, an `aws s3 cp
--no-sign-request` alternative, and the licence/attribution text live in
**`data_sources/copernicus-glo30/MANIFEST.md`** (committed; the `.tif`
files themselves are gitignored under
`demos/morocco-offline-gis/data_sources/**/*.tif` and must be re-fetched on
a fresh machine before a real-mode build).

## 3. Full rebuild

```powershell
# one-time: fetch the 6 tifs into demos/morocco-offline-gis/data_sources/copernicus-glo30
#           (see MANIFEST.md) and verify against SHA256SUMS.txt
cd demos/morocco-offline-gis
python scripts/prepare_data.py --terrain-source real --dem-dir data_sources/copernicus-glo30
python scripts/validate_data.py            # must end 100% PASS (real mode)
```

`--terrain-source` defaults to `synthetic` (v1.0.0 behaviour, byte-compatible).
`--fast` caps DEM/contour zooms at z11 for a ~2 min smoke build; fast builds
fail the validator's release gate (`dem zooms [7, 12]`) by design.

Packaging gate: `scripts/package-dist.ps1` **refuses to package** unless
`metadata.json -> terrain.mode == "real"` (override for dev only with
`-AllowSimulated`).

## 4. Processing steps

1. **Load + provenance** (`scripts/pipeline/dem_real.py`): per-file SHA-256,
   bounds, resolution, dtype recorded; CRS must be EPSG:4326.
2. **Mosaic**: the six tiles are mosaiced into ONE in-memory float32 array
   over `COVERAGE_BBOX = (-8.75, 30.80, -6.45, 31.65)` (a camera-aware
   expansion of the old GEN_BBOX so tilted preset cameras never reach a data
   cliff) plus a 0.05° outer margin → 3420×8640 px.
3. **NoData policy**: NaN or values outside [-1000, 9000] m are void. Voids
   inside the coverage are accepted only if they cover ≤ 0.5% AND no single
   4-connected region exceeds 64 px (else the build fails loudly). Small
   voids are filled by nearest-neighbour interpolation (GDAL `fillnodata`)
   and the count is reported (`terrain.void_pixels_filled`). Measured build:
   **0 void pixels**.
4. **Averaging pyramid**: repeated 2×2 halving (9 levels). Per output zoom
   the pipeline picks the pyramid level whose pixel is not coarser than the
   output pixel, so z7–z10 are BOX-AVERAGED (no 30 m point-sampling speckle)
   and z11/z12 stay bilinear on the native mosaic.
5. **Tiles**: terrarium encoding identical to v1.0.0 (`v = elev + 32768`);
   hypso tint from the same sampled elevations; sampling is edge-clamped
   outside the mosaic so overview tiles never leak nodata.
6. **Contours**: the shared-lattice margin design is unchanged
   (STEPS_PER_TILE = 192 + margin ring); `build_contour_tile` now takes a
   sampler (default = synthetic model). Real mode samples the pyramid level
   matching the lattice step, so tiles seam-match at every zoom.
7. **GeoJSON**: peak/pass `ele` = published nominals (Toubkal 4167,
   Ouanoukrim 4089, Aksoual 3910, **Jbel Aguelzim 3547** — renamed from the
   mangled "Iguelzoum", Adrar n'Dern 3000, Tizi n'Tichka 2260,
   Tizi n'Tamatert 2250). Labels are placed by an **ordered claim pass**
   (`REAL_CLAIMS` in `scripts/prepare_data.py`, processed top to bottom):
   each peak is claimed onto the max-elevation DEM pixel inside its search
   radius (1.5–3.5 km) around its published anchor, **excluding discs**
   (1.5–2.5 km) around points already claimed by earlier peaks — mutual
   exclusion, so no two labels share one summit (Aguelzim instead claims
   the pixel closest to its nominal, like the Tamatert pass). A claim below its
   acceptance floor (nominal−400-style) is still claimed but warned, never
   forced. The Tamatert pass reconciles onto the pixel whose elevation is
   closest to its nominal (moved only if within 150 m); Tichka is
   untouched. Every moved feature carries `snap_offset_m` (anchor→claimed
   distance) and `snap_ref` provenance; `dem_ele` is the DEM value at the
   claimed pixel; `rank` 1–7 peaks/passes, 8+ places; roads
   `simulated:true`. RAN sites keep the simulated RSRP/LOS logic with real
   ground elevations.

## 5. QA summary (measured, full real build)

* coverage elevation min / mean / max: **260.4 / 1565.4 / 4158.5 m**
* voids inside coverage: **0 px** filled (max region 0 px)
* decoded z12 elevation range over all 324 coverage tiles: **242.9 – 4156.4 m**
* terrarium (bilinear decode) vs direct GeoTIFF bilinear, 64 random points:
  **max 2.48 m, mean 0.17 m** (bound 30 m); nearest-pixel decode: max 8.3 m,
  mean 1.8 m (within-pixel terrain variation, informational)
* seam continuity (decoded z12 edge columns, adjacent tiles): mean jump
  **0.27 m / 0.65 m** (bound 25 m); contour MVT shared-edge vertices match
  exactly
* anchor QA after the v1.1.0 label reconciliation — **ordered claim pass**
  over published anchors: each peak claimed onto the max-elevation DEM
  pixel within 1.5–3.5 km, excluding 1.5–2.5 km discs around earlier
  claims; the Tamatert pass claimed onto the pixel closest to its nominal;
  Tichka untouched. `ele` always stays the published nominal;
  `snap_offset_m` = anchor→claimed distance; `snap_ref` records
  provenance. Exclusion decisions: Ouanoukrim and Aksoual both initially
  picked Toubkal's summit (4155 m) and were masked to their own massifs;
  Aguelzim had no exclusion conflict.

| name | nominal (m) | pre-snap dem (m) | claimed dem (m) | offset (m) | diff (m) |
|---|---|---|---|---|---|
| Jbel Toubkal | 4167 | 3999 | 4154 | 252 | **−13** (expected window) |
| Jbel Ouanoukrim | 4089 | 3223 | 4087 | 2510 | **−2** |
| Aksoual | 3910 | 2706 | 3796 | 3313 | −114 |
| Jbel Aguelzim | 3547 | 3480 | 3547 | 749 | ±0 |
| Adrar n'Dern | 3000 | 2382 | 3102 | 1492 | +102 |
| Tizi n'Tichka | 2260 | 2062 | 2062 | — (untouched) | −198 |
| Tizi n'Tamatert | 2250 | 1649 | 2250 | 2476 | ±0 |

  Ouanoukrim's label now sits on the real 4087 m summit (GLO-30's read of
  the 4089 m peak, 2.5 km from the off-summit synthetic anchor); Aksoual
  claims its own massif at 3796 m instead of Toubkal's flank; Tizi
  n'Tamatert sits on 2250 m pass terrain (dead-on nominal) instead of a
  1649 m valley floor; "Iguelzoum" was a mangled name — no such summit
  exists, the real peak is Jbel Aguelzim. Aguelzim uses the
  closest-to-nominal claim mode (same mechanism as the Tamatert pass):
  the claim lands on a 3547 m shoulder pixel (−7.98558, 31.06064), 749 m
  from the anchor and ≈0.4 km from the summit proper (≈−7.9884, 31.0630,
  dem ≈3472 m, −75 m vs nominal) — elevation-coherent with the published
  label by construction and on-massif, rather than the 3911 m
  Toubkal–Ouanoukrim ridge shoulder a pure max-claim picked.
* anti-fallback detector: **0/7** anchors decode within ±2 m of their
  nominal value (a synthetic fingerprint would match ≥5/7 → FAIL)
* validator: **99/99 checks PASS** (real mode, full build; includes the two
  label-reconciliation checks added with the claim pass)

## 6. Validation (`scripts/validate_data.py`)

Mode is auto-detected from `metadata.json -> terrain.mode`. Real mode adds:

* provenance: 6 source files listed with SHA-256; digests recomputed from
  `--dem-dir` and matched; combined digest verified; product/CRS/datum/
  resolution/coverage/void fields checked
* anti-fallback: z12 terrarium decode at the 7 published anchors must NOT
  match the nominal elevations within ±2 m at ≥5 of 7 (catches a silent
  regression back to the synthetic model, which was solved to hit nominal
  values exactly)
* accuracy: ≥64 random points, decoded z12 terrarium (bilinear) vs direct
  GeoTIFF bilinear sample; FAIL if max error > 30 m
* extremes: coverage min in [150, 800] m, max in [4000, 4300] m, no decoded
  value ≤ 0 (no nodata leaks)
* contours: `ele` a multiple of the zoom-band interval at every zoom;
  feature counts > 0; at 3 max-zoom tiles every `ele` lies within the decoded
  DEM tile's min/max
* seams: 2 adjacent z12 tile pairs must not jump > 25 m on the decoded edge
  columns; contour MVT boundary vertices must match across the shared edge
* label reconciliation (GeoJSON): every peak carries `snap_offset_m` ≤ 3500
  and `dem_ele` within ±450 m of its published nominal, unless the name is
  explicitly allow-listed with a recorded reason (Jbel Aguelzim, accepted
  floor 3300 m); any moved feature must carry `snap_ref` provenance;
  published nominals matched against the reconciled table (Aguelzim 3547)
* metadata/legend/archive: legend must equal the `HYPSO_STOPS_REAL` palette
  exactly; archive header bbox = declared coverage; scene pitches 48/50;
  release gate `dem zooms == [7, 12]`

Synthetic-mode checks are unchanged (analytic-model accuracy, anchor ±60 m,
glyph/GeoJSON/metadata checks) and still pass on a full synthetic build.

## 7. Glyph ranges

Peak labels use a `▲ ` prefix (U+25B2, decimal 9650) → MapLibre requests
glyph range **9472-9727**. `scripts/pipeline/glyphs.py` gained a stdlib cmap
reader (`ttf_covers`) because PIL renders `.notdef` tofu for missing
codepoints and cannot prove presence. **Measured: the shipped
@expo-google-fonts NotoSans_400Regular.ttf does NOT map U+25B2** (it also
lacks U+25CF/○/→; it DOES map U+2022 `•`, U+00B7 `·`, and all ASCII).

Therefore the pipeline emits only `public/assets/glyphs/Noto Sans Regular/0-255.pbf`
and **skips** `9472-9727.pbf` — shipping it would render tofu boxes. The
frontend must fall back to an ASCII-safe peak prefix (all ASCII glyphs are
in `0-255.pbf`). `validate_data.py` (real mode) enforces the invariant:
the range file may be absent only while the source TTF lacks U+25B2; if a
future font upgrade maps it, the validator fails until the range file is
generated. Should a symbol fallback (`•` U+2022) be preferred instead, the
8192-8447 range can be shipped the same way — one call to
`generate_glyph_pbf(..., lo=8192, hi=8447)`.

Vite copies `public/assets/glyphs/**` into `dist/` recursively, and
`package-dist.ps1` adds `9472-9727.pbf` to its required-files list whenever
it exists in `public/`.

## 8. Runtime & sizes (measured, full real release build)

* build wall time: **388–555 s measured across full real builds** (~6.5–9
  min, machine-load dependent); ~2 min `--fast`
  (desktop machine, far below the 15–45 min budget)
* peak memory ~1–1.5 GB (mosaic + pyramid + tile buffers)
* `public/data` total: **242.7 MB**
  * `dem-terrarium.pmtiles` — **208.4 MB**, 442 tiles (z7:2, z8:3, z9:8,
    z10:21, z11:84, **z12:324**), terrarium PNG 512 px
  * `hypso.pmtiles` — **28.8 MB**, 442 tiles
  * `contours.pmtiles` — **5.4 MB**, 443 tiles (z6:1, z7:2, z8:3, z9:8,
    z10:21, z11:84, z12:324)
  * `roads-peaks.geojson` — 16 features; `simulated-ran.geojson` — 283
    features; `metadata.json` with real terrain provenance
* full synthetic regression build (v1.0.0 path, unchanged): 440 s,
  180.1 MB, validator **47/47 PASS**
