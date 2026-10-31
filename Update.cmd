@echo off
rem Brings this build up to the newest one published: git pull from the build repo, then its
rem packages again if they changed. The app runs this itself when you press Update on its Build
rem page (through Start.cmd). By hand, stop the app first.
setlocal
cd /d "%~dp0"
for /f %%h in ('git rev-parse HEAD') do set BEFORE=%%h
echo [%date% %time%] updating from %BEFORE%
git pull --ff-only
if errorlevel 1 (
  echo The pull failed: this build is unchanged. Is the PC online, and signed in to GitHub?
  exit /b 1
)
git diff --quiet %BEFORE% HEAD -- package-lock.json
if errorlevel 1 call npm ci --omit=dev --no-audit --no-fund
for /f %%h in ('git rev-parse --short HEAD') do echo [%date% %time%] now at %%h
exit /b 0
