' Traz o icone do UniOver de volta a bandeja depois do "Sair" (atalho "UniOver" do menu Iniciar). Somente ASCII.
' Apaga o sinal runtime\tray-closed (o supervisor abre o icone em poucos segundos) e chama o lancador estavel, que sobe
' o agente se ele nao estiver rodando e sai na hora se estiver. Fica em app\tools: a atualizacao o renova junto com o resto.
Option Explicit
Dim shell, fso, here, base, flag, request, launcher, signal
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' A pasta de instalacao e a primeira acima do script que tem "runtime": app\tools fica duas abaixo dela e
' app.staging\<sha>\tools (a versao preparada para a troca sem queda), tres. Sem ela, a padrao em %LOCALAPPDATA%.
Dim i
here = fso.GetParentFolderName(WScript.ScriptFullName)
base = fso.GetParentFolderName(here)
For i = 1 To 3
  If base = "" Then Exit For
  If fso.FolderExists(base & "\runtime") Then Exit For
  base = fso.GetParentFolderName(base)
Next
If base = "" Then base = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver"
If Not fso.FolderExists(base & "\runtime") Then base = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver"
flag = base & "\runtime\tray-closed"
request = base & "\runtime\tray-start-request"
On Error Resume Next
If fso.FileExists(flag) Then fso.DeleteFile flag, True
Set signal = fso.CreateTextFile(request, True)
If Not signal Is Nothing Then signal.Close
launcher = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver\launcher.vbs"
If fso.FileExists(launcher) Then shell.Run "wscript.exe """ & launcher & """", 0, False
