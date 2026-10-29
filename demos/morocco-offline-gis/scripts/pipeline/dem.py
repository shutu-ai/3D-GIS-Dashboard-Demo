"""Synthetic analytic elevation model for the Morocco High Atlas demo.

IMPORTANT: this is a SIMULATED terrain surface (user decision: all data
programmatically generated). It is anchored to real-world coordinates and
approximate real elevations of named features (Toubkal 4167 m, Tizi n'Tichka
2260 m, ...) so the demo looks plausible, but it is NOT survey data and must
be labelled SIMULATED everywhere.

The model is a pure function of (lon, lat) — every artifact (DEM tiles,
hypsometric tiles, contours, GeoJSON elevations) samples the SAME function,
which is what guarantees acceptance consistency between layers.
"""

from __future__ import annotations

import numpy as np

# Target area (from task doc) + generation buffer
TARGET_BBOX = (-8.2, 30.9, -7.1, 31.5)
GEN_BBOX = (-8.4, 30.85, -6.95, 31.55)

SEED = 20261029

# ---------------------------------------------------------------------------
# Value / gradient noise (fully vectorised over numpy arrays)
# ---------------------------------------------------------------------------

_PERM = np.random.default_rng(SEED).permutation(512)
_P = np.concatenate([_PERM, _PERM])
# 8 precomputed gradient directions (replaces per-element cos/sin — huge speedup)
_GRAD = np.array(
    [[np.cos(k * np.pi / 4.0), np.sin(k * np.pi / 4.0)] for k in range(8)],
    dtype=np.float64,
)


def _fade(t: np.ndarray) -> np.ndarray:
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def _grad2(hash_: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    g = _GRAD[hash_ & 7]
    return g[..., 0] * x + g[..., 1] * y


def perlin2(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Classic 2D Perlin gradient noise, output in [-1, 1] (float32 fast path)."""
    x = x.astype(np.float32, copy=False)
    y = y.astype(np.float32, copy=False)
    xi = np.floor(x).astype(np.int64)
    yi = np.floor(y).astype(np.int64)
    xf = (x - xi).astype(np.float32)
    yf = (y - yi).astype(np.float32)
    u = _fade(xf)
    v = _fade(yf)
    n00 = _grad2(_P[(_P[xi & 511] + yi) & 511], xf, yf)
    n10 = _grad2(_P[(_P[(xi + 1) & 511] + yi) & 511], xf - 1, yf)
    n01 = _grad2(_P[(_P[xi & 511] + yi + 1) & 511], xf, yf - 1)
    n11 = _grad2(_P[(_P[(xi + 1) & 511] + yi + 1) & 511], xf - 1, yf - 1)
    return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v


def fbm(x: np.ndarray, y: np.ndarray, octaves: int, lacunarity: float, gain: float) -> np.ndarray:
    total = np.zeros_like(x)
    amp = 1.0
    norm = 0.0
    for _ in range(octaves):
        total += amp * perlin2(x, y)
        norm += amp
        amp *= gain
        x, y = x * lacunarity, y * lacunarity
    return total / norm


def ridged(x: np.ndarray, y: np.ndarray, octaves: int, lacunarity: float, gain: float) -> np.ndarray:
    """Ridged multifractal — sharp mountain crests. Output ~[0, 1]."""
    total = np.zeros_like(x)
    weight = np.ones_like(x) * 0.5
    amp = 1.0
    norm = 0.0
    for _ in range(octaves):
        n = 1.0 - np.abs(perlin2(x, y))
        n = n * n * weight
        weight = np.clip(n * 2.0, 0.0, 1.0)
        total += amp * n
        norm += amp
        amp *= gain
        x, y = x * lacunarity, y * lacunarity
    return np.clip(total / norm, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Anchors: real feature names at real coordinates with approximate elevations
# ---------------------------------------------------------------------------

# name, lon, lat, target elevation (m), sigma (deg), kind
# Two tiers by design: a few WIDE regional anchors define the massif/plains
# skeleton, many NARROW local anchors pin named summits/passes/valleys.
# Conflicting wide anchors near each other are what produced dipoles (+4200/-4000)
# that blew the terrain up between them - keep wide anchors far apart.
ANCHORS = [
    # --- regional (wide sigma, define the skeleton)
    ("Atlas Massif", -7.8000, 31.1200, 3600.0, 0.110, "peak"),
    ("Haouz Plain", -7.3000, 31.4800, 470.0, 0.150, "valley"),
    ("Takerkoust Basin", -8.0600, 31.3700, 600.0, 0.050, "valley"),
    # --- local peaks
    ("Jbel Toubkal", -7.9146, 31.0595, 4167.0, 0.024, "peak"),
    ("Jbel Ouanoukrim", -7.9770, 31.0230, 4089.0, 0.020, "peak"),
    ("Aksoual", -7.9170, 31.0880, 3910.0, 0.018, "peak"),
    ("Iguelzoum", -8.0200, 31.0900, 3600.0, 0.020, "peak"),
    ("Adrar n'Dern", -7.5500, 31.1850, 3000.0, 0.028, "peak"),
    # --- passes (saddles)
    ("Tizi n'Tichka", -7.4167, 31.2500, 2260.0, 0.020, "pass"),
    ("Tizi n'Tamatert", -7.9350, 31.1600, 2250.0, 0.014, "pass"),
    # --- valleys / settlements
    ("Imlil", -7.9217, 31.1367, 1740.0, 0.012, "valley"),
    ("Asni", -7.9800, 31.2500, 1160.0, 0.018, "valley"),
    ("Setti Fatma", -7.7200, 31.2400, 1000.0, 0.018, "valley"),
]

# Road corridors that carve valleys (list of waypoints, lon/lat)
ROAD_TICHKA = [
    (-7.2000, 31.4200),  # Haouz plain (E)
    (-7.3000, 31.3400),
    (-7.3600, 31.2900),
    (-7.4167, 31.2500),  # the pass
    (-7.4800, 31.2100),
    (-7.5600, 31.1700),
    (-7.6600, 31.1400),
    (-7.7800, 31.1200),
    (-7.9000, 31.1000),
]
ROAD_IMLIL = [
    (-7.9800, 31.2500),  # Asni
    (-7.9650, 31.2300),
    (-7.9400, 31.1900),
    (-7.9350, 31.1600),  # Tizi n'Tamatert
    (-7.9217, 31.1367),  # Imlil
]
ROAD_OURIKA = [
    (-7.7200, 31.2400),  # Setti Fatma
    (-7.7400, 31.2100),
    (-7.7700, 31.1800),
    (-7.8000, 31.1500),
]


def _seg_dists(lons: np.ndarray, lats: np.ndarray, way) -> np.ndarray:
    """Approx distance (deg-ish, isotropic in lon scaled by cos(lat)) from
    points to a polyline; vectorised over the waypoints."""
    wx = np.array([p[0] for p in way], dtype=np.float64)
    wy = np.array([p[1] for p in way], dtype=np.float64)
    wx = wx * np.cos(np.radians(31.2))
    px = lons * np.cos(np.radians(31.2))
    py = lats
    best = np.full_like(px, 1e9)
    for i in range(len(wx) - 1):
        ax, ay = wx[i], wy[i]
        bx, by = wx[i + 1], wy[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0.0, 1.0)
        cx, cy = ax + t * dx, ay + t * dy
        d = np.hypot(px - cx, py - cy)
        best = np.minimum(best, d)
    return best


# ---------------------------------------------------------------------------
# The elevation function
# ---------------------------------------------------------------------------

_ANCHOR_SCALE = np.radians(31.2)  # cos(lat) lon compression

_ROAD_CARVES = (
    (ROAD_TICHKA, 260.0, 0.022),
    (ROAD_IMLIL, 140.0, 0.012),
    (ROAD_OURIKA, 150.0, 0.010),
)


def _base_field(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Ridge-structured base terrain in metres before anchor adjustment."""
    # noise space: compress lon, stretch along the NE-SW Atlas trend
    nx = (lon - GEN_BBOX[0]) * np.cos(_ANCHOR_SCALE) * 52.0
    ny = (lat - GEN_BBOX[1]) * 52.0
    # rotate to align ridges SW-NE
    ang = np.radians(38.0)
    rx = nx * np.cos(ang) - ny * np.sin(ang)
    ry = nx * np.sin(ang) + ny * np.cos(ang)
    ridge = ridged(rx * 0.55, ry * 0.55, octaves=5, lacunarity=2.15, gain=0.45)
    detail = fbm(nx * 2.6, ny * 2.6, octaves=3, lacunarity=2.3, gain=0.5)
    mx = (lon - (-7.05)) / (-8.4 - (-7.05))
    my = (lat - (31.5)) / (30.9 - 31.5)
    mask = np.clip(mx * 0.75 + my * 0.45 + 0.30, 0.0, 1.0)
    mask = mask * mask * (3 - 2 * mask)  # smoothstep
    mountains = 450.0 + mask * (150.0 + ridge * 3200.0 + detail * 180.0)
    return mountains


def _carve(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Road corridor valley carving (negative metres)."""
    out = np.zeros_like(lon)
    for way, depth, width in _ROAD_CARVES:
        d = _seg_dists(lon, lat, way)
        out = out - depth * np.exp(-(d * d) / (2.0 * width * width))
    return out


def _tilt(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Gentle regional tilt: lower towards the north-east corner."""
    return -140.0 * np.clip((lon + 7.05) / 1.35, 0.0, 1.0) * np.clip((31.55 - lat) / 0.65, 0.0, 1.0)


def _weight(alon: np.ndarray | float, alat: np.ndarray | float, sigma: float, lon, lat) -> np.ndarray:
    d2 = ((lon - alon) * _ANCHOR_SCALE) ** 2 + (lat - alat) ** 2
    return np.exp(-d2 / (2.0 * sigma * sigma))


def _solve_anchor_corrections() -> np.ndarray:
    """Solve d such that raw(a_i) + sum_j w_j(a_i) * d_j == target_i.

    A small linear system over the anchor set — this is what makes named
    features land on their target elevations exactly instead of drifting
    when neighbouring Gaussians overlap.
    """
    n = len(ANCHORS)
    raw = np.empty(n)
    W = np.empty((n, n))
    targets = np.empty(n)
    for i, (_ni, alon_i, alat_i, target_i, _si, _ki) in enumerate(ANCHORS):
        li = np.array(alon_i)
        la = np.array(alat_i)
        raw[i] = float(_base_field(li, la) + _carve(li, la) + _tilt(li, la))
        targets[i] = target_i
        for j, (_nj, alon_j, alat_j, _tj, sigma_j, _kj) in enumerate(ANCHORS):
            W[i, j] = float(_weight(alon_j, alat_j, sigma_j, li, la))
    # Damped Gauss-Seidel on W d = targets - raw: each anchor corrects itself
    # against the current field contributed by all others. W has unit diagonal
    # (self weight 1) with mostly weak cross terms, so this converges without
    # the wild far-field blowups of an exact ill-conditioned solve.
    d = np.zeros(n)
    for _it in range(400):
        max_delta = 0.0
        for i in range(n):
            resid_i = (targets[i] - raw[i]) - float(W[i] @ d)
            step = 0.75 * resid_i
            d[i] += step
            max_delta = max(max_delta, abs(step))
        if max_delta < 0.05:
            break
    resid = W @ d - (targets - raw)
    print(f"[dem] anchor corrections solved ({_it+1} it), max residual {np.abs(resid).max():.1f} m, |d|max {np.abs(d).max():.0f} m")
    if np.abs(d).max() > 2500.0:
        print("[dem] WARNING: large anchor corrections - check for conflicting anchors")
    return d


_ANCHOR_D = _solve_anchor_corrections()


def elevation(lon, lat):
    """Elevation in metres for scalar or array lon/lat (SIMULATED terrain)."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    elev = _base_field(lon, lat) + _carve(lon, lat) + _tilt(lon, lat)
    for d_i, (_name, alon, alat, _target, sigma, _kind) in zip(_ANCHOR_D, ANCHORS):
        w = _weight(alon, alat, sigma, lon, lat)
        elev = elev + w * d_i
    return np.clip(elev, 380.0, 4230.0)


def elevation_scalar(lon: float, lat: float) -> float:
    return float(elevation(np.array(lon), np.array(lat)))


if __name__ == "__main__":
    for name, alon, alat, target, _s, _k in ANCHORS:
        got = elevation_scalar(alon, alat)
        print(f"{name:20s} target={target:7.1f} m  model={got:7.1f} m  diff={got - target:+6.1f}")
