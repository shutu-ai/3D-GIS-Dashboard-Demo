"""Round-trip test for the hand-rolled PMTiles v3 writer.

1. Writes a small archive with known payloads.
2. Reads it back with an independent minimal Python reader (LE header +
   Hilbert tile ids + directory walk).
3. The authoritative cross-check (same `pmtiles` npm package the frontend
   uses) lives in scripts/verify-pmtiles-node.mjs.
"""

import gzip
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from pipeline import pmtiles_writer as pw


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


def parse_directory(raw: bytes) -> list[tuple[int, int, int, int]]:
    """Independent v3 directory parser -> [(tile_id, run_length, length, offset)]."""
    n, pos = read_uvarint(raw, 0)
    tile_ids = []
    tid = 0
    for _ in range(n):
        d, pos = read_uvarint(raw, pos)
        tid += d
        tile_ids.append(tid)
    run_lengths = []
    for _ in range(n):
        v, pos = read_uvarint(raw, pos)
        run_lengths.append(v)
    lengths = []
    for _ in range(n):
        v, pos = read_uvarint(raw, pos)
        lengths.append(v)
    offsets = []
    prev_end = 0
    for i in range(n):
        v, pos = read_uvarint(raw, pos)
        if v == 0 and i > 0:
            offsets.append(prev_end)
        else:
            offsets.append(v - 1)
        prev_end = offsets[-1] + lengths[i]
    assert pos == len(raw), f"directory not fully consumed: {pos} != {len(raw)}"
    return list(zip(tile_ids, run_lengths, lengths, offsets))


def find_tile(path: str, z: int, x: int, y: int) -> bytes | None:
    with open(path, "rb") as f:
        blob = f.read()
    assert blob[:7] == b"PMTiles", blob[:7]
    version = blob[7]
    assert version == 3, version
    (root_off, root_len, _meta_off, _meta_len, leaf_off, leaf_len, data_off, _data_len) = (
        struct.unpack_from("<QQQQQQQQ", blob, 8)
    )
    root = gzip.decompress(blob[root_off : root_off + root_len])

    def walk(dir_bytes: bytes, want: int) -> tuple[int, int] | None:
        for tid, rl, ln, off in parse_directory(dir_bytes):
            if rl == 0:  # leaf pointer
                lo = leaf_off + off
                leaf = gzip.decompress(blob[lo : lo + ln])
                hit = walk(leaf, want)
                if hit is not None:
                    return hit
            elif tid <= want < tid + rl:
                return off, ln
        return None

    hit = walk(root, pw.tileid(z, x, y))
    if hit is None:
        return None
    off, ln = hit
    return blob[data_off + off : data_off + off + ln]


def main() -> None:
    import gzip as _gzip

    tiles = {
        (9, 334, 232): _gzip.compress(b"TILE-9/334/232"),
        (10, 668, 464): _gzip.compress(b"TILE-10/668/464"),
        (11, 1336, 929): _gzip.compress(b"TILE-11/1336/929"),
        (12, 2673, 1858): _gzip.compress(b"TILE-12/2673/1858"),
    }
    # sanity: Hilbert tile ids must match the npm pmtiles package exactly
    # (values cross-checked by node -e "zxyToTileId(...)")
    assert pw.tileid(1, 0, 0) == 1
    assert pw.tileid(1, 1, 0) == 4
    assert pw.tileid(1, 1, 1) == 3
    assert pw.tileid(1, 0, 1) == 2
    assert pw.tileid(2, 0, 0) == 5
    assert pw.tileid(2, 1, 1) == 7
    assert pw.tileid(9, 334, 232) == 303633
    assert pw.tileid(12, 2673, 1858) == 19432540

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "test.pmtiles")
        stats = pw.write_pmtiles(
            path,
            tiles,
            tile_type=pw.TILE_TYPE_MVT,
            tile_compression=pw.COMPRESSION_GZIP,
            min_zoom=9,
            max_zoom=12,
            bbox=(-8.4, 30.85, -6.95, 31.55),
            center=(-7.65, 31.2, 11),
        )
        print("write stats:", stats)
        for (z, x, y), payload in tiles.items():
            got = find_tile(path, z, x, y)
            assert got == payload, f"{z}/{x}/{y}: {got!r} != {payload!r}"
        assert find_tile(path, 9, 1, 1) is None
        print("python round-trip OK: 4/4 tiles byte-identical, absent -> None")


if __name__ == "__main__":
    main()
