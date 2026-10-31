' Starts start-hub.cmd (next to this file) with no window: the hub agent in the background.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & here & "\start-hub.cmd""", 0, False
