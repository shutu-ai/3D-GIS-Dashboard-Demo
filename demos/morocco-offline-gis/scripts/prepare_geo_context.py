#!/usr/bin/env python3
"""prepare_geo_context.py -- build-time extraction pipeline for the v1.2.1
geographic-context vector archives (Protomaps Basemap v4).

BUILD-TIME TOOL -- NEVER INVOKED BY THE RUNTIME APP
---------------------------------------------------
This script is the reproducible pipeline that produces the two vector archives
in public/data/ and refreshes their provenance entries in
public/data/metadata.json (geo_context.files[...]). The runtime app only ever
reads the finished archives + metadata; it never calls this script.

Pinned source snapshot
----------------------
* Snapshot ....... 2026-10-30   (https://build.protomaps.com/20261030.pmtiles)
* Basemap build .. Protomaps Basemap v4.15.2 (planetiler; OpenStreetMap +
                   Natural Earth). The archive's own metadata reports
                   planetiler:version 0.10.2 / version 4.15.2.
* The full planet archive is ~139 GB. It is NEVER downloaded in full:
   `pmtiles extract` performs HTTP range requests and pulls only the byte
   ranges that intersect the preset bboxes (or reads a local
   --source-local archive for fully offline rebuilds).

License / attribution obligations (must accompany any redistribution)
---------------------------------------------------------------------
* OpenStreetMap data: (c) OpenStreetMap contributors, ODbL 1.0
  https://www.openstreetmap.org/copyright
* Protomaps Basemap v4 tiles (rendering of OSM data by Protomaps).
Both obligations are recorded in metadata.json -> geo_context.source.license
and geo_context.source.attribution.

Presets
-------
  overview -> public/data/morocco-overview.pmtiles
              bbox -17.6,20.4,-0.6,36.35 (Morocco incl. Western Sahara), maxzoom 12
  detail   -> public/data/high-atlas-context.pmtiles
              bbox -9.15,30.4,-6.05,32.0  (Marrakech / High Atlas),   maxzoom 14

Flow per preset
---------------
  [optional --dry-run] `pmtiles extract --dry-run` estimate, NO writes
  1. `pmtiles extract <source> <out> --bbox=... --maxzoom=...`
  2. `pmtiles verify <out>`            (must exit 0)
  3. sha256 + size of <out>
  4. update metadata.json geo_context.files[<name>] with
     sha256/size_bytes/bbox/minzoom/maxzoom (read-modify-write: every other
     key is preserved, key order kept, trailing newline).

`--skip-extract` skips steps 1-2 and only refreshes hashes/sizes/provenance
from the existing archives (validate + metadata refresh mode; pair it with
scripts/validate_geo_context.py).

Examples
--------
  python scripts/prepare_geo_context.py
  python scripts/prepare_geo_context.py --preset overview
  python scripts/prepare_geo_context.py --preset detail --preset overview --dry-run
  python scripts/prepare_geo_context.py --skip-extract --preset overview --preset detail
  python scripts/prepare_geo_context.py --source-local D:\\planet\\20261030.pmtiles
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = ROOT / "public" / "data"
DEFAULT_TOOL = ROOT / ".data" / "tools" / "pmtiles.exe"
METADATA_PATH = DEFAULT_OUT_DIR / "metadata.json"

# minzoom is the source planet archive's minimum zoom (0); extract keeps it.
PRESETS: dict[str, dict] = {
    "overview": {
        "out": "morocco-overview.pmtiles",
        "bbox": "-17.6,20.4,-0.6,36.35",
        "bbox_json": [-17.6, 20.4, -0.6, 36.35],
        "minzoom": 0,
        "maxzoom": 12,
    },
    "detail": {
        "out": "high-atlas-context.pmtiles",
        "bbox": "-9.15,30.4,-6.05,32.0",
        "bbox_json": [-9.15, 30.4, -6.05, 32.0],
        "minzoom": 0,
        "maxzoom": 14,
    },
}


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


def update_metadata(name: str, sha256: str, size_bytes: int, preset: dict) -> None:
    """Read-modify-write of metadata.json; preserves key order and all other content."""
    meta = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    geo = meta.get("geo_context")
    files = geo.get("files") if isinstance(geo, dict) else None
    if not isinstance(files, dict) or name not in files:
        raise SystemExit(
            f"metadata.json has no geo_context.files[{name!r}] entry; "
            "run scripts/add_geo_context_meta.py first (baseline provenance)."
        )
    entry = files[name]
    entry["sha256"] = sha256
    entry["size_bytes"] = size_bytes
    entry["bbox"] = list(preset["bbox_json"])
    entry["minzoom"] = preset["minzoom"]
    entry["maxzoom"] = preset["maxzoom"]
    METADATA_PATH.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  [4/4] metadata updated: geo_context.files[{name}] "
          f"(sha256={sha256[:12]}... size={size_bytes} bbox={preset['bbox']} "
          f"zooms {preset['minzoom']}-{preset['maxzoom']})")


def process_preset(name: str, args: argparse.Namespace) -> None:
    preset = PRESETS[name]
    out_path = pathlib.Path(args.out_dir) / preset["out"]
    source = str(args.source_local) if args.source_local else args.source_url
    print(f"== preset '{name}': {source} -> {out_path}")
    print(f"   bbox={preset['bbox']} minzoom={preset['minzoom']} maxzoom={preset['maxzoom']}")

    extract_cmd = [
        str(args.tool), "extract", source, str(out_path),
        f"--bbox={preset['bbox']}",
        f"--maxzoom={preset['maxzoom']}",
    ]

    if args.dry_run:
        print("  [dry-run] estimating extract (HTTP range reads only, NO writes):")
        print("        ", " ".join(extract_cmd + ["--dry-run"]))
        proc = subprocess.run(extract_cmd + ["--dry-run"])
        if proc.returncode != 0:
            raise SystemExit(f"dry-run extract failed for preset '{name}' (exit {proc.returncode})")
        print("  [dry-run] estimate done; no files written, metadata untouched.")
        return

    if args.skip_extract:
        print("  --skip-extract: skipping extract/verify; refreshing provenance from the existing archive.")
    else:
        print("  [1/4] extracting (HTTP range requests only; full ~139 GB planet is NOT downloaded):")
        print("        ", " ".join(extract_cmd))
        proc = subprocess.run(extract_cmd)
        if proc.returncode != 0:
            raise SystemExit(f"pmtiles extract failed for preset '{name}' (exit {proc.returncode})")

        print(f"  [2/4] verifying {out_path.name}:")
        proc = subprocess.run([str(args.tool), "verify", str(out_path)])
        if proc.returncode != 0:
            raise SystemExit(f"pmtiles verify FAILED for {out_path} (exit {proc.returncode})")
        print("        verify: OK")

    if not out_path.exists():
        raise SystemExit(f"archive missing after extract: {out_path}")

    print(f"  [3/4] hashing {out_path.name}:")
    sha256, size_bytes = sha256_and_size(out_path)
    print(f"        sha256={sha256}  size={size_bytes}")

    print("  [4/4] updating metadata.json:")
    update_metadata(preset["out"], sha256, size_bytes, preset)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Rebuild the v1.2.1 geographic-context PMTiles archives "
                    "(build-time tool; the runtime app never calls this).")
    ap.add_argument("--preset", action="append", choices=sorted(PRESETS),
                    help="preset to build; repeatable (default: both)")
    ap.add_argument("--source-url",
                    default="https://build.protomaps.com/20261030.pmtiles",
                    help="source archive URL for pmtiles extract (default: pinned 2026-10-30 snapshot)")
    ap.add_argument("--source-local", type=pathlib.Path, default=None,
                    help="path to a local full PMTiles archive; used as extract input "
                         "instead of --source-url for fully offline rebuilds")
    ap.add_argument("--tool", type=pathlib.Path, default=DEFAULT_TOOL,
                    help="path to the pmtiles CLI (default: %(default)s)")
    ap.add_argument("--dry-run", action="store_true",
                    help="run `pmtiles extract --dry-run` (estimate only, no writes)")
    ap.add_argument("--skip-extract", action="store_true",
                    help="skip extract/verify; refresh sha256/size + provenance from existing archives only")
    ap.add_argument("--out-dir", type=pathlib.Path, default=DEFAULT_OUT_DIR,
                    help="output directory (default: %(default)s)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    presets = args.preset or sorted(PRESETS)

    if not args.skip_extract and not args.dry_run:
        if not args.tool.exists():
            raise SystemExit(f"pmtiles CLI not found at {args.tool}; pass --tool /path/to/pmtiles.exe")

    for name in presets:
        process_preset(name, args)

    print("Done. Run `python scripts/validate_geo_context.py` to accept the result.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
