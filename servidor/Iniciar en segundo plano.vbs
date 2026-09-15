' Igual que Iniciar.vbs pero sin abrir el navegador.
' Pon un acceso directo a este fichero en la carpeta de Inicio de Windows
' (Win+R  ->  shell:startup) para que se ponga a vigilar solo al encender.
Dim sh, fso, carpeta
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = carpeta
sh.Run "pythonw.exe """ & carpeta & "\run.py"" --no-browser", 0, False
