# package-dist.ps1 — build the self-contained offline package into dist/
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-dist.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot | Split-Path
Set-Location $root

Write-Host "== typecheck + vite build ==" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] build" -ForegroundColor Red; exit 1 }

Write-Host "== bundle offline server + docs into dist/ ==" -ForegroundColor Cyan
Copy-Item (Join-Path $root 'start-offline.ps1') (Join-Path $root 'dist\start-offline.ps1') -Force
Copy-Item (Join-Path $root 'start-offline.bat') (Join-Path $root 'dist\start-offline.bat') -Force
Copy-Item (Join-Path $root 'DATA_SOURCES_AND_LICENSES.md') (Join-Path $root 'dist\DATA_SOURCES_AND_LICENSES.md') -Force

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$commit = git rev-parse --short HEAD 2>$null
if (-not $commit -or $LASTEXITCODE -ne 0) { $commit = 'n/a' }
@"
Morocco High Atlas - Offline 3D GIS Lab
built:   $stamp
commit:  $commit
runtime: open start-offline.bat (serves http://127.0.0.1:17841)
data:    SIMULATED terrain - see DATA_SOURCES_AND_LICENSES.md
"@ | Out-File (Join-Path $root 'dist\VERSION.txt') -Encoding utf8

$must = @('index.html', 'start-offline.bat', 'start-offline.ps1',
          'data\dem-terrarium.pmtiles', 'data\hypso.pmtiles', 'data\contours.pmtiles',
          'data\roads-peaks.geojson', 'data\simulated-ran.geojson', 'data\metadata.json',
          'assets\glyphs\Noto Sans Regular\0-255.pbf')
$missing = @($must | Where-Object { -not (Test-Path (Join-Path $root "dist\$_")) })
if ($missing) { Write-Host "[FAIL] missing in dist: $($missing -join ', ')" -ForegroundColor Red; exit 1 }

$size = (Get-ChildItem (Join-Path $root 'dist') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[OK] dist complete - {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Green
