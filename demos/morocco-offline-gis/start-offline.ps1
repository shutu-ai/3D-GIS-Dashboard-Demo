# Morocco High Atlas - Offline 3D GIS Lab :: zero-dependency static server
# Supports HTTP Range requests (required for PMTiles). .NET HttpListener only.
# Usage:  powershell -ExecutionPolicy Bypass -File start-offline.ps1 [-Port 17841] [-Root <dir>]
#         (defaults: Root = the folder containing this script, Port = 17841)

param(
    [int]$Port = 17841,
    [string]$Root = "",
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
if (-not $Root) { $Root = $PSScriptRoot }
if (-not (Test-Path (Join-Path $Root "index.html"))) {
    Write-Host "ERROR: index.html not found under '$Root'. Run this script from the dist package root." -ForegroundColor Red
    exit 1
}

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".mjs"  = "text/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json"
    ".geojson" = "application/geo+json"
    ".pmtiles" = "application/vnd.pmtiles"
    ".pbf"  = "application/x-protobuf"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".map"  = "application/json"
    ".txt"  = "text/plain; charset=utf-8"
    ".md"   = "text/plain; charset=utf-8"
    ".woff" = "font/woff"
    ".woff2" = "font/woff2"
}

$rootFull = [IO.Path]::GetFullPath($Root)
$reqPort = $Port

# Bind the requested port; if it is unavailable (in use, or inside a Hyper-V /
# WinNAT reserved range - pid 4 "System"), fall forward to the next candidates
# so a clean-machine cold start never dies on a port collision.
$listener = New-Object System.Net.HttpListener
$maxPortAttempts = 10
$bound = $false
for ($attempt = 0; $attempt -lt $maxPortAttempts; $attempt++) {
    $Port = $reqPort + $attempt
    $listener.Prefixes.Clear()
    $listener.Prefixes.Add("http://127.0.0.1:${Port}/")
    try { $listener.Start(); $bound = $true; break } catch {
        Write-Host "  [WARN] port 127.0.0.1:${Port} unavailable ($($_.Exception.Message)), trying next..." -ForegroundColor Yellow
    }
}
if (-not $bound) {
    Write-Host "ERROR: cannot bind 127.0.0.1:${reqPort}-$($reqPort + $maxPortAttempts - 1). Free a port or pass -Port <n>." -ForegroundColor Red
    exit 1
}
if ($Port -ne $reqPort) {
    Write-Host "  [INFO] default port $reqPort was reserved/in use - using $Port instead." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Morocco High Atlas - Offline 3D GIS Lab" -ForegroundColor Cyan
Write-Host "  Serving : $rootFull"
Write-Host "  URL     : http://127.0.0.1:${Port}/" -ForegroundColor Yellow
Write-Host "  Range   : supported (206 partial content, required by PMTiles)"
Write-Host "  Offline : the server makes no external requests."
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

# Open the default browser at the ACTUALLY bound port (may differ from the
# requested one when the default was reserved, e.g. by Hyper-V/WinNAT).
if (-not $NoBrowser) {
    try { Start-Process "http://127.0.0.1:${Port}/" } catch {
        Write-Host "  [WARN] could not launch browser automatically: open http://127.0.0.1:${Port}/ manually" -ForegroundColor Yellow
    }
}

# Preflight self-test runs as a background job: the request it makes must be served
# by the main loop below, so it cannot run synchronously (would deadlock on GetContext).
$pmt = Join-Path $rootFull "data\dem-terrarium.pmtiles"
$preJob = $null
if (Test-Path $pmt) {
    $preJob = Start-Job -ScriptBlock {
        param($port)
        Start-Sleep -Milliseconds 500
        try {
            $pre = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/data/dem-terrarium.pmtiles")
            $pre.Method = "GET"
            $pre.AddRange(0, 127)
            $pre.Timeout = 8000
            $preResp = $pre.GetResponse()
            $preStream = $preResp.GetResponseStream()
            $preBuf = New-Object byte[] 256
            $preN = $preStream.Read($preBuf, 0, 256)
            $preStream.Close(); $preResp.Close()
            if ($preResp.StatusCode -eq [System.Net.HttpStatusCode]::PartialContent -and $preN -eq 128) {
                "  [OK] PMTiles Range preflight: 206, 128-byte header received"
            } else {
                "  [WARN] PMTiles Range preflight unexpected: $($preResp.StatusCode), $preN bytes"
            }
        } catch {
            "  [WARN] PMTiles Range preflight failed: $($_.Exception.Message)"
        }
    } -ArgumentList $Port
} else {
    Write-Host "  [WARN] data/dem-terrarium.pmtiles not found yet (dev mode?)" -ForegroundColor Yellow
}

# Serve requests (synchronous loop: reliable on Windows PowerShell 5.1 and pwsh 7+;
# HttpListener queues concurrent browser connections, which are then served in order).
$serve = {
    param($ctx)
    try {
        $req = $ctx.Request; $res = $ctx.Response
        $rawPath = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
        if ($rawPath -eq "/" -or $rawPath -eq "") { $rawPath = "/index.html" }
        $rel = $rawPath.TrimStart("/")
        $full = [IO.Path]::GetFullPath((Join-Path $rootFull ($rel -replace "/", [IO.Path]::DirectorySeparatorChar)))
        if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403; $res.Close(); return
        }
        if ([IO.Directory]::Exists($full)) { $full = Join-Path $full "index.html" }
        if (-not [IO.File]::Exists($full)) { $res.StatusCode = 404; $res.Close(); return }

        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $res.Headers["Accept-Ranges"] = "bytes"
        $res.Headers["Cache-Control"] = "no-cache"
        $len = (Get-Item $full).Length
        $rangeHdr = $req.Headers["Range"]
        $fs = [IO.File]::OpenRead($full)
        try {
            if ($rangeHdr -and $rangeHdr -match '^bytes=(\d*)-(\d*)$') {
                $start = 0L; $end = $len - 1
                if ($Matches[1]) { $start = [long]$Matches[1] }
                if ($Matches[2]) { $end = [long]$Matches[2] }
                if ($start -ge $len) { $res.StatusCode = 416; $res.Close(); return }
                if ($end -lt $start) { $end = $start }
                if ($end -ge $len) { $end = $len - 1 }
                $res.StatusCode = 206
                $res.Headers["Content-Range"] = "bytes $start-$end/$len"
                $count = $end - $start + 1
                $res.ContentLength64 = $count
                $fs.Position = $start
                $buf = New-Object byte[] (64 * 1024)
                $remaining = $count
                if ($req.HttpMethod -ne "HEAD") {
                    while ($remaining -gt 0) {
                        $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $remaining))
                        if ($n -le 0) { break }
                        $res.OutputStream.Write($buf, 0, $n)
                        $remaining -= $n
                    }
                }
            } else {
                $res.StatusCode = 200
                $res.ContentLength64 = $len
                if ($req.HttpMethod -ne "HEAD") { $fs.CopyTo($res.OutputStream) }
            }
        } finally { $fs.Close() }
        $res.Close()
    } catch {
        try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
    }
}

$preReported = $false
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    & $serve $ctx
    if (-not $preReported -and $preJob) {
        if ($preJob.State -in "Completed","Failed","Stopped") {
            $preReported = $true
            if ($preJob.State -eq "Completed") {
                $msg = Receive-Job -Job $preJob
                $color = if ($msg -match "\[OK\]") { "Green" } else { "Yellow" }
                Write-Host $msg -ForegroundColor $color
            } else {
                Write-Host "  [WARN] PMTiles Range preflight job $($preJob.State)" -ForegroundColor Yellow
            }
            Remove-Job -Job $preJob -Force
            Write-Host ""
        }
    }
}
