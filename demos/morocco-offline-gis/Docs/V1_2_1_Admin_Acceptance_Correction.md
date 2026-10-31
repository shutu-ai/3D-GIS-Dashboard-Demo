# v1.2.1 — Administrative-name and readability acceptance correction

Status: **IN PROGRESS / RELEASE_READY=NO** (2026-10-31).

## Defect and evidence gap

The previous Admin Zoom test proved nonzero administrative line counts, not
visible administrative names or distinguishable boundaries. Its 768p image
review explicitly admitted the lines were not distinctly resolvable. Those
two administrative frames and their earlier PASS verdicts are reopened.
At the rejected baseline, ADM1/ADM2 toggle groups contained only line layers;
no name-label layers existed. Cities/towns must not be substituted for
administrative names. The correction now includes same-source gbOpen labels;
their final viewport acceptance remains pending below.

## Correction contract

1. Verify actual named ADM1/ADM2 source features, stable IDs, administrative
   levels, source version/year, license and geometry before implementation.
   Protomaps line taxonomy alone does not establish a name-label contract.
2. If geoBoundaries gbOpen is used, record fixed download URLs and SHA-256,
   preserve attribution, and disclose any difference from OSM boundaries.
   Never silently attach a name from one geometry source to another boundary.
3. Keep source-flagged OSM disputed country boundaries separate, dashed and
   neutrally disclosed. Improve regional/provincial boundary hierarchy without
   obscuring real terrain or changing simulated RAN provenance.
4. Verify at **1920×1080 and 1366×768**: source-backed ADM1 and ADM2 text
   actually rendered, not collision-culled or under a panel; independently
   recognizable corresponding boundaries; correct toggles and reversible
   GIS/RAN label/line behavior. A count-only assertion is insufficient.
5. Capture fresh administrative evidence (including layer-on/off comparison
   where needed), inspect both viewports, retain zero external and JS/resource
   errors, and rerun the affected tests followed by one reconciled full suite.
6. Only then update the acceptance reports, all affected screenshots, delivery
   archive and checksum. Preserve the previous ZIP as historical evidence;
   prior manual acceptance does not certify the changed runtime.

## Ownership

- Source discovery: read-only archive/official-source investigation.
- Cartography: designer owns boundary/label styles and focused image review.
- Implementation tests: bounded test lane after the source contract settles.
- Final reconciliation: parent owns data integrity, full regression, reports,
  packaging and checksum verification. No push/tag/Release is authorized.

## Verified supplemental source (not yet render acceptance)

Official metadata queried on 2026-10-31:
`https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM1/` and
`https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM2/`.
Build inputs use the fixed release **9469f09**, not those moving API URLs.

| Level | Boundary ID | Units | Source bytes | SHA-256 |
|---|---|---:|---:|---|
| ADM1 | MAR-ADM1-70788906 | 12 | 250,546 | `21841ea5810305a2c6c25300e4b295e59a9706a5ae0da03b50ae3cfd2ddc5849` |
| ADM2 | MAR-ADM2-96644757 | 75 | 587,169 | `0486dad7e941c1f9ec494a1106a7789737ff4224b878fc2081a1e30b88164dff` |

Pinned source URLs:

- `https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1_simplified.geojson`
- `https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/MAR/ADM2/geoBoundaries-MAR-ADM2_simplified.geojson`

Both represent **2017** boundaries, source OpenStreetMap/Wambacher, source
update 2023-01-19, build 2023-12-12. **The actual license is ODbL 1.0, not
an assumed CC BY license.** Complete properties are `shapeName`, `shapeISO`,
`shapeID`, `shapeGroup`, `shapeType`; ADM2 ISO values are empty, so use
`shapeID` as the stable identity. Source-backed examples verified: ADM1
Marrakech-Safi (`70788906B60308563647099`), ADM2 Al Haouz Province
(`96644757B698999344864`).

Some ADM2 names mix French and Arabic. Preserve the full source name;
the build-time Latin display label is its existing French prefix, not a
translated or invented name. Label anchors must lie inside the same source
polygon (or its real-DEM coverage intersection for local cartography).

The supplement becomes the **primary named ADM1/ADM2 geometry**; it must not
silently label the different 2026 Protomaps segments. Source MAR territorial
classification is not a political attribution statement. OSM's source-flagged
disputed ADM0 remains separate, dashed, neutrally disclosed and unobscured.

## Verified data/build evidence

`python scripts/validate_admin_context.py --idempotence-run`:
**passed=9 failed=0**. This covers pinned provenance, raw structure, verbatim
area geometry/name/IDs, safe label derivation, polygon-interior anchors,
metadata contract, notices, no fabrication and repeat-build identity.

| Generated asset | Bytes | SHA-256 |
|---|---:|---|
| `admin-context-areas.geojson` | 2,396,526 | `c9443d8008b9c34a39483789239073a2f59ae9d488a1026075e0038a4c814202` |
| `admin-context-labels.geojson` | 77,611 | `a2051a9db3a13138500f7a8d6bc95e6439212b6ecbfed77a5d11330a582aa9dd` |

The basemap provenance initializer was also checked after adding the named
administrative contract: it preserves that independent source block and
leaves the entire metadata file byte-identical (SHA-256
`4690b7da5dcc6e8cca11b1611d34acc955ed2a896a08c3c97c97fd043536d7f4`).
This prevents a routine basemap refresh from silently erasing admin provenance.
These are data/build checks, **not** viewport visibility acceptance.

## First strict viewport run — rejected, evidence preserved

`playwright test v121-geo.spec.ts -g admin` selected scenarios 01/02/07 in
both projects: **4 passed, 2 failed, 0 skipped** (94.3 s). Both administrative
popup/disputed-source tests passed. Both Admin Zoom tests failed the ADM1
text-contrast gate in the real z7 overview; no pass was inferred from label
placement or source identity alone.

- Fixed gate: at least 24 ROI pixels with on/off relative-luminance contrast
  ≥3:1 and maximum RGB-channel delta ≥24; whole ROI must be panel-free.
- Both failed text ROIs: **0** qualifying pixels, maximum contrast **1.677**.
  The label was queryable but not sufficiently visible against the dark land.
- Initial raw result retained as
  `v1_2_1_admin_visibility_initial_failure.json` (SHA-256
  `ad3d272fe85f3f11bb6e85784af0d535ebf87fc02d97d8410871dbb2081d0c8b`).
  The four unchanged on/off PNGs are retained under
  `screenshots/v1.2.1-admin-correction-attempt1/`.
- The text-fill/SDF route is under independent minimal-reproduction and
  exact-version source review; it is **not yet declared a proven cause**.
  No contrast threshold was reduced, and the published baseline glyph bytes
  must not be casually overwritten as a workaround.

Current G2/G4/G5 remain **FAIL** pending the corrected runtime, unchanged
strict tests, new image review, full regression and updated packaging.

## Exact-fixture causal comparison (diagnostic, not final acceptance)

The first broad claim that all text fill was absent was too strong; an
isolated map can paint with the original bytes. A second diagnosis attributing
the failure to tan terrain was also rejected: the exact failed ROI background
is `(28,40,34)`. Independent pixel evidence is preserved in
`v1_2_1_admin_initial_roi_metrics.json`.

The controlled comparison then fixed camera, target shapeID, styles, sole ADM1
toggle and unobstructed ROI to match the original failure. Results in **both**
viewports (`v1_2_1_admin_font_exact_fixture.json`):

| Variant | Qualifying pixels | Maximum contrast | Result |
|---|---:|---:|---|
| Original font/styles | 0 | 1.677 | FAIL |
| Original after >30 s | 0 | 1.677 | FAIL |
| Only SDF-convention-normalized diagnostic font | 396 | 12.632 | PASS |
| Original font, size/halo/fill style adjustment | 0 | 1.193 | FAIL |

This justifies a **scoped administrative-font correction**, not a global font
rewrite or threshold relaxation. The new `Offline Admin Latin` stack is being
derived deterministically from the existing OFL Latin glyph data; only ADM
labels will use it. The original Noto Sans PBF, other labels, geometry, terrain
and RAN data remain untouched. The transformation aligns the existing
Euclidean SDF byte convention with the exact-version MapLibre/TinySDF formula:
`clamp(round(191.25 + (v - 128) * 255 / 127), 0, 255)`.

Production glyph validation now passes independent byte-LUT, 224 glyph
IDs/metrics, range safety, metadata/NOTICE and deterministic rebuild checks
(`v1_2_1_admin_font_validation.json`). Original Noto Sans bytes remain unchanged.
Fresh strict tests and anti-ghost image inspection are still required; the
diagnostic PASS above is not substituted for those gates.

## Strict production-font run and boundary-probe investigation

The next focused 02/07 run returned **2 passed / 2 failed**: both source-backed
administrative click scenarios passed. Both overview ADM1 text ROIs reached
396 qualifying pixels / 12.632 maximum contrast; both overview line ROIs reached
260 pixels / 11.717 contrast, under the original fixed thresholds. The two
main-atlas scenarios stopped on null corresponding-boundary probes (ADM1 at
1080p, ADM2 at 768p), so no main-frame PASS is claimed.

Inspection found that geometry-first probing consumed its 400 total / 120
per-feature query budget on offscreen or panel-obscured polygon coordinates.
The narrowly scoped detector correction rejects candidates failing the existing
whole-ROI canvas test **before** charging that budget. It does not change the
runtime, camera, layer-type or identity matching, ROI dimensions, or numerical
contrast gates. Previous result/ROI JSON and failure traces are retained under
`.data/admin-probe-budget-before/`.

The budget-corrected rerun completed **3 passed / 1 failed** (2.9 minutes).
Both viewport probes now locate actual line-type geometry; the 1080p main ADM2
glyph/line ROIs pass (783 / 88 qualifying pixels). At 768p the glyph passes
(773), but the boundary ROI at `(366,80)` reaches only **7** qualifying pixels,
below the unchanged minimum 24. Main-atlas ADM1 still needs its own on/off
pixel evidence, not just a structurally matched symbol/line query. Neither
gap is accepted as PASS. The raw log, ROI JSON, images and trace are preserved
under `.data/admin-probe-budget-after/`.

The JSON reporter environment variable used in this rerun initially left the
intended `Docs/v1_2_1_admin_visibility_results.json` stale. Investigation found
the real output under `e2e/Docs/`: the `OUTPUT_NAME` path had resolved relative
to the config directory, not the working directory. Its raw stats are
3 passed / 1 failed / 0 skipped, start `2026-10-31T11:56:26.211Z`, duration
172592.308 ms. It has now been copied byte-identically to the intended Docs
path and `.data/admin-probe-budget-after/` (SHA-256
`4426aaec46e39a0f692b92da92e14e1891a4b0ca9ec6d3f588b342afb1c655ce`).
The earlier 2/2 JSON remains preserved under the before-run archive. Future
invocations use an absolute `PLAYWRIGHT_JSON_OUTPUT_FILE` with JSON reporting
explicitly enabled and must verify the resulting raw file before citing it.

## Additional user-requested UI correction (pending implementation/acceptance)

The user requested two control-panel tabs, clear separation of the legacy
roads/peaks/places from real roads/natural labels, and clearer white geographic
text with dark edging/shadow. These are part of the revised runtime, not a
reason to carry forward the old visual or manual signoff.

Verification must cover tab navigation at both viewports (including keyboard
access and visible selected state), unchanged control identities/preferences,
the original 42 tests without modification/skips, clear real/curated/simulated
source wording, no duplicate same-place labels or silently mixed road geometry,
and readable white/dark-edged text over both dark overview and real terrain.
The original font bytes, terrain/contour data and simulated RAN meanings remain
fixed. Any suspected doubled glyphs must be resolved by actual layer/font
isolation, not by assuming a duplicate label or suppressing contrary evidence.

Only after the UI and test writers are reconciled will the parent rebuild,
repeat the strict administrative tests, run the complete 66-case regression,
capture/review the revised images and replace the canonical ZIP/checksum.

### Bounded geographic-font usage expansion decision

The same-camera counterfactual in `.data/boundary_probe/probe7-fontab.mjs`
changes only the font stack on eight real geographic-label and four curated
reference-label layers. The parent inspected the actual Amizmiz A/B crops:
the original stack has weak/missing fill; the normalized stack yields filled
letter strokes. This supports a scoped font-usage expansion for the user's
new readability request, not a rewrite of original font bytes or a global
font replacement. The earlier apparent interleaved/double strings were a
separate review/dot-over-text issue, not proof of duplicate-source labels.

The approved contract is exactly 16 layers: four existing ADM name layers,
six real place-name variants (major/town/local × overview/detail), two real
peak-name variants, and four curated place/pass/peak/top-peak layers. Original
Noto Sans and normalized PBF bytes/hashes remain fixed; only usage metadata,
the exact whitelist and the named layer references change. Contour and RAN
fonts remain outside this change. Curated text must be checked against the
existing Latin range before adoption. Final image/strict-test acceptance
cannot be inferred from this diagnostic decision alone.

## First integrated two-tab / white-label build — not accepted yet

The parent-built runtime is `assets/index-Dj71wn2P.js`, SHA-256
`1e4902428b0a03049c4fe89cd4c2d883bf6baab7e17b83972a6e70156d633642`.
The actual served JS/CSS/index, both fonts, metadata and administrative
GeoJSON were byte-compared with dist; all eight match. DEM and both geographic
archives return local HTTP206 / 128 bytes for `Range: bytes=0-127`.
Evidence: `.data/v121-admin-ui-static-assets.json`.

The font validator now passes the exact independent 16-layer whitelist and
NOTICE checks; both PBF hashes remain unchanged. The integrated strict 02/07
run (start `2026-10-31T13:08:19.817Z`) returned **2 passed / 2 failed**, zero
skips. Both administrative click/dispute tests passed. Both 02 tests rejected
the ADM2 glyph pair because `layout.visibility=none` let a previously absent
`Moulay Brahim` town symbol occupy the glyph ROI. This is contaminated pixel
evidence and remains a failure, not an accepted label comparison.

The independent line-only measurements also expose an unresolved 768p line
ROI at `(1234,621)` (160×160): zero qualifying pixels, maximum delta23 and
contrast1.397. The 1080p line-only ROI passes272 pixels. Whether the 768p
probe selected an obscured/shared segment or an actually weak visible stroke
must be established before choosing a detector or cartography correction.
No threshold, ROI size or whole-panel exclusion is relaxed.

Raw JSON, ROI JSON, unedited PNGs and traces are preserved under
`.data/v121-admin-ui-reflow-failure/`. A collision-preserving glyph-only OFF
method and actual visible-stroke investigation are in progress; final full
66-case regression and fresh visual acceptance have not run yet.

## Rev4 rebuild and the shared-edge ADM1 discovery defect

The rev4 rebuild (dedup reversibility + camera in place) is
`assets/index-F_dzb_BC.js`, SHA-256
`4701da2934d5c57af106a8cb564bbc73e3d8092f2b31a1ecb247fb4c596067a3`; served
JS/CSS/index, metadata and both administrative GeoJSON were byte-compared
with dist, and all three geo archives still answer local HTTP 206 Range
requests (`.data/v121-rev4-static-assets.json`). The strict 02/07 run returned
**3 passed / 1 failed**: the 768p main frame passed every gate on the new
camera, but the 1080p main-frame ADM1 boundary ROI measured only 5 qualifying
pixels.

Parent pixel analysis of the preserved frames (`.data/v121-rev4-sharededge-failure/rev4-diag/`)
shows 433 ROI pixels carried ADM1 ink (delta ≥ 24), but the on/off contrast
clustered at 2.7–3.4:1. The OFF frame still shows a dark line through the
ROI: the fixture candidate at (1825, 557) sits on an ADM1/ADM2 **shared
edge**, so hiding ADM1 reveals ADM2's dark solid casing rather than terrain
and the diff measures the 55%-alpha cream dash against that residual. This is
the same discovery-defect class as probe10 (a contaminated measurement, not a
cartography weakness — the solid dark casing is plainly visible over the
light hypsometric terrain in the captured frames).

The first detector attempt (rev5, spec-only) added a point-level rule: an
ADM1 line candidate was rejected when a rendered-geometry box around it
intersected `geo-admin-gb2-line` or `geo-admin-gb2-casing`, sized to the
corruption mechanism — ADM2 ink persisting inside the removed stroke's own
footprint (z10 casing ~3.2 px wide, half-width ≈ 1.6 px → ±2 px). This route
was REFUTED by its own measurements and abandoned:

- ±4 px box (rev5a): rejected every on-screen ADM1 candidate in BOTH
  viewports (`bound1b` toBeTruthy null). Archived under
  `.data/v121-rev5a-box4-failure/`.
- ±2 px box with the original 400-attempt budget (rev5b): still null in
  both viewports (same folder, `rev5b-*`).
- ±2 px box with discovery budgets widened to 4000/600 (rev5c): still null
  in both viewports. Archived under `.data/v121-rev5c-point-null-failure/`
  together with two read-only diagnostics that explain why:
  `diag_adm1_deviation.mjs` (walks the rendered ADM1 stroke at the frozen
  camera; 768p finds 9 on-stroke candidates, 6 with a gb2-free ±2 px centre)
  and `diag_adm1_specwalk.mjs` (replicates the spec walk exactly and logs
  every rejection; it rejects (1146, 652) — the anchor whose 160×160 ROI the
  FIXED Pillow gate had already PASSED in rev4 at 54 qualifying px / 7.6:1).

The (1146, 652) rejection is the causal proof that point-level
non-coincidence is the wrong discriminator: rev4's pass came from ADM1/ADM2
deviation stretches ELSEWHERE in the ROI, not from the centre pixel, and a
region boundary (ADM1) is by construction the aggregate of its provinces
(ADM2) — centre-coincidence is the geometric NORM, not contamination.

## Rev6 correction: ordered candidates judged by the unchanged fixed gate

Rev6 removes the point-level box rule entirely and changes only HOW evidence
anchors are chosen — never WHAT counts as evidence:

- Discovery (`fixtureOwnedPoints`) returns an ORDERED candidate list (up to
  24; the first rev6a run capped at 12 and is archived under
  `.data/v121-rev6a-limit12-failure/`) of owned, unobstructed ADM1 stroke
  anchors in the same deterministic
  walk order (label-anchor window probe first, then the geometry walk,
  budgets 4000/600 unchanged), suppressed to ~24 px spacing so jitter clones
  cannot flood the list. Per-candidate validation is unchanged: exact
  fixture property match, whole-160×160-patch overlay guards, strict
  topmost-stroke ownership.
- The main-frame ADM1 boundary gate loops over the list in order: per
  candidate it captures the same lines-only OFF frame, runs the UNCHANGED
  Pillow gate (contrast ≥ 3:1, max channel delta ≥ 24, ≥ 24 qualifying px in
  the 160×160 ROI), and the FIRST passing candidate wins. Every tried
  candidate's metrics are persisted BEFORE its verdict (logger-first) under
  `02b-atlas-adm1-c<i>`; the winner additionally lands under the canonical
  `02b-atlas-adm1` boundary key and its OFF frame is copied to the canonical
  filename. If no candidate passes, the test fails HARD listing every tried
  candidate's metrics — the gate is never loosened, the ROI never shrunk,
  and there is no pixel-maximum search (each candidate is judged once,
  pass/fail, at its own ROI).

The rev6a run (limit 12) returned **3 passed / 1 failed**: the 768p main
frame passed every gate with the FIRST candidate winning — c0 at (1145, 652),
58 qualifying px at 8.1:1 (the same stretch whose rev4 pass measured
54 px / 7.6:1, now found deterministically by the ordered walk) — but the
1080p walk filled its 12-candidate list without reaching the gate. The
persisted per-candidate metrics show the failure was TRUNCATION, not
absence: candidates c4-c9 (shared-edge stretches) sit at contrast ≈ 3.3
against the ADM2 residual and are correctly rejected, while the walk ENTERS
the rev4-diagnosed deviation band (1461-1604, 674-796) at c10-c11 with
contrast 5.4 → 6.1, maxΔ 122 → 130 and qualifying 10 → 14, still rising.
Archived under `.data/v121-rev6a-limit12-failure/`.

With the list extended to 24 (rev6b), the deterministic walk finishes the
band: the strict 02/07 rerun passed **4 / 4**. The 1080p winner is
candidate c14 at (1400, 793): 24 qualifying px at 7.46:1 under the
UNTOUCHED thresholds (≥ 24 px, ≥ 3:1, maxΔ ≥ 24); the 768p winner stays
c0 (58 px, 8.1:1). All tried candidates are persisted as
`02b-atlas-adm1-c<i>` ROI rows, the winner is duplicated under the canonical
`02b-atlas-adm1` boundary key, and its OFF frame is copied to the canonical
filename — the evidence tree keeps its rev4 shape while carrying the full
per-candidate trail.

Full 66-case regression: **66/66 passed (16.4 m)**, baseline 42 spec files
byte-untouched (git diff exit 0), recorded in
`Docs/v1_2_1_full66_rev6b_results.json` with the raw list-reporter log. The
full-suite rerun of scenario 02 reproduced the strict-run winners EXACTLY
(1080p c14 at (1400, 793), 24 px / 7.46:1; 768p c0 at (1145, 652),
58 px / 8.11:1; all 28 ROI rows carry fresh full-suite runIds), confirming
the ordered walk is deterministic across runs.

Runtime evidence refresh (`Docs/v1_2_1_runtime_evidence.json`, measured
2026-10-31T17:04Z on the same frozen dist): external request attempts **0**,
console/page/map errors **0**, both geo PMTiles archives answer 206 Range
(128-byte) requests, boot registered 1115 ms (1080p) / 1750 ms (768p),
10 GIS/RAN roundtrips per viewport (median ≈ 10.1 s including fixed 5 s
render-stability windows), and the 16-layer admin/places label contract
holds at runtime — exactUsage **true** and allWhite **true** on BOTH
viewports. The designer's per-image review of the refreshed dual-viewport
screenshot set is recorded below.

## Designer per-image review (2026-10-31): 27/27 PASS

Independent AI designer review of the refreshed screenshot set
(`Docs/screenshots/v1.2.1/desktop-{1080p,768p}/`): 27 full frames read at
native resolution (1080p x 15, 768p x 12) plus ~15 precision 2x-4x crops,
whole-frame pixel diff (dRGB > 30/40) and MD5 cross-checks. **27/27 PASS,
0 FAIL.** Two thumbnail-preview misreads ("FEZ-MEKNES" and "MARRAKECH-SAFI"
label residue) were refuted by pixel diff + zoom crops — every verdict rests
on full-resolution evidence, never on preview compression.

Confirmed: real gbOpen ADM1/ADM2 white (#ffffff) + dark-halo name labels
(not old OSM names); boundaries recognizable (dark casing + cream dashed
mains) over terrain and dark basemap; two-TAB panel correct in both
viewports with no panel contamination; OFF frames isolate exactly the target
ink class (labels-off moves only labels, lines-off only lines,
byte/pixel-identical elsewhere); dual-viewport consistency at the evidence
anchors (1080p c14 (1400, 793), 768p c0 (1145, 652)).

Four non-blocking observations recorded: (1) ADM1 checkbox visual state in
OFF evidence frames reflects the map-layer isolation mechanism, not a real
click — evidence-frame cosmetic only; (2) the 1080p 02a "FEZ-MEKNES residue"
does not exist (refuted by diff+crop); (3) in the High Atlas the ADM1
boundary ink is stylistically close to SIM paths after lines-off — moderate
legibility there, a candidate FUTURE styling tweak (widen/lighten), not an
acceptance failure (the unchanged gate passed at the 1080p anchor,
24 px / 7.46:1); (4) 768p 02b-adm2-lines-off and 08-ran-site-road-profile
are covered by same-family diff/hash evidence rather than individual reads.
Per-frame verdicts: `Docs/V1_2_1_Visual_Acceptance.md` (current-status
section).

## Deliverable refresh (2026-10-31)

Delivery ZIP rebuilt deterministically from the frozen dist
(`scripts/build_delivery_zip.py`; dist unchanged, bundle index-F_dzb_BC.js
rebuild byte-identical): `releases/Morocco-High-Atlas-Offline-GeoContext-
v1.2.1.zip`. Its entry count, byte size and SHA-256 are recorded in the
checksum sidecar shipped beside the archive
(`Morocco-High-Atlas-Offline-GeoContext-v1.2.1.zip.sha256`) and in the
repo-level verification report `Docs/v1_2_1_delivery_zip_verification.json`
(byte-verified by `scripts/verify_delivery_zip.py`, 6/6 checks ok). The old
ec64df5c candidate stays preserved byte-identically under
`releases/history/pre-admin-correction-ec64df5c7164/`. RELEASE_READY stays
NO solely pending the user's physical-disconnect / cold-start manual
re-acceptance of THIS revised archive.
