# Copernicus DEM GLO-30 — source manifest (offline build inputs)

The six 1°×1° GeoTIFFs in this directory are the terrain source for the
`--terrain-source real` build (`python scripts/prepare_data.py --terrain-source real`).
They are **not** committed to git (`*.tif` is gitignored at the repo root);
re-fetch them with the links below when rebuilding on a fresh machine.

Product: **Copernicus DEM GLO-30** (2021 release, EOG-derived, 30 m GLO)
Grid: EPSG:4326, 3600×3600 float32 metres per tile, vertical datum EGM2008
(per Copernicus DEM product specification).

## Files (byte sizes as measured on the fetched copies)

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `Copernicus_DSM_COG_10_N30_00_W007_00_DEM.tif` | 40,993,319 | `45cb943ea4a43a1a4065c99d593c7d2eb5bf982055ca1c895b5989d69b68e0ea` |
| `Copernicus_DSM_COG_10_N30_00_W008_00_DEM.tif` | 41,269,668 | `7714ec5e34bfcb3e9b2d2d4039b50e1e7ce823a882a67a0bb4763f4eedbc6065` |
| `Copernicus_DSM_COG_10_N30_00_W009_00_DEM.tif` | 42,267,520 | `9ccf11a8dea3757a57698b475090eef3b3aefca15c1c10765456d91b3962f712` |
| `Copernicus_DSM_COG_10_N31_00_W007_00_DEM.tif` | 41,088,635 | `024f00066f44b6c04c26ab5c22ef8d355f6dc77052206d96c9a9c04f66b9c61e` |
| `Copernicus_DSM_COG_10_N31_00_W008_00_DEM.tif` | 40,611,633 | `8b0a6c28fa9e8a04c4df4a390f8b0d1ad512ff63726b0cda64de8d556a011243` |
| `Copernicus_DSM_COG_10_N31_00_W009_00_DEM.tif` | 41,203,223 | `d89c471537b15d1b21d6792f108d4b4f1e1e470fcbec26b957b864e1e6db04b1` |

`SHA256SUMS.txt` in this directory mirrors the digests above (same order as
`ls`). The build combines the per-file digests into
`metadata.json -> terrain.source_sha256` = sha256 of the concatenation of the
64-char lowercase hex digests in sorted-filename order (no separators).

## Direct download URLs (AWS Open Data, no sign-up / no sign-request)

    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_W007_00_DEM/Copernicus_DSM_COG_10_N30_00_W007_00_DEM.tif
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_W008_00_DEM/Copernicus_DSM_COG_10_N30_00_W008_00_DEM.tif
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_W009_00_DEM/Copernicus_DSM_COG_10_N30_00_W009_00_DEM.tif
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N31_00_W007_00_DEM/Copernicus_DSM_COG_10_N31_00_W007_00_DEM.tif
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N31_00_W008_00_DEM/Copernicus_DSM_COG_10_N31_00_W008_00_DEM.tif
    https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N31_00_W009_00_DEM/Copernicus_DSM_COG_10_N31_00_W009_00_DEM.tif

### AWS CLI alternative

    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N30_00_W007_00_DEM/Copernicus_DSM_COG_10_N30_00_W007_00_DEM.tif .
    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N30_00_W008_00_DEM/Copernicus_DSM_COG_10_N30_00_W008_00_DEM.tif .
    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N30_00_W009_00_DEM/Copernicus_DSM_COG_10_N30_00_W009_00_DEM.tif .
    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N31_00_W007_00_DEM/Copernicus_DSM_COG_10_N31_00_W007_00_DEM.tif .
    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N31_00_W008_00_DEM/Copernicus_DSM_COG_10_N31_00_W008_00_DEM.tif .
    aws s3 cp --no-sign-request s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N31_00_W009_00_DEM/Copernicus_DSM_COG_10_N31_00_W009_00_DEM.tif .

Verify after download: `sha256sum -c SHA256SUMS.txt` (or `Get-FileHash` on
Windows) against the digests above.

## License / attribution requirement

Copernicus DEM is provided under the **full, free and open licence** of the
Copernicus programme (Commission Implementing Decision 2011/484/EU of
4 August 2011). Any distribution of the demo package or derived products must
carry the attribution line:

> Contains modified Copernicus data. Terrain: Copernicus DEM GLO-30
> (European Space Agency / European Commission).

The offline package already ships this attribution in
`DATA_SOURCES_AND_LICENSES.md` and `public/data/metadata.json`
(`terrain.product` / `dem.source`).
