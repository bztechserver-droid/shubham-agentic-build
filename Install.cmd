@echo off
rem Makes this PC run Shubham Agentic from this build folder: see Install.ps1.
rem   Install.cmd               install, and start it now
rem   Install.cmd -Role hub     the first time on the hub
rem   Install.cmd -Remove       stop it and take it out of the logon programs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
echo.
pause
