# Offline Admin Latin — derived glyph fontstack NOTICE

Isolated MapLibre glyph stack for the 16 whitelisted name label layers only
(4 ADM + 8 real geo place/peak + 4 curated osm place/pass/peak):
geo-admin-gb1-labels, geo-admin-gb1-labels-a, geo-admin-gb2-labels, geo-admin-gb2-labels-a, geo-place-labels-major, geo-place-labels-major-d, geo-place-labels-town, geo-place-labels-town-d, geo-place-labels-local, geo-place-labels-local-d, geo-peak-labels, geo-peak-labels-d, osm-place-labels, osm-pass-labels, osm-peak-labels, osm-peak-labels-top.
No other layer or font consumer uses this stack.

## Derivation

| | |
|---|---|
| Input baseline | `public/assets/glyphs/Noto Sans Regular/0-255.pbf` |
| Input SHA-256 (pinned) | `a658f4ca95dbdaa9d54bc10a9bde07cfcb6a42317bcf55bdd1e8e46a4be59715` |
| Output | `0-255.pbf` (this folder) |
| Output SHA-256 | `2ee61f0000cfc63ca24462aa08c599a8f512b968d24bfc78c797288e6edede3b` |
| Output size | 417018 bytes |
| Glyph count / range | 224 glyphs, 0-255, same glyph ids as baseline |
| Builder | `scripts/prepare_admin_font.py` (deterministic; rebuild byte-identical) |
| Validator | `scripts/validate_admin_font.py` (strict standalone check + bitmap sheet) |

## Transform (bitmap bytes ONLY)

```
v' = clamp(round(191.25 + (v - 128) * 255 / 127), 0, 255)
```

Re-expresses the generator's SDF edge convention (`scripts/pipeline/glyphs.py`
encodes 128 = glyph outline) in the convention MapLibre's symbol SDF shader
expects for `text-halo` gamma 0.75 — the convention TinySDF 2.1.0 produces
with its default `cutoff: 0.25` (edge = 255 * (1 - 0.25) = 191.25), which is
what maplibre-gl 5.24's own glyph generation emits. Glyph ids, widths,
heights, left/top bearings, advances and protobuf field encodings are
preserved byte-for-byte; the fontstack name alias is the only other change.
Bytes outside the ink (0 and the 1-value 3px safety border) map to 0 via the
formula itself. No outlines were regenerated and no metrics mutated.

## Sources (official upstream references)

* MapLibre GL JS v5.24.0 symbol SDF fragment shader (gamma/halo threshold math):
  https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/shaders/symbol_sdf.fragment.glsl
* MapLibre GL JS v5.24.0 glyph manager (TinySDF cutoff 0.25 for local glyph
  generation, remote PBF passthrough): https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/render/glyph_manager.ts
* TinySDF v2.1.0 (default `cutoff: 0.25` -> SDF edge 191.25; the reference
  generator behind maplibre-gl's bundled-glyph convention): https://github.com/mapbox/tiny-sdf/blob/v2.1.0/index.js

## Why

The baseline edge-128 bytes collapse the label fill interior below the SDF
shader paint threshold at ADM overview sizes, rendering halo-ink "ghost"
labels on dark terrain. Exact-production A/B/C probe
(`.data/font-fill-probe/exact-fixture/`): A (original font) FAIL (0 qualifying
px, maxDelta 42); B (this remap, styles untouched) PASS (396 px, contrast
12.63:1, maxDelta 214); C (style-only) FAIL (maxDelta 19).

## License

Copyright/authorship and the SIL Open Font License 1.1 terms are unchanged —
this is a derivative of the bundled Noto Sans glyphs under the same license.
Full license text (relative path from this folder):
`../../../licenses/Noto-Sans-OFL.txt` — official text: https://openfontlicense.org/open-font-license-official-text/
The stack name avoids the "Noto" Reserved Font Name because the rendering
data has been modified.
