@echo off
rem Keeps this PC's hub agent running (F-004). Started hidden at logon by start-hub.vbs, which
rem install-hub-startup.ps1 puts in the Startup folder. When the agent stops (a crash, or
rem stopped on purpose to load new code after a git pull), it starts again 5 s later.
rem Output goes to %LOCALAPPDATA%\shubham-agentic\agent-console.log; the agent's own log is
rem in %LOCALAPPDATA%\shubham-agentic\agent\logs.
cd /d "%~dp0..\.."
:loop
node agent/main.ts --role hub >> "%LOCALAPPDATA%\shubham-agentic\agent-console.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
