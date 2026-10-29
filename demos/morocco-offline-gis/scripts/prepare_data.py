"""Prepare all offline data for the Morocco High Atlas GIS demo.

Everything is programmatically generated (SIMULATED terrain per project
decision) from one analytic elevation model (pipeline/dem.py), so DEM tiles,
hypsometric tiles, contours, GeoJSON elevations and RAN site elevations are
mutually consistent by construction.

Outputs (see the data contract in Docs/Architecture.md):
  public/data/dem-terrarium.pmtiles   raster DEM, terrarium encoding, z7-12, 512px
  public/data/hypso.pmtiles           raster hypsometric tint, z7-12, 512px
  public/data/contours.pmtiles        vector MVT "contour" {ele, major}, z6-13
  public/data/roads-peaks.geojson     roads / peaks / passes / places
  public/data/simulated-ran.geojson   sites / rsrp road segments (SIMULATED)
  public/data/metadata.json           coverage, zooms, legend, scenes, provenance
  public/assets/glyphs/Noto Sans Regular/0-255.pbf

Usage:  python scripts/prepare_data.py [--fast]   (--fast: z<=12 only, quick dev)
"""

from __future__ import annotations

import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipeline import mvt, pmtiles_writer
from pipeline.contours import build_contour_tile, tile_fraction_to_lonlat
from pipeline.dem import ANCHORS, GEN_BBOX, SEED, TARGET_BBOX, elevation, elevation_scalar
from pipeline.glyphs import generate_glyph_pbf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "public", "data")
GLYPH_DIR = os.path.join(ROOT, "public", "assets", "glyphs")

DEM_TILE_SIZE = 512
DEM_EVAL_SIZE = 256  # evaluate the analytic model at 256px, bilinear upsample to 512
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
    {"name": "Toubkal Peak", "lng": -7.9146, "lat": 31.0595, "zoom": 10.8, "pitch": 68, "bearing": 150},
    {"name": "High Atlas Ridges", "lng": -7.75, "lat": 31.12, "zoom": 10.8, "pitch": 60, "bearing": 30},
    {"name": "Tizi n'Tichka Pass", "lng": -7.4167, "lat": 31.25, "zoom": 10.8, "pitch": 65, "bearing": -30},
    {"name": "Mountain Road", "lng": -7.55, "lat": 31.17, "zoom": 10.8, "pitch": 62, "bearing": 75},
]


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


# ---------------------------------------------------------------------------
# Raster tile builders
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
                # terrarium encode
                v = elev + 32768.0
                r = np.clip(np.floor(v / 256.0), 0, 255).astype(np.uint8)
                g = np.clip(np.floor(v) % 256, 0, 255).astype(np.uint8)
                b = np.clip(np.round((v - np.floor(v)) * 255.0), 0, 255).astype(np.uint8)
                buf = io.BytesIO()
                Image.fromarray(np.dstack([r, g, b]), "RGB").save(buf, "PNG", optimize=True)
                dem_tiles[(z, x, y)] = buf.getvalue()
                # hypso tint
                ei = np.clip(elev, 0, 4230).astype(np.int32)
                buf = io.BytesIO()
                Image.fromarray(lut[ei], "RGB").save(buf, "PNG", optimize=True)
                hypso_tiles[(z, x, y)] = buf.getvalue()
                n += 1
        print(f"  [dem+hypso] z{z}: {n} tiles", flush=True)
    return dem_tiles, hypso_tiles


def _hypso_lut() -> np.ndarray:
    stops = [(e, hex_to_rgb(c)) for e, c in HYPSO_STOPS]
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


def build_roads_peaks():
    from pipeline.dem import ROAD_IMLIL, ROAD_OURIKA, ROAD_TICHKA

    feats = []
    for way, name, cls in (
        (ROAD_TICHKA, "R202 Tichka Mountain Road", "mountain-road"),
        (ROAD_IMLIL, "Imlil Valley Road", "mountain-road"),
        (ROAD_OURIKA, "Ourika Valley Road", "mountain-road"),
    ):
        pts = _densify(way)
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[p[0], p[1]] for p in pts]},
                "properties": {"name": name, "class": cls},
            }
        )
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
    # extra small settlements for map life
    for name, lon, lat in [
        ("Tanourt", -7.9450, 31.1750),
        ("Arhbalou", -7.8650, 31.2050),
        ("Aguerssioual", -7.9050, 31.2050),
    ]:
        feats.append(
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
             "properties": {"name": name, "kind": "place"}}
        )
    return {"type": "FeatureCollection", "features": feats}


def _los_clear(lon0, lat0, h0, lon1, lat1, h1, n=48):
    """Terrain-only line of sight between two antenna points (approximation)."""
    for i in range(1, n):
        t = i / n
        lon = lon0 + (lon1 - lon0) * t
        lat = lat0 + (lat1 - lat0) * t
        ground = elevation_scalar(lon, lat)
        ray = h0 + (h1 - h0) * t
        if ground > ray:
            return False
    return True


def build_simulated_ran():
    import random

    rng = random.Random(SEED)
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
        ground = round(elevation_scalar(lon, lat))
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
            if not _los_clear(slon, slat, h, lon, lat, elevation_scalar(lon, lat) + 1.5):
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


def main():
    fast = "--fast" in sys.argv
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(GLYPH_DIR, exist_ok=True)

    print("== DEM + hypsometric tiles (terrarium + tint, single evaluation pass) ==", flush=True)
    dem_tiles, hypso_tiles = build_dem_tiles(fast)
    zmax_dem = DEM_ZOOMS[1] if not fast else 11
    stats = pmtiles_writer.write_pmtiles(
        os.path.join(DATA_DIR, "dem-terrarium.pmtiles"),
        dem_tiles,
        tile_type=pmtiles_writer.TILE_TYPE_PNG,
        tile_compression=pmtiles_writer.COMPRESSION_NONE,
        min_zoom=DEM_ZOOMS[0],
        max_zoom=zmax_dem,
        bbox=GEN_BBOX,
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
        bbox=GEN_BBOX,
        center=(-7.65, 31.2, 11),
    )
    print(f"hypso.pmtiles: {stats}")

    print("== Contour vector tiles ==", flush=True)
    contour_tiles = build_contour_tiles(fast)
    stats = pmtiles_writer.write_pmtiles(
        os.path.join(DATA_DIR, "contours.pmtiles"),
        contour_tiles,
        tile_type=pmtiles_writer.TILE_TYPE_MVT,
        tile_compression=pmtiles_writer.COMPRESSION_GZIP,
        min_zoom=CONTOUR_ZOOMS[0],
        max_zoom=CONTOUR_ZOOMS[1] if not fast else 11,
        bbox=GEN_BBOX,
        center=(-7.65, 31.2, 11),
    )
    print(f"contours.pmtiles: {stats}")

    print("== GeoJSON ==", flush=True)
    rp = build_roads_peaks()
    with open(os.path.join(DATA_DIR, "roads-peaks.geojson"), "w", encoding="utf-8") as f:
        json.dump(rp, f, ensure_ascii=False)
    print(f"roads-peaks.geojson: {len(rp['features'])} features")
    ran = build_simulated_ran()
    with open(os.path.join(DATA_DIR, "simulated-ran.geojson"), "w", encoding="utf-8") as f:
        json.dump(ran, f, ensure_ascii=False)
    print(f"simulated-ran.geojson: {len(ran['features'])} features")

    print("== Glyphs ==", flush=True)
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


if __name__ == "__main__":
    main()
