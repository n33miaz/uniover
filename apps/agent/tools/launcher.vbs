' Inicia o lancador do UniOver sem janela: o Windows Script Host nao tem console e o
' Run com estilo 0 cria o PowerShell ja oculto (nada pisca no logon). Somente ASCII.
' Do Windows 10 2004 em diante o PowerShell sobe num console sem janela (conhost
' --headless): com o Terminal do Windows como terminal padrao, um console oculto ainda
' poderia virar uma janela do Terminal.
Option Explicit
Dim shell, base, command, build
Set shell = CreateObject("WScript.Shell")
base = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\launcher.ps1"""
build = 0
On Error Resume Next
build = CLng(shell.RegRead("HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber"))
On Error GoTo 0
If build >= 19041 Then command = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\conhost.exe --headless " & command
shell.Run command, 0, False
