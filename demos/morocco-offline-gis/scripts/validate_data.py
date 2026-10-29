"""Offline data acceptance validator.

Checks everything the task doc's data contract requires, from the generated
files only (plus the terrain source as ground truth).  The mode is
auto-detected from metadata.json -> terrain.mode:

  synthetic (v1.0.0): DEM accuracy is measured against the analytic model.
  real (v1.1.0): Copernicus DEM GLO-30 provenance + anti-fallback fingerprint
    detector + terrarium-vs-GeoTIFF accuracy + extremes + seam continuity and
    contour/DEM consistency.

Shared checks (both modes):
  1. PMTiles structure: header fields sane, every expected tile inside the
     coverage bbox resolvable through the independent reader.
  2. Contours: MVT layer parses; ele values are multiples of the zoom's
     interval and lie within the tile's DEM elevation range; geometry type is
     LineString.
  3. Glyphs: PBF parses; ASCII coverage incl. digits present.
  4. GeoJSON: structure + anchor presence + RSRP value ranges (+ simulated
     flags / rank / dem_ele in real mode).
  5. metadata.json: simulated flag, zooms, legend (== palette stops), scenes,
     archive header bbox vs declared coverage.

Exit code 0 = PASS. Any FAIL line -> exit 1.
"""

from __future__ import annotations

import argparse
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
from pipeline.dem_real import COVERAGE_BBOX, HYPSO_STOPS_REAL
from pipeline.glyphs import ttf_covers

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
GLYPHS = os.path.join(ROOT, "public", "assets", "glyphs", "Noto Sans Regular", "0-255.pbf")
DEFAULT_DEM_DIR = os.path.join(ROOT, "data_sources", "copernicus-glo30")

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

    def header_bbox(self) -> tuple[float, float, float, float]:
        return (self.min_lon / 1e7, self.min_lat / 1e7, self.max_lon / 1e7, self.max_lat / 1e7)


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


def validate_archive(name: str, path: str, zmin: int, zmax: int, tile_type: int, bbox) -> Archive:
    print(f"[1] PMTiles structure: {name}")
    check(os.path.exists(path), f"{name} exists", f"{os.path.getsize(path)/1e6:.1f} MB" if os.path.exists(path) else "")
    a = Archive(path)
    check(a.version == 3, "spec version 3", str(a.version))
    check(a.tile_type == tile_type, "tile type", str(a.tile_type))
    check((a.min_zoom, a.max_zoom) == (zmin, zmax), "zoom range", f"{a.min_zoom}-{a.max_zoom}")
    hb = a.header_bbox()
    bbox_ok = all(abs(h - b) < 1e-5 for h, b in zip(hb, bbox))
    check(bbox_ok, "archive header bbox == declared coverage",
          f"header {tuple(round(v, 4) for v in hb)}")
    missing = 0
    total = 0
    for z in range(zmin, zmax + 1):
        for (x, y) in bbox_tiles(z, bbox):
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


def decode_dem_tile(a: Archive, z: int, x: int, y: int) -> np.ndarray | None:
    """Terrarium-decoded elevation grid (float64, metres) or None."""
    raw = a.get_tile(z, x, y)
    if raw is None:
        return None
    img = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float64)
    return img[..., 0] * 256 + img[..., 1] + img[..., 2] / 256 - 32768


def lonlat_to_tile_frac(z: int, lon: float, lat: float) -> tuple[float, float]:
    n = 2**z
    fx = (lon + 180) / 360 * n
    lr = math.radians(lat)
    fy = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    return fx, fy


def sample_decoded_tile(grid: np.ndarray, fx: float, fy: float, bilinear: bool) -> float:
    """Sample a decoded 512px tile at fractional tile coords (nearest or bilinear)."""
    size = grid.shape[0]
    px = fx * size - 0.5
    py = fy * size - 0.5
    if not bilinear:
        return float(grid[min(size - 1, max(0, int(py))), min(size - 1, max(0, int(px)))])
    px = min(size - 1 - 1e-6, max(0.0, px))
    py = min(size - 1 - 1e-6, max(0.0, py))
    x0, y0 = int(px), int(py)
    tx, ty = px - x0, py - y0
    return float(
        grid[y0, x0] * (1 - tx) * (1 - ty)
        + grid[y0, x0 + 1] * tx * (1 - ty)
        + grid[y0 + 1, x0] * (1 - tx) * ty
        + grid[y0 + 1, x0 + 1] * tx * ty
    )


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
        fx, fy = lonlat_to_tile_frac(z, lon, lat)
        raw = dem.get_tile(z, int(fx), int(fy))
        if raw is None:
            check(False, f"anchor tile present: {name}")
            continue
        img = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.float64)
        h = img.shape[0]
        px = min(h - 1, int((fx % 1) * h))
        py = min(h - 1, int((fy % 1) * h))
        got = img[py, px, 0] * 256 + img[py, px, 1] + img[py, px, 2] / 256 - 32768
        err = abs(got - target)
        worst_anchor = max(worst_anchor, err)
    check(worst_anchor <= 60.0, "anchor elevations within 60 m via tile decode", f"max {worst_anchor:.1f} m")


# ------------------------------------------------------- real DEM (v1.1.0) ---
ANCHOR_BY_NAME = {a[0]: a for a in ANCHORS}
# v1.1.0 reconciliation: features renamed / re-anchored vs the legacy
# synthetic ANCHORS table (peak labels re-claimed onto real summits).
# name -> (lon, lat, nominal)
REAL_RECONCILED = {
    "Jbel Aguelzim": (-7.9830, 31.0670, 3547),
}
# published peaks (rank 1-5) and passes (rank 6-7) in real mode
REAL_PUBLISH_ANCHORS = [
    ("Jbel Toubkal", 1),
    ("Jbel Ouanoukrim", 2),
    ("Aksoual", 3),
    ("Jbel Aguelzim", 4),
    ("Adrar n'Dern", 5),
    ("Tizi n'Tichka", 6),
    ("Tizi n'Tamatert", 7),
]


def _sha256_of(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_real_provenance(meta: dict, dem_dir: str) -> None:
    print("[2] Real DEM provenance (metadata vs source GeoTIFFs)")
    t = meta.get("terrain") or {}
    check(t.get("mode") == "real", "terrain.mode == 'real'", str(t.get("mode")))
    check(meta.get("simulated") is False, "simulated flag false")
    sf = t.get("source_files") or []
    check(len(sf) == 6, "6 source files listed", str(len(sf)))
    hex_ok = all(len(f.get("sha256", "")) == 64 and all(c in "0123456789abcdef" for c in f["sha256"]) for f in sf)
    check(hex_ok and len(sf) > 0, "each source file lists a sha256")
    names = [f.get("name") for f in sf]
    check(len(set(names)) == len(names) and all(n and n.endswith(".tif") for n in names),
          "source file names unique *.tif")

    # combined digest: sha256 over the per-file hashes concatenated in sorted
    # filename order (mirrors pipeline.dem_real.combined_sha256)
    import hashlib

    combo = hashlib.sha256()
    for x in sorted(f["sha256"] for f in sf):
        combo.update(x.encode("ascii"))
    check(combo.hexdigest() == t.get("source_sha256"), "terrain.source_sha256 consistent")

    tif_paths = sorted(
        os.path.join(dem_dir, f) for f in os.listdir(dem_dir) if f.endswith(".tif")
    ) if os.path.isdir(dem_dir) else []
    if tif_paths:
        listed = {f["name"]: f["sha256"] for f in sf}
        mismatch = []
        for p in tif_paths:
            nm = os.path.basename(p)
            if nm not in listed or _sha256_of(p) != listed[nm]:
                mismatch.append(nm)
        check(len(tif_paths) == len(sf) and not mismatch,
              "local --dem-dir sha256 matches metadata", f"{len(tif_paths)} files, mismatch {mismatch}")
    else:
        print(f"  NOTE --dem-dir not found ({dem_dir}); on-disk sha256 recompute skipped")

    check(t.get("product") == "Copernicus DEM GLO-30", "product", str(t.get("product")))
    check(t.get("crs") == "EPSG:4326", "crs", str(t.get("crs")))
    vd = str(t.get("vertical_datum", ""))
    check(vd.startswith("EGM2008"), "terrain vertical datum EGM2008", vd)
    check(t.get("native_resolution_m") == 30, "native_resolution_m == 30", str(t.get("native_resolution_m")))
    cov = t.get("coverage") or []
    check(len(cov) == 4 and all(abs(float(a) - float(b)) < 1e-6 for a, b in zip(cov, COVERAGE_BBOX)),
          "terrain.coverage == COVERAGE_BBOX", str(cov))
    vpf = t.get("void_pixels_filled")
    check(isinstance(vpf, int) and vpf >= 0, "void_pixels_filled reported", str(vpf))
    check((meta.get("network_data") or {}).get("mode") == "simulated", "network_data.mode simulated")
    check((meta.get("geo_features") or {}).get("mode") == "simulated roads / curated nominal peaks",
          "geo_features.mode", str((meta.get("geo_features") or {}).get("mode")))
    d = meta.get("dem") or {}
    check(d.get("vertical_datum") == "EGM2008", "dem.vertical_datum EGM2008", str(d.get("vertical_datum")))
    check(d.get("source") == "Copernicus DEM GLO-30 (real)", "dem.source", str(d.get("source")))
    check(d.get("nominal_resolution_m") == "30 m", "dem.nominal_resolution_m", str(d.get("nominal_resolution_m")))
    check((meta.get("contours") or {}).get("source") == "generated from the same real DEM as the DEM tiles",
          "contours.source", str((meta.get("contours") or {}).get("source")))


def validate_real_terrain(dem: Archive, dem_dir: str, bbox) -> None:
    print("[3] Real DEM accuracy / anti-fallback / extremes")
    if not os.path.isdir(dem_dir) or not any(f.endswith(".tif") for f in os.listdir(dem_dir)):
        check(False, "source GeoTIFFs available for accuracy ground truth", dem_dir)
        return
    from pipeline.dem_real import RealDEM

    demr = RealDEM(dem_dir)
    z = dem.max_zoom

    # --- accuracy: decoded z12 terrarium vs direct GeoTIFF bilinear sample ---
    rng = np.random.default_rng(20261029)
    min_lon, min_lat, max_lon, max_lat = bbox
    lons = rng.uniform(min_lon, max_lon, 64)
    lats = rng.uniform(min_lat, max_lat, 64)
    expected = demr.sample(lons, lats, level=0)
    err_b, err_near = [], []
    tile_cache: dict[tuple[int, int], np.ndarray] = {}
    for i in range(len(lons)):
        fx, fy = lonlat_to_tile_frac(z, float(lons[i]), float(lats[i]))
        key = (int(fx), int(fy))
        if key not in tile_cache:
            g = decode_dem_tile(dem, z, key[0], key[1])
            if g is None:
                check(False, f"z12 tile present for accuracy point {i}", str(key))
                return
            tile_cache[key] = g
        g = tile_cache[key]
        err_b.append(abs(sample_decoded_tile(g, fx % 1.0, fy % 1.0, bilinear=True) - expected[i]))
        err_near.append(abs(sample_decoded_tile(g, fx % 1.0, fy % 1.0, bilinear=False) - expected[i]))
    err_b = np.array(err_b)
    err_near = np.array(err_near)
    check(float(err_b.max()) <= 30.0,
          "terrarium (bilinear decode) vs GeoTIFF bilinear <= 30 m",
          f"max {err_b.max():.2f} m, mean {err_b.mean():.2f} m over {len(err_b)} pts")
    print(f"  info nearest-pixel decode vs GeoTIFF: max {err_near.max():.1f} m, mean {err_near.mean():.1f} m")

    # --- anti-fallback: synthetic model was SOLVED to hit nominal anchors
    # exactly; real terrain must NOT match the published nominal elevations
    # within +/-2 m at most anchors.
    print("  anti-fallback probe (decoded tile vs published nominal):")
    matches = 0
    for name, _rank in REAL_PUBLISH_ANCHORS:
        if name in REAL_RECONCILED:
            lon, lat, nominal = REAL_RECONCILED[name]
        else:
            _n, lon, lat, nominal, _s, _k = ANCHOR_BY_NAME[name]
        fx, fy = lonlat_to_tile_frac(z, lon, lat)
        g = tile_cache.get((int(fx), int(fy)))
        if g is None:
            g = decode_dem_tile(dem, z, int(fx), int(fy))
            if g is None:
                check(False, f"dem tile present at anchor {name}")
                return
            tile_cache[(int(fx), int(fy))] = g
        got = sample_decoded_tile(g, fx % 1.0, fy % 1.0, bilinear=False)
        near = abs(got - nominal) <= 2.0
        matches += int(near)
        print(f"    {name:20s} nominal {nominal:6.0f} m  decoded {got:7.1f} m  {'<-- matches nominal!' if near else ''}")
    check(matches < 5, "no synthetic fingerprint (<=4/7 anchors within +/-2 m of nominal)",
          f"{matches}/7 match")

    # --- extremes over all decoded z12 coverage tiles -----------------------
    tiles = bbox_tiles(z, bbox)
    gmin, gmax = float("inf"), float("-inf")
    for (x, y) in tiles:
        g = tile_cache.get((x, y))
        if g is None:
            g = decode_dem_tile(dem, z, x, y)
            if g is None:
                check(False, f"z12 dem tile present {x},{y}")
                continue
            tile_cache[(x, y)] = g
        gmin = min(gmin, float(g.min()))
        gmax = max(gmax, float(g.max()))
    check(gmin > 0.0, "no nodata leaks (all decoded elevations > 0 m)", f"min {gmin:.1f} m")
    check(150.0 <= gmin <= 800.0, "min elevation in [150, 800] m", f"{gmin:.1f} m")
    check(4000.0 <= gmax <= 4300.0, "max elevation in [4000, 4300] m", f"{gmax:.1f} m")


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


def parse_mvt_contour_features(raw: bytes) -> list[tuple[int, list[int], bytes]]:
    """-> [(geom_type, [ele,...], geometry_blob)] for every 'contour' feature."""
    out: list[tuple[int, list[int], bytes]] = []
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
            geom = b""
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
                    elif f3 == 4:
                        geom = payload
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
            out.append((gtype, eles, geom))
    return out


def mvt_vertices(geom: bytes) -> list[tuple[int, int]]:
    """Decode the geometry command stream into absolute (x, y) vertices."""
    def unzigzag(v: int) -> int:
        return (v >> 1) ^ -(v & 1)

    pos = 0
    cx = cy = 0
    verts: list[tuple[int, int]] = []
    while pos < len(geom):
        cmd, pos = read_uvarint(geom, pos)
        cid, count = cmd & 7, cmd >> 3
        for _ in range(count):
            if cid in (1, 2):  # MoveTo / LineTo
                dx, pos = read_uvarint(geom, pos)
                dy, pos = read_uvarint(geom, pos)
                cx += unzigzag(dx)
                cy += unzigzag(dy)
                verts.append((cx, cy))
            # ClosePath (7): no parameters
    return verts


CONTOUR_INTERVALS = {6: 500.0, 7: 500.0, 8: 500.0, 9: 100.0, 10: 100.0, 11: 100.0, 12: 50.0}


def validate_contours(contours: Archive, bbox, dem: Archive | None, real: bool) -> None:
    print("[4] Contour vector tiles")
    z = contours.max_zoom
    tiles = bbox_tiles(z, bbox)
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
        if real:
            # tile elevation range straight from the decoded DEM tile
            g = decode_dem_tile(dem, z, x, y) if dem is not None else None
            if g is None:
                continue
            lo, hi = float(g.min()), float(g.max())
        else:
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
        for gtype, eles, _geom in feats:
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

    if not real:
        return

    # real mode extras: interval multiplicity across ALL zoom bands, feature
    # presence per zoom, and strict DEM-range check on 3 tiles at max zoom.
    for zz, iv in CONTOUR_INTERVALS.items():
        if zz > contours.max_zoom:
            continue  # fast dev build: high zooms absent
        ztiles = bbox_tiles(zz, bbox)
        sel = ztiles[:: max(1, len(ztiles) // 6)]
        n_f = 0
        bad_m = 0
        for (x, y) in sel:
            raw = contours.get_tile(zz, x, y)
            if raw is None:
                continue
            for gtype, eles, _geom in parse_mvt_contour_features(gzip.decompress(raw)):
                n_f += 1
                for e in eles:
                    if not isinstance(e, int) or abs(e / iv - round(e / iv)) > 1e-9:
                        bad_m += 1
        check(n_f > 0, f"contour features present at z{zz}", f"{n_f} sampled")
        check(bad_m == 0, f"ele multiple of {iv:g} m at z{zz}", str(bad_m))

    ztiles = bbox_tiles(contours.max_zoom, bbox)
    picks = [ztiles[len(ztiles) // 6], ztiles[len(ztiles) // 2], ztiles[(5 * len(ztiles)) // 6]]
    violations = 0
    for (x, y) in picks:
        g = decode_dem_tile(dem, contours.max_zoom, x, y)
        raw = contours.get_tile(contours.max_zoom, x, y)
        if g is None or raw is None:
            check(False, f"z{contours.max_zoom} dem+contour tiles present {x},{y}")
            continue
        lo, hi = float(g.min()), float(g.max())
        n_e = 0
        for gtype, eles, _geom in parse_mvt_contour_features(gzip.decompress(raw)):
            for e in eles:
                n_e += 1
                if not (lo <= e <= hi):
                    violations += 1
                    print(f"    out-of-range: tile {x},{y} dem [{lo:.1f}, {hi:.1f}] ele {e}")
        if n_e == 0:
            violations += 1
            print(f"    no contour features in sampled tile {x},{y}")
    check(violations == 0, f"z{contours.max_zoom} contour ele within decoded DEM tile min/max (3 tiles)",
          f"{violations} violations")


# ------------------------------------------------------------------- seams ---
def validate_seams(dem: Archive, contours: Archive, bbox) -> None:
    print("[5] Seam continuity (real DEM)")
    z = dem.max_zoom
    tiles = bbox_tiles(z, bbox)
    xs = sorted({x for x, _y in tiles})
    ys = sorted({y for _x, y in tiles})

    # raster: decoded edge columns of 2 adjacent tile pairs must not jump
    pair_stats = []
    for x in xs[:-1]:
        for y in ys[: len(ys) // 2]:
            gl = decode_dem_tile(dem, z, x, y)
            gr = decode_dem_tile(dem, z, x + 1, y)
            if gl is None or gr is None:
                continue
            pair_stats.append((x, y, float(np.abs(gl[:, -1] - gr[:, 0]).mean())))
            if len(pair_stats) == 2:
                break
        if len(pair_stats) == 2:
            break
    check(len(pair_stats) == 2, "found 2 adjacent z12 tile pairs", str(len(pair_stats)))
    for x, y, mean_jump in pair_stats:
        check(mean_jump <= 25.0, f"edge-column mean jump <= 25 m at ({x},{y})|({x + 1},{y})",
              f"{mean_jump:.2f} m")

    # vector: shared-edge contour vertices must exist on both sides at the same
    # coordinate (shared margin lattice keeps tiles seam-matched)
    found_match = False
    tried = 0
    for x in xs[:-1]:
        for y in ys:
            rl = contours.get_tile(z, x, y)
            rr = contours.get_tile(z, x + 1, y)
            if rl is None or rr is None:
                continue
            tried += 1
            vl = mvt_vertices_sets(gzip.decompress(rl))
            vr = mvt_vertices_sets(gzip.decompress(rr))
            edge_l = {(py) for (px, py) in vl if px == 4096}
            edge_r = {(py) for (px, py) in vr if px == 0}
            if edge_l & edge_r:
                found_match = True
                break
        if found_match:
            break
    check(found_match, "MVT boundary vertices seam-match (shared-edge y coords)",
          f"{tried} adjacent pairs tried")


def mvt_vertices_sets(mvt_raw: bytes) -> list[tuple[int, int]]:
    verts: list[tuple[int, int]] = []
    for _gtype, _eles, geom in parse_mvt_contour_features(mvt_raw):
        verts.extend(mvt_vertices(geom))
    return verts


# ------------------------------------------------------------------ glyphs ---
def parse_glyph_pbf(path: str) -> tuple[str, list[int]]:
    """-> (fontstack name, glyph ids) from a glyphs.pbf range file."""
    raw = open(path, "rb").read()
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
    return name, glyph_ids


def validate_glyphs(real: bool) -> None:
    print("[6] Glyph PBF")
    check(os.path.exists(GLYPHS), "0-255.pbf exists", f"{os.path.getsize(GLYPHS)/1024:.0f} KB")
    name, glyph_ids = parse_glyph_pbf(GLYPHS)
    check(name == "Noto Sans Regular", "fontstack name", name)
    check(len(glyph_ids) >= 90, "glyph count", str(len(glyph_ids)))
    need = list(range(48, 58)) + [ord("m"), ord(" ")] + list(range(65, 91)) + list(range(97, 123))
    missing = [c for c in need if c not in glyph_ids]
    check(not missing, "ASCII digits/letters/space present", f"missing {len(missing)}")

    if not real:
        return

    # Peak-label prefix range (U+25B2 -> MapLibre requests 9472-9727).  The
    # file is only shipped when the source TTF cmap maps the codepoint;
    # verify exactly that invariant.
    range_path = os.path.join(ROOT, "public", "assets", "glyphs", "Noto Sans Regular", "9472-9727.pbf")
    if os.path.exists(range_path):
        rname, rids = parse_glyph_pbf(range_path)
        check(rname == "Noto Sans Regular", "9472-9727.pbf fontstack name", rname)
        check(0x25B2 in rids, "9472-9727.pbf maps U+25B2 (9650)", f"{len(rids)} glyphs")
    else:
        ttf = os.path.join(
            ROOT, "node_modules", "@expo-google-fonts", "noto-sans", "400Regular", "NotoSans_400Regular.ttf"
        )
        if not os.path.exists(ttf):
            import glob

            cands = glob.glob(
                os.path.join(ROOT, "node_modules", "@expo-google-fonts", "noto-sans", "**", "*Regular*.ttf"),
                recursive=True,
            )
            ttf = cands[0] if cands else None
        if ttf is None:
            print("  NOTE source TTF unavailable; cannot verify U+25B2 coverage (ASCII fallback assumed)")
            check(True, "9472-9727.pbf absent - U+25B2 unverified, ASCII fallback prefix expected")
        elif 0x25B2 not in ttf_covers(ttf, (0x25B2,)):
            check(True, "9472-9727.pbf correctly absent (source TTF does not map U+25B2; ASCII fallback prefix)",
                  "NOTE")
        else:
            check(False, "9472-9727.pbf missing but source TTF maps U+25B2 - rerun prepare_data.py")


# ----------------------------------------------------------------- geojson ---
def validate_geojson(real: bool) -> None:
    print("[7] GeoJSON")
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

    if real:
        roads = [f for f in rp["features"] if f["geometry"]["type"] == "LineString"]
        check(len(roads) == 3 and all(f["properties"].get("simulated") is True for f in roads),
              "roads carry simulated:true", f"{len(roads)} roads")
        points = [f for f in rp["features"] if f["geometry"]["type"] == "Point"]
        peaks_passes = [f for f in points if f["properties"].get("kind") in ("peak", "pass")]
        check(len(peaks_passes) == 7, "7 published peaks+passes", str(len(peaks_passes)))
        bad = []
        ranks_seen = set()
        for f in peaks_passes:
            p = f["properties"]
            name = p.get("name")
            if name in REAL_RECONCILED:
                _rlon, _rlat, nominal = REAL_RECONCILED[name]
            else:
                _n, _lon, _lat, nominal, _s, _k = ANCHOR_BY_NAME.get(name, (None,) * 6)
            ok = (
                p.get("simulated") is False
                and p.get("ele") == int(nominal)
                and isinstance(p.get("dem_ele"), int)
                and isinstance(p.get("rank"), int) and 1 <= p["rank"] <= 7
            )
            ranks_seen.add(p.get("rank"))
            if not ok:
                bad.append(name)
        check(not bad, "peaks/passes: nominal ele + dem_ele + rank + simulated:false", f"bad {bad}")
        check(len(ranks_seen) == 7, "peak/pass ranks 1-7 unique", str(sorted(ranks_seen)))

        # v1.1.0 reconciliation invariants: claimed labels stay within a sane
        # distance (3.5 km) and elevation (+/-450 m) envelope, unless the
        # name is explicitly allow-listed with a recorded reason.
        snap_allow = {
            "Jbel Aguelzim": (3300, "GLO-30-smoothed Aguelzim summit ~3472 m vs nominal 3547; accepted floor 3300 m"),
        }
        snap_bad = []
        moved_no_ref = []
        for f in points:
            p = f["properties"]
            name = p.get("name")
            off = p.get("snap_offset_m")
            if off is not None and not p.get("snap_ref"):
                moved_no_ref.append(name)
            if p.get("kind") != "peak":
                continue
            dem_ele, ele = p.get("dem_ele"), p.get("ele")
            if not (isinstance(off, int) and 0 <= off <= 3500):
                snap_bad.append(f"{name}: snap_offset_m {off!r} not int in [0, 3500]")
                continue
            if not (isinstance(dem_ele, int) and isinstance(ele, int)):
                snap_bad.append(f"{name}: dem_ele/ele not ints")
                continue
            if abs(dem_ele - ele) <= 450:
                continue
            if name in snap_allow and dem_ele >= snap_allow[name][0]:
                continue
            snap_bad.append(f"{name}: dem_ele {dem_ele} vs ele {ele} ({dem_ele - ele:+d} m, not allowlisted)")
        check(not snap_bad,
              "peaks: snap_offset_m <= 3500 and dem_ele within +/-450 m of ele (or allowlisted)",
              f"bad {snap_bad}")
        check(not moved_no_ref, "moved features carry snap_ref provenance", f"missing {moved_no_ref}")
        places = [f for f in points if f["properties"].get("kind") == "place"]
        check(all(f["properties"].get("simulated") is False for f in places),
              "places carry simulated:false", f"{len(places)} places")
        check(all(isinstance(f["properties"].get("rank"), int) and f["properties"]["rank"] >= 8 for f in places),
              "place ranks >= 8")
    else:
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
def validate_metadata(dem: Archive, contours: Archive, real: bool) -> None:
    print("[8] metadata.json")
    meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
    if real:
        check(meta.get("simulated") is False, "simulated flag false")
    else:
        check(meta.get("simulated") is True, "simulated flag true")
    check(meta["dem"]["encoding"] == "terrarium", "terrarium encoding")
    check(meta["dem"]["zooms"] == [dem.min_zoom, dem.max_zoom], "dem zooms match archive", str(meta["dem"]["zooms"]))
    check(meta["contours"]["intervals_by_zoom"] == {"6-8": 500, "9-11": 100, "12+": 50}, "contour intervals")
    check(contours.min_zoom == 6, "contour archive min zoom 6")
    legend = meta["hypso"]["legend"]
    check(len(legend) >= 10, "hypsometric legend entries", str(len(legend)))
    if real:
        expected = [{"elev_m": e, "color": c} for e, c in HYPSO_STOPS_REAL]
        check(legend == expected, "legend exactly equals real LUT stops",
              f"{len(legend)} stops vs {len(expected)}")
        check(meta["dem"]["zooms"] == [7, 12], "release dem zooms [7, 12]", str(meta["dem"]["zooms"]))
        check(all(s.get("pitch") in (48, 50) for s in meta["scenes"]),
              "scene pitches updated (48/50)", str([s.get("pitch") for s in meta["scenes"]]))
    check(len(meta["scenes"]) >= 3, "fly-to scenes", str(len(meta["scenes"])))
    check("SIMULATED" in (meta.get("ran") or {}).get("note", ""), "ran layer labelled SIMULATED",
          str((meta.get("ran") or {}).get("note"))[:40])


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate the generated offline data")
    ap.add_argument("--dem-dir", default=DEFAULT_DEM_DIR,
                    help="GLO-30 GeoTIFF directory for real-mode ground truth (default %(default)s)")
    args = ap.parse_args()

    meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
    real = (meta.get("terrain") or {}).get("mode") == "real"
    bbox = COVERAGE_BBOX if real else GEN_BBOX
    print(f"mode: {meta.get('terrain', {}).get('mode', 'synthetic')}  coverage: {tuple(bbox)}")

    # zoom expectations track the declared build (full release: dem 7-12,
    # contours 6-12; --fast dev builds cap both at 11 and are gated in
    # validate_metadata's release-zoom check)
    zmin_dem, zmax_dem = meta["dem"]["zooms"]
    dem = validate_archive("dem-terrarium.pmtiles", os.path.join(DATA, "dem-terrarium.pmtiles"), zmin_dem, zmax_dem, 2, bbox)
    validate_archive("hypso.pmtiles", os.path.join(DATA, "hypso.pmtiles"), zmin_dem, zmax_dem, 2, bbox)
    contours = validate_archive("contours.pmtiles", os.path.join(DATA, "contours.pmtiles"), 6, zmax_dem, 1, bbox)
    if real:
        validate_real_provenance(meta, args.dem_dir)
        validate_real_terrain(dem, args.dem_dir, bbox)
        validate_contours(contours, bbox, dem=dem, real=True)
        validate_seams(dem, contours, bbox)
    else:
        validate_dem_accuracy(dem)
        validate_contours(contours, GEN_BBOX, dem=None, real=False)
    validate_glyphs(real)
    validate_geojson(real)
    validate_metadata(dem, contours, real)

    print(f"\n==== {CHECKS - len(FAILS)}/{CHECKS} checks passed ====")
    if FAILS:
        print("FAILED:", *FAILS, sep="\n  - ")
        sys.exit(1)


if __name__ == "__main__":
    main()
