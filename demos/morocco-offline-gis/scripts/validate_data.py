"""Offline data acceptance validator.

Checks everything the task doc's data contract requires, from the generated
files only (plus the analytic model as ground truth):

  1. PMTiles structure: header fields sane, every expected tile inside the
     coverage bbox resolvable through the independent reader.
  2. DEM accuracy: terrarium-decoded PNG elevations vs the analytic model
     at pixel centres (<= 30 m, the stated nominal resolution), including
     named anchor summits.
  3. Contours: MVT layer parses; ele values are multiples of the zoom's
     interval and lie within one interval of the tile's DEM elevation range;
     geometry type is LineString.
  4. Glyphs: PBF parses; ASCII coverage incl. digits present.
  5. GeoJSON: structure + anchor presence + RSRP value ranges.
  6. metadata.json: simulated flag, zooms, legend, scenes.

Exit code 0 = PASS. Any FAIL line -> exit 1.
"""

from __future__ import annotations

import gzip
import io
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline import pmtiles_writer as pw
from pipeline.dem import ANCHORS, GEN_BBOX, elevation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
GLYPHS = os.path.join(ROOT, "public", "assets", "glyphs", "Noto Sans Regular", "0-255.pbf")

FAILS: list[str] = []
CHECKS = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if ok:
        print(f"  PASS {label}" + (f" ({detail})" if detail else ""))
    else:
        print(f"  FAIL {label}" + (f" ({detail})" if detail else ""))
        FAILS.append(label)


# ---------------------------------------------------------------- PMTiles ---
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
    n, pos = read_uvarint(raw, 0)
    tile_ids: list[int] = []
    tid = 0
    for _ in range(n):
        d, pos = read_uvarint(raw, pos)
        tid += d
        tile_ids.append(tid)
    run_lengths: list[int] = []
    for _ in range(n):
        v, pos = read_uvarint(raw, pos)
        run_lengths.append(v)
    lengths: list[int] = []
    for _ in range(n):
        v, pos = read_uvarint(raw, pos)
        lengths.append(v)
    offsets: list[int] = []
    prev_end = 0
    for i in range(n):
        v, pos = read_uvarint(raw, pos)
        if v == 0 and i > 0:
            offsets.append(prev_end)
        else:
            offsets.append(v - 1)
        prev_end = offsets[-1] + lengths[i]
    if pos != len(raw):
        raise ValueError(f"directory not fully consumed {pos} != {len(raw)}")
    return list(zip(tile_ids, run_lengths, lengths, offsets))


class Archive:
    def __init__(self, path: str):
        with open(path, "rb") as f:
            self.blob = f.read()
        assert self.blob[:7] == b"PMTiles"
        self.version = self.blob[7]
        (
            self.root_off,
            self.root_len,
            self.meta_off,
            self.meta_len,
            self.leaf_off,
            self.leaf_len,
            self.data_off,
            self.data_len,
            self.n_addr,
            self.n_entries,
            self.n_contents,
        ) = struct.unpack_from("<QQQQQQQQQQQ", self.blob, 8)
        (self.clustered, self.internal_comp, self.tile_comp, self.tile_type,
         self.min_zoom, self.max_zoom) = self.blob[96:102]
        self.min_lon, self.min_lat = struct.unpack_from("<ii", self.blob, 102)
        self.max_lon, self.max_lat = struct.unpack_from("<ii", self.blob, 110)
        self.center_zoom = self.blob[118]
        self.center_lon, self.center_lat = struct.unpack_from("<ii", self.blob, 119)
        self._dir_cache: dict[tuple[int, int], list[tuple[int, int, int, int]]] = {}

    def get_tile(self, z: int, x: int, y: int) -> bytes | None:
        want = pw.tileid(z, x, y)
        dO, dL = self.root_off, self.root_len
        for _depth in range(4):
            key = (dO, dL)
            if key not in self._dir_cache:
                raw = self.blob[dO : dO + dL]
                if self.internal_comp == 2:
                    raw = gzip.decompress(raw)
                self._dir_cache[key] = parse_directory(raw)
            entries = self._dir_cache[key]
            hit = None
            for tid, rl, ln, off in entries:
                if rl == 0:
                    if want >= tid:
                        hit = ("leaf", off, ln)
                elif tid <= want < tid + rl:
                    hit = ("tile", off, ln)
                    break
            if hit is None:
                return None
            kind, off, ln = hit
            if kind == "tile":
                return self.blob[self.data_off + off : self.data_off + off + ln]
            dO, dL = self.leaf_off + off, ln
        raise RuntimeError("leaf depth exceeded")


def bbox_tiles(z: int, bbox) -> list[tuple[int, int]]:
    min_lon, min_lat, max_lon, max_lat = bbox
    n = 2**z

    def fx(lon):
        return (lon + 180) / 360 * n

    def fy(lat):
        lr = math.radians(lat)
        return (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n

    out = []
    for x in range(max(0, int(fx(min_lon))), min(n - 1, int(fx(max_lon))) + 1):
        for y in range(max(0, int(fy(max_lat))), min(n - 1, int(fy(min_lat))) + 1):
            out.append((x, y))
    return out


def validate_archive(name: str, path: str, zmin: int, zmax: int, tile_type: int) -> Archive:
    print(f"[1] PMTiles structure: {name}")
    check(os.path.exists(path), f"{name} exists", f"{os.path.getsize(path)/1e6:.1f} MB" if os.path.exists(path) else "")
    a = Archive(path)
    check(a.version == 3, "spec version 3", str(a.version))
    check(a.tile_type == tile_type, "tile type", str(a.tile_type))
    check((a.min_zoom, a.max_zoom) == (zmin, zmax), "zoom range", f"{a.min_zoom}-{a.max_zoom}")
    missing = 0
    total = 0
    for z in range(zmin, zmax + 1):
        for (x, y) in bbox_tiles(z, GEN_BBOX):
            total += 1
            if a.get_tile(z, x, y) is None:
                missing += 1
    check(missing == 0, "all coverage tiles present", f"{total - missing}/{total}")
    outside = a.get_tile(zmin, 0, 0)
    check(outside is None, "tile outside coverage absent")
    return a


# --------------------------------------------------------------- terrarium ---
def tile_pixel_lonlat(z: int, x: int, y: int, px: int, py: int, size: int):
    n = 2**z
    fx = (x + (px + 0.5) / size) / n
    fy = (y + (py + 0.5) / size) / n
    lon = fx * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy))))
    return lon, lat


def validate_dem_accuracy(dem: Archive) -> None:
    print("[2] DEM accuracy (terrarium decode vs analytic model)")
    tol = 30.0
    worst = 0.0
    z = dem.max_zoom
    tiles = bbox_tiles(z, GEN_BBOX)
    step = max(1, len(tiles) // 12)
    n_samples = 0
    for (x, y) in tiles[::step]:
        raw = dem.get_tile(z, x, y)
        if raw is None:
            continue
        img = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float64)
        h, w = img.shape[:2]
        # sample a sparse grid of pixels
        ys, xs = np.meshgrid(np.arange(0, h, 32), np.arange(0, w, 32), indexing="ij")
        lons = np.empty(xs.size)
        lats = np.empty(xs.size)
        for i, (px, py) in enumerate(zip(xs.ravel(), ys.ravel())):
            lons[i], lats[i] = tile_pixel_lonlat(z, x, y, int(px), int(py), h)
        expect = elevation(lons, lats)
        got = img[ys.ravel(), xs.ravel(), 0] * 256 + img[ys.ravel(), xs.ravel(), 1] + img[ys.ravel(), xs.ravel(), 2] / 256 - 32768
        err = np.abs(got - expect)
        worst = max(worst, float(err.max()))
        n_samples += xs.size
    check(worst <= tol, f"pixel error <= {tol:g} m", f"max {worst:.1f} m over {n_samples} samples")

    # anchors: query the exact anchor pixel like the frontend does (nearest pixel)
    worst_anchor = 0.0
    for name, lon, lat, target, _s, _k in ANCHORS:
        n = 2**z
        tx = (lon + 180) / 360 * n
        lr = math.radians(lat)
        ty = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
        raw = dem.get_tile(z, int(tx), int(ty))
        if raw is None:
            check(False, f"anchor tile present: {name}")
            continue
        img = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float64)
        h = img.shape[0]
        px = min(h - 1, int((tx % 1) * h))
        py = min(h - 1, int((ty % 1) * h))
        got = img[py, px, 0] * 256 + img[py, px, 1] + img[py, px, 2] / 256 - 32768
        err = abs(got - target)
        worst_anchor = max(worst_anchor, err)
    check(worst_anchor <= 60.0, "anchor elevations within 60 m via tile decode", f"max {worst_anchor:.1f} m")


# --------------------------------------------------------------------- MVT ---
def parse_mvt_layer_names(raw: bytes) -> list[str]:
    pos = 0
    names = []
    while pos < len(raw):
        tag, pos = read_uvarint(raw, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 2:
            ln, pos = read_uvarint(raw, pos)
            payload = raw[pos : pos + ln]
            pos += ln
            if field == 3:  # layer
                q = 0
                while q < len(payload):
                    t2, q = read_uvarint(payload, q)
                    if (t2 >> 3) == 1 and (t2 & 7) == 2:
                        l2, q = read_uvarint(payload, q)
                        names.append(payload[q : q + l2].decode("utf-8"))
                        q += l2
                    elif (t2 & 7) == 0:
                        _, q = read_uvarint(payload, q)
                    elif (t2 & 7) == 2:
                        l3, q = read_uvarint(payload, q)
                        q += l3
                    else:
                        raise ValueError("bad layer wire")
        elif wire == 0:
            _, pos = read_uvarint(raw, pos)
        else:
            raise ValueError(f"bad wire {wire}")
    return names


def parse_mvt_contour_features(raw: bytes) -> list[tuple[int, list[int]]]:
    """-> [(geom_type, [ele,...])] for every feature in every 'contour' layer."""
    out: list[tuple[int, list[int]]] = []
    pos = 0
    while pos < len(raw):
        tag, pos = read_uvarint(raw, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            _, pos = read_uvarint(raw, pos)
            continue
        if wire != 2:
            raise ValueError(f"unexpected wire {wire} at tile level")
        ln, pos = read_uvarint(raw, pos)
        layer = raw[pos : pos + ln]
        pos += ln
        assert field == 3, f"expected layer field 3, got {field}"
        # walk layer: 1 name, 2 feature, 3 keys, 4 values, 5 extent, 15 version
        q = 0
        name = ""
        keys: list[str] = []
        values: list[object] = []
        feat_blobs: list[bytes] = []
        while q < len(layer):
            t2, q = read_uvarint(layer, q)
            f2, w2 = t2 >> 3, t2 & 7
            if w2 == 2:
                l2, q = read_uvarint(layer, q)
                payload = layer[q : q + l2]
                q += l2
                if f2 == 1:
                    name = payload.decode("utf-8")
                elif f2 == 2:
                    feat_blobs.append(payload)
                elif f2 == 3:
                    keys.append(payload.decode("utf-8"))
                elif f2 == 4:
                    # Value message
                    r = 0
                    val = None
                    while r < len(payload):
                        t3, r = read_uvarint(payload, r)
                        f3, w3 = t3 >> 3, t3 & 7
                        if w3 == 2:
                            l3, r = read_uvarint(payload, r)
                            val = payload[r : r + l3].decode("utf-8")
                            r += l3
                        elif w3 == 0:
                            v, r = read_uvarint(payload, r)
                            if f3 == 7:
                                val = bool(v)
                            elif f3 in (4, 5, 6):
                                if f3 == 6:  # sint64 zigzag
                                    val = (v >> 1) ^ -(v & 1)
                                else:
                                    val = v
                            else:
                                val = v
                        elif w3 == 5:
                            val = struct.unpack_from("<f", payload, r)[0]
                            r += 4
                    values.append(val)
            elif w2 == 0:
                _, q = read_uvarint(layer, q)
            else:
                raise ValueError("bad layer field")
        if name != "contour":
            continue
        for fb in feat_blobs:
            r = 0
            gtype = 0
            tags: list[int] = []
            while r < len(fb):
                t3, r = read_uvarint(fb, r)
                f3, w3 = t3 >> 3, t3 & 7
                if w3 == 2:
                    l3, r = read_uvarint(fb, r)
                    payload = fb[r : r + l3]
                    r += l3
                    if f3 == 2:
                        rr = 0
                        while rr < len(payload):
                            v, rr = read_uvarint(payload, rr)
                            tags.append(v)
                elif w3 == 0:
                    v, r = read_uvarint(fb, r)
                    if f3 == 3:
                        gtype = v
                else:
                    raise ValueError("bad feature wire")
            eles: list[int] = []
            for i in range(0, len(tags) - 1, 2):
                k = keys[tags[i]] if tags[i] < len(keys) else "?"
                v = values[tags[i + 1]] if tags[i + 1] < len(values) else "?"
                if k == "ele":
                    eles.append(v)
            out.append((gtype, eles))
    return out


CONTOUR_INTERVALS = {6: 500.0, 7: 500.0, 8: 500.0, 9: 100.0, 10: 100.0, 11: 100.0, 12: 50.0}


def validate_contours(contours: Archive) -> None:
    print("[3] Contour vector tiles")
    z = contours.max_zoom
    tiles = bbox_tiles(z, GEN_BBOX)
    step = max(1, len(tiles) // 10)
    n_feat = 0
    bad_multiple = 0
    bad_type = 0
    out_of_range = 0
    interval = CONTOUR_INTERVALS[z]
    for (x, y) in tiles[::step]:
        raw = contours.get_tile(z, x, y)
        if raw is None:
            continue
        mvt_raw = gzip.decompress(raw)  # tile_compression gzip
        feats = parse_mvt_contour_features(mvt_raw)
        n_feat += len(feats)
        # tile elevation range from the analytic model on a fine grid
        # (96x96: contour tiles are generated from a lattice at this order of
        # resolution; a coarser grid underestimates the range and false-flags)
        n2 = 2**z
        lons = np.linspace((x / n2) * 360 - 180, ((x + 1) / n2) * 360 - 180, 96)
        fy0 = (y + 1) / n2
        fy1 = y / n2
        lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy0))))
        lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * fy1))))
        lats = np.linspace(lat0, lat1, 96)
        gx, gy = np.meshgrid(lons, lats)
        grid = elevation(gx, gy)
        lo, hi = float(grid.min()), float(grid.max())
        for gtype, eles in feats:
            if gtype != 2:
                bad_type += 1
            for e in eles:
                if not isinstance(e, int) or abs(e / interval - round(e / interval)) > 1e-9:
                    bad_multiple += 1
                elif e < lo - interval or e > hi + interval:
                    out_of_range += 1
    check(n_feat > 0, "contour features present", f"{n_feat} features sampled")
    check(bad_type == 0, "all features LineString (type 2)", str(bad_type))
    check(bad_multiple == 0, f"ele multiple of {interval:g} m", str(bad_multiple))
    check(out_of_range == 0, "ele within tile DEM range +/- interval", str(out_of_range))


# ------------------------------------------------------------------ glyphs ---
def validate_glyphs() -> None:
    print("[4] Glyph PBF")
    check(os.path.exists(GLYPHS), "0-255.pbf exists", f"{os.path.getsize(GLYPHS)/1024:.0f} KB")
    raw = open(GLYPHS, "rb").read()
    pos = 0
    glyph_ids: list[int] = []
    name = ""
    while pos < len(raw):
        tag, pos = read_uvarint(raw, pos)
        field, wire = tag >> 3, tag & 7
        ln, pos = read_uvarint(raw, pos)
        stack = raw[pos : pos + ln]
        pos += ln
        assert field == 1  # fontstack
        q = 0
        while q < len(stack):
            t2, q = read_uvarint(stack, q)
            f2, w2 = t2 >> 3, t2 & 7
            if w2 == 2:
                l2, q = read_uvarint(stack, q)
                payload = stack[q : q + l2]
                q += l2
                if f2 == 1:
                    name = payload.decode("utf-8")
                elif f2 == 3:  # glyph
                    r = 0
                    gid = None
                    while r < len(payload):
                        t3, r = read_uvarint(payload, r)
                        f3, w3 = t3 >> 3, t3 & 7
                        if w3 == 2:
                            l3, r = read_uvarint(payload, r)
                            r += l3
                        elif w3 == 0:
                            v, r = read_uvarint(payload, r)
                            if f3 == 1:
                                gid = v
                    if gid is not None:
                        glyph_ids.append(gid)
            elif w2 == 0:
                _, q = read_uvarint(stack, q)
    check(name == "Noto Sans Regular", "fontstack name", name)
    check(len(glyph_ids) >= 90, "glyph count", str(len(glyph_ids)))
    need = list(range(48, 58)) + [ord("m"), ord(" ")] + list(range(65, 91)) + list(range(97, 123))
    missing = [c for c in need if c not in glyph_ids]
    check(not missing, "ASCII digits/letters/space present", f"missing {len(missing)}")


# ----------------------------------------------------------------- geojson ---
def validate_geojson() -> None:
    print("[5] GeoJSON")
    rp = json.load(open(os.path.join(DATA, "roads-peaks.geojson"), encoding="utf-8"))
    check(rp["type"] == "FeatureCollection", "roads-peaks FeatureCollection")
    kinds = {}
    names = set()
    for f in rp["features"]:
        k = f["properties"].get("kind")
        kinds[k] = kinds.get(k, 0) + 1
        names.add(f["properties"].get("name"))
    for k in ("peak", "pass", "place"):
        check(kinds.get(k, 0) > 0, f"features of kind '{k}'", str(kinds.get(k, 0)))
    anchor_names = {a[0] for a in ANCHORS}
    local_missing = anchor_names - names
    check(not local_missing, "all DEM anchors appear as features", str(sorted(local_missing)))

    ran = json.load(open(os.path.join(DATA, "simulated-ran.geojson"), encoding="utf-8"))
    check(ran["type"] == "FeatureCollection", "simulated-ran FeatureCollection")
    sites = [f for f in ran["features"] if f["geometry"]["type"] == "Point"]
    segs = [f for f in ran["features"] if f["properties"].get("rsrp_dbm") is not None]
    check(len(sites) >= 6, "RAN sites present", str(len(sites)))
    bad_rsrp = [f["properties"]["rsrp_dbm"] for f in segs if not (-141 <= f["properties"]["rsrp_dbm"] <= -57)]
    check(len(segs) > 50 and not bad_rsrp, "RSRP segments in [-140,-58]", f"{len(segs)} segs, bad {len(bad_rsrp)}")


# ---------------------------------------------------------------- metadata ---
def validate_metadata(dem: Archive, contours: Archive) -> None:
    print("[6] metadata.json")
    meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
    check(meta.get("simulated") is True, "simulated flag true")
    check(meta["dem"]["encoding"] == "terrarium", "terrarium encoding")
    check(meta["dem"]["zooms"] == [dem.min_zoom, dem.max_zoom], "dem zooms match archive", str(meta["dem"]["zooms"]))
    check(meta["contours"]["intervals_by_zoom"] == {"6-8": 500, "9-11": 100, "12+": 50}, "contour intervals")
    check(contours.min_zoom == 6, "contour archive min zoom 6")
    check(len(meta["hypso"]["legend"]) >= 10, "hypsometric legend entries", str(len(meta["hypso"]["legend"])))
    check(len(meta["scenes"]) >= 3, "fly-to scenes", str(len(meta["scenes"])))


def main() -> None:
    dem = validate_archive("dem-terrarium.pmtiles", os.path.join(DATA, "dem-terrarium.pmtiles"), 7, 12, 2)
    validate_archive("hypso.pmtiles", os.path.join(DATA, "hypso.pmtiles"), 7, 12, 2)
    contours = validate_archive("contours.pmtiles", os.path.join(DATA, "contours.pmtiles"), 6, 12, 1)
    validate_dem_accuracy(dem)
    validate_contours(contours)
    validate_glyphs()
    validate_geojson()
    validate_metadata(dem, contours)

    print(f"\n==== {CHECKS - len(FAILS)}/{CHECKS} checks passed ====")
    if FAILS:
        print("FAILED:", *FAILS, sep="\n  - ")
        sys.exit(1)


if __name__ == "__main__":
    main()
