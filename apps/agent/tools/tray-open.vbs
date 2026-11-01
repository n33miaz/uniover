' Traz o icone do UniOver de volta a bandeja depois do "Sair" (atalho "UniOver Agente" do menu Iniciar). Somente ASCII.
' Apaga o sinal runtime\tray-closed (o supervisor abre o icone em poucos segundos) e chama o lancador estavel, que sobe
' o agente se ele nao estiver rodando e sai na hora se estiver. Fica em app\tools: a atualizacao o renova junto com o resto.
Option Explicit
Dim shell, fso, here, base, flag, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' app\tools\tray-open.vbs -> a pasta de instalacao fica duas acima de "tools".
here = fso.GetParentFolderName(WScript.ScriptFullName)
base = fso.GetParentFolderName(fso.GetParentFolderName(here))
flag = base & "\runtime\tray-closed"
On Error Resume Next
If fso.FileExists(flag) Then fso.DeleteFile flag, True
launcher = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver\launcher.vbs"
If fso.FileExists(launcher) Then shell.Run "wscript.exe """ & launcher & """", 0, False
