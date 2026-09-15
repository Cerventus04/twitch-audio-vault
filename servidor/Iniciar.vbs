' Arranca Twitch Audio Vault sin ventana de consola y abre el panel.
' El 0 del Run es lo que oculta la ventana; el False hace que no espere.
Dim sh, fso, carpeta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta
sh.Run "pythonw.exe """ & carpeta & "\run.py""", 0, False
