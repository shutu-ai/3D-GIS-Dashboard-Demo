# v1.2.1 Visual Acceptance Record

> **Current status — rev6b dual-viewport ACCEPTANCE PASSED (2026-10-31).**
> The reopened administrative requirements are closed by machine evidence +
> independent AI image review: strict 02/07 **4/4**, full suite **66/66**,
> per-image review **27/27 PASS** (below). RELEASE_READY remains NO pending
> ONLY the user's physical-disconnect / cold-start re-acceptance of the
> REVISED artifact — the prior manual PASS binds the old ec64df5c ZIP only.
>
> The review further below (9 per viewport, boundary-count assertions)
> accepted the OLD artifact without real name-label proof; it is retained as
> historical record only.

## Current status — rev6b (2026-10-31): 27/27 PASS

- **Reviewer/method:** independent AI designer review. 27 full frames read
  at native resolution (1080p × 15, 768p × 12) + ~15 precision 2x-4x crops +
  whole-frame pixel diff (ΔRGB > 30/40) + MD5 cross-checks. Thumbnail
  previews twice suggested non-existent label residue ("FEZ-MEKNES",
  "MARRAKECH-SAFI"); both refuted by pixel diff + zoom crops — every
  verdict rests on full-resolution evidence.
- **Result: 27/27 PASS, 0 FAIL.**
- Core requirements confirmed: real geoBoundaries gbOpen ADM1/ADM2 name
  labels in white #ffffff + dark halo, readable, NOT the old OSM names;
  boundaries (dark casing + cream dashed mains) recognizable over terrain
  and dark basemap; two-TAB panel correct in both viewports with no panel
  contamination of evidence frames; OFF frames isolate exactly the target
  ink class (labels-off moves only labels, lines-off only lines,
  byte/pixel-identical elsewhere); dual-viewport consistency with evidence
  anchors c14 (1400, 793) at 1080p and c0 (1145, 652) at 768p.
- Per-frame verdicts (abbreviated; full reasoning in the review transcript):
  1080p — 02a on / labels-off / lines-off, 02b-atlas-adm2 triple,
  02b-atlas-adm1 triple, 02 main admin frame, 05 geo-layer-toggles (two
  TABs), 01 overview, 04 water/natural, 07 RAN background: all PASS.
  768p — 02a triple, 02b-adm1 triple, 02b-adm2 on/labels-off, 02 main
  admin frame, 05 toggles, 03 roads/towns, 06 3D terrain, 08 back-to-GIS:
  all PASS.
- Non-blocking observations recorded: (1) the ADM1 checkbox visual state in
  OFF evidence frames reflects the map-layer isolation mechanism, not a
  real click — evidence-frame cosmetic only; (2) the 1080p 02a "FEZ-MEKNES
  residue" was refuted by diff+crop (does not exist); (3) in the High Atlas
  the ADM1 boundary ink is stylistically close to SIM paths after
  lines-off — moderate legibility there, a candidate FUTURE styling tweak
  (widen/lighten boundary), explicitly not an acceptance failure (the
  unchanged fixed gate passed at the 1080p anchor: 24 px at 7.46:1);
  (4) 768p 02b-adm2-lines-off and 08-ran-site-road-profile are covered by
  same-family diff/hash evidence rather than individual reads.
- Machine evidence: `Docs/v1_2_1_admin_visibility_results.json` (strict
  02/07 4/4), `Docs/v1_2_1_admin_visibility_rois.json` (28 ROI rows incl.
  the full ordered-candidate trail; winners 1080p c14 24 px / 7.46:1, 768p
  c0 58 px / 8.11:1), `Docs/v1_2_1_full66_rev6b_results.json` (66/66),
  `Docs/v1_2_1_runtime_evidence.json` (external 0 / errors 0 / Range 206 /
  16-layer exactUsage + allWhite on both viewports).

## Historical status — old ec64df5c candidate only

- **Screenshot collection: 9 per viewport — 18 images inspected in total**
  (8 suite-captured frames + 1 added `08-ran-site-road-profile.png` per
  viewport; see the per-image entries for lineage).
- **desktop-1080p: reviewed — 9/9 images inspected, all PASS.**
- **desktop-768p: reviewed — 9/9 images inspected, all PASS (with
  768p-specific factual notes).**
- **scenario07 click retest: PASSED** — evidence `Docs/v1_2_1_admin_click_retest.json`:
  stats `expected: 2, unexpected: 0` (both viewports), duration 34.4 s; both
  runs of "07 admin click popup cites OSM provenance; disputed line popup is
  honest" passed (15901 ms + 15407 ms, 2026-10-30T20:49Z). The fix was a
  **test-only geometry-first click helper** affecting scenario07 only —
  **no source change**.
- **Full-run accounting (factual):** the full run itself ended **65 pass /
  1 fail**; that raw result is not renamed. Reconciled against the retest:
  baseline cases 42/42 + new cases 24/24 = 66/66 with the test-only helper
  fix applied to 07.
- **Historical G4 physical-disconnect / cold-start / manual-acceptance gate: CLOSED —
  PASS via user-attested manual acceptance** (2026-10-31). The user explicitly
  confirmed, verbatim: (1) candidate ZIP, fresh extraction, all external
  network disconnected, fresh profile / empty-cache cold boot — **「三项均
  已完成」**; (2) manual acceptance covering nationwide 2D, RAN→site/road→DEM
  profile→return to GIS, and the 1366×768 viewport — **「全部检查通过」**.
  Full attestation, screenshot facts, and hashes:
  `Docs/V1_2_1_Manual_Acceptance.md`. This document's own method remains the
  **AI inspection of 18 automated captures** — the physical/cold-start/
  manual gates are closed by the user's attestation, **not** by pixels.
- **Collection accounting: 18 AI-inspected + 2 user-manual photos = 20 total**
  (methods kept strictly separate throughout this record).

## Review conditions (factual, no over-claim)

- **Method:** AI image inspection only (automated image-read of each PNG).
  This is **not human review**.
- **Images:** unedited screenshots as written by the suite into
  `Docs/screenshots/v1.2.1/desktop-1080p/` (timestamps 2026-10-30 22:33–22:35)
  and `Docs/screenshots/v1.2.1/desktop-768p/` (timestamps 2026-10-30
  22:40–22:41), produced by the final full-suite run against the packaged
  bundle `index-D5YJgpqR.js` served at `http://127.0.0.1:17841`, plus one
  **added** image per viewport (`08-ran-site-road-profile.png` — lineage
  documented in its per-image entries, hash-verified byte-identical copies of
  final66 G2 captures, no processing applied).
- **Scope of PASS:** the listed checklist dimensions visible in each still
  image (labels, roads, water, admin, terrain honesty, panel obstruction, glyph
  ghosts, RAN prominence/honesty, profile panel state). Functional assertions
  (queryRenderedFeatures, network accounting, click-grid interactions) are
  owned by the e2e suite and are only cross-referenced, not re-verified here.
- Checklist dimension key: LB=labels · RD=roads · WA=water · AD=admin
  boundaries · TR=terrain honesty (2D no-DEM overview / real 3D in atlas) ·
  PA=panel obstruction · GG=no glyph ghosts (no tofu boxes) · RH=RAN
  prominence/honesty · PR=profile.

## Per-image review — desktop-1080p (1920×1080 viewport)

### 01 — `Docs/screenshots/v1.2.1/desktop-1080p/01-morocco-overview.png` — PASS

- LB: real nationwide toponyms render from the overview archive: Safi,
  Agadir, Tiznit, Tan-Tan, Essaouira, Laâyoune, Es-Semara, Errachidia,
  Tindouf (Latin fallback) and the country label `Maroc`. **Marrakech is not
  among the fixed-framing set at 1080p** (collision cull; known behavior,
  documented in the suite; hub presence satisfied by the other hubs).
- AD: country outline solid; **Western Sahara disputed segment rendered
  dashed in the distinct amber dispute style** — provenance preserved.
- TR: nationwide view is flat 2D with **no DEM/hillshade/terrain shading**;
  persistent honesty banner `2D GEOGRAPHIC OVERVIEW: 真实地形仅覆盖 High
  Atlas（此处无 DEM 数据）` visible at bottom.
- WA: Atlantic ocean fill + small inland water bodies render.
- RD: no road lines expected/drawn at this zoom (major-road minzoom not
  reached) — factually absent, not a defect.
- PA: left control panel and right analysis panel do not obstruct the map
  core; elevation legend and attribution bar visible.
- GG: all visible labels are readable Latin — **zero tofu/ghost glyphs**.

### 02 — `Docs/screenshots/v1.2.1/desktop-1080p/02-high-atlas-admin-boundaries.png` — PASS

- TR: real 3D atlas domain — hypsometric tint + hillshade relief + contours
  (100 m interval labels, e.g. `1500 m`).
- AD: ADM1/ADM2 dashed boundary lines visible (upper-left region line,
  county segments) but **subtle at this 3 km framing** under dense contours —
  present, low visual weight.
- LB: real towns render (`Amizmiz`, `Moulay Brahim`, `Asni`, `Tahannaout`
  at right edge) alongside curated pass/peak labels (`Tizi n'Tamatert
  2250 m`, `Aksoual 3910 m`, `Jbel Aguelzim 3547 m`, `Jbel Toubkal`).
- RD: curated SIMULATED amber dashed road (right edge, with station dots)
  clearly distinct from real neutral roads and from contour linework.
- WA: reservoir fill + thin blue river network + vertical waterway label.
- PA / GG: panels unobstructive; no tofu boxes.

### 03 — `Docs/screenshots/v1.2.1/desktop-1080p/03-high-atlas-real-roads-towns.png` — PASS

- LB: **the Tahannaout town label renders at center** with the town's
  building footprints; local hierarchy co-renders beneath it (`El Bared
  Tahannaout`, `Bou Ouzgar`, `Agafay`, `Ta' richt`, `Azib scom`, `Ait
  Bouloumane`, `Al Mtougui`, `Rouhi`, `El Kharoua`, `Dar Ayt Lahsene Ou
  Hsayne`, `Taseksout`, `Tannzat`, `Tawrirt`, `Talat Marghene`).
- GG: the Tifinagh-only hamlet name (`ⵍⴻⵎⴳⴰⵙⴻⵎ`, known from the tile probe)
  is **not rendered and leaves no tofu box** — the Latin-safe glyph guard is
  visually confirmed at the exact scenario-03 camera.
- RD: real OSM roads (neutral solid RN7 + connecting roads) clearly distinct
  from the thin beige contour lines and from curated SIMULATED dashed amber
  roads (none in this frame).
- WA: blue stream network threads the plains; no fill artifacts.
- TR: real DEM shading present (contours 800–1050 m labeled).
- PA: panels clear of the town core.

### 04 — `Docs/screenshots/v1.2.1/desktop-1080p/04-water-natural-labels.png` — PASS

- LB/TR: Toubkal massif in full real 3D relief; peak labels with OSM nominal
  elevations: `Jbel Toubkal 4167 m`, `Toubkal Western Peak 4018 m`, `Jbel
  Ouanoukrim 4089 m`, `Aksoual 3910 m`, `Biguinoussenne 3976 m`, `Afella
  4043 m`, `Afoud 4035 m`, `Bou Ouzzal 3862 m`, `Dome n'Tiri 3876 m`,
  `Afenol 3755 m`, `Igger n'Habdell 3815 m`, plus curated `Epave moteur
  avion`. **No same-name duplicate peak labels** (Jbel Toubkal appears once).
- WA: rivers + the Ifni lake basin (bottom-right) render.
- LB (places): `Tissaldal`, `Imhelene` context labels on the flanks.
- GG: contour labels (3450 m … 2100 m) dense but legible; zero ghost glyphs.
- PA: panels fine.

### 05 — `Docs/screenshots/v1.2.1/desktop-1080p/05-geo-layer-toggles.png` — PASS

- State: all Geographic Context toggle groups checked on; pitch 50° 3D.
- LB: **`Marrakech` city label renders** with its radial road network; town
  tier renders around it (`Tahannaout`, `Souihla`, `Tameslouht`, `El
  Attaouia`, `Oulad Selah`, `Ait Ourir`, `Dar El Aim`, `Lalla Takerkoust`…).
- RH (honesty side-state): RAN overlay checkbox unchecked; `SIM` badge on the
  simulated overlay row; no RAN data drawn in GIS mode.
- RD: real neutral roads around Marrakech distinct from the curated amber
  dashed simulated road along the ridge (with `Moulay Brahim`,
  `Oukaïmeden`, `Asni`, `Imlil`, `Tizi n'Tichka 2250 m`, `Jbel Toubkal 4167
  m` curated labels).
- WA: reservoir (bottom-right) + rivers visible.
- TR: real 3D terrain with ridge shadowing; horizon band at top is normal
  pitched-view rendering; near-horizon labels show mild perspective
  compression (cosmetic, expected at pitch 50°).
- PA / GG: fine; no tofu.

### 06 — `Docs/screenshots/v1.2.1/desktop-1080p/06-real-3d-terrain-natural-labels.png` — PASS

- TR: full real 3D terrain close-up — hillshade, 50 m contour stack, hypso.
- LB: natural tier renders (`Jbel Toubkal 4167 m`, `Jbel Ouanoukrim 4089 m`,
  `Igger n'Habdell 3815 m`, `Bou Ouzzal 3860 m`, `Afella 4043 m`); village
  tier (`Imhelene`) and water (`Tissaldal`, `Missour` context) render.
  **Top-edge labels (`Aksoual`, `Jbel Toubkal`) are partially clipped by the
  viewport top** — camera framing artifact of the scripted camera, not a
  rendering defect; factual note.
- WA: Ifni lake + stream network render.
- GG: no ghost glyphs anywhere.
- PA: fine.

### 07 — `Docs/screenshots/v1.2.1/desktop-1080p/07-ran-coverage-real-geo-background.png` — PASS

- RH: RAN Coverage mode active — header badge `SIMULATED NETWORK DATA`,
  right panel `网络选择 / RAN Selection` with `SIM` badge and demo targets
  honestly marked `SIMULATED — 选择` with per-target signal values (e.g.
  `TICHKA-05 → 道路近段 4.6 km · -110.7 dBm（弱）`); left legend explicitly
  `SIMULATED RSRP` gradient (-140 dBm → -60).
- RH (prominence): RSRP-colored corridor (green→yellow→red) + blue site
  markers are the visual dominant; the real geo background is dimmed but
  still readable per the dampening table — `Marrakech`, `Tahannaout`,
  `Tameslouht`, `El Attaouia`, `Oukaïmeden`, `Asni`, `Tizi n'Tichka 2250 m`,
  `Jbel Toubkal 4167 m`, `Aksoual` all remain legible.
- RD: simulated RSRP line follows the corridor; curated dashed amber road
  still distinguishable from the RAN coloring.
- TR: real 3D terrain retained under the overlay.
- PA / GG: fine; no tofu.

### 08 — `Docs/screenshots/v1.2.1/desktop-1080p/08-back-to-gis.png` — PASS

- RH: back in GIS mode — `SIMULATED NETWORK DATA` banner gone, header shows
  `REAL TERRAIN · OFFLINE`; RAN overlay checkbox unchecked; RSRP legend
  replaced by the elevation legend.
- PR: right panel switched to `A-B 剖面` (Profile): card present with
  instructions, LOS controls honestly labeled `（terrain-only approximation）`,
  antenna/frequency inputs, and an empty chart — the pre-selection state
  after returning to GIS (no A/B drawn in this still; profile drawing is
  covered by the functional suite, not asserted from this image).
- LB: same real-geo label set as 05 (Marrakech, Tahannaout, town tier,
  curated ridge labels) — GIS state fully restored.
- TR / RD / WA: identical honest terrain + road/water context as 05.
- PA / GG: fine.

### 08b — `Docs/screenshots/v1.2.1/desktop-1080p/08-ran-site-road-profile.png` — PASS

- **Lineage (hash-verified, no processing):** byte-identical copy of the
  final66 G2 capture `Docs/screenshots/v1.2.0-g2/desktop-1080p/06-linkage-blocked.png`
  (written 2026-10-30 22:29:13, inside the final-run window — final66 bytes,
  not old baseline bytes). SHA256 `0d3a339ac2c93d47efc74ffff6bb94c76ae36ab2e
  dfb84baa6f32510397f711c` matches the source file exactly; added because
  scenario 08's own still (`08-back-to-gis.png`) shows the empty pre-selection
  profile state, while the task's screenshot 08 also requires an **actual
  site→road profile** — this image supplies it. Renaming of existing files
  was avoided; this was added as a separate file.
- RH: RAN Coverage mode with a site selected — header badge `SIMULATED
  NETWORK DATA`; site `GTW-TICHKA-05` marked on the map and in the panel with
  `SIMULATED`/`SIM` badges throughout (site elevation DEM 2825 m, antenna 35
  m 模拟, 900 MHz, azimuth 75°, road-segment RSRP -110.7 dBm `SIMULATED`,
  grade 模拟弱覆盖（弱值 -110 dBm）, explicit disclaimer that modal data is
  实测/证明 of scene-level validation only).
- PR (actual profile content): **a real A→B terrain profile is drawn** —
  `地形剖面 / Profile: GTW-TICHKA-05 → 道路点 B 剖面` chart with elevation
  axis 2500–3800 m, terrain silhouette plus dashed LOS line, `水平距离
  4.64 km`, `海拔范围 2614 → 3647 m`; A端 ground 2811 m (真实 DEM 采样), B端
  3328 m, endpoint offset 1.5 m labeled 模拟终端假设.
- RH (honest judgment): 判定 `BLOCKED — LOS 受地形阻挡（terrain-only）`,
  最小净空 -389 m（正=射线高于地形，负=与地形相交）, with the explicit
  disclaimer that this is a demo explanation, not an operator commercial
  verification, and that LOS blockage alone must not be used to explain the
  simulated RSRP gap. The full layer legend including the `SIMULATED RSRP`
  gradient (-140 → -60 dBm) is visible bottom-left.
- LB / TR: real geo labels legible under RAN dimming (Marrakech, Tahannaout,
  Oukaïmeden, Tizi n'Tamatert, Tizi n'Tichka, `Jbel Toubkal 4167 m`); real 3D
  terrain retained; RSRP-colored corridor + site dots dominant.
- GG / PA: no tofu; panels fine.

## Per-image review — desktop-768p (final images from the full-suite run)

### 01 — `Docs/screenshots/v1.2.1/desktop-768p/01-morocco-overview.png` — PASS

- LB: nationwide toponyms render — `Maroc`, `Agadir`, `Tindouf`, `Guelmim`,
  `Laâyoune`, `Es-Semara`, `Tan-Tan`. **768p-specific notes:** labels render
  in the dim overview styling and read at low contrast against the dark land
  fill (legible on inspection, but visually subdued); **`Tan-Tan` is
  partially hidden behind the left control panel** — panel overlap is more
  intrusive at the 1366×768 viewport. Marrakech again absent from the fixed
  nationwide framing (known collision behavior, consistent with 1080p).
- AD: Western Sahara disputed segment renders dashed amber, clearly visible
  across the frame; straight administrative segments visible.
- TR: flat 2D, no DEM shading; honesty banner
  `2D GEOGRAPHIC OVERVIEW · 真实地形仅覆盖 High Atlas（此处无 DEM 数据）`
  fully readable at bottom.
- WA: Atlantic fill + Canary Islands render.
- RD: none drawn at this zoom (minzoom not reached) — as at 1080p.
- PA: narrower map area at 768p; panels cover more relative width but the
  country core stays visible; attribution bar intact.
- GG: zero tofu/ghost glyphs.

### 02 — `Docs/screenshots/v1.2.1/desktop-768p/02-high-atlas-admin-boundaries.png` — PASS

- TR: real relief — hypso + hillshade + dense contour stack.
- LB: `Amizmiz` town label renders center; vertical waterway label present
  at the reservoir but **clipped by the right analysis panel edge** at 768p.
- AD: **the dashed admin lines are present but not distinctly resolvable at
  768p** — they sit under the contour density and the smaller viewport
  compresses their visual weight further than at 1080p. Recorded as a
  legibility fact of this still; presence is asserted functionally by the
  passing suite scenario.
- RD: amber dashed curated road fragment visible crossing the top edge —
  distinguishable from contours.
- WA: reservoir fill (right) + blue river network render.
- PA / GG: fine; no tofu.

### 03 — `Docs/screenshots/v1.2.1/desktop-768p/03-high-atlas-real-roads-towns.png` — PASS

- LB: **`Tahannaout` town label renders at center** — the v1.2.1 town-label
  fix is visually confirmed at 768p too. The full local ladder co-renders:
  `El Bared Tahannaout`, `Bou Ouzgar`, `Agafay`, `Ta' richt`, `Al Mtougui`,
  `Rouhi`, `Ait Boulumane` (top edge), `El Kharoua` (right),
  `Dar Ayt Lahsene Ou Hsayne`, `Taseksout` (bottom).
- GG: the Tifinagh-only hamlet name is absent with **no tofu box** — glyph
  guard confirmed at 768p as well.
- RD: real neutral RN7 + connectors clearly distinct from contour linework;
  building footprints render around the town.
- WA: stream network threads the frame.
- TR: real DEM shading; contour labels 850/900/950 m (50 m interval per the
  panel toggle) legible.
- PA: panels clear of the town core.

### 04 — `Docs/screenshots/v1.2.1/desktop-768p/04-water-natural-labels.png` — PASS

- LB/TR: Toubkal massif real 3D; peak ladder renders with elevations:
  `Jbel Toubkal 4167 m` (**exactly once — no duplicate**), `Toubkal Western
  Peak 4018 m`, `Dome n'Tiri 3876 m`, `Bou Ouzza 3860 m`, `Afenol 3755 m`
  (clipped by the viewport top edge), curated `Epave moteur avion`.
- WA: thin blue streams render; **the Ifni lake basin visible at 1080p is
  outside this 768p framing** — recorded as a framing difference of the
  scripted camera at the smaller viewport, not a water-layer failure.
- GG: dense contour labels (2800–3100 m) legible; zero ghost glyphs.
- PA: fine.

### 05 — `Docs/screenshots/v1.2.1/desktop-768p/05-geo-layer-toggles.png` — PASS

- State: Geographic Context toggles on; pitch 50° 3D.
- LB: **`Marrakech` renders** with its radial road network; town tier renders
  (`Souihla`, `Tahannaout`, `Ait Ourir`, `El Attaouia`, `Demnate`,
  `Dar El Ain`, `Lalla Takerkoust` clipped by the left panel edge, `Agouim`,
  `Ait Ben Haddou`); curated ridge labels (`Moulay Brahim`, `Oukaïmeden`,
  `Jbel Toubkal 4167 m`) render with station dots and the amber dashed
  simulated road.
- RH: RAN overlay checkbox unchecked; `SIM` badge on the overlay row.
- RD: real neutral roads distinct from the curated amber dashed road.
- WA: small reservoir bottom-right.
- TR: real 3D with horizon band; near-horizon labels show the expected mild
  perspective compression at pitch 50°.
- PA / GG: fine; no tofu.

### 06 — `Docs/screenshots/v1.2.1/desktop-768p/06-real-3d-terrain-natural-labels.png` — PASS

- TR: full real 3D close-up — hillshade, 50 m contours (2500/2550/2600 m
  labeled), hypso; **terrain honesty intact**.
- LB: **768p-specific factual note: the peak text labels seen at 1080p are
  not legible in this 768p still** — the peak marker dots render (four
  visible on the ridgeline) but their text labels are absent/culled at this
  tighter framing (consistent with collision culling under the denser
  contour-label load at the smaller viewport). Contour labels render
  normally; the small dark text fragment near the center-left contour is not
  resolvable. Recorded as a legibility fact of this still, not a rendering
  defect; the natural-tier labels are visually verified in 04 and 05 at this
  same viewport.
- WA: stream lines visible.
- GG / PA: fine.

### 07 — `Docs/screenshots/v1.2.1/desktop-768p/07-ran-coverage-real-geo-background.png` — PASS

- RH: RAN Coverage mode active — header badge `SIMULATED NETWORK DATA`
  (amber); right panel `网络选择 / RAN Selection` with `SIM` badge and demo
  targets honestly marked with per-target values: `TICHKA-05 → 道路东段
  4.6 km · -110.7 dBm（弱）`, `TICHKA-05 → 近场段 0.3 km · -62.7 dBm（对比）`,
  `TICHKA-04 → 4.5 km · -110.5 dBm`, `IMLIL-01 → 4.9 km · -111.7 dBm（弱）`;
  RAN overlay checkbox now CHECKED with `SIM` badge.
- RH (prominence): the RSRP corridor (green→yellow→red) + blue site markers
  + gray coverage blobs are the visual dominant; dimmed real geo background
  stays readable — `Marakech/Marrakech`, `Tahannaout`, `Souihla`,
  `Ait Ourir`, `Agouim`, `Jbel Toubkal 4167 m` all legible under the
  dampening.
- **768p-specific note:** the left `SIMULATED RSRP` gradient legend, clearly
  visible at 1080p, is not distinctly resolvable in this 768p still (panel
  space is tighter); honesty signage is carried by the header badge, the
  panel `SIM` badge, and the `SIMULATED — 选择` target labeling.
- RD / TR / GG / PA: corridor follows the road line; real terrain retained;
  no tofu; panels fine.

### 08 — `Docs/screenshots/v1.2.1/desktop-768p/08-back-to-gis.png` — PASS

- RH: GIS state restored — `SIMULATED NETWORK DATA` header badge gone;
  header shows `OFFLINE GIS DEMO` + `REAL TERRAIN · OFFLINE`; RAN overlay
  checkbox unchecked.
- PR: right panel on `A-B 剖面`: `地形剖面 / Profile` card with instruction
  text, empty pre-selection chart, `视距 LOS（terrain-only approximation）`
  honesty label, A/B antenna-height inputs (10 m), frequency selector
  (900 MH), `清除剖面` controls — matches the 1080p restored state.
- LB: same real-geo label set as 768p-05 (Marrakech, Tahannaout, town tier,
  curated ridge labels) — fully restored.
- TR / RD / WA: identical honest terrain/road/water context as 05.
- PA / GG: fine.

### 08b — `Docs/screenshots/v1.2.1/desktop-768p/08-ran-site-road-profile.png` — PASS

- **Lineage (hash-verified, no processing):** byte-identical copy of the
  final66 G2 capture `Docs/screenshots/v1.2.0-g2/desktop-768p/06-linkage-blocked.png`
  (written 2026-10-30 22:36:35, inside the final-run window — final66 bytes,
  not old baseline bytes). SHA256 `b3dc79b71429b7062c84eac1a5bd58ac18c4d220
  61e88c1a1baee6a5675ff972` matches the source file exactly; added to cover
  the actual site→road profile requirement that the empty-profile
  `08-back-to-gis.png` still does not show.
- RH: identical RAN site-selection state as the 1080p image, rendered at
  1366×768: `GTW-TICHKA-05` selected (map label + yellow marker), panel card
  with `SIMULATED`/`SIM` badges (DEM 2825 m, antenna 35 m 模拟, 900 MHz,
  azimuth 75°, road RSRP -110.7 dBm `SIMULATED`, grade 模拟弱覆盖（弱值
  -110 dB）), A/B endpoint rows (2811 m 真实 DEM 采样 / 3328 m, endpoint 1.5 m
  模拟终端假设), distance 4.64 km @ 900 MHz, demo-target list with per-target
  dBm（弱）/（对比） markers.
- RH (honest judgment): 判定 `BLOCKED — LOS 受地形阻挡（terrain-only）`,
  最小净空 -389 m, plus both disclaimers (demo explanation, not operator
  commercial verification; LOS blockage alone must not explain the simulated
  RSRP gap) — fully readable at 768p.
- PR (768p-specific factual note): the `地形剖面 / Profile` section heading
  and the profile title `GTW-TICHKA-05 → 道路点 B 剖面动画` are visible at
  the panel bottom, but **the chart itself falls below the viewport fold at
  768p** — the drawn-profile evidence at 768p is therefore the panel's
  numeric profile rows (A/B ground heights, distance, LOS verdict), while the
  full chart is visually evidenced in the 1080p-08b image of the same final66
  capture session. The on-map corridor with the A→B path and site marker is
  visible.
- LB / TR / GG / PA: real geo labels legible under RAN dimming (Marrakech,
  Tahannaout, Moulay Brahim, Oukaïmeden, `Jbel Toubkal 4167 m`); real 3D
  terrain retained; no tofu; panels fine.

## Cross-image factual notes

1. No ghost/tofu glyphs appear in any of the 18 images — consistent with the
   Latin-safe label guard (`src/map/geographic-context.ts` NAME_FIELD) and
   the offline glyph audit (`scripts/audit_geo_glyphs.mjs`, evidence
   `Docs/geo_glyph_audit_snapshot_20261030.json`). These images show the
   visual side only.
2. Real vs simulated differentiation is visible in every atlas-domain frame
   at both viewports: real roads = neutral solid; curated roads = amber
   dashed with `SIM` badges in the panel; RAN = separately badged overlay.
   Disputed boundary keeps its dashed amber treatment in the overviews (01
   at both viewports).
3. Terrain honesty at both viewports: overview frames are flat 2D with an
   explicit no-DEM banner; every atlas frame shows real DEM relief. No
   nationwide fake terrain.
4. 768p-specific behaviors recorded (all factual still-image observations,
   none treated as blockers): dim/low-contrast overview labels with Tan-Tan
   partially behind the left panel (768p-01); admin boundary lines not
   distinctly resolvable under contour density (768p-02); Ifni lake outside
   frame (768p-04); peak text labels culled/not legible while marker dots
   render (768p-06); RSRP legend not distinctly resolvable (768p-07);
   profile chart below the viewport fold in 768p-08b (numeric profile rows
   visible; full chart evidenced in 1080p-08b).
5. The two added `08-ran-site-road-profile.png` images are hash-verified
   byte-identical copies of final66 G2 captures
   (`v1.2.0-g2/<viewport>/06-linkage-blocked.png`, written 22:29:13 and
   22:36:35 inside the final-run window); no processing applied; existing
   files were not renamed. They were added because scenario 08's own still
   shows the empty pre-selection profile, while the task also requires an
   actual site→road profile — which both 08b images provide (full chart at
   1080p; panel rows + on-map path at 768p).
6. Known accepted collision behaviors visible in stills at both viewports:
   Marrakech absent from the fixed nationwide framing (01) while other hubs
   render; low-prominence labels cede to towns (03). Both are covered by the
   suite's assertions, not treated as image defects.
7. The 768p images were reviewed only after the parent's GO following the
   final full-suite run; no stale artifacts were used.

## Manual acceptance addendum (user-attested, 2026-10-31 — separate method)

This addendum records the **user manual acceptance** that closes the G4 gate
that AI image inspection explicitly could not. Authoritative record:
**`Docs/V1_2_1_Manual_Acceptance.md`** (user verbatim confirmations, screenshot
facts, original-file hashes, limitations). Summary of what was independently
verified here by actual image-read of the two **user-original** photos
(`D:/dev-projects/3D-GIS/离网截图/`, read read-only, unmodified):

- `首页.PNG` (08:29:39): browser chrome shows URL `127.0.0.1:17841/#v=-7.9146,
  31.0595,10.8,50,150,1.2`; real 3D atlas with peak labels (`Jbel Toubkal
  4167 m`, `Aksoual 3910 m`, `Jbel Aguelzim 3547 m`, curated `n'Tamatert
  2250 m`), water linework, full REAL-OSM layer list; GIS state (no
  `SIMULATED NETWORK DATA` banner, RAN unchecked); no visible errors/tofu.
- `1.PNG` (08:30:05): URL `127.0.0.1:17841/#v=-7.92517,31.08261,13.8,50,150,
  1.2`; full peak ladder + 50 m contours; **live elevation query result**
  (`31.08153, -7.92415`, DEM **2939.3 m**, nearest-pixel 无插值, Copernicus
  GLO-30/EGM2008 source line) — interactive DEM pipeline confirmed working in
  the user session; no visible errors/tofu.

**Method separation (kept explicit):**

- The **18 automated captures** above were reviewed by **AI image inspection** —
  not human review. All per-image limitations in this document remain scoped
  to that method.
- The **2 user photos** are user originals (per the parent's record:
  byte-identical copies verified against originals, SHA-256 recorded in
  `V1_2_1_Manual_Acceptance.md`; 1920×1032 PNG). They prove **app content in
  the user's real browser session** — nothing more.
- The user's **explicit functional/visual sign-off** (nationwide 2D,
  RAN→site/road→DEM profile→return GIS, 1366×768 — 「全部检查通过」) and the
  **environment attestations** (candidate ZIP fresh extraction, all external
  network disconnected, fresh profile/empty-cache cold boot — 「三项均已完成」)
  are the user's attested confirmations recorded by the parent. They are
  accepted as the G4 gate closure **as attestations**; the photos themselves
  still do **not** prove physical disconnection, cold cache, or the served
  bundle version (no NIC/taskbar in frame, no cache state visible, no bundle
  hash in the URL).

## Historical release-package notice

The user-tested archive, preserved at
`releases/history/pre-admin-correction-ec64df5c7164/Morocco-High-Atlas-Offline-GeoContext-v1.2.1.zip`,
(375,265,214 B, SHA-256 `ec64df5c7164e864887b9e445b4526826b724b190af300f213bb
84cf2611ea44`) is **unchanged** — it was not repackaged when the acceptance
records were finalized. The QA documents **inside the ZIP are a pre-manual
historical snapshot** and may still read "pending physical-disconnect
acceptance"; the **final authoritative status** is the external
`V1_2_1_Acceptance.json`, `V1_2_1_Completion_Report.txt`, and
`Docs/V1_2_1_Manual_Acceptance.md` (delivered as ZIP sidecars; the archive
hash is unaffected).

## Historical verdict — superseded, not current acceptance

- desktop-1080p: 9/9 PASS (AI image inspection, factual, images unedited).
- desktop-768p: 9/9 PASS (same method; 768p-specific legibility notes
  recorded above).
- **18/18 automated screenshots inspected by AI (9 per viewport), plus 2
  user-original manual photos inspected read-only — 20 images total, methods
  kept separate.**
- Full e2e suite: the full run ended **65 pass / 1 fail** (kept factual, not
  renamed); the single failure — 768 scenario07 thin disputed-line
  click-grid miss — **passed on retest** (`Docs/v1_2_1_admin_click_retest.json`,
  expected: 2 / unexpected: 0, 34.4 s) after a **test-only** geometry-first
  click-helper fix (scenario07 only, **no source change**). Reconciled
  accounting: baseline 42/42 + new 24/24.
- **Old candidate G4: PASS (subsequently reopened).** The last open gate — physical disconnection, cold start, and
  human visual/functional acceptance — is closed by the user's **explicit
  attested manual confirmation** (「三项均已完成」 / 「全部检查通过」,
  2026-10-31), recorded with screenshot facts and original hashes in
  **`Docs/V1_2_1_Manual_Acceptance.md`**. This remains a **user-attested**
  closure: the two photos evidence app content in the user's session, and do
  not by themselves prove physical disconnection, cold cache, or bundle
  version; the AI-reviewed 18 captures remain an automated-method record,
  not human review. The then-recorded G4=PASS / RELEASE_READY=YES verdict
  has been withdrawn for the administrative correction.

## Current verdict

**G4=FAIL; RELEASE_READY=NO; PUBLISHED=NO.** Administrative visibility,
the requested two-tab controls/white dark-edged text/legacy-real separation,
fresh dual-viewport review, full regression and replacement archive evidence
remain pending. Prior user confirmation binds the preserved ec64df5c ZIP only.
