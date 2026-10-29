"""MapLibre glyph PBF generator: rasterise a TTF with Pillow, convert the
coverage bitmap to a signed distance field (SDF), hand-encode the protobuf
wire format (glyphs.proto). No protobuf/scipy dependency.

Wire format (mapbox/glyphs):
glyphs { repeated fontstack stacks = 1; }
fontstack { required string name = 1;  uint32 range_number = 2 (legacy);
            repeated glyph glyphs = 3; }
glyph { uint32 id = 1; bytes bitmap = 2; uint32 width = 3; uint32 height = 4;
        sint32 left = 5; sint32 top = 6; uint32 advance = 7; }

Metric conventions (mapnik/maplibre):
  left   = pen position -> bitmap left edge (px, x right)
  top    = baseline -> bitmap top edge (px, y UP)
  advance = pen advance in px
MapLibre renders the bitmap as an SDF (mid 128), so bitmap bytes encode
distance to the glyph outline with ~8 px spread.
"""

from __future__ import annotations

import os
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFont

GLYPH_SIZE = 32  # rasterisation px; MapLibre scales to text-size
BUFFER = 8       # px padding around ink — must cover the SDF spread
SPREAD = 8.0     # SDF spread in px


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _zigzag(n: int) -> int:
    # arbitrary-precision-safe zigzag: 0,1,-1,2,-2 -> 0,2,1,4,3
    return n * 2 if n >= 0 else -n * 2 - 1


def _tag(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _bytes_field(field: int, payload: bytes) -> bytes:
    return _tag(field, 2) + _varint(len(payload)) + payload


def _varint_field(field: int, value: int) -> bytes:
    return _tag(field, 0) + _varint(value)


def _dilate3(m: np.ndarray) -> np.ndarray:
    p = np.pad(m, 1, constant_values=False)
    return (
        p[:-2, :-2] | p[:-2, 1:-1] | p[:-2, 2:]
        | p[1:-1, :-2] | p[1:-1, 1:-1] | p[1:-1, 2:]
        | p[2:, :-2] | p[2:, 1:-1] | p[2:, 2:]
    )


def _erode3(m: np.ndarray) -> np.ndarray:
    p = np.pad(m, 1, constant_values=True)
    return (
        p[:-2, :-2] & p[:-2, 1:-1] & p[:-2, 2:]
        & p[1:-1, :-2] & p[1:-1, 1:-1] & p[1:-1, 2:]
        & p[2:, :-2] & p[2:, 1:-1] & p[2:, 2:]
    )


def _clip_dist(mask: np.ndarray, spread: int, inside: bool) -> np.ndarray:
    """Layered 3x3 erosion/dilation -> chebyshev distance clipped to `spread`.

    inside=True: distance from ink pixels toward the outside edge (1..spread).
    inside=False: distance from background pixels toward the nearest ink.
    """
    dist = np.zeros(mask.shape, dtype=np.int32)
    cur = mask.copy()
    step = _erode3 if inside else _dilate3
    for k in range(1, spread + 1):
        nxt = step(cur)
        newly = cur & ~nxt if inside else nxt & ~cur
        dist[newly] = k
        cur = nxt
    dist[cur] = spread  # everything deeper clamps at the spread
    return dist


def _sdf_bitmap(alpha: np.ndarray) -> bytes:
    """alpha (uint8 2D) -> SDF bytes (uint8 2D, 128 = outline)."""
    ink = alpha > 127
    spread = int(SPREAD)
    d_in = _clip_dist(ink, spread, inside=True)
    d_out = _clip_dist(ink, spread, inside=False)
    signed = np.where(ink, d_in, -d_out).astype(np.float64)
    vals = np.clip(128.0 + signed * (127.0 / SPREAD), 1.0, 255.0).astype(np.uint8)
    # glyphs.proto stores the bitmap including MapLibre's 3px safety border;
    # the parser adds that border to width/height when constructing AlphaImage.
    padded = np.pad(vals, 3, mode="constant", constant_values=1)
    return padded.tobytes()


def _encode_glyph(cp: int, font: ImageFont.FreeTypeFont) -> bytes | None:
    ch = chr(cp)
    try:
        bbox = font.getbbox(ch)
    except Exception:
        return None
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    ink_w, ink_h = x1 - x0, y1 - y0
    advance = max(1, int(round(font.getlength(ch))))
    if ink_w <= 0 or ink_h <= 0:
        # MapLibre adds a 3px border to the declared metrics and therefore
        # expects a 6x6 bitmap even when width=height=0.
        g = _varint_field(1, cp)
        g += _bytes_field(2, bytes([1]) * 36)
        g += _varint_field(3, 0)
        g += _varint_field(4, 0)
        g += _varint_field(5, _zigzag(0))
        g += _varint_field(6, _zigzag(0))
        g += _varint_field(7, advance)
        return g

    w = ink_w + 2 * BUFFER
    h = ink_h + 2 * BUFFER
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    # PIL text origin = top-left of the em box (y grows down)
    draw.text((-x0 + BUFFER, -y0 + BUFFER), ch, font=font, fill=255)
    bitmap = _sdf_bitmap(np.asarray(img, dtype=np.uint8))

    ascent, _descent = font.getmetrics()
    left = x0 - BUFFER
    top = ascent - y0 + BUFFER  # baseline -> bitmap top, y UP

    g = _varint_field(1, cp)
    g += _bytes_field(2, bitmap)
    g += _varint_field(3, w)
    g += _varint_field(4, h)
    g += _varint_field(5, _zigzag(int(left)))
    g += _varint_field(6, _zigzag(int(top)))
    g += _varint_field(7, advance)
    return g


def generate_glyph_pbf(
    ttf_path: str, out_path: str, fontstack_name: str, lo: int = 0, hi: int = 255
) -> int:
    font = ImageFont.truetype(ttf_path, GLYPH_SIZE)
    stack = bytearray()
    stack += _bytes_field(1, fontstack_name.encode("utf-8"))
    stack += _varint_field(2, 0)  # range_number (legacy)
    count = 0
    for cp in range(lo, hi + 1):
        if cp < 32 and cp != 32:
            continue  # skip control chars, keep space
        g = _encode_glyph(cp, font)
        if g is None:
            continue
        stack += _bytes_field(3, g)
        count += 1
    msg = _bytes_field(1, bytes(stack))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(bytes(msg))
    return count


# --------------------------------------------------------------------------
# cmap presence check (stdlib only - fontTools is not a dependency).
#
# PIL/FreeType render .notdef for missing codepoints, so getbbox() cannot
# prove a glyph exists.  Parse the TTF cmap subtables directly and resolve
# the glyph id; gid > 0 means the character is actually mapped.
# --------------------------------------------------------------------------

def _cmap_subtables(data: bytes, cmap_off: int) -> list[tuple[int, int, int, int]]:
    n = struct.unpack_from(">H", data, cmap_off + 2)[0]
    out = []
    for i in range(n):
        pid, eid, off = struct.unpack_from(">HHI", data, cmap_off + 4 + 8 * i)
        fmt = struct.unpack_from(">H", data, cmap_off + off)[0]
        out.append((pid, eid, cmap_off + off, fmt))
    return out


def _gid_from_format4(data: bytes, soff: int, cp: int) -> int | None:
    if cp > 0xFFFF:
        return None
    seg_count_x2 = struct.unpack_from(">H", data, soff + 6)[0]
    seg_count = seg_count_x2 // 2
    end_off = soff + 14
    start_off = end_off + seg_count_x2 + 2
    delta_off = start_off + seg_count_x2
    range_off = delta_off + seg_count_x2
    for i in range(seg_count):
        end_code = struct.unpack_from(">H", data, end_off + 2 * i)[0]
        start_code = struct.unpack_from(">H", data, start_off + 2 * i)[0]
        if start_code <= cp <= end_code:
            id_delta = struct.unpack_from(">h", data, delta_off + 2 * i)[0]
            id_range_offset = struct.unpack_from(">H", data, range_off + 2 * i)[0]
            if id_range_offset == 0:
                return (cp + id_delta) & 0xFFFF
            addr = range_off + 2 * i + id_range_offset + 2 * (cp - start_code)
            if addr + 2 > len(data):
                return None
            return struct.unpack_from(">H", data, addr)[0]
    return None


def _gid_from_format12(data: bytes, soff: int, cp: int) -> int | None:
    n_groups = struct.unpack_from(">I", data, soff + 12)[0]
    for g in range(n_groups):
        start_c, end_c, start_gid = struct.unpack_from(">III", data, soff + 16 + 12 * g)
        if start_c <= cp <= end_c:
            return start_gid + (cp - start_c)
    return None


def ttf_covers(ttf_path: str, codepoints) -> set[int]:
    """Return the subset of `codepoints` that the TTF cmap actually maps."""
    import contextlib

    with open(ttf_path, "rb") as f:
        data = f.read()
    num_tables = struct.unpack_from(">H", data, 4)[0]
    cmap_off = None
    for i in range(num_tables):
        rec = 12 + 16 * i
        tag = data[rec : rec + 4]
        off = struct.unpack_from(">I", data, rec + 8)[0]
        if tag == b"cmap":
            cmap_off = off
    if cmap_off is None:
        return set()

    subs = _cmap_subtables(data, cmap_off)

    def pick(pred):
        for pid, eid, soff, fmt in subs:
            if pred(pid, eid, fmt):
                return soff, fmt
        return None

    # preference: unicode/windows full repertoire first, BMP formats after
    order = [
        (lambda p, e, f: f == 12 and (p, e) in ((3, 10), (0, 4), (0, 6))),
        (lambda p, e, f: f == 12),
        (lambda p, e, f: f == 4 and (p, e) in ((3, 1), (0, 3))),
        (lambda p, e, f: f == 4),
    ]
    chosen = None
    for pred in order:
        chosen = pick(pred)
        if chosen:
            break
    if chosen is None:
        return set()
    soff, fmt = chosen

    found = set()
    for cp in codepoints:
        with contextlib.suppress(Exception):
            if fmt == 12:
                gid = _gid_from_format12(data, soff, cp)
            else:
                gid = _gid_from_format4(data, soff, cp)
            if gid:
                found.add(cp)
    return found
