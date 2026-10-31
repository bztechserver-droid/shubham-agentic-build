@echo off
rem Shubham Agentic (the build). Keeps the app running on this PC: its device agent, which also
rem serves the page at http://localhost:5173. Started hidden at logon (Install.cmd sets that up).
rem When the app asks to update (exit code 75, its Build page's Update), this runs Update.cmd and
rem starts it again; when it stops for any other reason, it starts again 5 s later.
rem The first time on the hub: Start.cmd --role hub (the role is remembered after that).
rem Output goes to %LOCALAPPDATA%\shubham-agentic\agent-console.log; the agent's own log is in
rem %LOCALAPPDATA%\shubham-agentic\agent\logs.
setlocal
cd /d "%~dp0"
set SAD_SUPERVISED=1
set LOGDIR=%LOCALAPPDATA%\shubham-agentic
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist node_modules call npm ci --omit=dev --no-audit --no-fund >> "%LOGDIR%\agent-console.log" 2>&1
:loop
node agent/main.ts --app app %* >> "%LOGDIR%\agent-console.log" 2>&1
if %ERRORLEVEL% EQU 75 call "%~dp0Update.cmd" >> "%LOGDIR%\agent-console.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
