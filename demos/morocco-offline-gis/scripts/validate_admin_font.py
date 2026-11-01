"""Strict validator for the derived 'Offline Admin Latin' fontstack (v1.2.1).

Checks (all mandatory ones must pass, exit 1 otherwise; result JSON is
written to Docs/v1_2_1_admin_font_structural_validation.json):
  1. baseline input still matches the pinned SHA (old font bytes unchanged);
  2. derived output parses: alias 'Offline Admin Latin', range_number
     preserved, same glyph id sequence (224 codepoints), identical metrics
     (width/height/left/top/advance) per glyph;
  3. ONLY bitmap payloads differ, and every bitmap byte equals an
     INDEPENDENT LUT computed here from the published formula
     (math.floor/clamp) — the builder's own remap is never reused to
     assert itself;
  4. rebuild is byte-identical (idempotent derivation, run twice);
  5. structural provenance: metadata key geo_context.administrative_label_font
     equals the builder's contract manifest AND matches the ACTUAL asset
     (sha256/size/alias/input sha/glyph count); the usage whitelist equals
     the pinned exact 20-layer list (4 ADM + 8 real geo + 4 curated osm +
     2 contour + 2 RAN — v1.2.1 user-feedback scope; must never widen
     further) and NOTICE.md exists at the declared path, cites the output
     sha, formula and license relative path, and lists every whitelisted
     layer;
  6. OPTIONAL, portable: bitmap payloads equal the diagnostic twin used for
     the authorized B-variant probe when that file happens to exist on this
     machine (never required — absence is reported, not failed);
  7. writes a bitmap visual sheet PNG (raw SDF alphas) including French
     accent glyphs for actual-image proof.

Stdlib only. Source/meta/LUT/range checks never depend on .data.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prepare_admin_font import (  # noqa: E402
    FORMULA,
    INPUT_PATH,
    INPUT_SHA256,
    LICENSE_REL_PATH,
    METADATA_PATH,
    NEW_NAME,
    NOTICE_PATH,
    OUT_PATH,
    _fields,
    derive,
    manifest,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TWIN_PATH = os.path.join(ROOT, ".data", "font-fill-probe", "glyphs", "Noto Sans Fixed", "0-255.pbf")
STRUCTURAL_JSON = os.path.join(ROOT, "Docs", "v1_2_1_admin_font_structural_validation.json")
SHEET_PATH = os.path.join(ROOT, "Docs", "v1_2_1_admin_font_sheet.png")
SHEET_CHARS = "MARKECHSFI-éàçô"  # ADM1 label alphabet + French accents (all <= U+00FF)
EXPECTED_GLYPHS = 224
EXPECTED_ALIAS = NEW_NAME

# Approved usage whitelist (v1.2.1 clear-place-name expansion + user-feedback
# S9 authorization), pinned HERE independently of the builder: usage scope is
# exactly these 20 layers (4 ADM + 8 real geo + 4 curated osm + 2 contour +
# 2 RAN site labels) — any further widening fails validation.
APPROVED_USAGE_LAYERS = [
    "geo-admin-gb1-labels",
    "geo-admin-gb1-labels-a",
    "geo-admin-gb2-labels",
    "geo-admin-gb2-labels-a",
    "geo-place-labels-major",
    "geo-place-labels-major-d",
    "geo-place-labels-town",
    "geo-place-labels-town-d",
    "geo-place-labels-local",
    "geo-place-labels-local-d",
    "geo-peak-labels",
    "geo-peak-labels-d",
    "osm-place-labels",
    "osm-pass-labels",
    "osm-peak-labels",
    "osm-peak-labels-top",
    "contour-labels",
    "contour-labels-minor",
    "ran-site-labels",
    "ran-site-labels-selected",
]


def independent_lut() -> bytes:
    """Explicit LUT from the published formula — computed HERE, independent
    of the builder's implementation (JS Math.round semantics: floor(x+0.5);
    exact half-integer ties cannot occur for this formula)."""
    lut = bytearray()
    for v in range(256):
        x = 191.25 + (v - 128) * 255.0 / 127.0
        n = math.floor(x + 0.5)
        lut.append(max(0, min(255, n)))
    return bytes(lut)


def parse_glyphs(pbf: bytes):
    """-> (stack_name, [(id, bitmap, w, h, left, top, advance)...], range_number)"""
    (stack,) = [p for f, _w, p in _fields(pbf) if f == 1]
    name, glyphs, rng = None, [], None
    for f, _w, p in _fields(stack):
        if f == 1:
            name = p.decode("utf-8")
        elif f == 2:
            rng = p
        elif f == 3:
            g = {}
            for gf, _gw, gp in _fields(p):
                g[gf] = gp
            glyphs.append((g[1], g[2], g[3], g[4], g[5], g[6], g[7]))
    return name, glyphs, rng


def png_write(path: str, w: int, h: int, rows_gray: list[bytes]) -> None:
    raw = b"".join(b"\x00" + r for r in rows_gray)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def sheet(new_g) -> None:
    """Grayscale sheet: each sample glyph's SDF core (border stripped, 3px),
    one glyph per 64x64 cell, baseline-aligned at y=16..16+h."""
    by_id = {g[0]: g for g in new_g}
    cell, gap = 64, 4
    cols = len(SHEET_CHARS)
    W, H = cols * (cell + gap) + gap, cell + 2 * gap
    canvas = bytearray(W * H)
    for i, ch in enumerate(SHEET_CHARS):
        g = by_id.get(ord(ch))
        if g is None:
            continue
        _id, bmp, w, h, _l, _t, _a = g
        stride = w + 6
        ox = gap + i * (cell + gap) + (cell - w) // 2
        oy = gap + 16
        for y in range(h):
            src = bmp[(y + 3) * stride + 3 : (y + 3) * stride + 3 + w]
            dst = (oy + y) * W + ox
            canvas[dst : dst + w] = src
    png_write(SHEET_PATH, W, H, [bytes(canvas[y * W : (y + 1) * W]) for y in range(H)])


def main() -> None:
    checks: dict[str, object] = {}
    ok = True

    # -- (1) baseline unchanged ------------------------------------------------
    with open(INPUT_PATH, "rb") as f:
        base = f.read()
    base_sha = hashlib.sha256(base).hexdigest()
    checks["baseline_unchanged"] = base_sha == INPUT_SHA256
    ok &= checks["baseline_unchanged"]

    # -- (2) output structure --------------------------------------------------
    with open(OUT_PATH, "rb") as f:
        out = f.read()
    out_sha = hashlib.sha256(out).hexdigest()
    checks["output_sha256"] = out_sha
    checks["output_bytes"] = len(out)

    name_b, glyphs_b, rng_b = parse_glyphs(base)
    name_n, glyphs_n, rng_n = parse_glyphs(out)
    checks["baseline_alias_was_noto"] = name_b == "Noto Sans Regular"
    checks["output_alias"] = name_n
    checks["alias_correct"] = name_n == EXPECTED_ALIAS
    checks["range_number_preserved"] = rng_b == rng_n  # MANDATORY gate (ANDed below)
    checks["glyph_count_224"] = len(glyphs_n) == EXPECTED_GLYPHS and len(glyphs_b) == EXPECTED_GLYPHS
    for k in ("baseline_alias_was_noto", "alias_correct", "range_number_preserved", "glyph_count_224"):
        ok &= bool(checks[k])

    # -- (3) independent LUT over the actual 224 bitmaps ------------------------
    metrics_same = len(glyphs_b) == len(glyphs_n) and all(
        a[0] == b[0] and a[2:] == b[2:] for a, b in zip(glyphs_b, glyphs_n)
    )
    checks["ids_and_metrics_identical"] = bool(metrics_same)
    lut = independent_lut()
    lut_ok = all(bytes(lut[b] for b in a[1]) == b[1] for a, b in zip(glyphs_b, glyphs_n))
    only_bitmap_diff = all(
        a[1] != b[1] and a[:1] + a[2:] == b[:1] + b[2:] for a, b in zip(glyphs_b, glyphs_n)
    )
    checks["independent_lut"] = lut.hex()
    checks["only_bitmap_diff_and_exact_independent_lut"] = bool(metrics_same and lut_ok and only_bitmap_diff)
    ok &= checks["only_bitmap_diff_and_exact_independent_lut"]

    # -- (4) idempotent rebuild -------------------------------------------------
    rebuilt, _c, _ch = derive(base)
    checks["rebuild_byte_identical"] = hashlib.sha256(rebuilt).hexdigest() == out_sha
    ok &= checks["rebuild_byte_identical"]

    # -- (5) structural provenance (metadata contract + NOTICE) -----------------
    with open(METADATA_PATH, "rb") as f:
        meta = json.loads(f.read().decode("utf-8"))
    stored = meta.get("geo_context", {}).get("administrative_label_font")
    expected = manifest(out_sha, len(out), len(glyphs_n))
    checks["metadata_key_present"] = isinstance(stored, dict)
    checks["metadata_matches_builder_contract"] = stored == expected
    checks["metadata_input_sha_matches_pinned"] = bool(
        isinstance(stored, dict) and stored.get("derived_from", {}).get("sha256") == INPUT_SHA256
    )
    checks["metadata_asset_hash_size_match_actual"] = bool(
        isinstance(stored, dict)
        and stored.get("output_sha256") == out_sha
        and stored.get("output_size_bytes") == len(out)
    )
    checks["metadata_alias_matches_pbf"] = bool(
        isinstance(stored, dict) and stored.get("fontstack") == name_n
    )
    notice_exists = os.path.isfile(NOTICE_PATH)
    notice_text = ""
    if notice_exists:
        with open(NOTICE_PATH, "rb") as f:
            notice_raw = f.read()
        try:
            notice_text = notice_raw.decode("utf-8")
            notice_utf8 = True
        except UnicodeDecodeError:
            notice_utf8 = False
    else:
        notice_utf8 = False
    checks["notice_valid_utf8"] = notice_utf8
    checks["notice_present_at_metadata_path"] = notice_exists and bool(
        isinstance(stored, dict)
        and stored.get("notice") == os.path.relpath(NOTICE_PATH, os.path.join(ROOT, "public")).replace("\\", "/")
    )
    checks["notice_cites_output_sha_formula_license"] = bool(
        notice_text
        and out_sha in notice_text
        and FORMULA in notice_text
        and LICENSE_REL_PATH in notice_text
        and INPUT_SHA256 in notice_text
    )
    # usage exactness (v1.2.1 clear-place-name expansion + user-feedback S9
    # authorization): the stored whitelist must equal the pinned 20-layer
    # list (no widening, no reordering) and the NOTICE must enumerate every
    # whitelisted layer.
    stored_layers = stored.get("used_by_layers") if isinstance(stored, dict) else None
    checks["usage_whitelist_exact_20"] = stored_layers == APPROVED_USAGE_LAYERS
    checks["notice_lists_all_20_layers"] = bool(notice_text) and all(
        name in notice_text for name in APPROVED_USAGE_LAYERS
    )
    for k in (
        "metadata_key_present",
        "metadata_matches_builder_contract",
        "metadata_input_sha_matches_pinned",
        "metadata_asset_hash_size_match_actual",
        "metadata_alias_matches_pbf",
        "notice_valid_utf8",
        "notice_present_at_metadata_path",
        "notice_cites_output_sha_formula_license",
        "usage_whitelist_exact_20",
        "notice_lists_all_20_layers",
    ):
        ok &= bool(checks[k])

    # -- (6) OPTIONAL probe twin (portable; absence is not a failure) ----------
    if os.path.isfile(TWIN_PATH):
        with open(TWIN_PATH, "rb") as f:
            _tn, tg, _tr = parse_glyphs(f.read())
        checks["twin_bitmaps_match_probe_evidence"] = [g[1] for g in tg] == [g[1] for g in glyphs_n]
    else:
        checks["twin_bitmaps_match_probe_evidence"] = "twin absent (optional check skipped)"

    # -- (7) visual sheet -------------------------------------------------------
    sheet(glyphs_n)
    checks["visual_sheet"] = os.path.relpath(SHEET_PATH, ROOT)

    checks["all_pass"] = bool(ok)
    with open(STRUCTURAL_JSON, "wb") as f:
        f.write((json.dumps(checks, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps(checks, indent=1, ensure_ascii=False))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
