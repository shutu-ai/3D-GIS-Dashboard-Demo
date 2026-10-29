import sys, time, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import numpy as np

t0 = time.time()
from pipeline.dem import elevation
print(f"import+anchor solve: {time.time()-t0:.2f}s")

# correct z10 tile inside bbox: x=490, y=418 (computed from GEN_BBOX)
gx, gy = np.meshgrid(np.arange(512) + 0.5, np.arange(512) + 0.5)
t0 = time.time()
n = 2**12
lons = -7.6 + gx * 1e-4
lats = 31.2 + gy * 1e-4
e = elevation(lons, lats)
print(f"elevation 512x512: {time.time()-t0:.2f}s  min={e.min():.0f} max={e.max():.0f}")

from pipeline.contours import build_contour_tile
t0 = time.time()
b = build_contour_tile(10, 490, 418, 100.0)
print(f"contour tile z10 in-bbox: {time.time()-t0:.2f}s  bytes={len(b)}")
t0 = time.time()
b = build_contour_tile(12, 1963, 1673, 50.0)
print(f"contour tile z12 in-bbox: {time.time()-t0:.2f}s  bytes={len(b)}")
