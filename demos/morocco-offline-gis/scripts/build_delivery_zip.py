#!/usr/bin/env python3
"""Build the deterministic delivery ZIP from dist/ and write its .sha256 sidecar.

The archive is byte-deterministic: entries are walked in sorted order, stored
with fixed 1980 timestamps and deflate compression, so rebuilding from an
identical dist/ yields an identical ZIP. The canonical output path is
releases/Morocco-High-Atlas-Offline-GeoContext-v1.2.1.zip; verify the result
with scripts/verify_delivery_zip.py (dist-driven entry-set + byte-identity).

Docs/V1_2_1_Acceptance.json and Docs/V1_2_1_Completion_Report.txt are excluded
from dist by the packaging step (self-referential-hash convention); this
script packages dist/ as-is and adds nothing else.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import zipfile
from datetime import datetime, timezone

DEFAULT_NAME = "Morocco-High-Atlas-Offline-GeoContext-v1.2.1.zip"
_FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def dist_files(dist: str):
    for root, _dirs, names in os.walk(dist):
        for name in sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, dist).replace(os.sep, "/")
            yield rel, full


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build(dist: str, out_zip: str) -> tuple[int, int, int]:
    entries = sorted(dist_files(dist))
    with open(out_zip, "wb") as _truncate:
        pass
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as bundle:
        for rel, full in entries:
            info = zipfile.ZipInfo(rel, date_time=_FIXED_DATE)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as handle:
                bundle.writestr(info, handle.read())
    size = os.path.getsize(out_zip)
    return len(entries), size, 0


def main(argv=None) -> int:
    demo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", default=os.path.join(demo_root, "dist"))
    parser.add_argument("--out", default=os.path.join(demo_root, "releases", DEFAULT_NAME))
    args = parser.parse_args(argv)

    dist = os.path.abspath(args.dist)
    out_zip = os.path.abspath(args.out)
    if not os.path.isdir(dist):
        print("precondition failed: dist not found: %s" % dist, file=os.sys.stderr)
        return 2
    if under(out_zip, dist):
        print("precondition failed: output zip must not live under dist", file=os.sys.stderr)
        return 2

    os.makedirs(os.path.dirname(out_zip), exist_ok=True)
    started = datetime.now(timezone.utc)
    count, size, _ = build(dist, out_zip)
    digest = sha256_file(out_zip)
    with open(out_zip + ".sha256", "w", encoding="utf-8", newline="\n") as handle:
        handle.write("%s  %s\n" % (digest, os.path.basename(out_zip)))
    print(
        "built %s\n  entries=%d bytes=%d sha256=%s\n  dist=%s\n  started=%s"
        % (out_zip, count, size, digest, dist, started.isoformat())
    )
    return 0


def under(child: str, parent: str) -> bool:
    child = os.path.normcase(os.path.realpath(child))
    parent = os.path.normcase(os.path.realpath(parent))
    return child == parent or child.startswith(parent + os.sep)


if __name__ == "__main__":
    raise SystemExit(main())
