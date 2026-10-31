' Runs Guard.cmd (next to this file) with no window, and waits for it. The Scheduled Task that starts this
' stays "running" for as long as the guard does, so the scheduler (set to ignore a new start while one
' runs) never starts two; when the guard's shell is killed, the task ends, and the next minute starts it again.
' Arguments (--role hub) go on to the guard.
Set shell = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
WScript.Quit shell.Run("""" & here & "\Guard.cmd""" & args, 0, True)
