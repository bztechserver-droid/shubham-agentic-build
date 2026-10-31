@echo off
rem F-028: opens this PC to the other PCs on its Tailscale network (every port, the tailnet only). -Remove undoes it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-To-Tailnet.ps1" %*
