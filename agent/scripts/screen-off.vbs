' Runs screen-off.ps1 (next to this file) with no window: the "Screen off" desktop button.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\screen-off.ps1""", 0, False
