"""Build the isolated 'Offline Admin Latin' MapLibre glyph fontstack (v1.2.1).

Derives public/assets/glyphs/Offline Admin Latin/0-255.pbf from the shipped
public baseline font WITHOUT regenerating outlines or mutating metrics, and
deterministically emits the provenance pair from pinned constants + the
computed output hash:

  1. the glyph PBF (bitmap-only SDF-edge remap, see transform below);
  2. NOTICE.md (license retention + official source citations, UTF-8);
  3. the independent metadata key geo_context.administrative_label_font
     (read-modify-write of public/data/metadata.json; every other key is
     preserved; when the stored key is already semantically equal the file
     is left BYTE-IDENTICAL on disk).

  * input baseline is pinned by SHA-256 and verified BEFORE derivation;
  * ONLY glyph bitmap bytes are transformed
        v' = clamp(round(191.25 + (v - 128) * 255 / 127), 0, 255)
    which re-expresses the generator's SDF edge convention (128 = outline,
    scripts/pipeline/glyphs.py) in the convention MapLibre's SDF shader
    expects for text-halo/gamma 0.75 (maplibre-gl 5.24 symbol SDF shader)
    and TinySDF 2.1.0 (cutoff 0.25 -> edge 191.25). Bytes outside the ink
    (0 and the 1-value 3px safety border) map to 0 by the formula itself.
  * glyph ids, widths, heights, left/top, advance and field encoding are
    preserved byte-for-byte; only the fontstack name alias and bitmap
    payloads differ;
  * the transform is a pure function of the input, so rebuilds are
    byte-identical (checked by scripts/validate_admin_font.py);
  * no wall-clock/time inputs anywhere — output is a pure function of the
    pinned input.

Deterministic, stdlib-only. License: the derived stack carries the same
Noto Sans SIL Open Font License 1.1 terms (see NOTICE.md).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_PATH = os.path.join(ROOT, "public", "assets", "glyphs", "Noto Sans Regular", "0-255.pbf")
INPUT_SHA256 = "a658f4ca95dbdaa9d54bc10a9bde07cfcb6a42317bcf55bdd1e8e46a4be59715"
OUT_DIR = os.path.join(ROOT, "public", "assets", "glyphs", "Offline Admin Latin")
OUT_PATH = os.path.join(OUT_DIR, "0-255.pbf")
NOTICE_PATH = os.path.join(OUT_DIR, "NOTICE.md")
METADATA_PATH = os.path.join(ROOT, "public", "data", "metadata.json")
NEW_NAME = "Offline Admin Latin"
OLD_NAME = "Noto Sans Regular"
EXPECTED_GLYPHS = 224

FORMULA = "v' = clamp(round(191.25 + (v - 128) * 255 / 127), 0, 255)"
TRANSFORM_NOTE = (
    "applied to glyph bitmap bytes ONLY (SDF edge 128 -> MapLibre 5.24 "
    "gamma-0.75 / TinySDF 2.1.0 cutoff-0.25 edge convention); glyph ids and "
    "metrics preserved; fontstack alias is the only other change"
)
RATIONALE = (
    "baseline edge-128 SDF bytes collapse the ADM label fill below the shader "
    "paint threshold at overview sizes (halo-ink ghost labels on dark "
    "terrain); exact-fixture A/B probe: A FAIL maxDelta 42 / B (this remap) "
    "PASS contrast 12.63 maxDelta 214"
)
USED_BY_LAYERS = [
    # v1.2.1 original scope: the four ADM name label layers
    "geo-admin-gb1-labels",
    "geo-admin-gb1-labels-a",
    "geo-admin-gb2-labels",
    "geo-admin-gb2-labels-a",
    # approved clear-place-name expansion: real geo labels (overview + -d)
    "geo-place-labels-major",
    "geo-place-labels-major-d",
    "geo-place-labels-town",
    "geo-place-labels-town-d",
    "geo-place-labels-local",
    "geo-place-labels-local-d",
    "geo-peak-labels",
    "geo-peak-labels-d",
    # approved clear-place-name expansion: curated osm name labels
    "osm-place-labels",
    "osm-pass-labels",
    "osm-peak-labels",
    "osm-peak-labels-top",
]
LICENSE_NAME = "SIL Open Font License 1.1 (derivative of bundled Noto Sans glyphs; stack name avoids the Noto Reserved Font Name because rendering data is modified)"
LICENSE_REL_PATH = "../../../licenses/Noto-Sans-OFL.txt"
LICENSE_URL = "https://openfontlicense.org/open-font-license-official-text/"
URL_SHADER = "https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/shaders/symbol_sdf.fragment.glsl"
URL_GLYPH_MANAGER = "https://github.com/maplibre/maplibre-gl-js/blob/v5.24.0/src/render/glyph_manager.ts"
URL_TINYSDF = "https://github.com/mapbox/tiny-sdf/blob/v2.1.0/index.js"

# MapLibre glyph PBF wire format (glyphs.proto), matching pipeline/glyphs.py:
#   glyphs  { repeated fontstack stacks = 1; }
#   fontstack { string name = 1; uint32 range_number = 2; repeated glyph glyphs = 3; }
#   glyph { uint32 id=1; bytes bitmap=2; uint32 width=3; uint32 height=4;
#           sint32 left=5; sint32 top=6; uint32 advance=7; }


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    shift = value = 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7


def _fields(buf: bytes):
    """Yield (field, wire, payload) preserving each field's raw encoding."""
    pos = 0
    while pos < len(buf):
        tag, pos = _read_varint(buf, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = _read_varint(buf, pos)
            yield field, wire, value
        elif wire == 2:
            n, pos = _read_varint(buf, pos)
            yield field, wire, buf[pos : pos + n]
            pos += n
        else:
            raise ValueError(f"unsupported wire type {wire} (field {field})")


def _rnd(v: int) -> int:
    # JS Math.round semantics: floor(x + 0.5) (exact half-integers cannot
    # occur for this formula; bytes < the ink floor clamp to 0 regardless).
    x = 191.25 + (v - 128) * 255.0 / 127.0
    return max(0, min(255, int(x + 0.5) if x >= 0 else -int(-x + 0.5)))


def _remap(bitmap: bytes) -> bytes:
    """SDF edge 128 -> MapLibre/TinySDF cutoff-0.25 edge 191.25."""
    lut = bytes(_rnd(v) for v in range(256))
    return bitmap.translate(lut)


def derive(data: bytes) -> tuple[bytes, int, int]:
    (stack_payload,) = [p for f, _w, p in _fields(data) if f == 1] or [None]
    if stack_payload is None:
        sys.exit("FATAL: no fontstack field in input")

    name = None
    range_number_raw = None
    glyphs_raw = []
    for f, _w, p in _fields(stack_payload):
        if f == 1:
            name = p.decode("utf-8")
        elif f == 2:
            range_number_raw = p
        elif f == 3:
            glyphs_raw.append(p)
    if name != OLD_NAME:
        sys.exit(f"FATAL: input fontstack name is {name!r}, expected {OLD_NAME!r}")

    out_glyphs = []
    changed = 0
    for g in glyphs_raw:
        parts = []
        for f, wire, p in _fields(g):
            if f == 2:
                nb = _remap(p)
                changed += nb != p
                parts.append((f, wire, nb))
            else:
                parts.append((f, wire, p))
        # rebuild glyph message in original field order, raw encodings kept
        msg = bytearray()
        for f, _wire, p in parts:
            if isinstance(p, int):
                msg += _varint_field_raw(f, p)
            else:
                msg += _len_field_raw(f, p)
        out_glyphs.append(bytes(msg))

    stack = bytearray()
    stack += _len_field_raw(1, NEW_NAME.encode("utf-8"))
    if range_number_raw is not None:
        stack += _varint_field_raw(2, range_number_raw)
    for g in out_glyphs:
        stack += _len_field_raw(3, g)
    return bytes(_len_field_raw(1, bytes(stack))), len(out_glyphs), changed


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _varint_field_raw(field: int, value: int) -> bytes:
    return _varint((field << 3) | 0) + _varint(value)


def _len_field_raw(field: int, payload: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(payload)) + payload


def manifest(output_sha256: str, output_size: int, glyph_count: int) -> dict:
    """The metadata contract for geo_context.administrative_label_font.

    Key order and values are deterministic constants (+ computed hash/size);
    the runtime application never reads this key — it is provenance only.
    """
    return {
        "note": "independent v1.2.1 record: isolated derived glyph stack used ONLY by the 16 whitelisted name label layers (4 ADM + 8 real geo + 4 curated osm); baseline font and all other consumers are untouched",
        "fontstack": NEW_NAME,
        "glyphs_path": "assets/glyphs/Offline Admin Latin/0-255.pbf",
        "glyph_range": "0-255",
        "glyph_count": glyph_count,
        "used_by_layers": list(USED_BY_LAYERS),
        "derived_from": {
            "fontstack": OLD_NAME,
            "path": "assets/glyphs/Noto Sans Regular/0-255.pbf",
            "sha256": INPUT_SHA256,
            "unchanged": True,
        },
        "output_sha256": output_sha256,
        "output_size_bytes": output_size,
        "builder": "scripts/prepare_admin_font.py",
        "validator": "scripts/validate_admin_font.py",
        "transform": f"{FORMULA} {TRANSFORM_NOTE}",
        "rationale": RATIONALE,
        "notice": "assets/glyphs/Offline Admin Latin/NOTICE.md",
        "license": LICENSE_NAME,
    }


def notice_text(m: dict) -> str:
    """Deterministic NOTICE.md (UTF-8, LF) for the derived fontstack."""
    return f"""# Offline Admin Latin — derived glyph fontstack NOTICE

Isolated MapLibre glyph stack for the 16 whitelisted name label layers only
(4 ADM + 8 real geo place/peak + 4 curated osm place/pass/peak):
{', '.join(m['used_by_layers'])}.
No other layer or font consumer uses this stack.

## Derivation

| | |
|---|---|
| Input baseline | `public/assets/glyphs/Noto Sans Regular/0-255.pbf` |
| Input SHA-256 (pinned) | `{m['derived_from']['sha256']}` |
| Output | `0-255.pbf` (this folder) |
| Output SHA-256 | `{m['output_sha256']}` |
| Output size | {m['output_size_bytes']} bytes |
| Glyph count / range | {m['glyph_count']} glyphs, 0-255, same glyph ids as baseline |
| Builder | `scripts/prepare_admin_font.py` (deterministic; rebuild byte-identical) |
| Validator | `scripts/validate_admin_font.py` (strict standalone check + bitmap sheet) |

## Transform (bitmap bytes ONLY)

```
{FORMULA}
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
  {URL_SHADER}
* MapLibre GL JS v5.24.0 glyph manager (TinySDF cutoff 0.25 for local glyph
  generation, remote PBF passthrough): {URL_GLYPH_MANAGER}
* TinySDF v2.1.0 (default `cutoff: 0.25` -> SDF edge 191.25; the reference
  generator behind maplibre-gl's bundled-glyph convention): {URL_TINYSDF}

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
`{LICENSE_REL_PATH}` — official text: {LICENSE_URL}
The stack name avoids the "Noto" Reserved Font Name because the rendering
data has been modified.
"""


def update_metadata(m: dict) -> str:
    """RMW of public/data/metadata.json, preserving every other key.

    If the stored key is already semantically equal, the file is NOT
    rewritten (byte order preserved). Otherwise the whole document is
    re-serialized in the file's established dialect (CRLF, 2-space indent,
    UTF-8 literal non-ASCII, trailing newline) — deterministic, no wall
    clock inputs.
    """
    with open(METADATA_PATH, "rb") as f:
        raw = f.read()
    meta = json.loads(raw.decode("utf-8"))
    geo = meta.setdefault("geo_context", {})
    if geo.get("administrative_label_font") == m:
        return "unchanged"
    geo["administrative_label_font"] = m
    text = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    data = text.replace("\n", "\r\n").encode("utf-8")
    with open(METADATA_PATH, "wb") as f:
        f.write(data)
    return "updated"


def main() -> None:
    with open(INPUT_PATH, "rb") as f:
        data = f.read()
    sha = hashlib.sha256(data).hexdigest()
    if sha != INPUT_SHA256:
        sys.exit(f"FATAL: input baseline SHA {sha} != pinned {INPUT_SHA256}")
    print(f"input  {INPUT_PATH}\n       sha256 {sha} OK ({len(data)} bytes)")

    msg, count, changed = derive(data)
    if count != EXPECTED_GLYPHS:
        sys.exit(f"FATAL: glyph count {count} != expected {EXPECTED_GLYPHS}")
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PATH, "wb") as f:
        f.write(msg)
    out_sha = hashlib.sha256(msg).hexdigest()
    print(f"output {OUT_PATH}\n       sha256 {out_sha} ({len(msg)} bytes)")
    print(f"glyphs {count} (bitmaps changed: {changed}/{count}) alias {NEW_NAME!r}")

    m = manifest(out_sha, len(msg), count)
    with open(NOTICE_PATH, "wb") as f:
        f.write(notice_text(m).encode("utf-8"))
    print(f"notice {NOTICE_PATH}")
    state = update_metadata(m)
    print(f"metadata {METADATA_PATH} ({state})")


if __name__ == "__main__":
    main()
