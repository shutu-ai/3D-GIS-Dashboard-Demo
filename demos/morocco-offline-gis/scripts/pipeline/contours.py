"""Contour generation: vectorised marching squares on the analytic DEM.

Grid lattice is global (tile fraction +/- one margin cell), so neighbouring
tiles produce matching boundary vertices. Polylines are chained, clipped to
the tile rect, simplified (Douglas-Peucker) and encoded as MVT.
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from . import mvt
from .dem import elevation

STEPS_PER_TILE = 192  # lattice cells per tile edge (same lattice at every zoom)


def marching_squares(grid: np.ndarray, level: float) -> list[tuple[float, float, float, float]]:
    """Segments (x0, y0, x1, y1) in node-index space (col, row), vectorised.

    grid[i, j]: i = row (y node index), j = col (x node index).
    """
    a = grid[:-1, :-1]   # top-left
    b = grid[:-1, 1:]    # top-right
    c = grid[1:, 1:]     # bottom-right
    d = grid[1:, :-1]    # bottom-left
    idx = (
        ((a > level).astype(np.uint8) << 3)
        | ((b > level).astype(np.uint8) << 2)
        | ((c > level).astype(np.uint8) << 1)
        | (d > level).astype(np.uint8)
    )
    act = np.argwhere((idx != 0) & (idx != 15))
    if act.size == 0:
        return []

    ii = act[:, 0]  # row
    jj = act[:, 1]  # col
    cases = idx[ii, jj]

    av = a[ii, jj]
    bv = b[ii, jj]
    cv = c[ii, jj]
    dv = d[ii, jj]

    # edge crossing points (in node-index space); guard against div by zero
    with np.errstate(divide="ignore", invalid="ignore"):
        t_top = np.clip((level - av) / np.where(bv != av, bv - av, 1.0), 0, 1)
        t_right = np.clip((level - bv) / np.where(cv != bv, cv - bv, 1.0), 0, 1)
        t_bottom = np.clip((level - dv) / np.where(cv != dv, cv - dv, 1.0), 0, 1)
        t_left = np.clip((level - av) / np.where(dv != av, dv - av, 1.0), 0, 1)

    Pt = np.stack([jj + t_top, ii.astype(float)], axis=1)
    Pr = np.stack([jj + 1.0, ii + t_right], axis=1)
    Pb = np.stack([jj + t_bottom, ii + 1.0], axis=1)
    Pl = np.stack([jj.astype(float), ii + t_left], axis=1)

    m1 = cases == 1
    m2 = cases == 2
    m3 = cases == 3
    m4 = cases == 4
    m5 = cases == 5
    m6 = cases == 6
    m7 = cases == 7
    m8 = cases == 8
    m9 = cases == 9
    m10 = cases == 10
    m11 = cases == 11
    m12 = cases == 12
    m13 = cases == 13
    m14 = cases == 14

    center = (av + bv + cv + dv) / 4.0
    m5_hi = m5 & (center > level)
    m5_lo = m5 & ~(center > level)
    m10_hi = m10 & (center > level)
    m10_lo = m10 & ~(center > level)

    s_list: list[np.ndarray] = []
    e_list: list[np.ndarray] = []
    for mask, pa, pb in (
        (m1, Pl, Pb),
        (m2, Pb, Pr),
        (m3, Pl, Pr),
        (m4, Pt, Pr),
        (m5_hi, Pl, Pt),
        (m5_hi, Pb, Pr),
        (m5_lo, Pl, Pb),
        (m5_lo, Pt, Pr),
        (m6, Pt, Pb),
        (m7, Pl, Pt),
        (m8, Pt, Pl),
        (m9, Pt, Pb),
        (m10_hi, Pt, Pr),
        (m10_hi, Pl, Pb),
        (m10_lo, Pt, Pl),
        (m10_lo, Pb, Pr),
        (m11, Pt, Pr),
        (m12, Pl, Pr),
        (m13, Pb, Pr),
        (m14, Pl, Pb),
    ):
        sel = np.nonzero(mask)[0]
        if len(sel):
            s_list.append(pa[sel])
            e_list.append(pb[sel])

    if not s_list:
        return []
    S = np.concatenate(s_list)
    E = np.concatenate(e_list)
    return list(zip(S[:, 0].tolist(), S[:, 1].tolist(), E[:, 0].tolist(), E[:, 1].tolist()))


def _chain(segs: list[tuple[float, float, float, float]], eps: float = 1e-6):
    """Chain segments into polylines by endpoint matching."""
    if not segs:
        return []
    used = [False] * len(segs)

    def key(x: float, y: float):
        return (round(x / eps), round(y / eps))

    ends: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, (x0, y0, x1, y1) in enumerate(segs):
        ends[key(x0, y0)].append(i)
        ends[key(x1, y1)].append(i)
    lines: list[list[tuple[float, float]]] = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        x0, y0, x1, y1 = segs[i]
        line = [(x0, y0), (x1, y1)]
        while True:  # extend forward
            head = line[-1]
            cands = [j for j in ends[key(*head)] if not used[j]]
            if not cands:
                break
            j = cands[0]
            used[j] = True
            ax, ay, bx, by = segs[j]
            if key(ax, ay) == key(*head):
                line.append((bx, by))
            else:
                line.append((ax, ay))
        while True:  # extend backward
            tail = line[0]
            cands = [j for j in ends[key(*tail)] if not used[j]]
            if not cands:
                break
            j = cands[0]
            used[j] = True
            ax, ay, bx, by = segs[j]
            if key(ax, ay) == key(*tail):
                line.insert(0, (bx, by))
            else:
                line.insert(0, (ax, ay))
        lines.append(line)
    return lines


def _point_to_seg_dist(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _rdp(points, epsilon: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        s, e = stack.pop()
        dmax, idx = 0.0, -1
        for i in range(s + 1, e):
            d = _point_to_seg_dist(points[i], points[s], points[e])
            if d > dmax:
                dmax, idx = d, i
        if dmax > epsilon and idx > 0:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [p for p, k in zip(points, keep) if k]


def _clip_line(points, hi):
    """Keep parts of a polyline inside [0, hi]^2 (binary-search boundary)."""
    out: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []

    def inside(p):
        return 0 <= p[0] <= hi and 0 <= p[1] <= hi

    def interp(p, q):
        for _ in range(20):
            m = ((p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0)
            if inside(m):
                p = m
            else:
                q = m
        return p if inside(p) else q

    for k in range(len(points) - 1):
        p, q = points[k], points[k + 1]
        if inside(p):
            if not cur:
                cur.append(p)
            if inside(q):
                cur.append(q)
            else:
                cur.append(interp(p, q))
                out.append(cur)
                cur = []
        else:
            if inside(q):
                cur.append(interp(p, q))
                cur.append(q)
    if len(cur) >= 2:
        out.append(cur)
    return out


def tile_fraction_to_lonlat(z, fx, fy):
    n = 2**z
    lon = fx / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * fy / n))))
    return lon, lat


def build_contour_tile(z: int, x: int, y: int, interval: float) -> bytes:
    """MVT bytes (uncompressed) with one 'contour' layer for this tile.

    Lattice nodes: k = 0 .. steps+2 at fraction (tile + (k-1)/steps), so
    node k=1 is the tile's left/top edge — shared with the neighbour's
    k=steps+1, which makes boundary vertices identical across tiles.
    """
    steps = STEPS_PER_TILE
    xs = x + np.arange(-1, steps + 2) / steps  # (steps+3,)
    ys = y + np.arange(-1, steps + 2) / steps
    gx, gy = np.meshgrid(xs, ys)  # gx[r,c] = xs[c], gy[r,c] = ys[r]
    lons, lats = tile_fraction_to_lonlat(z, gx, gy)
    grid = elevation(lons, lats)

    lo = float(grid.min())
    hi = float(grid.max())
    start = math.floor(lo / interval) * interval
    levels = np.arange(start, hi + interval, interval)

    layer = mvt.Layer("contour", extent=4096)
    scale = 4096.0 / steps
    # zoom-appropriate simplification: coarser at low zoom keeps tile size sane
    rdp_eps = 1.0 + max(0, 12 - z) * 0.7
    for level in levels:
        segs = marching_squares(grid, float(level))
        if not segs:
            continue
        lines = _chain(segs)
        n_units = int(round(level / interval))
        major = n_units % 5 == 0
        for ln in lines:
            # node index (col j, row i) -> extent units, node k=1 == 0
            pts = [((j - 1.0) * scale, (i - 1.0) * scale) for (j, i) in ln]
            pts = _rdp(pts, rdp_eps)
            for part in _clip_line(pts, 4096.0):
                ipts = [(int(round(a)), int(round(b))) for a, b in part]
                layer.add_linestring(ipts, {"ele": int(round(level)), "major": bool(major)})
    return mvt.encode_tile([layer])
