@echo off
rem Makes the guard keep this PC's Shubham Agentic up: see Install-Guard.ps1. No admin needed.
rem   Install-Guard.cmd               install, take over from whatever runs now, and start it
rem   Install-Guard.cmd -Role hub     the first time on the hub
rem   Install-Guard.cmd -Remove       take the guard out and go back to Start.cmd, the old way
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Guard.ps1" %*
echo.
pause
