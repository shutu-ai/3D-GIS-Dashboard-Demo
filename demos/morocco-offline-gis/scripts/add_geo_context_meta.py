"""One-shot: add the v1.2.1 geo_context provenance block to metadata.json.
(Kept as a script for traceability; scripts/prepare_geo_context.py is the
reproducible pipeline that regenerates the same block after re-extraction.)
"""
import json
import pathlib

META = pathlib.Path(__file__).resolve().parent.parent / "public" / "data" / "metadata.json"

BLOCK = {
    "mode": "real open geographic data",
    "provider": "Protomaps Basemap v4 (planetiler; OpenStreetMap + Natural Earth)",
    "source": {
        "url": "https://build.protomaps.com/20261030.pmtiles",
        "snapshot": "2026-10-30",
        "build_version": "4.15.2",
        "retrieved_at": "2026-10-30",
        "size_bytes": 139202898553,
        "md5": "6JzP3p/XlgMG7jMbTCd/NA==",
        "b3sum": "b936e54942f13e0d5e3921409b992348a61f33953e4a6609dbef5aeb52c8f917",
        "license": "OpenStreetMap data under ODbL 1.0; rendering via Protomaps Basemap tiles",
        "attribution": "Geographic data: (c) OpenStreetMap contributors (ODbL) - Protomaps Basemap v4",
    },
    "files": {
        "morocco-overview.pmtiles": {
            "role": "nationwide 2D geographic overview (admin/cities/major roads/water)",
            "sha256": "f5e587bd800ef7b7d846c30e3feae6bcaba89ccf91935ec1076f0006202ca119",
            "size_bytes": 65961582,
            "bbox": [-17.6, 20.4, -0.6, 36.35],
            "minzoom": 0,
            "maxzoom": 12,
            "layers": ["boundaries", "buildings", "earth", "landcover", "landuse", "places", "pois", "roads", "water"],
        },
        "high-atlas-context.pmtiles": {
            "role": "High Atlas local context (local roads/villages/waterway/peaks)",
            "sha256": "507986ca83b62f5f032ee82f52d2b57f20260ff5b4298f80c6d6716bb68a00de",
            "size_bytes": 36675954,
            "bbox": [-9.15, 30.4, -6.05, 32.0],
            "minzoom": 0,
            "maxzoom": 14,
            "layers": ["boundaries", "buildings", "earth", "landcover", "landuse", "places", "pois", "roads", "water"],
        },
    },
    "admin_levels": {
        "country": {"kind": "country", "kind_detail": 2},
        "region_adm1": {"kind": "region", "kind_detail": 4},
        "province_adm2": {"kind": "county", "kind_detail": [5, 6]},
    },
    "disputed_boundary_handling": (
        "Boundary lines flagged disputed=true by the source (the Morocco/Western "
        "Sahara line, OSM admin_level=2) are rendered dashed with a disputed note "
        "on click; they are never removed, filled over, or re-attributed."
    ),
    "name_field_policy": (
        "Labels prefer name:fr, then name:en, then a cased Latin name. "
        "Each candidate rejects unsupported codepoints found in the pinned snapshots; "
        "no safe candidate produces empty text. The bundled Noto Sans glyph range is "
        "0-255 only; Arabic/Tifinagh shaping is not enabled and no custom SDF glyphs are generated."
    ),
    "peak_elevation_policy": (
        "pois.elevation on peak labels is the OSM-tagged nominal value shown for "
        "context; elevation queries always return the raw DEM pixel value."
    ),
    "coverage_note": (
        "Vector geographic context is nationwide; REAL 3D DEM terrain remains "
        "limited to the terrain.coverage bbox (High Atlas). Overview mode is 2D."
    ),
}

meta = json.loads(META.read_text(encoding="utf-8"))
assert meta.get("terrain", {}).get("mode") == "real", "unexpected baseline metadata"
# Refresh only this initializer's basemap fields. Named administrative data
# has a separately pinned contract and must survive a basemap refresh.
existing_geo = meta.get("geo_context", {})
assert isinstance(existing_geo, dict), "unexpected geo_context type"
meta["geo_context"] = {**existing_geo, **BLOCK}
META.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("metadata.json geo_context block written; bytes:", META.stat().st_size)
