' Inicia o lancador do UniOver sem janela: o Windows Script Host nao tem console e o
' Run com estilo 0 cria o PowerShell ja oculto (nada pisca no logon). Somente ASCII.
Option Explicit
Dim shell, base
Set shell = CreateObject("WScript.Shell")
base = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\UniOver"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\launcher.ps1""", 0, False
