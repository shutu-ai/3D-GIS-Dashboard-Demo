# v1.2.1 — Data Sources & Boundaries (Geographic Context)

Companion to `DATA_SOURCES_AND_LICENSES.md` (which now lists **four** data
classes). This file records exactly where the v1.2.1 real geographic context
comes from, how it was verified, and how disputed boundaries are handled.

## 1. Source record (pinned)

| Item | Value |
|---|---|
| Provider | Protomaps Basemap v4 (planetiler build of OpenStreetMap + Natural Earth) |
| Pinned snapshot URL | `https://build.protomaps.com/20261030.pmtiles` |
| Basemap build version | 4.15.2 |
| Snapshot date | 2026-10-30 |
| Retrieved at | 2026-10-30 |
| Source size | 139,202,898,553 B (planet file, **never downloaded wholesale** — extraction reads only the needed byte ranges) |
| Source md5 / b3sum | `6JzP3p/XlgMG7jMbTCd/NA==` (base64) / `b936e549…f917` (hex, full value in `metadata.json`) |
| License | OpenStreetMap data © OpenStreetMap contributors, **ODbL 1.0**; tiles rendered by Protomaps Basemap |
| Required attribution | `Geographic data: © OpenStreetMap contributors (ODbL) - Protomaps Basemap v4` — shown in the app footer and inside every geo click popup |

Why Protomaps/OSM (task §3.1 priority): redistribution under ODbL 1.0
(attribution, share-alike for derived databases, machine-readable access and
no DRM-only distribution), worldwide `boundaries` with `disputed` flags,
and `pois` peak elevations. The initial decision to omit geoBoundaries was
reopened: Protomaps ADM1/ADM2 lines contain no names and cannot meet the
administrative-label requirement. A fixed **gbOpen** MAR supplement is now
the primary named ADM1/ADM2 geometry; no `gbAuthoritative` source is used.
The extracted OSM-derived databases are
offered under ODbL in full as unrestricted PMTiles, with `data/NOTICE.txt`
and an offline license copy. Natural Earth is public domain. The unused
`landcover` layer remains in the extracts; ESA WorldCover / Daylight
Landcover CC BY 4.0 attribution and full URLs are included in that notice.

## 2. Redistributed archives

Both files live in `public/data/` (and ship inside the release ZIP), with
hashes + bboxes recorded twice: in `metadata.json` and in the pinned-value
table enforced by `scripts/validate_geo_context.py` (check d).

### morocco-overview.pmtiles — nationwide 2D context

- bbox −17.6, 20.4, −0.6, 36.35 (all of Morocco incl. Western Sahara + margin)
- zoom 0–12; size 65,961,582 B
- sha256 `f5e587bd800ef7b7d846c30e3feae6bcaba89ccf91935ec1076f0006202ca119`
- vector layers: boundaries, buildings, earth, landcover, landuse, places,
  pois, roads, water

### high-atlas-context.pmtiles — High Atlas local context

- bbox −9.15, 30.4, −6.05, 32.0
- zoom 0–14; size 36,675,954 B
- sha256 `507986ca83b62f5f032ee82f52d2b57f20260ff5b4298f80c6d6716bb68a00de`
- same layer set, denser roads/places/pois at deep zoom

Extraction command shape (reproducible; see `scripts/prepare_geo_context.py`):

```
.data/tools/pmtiles.exe extract <source> <out>.pmtiles \
  --bbox <west>,<south>,<east>,<north> --maxzoom <z>
.data/tools/pmtiles.exe verify <out>.pmtiles   # must exit 0
```

`--skip-extract` re-validates and rewrites the metadata contract
read-modify-write (idempotent, byte-identical).

## 3. Protomaps archive line taxonomy (not a name-label source)

| Level | Source encoding | Evidence |
|---|---|---|
| ADM0 country | `kind=country`, `kind_detail=2` | z6 sweep; retained country/disputed source |
| ADM1 region | `kind=region`, `kind_detail=4` | archive line classification only; no name field |
| ADM2 province | `kind=county`, `kind_detail ∈ {5,6}` | archive line classification only; no name field |

Depth/completeness at deep zoom is inherited from the source — we do not
claim full national ADM2 coverage beyond what the archive carries.

### 3.1 Primary named ADM1/ADM2 supplement — geoBoundaries gbOpen

Fixed release `9469f09`, source OpenStreetMap/Wambacher, represented year
**2017**, upstream update **2023-01-19**, build **2023-12-12**. Actual license:
**ODbL 1.0** (not CC BY by assumption). Official metadata:
`https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM1/` and
`https://www.geoboundaries.org/api/current/gbOpen/MAR/ADM2/`.

| Raw input | Boundary ID | Units | SHA-256 |
|---|---|---:|---|
| `geoBoundaries-MAR-ADM1_simplified.geojson` | MAR-ADM1-70788906 | 12 | `21841ea5810305a2c6c25300e4b295e59a9706a5ae0da03b50ae3cfd2ddc5849` |
| `geoBoundaries-MAR-ADM2_simplified.geojson` | MAR-ADM2-96644757 | 75 | `0486dad7e941c1f9ec494a1106a7789737ff4224b878fc2081a1e30b88164dff` |

Pinned URLs and license links are fully recorded in `DATA_SOURCES_AND_LICENSES.md`,
`public/data/NOTICE.txt` and `data_sources/geoboundaries/MANIFEST.json`.

- `admin-context-areas.geojson`: 87 original polygons with stable `shapeID`
  and unmodified `shapeName`; app `admin_level=1/2` means ADM1/ADM2, **not**
  invented OSM level numbers. All source ADM2 ISO strings are empty.
- `admin-context-labels.geojson`: 87 overview anchors + 13 anchors inside
  polygon∩real-DEM coverage. Names and lines share the same source polygon.
  The safe Latin `label` preserves the source prefix; full bilingual names
  remain available. Data validation proves identity, interior placement,
  font range, provenance and byte-identical repeated builds (9/9).
- The 2017 polygons may differ from the 2026 Protomaps boundary lines;
  named ADM1/ADM2 use the former, while ADM0/disputed use the latter. These
  sources are not silently merged into one purported official boundary set.
- MAR's inclusion/classification of southern regions is attributed to the
  dataset, not a political claim by the application. Source-flagged OSM
  disputed boundaries must remain separate, dashed and unobscured.

Runtime visibility acceptance is tracked separately in
`V1_2_1_Admin_Acceptance_Correction.md`; data validation alone is not a
claim that both viewport labels/boundaries are readable.

## 4. Disputed boundaries (Western Sahara)

The source flags the Morocco/Western Sahara line (OSM `admin_level=2`) with
`disputed=true`. Policy (verbatim from the `metadata.json` contract):

> Boundary lines flagged disputed=true by the source (the Morocco/Western
> Sahara line, OSM admin_level=2) are rendered dashed with a disputed note on
> click; they are never removed, filled over, or re-attributed.

Implementation:

- dedicated layers `geo-admin-disputed` / `geo-admin-disputed-d` with a dashed
  dash pattern, filter `kind=country AND disputed=true`;
- non-disputed country segments render solid in their own layers;
- click popup adds the row `边界属性: disputed — 源数据标记为争议边界，如实展示，
  不作政治归属断言`;
- z6 sweep validation: `disputedCount = 6` segments with
  `kind=country |kind_detail=2 |disputed=true` around Laâyoune
  (validator check i), plus e2e rendering + popup disclosure assertions.

## 5. Field policies

- **Name fields**: labels prefer `name:fr`, `name:en`, then a cased Latin
  `name`, rejecting unsupported codepoints observed in the pinned snapshots
  for every candidate (including French/English fields). No safe candidate
  means empty text, so no missing Arabic/Tifinagh glyph ranges are requested.
  Noto Sans covers Unicode 0–255 only; new snapshots require another glyph
  coverage audit. Popups retain the original OSM `name` value.
- **Peak elevations**: `pois.elevation` on natural labels is the OSM-tagged
  **nominal** value, labelled `OSM 标称值` in popups; elevation queries always
  return the raw DEM pixel value. Jbel Toubkal 4167 m is asserted by the
  validator (check h) — it matches the curated value used since v1.0.0.
- **Roads**: real OSM geometries render solid neutral `#cfcbba`; the curated
  hand-authored roads keep their amber dashed style and their `SIMULATED GEO
  FEATURES` label. No geometry is shared or silently mixed between the two.

## 6. Verification artefacts

- `scripts/validate_geo_context.py` → `10/10 geo-context checks passed`
  (existence, header, bbox, hashes, provenance, layers, key places, Toubkal,
  disputed sweep, water sweep).
- `scripts/geo_probe.mjs` — the underlying offline tile decoder probe
  (boundaries/places/roads/water feature dumps + sweeps).
- E2E: `e2e/v121-geo.spec.ts` scenarios 1, 2, 7, 11 assert rendered real
  content, provenance popups and disputed disclosure in the packaged app.
