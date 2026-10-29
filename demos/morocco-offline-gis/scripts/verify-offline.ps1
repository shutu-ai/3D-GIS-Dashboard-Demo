# verify-offline.ps1 — Phase 4 offline acceptance runner (to be executed against dist/)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-offline.ps1 [-Dist <path>] [-Port 17841]
# Starts the packaged server against the dist folder, then runs Playwright E2E with
# ALL external network blocked (only 127.0.0.1 allowed) and a fresh browser profile.

param(
    [string]$Dist = "",
    [int]$Port = 17841
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot | Split-Path
if (-not $Dist) { $Dist = Join-Path $root "dist" }
if (-not (Test-Path (Join-Path $Dist "index.html"))) {
    Write-Host "ERROR: dist package not found at '$Dist'. Build it first." -ForegroundColor Red
    exit 1
}

# guard: a stale server on this port would answer requests with the WRONG root
# and poison the acceptance result. Refuse to run until the port is free.
$stale = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($stale) {
    $spid = ($stale | Select-Object -First 1).OwningProcess
    Write-Host "ERROR: port $Port already in use (pid $spid) - stop the stale server first:" -ForegroundColor Red
    Write-Host "       Stop-Process -Id $spid -Force"
    exit 1
}

# 1. Start the offline server against dist (same server the end user runs)
$server = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Dist 'start-offline.ps1'),'-Port',$Port -PassThru -WindowStyle Hidden
Start-Sleep 3
try {
    # 2. PMTiles Range gate
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/data/dem-terrarium.pmtiles")
    $req.Method = "GET"; $req.AddRange(0, 127); $req.Timeout = 5000
    $resp = $req.GetResponse(); $n = $resp.GetResponseStream().Read((New-Object byte[] 256), 0, 256); $resp.Close()
    if ($resp.StatusCode -eq 206 -and $n -eq 128) {
        Write-Host "[PASS] PMTILES_RANGE (206, header 128 bytes)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] PMTILES_RANGE" -ForegroundColor Red; exit 1
    }

    # 3. Playwright E2E with network interception (external requests blocked & counted)
    Push-Location $root
    $env:GIS_DEMO_URL = "http://127.0.0.1:$Port/"
    npx playwright test --config=e2e/playwright.config.ts
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Host "[FAIL] E2E" -ForegroundColor Red; exit 1 }
    Write-Host "[PASS] E2E suite" -ForegroundColor Green
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
