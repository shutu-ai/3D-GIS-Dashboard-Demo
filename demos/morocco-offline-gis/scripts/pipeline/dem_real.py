"""Real DEM support: Copernicus DEM GLO-30 mosaic, pyramid and sampler.

Loads the six local 1x1-degree Copernicus GLO-30 GeoTIFFs (EPSG:4326,
3600x3600 float32 metres, pixel centres on the global 1/3600-deg lattice,
vertical datum EGM2008 per product specification), mosaics them into ONE
in-memory float32 array covering COVERAGE_BBOX plus an outer margin, and
exposes a vectorised bilinear sampler used by the tile builders.

Anti-aliasing policy: the 30 m native mosaic is progressively 2x2-halved into
an averaging pyramid.  For a requested sampling step `step_deg` (one output
pixel / contour lattice cell) the pyramid level whose native pixel is not
coarser than the output step is selected, so low-zoom tiles are BOX-AVERAGED
(never point-sampled) and z11/z12 stay on the native bilinear path.

NoData policy: NaN or elevations outside [-1000, 9000] m are void.  Voids
inside COVERAGE_BBOX are tolerated only if they cover <= 0.5% of the coverage
and no single 4-connected region exceeds 64 px; small voids are filled by
nearest-neighbour interpolation (GDAL fillnodata) and the filled count is
reported so it can be surfaced in metadata.
"""

from __future__ import annotations

import glob
import hashlib
import math
import os

import numpy as np
import rasterio
from rasterio.fill import fillnodata

# Far-field coverage of the four preset cameras (tilted views must not hit a
# data cliff): superset of the synthetic GEN_BBOX.
COVERAGE_BBOX = (-8.75, 30.80, -6.45, 31.65)
MARGIN_DEG = 0.05  # outer margin around COVERAGE_BBOX for bilinear edge handling

VOID_MIN = -1000.0
VOID_MAX = 9000.0
VOID_MAX_FRACTION = 0.005  # > 0.5% of coverage -> error
VOID_MAX_REGION_PX = 64  # single connected void region larger than this -> error
FILL_SEARCH_PX = 300  # nearest-neighbour fill search radius (native pixels)

PRODUCT = "Copernicus DEM GLO-30"
CRS_EXPECTED = "EPSG:4326"
VERTICAL_DATUM = "EGM2008 (per Copernicus DEM product specification)"

# Hypsometric palette for the REAL terrain.  Bottom end extended for the ~300 m
# coverage plains (low-saturation light green/tan below the old 400 m stop);
# top end softened toward light rock-gray so the 4167 m summit does not blow
# out to pure white over a large area.  The legend in metadata.json must stay
# byte-identical to this list.
HYPSO_STOPS_REAL = [
    (250, "#b9bd97"),  # low plains (tan-green, low saturation)
    (320, "#9aab7d"),  # light green lowlands
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
    (3850, "#b0b2ba"),  # softened: light rock-gray instead of near-white
    (4050, "#cdced6"),
    (4160, "#dde0e6"),  # summit cap, no pure white
]


def sha256_file(path: str, chunk: int = 8 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def combined_sha256(hashes: list[str]) -> str:
    """Provenance digest: sha256 of the per-file hex digests concatenated in
    sorted-filename order (no separators).  Documented in MANIFEST.md and
    recomputed by validate_data.py."""
    h = hashlib.sha256()
    for x in sorted(hashes):
        h.update(x.encode("ascii"))
    return h.hexdigest()


def _largest_void_regions(mask: np.ndarray, cap: int) -> list[int]:
    """Sizes of 4-connected void regions (BFS); a region's count stops growing
    past `cap` so pathological datasets fail fast instead of crawling."""
    from collections import deque

    h, w = mask.shape
    visited = np.zeros((h, w), dtype=bool)
    sizes: list[int] = []
    for r0, c0 in np.argwhere(mask):
        if visited[r0, c0]:
            continue
        size = 0
        q = deque([(int(r0), int(c0))])
        visited[r0, c0] = True
        while q and size <= cap:
            r, c = q.popleft()
            size += 1
            if r + 1 < h and mask[r + 1, c] and not visited[r + 1, c]:
                visited[r + 1, c] = True
                q.append((r + 1, c))
            if r > 0 and mask[r - 1, c] and not visited[r - 1, c]:
                visited[r - 1, c] = True
                q.append((r - 1, c))
            if c + 1 < w and mask[r, c + 1] and not visited[r, c + 1]:
                visited[r, c + 1] = True
                q.append((r, c + 1))
            if c > 0 and mask[r, c - 1] and not visited[r, c - 1]:
                visited[r, c - 1] = True
                q.append((r, c - 1))
        sizes.append(size)
    return sizes


class RealDEM:
    """Mosaic of the local GLO-30 tiles + averaging pyramid + bilinear sampler."""

    def __init__(self, dem_dir: str, coverage_bbox=COVERAGE_BBOX, margin_deg: float = MARGIN_DEG):
        paths = sorted(glob.glob(os.path.join(dem_dir, "*.tif")))
        if not paths:
            raise FileNotFoundError(f"no GeoTIFF sources found in {dem_dir}")

        # --- provenance + grid convention per file --------------------------
        infos = []
        res = None
        origin_lon = None
        origin_lat_top = None
        for p in paths:
            with rasterio.open(p) as ds:
                if ds.crs is None or ds.crs.to_epsg() != 4326:
                    raise ValueError(f"{os.path.basename(p)}: expected EPSG:4326, got {ds.crs}")
                if ds.count != 1 or ds.dtypes[0] != "float32":
                    raise ValueError(f"{os.path.basename(p)}: expected single float32 band")
                r = ds.res
                if res is None:
                    res = (float(r[0]), float(r[1]))
                elif not np.isclose(r[0], res[0]) or not np.isclose(r[1], res[1]):
                    raise ValueError(f"{os.path.basename(p)}: resolution mismatch {r} vs {res}")
                l, b, rt, t = ds.bounds
                infos.append({
                    "path": p,
                    "name": os.path.basename(p),
                    "sha256": sha256_file(p),
                    "bounds": [float(l), float(b), float(rt), float(t)],
                    "resolution_deg": [res[0], res[1]],
                    "dtype": ds.dtypes[0],
                    "shape": [int(ds.height), int(ds.width)],
                })
                # pixel centres sit on the global 1/3600 lattice
                origin_lon = l + res[0] / 2.0 if origin_lon is None else min(origin_lon, l + res[0] / 2.0)
                origin_lat_top = t - res[1] / 2.0 if origin_lat_top is None else max(origin_lat_top, t - res[1] / 2.0)

        self.res = res[0]  # square pixels
        if abs(res[0] - res[1]) > 1e-12:
            raise ValueError(f"non-square pixels not supported: {res}")

        # --- mosaic over COVERAGE_BBOX + margin, snapped to the lattice ------
        min_lon, min_lat, max_lon, max_lat = coverage_bbox
        e_lon0, e_lat0, e_lon1, e_lat1 = (
            min_lon - margin_deg, min_lat - margin_deg, max_lon + margin_deg, max_lat + margin_deg,
        )
        i0 = round((e_lon0 - origin_lon) / self.res)
        i1 = round((e_lon1 - origin_lon) / self.res)
        j0 = round((origin_lat_top - e_lat1) / self.res)
        j1 = round((origin_lat_top - e_lat0) / self.res)
        self.lon0 = origin_lon + i0 * self.res
        self.lat1 = origin_lat_top - j0 * self.res
        mw, mh = i1 - i0, j1 - j0
        if mw <= 0 or mh <= 0:
            raise ValueError("coverage bbox does not intersect the source tiles")

        mosaic = np.full((mh, mw), np.nan, dtype=np.float32)
        for info in infos:
            l, b, rt, t = info["bounds"]
            tc0 = round((l + self.res / 2.0 - origin_lon) / self.res)
            tr0 = round((origin_lat_top - (t - self.res / 2.0)) / self.res)
            with rasterio.open(info["path"]) as ds:
                data = ds.read(1)  # ~52 MB transient per tile
            # overlap of this tile with the mosaic window (union-grid coords)
            c_lo, c_hi = max(i0, tc0), min(i1, tc0 + ds.width)
            r_lo, r_hi = max(j0, tr0), min(j1, tr0 + ds.height)
            if c_hi <= c_lo or r_hi <= r_lo:
                raise ValueError(f"{info['name']} does not overlap the mosaic window")
            mosaic[r_lo - j0 : r_hi - j0, c_lo - i0 : c_hi - i0] = data[
                r_lo - tr0 : r_hi - tr0, c_lo - tc0 : c_hi - tc0
            ]
            del data
        self.infos = infos

        # --- NoData policy ----------------------------------------------------
        cov_c0 = round((min_lon - self.lon0) / self.res)
        cov_c1 = round((max_lon - self.lon0) / self.res)
        cov_r0 = round((self.lat1 - max_lat) / self.res)
        cov_r1 = round((self.lat1 - min_lat) / self.res)
        cov = mosaic[cov_r0:cov_r1, cov_c0:cov_c1]

        bad_inside = ~np.isfinite(cov) | (cov < VOID_MIN) | (cov > VOID_MAX)
        void_fraction = float(bad_inside.mean())
        void_inside = int(bad_inside.sum())
        if void_fraction > VOID_MAX_FRACTION:
            raise ValueError(
                f"void fraction inside coverage {void_fraction * 100:.3f}% exceeds "
                f"{VOID_MAX_FRACTION * 100:.1f}% ({void_inside} px of {bad_inside.size})"
            )
        region_sizes = _largest_void_regions(bad_inside, VOID_MAX_REGION_PX + 1)
        big = [s for s in region_sizes if s > VOID_MAX_REGION_PX]
        if big:
            raise ValueError(
                f"void regions exceed {VOID_MAX_REGION_PX} px inside coverage: "
                f"{sorted(big, reverse=True)[:10]} (total void px {void_inside})"
            )

        valid = np.isfinite(mosaic) & (mosaic > VOID_MIN) & (mosaic < VOID_MAX)
        mask = np.where(valid, np.uint8(255), np.uint8(0))
        mosaic = fillnodata(mosaic, mask=mask, max_search_distance=FILL_SEARCH_PX)
        if not np.isfinite(mosaic).all():
            n = int((~np.isfinite(mosaic)).sum())
            raise ValueError(f"{n} mosaic pixels remain unfilled after nearest-neighbour fill")
        print(
            f"[dem_real] voids inside coverage: {void_inside} px ({void_fraction * 100:.4f}%), "
            f"max region {max(region_sizes) if region_sizes else 0} px -> filled {void_inside} px "
            f"(nearest-neighbour, search {FILL_SEARCH_PX} px)",
            flush=True,
        )
        self.void_pixels_filled = void_inside
        self.void_max_region_px = int(max(region_sizes)) if region_sizes else 0

        # --- averaging pyramid (repeated 2x2 halving) -------------------------
        self.levels = [mosaic]
        while min(self.levels[-1].shape) >= 16:
            self.levels.append(self._halve(self.levels[-1]))

        cov_valid = mosaic[cov_r0:cov_r1, cov_c0:cov_c1]
        self._stats = {
            "min_m": float(cov_valid.min()),
            "max_m": float(cov_valid.max()),
            "mean_m": float(cov_valid.mean()),
        }
        self._coverage_bbox = tuple(coverage_bbox)
        print(
            f"[dem_real] mosaic {mh}x{mw} px ({self.res * 3600:.0f}/deg), "
            f"{len(self.levels)} pyramid levels, elevation min {self._stats['min_m']:.1f} / "
            f"max {self._stats['max_m']:.1f} m inside coverage",
            flush=True,
        )

    @staticmethod
    def _halve(a: np.ndarray) -> np.ndarray:
        h, w = a.shape
        h2, w2 = h - (h % 2), w - (w % 2)
        a = a[:h2, :w2]
        return (a[0::2, 0::2] + a[0::2, 1::2] + a[1::2, 0::2] + a[1::2, 1::2]) * np.float32(0.25)

    # ------------------------------------------------------------------ API --
    def level_for_deg(self, step_deg: float) -> int:
        """Pyramid level whose pixel is not coarser than `step_deg` (so low
        zooms are box-averaged, never point-sampled)."""
        ratio = step_deg / self.res
        if ratio <= 1.0:
            return 0
        return min(int(math.floor(math.log2(ratio))), len(self.levels) - 1)

    def sample(self, lons, lats, level: int = 0, clamp: bool = False) -> np.ndarray:
        """Vectorised bilinear sample.  Points outside the mosaic are NaN,
        unless `clamp=True` (edge-replicated, used for tile building so no
        nodata ever leaks into an artifact)."""
        lon = np.asarray(lons, dtype=np.float64)
        lat = np.asarray(lats, dtype=np.float64)
        lon, lat = np.broadcast_arrays(lon, lat)
        arr = self.levels[level]
        res = self.res * (1 << level)
        h, w = arr.shape

        x = (lon - self.lon0) / res - 0.5
        y = (self.lat1 - lat) / res - 0.5
        eps = 1e-9
        outside = (
            ~np.isfinite(x) | ~np.isfinite(y)
            | (x < -0.5 - eps) | (x > w - 0.5 + eps)
            | (y < -0.5 - eps) | (y > h - 0.5 + eps)
        )
        xc = np.clip(x, 0.0, w - 1 - 1e-6)
        yc = np.clip(y, 0.0, h - 1 - 1e-6)
        x0 = np.floor(xc).astype(np.int64)
        y0 = np.floor(yc).astype(np.int64)
        tx = (xc - x0).astype(np.float32)
        ty = (yc - y0).astype(np.float32)
        idx = y0 * w + x0
        flat = arr.reshape(-1)
        v00 = flat[idx]
        v01 = flat[idx + 1]
        v10 = flat[idx + w]
        v11 = flat[idx + w + 1]
        out = (
            v00 * (1.0 - tx) * (1.0 - ty)
            + v01 * tx * (1.0 - ty)
            + v10 * (1.0 - tx) * ty
            + v11 * tx * ty
        ).astype(np.float64)
        if not clamp:
            out[outside] = np.nan
        return out

    def sample_scalar(self, lon: float, lat: float, level: int = 0) -> float:
        v = self.sample(np.array([lon]), np.array([lat]), level=level)
        return float(v[0])

    def coverage_bbox(self) -> tuple[float, float, float, float]:
        return self._coverage_bbox

    def claim_pixel(
        self,
        lon: float,
        lat: float,
        radius_m: float,
        exclusions: tuple = (),
        target_ele: float | None = None,
    ) -> dict:
        """Ordered-claim search around (lon, lat): pick the best valid DEM
        pixel within `radius_m`, excluding discs (lon_i, lat_i, r_i) around
        points already claimed by earlier features in the pass (mutual
        exclusion, so two peaks can never claim the same summit).

        target_ele=None  -> maximise elevation (peak summits).
        target_ele=float -> minimise |elevation - target_ele| (pass
        reconciliation onto terrain that actually matches the published
        saddle elevation).

        Void-guarded like snap_to_peak.  Returns
          {"snapped", "reason", "lon", "lat", "ele", "offset_m",
           "excluded", "raw_best"}
        where offset_m is the anchor->claimed distance and raw_best is the
        un-excluded winner when the exclusion zones changed the outcome
        (for decision logging), else None.
        """
        coslat = math.cos(math.radians(lat))
        lat_r = radius_m / 111320.0
        lon_r = radius_m / (111320.0 * coslat)
        res_m_lat = self.res * 111320.0
        n = max(2, int(math.ceil(radius_m / res_m_lat)))
        lons = np.linspace(lon - lon_r, lon + lon_r, 2 * n + 1)
        lats = np.linspace(lat - lat_r, lat + lat_r, 2 * n + 1)
        gx, gy = np.meshgrid(lons, lats)
        z = self.sample(gx, gy, level=0)
        dist = np.hypot(gy - lat, (gx - lon) * coslat) * 111320.0
        valid = np.isfinite(z) & (z > VOID_MIN) & (z < VOID_MAX) & (dist <= radius_m)

        def _best(mask):
            if not mask.any():
                return None
            if target_ele is None:
                score = np.where(mask, z, -np.inf)
                idx = int(np.argmax(score))
            else:
                score = np.where(mask, np.abs(z - target_ele), np.inf)
                idx = int(np.argmin(score))
            r, c = np.unravel_index(idx, score.shape)
            return {
                "lon": float(gx[r, c]),
                "lat": float(gy[r, c]),
                "ele": float(z[r, c]),
                "offset_m": float(dist[r, c]),
            }

        raw = _best(valid)
        for ex_lon, ex_lat, ex_r in exclusions:
            ex_dist = np.hypot(gy - ex_lat, (gx - ex_lon) * coslat) * 111320.0
            valid &= ex_dist > ex_r
        best = _best(valid)
        if best is None:
            why = f"no valid DEM pixels within {radius_m:.0f} m"
            if raw is not None:
                why += " after mutual-exclusion zones"
            return {"snapped": False, "reason": why, "lon": lon, "lat": lat,
                    "ele": float("nan"), "offset_m": 0.0,
                    "excluded": raw is not None, "raw_best": raw}
        changed = raw is not None and (raw["lon"], raw["lat"]) != (best["lon"], best["lat"])
        best.update(snapped=True, reason="", excluded=changed, raw_best=raw if changed else None)
        return best

    def snap_to_peak(self, lon: float, lat: float, radius_m: float = 1500.0) -> dict:
        """Snap a published peak coordinate to the highest valid DEM pixel
        within `radius_m` (thin wrapper over claim_pixel, no exclusions)."""
        r = self.claim_pixel(lon, lat, radius_m)
        r.pop("raw_best", None)
        r.pop("excluded", None)
        return r

    def elevation_stats(self) -> dict:
        return dict(self._stats)

    def provenance(self) -> dict:
        return {
            "product": PRODUCT,
            "source_files": [
                {k: info[k] for k in ("name", "sha256", "bounds", "resolution_deg", "dtype", "shape")}
                for info in self.infos
            ],
            "source_sha256": combined_sha256([i["sha256"] for i in self.infos]),
            "crs": CRS_EXPECTED,
            "vertical_datum": VERTICAL_DATUM,
            "native_resolution_m": 30,
            "coverage": [float(v) for v in self._coverage_bbox],
            "void_pixels_filled": self.void_pixels_filled,
        }


if __name__ == "__main__":
    import sys

    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "data_sources", "copernicus-glo30",
    )
    dem = RealDEM(d)
    print("provenance:", dem.provenance()["source_sha256"])
    for lon, lat, label in (
        (-7.9146, 31.0595, "Jbel Toubkal"),
        (-7.9770, 31.0230, "Jbel Ouanoukrim"),
        (-7.4167, 31.2500, "Tizi n'Tichka"),
    ):
        print(f"  {label:18s} sample={dem.sample_scalar(lon, lat):8.1f} m")
