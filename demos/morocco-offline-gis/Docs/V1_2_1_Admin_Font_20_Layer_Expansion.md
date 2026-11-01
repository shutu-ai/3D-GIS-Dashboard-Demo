# V1.2.1 — Admin Font Usage Contract: 16 → 20 Layer Expansion

Date: 2026-11-01 · Scope: authorized widening of the `Offline Admin Latin`
corrected-SDF usage whitelist (data/contract change only — **glyph PBF bytes
unchanged**).

## Reason

User feedback screenshots (S9 series, 2026-10-31/11-01) still showed **black
contour elevation digits** on the baseline `Noto Sans Regular` stack after the
16-layer fix. The lead formally authorized extending the corrected-SDF usage
from the exact 16-layer whitelist to an exact **20-layer** whitelist.

## New layers (exactly 4)

| layer id (`used_by_layers`) | `LAYER_IDS` key | source |
|---|---|---|
| `contour-labels` | `contoursLabel` | `src/config.ts` (HEAD) |
| `contour-labels-minor` | `contoursLabelMinor` | `src/config.ts` (HEAD) |
| `ran-site-labels` | `ranSiteLabels` | `src/config.ts` (HEAD) |
| `ran-site-labels-selected` | `ranSiteLabelsSel` | `src/config.ts` (HEAD) |

Correction note: the task brief named one layer `ran-selected-label`; the real
config id is **`ran-site-labels-selected`** and the contract uses the real id.

## What changed (contract only)

* `scripts/prepare_admin_font.py`: `USED_BY_LAYERS` 16 → 20 (4 appended in the
  order above); manifest `note` and `NOTICE.md` header updated to
  "20 whitelisted … (4 ADM + 8 real geo + 4 curated osm + 2 contour + 2 RAN
  site labels)".
* `scripts/validate_admin_font.py`: `APPROVED_USAGE_LAYERS` independently
  re-pinned to the same exact 20; check keys renamed to
  `usage_whitelist_exact_20` / `notice_lists_all_20_layers` — still strict
  equality (`==`), no loosening, any further widening fails validation.
* Regenerated: `public/data/metadata.json`
  (`geo_context.administrative_label_font.used_by_layers` = 20 entries),
  `public/assets/glyphs/Offline Admin Latin/NOTICE.md`,
  `Docs/v1_2_1_admin_font_structural_validation.json`.
* `scripts/measure_geo_context.mjs`: **no change** — it reads
  `contract.used_by_layers` dynamically.

## Bytes unchanged (proof)

* Baseline input `public/assets/glyphs/Noto Sans Regular/0-255.pbf`:
  SHA-256 `a658f4ca95dbdaa9d54bc10a9bde07cfcb6a42317bcf55bdd1e8e46a4be59715`
  (pinned, re-verified by builder and validator).
* Derived output `Offline Admin Latin/0-255.pbf`: SHA-256
  `2ee61f0000cfc63ca24462aa08c599a8f512b968d24bfc78c797288e6edede3b`
  — identical before and after the expansion (the whitelist lives only in the
  metadata manifest and NOTICE text, never in the PBF). 224 glyphs, metrics
  preserved.

## Verification results (2026-11-01)

* `python scripts/prepare_admin_font.py` run 1: input SHA OK, output SHA
  identical, metadata `updated`.
* `python scripts/validate_admin_font.py`: `all_pass: true`, exit 0
  (incl. `usage_whitelist_exact_20`, `notice_lists_all_20_layers`,
  `rebuild_byte_identical`).
* Builder run 2 (idempotency): metadata `unchanged`; `metadata.json` and
  `NOTICE.md` byte-identical across runs.

## History preservation & integration status

Prior 16-layer conclusions in `V1_2_1_Admin_Font_Encoding.md`,
`V1_2_1_Admin_Acceptance_Correction.md` and the existing acceptance/completion
records are untouched — this record documents an authorized widening, not a
revision of earlier acceptance status or evidence.

The designer has updated `src/map/map.ts`: the four new layers now use
`[ADMIN_FONT_STACK]`, white fill and a dark halo. The contour layers retain
along-line placement. Production rebuild, runtime exact-usage verification
and visual checks remain pending; source and metadata agreement alone does
not establish that glyph ink is visible or readable.
