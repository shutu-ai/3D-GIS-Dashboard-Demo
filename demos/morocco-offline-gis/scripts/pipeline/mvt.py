"""Minimal Mapbox Vector Tile (MVT v2) encoder — enough for LineString layers.

Wire format hand-encoded per vector_tile.proto:
  Layer: version(15), name(19 as bytes), features(18), extent(20 MessageInt)
  Feature: id(1), tags(2 packed varints), type(3 MessageInt enum), geometry(4 packed)
  Value: string(1) | float(2) | double(3) | int64(4) | uint64(5) | sint64(6) | bool(7)
Geometry commands: MoveTo=1, LineTo=2; parameters are zigzag varints.
"""

from __future__ import annotations


def zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 31) if n < 0 else n << 1


def unzigzag(n: int) -> int:
    return (n >> 1) ^ -(n & 1)


def _varint(value: int) -> bytes:
    value = value & 0xFFFFFFFFFFFFFFFF
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _tag(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _len_delim(field: int, payload: bytes) -> bytes:
    return _tag(field, 2) + _varint(len(payload)) + payload


def _varint_field(field: int, value: int) -> bytes:
    return _tag(field, 0) + _varint(value)


def encode_value(v) -> bytes:
    if isinstance(v, bool):
        return _tag(7, 0) + _varint(1 if v else 0)
    if isinstance(v, int):
        return _tag(4, 0) + _varint(v)  # int64
    if isinstance(v, float):
        import struct as _s

        return _tag(2, 5) + _s.pack("<f", v)
    s = str(v)
    return _len_delim(1, s.encode("utf-8"))


class Layer:
    def __init__(self, name: str, extent: int = 4096):
        self.name = name
        self.extent = extent
        self.features: list[tuple[int, list[int], list[list[tuple[int, int]]]]] = []
        # (geom_type, tag_pairs, geometries)  tag_pairs index key/value tables
        self.keys: list[str] = []
        self.values: list[bytes] = []
        self._key_idx: dict[str, int] = {}
        self._val_idx: dict[str, int] = {}

    def _key(self, k: str) -> int:
        if k not in self._key_idx:
            self._key_idx[k] = len(self.keys)
            self.keys.append(k)
        return self._key_idx[k]

    def _val(self, v) -> int:
        # dedupe on the wire bytes
        wire = encode_value(v)
        if wire not in self._val_idx:
            self._val_idx[wire] = len(self.values)
            self.values.append(wire)
        return self._val_idx[wire]

    def add_linestring(self, coords: list[tuple[int, int]], props: dict):
        """coords: tile-local integer coordinates (0..extent)."""
        if len(coords) < 2:
            return
        tags: list[int] = []
        for k, v in props.items():
            tags.append(self._key(k))
            tags.append(self._val(v))
        geom = _encode_commands(coords)
        self.features.append((2, tags, geom))

    def serialize(self) -> bytes:
        out = bytearray()
        out += _varint_field(15, 2)  # version 2
        out += _len_delim(1, self.name.encode("utf-8"))
        for geom_type, tags, geom in self.features:
            f = bytearray()
            # id omitted
            if tags:
                packed = b"".join(_varint(t) for t in tags)
                f += _len_delim(2, packed)
            f += _varint_field(3, geom_type)
            packed_geom = b"".join(_varint(g) for g in geom)
            f += _len_delim(4, packed_geom)
            out += _len_delim(2, bytes(f))
        for k in self.keys:
            out += _len_delim(3, k.encode("utf-8"))
        for v in self.values:
            out += _len_delim(4, v)
        out += _varint_field(5, self.extent)
        return bytes(out)


def encode_tile(layers: list["Layer"]) -> bytes:
    """Wrap serialized Layers in the Tile message (repeated Layer layers = 3)."""
    return b"".join(_len_delim(3, layer.serialize()) for layer in layers)


def _encode_commands(coords: list[tuple[int, int]]) -> list[int]:
    """MoveTo(1) then LineTo(2) command stream, cursor-relative zigzag deltas."""
    cmds: list[int] = []
    cx, cy = 0, 0
    x0, y0 = coords[0]
    cmds.append((2 << 3) | 1)  # MoveTo, 2 parameters
    cmds.append(zigzag(x0 - cx))
    cmds.append(zigzag(y0 - cy))
    cx, cy = x0, y0
    run: list[tuple[int, int]] = []
    for x, y in coords[1:]:
        run.append((x - cx, y - cy))
        cx, cy = x, y
    i = 0
    while i < len(run):
        j = i
        while j < len(run) and j - i < 8191:
            j += 1
        cmds.append(((2 * (j - i)) << 3) | 2)  # LineTo with 2*(j-i) parameters
        for dx, dy in run[i:j]:
            cmds.append(zigzag(dx))
            cmds.append(zigzag(dy))
        i = j
    return cmds
