@echo off
rem Shubham Agentic (the build): the one Start button. It starts every service at once, with no Claude session:
rem the guard (Guard hidden.vbs), which starts the agent, its chat host, RustDesk's servers and the page on
rem http://localhost:5173, all hidden, in the background. Then it waits and says which services are up.
rem Press it again any time: a guard that runs already makes this do nothing (the guard refuses a second copy).
rem It does NOT run its own restart loop.
rem Output goes to %LOCALAPPDATA%\shubham-agentic\guard-console.log (the agent's own: agent-console.log).
setlocal
cd /d "%~dp0"
start "" wscript.exe "%~dp0Guard hidden.vbs" %*
echo Starting Shubham Agentic: all services (up to 60 seconds)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$svc=[ordered]@{'page (5173)'=5173;'agent (21221)'=21221;'chat host (21229)'=21229;'RustDesk hbbs (21216)'=21216;'RustDesk hbbr (21217)'=21217}; $end=(Get-Date).AddSeconds(60); foreach($k in $svc.Keys){ $ok=$false; while((Get-Date) -lt $end -and -not $ok){ $t=New-Object Net.Sockets.TcpClient; try{ $ar=$t.BeginConnect('127.0.0.1',$svc[$k],$null,$null); $ok=($ar.AsyncWaitHandle.WaitOne(500) -and $t.Connected) } catch {} finally { $t.Close() }; if(-not $ok){ Start-Sleep -Milliseconds 500 } }; if($ok){ Write-Host ('  up        ' + $k) } else { Write-Host ('  NOT UP    ' + $k + ' - see guard-console.log') } }"
echo.
echo Page: http://localhost:5173   Logs: %LOCALAPPDATA%\shubham-agentic\guard-console.log
pause
