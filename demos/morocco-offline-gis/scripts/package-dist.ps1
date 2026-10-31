# package-dist.ps1 — build the self-contained offline package into dist/
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-dist.ps1 [-AllowSimulated]
#   Release builds MUST carry real (Copernicus GLO-30) terrain; -AllowSimulated
#   is a dev-only override for packaging the synthetic v1.0.0 terrain.
param(
    [switch]$AllowSimulated
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot | Split-Path
Set-Location $root

Write-Host "== release gate: data mode ==" -ForegroundColor Cyan
$metaPath = Join-Path $root 'public\data\metadata.json'
if (-not (Test-Path $metaPath)) {
    Write-Host "[FAIL] public\data\metadata.json missing - run scripts/prepare_data.py first" -ForegroundColor Red; exit 1
}
$meta = Get-Content $metaPath -Raw -Encoding utf8 | ConvertFrom-Json
$terrainMode = if ($meta.terrain -and $meta.terrain.mode) { $meta.terrain.mode } else { 'synthetic' }
if ($terrainMode -ne 'real') {
    if ($AllowSimulated) {
        Write-Host "[WARN] packaging SIMULATED terrain (dev override -AllowSimulated)" -ForegroundColor Yellow
    } else {
        Write-Host "[FAIL] metadata.json terrain.mode='$terrainMode' - release packages require real DEM terrain." -ForegroundColor Red
        Write-Host "       Rebuild with:  python scripts/prepare_data.py --terrain-source real" -ForegroundColor Red
        Write-Host "       Dev override:  scripts/package-dist.ps1 -AllowSimulated" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[OK] terrain.mode=real (Copernicus DEM GLO-30)" -ForegroundColor Green
}

Write-Host "== typecheck + vite build ==" -ForegroundColor Cyan
Write-Host "== named administrative data gate ==" -ForegroundColor Cyan
python scripts/validate_admin_context.py --idempotence-run
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] named administrative data" -ForegroundColor Red; exit 1 }
Write-Host "== isolated administrative font gate ==" -ForegroundColor Cyan
python scripts/validate_admin_font.py
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] isolated administrative font" -ForegroundColor Red; exit 1 }
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] build" -ForegroundColor Red; exit 1 }

Write-Host "== bundle offline server + docs into dist/ ==" -ForegroundColor Cyan
Copy-Item (Join-Path $root 'start-offline.ps1') (Join-Path $root 'dist\start-offline.ps1') -Force
Copy-Item (Join-Path $root 'start-offline.bat') (Join-Path $root 'dist\start-offline.bat') -Force
Copy-Item (Join-Path $root 'DATA_SOURCES_AND_LICENSES.md') (Join-Path $root 'dist\DATA_SOURCES_AND_LICENSES.md') -Force
Copy-Item (Join-Path $root 'README.md') (Join-Path $root 'dist\README.md') -Force
$docsDir = Join-Path $root 'dist\Docs'
New-Item -ItemType Directory -Path $docsDir -Force | Out-Null
foreach ($doc in @('V1_2_1_Geographic_Context_Plan.md', 'V1_2_1_Data_Sources_and_Boundaries.md',
                   'V1_2_0_Interaction_and_Data_Contract.md', 'V1_2_1_Disconnected_Cold_Start.md')) {
    Copy-Item (Join-Path $root "Docs\$doc") (Join-Path $docsDir $doc) -Force
}
# QA evidence is included when available; acceptance JSON and ZIP checksum stay
# outside the archive to avoid a self-referential ZIP hash.
foreach ($doc in @('V1_2_1_Visual_Acceptance.md', 'v1_2_1_runtime_evidence.json',
                   'v1_2_1_test_results.json', 'v1_2_1_admin_click_retest.json',
                   'geo_glyph_audit_snapshot_20261030.json',
                   'V1_2_1_Admin_Acceptance_Correction.md', 'v1_2_1_admin_data_validation.json',
                   'v1_2_1_admin_visibility_results.json', 'v1_2_1_test_results_admin_revision.json',
                   'v1_2_1_runtime_admin_revision.json', 'v1_2_1_admin_visibility_rois.json',
                   'v1_2_1_admin_font_exact_fixture.json', 'v1_2_1_admin_font_validation.json',
                   'v1_2_1_admin_font_structural_validation.json', 'v1_2_1_admin_font_sheet.png',
                   'V1_2_1_Admin_Font_Encoding.md', 'v1_2_1_admin_initial_roi_metrics.json',
                   'v1_2_1_admin_visibility_initial_failure.json',
                   'v1_2_1_full66_rev6b_results.json', 'v1_2_1_full66_rev6b_run.log')) {
    $source = Join-Path $root "Docs\$doc"
    if (Test-Path $source) { Copy-Item $source (Join-Path $docsDir $doc) -Force }
}
$screenshots = Join-Path $root 'Docs\screenshots\v1.2.1'
if (Test-Path $screenshots) {
    New-Item -ItemType Directory -Path (Join-Path $docsDir 'screenshots') -Force | Out-Null
    Copy-Item $screenshots (Join-Path $docsDir 'screenshots') -Recurse -Force
}

# re-check what vite actually copied into dist (source of truth for the package)
$distMetaPath = Join-Path $root 'dist\data\metadata.json'
if (-not (Test-Path $distMetaPath)) {
    Write-Host "[FAIL] dist\data\metadata.json missing after build" -ForegroundColor Red; exit 1
}
$distMeta = Get-Content $distMetaPath -Raw -Encoding utf8 | ConvertFrom-Json
$distMode = if ($distMeta.terrain -and $distMeta.terrain.mode) { $distMeta.terrain.mode } else { 'synthetic' }
if ($distMode -ne 'real' -and -not $AllowSimulated) {
    Write-Host "[FAIL] dist\data\metadata.json terrain.mode='$distMode' - expected real" -ForegroundColor Red; exit 1
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$commit = git rev-parse --short HEAD 2>$null
if (-not $commit -or $LASTEXITCODE -ne 0) { $commit = 'n/a' }
$dataLine = if ($distMode -eq 'real') {
    'data:    REAL terrain (Copernicus DEM GLO-30, EGM2008) + OPEN GEOGRAPHIC DATA (OSM/Protomaps) + CURATED/SIMULATED GEO + SIMULATED network overlay - see DATA_SOURCES_AND_LICENSES.md'
} else {
    'data:    SIMULATED terrain - see DATA_SOURCES_AND_LICENSES.md'
}
@"
Morocco High Atlas - Offline 3D GIS Lab
built:   $stamp
commit:  $commit
runtime: open start-offline.bat (serves http://127.0.0.1:17841)
$dataLine
"@ | Out-File (Join-Path $root 'dist\VERSION.txt') -Encoding utf8

# glyphs are copied into dist by vite's public/ copy (public/assets/glyphs/**
# -> dist/assets/glyphs/**), so both range files travel automatically.  The
# optional 9472-9727 range only exists when the source TTF maps U+25B2.
$must = @('index.html', 'start-offline.bat', 'start-offline.ps1',
          'data\dem-terrarium.pmtiles', 'data\hypso.pmtiles', 'data\contours.pmtiles',
          'data\roads-peaks.geojson', 'data\simulated-ran.geojson', 'data\metadata.json',
          'assets\glyphs\Noto Sans Regular\0-255.pbf')
# v1.2.1: real geographic context archives travel in the package (task §9)
$geoMust = @('data\morocco-overview.pmtiles', 'data\high-atlas-context.pmtiles',
             'data\admin-context-areas.geojson', 'data\admin-context-labels.geojson',
             'assets\glyphs\Offline Admin Latin\0-255.pbf', 'assets\glyphs\Offline Admin Latin\NOTICE.md',
             'data\NOTICE.txt', 'licenses\ODbL-1.0.txt', 'licenses\Noto-Sans-OFL.txt')
$must += $geoMust
$glyphRange = 'assets\glyphs\Noto Sans Regular\9472-9727.pbf'
if (Test-Path (Join-Path $root "public\$glyphRange")) { $must += $glyphRange }
$missing = @($must | Where-Object { -not (Test-Path (Join-Path $root "dist\$_")) })
if ($missing) { Write-Host "[FAIL] missing in dist: $($missing -join ', ')" -ForegroundColor Red; exit 1 }

$size = (Get-ChildItem (Join-Path $root 'dist') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[OK] dist complete - {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Green
