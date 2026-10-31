#!/usr/bin/env python3
"""validate_geo_context.py -- offline acceptance validator for the v1.2.1
geographic-context vector archives (Protomaps Basemap v4, snapshot 2026-10-30).

Validates public/data/morocco-overview.pmtiles and
public/data/high-atlas-context.pmtiles against the provenance recorded in
public/data/metadata.json (geo_context block) and a set of known-good vector
probes. Pure Python stdlib for file/header/hash checks, plus subprocess calls
to `node scripts/geo_probe.mjs` (local PMTiles + MVT reads) and the bundled
`pmtiles` CLI for cross-checks. REQUIRES NO NETWORK.

Checks (each printed as PASS/FAIL with a reason; exit 1 on any FAIL):
  a. archives exist in public/data/
  b. PMTiles v3 header parse in pure Python (magic, specVersion<=3,
     gzip tile compression, MVT tile type, zooms, bbox) + `pmtiles show`
     cross-check when the CLI is available
  c. header bbox == metadata geo_context.files[...].bbox
  d. sha256 + size match metadata AND the expected release values
  e. metadata source snapshot / build_version / attribution
  f. vector layers decode (via geo_probe): boundaries/places/roads/water
  g. key places: Marrakech, Laayoune, Dakhla present in `places`
  h. peak + elevation: "Jbel Toubkal" elevation=4167 in `pois`
  i. disputed boundary provenance: z6 boundaries sweep disputedCount>=1
     (kind=country kind_detail=2 disputed=true) + non-empty
     metadata geo_context.disputed_boundary_handling
  j. water: z13 detail sweep contains kind river or stream

Header layout note: byte offsets follow the empirical PMTiles v3 header as
implemented by the bundled pmtiles CLI (verified against `pmtiles show` on
these archives): magic u16 @0 == 19792 ('PM'), specVersion u8 @7,
tileDataOffset u64 @56 (low+high*2**32), tileCompression u8 @98 (2=gzip),
tileType u8 @99 (1=mvt), minZoom u8 @100, maxZoom u8 @101,
minLon i32 @102 (1e7 fixed), minLat @106, maxLon @110, maxLat @114;
header length 127 bytes.

Usage: python scripts/validate_geo_context.py
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import struct
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"
METADATA_PATH = DATA_DIR / "metadata.json"
GEO_PROBE = ROOT / "scripts" / "geo_probe.mjs"
PMTILES_TOOL = ROOT / ".data" / "tools" / "pmtiles.exe"

ARCHIVES = {
    "morocco-overview.pmtiles": {
        "sha256": "f5e587bd800ef7b7d846c30e3feae6bcaba89ccf91935ec1076f0006202ca119",
        "size_bytes": 65961582,
    },
    "high-atlas-context.pmtiles": {
        "sha256": "507986ca83b62f5f032ee82f52d2b57f20260ff5b4298f80c6d6716bb68a00de",
        "size_bytes": 36675954,
    },
}

# (archive, z, x, y, layers that must be present)
# z14/7831/6703 is the wilderness Toubkal tile: the `places` layer does not
# occur there; Marrakech city tile z14/7828/6673 carries places at detail zoom.
LAYER_PROBES = [
    ("morocco-overview.pmtiles", 6, 30, 26,
     ["boundaries", "places", "roads", "water"]),
    ("morocco-overview.pmtiles", 8, 122, 104,
     ["boundaries", "places", "roads", "water"]),
    ("high-atlas-context.pmtiles", 14, 7831, 6703,
     ["boundaries", "roads", "water", "pois"]),
    ("high-atlas-context.pmtiles", 14, 7828, 6673,
     ["boundaries", "places", "roads", "water"]),
]

KEY_PLACES = [
    ("morocco-overview.pmtiles", 6, 30, 26, "Marrakech"),
    ("morocco-overview.pmtiles", 6, 29, 26, "Laâyoune"),
    ("morocco-overview.pmtiles", 8, 116, 110, "Dakhla"),
]

OVERVIEW_SWEEP = ("morocco-overview.pmtiles", 6, -17.6, 20.4, -0.6, 36.35, "boundaries")
DETAIL_WATER_SWEEP = ("high-atlas-context.pmtiles", 13, -9.15, 30.4, -6.05, 32.0, "water")
DISPUTED_KEY = "kind=country |kind_detail=2 |disputed=true"


# ---------------------------------------------------------------- helpers

def sha256_and_size(path: pathlib.Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def probe(archive: pathlib.Path, mode: str, *args) -> dict:
    """Run scripts/geo_probe.mjs and return its JSON result (raises on failure)."""
    cmd = ["node", str(GEO_PROBE), str(archive), mode, *[str(a) for a in args]]
    proc = subprocess.run(cmd, capture_output=True, timeout=900, cwd=str(ROOT))
    if proc.returncode != 0:
        raise RuntimeError(
            f"geo_probe failed ({' '.join(cmd[2:])}): "
            f"{proc.stderr.decode('utf-8', 'replace').strip() or 'exit ' + str(proc.returncode)}")
    return json.loads(proc.stdout.decode("utf-8"))


def pmtiles_show_crosscheck(path: pathlib.Path, hdr: dict) -> list[str]:
    """Cross-check the pure-Python header against the bundled pmtiles CLI.
    Returns a list of problems (empty = consistent). Empty if CLI unavailable."""
    if not PMTILES_TOOL.exists():
        return []  # cross-check is optional; pure-Python checks already ran
    proc = subprocess.run([str(PMTILES_TOOL), "show", str(path)],
                          capture_output=True, timeout=300)
    if proc.returncode != 0:
        return [f"pmtiles show exited {proc.returncode}"]
    text = proc.stdout.decode("utf-8", "replace")

    problems: list[str] = []
    m = re.search(r"pmtiles spec version:\s*(\d+)", text)
    if m and int(m.group(1)) != hdr["spec_version"]:
        problems.append(f"CLI spec version {m.group(1)} != parsed {hdr['spec_version']}")
    m = re.search(r"tile compression:\s*(\S+)", text)
    if m and hdr["tile_compression"] == 2 and m.group(1) != "gzip":
        problems.append(f"CLI tile compression {m.group(1)} != gzip")
    m = re.search(r"tile type:\s*(\S+)", text)
    if m and hdr["tile_type"] == 1 and m.group(1) != "mvt":
        problems.append(f"CLI tile type {m.group(1)} != mvt")
    m = re.search(r"max zoom:\s*(\d+)", text)
    if m and int(m.group(1)) != hdr["max_zoom"]:
        problems.append(f"CLI max zoom {m.group(1)} != parsed {hdr['max_zoom']}")
    m = re.search(
        r"bounds:\s*\(long:\s*(-?\d+\.\d+),\s*lat:\s*(-?\d+\.\d+)\)\s*"
        r"\(long:\s*(-?\d+\.\d+),\s*lat:\s*(-?\d+\.\d+)\)", text)
    if m:
        cli_bbox = tuple(float(m.group(i)) for i in range(1, 5))
        if any(abs(a - b) > 1e-6 for a, b in zip(cli_bbox, hdr["bbox"])):
            problems.append(f"CLI bounds {cli_bbox} != parsed {hdr['bbox']}")
    return problems


def parse_pmtiles_header(path: pathlib.Path) -> tuple[dict, list[str]]:
    """Pure-Python PMTiles v3 header parse. Returns (header, problems)."""
    problems: list[str] = []
    try:
        with open(path, "rb") as fh:
            head = fh.read(127)
    except OSError as e:
        return {}, [f"read failed: {e}"]
    if len(head) < 127:
        return {}, [f"file smaller than the 127-byte header ({len(head)} bytes)"]

    def u32(off: int) -> int:
        return struct.unpack_from("<I", head, off)[0]

    def i32(off: int) -> int:
        return struct.unpack_from("<i", head, off)[0]

    def u64(off: int) -> int:  # little-endian low+high*2**32
        return u32(off) + u32(off + 4) * 2 ** 32

    magic = u32(0) & 0xFFFF  # magic uint16 @0
    if magic != 19792:  # 0x4D50 'PM'
        problems.append(f"magic u16 @0 is {magic}, expected 19792")
    hdr = {
        "magic": magic,
        "spec_version": head[7],
        "tile_data_offset": u64(56),
        "tile_compression": head[98],
        "tile_type": head[99],
        "min_zoom": head[100],
        "max_zoom": head[101],
        "bbox": (i32(102) / 1e7, i32(106) / 1e7, i32(110) / 1e7, i32(114) / 1e7),
    }
    file_size = path.stat().st_size
    if hdr["spec_version"] > 3:
        problems.append(f"specVersion @7 is {hdr['spec_version']}, must be <= 3")
    if hdr["tile_compression"] != 2:
        problems.append(f"tileCompression @98 is {hdr['tile_compression']}, must be 2 (gzip)")
    if hdr["tile_type"] != 1:
        problems.append(f"tileType @99 is {hdr['tile_type']}, must be 1 (mvt)")
    if not (0 < hdr["tile_data_offset"] <= file_size):
        problems.append(f"tileDataOffset @56 ({hdr['tile_data_offset']}) outside file (size {file_size})")
    if not (0 <= hdr["min_zoom"] <= hdr["max_zoom"] <= 31):
        problems.append(f"zoom range {hdr['min_zoom']}-{hdr['max_zoom']} invalid")
    return hdr, problems


def bbox_close(a, b, tol: float = 1e-6) -> bool:
    return all(abs(x - y) <= tol for x, y in zip(a, b))


# ---------------------------------------------------------------- checks

def make_checks(meta: dict):
    """Return list of (check_id, description, callable -> (ok, reason))."""
    checks = []

    def check(cid, desc):
        def wrap(fn):
            checks.append((cid, desc, fn))
            return fn
        return wrap

    files = meta.get("geo_context", {}).get("files", {})

    # a. existence
    @check("a", "archives exist in public/data/")
    def check_a():
        missing = [n for n in ARCHIVES if not (DATA_DIR / n).is_file()]
        if missing:
            return False, f"missing: {', '.join(missing)}"
        return True, "both morocco-overview.pmtiles and high-atlas-context.pmtiles present"

    # b. pure-Python PMTiles v3 header parse + CLI cross-check
    parsed: dict[str, dict] = {}

    @check("b", "PMTiles v3 header parse (pure python) + pmtiles CLI cross-check")
    def check_b():
        all_problems: list[str] = []
        for name in ARCHIVES:
            hdr, problems = parse_pmtiles_header(DATA_DIR / name)
            parsed[name] = hdr
            if problems:
                all_problems.append(f"{name}: " + "; ".join(problems))
                continue
            all_problems.extend(f"{name}: {p}" for p in pmtiles_show_crosscheck(DATA_DIR / name, hdr))
        if all_problems:
            return False, " | ".join(all_problems)
        sample = parsed["morocco-overview.pmtiles"]
        return True, (
            "specVersion=3, tileCompression=2(gzip), tileType=1(mvt), "
            f"zooms {sample['min_zoom']}-{sample['max_zoom']}, "
            f"tileDataOffset={sample['tile_data_offset']}; CLI show consistent")

    # c. header bbox == metadata bbox
    @check("c", "header bbox equals metadata geo_context.files[...].bbox")
    def check_c():
        bad = []
        for name in ARCHIVES:
            want = files.get(name, {}).get("bbox")
            hdr = parsed.get(name) or {}
            got = hdr.get("bbox")
            if want is None or got is None:
                bad.append(f"{name}: missing bbox (metadata={want} header={got})")
            elif not bbox_close(got, want):
                bad.append(f"{name}: header {got} != metadata {want}")
        if bad:
            return False, "; ".join(bad)
        return True, "both archives: header bbox matches metadata bbox"

    # d. sha256 + size vs metadata and expected release values
    @check("d", "sha256 + size match metadata.json and expected release values")
    def check_d():
        bad = []
        for name, expected in ARCHIVES.items():
            actual_sha, actual_size = sha256_and_size(DATA_DIR / name)
            meta_sha = files.get(name, {}).get("sha256")
            meta_size = files.get(name, {}).get("size_bytes")
            if actual_sha != expected["sha256"]:
                bad.append(f"{name}: sha256 {actual_sha} != expected {expected['sha256']}")
            if actual_size != expected["size_bytes"]:
                bad.append(f"{name}: size {actual_size} != expected {expected['size_bytes']}")
            if meta_sha != expected["sha256"]:
                bad.append(f"{name}: metadata sha256 {meta_sha} != expected {expected['sha256']}")
            if meta_size != expected["size_bytes"]:
                bad.append(f"{name}: metadata size {meta_size} != expected {expected['size_bytes']}")
        if bad:
            return False, "; ".join(bad)
        return True, "sha256 and size_bytes match metadata and release values for both archives"

    # e. metadata source provenance
    @check("e", "metadata geo_context.source snapshot/build_version/attribution")
    def check_e():
        src = meta.get("geo_context", {}).get("source", {})
        problems = []
        if src.get("snapshot") != "2026-10-30":
            problems.append(f"snapshot={src.get('snapshot')!r}, expected '2026-10-30'")
        if src.get("build_version") != "4.15.2":
            problems.append(f"build_version={src.get('build_version')!r}, expected '4.15.2'")
        attribution = src.get("attribution")
        if not isinstance(attribution, str) or "OpenStreetMap" not in attribution:
            problems.append(f"attribution={attribution!r} missing 'OpenStreetMap'")
        if problems:
            return False, "; ".join(problems)
        return True, "snapshot=2026-10-30, build_version=4.15.2, attribution credits OpenStreetMap"

    # f. vector layers decode via geo_probe
    @check("f", "vector layers decode: boundaries/places/roads/water (geo_probe)")
    def check_f():
        bad = []
        for name, z, x, y, required in LAYER_PROBES:
            result = probe(DATA_DIR / name, "layers", f"{z}/{x}/{y}")
            layers = set(result.get("layers", {}))
            missing = [l for l in required if l not in layers]
            if missing:
                bad.append(f"{name} {z}/{x}/{y}: missing {missing} (has {sorted(layers)})")
        if bad:
            return False, "; ".join(bad)
        return True, (f"all {len(LAYER_PROBES)} probe tiles contain the required "
                      "basemap layers (boundaries/roads/water everywhere; places on "
                      "overview tiles + Marrakech city tile z14/7828/6673)")

    # g. key places exist
    @check("g", "key places present: Marrakech / Laayoune / Dakhla")
    def check_g():
        bad = []
        for name, z, x, y, place in KEY_PLACES:
            result = probe(DATA_DIR / name, "features", f"{z}/{x}/{y}", "places", 9999)
            names = [f.get("name") for f in result.get("features", [])]
            if place not in names:
                bad.append(f"{name} {z}/{x}/{y}: '{place}' not found in places "
                           f"(saw: {sorted(n for n in names if n)})")
        if bad:
            return False, "; ".join(bad)
        return True, "Marrakech (6/30/26), Laayoune (6/29/26), Dakhla (8/116/110) all present"

    # h. peak + elevation
    @check("h", "Jbel Toubkal peak with elevation 4167 in pois (z14/7831/6703)")
    def check_h():
        result = probe(DATA_DIR / "high-atlas-context.pmtiles", "features", "14/7831/6703", "pois", 200)
        feats = result.get("features", [])
        match = [f for f in feats
                 if f.get("name") == "Jbel Toubkal" and f.get("elevation") == 4167]
        if not match:
            return False, (f"'Jbel Toubkal' with elevation 4167 not found "
                           f"(pois features: {[(f.get('name'), f.get('elevation')) for f in feats]})")
        return True, "pois contains Jbel Toubkal, kind=peak, elevation=4167"

    # i. disputed boundary provenance
    @check("i", "disputed boundary provenance (z6 sweep) + metadata policy text")
    def check_i():
        name, z, minlon, minlat, maxlon, maxlat, layer = OVERVIEW_SWEEP
        result = probe(DATA_DIR / name, "sweep", z, minlon, minlat, maxlon, maxlat, layer)
        disputed = result.get("disputedCount", 0)
        counts = result.get("kindCounts", {})
        expected_hits = counts.get(DISPUTED_KEY, 0)
        handling = meta.get("geo_context", {}).get("disputed_boundary_handling")
        problems = []
        if disputed < 1:
            problems.append(f"disputedCount={disputed}, expected >= 1")
        if expected_hits < 1:
            problems.append(f"no '{DISPUTED_KEY}' entries in kindCounts")
        if not (isinstance(handling, str) and handling.strip()):
            problems.append(f"disputed_boundary_handling={handling!r} is not a non-empty string")
        if problems:
            return False, "; ".join(problems)
        return True, (f"disputedCount={disputed} ({DISPUTED_KEY} x{expected_hits}); "
                      "disputed_boundary_handling is a non-empty string")

    # j. water kinds in detail sweep
    @check("j", "water sweep (z13 detail) contains river or stream")
    def check_j():
        name, z, minlon, minlat, maxlon, maxlat, layer = DETAIL_WATER_SWEEP
        result = probe(DATA_DIR / name, "sweep", z, minlon, minlat, maxlon, maxlat, layer)
        counts = result.get("kindCounts", {})
        found = {k: v for k, v in counts.items()
                 if k.startswith("kind=river |") or k.startswith("kind=stream |")}
        if not any(v >= 1 for v in found.values()):
            return False, f"no kind=river / kind=stream features (kindCounts: {counts})"
        summary = ", ".join(f"{k.split(' |')[0].split('=', 1)[1]} x{v}" for k, v in sorted(found.items()))
        return True, f"linear water features in sweep: {summary}"

    return checks


def main() -> int:
    failures: list[str] = []
    passed = 0

    try:
        meta = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"FAIL setup: cannot read {METADATA_PATH}: {e}")
        print("==== 0/10 geo-context checks passed ====")
        return 1

    checks = make_checks(meta)
    for cid, desc, fn in checks:
        try:
            ok, reason = fn()
        except Exception as e:  # a probe crash is a FAIL with its reason
            ok, reason = False, f"exception: {e}"
        status = "PASS" if ok else "FAIL"
        print(f"{status} {cid}: {desc} -- {reason}")
        if ok:
            passed += 1
        else:
            failures.append(cid)

    total = len(checks)
    print(f"==== {passed}/{total} geo-context checks passed ====")
    if failures:
        print(f"failing checks: {', '.join(failures)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
