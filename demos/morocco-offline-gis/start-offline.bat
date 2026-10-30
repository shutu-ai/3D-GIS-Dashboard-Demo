@echo off
rem Morocco High Atlas - Offline 3D GIS Lab :: one-click launcher (Windows 11)
rem Starts the zero-dependency local server (auto port-fallback if the default
rem port is reserved) and opens the demo at the bound URL via the PowerShell
rem launcher itself, so no hardcoded port here.
setlocal
cd /d "%~dp0"
where pwsh >nul 2>nul
if %errorlevel%==0 (
    start "" pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline.ps1"
) else (
    start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline.ps1"
)
endlocal
