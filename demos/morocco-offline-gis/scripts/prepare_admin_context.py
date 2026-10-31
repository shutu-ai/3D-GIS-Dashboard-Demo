#!/usr/bin/env python3
"""Deterministic DATA lane: geoBoundaries MAR ADM1+ADM2 administrative supplement.

Builds a real, named administrative-boundary supplement for the Morocco
offline 3D GIS demo from pinned geoBoundaries gbOpen source snapshots.

Provenance (parent-verified, fixed; never re-resolved at runtime):
  * release pinned at commit 9469f09 (gbOpen, country MAR)
  * boundaryYearRepresented: 2017; upstream update 2023-01-19, build 2023-12-12
  * license: ODbL 1.0
  * known SHA256 enforced BEFORE any derivation:
      ADM1 21841ea5810305a2c6c25300e4b295e59a9706a5ae0da03b50ae3cfd2ddc5849 (250546 B)
      ADM2 0486dad7e941c1f9ec494a1106a7789737ff4224b878fc2081a1e30b88164dff (587169 B)
  * the only remote mode is --fetch-pinned, which downloads exactly the two
    pinned raw 9469f09 URLs below. A live/unpinned URL is never a build input.

Pipeline (offline by default):
  1. Resolve raw sources: data_sources/geoboundaries/ (default) or the
     approved opencode temp copies (copied into data_sources on first run,
     only after hash verification).
  2. Verify known SHA256 + size for both files.
  3. Emit public/data/admin-context-areas.geojson:
       Polygon/MultiPolygon features, feature.id == shapeID (stable),
       full original geometry preserved verbatim. Locked property schema
       (exact key set, areas and points alike):
         level ('ADM1'|'ADM2'), admin_level (numeric app level 1|2),
         shapeID, shapeName (full original), shapeISO, shapeGroup,
         shapeType, name (== shapeName), label (safe Latin prefix),
         source ('geoBoundaries gbOpen'), source_version ('9469f09'),
         source_year (2017).
       admin_level is the APP level, not the OSM taxonomy; no OSM
       kind/kind_detail numbers are invented for gbOpen features.
  4. Emit public/data/admin-context-labels.geojson: deterministic Point
     anchors. scope="overview": representative_point() of the SAME source
     polygon. scope="atlas": representative_point() of the polygon's
     intersection with the REAL DEM coverage bbox (metadata terrain.coverage);
     only features whose intersection area > 0 get an atlas anchor. Labels are
     cartographic positions inside their own source polygon; they are never
     attributed to OSM segments. Point feature.id == shapeID + ':' + scope;
     properties.shapeID is the stable join key.
  5. Read-modify-write public/data/metadata.json: add
     geo_context.administrative_context (contract + fixture probe with actual
     shapeIDs and anchor coordinates for automated visible tests). All other
     metadata keys are preserved untouched.
  6. Append an ODbL/territory notice block to public/data/NOTICE.txt
     (idempotent via marker).
  7. Write provenance copies + manifest + SHA256SUMS + notice under
     data_sources/geoboundaries/.

Determinism: outputs are canonical JSON with no timestamps; the retrieved
date is the fixed constant RETRIEVED_AT (2026-10-31). Re-running on the same
machine produces byte-identical artifacts.

Requires: shapely (build-time only; not a runtime dependency of the app).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import sys
import urllib.request

# ---------------------------------------------------------------------------
# Pinned provenance constants (verified upstream; do not regenerate at runtime)
# ---------------------------------------------------------------------------

RELEASE_COMMIT = "9469f09"
RELEASE_BRANCH = "gbOpen"
SOURCE_LABEL = "geoBoundaries gbOpen"  # exact runtime props.source value
COUNTRY = "MAR"
BOUNDARY_YEAR_REPRESENTED = 2017
UPSTREAM_UPDATE = "2023-01-19"
UPSTREAM_BUILD = "2023-12-12"
LICENSE = "ODbL 1.0"
RETRIEVED_AT = "2026-10-31"  # fixed date; never a wall-clock timestamp
SOURCE_PROVIDER = "geoBoundaries"
GEOBOUNDARIES_BASE = (
    "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData"
)

EXPECTED_BILINGUAL_ADM2_NAMES = 41

PINNED_SOURCES: dict[int, dict] = {
    1: {
        "level": "ADM1",
        "admin_level": 1,
        "filename": "geoBoundaries-MAR-ADM1_simplified.geojson",
        "url": (
            "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData"
            "/gbOpen/MAR/ADM1/geoBoundaries-MAR-ADM1_simplified.geojson"
        ),
        "sha256": (
            "21841ea5810305a2c6c25300e4b295e59a9706a5ae0da03b50ae3cfd2ddc5849"
        ),
        "size_bytes": 250546,
        "expected_features": 12,
    },
    2: {
        "level": "ADM2",
        "admin_level": 2,
        "filename": "geoBoundaries-MAR-ADM2_simplified.geojson",
        "url": (
            "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData"
            "/gbOpen/MAR/ADM2/geoBoundaries-MAR-ADM2_simplified.geojson"
        ),
        "sha256": (
            "0486dad7e941c1f9ec494a1106a7789737ff4224b878fc2081a1e30b88164dff"
        ),
        "size_bytes": 587169,
        "expected_features": 75,
    },
}

APPROVED_TEMP_DIR = pathlib.Path(
    "C:/Users/swx1536744/AppData/Local/Temp/opencode"
)
APPROVED_TEMP_FILES: dict[int, str] = {
    1: "mar_adm1_simplified.geojson",
    2: "mar_adm2_simplified.geojson",
}

SOURCE_PROPS = ("shapeName", "shapeISO", "shapeID", "shapeGroup", "shapeType")
GEOMETRY_TYPES = {"Polygon", "MultiPolygon"}

NOTICE_MARKER = "geoBoundaries gbOpen Morocco (MAR)"

NOTICE_BLOCK = """\
Administrative area polygons (admin-context-areas.geojson and
admin-context-labels.geojson) contain {provider} {branch} Morocco ({country})
ADM1/ADM2 boundaries, release pinned at {commit}; boundary year represented
{year}. Offered under {license} (same license terms and conditions as the
OSM-derived data above; attribution, share-alike and access requirements
apply). Pinned raw sources:
  ADM1: {url1}
  ADM2: {url2}
Retrieved {retrieved}. Hashes, feature counts, label-transform provenance and
the fixture probe are recorded in metadata.json under
geo_context.administrative_context. The territorial extent of the {country}
dataset is the source's ({provider}) administrative classification, reproduced
verbatim; it is not a political assertion by this application. Rendered label
strings are the published Latin/French prefixes of the source names; nothing
is invented, translated or re-attributed.
"""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = ROOT / "public" / "data"
METADATA_PATH = DEFAULT_OUT_DIR / "metadata.json"
NOTICE_PATH = DEFAULT_OUT_DIR / "NOTICE.txt"
DEFAULT_SOURCE_DIR = ROOT / "data_sources" / "geoboundaries"

AREAS_OUT_NAME = "admin-context-areas.geojson"
LABELS_OUT_NAME = "admin-context-labels.geojson"


def _utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - non-console streams
            pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def sha256_and_size(path: pathlib.Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def is_arabic_char(ch: str) -> bool:
    o = ord(ch)
    return (
        0x0600 <= o <= 0x06FF
        or 0x0750 <= o <= 0x077F
        or 0x08A0 <= o <= 0x08FF
        or 0xFB50 <= o <= 0xFDFF
        or 0xFE70 <= o <= 0xFEFF
    )


def derive_latin_label(name: str) -> str:
    """Deterministic cartographic label from the verbatim source shapeName.

    Documented transform (never invents, translates or transliterates):
      1. Start from the full original shapeName exactly as published.
      2. Remove everything from the first character whose Unicode codepoint
         is greater than U+00FF onward. Arabic (U+0600+), Tifinagh (U+2D30+)
         and any other non-Latin-1 suffix therefore drops, while accented
         Latin letters (e.g. "e" U+00E9, "a" U+00E2) are kept as-is. For
         bilingual French/Arabic source names this isolates the published
         Latin/French prefix.
      3. Strip surrounding whitespace, then strip stray wrapping double-quote
         characters that some source strings carry verbatim, then strip
         whitespace again.

    The result must be non-empty, at most 255 characters, and contain only
    codepoints <= U+00FF (the bundled Noto Sans glyph range is 0-255).
    """
    s = name
    for i, ch in enumerate(s):
        if ord(ch) > 0x00FF:
            s = s[:i]
            break
    s = s.strip()
    s = s.strip('"').strip()
    if not s:
        raise ValueError(
            "label derivation produced an empty string for source name %r; "
            "refusing to invent a name" % name
        )
    if len(s) > 255:
        raise ValueError("derived label exceeds 255 chars: %r" % s)
    for ch in s:
        if ord(ch) > 0x00FF:
            raise ValueError(
                "derived label contains unsupported codepoint U+%04X: %r"
                % (ord(ch), s)
            )
    return s


def write_json_canonical(path: pathlib.Path, obj) -> None:
    r"""Canonical deterministic JSON: sorted keys, LF endings, trailing newline.

    ensure_ascii=True keeps the artifact bytes pure ASCII regardless of the
    build machine locale; string contents (including Arabic source names) are
    preserved exactly via \uXXXX escapes.
    """
    text = json.dumps(obj, indent=2, ensure_ascii=True, sort_keys=True) + "\n"
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


# ---------------------------------------------------------------------------
# Source acquisition (offline-first; pinned URLs are the only remote mode)
# ---------------------------------------------------------------------------


def verify_pinned(path: pathlib.Path, spec: dict) -> None:
    sha, size = sha256_and_size(path)
    if size != spec["size_bytes"] or sha != spec["sha256"]:
        raise SystemExit(
            "FATAL: %s does not match the pinned fingerprint\n"
            "  expected sha256=%s size=%d\n"
            "  actual   sha256=%s size=%d\n"
            "Refusing to derive from unverified source data."
            % (path, spec["sha256"], spec["size_bytes"], sha, size)
        )


def fetch_pinned(spec: dict, dest: pathlib.Path) -> None:
    print("  fetching pinned %s ..." % spec["url"])
    req = urllib.request.Request(spec["url"], headers={"User-Agent": "geo-boundaries-pinned-fetch"})
    with urllib.request.urlopen(req) as resp:  # noqa: S310 - pinned https URL
        data = resp.read()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    verify_pinned(dest, spec)


def resolve_source_files(args: argparse.Namespace) -> dict[int, pathlib.Path]:
    """Locate/obtain the two raw snapshots and verify hashes BEFORE deriving."""
    source_dir = pathlib.Path(args.source_dir)
    resolved: dict[int, pathlib.Path] = {}
    for level, spec in PINNED_SOURCES.items():
        local = source_dir / spec["filename"]
        if local.exists():
            verify_pinned(local, spec)
            resolved[level] = local
            continue
        if args.fetch_pinned:
            fetch_pinned(spec, local)
            resolved[level] = local
            continue
        temp_candidate = APPROVED_TEMP_DIR / APPROVED_TEMP_FILES[level]
        if temp_candidate.exists():
            verify_pinned(temp_candidate, spec)
            source_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(temp_candidate, local)
            verify_pinned(local, spec)
            print("  copied approved temp copy -> %s (hash verified)" % local)
            resolved[level] = local
            continue
        raise SystemExit(
            "FATAL: raw source for ADM%d not found.\n"
            "  looked in: %s\n"
            "  approved temp copy: %s\n"
            "Re-run with --fetch-pinned to download the exact pinned "
            "9469f09 snapshot (hash-verified)." % (level, local, temp_candidate)
        )
    return resolved


def load_level(path: pathlib.Path, spec: dict) -> tuple[list[dict], dict]:
    """Parse one raw snapshot; structural checks; return features + summary."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("type") != "FeatureCollection":
        raise SystemExit("FATAL: %s is not a FeatureCollection" % path)
    feats = raw.get("features", [])
    if len(feats) != spec["expected_features"]:
        raise SystemExit(
            "FATAL: ADM%d expected %d features, found %d in %s"
            % (spec["admin_level"], spec["expected_features"], len(feats), path)
        )
    ids: set[str] = set()
    names: list[str] = []
    for feat in feats:
        props = feat.get("properties") or {}
        for key in SOURCE_PROPS:
            if key not in props:
                raise SystemExit(
                    "FATAL: ADM%d feature missing source property %r" % (spec["admin_level"], key)
                )
        shape_id = props["shapeID"]
        if not shape_id or shape_id in ids:
            raise SystemExit(
                "FATAL: ADM%d shapeIDs must be non-empty and unique (%r)" % (spec["admin_level"], shape_id)
            )
        ids.add(shape_id)
        if feat["geometry"]["type"] not in GEOMETRY_TYPES:
            raise SystemExit(
                "FATAL: ADM%d geometry type %r not supported"
                % (spec["admin_level"], feat["geometry"]["type"])
            )
        names.append(props["shapeName"])
    bilingual = sum(1 for n in names if any(is_arabic_char(c) for c in n))
    return feats, {
        "count": len(feats),
        "unique_shape_ids": len(ids),
        "bilingual_names": bilingual,
        "geometry_types": sorted({f["geometry"]["type"] for f in feats}),
    }


# ---------------------------------------------------------------------------
# Output construction
# ---------------------------------------------------------------------------


def feature_properties(feat: dict, spec: dict, label: str) -> dict:
    """Locked runtime schema (exact key set, same for areas and points).

    admin_level is the APP level (1=ADM1, 2=ADM2 per geoBoundaries shapeType),
    not the OSM admin_level taxonomy; no OSM kind/kind_detail numbers are
    invented for gbOpen features.
    """
    props = feat["properties"]
    return {
        "level": spec["level"],
        "admin_level": spec["admin_level"],
        "shapeID": props["shapeID"],
        "shapeName": props["shapeName"],
        "shapeISO": props["shapeISO"],
        "shapeGroup": props["shapeGroup"],
        "shapeType": props["shapeType"],
        "name": props["shapeName"],
        "label": label,
        "source": SOURCE_LABEL,
        "source_version": RELEASE_COMMIT,
        "source_year": BOUNDARY_YEAR_REPRESENTED,
    }


def build_areas(features_by_level: dict[int, list[dict]], specs: dict) -> dict:
    out_features = []
    for level in (1, 2):
        spec = specs[level]
        for feat in features_by_level[level]:
            label = derive_latin_label(feat["properties"]["shapeName"])
            out_features.append(
                {
                    "type": "Feature",
                    "id": feat["properties"]["shapeID"],
                    "geometry": feat["geometry"],  # verbatim source geometry
                    "properties": feature_properties(feat, spec, label),
                }
            )
    return {
        "type": "FeatureCollection",
        "name": "admin-context-areas",
        "metadata": {
            "source": SOURCE_LABEL,
            "source_version": RELEASE_COMMIT,
            "source_year": BOUNDARY_YEAR_REPRESENTED,
            "license": LICENSE,
            "territorial_disclaimer": (
                "Territorial extent is the source's administrative "
                "classification, not a political assertion by this application."
            ),
            "geometry_policy": (
                "Full source geometry preserved verbatim (no simplification, "
                "winding-order rewrite or coordinate rounding)."
            ),
            "admin_level_semantics": (
                "admin_level is the app level (1=ADM1, 2=ADM2 per "
                "geoBoundaries shapeType); it is not the OSM admin_level "
                "taxonomy and no OSM kind/kind_detail numbers are invented "
                "for gbOpen features."
            ),
        },
        "features": out_features,
    }


def build_labels(
    features_by_level: dict[int, list[dict]],
    specs: dict,
    dem_coverage: list[float],
) -> tuple[dict, list[dict]]:
    from shapely.geometry import box, shape  # build-time dependency only

    bbox_poly = box(*dem_coverage)
    out_features = []
    probes = []
    atlas_count = 0
    for level in (1, 2):
        spec = specs[level]
        for feat in features_by_level[level]:
            props = feat["properties"]
            shape_id = props["shapeID"]
            label = derive_latin_label(props["shapeName"])
            base_props = feature_properties(feat, spec, label)

            geom = shape(feat["geometry"])
            overview_pt = geom.representative_point()
            overview_coord = [overview_pt.x, overview_pt.y]

            atlas_coord = None
            intersection = geom.intersection(bbox_poly)
            if intersection.area > 0:
                atlas_pt = intersection.representative_point()
                atlas_coord = [atlas_pt.x, atlas_pt.y]
                atlas_count += 1

            for scope, coord in (("overview", overview_coord), ("atlas", atlas_coord)):
                if coord is None:
                    continue
                point_props = dict(base_props)
                point_props["scope"] = scope
                out_features.append(
                    {
                        "type": "Feature",
                        "id": "%s:%s" % (shape_id, scope),
                        "geometry": {"type": "Point", "coordinates": coord},
                        "properties": point_props,
                    }
                )

            probes.append(
                {
                    "id": shape_id,
                    "level": spec["level"],
                    "label": label,
                    "overview": overview_coord,
                    "atlas": atlas_coord,
                }
            )

    probes.sort(key=lambda p: (p["level"], p["id"]))
    labels = {
        "type": "FeatureCollection",
        "name": "admin-context-labels",
        "metadata": {
            "source": SOURCE_LABEL,
            "source_version": RELEASE_COMMIT,
            "source_year": BOUNDARY_YEAR_REPRESENTED,
            "license": LICENSE,
            "anchor_method": (
                "deterministic shapely representative_point (interior point) "
                "of the SAME source polygon; overview = full polygon, "
                "atlas = polygon INTERSECT real DEM coverage bbox"
            ),
            "cartographic_note": (
                "Label points are cartographic positions inside their own "
                "source polygon; they are never attributed to OSM segments."
            ),
            "dem_coverage_bbox": dem_coverage,
            "scopes": {
                "overview": "representative_point of the full source polygon",
                "atlas": (
                    "representative_point of polygon INTERSECT real DEM "
                    "coverage bbox; emitted only when the intersection "
                    "area > 0"
                ),
            },
        },
        "features": out_features,
    }
    return labels, probes


# ---------------------------------------------------------------------------
# Metadata / NOTICE / provenance writers
# ---------------------------------------------------------------------------


def metadata_contract(
    labels: dict,
    probes: list[dict],
    summaries: dict[int, dict],
    source_files: dict[int, pathlib.Path],
    dem_coverage: list[float],
    output_files: dict[str, pathlib.Path],
) -> dict:
    features = labels["features"]
    overview_count = sum(1 for f in features if f["properties"]["scope"] == "overview")
    atlas_count = sum(1 for f in features if f["properties"]["scope"] == "atlas")

    def file_entry(path: pathlib.Path, **extra) -> dict:
        sha, size = sha256_and_size(path)
        entry = {"sha256": sha, "size_bytes": size}
        entry.update(extra)
        return entry

    adm1_ids = sorted(
        f["properties"]["shapeID"]
        for f in labels["features"]
        if f["properties"]["admin_level"] == 1 and f["properties"]["scope"] == "overview"
    )
    adm2_ids = sorted(
        f["properties"]["shapeID"]
        for f in labels["features"]
        if f["properties"]["admin_level"] == 2 and f["properties"]["scope"] == "overview"
    )

    contract = {
        "mode": "real named administrative supplement (deterministic offline data lane)",
        "provider": SOURCE_PROVIDER,
        "release": RELEASE_BRANCH,
        "country": COUNTRY,
        "commit": RELEASE_COMMIT,
        "boundary_year_represented": BOUNDARY_YEAR_REPRESENTED,
        "areas_url": "/data/admin-context-areas.geojson",
        "labels_url": "/data/admin-context-labels.geojson",
        "source": {
            "name": SOURCE_LABEL,
            "provider": SOURCE_PROVIDER,
            "release": RELEASE_BRANCH,
            "commit": RELEASE_COMMIT,
            "boundary_year_represented": BOUNDARY_YEAR_REPRESENTED,
            "upstream_update": UPSTREAM_UPDATE,
            "upstream_build": UPSTREAM_BUILD,
            "license": LICENSE,
            "retrieved_at": RETRIEVED_AT,
            "offline_build": True,
            "source_uris": {str(k): PINNED_SOURCES[k]["url"] for k in (1, 2)},
            "local_copies": {
                str(k): {
                    "path": "data_sources/geoboundaries/" + PINNED_SOURCES[k]["filename"],
                    "sha256": PINNED_SOURCES[k]["sha256"],
                    "size_bytes": PINNED_SOURCES[k]["size_bytes"],
                    "feature_count": summaries[k]["count"],
                }
                for k in (1, 2)
            },
            "source_fields": ["shapeName", "shapeISO", "shapeID", "shapeGroup", "shapeType"],
        },
        "files": {
            AREAS_OUT_NAME: file_entry(
                output_files[AREAS_OUT_NAME],
                public_url="/data/admin-context-areas.geojson",
                role="named administrative area polygons (ADM1+ADM2), full source geometry",
                feature_counts={
                    "adm1": summaries[1]["count"],
                    "adm2": summaries[2]["count"],
                    "total": summaries[1]["count"] + summaries[2]["count"],
                },
            ),
            LABELS_OUT_NAME: file_entry(
                output_files[LABELS_OUT_NAME],
                public_url="/data/admin-context-labels.geojson",
                role="deterministic cartographic label anchor points (overview/atlas)",
                point_counts={
                    "overview": overview_count,
                    "atlas": atlas_count,
                    "total": overview_count + atlas_count,
                },
            ),
        },
        "identity": {
            "stable_id": "shapeID (geoBoundaries stable boundary ID); area feature.id == shapeID; label feature.id == shapeID + ':' + scope; properties.shapeID is the stable join key",
            "admin_level_semantics": (
                "admin_level is the numeric APP level (1=ADM1, 2=ADM2 per "
                "geoBoundaries shapeType); it is NOT the OSM admin_level "
                "taxonomy and no OSM kind/kind_detail numbers (4/5/6) are "
                "invented for gbOpen features."
            ),
            "adm1_shape_ids": adm1_ids,
            "adm2_shape_ids": adm2_ids,
            "adm2_iso_policy": (
                "All ADM2 shapeISO values are empty in the pinned source; "
                "shapeISO is preserved verbatim (empty string) and shapeID "
                "is the only stable identifier for ADM2 features."
            ),
        },
        "label_transform": {
            "name": "verbatim original source shapeName (French/Latin/Arabic/Tifinagh as published)",
            "label": (
                "deterministic non-Latin suffix trim: characters from the "
                "first codepoint > U+00FF onward are removed (drops Arabic "
                "U+0600+ and Tifinagh U+2D30+ suffixes, keeps accented Latin "
                "letters); surrounding whitespace and stray wrapping "
                "double-quote characters present verbatim in some source "
                "strings are stripped. The result is the published "
                "Latin/French prefix - never invented, translated or "
                "transliterated."
            ),
            "validation": (
                "rendered label is non-empty, <= 255 characters, every "
                "codepoint <= U+00FF (bundled Noto Sans glyph range 0-255)"
            ),
            "counts": {
                "bilingual_source_names_adm2": summaries[2]["bilingual_names"],
            },
        },
        "anchors": {
            "method": (
                "shapely representative_point (interior point), computed from "
                "the same source polygon the label belongs to; deterministic "
                "and geometry-interior by construction"
            ),
            "scope_overview": "representative_point of the full source polygon",
            "scope_atlas": (
                "representative_point of polygon INTERSECT real DEM coverage "
                "bbox; emitted only when intersection area > 0 (no invented "
                "or out-of-coverage anchors)"
            ),
            "dem_coverage_bbox": dem_coverage,
            "cartographic_only": (
                "Labels are cartographic positions within their own source "
                "polygon; they are not attributed to OSM segments."
            ),
        },
        "fixture_probe": {
            "note": (
                "actual pinned shapeIDs with rendered labels and anchor "
                "coordinates ([lng, lat] as emitted in %s) for automated "
                "visible-text tests" % LABELS_OUT_NAME
            ),
            "labels": probes,
        },
        "divergence": (
            "Administrative polygons are geoBoundaries gbOpen with boundary "
            "year represented 2017 (release pinned 9469f09, retrieved "
            "%s). They can diverge from the OSM-derived Protomaps "
            "2026-10-30 boundary lines rendered by geo_context; the two "
            "sources are kept separate by design and this data lane asserts "
            "no reconciliation between them." % RETRIEVED_AT
        ),
        "territorial_disclaimer": (
            "The territorial extent of the MAR dataset is the source's "
            "(geoBoundaries) classification of administrative areas, "
            "reproduced verbatim; it is not a political assertion by this "
            "application."
        ),
        "boundary_source_precedence": (
            "These polygons are the primary named administrative boundary "
            "source for the labeled supplement; OSM/Protomaps ADM0 lines and "
            "disputed-boundary handling remain under geo_context rendering "
            "control."
        ),
        "styling": (
            "No fill, color, opacity or style defaults are defined by this "
            "data contract; all rendering is owned by the application."
        ),
    }
    return contract


def update_metadata(contract: dict) -> None:
    """Read-modify-write: preserve every unrelated metadata key and its order."""
    meta = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    geo = meta.setdefault("geo_context", {})
    geo["administrative_context"] = contract
    text = json.dumps(meta, indent=2, ensure_ascii=False) + "\n"
    METADATA_PATH.write_text(text, encoding="utf-8")


def append_notice() -> bool:
    existing = NOTICE_PATH.read_text(encoding="utf-8") if NOTICE_PATH.exists() else ""
    if NOTICE_MARKER in existing:
        return False
    block = NOTICE_BLOCK.format(
        provider=SOURCE_PROVIDER,
        branch=RELEASE_BRANCH,
        country=COUNTRY,
        commit=RELEASE_COMMIT,
        year=BOUNDARY_YEAR_REPRESENTED,
        license=LICENSE,
        url1=PINNED_SOURCES[1]["url"],
        url2=PINNED_SOURCES[2]["url"],
        retrieved=RETRIEVED_AT,
    )
    sep = "" if existing.endswith("\n") else "\n"
    with NOTICE_PATH.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(sep + block)
    return True


def write_provenance(
    source_files: dict[int, pathlib.Path],
    summaries: dict[int, dict],
    output_files: dict[str, pathlib.Path],
) -> None:
    out_dir = DEFAULT_SOURCE_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "source": SOURCE_PROVIDER,
        "release": RELEASE_BRANCH,
        "country": COUNTRY,
        "commit": RELEASE_COMMIT,
        "boundary_year_represented": BOUNDARY_YEAR_REPRESENTED,
        "upstream_update": UPSTREAM_UPDATE,
        "upstream_build": UPSTREAM_BUILD,
        "license": LICENSE,
        "retrieved_at": RETRIEVED_AT,
        "offline_build": True,
        "files": {},
        "derived_outputs": {},
        "observations": {
            "adm1_features": summaries[1]["count"],
            "adm2_features": summaries[2]["count"],
            "adm1_unique_shape_ids": summaries[1]["unique_shape_ids"],
            "adm2_unique_shape_ids": summaries[2]["unique_shape_ids"],
            "adm2_bilingual_names": summaries[2]["bilingual_names"],
            "adm2_shape_iso_all_empty": True,
            "adm1_geometry_types": summaries[1]["geometry_types"],
            "adm2_geometry_types": summaries[2]["geometry_types"],
        },
        "label_transform": (
            "rendered label = published Latin/French prefix of shapeName "
            "(trim from first codepoint > U+00FF; strip whitespace and stray "
            "wrapping double quotes); never invented or translated"
        ),
    }
    for level in (1, 2):
        spec = PINNED_SOURCES[level]
        local = source_files[level]
        sha, size = sha256_and_size(local)
        manifest["files"][spec["filename"]] = {
            "url": spec["url"],
            "sha256": sha,
            "size_bytes": size,
            "feature_count": summaries[level]["count"],
            "level": spec["level"],
        }
    for name in (AREAS_OUT_NAME, LABELS_OUT_NAME):
        sha, size = sha256_and_size(output_files[name])
        manifest["derived_outputs"][name] = {
            "sha256": sha,
            "size_bytes": size,
            "path": "public/data/" + name,
        }
    write_json_canonical(out_dir / "MANIFEST.json", manifest)

    lines = []
    for level in (1, 2):
        sha, _ = sha256_and_size(source_files[level])
        lines.append("%s  %s" % (sha, PINNED_SOURCES[level]["filename"]))
    for name in (AREAS_OUT_NAME, LABELS_OUT_NAME):
        sha, _ = sha256_and_size(output_files[name])
        lines.append("%s  public/data/%s" % (sha, name))
    with (out_dir / "SHA256SUMS.txt").open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")

    notice = out_dir / "NOTICE.txt"
    notice_text = (
        "geoBoundaries gbOpen Morocco (MAR) ADM1/ADM2 simplified boundaries.\n"
        "Release pinned at {commit}; boundary year represented {year}.\n"
        "Upstream update {upd}; upstream build {bld}.\n"
        "License: {license}\n"
        "  https://opendatacommons.org/licenses/odbl/1-0/\n"
        "Sources (pinned raw URLs):\n"
        "  {url1}\n"
        "  {url2}\n"
        "Retrieved {ret}. Local copies are hash-verified against the pinned\n"
        "SHA256 fingerprints in MANIFEST.json / SHA256SUMS.txt before any\n"
        "derivation. The territorial extent of the MAR dataset is the\n"
        "source's administrative classification, reproduced verbatim; it is\n"
        "not a political assertion by this application.\n"
    ).format(
        commit=RELEASE_COMMIT,
        year=BOUNDARY_YEAR_REPRESENTED,
        upd=UPSTREAM_UPDATE,
        bld=UPSTREAM_BUILD,
        license=LICENSE,
        url1=PINNED_SOURCES[1]["url"],
        url2=PINNED_SOURCES[2]["url"],
        ret=RETRIEVED_AT,
    )
    with notice.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(notice_text)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build the geoBoundaries MAR administrative data lane (deterministic)."
    )
    p.add_argument(
        "--source-dir",
        default=str(DEFAULT_SOURCE_DIR),
        help="directory holding the raw geoBoundaries snapshots (default: %(default)s)",
    )
    p.add_argument(
        "--fetch-pinned",
        action="store_true",
        help="download the two exact pinned 9469f09 raw URLs (hash-verified) "
        "when the local snapshot is missing; never fetches any other URL",
    )
    p.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="output directory for the public data artifacts (default: %(default)s)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    _utf8_console()
    args = parse_args(argv)
    out_dir = pathlib.Path(args.out_dir)

    meta = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    dem_coverage = list(meta["terrain"]["coverage"])
    print("REAL DEM coverage bbox (metadata terrain.coverage): %s" % dem_coverage)

    print("[1/5] resolving + hash-verifying pinned raw sources ...")
    source_files = resolve_source_files(args)

    print("[2/5] parsing + structural checks ...")
    features_by_level: dict[int, list[dict]] = {}
    summaries: dict[int, dict] = {}
    for level in (1, 2):
        feats, summary = load_level(source_files[level], PINNED_SOURCES[level])
        features_by_level[level] = feats
        summaries[level] = summary
        print(
            "  ADM%d: %d features, %d unique shapeIDs, bilingual=%d, geometry=%s"
            % (
                level,
                summary["count"],
                summary["unique_shape_ids"],
                summary["bilingual_names"],
                summary["geometry_types"],
            )
        )
    if summaries[2]["bilingual_names"] != EXPECTED_BILINGUAL_ADM2_NAMES:
        raise SystemExit(
            "FATAL: expected %d bilingual ADM2 source names, found %d"
            % (EXPECTED_BILINGUAL_ADM2_NAMES, summaries[2]["bilingual_names"])
        )

    print("[3/5] deriving areas + deterministic label anchors ...")
    areas = build_areas(features_by_level, PINNED_SOURCES)
    labels, probes = build_labels(features_by_level, PINNED_SOURCES, dem_coverage)

    print("[4/5] writing canonical outputs ...")
    out_dir.mkdir(parents=True, exist_ok=True)
    output_files = {
        AREAS_OUT_NAME: out_dir / AREAS_OUT_NAME,
        LABELS_OUT_NAME: out_dir / LABELS_OUT_NAME,
    }
    write_json_canonical(output_files[AREAS_OUT_NAME], areas)
    write_json_canonical(output_files[LABELS_OUT_NAME], labels)
    for name, path in output_files.items():
        sha, size = sha256_and_size(path)
        print("  %s  sha256=%s  size=%d" % (name, sha, size))

    print("[5/5] metadata contract + notices + provenance ...")
    contract = metadata_contract(
        labels, probes, summaries, source_files, dem_coverage, output_files
    )
    update_metadata(contract)
    notice_appended = append_notice()
    write_provenance(source_files, summaries, output_files)
    sha, size = sha256_and_size(METADATA_PATH)
    print("  metadata.json updated (administrative_context added; RMW stable)")
    print("  metadata.json sha256=%s size=%d" % (sha, size))
    print(
        "  NOTICE.txt: %s"
        % ("notice block appended" if notice_appended else "notice block already present")
    )

    atlas_total = sum(1 for f in labels["features"] if f["properties"]["scope"] == "atlas")
    print(
        "DONE: %d area features (%d ADM1 + %d ADM2), %d label points "
        "(%d overview + %d atlas)."
        % (
            summaries[1]["count"] + summaries[2]["count"],
            summaries[1]["count"],
            summaries[2]["count"],
            len(labels["features"]),
            len(labels["features"]) - atlas_total,
            atlas_total,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
