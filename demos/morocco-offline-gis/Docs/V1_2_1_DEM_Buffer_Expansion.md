# V1.2.1 — DEM Buffer Expansion (authorized real-elevation buffer)

Date: 2026-11-01 · Scope: data pipeline only. User authorized enlarging the
package ("扩展真实高程缓冲") to remove the archive-rim "high wall" artifact:
the tile grid over the old bbox sampled edge-replicated mosaic pixels
(`clamp=True`) beyond the small margin, reading as a wall north/east in frame.

## Coverage change (single constant: `pipeline/dem_real.py`)

| | bbox (W, S, E, N) |
|---|---|
| old | (-8.75, 30.80, -6.45, 31.65) |
| suggested by lead | (-8.90, 30.10, -6.10, 31.90) |
| **shipped** | **(-8.83, 30.10, -6.10, 31.90)** |

`MARGIN_DEG = 0.05` unchanged. The sampling window (coverage ± margin,
lattice-snapped: [-8.8801389, 30.0501389, -6.0501389, 31.9501389]) lies
strictly inside the 6-tile raw GLO-30 union ([-9.0001389, 30.0001389,
-6.0001389, 32.0001389]; pixel-centre domain verified by preflight) — **real
data only; zero voids found (0 px filled); no fake/nodata fill anywhere**.

### West-edge correction (-8.90 → -8.83), data-driven

The suggested west edge was vetoed by validate_data.py's hard gate
`decoded min ∈ [150, 800] m`: the real Oued Tensift riverbed dips below
150 m exactly in the suggested NW extension (measured: ALL sub-150 m window
pixels sit at lon ≤ -8.8808; window min 127.1 m at west -8.90 vs 151.0 m at
-8.83; scans in `.data/DEM-buffer-expansion/locate_sub150.log`,
`west_trim_scan.log`). Per the no-threshold-lowering rule, the west edge was
trimmed the minimum 0.07° that restores the gate; N/E/S edges are exactly as
suggested (N +0.25°, E +0.35°, S +0.70° vs old core). Decoded-gate equivalence:
every decoded tile value is a box average or edge-replication of mosaic
values, so decoded min/max == window min/max — the +1.0 m headroom is exact,
not statistical (validator measured decoded min 151.6 m).

Old core (preset cameras, scenes, `bbox` analysis extent) stays strictly
inside: only `metadata.coverage` and `metadata.terrain` changed.

## Core-vs-buffer provenance (new metadata fields)

`metadata.terrain` now additionally records `margin_deg`, `sampling_window`
(lattice-snapped mosaic the sampler actually reads) and `source_union_bounds`
(raw GLO-30 extent); `coverage` remains the authorized archive core. The
clamp note in `pipeline/dem_real.py::provenance` documents that whole-tile
overhang beyond the sampling window is edge-replicated at archive rims only.

## Navigation coverage (integration convention, 2026-11-01)

`metadata.navigation_coverage = [-8.75, 30.8, -6.45, 31.65]` — the ORIGINAL
pre-expansion workspace, pinned as a new root key by
`pipeline/dem_real.py::NAVIGATION_COVERAGE` and emitted reproducibly by
`prepare_data._real_metadata` (same RMW path as every other owned key — not a
hand edit). Purpose: keep the real-elevation buffer (coverage) OUTSIDE the
navigable core so camera maxBounds do not widen with the archive and users
are not invited onto the buffer rim. `navigation_coverage` lies strictly
inside `coverage` (W -8.75 > -8.83, S 30.8 > 30.1, E -6.45 < -6.1,
N 31.65 < 31.9); `meta.bbox` and `scenes` keep their original values; the
runtime reads `navigation_coverage ?? coverage` (designer lane). Note: the
lead's message wrote coverage west as "-8.9"; the shipped gate-safe coverage
is (-8.83, 30.1, -6.1, 31.9) — see the west-edge correction above.

## Knock-on: admin label anchors re-derived (packaging gate, 2026-11-01)

`admin-context-labels.geojson` anchor points are derived from the admin areas
CLIPPED to `coverage`. With the expanded coverage the checked-in file was
stale; the first `package-dist.ps1` run failed its `labels_anchors` +
`idempotence` gates and the `validate_admin_context.py --idempotence-run`
regeneration wrote the re-derived anchors (interior points now computed over
the full, unclipped polygons — up to ~0.3 deg shift, more representative).
The gate then passes byte-identical on re-run. Full regression was re-run on
the regenerated data before packaging.

## Byte-preservation proof (vs `.data/DEM-buffer-expansion/pre-expansion-backup/`)

* `roads-peaks.geojson` SHA-256 `b77833fc…` — **identical** (all curated
  claim points zero-drift: level-0 lattice sampling is invariant to the
  mosaic window shift).
* `simulated-ran.geojson` SHA-256 `d766b11c…` — **identical** (SIM network
  untouched).
* baseline glyph `Noto Sans Regular/0-255.pbf` SHA-256 `a658f4ca…` —
  **identical** (pinned font-input contract intact; font20 manifest
  `usage_whitelist_exact_20` re-validated, `all_pass`).
* 6 source GeoTIFF hashes unchanged (`terrain.source_sha256 6f96a454…`,
  validator cross-check "mismatch []").
* `metadata.json` — CRLF/2-indent dialect, `geo_context` byte-identical;
  changed top-level keys: exactly `coverage` + `terrain`. RMW is a verified
  fixed point (serialize(parse(x)) == x), so regeneration is reproducible
  without hand-copying.

## Regeneration & validation (logs in `.data/DEM-buffer-expansion/`)

* `python scripts/prepare_data.py --terrain-source real` — 983 s, exit 0.
* `validate_data.py` — **99/99 PASS** (accuracy max 1.54 m; anti-fallback
  0/7; no nodata leaks min 151.6 m; max 4156.4 m; seams 0.63/0.64 m).
* `validate_geo_context.py` — 10/10 PASS. `validate_admin_font.py` —
  `all_pass` (exit 0).

## Size trade-off (authorized)

| archive | before | after |
|---|---|---|
| dem-terrarium.pmtiles | 208,401,064 B | 507,158,791 B (×2.43) |
| hypso.pmtiles | 28,820,267 B | 70,000,936 B (×2.43) |
| contours.pmtiles | 5,405,449 B | 11,574,790 B (×2.14) |
| public/data total | ~652 MB | 694.0 MB |

The accepted release ZIP (0e57) stays in releases/history; the previous
artifacts are preserved under
`.data/DEM-buffer-expansion/pre-expansion-backup/` with their SHA-256SUMS.
Historical docs (V1_1_0_Real_DEM_Pipeline.md etc.) are intentionally not
rewritten — this record documents the expansion.
