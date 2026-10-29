# Acceptance — Morocco High Atlas Offline 3D GIS Lab

**Acceptance date:** 2026-10-29  
**Runtime decision:** all runtime data is programmatically generated and marked `SIMULATED`; `REAL_DEM=NO`.  
**Coverage:** `[-8.4, 30.85, -6.95, 31.55]`; DEM/hypsometric tiles z7–z12; contours z6–z12.

## Evidence

| Gate | Result | Evidence |
|---|---|---|
| Data structure and accuracy | PASS | `python scripts/validate_data.py` → **43/43 checks passed**; DEM sampled pixel error max 22.0 m, anchor error max 6.1 m |
| PMTiles official reader | PASS | `scripts/verify-pmtiles-node.mjs` read representative z7/z9/z12 DEM, z7/z12 hypso, and z6/z12 contour tiles |
| HTTP Range | PASS | `scripts/verify-offline.ps1` → `PMTILES_RANGE (206, header 128 bytes)` |
| Cold start / external network | PASS | fresh Playwright contexts with external routes blocked; **0 external requests** |
| E2E regression | PASS | `scripts/verify-offline.ps1` → **16 passed** at 1920×1080 and 1366×768 |
| Typecheck / package | PASS | `npx tsc --noEmit`; `scripts/package-dist.ps1` → self-contained `dist/` |

## Feature checks

- 2D/3D terrain, pitch, zoom, reset, exaggeration 1.0/1.2/1.5: covered by E2E and screenshots.
- Hypsometric tint and hillshade are independent local layers.
- Contours are pre-generated MVT PMTiles with 500/100/50 m zoom intervals and local glyph PBFs.
- DEM click query reads the Terrarium PMTiles archive directly; visual exaggeration does not change the reported value.
- A/B profile includes distance, elevation range, ascent/descent, terrain-only LOS and Fresnel indication.
- RAN sites, sectors, roads and RSRP segments are generated demo data and show `SIMULATED NETWORK DATA` when enabled.
- Four fly-to scenes remain inside the offline coverage bbox.

## Screenshot evidence

- `Docs/screenshots/desktop-1080p/01-default-3d.png`
- `Docs/screenshots/desktop-1080p/02-ran-overlay.png`
- `Docs/screenshots/desktop-1080p/03-profile-los.png`
- `Docs/screenshots/desktop-768p/01-default-3d.png`
- `Docs/screenshots/desktop-768p/02-ran-overlay.png`
- `Docs/screenshots/desktop-768p/03-profile-los.png`

## Offline package

- Source/runtime directory: `dist/`
- Windows entry point: `dist/start-offline.bat`
- Server: bundled PowerShell static server with byte-range (`206`) support; no CDN, API, telemetry, or external tile endpoint.

## Known gaps and limits

- `REAL_DEM=NO`: terrain, contours, roads/peaks and network overlays are synthetic demo data, not survey or operator data.
- LOS/Fresnel is explicitly terrain-only and is not an engineering RF propagation or coverage prediction.
- Performance numbers are not generalized: the acceptance run verifies functional cold start and rendering, but does not claim a representative FPS or memory benchmark.

```text
IMPLEMENTATION=PASS
OFFLINE_RUNTIME=PASS
COLD_START=PASS
REAL_DEM_INCLUDED=NO
EXTERNAL_REQUESTS=0
PMTILES_RANGE=PASS
TERRAIN_3D=PASS
CONTOURS_AND_LABELS=PASS
ELEVATION_QUERY=PASS
PROFILE=PASS
RAN_OVERLAY=PASS
E2E_TESTS=16/16
PACKAGE_PATH=releases/Morocco-High-Atlas-Offline-GIS-v1.zip
KNOWN_GAPS=synthetic DEM and overlays; terrain-only LOS/Fresnel; no generalized FPS/memory benchmark
```
