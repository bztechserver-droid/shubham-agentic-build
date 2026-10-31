@echo off
rem Shubham Agentic (the build), kept running by its guard (F-058). Guard hidden.vbs runs this at logon,
rem and so does the Scheduled Task ShubhamAgenticGuard, every minute, if it is not running. The guard starts
rem the app, starts it again within seconds when it dies or hangs, serves the page on 5173 itself (so 5173
rem never closes), keeps RustDesk's servers up apart from the app, and brings back the chats that were open.
rem One guard runs at a time: a second one finds that out and stops at once (exit code 3), so starting
rem this again, by hand or from Christopher on 4740, is always safe.
rem The old way, Start.cmd (its own restart loop), still works. Never run both: Install-Guard.cmd -Remove goes back to it.
rem Output goes to %LOCALAPPDATA%\shubham-agentic\guard-console.log (the app's own: agent-console.log).
rem guard.env next to this file (KEY=VALUE lines) sets the guard's environment: a test copy on spare ports uses it.
setlocal
cd /d "%~dp0"
set SAD_SUPERVISED=1
if exist "%~dp0guard.env" for /f "usebackq eol=# tokens=1* delims==" %%a in ("%~dp0guard.env") do set "%%a=%%b"
set LOGDIR=%LOCALAPPDATA%\shubham-agentic
if defined SAD_HOME set LOGDIR=%SAD_HOME%
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist node_modules call npm ci --omit=dev --no-audit --no-fund >> "%LOGDIR%\agent-console.log" 2>&1
:loop
node agent/guard.ts %* >> "%LOGDIR%\guard-console.log" 2>&1
rem 3: a guard runs already. 4: it was asked to stop. Nothing more to do. 5: it updated itself: start it again at once.
if %ERRORLEVEL% EQU 3 exit /b 0
if %ERRORLEVEL% EQU 4 exit /b 0
if %ERRORLEVEL% EQU 5 goto loop
rem Killed or crashed: started again in 2 s (it takes the page's port back, and adopts the app that went on running).
timeout /t 2 /nobreak >nul
goto loop
