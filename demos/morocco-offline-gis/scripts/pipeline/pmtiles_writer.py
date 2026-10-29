"""Minimal PMTiles v3 archive writer.

Format verified byte-for-byte against the `pmtiles` npm package v4 (the exact
reader the frontend uses), by reading its shipped source map:

Header — little-endian, exactly 127 bytes:
  0   7s  magic "PMTiles"
  7   B   spec version (3)
  8   Q   root directory offset (absolute)
  16  Q   root directory length (compressed)
  24  Q   json metadata offset
  32  Q   json metadata length (0 allowed)
  40  Q   leaf directories offset
  48  Q   leaf directories length
  56  Q   tile data offset
  64  Q   tile data length
  72  Q   num addressed tiles
  80  Q   num tile entries
  88  Q   num tile contents
  96  B   clustered (0)
  97  B   internal compression (2 = gzip)
  98  B   tile compression (1 = none, 2 = gzip)
  99  B   tile type (1 = MVT, 2 = PNG)
  100 B   min zoom
  101 B   max zoom
  102 i   min lon e7
  106 i   min lat e7
  110 i   max lon e7
  114 i   max lat e7
  118 B   center zoom
  119 i   center lon e7
  123 i   center lat e7

Tile IDs: Hilbert curve (see zxyToTileId in the JS package).

Directory (per directory, gzip-compressed independently):
  varint run_count
  run_count x varint tile_id delta (cumulative from 0)
  run_count x varint run_length (0 = leaf pointer)
  run_count x varint length
  run_count x varint offset: 0 if contiguous with previous entry's end
                             (i > 0), else absolute offset + 1

File section order: header, root, leaves, metadata, tile data.
"""

from __future__ import annotations

import gzip
import json
import struct
from dataclasses import dataclass

MAGIC = b"PMTiles"
VERSION = 3
COMPRESSION_UNKNOWN = 0
COMPRESSION_NONE = 1
COMPRESSION_GZIP = 2
TILE_TYPE_UNKNOWN = 0
TILE_TYPE_MVT = 1
TILE_TYPE_PNG = 2
TILE_TYPE_JPEG = 3
TILE_TYPE_WEBP = 4

ROOT_DIR_MAX = 16384  # serialized (uncompressed) bytes before leaf split
HEADER_LEN = 127


def uvarint(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_uvarint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


@dataclass
class Entry:
    tile_id: int
    offset: int
    length: int
    run_length: int  # 0 = leaf directory pointer


def _rotate(n: int, x: int, y: int, rx: int, ry: int) -> tuple[int, int]:
    if ry == 0:
        if rx != 0:
            return (n - 1 - y, n - 1 - x)
        return (y, x)
    return (x, y)


def tileid(z: int, x: int, y: int) -> int:
    """Hilbert-curve tile id (mirror of zxyToTileId in pmtiles JS)."""
    if z == 0:
        return 0
    acc = ((1 << (2 * z)) - 1) // 3
    a = z - 1
    tx, ty = x, y
    s = 1 << a
    while s > 0:
        rx = tx & s
        ry = ty & s
        acc += ((3 * rx) ^ ry) * (1 << a)
        tx, ty = _rotate(s, tx, ty, rx, ry)
        a -= 1
        s >>= 1
    return acc


def serialize_directory(entries: list[Entry]) -> bytes:
    # Merge consecutive tile ids that share one payload span into runs.
    runs: list[Entry] = []
    i = 0
    while i < len(entries):
        j = i
        while (
            j + 1 < len(entries)
            and entries[j + 1].tile_id == entries[j].tile_id + 1
            and entries[j + 1].offset == entries[j].offset
            and entries[j + 1].length == entries[j].length
        ):
            j += 1
        runs.append(Entry(entries[i].tile_id, entries[i].offset, entries[i].length, j - i + 1))
        i = j + 1

    out = bytearray()
    out += uvarint(len(runs))
    prev_id = 0
    for e in runs:
        out += uvarint(e.tile_id - prev_id)
        prev_id = e.tile_id
    for e in runs:
        out += uvarint(e.run_length)
    for e in runs:
        out += uvarint(e.length)
    prev_end = 0
    for i, e in enumerate(runs):
        if i > 0 and e.offset == prev_end:
            out += uvarint(0)
        else:
            out += uvarint(e.offset + 1)
        prev_end = e.offset + e.length
    return bytes(out)


def split_leaves(entries: list[Entry]) -> tuple[list[Entry], list[bytes]]:
    """Split into leaf directories; returns (leaf pointer entries, blobs)."""
    leaf_blobs: list[bytes] = []
    leaves: list[Entry] = []
    chunk = max(1, (len(entries) // 400) + 1)
    start = 0
    leaf_offset = 0
    while start < len(entries):
        part = entries[start : start + chunk]
        blob = serialize_directory(part)
        leaf_blobs.append(blob)
        leaves.append(Entry(part[0].tile_id, leaf_offset, len(blob), 0))
        leaf_offset += len(blob)
        start += chunk
    return leaves, leaf_blobs


def write_pmtiles(
    path: str,
    tiles: dict[tuple[int, int, int], bytes],
    *,
    tile_type: int,
    tile_compression: int,
    min_zoom: int,
    max_zoom: int,
    bbox: tuple[float, float, float, float],
    center: tuple[float, float, int],
    metadata: dict | None = None,
) -> dict:
    """Write tiles (already-final payload bytes) to a PMTiles v3 archive."""
    if not tiles:
        raise ValueError("no tiles")

    entries: list[Entry] = []
    data_blob = bytearray()
    for (z, x, y) in sorted(tiles.keys(), key=lambda k: tileid(k[0], k[1], k[2])):
        payload = tiles[(z, x, y)]
        off = len(data_blob)
        data_blob += payload
        entries.append(Entry(tileid(z, x, y), off, len(payload), 1))

    root = serialize_directory(entries)
    leaf_section = b""
    if len(root) > ROOT_DIR_MAX:
        leaves, leaf_blobs = split_leaves(entries)
        root = serialize_directory(leaves)
        leaf_section = b"".join(leaf_blobs)

    root_z = gzip.compress(root, 9)
    leaf_z = gzip.compress(leaf_section, 9) if leaf_section else b""

    root_dir_offset = HEADER_LEN
    leaf_dir_offset = root_dir_offset + len(root_z)
    metadata_offset = leaf_dir_offset + len(leaf_z)
    if metadata:
        meta_z = gzip.compress(json.dumps(metadata).encode("utf-8"), 9)
    else:
        meta_z = b""
    tile_data_offset = metadata_offset + len(meta_z)

    min_lon, min_lat, max_lon, max_lat = bbox
    c_lon, c_lat, c_zoom = center
    header = struct.pack(
        "<7s B Q Q Q Q Q Q Q Q Q Q Q B B B B B B i i i i B i i",
        MAGIC,
        VERSION,
        root_dir_offset,
        len(root_z),
        metadata_offset,
        len(meta_z),
        leaf_dir_offset,
        len(leaf_z),
        tile_data_offset,
        len(data_blob),
        entries[-1].tile_id + 1,  # num addressed tiles
        len(entries),  # num tile entries
        len(entries),  # num tile contents (no dedup)
        0,  # clustered
        COMPRESSION_GZIP,  # internal (directory) compression
        tile_compression,
        tile_type,
        min_zoom,
        max_zoom,
        int(min_lon * 1e7),
        int(min_lat * 1e7),
        int(max_lon * 1e7),
        int(max_lat * 1e7),
        c_zoom,
        int(c_lon * 1e7),
        int(c_lat * 1e7),
    )
    assert len(header) == HEADER_LEN, len(header)

    with open(path, "wb") as f:
        f.write(header)
        f.write(root_z)
        f.write(leaf_z)
        f.write(meta_z)
        f.write(bytes(data_blob))

    return {
        "tiles": len(entries),
        "bytes": HEADER_LEN + len(root_z) + len(leaf_z) + len(meta_z) + len(data_blob),
        "root_bytes": len(root),
        "has_leaves": bool(leaf_section),
    }
