# v1.2.1 — Offline Geographic Context: Plan & Implementation Record

> **2026-10-31 correction in progress:** ADM1/ADM2 name labels and 768p
> boundary recognizability are not yet accepted. Prior PASS statements below
> are historical; current G2/G4/G5 FAIL and RELEASE_READY=NO until corrected
> source-backed labels, assertions, screenshots and packaging are verified.

Task: `Codex_Task_3D_GIS_Dashboard_v1.2.1_Offline_Geographic_Context.md`
Baseline: `v1.2.0` (real-DEM 3D, simulated RAN, 42/42 e2e, 99/99 data validation)
Branch: `feat/v1.2.1-offline-geographic-context` — **no push / no tag / no Release** (task §11).

Baseline identity rechecked: annotated tag `v1.2.0` resolves to commit
`e1958c7dd88407bfedb0c81771ff3a5a42a88e07` (not the tag object's SHA).
The working branch started at post-release main commit
`6e39a0cab4bd4f2f646eff00e70db4c8943a5887`.

## 1. Goal

Add **fully offline, real** geographic context (OSM administrative boundaries,
roads, places, water, natural labels) to the Morocco High Atlas offline 3D GIS
demo, without weakening any v1.2.0 guarantee:

- runtime stays 127.0.0.1-only (all resources same-origin);
- real data is never blended with or relabelled as simulated data;
- disputed boundaries (Western Sahara, source `disputed=true`) render dashed
  and are disclosed on click — never removed or re-attributed;
- the 42-test baseline suite and 99/99 `validate_data.py` stay green.

## 2. Data decision (G1)

Two PMTiles extracts cut from one **pinned** Protomaps Basemap build
(`https://build.protomaps.com/20261030.pmtiles`, Basemap v4.15.2, planetiler of
OSM + Natural Earth; source file 139,202,898,553 B, md5/b3sum recorded in
`metadata.json`). Extraction uses `pmtiles extract --bbox --maxzoom`
(HTTP-range partial reads — the ~139 GB planet is never downloaded), then
`pmtiles verify`. Both archives pass `pmtiles verify` and
`scripts/validate_geo_context.py` (10/10 checks, see §6).

| Archive | Role | BBox | Zoom | Size (B) | SHA-256 (first 12) |
|---|---|---|---|---|---|
| `morocco-overview.pmtiles` | nationwide 2D context | −17.6, 20.4, −0.6, 36.35 | 0–12 | 65,961,582 | `f5e587bd800e` |
| `high-atlas-context.pmtiles` | High Atlas local context | −9.15, 30.4, −6.05, 32.0 | 0–14 | 36,675,954 | `507986ca83b6` |

The original decision that geoBoundaries was not needed was **reopened**:
the pinned Basemap carries `boundaries`
`kind=country(2)/region(4)/county(5,6)` with `disputed` flags (verified by a
z6 tile sweep: 6 disputed country segments in the Western Sahara area) and
`pois` peaks with OSM `elevation` (Jbel Toubkal 4167 confirmed at z14), but
its administrative lines carry **no name fields**. The correction adds
primary named ADM1/ADM2 polygons and interior labels from geoBoundaries
gbOpen MAR release `9469f09` (2017, ODbL 1.0), with fixed source hashes and
explicit separation from the 2026 OSM country/disputed source. See
`V1_2_1_Admin_Acceptance_Correction.md` for the source contract and gates.

## 3. Coverage-domain model (task §5)

New `MapExtent = "atlas" | "overview"` (one owner: `MapApp.setExtent`):

- **overview** — nationwide 2D: terrain detached (`setTerrain(null)`), pitch 0,
  `maxBounds` = overview bbox, boundary-hint suppressed, persistent honesty
  hint (`2D GEOGRAPHIC OVERVIEW · 真实地形仅覆盖 High Atlas`), hash suffix
  `&e=ov`.
- **atlas** — the real-DEM High Atlas domain (v1.2.0 behaviour, unchanged).
- A 3D request while in overview is **denied honestly**: toast explains DEM
  coverage and offers a one-click jump back (`#terrain-denied-toast`).
- `&m=ran` forces `atlas` at boot (RAN demo lives in the DEM area); old
  `#v=…&m=ran` links keep working; `&m=ran&e=ov` resolves to atlas.

## 4. Layer architecture (G2)

`src/map/geographic-context.ts` builds all layers; `map.ts` only splices
sources + layers (base layers under contours, label layers above contour
labels). Every group exists in **overview** (`maxzoom 12.5`) and **detail**
(`minzoom 12.5`) variants so the two archives hand off at one seam:

| Toggle (`#ly-geo-*`) | Group | Content | Representative layer ids |
|---|---|---|---|
| admin | admin0 | country outline + **disputed dashed** | `geo-admin-country`, `geo-admin-disputed` (+`-d`) |
| adm1 | adm1 | regions (kind=region) | `geo-admin-region` (+`-d`) |
| adm2 | adm2 | provinces (kind=county, subtle dashed lines; dimmed in RAN) | `geo-admin-county` (+`-d`) |
| places | places | city/town dots + prominence ladder labels (country → city → town → village) | `geo-place-labels-*` (+`-d`) |
| roads | roads | `highway`/`major_road` solid neutral `#cfcbba` + casing; `minor_road/path` from z12.2 detail only | `geo-roads-major*`, `geo-roads-minor` |
| water | water | water polygons (ocean darker) + linear rivers/streams | `geo-water-fill*`, `geo-water-line*` |
| natural | natural | peak/saddle dots + labels with OSM nominal elevation | `geo-peak-dots*`, `geo-peak-labels*` |

Label policy: prefer safe `name:fr`, `name:en`, then a cased Latin `name`;
reject unsupported codepoints found by auditing the pinned snapshots, with
empty text if none is safe. Noto Sans covers only 0–255; no invented glyphs
or Arabic/Tifinagh shaping claims. New snapshots require another glyph audit.
The symbol ladder places towns above local villages in collision priority.
Label dedup vs the curated `roads-peaks.geojson` features: at boot the
curated file is fetched and its normalized peak/pass/place names become an
exclusion guard composed onto the real label filters — **data-driven, no
hardcoded geography**; simulated labels keep priority at low zoom, real labels
not in the curated set (Toubkal Sommet ouest, Oukaïmeden…) still render.

Click popups (boundaries/places/peaks) show: name, admin level/place type,
coordinates, DEM-coverage membership, OSM nominal elevation when present,
**`disputed` disclosure verbatim when flagged**, and full provenance
(© OpenStreetMap contributors (ODbL) · Protomaps Basemap v4.15.2 · snapshot
2026-10-30). Fields without source values are omitted — never invented.

## 5. Mode integration (G3)

- GIS/RAN remains one state machine (`view-mode.ts`). RAN mode applies
  `GEO_RAN_DIM_TABLE` paint-opacity dampening (secondary info fades: local
  labels → 0, town labels → 0.55, minor roads → 0, county lines → 0.14, peak
  labels → 0.4); GIS restores exact style values. Toggling a group off stays
  off across mode switches (checkbox is the source of truth; mode owns only
  reversible paint differences).
- Entering RAN from overview jumps back to the atlas domain first
  (`enterRanFocus`), so simulated network data is never shown over data-less
  nationwide 2D.
- Simulated layers keep their distinct look: curated roads remain amber dashed
  (`osm-roads`), real roads neutral solid; the `SIMULATED GEO FEATURES` /
  `SIMULATED NETWORK DATA` labels are unchanged, and the geo group carries a
  `REAL·OSM` badge in the panel.

## 6. Build & validation pipeline

- `scripts/prepare_geo_context.py` — reproducible extraction (`--preset
  overview|detail`, `--source-url`, `--source-local`, `--skip-extract`):
  extract → verify → sha256 → read-modify-write of `metadata.json
  geo_context` (key order + trailing newline preserved; idempotent,
  byte-identical on re-run).
- `scripts/geo_probe.mjs` — offline Node PMTiles/MVT probe (layers / features
  / sweep modes) used by the validator and for ad-hoc tile inspection.
- `scripts/validate_geo_context.py` — pure stdlib + subprocess, no network:
  a–j checks = archives exist; v3 header parse + `pmtiles show` cross-check;
  header bbox == metadata bbox; sha256/size == metadata AND pinned release
  values; snapshot/build_version/attribution; vector layers decode; key places
  (Marrakech z6/30/26, Laâyoune z6/29/26, Dakhla z8/116/110); Jbel Toubkal
  elevation 4167 (z14/7831/6703); z6 disputed sweep (`disputed=true` ×6,
  `kind=country |kind_detail=2`) + non-empty policy text; z13 water sweep
  (river ×2331, stream ×2321). **Current result: 10/10 PASS.**

## 7. Verification approach

- Baseline: `validate_data.py` 99/99; Playwright 42/42 via
  `scripts/verify-offline.ps1` (packaged dist + real offline server).
- New: `e2e/v121-geo.spec.ts` — 12 scenarios (task §8.1–8.12) × 2 viewports
  (1920×1080, 1366×768), including screenshot set 01–08 per viewport into
  `Docs/screenshots/v1.2.1/<project>/`, external-request-zero auditing and
  HTTP 206 Range checks on the geo archives.
- Automated functional checks + AI image review: packaged boot → overview
  2D → atlas 3D → RAN roundtrip → geo popups (review scope documented in
  `Docs/V1_2_1_Visual_Acceptance.md`; not claimed as human manual acceptance).

### Historical verification evidence — pre-administrative-correction candidate

- `validate_data.py`: **99/99**; `validate_geo_context.py`: **10/10** after
  the final packaged build. The DEM, hypso, contours, legacy geo features,
  simulated RAN and 0–255 glyph file are byte-identical (SHA-256) to the
  corresponding files extracted from the untouched v1.2.0 ZIP.
- `scripts/verify-offline.ps1 -JsonReport ...`: **65/66** in 825.5 s, baseline
  **42/42**, new **23/24**, zero skips. The sole failure was a 768p disputed
  line missed by the coarse test click-grid (not a source/render failure).
- After changing only that helper to use real rendered line geometry,
  scenario 07 passed **2/2** (both viewports, 34.4 s). Reconciled latest
  case evidence: **42/42 baseline + 24/24 new**. This is not falsely
  represented as a second full-suite 66/66 run. Raw reports:
  `v1_2_1_test_results.json`, `v1_2_1_admin_click_retest.json`.
- `scripts/audit_geo_glyphs.mjs`: **70,999 tiles** across every native zoom
  in both pinned archives; no unsafe codepoint survives the label guard.
  Evidence: `geo_glyph_audit_snapshot_20261030.json`. Re-audit new snapshots.
- Runtime measurements: `scripts/measure_geo_context.mjs` →
  `v1_2_1_runtime_evidence.json` (fresh profiles, Range 206, click-state
  latency, heap and errors; fixed waits are disclosed separately).
- **Old candidate manual acceptance closed on 2026-10-31 by explicit user confirmation**:
  candidate ZIP, new extraction, actual external-network disconnection,
  fresh-profile/empty-cache cold boot, both viewports, nationwide 2D and
  RAN/site-road-DEM profile/GIS return all confirmed passed. Two original
  screenshots preserved. See `V1_2_1_Manual_Acceptance.md` for precise
  attestation and screenshot limits. The historical G4=PASS / RELEASE_READY=YES
  verdict is withdrawn for the current revision: **G4=FAIL, RELEASE_READY=NO,
  PUBLISHED=NO**. The user-tested ZIP is preserved byte-identically under
  `releases/history/pre-admin-correction-ec64df5c7164/`; current acceptance lives in
  external reports, while enclosed QA documents retain the pre-manual snapshot.

## 8. Known limits (honesty first)

- Primary named ADM1/ADM2 rendering now uses fixed geoBoundaries gbOpen MAR
  release `9469f09` (2017, ODbL 1.0), not the nameless Protomaps county lines.
  Its 12/75 original polygons, Latin-prefix labels and same-polygon anchors
  pass 9/9 data checks; current viewport acceptance is tracked separately in
  `V1_2_1_Admin_Acceptance_Correction.md`.
- Arabic-script labels are out of scope for this release (glyph subset 0–255);
  the policy line in `metadata.json` records this.
- The overview domain is 2D by design — there is **no nationwide DEM**, and the
  UI says so persistently.
