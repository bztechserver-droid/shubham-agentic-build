' Starts Start.cmd (next to this file) with no window: the app in the background.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
shell.Run """" & here & "\Start.cmd""" & args, 0, False
