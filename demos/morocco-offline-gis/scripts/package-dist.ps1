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
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] build" -ForegroundColor Red; exit 1 }

Write-Host "== bundle offline server + docs into dist/ ==" -ForegroundColor Cyan
Copy-Item (Join-Path $root 'start-offline.ps1') (Join-Path $root 'dist\start-offline.ps1') -Force
Copy-Item (Join-Path $root 'start-offline.bat') (Join-Path $root 'dist\start-offline.bat') -Force
Copy-Item (Join-Path $root 'DATA_SOURCES_AND_LICENSES.md') (Join-Path $root 'dist\DATA_SOURCES_AND_LICENSES.md') -Force

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
    'data:    REAL terrain (Copernicus DEM GLO-30, EGM2008) + SIMULATED network overlay - see DATA_SOURCES_AND_LICENSES.md'
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
$glyphRange = 'assets\glyphs\Noto Sans Regular\9472-9727.pbf'
if (Test-Path (Join-Path $root "public\$glyphRange")) { $must += $glyphRange }
$missing = @($must | Where-Object { -not (Test-Path (Join-Path $root "dist\$_")) })
if ($missing) { Write-Host "[FAIL] missing in dist: $($missing -join ', ')" -ForegroundColor Red; exit 1 }

$size = (Get-ChildItem (Join-Path $root 'dist') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[OK] dist complete - {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Green
