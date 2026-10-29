@echo off
rem Morocco High Atlas - Offline 3D GIS Lab :: one-click launcher (Windows 11)
rem Starts the zero-dependency local server and opens the demo in the default browser.
setlocal
cd /d "%~dp0"
where pwsh >nul 2>nul
if %errorlevel%==0 (
    start "" pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline.ps1"
) else (
    start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline.ps1"
)
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:17841/"
endlocal
