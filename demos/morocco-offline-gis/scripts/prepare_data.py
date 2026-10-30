"""Prepare all offline data for the Morocco High Atlas GIS demo.

Two terrain modes, selected with --terrain-source:

  synthetic (default, v1.0.0): everything is programmatically generated
    (SIMULATED terrain per project decision) from one analytic elevation
    model (pipeline/dem.py), so DEM tiles, hypsometric tiles, contours,
    GeoJSON elevations and RAN site elevations are mutually consistent by
    construction.

  real: terrain comes from the local Copernicus DEM GLO-30 GeoTIFFs
    (pipeline/dem_real.py) via a pyramid-filtered sampler.  DEM/hypso tiles
    and contours are derived from the SAME real DEM; roads stay simulated,
    peaks/passes/places keep curated NOMINAL elevations plus the real
    `dem_ele` sample; the network layer stays SIMULATED.

Outputs (see the data contract in Docs/Architecture.md):
  public/data/dem-terrarium.pmtiles   raster DEM, terrarium encoding, z7-12, 512px
  public/data/hypso.pmtiles           raster hypsometric tint, z7-12, 512px
  public/data/contours.pmtiles        vector MVT "contour" {ele, major}, z6-13
  public/data/roads-peaks.geojson     roads / peaks / passes / places
  public/data/simulated-ran.geojson   sites / rsrp road segments (SIMULATED)
  public/data/metadata.json           coverage, zooms, legend, scenes, provenance
  public/assets/glyphs/Noto Sans Regular/0-255.pbf

Usage:
  python scripts/prepare_data.py [--fast]                 # synthetic (v1.0.0)
  python scripts/prepare_data.py --terrain-source real [--fast]
        [--dem-dir data_sources/copernicus-glo30]
  (--fast: z<=11 DEM + contours, quick dev check)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipeline import mvt, pmtiles_writer
from pipeline.contours import STEPS_PER_TILE, build_contour_tile, tile_fraction_to_lonlat
from pipeline.dem import ANCHORS, GEN_BBOX, SEED, TARGET_BBOX, elevation, elevation_scalar
from pipeline.dem_real import COVERAGE_BBOX, HYPSO_STOPS_REAL, RealDEM
from pipeline.glyphs import generate_glyph_pbf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "public", "data")
GLYPH_DIR = os.path.join(ROOT, "public", "assets", "glyphs")
DEFAULT_DEM_DIR = os.path.join("data_sources", "copernicus-glo30")

DEM_TILE_SIZE = 512
DEM_EVAL_SIZE = 256  # synthetic: evaluate the analytic model at 256px, bilinear upsample to 512
DEM_ZOOMS = (7, 12)  # z7-8 provide parent tiles for the default overview terrain
CONTOUR_ZOOMS = (6, 12)
CONTOUR_INTERVALS = [(6, 8, 500.0), (9, 11, 100.0), (12, 12, 50.0)]  # (zlo, zhi, m)

HYPSO_STOPS = [
    (400, "#3f7f63"),
    (600, "#5f9160"),
    (900, "#8ba05e"),
    (1200, "#b3a75c"),
    (1600, "#c99f63"),
    (2000, "#bd8b5b"),
    (2400, "#a97a5c"),
    (2800, "#98705f"),
    (3200, "#8a6d6a"),
    (3550, "#8f8b93"),
    (3850, "#bfc0c8"),
    (4050, "#eceef2"),
    (4160, "#ffffff"),
]

SCENES = [
    # Keep scene zooms within the z12 offline detail budget; the raster DEM
    # still shows the named peaks while avoiding a headless/WebGL tile storm.
    {"name": "Toubkal Peak", "lng": -7.9146, "lat": 31.0595, "zoom": 10.8, "pitch": 50, "bearing": 150},
    {"name": "High Atlas Ridges", "lng": -7.75, "lat": 31.12, "zoom": 10.8, "pitch": 48, "bearing": 30},
    {"name": "Tizi n'Tichka Pass", "lng": -7.4167, "lat": 31.25, "zoom": 10.8, "pitch": 50, "bearing": -30},
    {"name": "Mountain Road", "lng": -7.55, "lat": 31.17, "zoom": 10.8, "pitch": 48, "bearing": 75},
]

# v1.1.0 real-mode curated claims, in CLAIM ORDER (each claimed point
# reserves a mutual-exclusion zone for later peaks, so no two labels share
# one summit).  Anchors are published coordinates / DMS positions where the
# v1.0.0 synthetic ANCHORS proved off-summit (by up to ~3 km); Adrar n'Dern
# and Tizi n'Tichka keep their legacy curated coordinates.
#   (name, kind, rank, (anchor_lon, anchor_lat), nominal, radius_m,
#    min_dem|None, exclusions ((claimed_name, dist_m), ...), target_ele|None)
# Peaks: claim the max-elevation pixel; `min_dem` is the acceptance floor
# (nominal-400 style) - below it we still claim the best pixel but warn.
# Passes: radius/target_ele None = untouched; Tamatert reconciles onto the
# pixel whose elevation is closest to the nominal (move only if <= 150 m).
REAL_CLAIMS = [
    ("Jbel Toubkal", "peak", 1, (-7.9144, 31.0620), 4167, 1500.0, None, (), None),
    ("Jbel Ouanoukrim", "peak", 2, (-7.9206, 31.0367), 4089, 3000.0, 3689.0,
     (("Jbel Toubkal", 2000.0),), None),
    ("Aksoual", "peak", 3, (-7.9170, 31.0880), 3910, 3500.0, 3510.0,
     (("Jbel Toubkal", 2500.0), ("Jbel Ouanoukrim", 1500.0)), None),
    ("Jbel Aguelzim", "peak", 4, (-7.9830, 31.0670), 3547, 2000.0, 3300.0,
     (("Jbel Toubkal", 1500.0), ("Aksoual", 1500.0), ("Jbel Ouanoukrim", 2000.0)), 3547.0),
    ("Adrar n'Dern", "peak", 5, (-7.5500, 31.1850), 3000, 1500.0, None, (), None),
    ("Tizi n'Tichka", "pass", 6, (-7.4167, 31.2500), 2260, None, None, (), None),
    ("Tizi n'Tamatert", "pass", 7, (-7.9350, 31.1600), 2250, 2500.0, None, (), 2250.0),
]
SNAP_REF = "dem + published coordinates (see DATA_SOURCES_AND_LICENSES.md)"


# ---------------------------------------------------------------------------
# Web mercator helpers
# ---------------------------------------------------------------------------

def bbox_tile_range(z: int, bbox: tuple[float, float, float, float]) -> tuple[range, range]:
    min_lon, min_lat, max_lon, max_lat = bbox
    n = 2**z

    def fx(lon):
        return (lon + 180.0) / 360.0 * n

    def fy(lat):
        lat_r = math.radians(lat)
        return (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n

    x0 = max(0, int(math.floor(fx(min_lon))))
    x1 = min(n - 1, int(math.floor(fx(max_lon))))
    y0 = max(0, int(math.floor(fy(max_lat))))
    y1 = min(n - 1, int(math.floor(fy(min_lat))))
    return range(x0, x1 + 1), range(y0, y1 + 1)


def tile_grid(z: int, x: int, y: int, size: int):
    """lon/lat arrays for pixel CENTERS of a tile."""
    px = x + (np.arange(size) + 0.5) / size
    py = y + (np.arange(size) + 0.5) / size
    gx, gy = np.meshgrid(px, py)
    return tile_fraction_to_lonlat(z, gx, gy)


def encode_terrarium(elev: np.ndarray) -> bytes:
    """elev -> terrarium PNG bytes (v = elev + 32768, identical to v1.0.0)."""
    v = elev + 32768.0
    r = np.clip(np.floor(v / 256.0), 0, 255).astype(np.uint8)
    g = np.clip(np.floor(v) % 256, 0, 255).astype(np.uint8)
    b = np.clip(np.round((v - np.floor(v)) * 255.0), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(np.dstack([r, g, b]), "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Raster tile builders — synthetic (v1.0.0, unchanged)
# ---------------------------------------------------------------------------

def build_dem_tiles(fast: bool):
    """Single pass: evaluate the DEM grid once per tile, emit terrarium + hypso PNGs.

    The analytic model is sampled on a 256px lattice and bilinearly upsampled
    to 512px for encoding — within the stated ~30 m nominal resolution.
    """
    lut = _hypso_lut()
    dem_tiles: dict[tuple[int, int, int], bytes] = {}
    hypso_tiles: dict[tuple[int, int, int], bytes] = {}
    zmax = DEM_ZOOMS[1] if not fast else 11
    for z in range(DEM_ZOOMS[0], zmax + 1):
        xs, ys = bbox_tile_range(z, GEN_BBOX)
        n = 0
        for x in xs:
            for y in ys:
                lons, lats = tile_grid(z, x, y, DEM_EVAL_SIZE)
                elev = elevation(lons, lats)
                if DEM_EVAL_SIZE != DEM_TILE_SIZE:
                    img_f = Image.fromarray(elev.astype(np.float32), mode="F")
                    img_f = img_f.resize((DEM_TILE_SIZE, DEM_TILE_SIZE), Image.BILINEAR)
                    elev = np.asarray(img_f, dtype=np.float64)
                dem_tiles[(z, x, y)] = encode_terrarium(elev)
                # hypso tint
                ei = np.clip(elev, 0, 4230).astype(np.int32)
                buf = io.BytesIO()
                Image.fromarray(lut[ei], "RGB").save(buf, "PNG", optimize=True)
                hypso_tiles[(z, x, y)] = buf.getvalue()
                n += 1
        print(f"  [dem+hypso] z{z}: {n} tiles", flush=True)
    return dem_tiles, hypso_tiles


def build_contour_tiles(fast: bool):
    import gzip

    tiles: dict[tuple[int, int, int], bytes] = {}
    zmax = CONTOUR_ZOOMS[1] if not fast else 11
    for zlo, zhi, interval in CONTOUR_INTERVALS:
        for z in range(zlo, min(zhi, zmax) + 1):
            xs, ys = bbox_tile_range(z, GEN_BBOX)
            n = 0
            for x in xs:
                for y in ys:
                    mvt_bytes = build_contour_tile(z, x, y, interval)
                    tiles[(z, x, y)] = gzip.compress(mvt_bytes, 6)
                    n += 1
            print(f"  [contours] z{z} interval={interval:g}m: {n} tiles", flush=True)
    return tiles


# ---------------------------------------------------------------------------
# Raster tile builders — real (Copernicus GLO-30)
# ---------------------------------------------------------------------------

def build_dem_tiles_real(demr: RealDEM, fast: bool):
    """Real DEM tiles: pyramid box-filtering at low zoom (never point-sample
    the 30 m mosaic), bilinear on the native mosaic at z11/z12.

    The terrarium encode math is identical to v1.0.0 (v = elev + 32768).
    Sampling is edge-clamped outside the mosaic so overview tiles (which
    extend past the source footprint) never contain nodata leaks.
    """
    lut = _hypso_lut(HYPSO_STOPS_REAL)
    dem_tiles: dict[tuple[int, int, int], bytes] = {}
    hypso_tiles: dict[tuple[int, int, int], bytes] = {}
    zmax = DEM_ZOOMS[1] if not fast else 11
    for z in range(DEM_ZOOMS[0], zmax + 1):
        xs, ys = bbox_tile_range(z, COVERAGE_BBOX)
        step_deg = 360.0 / (2**z * DEM_TILE_SIZE)
        lvl = demr.level_for_deg(step_deg)
        n = 0
        for x in xs:
            for y in ys:
                lons, lats = tile_grid(z, x, y, DEM_TILE_SIZE)
                elev = demr.sample(lons, lats, level=lvl, clamp=True)
                dem_tiles[(z, x, y)] = encode_terrarium(elev)
                ei = np.clip(elev, 0, 4230).astype(np.int32)
                buf = io.BytesIO()
                Image.fromarray(lut[ei], "RGB").save(buf, "PNG", optimize=True)
                hypso_tiles[(z, x, y)] = buf.getvalue()
                n += 1
        print(f"  [dem+hypso:real] z{z}: {n} tiles (pyramid level {lvl})", flush=True)
    return dem_tiles, hypso_tiles


def build_contour_tiles_real(demr: RealDEM, fast: bool):
    import gzip

    tiles: dict[tuple[int, int, int], bytes] = {}
    zmax = CONTOUR_ZOOMS[1] if not fast else 11
    for zlo, zhi, interval in CONTOUR_INTERVALS:
        for z in range(zlo, min(zhi, zmax) + 1):
            # one pyramid level per zoom keeps the shared margin lattice
            # consistent across neighbouring tiles (seam matching)
            step_deg = 360.0 / (2**z * STEPS_PER_TILE)
            lvl = demr.level_for_deg(step_deg)

            def sampler(lons, lats, _lvl=lvl):
                return demr.sample(lons, lats, level=_lvl, clamp=True)

            xs, ys = bbox_tile_range(z, COVERAGE_BBOX)
            n = 0
            for x in xs:
                for y in ys:
                    mvt_bytes = build_contour_tile(z, x, y, interval, sampler=sampler)
                    tiles[(z, x, y)] = gzip.compress(mvt_bytes, 6)
                    n += 1
            print(f"  [contours:real] z{z} interval={interval:g}m (pyramid level {lvl}): {n} tiles", flush=True)
    return tiles


def _hypso_lut(stops=None) -> np.ndarray:
    stops = [(e, hex_to_rgb(c)) for e, c in (stops or HYPSO_STOPS)]
    lut = np.zeros((4231, 3), dtype=np.uint8)
    for e in range(0, stops[0][0]):
        lut[e] = stops[0][1]
    for i in range(len(stops) - 1):
        e0, c0 = stops[i]
        e1, c1 = stops[i + 1]
        for e in range(max(0, e0), min(4230, e1)):
            t = (e - e0) / max(1, (e1 - e0))
            lut[e] = [int(c0[k] + (c1[k] - c0[k]) * t) for k in range(3)]
    for e in range(stops[-1][0], 4231):
        lut[e] = stops[-1][1]
    return lut


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def build_hypso_tiles(fast: bool):  # noqa: ARG001 - kept for API compat; tiles built with DEM
    raise RuntimeError("hypso tiles are built together with DEM tiles (build_dem_tiles)")


# ---------------------------------------------------------------------------
# GeoJSON builders
# ---------------------------------------------------------------------------

def _densify(way, step_deg=0.0035):
    out = []
    for i in range(len(way) - 1):
        (x0, y0), (x1, y1) = way[i], way[i + 1]
        d = math.hypot((x1 - x0) * 0.857, y1 - y0)
        n = max(1, int(d / step_deg))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(way[-1])
    return out


def build_roads_peaks(sampler=None, dem=None):
    """Roads + peaks/passes/places features.

    sampler=None (default): v1.0.0 SIMULATED output, byte-identical.
    sampler=callable: real mode — roads keep simulated:true; peaks/passes
    keep the curated NOMINAL published elevation, gain `dem_ele` (real GLO-30
    sample), a `rank`, and simulated:false.
    dem=RealDEM (optional): run the ordered claim pass (REAL_CLAIMS) — each
    peak is claimed onto the max-elevation DEM pixel inside its radius,
    excluding discs around earlier claimed points; the feature gains
    `snap_offset_m` + `snap_ref` and its `dem_ele` is the claimed pixel.
    Pass Tizi n'Tamatert reconciles onto the pixel closest to its nominal.
    """
    from pipeline.dem import ROAD_IMLIL, ROAD_OURIKA, ROAD_TICHKA

    feats = []
    for way, name, cls in (
        (ROAD_TICHKA, "R202 Tichka Mountain Road", "mountain-road"),
        (ROAD_IMLIL, "Imlil Valley Road", "mountain-road"),
        (ROAD_OURIKA, "Ourika Valley Road", "mountain-road"),
    ):
        pts = _densify(way)
        props = {"name": name, "class": cls}
        if sampler is not None:
            props["simulated"] = True
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[p[0], p[1]] for p in pts]},
                "properties": props,
            }
        )

    if sampler is None:
        for name, lon, lat, target, _sigma, kind in ANCHORS:
            ele = round(elevation_scalar(lon, lat))
            if kind == "peak":
                feats.append(
                    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                     "properties": {"name": name, "ele": ele, "kind": "peak"}}
                )
            elif kind == "pass":
                feats.append(
                    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                     "properties": {"name": name, "ele": ele, "kind": "pass"}}
                )
            else:
                feats.append(
                    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                     "properties": {"name": name, "kind": "place", "ele": ele}}
                )
    else:
        anchor = {a[0]: (a[1], a[2], a[3]) for a in ANCHORS}  # places only
        claimed: dict = {}
        qa = []  # (name, kind, nominal, before, after, offset_m|None)
        print("\n  Claim pass (ordered, mutual exclusion):")
        for name, kind, rank, (alon, alat), nominal, radius, min_dem, exclusions, target_ele in REAL_CLAIMS:
            before = round(sampler(alon, alat))
            slon, slat, after, offset = alon, alat, before, None
            if dem is not None and radius is not None:
                ex = tuple((claimed[en][0], claimed[en][1], er) for en, er in exclusions)
                r = dem.claim_pixel(alon, alat, radius, exclusions=ex, target_ele=target_ele)
                if r["snapped"]:
                    err = abs(r["ele"] - target_ele) if target_ele is not None else None
                    move = True if target_ele is None else err <= 150.0
                    if move:
                        slon, slat = r["lon"], r["lat"]
                        after = round(r["ele"])
                        offset = round(r["offset_m"])
                        claimed[name] = (slon, slat)
                    if r.get("raw_best") is not None:
                        rb = r["raw_best"]
                        print(
                            f"    [{name}] raw best ({rb['lon']:.5f}, {rb['lat']:.5f}, {rb['ele']:.0f} m) "
                            f"inside a mutual-exclusion zone - masked",
                            flush=True,
                        )
                    if target_ele is None:
                        print(f"    [{name}] claimed ({slon:.5f}, {slat:.5f}) dem {after} m, moved {offset} m", flush=True)
                        if min_dem is not None and r["ele"] < min_dem:
                            print(
                                f"    [warn] {name}: claimed dem {after} m < acceptance floor {min_dem:.0f} m "
                                f"(GLO-30 summit smoothing) - claimed anyway, nominal kept",
                                flush=True,
                            )
                    elif move:
                        print(
                            f"    [{name}] reconciled to ({slon:.5f}, {slat:.5f}) dem {after} m "
                            f"(|{after}-{int(target_ele)}| = {abs(after - int(target_ele))} m <= 150 m, moved {offset} m)",
                            flush=True,
                        )
                    else:
                        print(
                            f"    [warn] {name}: closest pixel to {int(target_ele)} m within {radius / 1000:.1f} km "
                            f"is {r['ele']:.0f} m ({err:.0f} m off > 150 m) - keeping original coordinate",
                            flush=True,
                        )
                else:
                    print(f"    [warn] {name}: claim refused ({r['reason']}) - keeping original coordinate", flush=True)
            props = {
                "name": name, "ele": int(nominal), "dem_ele": after,
                "kind": kind, "rank": rank, "simulated": False,
            }
            if offset is not None:
                props["snap_offset_m"] = offset
                props["snap_ref"] = SNAP_REF
            feats.append(
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [slon, slat]},
                 "properties": props}
            )
            qa.append((name, kind, int(nominal), before, after, offset))
        place_rank = 8
        print("\n  QA: nominal vs real GLO-30 (ordered claim pass, mutual exclusion)")
        print("  %-20s %8s %9s %9s %8s %8s" % ("name", "nominal", "pre-snap", "post-snap", "offset", "diff"))
        for name, kind, nominal, before, after, offset in qa:
            print(
                "  %-20s %8d %9d %9d %8s %+8d"
                % (name, nominal, before, after, "-" if offset is None else f"{offset}m", after - nominal)
            )
        # Success criteria (report only - never force values).
        for name, kind, nominal, before, after, offset in qa:
            if kind == "peak" and name == "Jbel Toubkal" and abs(4167 - after) >= 60:
                print(f"  [warn] Toubkal: |4167 - {after}| = {abs(4167 - after)} m exceeds the expected <60 m window", flush=True)
        # places: curated valley/settlement anchors keep nominal elevation
        for name in ("Imlil", "Asni", "Setti Fatma"):
            lon, lat, nominal = anchor[name]
            feats.append(
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                 "properties": {
                     "name": name, "kind": "place", "ele": int(nominal),
                     "dem_ele": round(sampler(lon, lat)), "rank": place_rank,
                     "simulated": False,
                 }}
            )
            place_rank += 1
        # extra small settlements for map life (no published elevation, as v1.0.0)
        for name, lon, lat in [
            ("Tanourt", -7.9450, 31.1750),
            ("Arhbalou", -7.8650, 31.2050),
            ("Aguerssioual", -7.9050, 31.2050),
        ]:
            feats.append(
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                 "properties": {"name": name, "kind": "place", "rank": place_rank, "simulated": False}}
            )
            place_rank += 1
        # NOTE: the wide regional ANCHORS ("Atlas Massif", "Haouz Plain",
        # "Takerkoust Basin") are synthetic-model skeleton features and are
        # intentionally NOT published in real mode.
    return {"type": "FeatureCollection", "features": feats}


def _los_clear(lon0, lat0, h0, lon1, lat1, h1, n=48, elev=None):
    """Terrain-only line of sight between two antenna points (approximation)."""
    elev = elevation_scalar if elev is None else elev
    for i in range(1, n):
        t = i / n
        lon = lon0 + (lon1 - lon0) * t
        lat = lat0 + (lat1 - lat0) * t
        ground = elev(lon, lat)
        ray = h0 + (h1 - h0) * t
        if ground > ray:
            return False
    return True


def build_simulated_ran(sampler=None):
    """SIMULATED network layer (unchanged logic).  In real mode the GROUND
    elevations come from the real sampler; RSRP/LOS logic is unchanged."""
    import random

    rng = random.Random(SEED)
    elev = elevation_scalar if sampler is None else sampler
    from pipeline.dem import ROAD_TICHKA

    site_defs = [
        ("GTW-TICHKA-01", -7.4180, 31.2530, 35, ["900 MHz"], [(270, 65, 6000), (90, 65, 6000)]),
        ("GTW-TICHKA-02", -7.3600, 31.2870, 30, ["900 MHz"], [(285, 65, 5000)]),
        ("GTW-TICHKA-03", -7.4830, 31.2110, 40, ["1800 MHz"], [(95, 60, 5000), (255, 60, 5000)]),
        ("GTW-TICHKA-04", -7.5620, 31.1720, 30, ["1800 MHz"], [(85, 70, 6000)]),
        ("GTW-TICHKA-05", -7.6640, 31.1420, 35, ["900 MHz"], [(75, 65, 5000)]),
        ("GTW-TICHKA-06", -7.7820, 31.1230, 30, ["900 MHz"], [(70, 70, 5000)]),
        ("GTW-IMLIL-01", -7.9220, 31.1390, 25, ["1800 MHz"], [(160, 70, 4000)]),
        ("GTW-ASNI-01", -7.9790, 31.2510, 30, ["900 MHz"], [(180, 90, 6000)]),
        ("GTW-OURIKA-01", -7.7210, 31.2430, 30, ["1800 MHz"], [(190, 80, 4000)]),
    ]
    feats = []
    sites = []
    for sid, lon, lat, h, bands, sectors in site_defs:
        ground = round(elev(lon, lat))
        sites.append((sid, lon, lat, ground + h))
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": sid,
                    "ele": ground,
                    "height_m": h,
                    "bands": bands,
                    "sectors": [
                        {"azimuth": az, "width_deg": w, "radius_m": r} for az, w, r in sectors
                    ],
                },
            }
        )

    # RSRP along the Tichka road: distance + terrain-shadow based, clearly SIMULATED
    pts = _densify(ROAD_TICHKA, 0.0025)
    prev = None
    for lon, lat in pts:
        best = -140.0
        for sid, slon, slat, h in sites:
            d_km = math.hypot((lon - slon) * 85.7, (lat - slat) * 111.0)
            rsrp = -58.0 - 28.0 * math.log10(max(d_km, 0.25) / 0.25)
            if not _los_clear(slon, slat, h, lon, lat, elev(lon, lat) + 1.5, elev=elev):
                rsrp -= 18.0
            best = max(best, rsrp)
        val = round(max(-140.0, min(-58.0, best)), 1)
        if prev is not None:
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [list(prev), [lon, lat]]},
                    "properties": {"rsrp_dbm": val},
                }
            )
        prev = (lon, lat)
    return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------------------

def _write_glyphs() -> None:
    ttf = os.path.join(
        ROOT, "node_modules", "@expo-google-fonts", "noto-sans", "400Regular", "NotoSans_400Regular.ttf"
    )
    if not os.path.exists(ttf):
        # fallback: search the package for any regular TTF
        import glob

        cands = glob.glob(
            os.path.join(ROOT, "node_modules", "@expo-google-fonts", "noto-sans", "**", "*Regular*.ttf"),
            recursive=True,
        )
        if cands:
            ttf = cands[0]
        else:
            raise SystemExit("Noto Sans TTF not found - run `npm install` first")
    n = generate_glyph_pbf(
        ttf, os.path.join(GLYPH_DIR, "Noto Sans Regular", "0-255.pbf"), "Noto Sans Regular"
    )
    print(f"glyphs: {n} chars from {os.path.basename(ttf)}")

    # Peak-label prefix glyph (U+25B2 BLACK UP-POINTING TRIANGLE): MapLibre
    # requests glyph range 9472-9727 for it.  Only ship that range when the
    # source TTF's cmap actually maps the codepoint — otherwise MapLibre
    # would render .notdef tofu.  The current @expo-google-fonts Noto Sans
    # does NOT map U+25B2, so the range is skipped and the frontend must use
    # an ASCII-safe prefix (ASCII glyphs live in 0-255.pbf).  U+2022 (bullet)
    # IS mapped by this font, should a symbol fallback ever be wanted (it
    # would need the 8192-8447 range shipped the same way).
    from pipeline.glyphs import ttf_covers

    if 0x25B2 in ttf_covers(ttf, (0x25B2,)):
        n2 = generate_glyph_pbf(
            ttf,
            os.path.join(GLYPH_DIR, "Noto Sans Regular", "9472-9727.pbf"),
            "Noto Sans Regular",
            lo=9472,
            hi=9727,
        )
        print(f"glyphs: 9472-9727 range written ({n2} chars incl. U+25B2)")
    else:
        print(
            "[glyphs] U+25B2 (▲) NOT mapped by the source TTF - glyph range "
            "9472-9727 NOT generated; frontend must fall back to an ASCII-safe "
            "peak prefix (all ASCII glyphs are in 0-255.pbf)"
        )

    # keep font provenance next to the package
    os.makedirs(os.path.join(ROOT, ".data", "fonts"), exist_ok=True)
    try:
        import shutil

        shutil.copy(ttf, os.path.join(ROOT, ".data", "fonts", "NotoSans-Regular.ttf"))
        lic = os.path.join(os.path.dirname(ttf), "LICENSE")
        if os.path.exists(lic):
            shutil.copy(lic, os.path.join(ROOT, ".data", "fonts", "LICENSE-noto-sans.txt"))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] font copy: {e}")


def _write_geojsons(rp, ran) -> None:
    with open(os.path.join(DATA_DIR, "roads-peaks.geojson"), "w", encoding="utf-8") as f:
        json.dump(rp, f, ensure_ascii=False)
    print(f"roads-peaks.geojson: {len(rp['features'])} features")
    with open(os.path.join(DATA_DIR, "simulated-ran.geojson"), "w", encoding="utf-8") as f:
        json.dump(ran, f, ensure_ascii=False)
    print(f"simulated-ran.geojson: {len(ran['features'])} features")


def _write_archives(dem_tiles, hypso_tiles, contour_tiles, bbox, zmax_dem, zmax_contours) -> None:
    stats = pmtiles_writer.write_pmtiles(
        os.path.join(DATA_DIR, "dem-terrarium.pmtiles"),
        dem_tiles,
        tile_type=pmtiles_writer.TILE_TYPE_PNG,
        tile_compression=pmtiles_writer.COMPRESSION_NONE,
        min_zoom=DEM_ZOOMS[0],
        max_zoom=zmax_dem,
        bbox=bbox,
        center=(-7.65, 31.2, 11),
    )
    print(f"dem-terrarium.pmtiles: {stats}")
    stats = pmtiles_writer.write_pmtiles(
        os.path.join(DATA_DIR, "hypso.pmtiles"),
        hypso_tiles,
        tile_type=pmtiles_writer.TILE_TYPE_PNG,
        tile_compression=pmtiles_writer.COMPRESSION_NONE,
        min_zoom=DEM_ZOOMS[0],
        max_zoom=zmax_dem,
        bbox=bbox,
        center=(-7.65, 31.2, 11),
    )
    print(f"hypso.pmtiles: {stats}")
    stats = pmtiles_writer.write_pmtiles(
        os.path.join(DATA_DIR, "contours.pmtiles"),
        contour_tiles,
        tile_type=pmtiles_writer.TILE_TYPE_MVT,
        tile_compression=pmtiles_writer.COMPRESSION_GZIP,
        min_zoom=CONTOUR_ZOOMS[0],
        max_zoom=zmax_contours,
        bbox=bbox,
        center=(-7.65, 31.2, 11),
    )
    print(f"contours.pmtiles: {stats}")


def main():
    ap = argparse.ArgumentParser(description="Generate the offline data package")
    ap.add_argument("--fast", action="store_true", help="z<=11 DEM + contours (dev)")
    ap.add_argument("--terrain-source", choices=("synthetic", "real"), default="synthetic",
                    help="synthetic: analytic SIMULATED model (v1.0.0); real: Copernicus GLO-30")
    ap.add_argument("--dem-dir", default=DEFAULT_DEM_DIR,
                    help="directory with the GLO-30 GeoTIFFs (real mode, default %(default)s)")
    args = ap.parse_args()
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(GLYPH_DIR, exist_ok=True)

    t0 = time.time()
    if args.terrain_source == "real":
        _run_real(args, args.fast)
    else:
        _run_synthetic(args.fast)
    print(f"\nbuild wall time: {time.time() - t0:.0f} s")


# ---------------------------------------------------------------- synthetic --

def _run_synthetic(fast: bool) -> None:
    print("== DEM + hypsometric tiles (terrarium + tint, single evaluation pass) ==", flush=True)
    dem_tiles, hypso_tiles = build_dem_tiles(fast)
    zmax_dem = DEM_ZOOMS[1] if not fast else 11
    print("== Contour vector tiles ==", flush=True)
    contour_tiles = build_contour_tiles(fast)
    _write_archives(dem_tiles, hypso_tiles, contour_tiles, GEN_BBOX, zmax_dem,
                    CONTOUR_ZOOMS[1] if not fast else 11)

    print("== GeoJSON ==", flush=True)
    _write_geojsons(build_roads_peaks(), build_simulated_ran())

    print("== Glyphs ==", flush=True)
    _write_glyphs()

    print("== metadata.json ==", flush=True)
    meta = {
        "simulated": True,
        "seed": SEED,
        "bbox": TARGET_BBOX,
        "coverage": GEN_BBOX,
        "dem": {
            "file": "dem-terrarium.pmtiles",
            "encoding": "terrarium",
            "zooms": [DEM_ZOOMS[0], DEM_ZOOMS[1] if not fast else 11],
            "tile_size": DEM_TILE_SIZE,
            "vertical_datum": "synthetic - no datum (SIMULATED)",
            "nominal_resolution_m": "~30 (simulated analytic model)",
            "source": "SIMULATED TERRAIN - programmatically generated, not survey data",
        },
        "contours": {
            "file": "contours.pmtiles",
            "layer": "contour",
            "intervals_by_zoom": {"6-8": 500, "9-11": 100, "12+": 50},
            "source": "generated from the same analytic elevation model as the DEM",
        },
        "hypso": {
            "file": "hypso.pmtiles",
            "legend": [{"elev_m": e, "color": c} for e, c in HYPSO_STOPS],
        },
        "glyphs": {"fontstack": "Noto Sans Regular", "license": "SIL Open Font License 1.1"},
        "scenes": SCENES,
        "ran": {
            "file": "simulated-ran.geojson",
            "note": "SIMULATED NETWORK DATA - no real operator data involved",
        },
    }
    with open(os.path.join(DATA_DIR, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("metadata.json written")

    total = sum(os.path.getsize(os.path.join(DATA_DIR, f)) for f in os.listdir(DATA_DIR))
    print(f"\nDONE. public/data total: {total / 1e6:.1f} MB")


# --------------------------------------------------------------------- real --

def _run_real(args, fast: bool) -> None:
    dem_dir = args.dem_dir if os.path.isabs(args.dem_dir) else os.path.join(ROOT, args.dem_dir)
    print(f"== Real DEM: {dem_dir} ==", flush=True)
    demr = RealDEM(dem_dir)
    stats = demr.elevation_stats()
    print(
        f"[dem_real] coverage {tuple(demr.coverage_bbox())} "
        f"elevation min {stats['min_m']:.1f} / mean {stats['mean_m']:.1f} / max {stats['max_m']:.1f} m; "
        f"void pixels filled: {demr.void_pixels_filled}",
        flush=True,
    )

    print("== DEM + hypsometric tiles (real, pyramid-filtered) ==", flush=True)
    dem_tiles, hypso_tiles = build_dem_tiles_real(demr, fast)
    zmax_dem = DEM_ZOOMS[1] if not fast else 11
    print("== Contour vector tiles (real) ==", flush=True)
    contour_tiles = build_contour_tiles_real(demr, fast)
    _write_archives(dem_tiles, hypso_tiles, contour_tiles, COVERAGE_BBOX, zmax_dem,
                    CONTOUR_ZOOMS[1] if not fast else 11)

    print("== GeoJSON ==", flush=True)
    sampler = lambda lon, lat: demr.sample_scalar(lon, lat)  # noqa: E731
    _write_geojsons(build_roads_peaks(sampler=sampler, dem=demr), build_simulated_ran(sampler=sampler))

    print("== Glyphs ==", flush=True)
    _write_glyphs()

    print("== metadata.json (real terrain) ==", flush=True)
    meta = {
        "simulated": False,
        "seed": SEED,
        "bbox": TARGET_BBOX,
        "coverage": [float(v) for v in COVERAGE_BBOX],
        "terrain": {"mode": "real", **demr.provenance()},
        "network_data": {"mode": "simulated"},
        "geo_features": {"mode": "simulated roads / curated nominal peaks"},
        "dem": {
            "file": "dem-terrarium.pmtiles",
            "encoding": "terrarium",
            "zooms": [DEM_ZOOMS[0], zmax_dem],
            "tile_size": DEM_TILE_SIZE,
            "vertical_datum": "EGM2008",
            "nominal_resolution_m": "30 m",
            "source": "Copernicus DEM GLO-30 (real)",
        },
        "contours": {
            "file": "contours.pmtiles",
            "layer": "contour",
            "intervals_by_zoom": {"6-8": 500, "9-11": 100, "12+": 50},
            "source": "generated from the same real DEM as the DEM tiles",
        },
        "hypso": {
            "file": "hypso.pmtiles",
            "legend": [{"elev_m": e, "color": c} for e, c in HYPSO_STOPS_REAL],
        },
        "glyphs": {"fontstack": "Noto Sans Regular", "license": "SIL Open Font License 1.1"},
        "scenes": SCENES,
        "ran": {
            "file": "simulated-ran.geojson",
            "note": "SIMULATED NETWORK DATA - no real operator data involved",
        },
    }
    with open(os.path.join(DATA_DIR, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("metadata.json written")

    total = sum(os.path.getsize(os.path.join(DATA_DIR, f)) for f in os.listdir(DATA_DIR))
    print(f"\nDONE. public/data total: {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
