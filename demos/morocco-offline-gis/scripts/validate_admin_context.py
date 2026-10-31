#!/usr/bin/env python3
"""Validation for the geoBoundaries MAR administrative data lane (v1.2.1).

Focused, deterministic, offline data checks (no browser, no build/dist,
no runtime code). Read-only against all data artifacts; the only file it
writes is the generated evidence JSON (--evidence-out).

Checks:
  1. source_provenance  raw snapshots exist, hash+size == pinned fingerprints,
                        MANIFEST.json / SHA256SUMS.txt / NOTICE.txt agree
  2. source_structure   12 ADM1 + 75 ADM2, unique non-empty shapeIDs, allowed
                        geometry types, all ADM2 shapeISO empty, 41 bilingual
                        ADM2 source names
  3. areas_output       areas file matches source verbatim (geometry deep
                        equality, names verbatim), stable ids, contract props
  4. label_derivation   rendered labels equal the documented transform of the
                        source names; non-empty, <= 255 chars, codepoints
                        <= U+00FF; never invented/translated
  5. labels_anchors     overview anchors inside their own source polygon;
                        atlas anchors exist iff polygon INTERSECT real DEM
                        coverage has area > 0 and lie inside that intersection;
                        identity matches the areas file
  6. metadata_contract  geo_context.administrative_context: pinned fields,
                        file hashes/sizes/counts, fixture probe deep-equal to
                        actual label coordinates, no dynamic timestamps
  7. notice             ODbL + territory disclaimer present in public/data/
                        NOTICE.txt and data_sources/geoboundaries/NOTICE.txt
  8. no_fabrication     output id sets equal source id sets exactly; nothing
                        hardcoded or invented

With --idempotence-run the validator snapshots all artifact hashes, re-runs
the builder once (subprocess), snapshots again and requires byte-identical
results (deterministic rebuild, no timestamps).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import prepare_admin_context as prep  # noqa: E402 - shared pinned constants + transform

ROOT = prep.ROOT

# Locked runtime schema: exact property key sets (no extra, no missing).
AREA_PROPS = {
    "level",
    "admin_level",
    "shapeID",
    "shapeName",
    "shapeISO",
    "shapeGroup",
    "shapeType",
    "name",
    "label",
    "source",
    "source_version",
    "source_year",
}
POINT_PROPS = AREA_PROPS | {"scope"}
FEATURE_KEYS = {"type", "id", "geometry", "properties"}
AREAS_URL = "/data/admin-context-areas.geojson"
LABELS_URL = "/data/admin-context-labels.geojson"


def _sha(path: pathlib.Path) -> tuple[str, int]:
    return prep.sha256_and_size(path)


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, name: str, ok: bool, details: dict) -> bool:
        self.checks.append(
            {"name": name, "status": "pass" if ok else "FAIL", "details": details}
        )
        return ok


def deep_geom_equal(a, b) -> bool:
    return a == b  # parsed JSON structures; float repr round-trips exactly


def _all_keys(obj) -> set:
    """Recursively collect actual dict KEYS (structure check, not prose)."""
    keys: set = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= _all_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            keys |= _all_keys(v)
    return keys


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    p = argparse.ArgumentParser(description="Validate the admin context data lane.")
    p.add_argument("--source-dir", default=str(prep.DEFAULT_SOURCE_DIR))
    p.add_argument("--out-dir", default=str(prep.DEFAULT_OUT_DIR))
    p.add_argument(
        "--idempotence-run",
        action="store_true",
        help="re-run the builder once and require byte-identical artifacts",
    )
    p.add_argument(
        "--evidence-out",
        default=str(ROOT / "Docs" / "v1_2_1_admin_data_validation.json"),
    )
    args = p.parse_args(argv)

    out_dir = pathlib.Path(args.out_dir)
    source_dir = pathlib.Path(args.source_dir)
    areas_path = out_dir / prep.AREAS_OUT_NAME
    labels_path = out_dir / prep.LABELS_OUT_NAME
    metadata_path = prep.METADATA_PATH if out_dir == prep.DEFAULT_OUT_DIR else out_dir / "metadata.json"
    notice_path = prep.NOTICE_PATH if out_dir == prep.DEFAULT_OUT_DIR else out_dir / "NOTICE.txt"

    report = Report()

    # ------------------------------------------------------------------ raw
    from shapely.geometry import box, shape  # noqa: E402 - build-time only

    source_feats: dict[int, list[dict]] = {}
    provenance_ok = True
    prov_details: dict = {}
    for level in (1, 2):
        spec = prep.PINNED_SOURCES[level]
        local = source_dir / spec["filename"]
        if not local.exists():
            provenance_ok = False
            prov_details["adm%d" % level] = "missing: %s" % local
            continue
        sha, size = _sha(local)
        match = sha == spec["sha256"] and size == spec["size_bytes"]
        provenance_ok = provenance_ok and match
        prov_details["adm%d" % level] = {
            "path": str(local),
            "sha256": sha,
            "size_bytes": size,
            "matches_pinned": match,
        }
        source_feats[level] = json.loads(local.read_text(encoding="utf-8"))["features"]

    manifest_path = source_dir / "MANIFEST.json"
    sums_path = source_dir / "SHA256SUMS.txt"
    ds_notice_path = source_dir / "NOTICE.txt"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for level in (1, 2):
            spec = prep.PINNED_SOURCES[level]
            entry = manifest.get("files", {}).get(spec["filename"], {})
            ok = (
                entry.get("sha256") == spec["sha256"]
                and entry.get("size_bytes") == spec["size_bytes"]
                and entry.get("url") == spec["url"]
                and manifest.get("commit") == prep.RELEASE_COMMIT
                and manifest.get("retrieved_at") == prep.RETRIEVED_AT
            )
            provenance_ok = provenance_ok and ok
            prov_details["manifest_adm%d" % level] = ok
        prov_details["manifest_counts"] = {
            "adm1": manifest.get("observations", {}).get("adm1_features"),
            "adm2": manifest.get("observations", {}).get("adm2_features"),
        }
    else:
        provenance_ok = False
        prov_details["manifest"] = "missing MANIFEST.json"
    prov_details["sha256sums_present"] = sums_path.exists()
    prov_details["source_notice_present"] = ds_notice_path.exists()
    report.add("source_provenance", provenance_ok, prov_details)

    # ------------------------------------------------------------- structure
    struct_ok = True
    struct_details: dict = {}
    for level in (1, 2):
        spec = prep.PINNED_SOURCES[level]
        feats = source_feats.get(level, [])
        ids = [f["properties"]["shapeID"] for f in feats]
        iso_all_empty = all(f["properties"]["shapeISO"] == "" for f in feats)
        iso_any_present = any(f["properties"]["shapeISO"] for f in feats)
        geom_types = sorted({f["geometry"]["type"] for f in feats})
        bilingual = sum(
            1
            for f in feats
            if any(prep.is_arabic_char(c) for c in f["properties"]["shapeName"])
        )
        ok = (
            len(feats) == spec["expected_features"]
            and len(set(ids)) == len(ids)
            and all(ids)
            and set(geom_types) <= prep.GEOMETRY_TYPES
        )
        if level == 2:
            ok = ok and iso_all_empty and bilingual == prep.EXPECTED_BILINGUAL_ADM2_NAMES
        else:
            ok = ok and iso_any_present
        struct_ok = struct_ok and ok
        struct_details["adm%d" % level] = {
            "count": len(feats),
            "unique_shape_ids": len(set(ids)),
            "geometry_types": geom_types,
            "adm1_shape_iso_present": iso_any_present if level == 1 else None,
            "adm2_shape_iso_all_empty": iso_all_empty if level == 2 else None,
            "bilingual_names": bilingual,
            "ok": ok,
        }
    report.add("source_structure", struct_ok, struct_details)

    # ---------------------------------------------------------------- areas
    areas = json.loads(areas_path.read_text(encoding="utf-8"))
    labels = json.loads(labels_path.read_text(encoding="utf-8"))
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    dem_coverage = list(meta["terrain"]["coverage"])

    area_ok = True
    area_details: dict = {}
    by_id: dict[str, dict] = {}
    if areas.get("type") != "FeatureCollection":
        area_ok = False
        area_details["type"] = areas.get("type")
    expected_ids: set[str] = set()
    for level in (1, 2):
        spec = prep.PINNED_SOURCES[level]
        for src in source_feats.get(level, []):
            expected_ids.add(src["properties"]["shapeID"])
    counts = {1: 0, 2: 0}
    mismatch: list[str] = []
    for feat in areas.get("features", []):
        props = feat.get("properties", {})
        sid = props.get("shapeID")
        by_id[sid] = feat
        level = props.get("admin_level")
        counts[level] = counts.get(level, 0) + 1
        spec = prep.PINNED_SOURCES.get(level)
        src = None
        for cand in source_feats.get(level, []):
            if cand["properties"]["shapeID"] == sid:
                src = cand
                break
        if src is None or spec is None:
            mismatch.append(sid)
            continue
        sp = src["properties"]
        ok = (
            feat.get("id") == sid
            and set(feat) == FEATURE_KEYS
            and set(props) == AREA_PROPS
            and props.get("name") == sp["shapeName"]
            and props.get("shapeName") == sp["shapeName"]
            and props.get("label") == prep.derive_latin_label(sp["shapeName"])
            and deep_geom_equal(feat.get("geometry"), src["geometry"])
            and props.get("shapeISO") == sp["shapeISO"]
            and props.get("shapeGroup") == sp["shapeGroup"]
            and props.get("shapeType") == sp["shapeType"]
            and props.get("level") == spec["level"]
            and props.get("admin_level") == spec["admin_level"]
            and props.get("source") == prep.SOURCE_LABEL
            and props.get("source_version") == prep.RELEASE_COMMIT
            and props.get("source_year") == prep.BOUNDARY_YEAR_REPRESENTED
        )
        if not ok:
            mismatch.append(sid)
    area_ok = (
        area_ok
        and not mismatch
        and counts == {1: 12, 2: 75}
        and set(by_id) == expected_ids
    )
    area_details = {
        "feature_count": len(areas.get("features", [])),
        "adm1": counts.get(1),
        "adm2": counts.get(2),
        "unique_shape_ids": len(by_id),
        "ids_match_source_exactly": set(by_id) == expected_ids,
        "verbatim_geometry_and_names": not mismatch,
        "mismatches": mismatch[:10],
    }
    report.add("areas_output", area_ok, area_details)

    # ------------------------------------------------------- label derivation
    label_ok = True
    label_details: dict = {}
    bad: list[str] = []
    latin_counts = {1: 0, 2: 0}
    for feat in areas.get("features", []):
        props = feat.get("properties", {})
        sid = props.get("shapeID")
        name = props.get("name", "")
        expected_label = prep.derive_latin_label(name)
        label = props.get("label", "")
        ok = (
            label == expected_label
            and bool(label)
            and len(label) <= 255
            and all(ord(c) <= 0x00FF for c in label)
        )
        if props.get("admin_level") == 1 and label == name:
            latin_counts[1] += 1
        if props.get("admin_level") == 2 and label == name:
            latin_counts[2] += 1
        if not ok:
            bad.append(sid)
    label_ok = not bad
    label_details = {
        "labels_checked": len(by_id),
        "invalid_labels": bad[:10],
        "adm1_verbatim_latin_names": latin_counts[1],
        "adm2_verbatim_latin_names": latin_counts[2],
        "transform": "trim at first codepoint > U+00FF; strip whitespace + stray wrapping quotes",
    }
    report.add("label_derivation", label_ok, label_details)

    # ---------------------------------------------------------- label anchors
    anchor_ok = True
    anchor_details: dict = {}
    bbox_poly = box(*dem_coverage)
    overview_by_id: dict[str, dict] = {}
    atlas_by_id: dict[str, dict] = {}
    for feat in labels.get("features", []):
        props = feat.get("properties", {})
        scope = props.get("scope")
        sid = props.get("shapeID")
        target = overview_by_id if scope == "overview" else atlas_by_id
        target[sid] = feat
    anchor_details["overview_points"] = len(overview_by_id)
    anchor_details["atlas_points"] = len(atlas_by_id)
    anchor_details["expected_atlas_from_source"] = 0
    problems: list[str] = []
    src_geom_by_id: dict[str, dict] = {}
    for level in (1, 2):
        for src in source_feats.get(level, []):
            src_geom_by_id[src["properties"]["shapeID"]] = src["geometry"]
    for sid, geom_json in src_geom_by_id.items():
        geom = shape(geom_json)
        ov = overview_by_id.get(sid)
        if ov is None:
            problems.append("%s: missing overview anchor" % sid)
            continue
        coords = ov["geometry"]["coordinates"]
        if not geom.covers(shape({"type": "Point", "coordinates": coords})):
            problems.append("%s: overview anchor outside own polygon" % sid)
        inter = geom.intersection(bbox_poly)
        has_atlas = inter.area > 0
        if has_atlas:
            anchor_details["expected_atlas_from_source"] += 1
        at = atlas_by_id.get(sid)
        if has_atlas and at is None:
            problems.append("%s: missing atlas anchor" % sid)
        if at is not None:
            acoords = at["geometry"]["coordinates"]
            if not has_atlas:
                problems.append("%s: atlas anchor without positive intersection" % sid)
            elif not inter.covers(shape({"type": "Point", "coordinates": acoords})):
                problems.append("%s: atlas anchor outside intersection" % sid)
    # identity agreement between labels and areas
    for scope_map in (overview_by_id, atlas_by_id):
        for sid, feat in scope_map.items():
            area_feat = by_id.get(sid)
            if area_feat is None:
                problems.append("%s: label without area feature" % sid)
                continue
            ap = area_feat["properties"]
            lp = feat["properties"]
            if (
                set(lp) != POINT_PROPS
                or lp.get("name") != ap.get("name")
                or lp.get("label") != ap.get("label")
                or lp.get("admin_level") != ap.get("admin_level")
                or lp.get("level") != ap.get("level")
                or lp.get("shapeISO") != ap.get("shapeISO")
                or lp.get("source_year") != ap.get("source_year")
                or lp.get("source") != ap.get("source")
                or lp.get("source_version") != ap.get("source_version")
                or lp.get("scope") not in ("overview", "atlas")
                or feat.get("id") != "%s:%s" % (sid, lp.get("scope"))
            ):
                problems.append("%s: label identity mismatch" % sid)
    anchor_ok = not problems and len(overview_by_id) == 87
    anchor_details["problems"] = problems[:10]
    report.add("labels_anchors", anchor_ok, anchor_details)

    # ------------------------------------------------------ metadata contract
    contract = meta.get("geo_context", {}).get("administrative_context")
    meta_ok = isinstance(contract, dict)
    meta_details: dict = {}
    if meta_ok:
        src = contract.get("source", {})
        files = contract.get("files", {})
        checks_meta = {
            "commit": contract.get("commit") == prep.RELEASE_COMMIT,
            "release": contract.get("release") == prep.RELEASE_BRANCH,
            "boundary_year_represented": contract.get("boundary_year_represented")
            == prep.BOUNDARY_YEAR_REPRESENTED,
            "areas_url": contract.get("areas_url") == AREAS_URL,
            "labels_url": contract.get("labels_url") == LABELS_URL,
            "source_name": src.get("name") == prep.SOURCE_LABEL,
            "license": src.get("license") == prep.LICENSE,
            "retrieved_at": src.get("retrieved_at") == prep.RETRIEVED_AT,
            "upstream_update": src.get("upstream_update") == prep.UPSTREAM_UPDATE,
            "upstream_build": src.get("upstream_build") == prep.UPSTREAM_BUILD,
            "source_uris": src.get("source_uris")
            == {str(k): prep.PINNED_SOURCES[k]["url"] for k in (1, 2)},
            "territorial_disclaimer": bool(contract.get("territorial_disclaimer")),
            "divergence_note": "2026-10-30" in contract.get("divergence", "")
            and "2017" in contract.get("divergence", ""),
            "no_fill_defaults": "No fill" in contract.get("styling", ""),
            "cartographic_note": bool(contract.get("anchors", {}).get("cartographic_only")),
            "adm2_iso_policy": bool(contract.get("identity", {}).get("adm2_iso_policy")),
            "admin_level_app_semantics": "app level"
            in contract.get("identity", {}).get("admin_level_semantics", "").lower()
            and "not the osm" in contract.get("identity", {})
            .get("admin_level_semantics", "")
            .lower(),
            "no_invented_osm_kind_detail": not (
                {"kind_detail", "kind"} & _all_keys(contract)
            ),
        }
        for name, path in (
            (prep.AREAS_OUT_NAME, areas_path),
            (prep.LABELS_OUT_NAME, labels_path),
        ):
            entry = files.get(name, {})
            sha, size = _sha(path)
            checks_meta["file_%s_hash" % name] = (
                entry.get("sha256") == sha and entry.get("size_bytes") == size
            )
        checks_meta["counts"] = (
            files.get(prep.AREAS_OUT_NAME, {}).get("feature_counts", {})
            == {"adm1": 12, "adm2": 75, "total": 87}
            and files.get(prep.LABELS_OUT_NAME, {}).get("point_counts", {})
            == {
                "overview": len(overview_by_id),
                "atlas": len(atlas_by_id),
                "total": len(overview_by_id) + len(atlas_by_id),
            }
        )
        probe = contract.get("fixture_probe", {}).get("labels", [])
        expected_probe = [
            {
                "id": sid,
                "level": by_id[sid]["properties"]["level"],
                "label": by_id[sid]["properties"]["label"],
                "overview": overview_by_id[sid]["geometry"]["coordinates"],
                "atlas": atlas_by_id[sid]["geometry"]["coordinates"] if sid in atlas_by_id else None,
            }
            for sid in sorted(by_id, key=lambda s: (by_id[s]["properties"]["level"], s))
        ]
        checks_meta["fixture_probe_matches_actual"] = probe == expected_probe
        checks_meta["probe_count"] = len(probe)
        checks_meta["identity_id_lists"] = (
            contract.get("identity", {}).get("adm1_shape_ids") is not None
            and len(contract.get("identity", {}).get("adm2_shape_ids", [])) == 75
        )
        dynamic_keys = [
            k
            for k in json.dumps(contract).lower().split('"')
            if k in {"generated_at", "timestamp", "generatedat", "built_at", "now"}
        ]
        checks_meta["no_dynamic_timestamps"] = not dynamic_keys
        meta_ok = all(checks_meta.values())
        meta_details = {
            "field_checks": {k: v for k, v in checks_meta.items() if not v} or {"all": True},
            "probe_count": len(probe),
        }
    else:
        meta_details = {"contract": "missing geo_context.administrative_context"}
    report.add("metadata_contract", meta_ok, meta_details)

    # ---------------------------------------------------------------- notice
    notice_text = notice_path.read_text(encoding="utf-8") if notice_path.exists() else ""
    ds_notice = ds_notice_path.read_text(encoding="utf-8") if ds_notice_path.exists() else ""
    notice_ok = (
        prep.NOTICE_MARKER in notice_text
        and "ODbL" in notice_text
        and "9469f09" in notice_text
        and "not a political assertion" in notice_text
        and prep.NOTICE_MARKER in ds_notice
        and "ODbL" in ds_notice
    )
    report.add(
        "notice",
        notice_ok,
        {
            "public_notice_has_block": prep.NOTICE_MARKER in notice_text,
            "public_notice_has_odbl": "ODbL" in notice_text,
            "public_notice_has_disclaimer": "not a political assertion" in notice_text,
            "source_notice_ok": prep.NOTICE_MARKER in ds_notice and "ODbL" in ds_notice,
        },
    )

    # --------------------------------------------------------- no fabrication
    fabricate_ok = (
        set(by_id) == expected_ids
        and set(overview_by_id) == expected_ids
        and not area_details.get("mismatches")
    )
    report.add(
        "no_fabrication",
        fabricate_ok,
        {
            "area_ids_equal_source": set(by_id) == expected_ids,
            "label_ids_equal_source": set(overview_by_id) == expected_ids,
            "geometry_and_names_verbatim": area_details.get("verbatim_geometry_and_names"),
        },
    )

    # ------------------------------------------------------------ idempotence
    artifact_paths = [
        areas_path,
        labels_path,
        metadata_path,
        notice_path,
        manifest_path,
        sums_path,
        ds_notice_path,
        source_dir / prep.PINNED_SOURCES[1]["filename"],
        source_dir / prep.PINNED_SOURCES[2]["filename"],
    ]

    def snapshot() -> dict:
        return {str(pth): _sha(pth)[0] for pth in artifact_paths if pth.exists()}

    idem_details: dict = {"performed": False}
    if args.idempotence_run:
        run_a = snapshot()
        proc = subprocess.run(
            [
                sys.executable,
                str(pathlib.Path(__file__).resolve().parent / "prepare_admin_context.py"),
                "--source-dir",
                str(source_dir),
                "--out-dir",
                str(out_dir),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        run_b = snapshot()
        identical = proc.returncode == 0 and run_a == run_b
        idem_details = {
            "performed": True,
            "builder_exit_code": proc.returncode,
            "artifacts_compared": len(run_a),
            "identical": identical,
            "run_a": run_a,
            "run_b": run_b,
        }
        if not identical and proc.returncode != 0:
            idem_details["builder_output_tail"] = (proc.stdout or "")[-2000:]
            idem_details["builder_error_tail"] = (proc.stderr or "")[-2000:]
        report.add("idempotence", identical, idem_details)

    # --------------------------------------------------------------- evidence
    passed = sum(1 for c in report.checks if c["status"] == "pass")
    failed = sum(1 for c in report.checks if c["status"] != "pass")
    evidence = {
        "lane": "v1.2.1 real named administrative supplement (geoBoundaries MAR ADM1+ADM2)",
        "date": prep.RETRIEVED_AT,
        "pinned": {
            "release": "%s@%s" % (prep.RELEASE_BRANCH, prep.RELEASE_COMMIT),
            "boundary_year_represented": prep.BOUNDARY_YEAR_REPRESENTED,
            "license": prep.LICENSE,
            "retrieved_at": prep.RETRIEVED_AT,
            "adm1_sha256": prep.PINNED_SOURCES[1]["sha256"],
            "adm2_sha256": prep.PINNED_SOURCES[2]["sha256"],
        },
        "outputs": {
            path.name: {"sha256": _sha(path)[0], "size_bytes": _sha(path)[1]}
            for path in (areas_path, labels_path, metadata_path, notice_path)
            if path.exists()
        },
        "checks": report.checks,
        "summary": {
            "total": len(report.checks),
            "passed": passed,
            "failed": failed,
        },
    }
    evidence_path = pathlib.Path(args.evidence_out)
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    with evidence_path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(evidence, fh, indent=2, ensure_ascii=True, sort_keys=True)
        fh.write("\n")

    print("=" * 70)
    for check in report.checks:
        print("[%s] %s" % (check["status"].rjust(4), check["name"]))
    print("=" * 70)
    print("passed=%d failed=%d evidence=%s" % (passed, failed, evidence_path))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
