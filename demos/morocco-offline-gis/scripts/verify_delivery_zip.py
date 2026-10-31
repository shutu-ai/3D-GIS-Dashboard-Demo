#!/usr/bin/env python3
"""Verify a candidate delivery ZIP against its source dist/ directory.

Mechanical, read-only byte evidence for the Morocco Offline GIS demo
delivery lane. Python stdlib only. The archive and the dist tree are
never extracted, mutated, or written to; the ONLY file this tool writes
is the explicit --report JSON.

Checks (each recorded per-check in the report):
  archive_readable  the archive hashes and opens as a zip at all
  crc               every member's stored data reads back with a valid
                    CRC-32 (zipfile verifies on stream read; 1 MiB chunks)
  unsafe_paths      no member name contains NUL, is empty, starts with
                    "/", carries a drive prefix (C:), or has a ".."
                    segment (checked after backslash->slash normalization)
  duplicates        no two file members normalize to the same slash path
  entry_set         the set of member file paths equals the set of dist
                    file paths, slash-normalized (explicit directory
                    entries are counted in the report but are not part
                    of the file set)
  byte_identity     every common member is byte-identical to its dist
                    file: same size AND same SHA-256

The report also records mechanical facts: archive SHA-256/size, zip
entry counts/names, dist file count and total bytes, per-file dist
hashes, and metadata of current JS bundles (dist files ending in .js).
The only verdict field is the mechanical top-level "verified" boolean;
no READY/PASS prose is generated.

Exit codes: 0 = verified, 1 = verification failed, 2 = precondition or
usage error (missing/wrong-kind paths, report under dist, zip under
dist). --selftest builds tiny fixtures under <demo>/.data only and
asserts the tool's own behavior on them: an identical archive passes;
modified, missing, extra, duplicate, and unsafe-path archives fail.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import warnings
import zipfile

CHUNK = 1024 * 1024
_DRIVE = re.compile(r"^[A-Za-z]:")
DEMO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELFTEST_BASE = os.path.join(DEMO_ROOT, ".data", "verify_delivery_zip_selftest")


def sha256_and_size(path):
    """Stream-hash a file in 1 MiB chunks. Returns (hexdigest, byte size)."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def slash(name):
    """Path normalization for comparisons: backslash -> forward slash."""
    return name.replace("\\", "/")


def unsafe_reason(name_raw):
    """Safety screen for one archive member path, as stored in the archive.

    Returns a reason string, or None when the path is acceptable. Checks
    run on the backslash->slash normalized form; the NUL check also runs
    on the raw form.
    """
    norm = slash(name_raw)
    if "\x00" in name_raw or "\x00" in norm:
        return "contains NUL byte"
    if norm == "":
        return "empty member name"
    if norm.startswith("/"):
        return "absolute path (leading /)"
    if _DRIVE.match(norm):
        return "drive-letter prefix"
    if ".." in norm.split("/"):
        return "parent-directory segment (..)"
    return None


def dist_files(dist):
    """All files under dist as sorted (slash-relative-path, absolute-path)."""
    found = []
    for root, _dirs, names in os.walk(dist):
        for name in names:
            full = os.path.join(root, name)
            found.append((slash(os.path.relpath(full, dist)), full))
    found.sort()
    return found


def under_path(child, parent):
    """True when realpath(child) equals or lies inside realpath(parent).

    Lexical commonpath comparison; Windows drive-relative case quirks are
    out of scope for this mechanical tool.
    """
    child_real = os.path.realpath(child)
    parent_real = os.path.realpath(parent)
    try:
        return os.path.commonpath([child_real, parent_real]) == parent_real
    except ValueError:  # e.g. different drives
        return False


def verify(zip_path, dist, report_path, quiet=False):
    """Run every check, write the external report JSON, return 0 or 1."""
    # --- dist side (read-only): per-file size + sha256, total bytes ---------
    dist_entries = dist_files(dist)
    dist_meta = {}
    dist_read_errors = []
    dist_total_bytes = 0
    for rel, full in dist_entries:
        try:
            digest, size = sha256_and_size(full)
        except OSError as exc:
            dist_read_errors.append({"path": rel, "error": str(exc)})
            continue
        dist_meta[rel] = {"sha256": digest, "size": size}
        dist_total_bytes += size
    files_list = [
        {"path": rel, "size": dist_meta[rel]["size"], "sha256": dist_meta[rel]["sha256"]}
        for rel, _full in dist_entries
        if rel in dist_meta
    ]
    js_bundles = [entry for entry in files_list if entry["path"].lower().endswith(".js")]

    # --- archive side (read-only): whole-file hash, then per-member pass ----
    archive = {"sha256": None, "size": None}
    archive_error = None
    try:
        archive["sha256"], archive["size"] = sha256_and_size(zip_path)
    except OSError as exc:
        archive_error = str(exc)

    zip_open_error = None
    crc_failed = []
    unsafe = []
    dup_counts = {}
    entry_reads = {}  # normalized name -> list of per-occurrence read records
    zip_dir_entries = 0
    if archive_error is None:
        try:
            with zipfile.ZipFile(zip_path, "r") as bundle:
                for info in bundle.infolist():
                    raw_name = info.filename
                    name = slash(raw_name)
                    reason = unsafe_reason(raw_name)
                    if reason is not None:
                        unsafe.append({"name": raw_name, "normalized": name, "reason": reason})
                    if name.endswith("/"):
                        zip_dir_entries += 1
                        continue
                    dup_counts[name] = dup_counts.get(name, 0) + 1
                    record = {"read_ok": False, "size": None, "sha256": None}
                    entry_reads.setdefault(name, []).append(record)
                    try:
                        # Single streaming pass per member: zipfile verifies
                        # the stored CRC-32 when the stream reaches its end,
                        # and we hash the same bytes for byte_identity.
                        digest = hashlib.sha256()
                        size = 0
                        with bundle.open(info, "r") as stream:
                            while True:
                                block = stream.read(CHUNK)
                                if not block:
                                    break
                                digest.update(block)
                                size += len(block)
                        record["read_ok"] = True
                        record["size"] = size
                        record["sha256"] = digest.hexdigest()
                    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as exc:
                        crc_failed.append({"name": name, "reason": "read/crc failed: %s" % exc})
        except (zipfile.BadZipFile, OSError) as exc:
            zip_open_error = str(exc)

    # --- set comparison and byte identity -----------------------------------
    zip_set = set(entry_reads)
    dist_set = set(rel for rel, _full in dist_entries)
    missing_in_zip = sorted(dist_set - zip_set)
    extra_in_zip = sorted(zip_set - dist_set)

    mismatches = []
    for rel in sorted(zip_set & dist_set):
        reads = entry_reads[rel]
        dist_entry = dist_meta.get(rel)
        if dist_entry is None:
            mismatches.append({"name": rel, "reason": "dist file unreadable"})
            continue
        if len(reads) != 1:
            mismatches.append({
                "name": rel,
                "reason": "duplicate archive entries",
                "occurrences": len(reads),
            })
            continue
        read = reads[0]
        if not read["read_ok"]:
            mismatches.append({"name": rel, "reason": "archive member unreadable (crc/read)"})
            continue
        if read["size"] != dist_entry["size"]:
            mismatches.append({
                "name": rel,
                "reason": "size differs",
                "zip_size": read["size"],
                "dist_size": dist_entry["size"],
            })
            continue
        if read["sha256"] != dist_entry["sha256"]:
            mismatches.append({
                "name": rel,
                "reason": "sha256 differs",
                "zip_sha256": read["sha256"],
                "dist_sha256": dist_entry["sha256"],
            })

    duplicates = [
        {"name": name, "count": count}
        for name, count in sorted(dup_counts.items())
        if count > 1
    ]

    archive_readable_ok = archive_error is None and zip_open_error is None
    checks = {
        "archive_readable": {"ok": archive_readable_ok},
        "crc": {"ok": not crc_failed, "failed_entries": crc_failed},
        "unsafe_paths": {"ok": not unsafe, "entries": unsafe},
        "duplicates": {"ok": not duplicates, "entries": duplicates},
        "entry_set": {
            "ok": not missing_in_zip and not extra_in_zip,
            "missing_in_zip": missing_in_zip,
            "extra_in_zip": extra_in_zip,
        },
        "byte_identity": {"ok": not mismatches, "mismatches": mismatches},
    }
    if archive_error is not None:
        checks["archive_readable"]["error"] = "archive hash failed: %s" % archive_error
    if zip_open_error is not None:
        checks["archive_readable"]["error"] = "not a readable zip: %s" % zip_open_error

    verified = archive["sha256"] is not None and all(check["ok"] for check in checks.values())

    report = {
        "tool": "verify_delivery_zip",
        "zip": zip_path,
        "dist": dist,
        "report": report_path,
        "archive": {"sha256": archive["sha256"], "size": archive["size"]},
        "zip_file_entries": sum(len(reads) for reads in entry_reads.values()),
        "zip_dir_entries": zip_dir_entries,
        "zip_entry_names": sorted(zip_set),
        "dist_files": len(dist_entries),
        "dist_total_bytes": dist_total_bytes,
        "dist_read_errors": dist_read_errors,
        "files": files_list,
        "js_bundles": js_bundles,
        "checks": checks,
        "verified": verified,
    }
    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    with open(report_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")

    if not quiet:
        print("zip: %s" % zip_path)
        print("dist: %s" % dist)
        if archive["sha256"] is not None:
            print("archive sha256: %s (%d bytes)" % (archive["sha256"], archive["size"]))
        print(
            "zip file entries: %d (dir entries: %d) | dist files: %d (%d bytes)"
            % (report["zip_file_entries"], zip_dir_entries, len(dist_entries), dist_total_bytes)
        )
        for name in sorted(checks):
            print("check %s: %s" % (name, "ok" if checks[name]["ok"] else "FAIL"))
        print("verified: %s" % ("true" if verified else "false"))
        print("report: %s" % report_path)
    return 0 if verified else 1


# --- selftest: tiny fixtures, artifacts only under .data ---------------------

_FIXTURE_HTML = b"<!doctype html><html><body>offline demo fixture</body></html>\n"
_FIXTURE_JS = b"/* fixture bundle */\nconsole.log('app');\n"
_FIXTURE_GEOJSON = b'{"type":"FeatureCollection","features":[]}\n'
_FIXTURE_FILES = [
    ("index.html", _FIXTURE_HTML),
    ("assets/app.js", _FIXTURE_JS),
    ("data/points.geojson", _FIXTURE_GEOJSON),
]


def _write_dist(dist):
    os.makedirs(dist, exist_ok=True)
    for rel, data in _FIXTURE_FILES:
        target = os.path.join(dist, *rel.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(data)


def _write_zip(zip_path, entries):
    with warnings.catch_warnings():
        # zipfile warns when two entries share an arcname — expected when
        # building the DUPLICATE fixture, not a fixture defect; silence it
        # so the selftest output stays mechanical.
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as bundle:
            for arcname, data in entries:
                info = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
                bundle.writestr(info, data)


def selftest():
    """Tiny-fixture behavior check, rebuilt deterministically on every run.

    Cases: GOOD (identical archive passes), MODIFIED (same-size tampered
    bytes fail byte_identity), MISSING and EXTRA (entry_set), DUPLICATE
    (same normalized member twice), UNSAFE (../ member path). All
    artifacts stay under .data/verify_delivery_zip_selftest.
    """
    shutil.rmtree(SELFTEST_BASE, ignore_errors=True)

    modified_entries = []
    for rel, data in _FIXTURE_FILES:
        if rel == "assets/app.js":
            # same byte length as the original: only the sha256 can catch it
            data = b"/* fixture bundle */\nconsole.log('Xpp');\n"
        modified_entries.append((rel, data))
    missing_entries = [e for e in _FIXTURE_FILES if e[0] != "data/points.geojson"]
    extra_entries = list(_FIXTURE_FILES) + [("extra.txt", b"not in dist\n")]
    duplicate_entries = list(_FIXTURE_FILES) + [("data/points.geojson", _FIXTURE_GEOJSON)]
    unsafe_entries = list(_FIXTURE_FILES) + [("../escape.txt", b"bad\n")]

    cases = [
        ("GOOD", list(_FIXTURE_FILES), True, None),
        ("MODIFIED", modified_entries, False, "byte_identity"),
        ("MISSING", missing_entries, False, "entry_set"),
        ("EXTRA", extra_entries, False, "entry_set"),
        ("DUPLICATE", duplicate_entries, False, "duplicates"),
        ("UNSAFE", unsafe_entries, False, "unsafe_paths"),
    ]

    all_ok = True
    for name, entries, expect_verified, primary in cases:
        case_dir = os.path.join(SELFTEST_BASE, name)
        dist = os.path.join(case_dir, "dist")
        zip_path = os.path.join(case_dir, "%s.zip" % name)
        report_path = os.path.join(case_dir, "%s.report.json" % name)
        _write_dist(dist)
        _write_zip(zip_path, entries)
        code = verify(zip_path, dist, report_path, quiet=True)
        with open(report_path, "r", encoding="utf-8") as handle:
            report = json.load(handle)
        case_ok = report["verified"] == expect_verified
        case_ok = case_ok and code == (0 if expect_verified else 1)
        if primary is not None:
            case_ok = case_ok and report["checks"][primary]["ok"] is False
        else:
            case_ok = case_ok and all(check["ok"] for check in report["checks"].values())
        if name == "GOOD":
            case_ok = case_ok and len(report["js_bundles"]) == 1
        print(
            "selftest %s: verified=%s expected=%s exit=%d -> %s"
            % (name, report["verified"], expect_verified, code, "ok" if case_ok else "MISMATCH")
        )
        all_ok = all_ok and case_ok
    print("selftest artifacts: %s" % SELFTEST_BASE)
    return 0 if all_ok else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="verify_delivery_zip",
        description=(
            "Mechanically verify a candidate delivery ZIP against its dist/ "
            "tree. Read-only: only the explicit --report JSON is written."
        ),
    )
    parser.add_argument("--zip", help="candidate delivery archive (read-only)")
    parser.add_argument("--dist", help="source dist/ directory (read-only)")
    parser.add_argument("--report", help="explicit report JSON path (must not lie under dist)")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="run the tiny-fixture self check (artifacts under %s)"
        % os.path.relpath(SELFTEST_BASE, DEMO_ROOT),
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    missing = [
        flag
        for flag, value in (("--zip", args.zip), ("--dist", args.dist), ("--report", args.report))
        if not value
    ]
    if missing:
        parser.error("%s required (unless --selftest)" % ", ".join(missing))

    if not os.path.isfile(args.zip):
        print("precondition failed: --zip is not an existing file: %s" % args.zip, file=sys.stderr)
        return 2
    if not os.path.isdir(args.dist):
        print("precondition failed: --dist is not an existing directory: %s" % args.dist, file=sys.stderr)
        return 2
    if under_path(args.report, args.dist):
        print("precondition failed: --report must not be located under --dist (self-reference)", file=sys.stderr)
        return 2
    if under_path(args.zip, args.dist):
        print("precondition failed: --zip must not be located under --dist", file=sys.stderr)
        return 2
    if (os.path.normcase(os.path.realpath(args.report)) == os.path.normcase(os.path.realpath(args.zip))
            or (os.path.exists(args.report) and os.path.samefile(args.report, args.zip))):
        print("precondition failed: --report must not overwrite the archive", file=sys.stderr)
        return 2

    return verify(args.zip, args.dist, args.report)


if __name__ == "__main__":
    sys.exit(main())
